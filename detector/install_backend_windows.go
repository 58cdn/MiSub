//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var windowsInstancePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var winCreateEventEx = winKernel32.NewProc("CreateEventExW")
var winOpenEvent = winKernel32.NewProc("OpenEventW")
var winSetEvent = winKernel32.NewProc("SetEvent")
var winQueryImage = winKernel32.NewProc("QueryFullProcessImageNameW")

type windowsRuntimeRecord struct {
	Schema   int    `json:"schema"`
	Instance string `json:"instance"`
	PID      uint32 `json:"pid"`
	Created  uint64 `json:"created"`
	Image    string `json:"image"`
	SID      string `json:"sid"`
}

type windowsProcessController interface {
	Alive(windowsRuntimeRecord) (bool, error)
	Start(context.Context, installPaths, windowsServiceSpec, string, func(windowsRuntimeRecord) error) error
	Stop(context.Context, windowsRuntimeRecord) error
}

type windowsManagedService struct {
	store   *windowsInstallationStore
	process windowsProcessController
}

func platformManagedService(_ installPaths, files installationStore) managedService {
	return &windowsManagedService{store: files.(*windowsInstallationStore), process: nativeWindowsProcessController{}}
}

func (s *windowsInstallationStore) loadRuntime() (*windowsRuntimeRecord, error) {
	if s.dir == nil {
		return nil, nil
	}
	data, err := windowsInstallRead(filepath.Join(s.paths.Root, "runtime.json"), 16384)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record windowsRuntimeRecord
	sid, sidErr := windowsUserSID()
	if decodeInstallJSON(data, &record) != nil || sidErr != nil || record.Schema != 1 || !windowsInstancePattern.MatchString(record.Instance) || record.PID == 0 || record.Created == 0 || record.SID != sid || validateWindowsPath(record.Image) != nil {
		return nil, errors.New("installation_runtime_invalid")
	}
	return &record, nil
}

func (s *windowsInstallationStore) saveRuntime(record windowsRuntimeRecord) error {
	if s.lock == nil {
		return errors.New("installation_lock_required")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return errors.New("installation_runtime_invalid")
	}
	temp := "runtime-" + record.Instance + ".tmp"
	if err = writeWindowsInstallFile(s.dir, temp, data); err != nil {
		return err
	}
	defer s.dir.root.Remove(temp)
	if s.dir.root.Link(temp, "runtime.json") != nil {
		return errors.New("installation_runtime_publish_failed")
	}
	if s.dir.root.Remove(temp) != nil {
		return errors.New("installation_runtime_publish_uncertain")
	}
	return nil
}

func (s *windowsInstallationStore) clearRuntime() error {
	if s.lock == nil {
		return errors.New("installation_lock_required")
	}
	if _, err := s.loadRuntime(); err != nil {
		return err
	}
	if err := s.dir.root.Remove("runtime.json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("installation_runtime_remove_failed")
	}
	return nil
}

func (b *windowsManagedService) spec(path string) (windowsServiceSpec, error) {
	var spec windowsServiceSpec
	data, err := windowsInstallRead(path, 32768)
	if err != nil {
		return spec, err
	}
	if decodeInstallJSON(data, &spec) != nil || spec.Schema != 1 || spec.Binary != filepath.Join(filepath.Dir(path), "misub-probe.exe") || !validWindowsInstallConfig(b.store.paths.Root, spec.Config) {
		return spec, errors.New("installation_service_invalid")
	}
	return spec, nil
}

func (b *windowsManagedService) Inspect(_ context.Context, path string) (serviceStatus, error) {
	unknown := serviceStatus{State: "unknown"}
	record, err := b.store.loadRuntime()
	if err != nil {
		return unknown, err
	}
	if record == nil {
		return serviceStatus{State: "stopped"}, nil
	}
	expected := filepath.Join(filepath.Dir(path), "misub-probe.exe")
	if !strings.EqualFold(record.Image, expected) {
		return unknown, errors.New("installation_runtime_conflict")
	}
	alive, err := b.process.Alive(*record)
	if err != nil {
		return unknown, err
	}
	if alive {
		return serviceStatus{State: "running", PID: int(record.PID), Registered: true}, nil
	}
	return serviceStatus{State: "stopped", Registered: true}, nil
}

