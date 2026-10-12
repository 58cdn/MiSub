import { mount, flushPromises } from '@vue/test-utils';
import { h, ref, defineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createI18n } from '../../src/i18n/index.js';
import SettingsContent from '../../src/components/settings/SettingsContent.vue';
import SettingsModal from '../../src/components/modals/SettingsModal.vue';

const settingsMocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('../../src/composables/useSettingsLogic.js', () => ({
    useSettingsLogic: () => ({
        settings: ref({}),
        disguiseConfig: ref({}),
        isLoading: ref(false),
        isSaving: ref(false),
        showMigrationModal: ref(false),
        restartCountdown: ref(null),
        hasWhitespace: ref(false),
        isStorageTypeValid: ref(true),
        loadSettings: settingsMocks.load,
        handleSave: settingsMocks.save,
    }),
}));

const sectionStubs = {
    BasicSettings: true,
    HomeSettings: true,
    GlobalSettings: true,
    ServiceSettings: true,
    ClientSettings: true,
    CustomPageSettings: true,
    SystemSettings: true,
    WebdavBackupSettings: true,
    MigrationModal: true,
};

const wrappers = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('settings detector navigation', () => {
    for (const alwaysShowHeader of [false, true]) {
        it(`loads detector data only in its own tab and keeps actions independent of settings save (header ${alwaysShowHeader})`, async () => {
            const fetch = vi.fn(
                async () =>
                    new Response(JSON.stringify({ success: true, data: { storageReady: false } }), {
                        headers: { 'Content-Type': 'application/json' },
                    })
            );
            vi.stubGlobal('fetch', fetch);
            const shell = defineComponent({
                setup() {
                    const activeTab = ref('basic');
                    return () =>
                        h(SettingsContent, {
                            activeTab: activeTab.value,
                            'onUpdate:activeTab': (tab) => {
                                activeTab.value = tab;
                            },
                            settings: {},
                            alwaysShowHeader,
                        });
                },
            });
            const wrapper = mount(shell, {
                global: {
                    plugins: [createI18n({ initialLocale: 'en-US' })],
                    stubs: sectionStubs,
                },
            });
            wrappers.push(wrapper);
            await flushPromises();
            expect(fetch).not.toHaveBeenCalled();
            await wrapper.get('[data-testid="settings-tab-detectors"]').trigger('click');
            await flushPromises();
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch.mock.calls[0][0]).toBe('/api/probes/v1/capabilities');
            expect(
                wrapper.get('[data-testid="settings-tab-detectors"]').attributes('aria-current')
            ).toBe('page');
            expect(
                wrapper.get('[data-testid="detector-create"]').attributes('disabled')
            ).toBeDefined();
            expect(
                wrapper.findAll('button').some((button) => button.text() === 'Save Changes')
            ).toBe(false);
            await wrapper.get('[data-testid="settings-tab-basic"]').trigger('click');
            expect(wrapper.find('[data-testid="detector-settings"]').exists()).toBe(false);
            expect(wrapper.findAll('button').some((button) => /Save/i.test(button.text()))).toBe(
                true
            );
            expect(fetch).toHaveBeenCalledTimes(1);
        });
    }

    for (const blocked of [false, true]) {
        it(`opens detector management from the actual settings modal without nesting or saving (${blocked ? 'navigation blocked' : 'success'})`, async () => {
            const fetch = vi.fn();
            vi.stubGlobal('fetch', fetch);
            const router = createRouter({
                history: createMemoryHistory(),
                routes: [
                    { path: '/dashboard', component: { template: '<div />' } },
                    { path: '/dashboard/settings', component: { template: '<div />' } },
                ],
            });
            await router.push('/dashboard');
            await router.isReady();
            if (blocked) router.beforeEach(() => false);
            const wrapper = mount(SettingsModal, {
                props: { show: true },
                attachTo: document.body,
                global: {
                    plugins: [router, createI18n({ initialLocale: 'en-US' })],
                    stubs: sectionStubs,
                },
            });
            wrappers.push(wrapper);
            await flushPromises();
            expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
            document.querySelector('[data-testid="settings-tab-detectors"]').click();
            await flushPromises();
            expect(fetch).not.toHaveBeenCalled();
            expect(settingsMocks.save).not.toHaveBeenCalled();
            expect(document.querySelector('[data-testid="detector-create"]')).toBeNull();
            if (blocked) {
                expect(router.currentRoute.value.fullPath).toBe('/dashboard');
                expect(wrapper.emitted('update:show')).toBeUndefined();
                expect(document.querySelector('[role="alert"]').textContent).toContain(
                    'Unable to open'
                );
            } else {
                expect(router.currentRoute.value.fullPath).toBe(
                    '/dashboard/settings?focus=detectors'
                );
                expect(wrapper.emitted('update:show')).toEqual([[false]]);
                await wrapper.setProps({ show: false });
                await flushPromises();
                expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
            }
        });
    }
});
