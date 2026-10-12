import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, KeepAlive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import DetectorPairingWizard from '../../src/components/settings/sections/DetectorPairingWizard.vue';
import DetectorSettings from '../../src/components/settings/sections/DetectorSettings.vue';
import { setLocale } from '../../src/i18n/index.js';
import { syntheticProbeInstallation } from '../fixtures/probe-release.js';

const origin = 'https://misub.fixture.invalid';
const windowId = '00000000-0000-4000-8000-000000000001';
const pairingId = '00000000-0000-4000-8000-000000000002';
const agentId = '00000000-0000-4000-8000-000000000003';
const epoch = Date.parse('2026-01-01T00:00:00Z');
let wrappers,
    calls,
    state,
    windowState,
    lastSeen,
    postWindow,
    resolveCode,
    approveCode,
    readState,
    cancelWindow;
const safePair = (extra = {}) => ({
    id: pairingId,
    windowId,
    origin,
    name: 'Fixture detector',
    version: '0.2.0-fixture',
    platform: 'linux-amd64',
    fingerprint: 'ABCD-1234-EF56-7890',
    status: state,
    createdAt: epoch,
    expiresAt: epoch + 300000,
    approvedAt: null,
    consumedAt: null,
    agentId: state === 'consumed' ? agentId : null,
    lastSeen,
    checkedAt: epoch + performance.now(),
    ...extra,
});
const safeWindow = (extra = {}) => ({
    id: windowId,
    origin,
    status: windowState,
    createdAt: epoch,
    expiresAt: epoch + 300000,
    checkedAt: epoch + performance.now(),
    requests: [safePair()],
    ...extra,
});
const response = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const failure = (code, status = 400, extra = {}) =>
    new Response(JSON.stringify({ success: false, error: { code, ...extra } }), { status });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const get = (wrapper, id) => wrapper.get(`[data-testid="${id}"]`);
