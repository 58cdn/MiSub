package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureKernelLoopback(t *testing.T) *kernelLoopback {
	t.Helper()
	stub, err := newKernelLoopback()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stub.Close)
	return stub
}

func readyConnect(stub *kernelLoopback) string {
	return "CONNECT " + stub.host + ":80 HTTP/1.1\r\nHost: " + stub.host + ":80\r\nProxy-Authorization: " + stub.authorization() + "\r\n\r\n"
}

func readyGet(stub *kernelLoopback) string {
	return "GET " + stub.path + " HTTP/1.1\r\nHost: " + stub.host + "\r\n\r\n"
}

func exchangeKernelLoopback(stub *kernelLoopback, connect, get string) (string, error) {
	conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	reader := bufio.NewReader(conn)
	if _, err = io.WriteString(conn, connect); err != nil {
		return "", err
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", errors.New("CONNECT rejected")
	}
	if _, err = io.WriteString(conn, get); err != nil {
		return "", err
	}
	response, err = http.ReadResponse(reader, nil)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusOK {
		return "", errors.New("GET rejected")
	}
	return string(body), err
}

func TestKernelLoopbackAcknowledgesOnlyItsExactRequest(t *testing.T) {
	for _, scenario := range []string{"valid", "connect-method", "connect-host", "connect-port", "connect-body", "connect-chunked", "auth", "duplicate-auth", "get-method", "get-host", "get-path", "get-body", "get-chunked", "oversized-connect", "oversized-get"} {
		t.Run(scenario, func(t *testing.T) {
			stub := fixtureKernelLoopback(t)
			connect, get := readyConnect(stub), readyGet(stub)
			switch scenario {
			case "connect-method":
				connect = strings.Replace(connect, "CONNECT", "GET", 1)
			case "connect-host":
				connect = strings.ReplaceAll(connect, stub.host, "other.invalid")
			case "connect-port":
				connect = strings.ReplaceAll(connect, ":80", ":443")
			case "connect-body":
				connect = strings.Replace(connect, "\r\n\r\n", "\r\nContent-Length: 1\r\n\r\nx", 1)
			case "connect-chunked":
				connect = strings.Replace(connect, "\r\n\r\n", "\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 1)
			case "auth":
				connect = strings.Replace(connect, stub.authorization(), "Basic invalid", 1)
			case "duplicate-auth":
				connect = strings.Replace(connect, "\r\n\r\n", "\r\nProxy-Authorization: "+stub.authorization()+"\r\n\r\n", 1)
			case "get-method":
				get = strings.Replace(get, "GET", "POST", 1)
			case "get-host":
				get = strings.Replace(get, stub.host, "other.invalid", 1)
			case "get-path":
				get = strings.Replace(get, stub.path, "/other", 1)
			case "get-body":
				get = strings.Replace(get, "\r\n\r\n", "\r\nContent-Length: 1\r\n\r\nx", 1)
			case "get-chunked":
				get = strings.Replace(get, "\r\n\r\n", "\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 1)
			case "oversized-connect":
				connect = strings.Replace(connect, "\r\n\r\n", "\r\nX-Fill: "+strings.Repeat("x", kernelReadyHeaderBytes)+"\r\n\r\n", 1)
			case "oversized-get":
				get = strings.Replace(get, "\r\n\r\n", "\r\nX-Fill: "+strings.Repeat("x", kernelReadyHeaderBytes)+"\r\n\r\n", 1)
			}
			body, err := exchangeKernelLoopback(stub, connect, get)
			if scenario == "valid" {
				if err != nil || body != stub.body || !stub.received.Load() {
					t.Fatalf("valid loopback request was not acknowledged: %v", err)
				}
			} else if err == nil || stub.received.Load() {
				t.Fatal("invalid request received an acknowledgement")
			}
		})
	}
}

func TestKernelLoopbackBoundsConnectionsAndClosesPartialTunnels(t *testing.T) {
	stub := fixtureKernelLoopback(t)
	var connections []net.Conn
	for i := 0; i < kernelReadyMaxConnections; i++ {
		conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		if i%2 == 0 {
			_, _ = io.WriteString(conn, readyConnect(stub))
			if _, err := http.ReadResponse(bufio.NewReader(conn), nil); err != nil {
				t.Fatal(err)
			}
		} else {
			_, _ = io.WriteString(conn, "CONNECT ")
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		stub.mu.Lock()
		active := len(stub.conns)
		stub.mu.Unlock()
		if active == kernelReadyMaxConnections {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d active partial requests, got %d", kernelReadyMaxConnections, active)
		}
		time.Sleep(time.Millisecond)
	}
	extra, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(time.Second))
	var byteBuffer [1]byte
	if _, err := extra.Read(byteBuffer[:]); err == nil {
		t.Fatal("connection beyond the limit was accepted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("connection beyond the limit was left open")
	}
	var closing sync.WaitGroup
	for i := 0; i < 3; i++ {
		closing.Add(1)
		go func() { defer closing.Done(); stub.Close() }()
	}
	closing.Wait()
	for _, conn := range connections {
		if _, err := conn.Read(byteBuffer[:]); err == nil {
			t.Fatal("partial request survived Close")
		} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("Close did not interrupt a partial request")
		}
	}
	stub.mu.Lock()
	active := len(stub.conns)
	stub.mu.Unlock()
	if active != 0 || stub.received.Load() {
		t.Fatalf("Close did not join handlers: active=%d received=%t", active, stub.received.Load())
	}
	if conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), 100*time.Millisecond); err == nil {
		conn.Close()
		t.Fatal("listener survived Close")
	}
}

