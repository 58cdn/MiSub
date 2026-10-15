package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	path := flag.String("config", "probe.json", "Private configuration file (owner-only POSIX permissions or Windows ACL)")
	once := flag.Bool("once", false, "Process at most one task, then exit")
	showVersion := flag.Bool("version", false, "Print detector and pinned kernel versions")
	capabilities := flag.Bool("capabilities", false, "Print the offline bootstrap capability protocol, version, revision and native target")
	checkConfig := flag.Bool("check-config", false, "Validate configuration without sending it anywhere")
	doctor := flag.Bool("doctor", false, "Report local read-only checks; no service query, kernel execution or network request")
	selfTest := flag.Bool("self-test", false, "Verify and execute the embedded kernel version; no node or API request")
	pair := flag.Bool("pair", false, "Pair with browser approval, save private configuration, then exit")
	setup := flag.Bool("setup", false, "Pair with browser approval, install and start the detector")
	resume := flag.Bool("resume", false, "With --setup, preserve existing configuration and resume the exact installation")
	pairServer := flag.String("server", "", "HTTPS MiSub origin for pairing")
	pairWindow := flag.String("pair-window", "", "Public pairing window ID from MiSub settings")
	pairName := flag.String("pair-name", "MiSub Probe", "Detector display name; no machine username is sent")
	managedRun := flag.String("managed-run", "", "Internal managed-process instance; requires a matching private runtime record")
	managementFlags := map[string]*bool{}
	for _, action := range []string{"install", "start", "stop", "status", "uninstall", "reinstall", "resume-install"} {
		managementFlags[action] = flag.Bool(action, false, "User installation management: "+action+" (no login startup)")
	}
	jsonOutput := flag.Bool("json", false, "Print installation --status or local --doctor as JSON")
	flag.Parse()
	selected, visited := map[string]bool{}, map[string]bool{}
	for action, value := range managementFlags {
		selected[action] = *value
	}
	flag.Visit(func(f *flag.Flag) { visited[f.Name] = true })
	// A diagnostic flag can follow a positional argument or be consumed as a
	// missing string value. Neither case may enter the normal execution path.
	if !visited["doctor"] && doctorRequested(os.Args[1:]) {
		fmt.Fprintln(os.Stderr, "probe: doctor_flags_conflict")
		os.Exit(2)
	}
	if visited["doctor"] {
		if err := doctorFlags(*doctor, visited, flag.NArg()); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(2)
		}
		report := collectDoctor(nativeDoctorHost{}, doctorEnvironment{Target: nativeBootstrapTarget(), Version: version, Revision: commit, BuildChannel: buildChannel, SourceState: buildSourceState, Now: time.Now()}, doctorOptions{ConfigPath: *path, ConfigExplicit: visited["config"]})
		if err := writeDoctorReport(os.Stdout, report, *jsonOutput); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		if report.Status != "local_checks_passed" {
			os.Exit(1)
		}
		return
	}
	if visited["capabilities"] {
		if !*capabilities || len(visited) != 1 || flag.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "probe: capabilities_flags_conflict")
			os.Exit(1)
		}
		if err := writeBootstrapCapabilities(os.Stdout, nativeBootstrapTarget(), version, commit); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		return
	}
	if visited["setup"] || visited["resume"] {
		if err := bootstrapSetupFlags(*setup, *resume, visited, flag.NArg()); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		options := bootstrapSetupOptions{Pair: pairOptions{Server: *pairServer, WindowID: *pairWindow, Name: *pairName, ConfigPath: *path}, Resume: *resume}
		if err := setupProbe(ctx, options, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		return
	}
	action, managementErr := installationAction(selected, visited, flag.NArg())
	if managementErr != nil {
		fmt.Fprintln(os.Stderr, "probe:", managementErr)
		os.Exit(1)
	}
	if action != "" {
		configPath := ""
		if visited["config"] {
			configPath = *path
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := manageInstallation(ctx, action, configPath, *jsonOutput, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		return
	}
	if visited["managed-run"] {
		if len(visited) != 2 || !visited["config"] || flag.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "probe: managed_process_flags_conflict")
			os.Exit(1)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runManagedInstallation(ctx, *managedRun, *path); err != nil {
			fmt.Fprintln(os.Stderr, "probe: managed_process_failed")
			os.Exit(1)
		}
		return
	}
	if *pair {
		if *once || *showVersion || *checkConfig || *selfTest || flag.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "probe: pairing_flags_conflict")
			os.Exit(1)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		err := pairDevice(ctx, pairOptions{Server: *pairServer, WindowID: *pairWindow, Name: *pairName, ConfigPath: *path}, os.Stdout)
		if err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		return
	}
	if *pairServer != "" || *pairWindow != "" {
		fmt.Fprintln(os.Stderr, "probe: pairing_flags_require_pair")
		os.Exit(1)
	}
	lock, _ := loadKernelLock()
	if *showVersion {
		fmt.Printf("misub-probe %s (%s); mihomo %s\n", probeDisplayVersion(version, commit, buildChannel, buildSourceState), commit, lock.Version)
		return
	}
	if *selfTest {
		binary, cleanup, err := extractKernel()
		if err != nil {
			fmt.Fprintln(os.Stderr, "probe:", err)
			os.Exit(1)
		}
		defer cleanup()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		wait, startErr := startCoreProcess(ctx, binary, []string{"-v"}, filepath.Dir(binary))
		if startErr != nil || wait() != nil {
			fmt.Fprintln(os.Stderr, "probe: kernel_self_test_failed")
			cleanup()
			os.Exit(1)
		}
		fmt.Println("probe: embedded_kernel_verified")
		return
	}
	config, err := readConfig(*path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		os.Exit(1)
	}
	if *checkConfig {
		fmt.Println("probe: configuration_valid")
		return
	}
	binary, cleanup, err := extractKernel()
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		os.Exit(1)
	}
	defer cleanup()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Println("probe: started; outbound polling enabled; no public listener")
	if run(ctx, newAPI(config), binary, *once, os.Stdout) != nil {
		fmt.Fprintln(os.Stderr, "probe: stopped_with_error (check enrollment, HTTPS access and task status)")
		cleanup()
		os.Exit(1)
	}
}
