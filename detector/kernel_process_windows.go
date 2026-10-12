//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var winCreateJob = winKernel32.NewProc("CreateJobObjectW")
var winSetJob = winKernel32.NewProc("SetInformationJobObject")
var winIsProcessInJob = winKernel32.NewProc("IsProcessInJob")
var winTerminateJob = winKernel32.NewProc("TerminateJobObject")
var winQueryJob = winKernel32.NewProc("QueryInformationJobObject")
var winResumeThread = winKernel32.NewProc("ResumeThread")

// SDK JOBOBJECT_EXTENDED_LIMIT_INFORMATION: pointer-sized fields retain the
// platform ABI alignment; native tests assert the amd64 sizes and offsets.
type windowsJobLimits struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}
type windowsJobExtendedLimits struct {
	Basic                 windowsJobLimits
	IO                    [6]uint64
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}
type windowsJobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

func verifyWindowsJob(job, process syscall.Handle) error {
	var assigned int32
	ok, _, _ := winIsProcessInJob.Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&assigned)))
	if ok == 0 || assigned == 0 {
		return errors.New("kernel_job_assignment_failed")
	}
	return nil
}

func startCoreProcess(ctx context.Context, binary string, args []string, dir string) (func() error, error) {
	return startWindowsCoreProcess(ctx, binary, args, dir, verifyWindowsJob)
}

func startWindowsCoreProcess(ctx context.Context, binary string, args []string, dir string, verify func(syscall.Handle, syscall.Handle) error) (func() error, error) {
	failure := errors.New("kernel_process_failed")
	if ctx.Err() != nil || !filepath.IsAbs(binary) || !filepath.IsAbs(dir) {
		return nil, failure
	}
	application, err := syscall.UTF16PtrFromString(binary)
	if err != nil {
		return nil, failure
	}
	command := syscall.EscapeArg(binary)
	for _, arg := range args {
		if strings.ContainsRune(arg, 0) {
			return nil, failure
		}
		command += " " + syscall.EscapeArg(arg)
	}
	commandLine, err := syscall.UTF16PtrFromString(command)
	if err != nil {
		return nil, failure
	}
	directory, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return nil, failure
	}
	systemDir := windowsSystemDirectory()
	environment := utf16.Encode([]rune("SystemRoot=" + filepath.Dir(systemDir) + "\x00WINDIR=" + filepath.Dir(systemDir) + "\x00PATH=" + systemDir + "\x00HOME=" + dir + "\x00USERPROFILE=" + dir + "\x00TEMP=" + dir + "\x00TMP=" + dir + "\x00\x00"))
	startup, err := newWindowsStartupJob()
	if err != nil {
		return nil, failure
	}
	job := startup.Handle
	var process syscall.ProcessInformation
	// CreateProcess retains the primary thread handle. os/exec closes that handle.
	// STARTUPINFOEX assigns the kill-on-close job during creation, so even an
	// owner crash before verification or ResumeThread cannot orphan this core.
	// Handles and console streams are not inherited, and no console is allocated.
	err = syscall.CreateProcess(application, commandLine, nil, nil, false, 0x4|0x08000000|0x400|0x80000, &environment[0], directory, &startup.Info.StartupInfo, &process)
	if err != nil {
		startup.Close()
		return nil, failure
	}
	failStarted := func() (func() error, error) {
		_ = syscall.TerminateProcess(process.Process, 1)
		_, _ = syscall.WaitForSingleObject(process.Process, 5000)
		syscall.CloseHandle(process.Thread)
		syscall.CloseHandle(process.Process)
		startup.Close()
		return nil, failure
	}
	if verify(job, process.Process) != nil || ctx.Err() != nil {
		return failStarted()
	}
	resumed, _, _ := winResumeThread.Call(uintptr(process.Thread))
	if uint32(resumed) == 0xffffffff {
		return failStarted()
	}
	syscall.CloseHandle(process.Thread)
	return func() error {
		stopWatch := make(chan struct{})
		watchDone := make(chan struct{})
		go func() {
			defer close(watchDone)
			select {
			case <-ctx.Done():
				winTerminateJob.Call(uintptr(job), 1)
			case <-stopWatch:
			}
		}()
		result, waitErr := syscall.WaitForSingleObject(process.Process, syscall.INFINITE)
		close(stopWatch)
		<-watchDone
		var code uint32
		exitErr := syscall.GetExitCodeProcess(process.Process, &code)
		// A core that exits first must not leave a descendant behind.
		terminated, _, _ := winTerminateJob.Call(uintptr(job), 1)
		empty := false
		deadline := time.Now().Add(5 * time.Second)
		for terminated != 0 && time.Now().Before(deadline) {
			var accounting windowsJobAccounting
			queried, _, _ := winQueryJob.Call(uintptr(job), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
			if queried == 0 {
				break
			}
			if accounting.ActiveProcesses == 0 {
				empty = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		syscall.CloseHandle(process.Process)
		startup.Close()
		if waitErr != nil || result != syscall.WAIT_OBJECT_0 || exitErr != nil || code != 0 || !empty || ctx.Err() != nil {
			return failure
		}
		return nil
	}, nil
}
