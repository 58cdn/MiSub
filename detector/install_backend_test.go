package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeServiceCommands struct {
	platform, path      string
	registered, running bool
	commands            []serviceCommand
	fail                string
	output              string
}

func (f *fakeServiceCommands) Run(_ context.Context, c serviceCommand) (serviceCommandResult, error) {
	f.commands = append(f.commands, c)
	args := strings.Join(c.Args, " ")
	if f.fail != "" && strings.Contains(args, f.fail) {
		return serviceCommandResult{Output: "secret-manager-output", ExitCode: 5}, nil
	}
	if f.platform == "linux" {
		switch {
		case strings.Contains(args, " show "):
			if f.output != "" {
				return serviceCommandResult{Output: f.output}, nil
			}
			if !f.registered {
				return serviceCommandResult{Output: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nFragmentPath=\nUnitFileState=\nDropInPaths=\n", ExitCode: 4}, nil
			}
			state, sub, pid := "inactive", "dead", "0"
			if f.running {
				state, sub, pid = "active", "running", "123"
			}
			return serviceCommandResult{Output: "LoadState=loaded\nActiveState=" + state + "\nSubState=" + sub + "\nMainPID=" + pid + "\nFragmentPath=" + f.path + "\nUnitFileState=linked-runtime\nDropInPaths=\n"}, nil
		case strings.Contains(args, " link "):
			f.registered = true
			f.path = c.Args[len(c.Args)-1]
		case strings.Contains(args, " start "):
			f.running = true
		case strings.Contains(args, " stop "):
			f.running = false
		case strings.Contains(args, " disable "):
			f.registered = false
		}
	} else {
		switch c.Args[0] {
		case "print":
			if c.DiscardOutput {
				return serviceCommandResult{}, nil
			}
			if f.output != "" {
				return serviceCommandResult{Output: f.output}, nil
			}
			if !f.registered {
				return serviceCommandResult{ExitCode: 113}, nil
			}
			state := "not running"
			pid := ""
			if f.running {
				state = "running"
				pid = "\tpid = 123\n"
			}
			return serviceCommandResult{Output: "gui/501/com.misub.probe = {\n\tpath = " + f.path + "\n\tstate = " + state + "\n" + pid + "}\n"}, nil
		case "bootstrap":
			f.registered = true
			f.path = c.Args[2]
		case "kickstart":
			f.running = true
		case "bootout":
			f.registered = false
			f.running = false
		}
	}
	return serviceCommandResult{}, nil
}

func TestInstallationBackendExplicitLifecycle(t *testing.T) {
	for _, platform := range []string{"linux", "darwin"} {
		t.Run(platform, func(t *testing.T) {
			fake := &fakeServiceCommands{platform: platform}
			backend := newServiceBackend(installPaths{Platform: platform, UID: 501}, fake)
			ctx := context.Background()
			path := "/private/fixture/owned-service"
			if err := backend.Start(ctx, path); err != nil {
				t.Fatal(err)
			}
			if !fake.running || !fake.registered {
				t.Fatal("explicit start did not run")
			}
			before := len(fake.commands)
			if err := backend.Start(ctx, path); err != nil {
				t.Fatal(err)
			}
			for _, c := range fake.commands[before:] {
				if c.Args[0] == "kickstart" || strings.Contains(strings.Join(c.Args, " "), " start ") {
					t.Fatal("idempotent start restarted service")
				}
			}
			if err := backend.Forget(ctx, path); err == nil {
				t.Fatal("running service unregistered")
			}
			if err := backend.Stop(ctx, path); err != nil {
				t.Fatal(err)
			}
			if err := backend.Forget(ctx, path); err != nil {
				t.Fatal(err)
			}
			if fake.running || fake.registered {
				t.Fatal("explicit stop/unregister failed")
			}
			for _, c := range fake.commands {
				for _, arg := range c.Args {
					if arg == "enable" || arg == "sudo" || arg == "--system" || arg == "-k" || strings.Contains(arg, "linger") {
						t.Fatal("unexpected privileged or startup action")
					}
				}
				if c.Program != "/usr/bin/systemctl" && c.Program != "/bin/launchctl" {
					t.Fatal("PATH-resolved program")
				}
			}
		})
	}
}

func TestInstallationBackendRejectsUnknownOwnershipAndErrors(t *testing.T) {
	for _, platform := range []string{"linux", "darwin"} {
		fake := &fakeServiceCommands{platform: platform, registered: true, path: "/another/installation", running: true}
		backend := newServiceBackend(installPaths{Platform: platform, UID: 501}, fake)
		for _, action := range []func(context.Context, string) error{backend.Start, backend.Stop, backend.Forget} {
			if action(context.Background(), "/ours") == nil {
				t.Fatal("foreign service modified")
			}
		}
		for _, command := range fake.commands {
			if command.Args[0] != "print" && !strings.Contains(strings.Join(command.Args, " "), " show ") {
				t.Fatal("foreign registration mutation")
			}
		}
		fake = &fakeServiceCommands{platform: platform, output: "secret-manager-output"}
		backend = newServiceBackend(installPaths{Platform: platform, UID: 501}, fake)
		_, err := backend.Inspect(context.Background(), "/ours")
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("unrecognized output accepted or disclosed")
		}
	}
}