const create = (options = {}) => {
    const wrapper = mount(DetectorPairingWizard, {
        props: { enabled: true, installation: syntheticProbeInstallation(), ...options },
        attachTo: document.body,
    });
    wrappers.push(wrapper);
    return wrapper;
};
const start = async (wrapper) => {
    await get(wrapper, 'pairing-open').trigger('click');
    await get(wrapper, 'pairing-start').trigger('click');
    await flushPromises();
};
const review = async (wrapper) => {
    await get(wrapper, 'pairing-code').setValue('abcde-12345');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
};
const approve = async (wrapper) => {
    await get(wrapper, 'pairing-confirm').setValue(true);
    await get(wrapper, 'pairing-approve').trigger('click');
    await flushPromises();
};
const posts = () => calls.filter(({ options }) => options.method === 'POST');
beforeEach(() => {
    setLocale('en-US');
    wrappers = [];
    calls = [];
    state = 'pending';
    windowState = 'open';
    lastSeen = 0;
    vi.spyOn(window, 'location', 'get').mockReturnValue({ origin, protocol: 'https:' });
    postWindow = async () => response(safeWindow());
    resolveCode = async () => response(safePair());
    approveCode = async () => {
        state = 'approved';
        return response(safePair());
    };
    readState = async (url) => response(url.includes('/requests/') ? safePair() : safeWindow());
    cancelWindow = async () => {
        windowState = 'cancelled';
        if (state !== 'consumed') state = 'cancelled';
        return response(safeWindow());
    };
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options = {}) => {
            calls.push({ url, options });
            if (options.method === 'GET') return readState(url, options);
            if (url.endsWith('/windows')) return postWindow(url, options);
            if (url.endsWith('/resolve')) return resolveCode(url, options);
            if (url.endsWith('/approve')) return approveCode(url, options);
            if (url.endsWith('/cancel')) return cancelWindow(url, options);
            throw new Error('unexpected_request');
        })
    );
});
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('detector pairing wizard', () => {
    it('does not request or create anything on mount or when only opening the guide', async () => {
        const wrapper = create();
        await flushPromises();
        expect(calls).toHaveLength(0);
        expect(wrapper.text()).toContain('Compatible release packages are verified');
        expect(wrapper.text()).toContain('probe-v0.1.0 does not support');
        await get(wrapper, 'pairing-open').trigger('click');
        expect(calls).toHaveLength(0);
        expect(document.activeElement).toBe(get(wrapper, 'pairing-title').element);
        expect(wrapper.text()).toContain('five-minute pairing window');
    });
    it('requires configured storage and HTTPS before opening or posting', async () => {
        const disabled = create({ enabled: false });
        expect(get(disabled, 'pairing-open').attributes('disabled')).toBeDefined();
        vi.spyOn(window, 'location', 'get').mockReturnValue({
            origin: 'http://fixture.invalid',
            protocol: 'http:',
        });
        const insecure = create();
        await flushPromises();
        expect(get(insecure, 'pairing-open').attributes('disabled')).toBeDefined();
        expect(insecure.text()).toContain('Pairing requires this site to be accessed over HTTPS');
        expect(calls).toHaveLength(0);
    });
    it('creates a synthetic-release window only by explicit action and displays only its public ID', async () => {
        const wrapper = create();
        await start(wrapper);
        expect(posts()).toHaveLength(1);
        expect(posts()[0].url).toBe('/api/probes/v1/pairings/windows');
        expect(JSON.parse(posts()[0].options.body)).toEqual({});
        expect(get(wrapper, 'pairing-window-id').text()).toContain(windowId);
        expect(wrapper.find('[data-testid="pairing-command"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('misub-probe --pair');
        expect(get(wrapper, 'pairing-status').text()).toContain('Waiting for a client code');
        expect(wrapper.text()).toContain(
            'Private device credentials and configuration stay off this page'
        );
    });
    it('requires reviewed metadata and a fresh explicit confirmation before approval', async () => {
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        expect(posts()).toHaveLength(2);
        expect(JSON.parse(posts()[1].options.body)).toEqual({ windowId, userCode: 'ABCDE12345' });
        expect(get(wrapper, 'pairing-device').text()).toContain('Fixture detector');
        expect(get(wrapper, 'pairing-fingerprint').text()).toBe('ABCD-1234-EF56-7890');
        expect(wrapper.text()).toContain('not verified hardware');
        expect(get(wrapper, 'pairing-approve').attributes('disabled')).toBeDefined();
        await approve(wrapper);
        expect(posts()).toHaveLength(3);
        expect(JSON.parse(posts()[2].options.body)).toEqual({
            userCode: 'ABCDE12345',
            confirmed: true,
        });
        expect(get(wrapper, 'pairing-status').text()).toContain('Approved; waiting for the client');
        expect(wrapper.text()).toContain(
            'Approval alone does not mean an identity was created or connected'
        );
    });
    it('clears the review when a user edits the terminal code so an old device cannot be approved', async () => {
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await get(wrapper, 'pairing-confirm').setValue(true);
        await get(wrapper, 'pairing-code').setValue('ZZZZZ-12345');
        expect(wrapper.find('[data-testid="pairing-device"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pairing-approve"]').exists()).toBe(false);
        expect(posts()).toHaveLength(2);
    });
    it('handles an incorrect code with a fixed message and never echoes error payloads', async () => {
        resolveCode = async () => failure('pairing_unavailable', 404, { token: 'DO_NOT_RENDER' });
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        expect(wrapper.text()).toContain('Unable to match this code');
        expect(wrapper.html()).not.toContain('DO_NOT_RENDER');
        expect(wrapper.find('[data-testid="pairing-approve"]').exists()).toBe(false);
        expect(posts()).toHaveLength(2);
    });
    it('strips secrets and unknown fields from responses and never stores configuration or credentials', async () => {
        const extra = {
            token: 'LONG_TERM_SECRET',
            deviceCode: 'PRIVATE_DEVICE_SECRET',
            proof: 'PRIVATE_PROOF',
            proofHash: 'PRIVATE_HASH',
            config: { token: 'CONFIG_SECRET' },
        };
        postWindow = async () => response(safeWindow(extra));
        resolveCode = async () => response(safePair(extra));
        const store = vi.spyOn(Storage.prototype, 'setItem');
        const log = vi.spyOn(console, 'log');
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        expect(wrapper.html()).not.toMatch(
            /LONG_TERM_SECRET|PRIVATE_DEVICE_SECRET|PRIVATE_PROOF|PRIVATE_HASH|CONFIG_SECRET/
        );
        expect(store).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(calls.every(({ url }) => url.startsWith('/api/probes/v1/pairings/'))).toBe(true);
        expect(JSON.stringify(calls)).not.toContain('PRIVATE_DEVICE_SECRET');
    });
    it('rejects other origins and invalid response identities rather than constructing unsafe commands', async () => {
        postWindow = async () => response(safeWindow({ origin: 'https://other.invalid' }));
        const wrapper = create();
        await start(wrapper);
        expect(wrapper.text()).toContain('returned pairing information could not be verified');
        expect(wrapper.find('[data-testid="pairing-command"]').exists()).toBe(false);
        postWindow = async () => response(safeWindow());
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        resolveCode = async () => response(safePair({ fingerprint: 'NOT_VALID' }));
        await review(wrapper);
        expect(wrapper.find('[data-testid="pairing-approve"]').exists()).toBe(false);
    });
    it('distinguishes a consumed identity from a real first communication and emits only safe refresh events', async () => {
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        state = 'consumed';
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toBe(
            'Identity created; connection not yet confirmed'
        );
        expect(wrapper.text()).toContain('revoke this identity in the management list');
        expect(wrapper.text()).toContain('configuration cannot be retrieved again');
        expect(wrapper.emitted('agents-changed')).toEqual([[]]);
        lastSeen = epoch + performance.now();
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toBe(
            'First authenticated communication received'
        );
        expect(wrapper.text()).toContain('does not indicate a successful node check');
        expect(wrapper.emitted('agents-changed')).toHaveLength(1);
    });
    it('does not call a future or invalid communication timestamp a connection', async () => {
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        state = 'consumed';
        lastSeen = epoch + 600000;
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toContain('connection not yet confirmed');
    });
    it('requires explicit cancellation, permits keeping the window, and does not automatically replace it', async () => {
        const wrapper = create();
        await start(wrapper);
        await get(wrapper, 'pairing-cancel').trigger('click');
        expect(posts()).toHaveLength(1);
        await get(wrapper, 'pairing-keep').trigger('click');
        expect(posts()).toHaveLength(1);
        await get(wrapper, 'pairing-cancel').trigger('click');
        await get(wrapper, 'pairing-cancel-confirm').trigger('click');
        await flushPromises();
        expect(posts()).toHaveLength(2);
        expect(posts()[1].url).toContain('/cancel');
        expect(get(wrapper, 'pairing-status').text()).toBe('Pairing cancelled');
        await get(wrapper, 'pairing-reset').trigger('click');
        await flushPromises();
        expect(posts()).toHaveLength(2);
        expect(get(wrapper, 'pairing-start').exists()).toBe(true);
    });
    it('keeps an already created identity visible after cancelling the window', async () => {
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        state = 'consumed';
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        await get(wrapper, 'pairing-cancel').trigger('click');
        await get(wrapper, 'pairing-cancel-confirm').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toContain('Identity created');
        expect(wrapper.text()).toContain(agentId);
        expect(wrapper.text()).toContain('revoke this identity');
        expect(posts().some(({ options }) => options.method === 'DELETE')).toBe(false);
    });
    it('recovers explicitly after management revocation and window cancellation without implicitly opening another window', async () => {
        let revoked = false;
        const pairingFetch = fetch.getMockImplementation();
        fetch.mockImplementation(async (url, options = {}) => {
            if (url.endsWith('/capabilities')) {
                calls.push({ url, options });
                return response({ storageReady: true, installation: syntheticProbeInstallation() });
            }
            if (url.includes('/agents/overview?')) {
                calls.push({ url, options });
                const agents =
                    state === 'consumed'
                        ? [
                              {
                                  id: agentId,
                                  name: 'Fixture detector',
                                  status: revoked ? 'revoked' : 'unknown',
                                  lastSeen: 0,
                                  revokedAt: revoked ? epoch : null,
                                  lastTaskAt: null,
                                  lastResultAt: null,
                              },
                          ]
                        : [];
                return response({
                    agents,
                    total: agents.length,
                    nextOffset: null,
                    checkedAt: epoch + performance.now(),
                    retentionDays: 7,
                    onlineWindowMs: 120000,
                });
            }
            if (url === `/api/probes/v1/agents/${agentId}` && options.method === 'DELETE') {
                calls.push({ url, options });
                revoked = true;
                return response({ revoked: true });
            }
            return pairingFetch(url, options);
        });
        const wrapper = mount(DetectorSettings, {
            attachTo: document.body,
            global: { stubs: { teleport: true } },
        });
        wrappers.push(wrapper);
        await flushPromises();
        await start(wrapper);
        await get(wrapper, 'pairing-code').setValue('ABCDE-12345');
        await get(wrapper, 'pairing-wizard').get('form').trigger('submit');
        await flushPromises();
        await approve(wrapper);
        state = 'consumed';
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-recover-reset').attributes('disabled')).toBeDefined();
        await get(wrapper, `detector-revoke-${agentId}`).trigger('click');
        await get(wrapper, 'detector-confirm-revoke').trigger('click');
        await flushPromises();
        expect(revoked).toBe(true);
        expect(get(wrapper, `detector-card-${agentId}`).text()).toContain('Revoked');
        await get(wrapper, 'pairing-cancel').trigger('click');
        await get(wrapper, 'pairing-cancel-confirm').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toContain('Identity created');
        const beforeReset = calls.length;
        await get(wrapper, 'pairing-recovery-confirm').setValue(true);
        await get(wrapper, 'pairing-recover-reset').trigger('click');
        await flushPromises();
        expect(calls).toHaveLength(beforeReset);
        expect(get(wrapper, 'pairing-status').text()).toBe('Ready to pair');
        expect(get(wrapper, 'pairing-start').exists()).toBe(true);
        state = 'pending';
        windowState = 'open';
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        expect(posts().filter(({ url }) => url.endsWith('/windows'))).toHaveLength(2);
        expect(calls.filter(({ options }) => options.method === 'DELETE')).toHaveLength(1);
    });
    it('ignores a late pre-cancel status response even when the mocked network ignores abort', async () => {
        const wrapper = create();
        await start(wrapper);
        const pending = deferred();
        readState = () => pending.promise;
        await get(wrapper, 'pairing-refresh').trigger('click');
        const signal = calls.at(-1).options.signal;
        await get(wrapper, 'pairing-cancel').trigger('click');
        await get(wrapper, 'pairing-cancel-confirm').trigger('click');
        await flushPromises();
        expect(signal.aborted).toBe(true);
        expect(get(wrapper, 'pairing-status').text()).toBe('Pairing cancelled');
        pending.resolve(response(safeWindow({ status: 'open' })));
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toBe('Pairing cancelled');
    });
    it('never retries an ambiguous approval POST and recovers via a read-only status check', async () => {
        approveCode = async () => {
            state = 'approved';
            throw new Error('PRIVATE_NETWORK_ERROR');
        };
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        expect(wrapper.text()).toContain('Approval was not confirmed');
        expect(wrapper.html()).not.toContain('PRIVATE_NETWORK_ERROR');
        expect(posts()).toHaveLength(3);
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        expect(posts()).toHaveLength(3);
        expect(get(wrapper, 'pairing-status').text()).toContain('Approved; waiting');
    });
    it('bounds the window lifetime using server time and stops expiry polling without creating a replacement', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        await vi.advanceTimersByTimeAsync(301000);
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toBe('Pairing expired');
        const count = calls.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(calls).toHaveLength(count);
        expect(posts()).toHaveLength(1);
    });
    it('ends automatic waiting for an unconnected consumed identity after two minutes', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        state = 'consumed';
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(121000);
        await flushPromises();
        expect(wrapper.text()).toContain('Automatic waiting has ended');
        expect(get(wrapper, 'pairing-status').text()).toContain('connection not yet confirmed');
        const count = calls.length;
        await vi.advanceTimersByTimeAsync(30000);
        expect(calls).toHaveLength(count);
    });
    it('allows a slow explicit status read after automatic connection waiting has ended', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        await review(wrapper);
        await approve(wrapper);
        state = 'consumed';
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(121000);
        await flushPromises();
        const pending = deferred();
        readState = () => pending.promise;
        await get(wrapper, 'pairing-refresh').trigger('click');
        const signal = calls.at(-1).options.signal;
        await vi.advanceTimersByTimeAsync(1500);
        expect(signal.aborted).toBe(false);
        lastSeen = epoch + performance.now();
        pending.resolve(response(safePair()));
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).toBe(
            'First authenticated communication received'
        );
    });
    it.each(['expired', 'cancelled'])(
        'allows a slow explicit status read after the window is %s',
        async (terminalState) => {
            vi.useFakeTimers({
                toFake: [
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    'performance',
                ],
            });
            const wrapper = create();
            await start(wrapper);
            if (terminalState === 'expired') await vi.advanceTimersByTimeAsync(301000);
            else {
                await get(wrapper, 'pairing-cancel').trigger('click');
                await get(wrapper, 'pairing-cancel-confirm').trigger('click');
                await flushPromises();
                await vi.advanceTimersByTimeAsync(1000);
            }
            const pending = deferred();
            readState = () => pending.promise;
            await get(wrapper, 'pairing-refresh').trigger('click');
            const signal = calls.at(-1).options.signal;
            await vi.advanceTimersByTimeAsync(1500);
            expect(signal.aborted).toBe(false);
            pending.resolve(response(safeWindow({ status: terminalState })));
            await flushPromises();
            expect(get(wrapper, 'pairing-status').text()).toBe(`Pairing ${terminalState}`);
            expect(get(wrapper, 'pairing-refresh').attributes('disabled')).toBeUndefined();
        }
    );
    it('honors server retry delays and does not automatically retry a rate-limited window creation', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        postWindow = async () => failure('pairing_rate_limited', 429, { retryAfterSeconds: 3600 });
        const wrapper = create();
        await start(wrapper);
        expect(wrapper.text()).toContain('Requests are rate limited');
        expect(get(wrapper, 'pairing-start').attributes('disabled')).toBeDefined();
        await vi.advanceTimersByTimeAsync(3599000);
        expect(posts()).toHaveLength(1);
        expect(get(wrapper, 'pairing-start').attributes('disabled')).toBeDefined();
        await vi.advanceTimersByTimeAsync(2000);
        expect(get(wrapper, 'pairing-start').attributes('disabled')).toBeUndefined();
        expect(posts()).toHaveLength(1);
    });
    it('keeps a server cooldown when an expired window is explicitly cleared for another pairing', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        readState = async () => failure('pairing_rate_limited', 429, { retryAfterSeconds: 3600 });
        await get(wrapper, 'pairing-refresh').trigger('click');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(301000);
        expect(get(wrapper, 'pairing-status').text()).toContain('Pairing expired');
        await get(wrapper, 'pairing-reset').trigger('click');
        expect(get(wrapper, 'pairing-start').attributes('disabled')).toBeDefined();
        expect(get(wrapper, 'pairing-retry-after').text()).toContain('Wait at least');
        expect(posts()).toHaveLength(1);
    });
    it('times out a pending status read without overlap and backs off before read-only recovery', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        readState = async (_, options) =>
            new Promise((resolve, reject) =>
                options.signal.addEventListener(
                    'abort',
                    () => reject(new DOMException('Aborted', 'AbortError')),
                    { once: true }
                )
            );
        await get(wrapper, 'pairing-refresh').trigger('click');
        await vi.advanceTimersByTimeAsync(20001);
        await flushPromises();
        expect(calls.filter(({ options }) => options.method === 'GET')).toHaveLength(1);
        expect(get(wrapper, 'pairing-status').text()).toContain('State needs refresh');
        expect(wrapper.text()).toContain('Unable to refresh state');
        expect(posts()).toHaveLength(1);
        readState = async () => response(safeWindow());
        await vi.advanceTimersByTimeAsync(10000);
        await flushPromises();
        expect(calls.filter(({ options }) => options.method === 'GET')).toHaveLength(2);
        expect(get(wrapper, 'pairing-status').text()).not.toContain('State needs refresh');
    });
    it('requires typed declared metadata and keeps cancellation controls in a visible keyboard focus order', async () => {
        const wrapper = create();
        await start(wrapper);
        resolveCode = async () => response(safePair({ version: undefined }));
        await review(wrapper);
        expect(wrapper.find('[data-testid="pairing-approve"]').exists()).toBe(false);
        const button = get(wrapper, 'pairing-cancel');
        button.element.focus();
        await button.trigger('click');
        expect(document.activeElement).toBe(get(wrapper, 'pairing-cancel-confirmation').element);
        await get(wrapper, 'pairing-keep').trigger('click');
        expect(document.activeElement).toBe(button.element);
    });
    it('pauses hidden polling, aborts pending reads and ignores late responses', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
        });
        const wrapper = create();
        await start(wrapper);
        const pending = deferred();
        readState = () => pending.promise;
        await get(wrapper, 'pairing-refresh').trigger('click');
        const signal = calls.at(-1).options.signal;
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(signal.aborted).toBe(true);
        const count = calls.length;
        await vi.advanceTimersByTimeAsync(30000);
        expect(calls).toHaveLength(count);
        pending.resolve(response(safeWindow({ status: 'cancelled' })));
        await flushPromises();
        expect(get(wrapper, 'pairing-status').text()).not.toContain('cancelled');
        readState = async () => response(safeWindow());
        hidden.mockReturnValue(false);
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(calls.length).toBe(count + 1);
    });
    it('aborts pending writes on unmount without sending an implicit cancellation or accepting a late window', async () => {
        const pending = deferred();
        postWindow = () => pending.promise;
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-start').trigger('click');
        const signal = calls.at(-1).options.signal;
        wrapper.unmount();
        expect(signal.aborted).toBe(true);
        pending.resolve(response(safeWindow()));
        await flushPromises();
        expect(posts()).toHaveLength(1);
    });
    it('clears short-code confirmation and stops polling across KeepAlive deactivation', async () => {
        const shell = defineComponent({
            components: { DetectorPairingWizard, KeepAlive },
            data: () => ({ visible: true, installation: syntheticProbeInstallation() }),
            template:
                '<KeepAlive><DetectorPairingWizard v-if="visible" enabled :installation="installation" /></KeepAlive>',
        });
        const wrapper = mount(shell, { attachTo: document.body });
        wrappers.push(wrapper);
        await start(wrapper);
        await review(wrapper);
        await get(wrapper, 'pairing-confirm').setValue(true);
        await wrapper.setData({ visible: false });
        await wrapper.setData({ visible: true });
        await flushPromises();
        expect(get(wrapper, 'pairing-code').element.value).toBe('');
        expect(get(wrapper, 'pairing-confirm').element.checked).toBe(false);
        expect(get(wrapper, 'pairing-approve').attributes('disabled')).toBeDefined();
        expect(posts()).toHaveLength(2);
    });
});
