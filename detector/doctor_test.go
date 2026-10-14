package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fixtureDoctorHost struct {
	kernelVersion                         string
	kernelErr, installationErr, configErr error
	installation                          doctorInstallation
	calls                                 []string
}

func (h *fixtureDoctorHost) Kernel() (string, error) {
	h.calls = append(h.calls, "kernel")
	return h.kernelVersion, h.kernelErr
}
func (h *fixtureDoctorHost) Installation() (doctorInstallation, error) {
	h.calls = append(h.calls, "installation")
	return h.installation, h.installationErr
}
func (h *fixtureDoctorHost) Configuration(path string) error {
	h.calls = append(h.calls, "configuration:"+path)
	return h.configErr
}
func fixtureDoctorEnvironment() doctorEnvironment {
	return doctorEnvironment{Target: "linux-amd64", Version: "0.3.0-dev", Revision: strings.Repeat("a", 40), Now: time.Date(2026, 10, 14, 16, 30, 0, 0, time.FixedZone("fixture", 8*3600))}
}
func doctorCheckByID(t *testing.T, report doctorReport, id string) doctorCheck {
	t.Helper()
	for _, check := range report.Checks {
		if check.ID == id {
			return check
		}
	}
	t.Fatalf("missing check %s", id)
	return doctorCheck{}
}

func TestDoctorReadScopeAndConfigSelection(t *testing.T) {
	for _, row := range []struct {
		name                             string
		installation                     doctorInstallation
		installationErr                  error
		options                          doctorOptions
		wantPath, wantSource, wantStatus string
	}{
		{"standalone", doctorInstallation{}, nil, doctorOptions{}, "probe.json", "working_directory", "local_checks_passed"},
		{"installed", doctorInstallation{true, "/private/installed.json", "0.2.0"}, nil, doctorOptions{}, "/private/installed.json", "installation_manifest", "local_checks_passed"},
		{"explicit", doctorInstallation{true, "/private/installed.json", "0.2.0"}, nil, doctorOptions{ConfigPath: "/private/selected.json", ConfigExplicit: true}, "/private/selected.json", "explicit_config", "local_checks_passed"},
		{"broken_install", doctorInstallation{}, errors.New("installation_file_modified"), doctorOptions{}, "", "", "issues_found"},
		{"override_broken_install", doctorInstallation{}, errors.New("installation_manifest_invalid"), doctorOptions{ConfigPath: "/private/selected.json", ConfigExplicit: true}, "/private/selected.json", "explicit_config", "issues_found"},
	} {
		t.Run(row.name, func(t *testing.T) {
			host := &fixtureDoctorHost{kernelVersion: "v1.19.32", installation: row.installation, installationErr: row.installationErr}
			report := collectDoctor(host, fixtureDoctorEnvironment(), row.options)
			if report.SchemaVersion != 1 || report.CheckedAt != "2026-10-14T08:30:00Z" || report.Scope != "local_read_only" || report.Status != row.wantStatus || len(report.Checks) != 8 {
				t.Fatalf("unexpected envelope: %+v", report)
			}
			calls := []string{"kernel", "installation"}
			if row.wantPath != "" {
				calls = append(calls, "configuration:"+row.wantPath)
			}
			if !reflect.DeepEqual(host.calls, calls) {
				t.Fatalf("read calls: %v", host.calls)
			}
			config := doctorCheckByID(t, report, "configuration")
			if config.Source != row.wantSource {
				t.Fatalf("configuration source: %+v", config)
			}
			if row.wantPath == "" && (config.State != "not_run" || config.Code != "configuration_location_unknown") {
				t.Fatalf("unsafe fallback: %+v", config)
			}
			for _, id := range []string{"service", "kernel_execution", "network"} {
				if check := doctorCheckByID(t, report, id); check.State != "not_run" {
					t.Fatalf("unperformed check marked complete: %+v", check)
				}
			}
		})
	}
}

func TestDoctorUnknownPlatformDoesNotAccessHost(t *testing.T) {
	host := &fixtureDoctorHost{}
	environment := fixtureDoctorEnvironment()
	environment.Target = "private-platform-name"
	report := collectDoctor(host, environment, doctorOptions{})
	if len(host.calls) != 0 || report.Platform != "unsupported" || report.Status != "issues_found" {
		t.Fatalf("unsupported target read host: %+v", report)
	}
	for _, id := range []string{"kernel_materials", "installation", "configuration"} {
		if doctorCheckByID(t, report, id).State != "not_run" {
			t.Fatal("unsupported target check ran")
		}
	}
}

