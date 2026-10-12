import { isIP } from 'node:net';
import { SOURCES, PROBE_VERSION, canonicalIP, emptyResult, selectSources } from './contract.js';

const MAX_BODY = 16384;
const TIMEOUT = 5000;

export async function readBoundedText(response, maxBytes = MAX_BODY, signal) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    const onAbort = () => {
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        while (true) {
            if (signal?.aborted) throw new Error('cancelled');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new Error('cancelled');
            if (done) return text + decoder.decode();
            size += value.byteLength;
            if (size > maxBytes) throw new Error('response_too_large');
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function parseResult(source, text, status) {
    const result = emptyResult(source, 'unknown', 'no_availability_evidence');
    result.httpStatus = status;
    if (/cf-chl-|cf-mitigated|just a moment|captcha|challenge-platform/i.test(text))
        return { ...result, status: 'challenge', error: 'challenge' };
    if (source.kind === 'unlock') {
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            return result;
        }
        if (status === 403 && body?.error?.code === 'unsupported_country_region_territory')
            return { ...result, status: 'restricted', error: 'unsupported_country' };
        return result;
    }
    if (status < 200 || status >= 300) return { ...result, status: 'error', error: 'http_error' };
    if (source.kind === 'latency') {
        if (status !== 204) return { ...result, status: 'error', error: 'invalid_response' };
        return { ...result, status: 'ok', error: null, measurement: 'node_http_urltest' };
    }
    let body;
    if (['ifconfig', 'icanhazip'].includes(source.id)) body = { ip: text.trim() };
    else {
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error('invalid_response');
        }
    }
    const ip = canonicalIP(body?.ip);
    if (!ip) throw new Error('invalid_response');
    const country = source.id === 'ippure' ? body.countryCode : body.country_code;
    let asn = body.asn;
    if (typeof asn === 'string' && /^AS\d+$/.test(asn)) asn = Number(asn.slice(2));
    const countryCode =
        typeof country === 'string' && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
    const output = {
        ...result,
        status: 'ok',
        error: null,
        ip,
        family: isIP(ip),
        countryCode,
        asn: Number.isSafeInteger(asn) && asn >= 0 && asn <= 4294967295 ? asn : null,
    };
    if (source.kind === 'quality') {
        output.riskScore =
            typeof body.fraudScore === 'number' &&
            Number.isFinite(body.fraudScore) &&
            body.fraudScore >= 0 &&
            body.fraudScore <= 100
                ? body.fraudScore
                : null;
        output.isResidential = typeof body.isResidential === 'boolean' ? body.isResidential : null;
        output.isBroadcast = typeof body.isBroadcast === 'boolean' ? body.isBroadcast : null;
        if ([output.riskScore, output.isResidential, output.isBroadcast].some((v) => v === null))
            output.status = 'partial';
    }
    return output;
}

// This module deliberately has no global fetch fallback. A separately deployed,
// trusted proxy adapter must enforce node routing, DNS/IP policy, TLS and quotas.
// Reuse one runner per executor to share its bounded concurrency and cooldowns.
export function createDiagnosticRunner() {
    let running = false;
    const cooldowns = new Map();
    return async function run({
        requestId,
        sourceIds = SOURCES.map((s) => s.id),
        transport,
        signal,
        ipinfoToken,
    }) {
        const sources = selectSources(sourceIds);
        if (running) throw new Error('rate_limited');
        running = true;
        const results = new Array(sources.length);
        let cursor = 0;
        try {
            async function probe(source) {
                const started = performance.now();
                if (!source.url)
                    return emptyResult(source, 'unsupported', 'checker_not_implemented');
                if (signal?.aborted) return emptyResult(source, 'cancelled', 'cancelled');
                if (
                    transport?.scope !== 'node' ||
                    transport?.requestId !== requestId ||
                    typeof transport.fetch !== 'function'
                )
                    return emptyResult(source, 'unsupported', 'transport_unavailable');
                if (source.id === 'ipinfo' && !ipinfoToken)
                    return emptyResult(source, 'not_configured', 'token_required');
                const remaining = (cooldowns.get(source.id) || 0) - Date.now();
                if (remaining > 0)
                    return {
                        ...emptyResult(source, 'rate_limited', 'rate_limited'),
                        retryAfterSeconds: Math.ceil(remaining / 1000),
                    };
                // One request per source per minute is deliberately below IP.SB's limit.
                cooldowns.set(source.id, Date.now() + 60000);
                const controller = new AbortController();
                let timer;
                let rejectStop;
                const stopped = new Promise((_, reject) => {
                    rejectStop = reject;
                });
                const stop = (reason) => {
                    controller.abort();
                    rejectStop(new Error(reason));
                };
                const onAbort = () => stop('cancelled');
                signal?.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => stop('timeout'), TIMEOUT);
                try {
                    const operation = (async () => {
                        const headers = {
                            'User-Agent': 'MiSub-Diagnostics/1.0',
                            Accept: 'application/json, text/plain',
                        };
                        if (source.id === 'ipinfo') headers.Authorization = `Bearer ${ipinfoToken}`;
                        const response = await transport.fetch(source.url, {
                            method: 'GET',
                            headers,
                            signal: controller.signal,
                            redirect: 'manual',
                            credentials: 'omit',
                            cache: 'no-store',
                        });
                        if (controller.signal.aborted) {
                            await response.body?.cancel();
                            throw new Error('cancelled');
                        }
                        if (
                            response.redirected ||
                            (response.status >= 300 && response.status < 400)
                        ) {
                            await response.body?.cancel();
                            throw new Error('redirect_rejected');
                        }
                        if (response.status === 429) {
                            const header = response.headers.get('Retry-After');
                            const seconds = /^\d+$/.test(header || '')
                                ? Number(header)
                                : Math.ceil((Date.parse(header) - Date.now()) / 1000);
                            const retryAfterSeconds = Math.min(
                                86400,
                                Math.max(60, Number.isFinite(seconds) ? seconds : 60)
                            );
                            cooldowns.set(source.id, Date.now() + retryAfterSeconds * 1000);
                            await response.body?.cancel();
                            return {
                                ...emptyResult(source, 'rate_limited', 'rate_limited'),
                                httpStatus: 429,
                                retryAfterSeconds,
                            };
                        }
                        const text = await readBoundedText(response, MAX_BODY, controller.signal);
                        const result = parseResult(source, text, response.status);
                        if (source.kind === 'latency' && result.status === 'ok')
                            result.latencyMs = Math.round(performance.now() - started);
                        return result;
                    })();
                    return await Promise.race([operation, stopped]);
                } catch (error) {
                    const code = [
                        'timeout',
                        'cancelled',
                        'redirect_rejected',
                        'response_too_large',
                        'invalid_response',
                    ].includes(error.message)
                        ? error.message
                        : 'network_error';
                    return emptyResult(
                        source,
                        ['timeout', 'cancelled'].includes(code) ? code : 'error',
                        code
                    );
                } finally {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                }
            }
            async function worker() {
                while (cursor < sources.length) {
                    const index = cursor++;
                    const started = performance.now();
                    results[index] = await probe(sources[index]);
                    results[index].durationMs = Math.round(performance.now() - started);
                    results[index].checkedAt = new Date().toISOString();
                }
            }
            await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker));
            return { version: 1, requestId, scope: 'node', probeVersion: PROBE_VERSION, results };
        } finally {
            running = false;
        }
    };
}
