//go:build windows

package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"unsafe"
)

func windowsFixtureDir(t *testing.T) string {
	t.Helper()
	parent := t.TempDir()
	dir, cleanup, err := createPrivateTempDir(parent, "private-")
	if err != nil {
		diagnoseWindowsPrivateFixture(t, parent)
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return dir
}
func windowsFixtureConfig() Config {
	return Config{Version: 1, Server: "https://misub.example", Token: fixturePairToken, PollSeconds: 60}
}

func TestWindowsPrivatePairingPublication(t *testing.T) {
	base := windowsFixtureDir(t)
	path := filepath.Join(base, "配置 with spaces", "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("preflight published credentials")
	}
	if err = store.Save(windowsFixtureConfig()); err != nil {
		t.Fatal(err)
	}
	config, err := readConfig(path)
	if err != nil || config.Token != fixturePairToken {
		t.Fatalf("private config not readable: %v", err)
	}
	if store.Save(windowsFixtureConfig()) == nil {
		t.Fatal("existing credentials replaced")
	}
	names, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(names) != 1 {
		t.Fatal("temporary config left behind")
	}
	if os.Rename(filepath.Dir(path), filepath.Dir(path)+"-moved") == nil {
		t.Fatal("pinned config directory renamed")
	}
}

func TestWindowsConcurrentPairingNeverClobbers(t *testing.T) {
	path := filepath.Join(windowsFixtureDir(t), "probe.json")
	const writers = 8
	stores := make([]pairingConfigStore, writers)
	for i := range stores {
		var err error
		stores[i], err = preparePairingConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		defer stores[i].Close()
	}
	var wg sync.WaitGroup
	type outcome struct {
		token string
		err   error
	}
	results := make(chan outcome, writers)
	for index, store := range stores {
		wg.Add(1)
		go func(s pairingConfigStore, index int) {
			defer wg.Done()
			config := windowsFixtureConfig()
			config.Token = "mp1_" + strings.Repeat(string(rune('0'+index)), 64)
			results <- outcome{config.Token, s.Save(config)}
		}(store, index)
	}
	wg.Wait()
	close(results)
	succeeded := 0
	winner := ""
	for result := range results {
		if result.err == nil {
			succeeded++
			winner = result.token
		}
	}
	if succeeded != 1 {
		t.Fatalf("publication winners=%d", succeeded)
	}
	if config, err := readConfig(path); err != nil || config.Token != winner {
		t.Fatal("final configuration does not belong to the sole successful writer")
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatal("writer left a temporary credential")
	}
}

func TestWindowsPairingRejectsDestinationCreatedAfterPreflight(t *testing.T) {
	for _, kind := range []string{"file", "junction"} {
		t.Run(kind, func(t *testing.T) {
			base := windowsFixtureDir(t)
			path := filepath.Join(base, "probe.json")
			store, err := preparePairingConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			if kind == "file" {
				if err = writePrivateFile(path, []byte("existing-fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				target := filepath.Join(base, "target")
				dir, err := openWindowsDirectory(target, true, true)
				if err != nil {
					t.Fatal(err)
				}
				dir.Close()
				createFixtureJunction(t, path, target)
			}
			if store.Save(windowsFixtureConfig()) == nil {
				t.Fatal("racing destination accepted")
			}
			if kind == "file" {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "existing-fixture" {
					t.Fatal("existing file changed")
				}
			} else {
				entries, err := os.ReadDir(filepath.Join(base, "target"))
				if err != nil || len(entries) != 0 {
					t.Fatal("credentials followed destination junction")
				}
			}
		})
	}
}

func TestWindowsPairingCloseAndSaveAreSerialized(t *testing.T) {
	path := filepath.Join(windowsFixtureDir(t), "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	saved := make(chan error, 1)
	closed := make(chan struct{})
	go func() { saved <- store.Save(windowsFixtureConfig()) }()
	go func() { store.Close(); close(closed) }()
	err = <-saved
	<-closed
	if err == nil {
		if _, readErr := readConfig(path); readErr != nil {
			t.Fatal("successful concurrent save is not readable")
		}
	} else if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatal("failed concurrent save published configuration")
	}
}

func setFixtureDACL(t *testing.T, path, dacl string) {
	t.Helper()
	text, _ := syscall.UTF16PtrFromString(dacl)
	var descriptor uintptr
	ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal("fixture descriptor failed")
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	name, _ := syscall.UTF16PtrFromString(path)
	ok, _, _ = winAdvapi32.NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 0x80000004, descriptor)
	if ok == 0 {
		t.Fatal("fixture ACL failed")
	}
}

func TestWindowsPrivateACLRejectsBroadNullAndChangedPermissions(t *testing.T) {
	for _, dacl := range []string{"D:P(A;;FA;;;WD)", "D:NO_ACCESS_CONTROL"} {
		t.Run(dacl, func(t *testing.T) {
			base := windowsFixtureDir(t)
			path := filepath.Join(base, "probe.json")
			data, _ := json.Marshal(windowsFixtureConfig())
			if err := writePrivateFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			setFixtureDACL(t, path, dacl)
			if _, err := readConfig(path); err == nil {
				t.Fatal("unsafe DACL accepted")
			}
		})
	}
	base := windowsFixtureDir(t)
	path := filepath.Join(base, "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	setFixtureDACL(t, base, "D:P(A;OICI;FA;;;WD)")
	if store.Save(windowsFixtureConfig()) == nil {
		t.Fatal("changed directory ACL accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("unsafe save published credentials")
	}
}

// Directory junction fixtures do not require Developer Mode or symlink privileges.
func createFixtureJunction(t *testing.T, path, target string) {
	t.Helper()
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	name, _ := syscall.UTF16PtrFromString(path)
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	substitute, _ := syscall.UTF16FromString("\\??\\" + target)
	printName, _ := syscall.UTF16FromString(target)
	data := make([]byte, 16+2*(len(substitute)+len(printName)))
	binary.LittleEndian.PutUint32(data, 0xa0000003)
	binary.LittleEndian.PutUint16(data[4:], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:], uint16(2*(len(substitute)-1)))
	binary.LittleEndian.PutUint16(data[12:], uint16(2*len(substitute)))
	binary.LittleEndian.PutUint16(data[14:], uint16(2*(len(printName)-1)))
	for i, v := range append(substitute, printName...) {
		binary.LittleEndian.PutUint16(data[16+2*i:], v)
	}
	var returned uint32
	if syscall.DeviceIoControl(handle, 0x900a4, &data[0], uint32(len(data)), nil, 0, &returned, nil) != nil {
		t.Fatal("fixture junction failed")
	}
}

func TestWindowsPrivatePathsRejectJunctionsAndAliases(t *testing.T) {
	base := windowsFixtureDir(t)
	target := filepath.Join(base, "target")
	dir, err := openWindowsDirectory(target, true, true)
	if err != nil {
		t.Fatal(err)
	}
	dir.Close()
	link := filepath.Join(base, "junction")
	createFixtureJunction(t, link, target)
	if store, err := preparePairingConfig(filepath.Join(link, "probe.json")); err == nil {
		store.Close()
		t.Fatal("junction accepted")
	}
	for _, path := range []string{"probe.json", `\\server\share\probe.json`, `\\?\C:\private\probe.json`, `C:\private\probe.json:token`, `C:\private\CON.json`, `C:\private\COM¹`, `C:\private\file.`, `C:\private\file `, `C:\private\..\probe.json`} {
		if validateWindowsPath(path) == nil {
			t.Fatalf("ambiguous path accepted: %q", path)
		}
	}
	path := filepath.Join(base, "probe.json")
	store, err := preparePairingConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	store.Close()
	if err = store.Save(windowsFixtureConfig()); err == nil || strings.Contains(err.Error(), base) {
		t.Fatal("closed store failed open or leaked path")
	}
}
