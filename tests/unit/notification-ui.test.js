import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createI18n } from '../../src/i18n/index.js';
import SecurityFeed from '../../src/components/notifications/SecurityFeed.vue';
import Login from '../../src/components/modals/Login.vue';

const globals = {
    plugins: [createI18n({ initialLocale: 'en-US' })],
    stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
};
const wrappers = [];
const render = (component, props) => {
    const wrapper = mount(component, { props, global: globals });
    wrappers.push(wrapper);
    return wrapper;
};
const feed = (extra = {}) =>
    reactive({
        items: [],
        enabled: true,
        error: '',
        loading: false,
        saving: false,
        unreadCount: 0,
        page: 0,
        nextCursor: null,
        markRead: vi.fn(),
        refresh: vi.fn(),
        latest: vi.fn(),
        previous: vi.fn(),
        next: vi.fn(),
        ...extra,
    });
afterEach(() => {
    wrappers.splice(0).forEach((w) => w.unmount());
    vi.useRealTimers();
});

describe('notification rendering', () => {
    it.each([
        [{}, 'No system messages yet'],
        [{ enabled: false }, 'Login security is not enabled'],
        [{ error: 'forbidden' }, 'Your session expired'],
        [{ error: 'unavailable' }, 'server supports'],
        [{ error: 'error' }, 'Check your connection'],
        [{ loading: true }, 'Loading notifications'],
    ])('renders an explicit state in English', (values, expected) => {
        const wrapper = render(SecurityFeed, { feed: feed(values) });
        expect(wrapper.text()).toContain(expected);
        expect(wrapper.text()).not.toMatch(/[\u4e00-\u9fff]|notifications\./);
    });
    it('escapes event content and rejects attacker-controlled routes', () => {
        const wrapper = render(SecurityFeed, {
            feed: feed({
                items: [
                    {
                        id: 1,
                        type: 'login_success',
                        ip: '<img src=x onerror=alert(1)>',
                        browser: '<script>bad()</script>',
                        target: 'javascript:alert(1)',
                    },
                ],
            }),
        });
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.find('script').exists()).toBe(false);
        expect(wrapper.text()).toContain('<img src=x');
        expect(wrapper.find('a').exists()).toBe(false);
    });
    it('does not mark events read on display or navigation', async () => {
        const value = feed({
            items: [
                { id: 1, type: 'login_success', readAt: null, target: 'security' },
                { id: 2, type: 'login_warning', readAt: 3 },
            ],
            unreadCount: 1,
        });
        const wrapper = render(SecurityFeed, { feed: value });
        await wrapper.get('a').trigger('click');
        expect(value.markRead).not.toHaveBeenCalled();
        await wrapper
            .findAll('button')
            .find((b) => b.text() === 'Mark this page as read')
            .trigger('click');
        expect(value.markRead).toHaveBeenCalledWith([1]);
    });
    it('keeps audit read-only', () => {
        const wrapper = render(SecurityFeed, {
            feed: feed({ items: [{ id: 1, type: 'login_success' }] }),
            audit: true,
        });
        expect(wrapper.text()).not.toContain('Mark as read');
        expect(wrapper.text()).not.toContain('Unread');
    });
});

describe('login lockout feedback', () => {
    it('preserves server lockout metadata, blocks resubmission and reenables after the wait', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        const login = vi
            .fn()
            .mockRejectedValue({ status: 429, data: { code: 'login_locked', retryAfter: 2 } });
        const wrapper = render(Login, { login });
        await wrapper.get('input').setValue('fixture-password');
        await wrapper.get('form').trigger('submit');
        await flushPromises();
        expect(wrapper.get('#login-locked').text()).toContain('2 seconds');
        expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined();
        await wrapper.get('form').trigger('submit');
        expect(login).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(wrapper.find('#login-locked').exists()).toBe(false);
        expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeUndefined();
        expect(login).toHaveBeenCalledTimes(1);
    });
    it('gives a localized service error with an accessible field association', async () => {
        const wrapper = render(Login, {
            login: vi.fn().mockRejectedValue({ status: 503, message: 'raw backend error' }),
        });
        await wrapper.get('input').setValue('fixture-password');
        await wrapper.get('form').trigger('submit');
        await flushPromises();
        expect(wrapper.get('[role=alert]').text()).toContain(
            'login security service is unavailable'
        );
        expect(wrapper.get('input').attributes('aria-describedby')).toBe('login-error');
    });
});
