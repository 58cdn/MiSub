import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Full built app, isolated browser profile and synthetic APIs. No external traffic.
const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
execFileSync(
    'git',
    [
        'diff',
        '--exit-code',
        'HEAD',
        '--',
        'src',
        'public',
        'index.html',
        'vite.config.js',
        'package.json',
        'package-lock.json',
    ],
    { cwd: root, stdio: 'pipe' }
);
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root,
    stdio: 'pipe',
});
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/notification-evidence'));
await mkdir(evidence, { recursive: true });
const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(dist + sep) && path !== dist) {
        response.writeHead(403).end();
        return;
    }
    try {
        const actual = extname(path) ? path : resolve(dist, 'index.html');
        const data = await readFile(actual);
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
        response.end(data);
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { externalRequests: [], unexpectedApi: [], pageErrors: [], layouts: [], checks: [] };
const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
});
let mode = 'normal';
let loggedIn = true;
let loginMode = 'success';
let readCalls = [];
let events;
const resetEvents = () => {
    events = Array.from({ length: 23 }, (_, i) => ({
        id: 42 - i,
        type: i === 0 ? 'login_warning' : 'login_success',
        createdAt: 1791900020000 - i * 60000,
        readAt: null,
        ip: i === 0 ? null : '2001:db8::1',
        browser: i === 0 ? null : 'Firefox',
        os: i === 0 ? null : 'Windows',
        device: i === 0 ? null : 'desktop',
        failedAttempts: i === 0 ? 10 : null,
        since: i === 0 ? 1791900000000 : null,
        lastFailureAt: i === 0 ? 1791900010000 : null,
        target: 'security',
    }));
};
resetEvents();
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    reducedMotion: 'reduce',
    hasTouch: true,
});
await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) {
        report.externalRequests.push(request.url());
        return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/session/protocol') return json({ protocol: 'legacy' });
    if (url.pathname === '/api/public_config')
        return json({ enablePublicPage: true, isLoginPath: true, customLoginPath: 'login' });
    if (url.pathname === '/api/data')
        return json(
            loggedIn
                ? {
                      misubs: [],
                      profiles: [],
                      ruleTemplates: [],
                      config: { isDefaultPassword: false },
                  }
                : { authenticated: false }
        );
    if (url.pathname === '/api/github/release') return json({});
    if (url.pathname === '/api/detect_legacy_d1')
        return json({ success: true, data: { hasLegacyData: false } });
    if (url.pathname === '/api/settings') return json({ defaultLocale: 'en-US' });
    if (url.pathname === '/api/guestbook/manage') return json({ success: true, data: [] });
    if (url.pathname === '/api/clients') return json({ success: true, data: [] });
    if (url.pathname === '/api/login') {
        if (loginMode === 'locked')
            return json(
                { code: 'login_locked', retryAfter: 600, lockedUntil: Date.now() + 600000 },
                429
            );
        loggedIn = true;
        return json({
            success: true,
            loginSecurity: {
                enabled: true,
                warning: {
                    id: 42,
                    failedAttempts: 10,
                    since: 1791900000000,
                    lastFailureAt: 1791900010000,
                },
            },
        });
    }
    if (url.pathname === '/api/admin/notifications/read') {
        assert.equal(request.method(), 'POST');
        const { ids } = request.postDataJSON();
        readCalls.push(ids);
        events = events.map((event) =>
            ids.includes(event.id) ? { ...event, readAt: event.readAt ?? Date.now() } : event
        );
        return json({ success: true, enabled: true });
    }
    if (['/api/admin/notifications', '/api/admin/login-audit'].includes(url.pathname)) {
        assert.equal(request.method(), 'GET');
        if (mode === 'error') return json({ error: 'unavailable' }, 503);
        if (mode === 'forbidden') return json({ error: 'forbidden' }, 403);
        if (mode === 'disabled')
            return json({
                success: true,
                enabled: false,
                items: [],
                unreadCount: 0,
                nextCursor: null,
            });
        if (mode === 'empty')
            return json({
                success: true,
                enabled: true,
                items: [],
                unreadCount: 0,
                nextCursor: null,
            });
        const filtered = events.filter(
            (event) => !url.pathname.endsWith('login-audit') || event.type === 'login_success'
        );
        const before = Number(url.searchParams.get('before') || Infinity);
        const remaining = filtered.filter((event) => event.id < before);
        const items = remaining.slice(0, 20);
        return json({
            success: true,
            enabled: true,
            items,
            unreadCount: filtered.filter((event) => event.readAt === null).length,
            nextCursor: remaining.length > 20 ? items.at(-1).id : null,
        });
    }
    report.unexpectedApi.push({ method: request.method(), path: url.pathname });
    return json({ success: false }, 404);
});
const page = await context.newPage();
page.on('pageerror', (error) => report.pageErrors.push(error.message));
const bell = () =>
    page.getByRole('button', { name: /Notifications,|通知中心，/ }).filter({ visible: true });
