//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type windowsPairingConfig struct {
	dir    *windowsPrivateDir
	name   string
	mu     sync.Mutex
	closed bool
}

func preparePairingConfig(path string) (pairingConfigStore, error) {
	if validateWindowsPath(path) != nil {
		return nil, errors.New("pairing_config_requires_absolute_private_path")
	}
	dir, err := openWindowsDirectory(filepath.Dir(path), true, true)
	if err != nil {
		return nil, errors.New("pairing_config_requires_private_windows_directory")
	}
	store := &windowsPairingConfig{dir: dir, name: filepath.Base(path)}
	if err = store.preflight(); err != nil {
		store.Close()
		return nil, err
	}
	name, file, err := store.createTemp()
	if err != nil {
		store.Close()
		return nil, errors.New("pairing_config_not_writable")
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	linkName := name + ".check"
	linkErr := dir.root.Link(name, linkName)
	if linkErr == nil {
		linkErr = dir.root.Remove(linkName)
	}
	removeErr := dir.root.Remove(name)
	if syncErr != nil || closeErr != nil || linkErr != nil || removeErr != nil {
		store.Close()
		return nil, errors.New("pairing_config_not_writable")
	}
	return store, nil
}

func (s *windowsPairingConfig) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.dir.Close()
}
func (s *windowsPairingConfig) preflight() error {
	if s.dir.validate() != nil {
		return errors.New("pairing_config_requires_private_windows_directory")
	}
	if _, err := s.dir.root.Lstat(s.name); !errors.Is(err, os.ErrNotExist) {
		return errors.New("pairing_config_already_exists_or_unreadable")
	}
	return nil
}
func (s *windowsPairingConfig) createTemp() (string, *os.File, error) {
	secret, err := newSecret()
	if err != nil {
		return "", nil, err
	}
	name := ".pairing-" + secret[:32] + ".tmp"
	file, err := s.dir.createFile(name)
	return name, file, err
}
func (s *windowsPairingConfig) Save(config Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("pairing_config_closed")
	}
	if config.validate() != nil {
		return errors.New("pairing_config_invalid")
	}
	if err := s.preflight(); err != nil {
		return err
	}
	data, err := json.Marshal(config)
	if err != nil {
		return errors.New("pairing_config_invalid")
	}
	name, file, err := s.createTemp()
	if err != nil {
		return errors.New("pairing_config_write_failed")
	}
	defer s.dir.root.Remove(name)
	defer file.Close()
	if _, err = file.Write(append(data, '\n')); err != nil {
		return errors.New("pairing_config_write_failed")
	}
	if file.Sync() != nil || file.Close() != nil {
		return errors.New("pairing_config_write_failed")
	}
	if err = s.preflight(); err != nil {
		return err
	}
	// Windows Root.Link is handle-relative and never replaces an existing name.
	if s.dir.root.Link(name, s.name) != nil {
		return errors.New("pairing_config_publish_failed")
	}
	if s.dir.root.Remove(name) != nil {
		return errors.New("pairing_config_sync_failed")
	}
	return nil
}
