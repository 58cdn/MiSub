// Offline protocol model. No application imports, bindings, HTTP routes or migration runner.
import { createHash } from 'node:crypto';

const tables = ['model_subscriptions', 'model_profiles'];
export const MODEL_LIMITS = Object.freeze({ bytes: 262144, items: 1000, receipts: 128 });
export const MODEL_SCHEMA = [
    `CREATE TABLE model_epochs (epoch TEXT PRIMARY KEY)`,
    `CREATE TABLE model_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))`,
    `CREATE TRIGGER model_initial_epoch AFTER INSERT ON model_meta BEGIN
        INSERT INTO model_epochs VALUES(NEW.epoch);
    END`,
    `CREATE TRIGGER model_rotate_epoch AFTER UPDATE OF epoch ON model_meta
        WHEN NEW.epoch!=OLD.epoch BEGIN
        INSERT INTO model_epochs VALUES(NEW.epoch);
    END`,
    ...tables.map((name) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`),
    `CREATE TABLE model_receipts (epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, subscriptions INTEGER NOT NULL,
        profiles INTEGER NOT NULL, PRIMARY KEY(epoch,operation_id))`,
    `CREATE TABLE model_gate_seal (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE model_gate (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL,
        base_revision INTEGER NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
        next_epoch TEXT NOT NULL, apply INTEGER NOT NULL CHECK(apply IN (0,1)),
        must_close INTEGER NOT NULL DEFAULT 1 REFERENCES model_gate_seal(id)
            DEFERRABLE INITIALLY DEFERRED)`,
    `CREATE TRIGGER model_admission BEFORE INSERT ON model_gate BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_meta WHERE id=1)
            THEN RAISE(ABORT,'model_uninitialized') END;
        SELECT CASE WHEN NEW.epoch != (SELECT epoch FROM model_meta WHERE id=1)
            THEN RAISE(ABORT,'model_epoch_conflict') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM model_receipts WHERE epoch=NEW.epoch
            AND operation_id=NEW.operation_id AND digest!=NEW.digest)
            THEN RAISE(ABORT,'model_operation_conflict') END;
        SELECT CASE WHEN NEW.apply != NOT EXISTS(SELECT 1 FROM model_receipts
            WHERE epoch=NEW.epoch AND operation_id=NEW.operation_id)
            THEN RAISE(ABORT,'model_invalid_gate') END;
        SELECT CASE WHEN NEW.apply=1 AND NEW.base_revision !=
            (SELECT revision FROM model_meta WHERE id=1)
            THEN RAISE(ABORT,'model_revision_conflict') END;
        SELECT CASE WHEN NEW.apply=1 AND NEW.next_epoch!=NEW.epoch AND
            EXISTS(SELECT 1 FROM model_epochs WHERE epoch=NEW.next_epoch)
            THEN RAISE(ABORT,'model_epoch_reused') END;
        SELECT CASE WHEN NEW.apply=1 AND (SELECT count(*) FROM model_receipts)>=128
            THEN RAISE(ABORT,'model_receipt_capacity') END;
    END`,
    ...tables.flatMap((name) =>
        ['INSERT', 'UPDATE', 'DELETE'].map(
            (verb) => `CREATE TRIGGER ${name}_${verb.toLowerCase()} BEFORE ${verb} ON ${name}
            BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_gate WHERE id=1 AND apply=1)
                THEN RAISE(ABORT,'model_unversioned_write') END; END`
        )
    ),
    `CREATE TRIGGER model_meta_guard BEFORE UPDATE ON model_meta BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_gate WHERE id=1 AND apply=1)
            THEN RAISE(ABORT,'model_unversioned_write') END;
    END`,
    `CREATE TRIGGER model_close_guard BEFORE DELETE ON model_gate WHEN OLD.apply=1 BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM model_meta m JOIN model_receipts r
            ON r.epoch=m.epoch AND r.revision=m.revision
            WHERE m.id=1 AND m.epoch=OLD.next_epoch
            AND m.revision=CASE WHEN OLD.epoch=OLD.next_epoch THEN OLD.base_revision+1 ELSE 0 END
            AND r.operation_id=OLD.operation_id AND r.digest=OLD.digest)
            THEN RAISE(ABORT,'model_incomplete_commit') END;
    END`,
];

function reject(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])])
        );
    }
    return value;
}

function validToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateCollections(data) {
    const collections = [data?.subscriptions, data?.profiles];
    for (const items of collections) {
        if (!Array.isArray(items) || items.length > MODEL_LIMITS.items)
            reject('model_invalid_data');
        const ids = new Set();
        for (const item of items) {
            if (
                !item ||
                typeof item !== 'object' ||
                Array.isArray(item) ||
                typeof item.id !== 'string' ||
                !item.id.trim() ||
                ids.has(item.id)
            ) {
                reject('model_invalid_data');
            }
            ids.add(item.id);
        }
    }
    const ids = new Set(data.subscriptions.map((item) => item.id));
    for (const profile of data.profiles) {
        for (const field of ['subscriptions', 'manualNodes']) {
            if (profile[field] === undefined) continue;
            if (
                !Array.isArray(profile[field]) ||
                new Set(profile[field]).size !== profile[field].length ||
                profile[field].some((id) => !ids.has(id))
            )
                reject('model_invalid_reference');
        }
    }
}

export function requireAtomicBackend(backend) {
    if (backend !== 'd1-model') reject('model_atomic_backend_required');
}

/** Compile a bounded SERVER-PREPARED snapshot. Not an HTTP/client payload contract. */
export function compileSnapshotCommit({ backend, baseVersion, operationId, next, nextEpoch }) {
    requireAtomicBackend(backend);
    if (!baseVersion) reject('model_version_required');
    if (
        !validToken(baseVersion.epoch) ||
        !Number.isSafeInteger(baseVersion.revision) ||
        baseVersion.revision < 0 ||
        !validToken(operationId)
    )
        reject('model_invalid_version');
    const targetEpoch = nextEpoch ?? baseVersion.epoch;
    if (!validToken(targetEpoch)) reject('model_invalid_epoch');
    if (nextEpoch !== undefined && targetEpoch === baseVersion.epoch) reject('model_epoch_reused');
    let serialized;
    try {
        serialized = JSON.stringify(stable(next));
    } catch {
        reject('model_invalid_data');
    }
    if (!serialized || Buffer.byteLength(serialized) > MODEL_LIMITS.bytes) reject('model_capacity');
    const data = JSON.parse(serialized);
    validateCollections(data);
    const digest = createHash('sha256')
        .update(
            JSON.stringify({
                baseVersion: { epoch: baseVersion.epoch, revision: baseVersion.revision },
                targetEpoch,
                data,
            })
        )
        .digest('hex');
    const step = (sql, ...args) => ({ sql, args });
    const writable = 'EXISTS(SELECT 1 FROM model_gate WHERE id=1 AND apply=1)';
    return [
        step(
            `INSERT INTO model_gate(id,epoch,base_revision,operation_id,digest,next_epoch,apply) SELECT 1,?,?,?,?,?,
            NOT EXISTS(SELECT 1 FROM model_receipts WHERE epoch=? AND operation_id=?)`,
            baseVersion.epoch,
            baseVersion.revision,
            operationId,
            digest,
            targetEpoch,
            baseVersion.epoch,
            operationId
        ),
        ...tables.flatMap((name, index) => [
            step(`DELETE FROM ${name} WHERE ${writable}`),
            step(
                `INSERT INTO ${name}(id,data) SELECT json_extract(value,'$.id'),value
                FROM json_each(?) WHERE ${writable}`,
                JSON.stringify(index ? data.profiles : data.subscriptions)
            ),
        ]),
        step(
            `UPDATE model_meta SET epoch=?,revision=CASE WHEN epoch=? THEN revision+1 ELSE 0 END
            WHERE id=1 AND ${writable}`,
            targetEpoch,
            targetEpoch
        ),
        step(`INSERT INTO model_receipts SELECT m.epoch,g.operation_id,g.digest,m.revision,
            (SELECT count(*) FROM model_subscriptions),(SELECT count(*) FROM model_profiles)
            FROM model_meta m,model_gate g WHERE m.id=1 AND g.id=1 AND g.apply=1`),
        step('DELETE FROM model_gate WHERE id=1'),
        step(
            `SELECT epoch,operation_id,digest,revision,subscriptions,profiles FROM model_receipts
            WHERE epoch=? AND operation_id=?`,
            targetEpoch,
            operationId
        ),
    ];
}

// All collections and their version are obtained by one SQL statement/snapshot.
export const MODEL_READ = `SELECT epoch,revision,
    (SELECT json_group_array(json(data)) FROM (SELECT data FROM model_subscriptions ORDER BY id)) subscriptions,
    (SELECT json_group_array(json(data)) FROM (SELECT data FROM model_profiles ORDER BY id)) profiles
    FROM model_meta WHERE id=1`;
