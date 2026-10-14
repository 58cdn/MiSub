// Pure offline planner: accepts supplied physical rows, never resolves a binding or executes SQL.
import {
    PROTOCOL_SCHEMA,
    PROTOCOL_SCHEMA_VERSION,
    SETTINGS_ROW_KEY,
    RULES_ROW_KEY,
} from '../../functions/services/subscription-protocol/sql.js';
import {
    canonicalJson,
    hashValue,
    validateSnapshot,
    validId,
    validateDomains,
    PROTOCOL_LIMITS,
} from '../../functions/services/subscription-protocol/operations.js';
import {
    protocolError,
    validToken,
} from '../../functions/services/subscription-protocol/errors.js';

const columns = {
    subscriptions: ['id', 'data', 'created_at', 'updated_at'],
    profiles: ['id', 'data', 'created_at', 'updated_at'],
    settings: ['key', 'value', 'created_at', 'updated_at'],
};
const encoder = new TextEncoder();
// Match SQLite BINARY / UTF-8 order so a readback has the same physical-row digest.
const compare = (a, b) => {
    const left = encoder.encode(a),
        right = encoder.encode(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++)
        if (left[i] !== right[i]) return left[i] - right[i];
    return left.length - right.length;
};

function physicalRows(rows, table) {
    if (!Array.isArray(rows)) throw protocolError('invalid_data');
    const fields = columns[table],
        key = fields[0],
        ids = new Set();
    const result = rows.map((row) => {
        if (
            !row ||
            typeof row !== 'object' ||
            Array.isArray(row) ||
            Object.keys(row).some((field) => !fields.includes(field)) ||
            typeof row[key] !== 'string' ||
            !row[key] ||
            ids.has(row[key]) ||
            !Object.hasOwn(row, fields[1])
        )
            throw protocolError('invalid_data');
        ids.add(row[key]);
        const value = Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
        if (
            fields.some((field) => value[field] !== null && typeof value[field] !== 'string') ||
            (table !== 'settings' && typeof value.data !== 'string')
        )
            throw protocolError('invalid_data');
        return value;
    });
    return result.sort((a, b) => compare(a[key], b[key]));
}

function validateSettings(rows) {
    const values = new Map(rows.map((row) => [row.key, row.value]));
    try {
        const settings = values.has(SETTINGS_ROW_KEY)
            ? JSON.parse(values.get(SETTINGS_ROW_KEY))
            : {};
        const ruleTemplates = values.has(RULES_ROW_KEY)
            ? JSON.parse(values.get(RULES_ROW_KEY))
            : [];
        // The protocol chooses authority separately; retain the legacy setting bytes.
        if (!settings || Array.isArray(settings) || typeof settings !== 'object')
            throw protocolError('invalid_data');
        validateDomains({ settings: { ...settings, storageType: 'd1' }, ruleTemplates });
    } catch (error) {
        if (error?.code) throw error;
        throw protocolError('invalid_data');
    }
}

function expand(rows) {
    if (!Array.isArray(rows)) throw protocolError('invalid_data');
    const found = new Map();
    const metadata = new Map();
    let identicalDuplicates = 0,
        legacyRows = 0;
    for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.data !== 'string')
            throw protocolError('invalid_data');
        let value;
        try {
            value = JSON.parse(row.data);
        } catch {
            throw protocolError('invalid_data');
        }
        if (row.id === 'main' && !Array.isArray(value)) throw protocolError('migration_required');
        if (row.id !== 'main' && (!value || Array.isArray(value) || row.id !== value.id))
            throw protocolError('invalid_data');
        const items = row.id === 'main' ? value : [value];
        if (row.id === 'main') legacyRows++;
        for (const item of items) {
            if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id))
                throw protocolError('invalid_data');
            if (found.has(item.id)) {
                if (canonicalJson(found.get(item.id)) !== canonicalJson(item))
                    throw protocolError('item_exists');
                if (
                    canonicalJson(metadata.get(item.id)) !==
                    canonicalJson({ created_at: row.created_at, updated_at: row.updated_at })
                )
                    throw protocolError('migration_required');
                identicalDuplicates++;
            } else {
                found.set(item.id, item);
                metadata.set(item.id, { created_at: row.created_at, updated_at: row.updated_at });
            }
        }
    }
    return {
        items: [...found.values()],
        identicalDuplicates,
        legacyRows,
        physicalRows: rows.length,
        metadata,
    };
}

