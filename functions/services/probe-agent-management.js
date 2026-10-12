import { requireValue } from './probe-contract.js';

export const AGENT_STATUSES = ['all', 'online', 'offline', 'unknown', 'revoked'];
export const AGENT_VISIBILITIES = ['visible', 'hidden', 'all'];
export const AGENT_SORTS = ['createdAt', 'name', 'status', 'lastSeen', 'lastTaskAt', 'lastResultAt', 'version'];

export function agentManagementFilters(input = {}) {
    const { q = '', status = 'all', visibility = 'visible', sort = 'createdAt', direction = 'desc' } = input;
    requireValue(typeof q === 'string' && q.length <= 80 && !/[\x00-\x1f\x7f]/.test(q), 'invalid_query');
    requireValue(AGENT_STATUSES.includes(status), 'invalid_status');
    requireValue(AGENT_VISIBILITIES.includes(visibility), 'invalid_visibility');
    requireValue(AGENT_SORTS.includes(sort), 'invalid_sort');
    requireValue(['asc', 'desc'].includes(direction), 'invalid_direction');
    return { q: q.trim(), status, visibility, sort, direction };
}

export function agentManagementQuery(params) {
    const allowed = new Set(['offset', 'limit', 'q', 'status', 'visibility', 'sort', 'direction']);
    const input = {};
    for (const [key, value] of params) {
        requireValue(allowed.has(key) && params.getAll(key).length === 1, 'invalid_query');
        if (key !== 'offset' && key !== 'limit') input[key] = value;
    }
    return agentManagementFilters(input);
}

export function agentActionConfirmation(body) {
    requireValue(body && Object.keys(body).length === 1 && body.confirmed === true, 'confirmation_required');
}
