package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapResumeMatchesExistingInstallationWithoutMutation(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source-binary")
	if err := os.WriteFile(source, []byte("offline-binary-fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	digest, err := bootstrapSourceSHA256(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, changed := range []string{"none", "config", "version", "binary", "files", "config-invalid"} {
		t.Run(changed, func(t *testing.T) {
			paths := installPaths{Platform: "linux", Root: filepath.Join(dir, "install"), Config: filepath.Join(dir, "probe.json"), Source: source}
			manifest := &installManifest{Current: "fixture", ConfigPath: paths.Config, Generations: []installGeneration{{ID: "fixture", Version: version, BinarySHA256: digest}}}
			files := &memoryInstallationStore{manifest: manifest}
			switch changed {
			case "config":
				manifest.ConfigPath = filepath.Join(dir, "another.json")
			case "version":
				manifest.Generations[0].Version = "other-version"
			case "binary":
				manifest.Generations[0].BinarySHA256 = strings.Repeat("a", 64)
			case "files":
				files.verifyErr = errors.New("installation_modified")
			case "config-invalid":
				files.configErr = errors.New("configuration_invalid")
			}
			runner := &fakeServiceCommands{platform: "linux"}
			manager := installManager{paths: paths, files: files, service: newServiceBackend(paths, runner)}
			status, err := manager.execute(context.Background(), "resume-install")
			if (err == nil) != (changed == "none") {
				t.Fatalf("resume outcome for %s: %v", changed, err)
			}
			if changed == "none" && (status.ExecutablePath != paths.binary("fixture") || status.Service.State != "not_checked") {
				t.Fatal("matching installed path unavailable")
			}
			if files.installs != 0 || files.removes != 0 || len(runner.commands) != 0 || files.manifest != manifest {
				t.Fatal("resume mutated or started existing installation")
			}
		})
	}
}

func TestBootstrapResumeRequiresExistingValidConfigBeforeNewInstall(t *testing.T) {
	for _, valid := range []bool{true, false} {
		paths := installPaths{Platform: "linux", Root: t.TempDir(), Config: filepath.Join(t.TempDir(), "probe.json")}
		files := &memoryInstallationStore{}
		if !valid {
			files.configErr = errors.New("configuration_missing")
		}
		runner := &fakeServiceCommands{platform: "linux"}
		manager := installManager{paths: paths, files: files, service: newServiceBackend(paths, runner)}
		_, err := manager.execute(context.Background(), "resume-install")
		if (err == nil) != valid || files.checks != 1 || len(runner.commands) != 0 {
			t.Fatal("resume bypassed configuration or started a process")
		}
		if valid && files.installs != 1 || !valid && files.installs != 0 {
			t.Fatal("unexpected install action")
		}
	}
}

type startedThenExitedService struct {
	state  serviceStatus
	starts int
}

func (s *startedThenExitedService) Inspect(context.Context, string) (serviceStatus, error) {
	return s.state, nil
}
func (s *startedThenExitedService) Start(context.Context, string) error { s.starts++; return nil }
func (*startedThenExitedService) Stop(context.Context, string) error    { return nil }
func (*startedThenExitedService) Forget(context.Context, string) error  { return nil }

func TestInstallationStartRequiresRunningProcessEvidence(t *testing.T) {
	for _, state := range []serviceStatus{{State: "stopped"}, {State: "failed"}, {State: "running"}, {State: "running", PID: 123}} {
		files := &memoryInstallationStore{manifest: &installManifest{Current: "fixture", ConfigPath: "fixture-config"}}
		service := &startedThenExitedService{state: state}
		manager := installManager{paths: installPaths{Platform: "linux", Root: "fixture"}, files: files, service: service}
		_, err := manager.execute(context.Background(), "start")
		if (err == nil) != (state.State == "running" && state.PID > 0) || service.starts != 1 {
			t.Fatalf("startup result did not reflect %v: %v", state, err)
		}
	}
}
