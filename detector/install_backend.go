package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type serviceCommand struct {
	Program       string
	Args          []string
	DiscardOutput bool
}
type serviceCommandResult struct {
	Output   string
	ExitCode int
}
type serviceCommandRunner interface {
	Run(context.Context, serviceCommand) (serviceCommandResult, error)
}

type nativeCommandRunner struct{ home string }
type boundedServiceOutput struct {
	bytes.Buffer
	overflow bool
}

func (b *boundedServiceOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 65536 - b.Len()
	if len(p) > remaining {
		p = p[:max(0, remaining)]
		b.overflow = true
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

func (r *nativeCommandRunner) Run(ctx context.Context, command serviceCommand) (serviceCommandResult, error) {
	if err := validateServiceExecutable(command.Program); err != nil {
		return serviceCommandResult{}, err
	}
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, command.Program, command.Args...)
	cmd.Env = []string{"HOME=" + r.home, "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"}
	for _, key := range []string{"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if value := os.Getenv(key); value != "" {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	var buffer boundedServiceOutput
	cmd.Stdout = &buffer
	if command.DiscardOutput {
		cmd.Stdout = io.Discard
	}
	cmd.Stderr = io.Discard
	err := cmd.Run()
	if child.Err() != nil || buffer.overflow {
		return serviceCommandResult{}, errors.New("service_manager_unavailable")
	}
	result := serviceCommandResult{Output: buffer.String()}
	if err != nil {
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			return result, errors.New("service_manager_unavailable")
		}
		result.ExitCode = exited.ExitCode()
	}
	return result, nil
}

type serviceBackend struct {
	paths  installPaths
	runner serviceCommandRunner
}

func newServiceBackend(paths installPaths, runner serviceCommandRunner) *serviceBackend {
	return &serviceBackend{paths, runner}
}
func (b *serviceBackend) target() string {
	return "gui/" + strconv.Itoa(b.paths.UID) + "/com.misub.probe"
}
func (b *serviceBackend) run(ctx context.Context, discard bool, args ...string) (serviceCommandResult, error) {
	program := "/usr/bin/systemctl"
	if b.paths.Platform == "darwin" {
		program = "/bin/launchctl"
	}
	return b.runner.Run(ctx, serviceCommand{Program: program, Args: args, DiscardOutput: discard})
}

func (b *serviceBackend) Inspect(ctx context.Context, servicePath string) (serviceStatus, error) {
	unknown := serviceStatus{State: "unknown"}
	if b.paths.Platform == "linux" {
		result, err := b.run(ctx, false, "--user", "--no-pager", "show", "misub-probe.service", "--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,UnitFileState,DropInPaths")
		if err != nil {
			return unknown, err
		}
		fields := map[string]string{}
		for _, line := range strings.Split(strings.TrimSpace(result.Output), "\n") {
			key, value, ok := strings.Cut(strings.TrimSuffix(line, "\r"), "=")
			_, duplicate := fields[key]
			if !ok || duplicate {
				return unknown, errors.New("service_status_unrecognized")
			}
			fields[key] = value
		}
		if (result.ExitCode == 0 || result.ExitCode == 4) && fields["LoadState"] == "not-found" && fields["ActiveState"] == "inactive" && fields["MainPID"] == "0" && fields["FragmentPath"] == "" {
			return serviceStatus{State: "stopped"}, nil
		}
		if result.ExitCode != 0 {
			return unknown, errors.New("service_manager_unavailable")
		}
		if fields["LoadState"] != "loaded" || fields["FragmentPath"] != servicePath || fields["UnitFileState"] != "linked-runtime" || fields["DropInPaths"] != "" {
			return unknown, errors.New("service_registration_conflict")
		}
		pid, err := strconv.Atoi(fields["MainPID"])
		if err != nil || pid < 0 {
			return unknown, errors.New("service_status_unrecognized")
		}
		state := fields["ActiveState"]
		switch {
		case state == "active" && fields["SubState"] == "running" && pid > 0:
			state = "running"
		case state == "inactive" && pid == 0:
			state = "stopped"
		case state == "failed" && pid == 0:
			state = "failed"
		case state == "activating" || state == "deactivating":
			state = "transitioning"
		default:
			return unknown, errors.New("service_status_unrecognized")
		}
		return serviceStatus{State: state, PID: pid, Registered: true}, nil
	}
	if b.paths.Platform != "darwin" {
		return unknown, errors.New("installation_platform_not_supported")
	}
	domain, err := b.run(ctx, true, "print", "gui/"+strconv.Itoa(b.paths.UID))
	if err != nil || domain.ExitCode != 0 {
		return unknown, errors.New("user_service_session_unavailable")
	}
	result, err := b.run(ctx, false, "print", b.target())
	if err != nil {
		return unknown, err
	}
	if result.ExitCode == 113 || result.ExitCode == 3 {
		return serviceStatus{State: "stopped"}, nil
	}
	if result.ExitCode != 0 {
		return unknown, errors.New("service_manager_unavailable")
	}
	// launchctl print is diagnostic text. Unknown layouts fail closed.
	fields := map[string]string{}
	for _, line := range strings.Split(result.Output, "\n") {
		if !strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "\t\t") {
			continue
		}
		key, value, ok := strings.Cut(strings.TrimSpace(line), " = ")
		if !ok {
			continue
		}
		if key == "path" || key == "state" || key == "pid" {
			if _, seen := fields[key]; seen {
				return unknown, errors.New("service_status_unrecognized")
			}
			fields[key] = value
		}
	}
	if fields["path"] != servicePath {
		return unknown, errors.New("service_registration_conflict")
	}
	if fields["state"] == "not running" && fields["pid"] == "" {
		return serviceStatus{State: "stopped", Registered: true}, nil
	}
	pid, err := strconv.Atoi(fields["pid"])
	if fields["state"] != "running" || err != nil || pid <= 0 {
		return unknown, errors.New("service_status_unrecognized")
	}
	return serviceStatus{State: "running", PID: pid, Registered: true}, nil
}

