import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import DetectorSettings from '../../src/components/settings/sections/DetectorSettings.vue';
import { setLocale } from '../../src/i18n/index.js';

let wrappers, calls, ready, overviewHandler, historyHandler, createHandler, revokeHandler;
const timestamp = Date.parse('2026-01-01T00:00:00Z');
const agent = (id = 'one', extra = {}) => ({
    id,
    name: `Detector ${id}`,
    createdAt: timestamp,
    lastSeen: timestamp,
    lastTaskAt: timestamp - 2000,
    lastResultAt: timestamp - 1000,
    status: 'online',
    revokedAt: null,
    version: '0.2.0',
    platform: 'linux-amd64',
    taskCounts: { queued: 1, running: 2, done: 3, stopped: 4 },
    ...extra,
});
const overview = (agents = [agent()], extra = {}) => ({
    agents,
    total: agents.length,
    nextOffset: null,
    checkedAt: timestamp,
    onlineWindowMs: 120000,
    retentionDays: 7,
    ...extra,
});
const history = (records = [], extra = {}) => ({
    agent: agent(),
    records,
    total: records.length,
    nextOffset: null,
    checkedAt: timestamp,
    retentionDays: 7,
    ...extra,
});
const record = (name = 'Fixture node', extra = {}) => ({
    id: name,
    jobId: 'fixture-job',
    nodeId: 'fixture',
    nodeName: name,
    state: 'done',
    attempt: 1,
    createdAt: timestamp - 2000,
    completedAt: timestamp - 1000,
    checks: {
        proxy: { status: 'passed', code: 'proxy_reachable', latencyMs: 0 },
        unlock: {
            status: 'unknown',
            code: 'probe_inconclusive',
            services: [
                {
                    service: 'openai',
                    status: 'unknown',
                    code: 'service_reachable',
                    httpStatus: 401,
                    checkedAt: '2026-01-01T00:00:00Z',
                },
            ],
        },
    },
    ...extra,
});
const response = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const create = (component = DetectorSettings) => {
    const wrapper = mount(component, {
        attachTo: document.body,
        global: { stubs: { teleport: true } },
    });
    wrappers.push(wrapper);
    return wrapper;
};
const get = (wrapper, id) => wrapper.get(`[data-testid="${id}"]`);
const submit = async (wrapper) => {
    await get(wrapper, 'detector-name').setValue('My device');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
};
const writes = () => calls.filter((call) => call.options.method !== 'GET');

