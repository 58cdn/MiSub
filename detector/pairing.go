package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const pairingLifetime = 5 * time.Minute
const pairingResponseLimit = 8192

var pairingIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var pairingCodePattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$`)
var pairingDevicePattern = regexp.MustCompile(`^pdc1_[a-f0-9]{64}$`)
var pairingHostPattern = regexp.MustCompile(`^[a-z0-9.-]+$`)

type pairOptions struct {
	Server, WindowID, Name, ConfigPath string
}

type pairingConfigStore interface {
	Save(Config) error
	Close() error
}

type pairingClient struct {
	server string
	http   *http.Client
	wait   func(context.Context, time.Duration) bool
}

type pairingStart struct {
	ID              string `json:"id"`
	WindowID        string `json:"windowId"`
	Origin          string `json:"origin"`
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	Fingerprint     string `json:"fingerprint"`
	ExpiresAt       int64  `json:"expiresAt"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

type pairingPoll struct {
	Status          string `json:"status"`
	ExpiresAt       int64  `json:"expiresAt"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Agent           struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		CreatedAt int64  `json:"createdAt"`
	} `json:"agent"`
	Config Config `json:"config"`
}

type pairingResponse struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   struct {
		Code              string `json:"code"`
		RetryAfterSeconds int    `json:"retryAfterSeconds"`
	} `json:"error"`
}

func pairingOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return "", errors.New("pairing_server_must_be_https_origin")
	}
	for _, ch := range u.Host {
		if ch > 127 || ch <= 32 || ch == 127 || ch == '%' || ch == '\\' {
			return "", errors.New("pairing_server_must_be_https_origin")
		}
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else if !pairingHostPattern.MatchString(host) {
		return "", errors.New("pairing_server_must_be_https_origin")
	}
	port := u.Port()
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", errors.New("pairing_server_must_be_https_origin")
		}
		port = strconv.Itoa(n)
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" && port != "443" {
		host += ":" + port
	}
	return "https://" + host, nil
}

func validPairingName(name string) bool {
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 60 || strings.TrimSpace(name) != name {
		return false
	}
	units := 0
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	return units <= 60
}

func pairDevice(ctx context.Context, opts pairOptions, output io.Writer) error {
	origin, err := pairingOrigin(opts.Server)
	if err != nil {
		return err
	}
	if !pairingIDPattern.MatchString(opts.WindowID) || !validPairingName(opts.Name) {
		return errors.New("invalid_pairing_options")
	}
	store, err := preparePairingConfig(opts.ConfigPath)
	if err != nil {
		return err
	}
	defer store.Close()
	client := newPairingClient(origin)
	defer client.http.CloseIdleConnections()
	return client.pair(ctx, opts, store, output)
}

func newPairingClient(origin string) *pairingClient {
	return &pairingClient{server: origin, wait: sleep, http: &http.Client{
		Timeout:       15 * time.Second,
		Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, MaxIdleConns: 1, MaxIdleConnsPerHost: 1, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func pairingFingerprint(proofHash string) string {
	value := strings.ToUpper(proofHash[:16])
	return value[:4] + "-" + value[4:8] + "-" + value[8:12] + "-" + value[12:]
}

func (c *pairingClient) request(ctx context.Context, path string, input any) (int, pairingResponse, int, error) {
	var result pairingResponse
	body, err := json.Marshal(input)
	if err != nil {
		return 0, result, 0, errors.New("pairing_invalid_request")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.server+"/api/probes/v1/device-pairing/"+path, bytes.NewReader(body))
	if err != nil {
		return 0, result, 0, errors.New("pairing_invalid_request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "MiSub-Probe/"+version)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, result, 0, errors.New("pairing_request_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode <= 399 {
		return resp.StatusCode, result, 0, errors.New("pairing_redirect_refused")
	}
	retry := rateLimited(resp.Header, time.Now()).RetryAfterSeconds
	seconds := 0
	if retry != nil {
		seconds = int(*retry)
	}
	// Rate-limit headers govern the next request even if the response body stalls.
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp.StatusCode, result, seconds, nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, pairingResponseLimit+1))
	if err != nil || len(data) > pairingResponseLimit || json.Unmarshal(data, &result) != nil {
		return resp.StatusCode, pairingResponse{}, seconds, errors.New("pairing_invalid_response")
	}
	return resp.StatusCode, result, seconds, nil
}

func pairingRecoveryError() error {
	return errors.New("pairing_delivery_uncertain_revoke_in_misub_before_pairing_again")
}

func (c *pairingClient) pair(parent context.Context, opts pairOptions, store pairingConfigStore, output io.Writer) error {
	ctx, cancel := context.WithTimeout(parent, pairingLifetime)
	defer cancel()
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return errors.New("pairing_random_unavailable")
	}
	proof := hex.EncodeToString(random[:])
	hash := sha256.Sum256([]byte(proof))
	proofHash := hex.EncodeToString(hash[:])
	platform := runtime.GOOS + "-" + runtime.GOARCH
	status, envelope, _, err := c.request(ctx, "start", map[string]string{
		"windowId": opts.WindowID, "name": opts.Name, "version": version, "platform": platform, "proofHash": proofHash,
	})
	if err != nil || status != http.StatusCreated || !envelope.Success {
		return errors.New("pairing_start_failed_check_window_in_misub")
	}
	var start pairingStart
	if json.Unmarshal(envelope.Data, &start) != nil || !pairingIDPattern.MatchString(start.ID) || start.WindowID != opts.WindowID || start.Origin != c.server || !pairingDevicePattern.MatchString(start.DeviceCode) || !pairingCodePattern.MatchString(start.UserCode) || start.Fingerprint != pairingFingerprint(proofHash) || start.IntervalSeconds < 5 || start.IntervalSeconds > 300 {
		return errors.New("pairing_invalid_start_response")
	}
	remaining := time.Until(time.UnixMilli(start.ExpiresAt))
	if remaining <= 0 || remaining > pairingLifetime+5*time.Second {
		return errors.New("pairing_invalid_expiry")
	}
	if remaining < pairingLifetime {
		var stop context.CancelFunc
		ctx, stop = context.WithTimeout(ctx, remaining)
		defer stop()
	}
	if _, err := fmt.Fprintf(output, "MiSub site: %s\nPairing code: %s\nSession fingerprint: %s\nSelf-reported platform: %s (not hardware authentication)\nCompare the site, code and fingerprint in MiSub settings, then approve this request.\n", c.server, start.UserCode, start.Fingerprint, platform); err != nil {
		return errors.New("pairing_output_unavailable_cancel_window_in_misub")
	}
	interval := time.Duration(start.IntervalSeconds) * time.Second
	for {
		if !c.wait(ctx, interval) {
			return errors.New("pairing_cancelled_or_expired_cancel_window_in_misub")
		}
		status, envelope, retry, err := c.request(ctx, "token", map[string]string{"windowId": opts.WindowID, "id": start.ID, "deviceCode": start.DeviceCode, "proof": proof})
		// A failed transport or malformed reply may follow a committed redemption.
		// Never request another permanent credential after an ambiguous response.
		if err != nil {
			return pairingRecoveryError()
		}
		if status == http.StatusTooManyRequests {
			interval += 5 * time.Second
			if d := time.Duration(retry) * time.Second; d > interval {
				interval = d
			}
			continue
		}
		if status >= http.StatusInternalServerError {
			return pairingRecoveryError()
		}
		if status == http.StatusConflict && envelope.Error.Code == "pairing_consumed" {
			return pairingRecoveryError()
		}
		if status == http.StatusGone {
			return errors.New("pairing_cancelled_or_expired_cancel_window_in_misub")
		}
		if status == http.StatusConflict && envelope.Error.Code == "agent_limit" {
			return errors.New("pairing_agent_limit_manage_detectors_in_misub")
		}
		if !envelope.Success || (status != http.StatusAccepted && status != http.StatusOK) {
			return errors.New("pairing_rejected_check_window_in_misub")
		}
		var poll pairingPoll
		if json.Unmarshal(envelope.Data, &poll) != nil {
			return pairingRecoveryError()
		}
		if status == http.StatusAccepted {
			if poll.Status != "pending" || poll.ExpiresAt != start.ExpiresAt || poll.IntervalSeconds < 5 || poll.IntervalSeconds > 300 {
				return pairingRecoveryError()
			}
			interval = max(interval, time.Duration(poll.IntervalSeconds)*time.Second)
			continue
		}
		if poll.Status != "consumed" || !pairingIDPattern.MatchString(poll.Agent.ID) || poll.Config.Server != c.server || poll.Config.PollSeconds != 60 || poll.Config.validate() != nil {
			return pairingRecoveryError()
		}
		if store.Save(poll.Config) != nil {
			return errors.New("pairing_config_save_failed_revoke_in_misub_before_pairing_again")
		}
		_, err = fmt.Fprintln(output, "probe: pairing_saved; start the detector separately when ready")
		if err != nil {
			return errors.New("pairing_saved_output_unavailable")
		}
		return nil
	}
}
