//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"io"
	"path/filepath"
	"testing"
)

func TestPairingUnsupportedPlatformFailsBeforeNetwork(t *testing.T) {
	f := newPairingFixture(t)
	err := pairDevice(context.Background(), pairOptions{Server: f.server.URL, WindowID: fixturePairWindow, Name: "Fixture Probe", ConfigPath: filepath.Join(t.TempDir(), "probe.json")}, io.Discard)
	if err == nil || err.Error() != "pairing_platform_not_supported_requires_linux_or_macos" || f.starts.Load() != 0 {
		t.Fatal("unsupported platform sent pairing request")
	}
}
