import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, APIError } from '../../src/lib/http.js';
import {
    fetchSecurityPage,
    readNotifications,
    notificationDestination,
    loginRetryDeadline,
    formatSecurityTime,
} from '../../src/lib/admin-notifications.js';
import { useSecurityFeed } from '../../src/composables/useSecurityFeed.js';

const event = (id, readAt = null) => ({
    id,
    readAt,
    type: 'login_success',
    createdAt: 1791896200000,
    target: 'security',
});
const page = (items = [event(21)], nextCursor = null) => ({
    success: true,
    enabled: true,
    items,
    unreadCount: 3,
    nextCursor,
});
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

describe('administrator notification contract', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it('uses cursor pagination and a fixed endpoint for audit', async () => {
        const get = vi.spyOn(api, 'get').mockResolvedValue(page());
        await fetchSecurityPage('notifications', 30);
        await fetchSecurityPage('audit');
        expect(get.mock.calls).toEqual([
            ['/api/admin/notifications?limit=20&before=30'],
            ['/api/admin/login-audit?limit=20'],
        ]);
    });
    it.each([
        {},
        { success: false },
        { enabled: null },
        { unreadCount: -1 },
        { nextCursor: '2' },
        { items: [{ id: '1' }] },
    ])('rejects malformed responses %j', async (override) => {
        vi.spyOn(api, 'get').mockResolvedValue(
            Object.keys(override).length ? { ...page(), ...override } : {}
        );
        await expect(fetchSecurityPage()).rejects.toMatchObject({ status: 502 });
    });
    it('rejects cursors that would repeat pages', async () => {
        vi.spyOn(api, 'get').mockResolvedValue(page([event(9)], 10));
        await expect(fetchSecurityPage('notifications', 10)).rejects.toThrow();
    });
    it('deduplicates IDs and does not expose stale events when disabled', async () => {
        vi.spyOn(api, 'get')
            .mockResolvedValueOnce(page([event(21), event(21)]))
            .mockResolvedValueOnce({ ...page(), enabled: false });
        expect((await fetchSecurityPage()).items).toHaveLength(1);
        expect(await fetchSecurityPage()).toMatchObject({
            items: [],
            unreadCount: 0,
            nextCursor: null,
        });
    });
    it('only sends explicit unique IDs by POST', async () => {
        const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true, enabled: true });
        await readNotifications([4, 4, 5]);
        expect(post).toHaveBeenCalledWith('/api/admin/notifications/read', { ids: [4, 5] });
        await expect(
            readNotifications(Array.from({ length: 51 }, (_, i) => i + 1))
        ).rejects.toThrow();
        await expect(readNotifications(['4'])).rejects.toThrow();
        expect(post).toHaveBeenCalledTimes(1);
    });
    it.each([
        'https://evil.test',
        '//evil.test',
        'javascript:alert(1)',
        '/dashboard',
        '__proto__',
        'constructor',
        { target: 'security' },
    ])('refuses unsafe targets %j', (target) => {
        expect(notificationDestination(target)).toBeNull();
    });
    it('maps only fixed internal destinations', () => {
        expect(notificationDestination('security')).toBe('/dashboard/security');
        expect(notificationDestination('detectors')).toBe('/dashboard/settings?focus=detectors');
    });
    it('uses relative retry seconds despite client clock skew and supports absolute fallback', () => {
        expect(loginRetryDeadline({ retryAfter: 600, lockedUntil: 1 }, 1000)).toBe(601000);
        expect(loginRetryDeadline({ lockedUntil: 4000 }, 1000)).toBe(4000);
        expect(loginRetryDeadline({}, 1000)).toBe(0);
        expect(formatSecurityTime('bad-date', 'en-US')).toBe('—');
    });
});

