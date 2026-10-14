//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDoctorNativeWindowsRejectsJunctionParentsBeforeReading(t *testing.T) {
	base := doctorNativePrivateDir(t)
	target := filepath.Join(base, "target")
	child := filepath.Join(target, "child")
	doctorNativePrivateChild(t, target)
	doctorNativePrivateChild(t, child)
	data := []byte(`{"version":1,"server":"https://misub.example","token":"` + fixturePairToken + `"}`)
	for _, directory := range []string{target, child} {
		doctorNativeWrite(t, filepath.Join(directory, "probe.json"), data, 0600)
	}
	link := filepath.Join(base, "junction")
	createFixtureJunction(t, link, target)
	before := doctorNativeSnapshot(t, target)
	for _, path := range []string{filepath.Join(link, "probe.json"), filepath.Join(link, "child", "probe.json")} {
		release, err := doctorPinParents(path)
		if release != nil {
			release()
			t.Fatal("junction parent returned a lease")
		}
		doctorNativeError(t, err, "doctor_local_path_required")
		doctorNativeError(t, (nativeDoctorHost{}).Configuration(path), "config_path_invalid")
	}
	got, err := inspectDoctorInstallation(installPaths{Home: base, Root: filepath.Join(link, "child"), Platform: "windows"})
	doctorNativeError(t, err, "installation_path_invalid")
	if got != (doctorInstallation{}) {
		t.Fatal("junction installation returned state")
	}
	doctorNativeUnchanged(t, target, before)
	if _, err := os.Lstat(filepath.Join(child, "operation.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected path created operation.lock: %v", err)
	}
	if err := os.Rename(link, link+"-released"); err != nil {
		t.Fatalf("rejected junction retained a handle: %v", err)
	}
}
