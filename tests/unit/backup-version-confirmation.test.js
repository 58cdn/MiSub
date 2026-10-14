import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WebdavBackupSettings from '../../src/components/settings/sections/WebdavBackupSettings.vue';
import { useBackupLogic } from '../../src/composables/useBackupLogic.js';
import { createI18n } from '../../src/i18n/index.js';

const { get, post, confirmAction, showToast } = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    confirmAction: vi.fn(),
    showToast: vi.fn(),
}));
vi.mock('../../src/lib/http.js', () => ({ api: { get, post } }));
vi.mock('../../src/composables/useConfirm.js', () => ({ confirmAction }));
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));
const version = (revision) => ({ epoch: 'backup-fixture', revision });
const payload = { scope: 'dataOnly', subscriptions: [], profiles: [], ruleTemplates: [] };
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
let selectedInput;
let fileRead;
let wrappers;
let baseline;
let events;
let confirmation;

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    selectedInput = null;
    fileRead = null;
    wrappers = [];
    events = [];
    baseline = {
        subscriptionProtocol: 'd1-v1',
        version: version(4),
        misubs: [],
        profiles: [],
        config: {},
        ruleTemplates: [],
    };
    confirmation = deferred();
    get.mockImplementation(async (url) => {
        if (url === '/api/backup/webdav/list')
            return { success: true, data: [{ name: 'fixture.json', path: '/fixture.json' }] };
        if (url === '/api/data') {
            events.push('baseline');
            return baseline;
        }
        throw new Error('unexpected mock GET');
    });
    confirmAction.mockImplementation(() => {
        events.push('confirm');
        return confirmation.promise;
    });
    post.mockImplementation(async () => {
        events.push('post');
        return { success: true };
    });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
        selectedInput = this;
    });
    vi.stubGlobal(
        'FileReader',
        class {
            readAsText() {
                fileRead = this.onload({ target: { result: JSON.stringify(payload) } });
            }
        }
    );
});
afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function start(kind) {
    if (kind === 'composable') useBackupLogic().importBackup();
    else {
        const wrapper = mount(WebdavBackupSettings, {
            props: {
                settings: {
                    webdavBackup: {
                        enabled: true,
                        endpoint: 'https://fixture.invalid',
                        backupScope: 'dataOnly',
                        remotePath: '/MiSub',
                        retentionCount: 7,
                    },
                },
            },
            global: { plugins: [createI18n({ initialLocale: 'en-US' })] },
        });
        wrappers.push(wrapper);
        if (kind === 'remote') {
            await wrapper
                .findAll('button')
                .find((button) => button.text() === 'Load remote backups')
                .trigger('click');
            await flushPromises();
            await wrapper
                .findAll('button')
                .find((button) => button.text() === 'Restore')
                .trigger('click');
        } else
            await wrapper
                .findAll('button')
                .find((button) => button.text() === 'Restore from file')
                .trigger('click');
    }
    if (kind !== 'remote') selectedInput.onchange({ target: { files: [new Blob(['fixture'])] } });
    await flushPromises();
}
async function finish(confirmed) {
    confirmation.resolve(confirmed);
    if (fileRead) await fileRead;
    await flushPromises();
}

describe.each(['composable', 'local', 'remote'])(
    '%s backup restore version confirmation',
    (kind) => {
        it('loads the baseline before confirmation and submits that exact version without a later GET', async () => {
            await start(kind);
            expect(events).toEqual(['baseline', 'confirm']);
            expect(post).not.toHaveBeenCalled();
            baseline.version.revision = 99;
            await finish(true);
            expect(events).toEqual(['baseline', 'confirm', 'post']);
            expect(get.mock.calls.filter(([url]) => url === '/api/data')).toHaveLength(1);
            const [url, body] = post.mock.calls[0];
            expect(url).toBe(
                kind === 'remote' ? '/api/backup/webdav/restore' : '/api/backup/restore'
            );
            expect(body).toMatchObject({
                baseVersion: version(4),
                operationId: expect.any(String),
                nextEpoch: expect.any(String),
            });
            expect(body.nextEpoch).not.toBe(body.operationId);
            expect(body.nextEpoch).not.toBe('backup-fixture');
            if (kind === 'remote') expect(body.file).toBe('/fixture.json');
            else expect(body.payload).toEqual(payload);
        });
        it('does not post if confirmation is canceled', async () => {
            await start(kind);
            await finish(false);
            expect(events).toEqual(['baseline', 'confirm']);
            expect(post).not.toHaveBeenCalled();
        });
        it('does not prompt or submit if the authoritative baseline fails', async () => {
            get.mockImplementation(async (url) => {
                if (url === '/api/backup/webdav/list')
                    return {
                        success: true,
                        data: [{ name: 'fixture.json', path: '/fixture.json' }],
                    };
                throw new Error('offline');
            });
            await start(kind);
            if (fileRead) await fileRead;
            expect(confirmAction).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
            expect(showToast.mock.calls.at(-1)[1]).toBe('error');
        });
        it('blocks a malformed strict version before the user confirmation', async () => {
            baseline.version = { epoch: '', revision: -1 };
            await start(kind);
            if (fileRead) await fileRead;
            expect(confirmAction).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
        });
        it('keeps legacy restore request shapes without protocol metadata', async () => {
            delete baseline.subscriptionProtocol;
            delete baseline.version;
            await start(kind);
            await finish(true);
            expect(post.mock.calls[0][1]).toEqual(
                kind === 'remote' ? { file: '/fixture.json' } : { payload, scope: 'dataOnly' }
            );
        });
        it('does not obtain a newer version or retry automatically after a 409', async () => {
            post.mockImplementation(async () => {
                events.push('post');
                throw Object.assign(new Error('revision_conflict'), { status: 409 });
            });
            await start(kind);
            await finish(true);
            expect(events).toEqual(['baseline', 'confirm', 'post']);
            expect(post).toHaveBeenCalledOnce();
            expect(get.mock.calls.filter(([url]) => url === '/api/data')).toHaveLength(1);
            expect(showToast.mock.calls.at(-1)[1]).toBe('error');
            expect(vi.getTimerCount()).toBe(0);
        });
    }
);
