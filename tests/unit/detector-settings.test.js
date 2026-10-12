import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import DetectorSettings from '../../src/components/settings/sections/DetectorSettings.vue';
import { setLocale } from '../../src/i18n/index.js';
import { DETECTOR_COLUMNS, DETECTOR_VIEW_KEY } from '../../src/utils/detector-view-preferences.js';

let wrappers,
    calls,
    ready,
    overviewHandler,
    historyHandler,
    createHandler,
    revokeHandler,
    archiveHandler,
    restoreHandler;
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
    hidden: false,
    archivedAt: null,
    lastHeartbeatAt: null,
    capabilities: null,
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
const overviewCalls = () => calls.filter((call) => call.url.includes('/overview?'));
const params = (call = overviewCalls().at(-1)) =>
    new URL(call.url, 'https://fixture.invalid').searchParams;
const revoked = (id = 'one', extra = {}) =>
    agent(id, { status: 'revoked', revokedAt: timestamp, ...extra });

beforeEach(() => {
    localStorage.removeItem(DETECTOR_VIEW_KEY);
    setLocale('en-US');
    wrappers = [];
    calls = [];
    ready = true;
    overviewHandler = async () => response(overview());
    historyHandler = async () => response(history([record()]));
    createHandler = async () =>
        response({ id: 'created', name: 'My device', token: 'FIXTURE_ONLY_SECRET' });
    revokeHandler = async () => response({ revoked: true });
    archiveHandler = async () =>
        response({ id: 'one', hidden: true, archivedAt: timestamp, restoredAt: null });
    restoreHandler = async () =>
        response({ id: 'one', hidden: false, archivedAt: null, restoredAt: timestamp });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/capabilities')) return response({ storageReady: ready });
            if (url.endsWith('/archive')) return archiveHandler(url, options);
            if (url.endsWith('/restore')) return restoreHandler(url, options);
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

describe('detector list and recoverable deletion', () => {
    it('switches views without another request and saves only allowed presentation preferences', async () => {
        overviewHandler = async () => response(overview([agent()], { total: 21, nextOffset: 20 }));
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-overview-next').trigger('click');
        await flushPromises();
        const count = calls.length;
        await get(wrapper, 'detector-view-list').trigger('click');
        expect(calls).toHaveLength(count);
        expect(get(wrapper, 'detector-row-one').exists()).toBe(true);
        expect(wrapper.text()).toContain('Page 2');
        expect(get(wrapper, 'detector-view-list').attributes('aria-pressed')).toBe('true');
        expect(get(wrapper, 'detector-table-scroll').attributes('tabindex')).toBe('0');
        await get(wrapper, 'detector-column-version').setValue(false);
        expect(wrapper.find('th[data-column="version"]').exists()).toBe(false);
        const stored = JSON.parse(localStorage.getItem(DETECTOR_VIEW_KEY));
        expect(Object.keys(stored).sort()).toEqual(['columns', 'version', 'view']);
        expect(stored.view).toBe('list');
        expect(stored.columns).not.toContain('version');
        const next = create();
        await flushPromises();
        expect(get(next, 'detector-view-list').attributes('aria-pressed')).toBe('true');
        expect(next.find('th[data-column="version"]').exists()).toBe(false);
    });
    it('allows hiding every optional column while name and history actions remain available', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        for (const key of DETECTOR_COLUMNS)
            await get(wrapper, `detector-column-${key}`).setValue(false);
        expect(wrapper.findAll('thead th')).toHaveLength(2);
        expect(get(wrapper, 'detector-row-one').text()).toContain('Detector one');
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'detector-history-title').element).toBe(document.activeElement);
        expect(JSON.parse(localStorage.getItem(DETECTOR_VIEW_KEY)).columns).toEqual([]);
    });
    it.each([
        '{broken',
        JSON.stringify({ version: 99, view: 'list', columns: [] }),
        JSON.stringify({ version: 1, view: 'list', columns: 'token' }),
    ])('ignores corrupt preferences %s', async (stored) => {
        localStorage.setItem(DETECTOR_VIEW_KEY, stored);
        const wrapper = create();
        await flushPromises();
        expect(get(wrapper, 'detector-view-cards').attributes('aria-pressed')).toBe('true');
        expect(get(wrapper, 'detector-card-one').exists()).toBe(true);
    });
    it('validates stored column keys and never renders secret or unknown capability payloads', async () => {
        localStorage.setItem(
            DETECTOR_VIEW_KEY,
            JSON.stringify({
                version: 1,
                view: 'list',
                columns: [
                    'name',
                    'version',
                    'version',
                    'token',
                    'capabilities',
                    'lastHeartbeatAt',
                    3,
                ],
                q: 'PRIVATE_QUERY',
            })
        );
        overviewHandler = async () =>
            response(
                overview([
                    agent('one', {
                        token: 'PRIVATE_TOKEN',
                        capabilities: { secret: 'PRIVATE_CAPABILITY' },
                        lastHeartbeatAt: null,
                    }),
                ])
            );
        const wrapper = create();
        await flushPromises();
        expect(wrapper.findAll('thead th')).toHaveLength(5);
        expect(wrapper.html()).not.toMatch(/PRIVATE_TOKEN|PRIVATE_CAPABILITY|PRIVATE_QUERY/);
        expect(get(wrapper, 'detector-row-one').text()).toContain('Unknown (not reported)');
        expect(get(wrapper, 'detector-row-one').text()).toContain(
            'Unknown (not recorded separately)'
        );
        expect(params().has('q')).toBe(false);
    });
    it('retains in-memory view changes when browser preference storage is blocked', async () => {
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => {
                throw new Error('PRIVATE_STORAGE');
            },
        });
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        expect(get(wrapper, 'detector-row-one').exists()).toBe(true);
        expect(wrapper.text()).toContain('The browser could not save preferences');
        expect(wrapper.html()).not.toContain('PRIVATE_STORAGE');
    });
    it('detects silently discarded preference writes through the shared helper readback', async () => {
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        expect(get(wrapper, 'detector-row-one').exists()).toBe(true);
        expect(wrapper.text()).toContain('The browser could not save preferences');
    });
    it('falls back to cards when browser preference reads are denied without blocking data loading', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('SecurityError');
            },
            setItem: () => {},
        });
        const wrapper = create();
        await flushPromises();
        expect(get(wrapper, 'detector-view-cards').attributes('aria-pressed')).toBe('true');
        expect(get(wrapper, 'detector-card-one').exists()).toBe(true);
        expect(writes()).toHaveLength(0);
    });
    it('applies literal search only on submit and retains filters and sorting across pages and views', async () => {
        overviewHandler = async () => response(overview([agent()], { total: 21, nextOffset: 20 }));
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-search').setValue('a%_ & linux');
        expect(overviewCalls()).toHaveLength(1);
        await get(wrapper, 'detector-search-submit').trigger('submit');
        await flushPromises();
        expect(params().get('q')).toBe('a%_ & linux');
        await get(wrapper, 'detector-status-filter').setValue('revoked');
        await flushPromises();
        await get(wrapper, 'detector-visibility-filter').setValue('all');
        await flushPromises();
        await get(wrapper, 'detector-sort').setValue('version');
        await flushPromises();
        await get(wrapper, 'detector-direction').setValue('asc');
        await flushPromises();
        await get(wrapper, 'detector-overview-next').trigger('click');
        await flushPromises();
        expect(Object.fromEntries(params())).toEqual({
            offset: '20',
            limit: '20',
            q: 'a%_ & linux',
            status: 'revoked',
            visibility: 'all',
            sort: 'version',
            direction: 'asc',
        });
        const count = calls.length;
        await get(wrapper, 'detector-view-list').trigger('click');
        expect(calls).toHaveLength(count);
        expect(wrapper.text()).toContain('Page 2');
        expect(localStorage.getItem(DETECTOR_VIEW_KEY)).not.toContain('a%_');
        await get(wrapper, 'detector-status-filter').setValue('online');
        await flushPromises();
        expect(params().get('offset')).toBe('0');
        expect(params().get('q')).toBe('a%_ & linux');
    });
    it('invalidates delayed filter results even when the mock transport ignores abort', async () => {
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        overviewHandler = () => pending.promise;
        await get(wrapper, 'detector-status-filter').setValue('offline');
        const oldCall = overviewCalls().at(-1);
        overviewHandler = async () => response(overview([revoked('CURRENT')]));
        await get(wrapper, 'detector-status-filter').setValue('revoked');
        await flushPromises();
        expect(oldCall.options.signal.aborted).toBe(true);
        pending.resolve(response(overview([agent('STALE')])));
        await flushPromises();
        expect(wrapper.text()).toContain('Detector CURRENT');
        expect(wrapper.text()).not.toContain('Detector STALE');
    });
    it('uses sortable native buttons with aria-sort and preserves focus after loading', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        const button = get(wrapper, 'detector-sort-name');
        button.element.focus();
        await button.trigger('click');
        await flushPromises();
        expect(params().get('sort')).toBe('name');
        expect(params().get('direction')).toBe('asc');
        expect(get(wrapper, 'detector-sort-name').element).toBe(document.activeElement);
        expect(
            get(wrapper, 'detector-sort-name').element.closest('th').getAttribute('aria-sort')
        ).toBe('ascending');
        await get(wrapper, 'detector-sort-name').trigger('click');
        await flushPromises();
        expect(
            get(wrapper, 'detector-sort-name').element.closest('th').getAttribute('aria-sort')
        ).toBe('descending');
    });
    it('does not steal focus when a user moves to search during a slow sort request', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        const pending = deferred();
        overviewHandler = () => pending.promise;
        get(wrapper, 'detector-sort-name').element.focus();
        await get(wrapper, 'detector-sort-name').trigger('click');
        get(wrapper, 'detector-search').element.focus();
        pending.resolve(response(overview()));
        await flushPromises();
        expect(document.activeElement).toBe(get(wrapper, 'detector-search').element);
    });
    it('moves focus after confirming deletion without waiting for a slow list refresh or stealing later input', async () => {
        overviewHandler = async () => response(overview([revoked()]));
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        overviewHandler = () => pending.promise;
        await get(wrapper, 'detector-archive-one').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await flushPromises();
        expect(document.activeElement.textContent).toContain('My detectors');
        get(wrapper, 'detector-search').element.focus();
        pending.resolve(response(overview([])));
        await flushPromises();
        expect(document.activeElement).toBe(get(wrapper, 'detector-search').element);
    });
    it('keeps user focus after an archive completes when its pending dialog was closed', async () => {
        overviewHandler = async () => response(overview([revoked()]));
        const wrapper = create();
        await flushPromises();
        const pending = deferred();
        archiveHandler = () => pending.promise;
        await get(wrapper, 'detector-archive-one').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await get(wrapper, 'detector-cancel-archive').trigger('click');
        await flushPromises();
        get(wrapper, 'detector-search').element.focus();
        pending.resolve(response({ hidden: true }));
        await flushPromises();
        expect(document.activeElement).toBe(get(wrapper, 'detector-search').element);
    });
    it('distinguishes empty filtered results and resets search/status/visibility without resetting presentation', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        overviewHandler = async () => response(overview([]));
        await get(wrapper, 'detector-visibility-filter').setValue('hidden');
        await flushPromises();
        expect(wrapper.text()).toContain('No detectors match these filters');
        expect(wrapper.text()).not.toContain('No detectors yet');
        expect(get(wrapper, 'detector-overview-total').text()).toContain('Matching detectors: 0');
        await get(wrapper, 'detector-filters-reset').trigger('click');
        await flushPromises();
        expect(params().has('visibility')).toBe(false);
        expect(get(wrapper, 'detector-view-list').attributes('aria-pressed')).toBe('true');
    });
    it('requires explicit delete confirmation, supports Escape cancellation and only offers deletion for revoked identities', async () => {
        overviewHandler = async () => response(overview([agent(), revoked('two')]));
        const wrapper = create();
        await flushPromises();
        expect(wrapper.find('[data-testid="detector-archive-one"]').exists()).toBe(false);
        get(wrapper, 'detector-archive-two').element.focus();
        await get(wrapper, 'detector-archive-two').trigger('click');
        await flushPromises();
        expect(writes()).toHaveLength(0);
        expect(wrapper.text()).toContain('Credentials remain revoked');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flushPromises();
        expect(writes()).toHaveLength(0);
        expect(document.activeElement).toBe(get(wrapper, 'detector-archive-two').element);
        await get(wrapper, 'detector-archive-two').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await flushPromises();
        expect(writes()).toHaveLength(1);
        expect(writes()[0].url).toBe('/api/probes/v1/agents/two/archive');
        expect(JSON.parse(writes()[0].options.body)).toEqual({ confirmed: true });
    });
    it('clamps an emptied last page after deleting and invalidates both old reads before refresh', async () => {
        let archived = false;
        overviewHandler = async (url) =>
            response(
                overview(
                    url.includes('offset=20')
                        ? archived
                            ? []
                            : [revoked('last')]
                        : [agent('first')],
                    {
                        total: archived ? 20 : 21,
                        nextOffset: url.includes('offset=20') || archived ? null : 20,
                    }
                )
            );
        archiveHandler = async () => {
            archived = true;
            return response({ hidden: true });
        };
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-overview-next').trigger('click');
        await flushPromises();
        await get(wrapper, 'detector-history-last').trigger('click');
        await flushPromises();
        const oldOverview = deferred(),
            oldHistory = deferred();
        const readFresh = overviewHandler;
        overviewHandler = () => oldOverview.promise;
        historyHandler = () => oldHistory.promise;
        await get(wrapper, 'detector-refresh').trigger('click');
        const oldCalls = calls.slice(-2);
        overviewHandler = readFresh;
        historyHandler = async () => response(history([record('CURRENT')]));
        await get(wrapper, 'detector-archive-last').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await flushPromises();
        expect(oldCalls.every((call) => call.options.signal.aborted)).toBe(true);
        expect(params().get('offset')).toBe('0');
        expect(get(wrapper, 'detector-card-first').exists()).toBe(true);
        expect(get(wrapper, 'detector-history').text()).toContain('CURRENT');
        oldOverview.resolve(response(overview([revoked('STALE')])));
        oldHistory.resolve(response(history([record('STALE_HISTORY')])));
        await flushPromises();
        expect(wrapper.text()).not.toMatch(/Detector STALE|STALE_HISTORY/);
        expect(wrapper.text()).toContain('Page 1');
    });
    it('restores a deleted item explicitly without reauthorizing it, with history still accessible', async () => {
        let hidden = true;
        overviewHandler = async () =>
            response(overview([revoked('one', { hidden, archivedAt: hidden ? timestamp : null })]));
        restoreHandler = async () => {
            hidden = false;
            return response({ hidden: false });
        };
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-view-list').trigger('click');
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        await get(wrapper, 'detector-restore-one').trigger('click');
        expect(writes()).toHaveLength(0);
        expect(wrapper.text()).toContain('Its credentials remain revoked');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await flushPromises();
        expect(writes().map((call) => call.url)).toEqual(['/api/probes/v1/agents/one/restore']);
        expect(get(wrapper, 'detector-row-one').text()).toContain('Revoked');
        expect(get(wrapper, 'detector-archive-one').exists()).toBe(true);
        expect(wrapper.find('[data-testid="detector-revoke-one"]').exists()).toBe(false);
        expect(get(wrapper, 'detector-history').text()).toContain('Fixture node');
    });
    it('shows a fixed lease-conflict message and does not retry failed archive writes or leak errors', async () => {
        overviewHandler = async () => response(overview([revoked()]));
        archiveHandler = async () =>
            new Response(
                JSON.stringify({
                    success: false,
                    error: { code: 'agent_has_active_lease', message: 'PRIVATE_TOKEN' },
                }),
                { status: 409 }
            );
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-archive-one').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('active task lease');
        expect(wrapper.html()).not.toContain('PRIVATE_TOKEN');
        expect(writes()).toHaveLength(1);
        expect(get(wrapper, 'detector-card-one').exists()).toBe(true);
    });
    it('blocks repeated writes and ignores a delayed archive response after unmount', async () => {
        overviewHandler = async () => response(overview([revoked()]));
        const pending = deferred();
        archiveHandler = () => pending.promise;
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-archive-one').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        await get(wrapper, 'detector-confirm-archive').trigger('click');
        expect(writes()).toHaveLength(1);
        const count = calls.length;
        const call = writes()[0];
        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        expect(call.options.signal.aborted).toBe(true);
        pending.resolve(response({ hidden: true }));
        await flushPromises();
        expect(calls).toHaveLength(count);
    });
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
    it('filters task states on the server, preserves filters across pages, and resets the offset for a new filter', async () => {
        historyHandler = async (url) => {
            const query = new URL(url, window.location.origin).searchParams;
            if (query.get('state') === 'expired') return response(history([]));
            if (query.get('state') === 'done')
                return response(
                    history(
                        [record(query.get('offset') === '20' ? 'DONE_PAGE_TWO' : 'DONE_PAGE_ONE')],
                        { total: 21, nextOffset: query.get('offset') === '20' ? null : 20 }
                    )
                );
            return response(history([record('ALL_STATES')], { total: 42, nextOffset: 20 }));
        };
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        expect(calls.at(-1).url).toBe('/api/probes/v1/agents/one/history?offset=0&limit=20');
        await get(wrapper, 'detector-history-filter').setValue('done');
        await flushPromises();
        expect(get(wrapper, 'detector-history-total').text()).toBe('Matching records: 21 · Done');
        expect(get(wrapper, 'detector-history-total').attributes('aria-atomic')).toBe('true');
        expect(get(wrapper, 'detector-history').text()).toContain('Done means the task finished');
        await get(wrapper, 'detector-history-next').trigger('click');
        await flushPromises();
        expect(calls.at(-1).url).toBe(
            '/api/probes/v1/agents/one/history?offset=20&limit=20&state=done'
        );
        expect(get(wrapper, 'detector-history').text()).toContain('DONE_PAGE_TWO');
        await get(wrapper, 'detector-history-filter').setValue('expired');
        await flushPromises();
        expect(calls.at(-1).url).toBe(
            '/api/probes/v1/agents/one/history?offset=0&limit=20&state=expired'
        );
        expect(get(wrapper, 'detector-history').text()).not.toContain('DONE_PAGE_TWO');
        expect(get(wrapper, 'detector-history').text()).toContain(
            'No records match this task state within the retention period'
        );
        expect(get(wrapper, 'detector-history-total').text()).toBe('Matching records: 0 · Expired');
        expect(get(wrapper, 'detector-history-prev').attributes('disabled')).toBeDefined();
        await get(wrapper, 'detector-history-reset').trigger('click');
        await flushPromises();
        expect(calls.at(-1).url).toBe('/api/probes/v1/agents/one/history?offset=0&limit=20');
        expect(get(wrapper, 'detector-history').text()).toContain('ALL_STATES');
    });
    it('clears old history immediately and ignores a late response from an earlier task-state filter', async () => {
        const wrapper = create();
        await flushPromises();
        await get(wrapper, 'detector-history-one').trigger('click');
        await flushPromises();
        const pending = deferred();
        historyHandler = () => pending.promise;
        await get(wrapper, 'detector-history-filter').setValue('queued');
        const signal = calls.at(-1).options.signal;
        expect(get(wrapper, 'detector-history').text()).not.toContain('Fixture node');
        expect(wrapper.find('[data-testid="detector-history-total"]').exists()).toBe(false);
        historyHandler = async () =>
            response(history([record('RUNNING_FILTER', { state: 'running', checks: {} })]));
        await get(wrapper, 'detector-history-filter').setValue('running');
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(get(wrapper, 'detector-history').text()).toContain('RUNNING_FILTER');
        pending.resolve(response(history([record('STALE_QUEUED_FILTER')])));
        await flushPromises();
        expect(get(wrapper, 'detector-history').text()).not.toContain('STALE_QUEUED_FILTER');
        expect(get(wrapper, 'detector-history-filter').element.value).toBe('running');
    });
    it('moves keyboard focus to history only when opened and returns focus on close without polling jumps', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const wrapper = create();
        await flushPromises();
        const trigger = get(wrapper, 'detector-history-one');
        trigger.element.focus();
        await trigger.trigger('click');
        await flushPromises();
        expect(document.activeElement).toBe(get(wrapper, 'detector-history-title').element);
        expect(get(wrapper, 'detector-history-title').attributes('tabindex')).toBe('-1');
        const filter = get(wrapper, 'detector-history-filter');
        filter.element.focus();
        await filter.setValue('done');
        await flushPromises();
        expect(document.activeElement).toBe(filter.element);
        await vi.advanceTimersByTimeAsync(30000);
        await flushPromises();
        expect(document.activeElement).toBe(filter.element);
        expect(calls.at(-1).url).toContain('state=done');
        await get(wrapper, 'detector-history')
            .findAll('button')
            .find((button) => button.text() === 'Close history')
            .trigger('click');
        expect(document.activeElement).toBe(trigger.element);
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
