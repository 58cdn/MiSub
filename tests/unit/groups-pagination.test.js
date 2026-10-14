import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useSubscriptions } from '../../src/composables/useSubscriptions.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useSettingsStore } from '../../src/stores/settings.js';
import { createI18n } from '../../src/i18n/index.js';
import ResultsPagination from '../../src/components/shared/ResultsPagination.vue';
import SubscriptionPanel from '../../src/components/subscriptions/SubscriptionPanel.vue';
import { normalizeGroupsPageSize } from '../../shared/pagination.js';

const sources = (count) =>
    Array.from({ length: count }, (_, i) => ({
        id: `source-${i}`,
        name: `Source ${i}`,
        url: `https://airport.example/sub/${i}`,
        enabled: i % 2 === 0,
        nodeCount: 1,
    }));

describe('airport source pagination', () => {
    beforeEach(() => setActivePinia(createPinia()));

    it.each([undefined, null, 0, -1, 6, 1000, Infinity, {}, 'invalid'])(
        'normalizes old/invalid default %s to a bounded 20',
        (value) => {
            expect(normalizeGroupsPageSize(value)).toBe(20);
        }
    );

    it('uses the global default and keeps temporary page choices local to the view', async () => {
        useSettingsStore().setConfig({ groupsPageSize: 50 });
        useDataStore().subscriptions = sources(121);
        const list = useSubscriptions(vi.fn(), { configurablePagination: true });
        expect(list.paginatedSubscriptions.value).toHaveLength(50);
        list.changeSubsPage(3);
        expect(list.paginatedSubscriptions.value).toHaveLength(21);
        list.changeSubsPageSize(10);
        await nextTick();
        expect(list.subsCurrentPage.value).toBe(1);
        expect(list.paginatedSubscriptions.value).toHaveLength(10);
        expect(useSettingsStore().config.groupsPageSize).toBe(50);
        expect(
            useSubscriptions(vi.fn(), { configurablePagination: true }).subsItemsPerPage.value
        ).toBe(50);
        expect(useSubscriptions(vi.fn()).subsItemsPerPage.value).toBe(6);
    });

    it('applies status and text before counting and slicing; clamps after deletion', async () => {
        useDataStore().subscriptions = sources(85);
        const statusFilter = ref('');
        const list = useSubscriptions(vi.fn(), { configurablePagination: true, statusFilter });
        list.changeSubsPage(5);
        statusFilter.value = 'disabled';
        await nextTick();
        expect(list.subsCurrentPage.value).toBe(1);
        expect(list.filteredCount.value).toBe(42);
        expect(list.paginatedSubscriptions.value.every((sub) => !sub.enabled)).toBe(true);
        list.changeSubsPage(3);
        useDataStore().subscriptions = sources(43);
        await nextTick();
        expect(list.subsCurrentPage.value).toBe(2);
        expect(list.paginatedSubscriptions.value).toHaveLength(1);
        list.searchQuery.value = 'Source 1';
        await nextTick();
        expect(list.subsCurrentPage.value).toBe(1);
        expect(list.filteredCount.value).toBe(6);
        list.searchQuery.value = 'missing';
        await nextTick();
        expect(list.filteredCount.value).toBe(0);
        expect(list.subsTotalPages.value).toBe(1);
        expect(list.paginatedSubscriptions.value).toEqual([]);
        list.changeSubsPage(NaN);
        expect(list.subsCurrentPage.value).toBe(1);
    });

    it('adopts an asynchronously hydrated default unless the user has chosen a page size', async () => {
        const list = useSubscriptions(vi.fn(), { configurablePagination: true });
        useSettingsStore().setConfig({ groupsPageSize: '100' });
        await nextTick();
        expect(list.subsItemsPerPage.value).toBe(100);
        list.changeSubsPageSize(10);
        useSettingsStore().setConfig({ groupsPageSize: 50 });
        expect(list.subsItemsPerPage.value).toBe(10);
    });

    it('renders only current page members when an airport group is expanded', async () => {
        const list = sources(45);
        const wrapper = mount(SubscriptionPanel, {
            props: {
                subscriptions: list,
                paginatedSubscriptions: list.slice(20, 40),
                currentPage: 2,
                totalPages: 3,
                pageSize: 20,
                filteredCount: 45,
            },
            global: {
                plugins: [createPinia(), createI18n({ initialLocale: 'en-US' })],
                stubs: {
                    Card: {
                        props: ['misub'],
                        template: '<article class="source-card">{{ misub.name }}</article>',
                    },
                    draggable: true,
                    Modal: true,
                },
            },
        });
        await wrapper.find('[aria-expanded="false"]').trigger('click');
        expect(wrapper.findAll('.source-card')).toHaveLength(20);
        expect(wrapper.findAll('.source-card').map((w) => w.text())).toEqual(
            list.slice(20, 40).map((s) => s.name)
        );
        expect(wrapper.text()).toContain('Showing 21 to 40 of 45 results');
        await wrapper.setProps({
            paginatedSubscriptions: [list[41]],
            filteredCount: 1,
            currentPage: 1,
        });
        expect(wrapper.findAll('.source-card')).toHaveLength(1);
        expect(wrapper.text()).toContain('Showing 1 to 1 of 1 results');
        wrapper.unmount();
    });
});

describe('result range and accessible controls', () => {
    const render = (props = {}, locale = 'zh-CN') =>
        mount(ResultsPagination, {
            props,
            global: { plugins: [createI18n({ initialLocale: locale })] },
        });

    it('announces empty, first and partial last-page ranges and disables boundaries', async () => {
        const wrapper = render({ totalItems: 2585, pageSize: 20 });
        expect(wrapper.get('[role="status"]').text()).toBe('显示 1 至 20 共 2585 条结果');
        expect(wrapper.findAll('option').map((option) => option.text())).toEqual([
            '10',
            '20',
            '50',
            '100',
        ]);
        expect(wrapper.findAll('button')[0].element.disabled).toBe(true);
        await wrapper.setProps({ currentPage: 130 });
        expect(wrapper.get('[role="status"]').text()).toBe('显示 2581 至 2585 共 2585 条结果');
        expect(wrapper.findAll('button')[3].element.disabled).toBe(true);
        await wrapper.setProps({ totalItems: 0 });
        expect(wrapper.get('[role="status"]').text()).toBe('显示 0 至 0 共 0 条结果');
        expect(wrapper.findAll('button').every((b) => b.element.disabled)).toBe(true);
    });

    it('clamps page input and exposes labelled, disabled loading controls', async () => {
        const wrapper = render({ totalItems: 21 }, 'en-US');
        await wrapper.get('input').setValue(999);
        await wrapper.get('input').trigger('keydown.enter');
        expect(wrapper.emitted('change-page')[0]).toEqual([2]);
        expect(wrapper.get('select').attributes('aria-label')).toBe(
            'Airport subscriptions per page'
        );
        expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('select').attributes('id'));
        await wrapper.setProps({ busy: true });
        expect(wrapper.get('[role="status"]').text()).toBe('Loading results…');
        expect(wrapper.get('nav').attributes('aria-busy')).toBe('true');
        expect(
            wrapper.findAll('button, input, select').every((control) => control.element.disabled)
        ).toBe(true);
    });
});
