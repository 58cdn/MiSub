# Local diagnostics executor

## Plan and collaboration boundary

This independently scoped PR adds a runnable Node 22+ command-line executor for
HTTP/HTTPS CONNECT proxy nodes using only standard-library modules. It reuses the
merged diagnostic runner and result contract. It does not edit or depend on PR #8,
its `/api/probes/v1` control plane, D1 tasks, leases or detector identities.

At planning time, main is `81faf16`; open PR #8 is `1511e26`. Issue #7 has no
assignees or comments, and PR #8 has no ownership comments or reviews claiming an
active executor implementation. No repository collaboration/AGENTS file was found.
This PR does not claim the standalone multi-protocol binaries requested in #7.

The executor will read exactly one explicitly consented request from stdin, open
no listener, and emit only sanitized results. HTTP(S) CONNECT is the supported node
protocol; others fail closed. An explicitly selected loopback CONNECT proxy can
serve as an adapter to a separately installed trusted core. The core must already
be configured to use the intended node; the executor does not install or configure
it and cannot attest which upstream a user-managed proxy chooses.

Connection requirements: fixed provider destinations, bounded requests, DNS/IP
validation and pinning, target TLS chain/hostname verification, HTTPS proxy TLS
verification, cancellation and no direct fallback. Offline integration tests use
local fake proxies and TLS targets to prove the data path and rejection behavior.
No real subscriptions, nodes, credentials or production network settings are used.

Each PR remains draft until implementation, independent review, security checks
and final HEAD CI pass. No executor deployment or real-data acceptance is included.
