import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createI18n } from '../../src/i18n/index.js';
import VersionChangelogModal from '../../src/components/modals/VersionChangelogModal.vue';
import Footer from '../../src/components/layout/Footer.vue';
const render = (release, currentVersion = '0.0.1-alpha.1') =>
    mount(VersionChangelogModal, {
        props: { show: true, release, currentVersion },
        global: {
            plugins: [createPinia(), createI18n({ initialLocale: 'zh-CN' })],
            stubs: {
                Modal: {
                    template:
                        '<section><slot name="title"/><slot name="body"/><slot name="footer"/></section>',
                },
            },
        },
    });
describe('主应用产品与构建页面状态', () => {
    it('没有发行时不宣称最新，展示产品与源码未知', () => {
        const wrapper = render(null);
        expect(wrapper.text()).toContain('尚无可确认的测试发行');
        expect(wrapper.get('[data-testid="app-alpha-channel"]').text()).toContain(
            '不代表真实安装与全链路验收已通过'
        );
        expect(wrapper.get('[data-testid="app-build-identity"]').text()).toContain('0.0.1-alpha.1');
        expect(wrapper.get('[data-testid="app-build-identity"]').text()).toContain('未提供');
        wrapper.unmount();
    });
    it('历史版本明确显示迁移提示', () => {
        const wrapper = render(
            { tag_name: 'v0.0.1-alpha.1', prerelease: true, draft: false },
            '2.7.0'
        );
        expect(wrapper.get('[data-testid="app-legacy-migration"]').text()).toContain('迁移');
        expect(wrapper.text()).not.toContain('当前测试发行');
        wrapper.unmount();
    });
    it('页脚标识测试产品并打开详情', async () => {
        const wrapper = mount(Footer, { global: { plugins: [createPinia()] } });
        const button = wrapper.get('[data-testid="app-build-version"]');
        expect(button.text()).toContain('0.0.1-alpha.1');
        expect(button.attributes('title')).toContain('SHA unknown');
        await button.trigger('click');
        expect(wrapper.vm.versionStore.showModal).toBe(true);
        wrapper.unmount();
    });
});
