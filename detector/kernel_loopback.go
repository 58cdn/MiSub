package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

const (
	kernelReadyMaxConnections = 4
	kernelReadyMaxRequests    = 128
	kernelReadyHeaderBytes    = 4096
)

// kernelLoopback only acknowledges one locally generated request. It never
// resolves a destination or opens an outbound connection.
type kernelLoopback struct {
	listener net.Listener
	host     string
	path     string
	name     string
	password string
	body     string
	received atomic.Bool
	mu       sync.Mutex
	closed   bool
	conns    map[net.Conn]struct{}
	wg       sync.WaitGroup
	once     sync.Once
}

func newKernelLoopback() (*kernelLoopback, error) {
	nonce, err := newSecret()
	if err != nil {
		return nil, err
	}
	password, err := newSecret()
	if err != nil {
		return nil, err
	}
	body, err := newSecret()
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &kernelLoopback{
		listener: listener, host: nonce[:32] + ".reserved.invalid", path: "/" + nonce[32:],
		name: "misub-ready-" + nonce[:32], password: password, body: "misub-ready-" + body,
		conns: make(map[net.Conn]struct{}),
	}
	s.wg.Add(1)
	go s.serve()
	return s, nil
}

func (s *kernelLoopback) proxy() map[string]any {
	return map[string]any{
		"name": s.name, "type": "http", "server": "127.0.0.1",
		"port": s.listener.Addr().(*net.TCPAddr).Port, "username": "ready", "password": s.password,
	}
}

func (s *kernelLoopback) authorization() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte("ready:"+s.password))
}

func (s *kernelLoopback) Close() {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.listener.Close()
		for conn := range s.conns {
			conn.Close()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
}

func (s *kernelLoopback) serve() {
	defer s.wg.Done()
	for accepted := 0; accepted < kernelReadyMaxRequests; accepted++ {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed || len(s.conns) >= kernelReadyMaxConnections {
			conn.Close()
			s.mu.Unlock()
			continue
		}
		s.conns[conn] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go func() {
			defer s.wg.Done()
			defer func() {
				conn.Close()
				s.mu.Lock()
				delete(s.conns, conn)
				s.mu.Unlock()
			}()
			s.handle(conn)
		}()
	}
	s.listener.Close()
}

// Bound both request headers before HTTP parsing; no body or second request is
// accepted. The same connection deadline covers CONNECT, GET and the response.
func readKernelReadyRequest(reader *bufio.Reader) (*http.Request, error) {
	var header []byte
	for len(header) < kernelReadyHeaderBytes {
		line, err := reader.ReadSlice('\n')
		if err != nil || len(header)+len(line) > kernelReadyHeaderBytes {
			return nil, errors.New("invalid_readiness_request")
		}
		header = append(header, line...)
		if bytes.Equal(line, []byte("\r\n")) {
			req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header)))
			if err != nil {
				return nil, err
			}
			if req.ContentLength != 0 || len(req.TransferEncoding) != 0 || len(req.Trailer) != 0 || req.Header.Get("Expect") != "" {
				req.Body.Close()
				return nil, errors.New("invalid_readiness_request")
			}
			return req, nil
		}
	}
	return nil, errors.New("invalid_readiness_request")
}

func (s *kernelLoopback) handle(conn net.Conn) {
	if conn.SetDeadline(time.Now().Add(time.Second)) != nil {
		return
	}
	reader := bufio.NewReaderSize(conn, kernelReadyHeaderBytes)
	connect, err := readKernelReadyRequest(reader)
	if err != nil {
		return
	}
	defer connect.Body.Close()
	authority := net.JoinHostPort(s.host, "80")
	auth := connect.Header.Values("Proxy-Authorization")
	if connect.Method != http.MethodConnect || connect.RequestURI != authority || connect.Host != authority || len(auth) != 1 || subtle.ConstantTimeCompare([]byte(auth[0]), []byte(s.authorization())) != 1 {
		return
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	request, err := readKernelReadyRequest(reader)
	if err != nil {
		return
	}
	defer request.Body.Close()
	if request.Method != http.MethodGet || request.Host != s.host || request.RequestURI != s.path {
		return
	}
	s.received.Store(true)
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n%s", len(s.body), s.body)
}

// A successful HTTP round trip through the ordinary authenticated inbound and
// the exact local rule proves that the core accepts HTTP traffic after OnRunning.
// This is not a connectivity or latency measurement of the selected node.
func waitKernelRoute(ctx context.Context, done <-chan struct{}, proxyURL *url.URL, stub *kernelLoopback) error {
	probeContext, cancel := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-done:
			cancel()
		case <-probeContext.Done():
		}
	}()
	defer func() { cancel(); <-watchDone }()
	dialer := net.Dialer{Timeout: time.Second}
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true, DisableCompression: true,
		MaxResponseHeaderBytes: kernelReadyHeaderBytes, ResponseHeaderTimeout: time.Second,
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if address != proxyURL.Host {
				return nil, errors.New("invalid_readiness_destination")
			}
			return dialer.DialContext(ctx, "tcp4", proxyURL.Host)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return errors.New("kernel_failed")
		case <-probeContext.Done():
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("kernel_failed")
		case <-tick.C:
			request, _ := http.NewRequestWithContext(probeContext, http.MethodGet, "http://"+stub.host+stub.path, nil)
			response, err := client.Do(request)
			if err != nil {
				continue
			}
			body, readErr := io.ReadAll(io.LimitReader(response.Body, int64(len(stub.body)+1)))
			response.Body.Close()
			if response.StatusCode == http.StatusBadGateway {
				continue
			}
			if readErr != nil || response.StatusCode != http.StatusOK || response.ContentLength != int64(len(stub.body)) || string(body) != stub.body || !stub.received.Load() {
				return errors.New("kernel_failed")
			}
			select {
			case <-done:
				return errors.New("kernel_failed")
			case <-probeContext.Done():
				return probeContext.Err()
			default:
				return nil
			}
		}
	}
}
