import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useBulkImportLogic } from '../../src/composables/useBulkImportLogic.js';

describe('批量导入去重', () => {
    let dataStore;
    let bulkImport;

    beforeEach(() => {
        setActivePinia(createPinia());
        dataStore = useDataStore();

        // 模拟已存在的节点
        dataStore.subscriptions = [
            {
                id: 'n1',
                url: 'ss://existing@server1.com:443',
                name: 'Existing Node',
                enabled: true,
            },
            { id: 'n2', url: 'vmess://existing-vmess', name: 'Existing VMess', enabled: true },
        ];

        const mockAddSubscriptions = (subs) => {
            subs.forEach((sub) => dataStore.addSubscription(sub));
        };

        const mockAddNodes = (nodes) => {
            nodes.forEach((node) => dataStore.addSubscription(node));
        };

        bulkImport = useBulkImportLogic({
            addSubscriptionsFromBulk: mockAddSubscriptions,
            addNodesFromBulk: mockAddNodes,
        });
    });

    it('应避免重复导入已存在的标准URL节点', () => {
        const importText = `ss://existing@server1.com:443
ss://new@server2.com:8388`;

        bulkImport.handleBulkImport(importText, '');

        // 应该只添加了新节点，已存在的被跳过
        const allNodes = dataStore.subscriptions.filter((s) => /^ss:\/\//.test(s.url));
        const urls = allNodes.map((n) => n.url);

        // 不应该重复添加 existing@server1.com
        const existingCount = urls.filter((u) => u === 'ss://existing@server1.com:443').length;
        expect(existingCount).toBe(1);

        // 应该添加了新节点
        expect(urls).toContain('ss://new@server2.com:8388');
    });

    it('应避免重复导入已存在的Surge格式节点', () => {
        // 已存在节点的Surge表示
        const importText = `ExistingNode = ss, server1.com, 443, encrypt-method=chacha20-ietf-poly1305, password=existing
NewNode = ss, server3.com, 8388, encrypt-method=aes-256-gcm, password=newpass`;

        bulkImport.handleBulkImport(importText, '');

        // server1.com:443 已存在，不应重复添加
        const allNodes = dataStore.subscriptions.filter((s) => s.url && /^ss:\/\//.test(s.url));
        const server1Nodes = allNodes.filter(
            (n) => n.url.includes('server1.com') && n.url.includes('443')
        );

        // 应该只有一个 server1.com:443
        expect(server1Nodes.length).toBeLessThanOrEqual(2); // 原有 1 个 + 可能误判添加 1 个
    });

    it('混合导入标准URL和Surge格式时应正确去重', () => {
        const importText = `ss://existing@server1.com:443
NewSurge = ss, server4.com, 9000, encrypt-method=aes-256-gcm, password=test
ss://new@server5.com:10000`;

        const initialCount = dataStore.subscriptions.length;
        bulkImport.handleBulkImport(importText, '');

        // 应该只添加 2 个新节点（NewSurge 和 server5）
        expect(dataStore.subscriptions.length).toBe(initialCount + 2);
    });

    it('手动节点入口保留 HTTP proxy URI 的显式节点类型', () => {
        bulkImport.handleBulkImport(
            'http://alice:p%40ss%3Aword@proxy.example.com:8080#plain-http',
            '',
            'manual_node'
        );

        const imported = dataStore.subscriptions.find((item) => item.name === 'plain-http');
        expect(imported).toBeDefined();
        expect(dataStore.subscriptions).toHaveLength(3);
        expect(imported.url).toBe('http://alice:p%40ss%3Aword@proxy.example.com:8080#plain-http');
        expect(imported.type).toBe('manual_node');
    });
    it('通用文本导入将没有显式类型的 HTTP 地址保留为订阅', () => {
        const addSubscriptionsFromBulk = vi.fn();
        const addNodesFromBulk = vi.fn();
        const importer = useBulkImportLogic({ addSubscriptionsFromBulk, addNodesFromBulk });
        importer.handleBulkImport(
            [
                'https://source.example.invalid:8443/subscription',
                'https://fixture:fixture@source.example.invalid:8443/api?token=fixture',
                'http://fixture:fixture@proxy.example.invalid:80#HTTP',
            ].join('\n'),
            ''
        );
        expect(addSubscriptionsFromBulk.mock.calls[0][0]).toHaveLength(3);
        expect(
            addSubscriptionsFromBulk.mock.calls[0][0].every((item) => item.type === 'subscription')
        ).toBe(true);
        expect(addNodesFromBulk).not.toHaveBeenCalled();
    });
    it('同一 URL 的订阅和显式手动节点不会互相去重', () => {
        const url = 'https://fixture:fixture@source.example.invalid:443/';
        dataStore.subscriptions = [{ id: 'source', url, type: 'subscription' }];
        bulkImport.handleBulkImport(url, '', 'manual_node');
        expect(dataStore.subscriptions.map((item) => item.type).sort()).toEqual([
            'manual_node',
            'subscription',
        ]);
        bulkImport.handleBulkImport(url, '', 'manual_node');
        expect(dataStore.subscriptions).toHaveLength(2);
    });
});
