// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { createSubscriptionProtocol } from '../../functions/services/subscription-protocol/index.js';
import { planOfflineSubscriptionMigration } from '../../experiments/subscription-transactions/migration.js';

const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.close()));
async function fixture() {
    const f = await createProtocolFixture({
        subscriptions: [{ id: 'a', url: 'https://fixture.invalid/a' }],
        profiles: [{ id: 'g', subscriptions: ['a'] }],
        settings: { BotToken: 'synthetic-secret', mytoken: 'synthetic-token' },
        ruleTemplates: [{ id: 'r', name: 'old', content: '[Rule]\nMATCH,DIRECT' }],
    });
    fixtures.push(f);
    f.storage = createSubscriptionProtocol(f.env);
    return f;
}
const metadata = {
    baseVersion: { epoch: 'fixture-epoch', revision: 0 },
    operationId: 'domain-test',
};

describe('shared domain transaction boundaries', () => {
    it.each(Array.from({ length: 13 }, (_, i) => i))(
        'rolls back a full restore at SQL statement %i',
        async (index) => {
            const f = await fixture();
            const before = await f.storage.readDomainSnapshot();
            f.state.failAt = index;
            await expect(
                f.storage.restoreSubscriptionSnapshot({
                    ...metadata,
                    nextEpoch: 'new-history',
                    subscriptions: [],
                    profiles: [],
                    domains: { settings: { FileName: 'new' }, ruleTemplates: [] },
                    preRestoreBackup: {
                        scope: 'dataOnly',
                        data: { subscriptions: before.subscriptions, profiles: before.profiles },
                    },
                })
            ).rejects.toThrow();
            expect(await f.storage.readDomainSnapshot()).toEqual(before);
            expect(
                f.sql.prepare('SELECT count(*) n FROM subscription_protocol_receipts').get().n
            ).toBe(0);
            expect(f.sql.prepare('SELECT count(*) n FROM subscription_protocol_gate').get().n).toBe(
                0
            );
            expect(
                f.sql
                    .prepare("SELECT value FROM settings WHERE key='misub_restore_snapshot_latest'")
                    .get()
            ).toBeUndefined();
        }
    );
    it('keeps the ordinary subscription snapshot free of settings secrets', async () => {
        const { storage } = await fixture();
        expect(JSON.stringify(await storage.readSubscriptionSnapshot())).not.toContain(
            'synthetic-secret'
        );
        expect((await storage.readDomainSnapshot()).settings.BotToken).toBe('synthetic-secret');
    });
    it('rejects an oversized settings domain before any database mutation', async () => {
        const { storage, state } = await fixture();
        const before = await storage.readDomainSnapshot();
        await expect(
            storage.commitDomainOperations({
                ...metadata,
                domains: { settings: { description: 'x'.repeat(1048576) } },
            })
        ).rejects.toThrow('capacity_exceeded');
        expect(state.batches).toBe(0);
        expect(await storage.readDomainSnapshot()).toEqual(before);
    });
    it('enforces bounded preview retention without modifying business domains', async () => {
        const { storage, sql } = await fixture();
        const before = await storage.readDomainSnapshot();
        for (let index = 0; index < 128; index++)
            await storage.createTelegramPreview({
                id: `preview_${index}`,
                actorId: '1',
                chatId: '1',
                sourceDigest: 'a'.repeat(64),
                baseVersion: before.version,
                operations: [],
            });
        await expect(
            storage.createTelegramPreview({
                id: 'overflow',
                actorId: '1',
                chatId: '1',
                sourceDigest: 'a'.repeat(64),
                baseVersion: before.version,
                operations: [],
            })
        ).rejects.toThrow('preview_capacity');
        expect(sql.prepare('SELECT count(*) n FROM subscription_protocol_previews').get().n).toBe(
            128
        );
        expect(await storage.readDomainSnapshot()).toEqual(before);
    });
    it('replays a full domain receipt after another writer and rejects a changed payload', async () => {
        const { storage } = await fixture();
        const request = {
            ...metadata,
            domains: { settings: { FileName: 'new' }, ruleTemplates: [] },
        };
        const first = await storage.commitDomainOperations(request);
        await storage.commitSubscriptionOperations({
            operationId: 'rename',
            baseVersion: first.receipt.version,
            operations: [
                { type: 'update', collection: 'subscriptions', id: 'a', fields: { name: 'kept' } },
            ],
        });
        const replay = await storage.commitDomainOperations(request);
        expect(replay.replayed).toBe(true);
        expect(replay.receipt).toEqual(first.receipt);
        expect(replay.snapshot.subscriptions[0].name).toBe('kept');
        await expect(
            storage.commitDomainOperations({
                ...request,
                domains: { settings: { FileName: 'changed' } },
            })
        ).rejects.toThrow('operation_id_conflict');
    });
    it('serializes settings and rules against the same client baseline', async () => {
        const { storage } = await fixture();
        const results = await Promise.allSettled([
            storage.commitDomainOperations({
                ...metadata,
                domains: { settings: { FileName: 'settings' } },
            }),
            storage.commitDomainOperations({
                ...metadata,
                operationId: 'rules',
                domains: { ruleTemplates: [] },
            }),
        ]);
        expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((x) => x.status === 'rejected').reason.code).toBe('revision_conflict');
    });
    it.each([
        "UPDATE settings SET value='{}' WHERE key='main'",
        "DELETE FROM settings WHERE key='main'",
        "UPDATE settings SET key='unprotected' WHERE key='main'",
        "DELETE FROM settings WHERE key='misub_rule_templates_v1'",
        "INSERT OR REPLACE INTO settings(key,value) VALUES('main','{}')",
    ])('blocks old physical settings DML: %s', async (sql) => {
        const f = await fixture();
        const before = await f.storage.readDomainSnapshot();
        expect(() => f.sql.exec(sql)).toThrow('subscription_legacy_write_blocked');
        expect(await f.storage.readDomainSnapshot()).toEqual(before);
    });
    it('refuses an initialized migration target without changing any domain', async () => {
        const f = await fixture();
        const before = await f.storage.readDomainSnapshot();
        const plan = await planOfflineSubscriptionMigration({
            authority: 'other',
            epoch: 'other',
            subscriptions: [],
            profiles: [],
            settings: [],
        });
        await expect(
            f.db.batch(plan.statements.map(({ sql, args }) => f.db.prepare(sql).bind(...args)))
        ).rejects.toThrow();
        expect(await f.storage.readDomainSnapshot()).toEqual(before);
    });
    it('refuses schema version 1 without attempting an online upgrade', async () => {
        const f = await fixture();
        f.sql.exec('DROP TRIGGER subscription_protocol_meta_guard');
        f.sql.exec('PRAGMA ignore_check_constraints=ON');
        f.sql.exec('UPDATE subscription_protocol_meta SET schema_version=1');
        const batches = f.state.batches;
        await expect(f.storage.readDomainSnapshot()).rejects.toThrow('schema_not_ready');
        expect(f.state.batches).toBe(batches);
    });
});
