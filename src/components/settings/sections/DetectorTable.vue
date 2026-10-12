<script setup>
    import { nextTick } from 'vue';
    import { useI18n } from '@/i18n/index.js';

    defineProps({
        agents: { type: Array, required: true },
        columns: { type: Array, required: true },
        sort: { type: String, required: true },
        direction: { type: String, required: true },
        busy: Boolean,
        agentStatus: { type: Function, required: true },
        agentStale: { type: Function, required: true },
        date: { type: Function, required: true },
        iso: { type: Function, required: true },
    });
    defineEmits(['sort', 'history', 'revoke', 'archive', 'restore']);
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    function keepFocusVisible(event) {
        const target = event.target,
            scroller = event.currentTarget;
        nextTick(() => {
            if (!target?.isConnected || document.activeElement !== target) return;
            const cell = target.closest('th,td'),
                name = scroller.querySelector('thead .detector-name-cell'),
                actions = scroller.querySelector('thead .detector-actions-cell');
            if (
                !cell ||
                !name ||
                !actions ||
                getComputedStyle(name).position !== 'sticky' ||
                getComputedStyle(cell).position === 'sticky'
            )
                return;
            const rect = target.getBoundingClientRect(),
                left = name.getBoundingClientRect().right + 8,
                right = actions.getBoundingClientRect().left - 8;
            if (rect.left < left) scroller.scrollLeft += rect.left - left;
            else if (rect.right > right) scroller.scrollLeft += rect.right - right;
        });
    }
</script>

