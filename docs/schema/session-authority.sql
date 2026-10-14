-- Apply only to an explicitly approved, dedicated MISUB_SESSION_DB.
-- The application never runs this schema or initializes a missing row.
CREATE TABLE misub_session_authority (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    document TEXT NOT NULL CHECK (json_valid(document))
);
INSERT INTO misub_session_authority(id, revision, document)
VALUES(1, 0, json_object('schema', 1, 'receiptKey', lower(hex(randomblob(32))),
    'sessions', json('{}'), 'tickets', json('{}'), 'snapshots', json('{}')));
