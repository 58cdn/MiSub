//go:build linux || darwin

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type privatePairingConfig struct {
	root *os.Root
	name string
}

func pairingDirOwner(info os.FileInfo) (uint32, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Uid, true
}

func safePairingAncestor(info os.FileInfo) bool {
	owner, ok := pairingDirOwner(info)
	if !ok || !info.IsDir() || (owner != 0 && owner != uint32(os.Geteuid())) {
		return false
	}
	return info.Mode().Perm()&0022 == 0 || (owner == 0 && info.Mode()&os.ModeSticky != 0)
}

func privatePairingDir(info os.FileInfo) bool {
	owner, ok := pairingDirOwner(info)
	return ok && owner == uint32(os.Geteuid()) && info.IsDir() && info.Mode().Perm() == 0700
}

func preparePairingConfig(path string) (pairingConfigStore, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.IndexByte(path, 0) >= 0 {
		return nil, errors.New("pairing_config_requires_absolute_private_path")
	}
	parent, name := filepath.Split(path)
	if name == "" || name == "." || name == ".." {
		return nil, errors.New("pairing_config_invalid_path")
	}
	parts := strings.Split(strings.Trim(parent, "/"), "/")
	root, err := os.OpenRoot("/")
	if err != nil {
		return nil, errors.New("pairing_config_directory_unavailable")
	}
	for i, part := range parts {
		if part == "" {
			root.Close()
			return nil, errors.New("pairing_config_requires_private_directory")
		}
		info, err := root.Lstat(part)
		if errors.Is(err, os.ErrNotExist) && i == len(parts)-1 {
			if root.Mkdir(part, 0700) != nil {
				root.Close()
				return nil, errors.New("pairing_config_directory_unavailable")
			}
			info, err = root.Lstat(part)
		}
		if err != nil || !safePairingAncestor(info) {
			root.Close()
			return nil, errors.New("pairing_config_unsafe_directory")
		}
		next, err := root.OpenRoot(part)
		if err != nil {
			root.Close()
			return nil, errors.New("pairing_config_directory_unavailable")
		}
		opened, err := next.Stat(".")
		root.Close()
		root = next
		if err != nil || !os.SameFile(info, opened) || !safePairingAncestor(opened) {
			root.Close()
			return nil, errors.New("pairing_config_directory_changed")
		}
	}
	store := &privatePairingConfig{root: root, name: name}
	if err := store.preflight(); err != nil {
		store.Close()
		return nil, err
	}
	// Verify write and sync support before requesting a server-side identity.
	temp, file, err := store.createTemp()
	if err != nil {
		store.Close()
		return nil, errors.New("pairing_config_not_writable")
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	removeErr := root.Remove(temp)
	if syncErr != nil || closeErr != nil || removeErr != nil || store.syncDir() != nil {
		store.Close()
		return nil, errors.New("pairing_config_not_writable")
	}
	return store, nil
}

func (s *privatePairingConfig) Close() error { return s.root.Close() }

func (s *privatePairingConfig) preflight() error {
	info, err := s.root.Stat(".")
	if err != nil || !privatePairingDir(info) {
		return errors.New("pairing_config_directory_requires_owner_0700")
	}
	_, err = s.root.Lstat(s.name)
	if !errors.Is(err, os.ErrNotExist) {
		return errors.New("pairing_config_already_exists_or_unreadable")
	}
	return nil
}

func (s *privatePairingConfig) createTemp() (string, *os.File, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", nil, err
	}
	name := ".pairing-" + hex.EncodeToString(value[:]) + ".tmp"
	f, err := s.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	return name, f, err
}

func (s *privatePairingConfig) syncDir() error {
	dir, err := s.root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (s *privatePairingConfig) Save(config Config) error {
	if err := config.validate(); err != nil {
		return errors.New("pairing_config_invalid")
	}
	if err := s.preflight(); err != nil {
		return err
	}
	data, err := json.Marshal(config)
	if err != nil {
		return errors.New("pairing_config_invalid")
	}
	temp, file, err := s.createTemp()
	if err != nil {
		return errors.New("pairing_config_write_failed")
	}
	defer s.root.Remove(temp)
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return errors.New("pairing_config_write_failed")
	}
	info, err := file.Stat()
	owner, ok := uint32(0), false
	if err == nil {
		owner, ok = pairingDirOwner(info)
	}
	if err != nil || !ok || owner != uint32(os.Geteuid()) || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || file.Sync() != nil || file.Close() != nil {
		return errors.New("pairing_config_write_failed")
	}
	if err := s.preflight(); err != nil {
		return err
	}
	// Link publishes the complete file atomically and fails if the destination exists.
	if s.root.Link(temp, s.name) != nil {
		return errors.New("pairing_config_publish_failed")
	}
	if s.root.Remove(temp) != nil || s.syncDir() != nil {
		return errors.New("pairing_config_sync_failed")
	}
	return nil
}