export async function planOfflineSubscriptionMigration({
    subscriptions,
    profiles,
    settings,
    authority,
    epoch,
}) {
    if (!validToken(authority) || !validToken(epoch)) throw protocolError('invalid_version');
    // Capture before the first await: callers cannot change the plan's source during hashing.
    const source = Object.fromEntries(
        Object.entries({ subscriptions, profiles, settings }).map(([table, rows]) => [
            table,
            physicalRows(rows, table),
        ])
    );
    canonicalJson(source, PROTOCOL_LIMITS.transactionBytes);
    validateSettings(source.settings);
    const subs = expand(source.subscriptions),
        groups = expand(source.profiles);
    const snapshot = validateSnapshot(
        { subscriptions: subs.items, profiles: groups.items },
        { requireGeneration: false }
    );
    snapshot.subscriptions = await Promise.all(
        snapshot.subscriptions.map(async (item) => {
            if (
                ['_writeGeneration', '_observedAt', '_observationTimes'].some((field) =>
                    Object.hasOwn(item, field)
                )
            )
                throw protocolError('migration_required');
            return {
                ...item,
                _writeGeneration: await hashValue({ authority, epoch, id: item.id }),
                _observedAt: 0,
                _observationTimes: {},
            };
        })
    );
    validateSnapshot(snapshot);
    const step = (sql, ...args) => ({ sql, args });
    const targetRows = Object.fromEntries(
        Object.entries({
            subscriptions: snapshot.subscriptions.map((item) => ({
                id: item.id,
                data: JSON.stringify(item),
                ...subs.metadata.get(item.id),
            })),
            profiles: snapshot.profiles.map((item) => ({
                id: item.id,
                data: JSON.stringify(item),
                ...groups.metadata.get(item.id),
            })),
            settings: source.settings,
        }).map(([table, rows]) => [table, physicalRows(rows, table)])
    );
    const guardsFor = (expectedRows) =>
        Object.entries(columns).flatMap(([table, fields]) => {
            const actual = `SELECT ${fields.map((field) => `${field} COLLATE BINARY`).join(',')} FROM ${table}`;
            const expected = `SELECT ${fields.map((field) => `json_extract(value,'$.${field}') COLLATE BINARY`).join(',')} FROM json_each(?)`;
            const serialized = JSON.stringify(expectedRows[table]);
            return [
                step(
                    `INSERT INTO subscription_migration_guard SELECT 1,
                (SELECT count(*) FROM pragma_table_xinfo('${table}'))=${fields.length}
                AND NOT EXISTS(SELECT name FROM pragma_table_xinfo('${table}') WHERE hidden=0 EXCEPT SELECT value FROM json_each(?))
                AND NOT EXISTS(SELECT 1 FROM pragma_table_xinfo('${table}') WHERE hidden!=0)
                AND (SELECT pk FROM pragma_table_xinfo('${table}') WHERE name='${fields[0]}')=1
                AND (SELECT count(*) FROM pragma_table_xinfo('${table}') WHERE pk>0)=1
                AND NOT EXISTS(${actual} EXCEPT ${expected})
                AND NOT EXISTS(${expected} EXCEPT ${actual})
                AND (SELECT count(*) FROM ${table})=?`,
                    JSON.stringify(fields),
                    serialized,
                    serialized,
                    expectedRows[table].length
                ),
                step('DELETE FROM subscription_migration_guard'),
            ];
        });
    const statements = [
        // A previously initialized target fails before any collection change.
        step(PROTOCOL_SCHEMA[0]),
        step(
            'CREATE TABLE subscription_migration_guard(id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CONSTRAINT migration_source_mismatch CHECK(ok=1))'
        ),
        ...guardsFor(source),
        ...['subscriptions', 'profiles'].flatMap((table) => [
            step(`DELETE FROM ${table}`),
            step(
                `INSERT INTO ${table}(id,data,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`,
                JSON.stringify(targetRows[table])
            ),
        ]),
        ...guardsFor(targetRows),
        ...PROTOCOL_SCHEMA.slice(1).map((sql) => step(sql)),
        step(
            'INSERT INTO subscription_protocol_meta VALUES(1,?,?,?,0)',
            authority,
            PROTOCOL_SCHEMA_VERSION,
            epoch
        ),
        step('DROP TABLE subscription_migration_guard'),
    ];
    return {
        sourceDigest: await hashValue(source, PROTOCOL_LIMITS.transactionBytes),
        targetDigest: await hashValue(snapshot),
        targetRowsDigest: await hashValue(targetRows, PROTOCOL_LIMITS.transactionBytes),
        targetRows,
        snapshot,
        statements,
        counts: {
            subscriptions: subs.items.length,
            profiles: groups.items.length,
            identicalDuplicates: subs.identicalDuplicates + groups.identicalDuplicates,
            legacyRows: subs.legacyRows + groups.legacyRows,
            physicalRows: subs.physicalRows + groups.physicalRows,
            settingsRows: source.settings.length,
        },
        requirements: [
            'isolated-copy-only',
            'source-digest-must-be-rechecked',
            'one-complete-transaction-on-the-matching-source-copy',
            'verify-target-rows-and-authority-after-uncertain-response',
            'all-writers-frozen-before-production',
            'production-migration-needs-explicit-approval',
        ],
    };
}
