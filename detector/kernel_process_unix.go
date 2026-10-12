//go:build !windows

package main

import (
	"context"
	"io"
	"os"
	"os/exec"
)

func startCoreProcess(ctx context.Context, binary string, args []string, dir string) (func() error, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	// Core diagnostics may contain credentials or provider bodies.
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd.Wait, nil
}
