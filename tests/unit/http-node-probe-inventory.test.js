import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ nodes: [] }));
vi.mock('../../functions/modules/external-api-utils.js', () => ({
    getExternalStorageAdapter: async () => ({
        getAllSubscriptions: async () => fixture.nodes,
    }),
}));
vi.mock('../../functions/services/probe-http.js', () => ({
    createProbeHandler: (dependencies) => dependencies,
}));

import { handleProbeRequest } from '../../functions/modules/probe-handler.js';
import { convertClashProxyToUrl } from '../../functions/utils/clash-to-url.js';

describe('HTTP node Probe inventory', () => {
    it('keeps an exported TLS HTTP node with protocol parameters in the Probe inventory', async () => {
        const url = convertClashProxyToUrl({
            type: 'http',
            name: 'TLS HTTP',
            server: 'proxy.example.invalid',
            port: 443,
            username: 'fixture',
            password: 'fixture',
            tls: true,
            servername: 'tls.example.invalid',
            'skip-cert-verify': true,
            'client-fingerprint': 'chrome',
            alpn: ['h2', 'http/1.1'],
        });
        fixture.nodes = [{ id: 'tls', name: 'TLS HTTP', url }];
        const selected = await handleProbeRequest.loadManualNodes({});
        expect(selected.map((node) => node.id)).toEqual(['tls']);
        const [prepared] = await handleProbeRequest.prepareNodes(selected);
        expect(prepared.format.status).toBe('passed');
        expect(prepared.proxy).toMatchObject({
            type: 'http',
            tls: true,
            server: 'proxy.example.invalid',
            port: 443,
            servername: 'tls.example.invalid',
            'skip-cert-verify': true,
        });
    });
    it('loads and prepares HTTP nodes while excluding subscription sources', async () => {
        fixture.nodes = [
            { id: 'http', name: 'HTTP', url: 'http://fixture:fixture@proxy.example.invalid:8080' },
            { id: 'sub', name: 'Source', url: 'https://source.example.invalid:8443/sub' },
        ];
        const selected = await handleProbeRequest.loadManualNodes({});
        expect(selected.map((node) => node.id)).toEqual(['http']);
        const prepared = await handleProbeRequest.prepareNodes(selected);
        expect(prepared).toHaveLength(1);
        expect(prepared[0].format.status).toBe('passed');
        expect(prepared[0].proxy).toMatchObject({
            type: 'http',
            server: 'proxy.example.invalid',
            port: 8080,
        });
    });
});
