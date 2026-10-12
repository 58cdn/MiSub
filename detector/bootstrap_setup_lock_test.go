//go:build linux || darwin || windows

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func bootstrapLockFixturePath(t *testing.T) string {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(parent, "private")
}

func TestBootstrapSetupLockRejectsConcurrentAcquisitionAndPreservesFile(t *testing.T) {
	path := bootstrapLockFixturePath(t)
	release, err := lockBootstrapSetupDirectory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if duplicate, err := lockBootstrapSetupDirectory(path); err == nil {
		duplicate()
		t.Fatal("concurrent setup lock acquired")
	}
	before, err := os.Stat(filepath.Join(path, "setup.lock"))
	if err != nil || before.Size() != 0 {
		t.Fatal("setup lock contains data")
	}
	release()
	release()
	again, err := lockBootstrapSetupDirectory(path)
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	again()
	after, err := os.Stat(filepath.Join(path, "setup.lock"))
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("stable setup lock file was replaced")
	}
}

func TestBootstrapSetupLockRejectsHardlink(t *testing.T) {
	path := bootstrapLockFixturePath(t)
	release, err := lockBootstrapSetupDirectory(path)
	if err != nil {
		t.Fatal(err)
	}
	release()
	lock := filepath.Join(path, "setup.lock")
	if err = os.Link(lock, filepath.Join(path, "alias.lock")); err != nil {
		t.Fatal(err)
	}
	if release, err = lockBootstrapSetupDirectory(path); err == nil {
		release()
		t.Fatal("hardlinked setup lock accepted")
	}
	if _, err = os.Stat(lock); err != nil {
		t.Fatal("unsafe existing lock file was removed")
	}
}

func TestBootstrapSetupConcurrentAttemptsFailBeforeIdentity(t *testing.T) {
	path := bootstrapLockFixturePath(t)
	first, second := new(setupFixture), new(setupFixture)
	firstOps, secondOps := first.operations(t), second.operations(t)
	lock := func(f *setupFixture) func(string) (func(), error) {
		return func(string) (func(), error) {
			release, err := lockBootstrapSetupDirectory(path)
			if err != nil {
				return nil, err
			}
			f.locked = true
			return func() { f.locked = false; release() }, nil
		}
	}
	firstOps.lock, secondOps.lock = lock(first), lock(second)
	entered, proceed := make(chan struct{}), make(chan struct{})
	firstOps.pair = func(context.Context, pairOptions, io.Writer) error {
		close(entered)
		<-proceed
		first.paired = true
		return nil
	}
	firstOptions, secondOptions := setupFixtureOptions(t), setupFixtureOptions(t)
	finished := make(chan error, 1)
	go func() { finished <- runBootstrapSetup(context.Background(), firstOptions, io.Discard, firstOps) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture did not reach pairing")
	}
	err := runBootstrapSetup(context.Background(), secondOptions, io.Discard, secondOps)
	close(proceed)
	if firstErr := <-finished; firstErr != nil {
		t.Fatal(firstErr)
	}
	if err == nil || !strings.Contains(err.Error(), "setup_in_progress") || second.paired || len(second.calls) != 0 || second.locked {
		t.Fatal("concurrent setup reached identity creation")
	}
}

func TestBootstrapSetupLockChildFixture(t *testing.T) {
	path := os.Getenv("MISUB_SETUP_LOCK_FIXTURE")
	if path == "" {
		return
	}
	release, err := lockBootstrapSetupDirectory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	fmt.Println("fixture-lock-acquired")
	_, _ = io.ReadFull(os.Stdin, make([]byte, 1))
}

func TestBootstrapSetupLockReleasedAfterProcessExit(t *testing.T) {
	path := bootstrapLockFixturePath(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestBootstrapSetupLockChildFixture$")
	child.Env = append(os.Environ(), "MISUB_SETUP_LOCK_FIXTURE="+path)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "fixture-lock-acquired" {
		t.Fatal("child fixture did not acquire setup lock")
	}
	if release, err := lockBootstrapSetupDirectory(path); err == nil {
		release()
		t.Fatal("second process acquired active setup lock")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	release, err := lockBootstrapSetupDirectory(path)
	if err != nil {
		t.Fatalf("process exit did not release setup lock: %v", err)
	}
	release()
}

func TestBootstrapSetupLockRejectsSymlinkAndNonPrivateFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reparse and ACL fixtures run in the Windows-specific suite")
	}
	for _, kind := range []string{"symlink", "permissions"} {
		t.Run(kind, func(t *testing.T) {
			path := bootstrapLockFixturePath(t)
			release, err := lockBootstrapSetupDirectory(path)
			if err != nil {
				t.Fatal(err)
			}
			release()
			lock := filepath.Join(path, "setup.lock")
			if kind == "permissions" {
				err = os.Chmod(lock, 0644)
			} else {
				if err = os.Rename(lock, lock+"-target"); err != nil {
					t.Fatal(err)
				}
				err = os.Symlink(lock+"-target", lock)
			}
			if err != nil {
				t.Fatal(err)
			}
			if release, err = lockBootstrapSetupDirectory(path); err == nil {
				release()
				t.Fatal("unsafe existing setup lock accepted")
			}
			if _, err = os.Lstat(lock); err != nil {
				t.Fatal("unsafe setup lock was removed")
			}
		})
	}
}
