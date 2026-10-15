import { createJsonResponse, createErrorResponse } from '../utils.js';
import { StorageFactory, STORAGE_TYPES } from '../../storage-adapter.js';
import { selectTestRelease } from '../../../src/shared/product-version.js';

// This endpoint exposes this fork's alpha release notes. Stable recommendation is unavailable.
export async function handleGithubReleaseRequest(request, env) {
    const url = new URL(request.url);
    const repo = url.searchParams.get('repo');
    const component = url.searchParams.get('component') || 'app';
    const channel = url.searchParams.get('channel') || 'alpha';
    if (
        repo !== '58cdn/MiSub' ||
        !['app', 'probe'].includes(component) ||
        !['alpha', 'stable'].includes(channel)
    )
        return createErrorResponse('Invalid release channel or repository', 400);
    if (channel === 'stable')
        return createJsonResponse({
            tag_name: null,
            channel,
            reason: 'stable_channel_unavailable',
        });
    const cacheKey = `github_release_v2_${repo}_${component}_${channel}`;
    const ttl = 3600 * 1000;
    try {
        const storage = StorageFactory.createAdapter(env, STORAGE_TYPES.KV);
        const cached = await storage.get(cacheKey);
        if (
            cached?.timestamp &&
            Date.now() - cached.timestamp >= 0 &&
            Date.now() - cached.timestamp < ttl
        )
            return createJsonResponse(cached.data, 200, { 'X-Cache-Status': 'HIT' });
        const releases = [];
        for (let page = 1; page <= 20; page++) {
            const response = await fetch(
                `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
                {
                    headers: {
                        'User-Agent': 'MiSub-Proxy/1.0',
                        Accept: 'application/vnd.github+json',
                    },
                }
            );
            if ([403, 429].includes(response.status))
                return createJsonResponse({ tag_name: null, channel, rate_limited: true }, 200, {
                    'Cache-Control': 'no-store',
                });
            if (response.status === 404)
                return createJsonResponse({ tag_name: null, channel, not_found: true });
            if (!response.ok) return createErrorResponse('Release lookup failed', 502);
            const entries = await response.json();
            if (!Array.isArray(entries))
                return createErrorResponse('Invalid release inventory', 502);
            releases.push(...entries);
            if (entries.length < 100) break;
            if (page === 20) return createErrorResponse('Incomplete release inventory', 502);
        }
        const release = selectTestRelease(releases, component);
        const data = release
            ? {
                  tag_name: release.tag_name,
                  html_url: `https://github.com/58cdn/MiSub/releases/tag/${release.tag_name}`,
                  published_at: release.published_at,
                  name: release.name,
                  body: release.body || '',
                  prerelease: true,
                  draft: false,
                  channel,
                  component,
              }
            : { tag_name: null, channel, component, reason: 'no_test_release' };
        await storage.put(cacheKey, { data, timestamp: Date.now() });
        return createJsonResponse(data, 200, {
            'X-Cache-Status': 'MISS',
            'Cache-Control': 'public, max-age=3600',
        });
    } catch {
        return createErrorResponse('Release lookup unavailable', 502);
    }
}
