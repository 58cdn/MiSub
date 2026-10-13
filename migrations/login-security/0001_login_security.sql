-- Apply only to the separately approved MISUB_SECURITY_DB. Runtime never runs DDL.
CREATE TABLE IF NOT EXISTS login_security_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    clock_ms INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO login_security_config (id, schema_version, enabled) VALUES (1, 1, 0);

CREATE TABLE IF NOT EXISTS login_security_ips (
    ip TEXT PRIMARY KEY,
    failures INTEGER NOT NULL CHECK (failures BETWEEN 0 AND 10),
    window_started_at INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    operation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_security_ips_updated ON login_security_ips(updated_at);

-- Only timestamps are needed for the next successful login's global warning.
CREATE TABLE IF NOT EXISTS login_security_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_security_failures_created ON login_security_failures(created_at);

CREATE TABLE IF NOT EXISTS login_security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('login_success', 'login_warning')),
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    ip TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    failed_attempts INTEGER,
    since INTEGER,
    last_failure_at INTEGER,
    UNIQUE(operation_id, type)
);
CREATE INDEX IF NOT EXISTS login_security_events_created ON login_security_events(created_at);
CREATE INDEX IF NOT EXISTS login_security_events_unread ON login_security_events(read_at, type);
