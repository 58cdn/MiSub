// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import {
    handleDataRequest,
    handleSettingsGet,
    handleSettingsSave,
    handleSettingsReset,
} from '../../functions/modules/api-handler.js';
import { handleRuleTemplatesRequest } from '../../functions/modules/rule-template-handler.js';
import {
    buildBackupPayload,
    handleBackupRestore,
    handleWebdavRestore,
    performWebdavBackup,
} from '../../functions/modules/webdav-backup-handler.js';
import { commitWebdavStatusPatch } from '../../functions/services/domain-settings-service.js';
import { maybeRunScheduledTasks } from '../../functions/modules/scheduled-task-runner.js';
import { protocolError } from '../../functions/services/subscription-protocol/index.js';

vi.mock('../../functions/modules/notifications.js', () => ({
    sendTgNotification: vi.fn(),
    checkAndNotify: vi.fn(),
    handleCronTrigger: vi.fn(),
}));
vi.mock('../../functions/services/node-cache-service.js', async (actual) => ({
    ...(await actual()),
    clearAllNodeCaches: vi.fn().mockResolvedValue({ cleared: 0 }),
}));
vi.mock('../../functions/modules/utils.js', async (actual) => ({
    ...(await actual()),
    isUsingDefaultPassword: vi.fn().mockResolvedValue(false),
}));

