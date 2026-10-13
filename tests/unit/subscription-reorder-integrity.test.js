import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useSubscriptions } from '../../src/composables/useSubscriptions.js';

const source = (id, extra = {}) => ({
    id,
    name: id,
    url: `https://${id}.example.invalid/sub`,
    enabled: true,
    ...extra,
});

describe('subscription reordering preserves the complete collection', () => {
    let store;
    let markDirty;
    let reorderSubscriptions;

    beforeEach(() => {
        setActivePinia(createPinia());
        store = useDataStore();
        markDirty = vi.fn();
        ({ reorderSubscriptions } = useSubscriptions(markDirty));
        store.subscriptions = [source('a'), source('b'), source('c'), source('d')];
        store.profiles = [{ id: 'profile', subscriptions: ['a', 'b', 'c', 'd'] }];
    });

    it('reorders three visible sources without losing the fourth hidden source', () => {
        const [a, b, c, d] = store.subscriptions;
        reorderSubscriptions([c, a, b]);

        expect(store.subscriptions.map((item) => item.id)).toEqual(['c', 'a', 'b', 'd']);
        expect(store.subscriptions.find((item) => item.id === 'd')).toEqual(d);
        expect(store.profiles[0].subscriptions).toEqual(['a', 'b', 'c', 'd']);
        expect(markDirty).toHaveBeenCalledOnce();
    });

    it('keeps hidden sources and manual nodes in their existing positions', () => {
        const manual = { id: 'manual', name: 'Manual', url: 'ss://synthetic.invalid' };
        store.subscriptions.splice(1, 0, manual);
        reorderSubscriptions([store.subscriptions[4], store.subscriptions[0]]);

        expect(store.subscriptions.map((item) => item.id)).toEqual(['d', 'manual', 'b', 'c', 'a']);
        expect(store.subscriptions[1]).toEqual(manual);
    });

    it('uses the latest stored records when a drag payload contains older objects', () => {
        const staleA = { ...store.subscriptions[0], name: 'Old A' };
        const staleB = { ...store.subscriptions[1], enabled: false };
        reorderSubscriptions([staleB, staleA]);

        expect(store.subscriptions[0].enabled).toBe(true);
        expect(store.subscriptions[1].name).toBe('a');
        expect(store.subscriptions).toHaveLength(4);
    });

    it.each([
        ['empty list', []],
        ['duplicate IDs', [source('b'), source('b')]],
        ['unknown ID', [source('b'), source('missing')]],
        ['missing ID', [source('b'), {}]],
        ['null entry', [source('b'), null]],
        ['non-array', null],
    ])('leaves the collection unchanged for %s', (_label, order) => {
        const before = JSON.parse(JSON.stringify(store.subscriptions));
        reorderSubscriptions(order);
        expect(store.subscriptions).toEqual(before);
        expect(markDirty).not.toHaveBeenCalled();
    });

    it('does not mark unchanged ordering dirty', () => {
        reorderSubscriptions([...store.subscriptions]);
        expect(markDirty).not.toHaveBeenCalled();
    });

    it('leaves ambiguous duplicate source IDs unchanged', () => {
        store.subscriptions.push({ ...store.subscriptions[0] });
        const before = JSON.parse(JSON.stringify(store.subscriptions));
        reorderSubscriptions([store.subscriptions[1], store.subscriptions[0]]);
        expect(store.subscriptions).toEqual(before);
        expect(markDirty).not.toHaveBeenCalled();
    });

    it('still supports reordering the complete collection', () => {
        reorderSubscriptions([...store.subscriptions].reverse());
        expect(store.subscriptions.map((item) => item.id)).toEqual(['d', 'c', 'b', 'a']);
        expect(markDirty).toHaveBeenCalledOnce();
    });
});
