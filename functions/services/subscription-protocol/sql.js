// Explicit migration/test input only. Runtime requests never execute this schema.
export const PROTOCOL_SCHEMA_VERSION = 1;
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_CAPACITY = 10000;
// D1StorageAdapter maps the logical worker_settings_v1 key to this physical row.
export const SETTINGS_ROW_KEY = 'main';
// Keep the request policy scalar: settings can contain unrelated secrets.
const REQUEST_POLICY_SQL = `CASE WHEN json_type(COALESCE(
    (SELECT value FROM settings WHERE key='${SETTINGS_ROW_KEY}'),'{}'
    ), '$.builtinSkipCertVerify')='true' THEN 1 ELSE 0 END`;
export const PROTOCOL_SCHEMA = [
    `CREATE TABLE subscription_protocol_epochs (epoch TEXT PRIMARY KEY)`,
    `CREATE TABLE subscription_protocol_meta (id INTEGER PRIMARY KEY CHECK(id=1),
        authority TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
        epoch TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))`,
    `CREATE TRIGGER subscription_protocol_initial_epoch AFTER INSERT ON subscription_protocol_meta BEGIN
        INSERT INTO subscription_protocol_epochs VALUES(NEW.epoch); END`,
    `CREATE TRIGGER subscription_protocol_rotate_epoch AFTER UPDATE OF epoch ON subscription_protocol_meta
        WHEN OLD.epoch!=NEW.epoch BEGIN INSERT INTO subscription_protocol_epochs VALUES(NEW.epoch); END`,
    `CREATE TABLE subscription_protocol_receipts (epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, subscriptions INTEGER NOT NULL,
        profiles INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(epoch,operation_id))`,
    `CREATE TABLE subscription_protocol_seal (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE subscription_protocol_gate (id INTEGER PRIMARY KEY CHECK(id=1),
        authority TEXT NOT NULL, epoch TEXT NOT NULL, base_revision INTEGER NOT NULL,
        operation_id TEXT NOT NULL, digest TEXT NOT NULL, next_epoch TEXT NOT NULL,
        apply INTEGER NOT NULL CHECK(apply IN (0,1)), expires_at INTEGER NOT NULL,
        request_policy INTEGER CHECK(request_policy IN (0,1)),
        must_close INTEGER NOT NULL DEFAULT 1 REFERENCES subscription_protocol_seal(id) DEFERRABLE INITIALLY DEFERRED)`,
    `CREATE TRIGGER subscription_protocol_admission BEFORE INSERT ON subscription_protocol_gate BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM subscription_protocol_meta WHERE id=1 AND schema_version=1)
            THEN RAISE(ABORT,'subscription_schema_not_ready') END;
        SELECT CASE WHEN NEW.authority!=(SELECT authority FROM subscription_protocol_meta WHERE id=1)
            THEN RAISE(ABORT,'subscription_authority_mismatch') END;
        SELECT CASE WHEN NEW.epoch!=(SELECT epoch FROM subscription_protocol_meta WHERE id=1)
            THEN RAISE(ABORT,'subscription_epoch_conflict') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM subscription_protocol_receipts WHERE epoch=NEW.epoch
            AND operation_id=NEW.operation_id AND digest!=NEW.digest)
            THEN RAISE(ABORT,'subscription_operation_id_conflict') END;
        SELECT CASE WHEN NEW.apply!=NOT EXISTS(SELECT 1 FROM subscription_protocol_receipts
            WHERE epoch=NEW.epoch AND operation_id=NEW.operation_id)
            THEN RAISE(ABORT,'subscription_invalid_operation') END;
        SELECT CASE WHEN NEW.apply=1 AND NEW.base_revision!=(SELECT revision FROM subscription_protocol_meta WHERE id=1)
            THEN RAISE(ABORT,'subscription_revision_conflict') END;
        SELECT CASE WHEN NEW.apply=1 AND NEW.request_policy IS NOT NULL AND NEW.request_policy!=(${REQUEST_POLICY_SQL})
            THEN RAISE(ABORT,'subscription_identity_conflict') END;
        SELECT CASE WHEN NEW.apply=1 AND NEW.next_epoch!=NEW.epoch AND
            EXISTS(SELECT 1 FROM subscription_protocol_epochs WHERE epoch=NEW.next_epoch)
            THEN RAISE(ABORT,'subscription_epoch_conflict') END;
        SELECT CASE WHEN NEW.apply=1 AND (SELECT count(*) FROM subscription_protocol_receipts)>=10000
            THEN RAISE(ABORT,'subscription_receipt_capacity') END;
    END`,
    ...['subscriptions', 'profiles'].flatMap((table) =>
        ['INSERT', 'UPDATE', 'DELETE'].map(
            (verb) =>
                `CREATE TRIGGER subscription_protocol_${table}_${verb.toLowerCase()} BEFORE ${verb} ON ${table} BEGIN
            SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM subscription_protocol_gate WHERE id=1 AND apply=1)
                THEN RAISE(ABORT,'subscription_legacy_write_blocked') END; END`
        )
    ),
    `CREATE TRIGGER subscription_protocol_meta_guard BEFORE UPDATE ON subscription_protocol_meta BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM subscription_protocol_gate WHERE id=1 AND apply=1)
            THEN RAISE(ABORT,'subscription_legacy_write_blocked') END;
    END`,
    `CREATE TRIGGER subscription_protocol_close_guard BEFORE DELETE ON subscription_protocol_gate WHEN OLD.apply=1 BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM subscription_protocol_meta m JOIN subscription_protocol_receipts r
            ON r.epoch=m.epoch AND r.revision=m.revision WHERE m.id=1 AND m.epoch=OLD.next_epoch
            AND m.revision=CASE WHEN OLD.epoch=OLD.next_epoch THEN OLD.base_revision+1 ELSE 0 END
            AND r.operation_id=OLD.operation_id AND r.digest=OLD.digest)
            THEN RAISE(ABORT,'subscription_invalid_operation') END;
    END`,
];

