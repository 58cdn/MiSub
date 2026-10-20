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

describe('HTTP node Probe inventory', () => {
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
