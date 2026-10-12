//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsJobABI(t *testing.T) {
	if unsafe.Sizeof(windowsJobLimits{}) != 64 || unsafe.Sizeof(windowsJobExtendedLimits{}) != 144 || unsafe.Offsetof(windowsJobExtendedLimits{}.IO) != 64 || unsafe.Sizeof(windowsJobAccounting{}) != 48 {
		t.Fatal("Windows amd64 job ABI mismatch")
	}
	if unsafe.Sizeof(windowsStartupInfoEx{}) != 112 || unsafe.Offsetof(windowsStartupInfoEx{}.AttributeList) != 104 {
		t.Fatal("Windows amd64 STARTUPINFOEX ABI mismatch")
	}
}

func TestWindowsProcessHelper(t *testing.T) {
	split := -1
	for i, arg := range os.Args {
		if arg == "--" {
			split = i
			break
		}
	}
	if split < 0 {
		return
	}
	args := os.Args[split+1:]
	if len(args) != 2 {
		os.Exit(21)
	}
	mode, marker := args[0], args[1]
	switch mode {
	case "inspect":
		console, _, _ := winKernel32.NewProc("GetConsoleWindow").Call()
		if console != 0 || os.Getenv("HTTP_PROXY") != "" || os.Getenv("PAIRING_TEST_SECRET") != "" {
			os.Exit(22)
		}
		if os.WriteFile(marker, []byte("hidden-clean-environment"), 0600) != nil {
			os.Exit(23)
		}
		return
	case "grandchild":
		if os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600) != nil {
			os.Exit(24)
		}
	case "parent":
		exe, _ := os.Executable()
		child := exec.Command(exe, "-test.run=^TestWindowsProcessHelper$", "--", "grandchild", marker)
		child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		if child.Start() != nil {
			os.Exit(25)
		}
		defer child.Wait()
	case "job-owner":
		exe, _ := os.Executable()
		wait, err := startCoreProcess(context.Background(), exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "grandchild", marker}, filepath.Dir(marker))
		if err != nil {
			os.Exit(26)
		}
		_ = wait()
		return
	case "crash-before-resume":
		exe, _ := os.Executable()
		_, _ = startWindowsCoreProcess(context.Background(), exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "grandchild", marker + "-ran"}, filepath.Dir(marker), func(job, process syscall.Handle) error {
			if verifyWindowsJob(job, process) != nil {
				os.Exit(28)
			}
			pid, _, _ := winKernel32.NewProc("GetProcessId").Call(uintptr(process))
			if pid == 0 || os.WriteFile(marker, []byte(strconv.FormatUint(uint64(pid), 10)), 0600) != nil {
				os.Exit(29)
			}
			os.Exit(30)
			return nil
		})
		os.Exit(31)
	default:
		os.Exit(27)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestWindowsCoreStartupCrashCannotOrphanSuspendedProcess(t *testing.T) {
	dir := windowsFixtureDir(t)
	exe, _ := os.Executable()
	marker := filepath.Join(dir, "suspended-child.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	owner := exec.CommandContext(ctx, exe, "-test.run=^TestWindowsProcessHelper$", "--", "crash-before-resume", marker)
	owner.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := owner.Run(); err == nil {
		t.Fatal("fixture owner did not crash")
	}
	pid := awaitFixturePID(t, marker)
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE|0x1000, false, pid)
	if err != nil && err != syscall.Errno(87) {
		t.Fatal("fixture child state unavailable")
	}
	if err == nil {
		defer syscall.CloseHandle(handle)
		assertFixtureExited(t, handle)
	}
	if _, err := os.Stat(marker + "-ran"); !os.IsNotExist(err) {
		t.Fatal("suspended child ran before owner crash")
	}
}

