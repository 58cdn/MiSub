import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ settings: {}, fail: false }));
vi.mock('../../functions/storage-adapter.js', () => ({
    STORAGE_TYPES: { KV: 'kv', D1: 'd1' },
    SettingsCache: { get: async () => state.settings, clear: vi.fn() },
    StorageFactory: {
        getStorageType: async () => 'kv',
        createAdapter: () => ({
            get: async () => structuredClone(state.settings),
            put: async (_, value) => {
                if (state.fail) throw new Error('fixture unavailable');
                state.settings = structuredClone(value);
            },
        }),
    },
}));
import { handleSettingsGet, handleSettingsSave } from '../../functions/modules/api-handler.js';

const save = (body) =>
    handleSettingsSave(
        new Request('https://fixture.invalid/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MiSub-Save-Scope': 'preferences' },
            body: JSON.stringify(body),
        }),
        {}
    );

describe('global pagination setting persistence', () => {
    beforeEach(() => {
        state.settings = { FileName: 'Existing site', storageType: 'kv' };
        state.fail = false;
    });

    it('reads legacy settings with a default and persists a new choice without losing unrelated settings', async () => {
        expect((await (await handleSettingsGet({})).json()).groupsPageSize).toBe(20);
        expect((await save({ groupsPageSize: 50 })).status).toBe(200);
        expect((await (await handleSettingsGet({})).json()).groupsPageSize).toBe(50);
        expect(state.settings.FileName).toBe('Existing site');
        await save({ FileName: 'Renamed' });
        expect(state.settings.groupsPageSize).toBe(50);
    });

    it('normalizes malformed or unbounded values before storage', async () => {
        for (const value of [-1, 9999, null, 'bad']) {
            await save({ groupsPageSize: value });
            expect(state.settings.groupsPageSize).toBe(20);
        }
        await save({ groupsPageSize: '100' });
        expect(state.settings.groupsPageSize).toBe(100);
    });

    it('does not claim persistence when storage fails', async () => {
        state.fail = true;
        expect((await save({ groupsPageSize: 50 })).status).toBe(500);
        expect(state.settings.groupsPageSize).toBeUndefined();
    });
});
