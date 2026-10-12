# Detector list and recoverable removal

The detector manager offers explicit card/list preferences, configurable columns and server-side filters/sort/pagination. Name and action columns cannot be hidden. A user's explicit list choice keeps a separately scrollable table on small screens. The toolbar and pagination stay outside horizontal scrolling. Preferences store only validated view/column settings in the current site's browser admin namespace, never detector data, searches or credentials.

Removal is a reversible archive action for revoked detectors. Archive requires administrator auth, same-origin writes, explicit confirmation, a revoked identity and no active task lease. Restore requires the same auth and confirmation and keeps the identity revoked. Both actions are idempotent and preserve the detector row, revoked credential state, task history and attribution; ordinary seven-day task retention still applies. Restore returns the revoked item to the visible list and never reauthorizes its credential. This PR does not delete real production identities.

API additions: POST /api/probes/v1/agents/{id}/archive and /restore with {confirmed:true}. GET /agents/overview accepts offset, limit, q, status, visibility (visible/hidden/all), sort and direction. Unknown/duplicate parameters and unsupported filters are rejected. Sort keys are whitelisted; queries use bindings. Existing status, communication time and task/result timestamps keep their actual meaning. Missing heartbeat-only/capability reports remain explicitly unknown.

## API contract

The overview defaults to `offset=0`, `limit=20`, `q=`, `status=all`,
`visibility=visible`, `sort=createdAt`, and `direction=desc`. The default overview
order is creation time descending followed by identity ascending, including revoked
identities at their creation position. The legacy `GET /agents` array retains its
active-first order and now excludes hidden identities.

Search matches a trimmed literal substring of name, version or platform. ASCII
letter case is ignored; `%` and `_` are literal characters. Search accepts at most
80 characters without control characters. Status accepts `all`, `online`,
`offline`, `unknown`, or `revoked`; visibility accepts `visible`, `hidden`, or
`all`. Sort accepts `createdAt`, `name`, `status`, `lastSeen`, `lastTaskAt`,
`lastResultAt`, or `version`; direction accepts `asc` or `desc`. Status and version
sort lexically. Missing task/result times, never-seen time and empty version sort
last. Every sort uses identity ascending to break ties. Pagination remains bounded
to canonical decimal `offset` 0–100000 and `limit` 1–50. Counts and `nextOffset`
apply to the filtered set, independent of the selected page.

Both overview and history summaries include `hidden`, `archivedAt`,
`lastHeartbeatAt: null`, and `capabilities: null`. `lastSeen` continues to mean
server communication from a claim or accepted heartbeat; neither heartbeat-only
times nor capabilities can be reconstructed from the stored version/platform.
History remains available by identity while hidden and follows normal seven-day
retention. Archive timestamps do not extend task retention.

Archive and restore bodies must contain exactly `{"confirmed":true}` in at most
256 bytes of JSON; query parameters are rejected. Both require administrator auth,
same-origin `Origin`, and a revoked identity. Archive additionally rejects any
running lease whose deadline is after server time. These conditions are checked
in the atomic archive statement, including a repeated archive request.

The action response is `{id, hidden, archivedAt, restoredAt}` under the existing
success/data envelope. Archive/restore timestamps are stable across retries;
archiving again after restore starts a new archive timestamp. Restoring a revoked
identity that was never archived succeeds with null timestamps. The response
describes its own atomic transition even if a concurrent later action changes
visibility. Unknown identities return `404 agent_not_found`; active identities
return `409 agent_must_be_revoked`; a live lease returns
`409 agent_has_active_lease`. Restore never changes revocation or returns a token.

Storage adds only `probe_agent_archives`, keyed by the existing identity with
archive/restore timestamps. Identity rows, retained task/result data and job
attribution are preserved. A failed archive/restore statement cannot partially
apply its transition. These changes create no production identities or credentials.

Cards and table consume the same returned page. Filter/sort changes cancel stale reads and reset pagination; removal refreshes or clamps an empty last page. Column settings use native checkboxes; sorting uses buttons and aria-sort; confirmation and history keep keyboard focus behavior.

Reference research uses sub2api commit ab80abc6d1f929a6864c8804fd077b509d21fda2 (LGPL-3.0). MiSub independently implements the interaction concepts within its existing Vue/Tailwind design, without copying source. UI UX Pro Max guidance applies to focus, accessibility, responsive overflow and confirmation. Offline SQLite, HTTP, component and browser fixtures precede independent review and final-HEAD CI. Existing production provisioning, identity acceptance and binary publication boundaries remain unchanged.
