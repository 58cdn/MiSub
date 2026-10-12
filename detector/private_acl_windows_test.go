//go:build windows

package main

import (
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func fixtureWindowsDescriptor(t *testing.T, sddl string) uintptr {
	t.Helper()
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		t.Fatal("fixture descriptor text")
	}
	var descriptor uintptr
	ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 || descriptor == 0 {
		t.Fatal("fixture descriptor conversion")
	}
	t.Cleanup(func() { syscall.LocalFree(syscall.Handle(descriptor)) })
	return descriptor
}

func fixtureWindowsAliasSID(t *testing.T, alias string) string {
	t.Helper()
	descriptor := fixtureWindowsDescriptor(t, "O:"+alias+"D:P")
	var owner *syscall.SID
	var defaulted int32
	ok, _, _ := winAdvapi32.NewProc("GetSecurityDescriptorOwner").Call(descriptor, uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || owner == nil {
		t.Fatal("fixture owner unavailable")
	}
	sid, err := owner.String()
	if err != nil || !strings.HasPrefix(sid, "S-") {
		t.Fatal("fixture numeric identity unavailable")
	}
	return sid
}

func TestWindowsPrivateDACLCanonicalSIDIdentity(t *testing.T) {
	for _, alias := range []string{"LA", "SY"} {
		t.Run(alias, func(t *testing.T) {
			sid := fixtureWindowsAliasSID(t, alias)
			for _, flags := range []string{"", "OICI"} {
				input := "D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;" + sid + ")"
				actual, err := renderWindowsDACL(fixtureWindowsDescriptor(t, input))
				if err != nil || !matchesPrivateWindowsDACL(actual, sid, flags, "FA") {
					t.Fatal("equivalent numeric identity did not match OS-rendered DACL")
				}
				t.Logf("fixture alias=%s flags=%q rendered_alias=%t", alias, flags, strings.Contains(actual, ";;;"+alias+")"))
				for _, foreign := range []string{"S-1-5-21-11-22-33-500", "S-1-5-21-44-55-66-500"} {
					if matchesPrivateWindowsDACL(actual, foreign, flags, "FA") {
						t.Fatal("alias authorized an unrelated numeric identity")
					}
				}
			}
		})
	}
}

func TestWindowsPrivateDACLRejectsPolicyChanges(t *testing.T) {
	sid, err := windowsUserSID()
	if err != nil {
		t.Fatal(err)
	}
	system, user := "(A;;FA;;;SY)", "(A;;FA;;;"+sid+")"
	for _, valid := range []string{"D:P" + system + user, "D:P" + user + system} {
		actual, err := renderWindowsDACL(fixtureWindowsDescriptor(t, valid))
		if err != nil || !matchesPrivateWindowsDACL(actual, sid, "", "FA") {
			t.Fatal("exact current-user policy rejected")
		}
	}
	for name, invalid := range map[string]string{
		"everyone":          "D:P" + system + "(A;;FA;;;WD)",
		"administrators":    "D:P" + system + "(A;;FA;;;BA)",
		"extra-grant":       "D:P" + system + user + "(A;;FR;;;WD)",
		"duplicate-extra":   "D:P" + system + user + user,
		"missing-system":    "D:P" + user,
		"inherited-ace":     "D:P" + system + "(A;ID;FA;;;" + sid + ")",
		"inherit-only":      "D:P" + system + "(A;IO;FA;;;" + sid + ")",
		"wrong-mask":        "D:P" + system + "(A;;FR;;;" + sid + ")",
		"wrong-object-mask": "D:P" + system + "(A;;0x1f0003;;;" + sid + ")",
		"unprotected":       "D:" + system + user,
		"extra-control":     "D:PAI" + system + user,
		"null":              "D:NO_ACCESS_CONTROL",
		"empty":             "D:P",
	} {
		t.Run(name, func(t *testing.T) {
			actual, err := renderWindowsDACL(fixtureWindowsDescriptor(t, invalid))
			if err != nil {
				t.Fatal(err)
			}
			if matchesPrivateWindowsDACL(actual, sid, "", "FA") {
				t.Fatal("changed private DACL policy accepted")
			}
		})
	}
}

// Failure-only diagnostics inspect a new empty fixture object. No credentials,
// existing user ACLs, directory paths or complete numeric identities are logged.
func diagnoseWindowsPrivateFixture(t *testing.T, parent string) {
	t.Helper()
	if err := validateWindowsPath(parent); err != nil {
		t.Logf("fixture_acl stage=path error=%v", err)
		return
	}
	current := parent[:3]
	for index, part := range append([]string{""}, strings.Split(parent[3:], `\`)...) {
		current = filepath.Join(current, part)
		name, _ := syscall.UTF16PtrFromString(current)
		handle, err := syscall.CreateFile(name, winReadControl|winFileReadAttributes, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			t.Logf("fixture_acl stage=ancestor-open index=%d error=%v", index, err)
			return
		}
		var info syscall.ByHandleFileInformation
		infoErr := syscall.GetFileInformationByHandle(handle, &info)
		syscall.CloseHandle(handle)
		t.Logf("fixture_acl stage=ancestor-info index=%d attrs=%#x error=%v", index, info.FileAttributes, infoErr)
	}
	attrs, free, err := privateSecurityAttributes(true)
	if err != nil {
		t.Logf("fixture_acl stage=attributes error=%v", err)
		return
	}
	defer free()
	name, _ := syscall.UTF16PtrFromString(filepath.Join(parent, "acl-diagnostic"))
	if err = syscall.CreateDirectory(name, attrs); err != nil {
		t.Logf("fixture_acl stage=create error=%v", err)
		return
	}
	handle, err := syscall.CreateFile(name, winReadControl|winFileReadAttributes, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Logf("fixture_acl stage=open error=%v", err)
		return
	}
	defer syscall.CloseHandle(handle)
	t.Logf("fixture_acl stage=validate error=%v", validatePrivateHandle(handle, true))
	var owner *syscall.SID
	var descriptor uintptr
	result, _, _ := winGetSecurityInfo.Call(uintptr(handle), 1, 5, uintptr(unsafe.Pointer(&owner)), 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if result != 0 || descriptor == 0 {
		t.Logf("fixture_acl stage=security result=%d", result)
		return
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	sid, _ := windowsUserSID()
	ownerEqual := false
	if owner != nil {
		actualOwner, err := owner.String()
		ownerEqual = err == nil && actualOwner == sid
	}
	var control uint16
	var revision uint32
	ok, _, _ := winGetSDControl.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	text, renderErr := renderWindowsDACL(descriptor)
	text = regexp.MustCompile(`S-\d+(?:-\d+)+`).ReplaceAllString(text, "<numeric-sid>")
	t.Logf("fixture_acl stage=dacl owner_matches=%t control_ok=%t control=%#x dacl=%q error=%v", ownerEqual, ok != 0, control, text, renderErr)
}
