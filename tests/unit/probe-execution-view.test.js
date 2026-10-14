import { describe, expect, it } from 'vitest';
import { executionSnapshotView } from '../../src/utils/probe-execution-view.js';

const snapshot = Object.freeze({
    schemaVersion: 1,
    source: 'detector_reported',
    wrapperVersion: '0.3.0-fixture',
    wrapperRevision: 'b'.repeat(40),
    platform: 'linux-amd64',
    kernelLockVersion: 'v1.19.32',
    ruleSetVersion: 1,
});
const hidden = (status) => ({ status, metadata: null });
const invalid = hidden('invalid');

describe('execution snapshot task state', () => {
    it.each([
        ['queued', 'pending'],
        ['running', 'pending'],
        ['cancelled', 'stopped'],
        ['expired', 'stopped'],
        ['failed', 'unavailable'],
        ['unknown', 'unavailable'],
        ['DONE', 'unavailable'],
        ['', 'unavailable'],
        [undefined, 'unavailable'],
        [null, 'unavailable'],
    ])('prioritizes %s over all supplied declarations', (state, status) => {
        const unreadable = {
            get source() {
                throw new Error('PRIVATE_METADATA_FIXTURE');
            },
        };
        for (const metadata of [
            snapshot,
            null,
            undefined,
            [],
            { source: 'PRIVATE_METADATA_FIXTURE' },
            unreadable,
        ]) {
            expect(executionSnapshotView(metadata, state)).toEqual(hidden(status));
        }
    });

    it.each([null, undefined])(
        'keeps absent done metadata unavailable without guessing its cause: %s',
        (metadata) => {
            expect(executionSnapshotView(metadata, 'done')).toEqual(hidden('unavailable'));
        }
    );
});

describe('recorded execution declarations', () => {
    it('copies only the snapshot and leaves the source immutable', () => {
        const output = executionSnapshotView(snapshot, 'done');
        expect(output).toEqual({ status: 'recorded', metadata: snapshot });
        expect(output.metadata).not.toBe(snapshot);
        output.metadata.wrapperVersion = '9.9.9';
        expect(snapshot.wrapperVersion).toBe('0.3.0-fixture');
        expect(executionSnapshotView(snapshot, 'done').metadata.wrapperVersion).toBe(
            '0.3.0-fixture'
        );
    });

    it.each(['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64', 'windows-amd64'])(
        'accepts the declared platform %s',
        (platform) => {
            const metadata = { ...snapshot, platform };
            expect(executionSnapshotView(metadata, 'done')).toEqual({
                status: 'recorded',
                metadata,
            });
        }
    );

    it.each([
        ['stable wrapper', { wrapperVersion: '0.3.0' }],
        ['prerelease wrapper', { wrapperVersion: '0.3.0-rc.1' }],
        ['maximum wrapper length', { wrapperVersion: `1.2.3-${'a'.repeat(58)}` }],
        ['local source revision', { wrapperRevision: 'source' }],
        ['commit revision', { wrapperRevision: '0123456789abcdef0123456789abcdef01234567' }],
        ['kernel without prefix', { kernelLockVersion: '1.19.32' }],
        ['kernel prerelease', { kernelLockVersion: 'v1.19.32-rc.1' }],
        ['maximum kernel length', { kernelLockVersion: `v1.2.3-${'a'.repeat(57)}` }],
        ['maximum rules version', { ruleSetVersion: 65535 }],
    ])('preserves %s without normalization', (_name, fields) => {
        const metadata = { ...snapshot, ...fields };
        expect(executionSnapshotView(metadata, 'done')).toEqual({ status: 'recorded', metadata });
    });

    it('does not invent a missing kernel declaration or use current agent fields', () => {
        const { kernelLockVersion: _kernel, ...metadata } = snapshot;
        const input = Object.freeze({
            ...metadata,
            currentAgent: Object.freeze({
                version: '9.9.9',
                platform: 'windows-amd64',
                kernelLockVersion: 'v9.9.9',
            }),
        });
        expect(executionSnapshotView(input, 'done')).toEqual({ status: 'recorded', metadata });
        expect(
            Object.hasOwn(executionSnapshotView(input, 'done').metadata, 'kernelLockVersion')
        ).toBe(false);
        expect(executionSnapshotView({ ...input, kernelLockVersion: undefined }, 'done')).toEqual({
            status: 'recorded',
            metadata,
        });
        expect(input.currentAgent.kernelLockVersion).toBe('v9.9.9');
    });

    it('discards unknown nested fields without reading or exposing them', () => {
        const input = Object.freeze({
            ...snapshot,
            token: 'PRIVATE_METADATA_FIXTURE',
            path: 'C:\\PRIVATE_METADATA_FIXTURE',
            error: Object.freeze({ message: 'PRIVATE_METADATA_FIXTURE' }),
            nested: Object.freeze({
                credentials: Object.freeze({ password: 'PRIVATE_METADATA_FIXTURE' }),
            }),
            get rawResponse() {
                throw new Error('PRIVATE_METADATA_FIXTURE');
            },
        });
        const output = executionSnapshotView(input, 'done');
        expect(output).toEqual({ status: 'recorded', metadata: snapshot });
        expect(JSON.stringify(output)).not.toContain('PRIVATE_METADATA_FIXTURE');
        expect(input.token).toBe('PRIVATE_METADATA_FIXTURE');
    });
});

