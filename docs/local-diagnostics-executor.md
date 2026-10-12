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

## Running locally

Requires an already installed Node.js 22 or later. No npm install, proxy core,
container or service installation is needed for this executor. From this checkout:

```sh
node executors/connect/cli.js --help
node executors/connect/cli.js --consent < request.json
```

The caller prepares `request.json` locally with exactly one node, explicit source
IDs and consent. This is only a format example, not a reachable test node:

```json
{
    "node": "https://proxy.example.invalid:443",
    "sources": ["latency", "ipify", "ip_sb", "ippure", "openai"],
    "consent": true
}
```

Do not commit a real request file. Standard input avoids placing node credentials
in command-line arguments. The executor does not write the input to disk or log
it; results go to stdout. Missing consent, unknown protocols and malformed input
fail before network access. Stdin is limited to 16 KiB and five seconds.

To explicitly use an already configured trusted core's **HTTP CONNECT** listener,
use `--allow-loopback-proxy` and a literal `127.0.0.1` or `::1` node URL. The option
does not permit private provider targets or arbitrary local DNS names. It does
not start a core, select its upstream, or prove that an original SS/VLESS URI has
been selected. SOCKS, SS, VMess, VLESS, Trojan, Hysteria and other node protocols
are currently unsupported by this adapter. The CLI opens no listening port.

Both HTTP and HTTPS proxy nodes are supported. **HTTP proxy authentication is
plaintext on the connection to that proxy**; HTTPS proxy nodes protect that layer
with TLS. Provider requests always use verified TLS inside CONNECT. Basic proxy
credentials never enter provider headers; IPinfo bearer credentials never enter
CONNECT headers. The CLI leaves IPinfo unconfigured; an embedding application
may supply an existing `ipinfoToken` to `executeRequest()` without exposing it in
the input/result JSON. No token is generated here.

## Transport and security behavior

- Only exact HTTPS targets in the existing source registry are accepted. Redirects
  are never followed, including redirects returned by the proxy.
- Proxy and target DNS answers are all checked; mixed public/private answers are
  rejected. A validated numeric proxy IP is used for the only outbound socket;
  a validated numeric target IP is sent in CONNECT. There is no second resolution
  or direct connection fallback. IPv4 private/reserved ranges and non-global or
  special-purpose IPv6 ranges are denied conservatively.
- Target resolution uses the executor's resolver, **not proxy-side DNS**. Results
  therefore describe a connection to that resolved target IP through the proxy.
- Original DNS names remain in TLS SNI, certificate identity checks and HTTP Host.
  IP-literal HTTPS proxies require the corresponding IP SAN. Both TLS layers
  enforce certificate trust and identity, TLS 1.2 minimum, and HTTP/1.1.
- A dedicated one-socket HTTP Agent can only reuse the already-built tunnel. It
  never creates a target connection or honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY.
- Each operation has a five-second deadline across DNS, TCP, both TLS handshakes,
  CONNECT, headers and body; cancellation destroys the tunnel. A late DNS answer
  cannot start a connection. Responses are capped at 8 KiB headers/16 KiB body,
  concurrency at three, and stdin at one request per CLI process.
- The executor runs and validates the shared result contract, preserving errors,
  timestamps, independent source conflicts and unknown values.
  Its cooldown is in memory: **it is not a cross-process or distributed quota**.
  Repeated CLI invocations remain the operator's responsibility. The embedding
  API should reuse a runner and add shared quotas if it becomes a service.
- Errors shown by the CLI are sanitized; no raw node URI or credential is returned.
  `createConnectTransport()` is a low-level library and callers must sanitize its
  thrown exceptions before exposing them outside their process.

The implementation uses [Node's HTTP CONNECT API](https://nodejs.org/docs/latest-v22.x/api/http.html#event-connect),
[TLS socket wrapping](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsconnectoptions-callback)
and [DNS lookup](https://nodejs.org/docs/latest-v22.x/api/dns.html#dnslookuphostname-options-callback).
It adds no third-party dependencies or copied proxy-core code.

## Offline acceptance and remaining integration

```sh
node --test tests/executor/*.check.mjs
```

Tests require a locally installed OpenSSL (`OPENSSL_PATH` may point to it). They
generate a one-day fixture certificate in a temporary directory and remove it at
the end. All fixture servers bind only to `127.0.0.1` on ephemeral ports. A dial
assertion rejects any executor connection that bypasses the registered fake
proxy, and global fetch is disabled. Test DNS/CA dependencies are injected only
through the library; stdin cannot set them. No real provider or proxy is contacted.

The implementation and independent review each passed all 32 offline integration
tests locally on Node 24. CI runs the same suite on Node 22 alongside the existing
application test/build workflow. Tests cover both CONNECT schemes, TLS trust and
hostname failures, pinned DNS, late cancellation, bounded responses, rate-limit
headers, credential separation, conflicting source results and CLI input limits.

This is now an actual runnable CONNECT transport, not only a report contract. It
is **not connected to the deployed Pages UI**, the `NODE_DIAGNOSTICS` service
binding, or PR #8's task polling protocol. No service, D1 binding or detector token
is created. An independently reviewed bridge may reuse this transport later.
The different current contracts are:

| main diagnostic boundary                     | PR #8 control plane (separate, unmerged at design time)      |
| -------------------------------------------- | ------------------------------------------------------------ |
| One synchronous request via service binding  | Persistent tasks claimed by detector identity and lease      |
| `{version, requestId, node, sources}`        | Node/agent tasks plus five check categories and options      |
| Independent source observations in v1 report | Per-node/per-agent `checks` DTO and idempotent result upload |
| Existing admin session, per-run consent      | Admin session plus separately managed detector token         |

No translation between those contracts is implicit. This change also does not
provide native multi-protocol binaries, download speed tests, positive unlock
evidence, proxy-side DNS tests or live provider acceptance. OpenAI ordinary 200/401
remains unknown, and unimplemented unlock providers remain unsupported. Local
fixture success proves the controlled transport path, not a production node's
exit country, reputation or service availability.
