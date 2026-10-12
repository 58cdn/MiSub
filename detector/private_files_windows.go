//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// kernel32 is a Windows KnownDLL and the syscall package loads it from System32.
// All additional DLLs use the system directory returned by this trusted API.
var winKernel32 = syscall.NewLazyDLL("kernel32.dll")
var winGetSystemDirectory = winKernel32.NewProc("GetSystemDirectoryW")
var winAdvapi32 = syscall.NewLazyDLL(filepath.Join(windowsSystemDirectory(), "advapi32.dll"))
var winConvertStringSD = winAdvapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
var winConvertSDString = winAdvapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
var winGetSecurityInfo = winAdvapi32.NewProc("GetSecurityInfo")
var winGetSDControl = winAdvapi32.NewProc("GetSecurityDescriptorControl")
var winGetVolumeInformation = winKernel32.NewProc("GetVolumeInformationW")

const winReadControl = 0x00020000
const winFileReadAttributes = 0x80
const winDACLProtected = 0x1000

func windowsSystemDirectory() string {
	var buffer [32768]uint16
	n, _, _ := winGetSystemDirectory.Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if n == 0 || n >= uintptr(len(buffer)) {
		panic("windows_system_directory_unavailable")
	}
	return syscall.UTF16ToString(buffer[:n])
}

func windowsUserSID() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", errors.New("private_file_identity_unavailable")
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", errors.New("private_file_identity_unavailable")
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return "", errors.New("private_file_identity_unavailable")
	}
	return sid, nil
}

func privateSecurityAttributes(directory bool) (*syscall.SecurityAttributes, func(), error) {
	sid, err := windowsUserSID()
	if err != nil {
		return nil, func() {}, err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	text, err := syscall.UTF16PtrFromString("O:" + sid + "D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;" + sid + ")")
	if err != nil {
		return nil, func() {}, errors.New("private_file_acl_failed")
	}
	var descriptor uintptr
	ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return nil, func() {}, errors.New("private_file_acl_failed")
	}
	attrs := &syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	return attrs, func() { _, _ = syscall.LocalFree(syscall.Handle(descriptor)) }, nil
}

// Both DACLs use the OS renderer so a numeric SID and its Windows SDDL alias
// compare identically without interpreting variable-length ACE memory in Go.
func renderWindowsDACL(descriptor uintptr) (string, error) {
	var rendered *uint16
	var length uint32
	ok, _, _ := winConvertSDString.Call(descriptor, 1, 4, uintptr(unsafe.Pointer(&rendered)), uintptr(unsafe.Pointer(&length)))
	if ok == 0 || rendered == nil {
		return "", errors.New("private_file_acl_unreadable")
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(rendered))))
	if length == 0 || length > 65536 {
		return "", errors.New("private_file_acl_unreadable")
	}
	return syscall.UTF16ToString(unsafe.Slice(rendered, int(length))), nil
}

// sid comes from the current token; flags and rights are fixed object policies.
// Only these two exact grants, in either order, may match. No alias is trusted
// independently of the numeric identity supplied by the caller.
func matchesPrivateWindowsDACL(actual, sid, flags, rights string) bool {
	system := "(A;" + flags + ";" + rights + ";;;SY)"
	user := "(A;" + flags + ";" + rights + ";;;" + sid + ")"
	for _, expected := range []string{"D:P" + system + user, "D:P" + user + system} {
		text, err := syscall.UTF16PtrFromString(expected)
		if err != nil {
			return false
		}
		var descriptor uintptr
		ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
		if ok == 0 || descriptor == 0 {
			return false
		}
		canonical, err := renderWindowsDACL(descriptor)
		syscall.LocalFree(syscall.Handle(descriptor))
		if err != nil {
			return false
		}
		if actual == canonical {
			return true
		}
	}
	return false
}

