//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func windowsInstallationFixture(t *testing.T) (installPaths, *windowsInstallationStore) {
	t.Helper()
	base := windowsFixtureDir(t)
	source := filepath.Join(base, "source.exe")
	if err := writePrivateFile(source, []byte("fixture program, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	paths := installPaths{Home: base, Root: filepath.Join(base, "MiSubProbe", "install"), Source: source, Config: filepath.Join(base, "MiSubProbe", "probe.json"), Platform: "windows"}
	files, err := openInstallationStore(paths, "install")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { files.Close() })
	return paths, files.(*windowsInstallationStore)
}

type fakeWindowsProcesses struct {
	starts, stops int
	running       bool
	fail          error
}

func (f *fakeWindowsProcesses) Alive(windowsRuntimeRecord) (bool, error) { return f.running, f.fail }
func (f *fakeWindowsProcesses) Start(_ context.Context, _ installPaths, s windowsServiceSpec, id string, publish func(windowsRuntimeRecord) error) error {
	f.starts++
	if f.fail != nil {
		return f.fail
	}
	sid, _ := windowsUserSID()
	if err := publish(windowsRuntimeRecord{Schema: 1, Instance: id, PID: 123, Created: 456, Image: s.Binary, SID: sid}); err != nil {
		return err
	}
	f.running = true
	return nil
}
func (f *fakeWindowsProcesses) Stop(context.Context, windowsRuntimeRecord) error {
	f.stops++
	if f.fail != nil {
		return f.fail
	}
	f.running = false
	return nil
}

