import {
    protocolError,
    getProtocolError,
    requireMutationMetadata,
    validToken,
    validVersion,
    resolveSubscriptionProtocol,
    isAtomicSubscriptionStorage,
} from './errors.js';
import {
    canonicalJson,
    hashValue,
    validateSnapshot,
    validateOperations,
    applyOperations,
    validateRuntimeObservation,
    applyObservation,
    captureSubscriptionIdentity,
    validateDomains,
    PROTOCOL_LIMITS,
    isRecord,
} from './operations.js';
import {
    SNAPSHOT_SQL,
    DOMAIN_SNAPSHOT_SQL,
    PROTOCOL_SCHEMA_VERSION,
    RULES_ROW_KEY,
    compileCommit,
} from './sql.js';
import { createTelegramPreviewStore } from './telegram-previews.js';

export * from './errors.js';
export { captureSubscriptionIdentity } from './operations.js';
const runtimeCommit = Symbol('subscriptionRuntimeCommit');
const keys = { misub_subscriptions_v1: 'subscriptions', misub_profiles_v1: 'profiles' };
const settingsKey = 'worker_settings_v1';
const deniedWrites = new Set([
    'putSubscription',
    'putProfile',
    'putAllSubscriptions',
    'putAllProfiles',
    'updateSubscriptionById',
    'deleteSubscriptionById',
    'deleteProfileById',
]);

function translateSqlError(error) {
    if (getProtocolError(error).code !== 'storage_unavailable') return error;
    const code =
        /subscription_(schema_not_ready|authority_mismatch|epoch_conflict|operation_id_conflict|revision_conflict|identity_conflict|receipt_capacity|preview_capacity|preview_expired|legacy_write_blocked|invalid_operation)/.exec(
            String(error?.message ?? '')
        )?.[1];
    if (code) return protocolError(code);
    if (/no such table: subscription_protocol_/.test(String(error?.message ?? '')))
        return protocolError('schema_not_ready');
    return protocolError('storage_unavailable');
}

function receiptFromRow(row) {
    if (!row) throw protocolError('storage_unavailable');
    return {
        operationId: row.operation_id,
        version: { epoch: row.epoch, revision: row.revision },
        digest: row.digest,
        counts: { subscriptions: row.subscriptions, profiles: row.profiles },
        expiresAt: row.expires_at,
    };
}

