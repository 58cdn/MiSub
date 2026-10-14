// Actual Vue components with synthetic API responses and no external requests.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/probe-execution-history-evidence'));
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
const timestamp = Date.now();
const historicalVersion = `0.2.0-${'history'.repeat(8)}ab`;
const currentVersion = '0.9.0-current';
const secrets = [
    'fixture-private-token',
    'fixture-private-password',
    '/fixture/private/kernel',
    'https://fixture.invalid/private',
];
const snapshot = {
    schemaVersion: 1,
    source: 'detector_reported',
    wrapperVersion: historicalVersion,
    wrapperRevision: 'a'.repeat(40),
    platform: 'linux-amd64',
    kernelLockVersion: 'v1.19.32',
    ruleSetVersion: 1,
    token: secrets[0],
    password: secrets[1],
    path: secrets[2],
    debug: { url: secrets[3] },
};
const sourceSnapshot = { ...snapshot, wrapperVersion: '0.2.0-source', wrapperRevision: 'source' };
delete sourceSnapshot.kernelLockVersion;
const agents = ['a', 'b'].map((id) => ({
    id,
    name: `Current detector ${id.toUpperCase()}`,
    version: currentVersion,
    platform: 'windows-amd64',
    createdAt: timestamp - 86400000,
    lastSeen: timestamp - 1000,
    revokedAt: null,
    status: 'online',
    lastTaskAt: timestamp - 60000,
    lastResultAt: timestamp - 30000,
    lastHeartbeatAt: null,
    capabilities: null,
    hidden: false,
    archivedAt: null,
    taskCounts: { queued: 1, running: 1, done: 4, stopped: 2 },
}));
const record = (id, state, metadata, checks = null) => ({
    id,
    jobId: `job-${id}`,
    nodeId: `node-${id}`,
    nodeName: `Fixture ${id}`,
    state,
    attempt: 1,
    createdAt: timestamp - 60000,
    completedAt: ['done', 'cancelled', 'expired'].includes(state) ? timestamp - 30000 : null,
    checks,
    executionMetadata: metadata,
});
const records = [
    record('history-a', 'done', snapshot, { tcp: { status: 'failed', code: 'connect_failed' } }),
    record('source', 'done', sourceSnapshot, {
        tcp: { status: 'passed', code: 'ok', latencyMs: 7 },
    }),
    record('legacy', 'done', null, { tcp: { status: 'failed', code: 'connect_failed' } }),
    record(
        'invalid',
        'done',
        { ...snapshot, wrapperVersion: secrets[2] },
        { tcp: { status: 'passed', code: 'ok', latencyMs: 8 } }
    ),
    record('cancelled', 'cancelled', null),
    record('expired', 'expired', null),
    record('running', 'running', null),
    record('queued', 'queued', null),
];
const replacementRecords = [
    record('replacement-legacy', 'done', null, {
        tcp: { status: 'passed', code: 'ok', latencyMs: 12 },
    }),
];
let historyReplaced = false,
    browser,
    page,
    origin,
    delayed = null;
const heldRequests = new Set();

function holdNext(path) {
    let enter, release, complete;
    const value = {
        path,
        entered: new Promise((resolve) => {
            enter = resolve;
        }),
        released: new Promise((resolve) => {
            release = resolve;
        }),
        completed: new Promise((resolve) => {
            complete = resolve;
        }),
        enter: () => enter(),
        release: () => release(),
        complete: () => {
            heldRequests.delete(value);
            complete();
        },
    };
    heldRequests.add(value);
    delayed = value;
    return value;
}

