package main

import (
	"errors"
	"fmt"
	"io"
	"regexp"
	"runtime"
)

const bootstrapProtocol = "misub-probe-bootstrap-v1"

var bootstrapVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$`)
var bootstrapCommitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|source)$`)

func nativeBootstrapTarget() string { return runtime.GOOS + "-" + runtime.GOARCH }

// This protocol is independent of configuration, the embedded kernel and network
// availability. Installers require an exact version/revision/target match.
func writeBootstrapCapabilities(output io.Writer, target, buildVersion, revision string) error {
	switch target {
	case "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64":
	default:
		return errors.New("bootstrap_platform_not_supported")
	}
	if !probeBuildVersionValid(buildVersion) || !probeRevisionValid(buildVersion, revision) {
		return errors.New("bootstrap_build_identity_invalid")
	}
	if _, err := fmt.Fprintf(output, "%s %s %s %s\n", bootstrapProtocol, buildVersion, revision, target); err != nil {
		return errors.New("bootstrap_output_failed")
	}
	return nil
}
