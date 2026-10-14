import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { securityDatabase } from '../fixtures/login-security-db.js';
import { createSessionFixture } from '../fixtures/session-authority.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
if (!process.env.MISUB_FORM_SESSION_MODE) {
    execFileSync(
        'git',
        [
            'diff',
            '--exit-code',
            'HEAD',
            '--',
            'src',
            'functions',
            'public',
            'package.json',
            'package-lock.json',
        ],
        { cwd: root, stdio: 'pipe' }
    );
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
        cwd: root,
        stdio: 'pipe',
    });
    const modes = [];
    for (const mode of ['legacy', 'd1-v1']) {
        const directory = resolve(evidence, mode);
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), directory], {
            cwd: root,
            env: { ...process.env, MISUB_FORM_SESSION_MODE: mode },
            stdio: 'inherit',
            timeout: 180000,
        });
        const result = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
        assert.equal(result.passed, true);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.kvWrites, []);
        modes.push({ mode, commit: result.commit, checks: result.checks });
    }
    await writeFile(
        resolve(evidence, 'report.json'),
        JSON.stringify(
            {
                passed: true,
                checks: modes.flatMap((m) => m.checks.map((c) => `${m.mode}: ${c}`)),
                errors: [],
                kvWrites: [],
                modes,
            },
            null,
            2
        )
    );
    process.exit(0);
}
const durable = process.env.MISUB_FORM_SESSION_MODE === 'd1-v1';
const session = createSessionFixture();
const initialIds = ['alpha', 'beta', 'gamma', 'delta', 'manual'];
const business = await createProtocolFixture({
    subscriptions: [
        ...['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, index) => ({
            id: name.toLowerCase(),
            name,
            url: `https://fixture-${name.toLowerCase()}.invalid/source`,
            enabled: index % 2 === 1,
            sortIndex: index,
        })),
        {
            id: 'manual',
            name: 'Synthetic manual',
            url: 'trojan://fixture@node.invalid:443',
            enabled: true,
            sortIndex: 4,
        },
    ],
    profiles: [
        {
            id: 'profile',
            name: 'Fixture profile',
            enabled: true,
            subscriptions: initialIds.slice(0, 4),
            manualNodes: ['manual'],
        },
    ],
    settings: { storageType: 'd1', defaultLocale: 'en-US' },
});
const security = securityDatabase();
const report = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(),
    distEntrySha256: createHash('sha256')
        .update(await readFile(resolve(dist, 'index.html')))
        .digest('hex'),
    checks: [],
    requests: [],
    errors: [],
    externalRequests: [],
    kvWrites: [],
    limits: [
        'Synthetic identities and subscriptions; two independent in-memory SQLite databases.',
        'Production-built UI with real form controls, API handlers and browser cookies on loopback Chromium.',
        'API interception controls responses; no Cloudflare, production bindings, Safari, real nodes or remote subscription fetch.',
        'Read-only Pinia inspection is used for assertions; edits use DOM controls.',
    ],
};
const env = {
    ...business.env,
    ...(durable ? { SESSION_AUTH_MODE: 'd1-v1', MISUB_SESSION_DB: session.binding } : {}),
    ADMIN_PASSWORD: 'synthetic-browser-password',
    COOKIE_SECRET: 'synthetic-browser-secret',
    MISUB_SECURITY_DB: security.binding,
    MISUB_KV: {
        get: async (key) => (key === 'SYSTEM_COOKIE_SECRET' ? 'synthetic-browser-secret' : null),
        put: async (key) => {
            report.kvWrites.push(key);
            throw new Error('KV writes forbidden');
        },
        delete: async (key) => {
            report.kvWrites.push(key);
            throw new Error('KV deletes forbidden');
        },
    },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
    report.externalRequests.push('backend');
    throw new Error('External fetch forbidden');
};
const server = createServer(async (request, reply) => {
    const target = resolve(dist, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!target.startsWith(dist + sep) && target !== dist) return reply.writeHead(403).end();
    try {
        const path = extname(target) ? target : resolve(dist, 'index.html');
        reply.setHeader(
            'Content-Type',
            {
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.html': 'text/html',
                '.svg': 'image/svg+xml',
            }[extname(path)] || 'application/octet-stream'
        );
        reply.end(await readFile(path));
    } catch {
        reply.writeHead(404).end();
    }
});
let browser, context, origin;
let nextGate = null;
const activeGates = new Set();
function gate({ path = '/api/misubs', method = 'POST', mode = 'hold' } = {}) {
    assert.equal(nextGate, null);
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
    const value = { path, method, mode, release, ready, held, reached, delivered, finished };
    nextGate = value;
    activeGates.add(value);
    return value;
}
async function snapshot(page) {
    return page.evaluate(() => {
        const data = document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('data');
        return JSON.parse(
            JSON.stringify({
                subscriptions: data.subscriptions,
                profiles: data.profiles,
                dirty: data.isDirty,
                state: data.saveState,
                conflict: data.subscriptionConflict,
            })
        );
    });
}
async function waitState(page, state, dirty) {
    await page.waitForFunction(
        ({ state, dirty }) => {
            const data = document
                .querySelector('#app')
                .__vue_app__.config.globalProperties.$pinia._s.get('data');
            return data.saveState === state && data.isDirty === dirty;
        },
        { state, dirty }
    );
}
const card = (page, name) =>
    page
        .locator('div.group.relative')
        .filter({ has: page.getByRole('heading', { name, exact: true }) });
