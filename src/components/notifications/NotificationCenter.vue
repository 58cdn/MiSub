<script setup>
    import { ref, watch, onBeforeUnmount } from 'vue';
    import { useRoute } from 'vue-router';
    import { useNotificationsStore } from '../../stores/notifications.js';
    import { useI18n } from '../../i18n/index.js';
    import { notificationDestination } from '../../lib/admin-notifications.js';
    import SecurityFeed from './SecurityFeed.vue';

    const feed = useNotificationsStore();
    const { t } = useI18n();
    const route = useRoute();
    const dialog = ref(null);
    let oldOverflow = null;
    function close() {
        feed.opened = false;
    }
    function trapFocus(event) {
        if (event.key !== 'Tab') return;
        const elements = [
            ...dialog.value.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]'),
        ].filter((element) => element.getClientRects().length);
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    }
    function unlockScroll() {
        if (oldOverflow !== null) document.body.style.overflow = oldOverflow;
        oldOverflow = null;
    }
    watch(
        () => feed.opened,
        (opened) => {
            if (opened) {
                oldOverflow = document.body.style.overflow;
                dialog.value?.showModal();
                document.body.style.overflow = 'hidden';
            } else {
                dialog.value?.close();
                unlockScroll();
            }
        },
        { flush: 'post' }
    );
    watch(() => route.fullPath, close);
    onBeforeUnmount(() => {
        dialog.value?.close();
        unlockScroll();
    });
</script>

<template>
    <Teleport to="body">
        <dialog
            ref="dialog"
            aria-labelledby="notification-center-title"
            class="notification-dialog text-gray-800 dark:text-gray-200 bg-white dark:bg-slate-950"
            @cancel.prevent="close"
            @close="close"
            @keydown="trapFocus"
            @click="
                (event) => {
                    if (event.target === dialog) close();
                }
            "
        >
            <div class="flex flex-col h-full">
                <header
                    class="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-white/10 shrink-0"
                >
                    <div>
                        <h2 id="notification-center-title" class="text-xl font-semibold">
                            {{ t('notifications.title') }}
                        </h2>
                        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {{ t('notifications.scope') }}
                        </p>
                    </div>
                    <button
                        type="button"
                        autofocus
                        class="flex items-center justify-center size-11 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary-500"
                        :aria-label="t('notifications.close')"
                        @click="close"
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            class="size-5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path d="m6 6 12 12M6 18 18 6" />
                        </svg>
                    </button>
                </header>
                <div class="overflow-y-auto overscroll-contain px-5 py-5 grow">
                    <nav
                        :aria-label="t('notifications.shortcuts')"
                        class="mb-6 border-b border-gray-200 dark:border-white/10 pb-5"
                    >
                        <h3 class="text-sm font-semibold mb-2">
                            {{ t('notifications.shortcuts') }}
                        </h3>
                        <div class="flex flex-wrap gap-2">
                            <router-link
                                v-for="target in ['security', 'system', 'detectors']"
                                :key="target"
                                :to="notificationDestination(target)"
                                class="inline-flex items-center min-h-11 px-3 rounded-lg border border-gray-200 dark:border-white/10 text-sm hover:bg-gray-50 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary-500"
                                @click="close"
                                >{{ t(`notifications.${target}`) }}</router-link
                            >
                        </div>
                    </nav>
                    <SecurityFeed :feed="feed" @navigate="close" />
                    <p class="mt-6 text-xs leading-5 text-gray-500 dark:text-gray-400">
                        {{ t('notifications.retention') }}
                    </p>
                </div>
            </div>
        </dialog>
    </Teleport>
</template>

<style scoped>
    .notification-dialog {
        position: fixed;
        inset: 0 0 0 auto;
        margin: 0;
        padding: 0;
        border: 0;
        width: min(100%, 30rem);
        max-width: 100%;
        height: 100dvh;
        max-height: 100dvh;
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        box-shadow: -12px 0 40px rgb(0 0 0 / 12%);
    }
    .notification-dialog::backdrop {
        background: rgb(0 0 0 / 40%);
    }
</style>
