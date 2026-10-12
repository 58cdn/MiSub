# Node diagnostics interface

This companion to the diagnostics contract adds an explicit per-node diagnostics panel
using existing Vue components. It shows source-specific evidence, errors, freshness and
conflicts; requires consent before sending the selected node to an administrator-managed
executor; and clears pending work on cancel, close or node change.

The separate [basic connectivity check](node-basic-connectivity.md) connects to a saved
node's TCP port from Cloudflare. Its timing is a Worker observation, not local latency
or proof that proxy authentication and forwarding work.

Acceptance uses fixture-only UI tests and a local browser preview. No production node,
subscription, credential, public listener or network configuration is used.

## Delivered behavior

- Manual node rows/cards have a diagnostic action; subscription node preview has
  the same panel inside its existing dialog. Loading capabilities sends no node.
- Each run requires a fresh checkbox confirmation and sends only the selected
  single node to the explicitly configured administrator-owned executor.
- Unsupported/missing configuration, partial results, risk score zero, false and
  unknown flags, per-source errors, IP-family conflicts and freshness are distinct.
- Closing, cancelling or changing node credentials aborts and invalidates pending
  work. No diagnostic state is written to localStorage, KV/D1 or exports.
- Existing Modal focus management is reused; inactive preview content is inert
  and excluded from the focus trap. Return restores the diagnostic trigger.
- Basic connectivity failures do not determine proxy availability. Platform
  restrictions, UDP inapplicability, DNS uncertainty and timeouts have distinct
  labels. Node URLTest remains an executor-only measurement.

UI/UX Pro Max guidance was applied to this component extension: existing Vue and
Tailwind visual conventions, text status labels, keyboard focus, 44px controls,
responsive layout, dark mode and explicit loading/error/empty states. The skill
package search database was unavailable in this delegated environment, so its
general priority guidance and official reference were used; no installer was run.

Provider and executor limitations in `node-diagnostics.md` remain unchanged. UI
fixtures are not a real-node or provider acceptance test.

## Verification

- Integrated offline suite: 161 files, 991 tests passed, with no unhandled errors.
- Production Vite build passed. No dependencies were added.
- Headless Chromium with synthetic fixtures: 1280px light and 375px dark layouts,
  reduced motion, required consent, independent results, no horizontal overflow,
  Escape dismissal, restored focus and disabled unconfigured executor state.
  All external network requests were blocked; no external requests occurred.
- Unit regressions cover pending-result cancellation, node credential changes,
  consent reset, zero/false/unknown values, HTTP failures and modal keyboard traps.
