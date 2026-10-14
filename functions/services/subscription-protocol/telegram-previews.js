import { protocolError, validToken, validVersion } from './errors.js';
import { canonicalJson, isRecord, validateOperations, validId } from './operations.js';
import { RECEIPT_TTL_MS } from './sql.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const party = (value) => typeof value === 'string' && /^-?\d{1,20}$/.test(value);

function identity(value) {
    if (
        !validToken(value?.id) ||
        value.id.length > 125 ||
        !party(value.actorId) ||
        !party(value.chatId)
    )
        throw protocolError('invalid_data');
    return { id: value.id, actorId: value.actorId, chatId: value.chatId };
}

function validate(value) {
    const owner = identity(value);
    if (!validVersion(value.baseVersion) || !/^[a-f0-9]{64}$/.test(value.sourceDigest ?? ''))
        throw protocolError('invalid_data');
    const result = {
        ...owner,
        sourceDigest: value.sourceDigest,
        baseVersion: value.baseVersion,
        operations: validateOperations(value.operations),
    };
    if (value.settingsPatch !== undefined) {
        const binding = value.settingsPatch?.telegram_push_config?.user_bindings?.[owner.actorId];
        const expected = { telegram_push_config: { user_bindings: { [owner.actorId]: binding } } };
        if (
            (binding !== '' && !validId(binding)) ||
            canonicalJson(expected) !== canonicalJson(value.settingsPatch)
        )
            throw protocolError('invalid_operation');
        result.settingsPatch = expected;
    }
    if (value.createMetadata !== undefined) {
        if (!isRecord(value.createMetadata)) throw protocolError('invalid_data');
        for (const [id, metadata] of Object.entries(value.createMetadata)) {
            if (
                !result.operations.some(
                    (op) =>
                        op.type === 'create' &&
                        op.collection === 'subscriptions' &&
                        op.item.id === id
                ) ||
                !isRecord(metadata) ||
                Object.keys(metadata).some(
                    (key) => !['telegram_user_id', 'created_at'].includes(key)
                ) ||
                !Number.isSafeInteger(metadata.telegram_user_id) ||
                String(metadata.telegram_user_id) !== owner.actorId ||
                typeof metadata.created_at !== 'string' ||
                !Number.isFinite(Date.parse(metadata.created_at))
            )
                throw protocolError('invalid_operation');
        }
        result.createMetadata = value.createMetadata;
    }
    return JSON.parse(canonicalJson(result));
}

export function createTelegramPreviewStore({
    db,
    now,
    readDomainSnapshot,
    commit,
    translateSqlError,
}) {
    async function readTelegramPreview(value) {
        const owner = identity(value);
        try {
            await readDomainSnapshot();
            const row = await db
                .prepare(
                    'SELECT * FROM subscription_protocol_previews WHERE id=? AND retain_until>?'
                )
                .bind(owner.id, now())
                .first();
            if (!row) return null;
            if (row.actor_id !== owner.actorId || row.chat_id !== owner.chatId)
                throw protocolError('preview_forbidden');
            return { ...validate(JSON.parse(row.payload)), expiresAt: row.expires_at };
        } catch (error) {
            throw translateSqlError(error);
        }
    }
    async function createTelegramPreview(value) {
        const preview = validate(value);
        try {
            const existing = await readTelegramPreview(preview);
            if (existing) {
                if (existing.sourceDigest !== preview.sourceDigest)
                    throw protocolError('operation_id_conflict');
                return existing;
            }
            const snapshot = await readDomainSnapshot();
            if (snapshot.version.epoch !== preview.baseVersion.epoch)
                throw protocolError('epoch_conflict');
            if (snapshot.version.revision !== preview.baseVersion.revision)
                throw protocolError('revision_conflict');
            const timestamp = now();
            await db.batch([
                db
                    .prepare('DELETE FROM subscription_protocol_previews WHERE retain_until<=?')
                    .bind(timestamp),
                db
                    .prepare(
                        `INSERT INTO subscription_protocol_previews(id,actor_id,chat_id,source_digest,payload,expires_at,retain_until)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
                    )
                    .bind(
                        preview.id,
                        preview.actorId,
                        preview.chatId,
                        preview.sourceDigest,
                        canonicalJson(preview),
                        timestamp + PREVIEW_TTL_MS,
                        timestamp + RECEIPT_TTL_MS
                    ),
            ]);
            const result = await readTelegramPreview(preview);
            if (!result || result.sourceDigest !== preview.sourceDigest)
                throw protocolError('operation_id_conflict');
            return result;
        } catch (error) {
            throw translateSqlError(error);
        }
    }
    async function commitTelegramPreview(value) {
        const preview = await readTelegramPreview(value);
        if (!preview) throw protocolError('preview_expired');
        // Admission checks expiry inside the same transaction as the mutation. A
        // retained successful receipt permits replay without executing it again.
        return commit(preview);
    }
    return { readTelegramPreview, createTelegramPreview, commitTelegramPreview };
}
