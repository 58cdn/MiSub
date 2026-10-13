package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func setupFixtureOptions(t *testing.T) bootstrapSetupOptions {
	t.Helper()
	return bootstrapSetupOptions{Pair: pairOptions{Server: "https://fixture.invalid", WindowID: "00000000-0000-0000-0000-000000000000", Name: "Fixture", ConfigPath: filepath.Join(t.TempDir(), "probe.json")}}
}

type setupFixture struct {
	calls     []string
	fail      string
	status    installationStatus
	statuses  int
	locked    bool
	paired    bool
	installed bool
}

func (f *setupFixture) step(name string) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New("fixture_" + name)
	}
	return nil
}

func (f *setupFixture) operations(t *testing.T) bootstrapSetupOperations {
	t.Helper()
	return bootstrapSetupOperations{
		lock: func(string) (func(), error) {
			if err := f.step("lock"); err != nil {
				return nil, err
			}
			f.locked = true
			return func() { f.locked = false; f.calls = append(f.calls, "unlock") }, nil
		},
		preflight: func(string) error { return f.step("preflight") },
		pair: func(_ context.Context, _ pairOptions, _ io.Writer) error {
			if !f.locked {
				t.Fatal("identity created outside setup lock")
			}
			if err := f.step("pair"); err != nil {
				return err
			}
			f.paired = true
			return nil
		},
		check: func(string) error { return f.step("check") },
		manage: func(_ context.Context, action, config string, jsonOutput bool, output io.Writer) error {
			if !f.locked {
				t.Fatal("installation operation outside setup lock")
			}
			if err := f.step(action); err != nil {
				return err
			}
			if action == "status" {
				if !jsonOutput || config != "" {
					t.Fatal("status received mutation options")
				}
				f.statuses++
				status := f.status
				if f.installed {
					status.Installed = true
					status.Service = serviceStatus{State: "running", PID: 1234}
				}
				return json.NewEncoder(output).Encode(status)
			}
			if jsonOutput || action == "start" && config != "" || action != "start" && config == "" {
				t.Fatal("management action received incompatible options")
			}
			if action == "install" || action == "resume-install" {
				f.installed = true
			}
			return nil
		},
	}
}

func TestBootstrapSetupNewAndResume(t *testing.T) {
	for _, resume := range []bool{false, true} {
		options := setupFixtureOptions(t)
		options.Resume = resume
		if resume {
			options.Pair.Server, options.Pair.WindowID = "", ""
		}
		fixture := new(setupFixture)
		var output bytes.Buffer
		if err := runBootstrapSetup(context.Background(), options, &output, fixture.operations(t)); err != nil {
			t.Fatal(err)
		}
		want := []string{"lock", "preflight", "status", "pair", "check", "install", "start", "status", "unlock"}
		if resume {
			want = []string{"lock", "check", "resume-install", "start", "status", "unlock"}
		}
		if !reflect.DeepEqual(fixture.calls, want) || fixture.locked || fixture.paired == resume || !strings.Contains(output.String(), "setup_started") {
			t.Fatalf("unsafe setup order: %v", fixture.calls)
		}
	}
}

func TestBootstrapSetupStopsAtEveryFailedStep(t *testing.T) {
	for _, step := range []string{"lock", "preflight", "status", "pair", "check", "install", "start"} {
		t.Run(step, func(t *testing.T) {
			fixture := &setupFixture{fail: step}
			options := setupFixtureOptions(t)
			if err := runBootstrapSetup(context.Background(), options, io.Discard, fixture.operations(t)); err == nil || !strings.Contains(err.Error(), "fixture_"+step) {
				t.Fatalf("failure lost: %v", err)
			}
			if fixture.locked {
				t.Fatal("setup lock leaked")
			}
			for index, action := range fixture.calls {
				if action == step && index+1 < len(fixture.calls) && !reflect.DeepEqual(fixture.calls[index+1:], []string{"unlock"}) {
					t.Fatalf("failure retried or continued: %v", fixture.calls)
				}
			}
			if (step == "check" || step == "install" || step == "start") && !fixture.paired {
				t.Fatal("successful pairing state was not preserved")
			}
		})
	}
}

func TestBootstrapSetupPairingErrorsAreNeverRetried(t *testing.T) {
	for _, code := range []string{"pairing_cancelled_or_expired_cancel_window_in_misub", "pairing_delivery_uncertain_revoke_in_misub_before_pairing_again", "pairing_config_save_failed_revoke_in_misub_before_pairing_again"} {
		fixture := new(setupFixture)
		ops := fixture.operations(t)
		count := 0
		ops.pair = func(context.Context, pairOptions, io.Writer) error { count++; return errors.New(code) }
		err := runBootstrapSetup(context.Background(), setupFixtureOptions(t), io.Discard, ops)
		if err == nil || err.Error() != code || count != 1 || fixture.installed || fixture.locked {
			t.Fatalf("pairing recovery changed: %v, count=%d", err, count)
		}
	}
}

func TestBootstrapSetupPreservesExistingInstallation(t *testing.T) {
	fixture := &setupFixture{status: installationStatus{Installed: true}}
	err := runBootstrapSetup(context.Background(), setupFixtureOptions(t), io.Discard, fixture.operations(t))
	if err == nil || !strings.Contains(err.Error(), "existing_installation_preserved") || fixture.paired || fixture.installed || fixture.locked {
		t.Fatal("existing installation was modified")
	}
}

