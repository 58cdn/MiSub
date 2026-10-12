# Node diagnostics interface

This companion to the diagnostics contract adds an explicit per-node diagnostics panel
using existing Vue components. It shows source-specific evidence, errors, freshness and
conflicts; requires consent before sending the selected node to an administrator-managed
executor; and clears pending work on cancel, close or node change.

The existing browser probe must be labelled HTTP reachability timing, not TCP RTT or
node latency. Browser fetch failures must not be presented as a successful measurement.

Acceptance uses fixture-only UI tests and a local browser preview. No production node,
subscription, credential, public listener or network configuration is used.