const rule = {
    id: 'rule_one',
    name: 'Rule',
    type: 'ini',
    content: '[custom]\nruleset=DIRECT,[]MATCH',
    enabled: true,
};
const settings = {
    storageType: 'd1',
    FileName: 'Before',
    defaultLocale: 'zh-CN',
    webdavBackup: {
        enabled: true,
        autoBackup: false,
        endpoint: 'https://dav.fixture.invalid',
        username: 'synthetic',
        password: 'synthetic_webdav_secret',
    },
};
const fixtureOptions = {
    subscriptions: [
        { id: 'one', name: 'Before', url: 'https://source.fixture.invalid/sub', enabled: true },
    ],
    profiles: [{ id: 'group', name: 'Group', subscriptions: ['one'], manualNodes: [] }],
    settings,
    ruleTemplates: [rule],
};
let fixture;
let storage;
let expectedFetches;
const req = (body, method = 'POST', path = '/api/settings') =>
    new Request(`https://misub.fixture.invalid${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'X-MiSub-Save-Scope': 'preferences' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
async function metadata(id = 'fixture_operation') {
    return { operationId: id, baseVersion: (await storage.readDomainSnapshot()).version };
}
function backup(scope = 'dataAndSettings') {
    return {
        type: 'misub-backup',
        version: 1,
        scope,
        data: {
            subscriptions: [
                {
                    id: 'restored',
                    name: 'Restored',
                    url: 'https://source.fixture.invalid/restored',
                },
            ],
            profiles: [
                {
                    id: 'restored_group',
                    name: 'Restored group',
                    subscriptions: ['restored'],
                    manualNodes: [],
                },
            ],
            ruleTemplates: [{ ...rule, id: 'restored_rule', name: 'Restored rule' }],
            settings:
                scope === 'dataAndSettings'
                    ? {
                          FileName: 'Restored',
                          webdavBackup: { password: 'untrusted' },
                          adminPassword: 'untrusted',
                      }
                    : null,
        },
    };
}
beforeEach(async () => {
    expectedFetches = 0;
    fixture = await createProtocolFixture(fixtureOptions);
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('network forbidden');
        })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    fixture?.close();
    expect(fetch).toHaveBeenCalledTimes(expectedFetches);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('strict settings and rules use the client global version', () => {
    it('reads settings, rules and management data with one usable version and redacted WebDAV password', async () => {
        const expected = (await storage.readDomainSnapshot()).version;
        const settingResponse = await handleSettingsGet(fixture.env);
        const settingBody = await settingResponse.json();
        expect(settingResponse.status).toBe(200);
        expect(settingBody).toMatchObject({
            version: expected,
            subscriptionProtocol: 'd1-v1',
            data: { FileName: 'Before', webdavBackup: { password: '' } },
        });
        expect(JSON.stringify(settingBody)).not.toContain(settings.webdavBackup.password);
        const rules = await (
            await handleRuleTemplatesRequest(req(undefined, 'GET'), fixture.env)
        ).json();
        expect(rules).toMatchObject({ version: expected, data: [rule] });
        const management = await (await handleDataRequest(fixture.env)).json();
        expect(management).toMatchObject({
            version: expected,
            ruleTemplates: [rule],
            config: { FileName: 'Before' },
        });
        expect(JSON.stringify(management)).not.toContain(settings.webdavBackup.password);
    });
    it.each([
        [
            'settings',
            (request, env) => handleSettingsSave(request, env),
            { FileName: 'Stale legacy' },
        ],
        ['rules', handleRuleTemplatesRequest, { templates: [] }],
    ])('rejects versionless %s writes with no transaction', async (_, handler, body) => {
        const response = await handler(req(body), fixture.env);
        expect(response.status).toBe(428);
        expect((await response.json()).code).toBe('version_required');
        expect(fixture.state.batches).toBe(0);
    });
    it('merges only an explicit settings patch under its captured version', async () => {
        const response = await handleSettingsSave(
            req({
                ...(await metadata()),
                settings: {
                    FileName: 'Edited',
                    webdavBackup: { ...settings.webdavBackup, password: '' },
                },
            }),
            fixture.env
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            version: { revision: 1 },
            data: { FileName: 'Edited', webdavBackup: { password: '' } },
        });
        const snapshot = await storage.readDomainSnapshot();
        expect(snapshot.settings).toMatchObject({
            FileName: 'Edited',
            defaultLocale: 'zh-CN',
            webdavBackup: settings.webdavBackup,
        });
    });
    it('resets settings under the supplied version while retaining D1 authority and other domains', async () => {
        const before = await storage.readDomainSnapshot();
        const authPut = vi.fn();
        const authDelete = vi.fn();
        fixture.env.MISUB_KV = { put: authPut, delete: authDelete };
        const body = await metadata('reset_settings');
        const response = await handleSettingsReset(fixture.env, req(body));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            subscriptionProtocol: 'd1-v1',
            version: { revision: 1 },
            data: { FileName: 'MiSub', storageType: 'd1' },
        });
        const after = await storage.readDomainSnapshot();
        expect(after.settings).toEqual({ storageType: 'd1' });
        expect(after.subscriptions).toEqual(before.subscriptions);
        expect(after.profiles).toEqual(before.profiles);
        expect(after.ruleTemplates).toEqual(before.ruleTemplates);
        expect(authPut).not.toHaveBeenCalled();
        expect(authDelete).not.toHaveBeenCalled();
        const replay = await handleSettingsReset(fixture.env, req(body));
        expect((await replay.json()).replayed).toBe(true);
        expect((await storage.readDomainSnapshot()).version.revision).toBe(1);
    });
    it('rejects unversioned or stale resets without clearing settings', async () => {
        expect((await handleSettingsReset(fixture.env, req({}))).status).toBe(428);
        expect(fixture.state.batches).toBe(0);
        const stale = await metadata('stale_reset');
        await storage.commitDomainOperations({
            ...stale,
            operationId: 'rule_change_before_reset',
            domains: { ruleTemplates: [] },
        });
        const response = await handleSettingsReset(fixture.env, req(stale));
        expect(response.status).toBe(409);
        expect((await storage.readDomainSnapshot()).settings).toEqual(settings);
    });
    it('rejects a stale settings patch without adopting a fresh server version', async () => {
        const old = await metadata();
        await storage.commitDomainOperations({
            ...old,
            operationId: 'concurrent_rule_edit',
            domains: { ruleTemplates: [] },
        });
        const response = await handleSettingsSave(
            req({ ...old, settings: { FileName: 'Stale' } }),
            fixture.env
        );
        expect(response.status).toBe(409);
        expect((await storage.readDomainSnapshot()).settings.FileName).toBe('Before');
        expect(fixture.state.batches).toBe(1);
    });
    it('commits full rule data with stable IDs and timestamps and replays its fixed intent', async () => {
        const templates = [
            {
                ...rule,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
            },
        ];
        const body = { ...(await metadata()), templates };
        const response = await handleRuleTemplatesRequest(req(body), fixture.env);
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual(templates);
        const replay = await handleRuleTemplatesRequest(req(body), fixture.env);
        expect((await replay.json()).replayed).toBe(true);
        const get = await handleRuleTemplatesRequest(req(undefined, 'GET'), fixture.env);
        expect((await get.json()).data).toEqual(templates);
    });
    it.each([null, {}, [null], [{ ...rule, id: '' }], [rule, rule], [{ ...rule, content: '' }]])(
        'rejects malformed rules %j without normalization',
        async (templates) => {
            const response = await handleRuleTemplatesRequest(
                req({ ...(await metadata()), templates }),
                fixture.env
            );
            expect(response.status).toBe(400);
            expect(fixture.state.batches).toBe(0);
            expect((await storage.readDomainSnapshot()).ruleTemplates).toEqual([rule]);
        }
    );
});

describe('strict multi-domain backup and restore', () => {
    it('preserves current authentication values while excluding them from responses and pre-restore backup', async () => {
        fixture.close();
        fixture = await createProtocolFixture({
            ...fixtureOptions,
            settings: {
                ...settings,
                adminPassword: 'synthetic_auth_secret',
                cookieSecret: 'synthetic_cookie_secret',
                sessionSecret: 'synthetic_session_secret',
            },
        });
        storage = StorageFactory.createAdapter(fixture.env, 'd1');
        const settingsBody = await (await handleSettingsGet(fixture.env)).json();
        expect(JSON.stringify(settingsBody)).not.toContain('synthetic_auth_secret');
        const response = await handleBackupRestore(
            req({
                ...(await metadata()),
                nextEpoch: 'restored_epoch',
                payload: backup(),
                scope: 'dataAndSettings',
            }),
            fixture.env
        );
        expect(response.status).toBe(200);
        const snapshot = await storage.readDomainSnapshot();
        expect(snapshot.settings).toMatchObject({
            adminPassword: 'synthetic_auth_secret',
            cookieSecret: 'synthetic_cookie_secret',
            sessionSecret: 'synthetic_session_secret',
        });
        expect(JSON.stringify(await storage.get('misub_restore_snapshot_latest'))).not.toContain(
            'synthetic_auth_secret'
        );
        expect(JSON.stringify(await response.json())).not.toContain('synthetic_auth_secret');
    });
    it('restores a remote backup using explicit client metadata and its file scope', async () => {
        expectedFetches = 1;
        fetch.mockResolvedValue(new Response(JSON.stringify(backup())));
        const response = await handleWebdavRestore(
            req({ ...(await metadata()), nextEpoch: 'restored_epoch', file: '/fixture.json' }),
            fixture.env
        );
        expect(response.status).toBe(200);
        expect((await storage.readDomainSnapshot()).settings.FileName).toBe('Restored');
    });
    it('does not replace the client baseline after a settings edit during remote download', async () => {
        expectedFetches = 1;
        fetch.mockImplementationOnce(async () => {
            const snapshot = await storage.readDomainSnapshot();
            await storage.commitDomainOperations({
                ...(await metadata('during_download')),
                domains: { settings: { ...snapshot.settings, FileName: 'Concurrent' } },
            });
            return new Response(JSON.stringify(backup()));
        });
        const response = await handleWebdavRestore(
            req({ ...(await metadata()), nextEpoch: 'restored_epoch', file: '/fixture.json' }),
            fixture.env
        );
        expect(response.status).toBe(409);
        const after = await storage.readDomainSnapshot();
        expect(after.settings.FileName).toBe('Concurrent');
        expect(after.subscriptions[0].id).toBe('one');
        expect(await storage.get('misub_restore_snapshot_latest')).toBeNull();
    });
    it('exports all requested domains from one coherent version without protected fields', async () => {
        const payload = await buildBackupPayload(fixture.env, { scope: 'dataAndSettings' });
        expect(payload.source.domainVersion).toEqual((await storage.readDomainSnapshot()).version);
        expect(payload.data.ruleTemplates).toEqual([rule]);
        expect(payload.data.settings).toMatchObject({ FileName: 'Before' });
        expect(payload.data.settings).not.toHaveProperty('webdavBackup');
    });
    it.each(['dataOnly', 'dataAndSettings'])(
        'restores %s in one transaction and preserves protected settings',
        async (scope) => {
            const response = await handleBackupRestore(
                req({
                    ...(await metadata()),
                    nextEpoch: 'restored_epoch',
                    payload: backup(scope),
                    scope,
                }),
                fixture.env
            );
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.data.version).toEqual({ epoch: 'restored_epoch', revision: 0 });
            expect(JSON.stringify(body)).not.toContain(settings.webdavBackup.password);
            const snapshot = await storage.readDomainSnapshot();
            expect(snapshot.ruleTemplates[0].id).toBe('restored_rule');
            expect(snapshot.settings.FileName).toBe(scope === 'dataOnly' ? 'Before' : 'Restored');
            expect(snapshot.settings.webdavBackup).toEqual(settings.webdavBackup);
            expect(snapshot.settings).not.toHaveProperty('adminPassword');
            expect(fixture.state.batches).toBe(1);
            const previous = await storage.get('misub_restore_snapshot_latest');
            expect(previous.data.subscriptions[0].id).toBe('one');
            expect(JSON.stringify(previous)).not.toContain(settings.webdavBackup.password);
        }
    );
    it('rolls back pre-restore backup and every domain when the SQL batch fails', async () => {
        const before = await storage.readDomainSnapshot();
        fixture.state.failAt = 5;
        const response = await handleBackupRestore(
            req({
                ...(await metadata()),
                nextEpoch: 'restored_epoch',
                payload: backup(),
                scope: 'dataAndSettings',
            }),
            fixture.env
        );
        expect(response.status).toBe(503);
        expect(await storage.readDomainSnapshot()).toEqual(before);
        expect(await storage.get('misub_restore_snapshot_latest')).toBeNull();
    });
    it('does not allow a pre-restore settings form to overwrite restored data', async () => {
        const before = await metadata('stale_form');
        const response = await handleBackupRestore(
            req({
                ...(await metadata('restore')),
                nextEpoch: 'restored_epoch',
                payload: backup(),
                scope: 'dataAndSettings',
            }),
            fixture.env
        );
        expect(response.status).toBe(200);
        const stale = await handleSettingsSave(
            req({ ...before, settings: { FileName: 'Before' } }),
            fixture.env
        );
        expect(stale.status).toBe(409);
        expect((await storage.readDomainSnapshot()).settings.FileName).toBe('Restored');
    });
    it('keeps current rules when an old flat backup has no rules domain', async () => {
        const response = await handleBackupRestore(
            req({
                ...(await metadata()),
                nextEpoch: 'restored_epoch',
                scope: 'dataOnly',
                payload: { subscriptions: [], manualNodes: [], profiles: [] },
            }),
            fixture.env
        );
        expect(response.status).toBe(200);
        expect((await storage.readDomainSnapshot()).ruleTemplates).toEqual([rule]);
    });
    it.each(['subscriptions', 'profiles', 'ruleTemplates'])(
        'rejects a unified backup missing %s before writes',
        async (field) => {
            const payload = backup();
            delete payload.data[field];
            const response = await handleBackupRestore(
                req({
                    ...(await metadata()),
                    nextEpoch: 'restored_epoch',
                    payload,
                    scope: 'dataAndSettings',
                }),
                fixture.env
            );
            expect(response.status).toBe(400);
            expect(fixture.state.batches).toBe(0);
        }
    );
    it('requires remote restore metadata before fetching a file', async () => {
        const response = await handleWebdavRestore(
            req({ file: '/backup.json', scope: 'dataAndSettings' }),
            fixture.env
        );
        expect(response.status).toBe(428);
        expect(fixture.state.batches).toBe(0);
    });
});

describe('background settings writes recompute explicit status patches only', () => {
    it('records an uploaded backup status without overwriting a concurrent setting edit', async () => {
        expectedFetches = 2;
        fetch.mockImplementation(async (_url, options) => {
            if (options.method === 'PUT') {
                const snapshot = await storage.readDomainSnapshot();
                await storage.commitDomainOperations({
                    ...(await metadata('while_uploading')),
                    domains: { settings: { ...snapshot.settings, FileName: 'Concurrent' } },
                });
            }
            return new Response(null, { status: 201 });
        });
        const result = await performWebdavBackup(fixture.env);
        expect(result.success).toBe(true);
        const after = await storage.readDomainSnapshot();
        expect(after.settings).toMatchObject({
            FileName: 'Concurrent',
            webdavBackup: { lastBackupStatus: 'success', password: settings.webdavBackup.password },
        });
        expect(after.version.revision).toBe(2);
    });
    it.each([
        ['revision_conflict', 3],
        ['storage_unavailable', 1],
    ])('limits retry for %s to %s attempts', async (code, count) => {
        const commit = vi.fn().mockRejectedValue(protocolError(code));
        await expect(
            commitWebdavStatusPatch(
                {
                    readDomainSnapshot: () => storage.readDomainSnapshot(),
                    commitDomainOperations: commit,
                },
                { lastBackupStatus: 'success' }
            )
        ).rejects.toMatchObject({ code });
        expect(commit).toHaveBeenCalledTimes(count);
        expect(fixture.state.batches).toBe(0);
    });
    it('retries a known revision conflict while preserving a concurrent setting edit', async () => {
        const original = storage.commitDomainOperations.bind(storage);
        let first = true;
        const controlled = {
            readDomainSnapshot: () => storage.readDomainSnapshot(),
            async commitDomainOperations(value) {
                if (first) {
                    first = false;
                    const snapshot = await storage.readDomainSnapshot();
                    await original({
                        operationId: 'concurrent_setting',
                        baseVersion: snapshot.version,
                        domains: { settings: { ...snapshot.settings, FileName: 'Concurrent' } },
                    });
                }
                return original(value);
            },
        };
        await commitWebdavStatusPatch(controlled, { lastBackupStatus: 'success' });
        expect((await storage.readDomainSnapshot()).settings).toMatchObject({
            FileName: 'Concurrent',
            webdavBackup: { lastBackupStatus: 'success', password: settings.webdavBackup.password },
        });
    });
    it('refuses a status job captured before an epoch restore', async () => {
        const before = await metadata();
        await handleBackupRestore(
            req({
                ...before,
                nextEpoch: 'restored_epoch',
                payload: backup(),
                scope: 'dataAndSettings',
            }),
            fixture.env
        );
        await expect(
            commitWebdavStatusPatch(
                storage,
                { lastBackupStatus: 'success' },
                { expectedEpoch: before.baseVersion.epoch }
            )
        ).rejects.toMatchObject({ code: 'epoch_conflict' });
        expect((await storage.readDomainSnapshot()).settings.webdavBackup).not.toHaveProperty(
            'lastBackupStatus'
        );
    });
    it('commits a scheduled check as a narrow versioned update without an upload when not due', async () => {
        const snapshot = await storage.readDomainSnapshot();
        await storage.commitDomainOperations({
            ...(await metadata()),
            domains: {
                settings: {
                    ...snapshot.settings,
                    webdavBackup: {
                        ...snapshot.settings.webdavBackup,
                        autoBackup: true,
                        lastBackupAt: new Date().toISOString(),
                    },
                },
            },
        });
        const result = await maybeRunScheduledTasks({ env: fixture.env });
        expect(result).toMatchObject({ skipped: true, reason: 'not-due' });
        const after = await storage.readDomainSnapshot();
        expect(after.version.revision).toBe(2);
        expect(after.settings.webdavBackup.lastCheckedAt).toEqual(expect.any(String));
        expect(after.settings.FileName).toBe('Before');
    });
});
