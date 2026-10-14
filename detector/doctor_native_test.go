//go:build linux || darwin || windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type doctorArchiveFile struct {
	io.Reader
	readBytes int64
	closed    int
}

func (f *doctorArchiveFile) Read(p []byte) (int, error) {
	n, err := f.Reader.Read(p)
	f.readBytes += int64(n)
	return n, err
}
func (f *doctorArchiveFile) Close() error { f.closed++; return nil }
func (f *doctorArchiveFile) Stat() (fs.FileInfo, error) {
	return nil, errors.New("archive_stat_not_needed")
}

type doctorArchiveFS struct {
	file  *doctorArchiveFile
	err   error
	paths []string
}

func (f *doctorArchiveFS) Open(name string) (fs.File, error) {
	f.paths = append(f.paths, name)
	if f.err != nil {
		return nil, f.err
	}
	if f.file == nil {
		return nil, fs.ErrNotExist
	}
	return f.file, nil
}

func doctorNativeHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func doctorNativeLock(target, extension, checksum string) kernelLock {
	return kernelLock{Version: "v1.19.0", Assets: map[string]kernelAsset{
		target: {File: "mihomo-" + target + "-v1.19.0" + extension, SHA256: checksum},
	}}
}

func doctorNativeError(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	} else if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestDoctorNativeKernelHashesFixedArchiveWithoutDecoding(t *testing.T) {
	for _, tc := range []struct{ target, extension string }{
		{"linux-amd64", ".gz"}, {"darwin-arm64", ".gz"}, {"windows-amd64", ".zip"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			// Deliberately not a compressed archive: this check establishes only its digest.
			payload := "inert synthetic archive bytes"
			archive := &doctorArchiveFile{Reader: strings.NewReader(payload)}
			files := &doctorArchiveFS{file: archive}
			lock := doctorNativeLock(tc.target, tc.extension, doctorNativeHash([]byte(payload)))
			version, err := inspectDoctorKernel(lock, files, tc.target)
			doctorNativeError(t, err, "")
			if version != lock.Version || !reflect.DeepEqual(files.paths, []string{"embedded/kernel" + tc.extension}) || archive.closed != 1 {
				t.Fatalf("version=%q paths=%v closes=%d", version, files.paths, archive.closed)
			}
		})
	}
}

func TestDoctorNativeKernelRejectsMetadataBeforeOpening(t *testing.T) {
	const target = "linux-amd64"
	for _, tc := range []struct {
		name, want string
		mutate     func(*kernelLock)
	}{
		{"empty version", "kernel_metadata_invalid", func(l *kernelLock) { l.Version = "" }},
		{"invalid version", "kernel_metadata_invalid", func(l *kernelLock) { l.Version = "../1.0.0" }},
		{"long version", "kernel_metadata_invalid", func(l *kernelLock) { l.Version = strings.Repeat("1", 65) }},
		{"unsupported target", "unsupported_platform", func(l *kernelLock) { l.Assets = nil }},
		{"wrong target", "kernel_metadata_invalid", func(l *kernelLock) {
			a := l.Assets[target]
			a.File = "mihomo-darwin-arm64-v1.19.0.gz"
			l.Assets[target] = a
		}},
		{"wrong extension", "kernel_metadata_invalid", func(l *kernelLock) { a := l.Assets[target]; a.File += ".tar"; l.Assets[target] = a }},
		{"short checksum", "kernel_metadata_invalid", func(l *kernelLock) { a := l.Assets[target]; a.SHA256 = "abc"; l.Assets[target] = a }},
		{"uppercase checksum", "kernel_metadata_invalid", func(l *kernelLock) { a := l.Assets[target]; a.SHA256 = strings.Repeat("A", 64); l.Assets[target] = a }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lock := doctorNativeLock(target, ".gz", strings.Repeat("a", 64))
			tc.mutate(&lock)
			files := &doctorArchiveFS{}
			version, err := inspectDoctorKernel(lock, files, target)
			doctorNativeError(t, err, tc.want)
			if len(files.paths) != 0 {
				t.Fatalf("invalid metadata opened %v", files.paths)
			}
			if (doctorVersion(lock.Version) && version != lock.Version) || (!doctorVersion(lock.Version) && version != "") {
				t.Fatalf("unexpected version %q", version)
			}
		})
	}
}

