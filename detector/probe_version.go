package main

import (
	_ "embed"
	"regexp"
	"runtime/debug"
	"strings"
)

var probeAlphaVersionPattern = regexp.MustCompile(`^0\.0\.1-alpha\.[1-9][0-9]*$`)
var probeRevisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

// Build recipes set the allocated product version and complete source revision.
// Archive builds may assert clean only after verifying the committed source tree.
var buildChannel = "development"
var buildSourceState = "unknown"

//go:embed VERSION
var sourceProductVersion string

func resolveProbeProduct(injected, source string) string {
	product := strings.TrimSpace(source)
	if !probeAlphaVersionValid(product) || (injected != "" && injected != product) {
		return "unknown"
	}
	return product
}

func probeSourceRevisionValid(value string) bool {
	return probeRevisionPattern.MatchString(value) && value != strings.Repeat("0", 40)
}

func probeAlphaVersionValid(value string) bool {
	return len(value) <= 64 && probeAlphaVersionPattern.MatchString(value)
}

func probeBuildVersionValid(value string) bool {
	if len(value) > 64 {
		return false
	}
	if strings.HasPrefix(value, "0.0.1-") {
		return probeAlphaVersionValid(value)
	}
	// Historical three-part identities remain readable; product allocation is
	// enforced by the release pipeline and installers.
	return bootstrapVersionPattern.MatchString(value)
}

func probeRevisionValid(buildVersion, revision string) bool {
	if probeAlphaVersionValid(buildVersion) {
		return probeSourceRevisionValid(revision)
	}
	return bootstrapCommitPattern.MatchString(revision)
}

func probeBuildChannelValid(channel string) bool {
	return channel == "development" || channel == "testing"
}

// A VCS observation takes precedence over an injected archive assertion. Dirty
// sources retain their base revision but cannot claim an exact source display.
func resolveProbeSource(revision, assertion string, info *debug.BuildInfo) (string, string) {
	observedRevision, modified := "", ""
	if info != nil {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				observedRevision = setting.Value
			case "vcs.modified":
				modified = setting.Value
			}
		}
	}
	if observedRevision != "" || modified != "" {
		if !probeSourceRevisionValid(observedRevision) {
			return revision, "unknown"
		}
		if revision == "source" || revision == "unknown" || revision == "" {
			revision = observedRevision
		}
		if revision != observedRevision {
			return observedRevision, "unknown"
		}
		if modified == "true" {
			return revision, "dirty"
		}
		if modified == "false" {
			return revision, "clean"
		}
		return revision, "unknown"
	}
	if probeSourceRevisionValid(revision) && assertion == "clean" {
		return revision, "clean"
	}
	return revision, "unknown"
}

func init() {
	version = resolveProbeProduct(version, sourceProductVersion)
	info, _ := debug.ReadBuildInfo()
	commit, buildSourceState = resolveProbeSource(commit, buildSourceState, info)
}

func probeDisplayVersion(product, revision, channel, sourceState string) string {
	if !probeBuildVersionValid(product) {
		return "unknown"
	}
	if !probeAlphaVersionValid(product) {
		return product
	}
	if !probeSourceRevisionValid(revision) || sourceState != "clean" {
		return "unknown"
	}
	switch channel {
	case "testing":
		return product
	case "development":
		return product + ".sha." + revision[:12]
	default:
		return "unknown"
	}
}

func kernelBuildVersionValid(value string) bool {
	return len(value) <= 64 && bootstrapVersionPattern.MatchString(strings.TrimPrefix(value, "v"))
}
