//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func privatePairingTestDir(t *testing.T) string {
	t.Helper()
	// macOS exposes /var through an OS-managed symlink; test the physical path.
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func fixturePairingConfig() Config {
	return Config{Version: 1, Server: "https://misub.example", Token: fixturePairToken, PollSeconds: 60}
}

func TestPairingConfigCreatesPrivateDirectoryAndAtomicFile(t *testing.T) {
	parent := filepath.Join(privatePairingTestDir(t), "private")
	path := filepath.Join(parent, "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("preflight wrote configuration")
	}
	if err := store.Save(fixturePairingConfig()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(parent)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("unsafe directory")
	}
	info, err = os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe file")
	}
	config, err := readConfig(path)
	if err != nil || config.Token != fixturePairToken {
		t.Fatal("saved config not readable")
	}
	files, err := os.ReadDir(parent)
	if err != nil || len(files) != 1 {
		t.Fatal("temporary secret file left behind")
	}
	if store.Save(fixturePairingConfig()) == nil {
		t.Fatal("existing credentials overwritten")
	}
}

func TestPairingConfigRejectsPermissionsSymlinksAndExistingFiles(t *testing.T) {
	for _, scenario := range []string{"public-directory", "symlink-directory", "symlink-ancestor", "existing-file", "symlink-file", "missing-parent", "relative"} {
		t.Run(scenario, func(t *testing.T) {
			base := privatePairingTestDir(t)
			path := filepath.Join(base, "probe.json")
			switch scenario {
			case "public-directory":
				if err := os.Chmod(base, 0755); err != nil {
					t.Fatal(err)
				}
			case "symlink-directory":
				link := base + "-link"
				if err := os.Symlink(base, link); err != nil {
					t.Fatal(err)
				}
				defer os.Remove(link)
				path = filepath.Join(link, "probe.json")
			case "symlink-ancestor":
				if err := os.Mkdir(filepath.Join(base, "private"), 0700); err != nil {
					t.Fatal(err)
				}
				link := base + "-link"
				if err := os.Symlink(base, link); err != nil {
					t.Fatal(err)
				}
				defer os.Remove(link)
				path = filepath.Join(link, "private", "probe.json")
			case "existing-file":
				if err := os.WriteFile(path, []byte("existing"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink-file":
				if err := os.Symlink(filepath.Join(base, "missing"), path); err != nil {
					t.Fatal(err)
				}
			case "missing-parent":
				path = filepath.Join(base, "missing", "missing", "probe.json")
			case "relative":
				path = "probe.json"
			}
			store, err := preparePairingConfig(path)
			if err == nil {
				store.Close()
				t.Fatal("unsafe configuration path accepted")
			}
			if strings.Contains(err.Error(), base) {
				t.Fatal("configuration error leaked local path")
			}
		})
	}
}

func TestPairingConfigConcurrentDestinationCannotBeClobbered(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		base := privatePairingTestDir(t)
		path := filepath.Join(base, "probe.json")
		store, err := preparePairingConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		victim := filepath.Join(base, "victim")
		if err := os.WriteFile(victim, []byte("existing"), 0600); err != nil {
			t.Fatal(err)
		}
		if symlink {
			err = os.Symlink(victim, path)
		} else {
			err = os.WriteFile(path, []byte("existing"), 0600)
		}
		if err != nil {
			t.Fatal(err)
		}
		if store.Save(fixturePairingConfig()) == nil {
			t.Fatal("racing destination overwritten")
		}
		value, err := os.ReadFile(path)
		if err != nil || string(value) != "existing" {
			t.Fatal("existing contents changed")
		}
	}
}

func TestPairingConfigDirectoryHandleSurvivesRename(t *testing.T) {
	base := privatePairingTestDir(t)
	parent := filepath.Join(base, "private")
	path := filepath.Join(parent, "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	moved := filepath.Join(base, "moved")
	if err := os.Rename(parent, moved); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(base, "other")
	if err := os.Mkdir(other, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, parent); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(fixturePairingConfig()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(other, "probe.json")); !os.IsNotExist(err) {
		t.Fatal("credentials followed replacement symlink")
	}
	if _, err := readConfig(filepath.Join(moved, "probe.json")); err != nil {
		t.Fatal("held directory did not receive complete config")
	}
}

func TestPairingConfigWriteFailureAndPermissionChangeFailClosed(t *testing.T) {
	for _, closeRoot := range []bool{false, true} {
		base := privatePairingTestDir(t)
		path := filepath.Join(base, "probe.json")
		store, err := preparePairingConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		if closeRoot {
			_ = store.Close()
		} else {
			if err := os.Chmod(base, 0755); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.Save(fixturePairingConfig()); err == nil {
			t.Fatal("unsafe or failed write accepted")
		}
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("failed save published credential")
		}
	}
}
