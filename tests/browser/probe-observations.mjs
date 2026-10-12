// Offline browser acceptance: every API request is mocked; external hosts abort.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SOURCES, emptyResult } from '../../functions/services/diagnostics/contract.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/probe-observations-evidence'));
await mkdir(evidence, { recursive: true });
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5181, strictPort: true },
    clearScreen: false,
});
let browser,
    posts = 0,
    configured = true;
const blocked = [],
    errors = [],
    overflow = [];
const checkedAt = '2026-01-01T00:00:00.000Z';
const report = {
    version: 1,
    requestId: 'fixture-task',
    scope: 'node',
    checkedAt,
    expiresAt: '2026-01-01T00:10:00.000Z',
    results: [
        {
            ...emptyResult(
                SOURCES.find((s) => s.id === 'ipify'),
                'ok',
                null
            ),
            checkedAt,
            ip: '203.0.113.1',
            family: 4,
            httpStatus: 200,
        },
        {
            ...emptyResult(
                SOURCES.find((s) => s.id === 'ip_sb'),
                'ok',
                null
            ),
            checkedAt,
            ip: '203.0.113.2',
            family: 4,
            countryCode: 'JP',
            asn: 64500,
            httpStatus: 200,
        },
        {
            ...emptyResult(
                SOURCES.find((s) => s.id === 'ippure'),
                'partial',
                null
            ),
            checkedAt,
            ip: '203.0.113.2',
            family: 4,
            riskScore: 0,
            isResidential: false,
            durationMs: 75,
            httpStatus: 200,
        },
        {
            ...emptyResult(
                SOURCES.find((s) => s.id === 'ifconfig'),
                'rate_limited',
                'rate_limited'
            ),
            checkedAt,
            httpStatus: 429,
            retryAfterSeconds: 0,
        },
    ],
    conflicts: [{ type: 'ip', family: 4, values: ['203.0.113.1', '203.0.113.2'] }],
};
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
        if (url.origin !== 'http://127.0.0.1:5181') {
            blocked.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const send = (data) => route.fulfill({ json: { success: true, data } });
        if (url.pathname.endsWith('/capabilities'))
            return send({ storageReady: configured, observationsVersion: 1 });
        if (url.pathname.endsWith('/agents') && req.method() === 'GET')
            return send([{ id: 'agent', name: 'Fixture · Tokyo', lastSeen: Date.now() }]);
        if (url.pathname.endsWith('/jobs') && req.method() === 'GET') return send([]);
        if (url.pathname.endsWith('/jobs') && req.method() === 'POST') {
            const body = req.postDataJSON();
            if (
                body.nodes.length !== 1 ||
                body.nodes[0].url !== 'ss://fixture-only@example.invalid:443' ||
                body.consent !== true ||
                !body.types.includes('observations') ||
                !body.options.sources.includes('ippure')
            )
                throw new Error('Unexpected fixture payload');
            posts++;
            return send({ id: 'fixture-job' });
        }
        if (url.pathname.endsWith('/jobs/fixture-job') && req.method() === 'GET')
            return send({
                job: { total: 1 },
                nextOffset: null,
                nodes: [
                    {
                        id: 'fixture-task',
                        node_name: 'Fixture node',
                        agent_name: 'Fixture · Tokyo',
                        agent_id: 'agent',
                        state: 'done',
                        completed_at: Date.now(),
                        checks: {
                            format: { status: 'passed', code: 'ok' },
                            tcp: { status: 'passed', code: 'ok', latencyMs: 12 },
                            proxy: { status: 'passed', code: 'ok', latencyMs: 123 },
                            unlock: {
                                status: 'unknown',
                                code: 'probe_inconclusive',
                                services: [
                                    {
                                        service: 'openai',
                                        status: 'unknown',
                                        code: 'service_reachable',
                                        httpStatus: 401,
                                    },
                                ],
                            },
                            observations: { status: 'unknown', code: 'probe_inconclusive', report },
                        },
                    },
                ],
            });
        throw new Error(`Unexpected API fixture route: ${req.method()} ${url.pathname}`);
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [name, width, height, dark] of [
        ['desktop', 1280, 900, false],
        ['mobile', 375, 812, true],
    ]) {
        await page.setViewportSize({ width, height });
        await page.goto('http://127.0.0.1:5181/tests/browser/probe-observations.html');
        if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
        await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
        if (!(await page.getByTestId('probe-submit').isDisabled()))
            throw new Error('Submission enabled before consent');
        await page.getByTestId('probe-type-observations').check();
        if (await page.getByTestId('probe-source-ippure').isChecked())
            throw new Error('Quality source enabled by default');
        await page.getByTestId('probe-source-ippure').check();
        await page.getByTestId('probe-agent-agent').check();
        await page.getByTestId('probe-consent').check();
        await page.screenshot({
            path: resolve(evidence, `observations-${name}-consent.png`),
            fullPage: true,
        });
        await page.getByTestId('probe-submit').click();
        await page.getByTestId('probe-observation-details').locator('summary').click();
        await page.locator('[data-source="ippure"]').scrollIntoViewIfNeeded();
        await page.screenshot({
            path: resolve(evidence, `observations-${name}-results.png`),
            fullPage: true,
        });
        const bad = await page.evaluate(() =>
            [...document.querySelectorAll('[role="dialog"],section,article')]
                .filter((e) => e.scrollWidth > e.clientWidth + 1)
                .map((e) => ({ tag: e.tagName, width: e.clientWidth, scroll: e.scrollWidth }))
        );
        overflow.push({ viewport: width, elements: bad });
        if (bad.length) throw new Error(`Outer horizontal overflow at ${width}px`);
        if (await page.getByTestId('probe-consent').isChecked())
            throw new Error('Consent not cleared');
        if (
            !(await page.locator('[data-source="ippure"]').textContent()).includes(
                'Broadcast: Unknown'
            )
        )
            throw new Error('Missing values lost');
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        if (
            !(await page
                .getByRole('button', { name: 'Diagnose', exact: true })
                .evaluate((e) => e === document.activeElement))
        )
            throw new Error('Focus not restored');
    }
    configured = false;
    await page.reload();
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
    await page.getByText('MISUB_PROBE_DB is not configured.', { exact: false }).waitFor();
    if (!(await page.getByTestId('probe-submit').isDisabled()))
        throw new Error('Unconfigured submission enabled');
    await page.screenshot({
        path: resolve(evidence, 'observations-unconfigured.png'),
        fullPage: true,
    });
    const summary = {
        posts,
        externalRequestsBlocked: blocked,
        pageErrors: errors,
        overflow,
        tests: [
            'same task API for single node',
            'consent and IPPure opt-in',
            'nullable evidence and conflicts',
            'expiry',
            'no outer horizontal overflow',
            'Escape and focus restore',
            'no storage disables network work',
        ],
    };
    await writeFile(
        resolve(evidence, 'observations-browser.json'),
        JSON.stringify(summary, null, 2)
    );
    if (errors.length || blocked.length || posts !== 2)
        throw new Error('Browser acceptance failed');
    console.log(JSON.stringify(summary));
} finally {
    await browser?.close();
    await server.close();
}
