# Node diagnostics

## Architecture and delivery plan

MiSub uses Vue 3/Vite and Cloudflare Pages Functions with KV/D1. The inspected
baseline is `3253e9b1c8767cd4ba490bd93d9d7281446f42c9` on `58cdn/MiSub:main`.
No tracked AGENTS.md, .agents, or .codex rules exist at that revision.

1. Add a versioned evidence contract, fixed provider registry, bounded offline-testable
   runner and an admin-only optional executor boundary. Workers do not include a
   proxy core: absent an explicitly configured trusted executor, return unsupported.
2. Expose node diagnostics in the existing node interface with explicit per-run
   consent, independent source results, timestamps, errors and conflicts. Correct
   the existing browser HTTP timing description; it is not TCP RTT or node URLTest.

Each PR starts as a draft. Merge requires independent review, security checks and
passing CI for its final HEAD. Integration is tested again after merging.

## Research (2026-10-12)

- [clash-ip-checker](https://github.com/tombcato/clash-ip-checker) is GPLv3.
  Its `core/sources/ippure.py` uses the older `my.123169.xyz` endpoint; `ping0.py`
  parses HTML and fails on challenges. No code is copied into this MIT project.
- [sublinkPro](https://github.com/ZeroDeng01/sublinkPro) has a MIT root license.
  `services/mihomo/mihomo.go` binds requests to a node adapter, while
  `services/unlock/registry.go` and `orchestrator.go` separate providers and limit
  concurrency to three. Proxy-core dependencies have separate licenses. Its
  absence-of-block-marker heuristics and disabled TLS verification are not adopted.
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
  do not supply MiSub with a complete multi-protocol/UDP proxy core.
- [IPPure](https://ippure.com/MyIP-Info-API) documents `https://my.ippure.com/v1/info`
  as experimental. Missing scores/booleans remain unknown, including IPv6 scores;
  scores retain their provider meaning and are never averaged.
- [IP.SB API](https://ip.sb/api/) and [terms](https://ip.sb/terms-of-use/) require the
  API host and a User-Agent, with 100 requests/minute/IP and at most 5/second.
- [ipify](https://www.ipify.org/) distinguishes IPv4, dual-stack and IPv6 endpoints.
- [IPinfo](https://ipinfo.io/developers) offers Lite through
  `https://api.ipinfo.io/lite/me` with an existing token. No credentials are generated.
- Plain-text IP sources: `https://ifconfig.me/ip`, `https://icanhazip.com/`.
  Ping0 is not enabled: no verified machine API/automation permission is assumed.

## Safety and acceptance boundary

No actual subscriptions or node credentials are used in development or CI. Fixture
responses alone do not establish production provider correctness or real node
routing. No deployment credentials, ports, TLS settings, or network configuration
are created or modified. A successful Pages deployment only proves the release
workflow, not real network acceptance.

The executor must keep TLS verification enabled, bind every request to the selected
node, reject unsupported protocols without direct fallback, validate node destinations
against private/reserved addresses and DNS rebinding, and restrict targets to the
registry. Do not follow redirects. It must also enforce quotas across instances,
cancel work, avoid credential logging/storage, and keep existing IPinfo credentials
server-side. Deployment and real-data acceptance require separate authorization.
