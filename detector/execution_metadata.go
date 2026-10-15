package main

import "strings"

const executionMetadataSchemaVersion = 1

// This explicit build rule-set baseline must advance when interpretation rules
// change, following the execution-metadata versioning policy.
const executionRuleSetVersion = 1

type executionMetadata struct {
	SchemaVersion     int    `json:"schemaVersion"`
	WrapperVersion    string `json:"wrapperVersion"`
	WrapperRevision   string `json:"wrapperRevision"`
	Platform          string `json:"platform"`
	KernelLockVersion string `json:"kernelLockVersion,omitempty"`
	RuleSetVersion    int    `json:"ruleSetVersion"`
}

func executionBuildVersionValid(value string) bool {
	return probeBuildVersionValid(value)
}

func newExecutionMetadata(buildVersion, revision, platform, kernelVersion string) *executionMetadata {
	if !executionBuildVersionValid(buildVersion) || !bootstrapCommitPattern.MatchString(revision) {
		return nil
	}
	switch platform {
	case "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64":
	default:
		return nil
	}
	metadata := &executionMetadata{
		SchemaVersion: executionMetadataSchemaVersion, WrapperVersion: buildVersion,
		WrapperRevision: revision, Platform: platform, RuleSetVersion: executionRuleSetVersion,
	}
	if len(kernelVersion) <= 64 && bootstrapVersionPattern.MatchString(strings.TrimPrefix(kernelVersion, "v")) {
		metadata.KernelLockVersion = kernelVersion
	}
	return metadata
}

func currentExecutionMetadata() *executionMetadata {
	buildVersion, revision, platform := version, commit, nativeBootstrapTarget()
	kernelVersion := ""
	if lock, err := loadKernelLock(); err == nil {
		// The lock declaration does not attest which kernel actually executed.
		kernelVersion = lock.Version
	}
	return newExecutionMetadata(buildVersion, revision, platform, kernelVersion)
}
