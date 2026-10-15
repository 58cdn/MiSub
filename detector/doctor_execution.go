package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const doctorKernelTimeout = 10 * time.Second

type kernelVersionHost struct {
	extract func() (string, func(), error)
	start   func(context.Context, string, []string, string) (func() error, error)
}

// Execute only the verified embedded kernel's version command. Neither paths,
// arguments, output streams nor network targets come from diagnostic input.
func runKernelVersion(ctx context.Context, host kernelVersionHost) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	binary, cleanup, err := host.extract()
	if err != nil {
		return err
	}
	defer cleanup()
	if err := ctx.Err(); err != nil {
		return err
	}
	wait, err := host.start(ctx, binary, []string{"-v"}, filepath.Dir(binary))
	if err != nil {
		return err
	}
	err = wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func doctorModeValid(mode string) bool { return mode == "local" || mode == "kernel-version" }

func applyDoctorMode(ctx context.Context, report doctorReport, mode string, run func(context.Context) error) doctorReport {
	if mode == "local" {
		return report
	}
	// The CLI validates before any host read; retain a defensive no-execution gate.
	if mode != "kernel-version" {
		report.Status = "issues_found"
		return report
	}
	report.SchemaVersion = 2
	report.Checks = append([]doctorCheck(nil), report.Checks...)
	report.Mode, report.Scope = mode, "local_kernel_execution"
	report.SideEffects = []string{"private_temporary_files", "embedded_kernel_version_process"}
	ready := map[string]bool{}
	for _, check := range report.Checks {
		ready[check.ID] = check.State == "ok" || check.State == "info"
	}
	check := doctorCheck{ID: "kernel_execution", State: "not_run", Code: "kernel_execution_prerequisite_failed"}
	if !ready["platform"] || !ready["kernel_materials"] || !ready["installation"] {
		report.Status = "issues_found"
	}
	if ready["platform"] && ready["kernel_materials"] && ready["installation"] {
		child, cancel := context.WithTimeout(ctx, doctorKernelTimeout)
		err := child.Err()
		if err == nil {
			err = run(child)
		}
		if child.Err() != nil {
			err = child.Err()
		}
		cancel()
		check.State, check.Code = "ok", "embedded_kernel_version_exited"
		if err != nil {
			check.State, check.Code = "error", "kernel_execution_failed"
			switch {
			case errors.Is(err, context.Canceled):
				check.Code = "kernel_execution_cancelled"
			case errors.Is(err, context.DeadlineExceeded):
				check.Code = "kernel_execution_timeout"
			case errors.Is(err, os.ErrPermission):
				check.Code = "kernel_execution_permission_denied"
			}
			report.Status = "issues_found"
		}
	}
	for index := range report.Checks {
		if report.Checks[index].ID == "kernel_execution" {
			report.Checks[index] = check
		}
	}
	if report.Status == "local_checks_passed" {
		report.Status = "diagnostic_checks_passed"
	}
	return report
}
