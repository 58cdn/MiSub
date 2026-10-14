<script setup>
    import { computed } from 'vue';
    import { useI18n } from '../../i18n/index.js';
    import { formatSecurityTime, notificationDestination } from '../../lib/admin-notifications.js';
    import Button from '../ui/Button.vue';

    const props = defineProps({ feed: { type: Object, required: true }, audit: Boolean });
    const emit = defineEmits(['navigate']);
    const { t, locale } = useI18n();
    const unreadIds = computed(() =>
        props.feed.items.filter((item) => item.readAt == null).map((item) => item.id)
    );
    const state = computed(
        () => props.feed.error || (props.feed.enabled === false ? 'disabled' : '')
    );
    const busy = computed(() => props.feed.loading || props.feed.saving);
    const time = (value) => formatSecurityTime(value, locale.value);
    const title = (item) =>
        t(
            `notifications.${item.type === 'login_success' ? 'loginSuccess' : item.type === 'login_warning' ? 'loginWarning' : 'unknownEvent'}`
        );
</script>

<template>
    <section
        :aria-label="t(audit ? 'notifications.auditTitle' : 'notifications.messages')"
        :aria-busy="busy"
    >
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
            <p class="text-sm text-gray-600 dark:text-gray-300" role="status">
                {{
                    audit
                        ? t('notifications.scope')
                        : t('notifications.unreadCount', { count: feed.unreadCount })
                }}
            </p>
            <Button variant="secondary" class="min-h-11" :disabled="busy" @click="feed.latest()">{{
                t('notifications.refresh')
            }}</Button>
        </div>

        <div
            v-if="state"
            class="p-4 mb-4 border border-amber-200 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/40 rounded-xl text-amber-950 dark:text-amber-100"
            :role="feed.error ? 'alert' : 'status'"
        >
            <h3 class="font-semibold">{{ t(`notifications.${state}`) }}</h3>
            <p class="mt-2 text-sm leading-6">{{ t(`notifications.${state}Hint`) }}</p>
            <Button
                v-if="feed.error"
                variant="secondary"
                class="mt-3 min-h-11"
                :disabled="busy"
                @click="feed.refresh()"
                >{{ t('notifications.retry') }}</Button
            >
        </div>
        <p v-if="feed.loading" class="py-4 text-sm text-gray-600 dark:text-gray-300" role="status">
            {{ t('notifications.loading') }}
        </p>
        <div v-else-if="!state && !feed.items.length" class="py-12 px-4 text-center">
            <h3 class="font-semibold text-gray-900 dark:text-gray-100">
                {{ t(audit ? 'notifications.auditEmpty' : 'notifications.empty') }}
            </h3>
            <p class="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
                {{ t(audit ? 'notifications.auditEmptyHint' : 'notifications.emptyHint') }}
            </p>
        </div>

        <ol class="divide-y divide-gray-200 dark:divide-white/10">
            <li
                v-for="item in feed.items"
                :key="item.id"
                class="py-5 first:pt-1 break-words"
                :data-event-id="item.id"
            >
                <article>
                    <div class="flex flex-wrap items-center gap-2">
                        <h3 class="font-semibold text-gray-900 dark:text-gray-100">
                            {{ title(item) }}
                        </h3>
                        <span
                            v-if="!audit"
                            class="rounded-full px-2 py-0.5 text-xs font-medium"
                            :class="
                                item.readAt == null
                                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-200'
                                    : 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-400'
                            "
                            >{{
                                t(
                                    item.readAt == null
                                        ? 'notifications.unread'
                                        : 'notifications.read'
                                )
                            }}</span
                        >
                    </div>
                    <p class="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
                        {{ time(item.createdAt) }}
                    </p>
                    <p
                        v-if="item.type === 'login_warning'"
                        class="mt-3 text-sm leading-6 text-amber-800 dark:text-amber-200"
                    >
                        {{
                            t('notifications.failureSummary', {
                                count: item.failedAttempts ?? t('notifications.unknown'),
                            })
                        }}
                    </p>
                    <dl class="mt-3 space-y-2 text-sm leading-6">
                        <template v-if="item.type === 'login_success'">
                            <div>
                                <dt class="text-gray-500 dark:text-gray-400">
                                    {{ t('notifications.ip') }}
                                </dt>
                                <dd class="text-gray-800 dark:text-gray-200 break-all">
                                    {{ item.ip || t('notifications.unknown') }}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-gray-500 dark:text-gray-400">
                                    {{ t('notifications.device') }}
                                </dt>
                                <dd class="text-gray-800 dark:text-gray-200">
                                    {{
                                        [item.browser, item.os, item.device]
                                            .map((value) => value || t('notifications.unknown'))
                                            .join(' / ')
                                    }}
                                </dd>
                            </div>
                        </template>
                        <template v-else-if="item.type === 'login_warning'">
                            <div>
                                <dt class="text-gray-500 dark:text-gray-400">
                                    {{ t('notifications.since') }}
                                </dt>
                                <dd>{{ time(item.since) }}</dd>
                            </div>
                            <div>
                                <dt class="text-gray-500 dark:text-gray-400">
                                    {{ t('notifications.lastFailure') }}
                                </dt>
                                <dd>{{ time(item.lastFailureAt) }}</dd>
                            </div>
                        </template>
                    </dl>
                    <div v-if="!audit" class="mt-3 flex flex-wrap gap-2 items-center">
                        <Button
                            variant="secondary"
                            class="min-h-11"
                            :disabled="busy || item.readAt != null || Boolean(feed.error)"
                            :aria-label="`${t('notifications.markRead')}: ${title(item)} ${time(item.createdAt)}`"
                            @click="feed.markRead([item.id])"
                            >{{
                                t(
                                    item.readAt == null
                                        ? 'notifications.markRead'
                                        : 'notifications.read'
                                )
                            }}</Button
                        >
                        <router-link
                            v-if="notificationDestination(item.target)"
                            :to="notificationDestination(item.target)"
                            class="inline-flex items-center min-h-11 px-3 rounded-lg text-sm font-medium text-primary-700 dark:text-primary-300 hover:underline focus-visible:outline-2 focus-visible:outline-primary-500"
                            @click="emit('navigate')"
                            >{{ t('notifications.details') }}</router-link
                        >
                    </div>
                </article>
            </li>
        </ol>

        <Button
            v-if="!audit && feed.items.length"
            variant="secondary"
            class="w-full min-h-11 mt-3"
            :disabled="busy || !unreadIds.length || Boolean(feed.error)"
            @click="feed.markRead(unreadIds)"
            >{{ t(feed.saving ? 'notifications.marking' : 'notifications.markPage') }}</Button
        >
        <nav
            v-if="feed.items.length || feed.page > 0"
            :aria-label="t('notifications.messages')"
            class="flex flex-wrap items-center justify-between gap-2 mt-5 border-t border-gray-200 dark:border-white/10 pt-4"
        >
            <Button
                variant="secondary"
                class="min-h-11"
                :disabled="busy || feed.page === 0"
                @click="feed.previous()"
                >{{ t('notifications.previous') }}</Button
            >
            <span class="text-xs text-gray-600 dark:text-gray-400" role="status">{{
                t('notifications.page', { page: feed.page + 1 })
            }}</span>
            <Button
                variant="secondary"
                class="min-h-11"
                :disabled="busy || !feed.nextCursor"
                @click="feed.next()"
                >{{ t('notifications.next') }}</Button
            >
        </nav>
    </section>
</template>
