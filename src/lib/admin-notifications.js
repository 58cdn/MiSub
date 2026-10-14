import { api, APIError } from './http.js';

export const NOTIFICATION_PAGE_SIZE = 20;

const destinations = Object.freeze({
    security: '/dashboard/security',
    system: '/dashboard/settings',
    detectors: '/dashboard/settings?focus=detectors',
});

export function notificationDestination(target) {
    return typeof target === 'string' && Object.hasOwn(destinations, target)
        ? destinations[target]
        : null;
}

export function validEventId(value) {
    return Number.isSafeInteger(value) && value > 0;
}

export async function fetchSecurityPage(kind = 'notifications', before = null) {
    const endpoint = kind === 'audit' ? 'login-audit' : 'notifications';
    const query = new URLSearchParams({ limit: String(NOTIFICATION_PAGE_SIZE) });
    if (validEventId(before)) query.set('before', String(before));
    const data = await api.get(`/api/admin/${endpoint}?${query}`);
    if (
        data?.success !== true ||
        typeof data.enabled !== 'boolean' ||
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.unreadCount) ||
        data.unreadCount < 0 ||
        (data.nextCursor !== null && !validEventId(data.nextCursor)) ||
        (before !== null && data.nextCursor !== null && data.nextCursor >= before) ||
        data.items.length > NOTIFICATION_PAGE_SIZE ||
        data.items.some((item) => !validEventId(item?.id))
    ) {
        throw new APIError('Invalid notification response', 502);
    }
    return {
        ...data,
        items: data.enabled ? [...new Map(data.items.map((item) => [item.id, item])).values()] : [],
        unreadCount: data.enabled ? data.unreadCount : 0,
        nextCursor: data.enabled ? data.nextCursor : null,
    };
}

export async function readNotifications(ids) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length > 50 || uniqueIds.some((id) => !validEventId(id))) {
        throw new Error('Invalid notification IDs');
    }
    const data = await api.post('/api/admin/notifications/read', { ids: uniqueIds });
    if (data?.success !== true || typeof data.enabled !== 'boolean') {
        throw new APIError('Invalid read response', 502);
    }
    return data;
}

export function securityErrorKind(error) {
    if (error?.status === 401 || error?.status === 403) return 'forbidden';
    if (error?.status === 404 || error?.status === 501) return 'unavailable';
    return 'error';
}

export function formatSecurityTime(value, locale) {
    if (value === null || value === undefined || value === '') return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale);
}

export function loginRetryDeadline(data, now = Date.now()) {
    const seconds = Number(data?.retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return now + Math.ceil(seconds) * 1000;
    const until = new Date(data?.lockedUntil).getTime();
    return Number.isFinite(until) && until > now ? until : 0;
}
