import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createSessionFixture } from '../fixtures/session-authority.js';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { renewAuthSession } from '../../functions/modules/auth-middleware.js';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const origin = 'https://session-runtime.invalid';
const sources = {};
for (const name of ['session-client', 'session-registry', 'http', 'session-generation'])
    sources[`/src/lib/${name}.js`] = await readFile(
        new URL(`../../src/lib/${name}.js`, import.meta.url),
        'utf8'
    );
const report = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [
            name,
            createHash('sha256').update(source).digest('hex'),
        ])
    ),
    checks: [],
    external: [],
    pageErrors: [],
    requests: [],
    scope: 'Actual functions/api-router and src/lib/session-client on intercepted HTTPS in Chromium; isolated SQLite D1 adapter. No production, external network or real Cloudflare D1.',
};
let browser, context, fixture, pendingGate;
const gates = new Set();
function gate(path, mode = 'response') {
    let release, reached;
    const wait = new Promise((done) => {
        release = done;
    });
    const ready = new Promise((done) => {
        reached = done;
    });
    const result = { path, mode, release, reached, wait, ready };
    gates.add(result);
    pendingGate = result;
    return result;
}
async function newPage() {
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => window.client);
    return page;
}
async function fresh() {
    await context?.close();
    fixture?.close();
    fixture = createSessionFixture();
    pendingGate = null;
    context = await browser.newContext();
    context.on('page', (page) => page.on('pageerror', (e) => report.pageErrors.push(e.message)));
    await context.route('**/*', async (route) => {
        const incoming = route.request(),
            url = new URL(incoming.url());
        if (url.origin !== origin) {
            report.external.push(url.origin);
            return route.abort();
        }
        if (url.pathname === '/')
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><title>MiSub session integration</title><script type="module">import {createSessionClient} from "/src/lib/session-client.js"; window.client=createSessionClient();</script>',
            });
        if (sources[url.pathname])
            return route.fulfill({ contentType: 'text/javascript', body: sources[url.pathname] });
        const control = pendingGate?.path === url.pathname ? pendingGate : null;
        if (control) pendingGate = null;
        if (control?.mode === 'request') {
            control.reached();
            await control.wait;
        }
        const headers = await incoming.allHeaders();
        const request = new Request(url, {
            method: incoming.method(),
            headers,
            ...(['GET', 'HEAD'].includes(incoming.method()) ? {} : { body: incoming.postData() }),
        });
        let response;
        if (url.pathname === '/api/fixture-renew')
            response = await renewAuthSession(request, fixture.env, new Response('{}'), {
                isAuthenticated: true,
                shouldRenew: true,
            });
        else response = await handleApiRequest(request, fixture.env);
        const cookies = response.headers.getSetCookie();
        report.requests.push({
            path: url.pathname,
            status: response.status,
            setCookies: cookies.length,
        });
        if (control) {
            control.reached();
            if (control.mode === 'response' || control.mode === 'drop') await control.wait;
            gates.delete(control);
            if (control.mode === 'drop') return route.abort('failed');
        }
        await route.fulfill({
            status: response.status,
            headers: {
                ...Object.fromEntries(response.headers),
                ...(cookies.length ? { 'set-cookie': cookies.join('\n') } : {}),
            },
            body: await response.text(),
        });
    });
    return newPage();
}
const login = (page) => page.evaluate(() => client.login('synthetic-password'));
const logout = (page) => page.evaluate(() => client.logout());
const check = (page) => page.evaluate(async () => (await fetch('/api/session/check')).json());
const start = (page, method) =>
    page.evaluate((method) => {
        window.operation = client[method](
            ...(method === 'login' ? ['synthetic-password'] : [])
        ).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, code: error.data?.code || error.code || error.message })
        );
    }, method);
