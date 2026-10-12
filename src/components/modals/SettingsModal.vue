<script setup>
    import { useI18n } from '../../i18n/index.js';

    const { t } = useI18n();
    import { ref } from 'vue';
    import { useRouter } from 'vue-router';
    import Modal from '../forms/Modal.vue';
    import SettingsPanel from './SettingsPanel.vue';

    const props = defineProps({
        show: Boolean,
        exportBackup: Function,
        importBackup: Function,
    });

    const emit = defineEmits(['update:show']);

    const settingsPanelRef = ref(null);
    const router = useRouter();
    const navigationError = ref(false);

    async function openDetectorSettings() {
        navigationError.value = false;
        try {
            const failure = await router.push('/dashboard/settings?focus=detectors');
            if (failure) navigationError.value = true;
            else emit('update:show', false);
        } catch {
            navigationError.value = true;
        }
    }

    const handleConfirm = async () => {
        if (!settingsPanelRef.value) return;

        const didSave = await settingsPanelRef.value.handleSave();
        if (didSave) {
            emit('update:show', false);
        }
    };
</script>

<template>
    <Modal
        :show="show"
        @update:show="emit('update:show', $event)"
        @confirm="handleConfirm"
        :close-on-confirm="false"
        size="6xl"
    >
        <template #title>
            <div
                class="bg-white/80 dark:bg-gray-900/60 border border-gray-100/80 dark:border-white/10 misub-radius-lg px-4 py-2"
            >
                <h3 class="text-lg font-bold text-gray-800 dark:text-white">
                    {{ t('settings.title') }}
                </h3>
            </div>
        </template>
        <template #body>
            <p
                v-if="navigationError"
                role="alert"
                class="mb-3 text-sm text-red-600 dark:text-red-400"
            >
                {{ t('settings.detectorNavigationError') }}
            </p>
            <SettingsPanel
                ref="settingsPanelRef"
                :export-backup="props.exportBackup"
                :import-backup="props.importBackup"
                @open-detector-settings="openDetectorSettings"
            />
        </template>
    </Modal>
</template>
