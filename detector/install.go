package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

const installSchema = 1
const maxInstallGenerations = 8

var installGenerationPattern = regexp.MustCompile(`^[a-f0-9]{24}$`)
var installHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type installGeneration struct {
	ID            string `json:"id"`
	BinarySHA256  string `json:"binarySha256"`
	ServiceSHA256 string `json:"serviceSha256"`
	Version       string `json:"version"`
}

type installManifest struct {
	Schema      int                 `json:"schema"`
	Platform    string              `json:"platform"`
	ConfigPath  string              `json:"configPath"`
	Current     string              `json:"current"`
	Generations []installGeneration `json:"generations"`
}

type installPaths struct {
	Home, Root, Source, Config string
	UID                        int
	Platform                   string
}

func (p installPaths) serviceName() string {
	if p.Platform == "windows" {
		return "managed-process.json"
	}
	if p.Platform == "darwin" {
		return "com.misub.probe.plist"
	}
	return "misub-probe.service"
}
func (p installPaths) join(parts ...string) string {
	if p.Platform == "linux" || p.Platform == "darwin" {
		return path.Join(parts...)
	}
	return filepath.Join(parts...)
}
func (p installPaths) binary(id string) string {
	name := "misub-probe"
	if p.Platform == "windows" {
		name += ".exe"
	}
	return p.join(p.Root, id, name)
}
func (p installPaths) service(id string) string { return p.join(p.Root, id, p.serviceName()) }

type serviceStatus struct {
	State      string `json:"state"`
	PID        int    `json:"pid,omitempty"`
	Registered bool   `json:"registered"`
}

type installationStatus struct {
	Installed      bool          `json:"installed"`
	Version        string        `json:"version,omitempty"`
	ExecutablePath string        `json:"executablePath,omitempty"`
	Platform       string        `json:"platform"`
	Service        serviceStatus `json:"service"`
	Connectivity   string        `json:"connectivity"`
	Autostart      string        `json:"autostart"`
}

type installationStore interface {
	Load() (*installManifest, error)
	Verify(*installManifest) error
	VerifyRemoval(*installManifest) error
	Install(*installManifest, string) (*installManifest, error)
	Remove(*installManifest) error
	ConfigReady(string) error
	Close() error
}

type managedService interface {
	Inspect(context.Context, string) (serviceStatus, error)
	Start(context.Context, string) error
	Stop(context.Context, string) error
	Forget(context.Context, string) error
}

type installManager struct {
	paths   installPaths
	files   installationStore
	service managedService
}

func installationAction(selected, visited map[string]bool, arguments int) (string, error) {
	action := ""
	for name, on := range selected {
		if on {
			if action != "" {
				return "", errors.New("management_flags_conflict")
			}
			action = name
		}
	}
	if action == "" {
		if visited["json"] {
			return "", errors.New("json_requires_installation_status")
		}
		return "", nil
	}
	if arguments != 0 {
		return "", errors.New("management_flags_conflict")
	}
	for name := range visited {
		if _, management := selected[name]; management {
			continue
		}
		if name == "json" && action == "status" {
			continue
		}
		if name == "config" && (action == "install" || action == "reinstall" || action == "resume-install") {
			continue
		}
		return "", errors.New("management_flags_conflict")
	}
	return action, nil
}

