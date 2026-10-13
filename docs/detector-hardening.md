# Native detector safety and distribution

The native Go detector uses the `/api/probes/v1` task/lease control plane and a
locked Mihomo core. Node credentials are sent only to explicitly selected detector
identities after administrator consent. Provider requests use the selected node,
retain proxy-side hostname resolution and never fall back to a direct connection.
Service reachability alone does not establish unlock, account or playback access.

## Transport and result boundaries

- Reject nested/coerced TLS verification overrides and core-equivalent field
  aliases (underscore and Unicode case folding) before DNS. Hysteria2 Realm
  options are unsupported because they introduce additional unpinned targets.
- Reject SOCKS5 TLS domain/custom-name configurations which the locked core cannot
  preserve after IP pinning; keep verified IP-literal TLS and ordinary SOCKS5.
- Preserve HTTP 429 before reading bodies for unlock, proxy and speed checks;
  return only a validated, bounded `retryAfterSeconds` (0–86400), with no retry.
- Exercise trust, hostname identity, cancellation, provider-side hostname routing
  and no direct fallback using loopback fixtures. Native core tests run in CI;
  source-only tests explicitly skip them. No real subscription is exercised.
- Supported release targets are Linux/macOS amd64 and arm64, plus Windows amd64.
  Unix private files use POSIX permissions; Windows uses protected per-user ACLs.
  Native acceptance covers all five targets. The source build requires Linux
  kernel 3.2 with system CA certificates, macOS 13, or Windows 10 / Server 2016 x64.
- Core readiness requires a complete authenticated HTTP round trip through the
  core to an owned temporary loopback endpoint within the shared 10-second
  startup budget. A responsive control API, listening port or CONNECT 200 alone
  is insufficient. The response must match this startup's random identifier and
  the endpoint must confirm handling that request. The endpoint cannot forward
  targets; it and its connections close after success, failure, cancellation or
  core exit. This handshake makes no real-node request and contributes no node
  latency. Ordinary diagnostics still use only the selected node, without direct
  fallback. See the [local readiness design](detector-core-readiness.md).

## Distribution boundary

The release [probe-v0.1.0](https://github.com/58cdn/MiSub/releases/tag/probe-v0.1.0)
was published on 2026-10-12 at 11:32:29 UTC from
`b03b933d42621e7bf2169f07f8d8549ffbbf47df`.
It does not contain the safety changes from [PR #11](https://github.com/58cdn/MiSub/pull/11).
Its successful native CI and separate production control-plane smoke are not real-node/provider acceptance
or verification of complete distribution materials. Existing release assets remain
unchanged; unreleased source changes do not update an installed 0.1.0 detector.

Read-only archive inspection verified the published Linux amd64 archive SHA256
`e3aafe3ed26908ac68ffc5e89ca65177cb56c0f25cb6fdd8eedc02da65c346a0` and source archive
`98d5bf0a7dd6b895e35aafd4a4627bbb04e6097472baefd9cb086c52eb8c7991` against GitHub's
asset digests. The Linux amd64 binary archive contains only `LICENSE.MiSub` and
`LICENSE.mihomo` as license files; the source archive's
`component/ca/ca-certificates.crt` is zero bytes.

The [MiSub Probe 0.2.0 release](https://github.com/58cdn/MiSub/releases/tag/probe-v0.2.0), published on 2026-10-13
from MiSub commit `9ccee76c3cab149f34dca96c304310c9574c0d29`, uses the separately reviewed [source-build
and release workflow](detector-source-release.md). Its matching wrapper, core,
vendor, toolchain, notices and build instructions are supplied with the release.
The gate verifies actual linked-file notice mappings, matching source bytes,
repeat-build output, native fixtures and authenticated GitHub artifact provenance.
These checks do not replace review of license applicability when inputs change.

The source build deliberately preserves the locked upstream empty embedded-CA
file and uses the upstream system certificate pool. It neither injects roots nor
disables TLS verification. Linux requires installed system CA certificates; a
missing or untrusted issuer remains a TLS error. This explicit build recipe does
not retroactively establish the inputs or provenance of the old prebuilt release.

The historical inventory tool retains `ready: false`, and the old
`probe-detector.yml` artifact/publication gates remain frozen. New release assets
are produced by `Probe source release` after an explicit `workflow_dispatch` on
`58cdn/MiSub` main with `publish=true` and all release gates passing. PR, push and
`publish=false` do not upload binary artifacts. Draft upload, inspection and
publication use the same fixed Release ID; existing tags and assets are not
overwritten.

An existing draft may also be published through the explicitly authorized
[recovery path](detector-draft-recovery.md), after downloading and validating all
original assets, matching source materials and signed provenance from the
original run and attempt. Recovery defaults to verification only. Explicit
publication rechecks the remote run, tag, draft and assets before publishing that
same ID, then verifies the resulting public state. It does not rebuild, upload or
replace assets. The release source commit `9ccee76c3cab149f34dca96c304310c9574c0d29` remains distinct
from the recovery tool's own commit; a local verification report or an uncertain
publication result is not evidence that the release is public.

Ordinary Pages deployment remains separate from default-off manual production
resource provisioning and acceptance. Neither source publication nor catalog
activation creates a production detector identity or runs a real-node check.
Live device installation and node/provider acceptance require separate explicit
user action or authorization.

Evidence (reviewed at fixed revisions):

- [Core build workflow](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/.github/workflows/build.yml)
- [SOCKS5 TLS options](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outbound/socks5.go)
- [Nested SS plugin options](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outbound/shadowsocks.go)
- [Snappy license](https://github.com/golang/snappy/blob/v1.0.0/LICENSE)
- [gVisor license](https://github.com/MetaCubeX/gvisor/blob/e2cbcd6e7400/LICENSE)
- [sing license](https://github.com/MetaCubeX/sing/blob/v0.5.8/LICENSE)
- [ZeroTier notice](https://github.com/MetaCubeX/zerotier-go/blob/13fa6f45da5f/NOTICE)
- [Source build recipe](detector-source-build.md)
- [Source release gate](detector-source-release.md)
