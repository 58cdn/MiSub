package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestRejectNestedAndCoercedTLSBypassesBeforeDNS(t *testing.T) {
	for _, value := range []any{true, "true", "false", 1, nil} {
		for _, nested := range []bool{false, true} {
			p := map[string]any{"type": "ss", "server": "node.example", "port": 443}
			if nested {
				p["plugin-opts"] = map[string]any{"tls": true, "skip-cert-verify": value}
			} else {
				p["skip-cert-verify"] = value
			}
			called := false
			_, err := pinProxy(context.Background(), p, func(context.Context, string, string) ([]netip.Addr, error) {
				called = true
				return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
			})
			if err == nil || err.Error() != "unsupported_transport" || called {
				t.Errorf("nested=%v value=%v: err=%v lookup=%v", nested, value, err, called)
			}
		}
	}
}

func TestSOCKSTLSDoesNotPretendGenericSNIWorks(t *testing.T) {
	lookup := func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	}
	for _, p := range []map[string]any{
		{"type": "socks5", "server": "node.example", "port": 443, "tls": true},
		{"type": "socks5", "server": "1.1.1.1", "port": 443, "tls": true, "sni": "node.example"},
		{"type": "socks5", "server": "node.example", "port": 443, "tls": "true"},
		{"type": "socks5", "server": "node.example", "port": 443, "TLS": true},
		{"type": "socks5", "server": "1.1.1.1", "Server": "node.example", "port": 443, "tls": true},
	} {
		if _, err := pinProxy(context.Background(), p, lookup); err == nil || err.Error() != "unsupported_transport" {
			t.Errorf("TLS identity cannot be preserved: %v", err)
		}
	}
	for _, p := range []map[string]any{
		{"type": "socks5", "server": "node.example", "port": 1080},
		{"type": "socks5", "server": "1.1.1.1", "port": 443, "tls": true, "skip-cert-verify": false},
		{"type": "ss", "server": "node.example", "port": 443, "plugin": "v2ray-plugin", "plugin-opts": map[string]any{"tls": true, "skip-cert-verify": false, "host": "tls.example", "headers": map[string]any{"Host": "override.example"}}},
	} {
		out, err := pinProxy(context.Background(), p, lookup)
		if err != nil || out["server"] != "1.1.1.1" {
			t.Fatalf("supported verified transport rejected: %v", err)
		}
		if p["plugin-opts"] != nil {
			opts := out["plugin-opts"].(map[string]any)
			if opts["host"] != "tls.example" || opts["headers"].(map[string]any)["Host"] != "override.example" {
				t.Fatal("plugin identity rewritten")
			}
		}
	}
}

func TestRejectCoreDecoderAliasesBeforeDNS(t *testing.T) {
	for _, key := range []string{"skip_cert_verify", "SKIP_CERT_VERIFY", "Skip-Cert-Verify", "dialer_proxy", "routing_mark", "interface_name", "xhttp_opts", "name_cert_verify", "realm_opts", "Realm-Opts", "tlſ", "peerſ", "ſmux"} {
		for _, nested := range []bool{false, true} {
			p := map[string]any{"type": "socks5", "server": "node.example", "port": 443}
			if nested {
				p["plugin-opts"] = map[string]any{key: true}
			} else {
				p[key] = true
			}
			called := false
			_, err := pinProxy(context.Background(), p, func(context.Context, string, string) ([]netip.Addr, error) {
				called = true
				return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
			})
			if err == nil || err.Error() != "unsupported_transport" || called {
				t.Errorf("decoder alias %q nested=%v accepted: %v", key, nested, err)
			}
		}
	}
}

func TestRejectRealmSecondaryTargetsBeforeDNS(t *testing.T) {
	p := map[string]any{"type": "hysteria2", "server": "node.example", "port": 443, "realm-opts": map[string]any{"server-url": "https://other.invalid/", "stun-servers": []any{"127.0.0.1:3478"}}}
	called := false
	_, err := pinProxy(context.Background(), p, func(context.Context, string, string) ([]netip.Addr, error) { called = true; return nil, nil })
	if err == nil || err.Error() != "unsupported_transport" || called {
		t.Fatalf("Realm secondary target accepted: %v", err)
	}
}

type fixtureRoundTripper func(*http.Request) (*http.Response, error)

func (f fixtureRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type unreadableBody struct {
	reads  int
	closed bool
}

func (b *unreadableBody) Read([]byte) (int, error) {
	b.reads++
	return 0, errors.New("fixture body failure")
}
func (b *unreadableBody) Close() error { b.closed = true; return nil }

func TestRateLimitHeadersSurviveUnreadableBodies(t *testing.T) {
	for _, kind := range []string{"unlock", "proxy", "speed"} {
		body := &unreadableBody{}
		client := &http.Client{Transport: fixtureRoundTripper(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"120"}}, Body: body}, nil
		})}
		var r Check
		switch kind {
		case "unlock":
			r = checkServices(context.Background(), client, []string{"openai"}, time.Second).Services[0].Check
		case "proxy":
			r = checkProxy(context.Background(), client, "https://fixture.invalid/", time.Second)
		case "speed":
			r = checkSpeed(context.Background(), client, "https://fixture.invalid/", time.Second, 65536)
		}
		encoded, _ := json.Marshal(r)
		if r.Code != "rate_limited" || r.HTTPStatus != 429 || !strings.Contains(string(encoded), `"retryAfterSeconds":120`) || body.reads != 0 || !body.closed {
			t.Errorf("%s: %s reads=%d closed=%v", kind, encoded, body.reads, body.closed)
		}
	}
}

func TestRateLimitDoesNotWaitForStalledBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(429)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	start := time.Now()
	r := checkProxy(context.Background(), server.Client(), server.URL, time.Second)
	if r.Code != "rate_limited" || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("429 masked by stalled body: %+v", r)
	}
}

func TestProviderTLSVerificationAndCancellation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	if r := checkProxy(context.Background(), &http.Client{}, server.URL, time.Second); r.Status == "passed" {
		t.Fatal("untrusted provider certificate accepted")
	}
	if r := checkProxy(context.Background(), server.Client(), server.URL, time.Second); r.Status != "passed" {
		t.Fatal("fixture trusted certificate failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := checkProxy(ctx, server.Client(), server.URL, time.Second); r.Status != "cancelled" {
		t.Fatal("cancellation ignored")
	}
}

func TestRateLimitRetryAfterBounds(t *testing.T) {
	for _, value := range []string{"-1", "-0", "+120", "1.5", "not-a-date", strings.Repeat("9", 400), "120\nsecret"} {
		client := &http.Client{Transport: fixtureRoundTripper(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{value}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}
		r := checkServices(context.Background(), client, []string{"netflix"}, time.Second).Services[0].Check
		encoded, _ := json.Marshal(r)
		if r.Code != "rate_limited" || strings.Contains(string(encoded), `retryAfterSeconds`) {
			t.Errorf("untrusted Retry-After retained: %s", encoded)
		}
	}
}

func TestRetryAfterDatesAndClamping(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for value, want := range map[string]int64{"0": 0, "999999": 86400, now.Add(45 * time.Second).Format(http.TimeFormat): 45, now.Add(-time.Hour).Format(http.TimeFormat): 0} {
		r := rateLimited(http.Header{"Retry-After": []string{value}}, now)
		if r.RetryAfterSeconds == nil || *r.RetryAfterSeconds != want {
			t.Errorf("Retry-After %q: %+v", value, r)
		}
	}
}
