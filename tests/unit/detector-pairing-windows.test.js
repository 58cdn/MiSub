import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DetectorPairingWizard from '../../src/components/settings/sections/DetectorPairingWizard.vue';
import { setLocale } from '../../src/i18n/index.js';

const site = 'https://misub.fixture.invalid';
const windowId = '11111111-1111-4111-8111-111111111111';
let wrappers, calls, origin, now;
const get = (wrapper, id) => wrapper.get(`[data-testid="${id}"]`);
const create = () => {
    const wrapper = mount(DetectorPairingWizard, {
        props: { enabled: true },
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
            expect(JSON.parse(options.body)).toEqual({});
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
                        deviceCode: 'FIXTURE_DEVICE_SECRET',
                        proof: 'FIXTURE_PROOF',
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

describe('explicit pairing command terminal', () => {
    it('defaults to Linux/macOS even on a Windows browser and switches without network or storage writes', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
        const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
        vi.stubGlobal('localStorage', storage);
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        expect(get(wrapper, 'pairing-terminal').element.value).toBe('unix');
        expect(wrapper.get('label[for="pairing-terminal"]').text()).toBe('Command terminal');
        await get(wrapper, 'pairing-terminal').setValue('windows');
        expect(calls).toHaveLength(0);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="pairing-command"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('Installation packages await release verification');
        expect(wrapper.text()).toContain('0.1.0 release does not support this flow');
    });
    it('renders the verified PowerShell executable and private LOCALAPPDATA path using only public association values', async () => {
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-terminal').setValue('windows');
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        expect(get(wrapper, 'pairing-command').text()).toBe(
            `.\\misub-probe-windows-amd64.exe --pair --server '${site}' --pair-window '${windowId}' --config "$env:LOCALAPPDATA\\MiSubProbe\\probe.json"`
        );
        expect(wrapper.text()).toContain('matching Windows amd64 build with pairing support');
        expect(wrapper.text()).toContain('Open PowerShell in the executable’s directory');
        expect(wrapper.text()).toContain('existing files are not overwritten');
        expect(wrapper.html()).not.toMatch(
            /FIXTURE_PRIVATE_TOKEN|FIXTURE_DEVICE_SECRET|FIXTURE_PROOF|--install|--service|--token/
        );
        expect(wrapper.findAll('a[download]')).toHaveLength(0);
        expect(calls).toHaveLength(1);
    });
    it('preserves the window and keyboard focus while changing command shells after creation', async () => {
        const wrapper = create();
        await get(wrapper, 'pairing-open').trigger('click');
        await get(wrapper, 'pairing-start').trigger('click');
        await flushPromises();
        const choice = get(wrapper, 'pairing-terminal');
        choice.element.focus();
        await choice.setValue('windows');
        expect(document.activeElement).toBe(choice.element);
        expect(get(wrapper, 'pairing-command').text()).toContain('misub-probe-windows-amd64.exe');
        await choice.setValue('unix');
        expect(get(wrapper, 'pairing-command').text()).toBe(
            `misub-probe --pair --server '${site}' --pair-window '${windowId}' --config "$HOME/.misub-probe/probe.json"`
        );
        expect(calls).toHaveLength(1);
        expect(get(wrapper, 'pairing-status').text()).toContain('Waiting for a client code');
    });
    it.each([
        "https://bad'host.invalid",
        'https://user:password@misub.fixture.invalid',
        'https://misub.fixture.invalid/path',
        'http://misub.fixture.invalid',
    ])(
        'does not generate shell commands for unsafe or non-origin site values: %s',
        async (value) => {
            origin = value;
            const wrapper = create();
            expect(get(wrapper, 'pairing-open').attributes('disabled')).toBeDefined();
            expect(wrapper.find('[data-testid="pairing-command"]').exists()).toBe(false);
            expect(calls).toHaveLength(0);
        }
    );
    it.each(['https://misub.fixture.invalid:8443', 'https://[::1]:8443'])(
        'supports a validated HTTPS origin with an explicit port: %s',
        async (value) => {
            origin = value;
            const wrapper = create();
            await get(wrapper, 'pairing-open').trigger('click');
            await get(wrapper, 'pairing-terminal').setValue('windows');
            await get(wrapper, 'pairing-start').trigger('click');
            await flushPromises();
            expect(get(wrapper, 'pairing-command').text()).toContain(`--server '${value}'`);
        }
    );
});
