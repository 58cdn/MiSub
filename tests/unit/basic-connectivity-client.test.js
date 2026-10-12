import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { pingNode } from '../../src/utils/ping.js';
import { useManualNodes } from '../../src/composables/useManualNodes.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import Badge from '../../src/components/nodes/NodeConnectivityBadge.vue';
import { createI18n } from '../../src/i18n/index.js';

const value = {
    version: 1,
    status: 'ok',
    code: 'port_reachable',
    latencyMs: 12,
    checkedAt: Date.now(),
    measurement: 'worker_tcp_connect',
    vantage: 'cloudflare_worker',
};
const response = (data = value) => Response.json({ success: true, data });
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('saved-node basic connectivity client', () => {
    it('sends only an ID to the same-origin endpoint and preserves Worker measurement', async () => {
        const fetch = vi.fn().mockResolvedValue(response());
        vi.stubGlobal('fetch', fetch);
        expect(await pingNode('saved')).toMatchObject({
            status: 'ok',
            latency: 12,
            measurement: 'worker_tcp_connect',
            checkedAt: value.checkedAt,
        });
        expect(fetch.mock.calls[0][0]).toBe('/api/nodes/connectivity');
        expect(fetch.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'error',
            body: '{"nodeId":"saved"}',
        });
    });
    it('does not measure rejected requests as successful connections', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret')));
        expect(await pingNode('saved')).toEqual({
            status: 'unknown',
            code: 'request_failed',
            latency: -1,
        });
    });
    it('bounds requests and aborts without leftover timers even when fetch ignores the signal', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetch);
        const pending = pingNode('saved');
        await vi.advanceTimersByTimeAsync(8001);
        expect(await pending).toMatchObject({ status: 'unknown', latency: -1 });
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        {},
        { ...value, measurement: 'browser_http' },
        { ...value, latencyMs: 12.1 },
        { ...value, status: 'unknown' },
        { ...value, code: 'deadline' },
    ])('rejects misleading or malformed responses', async (data) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
        expect(await pingNode('saved')).toMatchObject({
            status: 'unknown',
            code: 'invalid_response',
            latency: -1,
        });
    });
    it.each(['rate_limited', 'node_not_found', 'unauthorized'])(
        'retains actionable API failure %s',
        async (code) => {
            vi.stubGlobal(
                'fetch',
                vi
                    .fn()
                    .mockResolvedValue(
                        Response.json({ success: false, error: { code } }, { status: 429 })
                    )
            );
            expect((await pingNode('saved')).code).toBe(code);
        }
    );
    it('does not request malformed IDs', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect((await pingNode('https://example.com')).code).toBe('unsaved_node');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('requires the saved URL and removes old evidence on edits, including in-flight results', async () => {
        setActivePinia(createPinia());
        const store = useDataStore();
        store.hydrateFromData({
            misubs: [{ id: 'saved', url: 'trojan://fixture@example.com:443', enabled: true }],
        });
        const scope = effectScope();
        const state = scope.run(() => useManualNodes(vi.fn()));
        let finish;
        const fetch = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        vi.stubGlobal('fetch', fetch);
        const pending = state.pingNodeId('saved');
        store.subscriptions[0].url = 'trojan://changed@example.com:444';
        finish(response());
        await pending;
        expect(state.pingResults.value.saved).toBeUndefined();
        await state.pingNodeId('saved');
        expect(state.pingResults.value.saved.code).toBe('unsaved_node');
        expect(fetch).toHaveBeenCalledOnce();
        scope.stop();
    });
    it('renders platform and UDP limitations neutrally with accessible reasons', () => {
        const w = mount(Badge, {
            props: { result: { status: 'unsupported', code: 'platform_restricted', latency: -1 } },
            global: { plugins: [createI18n({ initialLocale: 'en-US' })] },
        });
        expect(w.text()).toBe('Platform restriction');
        expect(w.get('[role="status"]').attributes('aria-label')).toContain('Cloudflare restricts');
        expect(w.classes().join(' ')).not.toMatch(/red-|green-/);
        w.unmount();
    });
});
