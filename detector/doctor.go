package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const doctorSchemaVersion = 1

type doctorCheck struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	Code        string `json:"code"`
	Remediation string `json:"remediation,omitempty"`
	Source      string `json:"source,omitempty"`
}

type doctorReport struct {
	SchemaVersion     int           `json:"schemaVersion"`
	CheckedAt         string        `json:"checkedAt"`
	Scope             string        `json:"scope"`
	Status            string        `json:"status"`
	Platform          string        `json:"platform"`
	Version           string        `json:"version"`
	Revision          string        `json:"revision"`
	DisplayVersion    string        `json:"displayVersion,omitempty"`
	BuildChannel      string        `json:"buildChannel,omitempty"`
	SourceState       string        `json:"sourceState,omitempty"`
	KernelLockVersion string        `json:"kernelLockVersion,omitempty"`
	InstalledVersion  string        `json:"installedVersion,omitempty"`
	Checks            []doctorCheck `json:"checks"`
	Mode              string        `json:"mode,omitempty"`
	SideEffects       []string      `json:"sideEffects,omitempty"`
}

type doctorEnvironment struct {
	Target, Version, Revision string
	BuildChannel, SourceState string
	Now                       time.Time
}

type doctorOptions struct {
	ConfigPath     string
	ConfigExplicit bool
}

// Paths and configuration values stay inside the read boundary, never in a report.
type doctorInstallation struct {
	Present             bool
	ConfigPath, Version string
}

type doctorHost interface {
	Kernel() (string, error)
	Installation() (doctorInstallation, error)
	Configuration(string) error
}

func doctorRequested(arguments []string) bool {
	for _, argument := range arguments {
		name := strings.SplitN(argument, "=", 2)[0]
		if name == "--doctor" || name == "-doctor" || name == "--doctor-mode" || name == "-doctor-mode" {
			return true
		}
	}
	return false
}

func doctorFlags(enabled bool, visited map[string]bool, arguments int) error {
	if !enabled || arguments != 0 {
		return errors.New("doctor_flags_conflict")
	}
	for name := range visited {
		if name != "doctor" && name != "doctor-mode" && name != "json" && name != "config" {
			return errors.New("doctor_flags_conflict")
		}
	}
	return nil
}

func doctorVersion(value string) bool {
	return probeBuildVersionValid(strings.TrimPrefix(value, "v"))
}

func doctorTarget(target string) bool {
	switch target {
	case "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64":
		return true
	}
	return false
}

func collectDoctor(host doctorHost, environment doctorEnvironment, options doctorOptions) doctorReport {
	report := doctorReport{
		SchemaVersion: doctorSchemaVersion, CheckedAt: environment.Now.UTC().Format(time.RFC3339),
		Scope: "local_read_only", Status: "local_checks_passed", Platform: "unsupported",
		Version: "unknown", Revision: "unknown", Checks: []doctorCheck{},
	}
	add := func(check doctorCheck) {
		report.Checks = append(report.Checks, check)
		if check.State == "error" {
			report.Status = "issues_found"
		}
	}
	if doctorVersion(environment.Version) && probeRevisionValid(strings.TrimPrefix(environment.Version, "v"), environment.Revision) {
		report.Version, report.Revision = environment.Version, environment.Revision
		add(doctorCheck{ID: "build", State: "ok", Code: "build_metadata_valid"})
	} else {
		add(doctorCheck{ID: "build", State: "error", Code: "build_metadata_invalid", Remediation: "Use a verifiable build with a version and source revision."})
	}
	if probeAlphaVersionValid(environment.Version) {
		report.DisplayVersion = probeDisplayVersion(environment.Version, environment.Revision, environment.BuildChannel, environment.SourceState)
		if probeBuildChannelValid(environment.BuildChannel) {
			report.BuildChannel = environment.BuildChannel
		}
		switch environment.SourceState {
		case "clean", "dirty", "unknown":
			report.SourceState = environment.SourceState
		}
		if report.DisplayVersion == "unknown" {
			report.Status = "issues_found"
			for index := range report.Checks {
				if report.Checks[index].ID == "build" {
					report.Checks[index] = doctorCheck{ID: "build", State: "error", Code: "build_source_unverified", Remediation: "Build from a verified source revision or use an audited testing release."}
				}
			}
		}
	}
	if doctorTarget(environment.Target) {
		report.Platform = environment.Target
		add(doctorCheck{ID: "platform", State: "ok", Code: "platform_supported"})
		kernelVersion, kernelErr := host.Kernel()
		if kernelBuildVersionValid(kernelVersion) {
			report.KernelLockVersion = kernelVersion
		} else if kernelErr == nil {
			kernelErr = errors.New("kernel_metadata_invalid")
		}
		if kernelErr != nil {
			add(doctorFailure("kernel_materials", kernelErr))
		} else {
			add(doctorCheck{ID: "kernel_materials", State: "ok", Code: "kernel_archive_checksum_matches"})
		}
		installation, installationErr := host.Installation()
		if installationErr == nil && installation.Present && !doctorVersion(installation.Version) {
			installationErr = errors.New("installation_manifest_invalid")
		}
		if installationErr != nil {
			add(doctorFailure("installation", installationErr))
		} else if installation.Present {
			report.InstalledVersion = installation.Version
			add(doctorCheck{ID: "installation", State: "ok", Code: "installation_files_match_manifest"})
		} else {
			add(doctorCheck{ID: "installation", State: "info", Code: "installation_not_found", Remediation: "A standalone detector can run without a managed installation."})
		}
		config, source := "probe.json", "working_directory"
		switch {
		case options.ConfigExplicit:
			config, source = options.ConfigPath, "explicit_config"
		case installationErr != nil:
			config = ""
		case installation.Present:
			config, source = installation.ConfigPath, "installation_manifest"
		}
		if !options.ConfigExplicit && installationErr != nil {
			add(doctorCheck{ID: "configuration", State: "not_run", Code: "configuration_location_unknown", Remediation: "Inspect the installation issue or explicitly select a configuration file."})
		} else {
			check := doctorCheck{ID: "configuration", State: "ok", Code: "configuration_valid"}
			if err := host.Configuration(config); err != nil {
				check = doctorFailure("configuration", err)
			}
			check.Source = source
			add(check)
		}
	} else {
		add(doctorCheck{ID: "platform", State: "error", Code: "platform_unsupported", Remediation: "Use a build for a supported native target."})
		for _, id := range []string{"kernel_materials", "installation", "configuration"} {
			add(doctorCheck{ID: id, State: "not_run", Code: "platform_unsupported"})
		}
	}
	add(doctorCheck{ID: "service", State: "not_run", Code: "service_status_not_checked", Remediation: "Use the separate --status command to query the service manager."})
	add(doctorCheck{ID: "kernel_execution", State: "not_run", Code: "kernel_execution_not_checked", Remediation: "The separate --self-test command executes the embedded kernel when explicitly requested."})
	add(doctorCheck{ID: "network", State: "not_run", Code: "network_not_checked", Remediation: "Server and node connectivity require a separate explicitly authorized check."})
	return report
}

