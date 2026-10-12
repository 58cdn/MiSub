import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/detector-table-archive-evidence'));
await mkdir(evidence, { recursive: true });
const origin = 'http://127.0.0.1:5196';
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5196, strictPort: true, hmr: false },
    clearScreen: false,
});
const timestamp = Date.now();
const agents = ['online', 'offline', 'unknown', 'revoked'].map((status, i) => ({
    id: `a${i + 1}`,
    name: i === 1 ? 'W'.repeat(60) : `Fixture ${status}`,
    createdAt: timestamp - 1000 * i,
    lastSeen: status === 'unknown' ? null : timestamp - (status === 'offline' ? 300000 : 1000),
    revokedAt: status === 'revoked' ? timestamp : null,
    status,
    version: i === 1 ? 'W'.repeat(64) : '0.2.0-fixture',
    platform: 'linux-amd64',
    lastTaskAt: timestamp - 2000,
    lastResultAt: timestamp - 1000,
    hidden: false,
    archivedAt: null,
    lastHeartbeatAt: null,
    capabilities: null,
    taskCounts: { queued: 0, running: 0, done: 1, stopped: 0 },
}));
const extraAgents = Array.from({ length: 17 }, (_, i) => ({
    ...agents[3],
    id: `extra-${i}`,
    name: `Extra ${i}`,
    createdAt: timestamp - 10000 - i,
}));
let paged = false;
const report = {
    external: [],
    errors: [],
    calls: [],
    layouts: [],
    contrast: [],
    preferences: {},
    keyboard: {},
};
let browser, page;
const regionOverflow = async () =>
    page.evaluate(() => ({
        document: {
            width: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
        },
        bad: [...document.querySelectorAll('main,section,article,[role="dialog"]')]
            .filter((e) => e.scrollWidth > e.clientWidth + 1)
            .map((e) => ({
                tag: e.tagName,
                testid: e.dataset.testid,
                width: e.clientWidth,
                scroll: e.scrollWidth,
            })),
        table: (() => {
            const e = document.querySelector('[data-testid="detector-table-scroll"]');
            return e ? { width: e.clientWidth, scroll: e.scrollWidth } : null;
        })(),
    }));
