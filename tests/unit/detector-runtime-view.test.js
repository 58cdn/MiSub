import { describe, expect, it } from 'vitest';
import {
    runtimeDeclarationView,
    validRuntimeTimestamp,
} from '../../src/utils/detector-runtime-view.js';

const checkedAt = 1800000000000;
const declaration = Object.freeze({
    source: 'agent_claim',
    state: 'declared',
    schemaVersion: 1,
    observationsVersion: 1,
    receivedAt: checkedAt - 1000,
    freshness: 'fresh',
});

describe('runtime declaration view', () => {
    it('copies only the bounded server fields without altering the source', () => {
        const input = Object.freeze({
            ...declaration,
            token: 'PRIVATE',
            debug: { path: '/private' },
        });
        const view = runtimeDeclarationView(input, checkedAt);
        expect(view).toEqual({ status: 'declared', declaration });
        expect(view.declaration).not.toBe(input);
        expect(input.token).toBe('PRIVATE');
    });
    it.each([null, undefined])('keeps absent records unknown: %s', (value) => {
        expect(runtimeDeclarationView(value, checkedAt)).toEqual({
            status: 'unavailable',
            declaration: null,
        });
    });
    it('prioritizes revocation over supplied declarations', () => {
        expect(runtimeDeclarationView(declaration, checkedAt, true)).toEqual({
            status: 'unavailable',
            declaration: null,
        });
    });
    it('distinguishes the legacy v1 observation declaration', () => {
        const legacy = { ...declaration, state: 'legacy', schemaVersion: null };
        expect(runtimeDeclarationView(legacy, checkedAt)).toEqual({
            status: 'legacy',
            declaration: legacy,
        });
    });
    it.each(['missing', 'unsupported_schema', 'invalid_declaration', 'conflicting_versions'])(
        'accepts %s only with unknown versions',
        (state) => {
            const value = { ...declaration, state, schemaVersion: null, observationsVersion: null };
            expect(runtimeDeclarationView(value, checkedAt)).toEqual({
                status: state,
                declaration: value,
            });
            expect(
                runtimeDeclarationView({ ...value, observationsVersion: 1 }, checkedAt).status
            ).toBe('invalid');
            expect(runtimeDeclarationView({ ...value, schemaVersion: 1 }, checkedAt).status).toBe(
                'invalid'
            );
        }
    );
    it.each([
        ['not an object', 'PRIVATE'],
        ['array', []],
        ['source', { ...declaration, source: 'PRIVATE' }],
        ['state', { ...declaration, state: 'PRIVATE' }],
        ['schema', { ...declaration, schemaVersion: 2 }],
        ['observations', { ...declaration, observationsVersion: '1' }],
        ['legacy schema', { ...declaration, state: 'legacy' }],
        [
            'legacy observations',
            { ...declaration, state: 'legacy', schemaVersion: null, observationsVersion: null },
        ],
        ['freshness', { ...declaration, freshness: 'PRIVATE' }],
        ['future received time', { ...declaration, receivedAt: checkedAt + 1 }],
        ['string timestamp', { ...declaration, receivedAt: String(checkedAt) }],
        ['negative timestamp', { ...declaration, receivedAt: -1 }],
        ['fractional timestamp', { ...declaration, receivedAt: checkedAt - 0.5 }],
        ['missing schema', { ...declaration, schemaVersion: undefined }],
    ])('rejects malformed %s', (_label, value) => {
        expect(runtimeDeclarationView(value, checkedAt)).toEqual({
            status: 'invalid',
            declaration: null,
        });
    });
    it.each([0, 299999, 300000, 300001])('uses the server check time at age %i ms', (age) => {
        const value = {
            ...declaration,
            receivedAt: checkedAt - age,
            freshness: age < 300000 ? 'fresh' : 'stale',
        };
        expect(runtimeDeclarationView(value, checkedAt).declaration).toEqual(value);
        expect(
            runtimeDeclarationView(
                { ...value, freshness: value.freshness === 'fresh' ? 'stale' : 'fresh' },
                checkedAt
            ).status
        ).toBe('invalid');
    });
    it.each([null, undefined, '1800000000000', NaN, Infinity, -1, 8640000000000001])(
        'requires a valid server checkedAt: %s',
        (time) => {
            expect(runtimeDeclarationView(declaration, time).status).toBe('invalid');
        }
    );
});

describe('successful lease timestamps', () => {
    it.each([1, checkedAt - 1000, checkedAt])('accepts bounded server time %s', (value) => {
        expect(validRuntimeTimestamp(value, checkedAt)).toBe(true);
    });
    it.each([
        null,
        undefined,
        0,
        -1,
        NaN,
        Infinity,
        checkedAt + 1,
        String(checkedAt),
        checkedAt - 0.5,
        8640000000000001,
    ])('keeps invalid time unknown: %s', (value) => {
        expect(validRuntimeTimestamp(value, checkedAt)).toBe(false);
    });
});