type doctorBrokenReader struct{}

func (doctorBrokenReader) Read(p []byte) (int, error) {
	return copy(p, "partial"), errors.New("synthetic private read failure")
}

func TestDoctorNativeKernelReadFailuresAreBoundedAndClosed(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		reader     io.Reader
		openErr    error
	}{
		{"missing", "kernel_missing", nil, fs.ErrNotExist},
		{"denied", "kernel_missing", nil, fs.ErrPermission},
		{"empty", "kernel_materials_invalid", strings.NewReader(""), nil},
		{"read error", "kernel_materials_invalid", doctorBrokenReader{}, nil},
		{"checksum mismatch", "kernel_checksum_failed", strings.NewReader("changed"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive := &doctorArchiveFile{Reader: tc.reader}
			files := &doctorArchiveFS{file: archive, err: tc.openErr}
			_, err := inspectDoctorKernel(doctorNativeLock("linux-amd64", ".gz", strings.Repeat("a", 64)), files, "linux-amd64")
			doctorNativeError(t, err, tc.want)
			wantCloses := 1
			if tc.openErr != nil {
				wantCloses = 0
			}
			if archive.closed != wantCloses {
				t.Fatalf("close count = %d, want %d", archive.closed, wantCloses)
			}
		})
	}
}

type doctorZeroReader struct{}

func (doctorZeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestDoctorNativeKernelSizeBoundary(t *testing.T) {
	digest := sha256.New()
	if _, err := io.Copy(digest, io.LimitReader(doctorZeroReader{}, maxKernelBytes)); err != nil {
		t.Fatal(err)
	}
	lock := doctorNativeLock("linux-amd64", ".gz", hex.EncodeToString(digest.Sum(nil)))
	for _, tc := range []struct {
		name string
		size int64
		want string
	}{
		{"maximum", maxKernelBytes, ""},
		{"oversized", maxKernelBytes * 2, "kernel_materials_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive := &doctorArchiveFile{Reader: io.LimitReader(doctorZeroReader{}, tc.size)}
			_, err := inspectDoctorKernel(lock, &doctorArchiveFS{file: archive}, "linux-amd64")
			doctorNativeError(t, err, tc.want)
			if archive.readBytes != min(tc.size, maxKernelBytes+1) || archive.closed != 1 {
				t.Fatalf("read=%d close=%d", archive.readBytes, archive.closed)
			}
		})
	}
}

