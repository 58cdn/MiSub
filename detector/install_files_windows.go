//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const maxInstalledBinaryBytes = 256 * 1024 * 1024

type windowsInstallationStore struct {
	paths installPaths
	dir   *windowsPrivateDir
	lock  *os.File
}

type windowsServiceSpec struct {
	Schema int    `json:"schema"`
	Binary string `json:"binary"`
	Config string `json:"config"`
}

func currentInstallPaths(config string) (installPaths, error) {
	base, err := os.UserCacheDir()
	if err != nil || validateWindowsPath(base) != nil {
		return installPaths{}, errors.New("installation_home_unavailable")
	}
	exe, err := os.Executable()
	if err != nil || validateWindowsPath(exe) != nil {
		return installPaths{}, errors.New("installation_source_unavailable")
	}
	if config != "" && validateWindowsPath(config) != nil {
		return installPaths{}, errors.New("installation_config_requires_absolute_path")
	}
	// An elevated process would create an elevated detector. Require an ordinary token.
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return installPaths{}, errors.New("installation_identity_unavailable")
	}
	defer token.Close()
	var elevated, returned uint32
	if syscall.GetTokenInformation(token, 20, (*byte)(unsafe.Pointer(&elevated)), 4, &returned) != nil || elevated != 0 {
		return installPaths{}, errors.New("installation_requires_regular_user")
	}
	return installPaths{Home: base, Root: filepath.Join(base, "MiSubProbe", "install"), Source: exe, Config: config, Platform: "windows"}, nil
}

