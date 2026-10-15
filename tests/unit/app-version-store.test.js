import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
vi.mock('../../src/lib/api.js', () => ({ fetchGithubLatestRelease: vi.fn() }));
import { fetchGithubLatestRelease } from '../../src/lib/api.js';
import { useVersionStore } from '../../src/stores/version.js';
beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
});
const release = (tag_name) => ({ tag_name, draft: false, prerelease: true });
describe('主应用测试通道状态', () => {
    it('使用本仓库和数字 alpha 排序', async () => {
        const store = useVersionStore();
        store.currentVersion = '0.0.1-alpha.9';
        fetchGithubLatestRelease.mockResolvedValue(release('v0.0.1-alpha.10'));
        await store.checkVersion();
        expect(fetchGithubLatestRelease).toHaveBeenCalledWith('58cdn/MiSub');
        expect(store.hasUpdate).toBe(true);
        expect(store.isUpToDate).toBe(false);
    });
    it.each([
        { tag_name: null },
        release('probe-v0.0.1-alpha.99'),
        { ...release('v0.0.1-alpha.99'), prerelease: false },
        { ...release('v0.0.1-alpha.99'), draft: true },
    ])('无合格候选时不宣称最新', async (candidate) => {
        const store = useVersionStore();
        expect(store.isUpToDate).toBe(false);
        fetchGithubLatestRelease.mockResolvedValue(candidate);
        await store.checkVersion();
        expect(store.hasUpdate).toBe(false);
        expect(store.isUpToDate).toBe(false);
        expect(store.showUpdateNotice).toBe(false);
    });
    it('旧线显示迁移，不把数字较大视为最新', async () => {
        const store = useVersionStore();
        store.currentVersion = '2.7.0';
        fetchGithubLatestRelease.mockResolvedValue(release('v0.0.1-alpha.1'));
        await store.checkVersion();
        expect(store.migrationRequired).toBe(true);
        expect(store.isUpToDate).toBe(false);
        expect(store.showUpdateNotice).toBe(true);
    });
    it('失败或限流清除先前候选和提示', async () => {
        const store = useVersionStore();
        fetchGithubLatestRelease.mockResolvedValue(release('v0.0.1-alpha.99'));
        await store.checkVersion();
        fetchGithubLatestRelease.mockResolvedValue({ rate_limited: true });
        await store.checkVersion();
        expect(store.checkState).toBe('unavailable');
        expect(store.latestRelease).toBeNull();
        expect(store.showUpdateNotice).toBe(false);
        fetchGithubLatestRelease.mockRejectedValue(new Error('offline'));
        await store.checkVersion();
        expect(store.isUpToDate).toBe(false);
    });
});
