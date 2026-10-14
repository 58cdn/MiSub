import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EditForm from '../../src/components/modals/SubscriptionEditModal/EditForm.vue';
import { fetchNodeCount } from '../../src/lib/api.js';
import { createI18n } from '../../src/i18n/index.js';

const { post, showToast } = vi.hoisted(() => ({ post: vi.fn(), showToast: vi.fn() }));
vi.mock('../../src/lib/http.js', () => ({
    api: { post },
    APIError: class APIError extends Error {},
}));
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));

describe('subscription proxy inspection intent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        post.mockResolvedValue({ success: true, data: { count: 3, userInfo: null } });
    });
    it('marks the proxy test as inspection only through the real form and API helper', async () => {
        const wrapper = mount(EditForm, {
            props: {
                editingSubscription: {
                    name: 'fixture',
                    url: 'https://example.invalid/sub',
                    fetchProxy: 'https://proxy.example.invalid/',
                    plusAsSpace: true,
                    customUserAgent: 'fixture-agent',
                },
            },
            global: { plugins: [createI18n({ initialLocale: 'en-US' })] },
        });
        try {
            await wrapper.findAll('button').at(-1).trigger('click');
            await flushPromises();
            expect(post).toHaveBeenCalledOnce();
            expect(post.mock.calls[0][0]).toBe('/api/node_count');
            expect(post.mock.calls[0][1]).toEqual({
                url: 'https://example.invalid/sub',
                fetchProxy: 'https://proxy.example.invalid/',
                plusAsSpace: true,
                userAgent: 'fixture-agent',
                inspectOnly: true,
            });
            expect(showToast.mock.calls[0][1]).toBe('success');
            expect(showToast.mock.calls[0][0]).toContain('3');
        } finally {
            wrapper.unmount();
        }
    });
    it('retains the legacy helper request without an explicit inspection option', async () => {
        const result = await fetchNodeCount('https://example.invalid/sub');
        expect(post.mock.calls[0][1]).toEqual({ url: 'https://example.invalid/sub' });
        expect(result).toEqual({ success: true, data: { count: 3, userInfo: null } });
    });
    it('continues to accept a legacy flat count response', async () => {
        post.mockResolvedValue({ count: 2, userInfo: null });
        expect(await fetchNodeCount('https://example.invalid/sub')).toEqual({
            success: true,
            data: { count: 2, userInfo: null },
        });
    });
});
