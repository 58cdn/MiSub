package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

const contractFixtureTime = "2026-01-01T00:00:00Z"

type resultContractFixture struct {
	Name     string           `json:"name"`
	Types    []string         `json:"types"`
	Services []string         `json:"services,omitempty"`
	Checks   map[string]Check `json:"checks"`
}

type contractRoundTripper func(*http.Request) (*http.Response, error)

func (f contractRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type contractErrorReader struct {
	err error
}

func (r contractErrorReader) Read([]byte) (int, error) { return 0, r.err }

type contractCancelReader struct {
	cancel context.CancelFunc
}

func (r contractCancelReader) Read([]byte) (int, error) {
	r.cancel()
	return 0, context.Canceled
}

type contractForbiddenReader struct {
	t *testing.T
}

func (r contractForbiddenReader) Read([]byte) (int, error) {
	r.t.Fatal("rate-limited response body must not be read")
	return 0, errors.New("unexpected_body_read")
}

// Dynamic observations are checked against their real bounds before replacing
// only their values for a deterministic, shared Go/JavaScript wire fixture.
func normalizeContractCheck(t *testing.T, check Check, started time.Time) Check {
	t.Helper()
	if check.LatencyMs != nil {
		if *check.LatencyMs < 0 || *check.LatencyMs > 180000 {
			t.Fatalf("invalid measured latency: %d", *check.LatencyMs)
		}
		value := int64(7)
		check.LatencyMs = &value
	}
	if check.BytesPerSecond != nil {
		value := *check.BytesPerSecond
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1e12 {
			t.Fatalf("invalid measured speed: %g", value)
		}
		if value > 0 {
			value = 1234.5
		}
		check.BytesPerSecond = &value
	}
	for index := range check.Services {
		service := &check.Services[index]
		checked, err := time.Parse(time.RFC3339Nano, service.CheckedAt)
		if err != nil || checked.Before(started) || checked.After(time.Now()) {
			t.Fatalf("invalid provider completion time: %q", service.CheckedAt)
		}
		service.CheckedAt = contractFixtureTime
		service.Check = normalizeContractCheck(t, service.Check, started)
	}
	return check
}

func TestProductionChecksMatchSharedResultContract(t *testing.T) {
	encoded, err := os.ReadFile("../tests/fixtures/probe-check-results.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int                     `json:"version"`
		Cases   []resultContractFixture `json:"cases"`
	}
	if err := json.Unmarshal(encoded, &fixture); err != nil || fixture.Version != 1 {
		t.Fatalf("invalid shared result fixture: %v", err)
	}
	started := time.Now()
	generated := make(map[string]resultContractFixture)
	add := func(name, typ string, check Check, services ...string) {
		generated[name] = resultContractFixture{Name: name, Types: []string{typ}, Services: services, Checks: map[string]Check{typ: check}}
	}
	responseClient := func(status int, header http.Header, body io.Reader) *http.Client {
		return &http.Client{Transport: contractRoundTripper(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(body)}, nil
		})}
	}
	errorClient := func(err error) *http.Client {
		return &http.Client{Transport: contractRoundTripper(func(*http.Request) (*http.Response, error) { return nil, err })}
	}
	ctx := context.Background()
	const target = "https://fixture.invalid/"
	const limit int64 = 65536
	for _, item := range []struct {
		name string
		err  error
	}{
		{"request_failed", errors.New("fixture network failure")},
		{"timeout", context.DeadlineExceeded},
		{"cancelled", context.Canceled},
	} {
		add("proxy_"+item.name, "proxy", checkProxy(ctx, errorClient(item.err), target, time.Second))
		add("speed_"+item.name, "speed", checkSpeed(ctx, errorClient(item.err), target, time.Second, limit))
		add("service_"+item.name, "unlock", checkServices(ctx, errorClient(item.err), []string{"netflix"}, time.Second), "netflix")
	}
	add("proxy_passed", "proxy", checkProxy(ctx, responseClient(204, nil, strings.NewReader("")), target, time.Second))
	add("proxy_http_error", "proxy", checkProxy(ctx, responseClient(403, nil, strings.NewReader("")), target, time.Second))
	add("proxy_oversized", "proxy", checkProxy(ctx, responseClient(200, nil, strings.NewReader(strings.Repeat("x", 1025))), target, time.Second))
	add("speed_passed", "speed", checkSpeed(ctx, responseClient(200, nil, strings.NewReader(strings.Repeat("x", int(limit)+1))), target, time.Second, limit))
	add("speed_empty", "speed", checkSpeed(ctx, responseClient(200, nil, strings.NewReader("")), target, time.Second, limit))
	add("speed_short", "speed", checkSpeed(ctx, responseClient(200, nil, strings.NewReader(strings.Repeat("x", 1024))), target, time.Second, limit))
	add("speed_http_error", "speed", checkSpeed(ctx, responseClient(403, nil, strings.NewReader("")), target, time.Second, limit))
	add("speed_compressed", "speed", checkSpeed(ctx, responseClient(200, http.Header{"Content-Encoding": []string{"gzip"}}, strings.NewReader("")), target, time.Second, limit))
	add("speed_invalid_request", "speed", checkSpeed(ctx, errorClient(errors.New("unused transport")), "%", time.Second, limit))
	for _, item := range []struct {
		name string
		err  error
	}{
		{"failed", io.ErrUnexpectedEOF},
		{"timeout", context.DeadlineExceeded},
	} {
		body := io.MultiReader(strings.NewReader(strings.Repeat("x", 1024)), contractErrorReader{item.err})
		add("speed_partial_"+item.name, "speed", checkSpeed(ctx, responseClient(200, nil, body), target, time.Second, limit))
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	body := io.MultiReader(strings.NewReader(strings.Repeat("x", 1024)), contractCancelReader{cancel})
	add("speed_partial_cancelled", "speed", checkSpeed(cancelCtx, responseClient(200, nil, body), target, time.Second, limit))
	cancel()
	for _, typ := range []string{"proxy", "speed", "unlock"} {
		client := responseClient(429, http.Header{"Retry-After": []string{"120"}}, contractForbiddenReader{t})
		switch typ {
		case "proxy":
			add("proxy_rate_limited", typ, checkProxy(ctx, client, target, time.Second))
		case "speed":
			add("speed_rate_limited", typ, checkSpeed(ctx, client, target, time.Second, limit))
		case "unlock":
			add("service_rate_limited", typ, checkServices(ctx, client, []string{"netflix"}, time.Second), "netflix")
		}
	}
	for _, item := range []struct {
		name    string
		service string
		status  int
		body    string
	}{
		{"service_reachable", "netflix", 200, "welcome"},
		{"service_openai_unauthenticated", "openai", 401, `{"error":{"code":"invalid_api_key"}}`},
		{"service_openai_blocked", "openai", 403, `{"error":{"code":"unsupported_country_region_territory"}}`},
		{"service_blocked_200", "youtube", 200, "YouTube Premium is not available in your country"},
		{"service_challenge", "youtube", 403, "captcha YouTube Premium is not available in your country"},
		{"service_redirect", "netflix", 302, "redirect"},
	} {
		add(item.name, "unlock", checkServices(ctx, responseClient(item.status, nil, strings.NewReader(item.body)), []string{item.service}, time.Second), item.service)
	}
	cancelCtx, cancel = context.WithCancel(ctx)
	cancel()
	add("services_cancelled_before_start", "unlock", checkServices(cancelCtx, errorClient(errors.New("unused transport")), []string{"netflix", "youtube"}, time.Second), "netflix", "youtube")
	cancelCtx, cancel = context.WithCancel(ctx)
	client := &http.Client{Transport: contractRoundTripper(func(*http.Request) (*http.Response, error) {
		cancel()
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("welcome"))}, nil
	})}
	add("services_cancelled_after_evidence", "unlock", checkServices(cancelCtx, client, []string{"netflix", "youtube"}, time.Second), "netflix", "youtube")
	cancel()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	proxy := map[string]any{"type": "ss", "server": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port}
	add("tcp_passed", "tcp", checkTCP(ctx, proxy, time.Second))
	cancelCtx, cancel = context.WithCancel(ctx)
	cancel()
	add("tcp_cancelled", "tcp", checkTCP(cancelCtx, proxy, time.Second))
	deadlineCtx, stop := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	add("tcp_timeout", "tcp", checkTCP(deadlineCtx, proxy, time.Second))
	stop()
	add("tcp_unsupported", "tcp", checkTCP(ctx, map[string]any{"type": "tuic"}, time.Second))
	for _, item := range []struct {
		name  string
		proxy map[string]any
	}{
		{"task_prerequisite_failed", nil},
		{"task_invalid_format", map[string]any{"type": "ss", "server": "1.1.1.1", "port": 0}},
		{"task_unsupported_protocol", map[string]any{"type": "invalid"}},
		{"task_unsupported_transport", map[string]any{"type": "ss", "network": "invalid"}},
		{"task_unsafe_target", map[string]any{"type": "ss", "server": "127.0.0.1", "port": 443}},
	} {
		task := Task{Node: Node{Proxy: item.proxy, Format: failure("passed", "ok")}, Types: []string{"tcp", "proxy", "speed", "unlock"}, Options: Options{TimeoutMs: 1000}}
		generated[item.name] = resultContractFixture{Name: item.name, Types: task.Types, Checks: executeTask(ctx, task, "")}
	}
	task := Task{Node: Node{Proxy: map[string]any{"type": "ss", "server": "1.1.1.1", "port": 443}, Format: failure("passed", "ok")}, Types: []string{"proxy", "speed", "unlock"}, Options: Options{TimeoutMs: 1000}}
	generated["task_kernel_missing"] = resultContractFixture{Name: "task_kernel_missing", Types: task.Types, Checks: executeTask(ctx, task, "")}

	if len(fixture.Cases) != len(generated) {
		t.Fatalf("shared fixture has %d cases, production exercise has %d", len(fixture.Cases), len(generated))
	}
	seen := make(map[string]bool)
	for _, expected := range fixture.Cases {
		t.Run(expected.Name, func(t *testing.T) {
			actual, ok := generated[expected.Name]
			if !ok || seen[expected.Name] {
				t.Fatal("missing or duplicate production case")
			}
			seen[expected.Name] = true
			for typ, check := range actual.Checks {
				actual.Checks[typ] = normalizeContractCheck(t, check, started)
			}
			if !reflect.DeepEqual(actual, expected) {
				got, _ := json.Marshal(actual)
				want, _ := json.Marshal(expected)
				t.Fatalf("production wire result differs\ngot:  %s\nwant: %s", got, want)
			}
		})
	}
}