func doctorNativePrivateDir(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir, cleanup, err := createPrivateTempDir(base, "doctor-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return dir
}

func doctorNativeWrite(t *testing.T, path string, data []byte, mode fs.FileMode) {
	t.Helper()
	if err := writePrivateFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}

type doctorNativeEntry struct {
	Mode     fs.FileMode
	Modified int64
	Size     int64
	Digest   string
	Entries  []string
}

func doctorNativeSnapshot(t *testing.T, root string) map[string]doctorNativeEntry {
	t.Helper()
	snapshot := map[string]doctorNativeEntry{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		state := doctorNativeEntry{Mode: info.Mode(), Modified: info.ModTime().UnixNano(), Size: info.Size()}
		if entry.IsDir() {
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			for _, child := range children {
				state.Entries = append(state.Entries, child.Name())
			}
		} else if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			state.Digest = doctorNativeHash(data)
		} else {
			return errors.New("unexpected nonregular fixture entry")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		snapshot[relative] = state
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func doctorNativeUnchanged(t *testing.T, root string, before map[string]doctorNativeEntry) {
	t.Helper()
	after := doctorNativeSnapshot(t, root)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("doctor changed fixture contents, permissions, modification times, or directory entries")
	}
}

func TestDoctorNativeConfigurationValidationIsReadOnly(t *testing.T) {
	legacy := `{"version":1,"server":"https://misub.example/","token":"` + fixturePairToken + `"}`
	current := strings.TrimSuffix(legacy, "}") + `,"pollSeconds":60}`
	for _, tc := range []struct{ name, data, want string }{
		{"current", current, ""},
		{"legacy defaults", legacy, ""},
		{"minimum interval", strings.Replace(current, ":60", ":30", 1), ""},
		{"maximum interval", strings.Replace(current, ":60", ":300", 1), ""},
		{"malformed", `{`, "invalid_config"},
		{"unknown field", strings.TrimSuffix(current, "}") + `,"extra":true}`, "invalid_config"},
		{"trailing JSON", current + `{}`, "invalid_config"},
		{"invalid version", strings.Replace(current, `"version":1`, `"version":2`, 1), "invalid_config"},
		{"invalid token", strings.Replace(current, fixturePairToken, "synthetic-invalid", 1), "invalid_config"},
		{"plaintext server", strings.Replace(current, "https://", "http://", 1), "server_must_be_https_origin"},
		{"query server", strings.Replace(current, ".example/", ".example/?fixture=1", 1), "server_must_be_https_origin"},
		{"short interval", strings.Replace(current, ":60", ":29", 1), "poll_interval_out_of_range"},
		{"long interval", strings.Replace(current, ":60", ":301", 1), "poll_interval_out_of_range"},
		{"size limit", current + strings.Repeat(" ", 16384-len(current)), ""},
		{"oversized", current + strings.Repeat(" ", 16385-len(current)), "config_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := doctorNativePrivateDir(t)
			path := filepath.Join(dir, "probe.json")
			doctorNativeWrite(t, path, []byte(tc.data), 0600)
			before := doctorNativeSnapshot(t, dir)
			for range 2 {
				doctorNativeError(t, (nativeDoctorHost{}).Configuration(path), tc.want)
			}
			doctorNativeUnchanged(t, dir, before)
		})
	}
}

func TestDoctorNativeConfigurationMissingAndUnsafePaths(t *testing.T) {
	dir := doctorNativePrivateDir(t)
	before := doctorNativeSnapshot(t, dir)
	doctorNativeError(t, (nativeDoctorHost{}).Configuration(""), "config_path_invalid")
	doctorNativeError(t, (nativeDoctorHost{}).Configuration(filepath.Join(dir, "absent", "probe.json")), "config_missing")
	doctorNativeError(t, (nativeDoctorHost{}).Configuration(filepath.Join(dir, "invalid\x00.json")), "config_path_invalid")
	if err := (nativeDoctorHost{}).Configuration(dir); err == nil {
		t.Fatal("directory accepted as configuration")
	}
	if runtime.GOOS == "windows" {
		for _, path := range []string{`\\fixture.invalid\share\probe.json`, `\\?\C:\fixture\probe.json`, `\\.\pipe\doctor-fixture`, filepath.Join(dir, "probe.json:stream")} {
			doctorNativeError(t, (nativeDoctorHost{}).Configuration(path), "config_path_invalid")
			got, err := inspectDoctorInstallation(installPaths{Root: path, Platform: runtime.GOOS})
			doctorNativeError(t, err, "installation_path_invalid")
			if got != (doctorInstallation{}) {
				t.Fatal("invalid installation path returned state")
			}
		}
	}
	doctorNativeUnchanged(t, dir, before)
}

func TestDoctorNativeConfigurationRejectsNonprivateFixture(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "probe.json")
	data := `{"version":1,"server":"https://misub.example","token":"` + fixturePairToken + `"}`
	if err := os.WriteFile(path, []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
	before := doctorNativeSnapshot(t, dir)
	if err := (nativeDoctorHost{}).Configuration(path); err == nil {
		t.Fatal("nonprivate configuration accepted")
	}
	doctorNativeUnchanged(t, dir, before)
}

func doctorNativePrivateChild(t *testing.T, path string) {
	t.Helper()
	// Prepare only the fixture directory; no configuration is published.
	store, err := preparePairingConfig(filepath.Join(path, "not-published.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDoctorNativeParentGuardLifetime(t *testing.T) {
	base := doctorNativePrivateDir(t)
	parent := filepath.Join(base, "parent")
	child := filepath.Join(parent, "child")
	doctorNativePrivateChild(t, parent)
	doctorNativePrivateChild(t, child)
	before := doctorNativeSnapshot(t, base)
	release, err := doctorPinParents(filepath.Join(child, "absent.json"))
	doctorNativeError(t, err, "")
	if release == nil {
		t.Fatal("valid guard returned no release function")
	}
	defer release()
	if runtime.GOOS == "windows" {
		for _, path := range []string{parent, child} {
			if err := os.Rename(path, path+"-moved"); err == nil {
				t.Fatal("ancestor was replaceable while the doctor reader held it")
			}
		}
	}
	release()
	release()
	doctorNativeUnchanged(t, base, before)
	if err := os.Rename(parent, parent+"-released"); err != nil {
		t.Fatalf("parent handle remains held after release: %v", err)
	}
	if err := os.Rename(filepath.Join(parent+"-released", "child"), filepath.Join(parent+"-released", "child-released")); err != nil {
		t.Fatalf("child handle remains held after release: %v", err)
	}
}

func TestDoctorNativeParentGuardFailureClosesEarlierHandles(t *testing.T) {
	base := doctorNativePrivateDir(t)
	parent := filepath.Join(base, "parent")
	doctorNativePrivateChild(t, parent)
	before := doctorNativeSnapshot(t, base)
	for _, path := range []string{"relative.json", filepath.Join(parent, "invalid\x00.json")} {
		release, err := doctorPinParents(path)
		if release != nil {
			release()
			t.Fatal("invalid path returned a lease")
		}
		doctorNativeError(t, err, "doctor_local_path_required")
	}
	release, err := doctorPinParents(filepath.Join(parent, "missing", "config.json"))
	if runtime.GOOS == "windows" {
		if release != nil {
			release()
			t.Fatal("missing parent returned a lease")
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("missing parent = %v", err)
		}
	} else {
		doctorNativeError(t, err, "")
		if release == nil {
			t.Fatal("local Unix path returned no release function")
		}
		release()
	}
	doctorNativeUnchanged(t, base, before)
	if err := os.Rename(parent, parent+"-released"); err != nil {
		t.Fatalf("failed guard retained an ancestor handle: %v", err)
	}
}

func TestDoctorNativeConfigurationReleasesParentsAfterRead(t *testing.T) {
	for _, valid := range []bool{true, false} {
		t.Run(map[bool]string{true: "valid", false: "invalid"}[valid], func(t *testing.T) {
			base := doctorNativePrivateDir(t)
			parent := filepath.Join(base, "config")
			doctorNativePrivateChild(t, parent)
			data := `{"version":1,"server":"https://misub.example","token":"` + fixturePairToken + `"}`
			want := ""
			if !valid {
				data, want = "{", "invalid_config"
			}
			path := filepath.Join(parent, "probe.json")
			doctorNativeWrite(t, path, []byte(data), 0600)
			doctorNativeError(t, (nativeDoctorHost{}).Configuration(path), want)
			if err := os.Rename(parent, parent+"-released"); err != nil {
				t.Fatalf("configuration read retained parent handles: %v", err)
			}
		})
	}
}

func doctorNativeInstallFixture(t *testing.T) (installPaths, installManifest) {
	t.Helper()
	home := doctorNativePrivateDir(t)
	root, cleanup, err := createPrivateTempDir(home, "install-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	paths := installPaths{Home: home, Root: root, Config: filepath.Join(home, "absent-config.json"), Platform: runtime.GOOS}
	manifest := installManifest{Schema: installSchema, Platform: runtime.GOOS, ConfigPath: paths.Config}
	for i, id := range []string{strings.Repeat("a", 24), strings.Repeat("b", 24)} {
		doctorNativePrivateChild(t, filepath.Join(root, id))
		binary, service := []byte("inert binary "+id), []byte("inert service "+id)
		doctorNativeWrite(t, paths.binary(id), binary, 0700)
		doctorNativeWrite(t, paths.service(id), service, 0600)
		manifest.Generations = append(manifest.Generations, installGeneration{ID: id, BinarySHA256: doctorNativeHash(binary), ServiceSHA256: doctorNativeHash(service), Version: []string{"0.1.0", "0.2.0"}[i]})
		manifest.Current = id
	}
	return paths, manifest
}

func doctorNativeWriteManifest(t *testing.T, paths installPaths, manifest installManifest) {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	doctorNativeWrite(t, filepath.Join(paths.Root, "manifest.json"), data, 0600)
}

func doctorNativeInspectUnchanged(t *testing.T, paths installPaths, want doctorInstallation, wantError string) {
	t.Helper()
	before := doctorNativeSnapshot(t, paths.Home)
	for range 2 {
		got, err := inspectDoctorInstallation(paths)
		doctorNativeError(t, err, wantError)
		if got != want {
			t.Fatalf("installation = %+v, want %+v", got, want)
		}
	}
	doctorNativeUnchanged(t, paths.Home, before)
	if _, err := os.Lstat(filepath.Join(paths.Root, "operation.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("status created operation.lock: %v", err)
	}
}

func TestDoctorNativeInstallationReadsCurrentGenerationWithoutChanges(t *testing.T) {
	paths, manifest := doctorNativeInstallFixture(t)
	doctorNativeWriteManifest(t, paths, manifest)
	doctorNativeInspectUnchanged(t, paths, doctorInstallation{Present: true, ConfigPath: paths.Config, Version: "0.2.0"}, "")
	if _, err := os.Lstat(paths.Config); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("configuration fixture should remain absent")
	}
	// A rename after the read also checks that the manifest handle was closed on Windows.
	path := filepath.Join(paths.Root, "manifest.json")
	if err := os.Rename(path, path+".closed"); err != nil {
		t.Fatalf("manifest remains held after status: %v", err)
	}
}

func TestDoctorNativeInstallationAbsentDoesNotCreateState(t *testing.T) {
	for _, missingRoot := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty root", true: "missing root"}[missingRoot], func(t *testing.T) {
			home := doctorNativePrivateDir(t)
			root := home
			if missingRoot {
				root = filepath.Join(home, "missing", "install")
			}
			doctorNativeInspectUnchanged(t, installPaths{Home: home, Root: root, Platform: runtime.GOOS}, doctorInstallation{}, "")
		})
	}
}

func TestDoctorNativeInstallationRejectsInvalidStateWithoutChanges(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		mutate     func(*testing.T, installPaths, *installManifest)
	}{
		{"invalid schema", "installation_manifest_invalid", func(_ *testing.T, _ installPaths, m *installManifest) { m.Schema++ }},
		{"unknown current", "installation_manifest_invalid", func(_ *testing.T, _ installPaths, m *installManifest) { m.Current = strings.Repeat("c", 24) }},
		{"duplicate generation", "installation_manifest_invalid", func(_ *testing.T, _ installPaths, m *installManifest) {
			m.Generations = append(m.Generations, m.Generations[0])
		}},
		{"relative config", "installation_manifest_invalid", func(_ *testing.T, _ installPaths, m *installManifest) { m.ConfigPath = "probe.json" }},
		{"modified binary", "installation_file_modified", func(_ *testing.T, _ installPaths, m *installManifest) {
			m.Generations[0].BinarySHA256 = strings.Repeat("0", 64)
		}},
		{"modified service", "installation_file_modified", func(_ *testing.T, _ installPaths, m *installManifest) {
			m.Generations[1].ServiceSHA256 = strings.Repeat("0", 64)
		}},
		{"unknown root file", "installation_unknown_files", func(t *testing.T, p installPaths, _ *installManifest) {
			doctorNativeWrite(t, filepath.Join(p.Root, "unknown.txt"), []byte("fixture"), 0600)
		}},
		{"unknown generation file", "installation_unknown_files", func(t *testing.T, p installPaths, m *installManifest) {
			doctorNativeWrite(t, filepath.Join(p.Root, m.Current, "unknown.txt"), []byte("fixture"), 0600)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			paths, manifest := doctorNativeInstallFixture(t)
			tc.mutate(t, paths, &manifest)
			doctorNativeWriteManifest(t, paths, manifest)
			doctorNativeInspectUnchanged(t, paths, doctorInstallation{}, tc.want)
		})
	}
}

func TestDoctorNativeInstallationRejectsMalformedManifestWithoutChanges(t *testing.T) {
	for _, scenario := range []string{"malformed", "trailing JSON", "unknown field"} {
		t.Run(scenario, func(t *testing.T) {
			paths, manifest := doctorNativeInstallFixture(t)
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "malformed":
				data = []byte("{")
			case "trailing JSON":
				data = append(data, []byte("{}")...)
			case "unknown field":
				data = append(data[:len(data)-1], []byte(`,"extra":true}`)...)
			}
			doctorNativeWrite(t, filepath.Join(paths.Root, "manifest.json"), data, 0600)
			doctorNativeInspectUnchanged(t, paths, doctorInstallation{}, "installation_manifest_invalid")
		})
	}
}
