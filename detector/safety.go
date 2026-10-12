package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"strings"
)

var forbiddenNetworks = func() []netip.Prefix {
	entries := []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"}
	out := make([]netip.Prefix, 0, len(entries))
	for _, s := range entries {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

func isPublicAddress(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, p := range forbiddenNetworks {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

type lookupFunc func(context.Context, string, string) ([]netip.Addr, error)

// Mihomo weakly decodes options, including nested plugin options. Accept only
// an explicit boolean false for every skip-cert-verify key, before any DNS/I/O.
func hasUnsafeTLSOption(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			// Match the locked core's '_' -> '-' KeyReplacer and Unicode
			// EqualFold decoder. Reject aliases instead of validating one spelling
			// while the core later consumes another (including duplicate keys).
			for _, canonical := range []string{"type", "server", "port", "tls", "sni", "servername", "name-cert-verify", "skip-cert-verify", "network", "dialer-proxy", "interface-name", "routing-mark", "peers", "xhttp-opts", "smux", "extra", "realm-opts"} {
				if strings.EqualFold(strings.ReplaceAll(key, "_", "-"), canonical) && key != canonical {
					return true
				}
			}
			if strings.EqualFold(key, "skip-cert-verify") {
				safe, ok := item.(bool)
				if !ok || safe {
					return true
				}
			}
			if strings.EqualFold(key, "tls") {
				if _, ok := item.(bool); !ok {
					return true
				}
			}
			if hasUnsafeTLSOption(item) {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if hasUnsafeTLSOption(item) {
				return true
			}
		}
	}
	return false
}
func resolvePublic(ctx context.Context, host string, lookup lookupFunc) (netip.Addr, error) {
	host = strings.TrimSuffix(strings.Trim(host, "[]"), ".")
	if host == "" || len(host) > 253 || strings.ContainsAny(host, " /\\\t\r\n%\x00") {
		return netip.Addr{}, errors.New("unsafe_target")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if !isPublicAddress(ip) {
			return netip.Addr{}, errors.New("unsafe_target")
		}
		return ip.Unmap(), nil
	}
	low := strings.ToLower(host)
	for _, suffix := range []string{"localhost", "local", "internal", "lan", "home", "onion"} {
		if low == suffix || strings.HasSuffix(low, "."+suffix) {
			return netip.Addr{}, errors.New("unsafe_target")
		}
	}
	ips, err := lookup(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return netip.Addr{}, errors.New("dns_failed")
	}
	for _, ip := range ips {
		if !isPublicAddress(ip) {
			return netip.Addr{}, errors.New("unsafe_target")
		}
	}
	chosen := ips[0].Unmap()
	for _, ip := range ips {
		if ip.Unmap().Is4() {
			chosen = ip.Unmap()
			break
		}
	}
	return chosen, nil
}
func pinProxy(ctx context.Context, input map[string]any, lookup lookupFunc) (map[string]any, error) {
	encoded, err := json.Marshal(input)
	if err != nil || len(encoded) > 65536 {
		return nil, errors.New("invalid_format")
	}
	var p map[string]any
	if json.Unmarshal(encoded, &p) != nil || p == nil {
		return nil, errors.New("invalid_format")
	}
	typ, _ := p["type"].(string)
	if !contains([]string{"ss", "ssr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "snell", "wireguard", "anytls", "http", "socks5", "mieru"}, typ) {
		return nil, errors.New("unsupported_protocol")
	}
	for _, key := range []string{"dialer-proxy", "interface-name", "routing-mark", "peers", "xhttp-opts", "smux", "extra", "realm-opts"} {
		if _, ok := p[key]; ok {
			return nil, errors.New("unsupported_transport")
		}
	}
	if hasUnsafeTLSOption(p) {
		return nil, errors.New("unsupported_transport")
	}
	if network, ok := p["network"].(string); ok && !contains([]string{"", "tcp", "ws", "grpc", "h2", "http"}, network) {
		return nil, errors.New("unsupported_transport")
	}
	port, ok := p["port"].(float64)
	if !ok || port < 1 || port > 65535 || port != float64(int(port)) {
		return nil, errors.New("invalid_format")
	}
	host, _ := p["server"].(string)
	// Locked Mihomo Socks5Option has no separate SNI field: it uses Server as
	// the TLS identity. Generic sni/servername additions cannot preserve a
	// hostname after IP pinning. Never compensate by weakening verification.
	if typ == "socks5" && p["tls"] == true {
		if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err != nil {
			return nil, errors.New("unsupported_transport")
		}
		for _, key := range []string{"sni", "servername", "name-cert-verify"} {
			if value, ok := p[key]; ok && value != "" {
				return nil, errors.New("unsupported_transport")
			}
		}
	}
	ip, err := resolvePublic(ctx, host, lookup)
	if err != nil {
		return nil, err
	}
	if _, err := netip.ParseAddr(strings.Trim(host, "[]")); err != nil {
		if p["servername"] == nil || p["servername"] == "" {
			p["servername"] = host
		}
		if p["sni"] == nil || p["sni"] == "" {
			p["sni"] = host
		}
		if typ == "vmess" || typ == "vless" {
			if network, _ := p["network"].(string); network == "ws" {
				opts, _ := p["ws-opts"].(map[string]any)
				if opts == nil {
					opts = map[string]any{}
					p["ws-opts"] = opts
				}
				headers, _ := opts["headers"].(map[string]any)
				if headers == nil {
					headers = map[string]any{}
					opts["headers"] = headers
				}
				if headers["Host"] == nil {
					headers["Host"] = host
				}
			}
		}
	}
	p["server"] = ip.String()
	p["port"] = int(port)
	p["name"] = "probe-target"
	delete(p, "metadata")
	return p, nil
}
func tcpSupported(p map[string]any) bool {
	typ, _ := p["type"].(string)
	if contains([]string{"hysteria", "hysteria2", "tuic", "wireguard"}, typ) {
		return false
	}
	if typ == "mieru" && p["transport"] == "UDP" {
		return false
	}
	return true
}
func defaultLookup(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, network, host)
}
