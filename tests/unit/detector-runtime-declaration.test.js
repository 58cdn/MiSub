import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DetectorRuntimeDeclaration from '../../src/components/settings/sections/DetectorRuntimeDeclaration.vue';
import { createI18n } from '../../src/i18n/index.js';

const checkedAt = 1800000000000;
const declaration = Object.freeze({
    source: 'agent_claim',
    state: 'declared',
    schemaVersion: 1,
    observationsVersion: 1,
    receivedAt: checkedAt - 1000,
    freshness: 'fresh',
});
const wrappers = [];
const languages = [
    {
        locale: 'en-US',
        declared: 'v1 declaration · observations v1',
        legacy: 'Legacy protocol · observations v1',
        missing: 'Capabilities not declared',
        unsupported_schema: 'Unknown declaration version',
        invalid_declaration: 'Invalid declaration',
        conflicting_versions: 'Conflicting declaration versions',
        unavailable: 'Unknown (no usable record)',
        invalid: 'Unknown (unreadable record)',
        fresh: 'At check: received within 5 minutes',
        stale: 'At check: record stale',
        source: 'Source: detector claim declaration',
        note: 'It does not establish current measured capabilities, unlock status or scheduling authorization.',
    },
    {
        locale: 'zh-CN',
        declared: 'v1 声明 · 观测 v1',
        legacy: '旧协议 · 观测 v1',
        missing: '未声明能力',
        unsupported_schema: '声明版本未知',
        invalid_declaration: '声明无效',
        conflicting_versions: '声明版本矛盾',
        unavailable: '未知（无可用记录）',
        invalid: '未知（记录无法识别）',
        fresh: '核对时：5 分钟内收到',
        stale: '核对时：记录已过期',
        source: '来源：检测器领单自报',
        note: '不代表当前实测能力、解锁状态或调度授权。',
    },
];
function render(language, props = {}) {
    const i18n = createI18n({ initialLocale: language.locale });
    const wrapper = mount(DetectorRuntimeDeclaration, {
        props: { capabilities: declaration, checkedAt, ...props },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    return { wrapper, i18n };
}
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

describe.each(languages)('runtime declaration component: $locale', (language) => {
    it('renders the explicit catalog with source limitations and no measured-success claim', async () => {
        const { wrapper } = render(language, {
            capabilities: { ...declaration, catalogVersion: 1 },
        });
        const catalog = wrapper.get('[data-testid="detector-capability-catalog"]');
        expect(catalog.text()).toContain('format, tcp, proxy, speed, unlock, observations');
        expect(catalog.text()).toContain('IPinfo');
        expect(catalog.text()).toContain('IPPure');
        expect(catalog.text()).toContain('openai v1');
        expect(wrapper.text()).toContain(language.note);
        await wrapper.setProps({
            capabilities: { ...declaration, catalogVersion: 999, sources: ['PRIVATE'] },
        });
        expect(wrapper.find('[data-testid="detector-capability-catalog"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="detector-capability-catalog-unknown"]').exists()).toBe(
            true
        );
        expect(wrapper.text()).not.toContain('PRIVATE');
    });
    it('renders bounded versions, source and fixed server timestamps with qualified freshness', () => {
        const { wrapper } = render(language);
        expect(wrapper.attributes('data-state')).toBe('declared');
        expect(wrapper.get('summary').text()).toContain(language.declared);
        expect(wrapper.get('summary').text()).toContain(language.fresh);
        expect(wrapper.text()).toContain(language.source);
        expect(wrapper.text()).toContain(language.note);
        expect(wrapper.get('[data-field="receivedAt"]').attributes('datetime')).toBe(
            new Date(declaration.receivedAt).toISOString()
        );
        expect(wrapper.get('[data-field="checkedAt"]').attributes('datetime')).toBe(
            new Date(checkedAt).toISOString()
        );
        expect(wrapper.text()).not.toContain('agent_claim');
    });
    it.each([
        'legacy',
        'missing',
        'unsupported_schema',
        'invalid_declaration',
        'conflicting_versions',
    ])('describes %s without inventing versions', (state) => {
        const { wrapper } = render(language, {
            capabilities: {
                ...declaration,
                state,
                schemaVersion: null,
                observationsVersion: state === 'legacy' ? 1 : null,
            },
        });
        expect(wrapper.get('.runtime-state').text()).toBe(language[state]);
        expect(wrapper.text()).toContain(language.note);
        if (state !== 'legacy') expect(wrapper.text()).not.toContain('v1');
    });
    it('labels a stale record using its server freshness', () => {
        const { wrapper } = render(language, {
            capabilities: { ...declaration, receivedAt: checkedAt - 300000, freshness: 'stale' },
        });
        expect(wrapper.get('.runtime-freshness').text()).toBe(language.stale);
    });
    it.each([null, undefined])('keeps an absent record unknown: %s', (capabilities) => {
        const { wrapper } = render(language, { capabilities });
        expect(wrapper.get('.runtime-state').text()).toBe(language.unavailable);
        expect(wrapper.find('time').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('v1');
    });
    it('discards sensitive and unsupported data without rendering markup', () => {
        const { wrapper } = render(language, {
            capabilities: {
                ...declaration,
                token: 'PRIVATE',
                path: '/private',
                debug: { password: 'PRIVATE' },
                html: '<img src="private.invalid">',
                version: '9.9.9',
            },
        });
        expect(wrapper.html()).not.toMatch(/PRIVATE|\/private|9\.9\.9/);
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.get('.runtime-state').text()).toBe(language.declared);
    });
    it('hides old accepted fields when data becomes malformed, missing or revoked', async () => {
        const { wrapper } = render(language);
        for (const props of [
            { capabilities: { ...declaration, source: 'PRIVATE' } },
            { capabilities: null },
            { capabilities: declaration, revoked: true },
        ]) {
            await wrapper.setProps(props);
            expect(wrapper.find('time').exists()).toBe(false);
            expect(wrapper.text()).not.toContain(language.source);
            expect(wrapper.text()).not.toContain('PRIVATE');
        }
    });
    it('uses a native collapsed disclosure with its own summary', () => {
        const { wrapper } = render(language);
        expect(wrapper.element.tagName).toBe('DETAILS');
        expect(wrapper.element.open).toBe(false);
        expect(wrapper.element.firstElementChild.tagName).toBe('SUMMARY');
        expect(wrapper.get('summary').attributes('role')).toBeUndefined();
        expect(wrapper.get('summary').attributes('tabindex')).toBeUndefined();
    });
});
it('updates locale without modifying the declaration or server time', async () => {
    const { wrapper, i18n } = render(languages[0]);
    i18n.setLocale('zh-CN');
    await nextTick();
    expect(wrapper.get('.runtime-state').text()).toBe(languages[1].declared);
    expect(wrapper.get('[data-field="receivedAt"]').attributes('datetime')).toBe(
        new Date(declaration.receivedAt).toISOString()
    );
});
