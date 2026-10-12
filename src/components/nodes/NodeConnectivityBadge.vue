<script setup>
    import { computed } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import { connectivityMessage } from '@/utils/ping.js';
    const props = defineProps({ result: { type: Object, required: true } });
    const { t, locale } = useI18n();
    const label = computed(() => {
        if (props.result.status === 'ok') return `TCP ${props.result.latency} ms`;
        const key =
            {
                platform_restricted: 'connectivityRestrictedLabel',
                udp_not_applicable: 'connectivityUdpLabel',
                unsaved_node: 'connectivitySaveLabel',
                node_not_found: 'connectivitySaveLabel',
                rate_limited: 'connectivityRateLabel',
                dns_failed: 'connectivityDnsLabel',
                connect_failed: 'connectivityFailedLabel',
            }[props.result.code] ||
            {
                loading: 'pinging',
                timeout: 'connectivityTimeoutLabel',
                blocked: 'connectivityBlockedLabel',
                unsupported: 'connectivityUnsupportedLabel',
                cancelled: 'connectivityCancelledLabel',
            }[props.result.status] ||
            'unreachable';
        return t(`manualNodes.${key}`);
    });
    const detail = computed(
        () =>
            `${connectivityMessage(props.result)}${props.result.checkedAt ? ` · ${new Date(props.result.checkedAt).toLocaleString(locale.value)}` : ''}`
    );
</script>

<template>
    <span
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
        :class="
            result.status === 'ok'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
        "
        role="status"
        :title="detail"
        :aria-label="`${label}：${detail}`"
    >
        <span
            v-if="result.status === 'loading'"
            class="h-2 w-2 animate-pulse rounded-full bg-current"
            aria-hidden="true"
        ></span>
        {{ label }}
    </span>
</template>
