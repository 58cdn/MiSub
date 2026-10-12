import { t } from '@/i18n/index.js';

// Browser HTTP observation only. A browser fetch cannot measure TCP RTT, verify
// a proxy protocol, or establish the node's exit IP. Keep this separate from the
// trusted executor's node_http_urltest measurement.
export async function pingNode(host, port, timeoutMs = 3000) {
    if (
        !host ||
        !/^[a-zA-Z0-9.:[\]-]+$/.test(host) ||
        !Number.isInteger(Number(port)) ||
        Number(port) < 1 ||
        Number(port) > 65535
    ) {
        return { status: 'error', latency: -1, message: t('utils.invalidAddressOrPort') };
    }
    const limit = Number.isFinite(timeoutMs) ? Math.min(30000, Math.max(100, timeoutMs)) : 3000;
    const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const controller = new AbortController();
    const started = performance.now();
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
            resolve({ status: 'timeout', latency: -1, measurement: 'browser_http' });
            controller.abort();
        }, limit);
    });
    try {
        const observation = fetch(`${protocol}//${hostname}:${port}/__ping_${Date.now()}`, {
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
        })
            .then(() => ({
                status: 'ok',
                latency: Math.round(performance.now() - started),
                measurement: 'browser_http',
                message: t('manualNodes.latencyHint'),
            }))
            .catch(() => ({
                status: 'error',
                latency: -1,
                measurement: 'browser_http',
                message: t('manualNodes.connectivityFailed'),
            }));
        return await Promise.race([observation, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}
