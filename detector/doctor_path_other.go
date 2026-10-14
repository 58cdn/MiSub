//go:build !windows

package main

import (
	"errors"
	"path/filepath"
	"strings"
)

func doctorValidateLocalPath(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.IndexByte(path, 0) >= 0 {
		return errors.New("doctor_local_path_required")
	}
	return nil
}

func doctorPinParents(target string) (func(), error) {
	if err := doctorValidateLocalPath(target); err != nil {
		return nil, err
	}
	return func() {}, nil
}
