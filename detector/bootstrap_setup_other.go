//go:build !linux && !darwin && !windows

package main

import "errors"

func lockBootstrapSetupDirectory(string) (func(), error) {
	return nil, errors.New("setup_platform_not_supported")
}