<template>
    <div class="space-y-2 min-w-0">
        <p id="detector-table-help" class="text-xs text-gray-600 dark:text-gray-400">
            {{
                L(
                    '表格可横向滚动；键盘聚焦表格区域后可用左右方向键。名称和操作列不可隐藏。',
                    'Scroll the table horizontally; focus the table region to use the arrow keys. Name and actions cannot be hidden.'
                )
            }}
        </p>
        <div
            data-testid="detector-table-scroll"
            class="detector-table-scroll"
            role="region"
            tabindex="0"
            :aria-label="L('检测器列表，可横向滚动', 'Detector list, horizontally scrollable')"
            aria-describedby="detector-table-help"
            @focusin="keepFocusVisible"
        >
            <table
                data-testid="detector-table"
                class="w-full border-separate border-spacing-0 text-left text-sm"
            >
                <caption class="sr-only">
                    {{
                        L('检测器及通信状态', 'Detectors and communication states')
                    }}
                </caption>
                <thead>
                    <tr>
                        <th
                            scope="col"
                            class="detector-name-cell"
                            :aria-sort="
                                sort === 'name'
                                    ? direction === 'asc'
                                        ? 'ascending'
                                        : 'descending'
                                    : 'none'
                            "
                        >
                            <button
                                type="button"
                                data-testid="detector-sort-name"
                                class="detector-sort"
                                @click="$emit('sort', 'name')"
                            >
                                {{ L('名称', 'Name')
                                }}<span aria-hidden="true">{{
                                    sort === 'name' ? (direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'
                                }}</span>
                            </button>
                        </th>
                        <th
                            v-for="column in columns"
                            :key="column.key"
                            scope="col"
                            :data-column="column.key"
                            :aria-sort="
                                column.sortable
                                    ? sort === column.key
                                        ? direction === 'asc'
                                            ? 'ascending'
                                            : 'descending'
                                        : 'none'
                                    : undefined
                            "
                        >
                            <button
                                v-if="column.sortable"
                                type="button"
                                :data-testid="`detector-sort-${column.key}`"
                                class="detector-sort"
                                @click="$emit('sort', column.key)"
                            >
                                {{ column.label
                                }}<span aria-hidden="true">{{
                                    sort === column.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'
                                }}</span>
                            </button>
                            <span v-else>{{ column.label }}</span>
                        </th>
                        <th scope="col" class="detector-actions-cell">
                            {{ L('操作', 'Actions') }}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="agent in agents"
                        :key="agent.id"
                        :data-testid="`detector-row-${agent.id}`"
                    >
                        <th scope="row" class="detector-name-cell">
                            <span
                                class="detector-long-text font-semibold text-gray-900 dark:text-white"
                                >{{ agent.name }}</span
                            ><span
                                v-if="agent.hidden"
                                class="mt-1 block text-xs font-normal text-gray-600 dark:text-gray-400"
                                >{{ L('已删除 · 可恢复', 'Deleted · restorable') }}</span
                            >
                        </th>
                        <td v-for="column in columns" :key="column.key" :data-column="column.key">
                            <span
                                v-if="column.key === 'status'"
                                class="inline-block rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium dark:bg-gray-700"
                                :class="{
                                    'text-emerald-700 dark:text-emerald-300':
                                        agent.status === 'online' && !agentStale(agent),
                                }"
                                >{{ agentStatus(agent) }}</span
                            >
                            <span v-else-if="column.key === 'version'" class="detector-long-text">{{
                                [agent.version, agent.platform].filter(Boolean).join(' · ') ||
                                L('未知', 'Unknown')
                            }}</span>
                            <span v-else-if="column.key === 'capabilities'">{{
                                L('未知（尚未上报）', 'Unknown (not reported)')
                            }}</span>
                            <span v-else-if="column.key === 'lastHeartbeatAt'">{{
                                L('未知（未单独记录）', 'Unknown (not recorded separately)')
                            }}</span>
                            <time v-else :datetime="iso(agent[column.key])">{{
                                date(agent[column.key])
                            }}</time>
                        </td>
                        <td class="detector-actions-cell">
                            <div class="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    :data-testid="`detector-history-${agent.id}`"
                                    class="detector-table-button"
                                    :aria-label="L('查看检测记录：', 'View history: ') + agent.name"
                                    @click="$emit('history', agent, $event)"
                                >
                                    {{ L('记录', 'History') }}
                                </button>
                                <button
                                    v-if="agent.hidden"
                                    type="button"
                                    :data-testid="`detector-restore-${agent.id}`"
                                    class="detector-table-button"
                                    :disabled="busy"
                                    :aria-label="L('恢复：', 'Restore: ') + agent.name"
                                    @click="$emit('restore', agent)"
                                >
                                    {{ L('恢复', 'Restore') }}
                                </button>
                                <button
                                    v-else-if="agent.revokedAt || agent.status === 'revoked'"
                                    type="button"
                                    :data-testid="`detector-archive-${agent.id}`"
                                    class="detector-table-button text-red-700 dark:text-red-300"
                                    :disabled="busy"
                                    :aria-label="L('删除：', 'Delete: ') + agent.name"
                                    @click="$emit('archive', agent)"
                                >
                                    {{ L('删除', 'Delete') }}
                                </button>
                                <button
                                    v-else
                                    type="button"
                                    :data-testid="`detector-revoke-${agent.id}`"
                                    class="detector-table-button text-red-700 dark:text-red-300"
                                    :disabled="busy"
                                    :aria-label="L('撤销：', 'Revoke: ') + agent.name"
                                    @click="$emit('revoke', agent)"
                                >
                                    {{ L('撤销', 'Revoke') }}
                                </button>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<style scoped>
    @reference '../../../assets/main.css';
    .detector-table-scroll {
        @apply max-w-full overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900;
    }
    th,
    td {
        @apply border-b border-gray-200 px-4 py-3 align-top dark:border-gray-700;
        min-width: 11rem;
    }
    thead th {
        @apply bg-gray-50 font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200;
        vertical-align: middle;
    }
    tbody tr:last-child > * {
        border-bottom: 0;
    }
    tbody tr > * {
        @apply bg-white dark:bg-gray-900;
    }
    .detector-name-cell {
        width: 16rem;
    }
    .detector-actions-cell {
        min-width: 13rem;
        width: 13rem;
    }
    .detector-long-text {
        display: block;
        max-width: 20rem;
        min-width: 9rem;
        overflow-wrap: anywhere;
    }
    .detector-sort {
        @apply flex min-h-11 w-full items-center justify-between gap-2 rounded text-left;
    }
    .detector-table-button {
        @apply inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700;
    }
    button:focus-visible,
    .detector-table-scroll:focus-visible {
        @apply outline outline-2 outline-offset-2 outline-indigo-500;
    }
    @media (min-width: 1024px) {
        .detector-name-cell {
            position: sticky;
            left: 0;
            z-index: 1;
        }
        .detector-actions-cell {
            position: sticky;
            right: 0;
            z-index: 1;
        }
        .detector-table-scroll {
            scroll-padding-inline: 17rem 14rem;
        }
    }
</style>
