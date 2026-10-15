import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    normalizeClaimCapabilities,
    agentRuntimeView,
} from '../../functions/services/probe-agent-runtime.js';
import { runtimeDeclarationView } from '../../src/utils/detector-runtime-view.js';
import { probeCapabilityCatalog } from '../../src/shared/probe-capability-catalog.js';

const minimal = { schemaVersion: 1, observationsVersion: 1 };
const now = 1800000000000;
const row = (capabilities) => ({
    declaration_state: 'declared',
    observations_version: 1,
    capabilities_json: JSON.stringify(capabilities),
    claim_received_at: now - 300000,
    last_heartbeat_at: now,
});

describe('explicit bounded capability catalog', () => {
    it('persists only a known ID within the unchanged schema and exposes independent stale claim time', () => {
        const result = normalizeClaimCapabilities({
            capabilities: { ...minimal, catalogVersion: 1 },
        });
        expect(result.capabilities).toEqual({ ...minimal, catalogVersion: 1 });
        expect(JSON.stringify(result.capabilities).length).toBeLessThanOrEqual(128);
        const view = agentRuntimeView(row(result.capabilities), now, null);
        expect(view.lastHeartbeatAt).toBe(now);
        expect(view.capabilities).toMatchObject({
            catalogVersion: 1,
            receivedAt: now - 300000,
            freshness: 'stale',
        });
        expect(runtimeDeclarationView(view.capabilities, now).declaration.catalogVersion).toBe(1);
        expect(agentRuntimeView(row(minimal), now, null).capabilities).not.toHaveProperty(
            'catalogVersion'
        );
    });

    it.each([
        undefined,
        null,
        0,
        -1,
        2,
        65536,
        '1',
        true,
        [],
        { version: 1 },
        'PRIVATE'.repeat(20000),
    ])(
        'keeps unknown and malicious catalog values out of storage and display: %#',
        (catalogVersion) => {
            const result = normalizeClaimCapabilities({
                observationsVersion: 1,
                capabilities: {
                    ...minimal,
                    catalogVersion,
                    checks: ['PRIVATE'],
                    sources: new Array(10000).fill('PRIVATE'),
                },
            });
            expect(result).toEqual({
                state: 'declared',
                observationsVersion: 1,
                capabilities: minimal,
            });
            const view = agentRuntimeView(row(minimal), now, null).capabilities;
            expect(
                runtimeDeclarationView({ ...view, catalogVersion }, now).declaration
            ).not.toHaveProperty('catalogVersion');
            expect(probeCapabilityCatalog(catalogVersion)).toBeNull();
        }
    );

    it('cannot infer a catalog from prototypes, build data, legacy or invalid declarations', () => {
        const inherited = Object.assign(Object.create({ catalogVersion: 1 }), minimal);
        expect(normalizeClaimCapabilities({ capabilities: inherited }).capabilities).toEqual(
            minimal
        );
        for (const input of [
            { catalogVersion: 1 },
            { version: '0.0.1-alpha.999', catalogVersion: 1 },
            { observationsVersion: 1, catalogVersion: 1 },
            { capabilities: { schemaVersion: 2, observationsVersion: 1, catalogVersion: 1 } },
        ]) {
            expect(normalizeClaimCapabilities(input).capabilities).toBeNull();
        }
        const declaration = agentRuntimeView(row(minimal), now, null).capabilities;
        expect(
            runtimeDeclarationView(
                { ...declaration, state: 'legacy', schemaVersion: null, catalogVersion: 1 },
                now
            ).declaration
        ).not.toHaveProperty('catalogVersion');
    });

    it('resolves a bounded fixed registry and returns independent copies', () => {
        const catalog = probeCapabilityCatalog(1);
        expect(catalog.checks).toEqual([
            'format',
            'tcp',
            'proxy',
            'speed',
            'unlock',
            'observations',
        ]);
        expect(catalog.sources).toHaveLength(6);
        expect(catalog.sources.find((item) => item.id === 'ipinfo').availability).toBe(
            'unconfigured'
        );
        expect(catalog.sources.find((item) => item.id === 'ippure').availability).toBe(
            'experimental'
        );
        expect(catalog.providerRules).toHaveLength(8);
        expect(
            catalog.providerRules.every((item) => item.ruleSetVersion === 1 && item.id.length <= 16)
        ).toBe(true);
        expect(catalog.sources.every((item) => item.id.length <= 16)).toBe(true);
        const registry = readFileSync('detector/services.go', 'utf8').match(
            /var serviceRegistry = map\[string\]string\{([\s\S]*?)\n\}/
        )[1];
        expect([...registry.matchAll(/"([a-z_]+)":/g)].map((match) => match[1]).sort()).toEqual(
            catalog.providerRules.map((item) => item.id).sort()
        );
        expect(readFileSync('detector/execution_metadata.go', 'utf8')).toContain(
            'const executionRuleSetVersion = 1'
        );
        catalog.sources[0].id = 'PRIVATE';
        catalog.providerRules[0].ruleSetVersion = 999;
        catalog.checks.push('PRIVATE');
        expect(JSON.stringify(probeCapabilityCatalog(1))).not.toMatch(/PRIVATE|999/);
    });
});
