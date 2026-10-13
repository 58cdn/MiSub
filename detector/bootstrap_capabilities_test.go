package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

type failingBootstrapWriter struct{}

func (failingBootstrapWriter) Write([]byte) (int, error) {
	return 0, errors.New("private-writer-detail")
}

func TestBootstrapCapabilityIdentityIsExact(t *testing.T) {
	for _, target := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"} {
		var out bytes.Buffer
		if err := writeBootstrapCapabilities(&out, target, "0.2.0", strings.Repeat("a", 40)); err != nil {
			t.Fatal(err)
		}
		if out.String() != "misub-probe-bootstrap-v1 0.2.0 "+strings.Repeat("a", 40)+" "+target+"\n" {
			t.Fatal("bootstrap build identity changed")
		}
	}
}

func TestBootstrapCapabilityRejectsUnsupportedOrAmbiguousIdentity(t *testing.T) {
	for _, row := range [][3]string{
		{"windows-arm64", "0.2.0", "source"}, {"linux-386", "0.2.0", "source"},
		{"linux-amd64", "0.2.0\nextra", "source"}, {"linux-amd64", "latest", "source"},
		{"linux-amd64", "0.2.0", "bad revision"}, {"linux-amd64", "0.2.0", ""},
	} {
		var out bytes.Buffer
		if err := writeBootstrapCapabilities(&out, row[0], row[1], row[2]); err == nil || out.Len() != 0 {
			t.Fatal("invalid capability response emitted")
		}
	}
	if err := writeBootstrapCapabilities(failingBootstrapWriter{}, "linux-amd64", "0.2.0", "source"); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatal("output failure was not safely reported")
	}
}
