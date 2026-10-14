<script setup>
    import { computed, ref, watch, useId } from 'vue';
    import { useI18n } from '../../i18n/index.js';
    import { GROUPS_PAGE_SIZE_OPTIONS } from '../../../shared/pagination.js';

    const props = defineProps({
        currentPage: { type: Number, default: 1 },
        totalItems: { type: Number, default: 0 },
        pageSize: { type: Number, default: 20 },
        busy: Boolean,
    });
    const emit = defineEmits(['change-page', 'update:pageSize']);
    const { t } = useI18n();
    const selectId = useId();
    const totalPages = computed(() => Math.max(1, Math.ceil(props.totalItems / props.pageSize)));
    const page = computed(() => Math.min(Math.max(1, props.currentPage), totalPages.value));
    const start = computed(() => (props.totalItems ? (page.value - 1) * props.pageSize + 1 : 0));
    const end = computed(() => Math.min(page.value * props.pageSize, props.totalItems));
    const pageInput = ref(1);
    watch(page, (value) => (pageInput.value = value), { immediate: true });
    const changePage = (value) => {
        const parsed = Number(value);
        const next = Number.isFinite(parsed)
            ? Math.min(Math.max(1, Math.trunc(parsed)), totalPages.value)
            : page.value;
        pageInput.value = next;
        if (!props.busy && next !== page.value) emit('change-page', next);
    };
    const buttons = computed(() => [
        {
            key: 'firstPage',
            target: 1,
            disabled: page.value === 1,
            path: 'M11 19l-7-7 7-7m8 14l-7-7 7-7',
        },
        {
            key: 'prevPage',
            target: page.value - 1,
            disabled: page.value === 1,
            path: 'M15 19l-7-7 7-7',
        },
        {
            key: 'nextPage',
            target: page.value + 1,
            disabled: page.value === totalPages.value,
            path: 'M9 5l7 7-7 7',
        },
        {
            key: 'lastPage',
            target: totalPages.value,
            disabled: page.value === totalPages.value,
            path: 'M13 5l7 7-7 7M5 5l7 7-7 7',
        },
    ]);
</script>

<template>
    <nav
        data-testid="groups-pagination"
        :aria-label="t('groupsPagination.navigation')"
        :aria-busy="busy"
        class="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-gray-200/80 bg-white/90 p-4 shadow-sm dark:border-white/10 dark:bg-gray-900/80"
    >
        <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            class="text-sm leading-6 text-gray-600 dark:text-gray-300 tabular-nums"
        >
            {{
                busy
                    ? t('groupsPagination.loading')
                    : t('groupsPagination.range', { start, end, total: totalItems })
            }}
        </p>
        <div
            class="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-end"
        >
            <div class="flex items-center gap-2">
                <label :for="selectId" class="text-sm text-gray-600 dark:text-gray-300">{{
                    t('groupsPagination.perPage')
                }}</label>
                <select
                    :id="selectId"
                    :value="pageSize"
                    :disabled="busy"
                    :aria-label="t('groupsPagination.pageSizeLabel')"
                    class="min-h-11 min-w-20 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
                    @change="emit('update:pageSize', Number($event.target.value))"
                >
                    <option v-for="size in GROUPS_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                        {{ size }}
                    </option>
                </select>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <template v-for="(button, index) in buttons" :key="button.key">
                    <div
                        v-if="index === 2"
                        class="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300 tabular-nums"
                    >
                        <input
                            v-model="pageInput"
                            type="number"
                            min="1"
                            :max="totalPages"
                            :disabled="busy || totalPages === 1"
                            :aria-label="t('common.pageNumber')"
                            class="page-input min-h-11 w-12 rounded-lg border border-gray-300 bg-white text-center text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
                            @keydown.enter="changePage(pageInput)"
                            @blur="changePage(pageInput)"
                        />
                        <span>/ {{ totalPages }}</span>
                    </div>
                    <button
                        type="button"
                        :aria-label="t(`common.${button.key}`)"
                        :title="t(`common.${button.key}`)"
                        :disabled="busy || button.disabled"
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none"
                        @click="changePage(button.target)"
                    >
                        <svg
                            aria-hidden="true"
                            class="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                :d="button.path"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />
                        </svg>
                    </button>
                </template>
            </div>
        </div>
    </nav>
</template>

<style scoped>
    .page-input {
        appearance: textfield;
        -moz-appearance: textfield;
    }
    .page-input::-webkit-inner-spin-button,
    .page-input::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
</style>
