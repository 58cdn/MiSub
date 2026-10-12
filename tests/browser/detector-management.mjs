import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/detector-management-evidence'));
await mkdir(evidence, { recursive: true });
const origin = 'http://127.0.0.1:5182';
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5182, strictPort: true },
    clearScreen: false,
});
const errors = [],
    external = [],
    calls = [],
    overflow = [];
const fakeToken = `mp1_${'a'.repeat(64)}`;
let browser,
    configured = true,
    paged = false,
    failOverview = false,
    posts = 0,
    deletes = 0;
const timestamp = Date.now();
const makeAgent = (id, status = 'online') => ({
    id,
    name: `Fixture ${id} · Singapore`,
    createdAt: timestamp - 86400000,
    lastSeen: status === 'unknown' ? 0 : timestamp - (status === 'offline' ? 300000 : 1000),
    revokedAt: status === 'revoked' ? timestamp - 5000 : null,
    version: status === 'unknown' ? '' : '0.2.0-fixture',
    platform: status === 'unknown' ? '' : 'linux-amd64',
    status,
    lastTaskAt: status === 'unknown' ? null : timestamp - 60000,
    lastResultAt: status === 'unknown' ? null : timestamp - 30000,
    taskCounts: { queued: 0, running: 0, done: status === 'unknown' ? 0 : 21, stopped: 0 },
});
let agents;
const resetAgents = () => {
    agents = [
        makeAgent('a1'),
        makeAgent('a2', 'offline'),
        makeAgent('a3', 'unknown'),
        makeAgent('a4', 'revoked'),
    ];
};
resetAgents();
const records = Array.from({ length: 21 }, (_, i) => ({
    id: `record-${i}`,
    jobId: `job-${i}`,
    nodeId: `node-${i}`,
    nodeName: `Fixture node ${i}`,
    state: 'done',
    attempt: 1,
    createdAt: timestamp - 60000 - i * 1000,
    completedAt: timestamp - 30000 - i * 1000,
    checks: {
        tcp: {
            status: i === 0 ? 'failed' : 'passed',
            code: i === 0 ? 'connect_failed' : 'ok',
            ...(i ? { latencyMs: 0 } : {}),
        },
        unlock: {
            status: 'unknown',
            code: 'probe_inconclusive',
            services: [
                {
                    service: 'openai',
                    status: 'unknown',
                    code: 'service_reachable',
                    httpStatus: 401,
                    checkedAt: new Date(timestamp - 40000).toISOString(),
                },
            ],
        },
    },
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
        const req = route.request(),
            url = new URL(req.url());
        if (url.origin !== origin) {
            external.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        calls.push({ path: url.pathname + url.search, method: req.method() });
        const send = (data, status = 200) =>
            route.fulfill({ status, json: { success: true, data } });
        if (url.pathname.endsWith('/capabilities')) return send({ storageReady: configured });
        if (url.pathname.endsWith('/agents/overview')) {
            if (failOverview)
                return route.fulfill({
                    status: 503,
                    json: { success: false, error: { code: 'probe_unavailable' } },
                });
            const all = paged
                ? [...agents, ...Array.from({ length: 17 }, (_, i) => makeAgent(`extra-${i}`))]
                : agents;
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
        if (url.pathname.endsWith('/history')) {
            const agent = agents.find((a) => a.id === url.pathname.split('/').at(-2));
            assert.ok(agent);
            const offset = Number(url.searchParams.get('offset') || 0),
                limit = Number(url.searchParams.get('limit') || 20);
            const all = agent.id === 'a3' ? [] : records;
            return send({
                agent,
                records: all.slice(offset, offset + limit),
                total: all.length,
                nextOffset: offset + limit < all.length ? offset + limit : null,
                checkedAt: Date.now(),
                retentionDays: 7,
            });
        }
        if (url.pathname.endsWith('/agents') && req.method() === 'POST') {
            assert.equal(req.postDataJSON().name, 'Created fixture');
            posts++;
            agents.unshift({ ...makeAgent('created', 'unknown'), name: 'Created fixture' });
            return send(
                { id: 'created', name: 'Created fixture', token: fakeToken, createdAt: Date.now() },
                201
            );
        }
        if (req.method() === 'DELETE') {
            const agent = agents.find((a) => a.id === url.pathname.split('/').at(-1));
            assert.ok(agent);
            deletes++;
            agent.revokedAt = Date.now();
            agent.status = 'revoked';
            return send({ revoked: true });
        }
        throw new Error(`Unexpected fixture request: ${req.method()} ${url.pathname}`);
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [name, width, height, dark] of [
        ['desktop', 1280, 900, false],
        ['mobile', 375, 812, true],
    ]) {
        resetAgents();
        await page.setViewportSize({ width, height });
        const before = calls.length;
        await page.goto(`${origin}/tests/browser/detector-management.html`);
        if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
        assert.equal(calls.length, before, 'Inactive settings must not fetch detector data');
        await page.getByTestId('settings-tab-detectors').click();
        await page.getByTestId('detector-card-a1').waitFor();
        await page.getByTestId('detector-auto-refresh').uncheck();
        assert.equal(posts, 0, 'Opening management cannot enroll an identity');
        assert.ok(!(await page.locator('body').textContent()).includes(fakeToken));
        await page.screenshot({ path: resolve(evidence, `detector-manager-${name}-overview.png`) });
        await page.getByTestId('detector-history-a1').click();
        await page.getByTestId('detector-history').waitFor();
        await page.getByTestId('detector-history-next').click();
        await page.getByText('Fixture node 20', { exact: true }).waitFor();
        await page.getByTestId('detector-history-prev').click();
        await page.getByText('Fixture node 0', { exact: true }).waitFor();
        await page.getByTestId('detector-history').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(evidence, `detector-manager-${name}-history.png`) });
        await page.getByTestId('detector-revoke-a1').click();
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        assert.equal(deletes, 0, 'Dismissed revocation cannot mutate');
        assert.ok(
            await page
                .getByTestId('detector-revoke-a1')
                .evaluate((e) => e === document.activeElement)
        );
        const bad = await page.evaluate(() =>
            [...document.querySelectorAll('main,section,article,[role="dialog"]')]
                .filter((e) => e.scrollWidth > e.clientWidth + 1)
                .map((e) => ({ tag: e.tagName, width: e.clientWidth, scroll: e.scrollWidth }))
        );
        overflow.push({ viewport: width, elements: bad });
        assert.deepEqual(bad, []);
    }
    paged = true;
    await page.getByTestId('detector-refresh').click();
    await page.getByTestId('detector-overview-next').click();
    await page.getByTestId('detector-card-extra-16').waitFor();
    await page.getByTestId('detector-overview-prev').click();
    await page.getByTestId('detector-card-a1').waitFor();
    paged = false;
    await page.getByTestId('detector-name').fill('Created fixture');
    await page.getByTestId('detector-create').click();
    await page.getByTestId('detector-download').waitFor();
    assert.ok(!(await page.locator('body').textContent()).includes(fakeToken));
    const downloadEvent = page.waitForEvent('download');
    await page.getByTestId('detector-download').click();
    const download = await downloadEvent;
    const config = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(config, { version: 1, server: origin, token: fakeToken, pollSeconds: 60 });
    await page.getByTestId('detector-revoke-created').click();
    await page.getByTestId('detector-confirm-revoke').click();
    await page.getByTestId('detector-revoke-created').waitFor({ state: 'detached' });
    assert.equal(deletes, 1);
    assert.equal(posts, 1);
    failOverview = true;
    await page.getByTestId('detector-refresh').click();
    await page.getByRole('alert').first().waitFor();
    await page.screenshot({ path: resolve(evidence, 'detector-manager-error.png') });
    failOverview = false;
    configured = false;
    await page.reload();
    await page.getByTestId('settings-tab-detectors').click();
    await page.getByTestId('detector-create').waitFor();
    assert.ok(await page.getByTestId('detector-create').isDisabled());
    await page.screenshot({ path: resolve(evidence, 'detector-manager-unconfigured.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const summary = {
        posts,
        deletes,
        externalRequests: external,
        pageErrors: errors,
        overflow,
        tests: [
            'lazy settings entry',
            'status and independent times',
            'history and overview pagination',
            'private fixture download',
            'explicit revoke confirmation',
            'Escape focus restoration',
            'refresh error',
            'unconfigured storage',
            'desktop/mobile dark mode',
        ],
    };
    await writeFile(
        resolve(evidence, 'detector-manager-browser.json'),
        JSON.stringify(summary, null, 2)
    );
    console.log(JSON.stringify(summary));
} finally {
    await browser?.close();
    await server.close();
}
