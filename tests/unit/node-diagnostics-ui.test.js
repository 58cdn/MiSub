import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import NodeDiagnosticsPanel from '../../src/components/nodes/NodeDiagnosticsPanel.vue';
import NodeObservationReport from '../../src/components/nodes/NodeObservationReport.vue';
import { setLocale } from '../../src/i18n/index.js';

let wrappers = [],
    calls = [],
    post,
    jobList,
    readResults,
    storageReady,
    observationsVersion;
const response = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const create = () => {
    const wrapper = mount(NodeDiagnosticsPanel, {
        props: { node: { name: 'Fixture node', url: 'ss://test-only@example.invalid:443' } },
    });
    wrappers.push(wrapper);
    return wrapper;
};
const allow = async (wrapper) => {
    await flushPromises();
    await wrapper.get('[data-testid="probe-agent-agent"]').setValue(true);
    await wrapper.get('[data-testid="probe-consent"]').setValue(true);
};
beforeEach(() => {
    setLocale('en-US');
    calls = [];
    storageReady = true;
    observationsVersion = 1;
    post = async () => response({ id: 'job' });
    jobList = [];
    readResults = async () => response({ job: { total: 0 }, nodes: [], nextOffset: null });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/capabilities'))
                return response({ storageReady, observationsVersion });
            if (url.endsWith('/agents'))
                return response([{ id: 'agent', name: 'Fixture detector', lastSeen: Date.now() }]);
            if (options.method === 'POST') return post(url, options);
            if (url.includes('/jobs/')) return readResults(url, options);
            if (url.endsWith('/jobs')) return response(jobList);
            return response([]);
        })
    );
});
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('unified single-node diagnostic panel', () => {
    it('shows independent provider times and leaves old-detector timestamps unknown', async () => {
        const checkedAt = '2026-01-01T00:00:00.000Z';
        jobList = [
            {
                id: 'services',
                created_at: 1000,
                types: ['unlock'],
                done: 1,
                stopped: 0,
                total: 1,
                queued: 0,
                running: 0,
            },
        ];
        readResults = async () =>
            response({
                job: { total: 1 },
                nodes: [
                    {
                        node_name: 'Fixture',
                        completed_at: Date.now(),
                        checks: {
                            unlock: {
                                status: 'unknown',
                                code: 'probe_inconclusive',
                                services: [
                                    {
                                        service: 'openai',
                                        status: 'unknown',
                                        code: 'service_reachable',
                                        httpStatus: 401,
                                        checkedAt,
                                    },
                                    {
                                        service: 'netflix',
                                        status: 'unknown',
                                        code: 'probe_inconclusive',
                                    },
                                ],
                            },
                        },
                    },
                ],
            });
        const wrapper = create();
        await flushPromises();
        await wrapper.get('.probe-job button').trigger('click');
        await flushPromises();
        expect(wrapper.get('time').attributes('datetime')).toBe(checkedAt);
        expect(wrapper.findAll('time')).toHaveLength(1);
        expect(wrapper.text()).toContain('Provider time unavailable');
        expect(wrapper.text()).toContain('Reachable; unlock unknown');
    });
    it('clears old evidence when a new submission succeeds but its history refresh fails', async () => {
        jobList = [
            {
                id: 'old',
                created_at: 1000,
                types: ['observations'],
                done: 1,
                stopped: 0,
                total: 1,
                queued: 0,
                running: 0,
            },
        ];
        readResults = async () =>
            response({ job: { total: 1 }, nodes: [{ node_name: 'PREVIOUS_RUN_EVIDENCE' }] });
        const wrapper = create();
        await flushPromises();
        await wrapper.get('.probe-job button').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('PREVIOUS_RUN_EVIDENCE');
        await allow(wrapper);
        post = async () => {
            jobList = null;
            return response({ id: 'new-run' });
        };
        const originalFetch = fetch.getMockImplementation();
        fetch.mockImplementation(async (url, options) => {
            if (url.endsWith('/jobs') && options.method === 'GET' && jobList === null)
                throw new Error('history_failed');
            return originalFetch(url, options);
        });
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('history_failed');
        expect(wrapper.text()).not.toContain('PREVIOUS_RUN_EVIDENCE');
    });
    it('clears old evidence before selecting another job and aborts the pending result read on node change', async () => {
        jobList = ['old', 'new'].map((id, i) => ({
            id,
            created_at: 1000 + i,
            types: ['observations'],
            done: 1,
            stopped: 0,
            total: 1,
            queued: 0,
            running: 0,
        }));
        let finish;
        readResults = async (url) =>
            url.includes('/old?')
                ? response({
                      job: { total: 1 },
                      nodes: [{ id: 'old-node', node_name: 'OLD_NODE_EVIDENCE', state: 'done' }],
                  })
                : new Promise((resolve) => {
                      finish = resolve;
                  });
        const wrapper = create();
        await flushPromises();
        await wrapper.findAll('.probe-job button')[0].trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('OLD_NODE_EVIDENCE');
        await wrapper.findAll('.probe-job button')[1].trigger('click');
        await flushPromises();
        expect(wrapper.text()).not.toContain('OLD_NODE_EVIDENCE');
        const pending = calls.find((c) => c.url.includes('/new?'));
        await wrapper.setProps({
            node: { name: 'Changed', url: 'ss://changed@example.invalid:443' },
        });
        expect(pending.options.signal.aborted).toBe(true);
        finish(response({ job: { total: 1 }, nodes: [{ node_name: 'LATE_NEW_EVIDENCE' }] }));
        await flushPromises();
        expect(wrapper.text()).not.toContain('LATE_NEW_EVIDENCE');
    });
    it('never keeps the previous page evidence while the next page fails', async () => {
        jobList = [
            {
                id: 'paged',
                created_at: 1000,
                types: ['observations'],
                done: 201,
                stopped: 0,
                total: 201,
                queued: 0,
                running: 0,
            },
        ];
        let reject;
        readResults = async (url) =>
            url.endsWith('offset=0')
                ? response({
                      job: { total: 201 },
                      nodes: [{ id: 'one', node_name: 'PAGE_ONE_EVIDENCE' }],
                      nextOffset: 200,
                  })
                : new Promise((_, fail) => {
                      reject = fail;
                  });
        const wrapper = create();
        await flushPromises();
        await wrapper.get('.probe-job button').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('PAGE_ONE_EVIDENCE');
        await wrapper
            .findAll('button')
            .find((b) => b.text() === 'Next')
            .trigger('click');
        await flushPromises();
        expect(wrapper.text()).not.toContain('PAGE_ONE_EVIDENCE');
        reject(new Error('offline_failure'));
        await flushPromises();
        expect(wrapper.text()).not.toContain('PAGE_ONE_EVIDENCE');
        expect(wrapper.text()).toContain('offline_failure');
    });
    it('requires fresh node and metered consent after discarding a failed submission', async () => {
        post = async () => {
            throw new Error('request_failed');
        };
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="probe-type-speed"]').setValue(true);
        const metered = wrapper
            .findAll('label')
            .find((l) => l.text().includes('Allow metered downloads'))
            .get('input');
        await metered.setValue(true);
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        await flushPromises();
        await wrapper.get('[data-testid="probe-discard"]').trigger('click');
        expect(wrapper.get('[data-testid="probe-consent"]').element.checked).toBe(false);
        expect(metered.element.checked).toBe(false);
        expect(wrapper.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
    });
    it('uses only task API reads before consent; no node credentials reach the DOM or reads', async () => {
        const wrapper = create();
        await flushPromises();
        expect(calls.length).toBeGreaterThan(0);
        expect(
            calls.every((c) => c.url.startsWith('/api/probes/v1/') && c.options.method === 'GET')
        ).toBe(true);
        expect(JSON.stringify(calls)).not.toContain('test-only');
        expect(wrapper.html()).not.toContain('test-only');
        expect(wrapper.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
    });
    it('keeps format checking available without task storage and gates unsupported sources', async () => {
        storageReady = false;
        observationsVersion = undefined;
        const wrapper = create();
        await flushPromises();
        expect(wrapper.text()).toContain('Only format checks');
        expect(
            wrapper.get('[data-testid="probe-type-observations"]').attributes('disabled')
        ).toBeDefined();
        expect(wrapper.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
        expect(calls).toHaveLength(1);
    });
    it('submits one consented snapshot with explicit source choices and clears consent', async () => {
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="probe-type-observations"]').setValue(true);
        expect(wrapper.get('[data-testid="probe-source-ippure"]').element.checked).toBe(false);
        expect(
            wrapper.get('[data-testid="probe-source-ipinfo"]').attributes('disabled')
        ).toBeDefined();
        await wrapper.get('[data-testid="probe-source-ippure"]').setValue(true);
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        await flushPromises();
        const sent = calls.filter((c) => c.options.method === 'POST');
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('/api/probes/v1/jobs');
        const body = JSON.parse(sent[0].options.body);
        expect(body.nodes).toEqual([
            { id: 'preview-node', name: 'Fixture node', url: 'ss://test-only@example.invalid:443' },
        ]);
        expect(body.options.sources).toEqual(['ipify', 'ip_sb', 'ifconfig', 'icanhazip', 'ippure']);
        expect(body.options.observationsVersion).toBe(1);
        expect(body.consent).toBe(true);
        expect(wrapper.get('[data-testid="probe-consent"]').element.checked).toBe(false);
        expect(wrapper.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
    });
    it('blocks empty source selections even with detector consent', async () => {
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="probe-type-observations"]').setValue(true);
        for (const id of ['ipify', 'ip_sb', 'ifconfig', 'icanhazip'])
            await wrapper.get(`[data-testid="probe-source-${id}"]`).setValue(false);
        expect(wrapper.get('[data-testid="probe-submit"]').attributes('disabled')).toBeDefined();
        expect(calls.some((c) => c.options.method === 'POST')).toBe(false);
    });
    it('aborts pending submission and resets consent when node credentials change', async () => {
        let finish;
        post = () =>
            new Promise((resolve) => {
                finish = resolve;
            });
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        const signal = calls.find((c) => c.options.method === 'POST').options.signal;
        await wrapper.setProps({
            node: { name: 'Changed', url: 'ss://changed@example.invalid:443' },
        });
        expect(signal.aborted).toBe(true);
        finish(response({ id: 'OLD_NODE' }));
        await flushPromises();
        expect(wrapper.text()).not.toContain('OLD_NODE');
        expect(wrapper.get('[data-testid="probe-consent"]').element.checked).toBe(false);
        expect(calls.some((c) => c.url.includes('/jobs/OLD_NODE'))).toBe(false);
    });
    it('sanitizes failures and aborts when the modal is removed', async () => {
        post = async () => {
            throw new Error('ss://private-secret@example.invalid');
        };
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('request_failed');
        expect(wrapper.html()).not.toContain('private-secret');
        let finish;
        post = () =>
            new Promise((resolve) => {
                finish = resolve;
            });
        await wrapper.get('[data-testid="probe-submit"]').trigger('click');
        const signal = calls.filter((c) => c.options.method === 'POST').at(-1).options.signal;
        wrapper.unmount();
        expect(signal.aborted).toBe(true);
        finish(response({ id: 'CLOSED' }));
        await flushPromises();
        expect(calls.some((c) => c.url.includes('/jobs/CLOSED'))).toBe(false);
    });
});

describe('independent source evidence', () => {
    it('preserves score zero, false, unknowns, expiry, conflicts and 429 without node latency', async () => {
        const checkedAt = '2026-01-01T00:00:00Z';
        const report = {
            expiresAt: '2026-01-01T00:10:00Z',
            conflicts: [{ family: 4, type: 'ip', values: ['203.0.113.1', '203.0.113.2'] }],
            results: [
                {
                    source: 'ippure',
                    kind: 'quality',
                    status: 'partial',
                    error: null,
                    ip: '203.0.113.2',
                    family: 4,
                    countryCode: 'US',
                    asn: null,
                    riskScore: 0,
                    isResidential: false,
                    isBroadcast: null,
                    checkedAt,
                    durationMs: 75,
                    probeVersion: '1',
                    httpStatus: 200,
                    retryAfterSeconds: null,
                },
                {
                    source: 'ipify',
                    kind: 'exit',
                    status: 'rate_limited',
                    error: 'rate_limited',
                    ip: null,
                    family: null,
                    countryCode: null,
                    asn: null,
                    checkedAt,
                    durationMs: 0,
                    probeVersion: '1',
                    httpStatus: 429,
                    retryAfterSeconds: 0,
                },
            ],
        };
        const wrapper = mount(NodeObservationReport, {
            props: { report, now: Date.parse('2026-01-01T00:11:00Z') },
        });
        wrappers.push(wrapper);
        expect(wrapper.text()).toContain('Sources disagree');
        expect(wrapper.text()).toContain('Residential: No');
        expect(wrapper.text()).toContain('Broadcast: Unknown');
        expect(wrapper.findAll('dd').some((dd) => dd.text() === '0')).toBe(true);
        expect(wrapper.text()).toContain('Results have expired');
        expect(wrapper.text()).toContain('Source duration 75 ms');
        expect(wrapper.text()).toContain('source duration is not node latency');
        expect(wrapper.text()).toContain('HTTP 429');
        expect(wrapper.get('[data-source="ipify"]').text()).toContain('0 seconds');
        expect(wrapper.get('time').attributes('datetime')).toBe(checkedAt);
        await wrapper.setProps({ now: Date.parse('2026-01-01T00:05:00Z') });
        expect(wrapper.text()).not.toContain('Results have expired');
    });
});
