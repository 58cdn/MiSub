import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Built App, Entrance, Login and session client; every API response is synthetic.
const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
const evidence = resolve(process.argv[2] || 'tmp/login-feedback');
await mkdir(evidence, { recursive: true });
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root,
    stdio: 'pipe',
});
const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(dist + sep) && path !== dist) return response.writeHead(403).end();
    try {
        const actual = extname(path) ? path : resolve(dist, 'index.html');
        response.setHeader(
            'Content-Type',
            {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.png': 'image/png',
                '.svg': 'image/svg+xml',
                '.json': 'application/json',
            }[extname(actual)] || 'application/octet-stream'
        );
        response.end(await readFile(actual));
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
});
const report = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    checks: [],
    external: [],
    unexpectedApi: [],
    pageErrors: [],
    requests: [],
    scope: 'Built App + Entrance + Login with loopback mock APIs, isolated Chromium profiles. No production login, credentials, configuration or external traffic.',
};
let context, page, mode, protocolMode, dataMode, loggedIn, loginCalled, logoutCalls;
const snapshot = {
    misubs: [],
    profiles: [],
    ruleTemplates: [],
    config: { isDefaultPassword: false },
};
async function fresh(path = '/fdc') {
    await context?.close();
    mode = 'unconfirmed';
    protocolMode = 'legacy';
    dataMode = 'normal';
    loggedIn = false;
    loginCalled = false;
    logoutCalls = 0;
    context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' });
    await context.route('**/*', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        const json = (body, status = 200) =>
            route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== origin) {
            // Optional public font is deliberately blocked, like every other external request.
            if (url.hostname !== 'fonts.googleapis.com') report.external.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        report.requests.push({ path: url.pathname, method: request.method(), mode });
        if (url.pathname === '/api/session/protocol') {
            if (protocolMode === 'pending') return;
            if (protocolMode === 'network') return route.abort('failed');
            return json(
                protocolMode === 'modern'
                    ? { protocol: 'd1-v1', serverNow: Date.now() }
                    : { protocol: 'legacy' }
            );
        }
        if (url.pathname === '/api/public_config')
            return json({ enablePublicPage: true, isLoginPath: true });
        if (url.pathname === '/api/data') {
            if (loginCalled && dataMode === '503')
                return json({ error: 'synthetic unavailable' }, 503);
            if (loginCalled && dataMode === 'network') return route.abort('failed');
            return json(loggedIn ? snapshot : { authenticated: false });
        }
        if (url.pathname === '/api/login') {
            assert.equal(request.method(), 'POST');
            assert.equal(request.postDataJSON().password, 'synthetic-password');
            loginCalled = true;
            if (mode === '401') return json({ error: 'Synthetic password rejected' }, 401);
            if (mode === '429') return json({ code: 'login_locked', retryAfter: 600 }, 429);
            if (mode === '500' || mode === '503')
                return json({ error: 'synthetic unavailable' }, Number(mode));
            if (mode === 'network') return route.abort('failed');
            if (mode === 'success') loggedIn = true;
            return json({ success: true });
        }
        if (url.pathname === '/api/session/cleanup') return json({ more: false });
        if (url.pathname === '/api/session/capture')
            return json({ id: 'synthetic-snapshot', ids: [], receipt: 'synthetic-receipt' });
        if (url.pathname === '/api/logout') {
            logoutCalls++;
            if (mode === 'recovery-failed') return json({ error: 'synthetic unavailable' }, 503);
            return json({ success: true });
        }
        if (url.pathname === '/api/github/release') return json({});
        if (url.pathname === '/api/detect_legacy_d1')
            return json({ success: true, data: { hasLegacyData: false } });
        if (url.pathname === '/api/settings') return json({ defaultLocale: 'en-US' });
        if (url.pathname === '/api/admin/notifications')
            return json({
                success: true,
                enabled: false,
                items: [],
                unreadCount: 0,
                nextCursor: null,
            });
        if (['/api/clients', '/api/guestbook/manage'].includes(url.pathname))
            return json({ success: true, data: [] });
        report.unexpectedApi.push(url.pathname);
        return json({ error: 'unexpected fixture API' }, 500);
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.goto(origin + path);
    await page.locator('input[autocomplete=current-password]').waitFor();
}
async function submit() {
    await page.locator('input[autocomplete=current-password]').fill('synthetic-password');
    await page.locator('button[type=submit]').click();
}
async function visibleError(pattern) {
    await page.locator('#login-error').waitFor({ timeout: 12000 });
    assert.match(await page.locator('#login-error').innerText(), pattern);
    assert.equal(await page.locator('button[type=submit]').isEnabled(), true);
    assert.equal(new URL(page.url()).pathname, '/fdc');
}
try {
    await fresh();
    await submit();
    await visibleError(/session/i);
    await page.screenshot({ path: resolve(evidence, 'session-unconfirmed.png') });
    report.checks.push(
        '200 login followed by authenticated:false keeps a visible session error on /fdc'
    );

    for (const value of ['401', '429', '500', '503', 'network']) {
        await fresh();
        mode = value;
        await submit();
        if (value === '429') {
            await page.locator('#login-locked').waitFor();
            assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
        } else
            await visibleError(
                value === '401'
                    ? /password/i
                    : value === '500'
                      ? /500/
                      : /service|network|fetch|try/i
            );
        report.checks.push(`Login ${value} has visible feedback`);
    }
    for (const value of ['503', 'network']) {
        await fresh();
        dataMode = value;
        await submit();
        await visibleError(/session/i);
        report.checks.push(`Session confirmation ${value} preserves the login error`);
    }
    for (const value of ['network', 'pending']) {
        await fresh();
        protocolMode = value;
        await submit();
        await visibleError(value === 'pending' ? /timed out/i : /network|fetch/i);
        assert.equal(loginCalled, false);
        report.checks.push(`Protocol ${value} ends with feedback without submitting a login`);
    }
    await fresh();
    protocolMode = 'modern';
    mode = 'recovery-failed';
    await page.evaluate(async () => {
        const db = await new Promise((done, reject) => {
            const open = indexedDB.open('misub-session-coordination-v1', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('coordination');
            open.onsuccess = () => done(open.result);
            open.onerror = () => reject(open.error);
        });
        await new Promise((done, reject) => {
            const tx = db.transaction('coordination', 'readwrite');
            tx.objectStore('coordination').put(
                {
                    version: 1,
                    intents: {},
                    known: {},
                    event: { id: 'synthetic-event', type: 'logout-pending' },
                    recovery: {
                        id: 'synthetic-recovery',
                        proof: 'synthetic-proof',
                        createdAt: Date.now(),
                        intentIds: [],
                        ids: [],
                        tickets: [],
                        snapshot: null,
                    },
                },
                'state'
            );
            tx.oncomplete = done;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    });
    await page.reload();
    await page.getByRole('button', { name: /retry logout/i }).waitFor();
    assert.match(await page.locator('[role=alert]').first().innerText(), /not yet confirmed/i);
    await page.getByRole('button', { name: /retry logout/i }).click();
    await visibleError(/not yet confirmed/i);
    assert.equal(logoutCalls, 1);
    report.checks.push(
        'Custom login entry displays durable logout recovery and failed retry feedback'
    );
    mode = 'recovery-success';
    await page.getByRole('button', { name: /retry logout/i }).click();
    await page.waitForURL((url) => url.pathname === '/');
    assert.equal(logoutCalls, 2);
    assert.equal(await page.getByRole('button', { name: /retry logout/i }).count(), 0);
    report.checks.push('Confirmed logout clears recovery controls reactively');

    await fresh();
    mode = 'success';
    await submit();
    await page.waitForURL((url) => url.pathname === '/dashboard');
    assert.equal(await page.locator('#login-error').count(), 0);
    report.checks.push('Confirmed login navigates to the dashboard');
    assert.deepEqual(report.external, []);
    assert.deepEqual(report.unexpectedApi, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
} catch (error) {
    report.failure = {
        message: error.message,
        path: page && new URL(page.url()).pathname,
        body: await page?.locator('body').innerText(),
    };
    await page?.screenshot({ path: resolve(evidence, 'failure.png') });
    throw error;
} finally {
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await new Promise((done) => server.close(done));
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, evidence }));
