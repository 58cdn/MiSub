import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { SessionCookieModel } from '../../experiments/session-cookie-protocol/model.js';

const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const origin = 'https://session-protocol-fixture.invalid';
const registrySource = await readFile(
    new URL('../../experiments/session-cookie-protocol/registry.js', import.meta.url),
    'utf8'
);
const modelSource = await readFile(
    new URL('../../experiments/session-cookie-protocol/model.js', import.meta.url),
    'utf8'
);
const report = {
    startedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    registrySha256: createHash('sha256').update(registrySource).digest('hex'),
    modelSha256: createHash('sha256').update(modelSource).digest('hex'),
    checks: [],
    external: [],
    errors: [],
    requests: [],
    limits: [
        'Offline proposal model, not MiSub runtime or production issuer.',
        'Actual Chromium Cookie and IndexedDB on intercepted synthetic HTTPS origin; no external network.',
        'Synthetic predictable secrets, memory SQLite; no Cloudflare, Safari, D1 adapter, bootstrap deployment or production resources.',
    ],
};
let browser, model, context, pendingGate;
const gates = new Set();
function gate(path, mode = 'hold') {
    let release, ready, delivered;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const reached = new Promise((resolve) => {
        ready = resolve;
    });
    const finished = new Promise((resolve) => {
        delivered = resolve;
    });
    pendingGate = { path, mode, release, ready, delivered, held, reached, finished };
    gates.add(pendingGate);
    return pendingGate;
}
async function fixture() {
    await context?.close();
    model?.close();
    model = new SessionCookieModel();
    pendingGate = null;
    context = await browser.newContext();
    context.on('page', (page) =>
        page.on('pageerror', (error) => report.errors.push(error.message))
    );
    await context.route('**/*', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (url.origin !== origin) {
            report.external.push(url.origin);
            return route.abort();
        }
        if (url.pathname === '/')
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><title>Offline session protocol</title><script type="module">import {createPendingLoginRegistry} from "/registry.js"; window.registry=createPendingLoginRegistry(indexedDB); window.ready=true;</script>',
            });
        if (url.pathname === '/registry.js')
            return route.fulfill({ contentType: 'text/javascript', body: registrySource });
        const headers = await request.allHeaders();
        const control = pendingGate?.path === url.pathname ? pendingGate : null;
        if (control) pendingGate = null;
        const args = request.postDataJSON() || {};
        if (control?.mode === 'before') {
            control.ready();
            await control.held;
        }
        let status = 200,
            result;
        try {
            if (control?.mode === 'unavailable')
                throw Object.assign(new Error('synthetic_unavailable'), { status: 503 });
            const cookie = headers.cookie || '';
            if (url.pathname === '/ticket') result = model.issueTicket();
            else if (url.pathname === '/login') result = model.login({ ...args, cookie });
            else if (url.pathname === '/revoke-targets')
                result = model.revokeTargets({ ...args, cookie });
            else if (url.pathname === '/capture-recovery')
                result = model.captureRecovery(cookie, args);
            else if (url.pathname === '/logout-recovered') result = model.logoutRecovered(args);
            else if (url.pathname === '/renew') result = model.renew(cookie);
            else if (url.pathname === '/ack')
                result = { confirmed: model.acknowledge(args.ticket, cookie) };
            else if (url.pathname === '/maintenance') result = model.maintenance(cookie);
            else if (url.pathname === '/cleanup') result = model.cleanup(cookie, args.id);
            else if (url.pathname === '/cleanup-ticket') result = model.cleanupTicket(args.id);
            else if (url.pathname === '/protected') {
                result = model.authenticate(cookie);
                status = result.authenticated ? 200 : 401;
            } else throw Object.assign(new Error('unknown_path'), { status: 404 });
        } catch (error) {
            status = error.status || 500;
            result = { error: error.code || error.message };
        }
        const { setCookie, ...body } = result;
        report.requests.push({
            path: url.pathname,
            status,
            setCookie: !!setCookie,
            control: control?.mode,
        });
        if (control) {
            control.ready();
            if (control.mode === 'hold') await control.held;
            gates.delete(control);
            if (control.mode === 'drop') {
                await route.abort('failed');
                control.delivered();
                return;
            }
        }
        await route.fulfill({
            status,
            headers: {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                ...(setCookie ? { 'set-cookie': setCookie } : {}),
            },
            body: JSON.stringify(body),
        });
        control?.delivered();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => window.ready);
    return page;
}
const rpc = (page, path, body = {}) =>
    page.evaluate(
        async ({ path, body }) => {
            try {
                const response = await fetch(path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                return { status: response.status, body: await response.json() };
            } catch {
                return { status: 0 };
            }
        },
        { path, body }
    );
const registry = (page, action, args = []) =>
    page.evaluate(({ action, args }) => window.registry[action](...args), { action, args });
async function prepare(page) {
    const intent = await registry(page, 'begin');
    const { body: ticket } = await rpc(page, '/ticket');
    assert.equal(await registry(page, 'bind', [intent.id, ticket]), true);
    return {
        intent,
        ticket,
        request: {
            ticket,
            password: 'synthetic-password',
            priorIds: intent.priorIds,
            priorTickets: intent.priorTickets,
        },
    };
}
async function login(page) {
    await maintenance(page);
    const prepared = await prepare(page),
        response = await rpc(page, '/login', prepared.request);
    assert.equal(response.status, 200);
    assert.equal(await registry(page, 'canConfirm', [prepared.intent.id]), true);
    const ack = await rpc(page, '/ack', { ticket: prepared.ticket });
    assert.equal(ack.body.confirmed, true);
    assert.equal(
        await registry(page, 'acknowledge', [prepared.intent.id, response.body.id, true]),
        true
    );
    await maintenance(page);
    return { ...prepared, response };
}
async function maintenance(page) {
    const response = await rpc(page, '/maintenance');
    assert.equal(response.status, 200);
    for (const id of response.body.staleIds)
        assert.equal((await rpc(page, '/cleanup', { id })).status, 200);
    for (const id of response.body.staleTicketIds)
        assert.equal((await rpc(page, '/cleanup-ticket', { id })).status, 200);
}
async function logout(page) {
    return recoveryLogout(page);
}
async function secondTab() {
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => window.ready);
    return page;
}
async function resetRegistry(page) {
    await registry(page, 'close');
    await page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase('misub-session-protocol-fixture');
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            })
    );
    await page.evaluate(async () => {
        const { createPendingLoginRegistry } = await import('/registry.js');
        window.registry = createPendingLoginRegistry(indexedDB);
    });
}
async function recoveryLogout(page) {
    const operation = await registry(page, 'beginRecovery');
    let snapshot = operation.snapshot;
    if (!snapshot) {
        const response = await rpc(page, '/capture-recovery', {
            ids: operation.knownIds,
            tickets: operation.tickets,
        });
        if (response.status !== 200) return { operation, response };
        await registry(page, 'bindRecovery', [operation.id, response.body]);
        // A concurrent tab may have bound the same recovery first. Always use
        // that persisted snapshot instead of expanding an already captured scope.
        snapshot = (await registry(page, 'retryRecovery', [operation.id]))?.snapshot;
        if (!snapshot) return { operation, response: { status: 409 } };
    }
    const logout = await rpc(page, '/logout-recovered', snapshot);
    if (logout.status === 200) await registry(page, 'completeRecovery', [operation.id]);
    return { operation, snapshot, response: logout };
}
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.MISUB_BROWSER_EXECUTABLE || undefined,
    });
    report.browserVersion = browser.version();
    // Real Cookie delivery: login response can restore bytes, but never restore authorization.
    for (const twoTabs of [false, true]) {
        const page = await fixture(),
            other = twoTabs ? await secondTab() : page;
        const prepared = await prepare(page),
            held = gate('/login');
        const oldLogin = rpc(page, '/login', prepared.request);
        await held.reached;
        assert.equal((await logout(other)).response.status, 200);
        held.release();
        await oldLogin;
        await held.finished;
        const cookies = await context.cookies();
        assert.ok(
            cookies.some(
                (cookie) =>
                    cookie.name.startsWith('__Host-misub_sid_') && cookie.httpOnly && cookie.secure
            )
        );
        assert.equal((await rpc(other, '/protected')).status, 401);
        assert.equal((await rpc(page, '/renew')).status, 401);
        report.checks.push(
            `${twoTabs ? 'Two tabs' : 'Same tab'}: delayed login Cookie may exist after logout, but server authorization and renewal both reject it.`
        );
    }
    {
        const page = await fixture();
        await login(page);
        const held = gate('/renew'),
            renew = rpc(page, '/renew');
        await held.reached;
        await logout(page);
        held.release();
        await renew;
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Delayed renewal has no Set-Cookie; protected access remains 401 after server revocation.'
        );
    }
    for (const twoTabs of [false, true]) {
        const page = await fixture(),
            other = twoTabs ? await secondTab() : page;
        await login(page);
        const target = await registry(page, 'snapshotLogout'),
            held = gate('/revoke-targets');
        const oldLogout = rpc(page, '/revoke-targets', target);
        await held.reached;
        const current = await login(other);
        held.release();
        await oldLogout;
        await registry(page, 'completeLogout', [target.id]);
        // A replay's real HTTP Cookie includes the future session; captured IDs still exclude it.
        assert.equal((await rpc(page, '/revoke-targets', target)).status, 200);
        assert.deepEqual((await rpc(other, '/protected')).body.ids, [current.response.body.id]);
        report.checks.push(
            `${twoTabs ? 'Two tabs' : 'Same tab'}: delayed logout and duplicate old logout preserve the newer session, including automatically attached future Cookie.`
        );
    }
    {
        const page = await fixture(),
            other = await secondTab();
        const prepared = await prepare(page),
            held = gate('/login');
        const oldLogin = rpc(page, '/login', prepared.request);
        await held.reached;
        const current = await login(other);
        held.release();
        await oldLogin;
        assert.deepEqual((await rpc(page, '/protected')).body.ids, [current.response.body.id]);
        assert.equal((await rpc(page, '/login', prepared.request)).status, 409);
        report.checks.push(
            'New login atomically cancels the captured older pending ticket; its late unique Cookie cannot replace or authorize alongside the new session.'
        );
    }
    {
        const page = await fixture(),
            other = await secondTab();
        const intent = await registry(page, 'begin'),
            held = gate('/ticket');
        const delayed = rpc(page, '/ticket');
        await held.reached;
        await registry(other, 'snapshotLogout');
        held.release();
        const ticket = (await delayed).body;
        assert.equal(await registry(page, 'bind', [intent.id, ticket]), false);
        assert.equal(model.sql.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
        report.checks.push(
            'Logout during ticket bootstrap prevents a delayed ticket from registering a fresh password-bearing login intent.'
        );
    }
    {
        const page = await fixture(),
            prepared = await prepare(page),
            dropped = gate('/login', 'drop');
        assert.equal((await rpc(page, '/login', prepared.request)).status, 0);
        await dropped.finished;
        const retry = await rpc(page, '/login', prepared.request);
        assert.equal(retry.body.committed, true);
        assert.equal((await rpc(page, '/protected')).status, 401);
        assert.equal((await rpc(page, '/ack', { ticket: prepared.ticket })).body.confirmed, false);
        await logout(page);
        assert.equal((await rpc(page, '/login', prepared.request)).status, 409);
        await login(page);
        assert.equal((await rpc(page, '/protected')).status, 200);
        report.checks.push(
            'Lost login response retry returns metadata only; logout cancels the unreceived credential, and a new explicit password login creates an independent session.'
        );
    }
    for (const mode of ['unavailable', 'drop']) {
        const page = await fixture(),
            current = await login(page),
            target = await registry(page, 'snapshotLogout');
        const control = gate('/revoke-targets', mode),
            response = await rpc(page, '/revoke-targets', target);
        await control.finished;
        assert.equal(response.status, mode === 'drop' ? 0 : 503);
        assert.equal((await rpc(page, '/protected')).status, mode === 'drop' ? 401 : 200);
        await page.reload();
        await page.waitForFunction(() => window.ready);
        assert.deepEqual(await registry(page, 'retryLogout', [target.id]), target);
        assert.equal((await rpc(page, '/revoke-targets', target)).status, 200);
        await registry(page, 'completeLogout', [target.id]);
        assert.equal((await rpc(page, '/protected')).status, 401);
        assert.ok(current.response.body.id);
        report.checks.push(
            `Logout ${mode}: exact cancellation snapshot survives reload and retries; success is never inferred from UI or transport failure.`
        );
    }
    {
        const page = await fixture();
        let current;
        for (let index = 0; index < 40; index++) current = await login(page);
        assert.deepEqual((await rpc(page, '/protected')).body.ids, [current.response.body.id]);
        assert.equal((await context.cookies()).length, 2);
        assert.equal((await logout(page)).response.status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Forty sequential password logins reclaim retired unique Cookies; the current credential stays valid and logout still revokes it.'
        );
    }
    {
        const page = await fixture();
        let previous, previousTicket;
        for (let index = 0; index < 9; index++) {
            const ticket = (await rpc(page, '/ticket')).body;
            const response = await rpc(page, '/login', {
                ticket,
                password: 'synthetic-password',
                priorIds: previous ? [previous] : [],
            });
            assert.equal(response.status, 200);
            previous = response.body.id;
            previousTicket = ticket;
        }
        assert.equal((await rpc(page, '/protected')).status, 431);
        await maintenance(page);
        assert.equal((await rpc(page, '/ack', { ticket: previousTicket })).body.confirmed, true);
        assert.deepEqual((await rpc(page, '/protected')).body.ids, [previous]);
        assert.equal((await rpc(page, '/cleanup', { id: previous })).status, 409);
        report.checks.push(
            'Nine accumulated real Cookies recover through bounded maintenance even when normal authentication rejects the header; active SID deletion remains forbidden.'
        );
    }
    {
        const page = await fixture(),
            other = await secondTab();
        const first = await prepare(page);
        const response1 = await rpc(page, '/login', first.request);
        const second = await prepare(other);
        assert.equal((await rpc(page, '/ack', { ticket: first.ticket })).body.confirmed, true);
        assert.equal(
            await registry(page, 'acknowledge', [first.intent.id, response1.body.id, true]),
            true
        );
        const response2 = await rpc(other, '/login', second.request);
        assert.equal((await rpc(other, '/ack', { ticket: second.ticket })).body.confirmed, true);
        assert.equal(
            await registry(other, 'acknowledge', [second.intent.id, response2.body.id, true]),
            true
        );
        const target = await registry(page, 'snapshotLogout');
        assert.deepEqual(target.ids, [response2.body.id]);
        assert.equal((await rpc(page, '/revoke-targets', target)).status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Cross-tab confirmation order removes prior-ticket SID metadata even when that SID was acknowledged after the newer intent began.'
        );
    }
    {
        const page = await fixture(),
            prepared = await prepare(page);
        assert.equal((await rpc(page, '/login', prepared.request)).status, 200);
        const replacement = (await rpc(page, '/ticket')).body;
        assert.equal(await registry(page, 'bind', [prepared.intent.id, prepared.ticket]), true);
        assert.equal(await registry(page, 'bind', [prepared.intent.id, replacement]), false);
        const target = await registry(page, 'snapshotLogout');
        assert.deepEqual(target.tickets, [prepared.ticket]);
        assert.equal((await rpc(page, '/revoke-targets', target)).status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Ticket retry cannot rebind an intent and orphan a committed login; duplicate identical binding stays idempotent.'
        );
    }
    {
        const page = await fixture(),
            prepared = await prepare(page);
        const result = await rpc(page, '/login', { ...prepared.request, password: 'wrong' });
        assert.equal(result.status, 401);
        assert.equal((await rpc(page, '/protected')).status, 401);
        assert.equal(
            (
                await rpc(page, '/revoke-targets', {
                    tickets: [{ ...prepared.ticket, cancelToken: 'guess' }],
                })
            ).status,
            403
        );
        assert.equal((await rpc(page, '/login', prepared.request)).status, 200);
        model.unavailable = true;
        assert.equal((await rpc(page, '/protected')).status, 503);
        model.unavailable = false;
        report.checks.push(
            'Wrong password and guessed cancellation cannot grant access or mutate the ticket; unavailable revocation storage fails closed with 503.'
        );
    }
    {
        const page = await fixture();
        await login(page);
        await resetRegistry(page);
        const empty = await registry(page, 'snapshotLogout');
        assert.equal((await rpc(page, '/revoke-targets', empty)).status, 409);
        assert.equal((await recoveryLogout(page)).response.status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Deleted IndexedDB with active HttpOnly Cookie: empty logout rejects; recovered server snapshot revokes the actual session.'
        );
    }
    {
        const page = await fixture();
        await login(page);
        await resetRegistry(page);
        await prepare(page);
        assert.equal((await logout(page)).response.status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Recreated registry with a newer uncommitted ticket: ordinary browser logout captures and revokes both the older active SID and the pending operation.'
        );
    }
    for (const mode of ['hold', 'before']) {
        const page = await fixture(),
            prepared = await prepare(page);
        const response = await rpc(page, '/login', prepared.request);
        assert.equal(response.status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        const held = gate('/ack', mode),
            ack = rpc(page, '/ack', { ticket: prepared.ticket });
        await held.reached;
        await resetRegistry(page);
        assert.equal((await recoveryLogout(page)).response.status, 200);
        held.release();
        const confirmed = await ack;
        assert.equal(confirmed.body.confirmed, mode === 'hold');
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            `Registry loss with confirm ${mode === 'hold' ? 'already committed' : 'not yet committed'}: recovery revokes both pending and active states.`
        );
    }
    {
        const page = await fixture(),
            prepared = await prepare(page),
            held = gate('/login');
        const delayed = rpc(page, '/login', prepared.request);
        await held.reached;
        await resetRegistry(page);
        const recovered = await recoveryLogout(page);
        assert.equal(recovered.response.status, 200);
        held.release();
        await delayed;
        assert.equal(await registry(page, 'canConfirm', [prepared.intent.id]), false);
        assert.equal((await rpc(page, '/ack', { ticket: prepared.ticket })).body.confirmed, false);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'Recovery captures the operation Cookie before a late login SID Cookie arrives; neither old confirm nor protected access succeeds.'
        );
    }
    {
        const page = await fixture(),
            prepared = await prepare(page),
            held = gate('/login');
        const delayed = rpc(page, '/login', prepared.request);
        await held.reached;
        await context.clearCookies();
        await resetRegistry(page);
        const fresh = await registry(page, 'begin');
        assert.notEqual(fresh.id, prepared.intent.id);
        assert.equal(await registry(page, 'bind', [prepared.intent.id, prepared.ticket]), false);
        const unknown = await recoveryLogout(page);
        assert.equal(unknown.response.status, 409);
        held.release();
        await delayed;
        assert.equal(await registry(page, 'canConfirm', [prepared.intent.id]), false);
        assert.equal((await rpc(page, '/protected')).status, 401);
        assert.equal((await rpc(page, '/renew')).status, 401);
        const recovered = await recoveryLogout(page);
        assert.equal(recovered.response.status, 200);
        assert.equal(recovered.snapshot.ticketCount, 0);
        assert.equal(Object.hasOwn(recovered.snapshot, 'cancelToken'), false);
        assert.equal((await rpc(page, '/ack', { ticket: prepared.ticket })).body.confirmed, false);
        report.checks.push(
            'All browser proofs lost: unknown recovery stays unconfirmed; late login is pending, cannot renew, and can be revoked without restoring activation ability.'
        );
    }
    for (const mode of ['unavailable', 'drop']) {
        const page = await fixture();
        await login(page);
        await resetRegistry(page);
        const held = gate('/logout-recovered', mode),
            recovered = await recoveryLogout(page);
        await held.finished;
        assert.equal(recovered.response.status, mode === 'drop' ? 0 : 503);
        const other = await secondTab();
        const blocked = await registry(other, 'begin').then(
            () => false,
            () => true
        );
        assert.equal(blocked, true);
        await page.reload();
        await page.waitForFunction(() => window.ready);
        const saved = await registry(page, 'retryRecovery', [recovered.operation.id]);
        assert.deepEqual(saved.snapshot, recovered.snapshot);
        const captures = report.requests.filter(
            (request) => request.path === '/capture-recovery'
        ).length;
        const retried = await recoveryLogout(page);
        assert.equal(retried.response.status, 200);
        assert.deepEqual(retried.snapshot, saved.snapshot);
        assert.equal(
            report.requests.filter((request) => request.path === '/capture-recovery').length,
            captures
        );
        const current = await login(other);
        assert.equal((await rpc(page, '/logout-recovered', saved.snapshot)).status, 200);
        assert.deepEqual((await rpc(other, '/protected')).body.ids, [current.response.body.id]);
        report.checks.push(
            `Recovery logout ${mode}: cross-tab admission stays frozen, persisted snapshot retries and never revokes a subsequent login.`
        );
    }
    {
        const page = await fixture();
        await login(page);
        const next = await prepare(page),
            response = await rpc(page, '/login', next.request);
        const held = gate('/ack', 'before'),
            confirm = rpc(page, '/ack', { ticket: next.ticket });
        await held.reached;
        await context.clearCookies({ name: `__Host-misub_sid_${response.body.id}` });
        await context.clearCookies({ name: `__Host-misub_op_${next.ticket.id}` });
        assert.equal((await logout(page)).response.status, 200);
        held.release();
        assert.equal((await confirm).body.confirmed, false);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            'A pending confirm retains only its IndexedDB cancellation proof after selective Cookie eviction; full logout includes that proof and atomically blocks the confirm.'
        );
    }
    {
        const page = await fixture();
        for (let i = 0; i < 16; i++) {
            await registry(page, 'begin');
            await rpc(page, '/ticket');
        }
        assert.equal(
            await registry(page, 'begin').then(
                () => false,
                () => true
            ),
            true
        );
        assert.equal((await logout(page)).response.status, 200);
        assert.ok((await registry(page, 'begin')).id);
        report.checks.push(
            'Unbound ticket responses count toward the 16-operation admission budget; recovery cancels their Cookie-backed server operations and releases the budget.'
        );
    }
    {
        const page = await fixture(),
            other = await secondTab();
        await login(page);
        const held = gate('/logout-recovered');
        const first = recoveryLogout(page);
        await held.reached;
        const second = await recoveryLogout(other);
        assert.equal(second.response.status, 200);
        held.release();
        const completed = await first;
        assert.equal(completed.response.status, 200);
        assert.deepEqual(completed.snapshot, second.snapshot);
        assert.equal((await rpc(page, '/protected')).status, 401);
        await login(other);
        assert.equal((await rpc(other, '/protected')).status, 200);
        report.checks.push(
            'Two ordinary concurrent logout calls complete the same persisted snapshot idempotently and release the login admission gate.'
        );
    }
    for (const lateTicket of [false, true]) {
        const page = await fixture();
        let delayed, held, oldIntent;
        for (let i = 0; i < 16; i++) {
            const intent = await registry(page, 'begin');
            if (lateTicket && i === 0) {
                oldIntent = intent;
                held = gate('/ticket', 'before');
                delayed = rpc(page, '/ticket');
                await held.reached;
            } else {
                const failed = gate('/ticket', 'unavailable');
                assert.equal((await rpc(page, '/ticket')).status, 503);
                await failed.finished;
            }
        }
        await assert.rejects(registry(page, 'begin'), /pending_login_limit/);
        const unconfirmed = await logout(page);
        assert.equal(unconfirmed.response.status, 409);
        const resumed = await registry(page, 'resumeLoginAfterUnconfirmedRecovery', [
            unconfirmed.operation.id,
        ]);
        assert.deepEqual(resumed, { logoutConfirmed: false, freshLoginRequired: true });
        if (lateTicket) {
            held.release();
            const late = await delayed;
            assert.equal(await registry(page, 'bind', [oldIntent.id, late.body]), false);
            assert.equal(await registry(page, 'canConfirm', [oldIntent.id]), false);
        }
        assert.equal((await rpc(page, '/protected')).status, 401);
        await login(page);
        assert.equal((await rpc(page, '/protected')).status, 200);
        assert.equal((await logout(page)).response.status, 200);
        assert.equal((await rpc(page, '/protected')).status, 401);
        report.checks.push(
            `16 unbound issuance failures (${lateTicket ? 'one late ticket' : 'no ticket'}): explicit fresh-login recovery releases local admission without claiming logout or authorizing a late callback.`
        );
    }
    {
        const page = await fixture();
        const prepared = await prepare(page);
        const recovery = await registry(page, 'beginRecovery');
        await assert.rejects(
            registry(page, 'resumeLoginAfterUnconfirmedRecovery', [recovery.id]),
            /recovery_evidence_must_be_preserved/
        );
        assert.equal((await logout(page)).response.status, 200);
        assert.equal((await rpc(page, '/login', prepared.request)).status, 409);
        await login(page);
        const active = await registry(page, 'beginRecovery');
        await assert.rejects(
            registry(page, 'resumeLoginAfterUnconfirmedRecovery', [active.id]),
            /recovery_evidence_must_be_preserved/
        );
        assert.equal((await logout(page)).response.status, 200);
        report.checks.push(
            'Explicit fresh-login recovery cannot discard a known active SID or a persisted cancellation capability.'
        );
    }
    assert.deepEqual(report.external, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    throw error;
} finally {
    for (const control of gates) control.release();
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await context?.close();
    model?.close();
    await browser?.close();
}