func (b *windowsManagedService) Start(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if state.State == "running" {
		return nil
	}
	if state.State != "stopped" {
		return errors.New("service_state_not_stable")
	}
	spec, err := b.spec(path)
	if err != nil {
		return err
	}
	if err = b.store.ConfigReady(spec.Config); err != nil {
		return err
	}
	if state.Registered {
		if err = b.store.clearRuntime(); err != nil {
			return err
		}
	}
	instance, err := newSecret()
	if err != nil {
		return errors.New("installation_random_failed")
	}
	return b.process.Start(ctx, b.store.paths, spec, instance[:32], b.store.saveRuntime)
}

func (b *windowsManagedService) Stop(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil || state.State == "stopped" {
		return err
	}
	record, err := b.store.loadRuntime()
	if err != nil || record == nil {
		return errors.New("installation_runtime_changed")
	}
	if err = b.process.Stop(ctx, *record); err != nil {
		return err
	}
	state, err = b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if state.State != "stopped" {
		return errors.New("service_stop_not_confirmed")
	}
	return nil
}

func (b *windowsManagedService) Forget(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if state.State != "stopped" {
		return errors.New("service_must_be_stopped")
	}
	return b.store.clearRuntime()
}

func windowsEventName(instance, kind string) string {
	return `Local\MiSubProbe-` + instance + "-" + kind
}

func windowsEventSecurity() (*syscall.SecurityAttributes, func(), error) {
	sid, err := windowsUserSID()
	if err != nil {
		return nil, func() {}, err
	}
	// EVENT_ALL_ACCESS, not the file-object full-access mask.
	text, _ := syscall.UTF16PtrFromString("O:" + sid + "D:P(A;;0x1f0003;;;SY)(A;;0x1f0003;;;" + sid + ")")
	var descriptor uintptr
	ok, _, _ := winConvertStringSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return nil, func() {}, errors.New("managed_event_acl_failed")
	}
	return &syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}, func() { syscall.LocalFree(syscall.Handle(descriptor)) }, nil
}

func validateWindowsEvent(handle syscall.Handle) error {
	sid, err := windowsUserSID()
	if err != nil {
		return err
	}
	var owner *syscall.SID
	var descriptor uintptr
	r, _, _ := winGetSecurityInfo.Call(uintptr(handle), 6, 5, uintptr(unsafe.Pointer(&owner)), 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if r != 0 || descriptor == 0 {
		return errors.New("managed_event_acl_unreadable")
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	if owner == nil {
		return errors.New("managed_event_owner")
	}
	actual, err := owner.String()
	if err != nil || actual != sid {
		return errors.New("managed_event_owner")
	}
	var control uint16
	var revision uint32
	ok, _, _ := winGetSDControl.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 || control&winDACLProtected == 0 {
		return errors.New("managed_event_acl_not_private")
	}
	var rendered *uint16
	var length uint32
	ok, _, _ = winConvertSDString.Call(descriptor, 1, 4, uintptr(unsafe.Pointer(&rendered)), uintptr(unsafe.Pointer(&length)))
	if ok == 0 || rendered == nil {
		return errors.New("managed_event_acl_unreadable")
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(rendered))))
	if length == 0 || length > 65536 {
		return errors.New("managed_event_acl_unreadable")
	}
	text := syscall.UTF16ToString(unsafe.Slice(rendered, int(length)))
	system, user := "(A;;0x1f0003;;;SY)", "(A;;0x1f0003;;;"+sid+")"
	if text != "D:P"+system+user && text != "D:P"+user+system {
		return errors.New("managed_event_acl_not_private")
	}
	return nil
}

