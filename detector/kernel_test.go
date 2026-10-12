package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureKernel(t *testing.T) string {
	t.Helper()
	lock, lockErr := loadKernelLock()
	if lockErr != nil {
		t.Fatal(lockErr)
	}
	asset := lock.Assets[runtime.GOOS+"-"+runtime.GOARCH]
	if _, err := embeddedFiles.ReadFile("embedded/kernel" + filepath.Ext(asset.File)); err != nil {
		if os.Getenv("MISUB_PROBE_REQUIRE_KERNEL") == "1" {
			t.Fatal("CI required the embedded kernel")
		}
		t.Skip("source-only checkout: real-kernel test runs in bundle CI")
	}
	binary, cleanup, err := extractKernel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return binary
}
func TestEmbeddedKernelRoutesOnlyThroughNode(t *testing.T) {
	binary := fixtureKernel(t)
	var seen atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mihomo HTTP outbound uses CONNECT even for a plain HTTP target.
		// Implement the tunnel; a web server response is not a proxy fixture.
		if r.Method != http.MethodConnect {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if rw.Flush() != nil {
			return
		}
		inner, err := http.ReadRequest(bufio.NewReader(rw))
		if err != nil {
			return
		}
		defer inner.Body.Close()
		if inner.Method != http.MethodGet || inner.Host != "fixture.invalid" {
			return
		}
		seen.Add(1)
		body := "fixture-routed-through-node"
		_, _ = fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	host, ps, _ := net.SplitHostPort(u.Host)
	port, _ := strconv.Atoi(ps)
	// Production always passes through pinProxy's public-address policy; only fixtures use loopback.
	proxy := map[string]any{"name": "probe-target", "type": "http", "server": host, "port": port}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	kernel, err := startKernel(ctx, binary, proxy)
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://fixture.invalid/check", nil)
	resp, err := kernel.Client.Do(req)
	if err != nil {
		t.Fatal("node route request failed")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if string(body) != "fixture-routed-through-node" || seen.Load() != 1 {
		t.Fatalf("chosen-proxy fixture failed: status=%d, received=%d", resp.StatusCode, seen.Load())
	}
}
func TestEmbeddedKernelDoesNotFallbackToDirect(t *testing.T) {
	binary := fixtureKernel(t)
	var directCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { directCalls.Add(1); w.WriteHeader(204) }))
	defer target.Close()
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	kernel, err := startKernel(ctx, binary, map[string]any{"name": "probe-target", "type": "http", "server": "127.0.0.1", "port": port})
	if err != nil {
		t.Fatal(err)
	}
	defer kernel.Close()
	result := checkProxy(ctx, kernel.Client, target.URL, time.Second)
	if result.Status == "passed" || directCalls.Load() != 0 {
		t.Fatal("proxy failure fell back to direct")
	}
}
