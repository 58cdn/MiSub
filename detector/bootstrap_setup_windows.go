//go:build windows

package main

import (
	"errors"
	"path/filepath"
	"sync"
	"syscall"
)

func lockBootstrapSetupDirectory(path string) (func(), error) {
	dir, err := openWindowsDirectory(path, true, true)
	if err != nil {
		return nil, errors.New("setup_private_directory_required")
	}
	attrs, free, err := privateSecurityAttributes(false)
	if err != nil {
		dir.Close()
		return nil, err
	}
	defer free()
	name, _ := syscall.UTF16PtrFromString(filepath.Join(path, "setup.lock"))
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE|winReadControl, 0, attrs, syscall.OPEN_ALWAYS, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		dir.Close()
		return nil, errors.New("setup_in_progress_or_lock_unsafe")
	}
	var info syscall.ByHandleFileInformation
	if validatePrivateHandle(handle, false) != nil || syscall.GetFileInformationByHandle(handle, &info) != nil || info.NumberOfLinks != 1 {
		syscall.CloseHandle(handle)
		dir.Close()
		return nil, errors.New("setup_lock_unsafe")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = syscall.CloseHandle(handle)
			_ = dir.Close()
		})
	}, nil
}
