import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Current clean checkout: freshly built frontend + actual backend + memory SQLite.
// No separate historical build, ambient credentials or production storage.
const root = fileURLToPath(new URL('../..', import.meta.url));
const frontendCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
}).trim();
const frontendPaths = [
    'src',
    'public',
    'index.html',
    'vite.config.js',
    'package.json',
    'package-lock.json',
];
execFileSync('git', ['diff', '--exit-code', frontendCommit, '--', ...frontendPaths], {
    cwd: root,
    stdio: 'pipe',
});
const backendRoot = root;
assert.ok(
    !process.env.MISUB_LOGIN_SECURITY_BACKEND_ROOT ||
        resolve(process.env.MISUB_LOGIN_SECURITY_BACKEND_ROOT) === resolve(root),
    'Backend must be the current checkout'
);
const backendCommit = frontendCommit;
const backendFiles = [
    'functions/modules/api-router.js',
    'functions/modules/auth-middleware.js',
    'functions/services/login-security.js',
    'functions/services/login-security-store.js',
    'functions/services/login-security-metadata.js',
    'tests/fixtures/login-security-db.js',
    'migrations/login-security/0001_login_security.sql',
];
for (const path of backendFiles) {
    const pinned = execFileSync('git', ['show', `${backendCommit}:${path}`], {
        cwd: backendRoot,
        encoding: 'utf8',
    });
    assert.equal(
        (await readFile(resolve(backendRoot, path), 'utf8')).replaceAll('\r\n', '\n'),
        pinned.replaceAll('\r\n', '\n'),
        `Backend source differs: ${path}`
    );
}
const dist = resolve(root, 'dist');
assert.ok(
    !process.env.MISUB_INTEGRATION_DIST || resolve(process.env.MISUB_INTEGRATION_DIST) === dist,
    'Build must be in the current checkout'
);
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root,
    stdio: 'pipe',
});
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/notification-integration'));
await mkdir(evidence, { recursive: true });
const report = {
    frontendCommit,
    frontendPaths,
    startedAt: new Date().toISOString(),
    frontendCheckoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
    }).trim(),
    integrationWorktreeBase: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: backendRoot,
        encoding: 'utf8',
    }).trim(),
    distEntrySha256: createHash('sha256')
        .update(await readFile(resolve(dist, 'index.html')))
        .digest('hex'),
    buildProvenance:
        'Vite build executed by this entry on the clean current checkout immediately before serving the resulting dist',
    backendCommit,
    backendFiles,
    storage:
        'SQLite :memory: using the backend D1 interface fixture; no persistent database or migration command',
    transport:
        'Loopback static server; browser API interception dispatches the actual backend router with synthetic Cloudflare request metadata',
    limitations: [
        'No Cloudflare/D1 deployment or production end-to-end test',
        'No real source-IP trust verification',
        'No Safari execution',
    ],
    checks: [],
    api: [],
    screenshots: [],
    externalRequestsBlocked: [],
    unexpectedApi: [],
    outboundBackendRequests: [],
    mainStoreWrites: [],
    pageErrors: [],
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
    report.outboundBackendRequests.push('blocked');
    throw new Error('Network access is disabled in local integration');
};
const loadBackend = (path) => import(pathToFileURL(resolve(backendRoot, path)).href);
const { handleApiRequest } = await loadBackend('functions/modules/api-router.js');
const { authMiddleware } = await loadBackend('functions/modules/auth-middleware.js');
const { securityDatabase } = await loadBackend('tests/fixtures/login-security-db.js');
const { SettingsCache } = await loadBackend('functions/storage-adapter.js');
SettingsCache.clear();
const db = securityDatabase();
const env = {
    ADMIN_PASSWORD: 'local-integration-fixture-password',
    COOKIE_SECRET: 'local-integration-fixture-secret',
    MISUB_SECURITY_DB: db.binding,
    MISUB_KV: {
        get: async (key) =>
            key === 'SYSTEM_COOKIE_SECRET' ? 'local-integration-fixture-secret' : null,
        put: async (key) => {
            report.mainStoreWrites.push(key);
            throw new Error('Main store is read-only');
        },
        delete: async (key) => {
            report.mainStoreWrites.push(key);
            throw new Error('Main store is read-only');
        },
    },
};
let backendClockOffset = 0;
let backendQueue = Promise.resolve();
const realNow = Date.now;
const dispatch = (request) => {
    const pending = backendQueue.then(async () => {
        Date.now = () => realNow() + backendClockOffset;
        try {
            return await handleApiRequest(request, env);
        } finally {
            Date.now = realNow;
        }
    });
    backendQueue = pending.catch(() => {});
    return pending;
};
const server = createServer(async (request, response) => {
    const path = resolve(
        dist,
        `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`
    );
    if (!path.startsWith(dist + sep) && path !== dist) return response.writeHead(403).end();
    try {
        const actual = extname(path) ? path : resolve(dist, 'index.html');
        const body = await readFile(actual);
        response.setHeader(
            'Content-Type',
            {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.png': 'image/png',
                '.svg': 'image/svg+xml',
            }[extname(actual)] || 'application/octet-stream'
        );
        response.end(body);
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
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
});
await context.addInitScript(() => localStorage.setItem('misub:locale', 'en-US'));
await context.route('**/*', async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (url.origin !== origin) {
        report.externalRequestsBlocked.push(`${url.origin}${url.pathname}`);
        return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const headers = await incoming.allHeaders();
    headers['cf-connecting-ip'] = '203.0.113.10';
    const request = new Request(incoming.url(), {
        method: incoming.method(),
        headers,
        ...(incoming.postData() ? { body: incoming.postData() } : {}),
    });
    Object.defineProperty(request, 'cf', { value: { colo: 'LOCAL_FIXTURE' } });
    if (
        [
            '/api/session/protocol',
            '/api/login',
            '/api/logout',
            '/api/admin/notifications',
            '/api/admin/notifications/read',
            '/api/admin/login-audit',
        ].includes(url.pathname)
    ) {
        const response = await dispatch(request);
        const body = await response.text();
        const payload = JSON.parse(body);
        report.api.push({
            method: request.method,
            path: `${url.pathname}${url.search}`,
            status: response.status,
            ...(url.pathname.endsWith('/read') ? { ids: JSON.parse(incoming.postData()).ids } : {}),
            payload,
        });
        return route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body,
        });
    }
    if (incoming.method() === 'GET') {
        if (url.pathname === '/api/data')
            return json(
                (await authMiddleware(request, env))
                    ? { misubs: [], profiles: [], config: { isDefaultPassword: false } }
                    : { authenticated: false }
            );
        if (url.pathname === '/api/public_config')
            return json({ enablePublicPage: true, isLoginPath: true, customLoginPath: 'login' });
        if (url.pathname === '/api/github/release') return json({});
        if (url.pathname === '/api/detect_legacy_d1')
            return json({ success: true, data: { hasLegacyData: false } });
        if (url.pathname === '/api/settings') return json({ defaultLocale: 'en-US' });
        if (['/api/guestbook/manage', '/api/clients'].includes(url.pathname))
            return json({ success: true, data: [] });
    }
    report.unexpectedApi.push({ method: request.method, path: url.pathname });
    return json({ error: 'Blocked by local integration allowlist' }, 404);
});
const page = await context.newPage();
page.on('pageerror', (error) => report.pageErrors.push(error.message));
const bell = () => page.getByRole('button', { name: /^Notifications,/ }).filter({ visible: true });
const dialog = () => page.getByRole('dialog', { name: 'Notifications', exact: true });
const unread = () =>
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_events WHERE read_at IS NULL').get()
        .n;