// Accept only the exact private grants created above; null, inherited,
// conditional, broad and extra ACEs fail closed.
func validatePrivateHandle(handle syscall.Handle, directory bool) error {
	var info syscall.ByHandleFileInformation
	if syscall.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
		return errors.New("private_file_reparse_or_type")
	}
	kind, err := syscall.GetFileType(handle)
	if err != nil || kind != syscall.FILE_TYPE_DISK {
		return errors.New("private_file_type")
	}
	sid, err := windowsUserSID()
	if err != nil {
		return err
	}
	var owner *syscall.SID
	var descriptor uintptr
	// SE_FILE_OBJECT = 1; OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION = 5.
	result, _, _ := winGetSecurityInfo.Call(uintptr(handle), 1, 5, uintptr(unsafe.Pointer(&owner)), 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if result != 0 || descriptor == 0 {
		return errors.New("private_file_acl_unreadable")
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	if owner == nil {
		return errors.New("private_file_owner")
	}
	ownerText, err := owner.String()
	if err != nil || ownerText != sid {
		return errors.New("private_file_owner")
	}
	var control uint16
	var revision uint32
	ok, _, _ := winGetSDControl.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 || control&winDACLProtected == 0 {
		return errors.New("private_file_acl_not_protected")
	}
	text, err := renderWindowsDACL(descriptor)
	if err != nil {
		return err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	if !matchesPrivateWindowsDACL(text, sid, flags, "FA") {
		return errors.New("private_file_acl_not_private")
	}
	return nil
}

func validateWindowsPath(path string) error {
	if len(path) < 4 || len(path) > 240 || path[1] != ':' || path[2] != '\\' || (path[0] < 'A' || path[0] > 'Z') && (path[0] < 'a' || path[0] > 'z') || filepath.Clean(path) != path || strings.ContainsAny(path[2:], ":/\x00\r\n<>\"|?*") {
		return errors.New("private_file_requires_local_absolute_path")
	}
	for _, part := range strings.Split(path[3:], "\\") {
		if part == "" || strings.TrimRight(part, " .") != part {
			return errors.New("private_file_invalid_path")
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
			for _, digit := range []string{"¹", "²", "³"} {
				if base[3:] == digit {
					return errors.New("private_file_invalid_path")
				}
			}
		}
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" || len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
			return errors.New("private_file_invalid_path")
		}
	}
	return nil
}

type windowsPrivateDir struct {
	path    string
	root    *os.Root
	handles []syscall.Handle
	once    sync.Once
}

func (d *windowsPrivateDir) Close() error {
	d.once.Do(func() {
		if d.root != nil {
			_ = d.root.Close()
		}
		for i := len(d.handles) - 1; i >= 0; i-- {
			_ = syscall.CloseHandle(d.handles[i])
		}
	})
	return nil
}

func (d *windowsPrivateDir) validate() error {
	if len(d.handles) == 0 {
		return errors.New("private_directory_unavailable")
	}
	return validatePrivateHandle(d.handles[len(d.handles)-1], true)
}

// Pin every path component without FILE_SHARE_DELETE. Parent renames and junction
// substitution are blocked for the lease lifetime; each opened component is checked.
func openWindowsDirectory(path string, createLeaf, privateLeaf bool) (*windowsPrivateDir, error) {
	if err := validateWindowsPath(path); err != nil {
		return nil, err
	}
	volume, _ := syscall.UTF16PtrFromString(path[:3])
	var flags uint32
	ok, _, _ := winGetVolumeInformation.Call(uintptr(unsafe.Pointer(volume)), 0, 0, 0, 0, uintptr(unsafe.Pointer(&flags)), 0, 0)
	if ok == 0 || flags&8 == 0 {
		return nil, errors.New("private_file_requires_persistent_acls")
	}
	d := &windowsPrivateDir{path: path}
	fail := func() (*windowsPrivateDir, error) {
		d.Close()
		return nil, errors.New("private_directory_unsafe_or_unavailable")
	}
	parts := strings.Split(path[3:], "\\")
	current := path[:3]
	// Pin the volume root as well as every named component.
	for index := -1; index < len(parts); index++ {
		if index >= 0 {
			current = filepath.Join(current, parts[index])
		}
		name, _ := syscall.UTF16PtrFromString(current)
		if index == len(parts)-1 && createLeaf {
			attrs, free, err := privateSecurityAttributes(true)
			if err != nil {
				return fail()
			}
			err = syscall.CreateDirectory(name, attrs)
			free()
			if err != nil && err != syscall.ERROR_ALREADY_EXISTS {
				return fail()
			}
		}
		handle, err := syscall.CreateFile(name, winReadControl|winFileReadAttributes, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return fail()
		}
		d.handles = append(d.handles, handle)
		var info syscall.ByHandleFileInformation
		if syscall.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return fail()
		}
	}
	if privateLeaf && d.validate() != nil {
		return fail()
	}
	var err error
	d.root, err = os.OpenRoot(path)
	if err != nil {
		return fail()
	}
	return d, nil
}

