package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestServiceObservationsKeepIndependentCompletionTimes(t *testing.T) {
	client := &http.Client{Transport: fixtureRoundTripper(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("fixture page"))}, nil
	})}
	start := time.Now()
	result := checkServices(context.Background(), client, []string{"netflix", "youtube"}, time.Second)
	if len(result.Services) != 2 {
		t.Fatal("missing provider evidence")
	}
	for _, s := range result.Services {
		checked, err := time.Parse(time.RFC3339Nano, s.CheckedAt)
		if err != nil || checked.Before(start) || checked.After(time.Now()) || s.Status != "unknown" {
			t.Fatal("invalid provider evidence time or unlock inference")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelled := checkServices(ctx, client, []string{"netflix"}, time.Second)
	if cancelled.Services[0].CheckedAt == "" || cancelled.Services[0].Status != "cancelled" {
		t.Fatal("cancelled provider lost timestamp")
	}
}
