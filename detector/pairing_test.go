package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fixturePairWindow = "12345678-1234-1234-1234-123456789abc"
const fixturePairID = "23456789-1234-1234-1234-123456789abc"
const fixturePairAgent = "34567890-1234-1234-1234-123456789abc"
const fixturePairDevice = "pdc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fixturePairToken = "mp1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type memoryPairingConfig struct {
	config Config
	saves  int
	err    error
}

func (m *memoryPairingConfig) Save(c Config) error { m.saves++; m.config = c; return m.err }
func (m *memoryPairingConfig) Close() error        { return nil }

type pairingFixture struct {
	t         *testing.T
	server    *httptest.Server
	client    *pairingClient
	store     *memoryPairingConfig
	output    bytes.Buffer
	starts    atomic.Int32
	polls     atomic.Int32
	expires   int64
	proofHash atomic.Value
	proof     atomic.Value
	waits     []time.Duration
	startEdit func(map[string]any)
	poll      func(http.ResponseWriter, *http.Request, int)
}

func newPairingFixture(t *testing.T) *pairingFixture {
	t.Helper()
	f := &pairingFixture{t: t, store: &memoryPairingConfig{}, expires: time.Now().Add(time.Minute).UnixMilli()}
	f.proofHash.Store("")
	f.proof.Store("")
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" {
			t.Error("unexpected request credentials or method")
			w.WriteHeader(400)
			return
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil || input["windowId"] != fixturePairWindow {
			t.Error("invalid pairing input")
			return
		}
		switch r.URL.Path {
		case "/api/probes/v1/device-pairing/start":
			f.starts.Add(1)
			proofHash := input["proofHash"]
			f.proofHash.Store(proofHash)
			if len(proofHash) != 64 || input["name"] != "Fixture Probe" || input["platform"] == "" || input["version"] == "" || len(input) != 5 {
				t.Error("invalid self-reported metadata")
			}
			data := map[string]any{"id": fixturePairID, "windowId": fixturePairWindow, "origin": f.server.URL, "deviceCode": fixturePairDevice, "userCode": "ABCDE-12345", "fingerprint": pairingFingerprint(proofHash), "expiresAt": f.expires, "intervalSeconds": 5}
			if f.startEdit != nil {
				f.startEdit(data)
			}
			pairingFixtureResponse(w, http.StatusCreated, data)
		case "/api/probes/v1/device-pairing/token":
			count := int(f.polls.Add(1))
			proof := input["proof"]
			f.proof.Store(proof)
			hash := sha256.Sum256([]byte(proof))
			if len(proof) != 64 || hex.EncodeToString(hash[:]) != f.proofHash.Load().(string) || input["id"] != fixturePairID || input["deviceCode"] != fixturePairDevice || len(input) != 4 {
				t.Error("secret or proof mismatch")
			}
			if f.poll != nil {
				f.poll(w, r, count)
			} else {
				f.success(w)
			}
		default:
			t.Error("pairing requested a claim, kernel task, or unrelated endpoint")
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	f.client = newPairingClient(f.server.URL)
	f.client.http.Transport = f.server.Client().Transport
	f.client.wait = func(ctx context.Context, d time.Duration) bool {
		f.waits = append(f.waits, d)
		return ctx.Err() == nil
	}
	t.Cleanup(f.client.http.CloseIdleConnections)
	return f
}

func pairingFixtureResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data})
}

func (f *pairingFixture) success(w http.ResponseWriter) {
	pairingFixtureResponse(w, 200, map[string]any{"status": "consumed", "agent": map[string]any{"id": fixturePairAgent, "name": "Fixture Probe", "createdAt": time.Now().UnixMilli()}, "config": Config{Version: 1, Server: f.server.URL, Token: fixturePairToken, PollSeconds: 60}})
}

func (f *pairingFixture) run(ctx context.Context) error {
	return f.client.pair(ctx, pairOptions{WindowID: fixturePairWindow, Name: "Fixture Probe"}, f.store, &f.output)
}

func (f *pairingFixture) assertNoSecrets(err error) {
	f.t.Helper()
	text := f.output.String()
	if err != nil {
		text += err.Error()
	}
	for _, secret := range []string{fixturePairToken, fixturePairDevice, f.proof.Load().(string), f.proofHash.Load().(string), "server-secret"} {
		if secret != "" && strings.Contains(text, secret) {
			f.t.Fatal("pairing output contains secret material")
		}
	}
}

func TestPairingApprovesOnceSavesAndExits(t *testing.T) {
	f := newPairingFixture(t)
	f.poll = func(w http.ResponseWriter, _ *http.Request, n int) {
		if n == 1 {
			pairingFixtureResponse(w, 202, map[string]any{"status": "pending", "expiresAt": f.expires, "intervalSeconds": 7})
			return
		}
		f.success(w)
	}
	if err := f.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.starts.Load() != 1 || f.polls.Load() != 2 || f.store.saves != 1 || f.store.config.Token != fixturePairToken || len(f.waits) != 2 || f.waits[0] != 5*time.Second || f.waits[1] != 7*time.Second {
		t.Fatal("pairing lifecycle mismatch")
	}
	for _, text := range []string{f.server.URL, "ABCDE-12345", pairingFingerprint(f.proofHash.Load().(string)), "not hardware authentication", "start the detector separately"} {
		if !strings.Contains(f.output.String(), text) {
			t.Errorf("missing guidance %q", text)
		}
	}
	f.assertNoSecrets(nil)
}