export function createSubscriptionProtocol(env, { now = () => Date.now() } = {}) {
    const config = resolveSubscriptionProtocol(env);
    if (!config) return null;
    const db = config.db.withSession?.('first-primary') ?? config.db;

    async function readSnapshot(includeDomains = false) {
        try {
            const row = await db
                .prepare(includeDomains ? DOMAIN_SNAPSHOT_SQL : SNAPSHOT_SQL)
                .first();
            if (!row || row.schema_version !== PROTOCOL_SCHEMA_VERSION)
                throw protocolError('schema_not_ready');
            if (row.authority !== config.authority) throw protocolError('authority_mismatch');
            if (row.bad_subscriptions || row.bad_profiles)
                throw protocolError('migration_required');
            if (!validVersion(row)) throw protocolError('schema_not_ready');
            const result = validateSnapshot({
                version: { epoch: row.epoch, revision: row.revision },
                requestPolicy: row.request_policy,
                subscriptions: JSON.parse(row.subscriptions),
                profiles: JSON.parse(row.profiles),
            });
            for (const collection of ['subscriptions', 'profiles'])
                result[collection].sort(
                    (left, right) =>
                        (Number(left.sortIndex) || 0) - (Number(right.sortIndex) || 0) ||
                        left.id.localeCompare(right.id)
                );
            if (includeDomains) {
                const settings = JSON.parse(row.settings);
                if (!isRecord(settings)) throw protocolError('invalid_data');
                Object.assign(
                    result,
                    validateDomains({
                        settings: { ...settings, storageType: 'd1' },
                        ruleTemplates: JSON.parse(row.rule_templates),
                    })
                );
            }
            return result;
        } catch (error) {
            throw translateSqlError(error);
        }
    }

    const readSubscriptionSnapshot = () => readSnapshot();
    const readDomainSnapshot = () => readSnapshot(true);

    async function commit(
        request,
        { kind = 'edit', observation, restore, domains, preRestoreBackup, preview } = {}
    ) {
        const metadata = requireMutationMetadata(request);
        const operations = ['edit', 'domains', 'telegram'].includes(kind)
            ? validateOperations(request.operations ?? [])
            : undefined;
        const payload =
            kind === 'edit'
                ? { operations }
                : kind === 'domains'
                  ? { operations, domains }
                  : kind === 'telegram'
                    ? { preview }
                    : kind === 'runtime'
                      ? { observation }
                      : {
                            restore,
                            ...(domains ? { domains } : {}),
                            ...(preRestoreBackup ? { preRestoreBackup } : {}),
                        };
        const intentMetadata =
            kind === 'runtime'
                ? { operationId: metadata.operationId, epoch: metadata.baseVersion.epoch }
                : metadata;
        const digest = await hashValue(
            {
                authority: config.authority,
                kind,
                ...intentMetadata,
                ...payload,
            },
            PROTOCOL_LIMITS.transactionBytes
        );
        try {
            const includeDomains = !!domains || kind === 'telegram';
            const snapshot = await readSnapshot(includeDomains);
            if (snapshot.version.epoch !== metadata.baseVersion.epoch)
                throw protocolError('epoch_conflict');
            const timestamp = now();
            const prior = await db
                .prepare(
                    `SELECT * FROM subscription_protocol_receipts WHERE epoch=? AND operation_id=? AND expires_at>?`
                )
                .bind(metadata.baseVersion.epoch, metadata.operationId, timestamp)
                .first();
            if (prior && prior.digest !== digest) throw protocolError('operation_id_conflict');
            if (!prior && snapshot.version.revision !== metadata.baseVersion.revision)
                throw protocolError('revision_conflict');
            const next = prior
                ? snapshot
                : ['edit', 'domains', 'telegram'].includes(kind)
                  ? applyOperations(snapshot, operations, timestamp)
                  : kind === 'runtime'
                    ? await applyObservation(snapshot, observation)
                    : validateSnapshot({
                          subscriptions: restore.subscriptions.map((item) => ({
                              ...item,
                              _writeGeneration: crypto.randomUUID(),
                              _observedAt: 0,
                              _observationTimes: {},
                          })),
                          profiles: restore.profiles,
                      });
            if (kind === 'telegram' && !prior) {
                for (const item of next.subscriptions) {
                    if (preview.createMetadata?.[item.id])
                        Object.assign(item, preview.createMetadata[item.id]);
                }
                if (preview.settingsPatch) {
                    const binding =
                        preview.settingsPatch.telegram_push_config.user_bindings[preview.actorId];
                    if (binding !== '' && !next.profiles.some((item) => item.id === binding))
                        throw protocolError('invalid_reference');
                    const settings = snapshot.settings;
                    domains = validateDomains({
                        settings: {
                            ...settings,
                            telegram_push_config: {
                                ...settings.telegram_push_config,
                                user_bindings: {
                                    ...settings.telegram_push_config?.user_bindings,
                                    [preview.actorId]: binding,
                                },
                            },
                        },
                    });
                }
                validateSnapshot(next);
            }
            const plan = compileCommit({
                authority: config.authority,
                ...metadata,
                digest,
                next,
                nextEpoch: restore?.nextEpoch,
                requestPolicy: kind === 'runtime' ? observation.requestPolicy : null,
                domains,
                preRestoreBackup,
                preview: kind === 'telegram' ? preview : undefined,
                now: timestamp,
            });
            const result = await db.batch(
                plan.map(({ sql, args }) => db.prepare(sql).bind(...args))
            );
            const receipt = receiptFromRow(result.at(-1)?.results?.[0]);
            return {
                receipt,
                snapshot: await readSnapshot(includeDomains),
                replayed: !!prior || result[1]?.results?.[0]?.apply === 0,
            };
        } catch (error) {
            throw translateSqlError(error);
        }
    }

    async function restoreSubscriptionSnapshot(request) {
        const metadata = requireMutationMetadata(request);
        if (!validToken(request.nextEpoch) || request.nextEpoch === metadata.baseVersion.epoch)
            throw protocolError('epoch_conflict');
        const restore = JSON.parse(
            canonicalJson({
                nextEpoch: request.nextEpoch,
                subscriptions: request.subscriptions,
                profiles: request.profiles,
            })
        );
        validateSnapshot(restore, { requireGeneration: false });
        const domains =
            request.domains === undefined ? undefined : validateDomains(request.domains);
        const preRestoreBackup =
            request.preRestoreBackup === undefined
                ? undefined
                : JSON.parse(
                      canonicalJson(request.preRestoreBackup, PROTOCOL_LIMITS.transactionBytes)
                  );
        return commit(metadata, { kind: 'restore', restore, domains, preRestoreBackup });
    }

    return {
        subscriptionProtocol: 'd1-v1',
        readSubscriptionSnapshot,
        readDomainSnapshot,
        commitSubscriptionOperations: (request) => commit(request),
        commitDomainOperations: async (request) =>
            commit(request, { kind: 'domains', domains: validateDomains(request.domains) }),
        restoreSubscriptionSnapshot,
        ...createTelegramPreviewStore({
            db,
            now,
            readDomainSnapshot,
            translateSqlError,
            commit: (preview) =>
                commit(
                    {
                        operationId: `tg_${preview.id}`,
                        baseVersion: preview.baseVersion,
                        operations: preview.operations,
                    },
                    { kind: 'telegram', preview }
                ),
        }),
        [runtimeCommit]: async (request, observation) =>
            commit(request, { kind: 'runtime', observation }),
    };
}

