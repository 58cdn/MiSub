//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func fixtureInstallationPaths(t *testing.T) installPaths {
	t.Helper()
	home := privatePairingTestDir(t)
	source := filepath.Join(home, "source-probe")
	if err := os.WriteFile(source, []byte("fixture executable; never execute"), 0700); err != nil {
		t.Fatal(err)
	}
	return installPaths{Home: home, Root: filepath.Join(home, ".misub-probe", "install"), Source: source, Config: filepath.Join(home, ".misub-probe", "probe.json"), UID: os.Geteuid(), Platform: runtime.GOOS}
}

func fixtureInstallationStore(t *testing.T, paths installPaths) *privateInstallationStore {
	t.Helper()
	store, err := openInstallationStore(paths, "install")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store.(*privateInstallationStore)
}

func TestInstallationPrivateFilesAtomicManifestAndConfigurationReuse(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Config); !os.IsNotExist(err) {
		t.Fatal("install generated credentials")
	}
	if err := store.Verify(manifest); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{paths.Root: 0700, paths.binary(manifest.Current): 0700, paths.service(manifest.Current): 0600, filepath.Join(paths.Root, "manifest.json"): 0600} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("unsafe installation file: %v", err)
		}
	}
	config := fixturePairingConfig()
	encoded, _ := json.Marshal(config)
	if err := os.WriteFile(paths.Config, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigReady(paths.Config); err != nil {
		t.Fatal(err)
	}
	old := manifest.Current
	if err := os.WriteFile(paths.Source, []byte("second fixture executable"), 0700); err != nil {
		t.Fatal(err)
	}
	manifest, err = store.Install(manifest, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Current == old || len(manifest.Generations) != 2 || manifest.ConfigPath != paths.Config {
		t.Fatal("reinstall did not publish a distinct complete generation")
	}
	if err := store.Verify(manifest); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(manifest); err != nil {
		t.Fatal(err)
	}
	retained, err := os.ReadFile(paths.Config)
	if err != nil || string(retained) != string(encoded) {
		t.Fatal("uninstall changed credentials")
	}
	entries, err := os.ReadDir(paths.Root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "operation.lock" {
		t.Fatal("uninstall retained manifest-owned program files")
	}
	if loaded, err := store.Load(); err != nil || loaded != nil {
		t.Fatal("uninstalled state not readable")
	}
}

func TestInstallationRejectsFileChangesAndUnknownFiles(t *testing.T) {
	for _, scenario := range []string{"unknown-root", "unknown-generation", "binary-modified", "service-modified", "binary-symlink", "generation-symlink", "public-directory"} {
		t.Run(scenario, func(t *testing.T) {
			paths := fixtureInstallationPaths(t)
			store := fixtureInstallationStore(t, paths)
			manifest, err := store.Install(nil, paths.Config)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "unknown-root":
				err = os.WriteFile(filepath.Join(paths.Root, "user-document"), []byte("preserve"), 0600)
			case "unknown-generation":
				err = os.WriteFile(filepath.Join(paths.Root, manifest.Current, "user-document"), []byte("preserve"), 0600)
			case "binary-modified":
				err = os.WriteFile(paths.binary(manifest.Current), []byte("changed"), 0700)
			case "service-modified":
				err = os.WriteFile(paths.service(manifest.Current), []byte("changed"), 0600)
			case "binary-symlink":
				if err = os.Remove(paths.binary(manifest.Current)); err == nil {
					err = os.Symlink(paths.Source, paths.binary(manifest.Current))
				}
			case "generation-symlink":
				original := filepath.Join(paths.Root, manifest.Current)
				moved := filepath.Join(paths.Home, "moved")
				if err = os.Rename(original, moved); err == nil {
					err = os.Symlink(moved, original)
				}
			case "public-directory":
				err = os.Chmod(paths.Root, 0755)
			}
			if err != nil {
				t.Fatal(err)
			}
			if store.Verify(manifest) == nil || store.Remove(manifest) == nil {
				t.Fatal("unsafe files accepted or deleted")
			}
			if _, err := os.Lstat(filepath.Join(paths.Root, "manifest.json")); err != nil {
				t.Fatal("failed uninstall removed manifest")
			}
		})
	}
}

func TestInstallationFailedStagePreservesPreviousGeneration(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(paths.Root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(paths.Source, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Install(manifest, paths.Config); err == nil {
		t.Fatal("writable source accepted")
	}
	after, err := os.ReadFile(filepath.Join(paths.Root, "manifest.json"))
	if err != nil || string(before) != string(after) {
		t.Fatal("failed stage changed manifest")
	}
	if err := store.Verify(manifest); err != nil {
		t.Fatal("previous generation no longer complete")
	}
}

func TestInstallationLockAndReadOnlyMissingStatus(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	missing, err := openInstallationStore(paths, "status")
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Close()
	if value, err := missing.Load(); err != nil || value != nil {
		t.Fatal("missing status failed")
	}
	if _, err := os.Stat(paths.Root); !os.IsNotExist(err) {
		t.Fatal("status created directories")
	}
	first := fixtureInstallationStore(t, paths)
	if second, err := openInstallationStore(paths, "start"); err == nil {
		second.Close()
		t.Fatal("concurrent mutation accepted")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	first.lock = nil
	first.root = nil
	if second, err := openInstallationStore(paths, "start"); err != nil {
		t.Fatal(err)
	} else {
		second.Close()
	}
}

func TestInstallationUninstallResumesAfterInterruptedRemoval(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(paths.binary(manifest.Current)); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(manifest); err != nil {
		t.Fatal(err)
	}
	if loaded, err := store.Load(); err != nil || loaded != nil {
		t.Fatal("interrupted uninstall cannot finish")
	}
}

func TestInstallationMovedRootCannotReceiveFiles(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	moved := paths.Root + "-moved"
	if err := os.Rename(paths.Root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(paths.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Install(nil, paths.Config); err == nil {
		t.Fatal("changed directory accepted")
	}
	entries, err := os.ReadDir(paths.Root)
	if err != nil || len(entries) != 0 {
		t.Fatal("replacement directory modified")
	}
}

func TestInstallationNativeServiceDescriptionSyntax(t *testing.T) {
	for _, suffix := range []string{"ordinary", "space dollar$ percent%"} {
		t.Run(suffix, func(t *testing.T) { verifyInstallationServiceSyntax(t, suffix) })
	}
}

func verifyInstallationServiceSyntax(t *testing.T, suffix string) {
	t.Helper()
	paths := fixtureInstallationPaths(t)
	paths.Root = filepath.Join(paths.Root, suffix)
	paths.Config = filepath.Join(paths.Home, "space dollar$ percent% quote\" backslash\\.json")
	id := "00112233445566778899aabb"
	if err := os.MkdirAll(filepath.Dir(paths.binary(id)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.binary(id), []byte("fixture executable; never execute"), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := renderInstallService(paths, id, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	path := paths.service(id)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.Command("/usr/bin/plutil", "-lint", path)
	} else {
		if _, err := os.Stat("/usr/bin/systemd-analyze"); err != nil {
			t.Skip("systemd-analyze is unavailable; static renderer tests still run")
		}
		command = exec.Command("/usr/bin/systemd-analyze", "verify", "--man=no", path)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("read-only syntax check: %v: %s", err, output)
	}
}

func TestInstallationConfigCannotEnterManagedTree(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	for _, config := range []string{paths.Root, filepath.Join(paths.Root, "probe.json"), filepath.Join(paths.Root, "nested", "probe.json")} {
		if _, err := store.Install(nil, config); err == nil {
			t.Fatal("configuration inside managed tree accepted")
		}
		if manifest, err := store.Load(); err != nil || manifest != nil {
			t.Fatal("rejected config published files")
		}
	}
	entries, err := os.ReadDir(paths.Root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "operation.lock" {
		t.Fatal("rejected config left installation files")
	}
}

func TestInstallationManifestCannotNameOutsideFiles(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	store := fixtureInstallationStore(t, paths)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(paths.Home, "preserve")
	if err := os.WriteFile(sentinel, []byte("preserve me"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest.Current = "../../preserve"
	manifest.Generations[0].ID = manifest.Current
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(paths.Root, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("manifest traversal accepted")
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "preserve me" {
		t.Fatal("outside file changed")
	}
}

func TestInstallationNativeLaunchctlCommandHelp(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("native macOS command documentation")
	}
	for _, name := range []string{"bootstrap", "bootout", "kickstart", "print"} {
		output, err := exec.Command("/bin/launchctl", "help", name).CombinedOutput()
		if err != nil || !strings.Contains(string(output), name) {
			t.Fatalf("launchctl help %s unavailable: %v: %s", name, err, output)
		}
		t.Logf("read-only launchctl help %s:\n%s", name, output)
	}
}

func TestInstallationManagerFilesystemLifecycleUsesOnlyFakeServices(t *testing.T) {
	paths := fixtureInstallationPaths(t)
	files := fixtureInstallationStore(t, paths)
	runner := &fakeServiceCommands{platform: runtime.GOOS}
	manager := installManager{paths: paths, files: files, service: newServiceBackend(paths, runner)}
	if _, err := manager.execute(context.Background(), "install"); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 0 {
		t.Fatal("install called real service manager")
	}
	if _, err := manager.execute(context.Background(), "start"); err == nil {
		t.Fatal("unpaired detector started")
	}
	config, _ := json.Marshal(fixturePairingConfig())
	if err := os.WriteFile(paths.Config, config, 0600); err != nil {
		t.Fatal(err)
	}
	if status, err := manager.execute(context.Background(), "start"); err != nil || status.Service.State != "running" {
		t.Fatalf("fake start failed: %v", err)
	}
	if _, err := manager.execute(context.Background(), "stop"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.execute(context.Background(), "uninstall"); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(paths.Config); err != nil {
		t.Fatal("configuration removed")
	}
}
