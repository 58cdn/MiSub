package main

import (
	"bytes"
	"runtime/debug"
	"strings"
	"testing"
)

func TestAlphaProbeBuildIdentity(t *testing.T) {
	revision := strings.Repeat("a", 40)
	for _, product := range []string{"0.0.1-alpha.1", "0.0.1-alpha.9", "0.0.1-alpha.10", "0.0.1-alpha." + strings.Repeat("9", 52)} {
		for _, target := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"} {
			var output bytes.Buffer
			if err := writeBootstrapCapabilities(&output, target, product, revision); err != nil || output.String() != bootstrapProtocol+" "+product+" "+revision+" "+target+"\n" {
				t.Fatalf("alpha capability identity rejected: %s %s", product, target)
			}
			metadata := newExecutionMetadata(product, revision, target, "v1.19.32-misub-source")
			if metadata == nil || metadata.WrapperVersion != product || metadata.WrapperRevision != revision || !doctorVersion(product) {
				t.Fatalf("alpha metadata identity rejected: %s", product)
			}
		}
	}
}

func TestAlphaProbeRejectsInvalidProductIdentity(t *testing.T) {
	for _, product := range []string{"0.0.1-alpha.0", "0.0.1-alpha.01", "0.0.1-alpha.-1", "0.0.1-alpha.", "0.0.1-alpha.1\n", "0.0.1-alpha.1.sha.abcdef012345", "0.0.1-alpha.1+build", "0.0.1-beta.1", "0.0.1-rc.1", "0.0.1.261015.1", "v0.0.1-alpha.1", "0.0.1-alpha." + strings.Repeat("9", 54)} {
		if probeBuildVersionValid(product) {
			t.Fatalf("invalid product accepted: %q", product)
		}
	}
	for _, revision := range []string{"source", "unknown", "abcdef012345", strings.Repeat("A", 40), strings.Repeat("0", 40), ""} {
		if newExecutionMetadata("0.0.1-alpha.1", revision, "linux-amd64", "") != nil {
			t.Fatalf("alpha metadata accepted incomplete revision: %q", revision)
		}
		var output bytes.Buffer
		if err := writeBootstrapCapabilities(&output, "linux-amd64", "0.0.1-alpha.1", revision); err == nil || output.Len() != 0 {
			t.Fatalf("alpha handshake accepted incomplete revision: %q", revision)
		}
	}
	for _, legacy := range []string{"0.1.0", "0.2.0", "0.3.0-dev", "1.2.3-rc.1"} {
		if !probeBuildVersionValid(legacy) || newExecutionMetadata(legacy, "source", "linux-amd64", "") == nil {
			t.Fatalf("historical identity unreadable: %s", legacy)
		}
	}
}

func TestProbeSourceRevisionAndDisplay(t *testing.T) {
	revision := "0123456789abcdef0123456789abcdef01234567"
	vcs := func(modified string) *debug.BuildInfo {
		return &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.revision", Value: revision}, {Key: "vcs.modified", Value: modified}}}
	}
	for _, tc := range []struct {
		name, input, assertion  string
		info                    *debug.BuildInfo
		wantRevision, wantState string
	}{
		{"clean VCS", revision, "unknown", vcs("false"), revision, "clean"},
		{"VCS resolves revision", "source", "unknown", vcs("false"), revision, "clean"},
		{"dirty overrides assertion", revision, "clean", vcs("true"), revision, "dirty"},
		{"missing modified state", revision, "clean", vcs(""), revision, "unknown"},
		{"mismatched revision", strings.Repeat("a", 40), "clean", vcs("false"), revision, "unknown"},
		{"verified committed archive", revision, "clean", nil, revision, "clean"},
		{"unverified archive", revision, "unknown", nil, revision, "unknown"},
		{"unknown archive", "source", "clean", nil, "source", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotRevision, state := resolveProbeSource(tc.input, tc.assertion, tc.info)
			if gotRevision != tc.wantRevision || state != tc.wantState {
				t.Fatalf("source identity = %q %q", gotRevision, state)
			}
			want := "unknown"
			if state == "clean" {
				want = "0.0.1-alpha.10.sha." + gotRevision[:12]
			}
			if display := probeDisplayVersion("0.0.1-alpha.10", gotRevision, "development", state); display != want {
				t.Fatalf("display identity = %q, want %q", display, want)
			}
		})
	}
	if got := probeDisplayVersion("0.0.1-alpha.10", revision, "testing", "clean"); got != "0.0.1-alpha.10" {
		t.Fatalf("testing display = %q", got)
	}
	for _, channel := range []string{"release", "stable", "", "private\nvalue"} {
		if probeDisplayVersion("0.0.1-alpha.10", revision, channel, "clean") != "unknown" {
			t.Fatal("unrecognized channel accepted")
		}
	}
}

