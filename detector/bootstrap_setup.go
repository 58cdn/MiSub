package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"time"
)

type bootstrapSetupOptions struct {
	Pair   pairOptions
	Resume bool
}

type bootstrapSetupOperations struct {
	lock      func(string) (func(), error)
	preflight func(string) error
	pair      func(context.Context, pairOptions, io.Writer) error
	check     func(string) error
	manage    func(context.Context, string, string, bool, io.Writer) error
}

func bootstrapSetupFlags(setup, resume bool, visited map[string]bool, arguments int) error {
	if !setup || arguments != 0 || !visited["config"] || visited["resume"] && !resume {
		return errors.New("setup_flags_conflict")
	}
	allowed := map[string]bool{"setup": true, "config": true}
	if resume {
		allowed["resume"] = true
	} else {
		allowed["server"], allowed["pair-window"], allowed["pair-name"] = true, true, true
		if !visited["server"] || !visited["pair-window"] {
			return errors.New("setup_requires_server_and_pair_window")
		}
	}
	for flag := range visited {
		if !allowed[flag] {
			return errors.New("setup_flags_conflict")
		}
	}
	return nil
}

func bootstrapSetupPreflight(config string) error {
	// Validate local installation privileges and paths before requesting identity.
	if _, err := currentInstallPaths(config); err != nil {
		return err
	}
	store, err := preparePairingConfig(config)
	if err != nil {
		return err
	}
	return store.Close()
}

func setupProbe(ctx context.Context, options bootstrapSetupOptions, output io.Writer) error {
	options.Pair.Setup = true
	return runBootstrapSetup(ctx, options, output, bootstrapSetupOperations{
		lock:      acquireBootstrapSetupLock,
		preflight: bootstrapSetupPreflight,
		pair:      pairDevice,
		check: func(path string) error {
			_, err := readConfig(path)
			return err
		},
		manage: manageInstallation,
	})
}

func runBootstrapSetup(parent context.Context, options bootstrapSetupOptions, output io.Writer, operations bootstrapSetupOperations) error {
	if options.Pair.ConfigPath == "" || !filepath.IsAbs(options.Pair.ConfigPath) || filepath.Clean(options.Pair.ConfigPath) != options.Pair.ConfigPath {
		return errors.New("setup_requires_absolute_config_path")
	}
	if options.Resume {
		if options.Pair.Server != "" || options.Pair.WindowID != "" {
			return errors.New("setup_resume_does_not_pair")
		}
	} else if _, err := pairingOrigin(options.Pair.Server); err != nil || !pairingIDPattern.MatchString(options.Pair.WindowID) || !validPairingName(options.Pair.Name) {
		return errors.New("invalid_pairing_options")
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Minute)
	defer cancel()
	if ctx.Err() != nil {
		return errors.New("setup_cancelled")
	}
	unlock, err := operations.lock(options.Pair.ConfigPath)
	if err != nil {
		return err
	}
	defer unlock()
	if !options.Resume {
		if err := operations.preflight(options.Pair.ConfigPath); err != nil {
			return err
		}
		status, err := bootstrapSetupStatus(ctx, operations)
		if err != nil {
			return err
		}
		if status.Installed {
			return errors.New("setup_existing_installation_preserved_use_resume")
		}
		if ctx.Err() != nil {
			return errors.New("setup_cancelled")
		}
		if _, err = fmt.Fprintln(output, "probe: compare the site, pairing code and fingerprint in MiSub; approving will install and start this detector"); err != nil {
			return errors.New("setup_output_unavailable")
		}
		// Pairing owns the single credential exchange and preserves its recovery errors.
		if err = operations.pair(ctx, options.Pair, output); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return errors.New("setup_cancelled_configuration_preserved")
	}
	if err := operations.check(options.Pair.ConfigPath); err != nil {
		return err
	}
	action := "install"
	if options.Resume {
		action = "resume-install"
	}
	if ctx.Err() != nil {
		return errors.New("setup_cancelled_configuration_preserved")
	}
	if err := operations.manage(ctx, action, options.Pair.ConfigPath, false, output); err != nil {
		return fmt.Errorf("setup_install_failed_configuration_preserved_use_resume: %w", err)
	}
	if ctx.Err() != nil {
		return errors.New("setup_cancelled_configuration_preserved")
	}
	if err := operations.manage(ctx, "start", "", false, output); err != nil {
		return fmt.Errorf("setup_start_failed_configuration_preserved_use_resume: %w", err)
	}
	status, err := bootstrapSetupStatus(ctx, operations)
	if err != nil {
		return err
	}
	if !status.Installed || status.Service.State != "running" || status.Service.PID <= 0 {
		return errors.New("setup_running_process_not_confirmed_configuration_preserved")
	}
	if _, err = fmt.Fprintln(output, "probe: setup_started; configuration preserved; check the heartbeat in MiSub to confirm server connectivity"); err != nil {
		return errors.New("setup_started_output_unavailable")
	}
	return nil
}

func acquireBootstrapSetupLock(config string) (func(), error) {
	paths, err := currentInstallPaths(config)
	if err != nil {
		return nil, err
	}
	return lockBootstrapSetupDirectory(filepath.Dir(paths.Root))
}

func bootstrapSetupStatus(ctx context.Context, operations bootstrapSetupOperations) (installationStatus, error) {
	var status installationStatus
	if ctx.Err() != nil {
		return status, errors.New("setup_cancelled_configuration_preserved")
	}
	var data bytes.Buffer
	if err := operations.manage(ctx, "status", "", true, &data); err != nil {
		return status, err
	}
	if data.Len() > 32768 {
		return status, errors.New("setup_invalid_installation_status")
	}
	decoder := json.NewDecoder(&data)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&status) != nil || decoder.Decode(new(any)) != io.EOF {
		return status, errors.New("setup_invalid_installation_status")
	}
	return status, nil
}
