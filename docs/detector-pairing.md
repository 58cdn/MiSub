# Detector pairing and installation guidance

MiSub opens a five-minute installation window from Settings → Data & integrations →
Add / manage detectors. The window ID is a public correlation value, not a credential.
The installation command downloads and verifies a compatible detector, which starts a device request using the HTTPS site and window ID.
Its private device secret remains on that client; the client displays a short code.
An authenticated administrator enters the short code, reviews the site and declared
device information, then explicitly approves the request. Approval is required before
the client can exchange its private secret for a detector credential.

This is a device-authorization interaction, not an OAuth implementation. Declared
device names/platforms and comparison codes are not hardware attestation. MiSub's
existing administrator session does not provide separate per-user ownership.

## Credential and database boundaries

- Windows and device requests expire; cancellation and single consumption are
  persisted in the existing probe D1. Public routes do not initialize the database
  or create installation windows.
- Device secrets and comparison codes are stored as hashes. State responses and
  administrator views contain no private device secret or long-lived credential.
- Approval, expiry, cancellation, identity creation and the active-identity limit
  are checked in an atomic transaction. A consumed request cannot produce another
  credential. Token hashes for paired identities bind their purpose and HTTPS site;
  existing manually enrolled identities remain compatible.
- Persistent request/short-code/poll budgets bound attempts and enforce polling
  intervals. Strict inputs, no-store responses, same-origin administrator writes,
  native-request boundaries and redirect refusal apply to pairing.
- The client receives the long-lived token once and writes a private configuration
  file. It is never embedded in URLs, shell commands, packages, browser storage or
  page text. Existing configuration files are not overwritten implicitly.
- If exchange succeeds but its response is lost, or private storage fails, the
  administrator revokes the unconnected identity and starts a new pairing request.
  The server does not retain a recoverable token for response replay.

## Pairing and connection states

The page distinguishes waiting for a device, awaiting administrator confirmation,
approved, identity created, first connection, expired and cancelled. First connection
requires a recorded authenticated claim or heartbeat. Starting a process or completing
the exchange alone does not prove connectivity or a successful node check.

## Installation and release boundaries

The wizard uses the verified [MiSub Probe 0.2.0 release](https://github.com/58cdn/MiSub/releases/tag/probe-v0.2.0), built from MiSub commit `9ccee76c3cab149f34dca96c304310c9574c0d29`. Its inspectable command downloads fixed release assets, checks their size, SHA256 and client capabilities, then requests pairing approval before private configuration, user installation and explicit startup. Linux/macOS use the verified Bash bootstrap; Windows downloads the raw EXE and invokes native `--setup`. It does not require a pre-existing executable. Unknown, failed or unavailable release metadata keeps the installation entry disabled.

The older `probe-v0.1.0` lacks these pairing and installation commands. Direct `--pair` still only saves the private configuration and exits; direct `--install` only installs, and `--start` explicitly starts an installed client. Resume uses an existing private configuration without another pairing request or expired window. No system service, login startup, public listener, system proxy, TUN, elevation, linger configuration or execution-policy change is part of this flow.

## Acceptance

Use SQLite fixtures for atomic exchange, identity-limit races, cancellation/expiry,
replay, origin binding and persistent budgets. Use HTTP/TLS fixtures for the CLI and
browser fixtures for the wizard. Live pairing, persistent identity creation, service startup and actual-node/provider checks require separate explicit user action or authorization. Release availability and Pages deployment do not establish this acceptance.