func createWindowsEvent(instance, kind string) (syscall.Handle, error) {
	if !windowsInstancePattern.MatchString(instance) || (kind != "stop" && kind != "ready") {
		return 0, errors.New("managed_event_invalid")
	}
	attrs, free, err := windowsEventSecurity()
	if err != nil {
		return 0, err
	}
	defer free()
	name, _ := syscall.UTF16PtrFromString(windowsEventName(instance, kind))
	handle, _, callErr := winCreateEventEx.Call(uintptr(unsafe.Pointer(attrs)), uintptr(unsafe.Pointer(name)), 1, 0x1f0003)
	if handle == 0 {
		return 0, errors.New("managed_event_unavailable")
	}
	if callErr == syscall.ERROR_ALREADY_EXISTS || validateWindowsEvent(syscall.Handle(handle)) != nil {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, errors.New("managed_event_conflict")
	}
	return syscall.Handle(handle), nil
}

func openWindowsEvent(instance, kind string) (syscall.Handle, error) {
	if !windowsInstancePattern.MatchString(instance) || (kind != "stop" && kind != "ready") {
		return 0, errors.New("managed_event_invalid")
	}
	name, _ := syscall.UTF16PtrFromString(windowsEventName(instance, kind))
	handle, _, _ := winOpenEvent.Call(syscall.SYNCHRONIZE|winReadControl|2, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return 0, errors.New("managed_event_unavailable")
	}
	if validateWindowsEvent(syscall.Handle(handle)) != nil {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, errors.New("managed_event_acl_not_private")
	}
	return syscall.Handle(handle), nil
}

func windowsProcessIdentity(handle syscall.Handle, pid uint32) (windowsRuntimeRecord, error) {
	record := windowsRuntimeRecord{Schema: 1, PID: pid}
	var created, exited, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(handle, &created, &exited, &kernel, &user) != nil {
		return record, errors.New("managed_process_identity_unavailable")
	}
	record.Created = uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	var buffer [32768]uint16
	length := uint32(len(buffer))
	ok, _, _ := winQueryImage.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 || length == 0 || length >= uint32(len(buffer)) {
		return record, errors.New("managed_process_identity_unavailable")
	}
	record.Image = syscall.UTF16ToString(buffer[:length])
	var token syscall.Token
	if syscall.OpenProcessToken(handle, syscall.TOKEN_QUERY, &token) != nil {
		return record, errors.New("managed_process_identity_unavailable")
	}
	defer token.Close()
	owner, err := token.GetTokenUser()
	if err != nil {
		return record, errors.New("managed_process_identity_unavailable")
	}
	record.SID, err = owner.User.Sid.String()
	if err != nil {
		return record, errors.New("managed_process_identity_unavailable")
	}
	return record, nil
}

// A process handle pins the identity across inspection and any later stop action.
func openVerifiedWindowsProcess(record windowsRuntimeRecord, terminate bool) (syscall.Handle, bool, error) {
	access := uint32(syscall.SYNCHRONIZE | 0x1000)
	if terminate {
		access |= syscall.PROCESS_TERMINATE
	}
	handle, err := syscall.OpenProcess(access, false, record.PID)
	if err == syscall.Errno(87) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, errors.New("managed_process_unavailable")
	}
	fail := func(err error) (syscall.Handle, bool, error) { syscall.CloseHandle(handle); return 0, false, err }
	wait, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil {
		return fail(errors.New("managed_process_unavailable"))
	}
	if wait == syscall.WAIT_OBJECT_0 {
		return fail(nil)
	}
	actual, err := windowsProcessIdentity(handle, record.PID)
	if err != nil {
		return fail(err)
	}
	// PID reuse proves that the recorded process ended; never stop the new process.
	if actual.Created != record.Created {
		return fail(nil)
	}
	if actual.SID != record.SID || !strings.EqualFold(actual.Image, record.Image) {
		return fail(errors.New("managed_process_identity_conflict"))
	}
	return handle, true, nil
}

type nativeWindowsProcessController struct{}