func validWindowsInstallConfig(root, config string) bool {
	root, config = strings.ToLower(root), strings.ToLower(config)
	return validateWindowsPath(config) == nil && config != root && !strings.HasPrefix(config, root+`\`)
}

func openInstallationStore(paths installPaths, action string) (installationStore, error) {
	s := &windowsInstallationStore{paths: paths}
	if action == "install" {
		parent, err := openWindowsDirectory(filepath.Dir(paths.Root), true, true)
		if err != nil {
			return nil, errors.New("installation_private_directory_required")
		}
		defer parent.Close()
	} else if _, err := os.Lstat(paths.Root); errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	dir, err := openWindowsDirectory(paths.Root, action == "install", true)
	if err != nil {
		return nil, errors.New("installation_private_directory_required")
	}
	s.dir = dir
	if action == "status" {
		return s, nil
	}
	attrs, free, err := privateSecurityAttributes(false)
	if err != nil {
		dir.Close()
		return nil, err
	}
	defer free()
	name, _ := syscall.UTF16PtrFromString(filepath.Join(paths.Root, "operation.lock"))
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE|winReadControl, 0, attrs, syscall.OPEN_ALWAYS, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		dir.Close()
		return nil, errors.New("installation_operation_in_progress_or_lock_unsafe")
	}
	s.lock = os.NewFile(uintptr(handle), "operation.lock")
	if validatePrivateHandle(handle, false) != nil {
		s.Close()
		return nil, errors.New("installation_lock_unsafe")
	}
	return s, nil
}

func (s *windowsInstallationStore) Close() error {
	if s.lock != nil {
		_ = s.lock.Close()
		s.lock = nil
	}
	if s.dir != nil {
		_ = s.dir.Close()
		s.dir = nil
	}
	return nil
}

func windowsInstallRead(path string, limit int64) ([]byte, error) {
	// Preserve absence separately; the private opener sanitizes other failures.
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil, os.ErrNotExist
	}
	f, closeFile, err := openPrivateConfig(path)
	if err != nil {
		return nil, errors.New("installation_file_unsafe")
	}
	defer closeFile()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("installation_file_unreadable")
	}
	return data, nil
}

func decodeInstallJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(destination) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("installation_metadata_invalid")
	}
	return nil
}

func (s *windowsInstallationStore) validateManifest(m *installManifest) error {
	if m.Schema != installSchema || m.Platform != "windows" || !validWindowsInstallConfig(s.paths.Root, m.ConfigPath) || !installGenerationPattern.MatchString(m.Current) || len(m.Generations) < 1 || len(m.Generations) > maxInstallGenerations {
		return errors.New("installation_manifest_invalid")
	}
	seen, found := map[string]bool{}, false
	for _, g := range m.Generations {
		if !installGenerationPattern.MatchString(g.ID) || !installHashPattern.MatchString(g.BinarySHA256) || !installHashPattern.MatchString(g.ServiceSHA256) || g.Version == "" || len(g.Version) > 100 || seen[g.ID] {
			return errors.New("installation_manifest_invalid")
		}
		seen[g.ID] = true
		found = found || m.Current == g.ID
	}
	if !found {
		return errors.New("installation_manifest_invalid")
	}
	return nil
}

func (s *windowsInstallationStore) Load() (*installManifest, error) {
	if s.dir == nil {
		return nil, nil
	}
	if s.dir.validate() != nil {
		return nil, errors.New("installation_private_directory_required")
	}
	data, err := windowsInstallRead(filepath.Join(s.paths.Root, "manifest.json"), 32768)
	if errors.Is(err, os.ErrNotExist) {
		return nil, s.checkEntries(nil, true)
	}
	if err != nil {
		return nil, err
	}
	var manifest installManifest
	if decodeInstallJSON(data, &manifest) != nil || s.validateManifest(&manifest) != nil {
		return nil, errors.New("installation_manifest_invalid")
	}
	return &manifest, nil
}

func (s *windowsInstallationStore) checkEntries(m *installManifest, missing bool) error {
	if s.dir == nil || s.dir.validate() != nil {
		return errors.New("installation_private_directory_required")
	}
	allowed := map[string]bool{"operation.lock": true}
	if m != nil {
		if s.validateManifest(m) != nil {
			return errors.New("installation_manifest_invalid")
		}
		allowed["manifest.json"], allowed["runtime.json"] = true, true
		for _, g := range m.Generations {
			allowed[g.ID] = true
		}
	}
	entries, err := os.ReadDir(s.paths.Root)
	if err != nil {
		return errors.New("installation_directory_unavailable")
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return errors.New("installation_unknown_files")
		}
	}
	if m == nil {
		return nil
	}
	if _, err := s.loadRuntime(); err != nil {
		return err
	}
	for _, g := range m.Generations {
		path := filepath.Join(s.paths.Root, g.ID)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) && missing {
			continue
		}
		dir, err := openWindowsDirectory(path, false, true)
		if err != nil {
			return errors.New("installation_generation_unsafe")
		}
		files, readErr := os.ReadDir(path)
		if readErr != nil {
			dir.Close()
			return errors.New("installation_generation_unreadable")
		}
		for _, file := range files {
			if file.Name() != "misub-probe.exe" && file.Name() != s.paths.serviceName() {
				dir.Close()
				return errors.New("installation_unknown_files")
			}
		}
		for name, hash := range map[string]string{"misub-probe.exe": g.BinarySHA256, s.paths.serviceName(): g.ServiceSHA256} {
			limit := int64(32768)
			if name == "misub-probe.exe" {
				limit = maxInstalledBinaryBytes
			}
			data, err := windowsInstallRead(filepath.Join(path, name), limit)
			if errors.Is(err, os.ErrNotExist) && missing {
				continue
			}
			if err != nil {
				dir.Close()
				return err
			}
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != hash {
				dir.Close()
				return errors.New("installation_file_modified")
			}
		}
		dir.Close()
	}
	return nil
}

func (s *windowsInstallationStore) Verify(m *installManifest) error { return s.checkEntries(m, false) }
func (s *windowsInstallationStore) VerifyRemoval(m *installManifest) error {
	if err := s.checkEntries(m, true); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return errors.New("installation_running_executable_unavailable")
	}
	running, err := os.Stat(executable)
	if err != nil {
		return errors.New("installation_running_executable_unavailable")
	}
	for _, generation := range m.Generations {
		if file, err := os.Stat(s.paths.binary(generation.ID)); err == nil && os.SameFile(running, file) {
			return errors.New("installation_uninstall_requires_another_trusted_executable")
		}
	}
	return nil
}
func (s *windowsInstallationStore) ConfigReady(path string) error {
	if _, err := readConfig(path); err != nil {
		return errors.New("installation_config_unsafe_or_invalid")
	}
	return nil
}

func writeWindowsInstallFile(dir *windowsPrivateDir, name string, data []byte) error {
	file, err := dir.createFile(name)
	if err != nil {
		return errors.New("installation_file_create_failed")
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err != nil || closed != nil {
		_ = dir.root.Remove(name)
		return errors.New("installation_file_write_failed")
	}
	return nil
}

func (s *windowsInstallationStore) Install(previous *installManifest, config string) (*installManifest, error) {
	if s.lock == nil {
		return nil, errors.New("installation_lock_required")
	}
	if err := s.checkEntries(previous, false); err != nil {
		return nil, err
	}
	if previous != nil && len(previous.Generations) >= maxInstallGenerations {
		return nil, errors.New("installation_version_limit_uninstall_first_config_is_preserved")
	}
	if config == "" {
		config = filepath.Join(filepath.Dir(s.paths.Root), "probe.json")
	}
	if !validWindowsInstallConfig(s.paths.Root, config) {
		return nil, errors.New("installation_config_requires_private_path_outside_install_tree")
	}
	if previous != nil && previous.ConfigPath != config {
		return nil, errors.New("reinstall_preserves_config_path")
	}
	// The invoking executable is explicit user input, not a downloaded update.
	// Hold a non-write-sharing file handle while copying it.
	parent, err := openWindowsDirectory(filepath.Dir(s.paths.Source), false, false)
	if err != nil {
		return nil, errors.New("installation_source_unsafe")
	}
	defer parent.Close()
	wide, _ := syscall.UTF16PtrFromString(s.paths.Source)
	handle, err := syscall.CreateFile(wide, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, errors.New("installation_source_unavailable")
	}
	source := os.NewFile(uintptr(handle), "installation-source")
	defer source.Close()
	var info syscall.ByHandleFileInformation
	if syscall.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return nil, errors.New("installation_source_unsafe")
	}
	data, err := io.ReadAll(io.LimitReader(source, maxInstalledBinaryBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxInstalledBinaryBytes {
		return nil, errors.New("installation_source_unavailable")
	}
	id, err := newSecret()
	if err != nil {
		return nil, errors.New("installation_random_failed")
	}
	id = id[:24]
	service, _ := json.Marshal(windowsServiceSpec{Schema: 1, Binary: s.paths.binary(id), Config: config})
	path := filepath.Join(s.paths.Root, id)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("installation_generation_conflict")
	}
	dir, err := openWindowsDirectory(path, true, true)
	if err != nil {
		return nil, errors.New("installation_generation_create_failed")
	}
	published := false
	defer func() {
		if !published {
			_ = dir.root.Remove("misub-probe.exe")
			_ = dir.root.Remove(s.paths.serviceName())
		}
		dir.Close()
		if !published {
			_ = s.dir.root.Remove(id)
		}
	}()
	if err = writeWindowsInstallFile(dir, "misub-probe.exe", data); err != nil {
		return nil, err
	}
	if err = writeWindowsInstallFile(dir, s.paths.serviceName(), service); err != nil {
		return nil, err
	}
	binaryHash, serviceHash := sha256.Sum256(data), sha256.Sum256(service)
	manifest := &installManifest{Schema: installSchema, Platform: "windows", ConfigPath: config, Current: id}
	if previous != nil {
		manifest.Generations = append(manifest.Generations, previous.Generations...)
	}
	manifest.Generations = append(manifest.Generations, installGeneration{ID: id, BinarySHA256: hex.EncodeToString(binaryHash[:]), ServiceSHA256: hex.EncodeToString(serviceHash[:]), Version: version})
	encoded, _ := json.Marshal(manifest)
	temp := "manifest-" + id + ".tmp"
	if err = writeWindowsInstallFile(s.dir, temp, encoded); err != nil {
		return nil, err
	}
	defer s.dir.root.Remove(temp)
	if previous == nil {
		err = s.dir.root.Link(temp, "manifest.json")
	} else {
		current, loadErr := s.Load()
		if loadErr != nil || current == nil || current.Current != previous.Current {
			return nil, errors.New("installation_manifest_changed")
		}
		err = s.dir.root.Rename(temp, "manifest.json")
	}
	if err != nil {
		return nil, errors.New("installation_manifest_publish_failed")
	}
	published = true
	if err := s.dir.root.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("installation_publish_uncertain_check_status")
	}
	return manifest, nil
}

func (s *windowsInstallationStore) Remove(m *installManifest) error {
	if s.lock == nil {
		return errors.New("installation_lock_required")
	}
	if err := s.VerifyRemoval(m); err != nil {
		return err
	}
	if record, err := s.loadRuntime(); err != nil || record != nil {
		return errors.New("installation_runtime_must_be_cleared")
	}
	for _, g := range m.Generations {
		path := filepath.Join(s.paths.Root, g.ID)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			continue
		}
		dir, err := openWindowsDirectory(path, false, true)
		if err != nil {
			return errors.New("installation_generation_unsafe")
		}
		for _, name := range []string{"misub-probe.exe", s.paths.serviceName()} {
			if err = dir.root.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
				dir.Close()
				return errors.New("installation_remove_failed")
			}
		}
		dir.Close()
		if s.dir.root.Remove(g.ID) != nil {
			return errors.New("installation_remove_failed")
		}
	}
	if s.dir.root.Remove("manifest.json") != nil {
		return errors.New("installation_remove_failed")
	}
	return nil
}

func validateServiceExecutable(string) error { return errors.New("service_manager_unavailable") }