func TestPairingRateLimitBackoff(t *testing.T) {
	f := newPairingFixture(t)
	f.poll = func(w http.ResponseWriter, r *http.Request, n int) {
		switch n {
		case 1:
			w.Header().Set("Retry-After", "13")
			w.WriteHeader(429)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case 2:
			w.WriteHeader(429)
		default:
			f.success(w)
		}
	}
	if err := f.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.waits) != 3 || f.waits[0] != 5*time.Second || f.waits[1] != 13*time.Second || f.waits[2] != 18*time.Second {
		t.Fatalf("bad polling backoff: %v", f.waits)
	}
}

func TestPairingCommittedRedemptionFollowedByServerFailureRequiresRevocation(t *testing.T) {
	for _, status := range []int{500, 502, 503, 504, 599} {
		f := newPairingFixture(t)
		var consumed atomic.Bool
		f.poll = func(w http.ResponseWriter, _ *http.Request, _ int) {
			consumed.Store(true)
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"success":false,"error":{"code":"probe_unavailable","detail":"server-secret"}}`)
		}
		err := f.run(context.Background())
		if err == nil || err.Error() != pairingRecoveryError().Error() || !consumed.Load() || f.starts.Load() != 1 || f.polls.Load() != 1 || f.store.saves != 0 {
			t.Fatalf("ambiguous server status %d did not require revocation: %v", status, err)
		}
		f.assertNoSecrets(err)
	}
}

func TestPairingAmbiguousResponseNeverRetrievesTokenAgain(t *testing.T) {
	for _, scenario := range []string{"disconnect", "malformed", "oversize", "slow", "consumed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPairingFixture(t)
			f.client.http.Timeout = 100 * time.Millisecond
			f.poll = func(w http.ResponseWriter, r *http.Request, _ int) {
				switch scenario {
				case "disconnect":
					connection, _, _ := w.(http.Hijacker).Hijack()
					_ = connection.Close()
				case "malformed":
					_, _ = io.WriteString(w, `{"success":true,"data":"server-secret`)
				case "oversize":
					_, _ = io.WriteString(w, strings.Repeat("x", pairingResponseLimit+1))
				case "slow":
					<-r.Context().Done()
				case "consumed":
					w.WriteHeader(409)
					_, _ = io.WriteString(w, `{"success":false,"error":{"code":"pairing_consumed"}}`)
				}
			}
			err := f.run(context.Background())
			if err == nil || err.Error() != pairingRecoveryError().Error() || f.polls.Load() != 1 || f.starts.Load() != 1 || f.store.saves != 0 {
				t.Fatalf("ambiguous token response retried: %v", err)
			}
			f.assertNoSecrets(err)
		})
	}
}

func TestPairingSaveFailureRequiresRevocation(t *testing.T) {
	f := newPairingFixture(t)
	f.store.err = errors.New("server-secret filesystem detail")
	err := f.run(context.Background())
	if err == nil || err.Error() != "pairing_config_save_failed_revoke_in_misub_before_pairing_again" || f.starts.Load() != 1 || f.polls.Load() != 1 || f.store.saves != 1 {
		t.Fatal("save failure retried or hidden")
	}
	f.assertNoSecrets(err)
}