func TestAlphaDoctorPreservesProductAndCompleteSource(t *testing.T) {
	revision := "0123456789abcdef0123456789abcdef01234567"
	for _, channel := range []string{"development", "testing"} {
		for _, state := range []string{"clean", "dirty", "unknown"} {
			environment := fixtureDoctorEnvironment()
			environment.Version, environment.Revision = "0.0.1-alpha.10", revision
			environment.BuildChannel, environment.SourceState = channel, state
			report := collectDoctor(&fixtureDoctorHost{kernelVersion: "v1.19.32"}, environment, doctorOptions{})
			if report.Version != environment.Version || report.Revision != revision || report.BuildChannel != channel || report.SourceState != state {
				t.Fatal("doctor lost product/source identity")
			}
			want := "unknown"
			if state == "clean" {
				want = environment.Version
				if channel == "development" {
					want += ".sha." + revision[:12]
				}
			}
			if report.DisplayVersion != want {
				t.Fatalf("doctor display = %q, want %q", report.DisplayVersion, want)
			}
			if state != "clean" && doctorCheckByID(t, report, "build").State != "error" {
				t.Fatal("unverified source was reported valid")
			}
			var output bytes.Buffer
			if err := writeDoctorReport(&output, report, false); err != nil || !strings.Contains(output.String(), "Build: "+want+" ("+revision+")") {
				t.Fatal("human doctor omitted source/display")
			}
		}
	}
}

func TestAlphaExecutionMetadataCarriesChannelWithoutSHAOrdering(t *testing.T) {
	oldVersion, oldCommit, oldChannel, oldState := version, commit, buildChannel, buildSourceState
	t.Cleanup(func() { version, commit, buildChannel, buildSourceState = oldVersion, oldCommit, oldChannel, oldState })
	version, commit = "0.0.1-alpha.10", strings.Repeat("b", 40)
	for _, channel := range []string{"development", "testing"} {
		for _, state := range []string{"clean", "dirty", "unknown"} {
			buildChannel, buildSourceState = channel, state
			metadata := currentExecutionMetadata()
			if metadata == nil || metadata.WrapperVersion != version || metadata.WrapperRevision != commit || metadata.BuildChannel != channel || metadata.SourceState != state {
				t.Fatal("execution metadata did not preserve independent product/source identity")
			}
		}
	}
}

func TestAlphaEmbeddedProductMatchesBuildRecipe(t *testing.T) {
	for _, tc := range []struct{ injected, source, want string }{
		{"", "0.0.1-alpha.1\n", "0.0.1-alpha.1"},
		{"0.0.1-alpha.10", "0.0.1-alpha.10\n", "0.0.1-alpha.10"},
		{"0.0.1-alpha.1", "0.0.1-alpha.10\n", "unknown"},
		{"", "0.1.0", "unknown"}, {"", "", "unknown"},
		{"", "0.0.1-alpha.01", "unknown"},
	} {
		if got := resolveProbeProduct(tc.injected, tc.source); got != tc.want {
			t.Fatalf("product identity = %q, want %q", got, tc.want)
		}
	}
}

func TestAlphaWrapperAndKernelIdentityRemainIndependent(t *testing.T) {
	if !kernelBuildVersionValid("v0.0.1-beta.1") || probeBuildVersionValid("0.0.1-beta.1") {
		t.Fatal("wrapper release grammar leaked into the independently versioned kernel")
	}
	if kernelBuildVersionValid("0.0.1.261015.1") {
		t.Fatal("invalid kernel version accepted")
	}
}
