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
- Supported detector targets are Linux and macOS on amd64 and arm64, with POSIX
  file permissions. Acceptance includes native race and core tests on all four targets.

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

The Pages workflow keeps ordinary main publication but requires separate,
default-off manual inputs for new probe D1 provisioning and production acceptance
that creates temporary detector identities. Script-level event checks also reject
automatic invocations before network operations. Binary publication and artifact
upload additionally remain paused pending the distribution-material review.

The existing root GPL file and `checkout + go mod vendor` source archive do not
establish complete distribution materials. Binary/source artifact uploads and
Release publication require an explicit main-branch manual invocation and remain
disabled by an additional workflow gate. Builds, native tests and source preparation
continue. Wrapper and core licenses remain separate. Restoring distribution requires
an independently reviewed change that verifies and includes:

1. The actual modules/versions/replacements and all applicable LICENSE, NOTICE and
   copyright files, including Snappy (BSD-3-Clause), gVisor (Apache-2.0), sing
   (GPL-3.0-or-later) and zerotier-go (MPL-2.0 with NOTICE).
2. The locked core's upstream build inputs: `with_gvisor`, toolchain/build scripts,
   and generated `component/ca/ca-certificates.crt` data (the committed file is empty).
3. Complete matching wrapper/core/dependency source and build instructions, with a
   specific corresponding-source location shipped with every binary archive.
4. One gate covering both CI binary artifacts and Release assets; passing source
   preparation alone is not proof that the source archive is complete.

Evidence (reviewed at fixed revisions):

- [Core build workflow](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/.github/workflows/build.yml)
- [SOCKS5 TLS options](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outbound/socks5.go)
- [Nested SS plugin options](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/adapter/outbound/shadowsocks.go)
- [Snappy license](https://github.com/golang/snappy/blob/v1.0.0/LICENSE)
- [gVisor license](https://github.com/MetaCubeX/gvisor/blob/e2cbcd6e7400/LICENSE)
- [sing license](https://github.com/MetaCubeX/sing/blob/v0.5.8/LICENSE)
- [ZeroTier notice](https://github.com/MetaCubeX/zerotier-go/blob/13fa6f45da5f/NOTICE)