func (nativeWindowsProcessController) Alive(record windowsRuntimeRecord) (bool, error) {
	handle, alive, err := openVerifiedWindowsProcess(record, false)
	if handle != 0 {
		syscall.CloseHandle(handle)
	}
	return alive, err
}

func (nativeWindowsProcessController) Start(ctx context.Context, paths installPaths, spec windowsServiceSpec, instance string, publish func(windowsRuntimeRecord) error) error {
	return startWindowsManagedProcess(ctx, paths, spec, instance, []string{"--managed-run", instance, "--config", spec.Config}, publish)
}

func startWindowsManagedProcess(ctx context.Context, paths installPaths, spec windowsServiceSpec, instance string, args []string, publish func(windowsRuntimeRecord) error) error {
	return startWindowsManagedProcessWithHandoff(ctx, paths, spec, instance, args, publish, releaseWindowsStartupJob)
}

func startWindowsManagedProcessWithHandoff(ctx context.Context, paths installPaths, spec windowsServiceSpec, instance string, args []string, publish func(windowsRuntimeRecord) error, handoff func(syscall.Handle) error) error {
	if ctx.Err() != nil {
		return errors.New("managed_process_cancelled")
	}
	// Pin the private executable and all its ancestors through the ready handshake.
	_, releaseExecutable, err := openPrivateConfig(spec.Binary)
	if err != nil {
		return errors.New("managed_process_executable_unsafe")
	}
	defer releaseExecutable()
	stop, err := createWindowsEvent(instance, "stop")
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(stop)
	ready, err := createWindowsEvent(instance, "ready")
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(ready)
	application, err := syscall.UTF16PtrFromString(spec.Binary)
	if err != nil || validateWindowsPath(spec.Binary) != nil {
		return errors.New("managed_process_invalid_path")
	}
	command := syscall.EscapeArg(spec.Binary)
	for _, arg := range args {
		command += " " + syscall.EscapeArg(arg)
	}
	line, err := syscall.UTF16PtrFromString(command)
	if err != nil {
		return errors.New("managed_process_invalid_arguments")
	}
	directory, _ := syscall.UTF16PtrFromString(paths.Root)
	system := windowsSystemDirectory()
	env := utf16.Encode([]rune("SystemRoot=" + filepath.Dir(system) + "\x00WINDIR=" + filepath.Dir(system) + "\x00PATH=" + system + "\x00LOCALAPPDATA=" + paths.Home + "\x00TEMP=" + filepath.Dir(paths.Root) + "\x00TMP=" + filepath.Dir(paths.Root) + "\x00\x00"))
	startup, err := newWindowsStartupJob()
	if err != nil {
		return err
	}
	defer startup.Close()
	var process syscall.ProcessInformation
	if syscall.CreateProcess(application, line, nil, nil, false, 0x4|0x08000000|0x400|0x80000, &env[0], directory, &startup.Info.StartupInfo, &process) != nil {
		return errors.New("managed_process_create_failed")
	}
	defer syscall.CloseHandle(process.Process)
	defer syscall.CloseHandle(process.Thread)
	succeeded := false
	defer func() {
		if !succeeded {
			_ = syscall.TerminateProcess(process.Process, 1)
			_, _ = syscall.WaitForSingleObject(process.Process, 5000)
		}
	}()
	record, err := windowsProcessIdentity(process.Process, process.ProcessId)
	if err != nil {
		return err
	}
	sid, err := windowsUserSID()
	if err != nil || record.SID != sid || !strings.EqualFold(record.Image, spec.Binary) {
		return errors.New("managed_process_identity_conflict")
	}
	record.Instance = instance
	if err = publish(record); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.New("managed_process_cancelled")
	}
	r, _, _ := winResumeThread.Call(uintptr(process.Thread))
	if uint32(r) == 0xffffffff {
		return errors.New("managed_process_resume_failed")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if ended, _ := syscall.WaitForSingleObject(process.Process, 0); ended == syscall.WAIT_OBJECT_0 {
			return errors.New("managed_process_start_failed")
		}
		if signaled, _ := syscall.WaitForSingleObject(ready, 50); signaled == syscall.WAIT_OBJECT_0 {
			if ctx.Err() != nil {
				return errors.New("managed_process_cancelled")
			}
			if err := handoff(startup.Handle); err != nil {
				return errors.New("managed_process_handoff_failed")
			}
			succeeded = true
			return nil
		}
	}
	return errors.New("managed_process_ready_timeout")
}

