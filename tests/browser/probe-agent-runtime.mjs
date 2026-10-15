// Mount the actual administration component with local synthetic API responses.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/probe-agent-runtime-evidence'));
await mkdir(evidence, { recursive: true });
const report = {
    passed: false,
    tests: [],
    cases: [],
    pageErrors: [],
    externalRequests: [],
    calls: [],
    overflow: [],
    contrast: [],
    screenshots: [],
};
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
    clearScreen: false,
});
const checkedAt = Date.now();
const privateText = [
    'PRIVATE_RUNTIME_TOKEN',
    '/private/runtime/path',
    'https://private.invalid',
    'PRIVATE_RUNTIME_SOURCE',
];
const declaration = {
    source: 'agent_claim',
    state: 'declared',
    schemaVersion: 1,
    observationsVersion: 1,
    catalogVersion: 1,
    receivedAt: checkedAt - 1000,
    freshness: 'fresh',
    token: privateText[0],
    path: privateText[1],
    nested: { url: privateText[2] },
};
const ids = [
    'declared',
    'legacy',
    'missing',
    'unsupported_schema',
    'invalid_declaration',
    'conflicting_versions',
    'unavailable',
    'malformed',
    'revoked',
    'stale',
];
const capability = (id) => {
    if (id === 'unavailable') return null;
    if (id === 'malformed') return { ...declaration, source: privateText[3] };
    if (id === 'revoked' || id === 'declared') return declaration;
    if (id === 'stale')
        return { ...declaration, receivedAt: checkedAt - 300000, freshness: 'stale' };
    return {
        ...declaration,
        state: id,
        schemaVersion: null,
        observationsVersion: id === 'legacy' ? 1 : null,
    };
};
const agents = () =>
    ids.map((id) => ({
        id,
        name: `Fixture ${id}`,
        createdAt: checkedAt - 86400000,
        version: '9.9.9-current',
        platform: 'linux-amd64',
        lastSeen: checkedAt - 500,
        status: id === 'revoked' ? 'revoked' : 'online',
        revokedAt: id === 'revoked' ? checkedAt - 100 : null,
        hidden: false,
        lastTaskAt: null,
        lastResultAt: null,
        lastHeartbeatAt: id === 'declared' ? checkedAt - 750 : null,
        capabilities: capability(id),
    }));
let browser,
    page,
    origin,
    unavailableMode = false,
    failOverview = false;
