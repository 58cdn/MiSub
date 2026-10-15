import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from '../../src/i18n/index.js';
import { probeVersionIdentity, compareProbeVersions } from '../../src/shared/probe-version.js';
import { sanitizeExecutionMetadata } from '../../functions/services/probe-execution-metadata.js';
import { executionSnapshotView } from '../../src/utils/probe-execution-view.js';
import {
    validateProbeReleaseCatalog,
    probeInstallationCapabilities,
} from '../../src/shared/probe-release.js';
import { syntheticProbeReleaseCatalog } from '../fixtures/probe-release.js';
import catalog from '../../detector/release-catalog.json';
import ProbeExecutionMetadata from '../../src/components/nodes/ProbeExecutionMetadata.vue';
import DetectorVersion from '../../src/components/settings/sections/DetectorVersion.vue';
const sha = 'abcdef1234567890abcdef1234567890abcdef12';
const declaration = {
    schemaVersion: 1,
    wrapperVersion: '0.0.1-alpha.10',
    wrapperRevision: sha,
    platform: 'linux-amd64',
    ruleSetVersion: 1,
    buildChannel: 'development',
    sourceState: 'clean',
};
const global = { plugins: [createI18n({ initialLocale: 'zh-CN' })] };
describe('Probe alpha 与历史记录兼容', () => {
    it('前后端保持产品版与完整 SHA 及可选构建声明', () => {
        const stored = sanitizeExecutionMetadata(declaration);
        expect(executionSnapshotView(stored, 'done').metadata).toEqual(stored);
        const identity = probeVersionIdentity(stored.wrapperVersion, stored.wrapperRevision, {
            development: true,
            sourceState: 'clean',
        });
        expect(identity).toMatchObject({
            productVersion: '0.0.1-alpha.10',
            displayVersion: '0.0.1-alpha.10.sha.abcdef123456',
            sourceCommit: sha,
            channel: 'testing',
        });
        expect(compareProbeVersions('0.0.1-alpha.9', '0.0.1-alpha.10')).toBe(-1);
    });
    it('alpha 必须有真实形状的完整 SHA，声明状态校验失败关闭', () => {
        for (const change of [
            { wrapperRevision: 'source' },
            { wrapperRevision: '0'.repeat(40) },
            { sourceState: 'verified' },
            { buildChannel: 'stable' },
        ])
            expect(() => sanitizeExecutionMetadata({ ...declaration, ...change })).toThrow();
        expect(
            probeVersionIdentity('0.0.1-alpha.1', sha, { development: true, sourceState: 'dirty' })
                .buildIdentityComplete
        ).toBe(false);
        expect(
            probeVersionIdentity('0.0.1-alpha.1', sha, { development: true }).displayVersion
        ).toBe('0.0.1-alpha.1');
    });
    it.each(['0.1.0', '0.2.0', '0.3.0', '0.0.1.261015.1'])('保留历史身份 %s', (wrapperVersion) => {
        const old = {
            schemaVersion: 1,
            wrapperVersion,
            wrapperRevision: 'source',
            platform: 'linux-amd64',
            ruleSetVersion: 1,
        };
        const stored = sanitizeExecutionMetadata(old);
        expect(stored.wrapperVersion).toBe(wrapperVersion);
        expect(stored).not.toHaveProperty('buildChannel');
        expect(executionSnapshotView(stored, 'done').status).toBe('recorded');
        expect(probeVersionIdentity(wrapperVersion, 'source').migrationRequired).toBe(true);
    });
    it('详情可识别产品、构建和源码，不虚构历史缺失字段', () => {
        const wrapper = mount(ProbeExecutionMetadata, {
            props: { state: 'done', metadata: sanitizeExecutionMetadata(declaration) },
            global,
        });
        expect(wrapper.get('[data-field="wrapperVersion"]').text()).toBe('0.0.1-alpha.10');
        expect(wrapper.get('[data-field="displayVersion"]').text()).toContain('.sha.abcdef123456');
        expect(wrapper.get('[data-field="wrapperRevision"]').text()).toBe(sha);
        wrapper.unmount();
        const old = mount(DetectorVersion, {
            props: { version: '0.3.0', platform: 'linux-amd64' },
            global,
        });
        expect(old.get('[data-testid="detector-version-migration"]').text()).toContain(
            '历史版本线'
        );
        old.unmount();
    });
    it('测试目录必须声明 testing/prerelease，历史目录只能只读', () => {
        const test = syntheticProbeReleaseCatalog();
        expect(validateProbeReleaseCatalog(test).release).toMatchObject({
            channel: 'testing',
            prerelease: true,
        });
        for (const change of [{ prerelease: false }, { channel: 'stable' }])
            expect(() =>
                validateProbeReleaseCatalog({ ...test, release: { ...test.release, ...change } })
            ).toThrow();
        expect(validateProbeReleaseCatalog(catalog).release.version).toBe('0.2.0');
        expect(
            probeInstallationCapabilities({ ...catalog, distributionReady: true }).targets.every(
                (entry) => !entry.available
            )
        ).toBe(true);
        expect(
            probeInstallationCapabilities({ ...test, distributionReady: false }).targets.every(
                (entry) => !entry.available
            )
        ).toBe(true);
    });
});
