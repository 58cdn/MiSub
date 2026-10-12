# Detector management

Settings → Data & integrations → Add / manage detectors is the management entrypoint.
It reuses `/api/probes/v1` enrollment, authentication, revocation and persisted task
results. Node check panels link to this page and keep detector selection for each run.

## Evidence and status

`GET /agents/overview?offset=0&limit=20` returns a paged administrator-only overview.
`GET /agents/{id}/history?offset=0&limit=20` returns persisted tasks for that detector.
Both use the existing probe database and seven-day task retention. No new database,
credential protocol or detector deployment is introduced.

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

Creation and revocation reuse the existing administrator session and same-origin
checks. Creation is an explicit action; its private configuration is offered once
and kept only in component memory until dismissed or the page is left. Lists and
history contain no token, token hash, lease secret or raw node configuration.
Revocation requires confirmation and stops queued/running tasks under the existing
API. History remains available within the retention period.

Production database provisioning, smoke identities and binary publication retain
their existing manual gates. Component and browser acceptance use offline fixtures;
this feature does not authorize production enrollment or real-node probing.