func TestWindowsInstallationPrivateLifecycleUsesFakeProcesses(t *testing.T) {
	paths, store := windowsInstallationFixture(t)
	process := &fakeWindowsProcesses{}
	manager := installManager{paths: paths, files: store, service: &windowsManagedService{store: store, process: process}}
	status, err := manager.execute(context.Background(), "install")
	if err != nil || !status.Installed || status.ExecutablePath == "" || process.starts != 0 {
		t.Fatalf("install: %v", err)
	}
	first, _ := store.Load()
	for _, path := range []string{paths.binary(first.Current), paths.service(first.Current), filepath.Join(paths.Root, "manifest.json")} {
		file, closeFile, err := openPrivateConfig(path)
		if err != nil || file == nil {
			t.Fatal("installation ACL not private")
		}
		closeFile()
	}
	if _, err := os.Stat(paths.Config); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("install created credentials")
	}
	if _, err := manager.execute(context.Background(), "start"); err == nil || process.starts != 0 {
		t.Fatal("unpaired install started")
	}
	config, _ := json.Marshal(windowsFixtureConfig())
	if err := writePrivateFile(paths.Config, config, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.execute(context.Background(), "start"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.execute(context.Background(), "start"); err != nil || process.starts != 1 {
		t.Fatal("second start created another process")
	}
	for _, action := range []string{"reinstall", "uninstall"} {
		if _, err := manager.execute(context.Background(), action); err == nil {
			t.Fatal("running process installation changed")
		}
	}
	if _, err := manager.execute(context.Background(), "stop"); err != nil || process.stops != 1 {
		t.Fatal("fake stop failed")
	}
	// Reinstall from the currently installed file retains the old generation.
	store.paths.Source = paths.binary(first.Current)
	if _, err := manager.execute(context.Background(), "reinstall"); err != nil {
		t.Fatal(err)
	}
	second, _ := store.Load()
	if second.Current == first.Current || len(second.Generations) != 2 || second.ConfigPath != paths.Config {
		t.Fatal("reinstall did not preserve config and prior generation")
	}
	if _, err := os.Stat(paths.binary(first.Current)); err != nil {
		t.Fatal("reinstall removed source generation")
	}
	if _, err := manager.execute(context.Background(), "uninstall"); err != nil {
		t.Fatal(err)
	}
	if data, err := windowsInstallRead(paths.Config, 16384); err != nil || string(data) != string(config) {
		t.Fatal("uninstall changed config")
	}
	entries, _ := os.ReadDir(paths.Root)
	if len(entries) != 1 || entries[0].Name() != "operation.lock" {
		t.Fatal("uninstall left owned files")
	}
}

func TestWindowsInstallationRefusesUnknownFilesConfigAliasesAndConcurrentMutations(t *testing.T) {
	paths, store := windowsInstallationFixture(t)
	if second, err := openInstallationStore(paths, "start"); err == nil {
		second.Close()
		t.Fatal("concurrent lock accepted")
	}
	for _, path := range []string{paths.Root, filepath.Join(paths.Root, "probe.json"), strings.ToUpper(filepath.Join(paths.Root, "probe.json"))} {
		if _, err := store.Install(nil, path); err == nil {
			t.Fatal("config inside managed tree accepted")
		}
	}
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(paths.Root, "user-note")
	if err := writePrivateFile(unknown, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if store.Verify(manifest) == nil || store.Remove(manifest) == nil {
		t.Fatal("unknown file accepted")
	}
	if data, err := os.ReadFile(unknown); err != nil || string(data) != "preserve" {
		t.Fatal("unknown file removed")
	}
}

func TestWindowsInstallationRejectsChangedACLJunctionAndContent(t *testing.T) {
	for _, scenario := range []string{"acl", "junction", "binary", "manifest-traversal"} {
		t.Run(scenario, func(t *testing.T) {
			paths, store := windowsInstallationFixture(t)
			manifest, err := store.Install(nil, paths.Config)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "acl":
				setFixtureDACL(t, paths.binary(manifest.Current), "D:P(A;;FA;;;WD)")
			case "binary":
				if err := os.WriteFile(paths.binary(manifest.Current), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "junction":
				original := filepath.Join(paths.Root, manifest.Current)
				moved := filepath.Join(paths.Home, "moved-generation")
				if err := os.Rename(original, moved); err != nil {
					t.Fatal(err)
				}
				createFixtureJunction(t, original, moved)
			case "manifest-traversal":
				manifest.Current, manifest.Generations[0].ID = `..\outside`, `..\outside`
				data, _ := json.Marshal(manifest)
				if err := os.WriteFile(filepath.Join(paths.Root, "manifest.json"), data, 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := store.Load(); err == nil {
					t.Fatal("traversal manifest loaded")
				}
			}
			if store.Verify(manifest) == nil || store.Remove(manifest) == nil {
				t.Fatal("changed file accepted or removed")
			}
		})
	}
}

func TestWindowsInstallationPrivateEventsRejectExistingOrBroadACL(t *testing.T) {
	id, _ := newSecret()
	id = id[:32]
	handle, err := createWindowsEvent(id, "stop")
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	if next, err := createWindowsEvent(id, "stop"); err == nil {
		syscall.CloseHandle(next)
		t.Fatal("existing event accepted")
	}
	opened, err := openWindowsEvent(id, "stop")
	if err != nil {
		t.Fatal(err)
	}
	syscall.CloseHandle(opened)
	text, _ := syscall.UTF16PtrFromString("D:P(A;;0x1f0003;;;WD)")
	var descriptor uintptr
	if ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0); ok == 0 {
		t.Fatal("fixture descriptor failed")
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	setSecurity := winAdvapi32.NewProc("SetKernelObjectSecurity")
	if ok, _, _ := setSecurity.Call(uintptr(handle), 0x80000004, descriptor); ok == 0 {
		t.Fatal("fixture event ACL setup failed")
	}
	if next, err := openWindowsEvent(id, "stop"); err == nil {
		syscall.CloseHandle(next)
		t.Fatal("broad event ACL accepted")
	}
}

func TestWindowsInstallationChild(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == "--" {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	args := os.Args[index+1:]
	if len(args) != 1 && len(args) != 2 && len(args) != 4 {
		os.Exit(61)
	}
	if len(args) == 2 && args[1] == "no-ready" {
		time.Sleep(15 * time.Second)
		return
	}
	if os.Getenv("HTTP_PROXY") != "" || os.Getenv("MANAGED_TEST_SECRET") != "" {
		os.Exit(62)
	}
	if window, _, _ := winKernel32.NewProc("GetConsoleWindow").Call(); window != 0 {
		os.Exit(63)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if len(args) == 4 {
		paths := installPaths{Home: args[1], Root: args[2], Platform: "windows"}
		store, err := openInstallationStore(paths, "status")
		if err != nil {
			os.Exit(65)
		}
		manifest, err := store.Load()
		if err != nil || manifest == nil {
			os.Exit(66)
		}
		err = store.VerifyRemoval(manifest)
		store.Close()
		if err == nil || err.Error() != "installation_uninstall_requires_another_trusted_executable" {
			os.Exit(67)
		}
		if writePrivateFile(args[3], []byte("uninstall-blocked-before-delete"), 0600) != nil {
			os.Exit(68)
		}
	}
	if windowsManagedEventLoop(ctx, args[0], func(ctx context.Context) error {
		if len(args) == 2 && args[1] == "nested-core" {
			exe, _ := os.Executable()
			marker := filepath.Join(os.TempDir(), "nested-"+args[0]+".pid")
			wait, err := startCoreProcess(ctx, exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "grandchild", marker}, os.TempDir())
			if err != nil {
				return err
			}
			err = wait()
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		<-ctx.Done()
		return nil
	}) != nil {
		os.Exit(64)
	}
}

func TestWindowsInstallationNativeHiddenProcessIdentityAndStop(t *testing.T) {
	paths, _ := windowsInstallationFixture(t)
	copyWindowsInstallationTestExecutable(t, paths.Source)
	spec := windowsServiceSpec{Schema: 1, Binary: paths.Source, Config: paths.Config}
	id, _ := newSecret()
	id = id[:32]
	t.Setenv("HTTP_PROXY", "http://fixture.invalid")
	t.Setenv("MANAGED_TEST_SECRET", "must-not-inherit")
	var record windowsRuntimeRecord
	err := startWindowsManagedProcess(context.Background(), paths, spec, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id}, func(value windowsRuntimeRecord) error { record = value; return nil })
	if err != nil {
		t.Fatal(err)
	}
	controller := nativeWindowsProcessController{}
	t.Cleanup(func() { _ = controller.Stop(context.Background(), record) })
	if alive, err := controller.Alive(record); err != nil || !alive {
		t.Fatal("fixture process not running")
	}
	reused := record
	reused.Created++
	if err := controller.Stop(context.Background(), reused); err != nil {
		t.Fatal(err)
	}
	if alive, _ := controller.Alive(record); !alive {
		t.Fatal("PID reuse check stopped live process")
	}
	for _, field := range []string{"image", "sid"} {
		bad := record
		if field == "image" {
			bad.Image = filepath.Join(paths.Home, "wrong.exe")
		} else {
			bad.SID = "S-1-5-18"
		}
		if err := controller.Stop(context.Background(), bad); err == nil {
			t.Fatal("identity mismatch accepted")
		}
		if alive, _ := controller.Alive(record); !alive {
			t.Fatal("identity mismatch stopped process")
		}
	}
	if err := controller.Stop(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if alive, _ := controller.Alive(record); alive {
		t.Fatal("stopped process alive")
	}
}

func TestWindowsInstallationPublishFailureNeverResumesProcess(t *testing.T) {
	paths, _ := windowsInstallationFixture(t)
	copyWindowsInstallationTestExecutable(t, paths.Source)
	id, _ := newSecret()
	id = id[:32]
	var record windowsRuntimeRecord
	err := startWindowsManagedProcess(context.Background(), paths, windowsServiceSpec{Binary: paths.Source}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id}, func(value windowsRuntimeRecord) error {
		record = value
		return errors.New("installation_fixture_write_failed")
	})
	if err == nil || record.PID == 0 {
		t.Fatal("publication failure accepted")
	}
	if alive, err := (nativeWindowsProcessController{}).Alive(record); err != nil || alive {
		t.Fatal("failed publication left process alive")
	}
}

func copyWindowsInstallationTestExecutable(t *testing.T, path string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(executable)
	if err != nil || os.WriteFile(path, data, 0600) != nil {
		t.Fatal("copy compiled fixture executable failed")
	}
}

func TestWindowsInstallationReadyCancellationLeavesNoProcess(t *testing.T) {
	paths, _ := windowsInstallationFixture(t)
	copyWindowsInstallationTestExecutable(t, paths.Source)
	id, _ := newSecret()
	id = id[:32]
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	var record windowsRuntimeRecord
	err := startWindowsManagedProcess(ctx, paths, windowsServiceSpec{Binary: paths.Source}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id, "no-ready"}, func(value windowsRuntimeRecord) error { record = value; return nil })
	if err == nil || record.PID == 0 {
		t.Fatal("unready process accepted")
	}
	if alive, err := (nativeWindowsProcessController{}).Alive(record); err != nil || alive {
		t.Fatal("cancelled start left process alive")
	}
	if strings.Contains(err.Error(), paths.Source) {
		t.Fatal("start failure disclosed path")
	}
}

func TestWindowsInstallationSelfUninstallRefusesBeforeDeletion(t *testing.T) {
	paths, store := windowsInstallationFixture(t)
	copyWindowsInstallationTestExecutable(t, paths.Source)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := newSecret()
	id = id[:32]
	marker := filepath.Join(paths.Home, "preflight.txt")
	var record windowsRuntimeRecord
	err = startWindowsManagedProcess(context.Background(), paths, windowsServiceSpec{Binary: paths.binary(manifest.Current)}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id, paths.Home, paths.Root, marker}, func(value windowsRuntimeRecord) error { record = value; return nil })
	if err != nil {
		t.Fatal(err)
	}
	controller := nativeWindowsProcessController{}
	t.Cleanup(func() { _ = controller.Stop(context.Background(), record) })
	if data, err := os.ReadFile(marker); err != nil || string(data) != "uninstall-blocked-before-delete" {
		t.Fatal("running copy did not refuse self-uninstall")
	}
	if err := store.Verify(manifest); err != nil {
		t.Fatal("self-uninstall modified installation")
	}
	if err := controller.Stop(context.Background(), record); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsInstallationInterruptedUninstallCanResume(t *testing.T) {
	paths, store := windowsInstallationFixture(t)
	manifest, err := store.Install(nil, paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(paths.binary(manifest.Current)); err != nil {
		t.Fatal(err)
	}
	if store.Verify(manifest) == nil {
		t.Fatal("partial installation verified for start")
	}
	if err := store.VerifyRemoval(manifest); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(manifest); err != nil {
		t.Fatal(err)
	}
	if manifest, err := store.Load(); err != nil || manifest != nil {
		t.Fatal("interrupted uninstall cannot resume")
	}
}

func TestWindowsInstallationLauncher(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == "--" {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	args := os.Args[index+1:]
	if len(args) != 5 {
		os.Exit(71)
	}
	mode, home, root, binary, recordPath := args[0], args[1], args[2], args[3], args[4]
	id, _ := newSecret()
	id = id[:32]
	err := startWindowsManagedProcess(context.Background(), installPaths{Home: home, Root: root, Platform: "windows"}, windowsServiceSpec{Binary: binary}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id}, func(record windowsRuntimeRecord) error {
		data, _ := json.Marshal(record)
		if err := writePrivateFile(recordPath, data, 0600); err != nil {
			return err
		}
		if mode == "crash-before-resume" {
			os.Exit(72)
		}
		return nil
	})
	if err != nil {
		os.Exit(73)
	}
}

func TestWindowsInstallationLauncherCrashAndSuccessfulHandoff(t *testing.T) {
	for _, mode := range []string{"crash-before-resume", "ready"} {
		t.Run(mode, func(t *testing.T) {
			paths, _ := windowsInstallationFixture(t)
			copyWindowsInstallationTestExecutable(t, paths.Source)
			recordPath := filepath.Join(paths.Home, "fixture-runtime.json")
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, paths.Source, "-test.run=^TestWindowsInstallationLauncher$", "--", mode, paths.Home, paths.Root, paths.Source, recordPath)
			command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
			system := windowsSystemDirectory()
			command.Env = []string{"SystemRoot=" + filepath.Dir(system), "WINDIR=" + filepath.Dir(system), "PATH=" + system, "LOCALAPPDATA=" + paths.Home, "TEMP=" + paths.Home, "TMP=" + paths.Home}
			err := command.Run()
			if (mode == "ready") != (err == nil) {
				t.Fatalf("launcher result does not match phase: %v", err)
			}
			data, err := windowsInstallRead(recordPath, 16384)
			var record windowsRuntimeRecord
			if err != nil || decodeInstallJSON(data, &record) != nil || record.PID == 0 {
				t.Fatal("launcher did not publish fixture identity")
			}
			controller := nativeWindowsProcessController{}
			if mode == "ready" {
				t.Cleanup(func() { _ = controller.Stop(context.Background(), record) })
				if alive, err := controller.Alive(record); err != nil || !alive {
					t.Fatal("successful launcher exit killed managed child")
				}
				if err := controller.Stop(context.Background(), record); err != nil {
					t.Fatal(err)
				}
			} else {
				handle, alive, err := openVerifiedWindowsProcess(record, false)
				if err != nil {
					t.Fatal(err)
				}
				if alive {
					defer syscall.CloseHandle(handle)
					if state, err := syscall.WaitForSingleObject(handle, 5000); err != nil || state != syscall.WAIT_OBJECT_0 {
						t.Fatal("launcher crash left a suspended orphan")
					}
				}
			}
		})
	}
}

func TestWindowsInstallationFailedHandoffReclaimsReadyProcess(t *testing.T) {
	paths, _ := windowsInstallationFixture(t)
	copyWindowsInstallationTestExecutable(t, paths.Source)
	id, _ := newSecret()
	id = id[:32]
	var record windowsRuntimeRecord
	err := startWindowsManagedProcessWithHandoff(context.Background(), paths, windowsServiceSpec{Binary: paths.Source}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id}, func(value windowsRuntimeRecord) error { record = value; return nil }, func(syscall.Handle) error { return errors.New("fixture handoff failure") })
	if err == nil || record.PID == 0 {
		t.Fatal("failed startup ownership handoff accepted")
	}
	if alive, err := (nativeWindowsProcessController{}).Alive(record); err != nil || alive {
		t.Fatal("handoff failure left ready process alive")
	}
}

func TestWindowsInstallationNestedCoreJobStopsWithManagedOwner(t *testing.T) {
	for _, mode := range []string{"stop", "owner-crash"} {
		t.Run(mode, func(t *testing.T) {
			paths, _ := windowsInstallationFixture(t)
			copyWindowsInstallationTestExecutable(t, paths.Source)
			id, _ := newSecret()
			id = id[:32]
			var record windowsRuntimeRecord
			err := startWindowsManagedProcess(context.Background(), paths, windowsServiceSpec{Binary: paths.Source}, id, []string{"-test.run=^TestWindowsInstallationChild$", "--", id, "nested-core"}, func(value windowsRuntimeRecord) error { record = value; return nil })
			if err != nil {
				t.Fatal(err)
			}
			controller := nativeWindowsProcessController{}
			t.Cleanup(func() { _ = controller.Stop(context.Background(), record) })
			pid := awaitFixturePID(t, filepath.Join(filepath.Dir(paths.Root), "nested-"+id+".pid"))
			core := fixtureProcessHandle(t, pid)
			if mode == "stop" {
				if err := controller.Stop(context.Background(), record); err != nil {
					t.Fatal(err)
				}
			} else {
				owner, alive, err := openVerifiedWindowsProcess(record, true)
				if err != nil || !alive {
					t.Fatal("managed fixture owner unavailable")
				}
				defer syscall.CloseHandle(owner)
				if syscall.TerminateProcess(owner, 1) != nil {
					t.Fatal("fixture owner termination failed")
				}
				assertFixtureExited(t, owner)
			}
			assertFixtureExited(t, core)
		})
	}
}
