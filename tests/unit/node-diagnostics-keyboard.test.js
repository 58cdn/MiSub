import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import NodeDiagnosticsButton from '../../src/components/nodes/NodeDiagnosticsButton.vue';
import Modal from '../../src/components/forms/Modal.vue';
import { setLocale } from '../../src/i18n/index.js';
beforeEach(() =>
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(JSON.stringify({ success: true, data: { storageReady: false } }))
        )
    )
);
let wrapper;
afterEach(() => {
    wrapper?.unmount();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});
it('moves and traps focus on first open, closes with Escape and restores the trigger', async () => {
    setLocale('en-US');
    wrapper = mount(NodeDiagnosticsButton, {
        attachTo: document.body,
        props: { node: { name: 'Fixture', url: 'ss://fixture@example.invalid:443' } },
    });
    const trigger = wrapper.get('button');
    trigger.element.focus();
    await trigger.trigger('click');
    await flushPromises();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = [...dialog.querySelectorAll('button:not([disabled])')];
    buttons.at(-1).focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
});
it('excludes the inactive preview subtree from the modal focus trap', async () => {
    wrapper = mount(Modal, {
        attachTo: document.body,
        props: { show: false },
        slots: {
            body: '<button id="visible-panel">Visible</button>',
            footer: '<button id="last-visible">Last</button><div inert><button id="inactive-preview">Hidden preview</button></div>',
        },
    });
    await wrapper.setProps({ show: true });
    await flushPromises();
    document.getElementById('visible-panel').focus();
    window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    );
    expect(document.activeElement.id).toBe('last-visible');
});
