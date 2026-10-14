/** Authenticated HTTP scheduling entry and platform-event sync function. */
import { StorageFactory } from './storage-adapter.js';
import { authMiddleware } from './modules/auth-middleware.js';
import { KV_KEY_SETTINGS, DEFAULT_SETTINGS } from './modules/config.js';
import { createJsonResponse } from './modules/utils.js';
import { getProtocolError } from './services/subscription-protocol/index.js';
import { runCanonicalSubscriptionSync } from './modules/notifications.js';

export async function authorizeCronRequest(request, env) {
    if (!['GET', 'POST'].includes(request.method)) {
        return createJsonResponse({ error: 'Method Not Allowed' }, 405, { Allow: 'GET, POST' });
    }
    if (
        request.method === 'POST' &&
        request.headers.has('Cookie') &&
        (await authMiddleware(request, env))
    ) {
        return null;
    }
    const storage = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    const settings = await storage.get(KV_KEY_SETTINGS);
    const secret = settings?.cronSecret;
    if (
        typeof secret === 'string' &&
        secret.length > 0 &&
        (request.headers.get('Authorization') === 'Bearer ' + secret ||
            new URL(request.url).searchParams.get('secret') === secret)
    )
        return null;
    return createJsonResponse({ error: 'Unauthorized' }, 401);
}

export function cronErrorResponse(error) {
    if (error?.code) {
        const failure = getProtocolError(error);
        return createJsonResponse({ success: false, error: failure.code }, failure.status);
    }
    return createJsonResponse(
        { success: false, error: error?.status === 400 ? 'invalid_sync_config' : 'sync_failed' },
        error?.status === 400 ? 400 : 503
    );
}

export function cronSyncConfig(env) {
    return {
        maxSyncCount: env.CRON_MAX_SYNC_COUNT === undefined ? 50 : Number(env.CRON_MAX_SYNC_COUNT),
        timeout: env.CRON_SYNC_TIMEOUT === undefined ? 30000 : Number(env.CRON_SYNC_TIMEOUT),
        concurrency: env.CRON_ENABLE_PARALLEL === 'false' ? 1 : 5,
    };
}

export async function onRequest({ request, env }) {
    try {
        const denied = await authorizeCronRequest(request, env);
        if (denied) return denied;
        return createJsonResponse({
            timestamp: new Date().toISOString(),
            subscriptionSync: await performSubscriptionSync(env, cronSyncConfig(env)),
        });
    } catch (error) {
        return cronErrorResponse(error);
    }
}

export async function performSubscriptionSync(env, config = {}, options = {}) {
    if (env.ENABLE_CRON === 'false') {
        const error = new Error('Cron functionality is disabled');
        error.status = 400;
        throw error;
    }
    const storage = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    const settings = options.checkTraffic
        ? (await storage.get(KV_KEY_SETTINGS)) || DEFAULT_SETTINGS
        : null;
    const result = await runCanonicalSubscriptionSync(storage, env, config);
    const traffic = [];
    if (settings) {
        const threshold =
            Number(settings.NotifyThresholdPercent) || DEFAULT_SETTINGS.NotifyThresholdPercent;
        for (const { sub } of result.applied) {
            const { upload, download, total } = sub.userInfo || {};
            if (
                ![upload, download, total].every(Number.isFinite) ||
                upload < 0 ||
                download < 0 ||
                total <= 0
            )
                continue;
            const usagePercent = Math.round(((upload + download) / total) * 100);
            traffic.push({
                id: sub.id,
                name: sub.name,
                usagePercent,
                warning: usagePercent >= threshold,
            });
        }
    }
    return {
        timestamp: new Date().toISOString(),
        totalSubscriptions: result.subscriptions.length,
        successfulSyncs: result.applied.length,
        failedSyncs: result.failures.length,
        details: result.details,
        config: result.config,
        ...(settings
            ? {
                  trafficCheck: {
                      checkedSubscriptions: traffic.length,
                      unavailableSubscriptions: result.subscriptions.length - traffic.length,
                      warnings: traffic.filter((item) => item.warning).length,
                      details: traffic,
                  },
              }
            : {}),
    };
}

/** Platform events call this function directly; an HTTP header never establishes this trust. */
export async function scheduled(_event, env, context) {
    const task = performSubscriptionSync(env, cronSyncConfig(env));
    if (typeof context?.waitUntil === 'function') context.waitUntil(task);
    return task;
}
