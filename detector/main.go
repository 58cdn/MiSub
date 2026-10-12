package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	path := flag.String("config", "probe.json", "Private configuration file downloaded from MiSub (chmod 600)")
	once := flag.Bool("once", false, "Process at most one task, then exit")
	showVersion := flag.Bool("version", false, "Print detector and pinned kernel versions")
	checkConfig := flag.Bool("check-config", false, "Validate configuration without sending it anywhere")
	selfTest := flag.Bool("self-test", false, "Verify and execute the embedded kernel version; no node or API request")
	pair := flag.Bool("pair", false, "Pair with browser approval, save private configuration, then exit (Linux/macOS)")
	pairServer := flag.String("server", "", "HTTPS MiSub origin for pairing")
	pairWindow := flag.String("pair-window", "", "Public pairing window ID from MiSub settings")
	pairName := flag.String("pair-name", "MiSub Probe", "Detector display name; no machine username is sent")
	managementFlags := map[string]*bool{}
	for _, action := range []string{"install", "start", "stop", "status", "uninstall", "reinstall"} {
		managementFlags[action] = flag.Bool(action, false, "User installation management: "+action+" (Linux/macOS; no login startup)")
	}
	jsonOutput := flag.Bool("json", false, "Print installation --status as JSON")
	flag.Parse()
	selected := map[string]bool{}
	visited := map[string]bool{}
	for action, value := range managementFlags {
		selected[action] = *value
	}
	flag.Visit(func(f *flag.Flag) { visited[f.Name] = true })
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
		fmt.Printf("misub-probe %s (%s); mihomo %s\n", version, commit, lock.Version)
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
		cmd := exec.CommandContext(ctx, binary, "-v")
		if cmd.Run() != nil {
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