async function scenario(name, run) {
    const start = Date.now();
    try {
        await run();
        report.tests.push(name);
        report.cases.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (error) {
        report.cases.push({
            name,
            passed: false,
            durationMs: Date.now() - start,
            error: error.message,
        });
        throw error;
    }
}

async function screenshot(name, locator = page) {
    const path = resolve(evidence, `${name}.png`);
    await locator.screenshot({ path, ...(locator === page ? { fullPage: true } : {}) });
    report.screenshots.push(path);
}

async function visit({
    width = 1280,
    height = 900,
    locale = 'en-US',
    theme = 'light',
    view = 'history',
} = {}) {
    await page.setViewportSize({ width, height });
    await page.goto(
        `${origin}/tests/browser/probe-execution-history.html?${new URLSearchParams({ locale, theme, view })}`
    );
    if (view === 'history') {
        await page.getByTestId('detector-card-a').waitFor();
        await page.getByTestId('detector-auto-refresh').uncheck();
    } else await page.locator('.probe-job-list button').first().waitFor();
}

const historyCard = (id) =>
    page
        .getByTestId('detector-history')
        .locator('article')
        .filter({ has: page.getByText(`Fixture ${id}`, { exact: true }) });
const metadataOf = (id) => historyCard(id).getByTestId('probe-execution-metadata');

async function openMetadata(metadata) {
    const toggle = metadata.getByTestId('probe-execution-toggle');
    if (!(await toggle.evaluate((el) => el.closest('details').open))) await toggle.click();
}

async function noPrivateText() {
    const html = await page.locator('body').innerHTML();
    for (const secret of secrets)
        assert.ok(!html.includes(secret), `Private metadata leaked: ${secret}`);
}

async function layout(name) {
    const result = await page.evaluate(() => {
        const candidates = [
            document.documentElement,
            ...document.querySelectorAll(
                'main,section,article,[data-testid="probe-execution-metadata"]'
            ),
        ];
        return candidates
            .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
            .map((el) => ({
                tag: el.tagName,
                testid: el.dataset.testid || null,
                width: el.clientWidth,
                scroll: el.scrollWidth,
            }));
    });
    report.overflow.push({ viewport: name, elements: result });
    assert.deepEqual(result, [], `Outer or metadata overflow: ${name}`);
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
        const luminance = (rgb) =>
            rgb
                .map((v) => {
                    const n = v / 255;
                    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const elements = [
            ...document.querySelectorAll('[data-testid="probe-execution-metadata"] *'),
        ].filter(
            (el) =>
                el.getClientRects().length &&
                [...el.childNodes].some(
                    (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
                )
        );
        return elements.map((el) => {
            const ancestors = [];
            for (let ancestor = el; ancestor; ancestor = ancestor.parentElement)
                ancestors.unshift(ancestor);
            let background = [255, 255, 255];
            for (const ancestor of ancestors)
                background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background);
            const foreground = blend(rgba(getComputedStyle(el).color), background);
            const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return {
                tag: el.tagName,
                field: el.dataset.field || null,
                ratio: (levels[0] + 0.05) / (levels[1] + 0.05),
            };
        });
    });
    report.contrast.push({ viewport: name, samples });
    assert.ok(samples.length > 10, 'Missing metadata text contrast samples');
    assert.ok(
        samples.every((sample) => sample.ratio >= 4.5),
        `Metadata text contrast below 4.5:1: ${JSON.stringify(samples.filter((s) => s.ratio < 4.5))}`
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
        report.calls.push({ method: request.method(), path: url.pathname + url.search });
        const send = async (data) => {
            const hold = delayed?.path === url.pathname ? delayed : null;
            if (hold) {
                delayed = null;
                hold.enter();
                await hold.released;
            }
            try {
                await route.fulfill({ json: { success: true, data } });
            } catch (error) {
                if (!hold) throw error;
            } finally {
                hold?.complete();
            }
        };
        if (request.method() === 'POST' && url.pathname.endsWith('/format')) {
            const body = request.postDataJSON();
            assert.deepEqual(body.types, ['format']);
            assert.equal(body.consent, false);
            return send({
                checkedAt: timestamp,
                nodes: [
                    {
                        id: 'fixture-node',
                        name: 'Local format fixture',
                        checks: { format: { status: 'passed', code: 'ok' } },
                    },
                ],
            });
        }
        if (request.method() !== 'GET') {
            report.pageErrors.push(`Unexpected mutation: ${request.method()} ${url.pathname}`);
            return route.abort();
        }
        if (url.pathname.endsWith('/capabilities'))
            return send({ storageReady: true, observationsVersion: 1 });
        if (url.pathname.endsWith('/agents/overview'))
            return send({
                agents,
                total: agents.length,
                nextOffset: null,
                checkedAt: timestamp,
                onlineWindowMs: 120000,
                retentionDays: 7,
            });
        if (url.pathname.endsWith('/history')) {
            const agent = agents.find((value) => value.id === url.pathname.split('/').at(-2));
            assert.ok(agent, 'Unknown fixture agent');
            const state = url.searchParams.get('state');
            const all = agent.id === 'a' && !historyReplaced ? records : replacementRecords;
            const filtered = all.filter((value) => !state || value.state === state);
            return send({
                agent,
                records: filtered,
                total: filtered.length,
                nextOffset: null,
                checkedAt: timestamp,
                retentionDays: 7,
            });
        }
        if (url.pathname.endsWith('/agents')) return send(agents);
        if (url.pathname.endsWith('/jobs'))
            return send(
                ['a', 'b'].map((id, i) => ({
                    id: `job-${id}`,
                    created_at: timestamp - 60000 - i * 1000,
                    types: ['tcp'],
                    total: 1,
                    queued: 0,
                    running: 0,
                    done: 1,
                    stopped: 0,
                }))
            );
        if (/\/jobs\/job-[ab]$/.test(url.pathname)) {
            const id = url.pathname.endsWith('job-a') ? 'a' : 'b';
            return send({
                job: { total: 1 },
                nextOffset: null,
                nodes: [
                    {
                        id: `task-${id}`,
                        node_name: `Remote result ${id.toUpperCase()}`,
                        agent_id: 'a',
                        agent_name: agents[0].name,
                        state: 'done',
                        completed_at: timestamp - 30000,
                        checks: { tcp: { status: 'failed', code: 'connect_failed' } },
                        executionMetadata: id === 'a' ? snapshot : null,
                    },
                ],
            });
        }
        report.pageErrors.push(`Unexpected API route: ${request.method()} ${url.pathname}`);
        return route.abort();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));

    for (const options of [
        { name: 'desktop-en-light', width: 1440, height: 960, locale: 'en-US', theme: 'light' },
        { name: 'desktop-zh-dark', width: 1280, height: 900, locale: 'zh-CN', theme: 'dark' },
        { name: 'mobile375-en-dark', width: 375, height: 812, locale: 'en-US', theme: 'dark' },
        { name: 'mobile375-zh-light', width: 375, height: 812, locale: 'zh-CN', theme: 'light' },
        { name: 'mobile320-en-light', width: 320, height: 812, locale: 'en-US', theme: 'light' },
        { name: 'mobile320-zh-dark', width: 320, height: 812, locale: 'zh-CN', theme: 'dark' },
    ])
        await scenario(`history states and accessible layout: ${options.name}`, async () => {
            await visit(options);
            assert.ok(
                (await page.getByTestId('detector-card-a').textContent()).includes(currentVersion)
            );
            await page.getByTestId('detector-history-a').click();
            await metadataOf('history-a').waitFor();
            const statuses = {
                'history-a': 'recorded',
                source: 'recorded',
                legacy: 'unavailable',
                invalid: 'invalid',
                cancelled: 'stopped',
                expired: 'stopped',
                running: 'pending',
                queued: 'pending',
            };
            for (const [id, status] of Object.entries(statuses))
                assert.equal(await metadataOf(id).getAttribute('data-status'), status, id);
            const metadata = metadataOf('history-a'),
                toggle = metadata.getByTestId('probe-execution-toggle');
            await toggle.focus();
            await page.keyboard.press('Enter');
            assert.equal(await toggle.evaluate((el) => el.closest('details').open), true);
            assert.equal(await toggle.evaluate((el) => el === document.activeElement), true);
            assert.ok((await toggle.boundingBox()).height >= 44, 'Summary target is below 44px');
            assert.equal(
                await toggle.evaluate((el) => getComputedStyle(el).outlineStyle !== 'none'),
                true,
                'Keyboard focus indicator missing'
            );
            assert.ok((await metadata.textContent()).includes(historicalVersion));
            assert.ok(!(await metadata.textContent()).includes(currentVersion));
            assert.ok((await historyCard('history-a').textContent()).includes('connect_failed'));
            for (const field of [
                'wrapperVersion',
                'wrapperRevision',
                'platform',
                'kernelLockVersion',
                'ruleSetVersion',
                'schemaVersion',
            ])
                assert.equal(await metadata.locator(`[data-field="${field}"]`).count(), 1);
            await page.keyboard.press('Space');
            assert.equal(await toggle.evaluate((el) => el.closest('details').open), false);
            await page.keyboard.press('Enter');
            await openMetadata(metadataOf('source'));
            const source = await metadataOf('source').textContent();
            assert.ok(
                source.includes(
                    options.locale === 'en-US'
                        ? 'Source build; revision not provided'
                        : '源码构建，修订未提供'
                )
            );
            assert.ok(
                source.includes(options.locale === 'en-US' ? 'Unknown (not provided)' : '未知'),
                'Missing kernel must remain unknown'
            );
            for (const id of ['legacy', 'invalid', 'cancelled', 'running']) {
                await openMetadata(metadataOf(id));
                assert.equal(
                    await metadataOf(id).locator('[data-field="wrapperVersion"]').count(),
                    0,
                    'Unavailable state retained identity fields'
                );
            }
            await noPrivateText();
            await layout(options.name);
            await contrast(options.name);
            await screenshot(`${options.name}-history-a`, historyCard('history-a'));
            if (options.name === 'desktop-en-light')
                await screenshot('desktop-en-light-all-history-states');
        });

    await scenario(
        'history switches ignore delayed old evidence and reload does not backfill current build',
        async () => {
            await visit();
            await page.getByTestId('detector-history-a').click();
            await metadataOf('history-a').waitFor();
            const hold = holdNext('/api/probes/v1/agents/a/history');
            await page.getByTestId('detector-history-a').click();
            await hold.entered;
            await page.getByTestId('detector-history-b').click();
            await metadataOf('replacement-legacy').waitFor();
            hold.release();
            await hold.completed;
            await page.evaluate(
                () =>
                    new Promise((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve))
                    )
            );
            assert.equal(await metadataOf('history-a').count(), 0);
            assert.equal(
                await metadataOf('replacement-legacy').getAttribute('data-status'),
                'unavailable'
            );
            historyReplaced = true;
            await page.reload();
            await page.getByTestId('detector-card-a').waitFor();
            await page.getByTestId('detector-auto-refresh').uncheck();
            await page.getByTestId('detector-history-a').click();
            await metadataOf('replacement-legacy').waitFor();
            assert.equal(
                await page
                    .getByTestId('detector-history')
                    .locator('[data-field="wrapperVersion"]')
                    .count(),
                0
            );
            await noPrivateText();
            historyReplaced = false;
        }
    );

    for (const options of [
        {
            name: 'nodes-desktop-en-light',
            width: 1440,
            height: 960,
            locale: 'en-US',
            theme: 'light',
        },
        {
            name: 'nodes-mobile320-zh-dark',
            width: 320,
            height: 812,
            locale: 'zh-CN',
            theme: 'dark',
        },
    ])
        await scenario(
            `remote node results and local format boundary: ${options.name}`,
            async () => {
                await visit({ ...options, view: 'nodes' });
                await page
                    .locator('.probe-job-list .probe-job')
                    .nth(0)
                    .locator('button')
                    .first()
                    .click();
                let metadata = page.getByTestId('probe-execution-metadata');
                await metadata.waitFor();
                assert.equal(await metadata.count(), 1);
                assert.equal(await metadata.getAttribute('data-status'), 'recorded');
                await openMetadata(metadata);
                assert.ok((await metadata.textContent()).includes(historicalVersion));
                assert.ok(!(await metadata.textContent()).includes(currentVersion));
                await noPrivateText();
                await layout(options.name);
                await contrast(options.name);
                await screenshot(options.name);
                const hold = holdNext('/api/probes/v1/jobs/job-b');
                await page
                    .locator('.probe-job-list .probe-job')
                    .nth(1)
                    .locator('button')
                    .first()
                    .click();
                await hold.entered;
                assert.equal(
                    await page.getByTestId('probe-execution-metadata').count(),
                    0,
                    'Switching jobs kept the previous snapshot visible'
                );
                hold.release();
                await hold.completed;
                metadata = page.getByTestId('probe-execution-metadata');
                await metadata.waitFor();
                assert.equal(await metadata.getAttribute('data-status'), 'unavailable');
                await page.getByTestId('probe-type-tcp').uncheck();
                await page.getByTestId('probe-type-proxy').uncheck();
                await page.getByTestId('probe-submit').click();
                await page
                    .locator('.probe-results')
                    .getByRole('rowheader', { name: 'Local format fixture MiSub' })
                    .waitFor();
                assert.equal(
                    await page.getByTestId('probe-execution-metadata').count(),
                    0,
                    'Local format produced a remote execution snapshot'
                );
            }
        );
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.equal(
        report.calls.filter((call) => call.method !== 'GET').length,
        2,
        'Only two mocked local format submissions are allowed'
    );
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    if (page) await screenshot('failure').catch(() => {});
    throw error;
} finally {
    for (const hold of heldRequests) hold.release();
    await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.tests.length, evidence }));