func TestDoctorReportsNeverIncludeHostDetails(t *testing.T) {
	secret := "PRIVATE_CANARY_9e: token=secret https://user:pass@private.invalid/node"
	for _, target := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"} {
		environment := fixtureDoctorEnvironment()
		environment.Target = target
		environment.Version, environment.Revision = secret, secret
		host := &fixtureDoctorHost{kernelVersion: secret, kernelErr: errors.New(secret), installationErr: errors.New(secret), configErr: errors.New(secret)}
		report := collectDoctor(host, environment, doctorOptions{ConfigPath: secret, ConfigExplicit: true})
		if report.Version != "unknown" || report.Revision != "unknown" || report.KernelLockVersion != "" || report.InstalledVersion != "" {
			t.Fatal("invalid metadata retained")
		}
		for _, asJSON := range []bool{true, false} {
			var out bytes.Buffer
			if err := writeDoctorReport(&out, report, asJSON); err != nil {
				t.Fatal(err)
			}
			for _, marker := range []string{"PRIVATE_CANARY", "private.invalid", "token=secret", "user:pass"} {
				if strings.Contains(out.String(), marker) {
					t.Fatalf("private field escaped in report (%s)", target)
				}
			}
			if asJSON {
				var decoded doctorReport
				if json.Unmarshal(out.Bytes(), &decoded) != nil || !reflect.DeepEqual(decoded, report) {
					t.Fatal("JSON report does not round trip")
				}
			}
		}
	}
	// Installed metadata is untrusted even when the store could parse its manifest.
	host := &fixtureDoctorHost{kernelVersion: "v1.19.32", installation: doctorInstallation{true, secret, secret}}
	report := collectDoctor(host, fixtureDoctorEnvironment(), doctorOptions{})
	if report.InstalledVersion != "" || len(host.calls) != 2 || doctorCheckByID(t, report, "installation").Code != "installation_record_invalid" {
		t.Fatal("invalid installed metadata was trusted")
	}
}

func TestDoctorConfigurationFailuresRemainBounded(t *testing.T) {
	for _, row := range [][2]string{
		{"config_missing", "configuration_missing"}, {"config_path_invalid", "configuration_path_invalid"},
		{"config_permissions_require_0600", "configuration_private_permissions_required"}, {"config_requires_private_windows_acl", "configuration_private_permissions_required"},
		{"config_too_large", "configuration_too_large"}, {"invalid_config", "configuration_invalid"},
		{"server_must_be_https_origin", "configuration_invalid"}, {"poll_interval_out_of_range", "configuration_invalid"},
		{"private parser detail", "configuration_unreadable"},
	} {
		host := &fixtureDoctorHost{kernelVersion: "v1.19.32", configErr: errors.New(row[0])}
		report := collectDoctor(host, fixtureDoctorEnvironment(), doctorOptions{})
		check := doctorCheckByID(t, report, "configuration")
		if report.Status != "issues_found" || check.State != "error" || check.Code != row[1] {
			t.Fatalf("failure incorrectly classified: %+v", check)
		}
	}
}

func TestDoctorRejectsMutatingOrExecutingFlagCombinations(t *testing.T) {
	for _, flag := range []string{"pair", "setup", "resume", "server", "pair-window", "pair-name", "managed-run", "install", "start", "stop", "status", "uninstall", "reinstall", "resume-install", "once", "version", "capabilities", "check-config", "self-test"} {
		if doctorFlags(true, map[string]bool{"doctor": true, flag: true}, 0) == nil {
			t.Fatalf("accepted --%s with doctor", flag)
		}
	}
	if doctorFlags(false, map[string]bool{"doctor": true}, 0) == nil || doctorFlags(true, map[string]bool{"doctor": true}, 1) == nil {
		t.Fatal("disabled doctor or positional command accepted")
	}
	if err := doctorFlags(true, map[string]bool{"doctor": true, "json": true, "config": true}, 0); err != nil {
		t.Fatal(err)
	}
}

func TestDoctorOutputFailureIsFixed(t *testing.T) {
	report := collectDoctor(&fixtureDoctorHost{kernelVersion: "v1.19.32"}, fixtureDoctorEnvironment(), doctorOptions{})
	for _, asJSON := range []bool{true, false} {
		if err := writeDoctorReport(failingBootstrapWriter{}, report, asJSON); err == nil || err.Error() != "doctor_output_failed" {
			t.Fatalf("unsafe output error: %v", err)
		}
	}
}

func TestDoctorCLIHelper(t *testing.T) {
	if os.Getenv("MISUB_DOCTOR_CLI_FIXTURE") != "1" {
		return
	}
	for index, argument := range os.Args {
		if argument == "--" {
			os.Args = append([]string{"probe"}, os.Args[index+1:]...)
			flag.CommandLine = flag.NewFlagSet("probe", flag.ExitOnError)
			main()
			os.Exit(0)
		}
	}
	os.Exit(99)
}

func TestDoctorCLIRejectsConflictsBeforeReadingConfiguration(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "PRIVATE_CANARY_missing.json")
	for _, arguments := range [][]string{
		{"--doctor", "--self-test"}, {"--doctor", "--start=false"}, {"--doctor", "--capabilities"},
		{"--doctor=false"}, {"--doctor", "stray"}, {"stray", "--doctor"}, {"--", "--doctor"},
		{"stray", "-doctor=true"}, {"stray", "--doctor=false"},
		{"--config", "--doctor"}, {"--managed-run", "--doctor"}, {"--server", "--doctor"},
	} {
		command := exec.Command(os.Args[0], append([]string{"-test.run=^TestDoctorCLIHelper$", "--", "--config", missing}, arguments...)...)
		command.Env = append(os.Environ(), "MISUB_DOCTOR_CLI_FIXTURE=1")
		output, err := command.CombinedOutput()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 || string(output) != "probe: doctor_flags_conflict\n" {
			t.Fatalf("arguments %v escaped diagnostic validation: exit=%v output=%q", arguments, err, output)
		}
	}
}
