// @vitest-environment node
import { it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import {
    LoginSecurityStore,
    LOGIN_LOCK_MS,
} from '../../functions/services/login-security-store.js';

it('runs atomic admission, warning and rollback on the local D1 runtime', async () => {
    const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("offline fixture") } }',
        compatibilityDate: '2024-04-01',
        d1Databases: ['MISUB_SECURITY_DB'],
    });
    try {
        const db = await mf.getD1Database('MISUB_SECURITY_DB');
        const schema = readFileSync(
            new URL('../../migrations/login-security/0001_login_security.sql', import.meta.url),
            'utf8'
        );
        await db.batch(
            schema
                .split(';')
                .map((sql) => sql.trim())
                .filter(Boolean)
                .map((sql) => db.prepare(sql))
        );
        await db.prepare('UPDATE login_security_config SET enabled=1').run();
        let now = 1791900000000;
        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                new LoginSecurityStore(db, () => now).record('203.0.113.1', false)
            )
        );
        expect(results.filter((r) => !r.lockedUntil)).toHaveLength(9);
        now += LOGIN_LOCK_MS;
        const device = { browser: 'Firefox', os: 'Windows', device: 'desktop' };
        const logins = await Promise.all(
            Array.from({ length: 5 }, () =>
                new LoginSecurityStore(db, () => now).record('203.0.113.1', true, device)
            )
        );
        expect(logins.filter((r) => r.warning)).toHaveLength(1);
        expect(logins.find((r) => r.warning).warning.failedAttempts).toBe(10);
        const store = new LoginSecurityStore(db, () => now);
        expect((await store.list()).unreadCount).toBe(6);
        await store.record('203.0.113.2', false);
        await db
            .prepare(
                "CREATE TRIGGER reject_audit BEFORE INSERT ON login_security_events WHEN NEW.type='login_success' BEGIN SELECT RAISE(ABORT,'offline failure'); END"
            )
            .run();
        await expect(store.record('203.0.113.2', true, device)).rejects.toThrow();
        await db.prepare('DROP TRIGGER reject_audit').run();
        expect((await store.record('203.0.113.2', true, device)).warning.failedAttempts).toBe(1);
    } finally {
        await mf.dispose();
    }
}, 30000);
