/** HTTP aliases for the authenticated canonical subscription sync runner. */
import {
    authorizeCronRequest,
    cronErrorResponse,
    cronSyncConfig,
    performSubscriptionSync,
} from './_schedule.js';
import { createJsonResponse } from './modules/utils.js';

export async function onRequest({ request, env }) {
    try {
        const denied = await authorizeCronRequest(request, env);
        if (denied) return denied;
        const cronType = request.headers.get('CF-Cron-Type') || 'default';
        if (
            !['default', 'hourly-subscription-sync', 'daily-full-sync', 'traffic-check'].includes(
                cronType
            )
        ) {
            return createJsonResponse({ success: false, error: 'Unknown cron type' }, 400);
        }
        const result = await performSubscriptionSync(env, cronSyncConfig(env), {
            checkTraffic: cronType === 'traffic-check',
        });
        return createJsonResponse({
            success: result.failedSyncs === 0,
            cronType,
            timestamp: new Date().toISOString(),
            ...result,
            ...(cronType === 'daily-full-sync'
                ? { type: 'full-sync', scope: 'bounded-subscription-refresh' }
                : {}),
            ...(result.trafficCheck || {}),
        });
    } catch (error) {
        return cronErrorResponse(error);
    }
}

export { scheduled } from './_schedule.js';
