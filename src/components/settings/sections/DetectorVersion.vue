<script setup>
    import { computed } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import { probeVersionIdentity } from '@/shared/probe-version.js';
    const props = defineProps({
        version: { type: String, default: '' },
        platform: { type: String, default: '' },
    });
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const identity = computed(() => probeVersionIdentity(props.version, null));
</script>
<template>
    <span class="detector-long-text" data-testid="detector-version-identity">
        <span>{{ [version, platform].filter(Boolean).join(' · ') || L('未知', 'Unknown') }}</span>
        <small
            v-if="identity.migrationRequired"
            class="block"
            data-testid="detector-version-migration"
            >{{
                L('历史版本线 · 待迁移验收', 'Historical line · migration acceptance required')
            }}</small
        >
        <small v-else-if="identity.channel === 'testing'" class="block">{{
            L('Alpha 测试版本', 'Alpha test version')
        }}</small>
    </span>
</template>
