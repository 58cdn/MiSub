// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
    LoginSecurityStore,
    LOGIN_WINDOW_MS,
    LOGIN_LOCK_MS,
    LOGIN_RETENTION_MS,
} from '../../functions/services/login-security-store.js';
import { securityDatabase } from '../fixtures/login-security-db.js';

const IP = '203.0.113.1';
const device = { browser: 'Firefox', os: 'Windows', device: 'desktop' };
const databases = [];
function fixture() {
    const db = securityDatabase();
    databases.push(db.sqlite);
    const clock = { now: 1791900000000 };
    return { ...db, clock, store: new LoginSecurityStore(db.binding, () => clock.now) };
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('D1 login security transactions', () => {
    it('admits a stable SID once across concurrent retries and preserves subsequent failures', async () => {
        const { store, sqlite } = fixture();
        await store.record(IP, false);
        const id = 'a'.repeat(32);
        const results = await Promise.all(
            Array.from({ length: 20 }, () => store.record(IP, true, device, id))
        );
        expect(new Set(results.map((r) => r.warning.id)).size).toBe(1);
        expect(
            sqlite
                .prepare("SELECT COUNT(*) n FROM login_security_events WHERE type='login_success'")
                .get().n
        ).toBe(1);
        for (let n = 0; n < 10; n++) await store.record(IP, false);
        expect((await store.record(IP, true, device, id)).lockedUntil).not.toBeNull();
        expect(sqlite.prepare('SELECT COUNT(*) n FROM login_security_failures').get().n).toBe(10);
    });
    it('keeps a stable warning after read acknowledgement and hides it while disabled', async () => {
        const { store, sqlite } = fixture();
        const id = 'b'.repeat(32);
        await store.record(IP, false);
        const first = await store.record(IP, true, device, id);
        await store.markRead([first.warning.id]);
        expect((await store.record(IP, true, device, id)).warning).toEqual(first.warning);
        sqlite.exec('UPDATE login_security_config SET enabled=0');
        expect(await store.record(IP, true, device, id)).toMatchObject({
            enabled: false,
            warning: null,
        });
    });
    it('locks exactly on 10, rejects 11 and valid passwords, does not extend, unlocks at the exact boundary', async () => {
        const { store, clock, sqlite } = fixture();
        for (let i = 1; i <= 9; i++) expect((await store.record(IP, false)).lockedUntil).toBeNull();
        const lockedUntil = clock.now + LOGIN_LOCK_MS;
        expect((await store.record(IP, false)).lockedUntil).toBe(lockedUntil);
        clock.now += LOGIN_LOCK_MS - 1;
        expect((await store.record(IP, false)).lockedUntil).toBe(lockedUntil);
        expect((await store.record(IP, true, device)).lockedUntil).toBe(lockedUntil);
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_failures').get().n).toBe(
            10
        );
        expect((await store.list()).items).toHaveLength(0);
        clock.now++;
        const result = await store.record(IP, true, device);
        expect(result.lockedUntil).toBeNull();
        expect(result.warning.failedAttempts).toBe(10);
        expect((await store.record(IP, false)).lockedUntil).toBeNull();
    });

    it('uses a fixed window from first failure, including the millisecond before and at expiry', async () => {
        const { store, clock, sqlite } = fixture();
        for (let i = 0; i < 8; i++) await store.record(IP, false);
        const started = clock.now;
        clock.now += LOGIN_WINDOW_MS - 1;
        expect((await store.record(IP, false)).lockedUntil).toBeNull();
        expect(sqlite.prepare('SELECT failures FROM login_security_ips').get().failures).toBe(9);
        clock.now++;
        expect((await store.record(IP, false)).lockedUntil).toBeNull();
        expect(
            sqlite.prepare('SELECT failures,window_started_at FROM login_security_ips').get()
        ).toMatchObject({ failures: 1, window_started_at: started + LOGIN_WINDOW_MS });
    });

    it('resets only the successful IP, starts its next window at its next failure', async () => {
        const { store, clock, sqlite } = fixture();
        for (let i = 0; i < 9; i++) await store.record(IP, false);
        await store.record('203.0.113.2', false);
        const result = await store.record(IP, true, device);
        expect(result.warning.failedAttempts).toBe(10);
        clock.now += LOGIN_WINDOW_MS - 1;
        await store.record(IP, false);
        expect(
            sqlite
                .prepare('SELECT failures,window_started_at FROM login_security_ips WHERE ip=?')
                .get(IP)
        ).toMatchObject({ failures: 1, window_started_at: clock.now });
        expect(
            sqlite.prepare('SELECT failures FROM login_security_ips WHERE ip=?').get('203.0.113.2')
                .failures
        ).toBe(1);
    });

    it('serializes 100 concurrent attempts across store instances without losing counts', async () => {
        const { binding, clock, sqlite } = fixture();
        const results = await Promise.all(
            Array.from({ length: 100 }, () =>
                new LoginSecurityStore(binding, () => clock.now).record(IP, false)
            )
        );
        expect(results.filter((result) => !result.lockedUntil)).toHaveLength(9);
        expect(new Set(results.filter((r) => r.lockedUntil).map((r) => r.lockedUntil)).size).toBe(
            1
        );
        expect(sqlite.prepare('SELECT failures FROM login_security_ips').get().failures).toBe(10);
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_failures').get().n).toBe(
            10
        );
    });

    it('consumes one global warning across concurrent successes and returns durable IDs', async () => {
        const { store, binding, clock } = fixture();
        await store.record('203.0.113.99', false);
        const results = await Promise.all(
            Array.from({ length: 12 }, () =>
                new LoginSecurityStore(binding, () => clock.now).record(IP, true, device)
            )
        );
        const warnings = results.filter((r) => r.warning);
        expect(warnings).toHaveLength(1);
        const events = await store.list();
        expect(events.items).toHaveLength(13);
        expect(events.items.find((r) => r.id === warnings[0].warning.id)).toMatchObject({
            type: 'login_warning',
            ip: null,
            target: 'security',
        });
        expect(events.unreadCount).toBe(13);
    });

    it('uses transaction order for a successful login racing the tenth failure', async () => {
        const { store } = fixture();
        for (let i = 0; i < 9; i++) await store.record(IP, false);
        const [failure, success] = await Promise.all([
            store.record(IP, false),
            store.record(IP, true, device),
        ]);
        expect(success.lockedUntil).toBe(failure.lockedUntil);
        expect(success.warning).toBeNull();
        expect((await store.list()).items).toHaveLength(0);
    });

    it('allows success ordered before a racing failure and leaves the later failure pending', async () => {
        const { store, sqlite } = fixture();
        for (let i = 0; i < 9; i++) await store.record(IP, false);
        const [success, failure] = await Promise.all([
            store.record(IP, true, device),
            store.record(IP, false),
        ]);
        expect(success.warning.failedAttempts).toBe(9);
        expect(failure.lockedUntil).toBeNull();
        expect(sqlite.prepare('SELECT failures FROM login_security_ips').get().failures).toBe(1);
        expect((await store.record(IP, true, device)).warning.failedAttempts).toBe(1);
    });

    it('rolls back admission and warning consumption when audit insertion fails', async () => {
        const { store, sqlite } = fixture();
        await store.record(IP, false);
        sqlite.exec(
            "CREATE TRIGGER unavailable BEFORE INSERT ON login_security_events WHEN NEW.type='login_success' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
        );
        await expect(store.record(IP, true, device)).rejects.toThrow();
        expect(sqlite.prepare('SELECT failures FROM login_security_ips').get().failures).toBe(1);
        expect((await store.list()).items).toHaveLength(0);
        sqlite.exec('DROP TRIGGER unavailable');
        expect((await store.record(IP, true, device)).warning.failedAttempts).toBe(1);
    });

    it('paginates by exclusive ID with concurrent arrivals and idempotent explicit read IDs', async () => {
        const { store, clock } = fixture();
        await store.record(IP, false);
        await store.record(IP, true, device);
        await store.record(IP, true, device);
        const first = await store.list({ limit: 2 });
        await store.record(IP, true, device);
        const second = await store.list({ limit: 2, before: first.nextCursor });
        expect(second.items).toHaveLength(1);
        expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(3);
        expect(second.nextCursor).toBeNull();
        await store.markRead([first.items[0].id, first.items[0].id, 9999]);
        const readAt = clock.now;
        clock.now++;
        await store.markRead([first.items[0].id]);
        const all = await store.list();
        expect(all.unreadCount).toBe(3);
        expect(all.items.find((r) => r.id === first.items[0].id).readAt).toBe(readAt);
        expect(all.items[0].readAt).toBeNull();
        const audit = await store.list({ audit: true });
        expect(audit.items.every((r) => r.type === 'login_success')).toBe(true);
        expect(audit.unreadCount).toBe(2);
    });

    it('expires records at 30 days and does not persist raw UA, passwords or request data', async () => {
        const { store, clock, sqlite } = fixture();
        await store.record(IP, true, device);
        await store.record(IP, false);
        clock.now += LOGIN_RETENTION_MS;
        expect((await store.list()).items).toHaveLength(0);
        expect((await store.record(IP, true, device)).warning).toBeNull();
        const row = sqlite.prepare('SELECT * FROM login_security_events').get();
        expect(Object.keys(row)).not.toEqual(
            expect.arrayContaining(['password', 'token', 'user_agent', 'request'])
        );
    });

    it('keeps the database clock monotonic if an earlier-started request executes later', async () => {
        const { store, clock, sqlite } = fixture();
        await store.record(IP, false);
        const start = clock.now;
        clock.now -= 1000;
        await store.record(IP, false);
        expect(sqlite.prepare('SELECT updated_at FROM login_security_ips').get().updated_at).toBe(
            start
        );
    });
});