func (nativeWindowsProcessController) Stop(ctx context.Context, record windowsRuntimeRecord) error {
	handle, alive, err := openVerifiedWindowsProcess(record, true)
	if err != nil || !alive {
		return err
	}
	defer syscall.CloseHandle(handle)
	event, err := openWindowsEvent(record.Instance, "stop")
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(event)
	if ok, _, _ := winSetEvent.Call(uintptr(event)); ok == 0 {
		return errors.New("managed_process_stop_failed")
	}
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if state, err := syscall.WaitForSingleObject(handle, 50); err == nil && state == syscall.WAIT_OBJECT_0 {
			return nil
		}
	}
	if ctx.Err() != nil {
		return errors.New("managed_process_stop_cancelled_check_status")
	}
	// The same verified handle is used; never reopen a PID after the grace period.
	if syscall.TerminateProcess(handle, 1) != nil {
		return errors.New("managed_process_stop_failed")
	}
	if state, err := syscall.WaitForSingleObject(handle, 5000); err != nil || state != syscall.WAIT_OBJECT_0 {
		return errors.New("service_stop_not_confirmed")
	}
	return nil
}

func runManagedInstallation(ctx context.Context, instance, configPath string) error {
	paths, err := currentInstallPaths(configPath)
	if err != nil {
		return err
	}
	store, err := openInstallationStore(paths, "status")
	if err != nil {
		return err
	}
	defer store.Close()
	s := store.(*windowsInstallationStore)
	manifest, err := s.Load()
	if err != nil || manifest == nil || s.Verify(manifest) != nil || manifest.ConfigPath != configPath {
		return errors.New("managed_process_installation_invalid")
	}
	record, err := s.loadRuntime()
	if err != nil || record == nil || record.Instance != instance || record.PID != uint32(os.Getpid()) || !strings.EqualFold(record.Image, paths.binary(manifest.Current)) {
		return errors.New("managed_process_runtime_invalid")
	}
	// Retain a non-delete-sharing lease once ready; normal management cannot lose
	// the identity record while this instance is still running.
	_, releaseRuntime, err := openPrivateConfig(filepath.Join(paths.Root, "runtime.json"))
	if err != nil {
		return errors.New("managed_process_runtime_invalid")
	}
	defer releaseRuntime()
	handle, alive, err := openVerifiedWindowsProcess(*record, false)
	if err != nil || !alive {
		return errors.New("managed_process_identity_conflict")
	}
	syscall.CloseHandle(handle)
	config, err := readConfig(configPath)
	if err != nil {
		return err
	}
	binary, cleanup, err := extractKernel()
	if err != nil {
		return err
	}
	defer cleanup()
	return windowsManagedEventLoop(ctx, instance, func(child context.Context) error { return run(child, newAPI(config), binary, false, io.Discard) })
}

func windowsManagedEventLoop(ctx context.Context, instance string, run func(context.Context) error) error {
	stop, err := openWindowsEvent(instance, "stop")
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(stop)
	ready, err := openWindowsEvent(instance, "ready")
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(ready)
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for child.Err() == nil {
			if state, err := syscall.WaitForSingleObject(stop, 50); err != nil || state == syscall.WAIT_OBJECT_0 {
				cancel()
				return
			}
		}
	}()
	if ok, _, _ := winSetEvent.Call(uintptr(ready)); ok == 0 {
		cancel()
		<-done
		return errors.New("managed_process_ready_failed")
	}
	err = run(child)
	cancel()
	<-done
	return err
}
