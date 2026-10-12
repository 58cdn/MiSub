package main

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

const observationsVersion = 1
const observationBodyLimit = 16384

type observationSource struct {
	id, kind, target string
	interval         time.Duration
}

var observationSources = map[string]observationSource{
	"ipify":     {"ipify", "exit", "https://api64.ipify.org?format=json", time.Second},
	"ip_sb":     {"ip_sb", "exit", "https://api.ip.sb/geoip", time.Second},
	"ifconfig":  {"ifconfig", "exit", "https://ifconfig.me/ip", time.Second},
	"icanhazip": {"icanhazip", "exit", "https://icanhazip.com/", time.Second},
	"ipinfo":    {"ipinfo", "exit", "", time.Second},
	"ippure":    {"ippure", "quality", "https://my.ippure.com/v1/info", time.Minute},
}

// Mirrors diagnostics/contract.js v1. Nullable fields remain null when a source
// supplies no evidence; endpoint duration is deliberately not node latency.
type Observation struct {
	Source            string   `json:"source"`
	Kind              string   `json:"kind"`
	Status            string   `json:"status"`
	Error             *string  `json:"error"`
	CheckedAt         string   `json:"checkedAt"`
	DurationMs        int64    `json:"durationMs"`
	ProbeVersion      string   `json:"probeVersion"`
	IP                *string  `json:"ip"`
	Family            *int     `json:"family"`
	CountryCode       *string  `json:"countryCode"`
	ASN               *int64   `json:"asn"`
	RiskScore         *float64 `json:"riskScore"`
	IsResidential     *bool    `json:"isResidential"`
	IsBroadcast       *bool    `json:"isBroadcast"`
	LatencyMs         *int64   `json:"latencyMs"`
	Measurement       *string  `json:"measurement"`
	HTTPStatus        *int     `json:"httpStatus"`
	RetryAfterSeconds *int64   `json:"retryAfterSeconds"`
}
type ObservationReport struct {
	Version   int           `json:"version"`
	RequestID string        `json:"requestId"`
	Scope     string        `json:"scope"`
	Results   []Observation `json:"results"`
}

func newObservation(source observationSource, status, code string, now time.Time) Observation {
	r := Observation{Source: source.id, Kind: source.kind, Status: status, CheckedAt: now.UTC().Format(time.RFC3339Nano), ProbeVersion: "1"}
	if code != "" {
		r.Error = &code
	}
	return r
}
func unavailableObservations(t Task) *ObservationReport {
	r := &ObservationReport{Version: 1, RequestID: t.ID, Scope: "node", Results: make([]Observation, 0, len(t.Options.Sources))}
	for _, id := range t.Options.Sources {
		r.Results = append(r.Results, newObservation(observationSources[id], "unsupported", "transport_unavailable", time.Now()))
	}
	return r
}

type observationRunner struct {
	mu    sync.Mutex
	next  map[string]time.Time
	now   func() time.Time
	slots chan struct{}
}

func newObservationRunner(now func() time.Time) *observationRunner {
	return &observationRunner{next: map[string]time.Time{}, now: now, slots: make(chan struct{}, 3)}
}

var sourceRunner = newObservationRunner(time.Now)

