import { describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';

describe('node diagnostics authentication', () => {
    it('keeps capabilities and execution behind the existing admin session', async () => {
        const fetch = vi.fn();
        for (const [path, method] of [
            ['/nodes/diagnostics/capabilities', 'GET'],
            ['/nodes/diagnostics', 'POST'],
        ]) {
            const result = await handleApiRequest(
                new Request(`https://misub.example/api${path}`, {
                    method,
                    headers: { Origin: 'https://misub.example' },
                }),
                { NODE_DIAGNOSTICS: { fetch } }
            );
            expect(result.status).toBe(401);
        }
        expect(fetch).not.toHaveBeenCalled();
    });
});