func TestKernelLoopbackExpiresSlowHeaders(t *testing.T) {
	stub := fixtureKernelLoopback(t)
	conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(conn, "CONNECT ")
	var data [1]byte
	if _, err := conn.Read(data[:]); err == nil {
		t.Fatal("incomplete header was accepted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("server did not expire the slow header")
	}
	stub.Close()
	if stub.received.Load() {
		t.Fatal("slow header produced a receipt")
	}
}

func TestKernelLoopbackLimitsTotalAcceptedConnections(t *testing.T) {
	stub := fixtureKernelLoopback(t)
	for i := 0; i < kernelReadyMaxRequests; i++ {
		conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatalf("listener closed before its connection budget: %d: %v", i, err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		_, _ = io.WriteString(conn, "invalid\r\n\r\n")
		var data [1]byte
		_, err = conn.Read(data[:])
		conn.Close()
		if err == nil {
			t.Fatal("invalid request received a response")
		}
	}
	stub.wg.Wait()
	if conn, err := net.DialTimeout("tcp4", stub.listener.Addr().String(), time.Second); err == nil {
		conn.Close()
		t.Fatal("listener exceeded its total connection budget")
	}
	if stub.received.Load() {
		t.Fatal("invalid requests created a receipt")
	}
}

func fixtureReadinessFrontend(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *url.URL) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("probe:fixture-password"))
		if r.Header.Get("Proxy-Authorization") != expected {
			t.Error("readiness did not authenticate to the original inbound")
			w.WriteHeader(http.StatusProxyAuthRequired)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	proxyURL, _ := url.Parse(server.URL)
	proxyURL.User = url.UserPassword("probe", "fixture-password")
	return server, proxyURL
}

func TestKernelRouteWaitsForCompleteOwnedRoundTrip(t *testing.T) {
	stub := fixtureKernelLoopback(t)
	var allow atomic.Bool
	var requests atomic.Int32
	reached := make(chan struct{}, 1)
	_, proxyURL := fixtureReadinessFrontend(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.Host != stub.host || r.URL.RequestURI() != stub.path {
			t.Error("readiness used a non-local destination")
			w.WriteHeader(400)
			return
		}
		if !allow.Load() {
			select {
			case reached <- struct{}{}:
			default:
			}
			w.WriteHeader(502)
			return
		}
		body, err := exchangeKernelLoopback(stub, readyConnect(stub), readyGet(stub))
		if err != nil {
			t.Error(err)
			w.WriteHeader(502)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = io.WriteString(w, body)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- waitKernelRoute(ctx, make(chan struct{}), proxyURL, stub) }()
	select {
	case <-reached:
	case <-ctx.Done():
		t.Fatal("local startup request was not received")
	}
	select {
	case err := <-result:
		t.Fatalf("an open inbound returning 502 completed readiness: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	allow.Store(true)
	select {
	case err := <-result:
		if err != nil || !stub.received.Load() || requests.Load() < 2 {
			t.Fatalf("owned round trip did not finish readiness: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("owned round trip exceeded the startup budget")
	}
}

func TestKernelRouteRejectsForgedAndMalformedResponses(t *testing.T) {
	for _, scenario := range []string{"forged-body-without-receipt", "wrong-body", "truncated", "oversized", "redirect", "chunked"} {
		t.Run(scenario, func(t *testing.T) {
			stub := fixtureKernelLoopback(t)
			if scenario != "forged-body-without-receipt" {
				if body, err := exchangeKernelLoopback(stub, readyConnect(stub), readyGet(stub)); err != nil || body != stub.body {
					t.Fatalf("could not establish the owned receipt: %v", err)
				}
			}
			var calls atomic.Int32
			_, proxyURL := fixtureReadinessFrontend(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				body := stub.body
				switch scenario {
				case "redirect":
					http.Redirect(w, r, "/other", http.StatusFound)
					return
				case "wrong-body":
					body = strings.Repeat("x", len(body))
				case "truncated":
					w.Header().Set("Content-Length", fmt.Sprint(len(body)))
					_, _ = io.WriteString(w, body[:1])
					return
				case "oversized":
					body += "x"
				case "chunked":
					w.(http.Flusher).Flush()
					_, _ = io.WriteString(w, body)
					return
				}
				w.Header().Set("Content-Length", fmt.Sprint(len(body)))
				_, _ = io.WriteString(w, body)
			})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := waitKernelRoute(ctx, make(chan struct{}), proxyURL, stub); err == nil || calls.Load() != 1 {
				t.Fatalf("malformed or unowned response passed: error=%v calls=%d", err, calls.Load())
			}
		})
	}
}

func TestKernelRouteNeverReadyStaysWithinOriginalBudget(t *testing.T) {
	stub := fixtureKernelLoopback(t)
	var calls atomic.Int32
	_, proxyURL := fixtureReadinessFrontend(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 450*time.Millisecond)
	defer cancel()
	if err := waitKernelRoute(ctx, make(chan struct{}), proxyURL, stub); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("never-ready frontend escaped the startup deadline: %v", err)
	}
	if calls.Load() == 0 || calls.Load() > 4 || stub.received.Load() {
		t.Fatalf("local polling was not bounded: calls=%d received=%t", calls.Load(), stub.received.Load())
	}
}

func TestKernelRouteBoundsStartupAndCancelsInflightRequests(t *testing.T) {
	for _, scenario := range []string{"deadline", "cancelled", "core-exited"} {
		t.Run(scenario, func(t *testing.T) {
			stub := fixtureKernelLoopback(t)
			started, stopped := make(chan struct{}), make(chan struct{})
			_, proxyURL := fixtureReadinessFrontend(t, func(w http.ResponseWriter, r *http.Request) {
				close(started)
				<-r.Context().Done()
				close(stopped)
			})
			budget := 5 * time.Second
			if scenario == "deadline" {
				budget = 350 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), budget)
			defer cancel()
			done := make(chan struct{})
			result := make(chan error, 1)
			go func() { result <- waitKernelRoute(ctx, done, proxyURL, stub) }()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("local request did not start")
			}
			if scenario == "cancelled" {
				cancel()
			} else if scenario == "core-exited" {
				close(done)
			}
			select {
			case err := <-result:
				if err == nil || scenario == "deadline" && !errors.Is(err, context.DeadlineExceeded) || scenario == "cancelled" && !errors.Is(err, context.Canceled) {
					t.Fatalf("startup was not stopped: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("startup did not stop an in-flight request")
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("local request survived startup cancellation")
			}
			stub.Close()
		})
	}
}
