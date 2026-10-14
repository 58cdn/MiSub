package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func executionMetadataWire(t *testing.T, value any) map[string]json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}

func TestExecutionMetadataWireAllowlist(t *testing.T) {
	for _, platform := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"} {
		t.Run(platform, func(t *testing.T) {
			metadata := newExecutionMetadata("0.3.0-dev", strings.Repeat("a", 40), platform, "v1.19.32")
			want := map[string]any{
				"schemaVersion": 1, "wrapperVersion": "0.3.0-dev", "wrapperRevision": strings.Repeat("a", 40),
				"platform": platform, "kernelLockVersion": "v1.19.32", "ruleSetVersion": 1,
			}
			if !reflect.DeepEqual(executionMetadataWire(t, metadata), executionMetadataWire(t, want)) {
				t.Fatal("execution metadata differs from the exact public field allowlist")
			}
		})
	}
	for _, buildVersion := range []string{"0.2.0", "1.2.3-rc.1", "1.2.3-" + strings.Repeat("a", 58)} {
		metadata := newExecutionMetadata(buildVersion, "source", "linux-amd64", "")
		if metadata == nil || metadata.WrapperRevision != "source" || len(executionMetadataWire(t, metadata)) != 5 {
			t.Fatalf("valid source build identity rejected: %q", buildVersion)
		}
	}
}

func TestExecutionMetadataInvalidIdentityIsOmitted(t *testing.T) {
	for _, tc := range []struct{ name, version, revision, platform string }{
		{"missing version", "", "source", "linux-amd64"},
		{"prefixed wrapper version", "v0.2.0", "source", "linux-amd64"},
		{"oversized version", "1.2.3-" + strings.Repeat("a", 59), "source", "linux-amd64"},
		{"version control character", "0.2.0\nprivate", "source", "linux-amd64"},
		{"version path", `C:\private\probe.json`, "source", "linux-amd64"},
		{"version token", fixturePairToken, "source", "linux-amd64"},
		{"missing revision", "0.2.0", "", "linux-amd64"},
		{"uppercase revision", "0.2.0", strings.Repeat("A", 40), "linux-amd64"},
		{"short revision", "0.2.0", strings.Repeat("a", 39), "linux-amd64"},
		{"long revision", "0.2.0", strings.Repeat("a", 41), "linux-amd64"},
		{"revision token", "0.2.0", fixturePairToken, "linux-amd64"},
		{"revision URL", "0.2.0", "https://fixture.invalid/private", "linux-amd64"},
		{"missing platform", "0.2.0", "source", ""},
		{"unknown platform", "0.2.0", "source", "windows-arm64"},
		{"platform hostname", "0.2.0", "source", "fixture-host"},
		{"platform path", "0.2.0", "source", "/private/probe"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := newExecutionMetadata(tc.version, tc.revision, tc.platform, "v1.19.32"); got != nil {
				t.Fatal("invalid build identity produced metadata")
			}
		})
	}
}

func TestExecutionMetadataKernelDeclarationIsOptional(t *testing.T) {
	for _, kernelVersion := range []string{"", "source", "v", "vv1.2.3", "v1.2.3\nprivate", fixturePairToken, "/private/kernel.gz", "v1.2.3-" + strings.Repeat("a", 58)} {
		metadata := newExecutionMetadata("0.2.0", "source", "linux-amd64", kernelVersion)
		fields := executionMetadataWire(t, metadata)
		if metadata == nil || len(fields) != 5 || fields["kernelLockVersion"] != nil {
			t.Fatal("invalid or absent kernel declaration affected the build identity or reached the wire")
		}
	}
	for _, kernelVersion := range []string{"1.19.32", "v1.19.32", "v1.2.3-rc.1", "v1.2.3-" + strings.Repeat("a", 57)} {
		metadata := newExecutionMetadata("0.2.0", "source", "linux-amd64", kernelVersion)
		if metadata == nil || metadata.KernelLockVersion != kernelVersion {
			t.Fatalf("valid lock declaration rejected: %q", kernelVersion)
		}
	}
}

func executionMetadataBuildFixture(t *testing.T, buildVersion, revision string) {
	t.Helper()
	oldVersion, oldCommit := version, commit
	version, commit = buildVersion, revision
	t.Cleanup(func() { version, commit = oldVersion, oldCommit })
}

func executionMetadataTaskFixture() Task {
	return Task{
		ID: "snapshot-fixture", LeaseToken: strings.Repeat("a", 64), Types: []string{"format"},
		Node: Node{Name: "private-node-name", Format: failure("passed", "ok"), Proxy: map[string]any{"password": "private-proxy-password"}},
	}
}

type executionMetadataTransport func(*http.Request) (*http.Response, error)

