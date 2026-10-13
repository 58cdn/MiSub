import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright';
import {
    syntheticProbeInstallation,
    unpublishedProbeInstallation,
} from '../fixtures/probe-release.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = resolve(process.argv[2] || resolve(root, 'tmp/pairing-evidence'));
await mkdir(evidence, { recursive: true });
const localOrigin = 'http://127.0.0.1:5183';
const fixtureOrigin = 'https://misub.fixture.invalid';
const server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), tailwind()],
    resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 5183, strictPort: true, hmr: false },
    clearScreen: false,
});
const windowId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const userCode = 'ABCDE-FGHJK';
const calls = [],
    external = [],
    errors = [],
    overflow = [];
let browser,
    createdAt = 0,
    expiresAt = 0,
    windowState = 'open',
    requestState = 'pending',
    lastSeen = 0;
let revoked = false;
let installation = unpublishedProbeInstallation();
let created = 0,
    approved = 0,
    cancelled = 0,
    expireNext = false;
const pairing = () => ({
    id: requestId,
    windowId,
    origin: fixtureOrigin,
    name: 'Offline fixture device',
    version: 'pairing-fixture',
    platform: 'linux-amd64',
    fingerprint: 'ABCD-EF01-2345-6789',
    status: requestState,
    createdAt,
    expiresAt,
    approvedAt: ['approved', 'consumed'].includes(requestState) ? createdAt + 1 : null,
    consumedAt: requestState === 'consumed' ? createdAt + 2 : null,
    agentId: requestState === 'consumed' ? agentId : null,
    lastSeen,
    checkedAt: Date.now(),
});
const windowData = () => ({
    id: windowId,
    origin: fixtureOrigin,
    status: windowState,
    createdAt,
    expiresAt,
    checkedAt: Date.now(),
    requests: [pairing()],
});
try {
    await server.listen();
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
    });
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            get: () => ({
                writeText: async (text) => {
                    window.__fixtureClipboard = text;
                },
            }),
        });
    });
    await context.routeWebSocket('**/*', (route) => route.close());
    await context.route('**/*', async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (url.origin !== fixtureOrigin) {
            external.push(url.origin);
            return route.abort();
        }
        if (!url.pathname.startsWith('/api/')) {
            const response = await route.fetch({ url: localOrigin + url.pathname + url.search });
            return route.fulfill({ response });
        }
        calls.push({ method: request.method(), path: url.pathname });
        const send = (data, status = 200) =>
            route.fulfill({ status, json: { success: true, data } });
        if (url.pathname.endsWith('/capabilities'))
            return send({ storageReady: true, installation });
        if (url.pathname.endsWith('/agents/overview'))
            return send({
                agents:
                    requestState === 'consumed'
                        ? [
                              {
                                  id: agentId,
                                  name: 'Offline fixture device',
                                  createdAt,
                                  lastSeen,
                                  revokedAt: revoked ? Date.now() : null,
                                  version: 'pairing-fixture',
                                  platform: 'linux-amd64',
                                  status: revoked ? 'revoked' : lastSeen ? 'online' : 'unknown',
                                  lastTaskAt: null,
                                  lastResultAt: null,
                                  taskCounts: { queued: 0, running: 0, done: 0, stopped: 0 },
                              },
                          ]
                        : [],
                total: requestState === 'consumed' ? 1 : 0,
                nextOffset: null,
                checkedAt: Date.now(),
                onlineWindowMs: 120000,
                retentionDays: 7,
            });
        if (url.pathname.endsWith(`/agents/${agentId}`) && request.method() === 'DELETE') {
            revoked = true;
            return send({ revoked: true });
        }
        if (url.pathname.endsWith('/pairings/windows') && request.method() === 'POST') {
            assert.deepEqual(request.postDataJSON(), {});
            created++;
            createdAt = Date.now();
            expiresAt = createdAt + (expireNext ? 2200 : 300000);
            windowState = 'open';
            requestState = 'pending';
            lastSeen = 0;
            revoked = false;
            return send(windowData(), 201);
        }
        if (url.pathname.endsWith(`/pairings/windows/${windowId}/cancel`)) {
            assert.equal(request.method(), 'POST');
            cancelled++;
            windowState = 'cancelled';
            if (requestState !== 'consumed') requestState = 'cancelled';
            return send(windowData());
        }
        if (url.pathname.endsWith(`/pairings/windows/${windowId}`)) {
            assert.equal(request.method(), 'GET');
            return send(windowData());
        }
        if (url.pathname.endsWith('/pairings/resolve')) {
            const body = request.postDataJSON();
            assert.equal(body.windowId, windowId);
            if (body.userCode.replace('-', '') !== userCode.replace('-', '')) {
                return route.fulfill({
                    status: 404,
                    json: { success: false, error: { code: 'pairing_unavailable' } },
                });
            }
            return send(pairing());
        }
        if (url.pathname.endsWith(`/pairings/requests/${requestId}/approve`)) {
            assert.equal(request.method(), 'POST');
            assert.deepEqual(request.postDataJSON(), {
                userCode: userCode.replace('-', ''),
                confirmed: true,
            });
            approved++;
            requestState = 'approved';
            return send(pairing());
        }
        if (url.pathname.endsWith(`/pairings/requests/${requestId}`)) {
            assert.equal(request.method(), 'GET');
            return send(pairing());
        }
        throw new Error(`Unexpected browser API: ${request.method()} ${url.pathname}`);
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [name, width, height, dark] of [
        ['desktop', 1440, 900, false],
        ['mobile', 375, 812, true],
        ['narrow-light', 320, 900, false],
        ['narrow-dark', 320, 900, true],
    ]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${fixtureOrigin}/tests/browser/detector-management.html`);
        if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
        await page.getByTestId('settings-tab-detectors').click();
        await page
            .getByText('Compatible installation packages have not been released.', { exact: false })
            .waitFor();
        assert.ok(await page.getByTestId('pairing-open').isDisabled());
        assert.equal(await page.getByTestId('pairing-command').count(), 0);
        assert.equal(await page.getByTestId('pairing-resume-command').count(), 0);
        assert.equal(await page.getByTestId('pairing-start').count(), 0);
        assert.equal(created, 0);
        const before = calls.length;
        await page.getByTestId('pairing-release-refresh').click();
        await page.getByTestId('pairing-release-refresh').waitFor();
        await page
            .getByText('Compatible installation packages have not been released.', { exact: false })
            .waitFor();
        assert.ok(calls.slice(before).every(({ method }) => method === 'GET'));
        assert.equal(created, 0);
        assert.ok(await page.getByTestId('detector-advanced-toggle').isVisible());
        const bad = await page.evaluate(() =>
            [...document.querySelectorAll('main, section, article')]
                .filter((element) => element.scrollWidth > element.clientWidth + 1)
                .map((element) => element.tagName)
        );
        assert.deepEqual(bad, []);
        await page.screenshot({
            path: resolve(evidence, `detector-pairing-${name}-unavailable.png`),
        });
    }
    // Only the following offline mock supplies synthetic published metadata for session regressions.
    installation = syntheticProbeInstallation();
    async function open(width, height, dark = false) {
        await page.setViewportSize({ width, height });
        await page.goto(`${fixtureOrigin}/tests/browser/detector-management.html`);
        if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
        await page.getByTestId('settings-tab-detectors').click();
        await page.getByTestId('pairing-open').waitFor();
        await page.getByTestId('pairing-open').click();
        await page.getByTestId('pairing-start').waitFor();
    }
    for (const [name, width, height, dark] of [
        ['desktop', 1440, 900, false],
        ['mobile', 375, 812, true],
        ['narrow-light', 320, 900, false],
        ['narrow-dark', 320, 900, true],
    ]) {
        const before = created;
        await open(width, height, dark);
        assert.equal(created, before, 'Opening the wizard cannot create an installation window');
        const terminal = page.getByTestId('pairing-terminal');
        assert.equal(await terminal.inputValue(), 'unix');
        await terminal.focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.equal(await terminal.inputValue(), 'windows');
        assert.equal(created, before, 'Changing terminals cannot create a pairing window');
        assert.ok(
            await terminal.evaluate(
                (e) =>
                    e === document.activeElement &&
                    e.getBoundingClientRect().height >= 44 &&
                    getComputedStyle(e).outlineStyle !== 'none'
            )
        );
        await page.getByTestId('pairing-start').click();
        await page.getByTestId('pairing-window-id').waitFor();
        assert.ok((await page.getByTestId('pairing-window-id').textContent()).includes(windowId));
        const windowsCommand = await page.getByTestId('pairing-command').textContent();
        assert.ok(windowsCommand.includes("@('--setup', '--server'"));
        assert.ok(!/install\.ps1|ExecutionPolicy|EncodedCommand/.test(windowsCommand));
        await page.getByTestId('pairing-copy-command').click();
        assert.equal(await page.evaluate(() => window.__fixtureClipboard), windowsCommand);
        assert.equal(created, before + 1);
        await terminal.selectOption('unix');
        assert.ok((await page.getByTestId('pairing-window-id').textContent()).includes(windowId));
        assert.ok(
            (await page.getByTestId('pairing-command').textContent()).includes(
                '/probe-v9.9.9/install.sh'
            )
        );
        await terminal.selectOption('windows');
        assert.equal(created, before + 1, 'Switching shell instructions preserves the window');
        await page.getByTestId('pairing-window-id').scrollIntoViewIfNeeded();
        await page.getByText('Review complete installation command', { exact: true }).click();
        await page.screenshot({
            path: resolve(evidence, `detector-pairing-${name}-window.png`),
        });
        const commandOverflow = await page.evaluate(() =>
            [...document.querySelectorAll('main, section, pre')]
                .filter(
                    (e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 1
                )
                .map((e) => ({
                    tag: e.tagName,
                    width: e.clientWidth,
                    scrollWidth: e.scrollWidth,
                    id: e.dataset.testid,
                    whiteSpace: getComputedStyle(e).whiteSpace,
                    wordBreak: getComputedStyle(e).wordBreak,
                    codeWhiteSpace: getComputedStyle(e.firstElementChild || e).whiteSpace,
                    codeWordBreak: getComputedStyle(e.firstElementChild || e).wordBreak,
                }))
        );
        assert.deepEqual(commandOverflow, []);
        await page.getByTestId('pairing-code').fill('ZZZZZ-ZZZZZ');
        await page.getByTestId('pairing-resolve').click();
        await page.getByRole('alert').first().waitFor();
        await page.getByTestId('pairing-code').fill(userCode);
        await page.getByTestId('pairing-resolve').click();
        await page.getByTestId('pairing-fingerprint').waitFor();
        assert.ok(await page.getByTestId('pairing-approve').isDisabled());
        const approvalsBefore = approved;
        await page.getByTestId('pairing-confirm').check();
        assert.equal(approved, approvalsBefore, 'Checking comparison alone cannot approve');
        await page.getByTestId('pairing-device').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(evidence, `detector-pairing-${name}-review.png`) });
        await page.getByTestId('pairing-approve').click();
        await page
            .getByText('Approved; waiting for the client to claim its identity', { exact: true })
            .waitFor();
        requestState = 'consumed';
        await page.getByTestId('pairing-refresh').click();
        await page
            .getByText('Identity created; connection not yet confirmed', { exact: true })
            .waitFor();
        await page.screenshot({
            path: resolve(evidence, `detector-pairing-${name}-unconnected.png`),
        });
        lastSeen = Date.now();
        await page.getByTestId('pairing-refresh').click();
        await page
            .getByText('First authenticated communication received', { exact: true })
            .waitFor();
        await page.screenshot({
            path: resolve(evidence, `detector-pairing-${name}-connected.png`),
        });
        const bad = await page.evaluate(() =>
            [...document.querySelectorAll('main, section, article, [role="dialog"]')]
                .filter((element) => element.scrollWidth > element.clientWidth + 1)
                .map((element) => element.tagName)
        );
        overflow.push({ viewport: width, elements: bad });
        assert.deepEqual(bad, []);
        assert.ok(!/mp1_|pdc1_/.test(await page.locator('body').textContent()));
    }
    await open(375, 812, true);
    await page.getByTestId('pairing-start').click();
    await page.getByTestId('pairing-code').fill(userCode);
    await page.getByTestId('pairing-resolve').click();
    await page.getByTestId('pairing-confirm').check();
    await page.getByTestId('pairing-approve').click();
    requestState = 'consumed';
    await page.getByTestId('pairing-refresh').click();
    await page
        .getByText('Identity created; connection not yet confirmed', { exact: true })
        .waitFor();
    assert.ok(await page.getByTestId('pairing-recover-reset').isDisabled());
    await page.getByTestId(`detector-revoke-${agentId}`).click();
    await page.getByTestId('detector-confirm-revoke').click();
    await page.getByTestId(`detector-revoke-${agentId}`).waitFor({ state: 'detached' });
    assert.equal(revoked, true);
    await page.getByTestId('pairing-cancel').click();
    await page.getByTestId('pairing-cancel-confirm').click();
    await page
        .getByText('Identity created; connection not yet confirmed', { exact: true })
        .waitFor();
    await page.getByTestId('pairing-recovery-confirm').check();
    const createdBeforeRecovery = created;
    await page.getByTestId('pairing-recover-reset').click();
    await page.getByTestId('pairing-start').waitFor();
    assert.equal(created, createdBeforeRecovery, 'Recovery only prepares the guide');
    await page.screenshot({ path: resolve(evidence, 'detector-pairing-recovery.png') });
    await open(375, 812, true);
    await page.getByTestId('pairing-start').click();
    await page.getByTestId('pairing-cancel').click();
    const cancelBefore = cancelled;
    await page.getByTestId('pairing-keep').click();
    assert.equal(cancelled, cancelBefore);
    await page.getByTestId('pairing-cancel').click();
    await page.getByTestId('pairing-cancel-confirm').click();
    await page.getByText('Pairing cancelled', { exact: true }).waitFor();
    await page.getByTestId('pairing-reset').click();
    expireNext = true;
    await page.getByTestId('pairing-start').click();
    await page.getByText('Pairing expired', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('pairing-command').count(), 0);
    assert.ok(!(await page.getByTestId('pairing-resume-command').textContent()).includes(windowId));
    await page.screenshot({ path: resolve(evidence, 'detector-pairing-expired.png') });
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    assert.ok(calls.every((call) => !/device-pairing|\/agent\/|\/jobs/.test(call.path)));
    const summary = {
        created,
        approved,
        cancelled,
        externalRequests: external,
        pageErrors: errors,
        overflow,
        tests: [
            'HTTPS fixture origin',
            'explicit unpublished fixture blocks every installation window and command',
            'release refresh reads only; advanced manual configuration remains available',
            'synthetic compatible-release metadata only for session regressions',
            'copies the complete native Windows exe setup command without downloading a ps1',
            'fixed verified Unix script command and independent resume command',
            'expired windows remove the executable pairing command',
            'no implicit enrollment or approval',
            'short-code mismatch',
            'explicit comparison and approval',
            'consumed differs from connected',
            'cancellation confirmation',
            'consumed identity revocation and explicit recovery',
            'local expiry',
            'no native or job API from browser',
            'no private credentials in DOM/commands',
            'desktop/mobile dark mode',
            'explicit PowerShell/Unix terminal choice with keyboard focus and 320px layouts',
        ],
    };
    await writeFile(
        resolve(evidence, 'detector-pairing-browser.json'),
        JSON.stringify(summary, null, 2)
    );
    console.log(JSON.stringify(summary));
} finally {
    await browser?.close();
    await server.close();
}
