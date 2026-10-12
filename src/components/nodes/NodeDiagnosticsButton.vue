<script setup>
    import { ref } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import Modal from '../forms/Modal.vue';
    import NodeDiagnosticsPanel from './NodeDiagnosticsPanel.vue';
    defineProps({ node: { type: Object, required: true } });
    const show = ref(false);
    const { t } = useI18n();
</script>
<template>
    <button
        type="button"
        class="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 dark:text-indigo-300 dark:hover:bg-white/10"
        @click.stop="show = true"
    >
        {{ t('diagnostics.action') }}
    </button>
    <Modal :show="show" size="4xl" @update:show="show = $event">
        <template #title
            ><h2 class="font-bold text-gray-900 dark:text-white">
                {{ t('diagnostics.title') }}
            </h2></template
        >
        <template #body
            ><NodeDiagnosticsPanel v-if="show" :node="node" @close="show = false"
        /></template>
        <template #footer
            ><button
                type="button"
                class="min-h-11 rounded-lg px-4 text-gray-700 dark:text-gray-200"
                @click="show = false"
            >
                {{ t('diagnostics.back') }}
            </button></template
        >
    </Modal>
</template>
