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
