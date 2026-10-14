<script setup>
    import { reactive, onMounted, onBeforeUnmount } from 'vue';
    import { useI18n } from '../i18n/index.js';
    import { useSecurityFeed } from '../composables/useSecurityFeed.js';
    import SecurityFeed from '../components/notifications/SecurityFeed.vue';
    const { t } = useI18n();
    const feed = reactive(useSecurityFeed('audit'));
    onMounted(() => feed.latest());
    onBeforeUnmount(() => feed.reset());
</script>

<template>
    <div class="max-w-3xl mx-auto">
        <router-link
            to="/dashboard"
            class="inline-flex items-center min-h-11 mb-3 text-sm text-primary-700 dark:text-primary-300 rounded-lg focus-visible:outline-2 focus-visible:outline-primary-500"
            >{{ t('notifications.back') }}</router-link
        >
        <header class="mb-6">
            <h1 class="text-2xl font-bold">{{ t('notifications.auditTitle') }}</h1>
            <p class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
                {{ t('notifications.auditSubtitle') }}
            </p>
        </header>
        <div
            class="p-5 sm:p-6 bg-white dark:bg-white/[0.025] border border-gray-200 dark:border-white/10 misub-radius-lg"
        >
            <SecurityFeed :feed="feed" audit />
            <p class="mt-6 text-xs leading-5 text-gray-500 dark:text-gray-400">
                {{ t('notifications.retention') }}
            </p>
        </div>
    </div>
</template>