const eventIds = async () =>
    dialog()
        .locator('[data-event-id]')
        .evaluateAll((rows) => rows.map((row) => Number(row.dataset.eventId)));
const screenshot = async (name) => {
    await page.screenshot({ path: resolve(evidence, `${name}.png`) });
    report.screenshots.push(`${name}.png`);
};
async function submit(password) {
    await page.locator('input[autocomplete=current-password]').fill(password);
    const reply = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/login'
    );
    await page.locator('button[type=submit]').click();
    const response = await reply;
    return { status: response.status(), body: await response.json() };
}
async function api(path, body) {
    return page.evaluate(
        async ({ path, body }) => {
            const response = await fetch(
                path,
                body === undefined
                    ? {}
                    : {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                      }
            );
            return { status: response.status, body: await response.json() };
        },
        { path, body }
    );
}
try {
    await page.goto(`${origin}/login`);
    for (const path of ['/api/admin/notifications', '/api/admin/login-audit']) {
        assert.equal((await api(path)).status, 401);
    }
    assert.equal((await api('/api/admin/notifications/read', { ids: [1] })).status, 401);
    assert.equal(unread(), 0);
    report.checks.push(
        'Without an administrator session the actual notification, audit and mark-read endpoints all return 401 and leave storage unchanged'
    );
    for (let count = 1; count <= 9; count++) {
        assert.equal((await submit('local-wrong-password')).status, 401);
        await page.getByText('密码错误', { exact: true }).waitFor();
    }
    await screenshot('login-password-error');
    const locked = await submit('local-wrong-password');
    assert.equal(locked.status, 429);
    assert.equal(locked.body.retryAfter, 600);
    await page.locator('#login-locked').waitFor();
    assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
    assert.equal((await api('/api/login', { password: env.ADMIN_PASSWORD })).status, 429);
    assert.equal(
        (await context.cookies()).filter((cookie) => cookie.name === 'auth_session').length,
        0
    );
    assert.equal(
        db.sqlite.prepare('SELECT locked_until FROM login_security_ips').get().locked_until,
        locked.body.lockedUntil
    );
    await screenshot('login-locked');
    report.checks.push(
        'Actual backend returns 401 for attempts 1-9 and 429 on attempt 10; UI renders error/countdown, disables submit, and locked correct-password retry cannot authenticate or extend the lock'
    );

    backendClockOffset = 600001;
    await page.reload();
    const signedIn = await submit(env.ADMIN_PASSWORD);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.loginSecurity.warning.failedAttempts, 10);
    await page.getByText('Login security warning', { exact: true }).waitFor();
    assert.equal(
        (await context.cookies()).find((cookie) => cookie.name === 'auth_session')?.httpOnly,
        true
    );
    for (let count = 0; count < 22; count++)
        assert.equal((await api('/api/login', { password: env.ADMIN_PASSWORD })).status, 200);
    assert.equal(unread(), 24);
    await page.getByRole('button', { name: 'View security notifications', exact: true }).click();
    await dialog().getByText('24 unread', { exact: true }).waitFor();
    assert.deepEqual(
        await eventIds(),
        Array.from({ length: 20 }, (_, index) => 24 - index)
    );
    assert.equal(unread(), 24);
    await screenshot('notifications-page-1');
    await dialog().getByRole('button', { name: 'Next', exact: true }).click();
    await dialog().getByText('Page 2', { exact: true }).waitFor();
    assert.deepEqual(await eventIds(), [4, 3, 2, 1]);
    assert.equal(unread(), 24);
    await screenshot('notifications-page-2');
    await dialog()
        .getByRole('button', { name: /^Mark as read: Failed password attempts/ })
        .click();
    await dialog().getByText('23 unread', { exact: true }).waitFor();
    assert.equal(await page.getByText('Login security warning', { exact: true }).count(), 0);
    await dialog().getByRole('button', { name: 'Mark this page as read', exact: true }).click();
    await dialog().getByText('20 unread', { exact: true }).waitFor();
    assert.deepEqual(
        report.api
            .filter(
                (entry) => entry.path === '/api/admin/notifications/read' && entry.status === 200
            )
            .map((entry) => entry.ids),
        [[1], [4, 3, 2]]
    );
    const readRows = db.sqlite
        .prepare(
            'SELECT id,read_at FROM login_security_events WHERE read_at IS NOT NULL ORDER BY id'
        )
        .all();
    assert.deepEqual(
        readRows.map((row) => row.id),
        [1, 2, 3, 4]
    );
    assert.equal((await api('/api/admin/notifications/read', { ids: [1, 2, 3, 4] })).status, 200);
    assert.deepEqual(
        db.sqlite
            .prepare(
                'SELECT id,read_at FROM login_security_events WHERE read_at IS NOT NULL ORDER BY id'
            )
            .all(),
        readRows
    );
    assert.equal(unread(), 20);
    await screenshot('notifications-read');
    report.checks.push(
        'After a simulated 10-minute backend clock advance, real login creates a warning and session; 24 persisted events paginate 20/4 with exclusive before=5, GET leaves unread unchanged, explicit read updates only IDs 1-4 and is idempotent'
    );

    await page.keyboard.press('Escape');
    await page.goto(`${origin}/dashboard/security`);
    await page.getByRole('heading', { name: 'Login security', exact: true }).waitFor();
    const audit = page.getByRole('region', { name: 'Login security', exact: true });
    await audit.locator('[data-event-id="24"]').waitFor();
    assert.equal(await audit.locator('[data-event-id]').count(), 20);
    await audit.getByRole('button', { name: 'Next', exact: true }).click();
    await audit.getByText('Page 2', { exact: true }).waitFor();
    assert.equal(await audit.locator('[data-event-id]').count(), 3);
    assert.equal(
        await audit.getByText('Failed password attempts detected', { exact: true }).count(),
        0
    );
    assert.equal(unread(), 20);
    report.checks.push(
        'Read-only login audit displays only 23 successful logins across 20/3 pages and does not change shared unread state'
    );

    await bell().click();
    await dialog().getByRole('button', { name: 'Refresh', exact: true }).click();
    await dialog().getByText('20 unread', { exact: true }).waitFor();
    db.sqlite.exec('UPDATE login_security_config SET enabled=0');
    await dialog().getByRole('button', { name: 'Mark this page as read', exact: true }).click();
    await dialog()
        .getByRole('heading', { name: 'Login security is not enabled', exact: true })
        .waitFor();
    assert.equal(await dialog().locator('[data-event-id]').count(), 0);
    assert.equal(unread(), 20);
    await screenshot('disabled-during-read');
    assert.deepEqual((await api('/api/admin/notifications')).body, {
        success: true,
        enabled: false,
        items: [],
        unreadCount: 0,
        nextCursor: null,
    });
    assert.equal((await api('/api/admin/login-audit')).body.enabled, false);
    const eventCount = db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_events').get().n;
    for (const mode of ['switch-off', 'binding-absent']) {
        if (mode === 'binding-absent') delete env.MISUB_SECURITY_DB;
        await context.clearCookies();
        await page.goto(`${origin}/login`);
        assert.equal((await submit('local-wrong-password')).status, 401);
        await page.getByText('密码错误', { exact: true }).waitFor();
        const legacyLogin = await submit(env.ADMIN_PASSWORD);
        assert.equal(legacyLogin.status, 200);
        assert.deepEqual(legacyLogin.body.loginSecurity, { enabled: false, warning: null });
        await bell().waitFor();
        await bell().click();
        await dialog()
            .getByRole('heading', { name: 'Login security is not enabled', exact: true })
            .waitFor();
        assert.equal(await dialog().locator('[data-event-id]').count(), 0);
        assert.equal(
            db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_events').get().n,
            eventCount
        );
        for (const path of ['/api/admin/notifications', '/api/admin/login-audit']) {
            assert.deepEqual(await api(path), {
                status: 200,
                body: {
                    success: true,
                    enabled: false,
                    items: [],
                    unreadCount: 0,
                    nextCursor: null,
                },
            });
        }
        const beforeDisabledRead = db.sqlite
            .prepare('SELECT id,read_at FROM login_security_events ORDER BY id')
            .all();
        assert.deepEqual((await api('/api/admin/notifications/read', { ids: [24] })).body, {
            success: true,
            enabled: false,
        });
        assert.deepEqual(
            db.sqlite.prepare('SELECT id,read_at FROM login_security_events ORDER BY id').all(),
            beforeDisabledRead
        );
        assert.equal(unread(), 20);
        await screenshot(mode);
        report.checks.push(
            `${mode}: actual password validation/session login remains usable, notification/audit/read APIs return disabled, UI clears event rows, and no security event is added or marked read`
        );
    }
    await context.clearCookies();
    const expiredReply = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/admin/notifications'
    );
    await dialog().getByRole('button', { name: 'Refresh', exact: true }).click();
    assert.equal((await expiredReply).status(), 401);
    await page.locator('input[autocomplete=current-password]').waitFor();
    assert.equal(await dialog().count(), 0);
    assert.equal(await bell().count(), 0);
    await screenshot('expired-session');
    report.checks.push(
        'Cleared session cookie causes actual administrator API 401, global session reset, notification removal and a return to the login form'
    );
    env.MISUB_SECURITY_DB = {
        prepare() {
            throw new Error('local unavailable binding fixture');
        },
    };
    await page.goto(`${origin}/login`);
    assert.equal((await submit(env.ADMIN_PASSWORD)).status, 503);
    await page
        .getByText('The login security service is unavailable. Please try again later.', {
            exact: true,
        })
        .waitFor();
    await screenshot('security-service-unavailable');
    report.checks.push(
        'Configured but failing security storage returns actual 503 and the frontend service-unavailable message'
    );
    assert.deepEqual(report.unexpectedApi, []);
    assert.deepEqual(report.outboundBackendRequests, []);
    assert.deepEqual(report.mainStoreWrites, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
} catch (error) {
    report.failure = {
        message: error.message,
        url: page.url(),
        body: (await page.locator('body').innerText()).slice(0, 6000),
    };
    await page.screenshot({ path: resolve(evidence, 'failure.png') });
    throw error;
} finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await new Promise((done) => server.close(done));
    db.sqlite.close();
    globalThis.fetch = originalFetch;
    Date.now = realNow;
}
console.log(
    JSON.stringify(
        {
            passed: report.passed,
            checks: report.checks,
            screenshots: report.screenshots.length,
            evidence,
        },
        null,
        2
    )
);