describe('invalid execution declarations', () => {
    it.each([
        ['array', []],
        ['string', 'PRIVATE_METADATA_FIXTURE'],
        ['boolean', false],
        ['number', 1],
        ['empty object', {}],
        ['nested declaration', { executionMetadata: snapshot, token: 'PRIVATE_METADATA_FIXTURE' }],
    ])('hides the malformed %s value', (_name, metadata) => {
        expect(executionSnapshotView(metadata, 'done')).toEqual(invalid);
    });

    it.each([
        ['schemaVersion', 2],
        ['schemaVersion', '1'],
        ['schemaVersion', undefined],
        ['source', 'server_verified'],
        ['source', undefined],
        ['source', { token: 'PRIVATE_METADATA_FIXTURE' }],
        ['wrapperVersion', undefined],
        ['wrapperVersion', null],
        ['wrapperVersion', 3],
        ['wrapperVersion', 'v0.3.0'],
        ['wrapperVersion', '0.3'],
        ['wrapperVersion', '0.3.0+build'],
        ['wrapperVersion', '../PRIVATE_METADATA_FIXTURE'],
        ['wrapperVersion', `1.2.3-${'a'.repeat(59)}`],
        ['wrapperRevision', undefined],
        ['wrapperRevision', null],
        ['wrapperRevision', 'A'.repeat(40)],
        ['wrapperRevision', 'b'.repeat(39)],
        ['wrapperRevision', 'b'.repeat(41)],
        ['wrapperRevision', { path: 'PRIVATE_METADATA_FIXTURE' }],
        ['wrapperRevision', ' source'],
        ['platform', undefined],
        ['platform', 'linux-x64'],
        ['platform', ['linux-amd64']],
        ['kernelLockVersion', null],
        ['kernelLockVersion', ''],
        ['kernelLockVersion', 'vv1.19.32'],
        ['kernelLockVersion', `v1.2.3-${'a'.repeat(58)}`],
        ['kernelLockVersion', { token: 'PRIVATE_METADATA_FIXTURE' }],
        ['ruleSetVersion', undefined],
        ['ruleSetVersion', null],
        ['ruleSetVersion', true],
        ['ruleSetVersion', '1'],
        ['ruleSetVersion', 0],
        ['ruleSetVersion', 65536],
        ['ruleSetVersion', 1.5],
        ['ruleSetVersion', NaN],
        ['ruleSetVersion', Infinity],
    ])('hides invalid %s = %j without changing the input', (field, value) => {
        const input = Object.freeze({
            ...snapshot,
            [field]: value,
            token: 'PRIVATE_METADATA_FIXTURE',
        });
        expect(executionSnapshotView(input, 'done')).toEqual(invalid);
        expect(input[field]).toBe(value);
        expect(input.token).toBe('PRIVATE_METADATA_FIXTURE');
    });

    for (const field of ['wrapperVersion', 'wrapperRevision', 'kernelLockVersion']) {
        it.each(['\n', '\r\n'])(`rejects a trailing newline in ${field}: %j`, (ending) => {
            expect(
                executionSnapshotView({ ...snapshot, [field]: snapshot[field] + ending }, 'done')
            ).toEqual(invalid);
        });
    }
});
