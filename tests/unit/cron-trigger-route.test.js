// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { createSignedToken } from '../../functions/modules/auth-middleware.js';
import { COOKIE_NAME } from '../../functions/modules/config.js';
import { performSubscriptionSync } from '../../functions/_schedule.js';

vi.mock('../../functions/_schedule.js', () => ({ performSubscriptionSync: vi.fn() }));
vi.mock('../../functions/modules/scheduled-task-runner.js', () => ({
    maybeRunScheduledTasks: vi.fn().mockResolvedValue({ skipped: true }),
}));
const env = {
    COOKIE_SECRET: 'synthetic-route-fixture-cookie-key',
    CRON_MAX_SYNC_COUNT: '7',
    CRON_SYNC_TIMEOUT: '8000',
    CRON_ENABLE_PARALLEL: 'false',
};
beforeEach(() => {
    vi.clearAllMocks();
    performSubscriptionSync.mockResolvedValue({
        totalSubscriptions: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('network forbidden');
        })
    );
});
afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
async function request(method, authenticated) {
    const token = authenticated
        ? await createSignedToken(env.COOKIE_SECRET, String(Date.now()))
        : null;
    return new Request('https://fixture.invalid/api/cron/trigger', {
        method,
        headers: token ? { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` } : {},
    });
}
describe('manual Cron router authentication and limits', () => {
    it('rejects unauthenticated POST before calling the runner', async () => {
        expect((await handleApiRequest(await request('POST', false), env)).status).toBe(401);
        expect(performSubscriptionSync).not.toHaveBeenCalled();
    });
    it('rejects authenticated GET before calling the runner', async () => {
        expect((await handleApiRequest(await request('GET', true), env)).status).toBe(405);
        expect(performSubscriptionSync).not.toHaveBeenCalled();
    });
    it.each([
        ['false', 1],
        ['true', 5],
    ])(
        'passes configured limits on a real signed POST with parallel=%s',
        async (parallel, concurrency) => {
            const config = { ...env, CRON_ENABLE_PARALLEL: parallel };
            expect((await handleApiRequest(await request('POST', true), config)).status).toBe(200);
            expect(performSubscriptionSync).toHaveBeenCalledWith(config, {
                maxSyncCount: 7,
                timeout: 8000,
                concurrency,
            });
        }
    );
});