const dialog = () => page.getByRole('dialog', { name: /Notifications|通知中心/ });
async function layout(name) {
    const result = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        overflowingNavButtons: [...document.querySelectorAll('.app-nav-bar .nav-action-btn')]
            .filter((element) => {
                if (!element.getClientRects().length) return false;
                const rect = element.getBoundingClientRect();
                const header = element.closest('.app-nav-bar').getBoundingClientRect();
                return (
                    rect.top < header.top - 1 ||
                    rect.bottom > header.bottom + 1 ||
                    rect.right > innerWidth + 1
                );
            })
            .map((element) => element.getAttribute('aria-label')),
        dialog: [...document.querySelectorAll('dialog[open]')].map((e) => ({
            width: e.clientWidth,
            scroll: e.scrollWidth,
        })),
    }));
    report.layouts.push({ name, ...result });
    assert.ok(result.scroll <= result.width + 1, `${name}: document overflow`);
    assert.deepEqual(result.overflowingNavButtons, [], `${name}: navigation button overflow`);
    assert.ok(
        result.dialog.every((e) => e.scroll <= e.width + 1),
        `${name}: dialog overflow`
    );
    await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: false });
}
try {
    await page.goto(`${origin}/dashboard/security`);
    await page.getByRole('heading', { name: 'Login security', exact: true }).waitFor();
    await bell().click();
    await dialog().waitFor();
    await dialog().getByText('Failed password attempts detected', { exact: true }).waitFor();
    assert.equal(readCalls.length, 0);
    await layout('desktop-light');
    const closeButton = dialog().getByRole('button', { name: 'Close notifications' });
    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(
        await page.evaluate(() => Boolean(document.activeElement?.closest('dialog'))),
        true
    );
    for (let index = 0; index < 80; index++) {
        await page.keyboard.press('Tab');
        assert.equal(
            await page.evaluate(() => Boolean(document.activeElement?.closest('dialog'))),
            true
        );
    }
    await page.keyboard.press('Escape');
    assert.equal(await bell().evaluate((e) => document.activeElement === e), true);
    report.checks.push('Tab containment and Escape focus return');
    await bell().click();
    await dialog().getByRole('button', { name: 'Next', exact: true }).click();
    await dialog().getByText('Page 2', { exact: true }).waitFor();
    await dialog().getByRole('button', { name: 'Mark this page as read', exact: true }).click();
    await dialog().getByText('20 unread', { exact: true }).waitFor();
    assert.deepEqual(readCalls[0], [22, 21, 20]);
    report.checks.push('Cursor pagination and only current-page read IDs');
    await dialog().getByRole('button', { name: 'Previous', exact: true }).click();
    await dialog().getByText('Page 1', { exact: true }).waitFor();
    for (const [state, text] of [
        ['disabled', 'Login security is not enabled'],
        ['error', 'Could not load or update notifications'],
        ['empty', 'No system messages yet'],
        ['forbidden', 'Administrator notifications are unavailable'],
    ]) {
        mode = state;
        await dialog().getByRole('button', { name: 'Refresh', exact: true }).click();
        await dialog().getByRole('heading', { name: text, exact: true }).waitFor();
        await layout(`state-${state}`);
    }
    mode = 'normal';
    await dialog().getByRole('button', { name: 'Refresh', exact: true }).click();
    await dialog().getByText('Failed password attempts detected', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        localStorage.setItem('theme', 'dark');
        localStorage.setItem('misub:locale', 'zh-CN');
    });
    await page.reload();
    await bell().click();
    for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await layout(`dark-zh-${width}`);
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 900 });
    await layout('modern-mobile-navigation');
    await page.evaluate(() => {
        localStorage.setItem('layoutMode', 'legacy');
        localStorage.setItem('misub:locale', 'en-US');
    });
    await page.reload();
    await page.getByRole('heading', { name: 'Login security', exact: true }).waitFor();
    await bell().click();
    await dialog().getByRole('link', { name: 'System settings', exact: true }).click();
    await page.waitForURL('**/dashboard/settings');
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Login security', exact: true }).waitFor();
    report.checks.push('Legacy layout security/settings routes and browser Back');
    await page.setViewportSize({ width: 375, height: 900 });
    await bell().click();
    await layout('legacy-mobile');
    await page.keyboard.press('Escape');
    await layout('legacy-mobile-navigation');
    loggedIn = false;
    loginMode = 'locked';
    await page.goto(`${origin}/login`);
    await page.getByRole('textbox', { name: /password/i }).count();
    await page.locator('input[autocomplete=current-password]').fill('fixture-password');
    await page.locator('button[type=submit]').click();
    await page.locator('#login-locked').waitFor();
    assert.equal(
        await page
            .locator('h1')
            .evaluate((element) => getComputedStyle(element.parentElement).opacity),
        '1'
    );
    await layout('login-locked-mobile');
    assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
    loginMode = 'success';
    await page.reload();
    await page.locator('input[autocomplete=current-password]').fill('fixture-password');
    await page.locator('button[type=submit]').click();
    await page.getByText('Login security warning', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View security notifications', exact: true }).click();
    await dialog().getByText('Failed password attempts detected', { exact: true }).waitFor();
    await dialog()
        .getByRole('button', { name: /^Mark as read: Failed password attempts/ })
        .click();
    await dialog().getByText('19 unread', { exact: true }).waitFor();
    assert.equal(await page.getByText('Login security warning', { exact: true }).count(), 0);
    report.checks.push(
        'Login metadata flows through API/store/form; successful login warning opens notifications'
    );
    assert.ok(
        report.externalRequests.every((url) => new URL(url).hostname === 'fonts.googleapis.com')
    );
    assert.deepEqual(report.unexpectedApi, []);
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
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(
    JSON.stringify(
        {
            passed: report.passed,
            screenshots: report.layouts.length,
            checks: report.checks,
            evidence,
        },
        null,
        2
    )
);