// Only fixed codes and advice leave the host boundary, including unexpected errors.
func doctorFailure(id string, err error) doctorCheck {
	check := doctorCheck{ID: id, State: "error"}
	switch id {
	case "configuration":
		check.Code, check.Remediation = "configuration_unreadable", "Check the selected local configuration and its private permissions."
		switch err.Error() {
		case "config_missing":
			check.Code = "configuration_missing"
		case "config_path_invalid":
			check.Code = "configuration_path_invalid"
		case "config_permissions_require_0600", "config_requires_private_windows_acl":
			check.Code = "configuration_private_permissions_required"
		case "config_too_large":
			check.Code = "configuration_too_large"
		case "invalid_config", "server_must_be_https_origin", "poll_interval_out_of_range":
			check.Code, check.Remediation = "configuration_invalid", "Use configuration schema 1 with an HTTPS origin and valid polling settings."
		}
	case "installation":
		check.Code, check.Remediation = "installation_unreadable", "Inspect the local installation record with the existing recovery guidance."
		switch err.Error() {
		case "installation_manifest_invalid", "installation_metadata_invalid", "installation_unknown_files", "installation_orphaned_files":
			check.Code = "installation_record_invalid"
		case "installation_file_modified":
			check.Code = "installation_files_changed"
		case "installation_requires_regular_user":
			check.Code, check.Remediation = "installation_regular_user_required", "Run diagnostics as the ordinary user who owns the installation."
		case "installation_path_invalid":
			check.Code = "installation_path_invalid"
		case "installation_private_directory_required", "installation_directory_requires_owner_0700", "installation_unsafe_directory", "installation_file_unsafe", "installation_generation_unsafe":
			check.Code = "installation_private_permissions_required"
		}
	case "kernel_materials":
		check.Code, check.Remediation = "kernel_materials_invalid", "Use the complete, verified package for this native platform."
		switch err.Error() {
		case "kernel_missing":
			check.Code = "kernel_materials_missing"
		case "unsupported_platform":
			check.Code = "kernel_target_missing"
		case "kernel_checksum_failed":
			check.Code = "kernel_archive_checksum_mismatch"
		}
	}
	return check
}

func writeDoctorReport(output io.Writer, report doctorReport, asJSON bool) error {
	if asJSON {
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		if encoder.Encode(report) != nil {
			return errors.New("doctor_output_failed")
		}
		return nil
	}
	displayVersion := report.Version
	if report.DisplayVersion != "" {
		displayVersion = report.DisplayVersion
	}
	if _, err := fmt.Fprintf(output, "MiSub Probe doctor v%d: %s; %s; %s\nBuild: %s (%s); target: %s\n", report.SchemaVersion, report.Status, report.Scope, report.CheckedAt, displayVersion, report.Revision, report.Platform); err != nil {
		return errors.New("doctor_output_failed")
	}
	if len(report.SideEffects) > 0 {
		if _, err := fmt.Fprintf(output, "Selected mode: %s; permitted side effects: %s\n", report.Mode, strings.Join(report.SideEffects, ", ")); err != nil {
			return errors.New("doctor_output_failed")
		}
	}
	for _, check := range report.Checks {
		if _, err := fmt.Fprintf(output, "%s: %s / %s", check.ID, check.State, check.Code); err != nil {
			return errors.New("doctor_output_failed")
		}
		if check.Source != "" {
			if _, err := fmt.Fprintf(output, " [%s]", check.Source); err != nil {
				return errors.New("doctor_output_failed")
			}
		}
		if check.Remediation != "" {
			if _, err := fmt.Fprintf(output, "; %s", check.Remediation); err != nil {
				return errors.New("doctor_output_failed")
			}
		}
		if _, err := fmt.Fprintln(output); err != nil {
			return errors.New("doctor_output_failed")
		}
	}
	return nil
}
