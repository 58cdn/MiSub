import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { agentRuntimeView, normalizeClaimCapabilities, PROBE_CAPABILITY_FRESHNESS_MS } from '../../functions/services/probe-agent-runtime.js';

const NOW = 1802476800000;
const declaration = Object.freeze({ schemaVersion: 1, observationsVersion: 1 });
const missing = state => ({ state, observationsVersion: null, capabilities: null });
const declared = { state: 'declared', observationsVersion: 1, capabilities: declaration };
const legacy = { state: 'legacy', observationsVersion: 1, capabilities: null };
const row = fields => ({
    claim_received_at: NOW - 1000,
    last_heartbeat_at: NOW - 500,
    declaration_state: 'declared',
    observations_version: 1,
    capabilities_json: JSON.stringify(declaration),
    ...fields,
});
const view = (fields = {}) => ({
    source: 'agent_claim', state: 'declared', schemaVersion: 1, observationsVersion: 1,
    receivedAt: NOW - 1000, freshness: 'fresh', ...fields,
});

describe('claim capability normalization', () => {
    it.each([
        ['absent info', undefined, missing('missing')],
        ['empty claim', {}, missing('missing')],
        ['legacy', { observationsVersion: 1 }, legacy],
        ['versioned only', { capabilities: declaration }, declared],
        ['dual protocol', { capabilities: declaration, observationsVersion: 1 }, declared],
    ])('normalizes %s', (_name, input, expected) => {
        expect(normalizeClaimCapabilities(input)).toEqual(expected);
    });

    it.each([null, [], 'PRIVATE_CAPABILITY_FIXTURE', false, 1].map(value => [value]))('rejects malformed claim objects: %j', input => {
        expect(normalizeClaimCapabilities(input)).toEqual(missing('invalid_declaration'));
    });

    it.each([undefined, null, 0, 2, '1', true, {}])('does not authorize an invalid legacy version: %j', observationsVersion => {
        expect(normalizeClaimCapabilities({ observationsVersion })).toEqual(missing('invalid_declaration'));
    });

    it.each([undefined, null, [], 'PRIVATE_CAPABILITY_FIXTURE', false, 1, {}].map(value => [value]))('never falls back from malformed nested capabilities: %j', capabilities => {
        expect(normalizeClaimCapabilities({ capabilities, observationsVersion: 1 })).toEqual(missing('invalid_declaration'));
    });

    it.each([undefined, null, '1', true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects malformed schema versions: %j', schemaVersion => {
        expect(normalizeClaimCapabilities({ capabilities: { ...declaration, schemaVersion }, observationsVersion: 1 }))
            .toEqual(missing('invalid_declaration'));
    });

    it.each([2, 65536, Number.MAX_SAFE_INTEGER])('records unsupported positive schema %s without granting observations', schemaVersion => {
        expect(normalizeClaimCapabilities({ capabilities: { ...declaration, schemaVersion }, observationsVersion: 1 }))
            .toEqual(missing('unsupported_schema'));
    });

    it.each([undefined, null, 0, 2, '1', true, { token: 'PRIVATE_CAPABILITY_FIXTURE' }])('rejects a malformed nested observation version: %j', observationsVersion => {
        expect(normalizeClaimCapabilities({ capabilities: { schemaVersion: 1, observationsVersion }, observationsVersion: 1 }))
            .toEqual(missing('invalid_declaration'));
    });

    it.each([undefined, null, 0, 2, '1', true, {}])('detects disagreement with a provided top-level value: %j', observationsVersion => {
        expect(normalizeClaimCapabilities({ capabilities: declaration, observationsVersion }))
            .toEqual(missing('conflicting_versions'));
    });

    it('does not infer protocol fields from prototypes or unrelated build metadata', () => {
        expect(normalizeClaimCapabilities(Object.create({ observationsVersion: 1, capabilities: declaration })))
            .toEqual(missing('missing'));
        expect(normalizeClaimCapabilities({ capabilities: Object.create(declaration) }))
            .toEqual(missing('invalid_declaration'));
        expect(normalizeClaimCapabilities({ version: '9.9.9', platform: 'linux-amd64', executionMetadata: declaration }))
            .toEqual(missing('missing'));
        expect(normalizeClaimCapabilities({ capabilities: { schemaVersion: 1 } }))
            .toEqual(missing('invalid_declaration'));
    });

    it('creates an independent whitelist without exposing unknown or sensitive fields', () => {
        const capabilities = Object.freeze({
            ...declaration, token: 'PRIVATE_CAPABILITY_FIXTURE',
            nested: Object.freeze({ path: '/private/fixture' }),
            get rawResponse() { throw new Error('PRIVATE_CAPABILITY_FIXTURE'); },
        });
        const input = Object.freeze({ observationsVersion: 1, capabilities, source: 'PRIVATE_CAPABILITY_FIXTURE' });
        const output = normalizeClaimCapabilities(input);
        expect(output).toEqual(declared);
        expect(output.capabilities === capabilities).toBe(false);
        expect(JSON.stringify(output)).not.toContain('PRIVATE_CAPABILITY_FIXTURE');
        output.capabilities.schemaVersion = 99;
        expect(capabilities.schemaVersion).toBe(1);
        expect(normalizeClaimCapabilities(input)).toEqual(declared);
    });
});

