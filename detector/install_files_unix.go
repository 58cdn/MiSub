//go:build linux || darwin

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

const maxInstalledBinaryBytes = 256 * 1024 * 1024

type privateInstallationStore struct {
	paths installPaths
	root  *os.Root
	lock  *os.File
}

func currentInstallPaths(config string) (installPaths, error) {
	if os.Geteuid() == 0 {
		return installPaths{}, errors.New("installation_requires_regular_user")
	}
	home, err := os.UserHomeDir()
	if err != nil || !validInstallPath(home) {
		return installPaths{}, errors.New("installation_home_unavailable")
	}
	source, err := os.Executable()
	if err != nil {
		return installPaths{}, errors.New("installation_source_unavailable")
	}
	if config != "" && !validInstallPath(config) {
		return installPaths{}, errors.New("installation_config_requires_absolute_path")
	}
	return installPaths{Home: home, Root: filepath.Join(home, ".misub-probe", "install"), Source: source, Config: config, UID: os.Geteuid(), Platform: runtime.GOOS}, nil
}

func validInstallPath(path string) bool {
	return path != "" && filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsAny(path, "\x00\r\n")
}

func validInstallConfigPath(root, config string) bool {
	return validInstallPath(config) && config != root && !strings.HasPrefix(config, root+string(os.PathSeparator))
}

func openInstallRoot(path string, create bool) (*os.Root, error) {
	if !validInstallPath(path) {
		return nil, errors.New("installation_unsafe_path")
	}
	root, err := os.OpenRoot("/")
	if err != nil {
		return nil, errors.New("installation_directory_unavailable")
	}
	for _, part := range strings.Split(strings.Trim(path, "/"), "/") {
		if part == "" {
			root.Close()
			return nil, errors.New("installation_unsafe_path")
		}
		info, err := root.Lstat(part)
		if errors.Is(err, os.ErrNotExist) && create {
			if root.Mkdir(part, 0700) != nil {
				root.Close()
				return nil, errors.New("installation_directory_unavailable")
			}
			info, err = root.Lstat(part)
		}
		if errors.Is(err, os.ErrNotExist) {
			root.Close()
			return nil, os.ErrNotExist
		}
		if err != nil || !safePairingAncestor(info) {
			root.Close()
			return nil, errors.New("installation_unsafe_directory")
		}
		next, err := root.OpenRoot(part)
		if err != nil {
			root.Close()
			return nil, errors.New("installation_directory_unavailable")
		}
		opened, err := next.Stat(".")
		root.Close()
		root = next
		if err != nil || !os.SameFile(info, opened) || !safePairingAncestor(opened) {
			root.Close()
			return nil, errors.New("installation_directory_changed")
		}
	}
	info, err := root.Stat(".")
	if err != nil || !privatePairingDir(info) {
		root.Close()
		return nil, errors.New("installation_directory_requires_owner_0700")
	}
	return root, nil
}

func openInstallationStore(paths installPaths, action string) (installationStore, error) {
	root, err := openInstallRoot(paths.Root, action == "install")
	store := &privateInstallationStore{paths: paths, root: root}
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if action != "status" {
		info, err := root.Lstat("operation.lock")
		if err == nil && !privateInstallFile(info, 0600) {
			root.Close()
			return nil, errors.New("installation_lock_unsafe")
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			root.Close()
			return nil, errors.New("installation_lock_unavailable")
		}
		lock, err := root.OpenFile("operation.lock", os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			root.Close()
			return nil, errors.New("installation_lock_unavailable")
		}
		opened, err := lock.Stat()
		if err != nil || !privateInstallFile(opened, 0600) || (info != nil && !os.SameFile(info, opened)) {
			lock.Close()
			root.Close()
			return nil, errors.New("installation_lock_unsafe")
		}
		if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			lock.Close()
			root.Close()
			return nil, errors.New("installation_operation_in_progress")
		}
		store.lock = lock
	}
	return store, nil
}

