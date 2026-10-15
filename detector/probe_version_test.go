package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestDatedProbeBuildIdentity(t *testing.T) {
	for _, version := range []string{"0.0.1.261015.1", "0.0.1.000229.999999", "0.0.1.240229.10", "0.0.1.991231.2"} {
		var out bytes.Buffer
		if err := writeBootstrapCapabilities(&out, "windows-amd64", version, "source"); err != nil || !strings.Contains(out.String(), " "+version+" ") {
			t.Fatalf("dated handshake rejected: %s", version)
		}
		metadata := newExecutionMetadata(version, "source", "windows-amd64", "v1.19.32-misub-source")
		if metadata == nil || metadata.WrapperVersion != version || !doctorVersion(version) {
			t.Fatalf("dated build metadata rejected: %s", version)
		}
		if newExecutionMetadata(version, "source", "windows-amd64", version).KernelLockVersion != "" {
			t.Fatal("wrapper date syntax accepted as kernel version")
		}
	}
	for _, version := range []string{"0.0.1.230229.1", "0.0.1.261332.1", "0.0.1.260000.1", "0.0.1.260431.1", "0.0.1.261015.0", "0.0.1.261015.01", "0.0.1.261015.1000000", "0.0.1.261015.1\n", "0.0.1.261015.1-dev", "v0.0.1.261015.1"} {
		if probeBuildVersionValid(version) {
			t.Fatalf("invalid build accepted: %q", version)
		}
	}
}
