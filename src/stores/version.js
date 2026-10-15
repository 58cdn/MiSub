import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { fetchGithubLatestRelease } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { useToastStore } from './toast.js';
import { readRawPreference, writeRawPreference } from '../utils/local-preference.js';
import { APP_BUILD } from '../utils/app-build.js';
import { productFromTag, selectTestRelease, versionTransition } from '../shared/product-version.js';

export const useVersionStore = defineStore('version', () => {
    const currentVersion = ref(APP_BUILD.productVersion);
    const build = APP_BUILD;
    const latestRelease = ref(null);
    const checkState = ref('unchecked');
    const showModal = ref(false);
    const showUpdateNotice = ref(false);
    const localChangelog =
        'MiSub alpha 测试通道。产品版本与构建源码分别展示；发布和真实安装验收状态以对应测试发行记录为准。';
    const transition = computed(() =>
        latestRelease.value
            ? versionTransition(currentVersion.value, productFromTag(latestRelease.value.tag_name))
            : 'unknown'
    );
    const hasUpdate = computed(() => transition.value === 'update');
    const migrationRequired = computed(() => transition.value === 'migration_required');
    const isUpToDate = computed(
        () => checkState.value === 'checked' && transition.value === 'current'
    );
    const getDismissKey = (tag) => `misub_release_notes_hidden:${currentVersion.value}:${tag}`;

    async function checkVersion(suppressModal = false) {
        checkState.value = 'checking';
        latestRelease.value = null;
        showUpdateNotice.value = false;
        try {
            const result = await fetchGithubLatestRelease('58cdn/MiSub');
            if (
                result?.rate_limited ||
                result?.stale ||
                result?.error ||
                result?.success === false
            ) {
                checkState.value = 'unavailable';
                return;
            }
            latestRelease.value = selectTestRelease([result]);
            checkState.value = latestRelease.value ? 'checked' : 'no_release';
            showUpdateNotice.value = hasUpdate.value || migrationRequired.value;
            if (
                isUpToDate.value &&
                !suppressModal &&
                readRawPreference(getDismissKey(result.tag_name)) !== 'true'
            )
                showModal.value = true;
        } catch {
            checkState.value = 'unavailable';
        }
    }
    function suppressUpdateModal() {
        if (
            latestRelease.value &&
            !writeRawPreference(getDismissKey(latestRelease.value.tag_name), 'true')
        )
            useToastStore().showToast(t('errors.preferenceNotSaved'), 'error');
        showModal.value = false;
    }
    return {
        currentVersion,
        build,
        latestRelease,
        checkState,
        transition,
        migrationRequired,
        localChangelog,
        showModal,
        showUpdateNotice,
        hasUpdate,
        isUpToDate,
        checkVersion,
        openModal: () => {
            showModal.value = true;
        },
        closeModal: () => {
            showModal.value = false;
        },
        suppressUpdateModal,
    };
});
