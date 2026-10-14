//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var doctorGetDriveType = winKernel32.NewProc("GetDriveTypeW")

func doctorValidateLocalPath(path string) error {
	if validateWindowsPath(path) != nil {
		return errors.New("doctor_local_path_required")
	}
	root, err := syscall.UTF16PtrFromString(path[:3])
	if err != nil {
		return errors.New("doctor_local_path_required")
	}
	driveType, _, _ := doctorGetDriveType.Call(uintptr(unsafe.Pointer(root)))
	// Fixed, removable, CD-ROM and RAM disks; reject remote and unknown drives.
	if driveType != 2 && driveType != 3 && driveType != 5 && driveType != 6 {
		return errors.New("doctor_local_path_required")
	}
	return nil
}

// Keep every ancestor pinned while existing readers inspect the leaf. This also
// protects their preliminary Lstat calls from traversing a replaced junction.
func doctorPinParents(target string) (func(), error) {
	if err := doctorValidateLocalPath(target); err != nil {
		return nil, err
	}
	directory := &windowsPrivateDir{}
	release := func() { _ = directory.Close() }
	parent := filepath.Dir(target)
	components := []string{target[:3]}
	current := target[:3]
	if len(parent) > 3 {
		for _, part := range strings.Split(parent[3:], `\`) {
			current = filepath.Join(current, part)
			components = append(components, current)
		}
	}
	for _, component := range components {
		name, _ := syscall.UTF16PtrFromString(component)
		handle, err := syscall.CreateFile(name, winReadControl|winFileReadAttributes|winFileListDirectory, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			release()
			if errors.Is(err, os.ErrNotExist) {
				return nil, os.ErrNotExist
			}
			return nil, errors.New("doctor_local_path_required")
		}
		directory.handles = append(directory.handles, handle)
		var info syscall.ByHandleFileInformation
		if syscall.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			release()
			return nil, errors.New("doctor_local_path_required")
		}
	}
	return release, nil
}