async function edit(page, name, nextName) {
    await card(page, name).hover();
    await card(page, name).getByRole('button', { name: 'Edit', exact: true }).click();
    const modal = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: 'Edit source', exact: true }) });
    await modal.locator('#sub-edit-name').fill(nextName);
    await modal.getByRole('button', { name: 'Confirm', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
}
async function save(page) {
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await waitState(page, 'success', false);
}
async function sources(page, query = '') {
    await page.goto(`${origin}/dashboard/groups${query}`);
    await page.getByTestId('subscription-search').waitFor();
}
async function login(page) {
    await page.goto(`${origin}/login`);
    await page.locator('input[autocomplete=current-password]').fill(env.ADMIN_PASSWORD);
    await page.locator('button[type=submit]').click();
    await page.waitForURL('**/dashboard');
}
async function notifications(page) {
    await page
        .getByRole('button', { name: /^Notifications,/ })
        .filter({ visible: true })
        .click();
    const modal = page.getByRole('dialog', { name: 'Notifications', exact: true });
    await modal.waitFor();
    const button = modal.getByRole('button', { name: 'Mark this page as read', exact: true });
    await button.waitFor();
    await page.waitForFunction(
        () =>
            !document
                .querySelector('#app')
                .__vue_app__.config.globalProperties.$pinia._s.get('notifications').loading
    );
    if (await button.isEnabled()) await button.click();
    await modal.getByText('0 unread', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
}
const persisted = (id) =>
    JSON.parse(business.sql.prepare('SELECT data FROM subscriptions WHERE id=?').get(id).data);
function preserved() {
    const ids = business.sql
        .prepare('SELECT id FROM subscriptions ORDER BY id')
        .all()
        .map((row) => row.id);
    assert.deepEqual(ids, [...initialIds].sort());
    const profile = JSON.parse(
        business.sql.prepare('SELECT data FROM profiles WHERE id=?').get('profile').data
    );
    assert.deepEqual(profile.subscriptions, initialIds.slice(0, 4));
    assert.deepEqual(profile.manualNodes, ['manual']);
}
try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    origin = 'https://subscription-forms.invalid';
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.MISUB_BROWSER_EXECUTABLE || undefined,
    });
    report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
        localStorage.setItem('misub:locale', 'en-US');
    });
    context.on('page', (page) =>
        page.on('pageerror', (error) => report.errors.push(error.message))
    );
    await context.route('**/*', async (route) => {
        const incoming = route.request(),
            url = new URL(incoming.url());
        if (url.origin !== origin) {
            report.externalRequests.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) {
            const target = resolve(dist, `.${url.pathname}`);
            assert.ok(target.startsWith(dist + sep) || target === dist);
            const file = extname(target) ? target : resolve(dist, 'index.html');
            const contentType =
                {
                    '.js': 'text/javascript',
                    '.css': 'text/css',
                    '.html': 'text/html',
                    '.svg': 'image/svg+xml',
                }[extname(file)] || 'application/octet-stream';
            return route.fulfill({ contentType, body: await readFile(file) });
        }
        if (url.pathname === '/api/github/release') return route.fulfill({ json: {} });
        const control =
            nextGate?.path === url.pathname && nextGate.method === incoming.method()
                ? nextGate
                : null;
        if (control) nextGate = null;
        const headers = await incoming.allHeaders();
        headers['cf-connecting-ip'] = '203.0.113.19';
        const request = new Request(incoming.url(), {
            method: incoming.method(),
            headers,
            ...(incoming.postData() ? { body: incoming.postData() } : {}),
        });
        Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
        const result =
            control?.mode === 'unavailable'
                ? Response.json(
                      {
                          success: false,
                          code: 'synthetic_unavailable',
                          message: 'Synthetic unavailable',
                      },
                      { status: 503 }
                  )
                : await handleApiRequest(request, env);
        const response = {
            status: result.status,
            headers: Object.fromEntries(result.headers),
            body: await result.text(),
        };
        if (result.headers.getSetCookie().length)
            response.headers['set-cookie'] = result.headers.getSetCookie().join('\n');
        report.requests.push({
            path: url.pathname,
            method: incoming.method(),
            status: result.status,
            ...(url.pathname === '/api/misubs'
                ? { payload: JSON.parse(incoming.postData()), body: JSON.parse(response.body) }
                : {}),
            control: control?.mode,
        });
        if (control) {
            control.ready();
            if (control.mode === 'hold') await control.held;
            activeGates.delete(control);
            if (control.mode === 'drop') {
                await route.abort('failed');
                control.delivered();
                return;
            }
        }
        await route.fulfill(response);
        control?.delivered();
    });
    const page = await context.newPage();
    await login(page);
    await sources(page);

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const add = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: 'Add source', exact: true }) });
    await add.locator('#sub-edit-name').fill('Epsilon');
    await add.locator('#sub-edit-url').fill('https://fixture-epsilon.invalid/source');
    await add.getByRole('button', { name: 'Confirm', exact: true }).click();
    await add.waitFor({ state: 'hidden' });
    await save(page);
    const addedId = (await snapshot(page)).subscriptions.find((item) => item.name === 'Epsilon').id;
    assert.equal(persisted(addedId).url, 'https://fixture-epsilon.invalid/source');
    await edit(page, 'Epsilon', 'Epsilon edited');
    await save(page);
    assert.equal(persisted(addedId).name, 'Epsilon edited');
    await card(page, 'Epsilon edited').hover();
    await card(page, 'Epsilon edited').getByRole('button', { name: 'Delete', exact: true }).click();
    await save(page);
    preserved();
    report.checks.push(
        'Actual Add/Edit/Delete dialogs and Save now persist correctly; four existing sources, hidden manual node and profile references remain intact.'
    );

    await edit(page, 'Alpha', 'Alpha first');
    const held = gate();
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await held.reached;
    assert.equal(persisted('alpha').name, 'Alpha first');
    await edit(page, 'Alpha first', 'Alpha later');
    await notifications(page);
    held.release();
    await waitState(page, 'idle', true);
    assert.equal(
        (await snapshot(page)).subscriptions.find((item) => item.id === 'alpha').name,
        'Alpha later'
    );
    await save(page);
    assert.equal(persisted('alpha').name, 'Alpha later');
    preserved();
    report.checks.push(
        'A real form edit during a committed but held save survives acknowledgement and saves next; notification read completes while the subscription response is held.'
    );

    await edit(page, 'Beta', 'Beta retry');
    const drop = gate({ mode: 'drop' });
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await drop.reached;
    await waitState(page, 'idle', true);
    assert.equal(persisted('beta').name, 'Beta retry');
    const failedRequest = report.requests
        .filter((request) => request.path === '/api/misubs')
        .at(-1);
    await edit(page, 'Delta', 'Delta later');
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await waitState(page, 'idle', true);
    const retriedRequest = report.requests
        .filter((request) => request.path === '/api/misubs')
        .at(-1);
    assert.deepEqual(retriedRequest.payload, failedRequest.payload);
    assert.equal(retriedRequest.body.replayed, true);
    assert.deepEqual(retriedRequest.body.receipt, failedRequest.body.receipt);
    assert.deepEqual(retriedRequest.body.data.version, failedRequest.body.data.version);
    assert.equal(persisted('delta').name, 'Delta');
    assert.equal(
        (await snapshot(page)).subscriptions.find((item) => item.id === 'delta').name,
        'Delta later'
    );
    await save(page);
    assert.equal(persisted('delta').name, 'Delta later');
    preserved();
    report.checks.push(
        'Committed lost-response retry reuses the identical operation payload; later form edits remain dirty until separately saved.'
    );

    await edit(page, 'Delta later', 'Delta recovered');
    const unavailable = gate({ mode: 'unavailable' });
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await unavailable.reached;
    await waitState(page, 'idle', true);
    assert.equal(persisted('delta').name, 'Delta later');
    await notifications(page);
    await save(page);
    assert.equal(persisted('delta').name, 'Delta recovered');
    report.checks.push(
        'Synthetic pre-commit 503 keeps real form edits retryable and leaves security notifications usable.'
    );

    await sources(page, '?status=disabled');
    await page.getByTestId('subscription-status-filter').waitFor();
    await page.getByRole('button', { name: 'Batch', exact: true }).click();
    await page.getByRole('button', { name: 'Sort', exact: true }).click();
    assert.equal(await page.locator('.cursor-move').count(), 4);
    await page
        .locator('.cursor-move')
        .filter({ has: page.getByRole('heading', { name: 'Gamma', exact: true }) })
        .dragTo(
            page
                .locator('.cursor-move')
                .filter({ has: page.getByRole('heading', { name: 'Alpha later', exact: true }) })
        );
    await page.waitForFunction(
        () =>
            document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('data')
                .subscriptions[0].id === 'gamma'
    );
    await save(page);
    preserved();
    await page.reload();
    await page.getByTestId('subscription-status-filter').waitFor();
    assert.deepEqual(
        (await snapshot(page)).subscriptions.map((item) => item.id),
        ['gamma', 'alpha', 'beta', 'delta', 'manual']
    );
    await page.getByTestId('subscription-status-filter-clear').click();
    await page.getByTestId('subscription-search').fill('Beta retry');
    await card(page, 'Beta retry').waitFor();
    assert.equal(await page.locator('div.group.relative h3').count(), 1);
    await page.getByRole('button', { name: 'Batch', exact: true }).click();
    await page.getByRole('button', { name: 'Sort', exact: true }).click();
    assert.equal(await page.locator('.cursor-move').count(), 4);
    assert.equal(await page.getByTestId('subscription-search').isDisabled(), true);
    await page
        .locator('.cursor-move')
        .filter({ has: page.getByRole('heading', { name: 'Delta recovered', exact: true }) })
        .dragTo(
            page
                .locator('.cursor-move')
                .filter({ has: page.getByRole('heading', { name: 'Gamma', exact: true }) })
        );
    await page.waitForFunction(
        () =>
            document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('data')
                .subscriptions[0].id === 'delta'
    );
    await save(page);
    preserved();
    await page.reload();
    await page.getByTestId('subscription-search').waitFor();
    assert.deepEqual(
        (await snapshot(page)).subscriptions.map((item) => item.id),
        ['delta', 'gamma', 'beta', 'alpha', 'manual']
    );
    report.checks.push(
        'Actual status-filtered drag reorders only visible positions; search-to-sort intentionally shows all four sources, preserves the manual node/profile references, and reload confirms order.'
    );

    await page.goto(`${origin}/dashboard/subscriptions`);
    const profileCard = page
        .locator('div.group')
        .filter({ has: page.locator('p[title="Fixture profile"]') });
    await profileCard.hover();
    await profileCard.getByRole('button', { name: 'Edit', exact: true }).click();
    const profileModal = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: 'Edit profile', exact: true }) });
    await profileModal.locator('#profile-name').fill('Fixture profile edited');
    await profileModal.getByRole('button', { name: 'Confirm', exact: true }).click();
    await profileModal.waitFor({ state: 'hidden' });
    await save(page);
    assert.equal(
        JSON.parse(business.sql.prepare('SELECT data FROM profiles WHERE id=?').get('profile').data)
            .name,
        'Fixture profile edited'
    );
    preserved();
    await page.reload();
    await page.locator('p[title="Fixture profile edited"]').waitFor();
    await sources(page);
    report.checks.push(
        'Actual profile name edit and reload preserve disabled-source references and the manual-node association.'
    );

    const other = await context.newPage();
    await sources(other);
    await edit(page, 'Gamma', 'Gamma tab one');
    await edit(other, 'Gamma', 'Gamma tab two');
    await save(page);
    await other.getByRole('button', { name: 'Save now', exact: true }).click();
    await waitState(other, 'idle', true);
    assert.equal((await snapshot(other)).conflict, true);
    assert.equal(persisted('gamma').name, 'Gamma tab one');
    assert.equal(
        (await snapshot(other)).subscriptions.find((item) => item.id === 'gamma').name,
        'Gamma tab two'
    );
    await notifications(other);
    await other.getByRole('button', { name: 'Discard', exact: true }).click();
    await waitState(other, 'idle', false);
    assert.equal(
        (await snapshot(other)).subscriptions.find((item) => item.id === 'gamma').name,
        'Gamma tab one'
    );
    preserved();
    await other.close();
    report.checks.push(
        'Two actual editor tabs conflict on stale snapshot; the loser keeps its local edit, notifications still work, and explicit Discard loads the winner.'
    );

    await edit(page, 'Gamma tab one', 'Gamma before logout');
    const late = gate();
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await late.reached;
    await page
        .getByRole('button', { name: 'Log out', exact: true })
        .filter({ visible: true })
        .click();
    await page.waitForURL((url) => url.pathname === '/login');
    late.release();
    await late.finished;
    await page.waitForFunction(
        () =>
            document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('data')
                .subscriptions.length === 0
    );
    if (durable) {
        const state = await page.evaluate(async () => (await fetch('/api/session/check')).json());
        assert.equal(state.authenticated, false);
        await page.reload();
        await page.locator('input[autocomplete=current-password]').waitFor();
    } else
        assert.equal(
            (await context.cookies()).some((cookie) => cookie.name === 'auth_session'),
            false
        );
    await login(page);
    await sources(page);
    assert.equal(
        (await snapshot(page)).subscriptions.find((item) => item.id === 'gamma').name,
        'Gamma before logout'
    );
    assert.equal((await snapshot(page)).dirty, false);
    preserved();
    report.checks.push(
        'Actual logout while a committed save response is held clears private display and authentication; later login loads the committed authority without resurrecting old dirty state.'
    );
    await page.screenshot({ path: resolve(evidence, 'actual-source-forms.png') });
    assert.deepEqual(report.kvWrites, []);
    assert.deepEqual(report.errors, []);
    assert.ok(report.externalRequests.every((value) => value === 'https://fonts.googleapis.com'));
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    for (const [index, page] of (context?.pages() || []).entries()) {
        await writeFile(
            resolve(evidence, `failure-page-${index}.txt`),
            await page.locator('body').innerText()
        );
        await page.screenshot({ path: resolve(evidence, `failure-page-${index}.png`) });
    }
    throw error;
} finally {
    for (const control of activeGates) control.release();
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    if (server.listening) await new Promise((done) => server.close(done));
    business.close();
    session.close();
    security.sqlite.close();
    globalThis.fetch = originalFetch;
}
