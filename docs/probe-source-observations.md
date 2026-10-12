# Probe source observations

This feature extends the existing `/api/probes/v1` task/lease protocol and native
Go detector. It does not add a second executor or an automatic network probe in
Workers. The implementation will integrate the TLS/rate-limit fixes from PR #11
before acceptance. The source research and licenses are recorded in
[node-diagnostics.md](node-diagnostics.md); no GPL checker code is copied.

Planned wire and execution contract:

- Add an opt-in `observations` check with version 1 and explicit source IDs. Old
  detector claim requests must not consume tasks requiring this capability.
- Retain an independent typed observation for ipify, IP.SB, ifconfig.me,
  icanhazip.com and experimental IPPure, including source version, timestamp,
  duration, HTTP status, bounded error and nullable evidence fields.
- IPinfo without an existing detector-side configuration remains not_configured.
  Ping0 remains disabled; no unverified HTML scraper is enabled.
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

A follow-up UI PR extends the existing NodeDetectionPanel from PR #12 with source
selection and per-source details, freshness, errors and conflicts using the same
jobs/results. No new credentials, production detector deployment, release assets
or public listeners are created. Native fixture success and Pages deployment are
not real-node acceptance. Binary distribution remains subject to the separate
corresponding-source and license gate.
