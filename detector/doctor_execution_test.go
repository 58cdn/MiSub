package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDoctorExecutionRequiresExplicitModeAndPrerequisites(t *testing.T) {
	report := collectDoctor(&fixtureDoctorHost{kernelVersion: "v1.19.32"}, fixtureDoctorEnvironment(), doctorOptions{})
	for _, mode := range []string{"local", "https://private.invalid/secret", "", "network", "kernel-version -v"} {
		calls := 0
		got := applyDoctorMode(context.Background(), report, mode, func(context.Context) error { calls++; return nil })
		if calls != 0 || doctorCheckByID(t, got, "kernel_execution").State != "not_run" {
			t.Fatal("unselected or arbitrary target mode executed")
		}
		if mode == "local" && !reflect.DeepEqual(got, report) {
			t.Fatal("default report changed")
		}
	}
	for _, blocked := range []string{"platform", "kernel_materials", "installation"} {
		blockedReport := report
		blockedReport.Checks = append([]doctorCheck(nil), report.Checks...)
		for i := range blockedReport.Checks {
			if blockedReport.Checks[i].ID == blocked {
				blockedReport.Checks[i].State = "error"
			}
		}
		got := applyDoctorMode(context.Background(), blockedReport, "kernel-version", func(context.Context) error { t.Fatal("blocked execution ran"); return nil })
		if doctorCheckByID(t, got, "kernel_execution").Code != "kernel_execution_prerequisite_failed" {
			t.Fatal("missing not-run state")
		}
	}
}

func TestDoctorExecutionResultsAreBoundedAndRedacted(t *testing.T) {
	for _, tc := range []struct {
		err         error
		state, code string
	}{
		{nil, "ok", "embedded_kernel_version_exited"},
		{context.DeadlineExceeded, "error", "kernel_execution_timeout"},
		{context.Canceled, "error", "kernel_execution_cancelled"},
		{os.ErrPermission, "error", "kernel_execution_permission_denied"},
		{errors.New("PRIVATE_TOKEN /private/path https://private.invalid"), "error", "kernel_execution_failed"},
	} {
		report := collectDoctor(&fixtureDoctorHost{kernelVersion: "v1.19.32"}, fixtureDoctorEnvironment(), doctorOptions{})
		calls := 0
		got := applyDoctorMode(context.Background(), report, "kernel-version", func(ctx context.Context) error {
			calls++
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > doctorKernelTimeout {
				t.Fatal("missing execution deadline")
			}
			return tc.err
		})
		check := doctorCheckByID(t, got, "kernel_execution")
		if calls != 1 || got.SchemaVersion != 2 || got.Scope != "local_kernel_execution" || check.State != tc.state || check.Code != tc.code {
			t.Fatalf("unexpected result: %+v", got)
		}
		if doctorCheckByID(t, got, "network").State != "not_run" || doctorCheckByID(t, got, "service").State != "not_run" {
			t.Fatal("invented network or service check")
		}
		for _, asJSON := range []bool{true, false} {
			var output bytes.Buffer
			if writeDoctorReport(&output, got, asJSON) != nil {
				t.Fatal("cannot write report")
			}
			if output.Len() > 8192 || strings.Contains(output.String(), "PRIVATE") || strings.Contains(output.String(), "private.invalid") || !strings.Contains(output.String(), "private_temporary_files") {
				t.Fatal("unbounded, unredacted or unexplained report")
			}
		}
	}
}

func TestDoctorExecutionCancellationAndTimeout(t *testing.T) {
	report := collectDoctor(&fixtureDoctorHost{kernelVersion: "v1.19.32"}, fixtureDoctorEnvironment(), doctorOptions{})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	got := applyDoctorMode(cancelled, report, "kernel-version", func(context.Context) error { t.Fatal("cancelled run started"); return nil })
	if doctorCheckByID(t, got, "kernel_execution").Code != "kernel_execution_cancelled" {
		t.Fatal("lost cancellation")
	}
	ctx, stop := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer stop()
	got = applyDoctorMode(ctx, report, "kernel-version", func(ctx context.Context) error { <-ctx.Done(); return errors.New("PRIVATE") })
	if doctorCheckByID(t, got, "kernel_execution").Code != "kernel_execution_timeout" {
		t.Fatal("lost timeout")
	}
}

func TestKernelVersionUsesFixedArgumentsAndCleansEveryPath(t *testing.T) {
	for _, phase := range []string{"success", "extract", "start", "wait", "cancel-extract", "cancel-wait", "pre-cancel"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			extracts, starts, cleanups := 0, 0, 0
			binary := filepath.Join(t.TempDir(), "fixture-kernel")
			if phase == "pre-cancel" {
				cancel()
			}
			err := runKernelVersion(ctx, kernelVersionHost{
				extract: func() (string, func(), error) {
					extracts++
					if phase == "extract" {
						return "", nil, os.ErrPermission
					}
					if phase == "cancel-extract" {
						cancel()
					}
					return binary, func() { cleanups++ }, nil
				},
				start: func(ctx context.Context, got string, args []string, dir string) (func() error, error) {
					starts++
					if got != binary || dir != filepath.Dir(binary) || !reflect.DeepEqual(args, []string{"-v"}) {
						t.Fatal("arbitrary execution parameters")
					}
					if phase == "start" {
						return nil, os.ErrPermission
					}
					return func() error {
						if phase == "cancel-wait" {
							cancel()
						}
						if phase == "wait" {
							return errors.New("fixture")
						}
						return nil
					}, nil
				},
			})
			if (err == nil) != (phase == "success") {
				t.Fatalf("unexpected error: %v", err)
			}
			wantCleanup := 1
			if phase == "extract" || phase == "pre-cancel" {
				wantCleanup = 0
			}
			if cleanups != wantCleanup || starts > 1 || (phase == "pre-cancel" && extracts != 0) || (phase == "cancel-extract" && starts != 0) {
				t.Fatal("execution or cleanup escaped its boundary")
			}
		})
	}
}
