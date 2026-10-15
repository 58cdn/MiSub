import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionClient } from '../../src/lib/session-client.js';

const registry = vi.hoisted(() => ({
    begin: vi.fn(async () => ({ id: 'synthetic-intent' })),
    abandonUnbound: vi.fn(async () => {}),
}));
vi.mock('../../src/lib/session-registry.js', () => ({ createSessionRegistry: () => registry }));

describe('bounded session protocol discovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });
    afterEach(() => vi.useRealTimers());

    function fixture(get) {
        const transport = { get, post: vi.fn(async () => ({ success: true })) };
        const storage = { getItem: () => 'synthetic-fence', setItem: vi.fn() };
        return { transport, client: createSessionClient({ transport, storage }) };
    }

    it('aborts a stalled protocol request without submitting credentials', async () => {
        const { client, transport } = fixture(
            vi.fn(
                (_path, { signal }) =>
                    new Promise((_, reject) => {
                        signal.addEventListener('abort', () =>
                            reject(new DOMException('aborted', 'AbortError'))
                        );
                    })
            )
        );
        const result = client.login('synthetic-password');
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(8000);
        await rejected;
        expect(transport.get.mock.calls[0][1].signal.aborted).toBe(true);
        expect(transport.post).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores a late protocol response after timeout and allows a new login attempt', async () => {
        let release;
        const { client, transport } = fixture(
            vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((done) => {
                            release = done;
                        })
                )
                .mockResolvedValue({ protocol: 'legacy' })
        );
        const first = client.login('old-synthetic-password');
        const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(8000);
        await rejected;
        await expect(client.login('new-synthetic-password')).resolves.toEqual({ success: true });
        release({ protocol: 'legacy' });
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.post).toHaveBeenCalledTimes(1);
        expect(transport.post.mock.calls[0].slice(0, 2)).toEqual([
            '/api/login',
            { password: 'new-synthetic-password' },
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the deadline on protocol rejection and rejects invalid modes', async () => {
        const failure = new TypeError('Failed to fetch');
        const { client } = fixture(
            vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ protocol: 'unknown' })
        );
        await expect(client.protocol()).rejects.toBe(failure);
        await expect(client.protocol()).rejects.toThrow('session_protocol_unavailable');
        expect(vi.getTimerCount()).toBe(0);
    });
});