func (d *windowsPrivateDir) createFile(name string) (*os.File, error) {
	if filepath.Base(name) != name || strings.ContainsAny(name, "\\/:") || name == "." || name == ".." {
		return nil, errors.New("private_file_invalid_name")
	}
	if err := d.validate(); err != nil {
		return nil, err
	}
	attrs, free, err := privateSecurityAttributes(false)
	if err != nil {
		return nil, err
	}
	defer free()
	path, err := syscall.UTF16PtrFromString(filepath.Join(d.path, name))
	if err != nil {
		return nil, errors.New("private_file_invalid_name")
	}
	handle, err := syscall.CreateFile(path, syscall.GENERIC_READ|syscall.GENERIC_WRITE|winReadControl, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_DELETE, attrs, syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, errors.New("private_file_create_failed")
	}
	file := os.NewFile(uintptr(handle), name)
	if validatePrivateHandle(handle, false) != nil {
		file.Close()
		return nil, errors.New("private_file_acl_failed")
	}
	return file, nil
}

func openPrivateConfig(path string) (*os.File, func(), error) {
	fail := func() (*os.File, func(), error) {
		return nil, func() {}, errors.New("config_requires_private_windows_acl")
	}
	if validateWindowsPath(path) != nil {
		return fail()
	}
	dir, err := openWindowsDirectory(filepath.Dir(path), false, true)
	if err != nil {
		return fail()
	}
	name, _ := syscall.UTF16PtrFromString(path)
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|winReadControl, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		dir.Close()
		return fail()
	}
	file := os.NewFile(uintptr(handle), filepath.Base(path))
	closeFile := func() { _ = file.Close(); _ = dir.Close() }
	if validatePrivateHandle(handle, false) != nil {
		closeFile()
		return fail()
	}
	return file, closeFile, nil
}

func createPrivateTempDir(parent, prefix string) (string, func(), error) {
	if parent == "" {
		parent = os.TempDir()
	}
	parentDir, err := openWindowsDirectory(parent, false, false)
	if err != nil {
		return "", func() {}, err
	}
	defer parentDir.Close()
	secret, err := newSecret()
	if err != nil {
		return "", func() {}, err
	}
	name := prefix + secret[:24]
	path := filepath.Join(parent, name)
	attrs, free, err := privateSecurityAttributes(true)
	if err != nil {
		return "", func() {}, err
	}
	wide, _ := syscall.UTF16PtrFromString(path)
	err = syscall.CreateDirectory(wide, attrs)
	free()
	if err != nil {
		return "", func() {}, errors.New("private_directory_create_failed")
	}
	dir, err := openWindowsDirectory(path, false, true)
	if err != nil {
		_ = os.Remove(path)
		return "", func() {}, err
	}
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			// Remove entries through the held root; never recursively follow a replaced path.
			if entries, err := dir.root.Open("."); err == nil {
				names, readErr := entries.Readdirnames(-1)
				entries.Close()
				if readErr == nil {
					for _, entry := range names {
						_ = dir.root.RemoveAll(entry)
					}
				}
			}
			dir.Close()
			// A replacement can only be removed if it is empty; this is not recursive.
			_ = os.Remove(path)
		})
	}
	return path, cleanup, nil
}

func writePrivateFile(path string, data []byte, _ os.FileMode) error {
	dir, err := openWindowsDirectory(filepath.Dir(path), false, true)
	if err != nil {
		return err
	}
	defer dir.Close()
	file, err := dir.createFile(filepath.Base(path))
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
