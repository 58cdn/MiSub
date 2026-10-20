import { describe, it, expect } from 'vitest';
import { isManualNodeEntry } from '../../src/composables/manual-nodes/filters.js';
import {
    isManualNode,
    isRemoteSubscription,
} from '../../functions/modules/external-api-mappers.js';
import { applyMihomoChainProxy } from '../../functions/modules/subscription/mihomo-chain-proxy.js';
import { buildAutoSortedSubscriptions } from '../../src/composables/manual-nodes/sorting.js';

describe('upstream integration acceptance', () => {
    it.each([
        ['http://fixture:fixture@proxy.example.invalid:8080#HTTP', true, false],
        ['HTTP://fixture:fixture@proxy.example.invalid:80', true, false],
        [' https://fixture:p%40ss@[2001:db8::1]:443/#HTTPS ', true, false],
        ['https://fixture:fixture@sub.example.invalid:8443/api?token=fixture', false, true],
        ['https://fixture:fixture@sub.example.invalid:8443/?token=fixture', false, true],
        ['https://sub.example.invalid:8443/subscription', false, true],
        ['http://proxy.example.invalid:8080', false, true],
        ['ss://fixture@proxy.example.invalid:443', true, false],
        [null, false, false],
        ['', false, false],
        [42, false, false],
    ])('classifies %s consistently across UI and API', (url, manual, remote) => {
        expect(isManualNodeEntry({ url })).toBe(manual);
        expect(isManualNode({ url })).toBe(manual);
        expect(isRemoteSubscription({ url })).toBe(remote);
    });
    it('keeps HTTP nodes exactly once when manual nodes are automatically reordered', () => {
        const node = {
            id: 'http',
            name: 'HK',
            url: 'http://fixture:fixture@proxy.example.invalid:8080',
        };
        const sub = { id: 'sub', name: 'Airport', url: 'https://example.invalid/sub' };
        expect(buildAutoSortedSubscriptions([sub, node], [node]).map((item) => item.id)).toEqual([
            'http',
            'sub',
        ]);
    });
    it('uses the same HTTP node classification in the UI and probe inventory', () => {
        const node = { id: 'fixture', url: 'http://fixture:fixture@proxy.example.invalid:8080' };
        expect(isManualNodeEntry(node)).toBe(true);
        expect(isManualNode(node)).toBe(isManualNodeEntry(node));
    });
    it('keeps entry members confined to original nodes even through indirect groups', () => {
        const model = {
            proxies: [{ name: 'HK', type: 'trojan', server: 'example.invalid', port: 443 }],
            groups: [
                { name: 'landing', type: 'select', members: ['entry'] },
                { name: 'entry', type: 'select', members: ['middle'] },
                { name: 'middle', type: 'select', members: ['landing'] },
            ],
            extras: { chainProxy: [{ group: 'landing', entry: 'entry' }] },
        };
        applyMihomoChainProxy(model);
        const entry = model.groups.find((group) => group.name === 'entry');
        expect(entry.members).toEqual(['HK']);
    });
    it('does not create a landing node with an existing group name', () => {
        const model = {
            proxies: [{ name: 'HK', type: 'trojan', server: 'example.invalid', port: 443 }],
            groups: [{ name: 'landing - HK', type: 'select', members: ['HK'] }],
            extras: { chainProxy: [{ group: 'landing', entry: 'entry' }] },
        };
        applyMihomoChainProxy(model);
        const names = [...model.proxies, ...model.groups].map((item) => item.name);
        expect(new Set(names).size).toBe(names.length);
    });
    it('reserves group names from later chain declarations before naming any copies', () => {
        const model = {
            proxies: [
                { name: 'HK', type: 'trojan' },
                { name: 'JP', type: 'trojan' },
            ],
            groups: [{ name: 'entry', type: 'select', members: ['JP', 'middle'] }],
            extras: {
                chainProxy: [
                    { group: 'landing', entry: 'entry' },
                    { group: 'landing - HK', entry: 'landing - JP' },
                ],
            },
        };
        applyMihomoChainProxy(model);
        const names = [...model.proxies, ...model.groups].map((item) => item.name);
        expect(new Set(names).size).toBe(names.length);
        expect(model.groups.find((group) => group.name === 'entry').members).toEqual(['JP']);
        expect(model.groups.find((group) => group.name === 'landing - JP').members).toEqual([
            'HK',
            'JP',
        ]);
    });
    it('does not create chain groups with a name already used by a source node', () => {
        const model = {
            proxies: [{ name: 'HK', type: 'trojan' }],
            groups: [],
            extras: {
                chainProxy: [
                    { group: 'HK', entry: 'entry' },
                    { group: 'landing', entry: 'HK' },
                ],
            },
        };
        applyMihomoChainProxy(model);
        expect(model.proxies).toHaveLength(1);
        expect(model.groups).toEqual([]);
    });
});
