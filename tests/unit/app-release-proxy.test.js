import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../functions/storage-adapter.js', () => ({
    StorageFactory: { createAdapter: () => storage },
    STORAGE_TYPES: { KV: 'kv' },
}));
import { handleGithubReleaseRequest } from '../../functions/modules/handlers/github-proxy-handler.js';
const request = (query = '') =>
    new Request(`https://app.invalid/api/github/release?repo=58cdn/MiSub${query}`);
const release = (tag_name, extras = {}) => ({
    tag_name,
    draft: false,
    prerelease: true,
    ...extras,
});
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
describe('发行代理隔离与完整库存', () => {
    it('分页读取并选主应用最大 alpha，缓存按组件隔离', async () => {
        fetch
            .mockResolvedValueOnce(
                Response.json(Array.from({ length: 100 }, () => release('probe-v0.0.1-alpha.99')))
            )
            .mockResolvedValueOnce(
                Response.json([
                    release('v0.0.1-alpha.9'),
                    release('v0.0.1-alpha.10'),
                    release('v9.9.9'),
                    release('v0.0.1-alpha.11', { prerelease: false }),
                ])
            );
        const response = await handleGithubReleaseRequest(request(), {});
        expect((await response.json()).tag_name).toBe('v0.0.1-alpha.10');
        expect(fetch.mock.calls[1][0]).toContain('page=2');
        expect(storage.put.mock.calls[0][0]).toBe('github_release_v2_58cdn/MiSub_app_alpha');
    });
    it('Probe 查询不包含主应用标签', async () => {
        fetch.mockResolvedValue(
            Response.json([release('probe-v0.0.1-alpha.2'), release('v0.0.1-alpha.99')])
        );
        const data = await (
            await handleGithubReleaseRequest(request('&component=probe'), {})
        ).json();
        expect(data.tag_name).toBe('probe-v0.0.1-alpha.2');
        expect(data.prerelease).toBe(true);
        expect(storage.put.mock.calls[0][0]).toContain('_probe_alpha');
    });
    it('稳定通道无推荐且不读取 GitHub', async () => {
        const data = await (
            await handleGithubReleaseRequest(request('&channel=stable'), {})
        ).json();
        expect(data).toMatchObject({ tag_name: null, reason: 'stable_channel_unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('限流时不把缓存旧发行当作最新', async () => {
        storage.get.mockResolvedValue({ timestamp: 1, data: release('v0.0.1-alpha.2') });
        fetch.mockResolvedValue(new Response('', { status: 429 }));
        const data = await (await handleGithubReleaseRequest(request(), {})).json();
        expect(data).toMatchObject({ tag_name: null, rate_limited: true });
    });
    it('拒绝上游仓库及未完成的库存', async () => {
        expect(
            (
                await handleGithubReleaseRequest(
                    new Request('https://app.invalid/api/github/release?repo=imzyb/MiSub'),
                    {}
                )
            ).status
        ).toBe(400);
        fetch.mockImplementation(async () =>
            Response.json(Array.from({ length: 100 }, () => release('v0.0.1-alpha.1')))
        );
        expect((await handleGithubReleaseRequest(request(), {})).status).toBe(502);
        expect(storage.put).not.toHaveBeenCalled();
    });
});
