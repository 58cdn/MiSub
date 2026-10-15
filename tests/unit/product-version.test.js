import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    compareSemver,
    parseSemver,
    productFromTag,
    productFromDisplay,
    compareProducts,
    versionTransition,
    nextAlphaVersion,
    selectTestRelease,
    createBuildIdentity,
} from '../../src/shared/product-version.js';
import { planAppRelease } from '../../scripts/app-release-policy.mjs';
import { readAppBuildIdentity } from '../../scripts/app-build-identity.mjs';
const sha = 'a'.repeat(40);
describe('完整 SemVer 与产品版本', () => {
    it('遵循 SemVer 官方优先级顺序', () => {
        const order = [
            '1.0.0-alpha',
            '1.0.0-alpha.1',
            '1.0.0-alpha.beta',
            '1.0.0-beta',
            '1.0.0-beta.2',
            '1.0.0-beta.11',
            '1.0.0-rc.1',
            '1.0.0',
            '2.0.0',
        ];
        for (let i = 1; i < order.length; i++) {
            expect(compareSemver(order[i - 1], order[i])).toBe(-1);
            expect(compareSemver(order[i], order[i - 1])).toBe(1);
        }
        expect(compareSemver('1.0.0+abc', '1.0.0+def')).toBe(0);
        expect(compareSemver('0.0.1-alpha.9', '0.0.1-alpha.10')).toBe(-1);
        expect(
            compareSemver('0.0.1-alpha.99999999999999999999', '0.0.1-alpha.100000000000000000000')
        ).toBe(-1);
    });
    it.each([
        '01.0.0',
        '1.0',
        '1.0.0-alpha.01',
        '1.0.0-alpha..1',
        '1.0.0+',
        '1.0.0\n',
        'v1.0.0',
        '1.0.0-α',
    ])('拒绝非 SemVer %s', (value) => expect(parseSemver(value)).toBeNull());
    it('隔离组件标签且只比较产品版本', () => {
        expect(productFromTag('probe-v0.0.1-alpha.99')).toBeNull();
        expect(productFromTag('v0.0.1-alpha.99', 'probe')).toBeNull();
        expect(productFromTag('probe-v0.0.1-alpha.9', 'probe')).toBe('0.0.1-alpha.9');
        expect(productFromTag('v0.0.1-alpha.9.sha.abcdef12')).toBeNull();
        expect(productFromDisplay('0.0.1-alpha.9.sha.abcdef12')).toBe('0.0.1-alpha.9');
        expect(compareProducts('0.0.1-alpha.9.sha.ffffffff', '0.0.1-alpha.9.sha.aaaaaaaa')).toBe(0);
    });
    it.each(['0.1', '0.2', '0.3', '0.1.0', '0.2.0', '0.3.0', '2.7.0', '0.0.1.261015.1'])(
        '显式迁移历史线 %s',
        (value) => expect(versionTransition(value, '0.0.1-alpha.1')).toBe('migration_required')
    );
    it('升级、相等和开发领先分别表达', () => {
        expect(versionTransition('0.0.1-alpha.9', '0.0.1-alpha.10')).toBe('update');
        expect(versionTransition('0.0.1-alpha.10.sha.abcde123', '0.0.1-alpha.10')).toBe('current');
        expect(versionTransition('0.0.1-alpha.11', '0.0.1-alpha.10')).toBe('ahead');
    });
    it('库存包含草稿且按各组件最大 N 接续', () => {
        const tags = ['v0.0.1-alpha.9', 'probe-v0.0.1-alpha.100', 'v2.7.0'];
        const releases = [{ tag_name: 'v0.0.1-alpha.10', draft: true }];
        expect(nextAlphaVersion(tags, releases)).toBe('0.0.1-alpha.11');
        expect(nextAlphaVersion(tags, releases, 'probe')).toBe('0.0.1-alpha.101');
        expect(nextAlphaVersion([], [])).toBe('0.0.1-alpha.1');
    });
    it('公开预发布候选按数字排序并排除其他通道', () => {
        const release = (tag_name, extras = {}) => ({
            tag_name,
            draft: false,
            prerelease: true,
            ...extras,
        });
        expect(
            selectTestRelease([
                release('v0.0.1-alpha.9'),
                release('probe-v0.0.1-alpha.99'),
                release('v0.0.1-alpha.12', { draft: true }),
                release('v0.0.1-alpha.11', { prerelease: false }),
                release('v2.7.0'),
                release('v0.0.1-alpha.10'),
            ]).tag_name
        ).toBe('v0.0.1-alpha.10');
    });
});
describe('源码身份与发行门槛', () => {
    it('保留真实完整 SHA 与未提交状态', () => {
        const identity = createBuildIdentity('0.0.1-alpha.1', sha, { dirty: true });
        expect(identity).toMatchObject({
            sourceCommit: sha,
            displayVersion: '0.0.1-alpha.1.sha.aaaaaaaa',
            dirty: true,
            prerelease: true,
        });
        expect(() => createBuildIdentity('0.0.1-alpha.1', '0'.repeat(40))).toThrow();
        expect(() => createBuildIdentity('0.0.1', sha)).toThrow();
    });
    it('实际检出 SHA 优先，拒绝伪造环境声明', () => {
        const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        expect(readAppBuildIdentity({ env: {} }).sourceCommit).toBe(actual);
        expect(() =>
            readAppBuildIdentity({ env: { MISUB_PRODUCT_VERSION: '0.0.1-alpha.99' } })
        ).toThrow('product_version_mismatch');
        expect(() => readAppBuildIdentity({ env: { MISUB_SOURCE_COMMIT: sha } })).toThrow(
            'source_commit_mismatch'
        );
    });
    it('发行计划只接受干净 main 与下一个未使用序号', () => {
        const input = {
            productVersion: '0.0.1-alpha.2',
            sourceCommit: sha,
            mainCommit: sha,
            sourceState: 'clean',
            inventoryComplete: true,
            tags: ['v0.0.1-alpha.1'],
            releases: [],
        };
        expect(planAppRelease(input)).toMatchObject({
            prerelease: true,
            make_latest: 'false',
            draft: true,
            distributionReady: false,
            acceptance: 'pending',
            sourceCommit: sha,
        });
        for (const extra of [
            { productVersion: '0.0.1-alpha.1' },
            { productVersion: '0.0.1' },
            { mainCommit: 'b'.repeat(40) },
            { sourceState: 'dirty' },
            { inventoryComplete: false },
            { releases: [{ tag_name: 'v0.0.1-alpha.2', draft: true }] },
        ])
            expect(() => planAppRelease({ ...input, ...extra })).toThrow();
    });
});
