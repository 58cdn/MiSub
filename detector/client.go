package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"time"
)

type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

type API struct {
	config Config
	client *http.Client
}

func newAPI(c Config) *API {
	return &API{c, &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: 90 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (a *API) post(ctx context.Context, path string, input any, output any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return errors.New("invalid_request")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", a.config.Server+"/api/probes/v1/agent/"+path, bytes.NewReader(encoded))
	if err != nil {
		return errors.New("invalid_request")
	}
	req.Header.Set("Authorization", "Bearer "+a.config.Token)
	req.Header.Set("Content-Type", "application/json")
	buildVersion := version
	if !executionBuildVersionValid(buildVersion) {
		buildVersion = "unknown"
	}
	req.Header.Set("User-Agent", "MiSub-Probe/"+buildVersion)
	resp, err := a.client.Do(req)
	if err != nil {
		return errors.New("api_unreachable")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return errors.New("invalid_api_response")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		code := "api_error"
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			code = "unauthorized"
		}
		if resp.StatusCode == 409 {
			code = "lease_lost"
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			code = "api_redirect_refused"
		}
		return &apiError{resp.StatusCode, code}
	}
	var envelope struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil || !envelope.Success {
		return errors.New("invalid_api_response")
	}
	if output != nil && json.Unmarshal(envelope.Data, output) != nil {
		return errors.New("invalid_api_response")
	}
	return nil
}
func (a *API) claim(ctx context.Context) (*Task, error) {
	var task *Task
	err := a.post(ctx, "claim", map[string]any{
		"version": version, "platform": runtime.GOOS + "-" + runtime.GOARCH,
		"observationsVersion": observationsVersion,
		"capabilities":        map[string]int{"schemaVersion": 1, "observationsVersion": observationsVersion},
	}, &task)
	if err == nil && task != nil {
		err = task.validate()
	}
	return task, err
}
func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (a *API) process(parent context.Context, t Task, binary string) error {
	return a.processWithExecutor(parent, t, binary, executeTask)
}
func (a *API) processWithExecutor(parent context.Context, t Task, binary string, execute func(context.Context, Task, string) map[string]Check) error {
	metadata := currentExecutionMetadata()
	lifecycle, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		tick := time.NewTicker(20 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-lifecycle.Done():
				return
			case <-tick.C:
				err := a.post(lifecycle, "tasks/"+t.ID+"/heartbeat", map[string]string{"leaseToken": t.LeaseToken}, nil)
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-heartbeatDone }()
	execution, stop := context.WithTimeout(lifecycle, 3*time.Minute)
	checks := execute(execution, t, binary)
	stop()
	if lifecycle.Err() != nil {
		return errors.New("task_cancelled_or_lease_lost")
	}
	payload := map[string]any{"leaseToken": t.LeaseToken, "checks": checks}
	if metadata != nil {
		payload["executionMetadata"] = metadata
	}
	// Retry delivery of the same result, never repeat the speed test after a lost ACK.
	for attempt := 0; attempt < 3; attempt++ {
		err := a.post(lifecycle, "tasks/"+t.ID+"/result", payload, nil)
		if err == nil {
			return nil
		}
		var ae *apiError
		if errors.As(err, &ae) && (ae.status == 401 || ae.status == 403 || ae.status == 409 || ae.status == 404 || ae.status == 400) {
			return err
		}
		if !sleep(lifecycle, time.Duration(1<<attempt)*time.Second) {
			break
		}
	}
	return errors.New("result_delivery_failed")
}
func run(ctx context.Context, a *API, binary string, once bool, log io.Writer) error {
	for {
		task, err := a.claim(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			var ae *apiError
			if errors.As(err, &ae) && (ae.status == 401 || ae.status == 403) {
				return errors.New("unauthorized")
			}
			fmt.Fprintln(log, "probe: claim_failed")
			if once {
				return errors.New("claim_failed")
			}
		} else if task != nil {
			err = a.process(ctx, *task, binary)
			if err == nil {
				fmt.Fprintln(log, "probe: result_accepted")
			} else {
				fmt.Fprintln(log, "probe: task_not_completed")
			}
			if once {
				return err
			}
			if !sleep(ctx, time.Second) {
				return nil
			}
			continue
		} else if once {
			fmt.Fprintln(log, "probe: no_pending_task")
			return nil
		}
		if !sleep(ctx, time.Duration(a.config.PollSeconds)*time.Second) {
			return nil
		}
	}
}