describe('persisted claim and heartbeat views', () => {
    it.each([
        ['declared', 1, JSON.stringify(declaration), 1],
        ['legacy', 1, null, null],
        ['missing', null, null, null],
        ['unsupported_schema', null, null, null],
        ['invalid_declaration', null, null, null],
        ['conflicting_versions', null, null, null],
    ])('renders a consistent %s record', (state, observationsVersion, json, schemaVersion) => {
        expect(agentRuntimeView(row({ declaration_state: state, observations_version: observationsVersion, capabilities_json: json }), NOW, null))
            .toEqual({ lastHeartbeatAt: NOW - 500, capabilities: view({ state, observationsVersion, schemaVersion }) });
    });

    it.each([
        [0, 'fresh'], [299999, 'fresh'], [300000, 'stale'], [300001, 'stale'],
    ])('classifies a recorded declaration of age %s as %s', (age, freshness) => {
        expect(PROBE_CAPABILITY_FRESHNESS_MS).toBe(300000);
        expect(agentRuntimeView(row({ claim_received_at: NOW - age }), NOW, null).capabilities)
            .toEqual(view({ receivedAt: NOW - age, freshness }));
    });

    it.each([null, undefined, 0, -1, NOW + 1, NOW + 0.5, String(NOW), NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('hides invalid claim times but preserves an independent heartbeat: %j', claim_received_at => {
        expect(agentRuntimeView(row({ claim_received_at }), NOW, null))
            .toEqual({ lastHeartbeatAt: NOW - 500, capabilities: null });
    });

    it.each([null, undefined, 0, -1, NOW + 1, NOW + 0.5, String(NOW), NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('hides invalid heartbeat times but preserves a consistent claim: %j', last_heartbeat_at => {
        expect(agentRuntimeView(row({ last_heartbeat_at }), NOW, null))
            .toEqual({ lastHeartbeatAt: null, capabilities: view() });
    });

    it.each([null, undefined, 0, -1, NOW + 0.5, String(NOW), NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('cannot establish recency from an invalid server clock: %j', checkedAt => {
        expect(agentRuntimeView(row(), checkedAt, null)).toEqual({ lastHeartbeatAt: null, capabilities: null });
    });

    it.each([null, undefined, [], 'PRIVATE_CAPABILITY_FIXTURE', 1].map(value => [value]))('treats an absent or malformed row as unavailable: %j', input => {
        expect(agentRuntimeView(input, NOW, null)).toEqual({ lastHeartbeatAt: null, capabilities: null });
    });

    it.each([undefined, 0, NOW, 'PRIVATE_CAPABILITY_FIXTURE'])('requires an explicitly active identity rather than revokedAt=%j', revokedAt => {
        expect(agentRuntimeView(row(), NOW, revokedAt)).toEqual({ lastHeartbeatAt: NOW - 500, capabilities: null });
    });

    it.each([
        ['unknown state', { declaration_state: 'PRIVATE_CAPABILITY_FIXTURE' }],
        ['declared missing observations', { observations_version: null }],
        ['declared string observations', { observations_version: '1' }],
        ['declared missing JSON', { capabilities_json: null }],
        ['declared malformed JSON', { capabilities_json: '{PRIVATE_CAPABILITY_FIXTURE' }],
        ['declared object rather than stored text', { capabilities_json: declaration }],
        ['declared JSON null', { capabilities_json: 'null' }],
        ['declared JSON array', { capabilities_json: '[]' }],
        ['declared missing nested field', { capabilities_json: '{"schemaVersion":1}' }],
        ['declared unknown schema', { capabilities_json: '{"schemaVersion":2,"observationsVersion":1}' }],
        ['declared incompatible observations', { capabilities_json: '{"schemaVersion":1,"observationsVersion":2}' }],
        ['legacy with JSON', { declaration_state: 'legacy' }],
        ['legacy without observations', { declaration_state: 'legacy', observations_version: null, capabilities_json: null }],
        ['missing with observations', { declaration_state: 'missing', capabilities_json: null }],
        ['invalid with JSON', { declaration_state: 'invalid_declaration', observations_version: null }],
    ])('hides inconsistent stored state: %s', (_name, fields) => {
        expect(agentRuntimeView(row(fields), NOW, null)).toEqual({ lastHeartbeatAt: NOW - 500, capabilities: null });
    });

    it('supports a heartbeat-only record without inventing a claim', () => {
        expect(agentRuntimeView(row({ claim_received_at: null, declaration_state: 'missing', observations_version: null, capabilities_json: null }), NOW, null))
            .toEqual({ lastHeartbeatAt: NOW - 500, capabilities: null });
        expect(agentRuntimeView(row({ last_heartbeat_at: NOW }), NOW, null).lastHeartbeatAt).toBe(NOW);
    });

    it('does not refresh an old declaration when a newer heartbeat arrives', () => {
        expect(agentRuntimeView(row({ claim_received_at: NOW - 300001, last_heartbeat_at: NOW }), NOW, null))
            .toEqual({ lastHeartbeatAt: NOW, capabilities: view({ receivedAt: NOW - 300001, freshness: 'stale' }) });
    });

    it.each([127, 128])('accepts consistent stored JSON within the %s-character boundary', length => {
        const capabilities_json = JSON.stringify(declaration).padEnd(length, ' ');
        expect(agentRuntimeView(row({ capabilities_json }), NOW, null))
            .toEqual({ lastHeartbeatAt: NOW - 500, capabilities: view() });
    });

    it.each([129, 10000])('does not parse oversized stored JSON of %s characters or hide its independent heartbeat', length => {
        const capabilities_json = JSON.stringify(declaration).padEnd(length, ' ');
        const parse = vi.spyOn(JSON, 'parse');
        let output, calls;
        try {
            output = agentRuntimeView(row({ capabilities_json }), NOW, null);
            calls = parse.mock.calls.length;
        } finally {
            parse.mockRestore();
        }
        expect(calls).toBe(0);
        expect(output).toEqual({ lastHeartbeatAt: NOW - 500, capabilities: null });
    });

    it('whitelists stored JSON and row fields without mutating them or exposing a supplied source', () => {
        const input = Object.freeze(row({
            capabilities_json: JSON.stringify({ ...declaration, source: 'PRIVATE', token: 'PRIVATE', nested: { path: '/private' } }),
            token_hash: 'PRIVATE_CAPABILITY_FIXTURE',
            version: '9.9.9',
        }));
        const before = JSON.stringify(input);
        const output = agentRuntimeView(input, NOW, null);
        expect(input.capabilities_json.length).toBeLessThanOrEqual(128);
        expect(output).toEqual({ lastHeartbeatAt: NOW - 500, capabilities: view() });
        expect(JSON.stringify(output)).not.toContain('PRIVATE');
        expect(JSON.stringify(input)).toBe(before);
        output.capabilities.state = 'changed';
        expect(agentRuntimeView(input, NOW, null).capabilities).toEqual(view());
    });
});

describe('claim capability OpenAPI boundaries', () => {
    const api = yaml.load(readFileSync('docs/node-probes.openapi.yaml', 'utf8'));
    const input = api.paths['/agent/claim'].post.requestBody.content['application/json'].schema;

    it.each(['observationsVersion', 'capabilities'])('documents arbitrary JSON input for %s without applying the supported-value schema', field => {
        expect(Object.keys(input.properties[field])).toEqual(['description']);
        expect(input.properties[field].description).toContain('Any JSON value is accepted');
        expect(input.properties[field].description).toContain('ordinary tasks');
    });

    it('keeps supported declarations and public response fields strictly bounded', () => {
        const supported = api.components.schemas.AgentClaimCapabilities;
        expect(supported.type).toBe('object');
        expect(supported.required).toEqual(['schemaVersion', 'observationsVersion']);
        expect(supported.properties).toEqual({
            schemaVersion: { type: 'integer', const: 1 },
            observationsVersion: { type: 'integer', const: 1 },
        });
        const response = api.components.schemas.AgentClaimDeclaration;
        expect(response.additionalProperties).toBe(false);
        expect(response.required).toEqual(['source', 'state', 'schemaVersion', 'observationsVersion', 'receivedAt', 'freshness']);
        expect(response.properties.source).toEqual({ type: 'string', const: 'agent_claim' });
        expect(response.oneOf).toEqual([
            { properties: { state: { const: 'declared' }, schemaVersion: { const: 1 }, observationsVersion: { const: 1 } } },
            { properties: { state: { const: 'legacy' }, schemaVersion: { const: null }, observationsVersion: { const: 1 } } },
            { properties: { state: { enum: ['missing', 'unsupported_schema', 'invalid_declaration', 'conflicting_versions'] }, schemaVersion: { const: null }, observationsVersion: { const: null } } },
        ]);
    });
});