func (f executionMetadataTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestExecutionMetadataProcessRetriesOneSnapshot(t *testing.T) {
	for _, acceptedAttempt := range []int{2, 3} {
		t.Run(fmt.Sprintf("accepted_attempt_%d", acceptedAttempt), func(t *testing.T) {
			executionMetadataBuildFixture(t, "0.3.0", strings.Repeat("a", 40))
			expected := currentExecutionMetadata()
			if expected == nil {
				t.Fatal("native build fixture is unsupported")
			}
			api := newAPI(Config{Server: "https://fixture.invalid", Token: fixturePairToken})
			var bodies [][]byte
			api.client.Transport = executionMetadataTransport(func(request *http.Request) (*http.Response, error) {
				defer request.Body.Close()
				if request.Method != "POST" || request.URL.Path != "/api/probes/v1/agent/tasks/snapshot-fixture/result" {
					t.Fatalf("unexpected API request: %s %s", request.Method, request.URL.Path)
				}
				body, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				bodies = append(bodies, body)
				version, commit = "0.5.0", strings.Repeat("c", 40)
				if len(bodies) < acceptedAttempt {
					return nil, errors.New("synthetic ACK lost after acceptance")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":true}`))}, nil
			})
			calls := 0
			execute := func(ctx context.Context, task Task, binary string) map[string]Check {
				calls++
				version, commit = "0.4.0", strings.Repeat("b", 40)
				return executeTask(ctx, task, binary)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := api.processWithExecutor(ctx, executionMetadataTaskFixture(), "private-unused-kernel-path", execute); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || len(bodies) != acceptedAttempt {
				t.Fatalf("execution calls=%d, delivery attempts=%d", calls, len(bodies))
			}
			for _, body := range bodies {
				if !bytes.Equal(body, bodies[0]) {
					t.Fatal("retry changed the result payload")
				}
			}
			var result struct {
				LeaseToken        string             `json:"leaseToken"`
				Checks            map[string]Check   `json:"checks"`
				ExecutionMetadata *executionMetadata `json:"executionMetadata"`
			}
			if err := json.Unmarshal(bodies[0], &result); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(result.ExecutionMetadata, expected) || result.Checks["format"].Status != "passed" {
				t.Fatal("result did not preserve the metadata captured before execution")
			}
			for _, private := range []string{fixturePairToken, "private-node-name", "private-proxy-password", "private-unused-kernel-path", "observationsVersion", "probeVersion", `"source"`} {
				if bytes.Contains(bodies[0], []byte(private)) {
					t.Fatalf("unexpected field or private input reached the payload: %q", private)
				}
			}
			fields := executionMetadataWire(t, json.RawMessage(bodies[0]))
			if len(fields) != 3 || fields["leaseToken"] == nil || fields["checks"] == nil || fields["executionMetadata"] == nil {
				t.Fatal("result payload fields changed")
			}
			var checks map[string]json.RawMessage
			if err := json.Unmarshal(fields["checks"], &checks); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(executionMetadataWire(t, checks["format"]), executionMetadataWire(t, map[string]string{"status": "passed", "code": "ok"})) {
				t.Fatal("metadata was added inside a check")
			}
		})
	}
}

func TestExecutionMetadataProcessAcceptsLegacyServer(t *testing.T) {
	for _, tc := range []struct {
		name, buildVersion, revision, userAgent string
		metadata                                bool
	}{
		{"valid", "0.3.0", "source", "MiSub-Probe/0.3.0", true},
		{"invalid version", "private\r\npath", "source", "MiSub-Probe/unknown", false},
		{"path version", `C:\private\probe.json`, "source", "MiSub-Probe/unknown", false},
		{"invalid revision", "0.3.0", fixturePairToken, "MiSub-Probe/0.3.0", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			executionMetadataBuildFixture(t, tc.buildVersion, tc.revision)
			received := make(chan map[string]json.RawMessage, 1)
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				var legacy struct {
					LeaseToken string           `json:"leaseToken"`
					Checks     map[string]Check `json:"checks"`
				}
				if err != nil || json.Unmarshal(body, &legacy) != nil || legacy.LeaseToken != strings.Repeat("a", 64) || legacy.Checks["format"].Status != "passed" || r.Header.Get("User-Agent") != tc.userAgent {
					t.Error("legacy server could not accept the result")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(body, &fields); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				received <- fields
				_, _ = io.WriteString(w, `{"success":true}`)
			}))
			defer server.Close()
			api := newAPI(Config{Server: server.URL, Token: fixturePairToken})
			api.client.Transport = server.Client().Transport
			defer api.client.CloseIdleConnections()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := api.process(ctx, executionMetadataTaskFixture(), "private-unused-kernel-path"); err != nil {
				t.Fatalf("optional metadata prevented result acceptance: %v", err)
			}
			fields := <-received
			if present := fields["executionMetadata"] != nil; present != tc.metadata {
				t.Fatalf("metadata present=%v, want %v", present, tc.metadata)
			}
			if !tc.metadata && len(fields) != 2 {
				t.Fatal("omitted metadata left extra payload fields")
			}
		})
	}
}
