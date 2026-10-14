import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import Login from '../../src/components/modals/Login.vue';

describe('unconfirmed logout recovery UI', () => {
    it('offers retry without claiming the browser is signed out', async () => {
        const retryLogout = vi.fn().mockResolvedValue(false);
        const wrapper = mount(Login, {
            props: { logoutPending: true, retryLogout, login: vi.fn() },
        });
        const alert = wrapper.get('[role="alert"]');
        expect(alert.text()).toMatch(/退出尚未确认|Logout is not yet confirmed/);
        await alert.get('button').trigger('click');
        expect(retryLogout).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[role="alert"]').exists()).toBe(true);
        wrapper.unmount();
    });
    it('hides recovery controls only after the caller clears pending state', async () => {
        const wrapper = mount(Login, {
            props: { logoutPending: true, retryLogout: vi.fn().mockResolvedValue(true) },
        });
        await wrapper.get('[role="alert"] button').trigger('click');
        expect(wrapper.find('[role="alert"]').exists()).toBe(true);
        await wrapper.setProps({ logoutPending: false });
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