func TestInstallationServiceRenderingDoesNotExpandUserPaths(t *testing.T) {
	path := "/home/fixture/space & dollar$ percent%"
	linux, err := renderInstallService(installPaths{Root: path, Platform: "linux"}, "fixture", path+"/quote\"-backslash\\-probe.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"ExecStart=:\"", "Restart=no", "KillMode=control-group", "TimeoutStopSec=20", "dollar$", "%%", "\\\"", "\\\\"} {
		if !strings.Contains(string(linux), fragment) {
			t.Errorf("missing %q", fragment)
		}
	}
	for _, fragment := range []string{"[Install]", "WantedBy", "network-online", "PrivateTmp", "$$"} {
		if strings.Contains(string(linux), fragment) {
			t.Errorf("unexpected %q", fragment)
		}
	}
	for _, unsupported := range []string{"'", "\"", "\\", "\t", "\x7f"} {
		if _, err := renderInstallService(installPaths{Root: path + unsupported, Platform: "linux"}, "fixture", path+"/probe.json"); err == nil {
			t.Fatal("unsupported systemd executable path accepted")
		}
	}
	mac, err := renderInstallService(installPaths{Root: path + "quote\"", Platform: "darwin"}, "fixture", path+"/probe.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"&amp;", "&#34;", "<key>RunAtLoad</key><false/>", "<key>KeepAlive</key><false/>", "<key>Umask</key><integer>63</integer>"} {
		if !strings.Contains(string(mac), fragment) {
			t.Errorf("missing %q", fragment)
		}
	}
	if _, err := systemdArgument("/bad\nExecStart=secret"); err == nil {
		t.Fatal("newline unit injection accepted")
	}
}

type memoryInstallationStore struct {
	manifest                  *installManifest
	installs, removes, checks int
	verifyErr, configErr      error
}

func (s *memoryInstallationStore) Load() (*installManifest, error)      { return s.manifest, nil }
func (s *memoryInstallationStore) Verify(*installManifest) error        { return s.verifyErr }
func (s *memoryInstallationStore) VerifyRemoval(*installManifest) error { return s.verifyErr }
func (s *memoryInstallationStore) Install(previous *installManifest, config string) (*installManifest, error) {
	s.installs++
	s.manifest = &installManifest{Current: "fixture", ConfigPath: config, Generations: []installGeneration{{ID: "fixture", Version: version}}}
	return s.manifest, nil
}
func (s *memoryInstallationStore) Remove(*installManifest) error {
	s.removes++
	s.manifest = nil
	return nil
}
func (s *memoryInstallationStore) ConfigReady(string) error { s.checks++; return s.configErr }
func (s *memoryInstallationStore) Close() error             { return nil }

func TestInstallationManagerInstallNeverContactsServiceOrReadsConfig(t *testing.T) {
	files := &memoryInstallationStore{}
	runner := &fakeServiceCommands{platform: "linux"}
	paths := installPaths{Platform: "linux", Config: "/private/probe.json", Root: "/private/install"}
	manager := installManager{paths: paths, files: files, service: newServiceBackend(paths, runner)}
	status, err := manager.execute(context.Background(), "install")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Installed || status.Connectivity != "not_checked" || status.ExecutablePath != paths.binary("fixture") || len(runner.commands) != 0 || files.checks != 0 || files.installs != 1 {
		t.Fatal("installation started or paired implicitly")
	}
	if _, err = manager.execute(context.Background(), "install"); err == nil || files.installs != 1 {
		t.Fatal("existing installation overwritten")
	}
	files.verifyErr = errors.New("fixture modified")
	if status, err = manager.execute(context.Background(), "start"); err == nil || len(runner.commands) != 0 || status.ExecutablePath != "" {
		t.Fatal("modified installation reached manager")
	}
}

func TestInstallationManagerPreservesConfigurationAndRequiresStoppedProcess(t *testing.T) {
	files := &memoryInstallationStore{manifest: &installManifest{Current: "fixture", ConfigPath: "/private/probe.json"}}
	paths := installPaths{Platform: "linux", Root: "/private/install"}
	runner := &fakeServiceCommands{platform: "linux", registered: true, running: true, path: paths.service("fixture")}
	manager := installManager{paths: paths, files: files, service: newServiceBackend(paths, runner)}
	for _, action := range []string{"uninstall", "reinstall"} {
		if _, err := manager.execute(context.Background(), action); err == nil || files.removes != 0 || files.installs != 0 {
			t.Fatal("running installation mutated")
		}
	}
	runner.running = false
	if status, err := manager.execute(context.Background(), "reinstall"); err != nil || status.ExecutablePath != paths.binary("fixture") {
		t.Fatalf("reinstall path unavailable: %v", err)
	}
	if files.manifest.ConfigPath != "/private/probe.json" || files.checks != 1 {
		t.Fatal("configuration not preserved")
	}
	if status, err := manager.execute(context.Background(), "status"); err != nil || status.ExecutablePath != paths.binary("fixture") {
		t.Fatalf("verified status path unavailable: %v", err)
	}
	if status, err := manager.execute(context.Background(), "uninstall"); err != nil || status.ExecutablePath != "" {
		t.Fatalf("uninstall retained executable path: %v", err)
	}
	if files.removes != 1 || files.checks != 1 {
		t.Fatal("uninstall touched configuration")
	}
}

func TestInstallationActionsAreMutuallyExclusive(t *testing.T) {
	selected := map[string]bool{"install": true, "start": true}
	if _, err := installationAction(selected, map[string]bool{}, 0); err == nil {
		t.Fatal("multiple actions accepted")
	}
	for _, flag := range []string{"pair", "once", "self-test", "server", "version", "pair-name"} {
		if _, err := installationAction(map[string]bool{"install": true}, map[string]bool{flag: true}, 0); err == nil {
			t.Errorf("combined %s", flag)
		}
	}
	if _, err := installationAction(map[string]bool{"start": true}, map[string]bool{"json": true}, 0); err == nil {
		t.Fatal("json accepted outside status")
	}
	if action, err := installationAction(map[string]bool{"status": true}, map[string]bool{"status": true, "json": true}, 0); err != nil || action != "status" {
		t.Fatal("status JSON rejected")
	}
}
