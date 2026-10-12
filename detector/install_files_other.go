//go:build !linux && !darwin

package main

import "errors"

func currentInstallPaths(string) (installPaths, error) {
	return installPaths{}, errors.New("installation_platform_not_supported")
}
func openInstallationStore(installPaths, string) (installationStore, error) {
	return nil, errors.New("installation_platform_not_supported")
}
func validateServiceExecutable(string) error {
	return errors.New("installation_platform_not_supported")
}
