package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

const aliveURL = "https://www.gstatic.com/generate_204"
const speedURL = "https://speed.cloudflare.com/__down?bytes=20971520"

func networkFailure(err error, start time.Time) Check {
	if errors.Is(err, context.Canceled) {
		return measured("cancelled", "cancelled", start)
	}
	var n net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &n) && n.Timeout()) {
		return measured("timeout", "deadline", start)
	}
	return measured("failed", "request_failed", start)
}
func checkTCP(ctx context.Context, p map[string]any, timeout time.Duration) Check {
	if !tcpSupported(p) {
		return failure("unsupported", "unsupported_transport")
	}
	start := time.Now()
	child, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	host, _ := p["server"].(string)
	port, _ := p["port"].(int)
	conn, err := (&net.Dialer{}).DialContext(child, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		r := networkFailure(err, start)
		if r.Status == "failed" {
			r.Code = "connect_failed"
		}
		return r
	}
	conn.Close()
	return measured("passed", "ok", start)
}
func requestGET(ctx context.Context, client *http.Client, target string, timeout time.Duration, limit int64) (int, http.Header, []byte, error) {
	child, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(child, "GET", target, nil)
	if err != nil {
		return 0, nil, nil, errors.New("request_failed")
	}
	req.Header.Set("User-Agent", "MiSub-Probe/"+version)
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp.StatusCode, resp.Header, nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return resp.StatusCode, resp.Header, nil, err
	}
	if int64(len(data)) > limit {
		return resp.StatusCode, resp.Header, nil, errors.New("body_too_large")
	}
	return resp.StatusCode, resp.Header, data, nil
}
func checkProxy(ctx context.Context, client *http.Client, target string, timeout time.Duration) Check {
	start := time.Now()
	status, header, data, err := requestGET(ctx, client, target, timeout, 1024)
	if err != nil {
		return networkFailure(err, start)
	}
	if status == http.StatusTooManyRequests {
		return rateLimited(header, time.Now())
	}
	r := measured("failed", "http_error", start)
	r.HTTPStatus = status
	if status == 204 && len(data) == 0 {
		r.Status = "passed"
		r.Code = "ok"
	}
	return r
}
func checkSpeed(ctx context.Context, client *http.Client, target string, timeout time.Duration, limit int64) Check {
	start := time.Now()
	child, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(child, "GET", target, nil)
	if err != nil {
		return failure("failed", "request_failed")
	}
	req.Header.Set("User-Agent", "MiSub-Probe/"+version)
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := client.Do(req)
	if err != nil {
		return networkFailure(err, start)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return rateLimited(resp.Header, time.Now())
	}
	if resp.StatusCode != 200 || (resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") {
		r := failure("failed", "http_error")
		r.HTTPStatus = resp.StatusCode
		return r
	}
	// Bound payload bytes read even when the server ignores Content-Length or Range.
	n, err := io.Copy(io.Discard, io.LimitReader(resp.Body, limit))
	elapsed := time.Since(start).Seconds()
	if elapsed < 0.001 {
		elapsed = 0.001
	}
	rate := float64(n) / elapsed
	r := measured("passed", "ok", start)
	r.Bytes = &n
	r.BytesPerSecond = &rate
	r.HTTPStatus = resp.StatusCode
	if err != nil {
		r.Status = "failed"
		r.Code = "request_failed"
		if errors.Is(err, context.DeadlineExceeded) || child.Err() == context.DeadlineExceeded {
			r.Status = "timeout"
			r.Code = "deadline"
		}
		if child.Err() == context.Canceled {
			r.Status = "cancelled"
			r.Code = "cancelled"
		}
	} else if n < 65536 {
		r.Status = "unknown"
		r.Code = "probe_inconclusive"
	}
	return r
}
func executeTask(ctx context.Context, t Task, binary string) map[string]Check {
	out := map[string]Check{}
	defer func() {
		if contains(t.Types, "observations") && out["observations"].Report == nil {
			r := out["observations"]
			r.Report = unavailableObservations(t)
			out["observations"] = r
		}
	}()
	if contains(t.Types, "format") {
		out["format"] = t.Node.Format
	}
	rest := func(r Check) {
		for _, typ := range t.Types {
			if typ != "format" {
				out[typ] = r
			}
		}
	}
	if len(t.Types) == 1 && t.Types[0] == "format" {
		return out
	}
	if t.Node.Proxy == nil || t.Node.Format.Status != "passed" {
		rest(failure("skipped", "prerequisite_failed"))
		return out
	}
	timeout := time.Duration(t.Options.TimeoutMs) * time.Millisecond
	pinCtx, cancel := context.WithTimeout(ctx, timeout)
	proxy, err := pinProxy(pinCtx, t.Node.Proxy, defaultLookup)
	cancel()
	if err != nil {
		code := err.Error()
		status := "failed"
		if code == "unsupported_protocol" || code == "unsupported_transport" {
			status = "unsupported"
		}
		if code == "unsafe_target" {
			status = "blocked"
		}
		rest(failure(status, code))
		return out
	}
	if contains(t.Types, "tcp") {
		out["tcp"] = checkTCP(ctx, proxy, timeout)
	}
	if !contains(t.Types, "proxy") && !contains(t.Types, "speed") && !contains(t.Types, "unlock") && !contains(t.Types, "observations") {
		return out
	}
	kernel, err := startKernel(ctx, binary, proxy)
	if err != nil {
		code := err.Error()
		if !contains([]string{"kernel_missing", "kernel_failed", "cancelled"}, code) {
			code = "kernel_failed"
		}
		for _, typ := range []string{"proxy", "speed", "unlock", "observations"} {
			if contains(t.Types, typ) {
				out[typ] = failure("unsupported", code)
			}
		}
		return out
	}
	defer kernel.Close()
	// Proxy success is independent from the TCP test (QUIC protocols do not use TCP).
	alive := failure("skipped", "prerequisite_failed")
	if contains(t.Types, "proxy") || contains(t.Types, "speed") {
		alive = checkProxy(ctx, kernel.Client, aliveURL, timeout)
	}
	if contains(t.Types, "proxy") {
		out["proxy"] = alive
	}
	if contains(t.Types, "speed") {
		if alive.Status != "passed" {
			out["speed"] = failure("skipped", "prerequisite_failed")
		} else {
			out["speed"] = checkSpeed(ctx, kernel.Client, speedURL, timeout, t.Options.DownloadBytes)
		}
	}
	if contains(t.Types, "unlock") {
		// A single URLTest site may be blocked while a service still works. Each service gets its own bounded attempt.
		out["unlock"] = checkServices(ctx, kernel.Client, t.Options.Services, timeout)
	}
	if contains(t.Types, "observations") {
		r := failure("unknown", "probe_inconclusive")
		r.Report = sourceRunner.run(ctx, kernel.Client, t)
		out["observations"] = r
	}
	return out
}
