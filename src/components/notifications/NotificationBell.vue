<script setup>
    import { useNotificationsStore } from '../../stores/notifications.js';
    import { useI18n } from '../../i18n/index.js';
    const feed = useNotificationsStore();
    const { t } = useI18n();
</script>

<template>
    <button
        type="button"
        class="nav-action-btn nav-action-btn-neutral nav-action-focus relative"
        :title="t('notifications.title')"
        :aria-label="t('notifications.bell', { count: feed.unreadCount })"
        aria-haspopup="dialog"
        :aria-expanded="feed.opened"
        @click="feed.open()"
    >
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            class="size-5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        <span
            v-if="feed.unreadCount > 0"
            aria-hidden="true"
            class="absolute -top-1 -right-1 min-w-4 h-4 rounded-full bg-primary-700 text-white text-[10px] leading-4 px-1 text-center"
            >{{ feed.unreadCount > 99 ? '99+' : feed.unreadCount }}</span
        >
    </button>
</template>
