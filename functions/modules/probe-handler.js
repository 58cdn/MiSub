import { authMiddleware } from './auth-middleware.js';
import { getExternalStorageAdapter } from './external-api-utils.js';
import { isManualNode } from './external-api-mappers.js';
import { urlToClashProxy } from '../utils/url-to-clash.js';
import { createProbeHandler } from '../services/probe-http.js';
import { createProbeNodePreparer } from '../services/probe-node.js';

export const handleProbeRequest = createProbeHandler({
    authorizeAdmin: authMiddleware,
    prepareNodes: createProbeNodePreparer(urlToClashProxy),
    async loadManualNodes(env) {
        const storage = await getExternalStorageAdapter(env);
        return (await storage.getAllSubscriptions()).filter(isManualNode);
    }
});
