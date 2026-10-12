import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import NodeDiagnosticsPanel from '../../src/components/nodes/NodeDiagnosticsPanel.vue';
import { api } from '../../src/lib/http.js';
import { setLocale } from '../../src/i18n/index.js';

vi.mock('../../src/lib/http.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const sources = [
    { id: 'ipify', kind: 'exit', label: 'ipify.org', implemented: true },
    { id: 'ippure', kind: 'quality', label: 'IPPure', implemented: true },
    { id: 'netflix', kind: 'unlock', label: 'Netflix', implemented: false },
];
let wrappers = [];
const create = () => {
    const wrapper = mount(NodeDiagnosticsPanel, {
        props: { node: { name: 'Fixture node', url: 'ss://test-only@example.invalid:443' } },
    });
    wrappers.push(wrapper);
    return wrapper;
};
const allow = async (wrapper) => {
    await flushPromises();
    await wrapper.get('[data-testid="consent"]').setValue(true);
};
beforeEach(() => {
    vi.clearAllMocks();
    setLocale('en-US');
    api.get.mockResolvedValue({ executorConfigured: true, sources });
});
afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
    vi.useRealTimers();
});

describe('node diagnostic consent and result UI', () => {
    it('loads capabilities only; credentials are never included in that request or DOM', async () => {
        const wrapper = create();
        await flushPromises();
        expect(api.get).toHaveBeenCalledWith(
            '/api/nodes/diagnostics/capabilities',
            expect.any(Object)
        );
        expect(api.post).not.toHaveBeenCalled();
        expect(wrapper.html()).not.toContain('test-only');
        expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined();
    });
    it('does not offer execution when no executor is configured', async () => {
        api.get.mockResolvedValue({ executorConfigured: false, sources });
        const wrapper = create();
        await flushPromises();
        expect(wrapper.text()).toContain('No trusted executor');
        expect(wrapper.find('[data-testid="consent"]').exists()).toBe(false);
        await wrapper.get('[data-testid="run"]').trigger('click');
        expect(api.post).not.toHaveBeenCalled();
    });
    it('sends only one explicitly consented node and selected supported sources', async () => {
        api.post.mockResolvedValue({ results: [], conflicts: [] });
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="run"]').trigger('click');
        await flushPromises();
        expect(api.post).toHaveBeenCalledWith(
            '/api/nodes/diagnostics',
            {
                node: 'ss://test-only@example.invalid:443',
                sources: ['ipify', 'ippure'],
                consent: true,
            },
            expect.any(Object)
        );
        expect(wrapper.get('[data-testid="consent"]').element.checked).toBe(false);
        expect(wrapper.get('[data-testid="run"]').attributes('disabled')).toBeDefined();
    });
    it('discards late results after cancel and never prints raw errors', async () => {
        let finish;
        api.post.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="run"]').trigger('click');
        const signal = api.post.mock.calls[0][2].signal;
        await wrapper.get('[data-testid="cancel"]').trigger('click');
        finish({ results: [{ source: 'SHOULD_NOT_APPEAR' }] });
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(wrapper.text()).not.toContain('SHOULD_NOT_APPEAR');
        expect(wrapper.text()).toContain('Cancelled');
    });
    it('clears results, consent and pending work when node credentials change', async () => {
        let finish;
        api.post.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="run"]').trigger('click');
        const signal = api.post.mock.calls[0][2].signal;
        await wrapper.setProps({
            node: { name: 'Another node', url: 'ss://changed@example.invalid:443' },
        });
        finish({ results: [{ source: 'OLD_NODE' }] });
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(wrapper.text()).not.toContain('OLD_NODE');
        expect(wrapper.get('[data-testid="consent"]').element.checked).toBe(false);
    });
    it('preserves score zero, false flags, nulls, timestamps and independent conflicts', async () => {
        const checkedAt = new Date().toISOString();
        api.post.mockResolvedValue({
            checkedAt,
            expiresAt: '2000-01-01T00:00:00Z',
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
                },
            ],
        });
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="run"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('Sources disagree');
        expect(wrapper.text()).toContain('Residential: No');
        expect(wrapper.text()).toContain('Broadcast: Unknown');
        expect(wrapper.findAll('dd').some((dd) => dd.text() === '0')).toBe(true);
        expect(wrapper.text()).toContain('Results have expired');
        expect(wrapper.text()).toContain('Source duration 75 ms');
    });
    it('sanitizes failure UI and aborts on unmount', async () => {
        api.post.mockRejectedValue(new Error('ss://private-secret@example.invalid'));
        const wrapper = create();
        await allow(wrapper);
        await wrapper.get('[data-testid="run"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('Diagnostics failed');
        expect(wrapper.html()).not.toContain('private-secret');
        wrapper.unmount();
        expect(api.post.mock.calls[0][2].signal.aborted).toBe(true);
    });
});