export const SNAPSHOT_SQL = `SELECT authority,schema_version,epoch,revision,
    (${REQUEST_POLICY_SQL}) request_policy,
    (SELECT json_group_array(json(data)) FROM (SELECT data FROM subscriptions ORDER BY id)) subscriptions,
    (SELECT json_group_array(json(data)) FROM (SELECT data FROM profiles ORDER BY id)) profiles,
    (SELECT count(*) FROM subscriptions WHERE id!=json_extract(data,'$.id') OR json_type(data)!='object') bad_subscriptions,
    (SELECT count(*) FROM profiles WHERE id!=json_extract(data,'$.id') OR json_type(data)!='object') bad_profiles
    FROM subscription_protocol_meta WHERE id=1`;

export function compileCommit({
    authority,
    baseVersion,
    operationId,
    digest,
    next,
    nextEpoch,
    requestPolicy = null,
    now,
}) {
    const target = nextEpoch ?? baseVersion.epoch;
    const step = (sql, ...args) => ({ sql, args });
    const apply = 'EXISTS(SELECT 1 FROM subscription_protocol_gate WHERE id=1 AND apply=1)';
    return [
        step('DELETE FROM subscription_protocol_receipts WHERE expires_at<=?', now),
        step(
            `INSERT INTO subscription_protocol_gate(id,authority,epoch,base_revision,operation_id,digest,next_epoch,apply,expires_at,request_policy)
            SELECT 1,?,?,?,?,?,?,NOT EXISTS(SELECT 1 FROM subscription_protocol_receipts WHERE epoch=? AND operation_id=?),?,? RETURNING apply`,
            authority,
            baseVersion.epoch,
            baseVersion.revision,
            operationId,
            digest,
            target,
            baseVersion.epoch,
            operationId,
            now + RECEIPT_TTL_MS,
            requestPolicy
        ),
        ...['subscriptions', 'profiles'].flatMap((table) => [
            step(`DELETE FROM ${table} WHERE ${apply}`),
            step(
                `INSERT INTO ${table}(id,data) SELECT json_extract(value,'$.id'),value FROM json_each(?) WHERE ${apply}`,
                JSON.stringify(next[table])
            ),
        ]),
        step(
            `UPDATE subscription_protocol_meta SET epoch=?,revision=CASE WHEN epoch=? THEN revision+1 ELSE 0 END WHERE id=1 AND ${apply}`,
            target,
            target
        ),
        step(`INSERT INTO subscription_protocol_receipts SELECT m.epoch,g.operation_id,g.digest,m.revision,
            (SELECT count(*) FROM subscriptions),(SELECT count(*) FROM profiles),g.expires_at
            FROM subscription_protocol_meta m,subscription_protocol_gate g WHERE m.id=1 AND g.id=1 AND g.apply=1`),
        step('DELETE FROM subscription_protocol_gate WHERE id=1'),
        step(
            'SELECT * FROM subscription_protocol_receipts WHERE epoch=? AND operation_id=?',
            target,
            operationId
        ),
    ];
}
