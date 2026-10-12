import {
    PROBE_BOOTSTRAP_CAPABILITIES,
    PROBE_RELEASE_TARGETS,
    probeInstallationCapabilities,
} from '../../src/shared/probe-release.js';

// Synthetic metadata for offline state-machine tests; these are not published release assets.
export function syntheticProbeReleaseCatalog(targets = [...PROBE_RELEASE_TARGETS]) {
    const tag = 'probe-v9.9.9';
    const file = (fileName) => ({
        fileName,
        url: `https://github.com/58cdn/MiSub/releases/download/${tag}/${fileName}`,
        sha256: 'a'.repeat(64),
        size: 12345,
    });
    return {
        schemaVersion: 1,
        distributionReady: true,
        release: {
            version: '9.9.9',
            tag,
            sourceCommit: 'b'.repeat(40),
            bootstrapProtocol: 1,
            capabilities: [...PROBE_BOOTSTRAP_CAPABILITIES],
            assets: targets.map((target) => ({
                target,
                ...file(`misub-probe-${target}${target === 'windows-amd64' ? '.exe' : ''}`),
            })),
            bootstrap: {
                ...(targets.some((target) => target !== 'windows-amd64')
                    ? { unix: file('install.sh') }
                    : {}),
                ...(targets.includes('windows-amd64') ? { windows: file('install.ps1') } : {}),
            },
        },
        legacyReleases: [{ version: '0.1.0', tag: 'probe-v0.1.0', capabilities: [] }],
    };
}

export function syntheticProbeInstallation(targets) {
    return probeInstallationCapabilities(syntheticProbeReleaseCatalog(targets));
}
