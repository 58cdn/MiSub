// Pure offline planner: accepts supplied physical rows, never resolves a binding or executes SQL.
import { PROTOCOL_SCHEMA } from '../../functions/services/subscription-protocol/sql.js';
import {
    canonicalJson,
    hashValue,
    validateSnapshot,
    validId,
} from '../../functions/services/subscription-protocol/operations.js';
import {
    protocolError,
    validToken,
} from '../../functions/services/subscription-protocol/errors.js';

function expand(rows) {
    if (!Array.isArray(rows)) throw protocolError('invalid_data');
    const found = new Map();
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
                identicalDuplicates++;
            } else found.set(item.id, item);
        }
    }
    return {
        items: [...found.values()],
        identicalDuplicates,
        legacyRows,
        physicalRows: rows.length,
    };
}

export async function planOfflineSubscriptionMigration({
    subscriptions,
    profiles,
    authority,
    epoch,
}) {
    if (!validToken(authority) || !validToken(epoch)) throw protocolError('invalid_version');
    const source = { subscriptions, profiles };
    const subs = expand(subscriptions),
        groups = expand(profiles);
    const snapshot = validateSnapshot(
        { subscriptions: subs.items, profiles: groups.items },
        { requireGeneration: false }
    );
    snapshot.subscriptions = await Promise.all(
        snapshot.subscriptions.map(async (item) => ({
            ...item,
            _writeGeneration: await hashValue({ authority, epoch, id: item.id }),
            _observedAt: 0,
            _observationTimes: {},
        }))
    );
    validateSnapshot(snapshot);
    const step = (sql, ...args) => ({ sql, args });
    const statements = [
        // A previously initialized target fails before any collection change.
        step(PROTOCOL_SCHEMA[0]),
        ...['subscriptions', 'profiles'].flatMap((table) => [
            step(`DELETE FROM ${table}`),
            step(
                `INSERT INTO ${table}(id,data) SELECT json_extract(value,'$.id'),value FROM json_each(?)`,
                JSON.stringify(snapshot[table])
            ),
        ]),
        ...PROTOCOL_SCHEMA.slice(1).map((sql) => step(sql)),
        step('INSERT INTO subscription_protocol_meta VALUES(1,?,1,?,0)', authority, epoch),
    ];
    return {
        sourceDigest: await hashValue(source),
        targetDigest: await hashValue(snapshot),
        snapshot,
        statements,
        counts: {
            subscriptions: subs.items.length,
            profiles: groups.items.length,
            identicalDuplicates: subs.identicalDuplicates + groups.identicalDuplicates,
            legacyRows: subs.legacyRows + groups.legacyRows,
            physicalRows: subs.physicalRows + groups.physicalRows,
        },
        requirements: [
            'isolated-copy-only',
            'source-digest-must-be-rechecked',
            'all-writers-frozen-before-production',
            'production-migration-needs-explicit-approval',
        ],
    };
}
