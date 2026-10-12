import { describe, expect, it } from 'vitest';
import catalog from '../../detector/release-catalog.json';
import {
    PROBE_RELEASE_TARGETS,
    probeInstallationCapabilities,
    readProbeInstallation,
    validateProbeReleaseCatalog,
} from '../../src/shared/probe-release.js';
import { syntheticProbeReleaseCatalog } from '../fixtures/probe-release.js';

describe('reviewed probe release catalog', () => {
    it('keeps production unavailable and records the old package without pairing/install support', () => {
        expect(catalog.distributionReady).toBe(false);
        expect(catalog.release).toBeNull();
        const installation = probeInstallationCapabilities(catalog);
        expect(installation.targets.map(({ target }) => target)).toEqual(PROBE_RELEASE_TARGETS);
        expect(installation.targets.every(({ available }) => available === false)).toBe(true);
        expect(installation.legacyReleases).toEqual([
            { version: '0.1.0', tag: 'probe-v0.1.0', capabilities: [] },
        ]);
        expect(readProbeInstallation(installation)).toEqual(installation);
    });
    it('validates a synthetic complete release and derives each platform availability', () => {
        const synthetic = syntheticProbeReleaseCatalog();
        expect(validateProbeReleaseCatalog(synthetic)).toEqual(synthetic);
        const installation = probeInstallationCapabilities(synthetic);
        expect(installation.targets.every(({ available }) => available)).toBe(true);
        expect(readProbeInstallation(installation)).toEqual(installation);
    });
    it('does not enable a missing platform or an unreleased catalog with valid metadata', () => {
        const synthetic = syntheticProbeReleaseCatalog(['darwin-arm64']);
        const installation = probeInstallationCapabilities(synthetic);
        expect(
            installation.targets.filter(({ available }) => available).map(({ target }) => target)
        ).toEqual(['darwin-arm64']);
        synthetic.distributionReady = false;
        expect(
            probeInstallationCapabilities(synthetic).targets.every(({ available }) => !available)
        ).toBe(true);
    });
    it.each([
        [
            'unknown schema',
            (value) => {
                value.schemaVersion = 2;
            },
        ],
        [
            'unknown root field',
            (value) => {
                value.available = true;
            },
        ],
        [
            'string readiness',
            (value) => {
                value.distributionReady = 'true';
            },
        ],
        [
            'ready without a release',
            (value) => {
                value.release = null;
            },
        ],
        [
            'prerelease version',
            (value) => {
                value.release.version = '9.9.9-beta';
            },
        ],
        [
            'leading zero version',
            (value) => {
                value.release.version = '09.9.9';
            },
        ],
        [
            'old incompatible version',
            (value) => {
                value.release.version = '0.1.0';
                value.release.tag = 'probe-v0.1.0';
            },
        ],
        [
            'incorrect tag',
            (value) => {
                value.release.tag = 'latest';
            },
        ],
        [
            'incorrect commit',
            (value) => {
                value.release.sourceCommit = 'main';
            },
        ],
        [
            'zero commit',
            (value) => {
                value.release.sourceCommit = '0'.repeat(40);
            },
        ],
        [
            'wrong bootstrap protocol',
            (value) => {
                value.release.bootstrapProtocol = 2;
            },
        ],
        [
            'missing capability',
            (value) => {
                value.release.capabilities.pop();
            },
        ],
        [
            'duplicate capability',
            (value) => {
                value.release.capabilities[1] = 'pair';
            },
        ],
        [
            'unknown capability',
            (value) => {
                value.release.capabilities.push('sudo');
            },
        ],
        [
            'empty assets',
            (value) => {
                value.release.assets = [];
            },
        ],
        [
            'duplicate target',
            (value) => {
                value.release.assets[1] = value.release.assets[0];
            },
        ],
        [
            'unsupported target',
            (value) => {
                value.release.assets[0].target = 'windows-arm64';
            },
        ],
        [
            'wrong filename',
            (value) => {
                value.release.assets[0].fileName += '.zip';
            },
        ],
        [
            'wrong repository',
            (value) => {
                value.release.assets[0].url = value.release.assets[0].url.replace(
                    '/58cdn/',
                    '/other/'
                );
            },
        ],
        [
            'unpinned URL',
            (value) => {
                value.release.assets[0].url =
                    'https://github.com/58cdn/MiSub/releases/latest/download/misub-probe-linux-amd64';
            },
        ],
        [
            'URL query',
            (value) => {
                value.release.assets[0].url += '?download=1';
            },
        ],
        [
            'wrong protocol',
            (value) => {
                value.release.assets[0].url = value.release.assets[0].url.replace(
                    'https:',
                    'http:'
                );
            },
        ],
        [
            'missing hash',
            (value) => {
                delete value.release.assets[0].sha256;
            },
        ],
        [
            'invalid hash',
            (value) => {
                value.release.assets[0].sha256 = 'NOT_A_SHA';
            },
        ],
        [
            'zero hash',
            (value) => {
                value.release.assets[0].sha256 = '0'.repeat(64);
            },
        ],
        [
            'fractional size',
            (value) => {
                value.release.assets[0].size = 1.5;
            },
        ],
        [
            'zero size',
            (value) => {
                value.release.assets[0].size = 0;
            },
        ],
        [
            'excessive size',
            (value) => {
                value.release.assets[0].size = 128 * 1024 * 1024 + 1;
            },
        ],
        [
            'missing bootstrap',
            (value) => {
                delete value.release.bootstrap.unix;
            },
        ],
        [
            'unsafe bootstrap URL',
            (value) => {
                value.release.bootstrap.unix.url = 'https://example.invalid/install.sh';
            },
        ],
        [
            'unknown bootstrap shell',
            (value) => {
                value.release.bootstrap.other = value.release.bootstrap.unix;
            },
        ],
        [
            'false old capability',
            (value) => {
                value.legacyReleases[0].capabilities = ['pair'];
            },
        ],
    ])('fails closed for %s', (_, mutate) => {
        const value = syntheticProbeReleaseCatalog();
        mutate(value);
        expect(() => validateProbeReleaseCatalog(value)).toThrow('invalid_release_catalog');
        const result = probeInstallationCapabilities(value);
        expect(result.reason).toBe('invalid_release_catalog');
        expect(result.distributionReady).toBe(false);
        expect(result.release).toBeNull();
        expect(result.targets.every(({ available }) => !available)).toBe(true);
        expect(readProbeInstallation(result)).toBeNull();
    });
    it('rejects forged derived flags, errors, missing fields and unknown API metadata', () => {
        for (const change of [
            (value) => {
                value.targets[0].available = true;
            },
            (value) => {
                value.reason = 'available';
            },
            (value) => {
                value.targets.reverse();
            },
            (value) => {
                value.targets[0].extra = 'secret';
            },
            (value) => {
                value.unknown = true;
            },
            (value) => {
                delete value.legacyReleases;
            },
        ]) {
            const value = probeInstallationCapabilities(catalog);
            change(value);
            expect(readProbeInstallation(value)).toBeNull();
        }
        expect(readProbeInstallation(null)).toBeNull();
        expect(readProbeInstallation({ available: true })).toBeNull();
    });
});