describe('notification feed state', () => {
    it('clears events when acknowledgement reports disabled without claiming read success', async () => {
        const get = vi
            .spyOn(api, 'get')
            .mockResolvedValueOnce(page())
            .mockRejectedValue(new Error('offline'));
        vi.spyOn(api, 'post').mockResolvedValue({ success: true, enabled: false });
        const feed = useSecurityFeed();
        await feed.latest();
        expect(await feed.markRead([21])).toBe(false);
        expect(feed.enabled.value).toBe(false);
        expect(feed.items.value).toEqual([]);
        expect(feed.readIds.value).toEqual([]);
        expect(feed.unreadCount.value).toBe(0);
        expect(get).toHaveBeenCalledTimes(1);
    });
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it('moves between cursor pages, refreshing the first page explicitly', async () => {
        const get = vi
            .spyOn(api, 'get')
            .mockResolvedValueOnce(page([event(21)], 21))
            .mockResolvedValueOnce(page([event(20)], 20))
            .mockResolvedValueOnce(page([event(22)], 22));
        const feed = useSecurityFeed();
        await feed.latest();
        await feed.next();
        expect(feed.page.value).toBe(1);
        await feed.previous();
        expect(feed.items.value[0].id).toBe(22);
        expect(get.mock.calls.map((args) => args[0])).toEqual([
            '/api/admin/notifications?limit=20',
            '/api/admin/notifications?limit=20&before=21',
            '/api/admin/notifications?limit=20',
        ]);
    });
    it('retains the page and unread state on failed requests', async () => {
        vi.spyOn(api, 'get')
            .mockResolvedValueOnce(page([event(21)], 21))
            .mockRejectedValue(new Error('offline'));
        vi.spyOn(api, 'post').mockRejectedValue(new Error('offline'));
        const feed = useSecurityFeed();
        await feed.latest();
        await feed.next();
        expect(feed.page.value).toBe(0);
        expect(feed.nextCursor.value).toBe(21);
        await feed.markRead([21]);
        expect(feed.items.value[0].readAt).toBeNull();
        expect(feed.unreadCount.value).toBe(3);
    });
    it('only confirms read after POST success and refreshes the server count', async () => {
        vi.spyOn(api, 'get')
            .mockResolvedValueOnce(page())
            .mockResolvedValueOnce({ ...page([event(21, 10)]), unreadCount: 8 });
        const pending = deferred();
        vi.spyOn(api, 'post').mockReturnValue(pending.promise);
        const feed = useSecurityFeed();
        await feed.latest();
        const write = feed.markRead([21]);
        expect(feed.items.value[0].readAt).toBeNull();
        pending.resolve({ success: true, enabled: true });
        await write;
        expect(feed.readIds.value).toEqual([21]);
        expect(feed.unreadCount.value).toBe(8);
    });
    it.each([401, 403])('clears sensitive events on permission error %s', async (status) => {
        vi.spyOn(api, 'get')
            .mockResolvedValueOnce(page())
            .mockRejectedValue(new APIError('denied', status));
        const feed = useSecurityFeed();
        await feed.latest();
        await feed.refresh();
        expect(feed.items.value).toEqual([]);
        expect(feed.unreadCount.value).toBe(0);
        expect(feed.error.value).toBe('forbidden');
    });
    it('distinguishes absent APIs from disabled storage', async () => {
        vi.spyOn(api, 'get').mockRejectedValue(new APIError('missing', 404));
        const feed = useSecurityFeed();
        await feed.latest();
        expect(feed.error.value).toBe('unavailable');
        expect(feed.enabled.value).toBeNull();
    });
    it('does not restore sensitive data after reset while a read is pending', async () => {
        const pending = deferred();
        vi.spyOn(api, 'get').mockReturnValue(pending.promise);
        const feed = useSecurityFeed();
        const read = feed.latest();
        feed.reset();
        pending.resolve(page());
        await read;
        expect(feed.items.value).toEqual([]);
        expect(feed.enabled.value).toBeNull();
    });
    it('does not refresh after reset while an acknowledgement is pending', async () => {
        const get = vi.spyOn(api, 'get').mockResolvedValue(page());
        const pending = deferred();
        vi.spyOn(api, 'post').mockReturnValue(pending.promise);
        const feed = useSecurityFeed();
        await feed.latest();
        const write = feed.markRead([21]);
        feed.reset();
        pending.resolve({ success: true, enabled: true });
        await write;
        expect(feed.items.value).toEqual([]);
        expect(get).toHaveBeenCalledTimes(1);
    });
    it('blocks overlapping read mutations', async () => {
        vi.spyOn(api, 'get').mockResolvedValue(page());
        const pending = deferred();
        const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise);
        const feed = useSecurityFeed();
        await feed.latest();
        const write = feed.markRead([21]);
        await feed.markRead([21]);
        expect(post).toHaveBeenCalledTimes(1);
        pending.resolve({ success: true, enabled: true });
        await write;
    });
});
