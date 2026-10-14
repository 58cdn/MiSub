// Local browser acceptance; all APIs are fixtures and all external requests abort.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/node-connectivity-evidence'));
await mkdir(evidence, { recursive: true });
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5184, strictPort: true },
    clearScreen: false,
});
const errors = [],
    external = [],
    cases = [];
let browser,
    posts = 0;
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
        const req = route.request(),
            url = new URL(req.url());
        if (url.origin !== 'http://127.0.0.1:5184') {
            external.push(url.origin);
            return route.abort();
        }
        if (url.pathname === '/api/nodes/connectivity') {
            const body = req.postDataJSON();
            assert.deepEqual(Object.keys(body), ['nodeId']);
            assert.notEqual(body.nodeId, 'unsaved');
            posts++;
            const pair = {
                reachable: ['ok', 'port_reachable'],
                restricted: ['unsupported', 'platform_restricted'],
                udp: ['unsupported', 'udp_not_applicable'],
                dns: ['unknown', 'dns_failed'],
                refused: ['unknown', 'connect_failed'],
                timeout: ['timeout', 'deadline'],
            }[body.nodeId];
            assert.ok(pair);
            return route.fulfill({
                json: {
                    success: true,
                    data: {
                        version: 1,
                        status: pair[0],
                        code: pair[1],
                        latencyMs: pair[0] === 'ok' ? 24 : null,
                        checkedAt: Date.now(),
                        measurement: 'worker_tcp_connect',
                        vantage: 'cloudflare_worker',
                    },
                },
            });
        }
        if (url.pathname.startsWith('/api/')) {
            const data = url.pathname.endsWith('/capabilities') ? { storageReady: true } : [];
            return route.fulfill({ json: { success: true, data } });
        }
        return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (const locale of ['zh-CN', 'en-US'])
        for (const theme of ['light', 'dark'])
            for (const width of [320, 375, 768, 1280])
                for (const view of ['card', 'list']) {
                    await page.setViewportSize({ width, height: 1100 });
                    await page.goto(
                        `http://127.0.0.1:5184/tests/browser/node-connectivity.html?locale=${locale}&view=${view}`
                    );
                    await page.evaluate(
                        (dark) => document.documentElement.classList.toggle('dark', dark),
                        theme === 'dark'
                    );
                    await page
                        .getByRole('button', {
                            name: locale === 'zh-CN' ? '批量基础检测' : 'Batch basic check',
                            exact: true,
                        })
                        .click();
                    await page
                        .getByRole('status')
                        .filter({ hasText: 'TCP 24 ms' })
                        .first()
                        .waitFor();
                    await page
                        .getByRole('status')
                        .filter({ hasText: locale === 'zh-CN' ? '请先保存' : 'Save first' })
                        .first()
                        .waitFor();
                    const overflow = await page.evaluate(
                        () => document.documentElement.scrollWidth > innerWidth
                    );
                    assert.equal(overflow, false, `${locale}/${theme}/${width}/${view} overflow`);
                    const clipped = await page.getByRole('status').evaluateAll((elements) =>
                        elements
                            .filter((element) => {
                                const box = element.getBoundingClientRect();
                                if (!box.width || !box.height) return false;
                                for (
                                    let parent = element.parentElement;
                                    parent;
                                    parent = parent.parentElement
                                ) {
                                    const style = getComputedStyle(parent),
                                        bounds = parent.getBoundingClientRect();
                                    if (
                                        /(hidden|clip)/.test(style.overflowX) &&
                                        (box.left < bounds.left - 1 || box.right > bounds.right + 1)
                                    )
                                        return true;
                                }
                                return false;
                            })
                            .map((element) => element.textContent)
                    );
                    assert.deepEqual(
                        clipped,
                        [],
                        `${locale}/${theme}/${width}/${view} clipped result`
                    );
                    assert.ok(
                        await page.getByTestId('probe-all').isVisible(),
                        'full node checks remain available'
                    );
                    const label = `${locale}-${theme}-${width}-${view}`;
                    await page.screenshot({
                        path: resolve(evidence, `${label}.png`),
                        fullPage: true,
                    });
                    cases.push(label);
                }
    await page.getByTestId('probe-all').click();
    await page.getByTestId('probe-type-unlock').check();
    for (const service of ['openai', 'claude'])
        assert.equal(await page.getByTestId(`probe-service-${service}`).isChecked(), true);
    for (const service of ['netflix', 'youtube', 'gemini', 'disney', 'spotify', 'tiktok'])
        assert.equal(await page.getByTestId(`probe-service-${service}`).isChecked(), false);
    await page.getByTestId('probe-service-netflix').check();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('probe-all').click();
    assert.equal(await page.getByTestId('probe-service-netflix').isChecked(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.equal(cases.length, 32);
    assert.equal(posts, 192);
    await writeFile(
        resolve(evidence, 'report.json'),
        JSON.stringify(
            {
                cases,
                posts,
                errors,
                external,
                unlockDefaults: ['openai', 'claude'],
                manualChoiceRetained: true,
            },
            null,
            2
        )
    );
    console.log(
        JSON.stringify({ cases: cases.length, posts, errors, external, manualChoiceRetained: true })
    );
} finally {
    await browser?.close();
    await server.close();
}