func (b *serviceBackend) commandOK(ctx context.Context, args ...string) error {
	result, err := b.run(ctx, true, args...)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return errors.New("service_command_failed_check_status")
	}
	return nil
}

func (b *serviceBackend) Start(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if state.State == "running" {
		return nil
	}
	if state.State != "stopped" && state.State != "failed" {
		return errors.New("service_state_not_stable")
	}
	if b.paths.Platform == "linux" {
		if !state.Registered {
			if err = b.commandOK(ctx, "--user", "--runtime", "link", path); err != nil {
				return err
			}
			if err = b.commandOK(ctx, "--user", "daemon-reload"); err != nil {
				return err
			}
		}
		if _, err = b.Inspect(ctx, path); err != nil {
			return err
		}
		return b.commandOK(ctx, "--user", "start", "misub-probe.service")
	}
	if !state.Registered {
		if err = b.commandOK(ctx, "bootstrap", "gui/"+strconv.Itoa(b.paths.UID), path); err != nil {
			return err
		}
	}
	if _, err = b.Inspect(ctx, path); err != nil {
		return err
	}
	return b.commandOK(ctx, "kickstart", b.target())
}

func (b *serviceBackend) Stop(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if !state.Registered {
		return nil
	}
	if b.paths.Platform == "darwin" {
		if err = b.commandOK(ctx, "bootout", b.target()); err != nil {
			return err
		}
	} else {
		if err = b.commandOK(ctx, "--user", "stop", "misub-probe.service"); err != nil {
			return err
		}
	}
	for attempt := 0; attempt < 20; attempt++ {
		state, err = b.Inspect(ctx, path)
		if err != nil {
			return err
		}
		if state.PID == 0 && (state.State == "stopped" || state.State == "failed") {
			return nil
		}
		if !sleep(ctx, 250*time.Millisecond) {
			break
		}
	}
	return errors.New("service_stop_not_confirmed")
}

func (b *serviceBackend) Forget(ctx context.Context, path string) error {
	state, err := b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if !state.Registered {
		return nil
	}
	if state.PID != 0 || (state.State != "stopped" && state.State != "failed") {
		return errors.New("service_must_be_stopped")
	}
	if b.paths.Platform == "darwin" {
		err = b.commandOK(ctx, "bootout", b.target())
	} else {
		if err = b.commandOK(ctx, "--user", "--runtime", "disable", "misub-probe.service"); err == nil {
			err = b.commandOK(ctx, "--user", "daemon-reload")
		}
	}
	if err != nil {
		return err
	}
	state, err = b.Inspect(ctx, path)
	if err != nil {
		return err
	}
	if state.Registered {
		return errors.New("service_unregistration_not_confirmed")
	}
	return nil
}

func systemdArgument(value string) (string, error) {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return "", errors.New("invalid_service_path")
		}
	}
	// ExecStart's ':' prefix disables environment expansion for every argument.
	// Unit specifiers still expand, so literal percent signs must be doubled.
	value = strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%").Replace(value)
	return "\"" + value + "\"", nil
}

func renderInstallService(paths installPaths, id, config string) ([]byte, error) {
	binary := paths.binary(id)
	if paths.Platform == "linux" {
		// systemd rejects these characters in the executable even when quoted.
		if strings.ContainsAny(binary, "'\"\\") {
			return nil, errors.New("installation_executable_path_unsupported")
		}
		exe, err := systemdArgument(binary)
		if err != nil {
			return nil, err
		}
		cfg, err := systemdArgument(config)
		if err != nil {
			return nil, err
		}
		return []byte("[Unit]\nDescription=MiSub user node detector\n\n[Service]\nType=exec\nExecStart=:" + exe + " --config " + cfg + "\nRestart=no\nUMask=0077\nNoNewPrivileges=true\nKillMode=control-group\nTimeoutStopSec=20\n"), nil
	}
	if paths.Platform != "darwin" {
		return nil, errors.New("installation_platform_not_supported")
	}
	var executable, configuration bytes.Buffer
	if strings.ContainsAny(binary+config, "\x00\r\n") {
		return nil, errors.New("invalid_service_path")
	}
	if xml.EscapeText(&executable, []byte(binary)) != nil || xml.EscapeText(&configuration, []byte(config)) != nil {
		return nil, errors.New("invalid_service_path")
	}
	return []byte(fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.misub.probe</string>\n<key>ProgramArguments</key><array><string>%s</string><string>--config</string><string>%s</string></array>\n<key>RunAtLoad</key><false/>\n<key>KeepAlive</key><false/>\n<key>Umask</key><integer>63</integer>\n<key>ExitTimeOut</key><integer>20</integer>\n<key>AbandonProcessGroup</key><false/>\n</dict></plist>\n", executable.String(), configuration.String())), nil
}
