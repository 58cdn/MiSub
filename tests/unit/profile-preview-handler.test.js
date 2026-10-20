import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAdapter = vi.fn();
const getStorageType = vi.fn();
const fetchSubscriptionNodes = vi.fn();

vi.mock('../../functions/storage-adapter.js', () => ({
    StorageFactory: {
        createAdapter: (...args) => createAdapter(...args),
        getStorageType: (...args) => getStorageType(...args),
    },
}));

vi.mock('../../functions/modules/subscription/node-fetcher.js', () => ({
    fetchSubscriptionNodes: (...args) => fetchSubscriptionNodes(...args),
}));

describe('handleProfileMode preview transforms', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getStorageType.mockResolvedValue('d1');
    });

    it('applies profile operator-chain renaming in preview results', async () => {
        createAdapter.mockReturnValue({
            getProfileById: vi.fn().mockResolvedValue({
                id: 'profile-1',
                enabled: true,
                subscriptions: ['sub-1'],
                manualNodes: [],
                operators: [
                    {
                        id: 'rename-1',
                        type: 'rename',
                        enabled: true,
                        params: {
                            regex: {
                                enabled: true,
                                rules: [{ pattern: 'Raw', replacement: 'Renamed' }],
                            },
                        },
                    },
                ],
            }),
            getSubscriptionsByIds: vi.fn().mockResolvedValue([
                {
                    id: 'sub-1',
                    enabled: true,
                    url: 'https://example.com/sub',
                    name: 'Test Sub',
                },
            ]),
            get: vi.fn().mockResolvedValue({ defaultOperators: [] }),
        });

        fetchSubscriptionNodes.mockResolvedValue({
            success: true,
            nodes: [
                {
                    name: 'Raw Node',
                    url: 'trojan://password@example.com:443#Raw%20Node',
                    protocol: 'trojan',
                    region: '其他',
                    subscriptionName: 'Test Sub',
                },
            ],
        });

        const { handleProfileMode } =
            await import('../../functions/modules/subscription/profile-handler.js');
        const result = await handleProfileMode(
            new Request('https://example.com/api/subscription_nodes'),
            {},
            'profile-1',
            'MiSub-Test/1.0',
            true,
            false
        );

        expect(result.success).toBe(true);
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0].name).toBe('Renamed Node');
        expect(result.nodes[0].url).toContain('#Renamed%20Node');
    });

    it('keeps an HTTP proxy subscription node separate from an HTTPS source URL', async () => {
        const targetSubscriptions = [
            {
                id: 'subscription-http',
                enabled: true,
                url: 'https://sub.example.com/link',
                name: 'HTTPS source',
            },
            {
                id: 'node-http',
                enabled: true,
                url: 'http://alice:***@192.0.2.10:8080/#office-http',
                name: 'Office HTTP',
            },
        ];
        createAdapter.mockReturnValue({
            getProfileById: vi.fn().mockResolvedValue({
                id: 'profile-http',
                enabled: true,
                subscriptions: ['subscription-http', 'node-http'],
                manualNodes: [],
                operators: [],
            }),
            getSubscriptionsByIds: vi.fn().mockResolvedValue(targetSubscriptions),
            get: vi.fn().mockResolvedValue({ defaultOperators: [] }),
        });

        const { handleProfileMode } =
            await import('../../functions/modules/subscription/profile-handler.js');
        const result = await handleProfileMode(
            new Request('https://example.com/api/subscription_nodes'),
            {},
            'profile-http',
            'MiSub-Test/1.0',
            false,
            false
        );

        expect(result.success).toBe(true);
        expect(result.nodes.map((node) => node.name)).toContain('Office HTTP');
        expect(fetchSubscriptionNodes).toHaveBeenCalledTimes(1);
        expect(fetchSubscriptionNodes).toHaveBeenCalledWith(
            'https://sub.example.com/link',
            'HTTPS source',
            expect.any(String),
            undefined,
            false,
            undefined,
            undefined,
            false,
            false,
            false
        );
    });
    it('previews manual HTTP references once and fetches an explicit-port source', async () => {
        const httpNode = {
            id: 'http',
            enabled: true,
            name: 'HTTP node',
            url: 'http://fixture:fixture@proxy.example.invalid:8080#HTTP',
        };
        const source = {
            id: 'sub',
            enabled: true,
            name: 'Source',
            url: 'https://example.invalid:8443/sub',
        };
        createAdapter.mockReturnValue({
            getProfileById: vi.fn().mockResolvedValue({
                id: 'profile',
                enabled: true,
                subscriptions: ['sub', 'http'],
                manualNodes: ['http'],
                operators: [],
            }),
            getSubscriptionsByIds: vi.fn().mockResolvedValue([source, httpNode]),
            get: vi.fn().mockResolvedValue({ defaultOperators: [] }),
        });
        fetchSubscriptionNodes.mockResolvedValue({ success: true, nodes: [] });
        const { handleProfileMode } =
            await import('../../functions/modules/subscription/profile-handler.js');
        const result = await handleProfileMode(
            new Request('https://example.invalid/api/subscription_nodes'),
            {},
            'profile',
            'Fixture'
        );
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0].url).toContain('@proxy.example.invalid:8080');
        expect(fetchSubscriptionNodes).toHaveBeenCalledTimes(1);
        expect(fetchSubscriptionNodes.mock.calls[0][0]).toBe(source.url);
    });
});