export async function commitRuntimeObservation(storage, value) {
    if (!isAtomicSubscriptionStorage(storage) || typeof storage[runtimeCommit] !== 'function')
        throw protocolError('atomic_backend_required');
    if (!validToken(value?.operationId) || !validToken(value?.epoch))
        throw protocolError('invalid_version');
    const observation = validateRuntimeObservation(value);
    const first = await storage.readSubscriptionSnapshot();
    const baseEpoch = value.epoch;
    if (first.version.epoch !== baseEpoch) return { applied: false, reason: 'epoch_conflict' };
    let snapshot = first;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (snapshot.version.epoch !== baseEpoch) throw protocolError('epoch_conflict');
            const result = await storage[runtimeCommit](
                { operationId: value.operationId, baseVersion: snapshot.version },
                observation
            );
            return { applied: true, ...result };
        } catch (error) {
            const { code } = getProtocolError(error);
            if (
                [
                    'identity_conflict',
                    'observation_stale',
                    'unknown_item',
                    'epoch_conflict',
                ].includes(code)
            )
                return { applied: false, reason: code };
            if (code !== 'revision_conflict' || attempt === 2) throw error;
            snapshot = await storage.readSubscriptionSnapshot();
        }
    }
}

export function wrapAtomicSubscriptionAdapter(base, env) {
    const protocol = createSubscriptionProtocol(env);
    if (!protocol) return base;
    const read = protocol.readSubscriptionSnapshot;
    const overrides = {
        ...protocol,
        getAllSubscriptions: async () => (await read()).subscriptions,
        getAllProfiles: async () => (await read()).profiles,
        getSubscriptionById: async (id) =>
            (await read()).subscriptions.find((item) => item.id === id) ?? null,
        getSubscriptionsByIds: async (ids) =>
            (await read()).subscriptions.filter((item) => ids.includes(item.id)),
        getProfileById: async (id) =>
            (await read()).profiles.find((item) => item.id === id || item.customId === id) ?? null,
        getProfilesByIds: async (ids) =>
            (await read()).profiles.filter((item) => ids.includes(item.id)),
        async get(key, ...args) {
            if (Object.hasOwn(keys, key)) return (await read())[keys[key]];
            if (key === settingsKey)
                return { ...(await protocol.readDomainSnapshot()).settings, storageType: 'd1' };
            if (key === RULES_ROW_KEY) return (await protocol.readDomainSnapshot()).ruleTemplates;
            return base.get(key, ...args);
        },
        async put(key, value, ...args) {
            if (Object.hasOwn(keys, key)) throw protocolError('legacy_write_blocked');
            if (key === settingsKey || key === RULES_ROW_KEY)
                throw protocolError('legacy_write_blocked');
            return base.put(key, value, ...args);
        },
        async delete(key, ...args) {
            if (Object.hasOwn(keys, key)) throw protocolError('legacy_write_blocked');
            if (key === settingsKey || key === RULES_ROW_KEY)
                throw protocolError('legacy_write_blocked');
            return base.delete(key, ...args);
        },
    };
    for (const method of deniedWrites)
        overrides[method] = async () => {
            throw protocolError('legacy_write_blocked');
        };
    return new Proxy(base, {
        get(target, property) {
            if (Object.hasOwn(overrides, property)) return overrides[property];
            if (property === 'db' || property === 'kv') return undefined;
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
