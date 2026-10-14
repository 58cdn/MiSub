package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

//go:embed embedded/* kernel-lock.json
var embeddedFiles embed.FS

type kernelLock struct {
	Repository string                 `json:"repository"`
	Version    string                 `json:"version"`
	Assets     map[string]kernelAsset `json:"assets"`
}

func loadKernelLock() (kernelLock, error) {
	var lock kernelLock
	b, err := embeddedFiles.ReadFile("kernel-lock.json")
	if err != nil {
		return lock, errors.New("kernel_missing")
	}
	if json.Unmarshal(b, &lock) != nil {
		return lock, errors.New("kernel_failed")
	}
	return lock, nil
}
func extractKernel() (string, func(), error) {
	lock, err := loadKernelLock()
	if err != nil {
		return "", func() {}, err
	}
	asset, ok := lock.Assets[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		return "", func() {}, errors.New("unsupported_platform")
	}
	extension := filepath.Ext(asset.File)
	payload, err := embeddedFiles.ReadFile("embedded/kernel" + extension)
	if err != nil {
		return "", func() {}, errors.New("kernel_missing")
	}
	executable, err := decodeKernelArchive(payload, asset)
	if err != nil {
		return "", func() {}, err
	}
	dir, cleanup, err := createPrivateTempDir("", "misub-probe-")
	if err != nil {
		return "", func() {}, errors.New("kernel_temp_failed")
	}
	name := "mihomo"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if writePrivateFile(path, executable, 0700) != nil {
		cleanup()
		return "", func() {}, errors.New("kernel_temp_failed")
	}
	return path, cleanup, nil
}
func newSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("random_failed")
	}
	return hex.EncodeToString(b), nil
}

type Kernel struct {
	Client    *http.Client
	transport *http.Transport
	cancel    context.CancelFunc
	done      chan struct{}
	dir       string
	cleanup   func()
	once      sync.Once
}

func (k *Kernel) Close() {
	k.once.Do(func() { k.transport.CloseIdleConnections(); k.cancel(); <-k.done; k.cleanup() })
}
func startKernel(parent context.Context, binary string, proxy map[string]any) (*Kernel, error) {
	if binary == "" {
		return nil, errors.New("kernel_missing")
	}
	dir, cleanFailure, err := createPrivateTempDir(filepath.Dir(binary), "task-")
	if err != nil {
		return nil, errors.New("kernel_failed")
	}
	l1, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		cleanFailure()
		return nil, errors.New("kernel_failed")
	}
	l2, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		l1.Close()
		cleanFailure()
		return nil, errors.New("kernel_failed")
	}
	port := l1.Addr().(*net.TCPAddr).Port
	controller := l2.Addr().String()
	secret, err := newSecret()
	if err != nil {
		l1.Close()
		l2.Close()
		cleanFailure()
		return nil, err
	}
	auth, err := newSecret()
	if err != nil {
		l1.Close()
		l2.Close()
		cleanFailure()
		return nil, err
	}
	stub, err := newKernelLoopback()
	if err != nil {
		l1.Close()
		l2.Close()
		cleanFailure()
		return nil, errors.New("kernel_failed")
	}
	defer stub.Close()
	cfg := map[string]any{
		"port": port, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
		"allow-lan": false, "bind-address": "127.0.0.1", "skip-auth-prefixes": []string{},
		"authentication": []string{"probe:" + auth}, "mode": "rule", "log-level": "silent", "ipv6": true,
		"external-controller": controller, "secret": secret, "external-ui": "",
		"external-controller-cors": map[string]any{"allow-origins": []string{}, "allow-private-network": false},
		"find-process-mode":        "off", "geo-auto-update": false,
		"dns": map[string]any{"enable": false}, "tun": map[string]any{"enable": false},
		"sniffer": map[string]any{"enable": false},
		"profile": map[string]any{"store-selected": false, "store-fake-ip": false},
		"proxies": []any{proxy, stub.proxy()}, "proxy-groups": []any{},
		"rules": []string{"DOMAIN," + stub.host + "," + stub.name, "MATCH,probe-target"},
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		l1.Close()
		l2.Close()
		cleanFailure()
		return nil, errors.New("invalid_format")
	}
	configPath := filepath.Join(dir, "config.json")
	if writePrivateFile(configPath, encoded, 0600) != nil {
		l1.Close()
		l2.Close()
		cleanFailure()
		return nil, errors.New("kernel_failed")
	}
	ctx, cancel := context.WithCancel(parent)
	l1.Close()
	l2.Close()
	wait, err := startCoreProcess(ctx, binary, []string{"-d", dir, "-f", configPath}, dir)
	if err != nil {
		cancel()
		cleanFailure()
		return nil, errors.New("kernel_failed")
	}
	proxyURL := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), User: url.UserPassword("probe", auth)}
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second, MaxResponseHeaderBytes: 8192, DisableCompression: true, MaxIdleConns: 2, MaxIdleConnsPerHost: 1, IdleConnTimeout: 5 * time.Second}
	k := &Kernel{transport: transport, cancel: cancel, done: make(chan struct{}), dir: dir, cleanup: cleanFailure}
	k.Client = &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	go func() { _ = wait(); close(k.done) }()
	startup, finishStartup := context.WithTimeout(ctx, 10*time.Second)
	err = waitKernelListeners(startup, k.done, controller, proxyURL.Host, secret)
	if err == nil {
		err = waitKernelRoute(startup, k.done, proxyURL, stub)
	}
	stub.Close()
	finishStartup()
	if err != nil {
		k.Close()
		if parent.Err() != nil {
			return nil, errors.New("cancelled")
		}
		return nil, errors.New("kernel_failed")
	}
	return k, nil
}

// The controller starts before the HTTP listener. Both must be reachable before
// returning a client; a local TCP connection does not establish node connectivity
// or prove the core has completed every later initialization step.
func waitKernelListeners(ctx context.Context, done <-chan struct{}, controller, proxyAddress, secret string) error {
	controlTransport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext}
	control := &http.Client{Transport: controlTransport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer controlTransport.CloseIdleConnections()
	dialer := net.Dialer{Timeout: time.Second}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("kernel_failed")
		case <-tick.C:
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+controller+"/version", nil)
			req.Header.Set("Authorization", "Bearer "+secret)
			resp, e := control.Do(req)
			if e != nil {
				continue
			}
			body, e := io.ReadAll(io.LimitReader(resp.Body, 4097))
			resp.Body.Close()
			var result struct {
				Version string `json:"version"`
			}
			if e != nil || resp.StatusCode != 200 || len(body) > 4096 || json.Unmarshal(body, &result) != nil || result.Version == "" {
				continue
			}
			connection, e := dialer.DialContext(ctx, "tcp4", proxyAddress)
			if e != nil {
				continue
			}
			connection.Close()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-done:
				return errors.New("kernel_failed")
			default:
				return nil
			}
		}
	}
}