func (m *installManager) execute(ctx context.Context, action string) (installationStatus, error) {
	status := installationStatus{Platform: m.paths.Platform, Service: serviceStatus{State: "not_installed"}, Connectivity: "not_checked", Autostart: "not_configured"}
	manifest, err := m.files.Load()
	if err != nil {
		return status, err
	}
	if manifest != nil {
		status.Installed = true
		for _, g := range manifest.Generations {
			if g.ID == manifest.Current {
				status.Version = g.Version
			}
		}
	}
	if action == "resume-install" {
		if m.paths.Config == "" || !filepath.IsAbs(m.paths.Config) {
			return status, errors.New("resume_requires_absolute_config")
		}
		if err = m.files.ConfigReady(m.paths.Config); err != nil {
			return status, err
		}
		if manifest != nil {
			if manifest.ConfigPath != m.paths.Config || status.Version != version {
				return status, errors.New("resume_installation_identity_mismatch")
			}
			sourceHash, sourceErr := bootstrapSourceSHA256(m.paths.Source)
			if sourceErr != nil {
				return status, sourceErr
			}
			matched := false
			for _, generation := range manifest.Generations {
				if generation.ID == manifest.Current && generation.BinarySHA256 == sourceHash {
					matched = true
				}
			}
			if !matched {
				return status, errors.New("resume_installation_identity_mismatch")
			}
			if err = m.files.Verify(manifest); err != nil {
				return status, err
			}
			status.ExecutablePath = m.paths.binary(manifest.Current)
			status.Service.State = "not_checked"
			return status, nil
		}
		action = "install"
	}
	if action == "install" {
		if manifest != nil {
			return status, errors.New("installation_already_exists_use_reinstall")
		}
		manifest, err = m.files.Install(nil, m.paths.Config)
		if err != nil {
			return status, err
		}
		status.Installed = true
		status.Version = version
		status.ExecutablePath = m.paths.binary(manifest.Current)
		status.Service.State = "not_checked"
		return status, nil
	}
	if manifest == nil {
		if action == "status" {
			return status, nil
		}
		return status, errors.New("installation_not_found")
	}
	if action == "uninstall" {
		if err = m.files.VerifyRemoval(manifest); err != nil {
			return status, err
		}
	} else {
		if err = m.files.Verify(manifest); err != nil {
			return status, err
		}
		status.ExecutablePath = m.paths.binary(manifest.Current)
	}
	servicePath := m.paths.service(manifest.Current)
	status.Service, err = m.service.Inspect(ctx, servicePath)
	if err != nil {
		return status, err
	}
	switch action {
	case "status":
		return status, nil
	case "start":
		if err = m.files.ConfigReady(manifest.ConfigPath); err != nil {
			return status, err
		}
		if err = m.service.Start(ctx, servicePath); err != nil {
			return status, err
		}
		status.Service, err = m.service.Inspect(ctx, servicePath)
		if err == nil && (status.Service.State != "running" || status.Service.PID <= 0) {
			return status, errors.New("service_start_not_confirmed")
		}
		return status, err
	case "stop":
		if err = m.service.Stop(ctx, servicePath); err != nil {
			return status, err
		}
		status.Service, err = m.service.Inspect(ctx, servicePath)
		return status, err
	case "reinstall", "uninstall":
		if status.Service.PID != 0 || (status.Service.State != "stopped" && status.Service.State != "failed") {
			return status, errors.New("service_must_be_stopped")
		}
		if action == "reinstall" {
			if m.paths.Config != "" && m.paths.Config != manifest.ConfigPath {
				return status, errors.New("reinstall_preserves_config_path")
			}
			if len(manifest.Generations) >= maxInstallGenerations {
				return status, errors.New("installation_version_limit_uninstall_first_config_is_preserved")
			}
			if err = m.files.ConfigReady(manifest.ConfigPath); err != nil {
				return status, err
			}
		}
		if status.Service.Registered {
			if err = m.service.Forget(ctx, servicePath); err != nil {
				return status, err
			}
		}
		if action == "uninstall" {
			if err = m.files.Remove(manifest); err != nil {
				return status, err
			}
			status.Installed = false
			status.Version = ""
			status.ExecutablePath = ""
			status.Service = serviceStatus{State: "not_installed"}
			return status, nil
		}
		updated, installErr := m.files.Install(manifest, manifest.ConfigPath)
		err = installErr
		if err == nil {
			status.Version = version
			status.ExecutablePath = m.paths.binary(updated.Current)
			status.Service = serviceStatus{State: "stopped"}
		}
		return status, err
	default:
		return status, errors.New("invalid_management_action")
	}
}

func manageInstallation(ctx context.Context, action, config string, jsonOutput bool, output io.Writer) error {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return errors.New("installation_platform_not_supported")
	}
	paths, err := currentInstallPaths(config)
	if err != nil {
		return err
	}
	storeAction := action
	if storeAction == "resume-install" {
		storeAction = "install"
	}
	files, err := openInstallationStore(paths, storeAction)
	if err != nil {
		return err
	}
	defer files.Close()
	manager := installManager{paths: paths, files: files, service: platformManagedService(paths, files)}
	bounded, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	status, err := manager.execute(bounded, action)
	if err != nil {
		return err
	}
	if jsonOutput {
		if json.NewEncoder(output).Encode(status) != nil {
			return errors.New("installation_output_failed")
		}
		return nil
	}
	_, err = fmt.Fprintf(output, "probe: installed=%t service=%s; server connectivity not checked; login startup not configured\n", status.Installed, status.Service.State)
	if err == nil && status.ExecutablePath != "" && (action == "install" || action == "reinstall" || action == "status" || action == "resume-install") {
		_, err = fmt.Fprintf(output, "probe: installed executable path (quoted display): %s\n", strconv.Quote(status.ExecutablePath))
	}
	if err != nil {
		return errors.New("installation_output_failed")
	}
	return nil
}
