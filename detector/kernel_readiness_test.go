package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func unusedKernelFixtureAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func TestKernelReadinessWaitsForProxyAfterAuthenticatedController(t *testing.T) {
	controllerReached := make(chan struct{}, 1)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/version" || r.Header.Get("Authorization") != "Bearer fixture-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		select {
		case controllerReached <- struct{}{}:
		default:
		}
		_, _ = io.WriteString(w, `{"version":"fixture"}`)
	}))
	defer controller.Close()
	proxyAddress := unusedKernelFixtureAddress(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- waitKernelListeners(ctx, make(chan struct{}), controller.Listener.Addr().String(), proxyAddress, "fixture-secret")
	}()
	select {
	case <-controllerReached:
	case <-ctx.Done():
		t.Fatal("controller fixture was not reached")
	}
	select {
	case err := <-result:
		t.Fatalf("controller response alone completed readiness: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	proxy, err := net.Listen("tcp4", proxyAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	probe := make(chan error, 1)
	go func() {
		conn, err := proxy.Accept()
		if err != nil {
			probe <- err
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var data [1]byte
		n, err := conn.Read(data[:])
		if n != 0 || err != io.EOF {
			probe <- errors.New("readiness sent data to the proxy")
			return
		}
		probe <- nil
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("both local listeners did not complete readiness")
	}
	select {
	case err := <-probe:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("local TCP probe did not finish")
	}
}

func TestKernelReadinessMissingProxySharesStartupDeadline(t *testing.T) {
	var controllerRequests atomic.Int32
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controllerRequests.Add(1)
		_, _ = io.WriteString(w, `{"version":"fixture"}`)
	}))
	defer controller.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	err := waitKernelListeners(ctx, make(chan struct{}), controller.Listener.Addr().String(), unusedKernelFixtureAddress(t), "fixture")
	if !errors.Is(err, context.DeadlineExceeded) || controllerRequests.Load() == 0 {
		t.Fatalf("missing proxy escaped the shared deadline: %v, controllerRequests=%d", err, controllerRequests.Load())
	}
}

func TestKernelReadinessRejectsInvalidControllerWithoutProxyTraffic(t *testing.T) {
	for _, scenario := range []string{"unauthorized", "redirect", "empty-version", "invalid-json", "oversized"} {
		t.Run(scenario, func(t *testing.T) {
			proxy, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.Close()
			accepted := make(chan bool, 1)
			go func() {
				conn, err := proxy.Accept()
				if err == nil {
					conn.Close()
				}
				accepted <- err == nil
			}()
			var requests atomic.Int32
			controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path != "/version" {
					t.Error("readiness followed a controller redirect")
				}
				switch scenario {
				case "unauthorized":
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"version":"fixture"}`)
				case "redirect":
					http.Redirect(w, r, "/other", http.StatusFound)
				case "empty-version":
					_, _ = io.WriteString(w, `{"version":""}`)
				case "invalid-json":
					_, _ = io.WriteString(w, "not json")
				case "oversized":
					_, _ = io.WriteString(w, `{"version":"`+strings.Repeat("a", 4097)+`"}`)
				}
			}))
			defer controller.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			err = waitKernelListeners(ctx, make(chan struct{}), controller.Listener.Addr().String(), proxy.Addr().String(), "fixture")
			if !errors.Is(err, context.DeadlineExceeded) || requests.Load() == 0 {
				t.Fatalf("invalid controller completed readiness: %v, requests=%d", err, requests.Load())
			}
			proxy.Close()
			if <-accepted {
				t.Fatal("invalid controller allowed a proxy connection")
			}
		})
	}
}

func TestKernelReadinessStopsForCancellationAndProcessExit(t *testing.T) {
	for _, exited := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		done := make(chan struct{})
		if exited {
			close(done)
		} else {
			cancel()
		}
		err := waitKernelListeners(ctx, done, "127.0.0.1:1", "127.0.0.1:1", "fixture")
		cancel()
		if exited && (err == nil || err.Error() != "kernel_failed") || !exited && !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled/exited core did not stop readiness: exited=%t error=%v", exited, err)
		}
	}
}

func TestKernelReadinessBoundsInFlightControllerRequest(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer controller.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	err := waitKernelListeners(ctx, make(chan struct{}), controller.Listener.Addr().String(), "127.0.0.1:1", "fixture")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("in-flight controller request exceeded startup budget: %v", err)
	}
	select {
	case <-started:
	default:
		t.Fatal("controller request never started")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("startup deadline did not cancel the controller request")
	}
}
