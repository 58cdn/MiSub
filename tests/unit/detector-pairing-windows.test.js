import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DetectorPairingWizard from '../../src/components/settings/sections/DetectorPairingWizard.vue';
import { setLocale } from '../../src/i18n/index.js';
import catalog from '../../detector/release-catalog.json';
import { probeInstallationCapabilities } from '../../src/shared/probe-release.js';
import { syntheticProbeInstallation } from '../fixtures/probe-release.js';

const site = 'https://misub.fixture.invalid';
const windowId = '11111111-1111-4111-8111-111111111111';
let wrappers, calls, origin, now;
const get = (wrapper, id) => wrapper.get(`[data-testid="${id}"]`);
const create = (props = {}) => {
    const wrapper = mount(DetectorPairingWizard, {
        props: { enabled: true, installation: syntheticProbeInstallation(), ...props },
        attachTo: document.body,
    });
    wrappers.push(wrapper);
    return wrapper;
};
beforeEach(() => {
    setLocale('en-US');
    wrappers = [];
    calls = [];
    origin = site;
    now = Date.now();
    vi.spyOn(window, 'location', 'get').mockImplementation(() => ({ origin, protocol: 'https:' }));
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options) => {
            calls.push({ url, options });
            expect(url).toBe('/api/probes/v1/pairings/windows');
            expect(options.method).toBe('POST');
            return new Response(
                JSON.stringify({
                    success: true,
                    data: {
                        id: windowId,
                        origin,
                        status: 'open',
                        createdAt: now,
                        checkedAt: now,
                        expiresAt: now + 300000,
                        requests: [],
                        token: 'FIXTURE_PRIVATE_TOKEN',
                    },
                })
            );
        })
    );
});
afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('verified installation availability', () => {
    it.each([
        ['unread', { installation: null }],
        ['loading', { installationLoading: true }],
        ['failed', { installationError: true }],
        ['unreleased', { installation: probeInstallationCapabilities(catalog) }],
        ['invalid', { installation: { distributionReady: true, available: true } }],
    ])('does not open a window, emit commands, or send requests while %s', async (_, props) => {
        const wrapper = create(props);
        const open = get(wrapper, 'pairing-open');
        expect(open.attributes('disabled')).toBeDefined();
        await open.trigger('click');
        await flushPromises();
        expect(calls).toHaveLength(0);
        expect(wrapper.find('[data-testid="pairing-start"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pairing-command"]').exists()).toBe(false);
        expect(wrapper.text()).not.toMatch(/misub-probe.*--pair|executable’s directory/);
    });
    it('explains the actual 0.1.0 flag mismatch and offers a read-only release refresh', async () => {
        const wrapper = create({ installation: probeInstallationCapabilities(catalog) });
        expect(wrapper.text()).toContain('Compatible installation packages have not been released');
        expect(wrapper.text()).toContain(
            'probe-v0.1.0 does not support pairing or installation commands'
        );
        await get(wrapper, 'pairing-release-refresh').trigger('click');
        expect(wrapper.emitted('refresh-installation')).toEqual([[]]);
        expect(calls).toHaveLength(0);
    });
    it('defaults to Linux/macOS even on Windows and does not store or send terminal selection', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
        const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
        vi.stubGlobal('localStorage', storage);
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        expect(get(wrapper, 'pairing-terminal').element.value).toBe('unix');
        await get(wrapper, 'pairing-terminal').setValue('windows');
        expect(calls).toHaveLength(0);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('requires all Unix targets and independently gates Windows without guessing architecture', async () => {
        const onlyMac = create({ installation: syntheticProbeInstallation(['darwin-arm64']) });
        expect(get(onlyMac, 'pairing-open').attributes('disabled')).toBeDefined();
        const windows = create({ installation: syntheticProbeInstallation(['windows-amd64']) });
        await get(windows, 'pairing-open').trigger('click');
        expect(get(windows, 'pairing-start').attributes('disabled')).toBeDefined();
        await get(windows, 'pairing-start').trigger('click');
        expect(calls).toHaveLength(0);
        await get(windows, 'pairing-terminal').setValue('windows');
        expect(get(windows, 'pairing-start').attributes('disabled')).toBeUndefined();
        await get(windows, 'pairing-start').trigger('click');
        await flushPromises();
        expect(calls).toHaveLength(1);
        expect(get(windows, 'pairing-window-id').text()).toContain(windowId);
    });
    it('rechecks availability after the guide was opened, before any window POST', async () => {
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await wrapper.setProps({ installation: probeInstallationCapabilities(catalog) });
        expect(get(wrapper, 'pairing-start').attributes('disabled')).toBeDefined();
        await get(wrapper, 'pairing-start').trigger('click');
        expect(calls).toHaveLength(0);
    });
    it('preserves the synthetic window and keyboard focus on terminal changes without assuming a local executable', async () => {
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        const choice = get(wrapper, 'pairing-terminal');
        choice.element.focus();
        await choice.setValue('windows');
        expect(document.activeElement).toBe(choice.element);
        await choice.setValue('unix');
        expect(get(wrapper, 'pairing-window-id').text()).toContain(windowId);
        expect(calls).toHaveLength(1);
        expect(wrapper.html()).not.toMatch(
            /FIXTURE_PRIVATE_TOKEN|\.\\misub-probe-windows-amd64\.exe --pair|misub-probe --pair/
        );
        expect(get(wrapper, 'pairing-command').text()).toContain('/probe-v9.9.9/install.sh');
    });
    it('copies the complete native Windows setup command and keeps resume independent of the window', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText });
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-terminal').setValue('windows');
        await get(wrapper, 'pairing-copy-resume').trigger('click');
        await flushPromises();
        expect(writeText.mock.calls[0][0]).toContain(
            "@('--setup', '--resume', '--config', $environment.Config)"
        );
        expect(writeText.mock.calls[0][0]).not.toContain(windowId);
        expect(calls).toHaveLength(0);
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        await get(wrapper, 'pairing-copy-command').trigger('click');
        await flushPromises();
        expect(writeText.mock.calls[1][0]).toBe(
            get(wrapper, 'pairing-command').element.textContent
        );
        expect(writeText.mock.calls[1][0]).toContain("@('--setup', '--server'");
        expect(writeText.mock.calls[1][0]).not.toMatch(/install\.ps1|ExecutionPolicy|ScriptBlock/);
        expect(calls).toHaveLength(1);
    });
    it('offers manual full-command review if clipboard access is blocked', async () => {
        vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
            writeText: vi.fn().mockRejectedValue(new Error('PRIVATE_CLIPBOARD')),
        });
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-copy-resume').trigger('click');
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain(
            'copy the complete command manually'
        );
        expect(wrapper.text()).not.toContain('PRIVATE_CLIPBOARD');
        expect(calls).toHaveLength(0);
    });
    it.each([
        "https://bad'host.invalid",
        'https://user:password@misub.fixture.invalid',
        'https://misub.fixture.invalid/path',
        'http://misub.fixture.invalid',
    ])('requires a canonical safe HTTPS origin: %s', (value) => {
        origin = value;
        const wrapper = create();
        expect(get(wrapper, 'pairing-open').attributes('disabled')).toBeDefined();
        expect(calls).toHaveLength(0);
    });
});
