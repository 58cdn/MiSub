package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func observationTask(sources ...string) Task {
	return Task{ID: "fixture-task", LeaseToken: strings.Repeat("a", 64), LeaseMs: 90000, Attempt: 1, Types: []string{"observations"}, Options: Options{ObservationsVersion: 1, Sources: sources, TimeoutMs: 1000, DownloadBytes: 65536}}
}

func TestObservationSharedWireFixture(t *testing.T) {
	var fixture struct {
		Responses map[string]string `json:"responses"`
		Report    ObservationReport `json:"report"`
	}
	data, err := os.ReadFile("testdata/observations-v1.json")
	if err != nil || json.Unmarshal(data, &fixture) != nil {
		t.Fatal("invalid shared fixture")
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, expected := range fixture.Report.Results {
		actual := parseObservation(observationSources[expected.Source], 200, []byte(fixture.Responses[expected.Source]), now)
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("Go/JS source wire fixture differs for %s: %+v", expected.Source, actual)
		}
	}
	encoded, _ := json.Marshal(fixture.Report)
	var typed, original any
	_ = json.Unmarshal(encoded, &typed)
	var raw struct {
		Report json.RawMessage `json:"report"`
	}
	_ = json.Unmarshal(data, &raw)
	_ = json.Unmarshal(raw.Report, &original)
	if !reflect.DeepEqual(typed, original) {
		t.Fatal("Go wire fields do not match shared JSON contract")
	}
}
func TestObservationParsingKeepsUnknownQualityFields(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r := parseObservation(observationSources["ippure"], 200, []byte(`{"ip":"198.51.100.1","countryCode":"jp","asn":"AS123","fraudScore":7.5,"isResidential":false}`), now)
	if r.Status != "partial" || r.RiskScore == nil || *r.RiskScore != 7.5 || r.IsResidential == nil || *r.IsResidential || r.IsBroadcast != nil || r.CountryCode == nil || *r.CountryCode != "JP" || r.ASN == nil || *r.ASN != 123 {
		t.Fatalf("lost independent evidence: %+v", r)
	}
	if r.LatencyMs != nil || r.Measurement != nil {
		t.Fatal("quality endpoint duration became node latency")
	}
	for _, body := range []string{`{"ip":"2001:db8::1","fraudScore":101,"isResidential":"false"}`, `{"ip":"2001:db8::1","fraudScore":null}`} {
		r = parseObservation(observationSources["ippure"], 200, []byte(body), now)
		if r.Status != "partial" || r.RiskScore != nil || r.IsResidential != nil || r.Family == nil || *r.Family != 6 {
			t.Fatal("missing/invalid quality evidence fabricated")
		}
	}
	for _, id := range []string{"ipify", "ip_sb"} {
		r = parseObservation(observationSources[id], 200, []byte(`{"ip":"198.51.100.1","fraudScore":9,"isResidential":true}`), now)
		if r.Status != "ok" || r.RiskScore != nil || r.IsResidential != nil {
			t.Fatal("exit source supplied quality conclusion")
		}
	}
}
func TestObservationFailureEvidenceIsBounded(t *testing.T) {
	now := time.Now()
	for _, body := range []string{`not-json`, `{"ip":"bad"}`, `{"ip":"1.2.3.4"} trailing`, `{"ip":"fe80::1%en0"}`} {
		if r := parseObservation(observationSources["ipify"], 200, []byte(body), now); r.Status != "error" || r.IP != nil {
			t.Fatal("invalid provider payload accepted")
		}
	}
	r := parseObservation(observationSources["ip_sb"], 403, []byte(`captcha region blocked`), now)
	if r.Status != "challenge" || r.IP != nil || r.Error == nil || *r.Error != "challenge" {
		t.Fatal("challenge fabricated evidence")
	}
	r = parseObservation(observationSources["ifconfig"], 200, []byte(" 2001:db8::1\n"), now)
	if r.Status != "ok" || r.CountryCode != nil || *r.Family != 6 {
		t.Fatal("plain IP misparsed")
	}
}
func TestObservationRequestsAreFixedBoundedAndConcurrent(t *testing.T) {
	var active, maxActive, calls atomic.Int32
	client := &http.Client{Transport: fixtureRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		count := active.Add(1)
		defer active.Add(-1)
		for old := maxActive.Load(); count > old; old = maxActive.Load() {
			if maxActive.CompareAndSwap(old, count) {
				break
			}
		}
		if req.URL.Scheme != "https" || req.Header.Get("User-Agent") == "" || req.Header.Get("Accept-Encoding") != "identity" || req.Header.Get("Authorization") != "" {
			t.Error("unsafe observation request")
		}
		found := false
		for _, s := range observationSources {
			if s.target == req.URL.String() {
				found = true
			}
		}
		if !found {
			t.Error("arbitrary target")
		}
		time.Sleep(15 * time.Millisecond)
		body := `{"ip":"198.51.100.1"}`
		if req.URL.Host == "ifconfig.me" || req.URL.Host == "icanhazip.com" {
			body = "198.51.100.1"
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	r := newObservationRunner(time.Now).run(context.Background(), client, observationTask("ipify", "ip_sb", "ifconfig", "icanhazip", "ippure", "ipinfo"))
	if calls.Load() != 5 || maxActive.Load() > 3 || maxActive.Load() < 2 || len(r.Results) != 6 {
		t.Fatalf("concurrency/calls: %d/%d", maxActive.Load(), calls.Load())
	}
	if r.Results[5].Status != "not_configured" || r.Results[5].HTTPStatus != nil {
		t.Fatal("unconfigured IPinfo contacted")
	}
	for _, result := range r.Results {
		if result.LatencyMs != nil || result.ProbeVersion != "1" || result.CheckedAt == "" {
			t.Fatal("invalid source metadata")
		}
	}
}
func TestObservation429AndCooldownNeverReadBody(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	runner := newObservationRunner(func() time.Time { return now })
	body := &unreadableBody{}
	calls := 0
	client := &http.Client{Transport: fixtureRoundTripper(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"120"}}, Body: body}, nil
	})}
	one := runner.run(context.Background(), client, observationTask("ipify")).Results[0]
	two := runner.run(context.Background(), client, observationTask("ipify")).Results[0]
	if one.Status != "rate_limited" || one.HTTPStatus == nil || *one.HTTPStatus != 429 || *one.RetryAfterSeconds != 120 || body.reads != 0 || !body.closed || calls != 1 {
		t.Fatal("429 evidence masked or retried")
	}
	if two.Status != "rate_limited" || two.HTTPStatus != nil || *two.RetryAfterSeconds != 120 {
		t.Fatal("local cooldown confused with provider response")
	}
	now = now.Add(121 * time.Second)
	runner.run(context.Background(), client, observationTask("ipify"))
	if calls != 2 {
		t.Fatal("cooldown never expires")
	}
}
func TestObservationRedirectSizeAndCancellation(t *testing.T) {
	for _, kind := range []string{"redirect", "large", "timeout", "cancelled"} {
		calls := 0
		ctx, cancel := context.WithCancel(context.Background())
		client := &http.Client{Transport: fixtureRoundTripper(func(req *http.Request) (*http.Response, error) {
			calls++
			if kind == "timeout" || kind == "cancelled" {
				if kind == "cancelled" {
					cancel()
				}
				<-req.Context().Done()
				return nil, req.Context().Err()
			}
			if kind == "redirect" {
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.invalid/"}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", observationBodyLimit+1)))}, nil
		})}
		r := newObservationRunner(time.Now).probe(ctx, client, observationSources["ipify"], 20*time.Millisecond)
		cancel()
		want := map[string]string{"redirect": "redirect_rejected", "large": "response_too_large", "timeout": "timeout", "cancelled": "cancelled"}[kind]
		if r.Error == nil || *r.Error != want || calls != 1 || r.IP != nil {
			t.Fatalf("%s: %+v calls=%d", kind, r, calls)
		}
	}
}
func TestObservationCapabilityAndTransportFailures(t *testing.T) {
	task := observationTask("ipify")
	if task.validate() != nil {
		t.Fatal("valid observation task rejected")
	}
	task.Options.ObservationsVersion = 2
	if task.validate() == nil {
		t.Fatal("unknown schema accepted")
	}
	task.Options.ObservationsVersion = 1
	task.Options.Sources = []string{"ping0"}
	if task.validate() == nil {
		t.Fatal("disabled scraper accepted")
	}
	task.Options.Sources = []string{"ipify", "ipify"}
	if task.validate() == nil {
		t.Fatal("duplicate work accepted")
	}
	task.Options.Sources = []string{"ipify"}
	task.Node.Format = failure("failed", "invalid_format")
	r := executeTask(context.Background(), task, "")["observations"]
	if r.Report == nil || len(r.Report.Results) != 1 || r.Report.Results[0].Status != "unsupported" {
		t.Fatal("prerequisite failure lost per-source result")
	}
	if result := newObservationRunner(time.Now).run(context.Background(), nil, task).Results[0]; result.Status != "unsupported" {
		t.Fatal("missing node transport fell back to direct")
	}
	encoded, _ := json.Marshal(r.Report)
	for _, field := range []string{`"scope":"node"`, `"ip":null`, `"riskScore":null`, `"latencyMs":null`, `"probeVersion":"1"`} {
		if !strings.Contains(string(encoded), field) {
			t.Fatalf("wire omitted nullable field %s", field)
		}
	}
}
