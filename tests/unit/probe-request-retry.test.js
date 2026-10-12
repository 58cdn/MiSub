import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRequest } from '../../src/utils/probe-client.js';

afterEach(() => vi.unstubAllGlobals());

function response(error) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ success: false, error }), { status: 429 }))
    );
}

describe('probe request retry hints', () => {
    it.each([0, 5, 3600, 86400])(
        'preserves a bounded integer retry hint (%s)',
        async (retryAfterSeconds) => {
            response({ code: 'pairing_rate_limited', retryAfterSeconds });
            await expect(
                probeRequest('pairings/windows', { method: 'POST', body: {} })
            ).rejects.toMatchObject({ message: 'pairing_rate_limited', retryAfterSeconds });
        }
    );

    it.each([-1, 0.5, 86401, '3600', null, {}, true])(
        'rejects malformed retry hints (%s)',
        async (retryAfterSeconds) => {
            response({
                code: 'pairing_rate_limited',
                retryAfterSeconds,
                token: 'private-fixture-value',
            });
            const error = await probeRequest('pairings/windows').catch((value) => value);
            expect(error.message).toBe('pairing_rate_limited');
            expect(error).not.toHaveProperty('retryAfterSeconds');
            expect(error).not.toHaveProperty('token');
        }
    );

    it('keeps arbitrary server text out of the error while retaining safe timing', async () => {
        response({ code: 'private-fixture-value details', retryAfterSeconds: 12 });
        const error = await probeRequest('pairings/windows').catch((value) => value);
        expect(error.message).toBe('request_failed');
        expect(error.retryAfterSeconds).toBe(12);
        expect(String(error)).not.toContain('private-fixture-value');
    });
});
