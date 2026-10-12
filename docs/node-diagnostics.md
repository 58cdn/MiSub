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

## Implemented boundary and provider coverage

`GET /api/nodes/diagnostics/capabilities` and `POST /api/nodes/diagnostics` require
the existing admin session. POST also requires same-origin `Origin`, JSON body
`{ node, sources, consent: true }`, one node URI (max 8 KiB) and only registered
source IDs. Input is capped at 16 KiB. No subscription expansion occurs. Unknown
protocols are rejected; accepting a URI does not claim the executor supports it.
The response is `no-store`; results are not saved in KV, D1 or subscription exports.

No executor is installed or bound by this change. An administrator can separately
provide a `NODE_DIAGNOSTICS` service binding implementing `POST /v1/check`.
The repository now also includes a [local CONNECT executor](local-diagnostics-executor.md)
for HTTP/HTTPS proxy nodes. Its CLI performs real CONNECT/TLS requests, but is not
automatically connected to this service binding or the deployed interface.
This must be a trusted adapter to a separately operated proxy core, not a generic
Worker fetch wrapper. It receives `{ version: 1, requestId, node, sources }` and
must produce `{ version: 1, requestId, scope: 'node', results }`. The request ID,
source set, measurement type, fresh timestamps and all typed result fields are
validated. Each result follows `emptyResult()` in `contract.js`. Extra fields and
raw errors are discarded; invalid reports fail with a sanitized 502. A binding's
claim of node routing is a trust assertion, not cryptographic proof of routing.

`createDiagnosticRunner()` is an executor building block, **not a proxy core or
deployable executor**. Inject a transport with `{ scope: 'node', requestId, fetch }`;
`fetch` must use the selected validated node and honor AbortSignal. There is no
global fetch fallback. Reuse the runner to share its three-request concurrency
limit, no-overlap guard and per-source cooldown. The API permits one active run
and one start per minute per binding object per isolate; a distributed deployment
must add executor-side shared quotas. The API deadline is 25 seconds and each
provider deadline is 5 seconds, including body reads. Responses are capped at
16 KiB/source and 64 KiB/report. Redirects are rejected; HTTP 429 retains bounded
Retry-After and is never automatically retried.

| Source                                       | V1 behavior with a conforming transport                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| latency                                      | Fixed gstatic 204 HTTP URLTest through node; includes protocol/TLS/HTTP overhead, not TCP RTT                     |
| ipify                                        | Dual-stack self IP; no country claim                                                                              |
| ip_sb                                        | Self IP, country code, ASN where present                                                                          |
| ifconfig / icanhazip                         | Plain-text self IP; no country claim                                                                              |
| ipinfo                                       | Lite self IP/country/ASN; existing executor-side token required; otherwise not_configured                         |
| ippure                                       | Self IP/country/ASN plus provider fraud score 0–100 and nullable flags; missing fields are partial                |
| openai                                       | Explicit API country rejection is restricted; 401/200 is unknown, not proof of unlock; challenge and 429 distinct |
| netflix / disney / youtube / gemini / claude | Registered extension points; checker_not_implemented, no request                                                  |
| ping0                                        | Not registered or requested                                                                                       |

Successful unlock detection is **not implemented** in v1. A future checker must
define and test affirmative provider-specific evidence before expanding the
contract; a successful ordinary HTTP request is insufficient. Unit tests cover
only fixtures. Actual proxy-core protocol coverage, public-address resolution,
DNS pinning, service quotas and provider behavior remain executor acceptance work.

Results carry per-source `checkedAt`, `durationMs`, `probeVersion`, `httpStatus`,
`error`, nullable IP/family/country/ASN/quality fields and explicit latency method.
`durationMs` for an IP or quality site is never node latency. Conflicts are reported
within an IP family and for differing country claims on the same IP. No winner,
average risk score or merged quality classification is fabricated. V1 does not
cache; returned `expiresAt` marks the ten-minute display freshness window.

The executor must keep TLS verification enabled, bind every request to the selected
node, reject unsupported protocols without direct fallback, validate node destinations
against private/reserved addresses and DNS rebinding, and restrict targets to the
registry. Do not follow redirects. It must also enforce quotas across instances,
cancel work, avoid credential logging/storage, and keep existing IPinfo credentials
server-side. Deployment and real-data acceptance require separate authorization.
