import { connect } from 'cloudflare:sockets';
import { authMiddleware } from '../../modules/auth-middleware.js';
import { getExternalStorageAdapter } from '../../modules/external-api-utils.js';
import { isManualNode } from '../../modules/external-api-mappers.js';
import { urlToClashProxy } from '../../utils/url-to-clash.js';
import { createProbeNodePreparer } from '../../services/probe-node.js';
import { createConnectivityHandler } from '../../services/node-connectivity.js';

const handle = createConnectivityHandler({
    authorizeAdmin: authMiddleware,
    prepareNodes: createProbeNodePreparer(urlToClashProxy),
    connect,
    async loadManualNodes(env) {
        const storage = await getExternalStorageAdapter(env);
        return (await storage.getAllSubscriptions()).filter(isManualNode);
    },
});

// This specific Pages route owns admin authentication and the same-origin check.
export function onRequest({ request, env }) {
    return handle(request, env);
}
