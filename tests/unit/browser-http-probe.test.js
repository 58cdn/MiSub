import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingNode } from '../../src/utils/ping.js';
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('browser HTTP observations', () => {
    it('never calls a fetch rejection successful or assigns it a latency', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        expect(await pingNode('example.invalid', 443)).toMatchObject({
            status: 'error',
            latency: -1,
            measurement: 'browser_http',
        });
    });
    it('labels an HTTP response as browser timing and does not follow redirects', async () => {
        const fetch = vi.fn().mockResolvedValue({ type: 'opaque' });
        vi.stubGlobal('fetch', fetch);
        expect(await pingNode('example.invalid', 443)).toMatchObject({
            status: 'ok',
            measurement: 'browser_http',
        });
        expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    });
    it('cancels timed out observations with no leftover timers', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetch);
        const result = pingNode('example.invalid', 443, 200);
        await vi.advanceTimersByTimeAsync(201);
        expect(await result).toMatchObject({ status: 'timeout', latency: -1 });
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('rejects malformed addresses without making a request', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect((await pingNode('example.invalid/private', 443)).status).toBe('error');
        expect((await pingNode('example.invalid', -1)).status).toBe('error');
        expect(fetch).not.toHaveBeenCalled();
    });
});
