import { describe, expect, it } from 'vitest';
import {
    isDatedProbeVersion,
    isProbeReleaseVersion,
    isProbeBuildVersion,
} from '../../src/shared/probe-version.js';
import { sanitizeExecutionMetadata } from '../../functions/services/probe-execution-metadata.js';
import { executionSnapshotView } from '../../src/utils/probe-execution-view.js';
import {
    validateProbeReleaseCatalog,
    probeInstallationCapabilities,
} from '../../src/shared/probe-release.js';
import { buildProbeBootstrapCommand } from '../../src/shared/probe-bootstrap-command.js';
import { syntheticProbeReleaseCatalog } from '../fixtures/probe-release.js';

const version = '0.0.1.261015.1';
describe('dated Probe release identities', () => {
    it.each([version, '0.0.1.000229.999999', '0.0.1.240229.10', '0.0.1.991231.2'])(
        'accepts exact valid calendar identity %s',
        (value) => {
            expect(isDatedProbeVersion(value)).toBe(true);
            expect(isProbeReleaseVersion(value)).toBe(true);
            expect(isProbeBuildVersion(value)).toBe(true);
        }
    );
    it.each([
        '0.0.1.230229.1',
        '0.0.1.261332.1',
        '0.0.1.260000.1',
        '0.0.1.260431.1',
        '0.0.1.261015.0',
        '0.0.1.261015.01',
        '0.0.1.261015.1000000',
        version + '\n',
        version + '-dev',
        'v' + version,
        version + ';echo',
        null,
    ])('rejects malformed dated identity %s', (value) => {
        expect(isDatedProbeVersion(value)).toBe(false);
        expect(isProbeReleaseVersion(value)).toBe(false);
        expect(isProbeBuildVersion(value)).toBe(false);
    });
    it('accepts dated wrapper results through backend and frontend while retaining kernel syntax', () => {
        const input = {
            schemaVersion: 1,
            wrapperVersion: version,
            wrapperRevision: 'a'.repeat(40),
            platform: 'windows-amd64',
            kernelLockVersion: 'v1.19.32-misub-source',
            ruleSetVersion: 1,
        };
        const sanitized = sanitizeExecutionMetadata(input);
        expect(sanitized.wrapperVersion).toBe(version);
        expect(executionSnapshotView(sanitized, 'done').metadata.wrapperVersion).toBe(version);
        expect(() => sanitizeExecutionMetadata({ ...input, kernelLockVersion: version })).toThrow(
            'invalid_execution_metadata'
        );
        expect(isProbeReleaseVersion('0.2.0')).toBe(true);
        expect(isProbeBuildVersion('0.3.0-dev')).toBe(true);
    });
    it('pins new and historical dated catalogs and generates both platform commands', () => {
        const fixture = syntheticProbeReleaseCatalog();
        const oldTag = fixture.release.tag;
        const updated = JSON.parse(JSON.stringify(fixture).replaceAll(oldTag, 'probe-v' + version));
        updated.release.version = version;
        updated.legacyReleases.push({
            version: '0.0.1.261014.10',
            tag: 'probe-v0.0.1.261014.10',
            capabilities: [],
        });
        expect(validateProbeReleaseCatalog(updated).release.version).toBe(version);
        const installation = probeInstallationCapabilities(updated);
        for (const terminal of ['unix', 'windows']) {
            expect(buildProbeBootstrapCommand({ installation, terminal, resume: true })).toContain(
                'probe-v' + version
            );
        }
    });
});
