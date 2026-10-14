import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { createI18n } from '../../src/i18n/index.js';
import SubscriptionGroupsView from '../../src/views/SubscriptionGroupsView.vue';
import SubscriptionPanel from '../../src/components/subscriptions/SubscriptionPanel.vue';

describe('groups view pagination, sorting and save integrity', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([4, 24])(
        'preserves every one of %i sources through filters, pagination, sorting and saving',
        async (count) => {
            const pinia = createPinia();
            setActivePinia(pinia);
            const store = useDataStore();
            const original = Array.from({ length: count }, (_, i) => ({
                id: `source-${i}`,
                name: i % 2 ? `Hidden ${i}` : `Visible ${i}`,
                url: `https://airport${i}.example/sub`,
                enabled: i % 2 === 0,
                nodeCount: 1,
            }));
            expect(
                store.hydrateFromData({
                    misubs: original,
                    profiles: [],
                    ruleTemplates: [],
                    config: { groupsPageSize: 10 },
                })
            ).toBe(true);
            const posted = [];
            vi.stubGlobal(
                'fetch',
                vi.fn(async (_, options) => {
                    const payload = JSON.parse(options.body);
                    posted.push(payload);
                    return new Response(
                        JSON.stringify({
                            success: true,
                            data: { misubs: payload.misubs, profiles: [] },
                        }),
                        { headers: { 'Content-Type': 'application/json' } }
                    );
                })
            );
            const router = createRouter({
                history: createMemoryHistory(),
                routes: [{ path: '/dashboard/groups', component: SubscriptionGroupsView }],
            });
            await router.push('/dashboard/groups');
            await router.isReady();
            const wrapper = mount(SubscriptionGroupsView, {
                global: {
                    plugins: [pinia, router, createI18n({ initialLocale: 'en-US' })],
                    stubs: {
                        Card: true,
                        Modal: true,
                        SubscriptionEditModal: true,
                        BulkImportModal: true,
                        NodePreviewModal: true,
                        QRCodeModal: true,
                        draggable: {
                            name: 'SortFixture',
                            props: ['modelValue'],
                            emits: ['update:modelValue', 'end'],
                            template: '<div data-testid="sort-fixture" />',
                        },
                    },
                },
            });
            const panel = wrapper.getComponent(SubscriptionPanel);
            // Four items cannot navigate past their one page; a larger fixture must navigate normally.
            panel.vm.$emit('changePage', 2);
            await flushPromises();
            expect(wrapper.vm.subsCurrentPage).toBe(count > 10 ? 2 : 1);
            await wrapper.get('[data-testid="subscription-search"]').setValue('Hidden');
            await router.replace('/dashboard/groups?status=disabled');
            await flushPromises();
            expect(panel.props('filteredCount')).toBe(count / 2);
            expect(wrapper.vm.subsCurrentPage).toBe(1);
            panel.vm.$emit('toggleSort');
            await flushPromises();
            const sortable = wrapper.getComponent({ name: 'SortFixture' });
            expect(sortable.props('modelValue')).toHaveLength(count);
            sortable.vm.$emit('update:modelValue', [...sortable.props('modelValue')].reverse());
            sortable.vm.$emit('end');
            await flushPromises();
            expect(await store.saveData()).toBe(true);
            expect(posted).toHaveLength(1);
            expect(posted[0].misubs.map((s) => s.id).sort()).toEqual(
                original.map((s) => s.id).sort()
            );
            expect(store.subscriptions).toHaveLength(count);
            expect(store.subscriptions.filter((s) => s.name.startsWith('Visible'))).toHaveLength(
                count / 2
            );
            wrapper.unmount();
        }
    );
});
