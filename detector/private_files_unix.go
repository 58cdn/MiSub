//go:build !windows

package main

import (
	"errors"
	"os"
)

func openPrivateConfig(path string) (*os.File, func(), error) {
	fail := func(message string) (*os.File, func(), error) { return nil, func() {}, errors.New(message) }
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return fail("config_unreadable_or_symlink")
	}
	if before.Mode().Perm()&0077 != 0 {
		return fail("config_permissions_require_0600")
	}
	file, err := os.Open(path)
	if err != nil {
		return fail("config_unreadable")
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) || !opened.Mode().IsRegular() || opened.Mode().Perm()&0077 != 0 {
		file.Close()
		return fail("config_unreadable_or_symlink")
	}
	return file, func() { _ = file.Close() }, nil
}

func createPrivateTempDir(parent, prefix string) (string, func(), error) {
	path, err := os.MkdirTemp(parent, prefix)
	if err != nil {
		return "", func() {}, err
	}
	return path, func() { _ = os.RemoveAll(path) }, nil
}

func writePrivateFile(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
