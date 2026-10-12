import { handleProbeRequest } from '../../modules/probe-handler.js';
// This more-specific Pages route owns its authentication and same-origin checks.
export function onRequest({ request, env }) {
    return handleProbeRequest(request, env);
}
