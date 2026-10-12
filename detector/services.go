package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Fixed public, unauthenticated targets. No account login, API keys, device registration,
// arbitrary target URL or claims about paid playback are part of the probe protocol.
var serviceRegistry = map[string]string{
	"netflix": "https://www.netflix.com/title/81280792",
	"youtube": "https://www.youtube.com/premium",
	"openai":  "https://api.openai.com/v1/models",
	"claude":  "https://claude.ai/login",
	"gemini":  "https://gemini.google.com/",
	"disney":  "https://www.disneyplus.com/",
	"spotify": "https://open.spotify.com/",
	"tiktok":  "https://www.tiktok.com/",
}

func classifyService(service string, status int, body []byte) Check {
	r := failure("unknown", "probe_inconclusive")
	r.HTTPStatus = status
	if status == 429 {
		r.Code = "rate_limited"
		return r
	}
	if service == "openai" {
		var message struct {
			Error struct {
				Code string `json:"code"`
				Type string `json:"type"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &message) == nil {
			if message.Error.Code == "unsupported_country_region_territory" {
				r.Status = "blocked"
				r.Code = "region_blocked"
				return r
			}
			if status == 401 && (message.Error.Code == "invalid_api_key" || message.Error.Type == "invalid_request_error") {
				r.Code = "service_reachable"
				return r
			}
		}
	}
	text := strings.ToLower(string(body))
	// Anti-bot/challenge pages are inconclusive, even if they contain region-related text.
	if strings.Contains(text, "cf-chl-") || strings.Contains(text, "captcha") || strings.Contains(text, "just a moment") {
		return r
	}
	markers := map[string][]string{
		"netflix": {"netflix is not available in your country", "you seem to be using an unblocker or proxy"},
		"youtube": {"youtube premium is not available in your country"},
		"claude":  {"claude is not available in your region", "claude is not available in your country"},
		"gemini":  {"gemini isn’t currently supported in your country", "gemini isn't currently supported in your country"},
		"disney":  {"disney+ is not available in your region", "disney+ is not available in your country"},
		"spotify": {"spotify is currently not available in your country"},
		"tiktok":  {"tiktok is not available in your country"},
	}
	for _, marker := range markers[service] {
		if strings.Contains(text, marker) {
			r.Status = "blocked"
			r.Code = "region_blocked"
			return r
		}
	}
	if status >= 200 && status < 300 {
		r.Code = "service_reachable"
	}
	// 200, generic 403/404 and redirects do NOT prove unlock, blocking or playback rights.
	return r
}
func checkServices(ctx context.Context, client *http.Client, services []string, timeout time.Duration) Check {
	overall := failure("unknown", "probe_inconclusive")
	for _, service := range services {
		if ctx.Err() != nil {
			overall.Services = append(overall.Services, ServiceCheck{service, failure("cancelled", "cancelled")})
			continue
		}
		target, ok := serviceRegistry[service]
		if !ok {
			overall.Services = append(overall.Services, ServiceCheck{service, failure("unsupported", "probe_inconclusive")})
			continue
		}
		func() {
			child, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			start := time.Now()
			req, err := http.NewRequestWithContext(child, "GET", target, nil)
			if err != nil {
				overall.Services = append(overall.Services, ServiceCheck{service, failure("failed", "request_failed")})
				return
			}
			req.Header.Set("User-Agent", "MiSub-Probe/"+version)
			req.Header.Set("Accept-Encoding", "identity")
			resp, err := client.Do(req)
			if err != nil {
				r := networkFailure(err, start)
				r.LatencyMs = nil
				overall.Services = append(overall.Services, ServiceCheck{service, r})
				return
			}
			defer resp.Body.Close()
			// A rate-limit is established by headers. Never read a stalled,
			// oversized or malformed body before preserving this evidence.
			if resp.StatusCode == http.StatusTooManyRequests {
				overall.Services = append(overall.Services, ServiceCheck{service, rateLimited(resp.Header, time.Now())})
				return
			}
			// Inspect a bounded prefix, not the whole page. Missing evidence remains unknown.
			body, err := io.ReadAll(io.LimitReader(resp.Body, 65536))
			if err != nil {
				r := networkFailure(err, start)
				r.LatencyMs = nil
				overall.Services = append(overall.Services, ServiceCheck{service, r})
				return
			}
			overall.Services = append(overall.Services, ServiceCheck{service, classifyService(service, resp.StatusCode, body)})
		}()
	}
	if ctx.Err() != nil {
		overall.Status = "cancelled"
		overall.Code = "cancelled"
	}
	return overall
}
