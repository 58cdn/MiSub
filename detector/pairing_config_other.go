//go:build !linux && !darwin && !windows

package main

import "errors"

func preparePairingConfig(string) (pairingConfigStore, error) {
	return nil, errors.New("pairing_platform_not_supported_requires_linux_or_macos")
}
