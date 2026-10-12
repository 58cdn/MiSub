//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsKernelRemovesTaskSecretsAfterCancellation(t *testing.T) {
	binary := fixtureKernel(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	kernel, err := startKernel(ctx, binary, map[string]any{"name": "probe-target", "type": "http", "server": "127.0.0.1", "port": 1})
	if err != nil {
		t.Fatal(err)
	}
	dir := kernel.dir
	_, closeFile, err := openPrivateConfig(filepath.Join(dir, "config.json"))
	if err != nil {
		kernel.Close()
		t.Fatal("core task config lacks private ACL")
	}
	closeFile()
	cancel()
	kernel.Close()
	kernel.Close()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("task secrets survived kernel close")
	}
}

func TestWindowsTemporaryDirectoryCleanup(t *testing.T) {
	base := t.TempDir()
	path, cleanup, err := createPrivateTempDir(base, "cleanup-")
	if err != nil {
		t.Fatal(err)
	}
	if err = writePrivateFile(filepath.Join(path, "secret.json"), []byte("fixture-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	cleanup()
	cleanup()
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("private temporary directory survived cleanup")
	}
}
