// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
    D1SessionState,
    SESSION_STATE_SCHEMA,
} from '../../experiments/session-cookie-protocol/d1-state.js';

const opened = [];
function fixture({ initialize = true } = {}) {
    const sql = new DatabaseSync(':memory:');
    opened.push(sql);
    if (initialize) sql.exec(SESSION_STATE_SCHEMA);
    const calls = [];
    let nextRead, nextWrite;
    const binding = {
        withSession(mode) {
            calls.push({ type: 'session', mode });
            let count = 0;
            return {
                prepare(query) {
                    if (++count > 1) throw new Error('fixture reused first-primary session');
                    return binding.prepare(query);
                },
            };
        },
        prepare(query) {
            calls.push({ type: 'prepare', query });
            return {
                async first() {
                    const row = sql.prepare(query).get();
                    const gate = nextRead;
                    nextRead = null;
                    if (gate) await gate(row);
                    return row;
                },
                bind(...args) {
                    return {
                        async run() {
                            const gate = nextWrite;
                            nextWrite = null;
                            if (gate) return gate(query, args);
                            return {
                                success: true,
                                meta: { changes: sql.prepare(query).run(...args).changes },
                            };
                        },
                    };
                },
            };
        },
    };
    return {
        sql,
        binding,
        calls,
        state: new D1SessionState(binding),
        readHook: (fn) => (nextRead = fn),
        writeHook: (fn) => (nextWrite = fn),
    };
}
afterEach(() => {
    while (opened.length) opened.pop().close();
});

describe('candidate primary-read D1 CAS boundary', () => {
    it('requires existing schema and never initializes through a read or mutation', async () => {
        const f = fixture({ initialize: false });
        await expect(f.state.read()).rejects.toMatchObject({ status: 503 });
        expect(
            f.sql.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n
        ).toBe(0);
        expect(
            f.calls.filter((call) => call.query).every((call) => call.query.startsWith('SELECT'))
        ).toBe(true);
    });
    it('starts a fresh primary session for every independent authentication read', async () => {
        const f = fixture();
        await f.state.read();
        await f.state.read();
        expect(f.calls.filter((call) => call.type === 'session')).toEqual([
            { type: 'session', mode: 'first-primary' },
            { type: 'session', mode: 'first-primary' },
        ]);
    });
    it('recomputes a pending activation after concurrent logout instead of overwriting revocation', async () => {
        const f = fixture();
        await f.state.mutate((state) => {
            state.sessions.s1 = { revoked: false, active: false };
        });
        f.readHook(async () => {
            await new D1SessionState(f.binding).mutate((state) => {
                state.sessions.s1.revoked = true;
            });
        });
        const activated = await f.state.mutate((state) => {
            if (state.sessions.s1.revoked) return false;
            state.sessions.s1.active = true;
            return true;
        });
        expect(activated).toBe(false);
        expect((await f.state.read()).state.sessions.s1).toEqual({ revoked: true, active: false });
    });
    it('commits related ticket, pending session and snapshot changes in one conditional statement', async () => {
        const f = fixture();
        await f.state.mutate((state) => {
            state.tickets.t1 = { cancelled: true };
            state.sessions.s1 = { revoked: true };
            state.snapshots.r1 = { completed: true };
        });
        const stored = await f.state.read();
        expect(stored.revision).toBe(1);
        expect(stored.state).toMatchObject({
            tickets: { t1: { cancelled: true } },
            sessions: { s1: { revoked: true } },
            snapshots: { r1: { completed: true } },
        });
        expect(f.calls.filter((call) => call.query?.startsWith('UPDATE'))).toHaveLength(1);
    });
    it('preserves no mutations when the action fails before commit', async () => {
        const f = fixture();
        await expect(
            f.state.mutate((state) => {
                state.tickets.bad = {};
                throw new Error('invalid_proof');
            })
        ).rejects.toThrow('invalid_proof');
        expect((await f.state.read()).state.tickets).toEqual({});
    });
    it('marks post-commit transport loss unconfirmed and does not reexecute the action', async () => {
        const f = fixture();
        let calls = 0;
        f.writeHook((query, args) => {
            f.sql.prepare(query).run(...args);
            throw new Error('transport');
        });
        await expect(
            f.state.mutate((state) => {
                calls++;
                state.snapshots.r1 = { completed: true };
            })
        ).rejects.toMatchObject({ code: 'session_commit_unconfirmed' });
        expect(calls).toBe(1);
        expect((await f.state.read()).state.snapshots.r1.completed).toBe(true);
    });
    it('bounds contention retries and refuses ambiguous write results', async () => {
        const f = fixture();
        const conflicting = {
            ...f.binding,
            prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }),
        };
        const busy = new D1SessionState(conflicting, { maxAttempts: 2 });
        await expect(busy.mutate(() => true)).rejects.toMatchObject({ code: 'session_store_busy' });
        f.writeHook(() => ({ success: true }));
        await expect(f.state.mutate(() => true)).rejects.toMatchObject({
            code: 'session_commit_unconfirmed',
        });
    });
    it.each(['{}', '{"schema":2,"sessions":{},"tickets":{},"snapshots":{}}'])(
        'fails closed on incompatible state %s',
        async (document) => {
            const f = fixture();
            f.sql.prepare('UPDATE misub_session_authority SET document=?').run(document);
            await expect(f.state.read()).rejects.toMatchObject({ code: 'session_store_invalid' });
        }
    );
    it('rejects a candidate document exceeding the bounded storage budget', async () => {
        const f = fixture();
        await expect(
            f.state.mutate((state) => {
                state.sessions.s1 = 'x'.repeat(262144);
            })
        ).rejects.toMatchObject({ code: 'session_store_invalid' });
        expect((await f.state.read()).revision).toBe(0);
    });
});