func TestPairingCancellationAndDeadlineStopPolling(t *testing.T) {
	for _, duringRequest := range []bool{false, true} {
		t.Run(map[bool]string{false: "waiting", true: "request"}[duringRequest], func(t *testing.T) {
			f := newPairingFixture(t)
			f.client.wait = sleep
			if duringRequest {
				f.client.wait = func(ctx context.Context, _ time.Duration) bool { return ctx.Err() == nil }
				f.poll = func(_ http.ResponseWriter, r *http.Request, _ int) { <-r.Context().Done() }
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
			defer cancel()
			started := time.Now()
			err := f.run(ctx)
			if err == nil || time.Since(started) > time.Second || f.store.saves != 0 || f.polls.Load() > 1 {
				t.Fatalf("deadline ignored: %v", err)
			}
			f.assertNoSecrets(err)
		})
	}
	f := newPairingFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if f.run(ctx) == nil || f.starts.Load() != 0 {
		t.Fatal("cancelled pairing started")
	}
}

func TestPairingRejectsStartBindingAndUnsafeDisplayData(t *testing.T) {
	for _, field := range []string{"origin", "id", "windowId", "deviceCode", "userCode", "fingerprint", "expiresAt", "intervalSeconds"} {
		t.Run(field, func(t *testing.T) {
			f := newPairingFixture(t)
			f.startEdit = func(data map[string]any) {
				switch field {
				case "expiresAt":
					data[field] = time.Now().Add(time.Hour).UnixMilli()
				case "intervalSeconds":
					data[field] = 0
				default:
					data[field] = "server-secret\n"
				}
			}
			err := f.run(context.Background())
			if err == nil || f.polls.Load() != 0 || f.output.Len() != 0 {
				t.Fatal("unbound or unsafe start response accepted")
			}
			f.assertNoSecrets(err)
		})
	}
}

func TestPairingRejectsWrongConfigOriginAndToken(t *testing.T) {
	for _, badOrigin := range []bool{false, true} {
		f := newPairingFixture(t)
		f.poll = func(w http.ResponseWriter, _ *http.Request, _ int) {
			c := Config{Version: 1, Server: f.server.URL, Token: fixturePairToken, PollSeconds: 60}
			if badOrigin {
				c.Server = "https://other.invalid"
			} else {
				c.Token = "server-secret"
			}
			pairingFixtureResponse(w, 200, map[string]any{"status": "consumed", "agent": map[string]any{"id": fixturePairAgent}, "config": c})
		}
		err := f.run(context.Background())
		if err == nil || f.store.saves != 0 || f.polls.Load() != 1 {
			t.Fatal("unsafe config accepted")
		}
		f.assertNoSecrets(err)
	}
}

func TestPairingTransportRejectsTLSRedirectAndEnvironmentProxy(t *testing.T) {
	f := newPairingFixture(t)
	f.client = newPairingClient(f.server.URL)
	if f.run(context.Background()) == nil || f.starts.Load() != 0 {
		t.Fatal("invalid TLS accepted")
	}
	client := newPairingClient("https://example.invalid")
	transport := client.http.Transport.(*http.Transport)
	if transport.Proxy != nil || (transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify) || client.http.Jar != nil || client.http.Timeout <= 0 {
		t.Fatal("unsafe transport configuration")
	}
	var redirected atomic.Int32
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer destination.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer source.Close()
	client = newPairingClient(source.URL)
	client.http.Transport = source.Client().Transport
	_, _, _, err := client.request(context.Background(), "token", map[string]string{"deviceCode": fixturePairDevice})
	if err == nil || err.Error() != "pairing_redirect_refused" || redirected.Load() != 0 {
		t.Fatal("secret sent to redirect")
	}
}

func TestPairingOriginAndNameValidation(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com/?secret=x", "https://example.com/?", "https://example.com/#secret", "https://example.com/path", "https://example.com:0", "https://example.com:99999", "https://example.com/\n", "https://example.com/%2f", "https://%65xample.com"} {
		if _, err := pairingOrigin(raw); err == nil {
			t.Errorf("unsafe origin accepted %q", raw)
		}
	}
	for input, want := range map[string]string{"https://EXAMPLE.com:443/": "https://example.com", "https://[::1]:8443/": "https://[::1]:8443"} {
		got, err := pairingOrigin(input)
		if err != nil || got != want {
			t.Errorf("origin mismatch %q %v", got, err)
		}
	}
	for _, name := range []string{"", " name", "name\n", strings.Repeat("a", 61)} {
		if validPairingName(name) {
			t.Error("unsafe display name accepted")
		}
	}
}

func TestPairingStartFailureDoesNotCreateAnotherRequest(t *testing.T) {
	var starts atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		starts.Add(1)
		connection, _, _ := w.(http.Hijacker).Hijack()
		_ = connection.Close()
	}))
	defer server.Close()
	client := newPairingClient(server.URL)
	client.http.Transport = server.Client().Transport
	err := client.pair(context.Background(), pairOptions{WindowID: fixturePairWindow, Name: "Fixture Probe"}, &memoryPairingConfig{}, io.Discard)
	if err == nil || starts.Load() != 1 {
		t.Fatal("ambiguous start retried")
	}
}

func TestPairingTerminalServerStatesDoNotRetry(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 409, 410, 500} {
		f := newPairingFixture(t)
		f.poll = func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"success":false,"error":{"code":"server-secret"}}`)
		}
		err := f.run(context.Background())
		if err == nil || f.polls.Load() != 1 || f.store.saves != 0 {
			t.Fatalf("server status %d retried", status)
		}
		f.assertNoSecrets(err)
	}
}

type pairingFailedOutput struct{}

func (pairingFailedOutput) Write([]byte) (int, error) { return 0, errors.New("server-secret") }

func TestPairingCannotRedeemWithoutDisplayingVerification(t *testing.T) {
	f := newPairingFixture(t)
	err := f.client.pair(context.Background(), pairOptions{WindowID: fixturePairWindow, Name: "Fixture Probe"}, f.store, pairingFailedOutput{})
	if err == nil || f.polls.Load() != 0 || f.store.saves != 0 || strings.Contains(err.Error(), "server-secret") {
		t.Fatal("pairing continued after failed verification display")
	}
}
