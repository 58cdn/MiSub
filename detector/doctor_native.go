package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type nativeDoctorHost struct{}

func (nativeDoctorHost) Kernel() (string, error) {
	lock, err := loadKernelLock()
	if err != nil {
		return "", err
	}
	return inspectDoctorKernel(lock, embeddedFiles, nativeBootstrapTarget())
}

// Hash the embedded archive without extracting files or executing the kernel.
func inspectDoctorKernel(lock kernelLock, files fs.FS, target string) (string, error) {
	if !kernelBuildVersionValid(lock.Version) {
		return "", errors.New("kernel_metadata_invalid")
	}
	asset, ok := lock.Assets[target]
	if !ok {
		return lock.Version, errors.New("unsupported_platform")
	}
	extension := path.Ext(asset.File)
	if (extension != ".gz" && extension != ".zip") || !strings.HasPrefix(asset.File, "mihomo-"+target+"-") || !installHashPattern.MatchString(asset.SHA256) {
		return lock.Version, errors.New("kernel_metadata_invalid")
	}
	archive, err := files.Open("embedded/kernel" + extension)
	if err != nil {
		return lock.Version, errors.New("kernel_missing")
	}
	defer archive.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(archive, maxKernelBytes+1))
	if err != nil || size == 0 || size > maxKernelBytes {
		return lock.Version, errors.New("kernel_materials_invalid")
	}
	if hex.EncodeToString(digest.Sum(nil)) != asset.SHA256 {
		return lock.Version, errors.New("kernel_checksum_failed")
	}
	return lock.Version, nil
}

func (nativeDoctorHost) Installation() (doctorInstallation, error) {
	paths, err := currentInstallPaths("")
	if err != nil {
		return doctorInstallation{}, err
	}
	return inspectDoctorInstallation(paths)
}

func inspectDoctorInstallation(paths installPaths) (doctorInstallation, error) {
	release, err := doctorPinParents(paths.Root)
	if errors.Is(err, os.ErrNotExist) {
		return doctorInstallation{}, nil
	}
	if err != nil {
		return doctorInstallation{}, errors.New("installation_path_invalid")
	}
	defer release()
	// The status store opens existing files without creating an operation lock.
	files, err := openInstallationStore(paths, "status")
	if err != nil {
		return doctorInstallation{}, err
	}
	defer files.Close()
	manifest, err := files.Load()
	if err != nil || manifest == nil {
		return doctorInstallation{}, err
	}
	if err := files.Verify(manifest); err != nil {
		return doctorInstallation{}, err
	}
	for _, generation := range manifest.Generations {
		if generation.ID == manifest.Current {
			return doctorInstallation{Present: true, ConfigPath: manifest.ConfigPath, Version: generation.Version}, nil
		}
	}
	return doctorInstallation{}, errors.New("installation_manifest_invalid")
}

func (nativeDoctorHost) Configuration(configPath string) error {
	if configPath == "" {
		return errors.New("config_path_invalid")
	}
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return errors.New("config_path_invalid")
	}
	release, err := doctorPinParents(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("config_missing")
	}
	if err != nil {
		return errors.New("config_path_invalid")
	}
	defer release()
	if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
		return errors.New("config_missing")
	}
	_, err = readConfig(absolute)
	return err
}
