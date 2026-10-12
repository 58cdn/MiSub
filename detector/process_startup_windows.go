//go:build windows

package main

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

var winInitializeAttributes = winKernel32.NewProc("InitializeProcThreadAttributeList")
var winUpdateAttributes = winKernel32.NewProc("UpdateProcThreadAttribute")
var winDeleteAttributes = winKernel32.NewProc("DeleteProcThreadAttributeList")

type windowsStartupInfoEx struct {
	StartupInfo   syscall.StartupInfo
	AttributeList *byte
}

// The buffers and handle array remain alive until the attribute list is deleted.
// JOB_LIST assigns ownership atomically as part of CreateProcess, including while
// the primary thread is suspended. Unsupported systems fail without a fallback.
type windowsStartupJob struct {
	Handle     syscall.Handle
	Info       windowsStartupInfoEx
	attributes []byte
	jobs       []syscall.Handle
	pinner     runtime.Pinner
}

func newWindowsStartupJob() (*windowsStartupJob, error) {
	j := &windowsStartupJob{}
	fail := func() (*windowsStartupJob, error) {
		j.Close()
		return nil, errors.New("process_startup_job_unavailable")
	}
	handle, _, _ := winCreateJob.Call(0, 0)
	if handle == 0 {
		return fail()
	}
	j.Handle = syscall.Handle(handle)
	limits := windowsJobExtendedLimits{Basic: windowsJobLimits{LimitFlags: 0x2000}}
	if ok, _, _ := winSetJob.Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		return fail()
	}
	var size uintptr
	winInitializeAttributes.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 65536 {
		return fail()
	}
	j.attributes = make([]byte, int(size))
	j.pinner.Pin(&j.attributes[0])
	if ok, _, _ := winInitializeAttributes.Call(uintptr(unsafe.Pointer(&j.attributes[0])), 1, 0, uintptr(unsafe.Pointer(&size))); ok == 0 {
		return fail()
	}
	j.Info.AttributeList = &j.attributes[0]
	j.Info.StartupInfo.Cb = uint32(unsafe.Sizeof(j.Info))
	j.jobs = []syscall.Handle{j.Handle}
	j.pinner.Pin(&j.jobs[0])
	if ok, _, _ := winUpdateAttributes.Call(uintptr(unsafe.Pointer(j.Info.AttributeList)), 0, 0x0002000d, uintptr(unsafe.Pointer(&j.jobs[0])), unsafe.Sizeof(j.Handle), 0, 0); ok == 0 {
		return fail()
	}
	return j, nil
}

func (j *windowsStartupJob) Close() {
	if j.Info.AttributeList != nil {
		winDeleteAttributes.Call(uintptr(unsafe.Pointer(j.Info.AttributeList)))
		j.Info.AttributeList = nil
	}
	if j.Handle != 0 {
		syscall.CloseHandle(j.Handle)
		j.Handle = 0
	}
	j.pinner.Unpin()
	j.attributes = nil
	j.jobs = nil
}

func releaseWindowsStartupJob(handle syscall.Handle) error {
	limits := windowsJobExtendedLimits{}
	if ok, _, _ := winSetJob.Call(uintptr(handle), 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		return errors.New("managed_process_handoff_failed")
	}
	return nil
}
