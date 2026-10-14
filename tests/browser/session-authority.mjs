import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createSessionFixture } from '../fixtures/session-authority.js';
import { securityDatabase } from '../fixtures/login-security-db.js';
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
// Exercise the actual store and BroadcastChannel as well as the HTTP client.
// Only unrelated router, business hydration and localization are replaced.
const mocks = {
    '../router': 'export default {push:async()=>{}}',
    '../lib/api': `import {sessionClient} from '/session-client'; export async function login(p){try{return {success:true,data:await sessionClient().login(p)}}catch(e){return {success:false,error:e.message,status:e.status,data:e.data}}} export async function fetchInitialData(){const r=await fetch('/api/session/check');const data=await r.json();return {success:r.ok&&data.authenticated,data,errorType:data.authenticated?undefined:'auth'}} export async function fetchPublicConfig(){return {success:true,data:{enablePublicPage:false}}}`,
    '../utils/errorHandler.js':
        'export function handleError(e){(window.errors||=[]).push(e.message)}',
    '../i18n/index.js': 'export const t=(k)=>k',
    './useDataStore':
        'export function useDataStore(){return {clearCachedData(){},hydrateFromData(data){return !!data.authenticated}}}',
};
const bundled = await build({
    stdin: {
        contents: `import {createPinia,setActivePinia} from 'pinia'; import {useSessionStore} from './src/stores/session.js'; import {createSessionClient,sessionClient,onSessionChange} from './src/lib/session-client.js'; setActivePinia(createPinia()); window.store=useSessionStore(); window.client=sessionClient(); window.createClient=createSessionClient; window.events=[]; onSessionChange(e=>events.push(e));`,
        resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    plugins: [
        {
            name: 'isolated-business-fixtures',
            setup(b) {
                b.onResolve({ filter: /.*/ }, (args) => {
                    if (args.path === '/session-client')
                        return { path: resolve('src/lib/session-client.js') };
                    if (
                        args.importer.replaceAll('\\', '/').endsWith('/src/stores/session.js') &&
                        Object.hasOwn(mocks, args.path)
                    )
                        return { path: args.path, namespace: 'mock' };
                });
                b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
                    contents: mocks[args.path],
                    loader: 'js',
                }));
            },
        },
    ],
});
sources['/app.js'] = bundled.outputFiles[0].text;
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
let browser, context, fixture, securityFixture, pendingGate;
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
async function fresh({ security = false } = {}) {
    await context?.close();
    fixture?.close();
    securityFixture?.sqlite.close();
    securityFixture = security ? securityDatabase() : null;
    fixture = createSessionFixture();
    if (securityFixture) fixture.env.MISUB_SECURITY_DB = securityFixture.binding;
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
                body: '<!doctype html><title>MiSub session integration</title><script type="module" src="/app.js"></script>',
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
        if (securityFixture) Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
        if (securityFixture) request.headers.set('CF-Connecting-IP', '203.0.113.1');
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
    await test('enabled login security locks both browser password entrypoints', async () => {
        const p = await fresh({ security: true });
        const statuses = await p.evaluate(async () => {
            const results = [];
            for (let n = 0; n < 10; n++)
                results.push(
                    await client.login('wrong').then(
                        () => 200,
                        (e) => e.status
                    )
                );
            results.push(
                await client.login('synthetic-password').then(
                    () => 200,
                    (e) => e.status
                )
            );
            return results;
        });
        assert.deepEqual(statuses, [...Array(9).fill(401), 429, 429]);
        assert.equal((await check(p)).authenticated, false);
    });
    await test('ticket preparation preserves login warnings for the actual session store', async () => {
        const p = await fresh({ security: true });
        await p.evaluate(() => client.login('wrong').catch(() => {}));
        await p.evaluate(() => store.login('synthetic-password'));
        assert.equal(await p.evaluate(() => store.sessionState), 'loggedIn');
        assert.equal(await p.evaluate(() => store.loginSecurity.enabled), true);
        assert.ok(await p.evaluate(() => store.loginSecurity.warning));
        assert.equal((await check(p)).authenticated, true);
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
    for (const path of ['/api/logout', '/api/session/protocol']) {
        await test(`late ${path} cannot invalidate a newer tab's store`, async () => {
            const a = await fresh(),
                b = await newPage();
            await a.evaluate(() => store.login('synthetic-password'));
            await b.evaluate(() => store.checkSession());
            const held = gate(path);
            await a.evaluate(() => {
                window.exiting = store.logout();
            });
            await held.ready;
            await b.evaluate(() => store.login('synthetic-password'));
            assert.equal(await b.evaluate(() => store.sessionState), 'loggedIn');
            const count = await b.evaluate(() => events.length);
            held.release();
            await a.evaluate(() => exiting);
            // Drain a real channel message after all older publications, then IDB.
            await b.evaluate(() => {
                window.drained = new Promise((resolve) => {
                    const c = new BroadcastChannel('misub-session-events-v1');
                    c.onmessage = (e) => {
                        if (e.data.id === 'stale') {
                            c.close();
                            resolve();
                        }
                    };
                });
            });
            await a.evaluate(() => {
                const c = new BroadcastChannel('misub-session-events-v1');
                c.postMessage({ id: 'stale', type: 'logout-pending' });
                c.close();
            });
            await b.evaluate(() => drained);
            await b.evaluate(() => client.recoveryPending());
            assert.equal(await b.evaluate(() => store.sessionState), 'loggedIn');
            assert.equal(await b.evaluate(() => store.logoutPending), false);
            assert.equal(await b.evaluate(() => events.length), count);
            assert.equal((await check(b)).authenticated, true);
        });
    }
    await test('129 expired operation cookies drain in bounded batches before login', async () => {
        const p = await fresh();
        await context.addCookies(
            Array.from({ length: 129 }, (_, n) => ({
                name: '__Host-misub_op_' + n.toString(16).padStart(32, '0'),
                value: 'a'.repeat(64),
                domain: new URL(origin).hostname,
                path: '/',
                secure: true,
                httpOnly: true,
                sameSite: 'Strict',
            }))
        );
        await login(p);
        assert.equal((await check(p)).authenticated, true);
        assert.equal(
            (await context.cookies()).filter((c) => c.name.startsWith('__Host-misub_op_')).length,
            1
        );
    });
    await test('queued logout broadcast cannot cancel an admitted new login', async () => {
        const a = await fresh(),
            b = await newPage();
        await a.evaluate(() => store.login('synthetic-password'));
        await b.evaluate(() => store.checkSession());
        await a.evaluate(() => {
            const post = BroadcastChannel.prototype.postMessage;
            BroadcastChannel.prototype.postMessage = function (message) {
                if (message.type === 'logout-complete')
                    window.releaseEvent = () => post.call(this, message);
                else post.call(this, message);
            };
        });
        await a.evaluate(() => store.logout());
        const held = gate('/api/session/prepare');
        await b.evaluate(() => {
            window.signingIn = store.login('synthetic-password');
        });
        await held.ready;
        await a.evaluate(() => releaseEvent());
        await b.evaluate(() => client.recoveryPending());
        held.release();
        await b.evaluate(() => signingIn);
        assert.equal((await check(b)).authenticated, true);
        assert.equal(await b.evaluate(() => store.sessionState), 'loggedIn');
    });
    await test('an event waiting for IndexedDB open cannot cancel a later user login', async () => {
        const a = await fresh();
        await a.evaluate(() => store.login('synthetic-password'));
        const b = await newPage();
        await b.evaluate(() => {
            const open = indexedDB.open.bind(indexedDB);
            indexedDB.open = (...args) => {
                const pending = {};
                window.releaseOpen = () => {
                    const actual = open(...args);
                    for (const name of ['success', 'error', 'blocked', 'upgradeneeded'])
                        actual['on' + name] = () => {
                            pending.result = actual.result;
                            pending['on' + name]?.();
                        };
                };
                return pending;
            };
        });
        await a.evaluate(() => store.logout());
        await b.waitForFunction(() => window.releaseOpen);
        await b.evaluate(() => {
            window.signingIn = store.login('synthetic-password');
        });
        await b.evaluate(() => releaseOpen());
        await b.evaluate(() => signingIn);
        assert.equal((await check(b)).authenticated, true);
        assert.equal(await b.evaluate(() => store.sessionState), 'loggedIn');
    });
    await test('queued pending and complete events settle normally without a new user action', async () => {
        const a = await fresh();
        await a.evaluate(() => store.login('synthetic-password'));
        const b = await newPage();
        await b.evaluate(() => {
            window.seenRaw = [];
            const observer = new BroadcastChannel('misub-session-events-v1');
            observer.onmessage = (e) => seenRaw.push(e.data.type);
            const open = indexedDB.open.bind(indexedDB);
            indexedDB.open = (...args) => {
                const pending = {};
                window.releaseOpen = () => {
                    const actual = open(...args);
                    actual.onsuccess = () => {
                        pending.result = actual.result;
                        pending.onsuccess();
                    };
                    actual.onerror = () => pending.onerror();
                };
                return pending;
            };
        });
        await a.evaluate(() => store.logout());
        await b.waitForFunction(
            () => seenRaw.includes('logout-pending') && seenRaw.includes('logout-complete')
        );
        await b.evaluate(() => releaseOpen());
        await b.waitForFunction(() => events.includes('logout-complete'));
        assert.equal(await b.evaluate(() => store.sessionState), 'loggedOut');
        assert.equal(await b.evaluate(() => store.logoutPending), false);
        assert.equal((await check(b)).authenticated, false);
    });
    await test('cleared localStorage cannot reuse a delayed login generation', async () => {
        const a = await fresh(),
            b = await newPage();
        const held = gate('/api/session/protocol');
        await start(a, 'login');
        await held.ready;
        await logout(b).catch(() => {});
        await b.evaluate(() => localStorage.clear());
        held.release();
        assert.equal((await a.evaluate(() => operation)).ok, false);
        assert.equal((await check(b)).authenticated, false);
    });
    await test('delayed IndexedDB open cannot revive login after logout and localStorage clear', async () => {
        const a = await fresh(),
            b = await newPage();
        await a.evaluate(() => {
            window.client = createClient({
                indexedDB: {
                    open(...args) {
                        const pending = {};
                        window.releaseOpen = () => {
                            const actual = indexedDB.open(...args);
                            for (const name of ['success', 'error', 'blocked', 'upgradeneeded'])
                                actual['on' + name] = () => {
                                    pending.result = actual.result;
                                    pending['on' + name]?.();
                                };
                        };
                        return pending;
                    },
                },
            });
        });
        await start(a, 'login');
        await a.waitForFunction(() => window.releaseOpen);
        await logout(b).catch(() => {});
        await login(b);
        assert.equal((await logout(b)).logoutConfirmed, true);
        await b.evaluate(() => localStorage.clear());
        await a.evaluate(() => releaseOpen());
        assert.equal((await a.evaluate(() => operation)).ok, false);
        assert.equal((await check(b)).authenticated, false);
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
    securityFixture?.sqlite.close();
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
