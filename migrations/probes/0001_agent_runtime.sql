-- Apply only to the dedicated MISUB_PROBE_DB after separate activation approval.
-- Runtime code does not create this table or apply this migration.
CREATE TABLE IF NOT EXISTS probe_agent_runtime_v1 (
    agent_id TEXT PRIMARY KEY REFERENCES probe_agents(id) ON DELETE CASCADE,
    claim_received_at INTEGER CHECK (claim_received_at IS NULL OR (typeof(claim_received_at) = 'integer' AND claim_received_at > 0 AND claim_received_at <= 9007199254740991)),
    last_heartbeat_at INTEGER CHECK (last_heartbeat_at IS NULL OR (typeof(last_heartbeat_at) = 'integer' AND last_heartbeat_at > 0 AND last_heartbeat_at <= 9007199254740991)),
    declaration_state TEXT NOT NULL CHECK (declaration_state IN ('declared', 'legacy', 'missing', 'unsupported_schema', 'invalid_declaration', 'conflicting_versions')),
    observations_version INTEGER CHECK (observations_version IS NULL OR (typeof(observations_version) = 'integer' AND observations_version = 1)),
    capabilities_json TEXT CHECK (capabilities_json IS NULL OR (typeof(capabilities_json) = 'text' AND length(capabilities_json) <= 128 AND json_valid(capabilities_json)))
);
