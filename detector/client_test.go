package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfigRequiresHTTPSAndPrivatePermissions(t *testing.T) {
	token := "mp1_" + strings.Repeat("a", 64)
	c := Config{Version: 1, Server: "http://example.com", Token: token}
	if c.validate() == nil {
		t.Fatal("plaintext enrollment accepted")
	}
	c.Server = "https://example.com/?token=bad"
	if c.validate() == nil {
		t.Fatal("query credentials accepted")
	}
	path := filepath.Join(t.TempDir(), "probe.json")
	text := `{"version":1,"server":"https://misub.example","token":"` + token + `"}`
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(path); err == nil {
		t.Fatal("world-readable token accepted")
	}
	// Windows ACL acceptance is exercised by TestWindowsPrivatePairingPublication.
	if runtime.GOOS == "windows" {
		return
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(path); err != nil {
		t.Fatal(err)
	}
}
func TestAPIRefusesRedirectsWithoutLeakingBearer(t *testing.T) {
	destinationCalls := 0
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls++; w.WriteHeader(200) }))
	defer destination.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	a := newAPI(Config{Server: source.URL, Token: "mp1_" + strings.Repeat("a", 64)})
	trusted := source.Client().Transport
	a.client.Transport = trusted
	if err := a.post(context.Background(), "claim", map[string]string{}, nil); err == nil {
		t.Fatal("redirect accepted")
	}
	if destinationCalls != 0 {
		t.Fatal("bearer sent to redirect target")
	}
}
func TestAPIBoundedResponsesAndSanitizedErrors(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		_, _ = io.WriteString(w, "do-not-log-this-secret")
	}))
	defer server.Close()
	a := newAPI(Config{Server: server.URL, Token: "mp1_" + strings.Repeat("a", 64)})
	a.client.Transport = server.Client().Transport
	err := a.post(context.Background(), "claim", map[string]string{}, nil)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("unsafe API error")
	}
}