beforeEach(() => {
    setLocale('en-US');
    wrappers = [];
    calls = [];
    ready = true;
    overviewHandler = async () => response(overview());
    historyHandler = async () => response(history([record()]));
    createHandler = async () =>
        response({ id: 'created', name: 'My device', token: 'FIXTURE_ONLY_SECRET' });
    revokeHandler = async () => response({ revoked: true });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/capabilities')) return response({ storageReady: ready });
            if (options.method === 'POST') return createHandler(url, options);
            if (options.method === 'DELETE') return revokeHandler(url, options);
            if (url.includes('/overview?')) return overviewHandler(url, options);
            if (url.includes('/history?')) return historyHandler(url, options);
            throw new Error('unexpected_request');
        })
    );
});
afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('detector settings', () => {
    it('reads capabilities before storage data and disables creation when unconfigured', async () => {
        ready = false;
        const wrapper = create();
        await flushPromises();
        expect(calls.map(({ url }) => url)).toEqual(['/api/probes/v1/capabilities']);
        expect(get(wrapper, 'detector-create').attributes('disabled')).toBeDefined();
        expect(wrapper.text()).toContain('Detector storage is not configured');
        expect(wrapper.find('[data-testid="detector-history"]').exists()).toBe(false);
    });
    it('renders server states despite a different local clock, with distinct communication and result times', async () => {
        overviewHandler = async () =>
            response(
                overview([
                    agent(),
                    agent('two', { status: 'offline' }),
                    agent('three', {
                        status: 'unknown',
                        lastSeen: 0,
                        lastTaskAt: null,
                        lastResultAt: null,
                        version: null,
                        platform: null,
                    }),
                    agent('four', { status: 'revoked', revokedAt: timestamp }),
                ])
            );
        const wrapper = create();
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').text()).toContain('Online');
        expect(get(wrapper, 'detector-card-two').text()).toContain('Offline');
        expect(get(wrapper, 'detector-card-three').text()).toContain('Unknown');
        expect(get(wrapper, 'detector-card-four').text()).toContain('Revoked');
        expect(get(wrapper, 'detector-card-one').text()).toContain(
            'Last communication (poll / heartbeat)'
        );
        expect(get(wrapper, 'detector-card-one').text()).toContain('Latest task created');
        expect(get(wrapper, 'detector-card-one').text()).toContain('Latest result received');
        expect(get(wrapper, 'detector-card-three').text()).toContain('No record');
        expect(get(wrapper, 'detector-card-three').text()).not.toContain('1970');
        expect(get(wrapper, 'detector-card-three').text()).not.toContain('Version / platform');
        expect(wrapper.text()).toContain('not a successful node check');
        expect(wrapper.text()).toContain('7 days.');
    });
    it('only displays allowed metadata and typed persisted measurements, preserving unknown evidence', async () => {
        overviewHandler = async () =>
            response(overview([agent('one', { token: 'HIDDEN_TOKEN', secret: 'PRIVATE_KEY' })]));
        historyHandler = async () =>
            response(
                history([
                    record('Fixture', {
                        nodeUrl: 'ss://password@example.invalid',
                        checks: {
                            ...record().checks,
                            speed: {
                                status: 'passed',
                                code: 'download_complete',
                                bytes: 0,
                                bytesPerSecond: 1250,
                                private: 'HIDDEN_TOKEN',
                            },
                        },
                    }),
                ])
            );
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).toContain('Latency: 0 ms');
        expect(get(wrapper, 'detector-history').text()).toContain('Speed: 1250 B/s');
        expect(get(wrapper, 'detector-history').text()).toContain('Unknown');
        expect(get(wrapper, 'detector-history').text()).toContain('service_reachable');
        expect(get(wrapper, 'detector-history').text()).toContain('HTTP 401');
        expect(wrapper.html()).not.toMatch(/HIDDEN_TOKEN|PRIVATE_KEY|ss:\/\/password/);
        expect(writes()).toHaveLength(0);
    });
    it('shows capability errors without leaking error content and provides retry', async () => {
        fetch.mockRejectedValueOnce(new Error('secret://PRIVATE'));
        const wrapper = create();
        await flushPromises();
        expect(wrapper.text()).toContain('Unable to read detector service');
        expect(wrapper.html()).not.toContain('PRIVATE');
        await get(wrapper, 'detector-initial-retry').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').text()).toContain('Online');
    });
    it('marks failed list refresh stale instead of turning agents offline', async () => {
        const wrapper = create();
        await flushPromises();
        overviewHandler = async () => {
            throw new Error('PRIVATE_TOKEN');
        };
        await get(wrapper, 'detector-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').text()).toContain('Status needs refresh');
        expect(get(wrapper, 'detector-card-one').text()).not.toContain('Offline');
        expect(wrapper.html()).not.toContain('PRIVATE_TOKEN');
        overviewHandler = async () => response(overview());
        await get(wrapper, 'detector-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').text()).toContain('Online');
    });
    it('pages the overview and clears previous page evidence during failed reads', async () => {
        overviewHandler = async () => response(overview([agent()], { total: 21, nextOffset: 20 }));
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        overviewHandler = () => pending.promise;
        await get(wrapper, 'detector-overview-next').trigger('click');
        expect(wrapper.find('[data-testid="detector-card-one"]').exists()).toBe(false);
        expect(calls.at(-1).url).toContain('offset=20&limit=20');
        pending.reject(new Error('offline'));
        await flushPromises();
        expect(wrapper.find('[data-testid="detector-card-one"]').exists()).toBe(false);
        overviewHandler = async () => response(overview());
        await get(wrapper, 'detector-overview-prev').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').exists()).toBe(true);
    });
    it('pages durable history and presents its empty state', async () => {
        historyHandler = async (url) =>
            response(
                url.includes('offset=20')
                    ? history([])
                    : history([record('FIRST_PAGE')], { total: 21, nextOffset: 20 })
            );
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).toContain('FIRST_PAGE');
        await get(wrapper, 'detector-history-next').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).not.toContain('FIRST_PAGE');
        expect(get(wrapper, 'detector-history').text()).toContain(
            'No detection history within the retention period'
        );
        expect(calls.at(-1).url).toBe('/api/probes/v1/agents/one/history?offset=20&limit=20');
    });
    it('aborts old history and ignores late responses when selecting a different detector', async () => {
        overviewHandler = async () => response(overview([agent(), agent('two')]));
        const pending = deferred();
        historyHandler = async (url) =>
            url.includes('/one/')
                ? pending.promise
                : response(history([record('CURRENT_HISTORY')]));
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        const signal = calls.at(-1).options.signal;
        await get(wrapper, 'detector-history-two').trigger('click');
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(get(wrapper, 'detector-history').text()).toContain('CURRENT_HISTORY');
        pending.resolve(response(history([record('STALE_HISTORY')])));
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).not.toContain('STALE_HISTORY');
    });
    it('shows history errors and recovers with explicit retry', async () => {
        historyHandler = async () => {
            throw new Error('credentials');
        };
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).toContain('Unable to refresh history');
        historyHandler = async () => response(history());
        await get(wrapper, 'detector-history')
            .findAll('button')
            .find((button) => button.text() === 'Retry')
            .trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).toContain('No detection history');
    });
    it('requires explicit creation and keeps credentials outside rendered markup and storage', async () => {
        const wrapper = create();
        await flushPromises();
        expect(writes()).toHaveLength(0);
        const storage = vi.spyOn(Storage.prototype, 'setItem');
        await submit(wrapper);
        expect(writes()).toHaveLength(1);
        expect(JSON.parse(writes()[0].options.body)).toEqual({ name: 'My device' });
        expect(get(wrapper, 'detector-download').exists()).toBe(true);
        expect(wrapper.html()).not.toContain('FIXTURE_ONLY_SECRET');
        expect(storage).not.toHaveBeenCalled();
        expect(get(wrapper, 'detector-create').attributes('disabled')).toBeDefined();
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });
    it('downloads the existing config format once and clears credentials after the download', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let saved;
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            saved = blob;
            return 'blob:fixture';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const click = vi
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(function () {
                expect(this.download).toBe('probe.json');
            });
        const wrapper = create();
        await flushPromises();
        await submit(wrapper);
        await get(wrapper, 'detector-download').trigger('click');
        expect(JSON.parse(await saved.text())).toEqual({
            version: 1,
            server: window.location.origin,
            token: 'FIXTURE_ONLY_SECRET',
            pollSeconds: 60,
        });
        expect(click).toHaveBeenCalledTimes(1);
        expect(revoke).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(revoke).toHaveBeenCalledWith('blob:fixture');
        expect(wrapper.find('[data-testid="detector-download"]').exists()).toBe(false);
        expect(wrapper.html()).not.toContain('FIXTURE_ONLY_SECRET');
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });
    it('requires discard confirmation and does not revoke an identity when discarding a config', async () => {
        const wrapper = create();
        await flushPromises();
        await submit(wrapper);
        await get(wrapper, 'detector-discard').trigger('click');
        expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="detector-download"]').exists()).toBe(false);
        await get(wrapper, 'detector-cancel-discard').trigger('click');
        expect(get(wrapper, 'detector-download').exists()).toBe(true);
        await get(wrapper, 'detector-discard').trigger('click');
        await get(wrapper, 'detector-confirm-discard').trigger('click');
        expect(wrapper.find('[data-testid="detector-download"]').exists()).toBe(false);
        expect(writes()).toHaveLength(1);
    });
    it('allows Escape from discard confirmation to return to saving with one active focus trap', async () => {
        const wrapper = create();
        await flushPromises();
        await submit(wrapper);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await nextTick();
        expect(get(wrapper, 'detector-confirm-discard').exists()).toBe(true);
        expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await nextTick();
        expect(get(wrapper, 'detector-download').exists()).toBe(true);
        expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
        expect(writes()).toHaveLength(1);
    });
    it('retains the configuration if download setup fails and cleans blob URLs on exit', async () => {
        const makeUrl = vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => {
            throw new Error('DOWNLOAD_PRIVATE_SECRET');
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const wrapper = create();
        await flushPromises();
        await submit(wrapper);
        await get(wrapper, 'detector-download').trigger('click');
        expect(wrapper.text()).toContain('Unable to start the download');
        expect(wrapper.html()).not.toContain('DOWNLOAD_PRIVATE_SECRET');
        makeUrl.mockReturnValue('blob:fixture');
        await get(wrapper, 'detector-download').trigger('click');
        expect(revoke).not.toHaveBeenCalled();
        wrapper.unmount();
        expect(revoke).toHaveBeenCalledWith('blob:fixture');
    });
    it('enforces the API name boundary and blocks whitespace or control characters', async () => {
        const wrapper = create();
        await flushPromises();
        expect(get(wrapper, 'detector-name').attributes('maxlength')).toBe('60');
        for (const value of ['   ', 'A'.repeat(61), 'Device\x01']) {
            await get(wrapper, 'detector-name').setValue(value);
            await wrapper.get('form').trigger('submit');
            expect(get(wrapper, 'detector-create').attributes('disabled')).toBeDefined();
        }
        expect(writes()).toHaveLength(0);
    });
    it('labels stopped task completion as an end time rather than a received result', async () => {
        historyHandler = async () =>
            response(history([record('Cancelled fixture', { state: 'cancelled', checks: {} })]));
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).toContain('Ended:');
        expect(get(wrapper, 'detector-history').text()).not.toContain('Result received:');
    });
    it('ages source evidence from server history time and elapsed monotonic time', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        historyHandler = async () =>
            response(
                history([
                    record('Source fixture', {
                        checks: {
                            observations: {
                                status: 'unknown',
                                code: 'probe_inconclusive',
                                report: {
                                    expiresAt: new Date(timestamp + 60000).toISOString(),
                                    results: [],
                                    conflicts: [],
                                },
                            },
                        },
                    }),
                ])
            );
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-auto-refresh').setValue(false);
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).not.toContain('Results have expired');
        await vi.advanceTimersByTimeAsync(61000);
        expect(get(wrapper, 'detector-history').text()).toContain('Results have expired');
    });
    it('prevents repeated create while pending and does not retry ambiguous failures', async () => {
        const pending = deferred();
        createHandler = () => pending.promise;
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-name').setValue('Device');
        await wrapper.get('form').trigger('submit');
        await wrapper.get('form').trigger('submit');
        expect(writes()).toHaveLength(1);
        pending.reject(new Error('PRIVATE_KEY'));
        await flushPromises();
        expect(wrapper.text()).toContain('an identity may already exist');
        expect(wrapper.html()).not.toContain('PRIVATE_KEY');
        await get(wrapper, 'detector-refresh').trigger('click');
        await flushPromises();
        expect(writes()).toHaveLength(1);
    });
    it('confirms revocation, supports cancel and Escape, and sends only the selected identity', async () => {
        const wrapper = create();
        await flushPromises();
        const button = get(wrapper, 'detector-revoke-one');
        button.element.focus();
        await button.trigger('click');
        await nextTick();
        expect(writes()).toHaveLength(0);
        await get(wrapper, 'detector-cancel-revoke').trigger('click');
        expect(document.activeElement).toBe(button.element);
        await button.trigger('click');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await nextTick();
        expect(wrapper.find('[data-testid="detector-confirm-revoke"]').exists()).toBe(false);
        await button.trigger('click');
        await get(wrapper, 'detector-confirm-revoke').trigger('click');
        await flushPromises();
        expect(writes()).toHaveLength(1);
        expect(writes()[0].url).toBe('/api/probes/v1/agents/one');
        expect(writes()[0].options.method).toBe('DELETE');
        expect(wrapper.text()).toContain('Detector revoked');
    });
    it('preserves the revoke confirmation after failure and permits safe cancellation', async () => {
        revokeHandler = async () => {
            throw new Error('TOKEN_SECRET');
        };
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-revoke-one').trigger('click');
        await get(wrapper, 'detector-confirm-revoke').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('Revocation was not confirmed');
        expect(wrapper.html()).not.toContain('TOKEN_SECRET');
        await get(wrapper, 'detector-cancel-revoke').trigger('click');
        expect(wrapper.find('[data-testid="detector-confirm-revoke"]').exists()).toBe(false);
    });
    it('invalidates in-flight overview and history after revocation and ignores late pre-revoke responses', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        const oldOverview = deferred(),
            oldHistory = deferred();
        overviewHandler = () => oldOverview.promise;
        historyHandler = () => oldHistory.promise;
        await get(wrapper, 'detector-refresh').trigger('click');
        const pendingReads = calls.slice(-2);
        expect(pendingReads.every(({ options }) => !options.signal.aborted)).toBe(true);
        overviewHandler = async () =>
            response(overview([agent('one', { status: 'revoked', revokedAt: timestamp })]));
        historyHandler = async () =>
            response(history([record('AFTER_REVOCATION', { state: 'cancelled', checks: {} })]));
        await get(wrapper, 'detector-revoke-one').trigger('click');
        await get(wrapper, 'detector-confirm-revoke').trigger('click');
        await flushPromises();
        expect(pendingReads.every(({ options }) => options.signal.aborted)).toBe(true);
        expect(calls.filter(({ url }) => url.includes('/overview?'))).toHaveLength(3);
        expect(calls.filter(({ url }) => url.includes('/history?'))).toHaveLength(3);
        expect(get(wrapper, 'detector-card-one').text()).toContain('Revoked');
        expect(get(wrapper, 'detector-history').text()).toContain('AFTER_REVOCATION');
        oldOverview.resolve(response(overview()));
        oldHistory.resolve(response(history([record('BEFORE_REVOCATION', { state: 'running' })])));
        await flushPromises();
        expect(get(wrapper, 'detector-card-one').text()).toContain('Revoked');
        expect(wrapper.find('[data-testid="detector-revoke-one"]').exists()).toBe(false);
        expect(get(wrapper, 'detector-history').text()).toContain('AFTER_REVOCATION');
        expect(get(wrapper, 'detector-history').text()).not.toContain('BEFORE_REVOCATION');
    });
    it('expires each online communication window using server time plus elapsed time and removes the green state', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        overviewHandler = async () =>
            response(
                overview([
                    agent('one', { lastSeen: timestamp - 119000 }),
                    agent('recent'),
                    agent('revoked', { status: 'revoked', revokedAt: timestamp }),
                ])
            );
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-auto-refresh').setValue(false);
        expect(get(wrapper, 'detector-card-one').text()).toContain('Online');
        expect(get(wrapper, 'detector-card-one').html()).toContain('text-emerald-700');
        await vi.advanceTimersByTimeAsync(2000);
        expect(get(wrapper, 'detector-card-one').text()).toContain('Status needs refresh');
        expect(get(wrapper, 'detector-card-one').text()).not.toContain('Offline');
        expect(get(wrapper, 'detector-card-one').html()).not.toContain('text-emerald-700');
        expect(get(wrapper, 'detector-card-recent').text()).toContain('Online');
        expect(get(wrapper, 'detector-card-revoked').text()).toContain('Revoked');
        expect(calls.filter(({ url }) => url.includes('/overview?'))).toHaveLength(1);
    });
    it('refreshes without overlap, can pause, and ages the snapshot without client-clock status inference', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        overviewHandler = () => pending.promise;
        await vi.advanceTimersByTimeAsync(30000);
        await flushPromises();
        expect(calls.filter(({ url }) => url.includes('/overview?'))).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(60000);
        await flushPromises();
        expect(calls.filter(({ url }) => url.includes('/overview?'))).toHaveLength(2);
        pending.resolve(response(overview()));
        await flushPromises();
        await get(wrapper, 'detector-auto-refresh').setValue(false);
        await vi.advanceTimersByTimeAsync(121000);
        await flushPromises();
        expect(calls.filter(({ url }) => url.includes('/overview?'))).toHaveLength(2);
        expect(get(wrapper, 'detector-card-one').text()).toContain('Status needs refresh');
    });
    it('stops hidden reads and polling, then refreshes when visible', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        overviewHandler = () => pending.promise;
        await get(wrapper, 'detector-refresh').trigger('click');
        const signal = calls.at(-1).options.signal;
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(signal.aborted).toBe(true);
        const count = calls.length;
        await vi.advanceTimersByTimeAsync(90000);
        expect(calls).toHaveLength(count);
        pending.resolve(response(overview([agent('hidden')])));
        await flushPromises();
        expect(wrapper.find('[data-testid="detector-card-hidden"]').exists()).toBe(false);
        overviewHandler = async () => response(overview());
        hidden.mockReturnValue(false);
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();
        expect(calls.length).toBe(count + 1);
    });
    it('aborts pending writes and ignores credentials delivered after unmount', async () => {
        const pending = deferred();
        createHandler = () => pending.promise;
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-name').setValue('Late');
        await wrapper.get('form').trigger('submit');
        const signal = calls.at(-1).options.signal;
        wrapper.unmount();
        expect(signal.aborted).toBe(true);
        const count = calls.length;
        pending.resolve(response({ id: 'late', name: 'Late', token: 'SECRET_LATE' }));
        await flushPromises();
        expect(calls).toHaveLength(count);
        expect(document.body.innerHTML).not.toContain('SECRET_LATE');
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });
    it('clears a pending configuration on KeepAlive deactivation and resumes with fresh reads', async () => {
        const shell = defineComponent({
            components: { DetectorSettings, KeepAlive },
            data: () => ({ visible: true }),
            template: '<KeepAlive><DetectorSettings v-if="visible" /></KeepAlive>',
        });
        const wrapper = create(shell);
        await flushPromises();
        await submit(wrapper);
        await wrapper.setData({ visible: false });
        await flushPromises();
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        await wrapper.setData({ visible: true });
        await flushPromises();
        expect(wrapper.find('[data-testid="detector-download"]').exists()).toBe(false);
        expect(calls.filter(({ url }) => url.endsWith('/capabilities'))).toHaveLength(2);
    });
});