try {
    await server.listen();
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
    });
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.route('**/*', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (url.origin !== origin) {
            report.external.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        report.calls.push({ method: request.method(), path: url.pathname + url.search });
        const send = (data) => route.fulfill({ json: { success: true, data } });
        if (request.method() === 'POST' && /\/(archive|restore)$/.test(url.pathname)) {
            const id = url.pathname.split('/').at(-2),
                candidate = [...agents, ...extraAgents].find((agent) => agent.id === id);
            assert.ok(candidate);
            assert.equal(candidate.status, 'revoked');
            assert.deepEqual(request.postDataJSON(), { confirmed: true });
            candidate.hidden = url.pathname.endsWith('/archive');
            candidate.archivedAt = candidate.hidden ? Date.now() : null;
            return send({
                id,
                hidden: candidate.hidden,
                archivedAt: candidate.archivedAt,
                restoredAt: candidate.hidden ? null : Date.now(),
            });
        }
        assert.equal(
            request.method(),
            'GET',
            'Only explicit fixture archive/restore writes are supported'
        );
        if (url.pathname.endsWith('/capabilities')) return send({ storageReady: true });
        if (url.pathname.endsWith('/overview')) {
            let all = paged ? [...agents, ...extraAgents] : [...agents];
            if (url.searchParams.has('q'))
                all = all.filter((agent) =>
                    [agent.name, agent.version, agent.platform].some((value) =>
                        value.includes(url.searchParams.get('q'))
                    )
                );
            if (url.searchParams.has('status'))
                all = all.filter((agent) => agent.status === url.searchParams.get('status'));
            const visibility = url.searchParams.get('visibility') || 'visible';
            if (visibility !== 'all')
                all = all.filter((agent) => agent.hidden === (visibility === 'hidden'));
            const sort = url.searchParams.get('sort') || 'createdAt',
                sign = url.searchParams.get('direction') === 'asc' ? 1 : -1;
            all.sort((a, b) => sign * (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0));
            const offset = Number(url.searchParams.get('offset') || 0),
                limit = Number(url.searchParams.get('limit') || 20);
            return send({
                agents: all.slice(offset, offset + limit),
                total: all.length,
                nextOffset: offset + limit < all.length ? offset + limit : null,
                checkedAt: Date.now(),
                onlineWindowMs: 120000,
                retentionDays: 7,
            });
        }
        if (url.pathname.endsWith('/history'))
            return send({
                agent: agents[0],
                records: [],
                total: 0,
                nextOffset: null,
                checkedAt: Date.now(),
                retentionDays: 7,
            });
        throw new Error('Unexpected local fixture API request');
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    for (const width of [320, 375, 768, 1024, 1440])
        for (const dark of [false, true]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${origin}/tests/browser/detector-management.html`);
            await page.evaluate((dark) => {
                localStorage.removeItem('misub:admin:detectors:view:v1');
                document.documentElement.classList.toggle('dark', dark);
            }, dark);
            await page.getByTestId('settings-tab-detectors').click();
            await page.getByTestId('detector-card-a1').waitFor();
            await page.getByTestId('detector-auto-refresh').uncheck();
            assert.equal(
                await page.getByTestId('detector-view-cards').getAttribute('aria-pressed'),
                'true'
            );
            for (const view of ['cards', 'list']) {
                await page.getByTestId(`detector-view-${view}`).click();
                const layout = await regionOverflow();
                report.layouts.push({ width, dark, view, ...layout });
                assert.ok(
                    layout.document.scroll <= layout.document.width + 1,
                    JSON.stringify(report.layouts.at(-1))
                );
                assert.deepEqual(layout.bad, [], JSON.stringify(report.layouts.at(-1)));
                if (width <= 375 && view === 'list')
                    assert.ok(
                        layout.table.scroll > layout.table.width,
                        'List should remain horizontally scrollable on narrow screens'
                    );
                if ((width === 320 || width === 1440) && (view === 'list' || width === 320)) {
                    await page.screenshot({
                        path: resolve(evidence, `${width}-${dark ? 'dark' : 'light'}-${view}.png`),
                        fullPage: true,
                    });
                }
            }
            const contrast = await page.evaluate(() => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const rgba = (color) => {
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data];
                };
                const luminance = (values) =>
                    values
                        .slice(0, 3)
                        .map((value) => {
                            const n = value / 255;
                            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                        })
                        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
                return [
                    '[data-testid="detector-view-list"]',
                    '[data-testid="detector-columns-toggle"]',
                    'label[for="detector-search"]',
                    '#detector-table-help',
                    '[data-testid="detector-sort-name"]',
                    '[data-testid="detector-row-a1"] [data-column="status"] span',
                    '[data-testid="detector-row-a1"] [data-column="capabilities"]',
                    '[data-testid="detector-archive-a4"]',
                ].map((selector) => {
                    const e = document.querySelector(selector),
                        foreground = rgba(getComputedStyle(e).color);
                    let background = [255, 255, 255, 255];
                    for (let a = e; a; a = a.parentElement) {
                        const candidate = rgba(getComputedStyle(a).backgroundColor);
                        if (candidate[3] === 255) {
                            background = candidate;
                            break;
                        }
                    }
                    const levels = [luminance(foreground), luminance(background)].sort(
                        (a, b) => b - a
                    );
                    return { selector, ratio: (levels[0] + 0.05) / (levels[1] + 0.05) };
                });
            });
            report.contrast.push({ width, dark, samples: contrast });
            assert.ok(
                contrast.every((sample) => sample.ratio >= 4.5),
                JSON.stringify(report.contrast.at(-1))
            );
            const targets = await page
                .locator(
                    '[data-testid="detector-settings"] button:visible, [data-testid="detector-settings"] select:visible, [data-testid="detector-search"], [data-testid="detector-columns-toggle"]'
                )
                .evaluateAll((elements) =>
                    elements
                        .map((e) => ({
                            testid: e.dataset.testid,
                            height: e.getBoundingClientRect().height,
                        }))
                        .filter((e) => e.height < 44)
                );
            assert.deepEqual(targets, [], 'Visible controls have 44px targets');
            if (width >= 1024)
                for (const key of ['lastSeen', 'lastResultAt', 'version']) {
                    await page.keyboard.press('Tab');
                    const button = page.getByTestId(`detector-sort-${key}`);
                    await button.focus();
                    const position = await button.evaluate((e) => {
                        const b = e.getBoundingClientRect(),
                            parent = e.closest('table'),
                            name = parent
                                .querySelector('thead .detector-name-cell')
                                .getBoundingClientRect(),
                            actions = parent
                                .querySelector('thead .detector-actions-cell')
                                .getBoundingClientRect();
                        return {
                            left: b.left,
                            right: b.right,
                            nameRight: name.right,
                            actionsLeft: actions.left,
                            outline: getComputedStyle(e).outlineStyle,
                        };
                    });
                    assert.ok(
                        position.left >= position.nameRight &&
                            position.right <= position.actionsLeft,
                        `Focus must remain outside sticky columns: ${JSON.stringify(position)}`
                    );
                    assert.notEqual(position.outline, 'none');
                }
        }
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.getByTestId('detector-view-list').getAttribute('aria-pressed'), 'true');
    const scroller = page.getByTestId('detector-table-scroll');
    await scroller.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    report.keyboard.scrollLeft = await scroller.evaluate((e) => e.scrollLeft);
    assert.ok(report.keyboard.scrollLeft > 0);
    await page.getByTestId('detector-sort-version').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
        () =>
            document.activeElement?.dataset.testid === 'detector-sort-version' &&
            document.activeElement.closest('th').getAttribute('aria-sort') === 'ascending'
    );
    await page.getByTestId('detector-columns-toggle').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('detector-column-version').uncheck();
    assert.equal(await page.getByTestId('detector-sort').inputValue(), 'version');
    assert.equal(await page.getByTestId('detector-direction').inputValue(), 'asc');
    report.preferences.hiddenSort = 'version asc remains explicitly shown in toolbar';
    for (const column of [
        'status',
        'lastSeen',
        'lastTaskAt',
        'lastResultAt',
        'version',
        'capabilities',
        'lastHeartbeatAt',
    ])
        await page.getByTestId(`detector-column-${column}`).uncheck();
    assert.equal(await page.locator('[data-testid="detector-table"] thead th').count(), 2);
    report.preferences.allOptionalHidden = true;
    await page.reload();
    await page.getByTestId('settings-tab-detectors').click();
    await page.getByTestId('detector-table').waitFor();
    assert.equal(await page.getByTestId('detector-view-list').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-testid="detector-table"] thead th').count(), 2);
    assert.equal(await page.getByTestId('detector-sort').inputValue(), 'createdAt');
    report.preferences.reload = 'list/columns preserved, sort resets to createdAt desc';
    await page.getByTestId('detector-archive-a4').click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(
        await page.getByTestId('detector-archive-a4').evaluate((e) => e === document.activeElement),
        true
    );
    report.keyboard.deleteEscapeReturnsFocus = true;
    await page.getByTestId('detector-history-a1').click();
    await page.getByTestId('detector-history').waitFor();
    assert.equal(
        await page
            .getByTestId('detector-history-title')
            .evaluate((e) => e === document.activeElement),
        true
    );
    report.keyboard.historyTitleFocused = true;
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    assert.equal(
        report.calls.filter((call) => call.method === 'POST').length,
        0,
        'Opening views/dialogs never mutates'
    );
    await page.getByTestId('detector-archive-a4').click();
    await page.getByTestId('detector-confirm-archive').click();
    await page.getByTestId('detector-row-a4').waitFor({ state: 'detached' });
    await page.getByTestId('detector-visibility-filter').selectOption('hidden');
    await page.getByTestId('detector-restore-a4').waitFor();
    await page.getByTestId('detector-restore-a4').click();
    await page.getByTestId('detector-cancel-archive').click();
    assert.equal(report.calls.filter((call) => call.method === 'POST').length, 1);
    await page.getByTestId('detector-restore-a4').click();
    await page.getByTestId('detector-confirm-archive').click();
    await page.getByTestId('detector-row-a4').waitFor({ state: 'detached' });
    assert.ok(
        (await page.getByTestId('detector-settings').textContent()).includes(
            'Its credentials remain revoked'
        )
    );
    await page.getByTestId('detector-visibility-filter').selectOption('visible');
    await page.getByTestId('detector-archive-a4').waitFor();
    report.recovery = {
        archived: true,
        restored: true,
        remainsRevoked: agents[3].status === 'revoked',
    };
    paged = true;
    await page.getByTestId('detector-refresh').click();
    await page.waitForFunction(
        () => !document.querySelector('[data-testid="detector-overview-next"]').disabled
    );
    await page.getByTestId('detector-overview-next').click();
    await page.getByTestId('detector-archive-extra-16').click();
    await page.getByTestId('detector-confirm-archive').click();
    await page.getByTestId('detector-row-a1').waitFor();
    assert.equal(await page.getByTestId('detector-overview-prev').isDisabled(), true);
    assert.ok((await page.getByTestId('detector-overview-total').textContent()).includes('20'));
    report.lastPageClamp = true;
    await page.getByTestId('detector-search').fill('Fixture unknown');
    await page.getByTestId('detector-search').press('Enter');
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="detector-row-"]').length === 1
    );
    assert.equal(await page.getByTestId('detector-row-a3').isVisible(), true);
    await page.getByTestId('detector-status-filter').selectOption('revoked');
    await page
        .getByText('No detectors match these filters. Reset filters or change visibility.', {
            exact: true,
        })
        .waitFor();
    await page.getByTestId('detector-filters-reset').click();
    await page.getByTestId('detector-row-a1').waitFor();
    assert.equal(await page.getByTestId('detector-view-list').getAttribute('aria-pressed'), 'true');
    report.filters = 'Search/status AND filter; reset keeps view';
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.external, []);
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    if (page) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true });
    throw error;
} finally {
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.close();
}
console.log(
    JSON.stringify({
        passed: report.passed,
        layouts: report.layouts.length,
        externalRequests: report.external.length,
        pageErrors: report.errors.length,
        evidence,
    })
);
