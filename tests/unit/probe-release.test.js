import { describe, expect, it } from 'vitest';
import catalog from '../../detector/release-catalog.json';
import {
    PROBE_RELEASE_TARGETS,
    probeInstallationCapabilities,
    readProbeInstallation,
    validateProbeReleaseCatalog,
} from '../../src/shared/probe-release.js';
import {
    syntheticProbeReleaseCatalog,
    unpublishedProbeReleaseCatalog,
} from '../fixtures/probe-release.js';

// Reviewed probe-v0.2.0 bytes: original draft assets were individually attested,
// and the public fixed-tag downloads matched these digests and lengths.
const reviewedFiles = {
    'misub-probe-darwin-amd64': [
        'ccbbf2c438b5ca8468997cd4a99b63c28e8b021125952a78f018eb67ab80d230',
        49377200,
    ],
    'misub-probe-darwin-arm64': [
        'b576d2f2d8d0bd5596b02b0b61b00fb55468f17e0a8035545e494482212126f9',
        46736770,
    ],
    'misub-probe-linux-amd64': [
        '30c6806a91c9749a2f22f4bcff956e315d13340c46f0f7db99ca40616fd38049',
        49893500,
    ],
    'misub-probe-linux-arm64': [
        'f1e99ad4e3979b814a116adc5e01e61ddb5d8887e2353451683fc3a9e625247b',
        46006396,
    ],
    'misub-probe-windows-amd64.exe': [
        '73e71b4823b7aa1910733e4b0552c40f04281a5d15cda9aa6eb4b0f8e13c4d08',
        49074176,
    ],
    'install.sh': ['b30e2f17570eb7ac8b4af3151a3bf7c34ddded39b130c594aa5a7afe2ead69b2', 13917],
    'install.ps1': ['9f4a91b8278f41bd216aa1b1857259daa9c7622dc53ed04977fb1ebe72b15ef7', 18968],
};

describe('reviewed probe release catalog', () => {
    it('preserves the recorded 0.2.0 file identities while keeping distribution paused', () => {
        const verified = validateProbeReleaseCatalog(catalog);
        expect(verified.distributionReady).toBe(false);
        expect(verified.release).toMatchObject({
            version: '0.2.0',
            tag: 'probe-v0.2.0',
            sourceCommit: '9ccee76c3cab149f34dca96c304310c9574c0d29',
            bootstrapProtocol: 1,
            capabilities: ['pair', 'install', 'start', 'status', 'check-config', 'bootstrap-v1'],
        });
        expect(verified.release.assets.map(({ target }) => target).sort()).toEqual([
            'darwin-amd64',
            'darwin-arm64',
            'linux-amd64',
            'linux-arm64',
            'windows-amd64',
        ]);
        const files = [
            ...verified.release.assets.map(({ target, ...file }) => file),
            ...Object.values(verified.release.bootstrap),
        ];
        expect(files).toHaveLength(7);
        expect(Object.fromEntries(files.map((file) => [file.fileName, file]))).toEqual(
            Object.fromEntries(
                Object.entries(reviewedFiles).map(([fileName, [sha256, size]]) => [
                    fileName,
                    {
                        fileName,
                        url: `https://github.com/58cdn/MiSub/releases/download/probe-v0.2.0/${fileName}`,
                        sha256,
                        size,
                    },
                ])
            )
        );
        expect(verified.legacyReleases).toEqual([
            { version: '0.1.0', tag: 'probe-v0.1.0', capabilities: [] },
        ]);
        const installation = probeInstallationCapabilities(catalog);
        expect(installation.reason).toBe('distribution_not_ready');
        expect(installation.targets).toHaveLength(5);
        expect(installation.targets.every(({ available }) => !available)).toBe(true);
    });
    it('validates the production catalog contract and derives only its declared availability', () => {
        const verified = validateProbeReleaseCatalog(catalog);
        const installation = probeInstallationCapabilities(catalog);
        expect(readProbeInstallation(installation)).toEqual(installation);
        expect(installation.targets.map(({ target }) => target)).toEqual(PROBE_RELEASE_TARGETS);
        for (const { target, available } of installation.targets) {
            expect(available).toBe(
                verified.distributionReady &&
                    verified.release.assets.some((asset) => asset.target === target)
            );
        }
    });
    it('keeps the unpublished fixture unavailable and records the old package without pairing/install support', () => {
        const unpublished = unpublishedProbeReleaseCatalog();
        expect(validateProbeReleaseCatalog(unpublished)).toEqual(unpublished);
        expect(unpublished.distributionReady).toBe(false);
        expect(unpublished.release).toBeNull();
        const installation = probeInstallationCapabilities(unpublished);
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
            const value = probeInstallationCapabilities(unpublishedProbeReleaseCatalog());
            change(value);
            expect(readProbeInstallation(value)).toBeNull();
        }
        expect(readProbeInstallation(null)).toBeNull();
        expect(readProbeInstallation({ available: true })).toBeNull();
    });
});
