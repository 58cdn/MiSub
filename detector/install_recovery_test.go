package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"
)

type installationRoundTripper func(*http.Request) (*http.Response, error)

func (r installationRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return r(request)
}

func TestInstallationOfflineRecoveryReusesIdentityAndStopsOnRevocation(t *testing.T) {
	config := Config{Version: 1, Server: "https://fixture.invalid", Token: "mp1_" + strings.Repeat("a", 64)}
	// Bypass config validation only in this fixture; normal config loads default to 60s.
	api := newAPI(config)
	calls := 0
	api.client.Transport = installationRoundTripper(func(request *http.Request) (*http.Response, error) {
		calls++
		if calls > 4 {
			t.Fatal("authentication failure retried")
		}
		if request.URL.Path != "/api/probes/v1/agent/claim" || request.Header.Get("Authorization") != "Bearer "+config.Token {
			t.Fatal("recovery changed identity or attempted enrollment")
		}
		if calls < 3 {
			return nil, errors.New("fixture-network-error-with-secret")
		}
		status, body := 200, `{"success":true,"data":null}`
		if calls == 4 {
			status, body = 401, "fixture-secret-response"
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	var output bytes.Buffer
	err := run(context.Background(), api, "never-execute", false, &output)
	if err == nil || err.Error() != "unauthorized" || calls != 4 {
		t.Fatalf("recovery/revocation failed: %v, calls=%d", err, calls)
	}
	if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), config.Token) {
		t.Fatal("network error leaked sensitive data")
	}
}

func TestInstallationOfflineCancellationStopsWithoutRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api := newAPI(Config{Server: "https://fixture.invalid", PollSeconds: 60})
	calls := 0
	api.client.Transport = installationRoundTripper(func(*http.Request) (*http.Response, error) { calls++; cancel(); return nil, context.Canceled })
	if err := run(ctx, api, "never-execute", false, io.Discard); err != nil || calls != 1 {
		t.Fatal("cancelled service kept retrying")
	}
}

func TestInstallationUnsupportedPlatformFailsBeforeAnyAction(t *testing.T) {
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		t.Skip("supported platform")
	}
	for _, action := range []string{"install", "start", "stop", "status", "uninstall", "reinstall"} {
		if err := manageInstallation(context.Background(), action, "", false, io.Discard); err == nil || err.Error() != "installation_platform_not_supported" {
			t.Fatal("unsupported platform accepted")
		}
	}
}
