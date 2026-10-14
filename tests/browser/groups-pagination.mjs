// Runs the real application routes against local synthetic API fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/groups-pagination-evidence'));
await mkdir(evidence, { recursive: true });
const origin = 'http://127.0.0.1:5196';
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5196, strictPort: true },
    clearScreen: false,
});
let browser;
let settings = {
    FileName: 'MiSub',
    defaultLocale: 'zh-CN',
    storageType: 'kv',
    enablePublicPage: false,
};
let count = 2585,
    grouped = false,
    failSave = false;
let pendingData = null;
let failData = false;
const requests = [],
    errors = [],
    checks = [],
    overflow = [],
    accessibility = [];
const data = () => ({
    config: settings,
    profiles: [],
    ruleTemplates: [],
    misubs: Array.from({ length: count }, (_, i) => ({
        id: `source-${i}`,
        name: `Fixture source ${String(i).padStart(4, '0')}`,
        url: `https://${grouped ? 'airport' : `airport${i}`}.example/sub/${i}`,
        enabled: i % 2 === 0,
        nodeCount: 3,
    })),
});
try {
    await server.listen();
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
        localStorage.setItem('misub:locale', 'zh-CN');
        localStorage.setItem('theme', 'dark');
    });
    await context.route('**/*', async (route) => {
        const req = route.request(),
            url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        requests.push({ path: url.pathname, method: req.method() });
        if (url.pathname === '/api/data') {
            if (pendingData) await pendingData;
            if (failData)
                return route.fulfill({ status: 503, json: { error: 'Fixture data unavailable' } });
            return route.fulfill({ json: data() });
        }
        if (url.pathname === '/api/public_config')
            return route.fulfill({ json: { enablePublicPage: false } });
        if (url.pathname === '/api/settings') {
            if (req.method() === 'GET') return route.fulfill({ json: settings });
            if (failSave)
                return route.fulfill({
                    status: 503,
                    json: { success: false, error: 'Fixture save unavailable' },
                });
            settings = { ...settings, ...req.postDataJSON() };
            return route.fulfill({ json: { success: true } });
        }
        if (url.pathname.includes('github'))
            return route.fulfill({ json: { success: true, data: { tag_name: 'v2.7.0' } } });
        return route.fulfill({ json: { success: true, data: [], hasLegacyData: false } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', (e) => errors.push(e.message));
    const footer = () => page.getByTestId('groups-pagination');
    const range = async (text) => {
        await page.waitForFunction(
            (text) =>
                document
                    .querySelector('[data-testid="groups-pagination"] [role="status"]')
                    ?.textContent.trim() === text,
            text
        );
        checks.push(text);
    };
    const shot = async (name) => {
        await footer().scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });
    };
    const auditFooter = async (theme) => {
        const metrics = await footer().evaluate((nav) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d');
            const rgb = (color) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const luminance = (channels) =>
                channels
                    .map((v) => {
                        const n = v / 255;
                        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                    })
                    .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
            const contrast = [...nav.querySelectorAll('[role="status"], label, select')].map(
                (el) => {
                    const ancestors = [];
                    for (let current = el; current; current = current.parentElement)
                        ancestors.unshift(current);
                    context.fillStyle = 'white';
                    context.fillRect(0, 0, 1, 1);
                    for (const parent of ancestors) {
                        context.fillStyle = getComputedStyle(parent).backgroundColor;
                        context.fillRect(0, 0, 1, 1);
                    }
                    const bg = luminance([...context.getImageData(0, 0, 1, 1).data].slice(0, 3));
                    const fg = luminance(rgb(getComputedStyle(el).color));
                    return {
                        element: el.tagName,
                        ratio: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05),
                    };
                }
            );
            const targets = [...nav.querySelectorAll('button, input, select')].map((el) => ({
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
            }));
            return { contrast, targets };
        });
        assert.ok(
            metrics.contrast.every((entry) => entry.ratio >= 4.5),
            JSON.stringify(metrics.contrast)
        );
        assert.ok(metrics.targets.every((entry) => entry.width >= 44 && entry.height >= 44));
        accessibility.push({ theme, ...metrics });
    };
    await page.goto(`${origin}/dashboard/groups`);
    await range('显示 1 至 20 共 2585 条结果');
    await shot('desktop-dark-first.png');
    await auditFooter('dark');
    assert.equal(
        await footer()
            .locator('option')
            .allTextContents()
            .then((x) => x.join(',')),
        '10,20,50,100'
    );
    await footer().getByRole('button', { name: '最后一页', exact: true }).click();
    await range('显示 2581 至 2585 共 2585 条结果');
    await shot('desktop-dark-last.png');
    await footer().getByRole('combobox').selectOption('50');
    await range('显示 1 至 50 共 2585 条结果');
    assert.equal(settings.groupsPageSize, undefined);
    await page.getByTestId('subscription-search').fill('Fixture source 000');
    await range('显示 1 至 10 共 10 条结果');
    await page.getByTestId('subscription-search').fill('no-match');
    await range('显示 0 至 0 共 0 条结果');
    assert.equal(await footer().locator('button:enabled').count(), 0);
    await shot('empty-filter.png');
    await page.goto(`${origin}/dashboard/groups?status=disabled`);
    await range('显示 1 至 20 共 1292 条结果');
    await page.getByTestId('subscription-search').fill('Fixture source 000');
    await range('显示 1 至 5 共 5 条结果');

    count = 45;
    grouped = true;
    await page.goto(`${origin}/dashboard/groups`);
    await range('显示 1 至 20 共 45 条结果');
    await page.getByRole('button', { name: /Airport\s*45/ }).click();
    assert.equal(await page.getByText('Fixture source 0020', { exact: true }).count(), 0);
    await footer().getByRole('button', { name: '下一页', exact: true }).click();
    await range('显示 21 至 40 共 45 条结果');
    assert.equal(await page.getByText('Fixture source 0000', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Fixture source 0020', { exact: true }).count(), 1);
    checks.push('Expanded groups render current page members only');

    for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await footer().scrollIntoViewIfNeeded();
        const dimensions = await page.evaluate(() => ({
            viewport: innerWidth,
            width: document.documentElement.scrollWidth,
        }));
        overflow.push(dimensions);
        assert.ok(
            dimensions.width <= dimensions.viewport,
            `Overflow at ${width}: ${dimensions.width}`
        );
        if (width === 375) await shot('mobile-dark.png');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await footer().getByRole('combobox').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await range('显示 1 至 10 共 45 条结果');
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({
        label: document.activeElement.getAttribute('aria-label'),
        shadow: getComputedStyle(document.activeElement).boxShadow,
    }));
    assert.ok(focus.label);
    assert.notEqual(focus.shadow, 'none');
    await writeFile(
        resolve(evidence, 'pagination-accessibility.txt'),
        await footer().ariaSnapshot()
    );
    await page.evaluate(() => {
        localStorage.setItem('theme', 'light');
        document.documentElement.classList.remove('dark');
    });
    await shot('desktop-light.png');
    await auditFooter('light');

    await page.goto(`${origin}/dashboard/settings`);
    await page.getByTestId('settings-tab-system').click();
    const defaultSize = page.getByLabel('机场订阅默认每页条数', { exact: true });
    assert.equal(await defaultSize.inputValue(), '20');
    await defaultSize.selectOption('50');
    await defaultSize.scrollIntoViewIfNeeded();
    await page.screenshot({
        path: resolve(evidence, 'system-settings.png'),
        animations: 'disabled',
    });
    failSave = true;
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByText('HTTP 503: Fixture save unavailable', { exact: false }).first().waitFor();
    assert.equal(settings.groupsPageSize, undefined);
    await page.screenshot({
        path: resolve(evidence, 'settings-error.png'),
        animations: 'disabled',
    });
    failSave = false;
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.waitForEvent('load');
    assert.equal(settings.groupsPageSize, 50);
    await page.goto(`${origin}/dashboard/groups`);
    await range('显示 1 至 45 共 45 条结果');
    assert.equal(await footer().getByRole('combobox').inputValue(), '50');
    checks.push('System setting persisted across application reload; failed save kept prior value');
    await page.getByRole('link', { name: '设置', exact: true }).first().click();
    await page.getByTestId('settings-tab-system').click();
    await page.getByLabel('机场订阅默认每页条数', { exact: true }).selectOption('100');
    await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/settings') && response.request().method() === 'POST'
        ),
        page.getByRole('button', { name: '保存修改', exact: true }).click(),
    ]);
    await page.getByRole('link', { name: '机场订阅', exact: true }).first().click();
    await range('显示 1 至 45 共 45 条结果');
    assert.equal(await footer().getByRole('combobox').inputValue(), '100');
    checks.push('Saved default applies immediately when navigating before the reload countdown');

    let releaseData;
    pendingData = new Promise((resolve) => {
        releaseData = resolve;
    });
    await page.goto(`${origin}/dashboard/groups`, { waitUntil: 'domcontentloaded' });
    await page.locator('#app > *').first().waitFor();
    assert.equal(await footer().count(), 0);
    await page.screenshot({
        path: resolve(evidence, 'initial-loading.png'),
        animations: 'disabled',
    });
    releaseData();
    pendingData = null;
    await range('显示 1 至 45 共 45 条结果');
    failData = true;
    const [failureResponse] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/data'),
        page.goto(`${origin}/dashboard/groups`),
    ]);
    assert.equal(failureResponse.status(), 503);
    await page.getByText('欢迎回来', { exact: true }).waitFor();
    assert.equal(await footer().count(), 0);
    await page.screenshot({
        path: resolve(evidence, 'initial-load-error.png'),
        animations: 'disabled',
    });
    failData = false;
    checks.push('Initial loading and failure do not announce a misleading empty result count');
    count = 0;
    grouped = false;
    await page.goto(`${origin}/dashboard/groups`);
    await range('显示 0 至 0 共 0 条结果');
    await shot('empty-dataset.png');
    assert.deepEqual(errors, []);
    await writeFile(
        resolve(evidence, 'results.json'),
        JSON.stringify({ checks, overflow, focus, accessibility, requests, errors }, null, 2)
    );
    console.log(JSON.stringify({ ok: true, checks: checks.length, evidence }));
} catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
        await page.screenshot({ path: resolve(evidence, 'failure.png'), animations: 'disabled' });
        await writeFile(resolve(evidence, 'failure.txt'), await page.locator('body').innerText());
    }
    throw error;
} finally {
    await browser?.close();
    await server.close();
}