func (s *privateInstallationStore) Close() error {
	if s.lock != nil {
		_ = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
		_ = s.lock.Close()
	}
	if s.root != nil {
		return s.root.Close()
	}
	return nil
}

func privateInstallFile(info os.FileInfo, mode os.FileMode) bool {
	owner, ok := pairingDirOwner(info)
	return ok && owner == uint32(os.Geteuid()) && info.Mode().IsRegular() && info.Mode().Perm() == mode
}

func (s *privateInstallationStore) checkRoot() error {
	if s.root == nil {
		return errors.New("installation_not_found")
	}
	current, err := openInstallRoot(s.paths.Root, false)
	if err != nil {
		return errors.New("installation_directory_changed")
	}
	defer current.Close()
	a, err := s.root.Stat(".")
	if err != nil {
		return errors.New("installation_directory_changed")
	}
	b, err := current.Stat(".")
	if err != nil || !os.SameFile(a, b) {
		return errors.New("installation_directory_changed")
	}
	return nil
}

func safeInstallRead(root *os.Root, name string, mode os.FileMode, limit int64) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !privateInstallFile(info, mode) || info.Size() > limit {
		return nil, errors.New("installation_file_unsafe")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, errors.New("installation_file_unavailable")
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) || !privateInstallFile(opened, mode) {
		return nil, errors.New("installation_file_changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("installation_file_unavailable")
	}
	return data, nil
}

func (s *privateInstallationStore) Load() (*installManifest, error) {
	if s.root == nil {
		return nil, nil
	}
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	data, err := safeInstallRead(s.root, "manifest.json", 0600, 32768)
	if errors.Is(err, os.ErrNotExist) {
		if err := s.checkEntries(nil, true); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("installation_manifest_unreadable")
	}
	var manifest installManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || decoder.Decode(new(any)) != io.EOF || s.validateManifest(&manifest) != nil {
		return nil, errors.New("installation_manifest_invalid")
	}
	return &manifest, nil
}

func (s *privateInstallationStore) validateManifest(m *installManifest) error {
	if m.Schema != installSchema || m.Platform != s.paths.Platform || !validInstallConfigPath(s.paths.Root, m.ConfigPath) || !installGenerationPattern.MatchString(m.Current) || len(m.Generations) < 1 || len(m.Generations) > maxInstallGenerations {
		return errors.New("installation_manifest_invalid")
	}
	seen := map[string]bool{}
	found := false
	for _, g := range m.Generations {
		if !installGenerationPattern.MatchString(g.ID) || !installHashPattern.MatchString(g.BinarySHA256) || !installHashPattern.MatchString(g.ServiceSHA256) || g.Version == "" || len(g.Version) > 100 || seen[g.ID] {
			return errors.New("installation_manifest_invalid")
		}
		seen[g.ID] = true
		if g.ID == m.Current {
			found = true
		}
	}
	if !found {
		return errors.New("installation_manifest_invalid")
	}
	return nil
}

func installReadDir(root *os.Root) ([]os.DirEntry, error) {
	f, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(64)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) >= 64 {
		return nil, errors.New("installation_unknown_files")
	}
	return entries, nil
}

