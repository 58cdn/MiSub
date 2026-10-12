package main

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Public bounded metadata only; never return raw headers. No automatic retry.
func rateLimited(header http.Header, now time.Time) Check {
	r := failure("unknown", "rate_limited")
	r.HTTPStatus = http.StatusTooManyRequests
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n") {
		return r
	}
	var seconds int64
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		return r
	}
	if n, err := strconv.ParseInt(value, 10, 64); err == nil {
		if n < 0 {
			return r
		}
		seconds = n
	} else if date, err := http.ParseTime(value); err == nil {
		seconds = int64(math.Ceil(date.Sub(now).Seconds()))
		if seconds < 0 {
			seconds = 0
		}
	} else {
		return r
	}
	if seconds > 86400 {
		seconds = 86400
	}
	r.RetryAfterSeconds = &seconds
	return r
}
