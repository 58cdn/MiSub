# Detector hardening plan

This follow-up uses the merged native detector from PR #10, based on main
`8e55c11e17ced334ba3ecafa0aead159310d1c5d`. It reuses safety/fixture acceptance
intent from draft PR #9 without adding a second executor or task entrypoint.

First reproduce and fix nested TLS-disable options, unsupported SOCKS5 TLS
identity after IP pinning, and HTTP 429 headers/Retry-After preservation. Preserve
existing conservative unlock results, proxy-side provider DNS semantics and the
single task/lease control plane. The reported config receiver issue was retracted:
`Config.validate` already uses a pointer receiver; it will not be changed for that
claim.

Review existing MIT wrapper/GPL kernel notices, pinned artifacts and corresponding
source packaging without relicensing the repository or claiming release acceptance.
Independent review and final HEAD CI are required before merging; native fixture
success is not a real user node or provider acceptance test. No production service,
long-lived credential or real subscription is configured by this work.

Source observations/IP quality and their unified task UI will be separate PRs after
this safety correction, preserving independent source evidence and explicit unknowns.

## Implemented acceptance boundaries

- Reject nested, coerced and ambiguous-case TLS verification overrides before DNS.
- Reject SOCKS5 TLS domain/custom-name configurations which the locked core cannot
  preserve after IP pinning; keep verified IP-literal TLS and ordinary SOCKS5.
- Preserve HTTP 429 before reading bodies for unlock, proxy and speed checks;
  return only a validated, bounded `retryAfterSeconds` (0–86400), with no retry.
- Exercise trust, hostname identity, cancellation, provider-side hostname routing
  and no direct fallback using loopback fixtures. Native core tests run in CI;
  source-only tests explicitly skip them. No real subscription is exercised.
- Windows is not a detector target. Its POSIX file-mode test fails as expected;
  targeted local tests do not replace full Linux/macOS race and core CI results.

## Distribution gate (paused)

Independent inspection of the locked core found that the existing root GPL file
and `checkout + go mod vendor` source archive do not yet establish complete
distribution materials. This PR disables binary/source artifact upload and Release
publication, while preserving all builds, native tests and source preparation.
There is no repository-wide license change. A follow-up must verify and include:

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