func (s *privateInstallationStore) checkEntries(m *installManifest, allowMissing bool) error {
	if err := s.checkRoot(); err != nil {
		return err
	}
	allowed := map[string]bool{"operation.lock": true}
	if m != nil {
		allowed["manifest.json"] = true
		for _, g := range m.Generations {
			allowed[g.ID] = true
		}
	}
	entries, err := installReadDir(s.root)
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
	for _, g := range m.Generations {
		info, err := s.root.Lstat(g.ID)
		if errors.Is(err, os.ErrNotExist) && allowMissing {
			continue
		}
		if err != nil || !privatePairingDir(info) {
			return errors.New("installation_generation_unsafe")
		}
		dir, err := s.root.OpenRoot(g.ID)
		if err != nil {
			return errors.New("installation_generation_unsafe")
		}
		opened, err := dir.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			dir.Close()
			return errors.New("installation_generation_unsafe")
		}
		files, err := installReadDir(dir)
		if err != nil {
			dir.Close()
			return errors.New("installation_generation_unreadable")
		}
		for _, file := range files {
			if file.Name() != "misub-probe" && file.Name() != s.paths.serviceName() {
				dir.Close()
				return errors.New("installation_unknown_files")
			}
		}
		for name, expected := range map[string]string{"misub-probe": g.BinarySHA256, s.paths.serviceName(): g.ServiceSHA256} {
			mode := os.FileMode(0600)
			limit := int64(32768)
			if name == "misub-probe" {
				mode = 0700
				limit = maxInstalledBinaryBytes
			}
			data, err := safeInstallRead(dir, name, mode, limit)
			if errors.Is(err, os.ErrNotExist) && allowMissing {
				continue
			}
			if err != nil {
				dir.Close()
				return errors.New("installation_file_unsafe")
			}
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != expected {
				dir.Close()
				return errors.New("installation_file_modified")
			}
		}
		dir.Close()
	}
	return nil
}

func (s *privateInstallationStore) Verify(m *installManifest) error { return s.checkEntries(m, false) }
func (s *privateInstallationStore) VerifyRemoval(m *installManifest) error {
	return s.checkEntries(m, true)
}

func (s *privateInstallationStore) ConfigReady(path string) error {
	root, err := openInstallRoot(filepath.Dir(path), false)
	if err != nil {
		return errors.New("installation_config_unsafe_or_missing")
	}
	defer root.Close()
	data, err := safeInstallRead(root, filepath.Base(path), 0600, 16384)
	if err != nil {
		return errors.New("installation_config_unsafe_or_missing")
	}
	var config Config
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF || config.validate() != nil {
		return errors.New("installation_config_invalid")
	}
	return nil
}

func writeInstallFile(root *os.Root, name string, data []byte, mode os.FileMode) error {
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return errors.New("installation_file_create_failed")
	}
	written := false
	defer func() {
		if !written {
			_ = root.Remove(name)
		}
	}()
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("installation_file_write_failed")
	}
	written = true
	return nil
}