async function test(name, action) {
    await action();
    report.checks.push({ name, passed: true });
}
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.MISUB_BROWSER_EXECUTABLE || undefined,
    });
    report.browserVersion = browser.version();
    await test('actual client login, HttpOnly Cookie and server-confirmed logout', async () => {
        const p = await fresh();
        await login(p);
        assert.equal((await check(p)).authenticated, true);
        assert.equal(await p.evaluate(() => document.cookie.includes('misub_sid_')), false);
        const result = await logout(p);
        assert.equal(result.logoutConfirmed, true);
        assert.equal((await check(p)).authenticated, false);
    });
    for (const [path, mode] of [
        ['/api/login', 'response'],
        ['/api/session/confirm', 'response'],
        ['/api/session/confirm', 'request'],
        ['/api/session/prepare', 'response'],
        ['/api/session/protocol', 'response'],
    ]) {
        await test(`logout blocks delayed ${path} ${mode}`, async () => {
            const a = await fresh(),
                b = await newPage(),
                held = gate(path, mode);
            await start(a, 'login');
            await held.ready;
            await logout(b).catch(() => {});
            held.release();
            const result = await a.evaluate(() => operation);
            assert.equal(result.ok, false);
            assert.equal((await check(b)).authenticated, false);
        });
    }
    await test('late logout response preserves a subsequent confirmed login', async () => {
        const a = await fresh(),
            b = await newPage();
        await login(a);
        const held = gate('/api/logout');
        await start(a, 'logout');
        await held.ready;
        await login(b);
        held.release();
        await a.evaluate(() => operation);
        assert.equal((await check(b)).authenticated, true);
    });
    await test('late protocol lookup from old logout cannot capture a later login', async () => {
        const a = await fresh(),
            b = await newPage();
        await login(a);
        const held = gate('/api/session/protocol');
        await start(a, 'logout');
        await held.ready;
        await login(b);
        held.release();
        await a.evaluate(() => operation);
        assert.equal((await check(b)).authenticated, true);
    });
    await test('lost capture response retries its same immutable receipt', async () => {
        const p = await fresh();
        await login(p);
        const held = gate('/api/session/capture', 'drop');
        await start(p, 'logout');
        await held.ready;
        held.release();
        assert.equal((await p.evaluate(() => operation)).ok, false);
        assert.equal(await p.evaluate(() => client.recoveryPending()), true);
        assert.equal((await logout(p)).logoutConfirmed, true);
        assert.equal((await check(p)).authenticated, false);
    });
    await test('lost logout response survives reload and permits fixed-scope retry before login', async () => {
        const p = await fresh();
        await login(p);
        const held = gate('/api/logout', 'drop');
        await start(p, 'logout');
        await held.ready;
        held.release();
        assert.equal((await p.evaluate(() => operation)).ok, false);
        await p.reload();
        await p.waitForFunction(() => window.client);
        assert.equal(await p.evaluate(() => client.recoveryPending()), true);
        await login(p);
        assert.equal((await check(p)).authenticated, true);
    });
    await test('server time recovers a browser clock one day ahead', async () => {
        const p = await fresh();
        await login(p);
        await p.evaluate(() => {
            const original = Date.now;
            Date.now = () => original() + 86400000;
        });
        assert.equal((await logout(p)).logoutConfirmed, true);
        assert.equal((await check(p)).authenticated, false);
    });
    await test('failed password retries do not exhaust persistent intents', async () => {
        const p = await fresh();
        await p.evaluate(async () => {
            for (let n = 0; n < 36; n++) await client.login('wrong').catch(() => {});
        });
        await login(p);
        assert.equal((await check(p)).authenticated, true);
    });
    await test('lost local registry recovers actual browser cookies', async () => {
        const p = await fresh();
        await login(p);
        await p.evaluate(async () => {
            await client.close();
            await new Promise((resolve, reject) => {
                const r = indexedDB.deleteDatabase('misub-session-coordination-v1');
                r.onsuccess = resolve;
                r.onerror = reject;
            });
        });
        await p.reload();
        await p.waitForFunction(() => window.client);
        assert.equal((await logout(p)).logoutConfirmed, true);
        assert.equal((await check(p)).authenticated, false);
    });
    await test('D1 outage does not report a confirmed logout and retry succeeds', async () => {
        const p = await fresh();
        await login(p);
        fixture.setUnavailable(true);
        await assert.rejects(logout(p));
        fixture.setUnavailable(false);
        assert.equal(await p.evaluate(() => client.recoveryPending()), true);
        assert.equal((await logout(p)).logoutConfirmed, true);
    });
    await test('delayed GET renewal never restores browser authentication after logout', async () => {
        const p = await fresh();
        await login(p);
        const held = gate('/api/fixture-renew');
        await p.evaluate(() => {
            window.renewing = fetch('/api/fixture-renew').then((r) => r.text());
        });
        await held.ready;
        await logout(p);
        held.release();
        await p.evaluate(() => renewing);
        assert.equal((await check(p)).authenticated, false);
        assert.equal(
            report.requests.filter((r) => r.path === '/api/fixture-renew').at(-1).setCookies,
            0
        );
    });
    assert.equal(report.external.length, 0);
    assert.equal(report.pageErrors.length, 0);
    report.success = true;
} catch (error) {
    report.success = false;
    report.failure = error.stack;
    process.exitCode = 1;
} finally {
    for (const g of gates) g.release();
    await context?.close();
    fixture?.close();
    await browser?.close();
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
        JSON.stringify({
            success: report.success,
            checks: report.checks.length,
            external: report.external.length,
            pageErrors: report.pageErrors.length,
            failure: report.failure,
        })
    );
}
