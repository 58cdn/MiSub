//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"sync"
	"syscall"
)

func privateBootstrapLockFile(info os.FileInfo) bool {
	if info == nil || !privateInstallFile(info, 0600) {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}

func lockBootstrapSetupDirectory(path string) (func(), error) {
	root, err := openInstallRoot(path, true)
	if err != nil {
		return nil, errors.New("setup_private_directory_required")
	}
	before, err := root.Lstat("setup.lock")
	if err == nil && !privateBootstrapLockFile(before) || err != nil && !errors.Is(err, os.ErrNotExist) {
		root.Close()
		return nil, errors.New("setup_lock_unsafe")
	}
	file, err := root.OpenFile("setup.lock", os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		root.Close()
		return nil, errors.New("setup_lock_unavailable")
	}
	fail := func(code string) (func(), error) {
		file.Close()
		root.Close()
		return nil, errors.New(code)
	}
	opened, err := file.Stat()
	if err != nil || !privateBootstrapLockFile(opened) || before != nil && !os.SameFile(before, opened) {
		return fail("setup_lock_unsafe")
	}
	linked, err := root.Lstat("setup.lock")
	if err != nil || !privateBootstrapLockFile(linked) || !os.SameFile(opened, linked) {
		return fail("setup_lock_unsafe")
	}
	if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return fail("setup_in_progress")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			_ = file.Close()
			_ = root.Close()
		})
	}, nil
}