async function scenario(name, run) {
    const start = Date.now();
    try {
        await run();
        report.tests.push(name);
        report.cases.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (error) {
        report.cases.push({ name, passed: false, error: error.message });
        throw error;
    }
}
const card = (id) => page.getByTestId(`detector-card-${id}`);
const runtime = (id) => card(id).getByTestId('detector-runtime-declaration');
async function open(locator) {
    if (!(await locator.evaluate((el) => el.open))) await locator.locator('summary').click();
}
async function noPrivateText() {
    const html = await page.locator('body').innerHTML();
    for (const value of privateText)
        assert.ok(!html.includes(value), `Sensitive runtime data rendered: ${value}`);
    for (const locator of await page.getByTestId('detector-runtime-declaration').all())
        assert.ok(
            !(await locator.innerText()).includes('9.9.9-current'),
            'Current detector version filled declaration'
        );
}
async function screenshot(name, locator = page) {
    const path = resolve(evidence, `${name}.png`);
    await locator.screenshot({ path, ...(locator === page ? { fullPage: true } : {}) });
    report.screenshots.push(path);
}
async function layout(name) {
    const overflow = await page.evaluate(() =>
        [
            document.documentElement,
            ...document.querySelectorAll(
                'main,section,article,[data-testid="detector-runtime-declaration"]'
            ),
        ]
            .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
            .map((el) => ({
                tag: el.tagName,
                testid: el.dataset.testid || null,
                width: el.clientWidth,
                scroll: el.scrollWidth,
            }))
    );
    report.overflow.push({ name, elements: overflow });
    assert.deepEqual(overflow, [], `Outer or declaration overflow: ${name}`);
}
async function contrast(name) {
    const samples = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = (color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map((v, i) =>
                i === 3 ? v / 255 : v
            );
        };
        const blend = (front, back) =>
            front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
        const lum = (rgb) =>
            rgb
                .map((v) => {
                    const n = v / 255;
                    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return [...document.querySelectorAll('[data-testid="detector-runtime-declaration"] *')]
            .filter(
                (el) =>
                    el.getClientRects().length &&
                    [...el.childNodes].some(
                        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
                    )
            )
            .map((el) => {
                const ancestors = [];
                for (let p = el; p; p = p.parentElement) ancestors.unshift(p);
                let background = [255, 255, 255];
                for (const p of ancestors)
                    background = blend(rgba(getComputedStyle(p).backgroundColor), background);
                const values = [
                    lum(blend(rgba(getComputedStyle(el).color), background)),
                    lum(background),
                ].sort((a, b) => b - a);
                return { tag: el.tagName, ratio: (values[0] + 0.05) / (values[1] + 0.05) };
            });
    });
    report.contrast.push({ name, samples });
    assert.ok(samples.length >= 10);
    assert.ok(
        samples.every((sample) => sample.ratio >= 4.5),
        `Runtime text contrast below 4.5:1: ${JSON.stringify(samples.filter((s) => s.ratio < 4.5))}`
    );
}

try {
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
    });
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (url.origin !== origin) {
            report.externalRequests.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        report.calls.push({ method: request.method(), path: url.pathname });
        if (request.method() !== 'GET') {
            report.pageErrors.push(`Unexpected mutation: ${request.method()} ${url.pathname}`);
            return route.abort();
        }
        const send = (data) => route.fulfill({ json: { success: true, data } });
        if (url.pathname.endsWith('/capabilities'))
            return send({ storageReady: true, observationsVersion: 1 });
        if (url.pathname.endsWith('/agents/overview')) {
            if (failOverview)
                return route.fulfill({
                    status: 503,
                    json: { success: false, error: 'Synthetic unavailable store' },
                });
            const values = agents().map((agent) =>
                unavailableMode ? { ...agent, capabilities: null, lastHeartbeatAt: null } : agent
            );
            return send({
                agents: values,
                total: values.length,
                nextOffset: null,
                checkedAt,
                onlineWindowMs: 120000,
                retentionDays: 7,
            });
        }
        report.pageErrors.push(`Unexpected API: ${url.pathname}`);
        return route.abort();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    for (const profile of [
        { name: 'en-light-desktop', locale: 'en-US', theme: 'light', width: 1280 },
        { name: 'zh-dark-desktop', locale: 'zh-CN', theme: 'dark', width: 1280 },
        { name: 'en-dark-mobile', locale: 'en-US', theme: 'dark', width: 375 },
        { name: 'zh-light-mobile', locale: 'zh-CN', theme: 'light', width: 320 },
    ]) {
        unavailableMode = false;
        failOverview = false;
        await page.setViewportSize({ width: profile.width, height: 900 });
        await page.goto(
            `${origin}/tests/browser/probe-agent-runtime.html?${new URLSearchParams({ locale: profile.locale, theme: profile.theme })}`
        );
        await card('declared').waitFor();
        await page.getByTestId('detector-auto-refresh').uncheck();
        await scenario(`${profile.name}: all declaration states and source limits`, async () => {
            for (const id of ids) {
                const expected =
                    id === 'revoked' || id === 'unavailable'
                        ? 'unavailable'
                        : id === 'malformed'
                          ? 'invalid'
                          : id === 'stale'
                            ? 'declared'
                            : id;
                assert.equal(await runtime(id).getAttribute('data-state'), expected);
                await open(runtime(id));
            }
            assert.match(
                await runtime('declared').getByTestId('detector-capability-catalog').innerText(),
                /openai v1/
            );
            assert.match(
                await runtime('stale').getByTestId('detector-capability-catalog').innerText(),
                /IPinfo/
            );
            assert.equal(
                await runtime('legacy').getByTestId('detector-capability-catalog').count(),
                0
            );
            assert.match(
                await runtime('declared').innerText(),
                profile.locale === 'en-US'
                    ? /does not establish current measured capabilities/
                    : /不代表当前实测能力/
            );
            assert.match(
                await runtime('legacy').innerText(),
                profile.locale === 'en-US' ? /Legacy protocol/ : /旧协议/
            );
            assert.match(
                await runtime('stale').innerText(),
                profile.locale === 'en-US' ? /record stale/ : /记录已过期/
            );
            for (const id of ['unavailable', 'malformed', 'revoked'])
                assert.equal(await runtime(id).locator('time').count(), 0);
            for (const id of [
                'missing',
                'unsupported_schema',
                'invalid_declaration',
                'conflicting_versions',
            ])
                assert.ok(!(await runtime(id).innerText()).includes('v1'));
            await noPrivateText();
        });
        await scenario(
            `${profile.name}: successful lease renewal and unknown heartbeat`,
            async () => {
                assert.equal(
                    await card('declared')
                        .getByTestId('detector-lease-renewal')
                        .getAttribute('datetime'),
                    new Date(checkedAt - 750).toISOString()
                );
                assert.equal(await card('legacy').getByTestId('detector-lease-renewal').count(), 0);
                assert.match(
                    await card('declared').innerText(),
                    profile.locale === 'en-US'
                        ? /does not indicate an independent idle heartbeat/
                        : /不表示空闲时有独立心跳/
                );
            }
        );
        await scenario(`${profile.name}: keyboard disclosure and 44px touch target`, async () => {
            const toggle = runtime('declared').locator('summary');
            await toggle.focus();
            await page.keyboard.press('Enter');
            assert.equal(await runtime('declared').evaluate((el) => el.open), false);
            await page.keyboard.press('Space');
            assert.equal(await runtime('declared').evaluate((el) => el.open), true);
            const target = await toggle.evaluate((el) => ({
                height: el.getBoundingClientRect().height,
                outline: getComputedStyle(el).outlineStyle,
                width: parseFloat(getComputedStyle(el).outlineWidth),
                focused: document.activeElement === el,
            }));
            assert.ok(
                target.height >= 44 &&
                    target.focused &&
                    target.outline !== 'none' &&
                    target.width >= 2
            );
        });
        await scenario(`${profile.name}: card layout and readable contrast`, async () => {
            await layout(`${profile.name}-cards`);
            await contrast(`${profile.name}-cards`);
            await screenshot(`${profile.name}-card`, card('declared'));
        });
        await scenario(
            `${profile.name}: table shares bounded declaration and lease time`,
            async () => {
                await page.getByTestId('detector-view-list').click();
                await page.getByTestId('detector-columns-toggle').click();
                await page.getByTestId('detector-column-lastHeartbeatAt').check();
                await page.getByTestId('detector-columns-toggle').click();
                const row = page.getByTestId('detector-row-declared');
                const metadata = row.getByTestId('detector-runtime-declaration');
                await open(metadata);
                assert.equal(await metadata.getAttribute('data-state'), 'declared');
                assert.equal(
                    await row.getByTestId('detector-lease-renewal').getAttribute('datetime'),
                    new Date(checkedAt - 750).toISOString()
                );
                assert.equal(
                    await page
                        .getByTestId('detector-row-revoked')
                        .getByTestId('detector-runtime-declaration')
                        .getAttribute('data-state'),
                    'unavailable'
                );
                await metadata.locator('summary').focus();
                if (profile.width >= 1024) {
                    await page.waitForFunction(() => {
                        const summary = document.activeElement,
                            row = summary.closest('tr');
                        if (!row) return false;
                        const target = summary.getBoundingClientRect(),
                            left = row.querySelector('.detector-name-cell').getBoundingClientRect(),
                            right = row
                                .querySelector('.detector-actions-cell')
                                .getBoundingClientRect();
                        return target.left >= left.right && target.right <= right.left;
                    });
                }
                await layout(`${profile.name}-table`);
                await contrast(`${profile.name}-table`);
                await noPrivateText();
                await screenshot(
                    `${profile.name}-table`,
                    page.getByTestId('detector-table-scroll')
                );
            }
        );
        await scenario(
            `${profile.name}: cached declaration keeps server times after failed refresh and clock change`,
            async () => {
                const metadata = page
                    .getByTestId('detector-row-declared')
                    .getByTestId('detector-runtime-declaration');
                const before = await metadata.innerText();
                failOverview = true;
                await page.getByTestId('detector-refresh').click();
                await page
                    .getByRole('alert')
                    .filter({ hasText: profile.locale === 'en-US' ? /refresh/i : /刷新/ })
                    .waitFor();
                await page.clock.setFixedTime(new Date(checkedAt + 86400000));
                assert.equal(await metadata.innerText(), before);
                assert.equal(
                    await metadata.locator('[data-field="receivedAt"]').getAttribute('datetime'),
                    new Date(declaration.receivedAt).toISOString()
                );
                assert.equal(
                    await metadata.locator('[data-field="checkedAt"]').getAttribute('datetime'),
                    new Date(checkedAt).toISOString()
                );
                await page.clock.setFixedTime(new Date(checkedAt));
                failOverview = false;
            }
        );
        await scenario(
            `${profile.name}: unavailable refresh removes old declaration and renewal`,
            async () => {
                unavailableMode = true;
                await page.getByTestId('detector-refresh').click();
                await page.waitForFunction(() =>
                    [
                        ...document.querySelectorAll(
                            '[data-testid="detector-runtime-declaration"]'
                        ),
                    ].every((el) => el.dataset.state === 'unavailable')
                );
                assert.equal(await page.getByTestId('detector-lease-renewal').count(), 0);
                assert.equal(
                    await page.getByTestId('detector-runtime-declaration').locator('time').count(),
                    0
                );
                await noPrivateText();
            }
        );
        await scenario(`${profile.name}: read failure uses existing overview error`, async () => {
            failOverview = true;
            await page.getByTestId('detector-refresh').click();
            await page
                .getByRole('alert')
                .filter({ hasText: profile.locale === 'en-US' ? /refresh/i : /刷新/ })
                .waitFor();
            assert.equal(
                await page.getByTestId('detector-runtime-declaration').locator('time').count(),
                0
            );
            assert.ok(
                !(await page.locator('body').innerText()).includes('Synthetic unavailable store')
            );
        });
    }
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.ok(report.calls.every((call) => call.method === 'GET'));
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    if (page) await screenshot('failure').catch(() => {});
    throw error;
} finally {
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.tests.length, evidence }));
