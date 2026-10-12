package main

import (
	"errors"
	"regexp"
	"time"
)

var version = "0.1.0-dev"
var commit = "source"

const maxResponseBytes = 1024 * 1024

var tokenPattern = regexp.MustCompile(`^mp1_[0-9a-f]{64}$`)
var leasePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var taskIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Check contains public measurements only: no URI, passwords, raw error or response body.
type Check struct {
	Status            string         `json:"status"`
	Code              string         `json:"code"`
	LatencyMs         *int64         `json:"latencyMs,omitempty"`
	Bytes             *int64         `json:"bytes,omitempty"`
	BytesPerSecond    *float64       `json:"bytesPerSecond,omitempty"`
	HTTPStatus        int            `json:"httpStatus,omitempty"`
	RetryAfterSeconds *int64         `json:"retryAfterSeconds,omitempty"`
	Region            string         `json:"region,omitempty"`
	Services          []ServiceCheck `json:"services,omitempty"`
}
type ServiceCheck struct {
	Service string `json:"service"`
	Check
}
type Node struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Proxy  map[string]any `json:"proxy"`
	Format Check          `json:"format"`
}
type Options struct {
	TimeoutMs              int      `json:"timeoutMs"`
	DownloadBytes          int64    `json:"downloadBytes"`
	Services               []string `json:"services"`
	WorstCaseDownloadBytes int64    `json:"worstCaseDownloadBytes"`
}
type Task struct {
	ID         string   `json:"id"`
	JobID      string   `json:"jobId"`
	Node       Node     `json:"node"`
	Types      []string `json:"types"`
	Options    Options  `json:"options"`
	Attempt    int      `json:"attempt"`
	LeaseToken string   `json:"leaseToken"`
	LeaseMs    int      `json:"leaseMs"`
}

func (t Task) validate() error {
	if !taskIDPattern.MatchString(t.ID) || !leasePattern.MatchString(t.LeaseToken) || t.LeaseMs < 30000 || t.LeaseMs > 120000 || t.Attempt < 1 || t.Attempt > 3 {
		return errors.New("invalid_task")
	}
	if len(t.Types) < 1 || len(t.Types) > 5 || t.Options.TimeoutMs < 1000 || t.Options.TimeoutMs > 15000 || t.Options.DownloadBytes < 65536 || t.Options.DownloadBytes > 20*1024*1024 || len(t.Options.Services) > 8 {
		return errors.New("invalid_task")
	}
	seen := map[string]bool{}
	for _, typ := range t.Types {
		if !contains([]string{"format", "tcp", "proxy", "speed", "unlock"}, typ) || seen[typ] {
			return errors.New("invalid_task")
		}
		seen[typ] = true
	}
	seen = map[string]bool{}
	for _, s := range t.Options.Services {
		if _, ok := serviceRegistry[s]; !ok || seen[s] {
			return errors.New("invalid_task")
		}
		seen[s] = true
	}
	if contains(t.Types, "unlock") && len(t.Options.Services) == 0 {
		return errors.New("invalid_task")
	}
	return nil
}
func contains(items []string, value string) bool {
	for _, s := range items {
		if s == value {
			return true
		}
	}
	return false
}
func measured(status, code string, start time.Time) Check {
	ms := time.Since(start).Milliseconds()
	if ms < 0 {
		ms = 0
	}
	if ms > 180000 {
		ms = 180000
	}
	return Check{Status: status, Code: code, LatencyMs: &ms}
}
func failure(status, code string) Check { return Check{Status: status, Code: code} }
