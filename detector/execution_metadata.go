package main

const executionMetadataSchemaVersion = 1

// This explicit build rule-set baseline must advance when interpretation rules
// change, following the execution-metadata versioning policy.
const executionRuleSetVersion = 1

type executionMetadata struct {
	SchemaVersion     int    `json:"schemaVersion"`
	WrapperVersion    string `json:"wrapperVersion"`
	WrapperRevision   string `json:"wrapperRevision"`
	BuildChannel      string `json:"buildChannel,omitempty"`
	SourceState       string `json:"sourceState,omitempty"`
	Platform          string `json:"platform"`
	KernelLockVersion string `json:"kernelLockVersion,omitempty"`
	RuleSetVersion    int    `json:"ruleSetVersion"`
}

func executionBuildVersionValid(value string) bool {
	return probeBuildVersionValid(value)
}

func newExecutionMetadata(buildVersion, revision, platform, kernelVersion string) *executionMetadata {
	if !executionBuildVersionValid(buildVersion) || !probeRevisionValid(buildVersion, revision) {
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
	if kernelBuildVersionValid(kernelVersion) {
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
	metadata := newExecutionMetadata(buildVersion, revision, platform, kernelVersion)
	if metadata != nil && probeAlphaVersionValid(buildVersion) {
		if probeBuildChannelValid(buildChannel) {
			metadata.BuildChannel = buildChannel
		}
		switch buildSourceState {
		case "clean", "dirty", "unknown":
			metadata.SourceState = buildSourceState
		}
	}
	return metadata
}
