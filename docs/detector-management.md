# Detector management

Settings → Data & integrations → Add / manage detectors is the management entrypoint.
It reuses `/api/probes/v1` enrollment, authentication, revocation and persisted task
results. Node check panels link to this page and keep detector selection for each run.
The direct link is `/dashboard/settings?focus=detectors`. The settings dialog opens
this dedicated page, so configuration and revocation confirmations use a single
dialog layer. Detector requests start only when the section is opened.

## Evidence and status

`GET /agents/overview?offset=0&limit=20` returns a paged administrator-only overview.
`GET /agents/{id}/history?offset=0&limit=20` returns persisted tasks for that detector.
The history task-state filter accepts `queued`, `running`, `done`, `cancelled` or
`expired`; omitting `state` returns all tasks. The total count and pagination apply
to the selected state. `done` means a task returned results, including failed checks.
Both use the existing probe database and seven-day task retention. No new database,
credential protocol or detector deployment is introduced.
Each page contains 20 records. API callers can request 1–50 records and an offset up
to 100,000. The list refreshes every 30 seconds while visible; automatic refresh can
be paused. Requests are cancelled when the section is hidden or left.

Online means the server received a claim or heartbeat within two minutes. Offline
means the last communication is older; never-seen or invalid timestamps are unknown.
Revoked identities remain visible with a revoked status. This status does not prove
node connectivity or Provider availability. A failed refresh makes displayed status
stale rather than reporting detectors as offline.

The interface distinguishes last communication, latest task creation and latest
accepted result. History includes task state, attempt, completion time and sanitized
checks. Completion may also mean cancellation or expiration; it is not a successful
network result. Version and platform appear only when reported. Capabilities are not
inferred from version strings or past results.

## Actions and privacy

The installation and connection wizard opens a short-lived window for an already
installed pairing-capable client. The administrator enters the terminal's short
code, compares its site and request fingerprint, and explicitly approves. The page
distinguishes identity creation from the first authenticated communication; it never
receives the permanent credential. See [pairing](detector-pairing.md) and the
[API contract](detector-pairing-api.md). Package distribution remains paused.

Private configuration enrollment remains available as an advanced option.
Creation and revocation reuse the existing administrator session and same-origin
checks. Creation is an explicit action; its private configuration is offered once
and kept only in component memory until dismissed or the page is left. Lists and
history contain no token, token hash, lease secret or raw node configuration.
The downloaded `probe.json` contains the current MiSub origin and the new detector's
token; it is not written to browser storage or rendered in the page. Closing the
configuration dialog before downloading requires confirmation. An uncertain creation
response is not automatically retried: refresh the list and revoke any unusable
identity before creating another.
Revocation requires confirmation and stops queued/running tasks under the existing
API. History remains available within the retention period.

Production database provisioning, smoke identities and binary publication retain
their existing manual gates. Component and browser acceptance use offline fixtures;
this feature does not authorize production enrollment or real-node probing.

## Local acceptance

Run the repository unit suite with `npm run test:run`. The SQLite control-plane
checks, including overview/history permissions and pagination, run with
`node --test tests/probes/*.check.mjs`. Run the browser fixture with
`node tests/browser/detector-management.mjs <evidence-directory>` after installing
the locked dependencies and a Playwright Chromium executable. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using an existing Chromium installation.
The fixture serves only on loopback, intercepts all probe API requests, rejects
external requests and checks desktop/mobile rendering, pagination, download,
confirmation, refresh failure and unconfigured storage.
