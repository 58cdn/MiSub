// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { handleExternalSubscriptionsRequest } from '../../functions/modules/external-subscriptions-handler.js';
import { handleExternalProfilesRequest } from '../../functions/modules/external-profiles-handler.js';
import * as nodeParser from '../../functions/modules/utils/node-parser.js';

const sourceUrl = 'https://fixture.invalid/sub';
const node = 'trojan://synthetic@fixture.invalid:443#Node+Name';
let fixture;
let storage;

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(node))
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    fixture?.close();
    fixture = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function setup(fields = {}) {
    fixture = await createProtocolFixture({
        subscriptions: [{ id: 'one', name: 'Source', url: sourceUrl, enabled: true, ...fields }],
        profiles: [{ id: 'group', name: 'Group', subscriptions: ['one'], manualNodes: [] }],
    });
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
}

async function refresh(kind = 'subscription') {
    const request = new Request('https://fixture.invalid/api/ext/v1/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            operationId: 'fixture_refresh',
            baseVersion: (await storage.readSubscriptionSnapshot()).version,
        }),
    });
    return kind === 'profile'
        ? handleExternalProfilesRequest(request, fixture.env, { id: 'group', action: 'refresh' })
        : handleExternalSubscriptionsRequest(request, fixture.env, {
              id: 'one',
              action: 'refresh',
          });
}

function requests() {
    return fetch.mock.calls.map(([request]) => ({
        url: request.url,
        userAgent: request.headers.get('user-agent'),
    }));
}

describe('strict external refresh uses canonical request policy through the real node handler', () => {
    it('rejects an observation fetched before restore even when restored configuration is unchanged', async () => {
        await setup();
        const before = await storage.readSubscriptionSnapshot();
        let restored;
        fetch.mockImplementationOnce(async () => {
            restored = await storage.restoreSubscriptionSnapshot({
                operationId: 'restore_during_fetch',
                baseVersion: before.version,
                nextEpoch: 'restored_epoch',
                subscriptions: before.subscriptions,
                profiles: before.profiles,
            });
            return new Response(node);
        });
        const response = await refresh();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('epoch_conflict');
        const after = await storage.readSubscriptionSnapshot();
        expect(after.version.epoch).toBe('restored_epoch');
        expect(after.subscriptions).toEqual(restored.snapshot.subscriptions);
    });
    it('unconfigured UA sends the same actual v2rayN header as node_count and Cron', async () => {
        await setup();
        expect((await refresh()).status).toBe(200);
        expect(requests()).toEqual([
            { url: sourceUrl, userAgent: 'clash-verge/v2.4.3' },
            { url: sourceUrl, userAgent: 'v2rayN/7.23' },
        ]);
        expect((await storage.readSubscriptionSnapshot()).subscriptions[0].nodeCount).toBe(1);
    });

    it.each(['subscription', 'profile'])(
        'ignores legacy aliases for %s runtime writes',
        async (kind) => {
            await setup({
                userAgent: 'LegacyAlias/1.0',
                proxy: 'https://alias.fixture.invalid/?url=',
            });
            expect((await refresh(kind)).status).toBe(200);
            expect(requests()).toEqual([
                { url: sourceUrl, userAgent: 'clash-verge/v2.4.3' },
                { url: sourceUrl, userAgent: 'v2rayN/7.23' },
            ]);
        }
    );

    it('preserves canonical custom UA, proxy and plusAsSpace for the actual node parser', async () => {
        const parse = vi.spyOn(nodeParser, 'parseNodeList');
        await setup({
            customUserAgent: ' CanonicalAgent/2.0 ',
            fetchProxy: ' https://proxy.fixture.invalid/?url= ',
            plusAsSpace: true,
            userAgent: 'LegacyAlias/1.0',
            proxy: 'https://alias.fixture.invalid/?url=',
        });
        expect((await refresh()).status).toBe(200);
        const proxyUrl = `https://proxy.fixture.invalid/?ua=CanonicalAgent%2F2.0&url=${encodeURIComponent(sourceUrl)}`;
        expect(requests()).toEqual([
            { url: proxyUrl, userAgent: 'clash-verge/v2.4.3' },
            { url: proxyUrl, userAgent: 'CanonicalAgent/2.0' },
        ]);
        expect(parse).toHaveBeenCalledWith(node, { plusAsSpace: true });
    });

    it('keeps the Clash-specific default UA selected from the canonical URL', async () => {
        const url = `${sourceUrl}?clash=2`;
        await setup({ url });
        expect((await refresh()).status).toBe(200);
        expect(requests()).toEqual([
            { url, userAgent: 'clash-verge/v2.4.3' },
            { url, userAgent: 'clash-verge/v2.4.3' },
        ]);
    });

    it('keeps candidate validation aliases as inspection-only input', async () => {
        await setup();
        const response = await handleExternalSubscriptionsRequest(
            new Request('https://fixture.invalid/api/ext/v1/subscriptions/validate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: sourceUrl, userAgent: 'CandidateAgent/1.0' }),
            }),
            fixture.env,
            { action: 'validate' }
        );
        expect(response.status).toBe(200);
        expect(requests()[1].userAgent).toBe('CandidateAgent/1.0');
        expect(fixture.state.batches).toBe(0);
        expect(
            (await storage.readSubscriptionSnapshot()).subscriptions[0].nodeCount
        ).toBeUndefined();
    });
});
