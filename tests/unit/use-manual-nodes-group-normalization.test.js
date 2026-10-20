import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useManualNodes } from '../../src/composables/useManualNodes.js';
import { useDataStore } from '../../src/stores/useDataStore.js';

vi.mock('../../src/stores/toast.js', () => ({
    useToastStore: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../src/utils/ping.js', () => ({
    pingNode: vi.fn(),
}));

describe('useManualNodes group normalization', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
    });
    it('HTTP 手动节点排序不会重复纳入订阅源列表', () => {
        const store = useDataStore();
        const node = {
            id: 'http',
            name: 'HTTP',
            url: 'http://fixture:fixture@proxy.example.invalid:8080',
            type: 'manual_node',
            enabled: true,
        };
        const sub = {
            id: 'sub',
            name: 'Airport',
            url: 'https://example.invalid/sub',
            enabled: true,
        };
        store.subscriptions = [sub, node];
        const manual = useManualNodes(vi.fn());
        expect(manual.manualNodes.value.map((item) => item.id)).toEqual(['http']);
        manual.reorderManualNodes([node]);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['http', 'sub']);
    });

    it('保存单个手动节点时规范化分组名', async () => {
        const markDirty = vi.fn();
        const dataStore = useDataStore();
        const { addNode, updateNode } = useManualNodes(markDirty);

        addNode({ id: 'n1', name: 'node1', url: 'ss://example', enabled: true, group: ' S5 ' });
        expect(dataStore.subscriptions[0].group).toBe('S5');

        updateNode({ ...dataStore.subscriptions[0], group: ' FreezeHost ' });
        expect(dataStore.subscriptions[0].group).toBe('FreezeHost');
    });

    it('批量导入和批量移动时规范化分组名', async () => {
        const markDirty = vi.fn();
        const dataStore = useDataStore();
        const { addNodesFromBulk, batchUpdateGroup } = useManualNodes(markDirty);

        addNodesFromBulk(
            [
                { id: 'n1', name: 'node1', url: 'ss://example1', enabled: true, group: ' S5 ' },
                { id: 'n2', name: 'node2', url: 'ss://example2', enabled: true },
            ],
            ' S5 '
        );

        expect(dataStore.subscriptions.map((node) => node.group)).toEqual(['S5', 'S5']);

        batchUpdateGroup(['n1', 'n2'], ' FreezeHost ');
        await nextTick();

        expect(dataStore.subscriptions.map((node) => node.group)).toEqual([
            'FreezeHost',
            'FreezeHost',
        ]);
    });
});