func TestBootstrapSetupResumeNeverPairsAfterFailure(t *testing.T) {
	for _, step := range []string{"check", "resume-install", "start", "status"} {
		fixture := &setupFixture{fail: step}
		options := setupFixtureOptions(t)
		options.Resume, options.Pair.Server, options.Pair.WindowID = true, "", ""
		if err := runBootstrapSetup(context.Background(), options, io.Discard, fixture.operations(t)); err == nil || fixture.paired || fixture.locked {
			t.Fatal("failed resume paired or kept lock")
		}
	}
}

func TestBootstrapSetupCancellationAndOutputFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fixture := new(setupFixture)
	if err := runBootstrapSetup(ctx, setupFixtureOptions(t), io.Discard, fixture.operations(t)); err == nil || len(fixture.calls) != 0 {
		t.Fatal("cancelled setup performed work")
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	ops := fixture.operations(t)
	ops.pair = func(context.Context, pairOptions, io.Writer) error { fixture.paired = true; cancel(); return nil }
	if err := runBootstrapSetup(ctx, setupFixtureOptions(t), io.Discard, ops); err == nil || !fixture.paired || fixture.installed || fixture.locked {
		t.Fatal("post-pair cancellation mutated installation")
	}
	fixture = new(setupFixture)
	if err := runBootstrapSetup(context.Background(), setupFixtureOptions(t), failingBootstrapWriter{}, fixture.operations(t)); err == nil || fixture.paired || fixture.locked {
		t.Fatal("pairing proceeded without visible approval instructions")
	}
}

func TestBootstrapSetupRequiresConfirmedProcess(t *testing.T) {
	for _, state := range []serviceStatus{{State: "stopped"}, {State: "running"}, {State: "running", PID: -1}} {
		fixture := new(setupFixture)
		ops := fixture.operations(t)
		manage := ops.manage
		ops.manage = func(ctx context.Context, action, config string, jsonOutput bool, out io.Writer) error {
			if action == "status" && fixture.installed {
				return json.NewEncoder(out).Encode(installationStatus{Installed: true, Service: state})
			}
			return manage(ctx, action, config, jsonOutput, out)
		}
		if err := runBootstrapSetup(context.Background(), setupFixtureOptions(t), io.Discard, ops); err == nil || !strings.Contains(err.Error(), "not_confirmed") {
			t.Fatal("setup claimed running without a positive PID")
		}
	}
}

func TestBootstrapSetupRejectsOptionsBeforeLocalOrNetworkWork(t *testing.T) {
	for _, mutate := range []func(*bootstrapSetupOptions){
		func(o *bootstrapSetupOptions) { o.Pair.ConfigPath = "probe.json" },
		func(o *bootstrapSetupOptions) { o.Pair.Server = "http://fixture.invalid" },
		func(o *bootstrapSetupOptions) { o.Pair.WindowID = "expired" },
		func(o *bootstrapSetupOptions) { o.Resume = true },
	} {
		fixture := new(setupFixture)
		options := setupFixtureOptions(t)
		mutate(&options)
		if err := runBootstrapSetup(context.Background(), options, io.Discard, fixture.operations(t)); err == nil || len(fixture.calls) != 0 {
			t.Fatal("invalid options reached local or remote work")
		}
	}
}

func TestBootstrapSetupFlagIsolation(t *testing.T) {
	fresh := map[string]bool{"setup": true, "config": true, "server": true, "pair-window": true}
	resume := map[string]bool{"setup": true, "resume": true, "config": true}
	if bootstrapSetupFlags(true, false, fresh, 0) != nil || bootstrapSetupFlags(true, true, resume, 0) != nil {
		t.Fatal("valid setup flags rejected")
	}
	for _, flags := range []map[string]bool{{"resume": true}, {"setup": true}, {"setup": true, "config": true}, {"setup": true, "resume": true, "config": true, "server": true}, {"setup": true, "resume": true, "config": true, "pair": true}, {"setup": true, "resume": true, "config": true, "start": true}} {
		if bootstrapSetupFlags(flags["setup"], flags["resume"], flags, 0) == nil {
			t.Fatalf("incompatible setup flags accepted: %v", flags)
		}
	}
	if bootstrapSetupFlags(false, false, fresh, 0) == nil || bootstrapSetupFlags(true, false, fresh, 1) == nil || bootstrapSetupFlags(true, false, resume, 0) == nil {
		t.Fatal("disabled flags or arguments accepted")
	}
}

func TestBootstrapSetupPairingGuidancePreservesProtocol(t *testing.T) {
	fixture := newPairingFixture(t)
	err := fixture.client.pair(context.Background(), pairOptions{WindowID: fixturePairWindow, Name: "Fixture Probe", Setup: true}, fixture.store, &fixture.output)
	if err != nil || fixture.starts.Load() != 1 || fixture.store.saves != 1 {
		t.Fatalf("setup pairing failed: %v", err)
	}
	if !strings.Contains(fixture.output.String(), "continuing the approved installation and startup") || strings.Contains(fixture.output.String(), "start the detector separately") {
		t.Fatal("setup pairing guidance does not describe the next action")
	}
	fixture.assertNoSecrets(err)
}