func (r *observationRunner) reserve(s observationSource) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if remaining := r.next[s.id].Sub(now); remaining > 0 {
		return int64(math.Ceil(remaining.Seconds()))
	}
	r.next[s.id] = now.Add(s.interval)
	return 0
}
func (r *observationRunner) backoff(id string, seconds int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if until := r.now().Add(time.Duration(seconds) * time.Second); until.After(r.next[id]) {
		r.next[id] = until
	}
}
func (r *observationRunner) run(ctx context.Context, client *http.Client, t Task) *ObservationReport {
	out := &ObservationReport{Version: 1, RequestID: t.ID, Scope: "node", Results: make([]Observation, len(t.Options.Sources))}
	// Three workers per detector; the lease loop allows only one active task.
	jobs := make(chan int)
	var workers sync.WaitGroup
	for worker := 0; worker < 3; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				out.Results[index] = r.probe(ctx, client, observationSources[t.Options.Sources[index]], time.Duration(t.Options.TimeoutMs)*time.Millisecond)
			}
		}()
	}
	for index := range t.Options.Sources {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	return out
}
func (r *observationRunner) probe(ctx context.Context, client *http.Client, s observationSource, timeout time.Duration) (result Observation) {
	start := r.now()
	result = newObservation(s, "unknown", "no_availability_evidence", start)
	defer func() {
		result.CheckedAt = r.now().UTC().Format(time.RFC3339Nano)
		result.DurationMs = r.now().Sub(start).Milliseconds()
		if result.DurationMs < 0 {
			result.DurationMs = 0
		}
		if result.DurationMs > 30000 {
			result.DurationMs = 30000
		}
	}()
	fail := func(status, code string) Observation {
		v := newObservation(s, status, code, r.now())
		v.HTTPStatus = result.HTTPStatus
		return v
	}
	if ctx.Err() != nil {
		return fail("cancelled", "cancelled")
	}
	if s.id == "ipinfo" {
		return fail("not_configured", "token_required")
	}
	if client == nil || s.target == "" {
		return fail("unsupported", "transport_unavailable")
	}
	child, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-child.Done():
		if ctx.Err() != nil {
			return fail("cancelled", "cancelled")
		}
		return fail("timeout", "timeout")
	}
	if remaining := r.reserve(s); remaining > 0 {
		result = fail("rate_limited", "rate_limited")
		result.RetryAfterSeconds = &remaining
		return
	}
	req, err := http.NewRequestWithContext(child, "GET", s.target, nil)
	if err != nil {
		return fail("error", "network_error")
	}
	req.Header.Set("User-Agent", "MiSub-Probe/"+version)
	req.Header.Set("Accept", "application/json, text/plain")
	req.Header.Set("Accept-Encoding", "identity")
	// Keep the injected node transport, but never follow provider redirects.
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := safeClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fail("cancelled", "cancelled")
		}
		if child.Err() != nil {
			return fail("timeout", "timeout")
		}
		return fail("error", "network_error")
	}
	defer resp.Body.Close()
	result.HTTPStatus = &resp.StatusCode
	if resp.StatusCode == 429 {
		limited := rateLimited(resp.Header, r.now())
		seconds := int64(60)
		if limited.RetryAfterSeconds != nil {
			seconds = *limited.RetryAfterSeconds
		}
		r.backoff(s.id, seconds)
		result = fail("rate_limited", "rate_limited")
		result.RetryAfterSeconds = limited.RetryAfterSeconds
		return
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fail("error", "redirect_rejected")
	}
	if resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity" {
		return fail("error", "invalid_response")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, observationBodyLimit+1))
	if err != nil {
		if ctx.Err() != nil {
			return fail("cancelled", "cancelled")
		}
		if child.Err() != nil {
			return fail("timeout", "timeout")
		}
		return fail("error", "network_error")
	}
	if len(body) > observationBodyLimit {
		return fail("error", "response_too_large")
	}
	return parseObservation(s, resp.StatusCode, body, r.now())
}

func parseObservation(s observationSource, status int, body []byte, now time.Time) Observation {
	r := newObservation(s, "error", "invalid_response", now)
	r.HTTPStatus = &status
	text := strings.ToLower(string(body))
	for _, marker := range []string{"cf-chl-", "cf-mitigated", "just a moment", "captcha", "challenge-platform"} {
		if strings.Contains(text, marker) {
			r.Status = "challenge"
			code := "challenge"
			r.Error = &code
			return r
		}
	}
	if status < 200 || status >= 300 {
		code := "http_error"
		r.Error = &code
		return r
	}
	var data map[string]any
	if s.id == "ifconfig" || s.id == "icanhazip" {
		data = map[string]any{"ip": strings.TrimSpace(string(body))}
	} else if json.Unmarshal(body, &data) != nil || data == nil {
		return r
	}
	ipText, ok := data["ip"].(string)
	if !ok {
		return r
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(ipText))
	if err != nil || ip.Zone() != "" {
		return r
	}
	canonical := ip.String()
	family := 6
	if ip.Is4() {
		family = 4
	}
	r.IP = &canonical
	r.Family = &family
	r.Status = "ok"
	r.Error = nil
	country, _ := data["country_code"].(string)
	if s.id == "ippure" {
		country, _ = data["countryCode"].(string)
	}
	country = strings.ToUpper(country)
	if len(country) == 2 && country[0] >= 'A' && country[0] <= 'Z' && country[1] >= 'A' && country[1] <= 'Z' {
		r.CountryCode = &country
	}
	if value, ok := data["asn"].(float64); ok && value >= 0 && value <= 4294967295 && value == math.Trunc(value) {
		asn := int64(value)
		r.ASN = &asn
	}
	if value, ok := data["asn"].(string); ok && strings.HasPrefix(value, "AS") {
		if asn, err := strconv.ParseInt(value[2:], 10, 64); err == nil && asn >= 0 && asn <= 4294967295 {
			r.ASN = &asn
		}
	}
	if s.kind == "quality" {
		if value, ok := data["fraudScore"].(float64); ok && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 100 {
			r.RiskScore = &value
		}
		if value, ok := data["isResidential"].(bool); ok {
			r.IsResidential = &value
		}
		if value, ok := data["isBroadcast"].(bool); ok {
			r.IsBroadcast = &value
		}
		if r.RiskScore == nil || r.IsResidential == nil || r.IsBroadcast == nil {
			r.Status = "partial"
		}
	}
	return r
}
