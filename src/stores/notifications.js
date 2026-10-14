import { ref } from 'vue';
import { defineStore } from 'pinia';
import { useSecurityFeed } from '../composables/useSecurityFeed.js';

export const useNotificationsStore = defineStore('notifications', () => {
    const feed = useSecurityFeed();
    const opened = ref(false);
    function open() {
        opened.value = true;
        void feed.latest();
    }
    function reset() {
        opened.value = false;
        feed.reset();
    }
    return { ...feed, opened, open, reset };
});
