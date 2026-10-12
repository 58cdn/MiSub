package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
)

type Config struct {
	Version     int    `json:"version"`
	Server      string `json:"server"`
	Token       string `json:"token"`
	PollSeconds int    `json:"pollSeconds,omitempty"`
}

func readConfig(path string) (Config, error) {
	var c Config
	// Never print parser errors: they can contain a token or the supplied server URL.
	f, closeFile, err := openPrivateConfig(path)
	if err != nil {
		return c, err
	}
	defer closeFile()
	info, err := f.Stat()
	if err != nil {
		return c, errors.New("config_unreadable")
	}
	if info.Size() > 16384 {
		return c, errors.New("config_too_large")
	}
	d := json.NewDecoder(io.LimitReader(f, 16385))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return c, errors.New("invalid_config")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return c, errors.New("invalid_config")
	}
	if err = c.validate(); err != nil {
		return c, err
	}
	return c, nil
}
func (c *Config) validate() error {
	u, err := url.Parse(c.Server)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("server_must_be_https_origin")
	}
	if c.Version != 1 || !tokenPattern.MatchString(c.Token) {
		return errors.New("invalid_config")
	}
	if c.PollSeconds == 0 {
		c.PollSeconds = 60
	}
	if c.PollSeconds < 30 || c.PollSeconds > 300 {
		return errors.New("poll_interval_out_of_range")
	}
	c.Server = strings.TrimRight(c.Server, "/")
	return nil
}
