//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"errors"
)

func platformManagedService(paths installPaths, _ installationStore) managedService {
	return newServiceBackend(paths, &nativeCommandRunner{home: paths.Home})
}
func runManagedInstallation(context.Context, string, string) error {
	return errors.New("managed_process_platform_not_supported")
}

func currentInstallPaths(string) (installPaths, error) {
	return installPaths{}, errors.New("installation_platform_not_supported")
}
func openInstallationStore(installPaths, string) (installationStore, error) {
	return nil, errors.New("installation_platform_not_supported")
}
func validateServiceExecutable(string) error {
	return errors.New("installation_platform_not_supported")
}
