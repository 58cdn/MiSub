package main

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// All DNS-looking targets are delivered unchanged to the fixture proxy. Only
// that proxy maps them to a loopback TLS server; no provider lookup/traffic occurs.
func TestEmbeddedKernelProviderTLSIdentity(t *testing.T) {
	binary := fixtureKernel(t)
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer provider.Close()
	identity := provider.Certificate().DNSNames[0]
	var routed atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || (r.Host != net.JoinHostPort(identity, "443") && r.Host != "wrong.fixture.invalid:443") {
			w.WriteHeader(403)
			return
		}
		routed.Add(1)
		dst, err := net.DialTimeout("tcp", provider.Listener.Addr().String(), time.Second)
		if err != nil {
			return
		}
		defer dst.Close()
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		_ = dst.SetDeadline(time.Now().Add(3 * time.Second))
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if rw.Flush() != nil {
			return
		}
		done := make(chan struct{})
		go func() { _, _ = io.Copy(dst, rw); dst.Close(); close(done) }()
		_, _ = io.Copy(conn, dst)
		conn.Close()
		<-done
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	host, ps, _ := net.SplitHostPort(u.Host)
	port, _ := strconv.Atoi(ps)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	kernel, err := startKernel(ctx, binary, map[string]any{"name": "probe-target", "type": "http", "server": host, "port": port})
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	target := "https://" + identity + "/"
	if r := checkProxy(ctx, kernel.Client, target, time.Second); r.Status == "passed" {
		t.Fatal("untrusted provider certificate passed through core")
	}
	trusted := kernel.transport.Clone()
	trusted.TLSClientConfig = provider.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	defer trusted.CloseIdleConnections()
	client := &http.Client{Transport: trusted, CheckRedirect: kernel.Client.CheckRedirect}
	if r := checkProxy(ctx, client, target, time.Second); r.Status != "passed" {
		t.Fatalf("trusted fixture through core: %+v", r)
	}
	if r := checkProxy(ctx, client, "https://wrong.fixture.invalid/", time.Second); r.Status == "passed" {
		t.Fatal("wrong provider certificate name accepted")
	}
	if routed.Load() != 3 {
		t.Fatalf("provider hostname did not reach selected node: %d", routed.Load())
	}
}

func TestEmbeddedKernelRejectsUntrustedNodeTLS(t *testing.T) {
	extractStarted := time.Now()
	binary := fixtureKernel(t)
	t.Logf("kernel extraction completed in %s", time.Since(extractStarted))
	var requests atomic.Int32
	type clientHello struct {
		serverName string
		at         time.Time
	}
	var observedHello atomic.Value
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.WriteHeader(204) }))
	upstream.TLS = &tls.Config{GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		observedHello.Store(clientHello{serverName: h.ServerName, at: time.Now()})
		return nil, nil
	}}
	upstream.StartTLS()
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	host, ps, _ := net.SplitHostPort(u.Host)
	port, _ := strconv.Atoi(ps)
	identity := upstream.Certificate().DNSNames[0]
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	startupStarted := time.Now()
	kernel, err := startKernel(ctx, binary, map[string]any{"name": "probe-target", "type": "http", "server": host, "port": port, "tls": true, "sni": identity})
	t.Logf("kernel local startup completed in %s; error=%v", time.Since(startupStarted), err)
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	requestStarted := time.Now()
	r := checkProxy(ctx, kernel.Client, "http://fixture.invalid/", 2*time.Second)
	t.Logf("node TLS request completed in %s; status=%s code=%s httpStatus=%d applicationRequests=%d parentError=%v", time.Since(requestStarted), r.Status, r.Code, r.HTTPStatus, requests.Load(), ctx.Err())
	if r.Status == "passed" || requests.Load() != 0 {
		t.Fatal("untrusted node TLS reached proxy request")
	}
	hello, observed := observedHello.Load().(clientHello)
	if !observed {
		t.Fatalf("node ClientHello not observed; TLS identity and certificate rejection were not exercised: status=%s code=%s httpStatus=%d", r.Status, r.Code, r.HTTPStatus)
	}
	t.Logf("last node ClientHello arrived after %s; serverName=%q", hello.at.Sub(requestStarted), hello.serverName)
	if hello.serverName != identity {
		t.Fatalf("pinned HTTP TLS node sent the wrong identity: got %q, want %q", hello.serverName, identity)
	}
}
