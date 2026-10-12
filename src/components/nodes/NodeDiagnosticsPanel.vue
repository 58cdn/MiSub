<script setup>
    import { computed, ref } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import NodeDetectionPanel from './NodeDetectionPanel.vue';

    const props = defineProps({ node: { type: Object, required: true } });
    const emit = defineEmits(['close']);
    const { t } = useI18n();
    const backButton = ref(null);
    const snapshot = computed(() => ({
        ...props.node,
        id: String(props.node.id || 'preview-node'),
    }));
    defineExpose({ focusBack: () => backButton.value?.focus() });
</script>

<template>
    <section :aria-label="t('diagnostics.title')">
        <div class="flex items-start justify-between gap-3 text-gray-700 dark:text-gray-200">
            <h3 class="min-w-0 break-words font-semibold">
                {{ node.name || t('manualNodes.unnamed') }}
            </h3>
            <button
                ref="backButton"
                type="button"
                class="min-h-11 rounded-lg px-3 font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 dark:text-indigo-300 dark:hover:bg-white/10"
                @click="emit('close')"
            >
                {{ t('diagnostics.back') }}
            </button>
        </div>
        <NodeDetectionPanel
            :key="node.url"
            :nodes="[snapshot]"
            :selected-node-ids="[snapshot.id]"
            embedded
        />
    </section>
</template>
