# Probe source observations

This feature extends the existing `/api/probes/v1` task/lease protocol and native
Go detector. It does not add a second executor or an automatic network probe in
Workers. The implementation includes the native TLS/rate-limit boundary from PR #11.
The source research and licenses are recorded in
[node-diagnostics.md](node-diagnostics.md); no GPL checker code is copied.

Wire and execution contract:

- Add an opt-in `observations` check with version 1 and explicit source IDs. Old
  detector claim requests must not consume tasks requiring this capability.
- Retain an independent typed observation for ipify, IP.SB, ifconfig.me,
  icanhazip.com and experimental IPPure, including source version, timestamp,
  duration, HTTP status, bounded error and nullable evidence fields. IPPure is
  opt-in; the default set is the four unauthenticated exit IP sources.
- IPinfo remains not_configured; this native detector does not accept or create
  an IPinfo token. Ping0 remains disabled; no unverified HTML scraper is enabled.
- Reuse the existing versioned diagnostic evidence validation where applicable;
  conflicts are recomputed at the control plane, never majority-voted away. IPv4
  and IPv6 are separate, and country conflicts are tied to the same IP.
- Route requests only through the selected native core, preserving proxy-side
  provider hostnames, verified TLS and fixed HTTPS targets. Bound concurrency,
  request/body deadlines, response size and per-provider cooldowns. Never use a
  direct fetch fallback, automatic retries or real user data in tests.
- IP/quality endpoint duration is not node latency. Keep TCP connect and node
  HTTP URLTest separate; quality scores keep their source meaning and missing
  fields remain unknown. Ordinary service success never proves unlock.

The [NodeDetectionPanel](probe-observations-ui.md) provides unified single-node
and bulk task entrypoints with explicit source selection and independent source
details, freshness, errors and conflicts. Both use the same jobs/results and
node-sharing consent. Native fixture success and Pages deployment are not
real-node acceptance. Binary distribution remains subject to the separate
[corresponding-source and license gate](detector-hardening.md).

## Task protocol

Create a normal job with `types: ["observations"]` (optionally combined with other
types), `options: { observationsVersion: 1, sources: ["ipify", "ip_sb", "ippure"] }`,
and the existing explicit node-sharing consent. No URLs or credentials for
providers are accepted in task options. The new detector includes
`observationsVersion: 1` in `agent/claim`; legacy agents skip these tasks without
consuming an attempt, while continuing to receive legacy task types.

The result is `checks.observations = { status, code, report }`. The container never
claims an overall quality pass. `report` follows the existing evidence v1 schema:
`version`, task-bound `requestId`, `scope: "node"`, and exactly one independent
result per selected source. The control plane validates types and a maximum
three-minute observation age, strips unknown fields, and recomputes conflicts.
Report `checkedAt`/`expiresAt` use the oldest included source observation, so a
queued job or delayed delivery cannot refresh old evidence. Identical delivery
retries use the original acceptance time for validation and preserve their hash.
Missing transport or an unsafe node still yields an explicit unexecuted result for
every selected source; no direct request is attempted.

Source-level timestamps are ISO 8601 UTC. `durationMs` is the observation request
duration. The detector and control-plane clocks need to agree: validation allows
only one second of clock tolerance around task creation and delivery time. This
feature does not change host clock configuration. `durationMs` includes limiter
wait and is not node latency.
`latencyMs` and `measurement`
remain null for all exit/quality observations. Countries and ASNs are nullable;
no country is inferred for plain IP-only services. IPPure's `fraudScore` remains
its own 0–100 measure; absent/invalid score or boolean values stay null/partial.
IPinfo is currently not configured: this version does not accept or create an
IPinfo token. Ping0 is not in the registry and receives no request.

Unlock provider results also retain an independent `checkedAt` completion time
from the native detector, including failures, cancellation and rate limits. The
control plane validates its age with the same three-minute/one-second bounds and
keeps replay validation fixed to first acceptance. Older detectors may omit it;
the UI must not invent a provider time from the task's delivery timestamp.

## Limits and acceptance

The detector shares a three-request semaphore and per-source cooldowns in its
process. Exit services have at least one second between starts; experimental
IPPure has one minute. HTTP 429 extends the cooldown using bounded Retry-After
(invalid/missing values use a one-minute local backoff). Local limiter results
have no HTTP status; provider 429 retains status 429. No request is automatically
retried. Multiple detector processes sharing an egress IP need external quota
coordination; the in-process guard is not a distributed rate-limit guarantee.

Each request including body reads has the job's bounded 1–15 second deadline,
16 KiB body limit, and 8 KiB response-header limit in the node transport. Redirects
and unexpected compression are rejected. All fixed HTTPS hostnames are passed
through the selected proxy; no local provider DNS pinning is introduced.

Tests use fake transports, in-memory SQLite and loopback fixtures only. They cover
parallel bounds, cancellation, malformed/large responses, 429 and cooldowns,
partial quality fields, no-credential IPinfo, same-family IP conflicts, same-IP
country disagreement, capability fencing and stable idempotent result delivery.