func awaitFixturePID(t *testing.T, path string) uint32 {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32); err == nil && pid > 0 {
				return uint32(pid)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("fixture process did not start")
	return 0
}
func fixtureProcessHandle(t *testing.T, pid uint32) syscall.Handle {
	t.Helper()
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE|syscall.PROCESS_QUERY_INFORMATION, false, pid)
	if err != nil {
		t.Fatal("fixture process unavailable")
	}
	t.Cleanup(func() { syscall.CloseHandle(handle) })
	return handle
}
func assertFixtureExited(t *testing.T, handle syscall.Handle) {
	t.Helper()
	result, err := syscall.WaitForSingleObject(handle, 8000)
	if err != nil || result != syscall.WAIT_OBJECT_0 {
		t.Fatal("fixture descendant survived")
	}
}

func TestWindowsCoreHiddenEnvironmentAndCancellation(t *testing.T) {
	dir := windowsFixtureDir(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HTTP_PROXY", "http://never-use.invalid")
	t.Setenv("PAIRING_TEST_SECRET", "must-not-inherit")
	marker := filepath.Join(dir, "inspect.txt")
	wait, err := startCoreProcess(context.Background(), exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "inspect", marker}, dir)
	if err != nil || wait() != nil {
		t.Fatal("hidden process failed")
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "hidden-clean-environment" {
		t.Fatal("console or environment isolation failed")
	}
	marker = filepath.Join(dir, "grandchild.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wait, err = startCoreProcess(ctx, exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "parent", marker}, dir)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- wait() }()
	pid := awaitFixturePID(t, marker)
	descendant := fixtureProcessHandle(t, pid)
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not finish")
	}
	assertFixtureExited(t, descendant)
}

func TestWindowsCoreFailsClosedBeforeResume(t *testing.T) {
	dir := windowsFixtureDir(t)
	exe, _ := os.Executable()
	marker := filepath.Join(dir, "must-not-exist")
	var child syscall.Handle
	var assigned bool
	verifyFailure := func(job, process syscall.Handle) error {
		assigned = verifyWindowsJob(job, process) == nil
		pid, _, _ := winKernel32.NewProc("GetProcessId").Call(uintptr(process))
		var err error
		child, err = syscall.OpenProcess(syscall.SYNCHRONIZE|syscall.PROCESS_TERMINATE, false, uint32(pid))
		if err == nil {
			t.Cleanup(func() {
				_ = syscall.TerminateProcess(child, 1)
				syscall.CloseHandle(child)
			})
		}
		return fmt.Errorf("fixture job verification failure")
	}
	if wait, err := startWindowsCoreProcess(context.Background(), exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "inspect", marker}, dir, verifyFailure); err == nil || wait != nil {
		t.Fatal("job failure accepted")
	}
	if !assigned || child == 0 {
		t.Fatal("suspended process was not atomically assigned to its job")
	}
	assertFixtureExited(t, child)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("child ran after job verification failure")
	}
	if wait, err := startCoreProcess(context.Background(), filepath.Join(dir, "missing-core.exe"), nil, dir); err == nil || wait != nil {
		t.Fatal("failed atomic process creation accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := startCoreProcess(ctx, exe, []string{"-test.run=^TestWindowsProcessHelper$", "--", "inspect", marker}, dir); err == nil {
		t.Fatal("cancelled process started")
	}
}

func TestWindowsJobClosesWhenDetectorCrashes(t *testing.T) {
	dir := windowsFixtureDir(t)
	exe, _ := os.Executable()
	marker := filepath.Join(dir, "owned-child.pid")
	// The owner is deliberately outside the helper's job, matching the detector.
	owner := exec.Command(exe, "-test.run=^TestWindowsProcessHelper$", "--", "job-owner", marker)
	owner.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if owner.Start() != nil {
		t.Fatal("fixture owner start failed")
	}
	t.Cleanup(func() { _ = owner.Process.Kill(); _ = owner.Wait() })
	pid := awaitFixturePID(t, marker)
	child := fixtureProcessHandle(t, pid)
	if owner.Process.Kill() != nil {
		t.Fatal("fixture owner kill failed")
	}
	_ = owner.Wait()
	assertFixtureExited(t, child)
}
