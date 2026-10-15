import { isAlphaProduct } from './product-version.js';
import { isProbeVersion } from './probe-version.js';

export const PROBE_RELEASE_TARGETS = Object.freeze([
    'linux-amd64',
    'linux-arm64',
    'darwin-amd64',
    'darwin-arm64',
    'windows-amd64',
]);
export const PROBE_BOOTSTRAP_CAPABILITIES = Object.freeze([
    'pair',
    'install',
    'start',
    'status',
    'check-config',
    'bootstrap-v1',
]);
const repository = 'https://github.com/58cdn/MiSub/releases/download/';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, expected) =>
    plain(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
const versionIsValid = isProbeVersion;
const exactSet = (value, expected) =>
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    value.every((entry) => expected.includes(entry));
function requireRelease(condition) {
    if (!condition) throw new Error('invalid_release_catalog');
}
function readFile(value, fileName, tag, maxBytes) {
    requireRelease(keysAre(value, ['fileName', 'url', 'sha256', 'size']));
    requireRelease(value.fileName === fileName);
    requireRelease(value.url === `${repository}${tag}/${fileName}`);
    requireRelease(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256));
    requireRelease(value.sha256 !== '0'.repeat(64));
    requireRelease(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= maxBytes);
    return { fileName, url: value.url, sha256: value.sha256, size: value.size };
}

/** A reviewed catalog describes published bytes; source support alone never enables installation. */
export function validateProbeReleaseCatalog(value) {
    requireRelease(
        keysAre(value, ['schemaVersion', 'distributionReady', 'release', 'legacyReleases'])
    );
    requireRelease(value.schemaVersion === 1 && typeof value.distributionReady === 'boolean');
    requireRelease(Array.isArray(value.legacyReleases) && value.legacyReleases.length <= 20);
    const seenLegacy = new Set();
    const legacyReleases = value.legacyReleases.map((entry) => {
        requireRelease(keysAre(entry, ['version', 'tag', 'capabilities']));
        requireRelease(versionIsValid(entry.version) && entry.tag === `probe-v${entry.version}`);
        requireRelease(!seenLegacy.has(entry.version));
        seenLegacy.add(entry.version);
        requireRelease(
            Array.isArray(entry.capabilities) &&
                new Set(entry.capabilities).size === entry.capabilities.length &&
                entry.capabilities.every((capability) =>
                    PROBE_BOOTSTRAP_CAPABILITIES.includes(capability)
                )
        );
        requireRelease(entry.version !== '0.1.0' || entry.capabilities.length === 0);
        return { version: entry.version, tag: entry.tag, capabilities: [...entry.capabilities] };
    });
    let release = null;
    if (value.release !== null) {
        const source = value.release;
        requireRelease(
            keysAre(source, [
                'version',
                'tag',
                'sourceCommit',
                'bootstrapProtocol',
                'capabilities',
                'assets',
                'bootstrap',
                ...(isAlphaProduct(source.version) ? ['channel', 'prerelease'] : []),
            ])
        );
        requireRelease(versionIsValid(source.version) && source.version !== '0.1.0');
        if (isAlphaProduct(source.version))
            requireRelease(source.channel === 'testing' && source.prerelease === true);
        // Historical catalogs remain readable; distribution requires a tested alpha product.
        requireRelease(!value.distributionReady || isAlphaProduct(source.version));
        requireRelease(
            source.tag === `probe-v${source.version}` && !seenLegacy.has(source.version)
        );
        requireRelease(
            typeof source.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(source.sourceCommit)
        );
        requireRelease(source.sourceCommit !== '0'.repeat(40));
        requireRelease(
            source.bootstrapProtocol === 1 &&
                exactSet(source.capabilities, PROBE_BOOTSTRAP_CAPABILITIES)
        );
        requireRelease(
            Array.isArray(source.assets) &&
                source.assets.length > 0 &&
                source.assets.length <= PROBE_RELEASE_TARGETS.length
        );
        const seenTargets = new Set();
        const assets = source.assets.map((asset) => {
            requireRelease(keysAre(asset, ['target', 'fileName', 'url', 'sha256', 'size']));
            requireRelease(
                PROBE_RELEASE_TARGETS.includes(asset.target) && !seenTargets.has(asset.target)
            );
            seenTargets.add(asset.target);
            const { target, ...file } = asset;
            const fileName = `misub-probe-${target}${target === 'windows-amd64' ? '.exe' : ''}`;
            return { target, ...readFile(file, fileName, source.tag, 128 * 1024 * 1024) };
        });
        const shells = [];
        if (assets.some((asset) => asset.target !== 'windows-amd64')) shells.push('unix');
        if (seenTargets.has('windows-amd64')) shells.push('windows');
        requireRelease(keysAre(source.bootstrap, shells));
        const bootstrap = Object.fromEntries(
            shells.map((shell) => [
                shell,
                readFile(
                    source.bootstrap[shell],
                    shell === 'unix' ? 'install.sh' : 'install.ps1',
                    source.tag,
                    1024 * 1024
                ),
            ])
        );
        release = {
            ...(isAlphaProduct(source.version) ? { channel: 'testing', prerelease: true } : {}),
            version: source.version,
            tag: source.tag,
            sourceCommit: source.sourceCommit,
            bootstrapProtocol: 1,
            capabilities: [...PROBE_BOOTSTRAP_CAPABILITIES],
            assets,
            bootstrap,
        };
    }
    requireRelease(!value.distributionReady || release !== null);
    return {
        schemaVersion: 1,
        distributionReady: value.distributionReady,
        release,
        legacyReleases,
    };
}

export function probeInstallationCapabilities(value) {
    let catalog;
    try {
        catalog = validateProbeReleaseCatalog(value);
    } catch {
        return {
            schemaVersion: 1,
            distributionReady: false,
            release: null,
            legacyReleases: [],
            reason: 'invalid_release_catalog',
            targets: PROBE_RELEASE_TARGETS.map((target) => ({
                target,
                available: false,
                reason: 'invalid_release_catalog',
            })),
        };
    }
    const reason = catalog.distributionReady ? 'available' : 'distribution_not_ready';
    return {
        ...catalog,
        reason,
        targets: PROBE_RELEASE_TARGETS.map((target) => {
            const available =
                catalog.distributionReady &&
                catalog.release.assets.some((asset) => asset.target === target);
            return {
                target,
                available,
                reason: available
                    ? 'available'
                    : catalog.distributionReady
                      ? 'artifact_unavailable'
                      : reason,
            };
        }),
    };
}

/** Recompute availability at the UI boundary instead of trusting a supplied availability flag. */
export function readProbeInstallation(value) {
    if (
        !keysAre(value, [
            'schemaVersion',
            'distributionReady',
            'release',
            'legacyReleases',
            'reason',
            'targets',
        ])
    )
        return null;
    const { reason, targets, ...catalog } = value;
    const verified = probeInstallationCapabilities(catalog);
    if (verified.reason === 'invalid_release_catalog' || reason !== verified.reason) return null;
    if (!Array.isArray(targets) || targets.length !== verified.targets.length) return null;
    if (
        targets.some(
            (entry, index) =>
                !keysAre(entry, ['target', 'available', 'reason']) ||
                ['target', 'available', 'reason'].some(
                    (key) => entry[key] !== verified.targets[index][key]
                )
        )
    )
        return null;
    return verified;
}
