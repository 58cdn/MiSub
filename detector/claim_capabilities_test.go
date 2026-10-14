package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type claimCapabilitiesTransport func(*http.Request) (*http.Response, error)

func (f claimCapabilitiesTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestClaimCapabilitiesWireCompatibility(t *testing.T) {
	for _, legacy := range []bool{true, false} {
		name := "versioned-server"
		if legacy {
			name = "legacy-server"
		}
		for _, idle := range []bool{true, false} {
			responseName := "observation-task"
			if idle {
				responseName = "idle"
			}
			t.Run(name+"/"+responseName, func(t *testing.T) {
				calls := 0
				api := newAPI(Config{Server: "https://fixture.invalid", Token: "mp1_" + strings.Repeat("a", 64)})
				api.client.Transport = claimCapabilitiesTransport(func(request *http.Request) (*http.Response, error) {
					calls++
					if request.Method != http.MethodPost || request.URL.Path != "/api/probes/v1/agent/claim" {
						t.Fatal("claim changed its HTTP endpoint")
					}
					if request.Header.Get("Content-Type") != "application/json" || request.Header.Get("Authorization") != "Bearer "+api.config.Token {
						t.Fatal("claim changed its authentication or content type")
					}
					if request.Header.Get("Cookie") != "" || request.Header.Get("Origin") != "" {
						t.Fatal("claim sent browser credentials")
					}
					var body map[string]json.RawMessage
					if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
						t.Fatal("claim body is not JSON")
					}
					wanted, _ := json.Marshal(map[string]any{
						"version": version, "platform": runtime.GOOS + "-" + runtime.GOARCH,
						"observationsVersion": 1,
						"capabilities":        map[string]int{"schemaVersion": 1, "observationsVersion": 1},
					})
					var expected map[string]json.RawMessage
					if err := json.Unmarshal(wanted, &expected); err != nil || !reflect.DeepEqual(body, expected) {
						t.Fatal("claim differs from the exact dual-protocol field allowlist")
					}
					// The legacy endpoint reads only the top-level field; the versioned
					// endpoint reads the nested declaration before assigning this task.
					observations := 0
					if legacy {
						if err := json.Unmarshal(body["observationsVersion"], &observations); err != nil {
							t.Fatal(err)
						}
					} else {
						var capabilities struct {
							SchemaVersion       int `json:"schemaVersion"`
							ObservationsVersion int `json:"observationsVersion"`
						}
						if err := json.Unmarshal(body["capabilities"], &capabilities); err != nil || capabilities.SchemaVersion != 1 {
							t.Fatal("versioned declaration is unavailable")
						}
						observations = capabilities.ObservationsVersion
					}
					if observations != 1 {
						t.Fatal("observation compatibility was lost")
					}
					var task *Task
					if !idle {
						task = &Task{
							ID: "claim-fixture", LeaseToken: strings.Repeat("b", 64), LeaseMs: 90000, Attempt: 1,
							Types:   []string{"observations"},
							Options: Options{TimeoutMs: 1000, DownloadBytes: 65536, ObservationsVersion: 1, Sources: []string{"ipify"}},
						}
					}
					encoded, err := json.Marshal(map[string]any{"success": true, "data": task})
					if err != nil {
						t.Fatal(err)
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
				})
				task, err := api.claim(context.Background())
				if err != nil || calls != 1 || (task == nil) != idle {
					t.Fatalf("claim failed: err=%v calls=%d idle=%t", err, calls, idle)
				}
				if task != nil && (task.ID != "claim-fixture" || task.Options.ObservationsVersion != 1) {
					t.Fatal("claim changed the assigned observation task")
				}
			})
		}
	}
}
