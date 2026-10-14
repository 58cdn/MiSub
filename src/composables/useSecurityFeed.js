import { ref } from 'vue';
import {
    fetchSecurityPage,
    readNotifications,
    securityErrorKind,
} from '../lib/admin-notifications.js';

export function useSecurityFeed(kind = 'notifications') {
    const items = ref([]);
    const enabled = ref(null);
    const unreadCount = ref(0);
    const nextCursor = ref(null);
    const cursors = ref([null]);
    const page = ref(0);
    const loading = ref(false);
    const saving = ref(false);
    const error = ref('');
    const readIds = ref([]);
    let epoch = 0;

    function reset() {
        epoch++;
        items.value = [];
        enabled.value = null;
        unreadCount.value = 0;
        nextCursor.value = null;
        cursors.value = [null];
        page.value = 0;
        loading.value = false;
        saving.value = false;
        error.value = '';
        readIds.value = [];
    }

    async function load(targetPage = page.value, cursor = cursors.value[targetPage]) {
        if (loading.value || saving.value) return false;
        const requestEpoch = epoch;
        loading.value = true;
        error.value = '';
        try {
            const data = await fetchSecurityPage(kind, cursor);
            if (requestEpoch !== epoch) return false;
            items.value = data.items;
            enabled.value = data.enabled;
            unreadCount.value = data.unreadCount;
            nextCursor.value = data.nextCursor;
            page.value = targetPage;
            cursors.value = [...cursors.value.slice(0, targetPage), cursor];
            readIds.value = [
                ...new Set([
                    ...readIds.value,
                    ...data.items.filter((item) => item.readAt != null).map((item) => item.id),
                ]),
            ];
            return true;
        } catch (cause) {
            if (requestEpoch !== epoch) return false;
            error.value = securityErrorKind(cause);
            if (error.value === 'forbidden') {
                items.value = [];
                unreadCount.value = 0;
                nextCursor.value = null;
                readIds.value = [];
                enabled.value = null;
            }
            return false;
        } finally {
            if (requestEpoch === epoch) loading.value = false;
        }
    }

    async function markRead(ids) {
        if (loading.value || saving.value || enabled.value !== true || error.value === 'forbidden')
            return false;
        const requestEpoch = epoch;
        saving.value = true;
        error.value = '';
        try {
            const result = await readNotifications(ids);
            if (requestEpoch !== epoch) return false;
            if (!result.enabled) {
                reset();
                enabled.value = false;
                return false;
            }
            readIds.value = [...new Set([...readIds.value, ...ids])];
            const newlyRead = items.value.filter(
                (item) => ids.includes(item.id) && item.readAt == null
            ).length;
            items.value = items.value.map((item) =>
                ids.includes(item.id) ? { ...item, readAt: item.readAt ?? Date.now() } : item
            );
            unreadCount.value = Math.max(0, unreadCount.value - newlyRead);
        } catch (cause) {
            if (requestEpoch !== epoch) return false;
            error.value = securityErrorKind(cause);
            if (error.value === 'forbidden') {
                items.value = [];
                unreadCount.value = 0;
                nextCursor.value = null;
                readIds.value = [];
                enabled.value = null;
            }
            return false;
        } finally {
            if (requestEpoch === epoch) saving.value = false;
        }
        if (requestEpoch !== epoch) return false;
        await load();
        return true;
    }

    return {
        items,
        enabled,
        unreadCount,
        nextCursor,
        page,
        loading,
        saving,
        error,
        readIds,
        reset,
        refresh: () => load(),
        latest: () => load(0, null),
        next: () => nextCursor.value !== null && load(page.value + 1, nextCursor.value),
        previous: () => page.value > 0 && load(page.value - 1, cursors.value[page.value - 1]),
        markRead,
    };
}