func installSyncDir(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (s *privateInstallationStore) Install(previous *installManifest, config string) (*installManifest, error) {
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
		config = filepath.Join(s.paths.Home, ".misub-probe", "probe.json")
	}
	if !validInstallPath(config) {
		return nil, errors.New("installation_config_requires_absolute_path")
	}
	if !validInstallConfigPath(s.paths.Root, config) {
		return nil, errors.New("installation_config_must_be_outside_install_tree")
	}
	if previous != nil && previous.ConfigPath != config {
		return nil, errors.New("reinstall_preserves_config_path")
	}
	info, err := os.Lstat(s.paths.Source)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0100 == 0 || info.Size() > maxInstalledBinaryBytes {
		return nil, errors.New("installation_source_unsafe")
	}
	owner, ok := pairingDirOwner(info)
	if !ok || (owner != 0 && owner != uint32(os.Geteuid())) {
		return nil, errors.New("installation_source_unsafe")
	}
	source, err := os.Open(s.paths.Source)
	if err != nil {
		return nil, errors.New("installation_source_unavailable")
	}
	defer source.Close()
	opened, err := source.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("installation_source_changed")
	}
	data, err := io.ReadAll(io.LimitReader(source, maxInstalledBinaryBytes+1))
	if err != nil || len(data) > maxInstalledBinaryBytes {
		return nil, errors.New("installation_source_unavailable")
	}
	after, err := source.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || int64(len(data)) != info.Size() {
		return nil, errors.New("installation_source_changed")
	}
	var random [12]byte
	if _, err = rand.Read(random[:]); err != nil {
		return nil, errors.New("installation_random_failed")
	}
	id := hex.EncodeToString(random[:])
	service, err := renderInstallService(s.paths, id, config)
	if err != nil {
		return nil, err
	}
	if s.root.Mkdir(id, 0700) != nil {
		return nil, errors.New("installation_generation_create_failed")
	}
	dir, err := s.root.OpenRoot(id)
	if err != nil {
		return nil, errors.New("installation_generation_create_failed")
	}
	defer dir.Close()
	published := false
	defer func() {
		if !published {
			_ = dir.Remove("misub-probe")
			_ = dir.Remove(s.paths.serviceName())
			_ = s.root.Remove(id)
		}
	}()
	if err = writeInstallFile(dir, "misub-probe", data, 0700); err != nil {
		return nil, err
	}
	if err = writeInstallFile(dir, s.paths.serviceName(), service, 0600); err != nil {
		return nil, err
	}
	if installSyncDir(dir) != nil {
		return nil, errors.New("installation_sync_failed")
	}
	binaryHash := sha256.Sum256(data)
	serviceHash := sha256.Sum256(service)
	manifest := &installManifest{Schema: installSchema, Platform: s.paths.Platform, ConfigPath: config, Current: id}
	if previous != nil {
		manifest.Generations = append(manifest.Generations, previous.Generations...)
	}
	manifest.Generations = append(manifest.Generations, installGeneration{ID: id, BinarySHA256: hex.EncodeToString(binaryHash[:]), ServiceSHA256: hex.EncodeToString(serviceHash[:]), Version: version})
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, errors.New("installation_manifest_invalid")
	}
	temp := "manifest-" + id + ".tmp"
	if err = writeInstallFile(s.root, temp, encoded, 0600); err != nil {
		return nil, err
	}
	defer s.root.Remove(temp)
	if err = s.checkRoot(); err != nil {
		return nil, err
	}
	if previous == nil {
		err = s.root.Link(temp, "manifest.json")
	} else {
		current, loadErr := s.Load()
		if loadErr != nil || current == nil || current.Current != previous.Current {
			return nil, errors.New("installation_manifest_changed")
		}
		err = s.root.Rename(temp, "manifest.json")
	}
	if err != nil {
		return nil, errors.New("installation_manifest_publish_failed")
	}
	published = true
	if err = s.root.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("installation_sync_failed_check_status")
	}
	if installSyncDir(s.root) != nil {
		return nil, errors.New("installation_sync_failed_check_status")
	}
	return manifest, nil
}

func (s *privateInstallationStore) Remove(m *installManifest) error {
	if s.lock == nil {
		return errors.New("installation_lock_required")
	}
	if err := s.checkEntries(m, true); err != nil {
		return err
	}
	for _, g := range m.Generations {
		dir, err := s.root.OpenRoot(g.ID)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return errors.New("installation_generation_unsafe")
		}
		for _, name := range []string{"misub-probe", s.paths.serviceName()} {
			if err = dir.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
				dir.Close()
				return errors.New("installation_remove_failed")
			}
		}
		dir.Close()
		if s.root.Remove(g.ID) != nil {
			return errors.New("installation_remove_failed")
		}
	}
	if s.root.Remove("manifest.json") != nil {
		return errors.New("installation_remove_failed")
	}
	if installSyncDir(s.root) != nil {
		return errors.New("installation_sync_failed_check_status")
	}
	return nil
}

func validateServiceExecutable(path string) error {
	if path != "/usr/bin/systemctl" && path != "/bin/launchctl" {
		return errors.New("service_manager_unavailable")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return errors.New("service_manager_unavailable")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		return errors.New("service_manager_unavailable")
	}
	owner, ok := pairingDirOwner(info)
	if !ok || owner != 0 {
		return errors.New("service_manager_unavailable")
	}
	return nil
}
