// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createDiagnosticRunner,
    readBoundedText,
} from '../../functions/services/diagnostics/runner.js';
import {
    SOURCES,
    emptyResult,
    validateReport,
} from '../../functions/services/diagnostics/contract.js';
import {
    handleNodeDiagnostics,
    handleDiagnosticsCapabilities,
} from '../../functions/modules/handlers/diagnostics-handler.js';

const id = 'fixture-request';
const source = (name) => SOURCES.find((s) => s.id === name);
const transport = (fetch) => ({ scope: 'node', requestId: id, fetch });
const response = (data, status = 200, headers) =>
    new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const request = (body = {}, options = {}) =>
    new Request('https://misub.example/api/nodes/diagnostics', {
        method: 'POST',
        headers: { Origin: 'https://misub.example' },
        body: JSON.stringify({
            node: 'ss://fixture-only@example.invalid:443',
            sources: ['ipify'],
            consent: true,
            ...body,
        }),
        ...options,
    });
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('isolated diagnostics runner', () => {
    it('keeps a pre-cancelled all-source report valid with unimplemented checkers', async () => {
        const controller = new AbortController();
        controller.abort();
        const start = Date.now();
        const report = await createDiagnosticRunner()({ requestId: id, signal: controller.signal });
        expect(() => validateReport(report, id, SOURCES, start)).not.toThrow();
    });
    it('never uses global fetch when no node-bound transport exists', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const report = await createDiagnosticRunner()({ requestId: id, sourceIds: ['ipify'] });
        expect(report.results[0]).toMatchObject({ status: 'unsupported', ip: null });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('keeps all sources and conflicts, with canonical IPv6 and nullable quality evidence', async () => {
        const run = createDiagnosticRunner();
        const start = Date.now();
        const report = await run({
            requestId: id,
            sourceIds: ['ipify', 'ip_sb', 'ippure', 'icanhazip'],
            transport: transport(async (url) => {
                if (url.includes('api64')) return response({ ip: '203.0.113.1' });
                if (url.includes('ip.sb'))
                    return response({ ip: '203.0.113.2', country_code: 'US', asn: 123 });
                if (url.includes('ippure'))
                    return response({
                        ip: '203.0.113.2',
                        countryCode: 'JP',
                        fraudScore: 0,
                        isResidential: false,
                    });
                return response('2001:db8:0:0:0:0:0:1\n');
            }),
        });
        const clean = validateReport(
            report,
            id,
            report.results.map((r) => source(r.source)),
            start
        );
        expect(clean.results[2]).toMatchObject({
            status: 'partial',
            riskScore: 0,
            isResidential: false,
            isBroadcast: null,
        });
        expect(clean.results[3].ip).toBe('2001:db8::1');
        expect(clean.conflicts).toEqual([
            { type: 'ip', family: 4, values: ['203.0.113.1', '203.0.113.2'] },
            { type: 'country', ip: '203.0.113.2', values: ['US', 'JP'] },
        ]);
    });
    it('does not treat normal HTTP status or HTML as successful unlock evidence', async () => {
        for (const [body, code, status] of [
            ['<html>Just a moment</html>', 200, 'challenge'],
            [{ error: { code: 'invalid_api_key' } }, 401, 'unknown'],
            ['Welcome', 200, 'unknown'],
            [{ error: { code: 'unsupported_country_region_territory' } }, 403, 'restricted'],
        ]) {
            const report = await createDiagnosticRunner()({
                requestId: id,
                sourceIds: ['openai'],
                transport: transport(async () => response(body, code)),
            });
            expect(report.results[0].status).toBe(status);
        }
    });
    it('honors 429 cooldown and does not retry, preserving Retry-After', async () => {
        const fetch = vi.fn(async () => response('limited', 429, { 'Retry-After': '120' }));
        const run = createDiagnosticRunner();
        const options = { requestId: id, sourceIds: ['ip_sb'], transport: transport(fetch) };
        const first = await run(options);
        const second = await run(options);
        expect(first.results[0]).toMatchObject({ status: 'rate_limited', retryAfterSeconds: 120 });
        expect(second.results[0].status).toBe('rate_limited');
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('only gives URLTest latency to the designated through-node 204 probe', async () => {
        const report = await createDiagnosticRunner()({
            requestId: id,
            sourceIds: ['latency', 'ipify'],
            transport: transport(async (url, init) => {
                expect(init.redirect).toBe('manual');
                expect(init.credentials).toBe('omit');
                return url.includes('gstatic')
                    ? new Response(null, { status: 204 })
                    : response({ ip: '203.0.113.1' });
            }),
        });
        expect(report.results[0]).toMatchObject({ status: 'ok', measurement: 'node_http_urltest' });
        expect(report.results[0].latencyMs).toBeGreaterThanOrEqual(0);
        expect(report.results[1].latencyMs).toBeNull();
    });
    it('rejects redirects, invalid IPs and oversized responses', async () => {
        for (const [make, error] of [
            [() => response('', 302, { Location: 'http://127.0.0.1/' }), 'redirect_rejected'],
            [() => response({ ip: 'evil.example' }), 'invalid_response'],
            [() => response('x'.repeat(17000)), 'response_too_large'],
        ]) {
            const report = await createDiagnosticRunner()({
                requestId: id,
                sourceIds: ['ipify'],
                transport: transport(async () => make()),
            });
            expect(report.results[0]).toMatchObject({ status: 'error', error, ip: null });
        }
    });
    it('does not request an unimplemented checker or IPinfo without existing credentials', async () => {
        const fetch = vi.fn();
        const report = await createDiagnosticRunner()({
            requestId: id,
            sourceIds: ['ipinfo', 'netflix'],
            transport: transport(fetch),
        });
        expect(report.results.map((r) => r.status)).toEqual(['not_configured', 'unsupported']);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('keeps concurrency at three, stable ordering and no same-runner overlap', async () => {
        let active = 0;
        let peak = 0;
        const pending = [];
        const run = createDiagnosticRunner();
        const options = {
            requestId: id,
            sourceIds: ['ipify', 'ip_sb', 'ifconfig', 'icanhazip'],
            transport: transport(
                () =>
                    new Promise((resolve) => {
                        active++;
                        peak = Math.max(peak, active);
                        pending.push(() => {
                            active--;
                            resolve(response('203.0.113.1'));
                        });
                    })
            ),
        };
        const result = run(options);
        await expect(run(options)).rejects.toThrow('rate_limited');
        expect(pending).toHaveLength(3);
        pending.shift()();
        await new Promise(setImmediate);
        while (pending.length) pending.shift()();
        expect((await result).results.map((r) => r.source)).toEqual(options.sourceIds);
        expect(peak).toBe(3);
    });
    it('times out stalled body reads and propagates cancellation without leaked timers', async () => {
        vi.useFakeTimers();
        let signal;
        const run = createDiagnosticRunner();
        const result = run({
            requestId: id,
            sourceIds: ['ipify'],
            transport: transport(async (_, init) => {
                signal = init.signal;
                return new Response(new ReadableStream({ start() {} }));
            }),
        });
        await vi.advanceTimersByTimeAsync(5001);
        expect((await result).results[0].status).toBe('timeout');
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        const controller = new AbortController();
        controller.abort();
        const fetch = vi.fn();
        const cancelled = await createDiagnosticRunner()({
            requestId: id,
            sourceIds: ['ipify'],
            transport: transport(fetch),
            signal: controller.signal,
        });
        expect(cancelled.results[0].status).toBe('cancelled');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('trusted executor boundary', () => {
    it('times out and cancels stalled input before contacting the executor', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const fetch = vi.fn();
        const req = new Request('https://misub.example/api/nodes/diagnostics', {
            method: 'POST',
            headers: { Origin: 'https://misub.example' },
            body: new ReadableStream({ cancel }),
            duplex: 'half',
        });
        const result = handleNodeDiagnostics(req, { NODE_DIAGNOSTICS: { fetch } });
        await vi.advanceTimersByTimeAsync(5001);
        expect((await result).status).toBe(408);
        expect(cancel).toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('defaults to unsupported with no network, storage or secret exposure', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect(
            await (
                await handleDiagnosticsCapabilities(new Request('https://misub.example'), {})
            ).json()
        ).toMatchObject({ executorConfigured: false });
        const result = await handleNodeDiagnostics(request(), {});
        expect(result.headers.get('cache-control')).toBe('no-store');
        expect(await result.json()).toMatchObject({
            scope: 'none',
            results: [{ status: 'unsupported', error: 'executor_unavailable' }],
        });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects missing consent, cross-origin, external targets and large input before calling a binding', async () => {
        const fetch = vi.fn();
        const env = { NODE_DIAGNOSTICS: { fetch } };
        for (const req of [
            request({ consent: false }),
            request({}, { headers: { Origin: 'https://evil.example' } }),
            request({ executorUrl: 'http://127.0.0.1' }),
            request({ node: 'x'.repeat(17000) }),
            request({ sources: ['ipify', 'ipify'] }),
        ]) {
            expect((await handleNodeDiagnostics(req, env)).status).toBeGreaterThanOrEqual(400);
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('binds reports to this request, projects typed fields, and limits repeated runs', async () => {
        const env = {
            NODE_DIAGNOSTICS: {
                fetch: vi.fn(async (req) => {
                    expect(req.url).toBe('https://diagnostics.internal/v1/check');
                    const body = await req.json();
                    return response({
                        version: 1,
                        scope: 'node',
                        requestId: body.requestId,
                        results: [
                            {
                                ...emptyResult(source('ipify'), 'ok', null),
                                ip: '203.0.113.1',
                                family: 4,
                                secret: body.node,
                            },
                        ],
                    });
                }),
            },
        };
        const result = await handleNodeDiagnostics(request(), env);
        const body = await result.json();
        expect(result.status).toBe(200);
        expect(JSON.stringify(body)).not.toContain('fixture-only');
        expect(body.results[0]).not.toHaveProperty('secret');
        expect((await handleNodeDiagnostics(request(), env)).status).toBe(429);
    });
    it('rejects stale, mismatched, duplicate and fake unlock evidence', () => {
        const r = { ...emptyResult(source('ipify'), 'ok', null), ip: '203.0.113.1', family: 4 };
        const report = { version: 1, scope: 'node', requestId: id, results: [r] };
        for (const change of [
            { requestId: 'other' },
            { scope: 'server' },
            { results: [r, r] },
            { results: [{ ...r, checkedAt: '2000-01-01T00:00:00Z' }] },
            { results: [{ ...r, error: 'ss://password@example.invalid' }] },
        ])
            expect(() =>
                validateReport({ ...report, ...change }, id, [source('ipify')], Date.now())
            ).toThrow();
        expect(() =>
            validateReport(
                { ...report, results: [emptyResult(source('openai'), 'ok', null)] },
                id,
                [source('openai')],
                Date.now()
            )
        ).toThrow();
    });
    it('does not leak executor exception messages', async () => {
        const result = await handleNodeDiagnostics(request(), {
            NODE_DIAGNOSTICS: {
                fetch: async () => {
                    throw new Error('password=secret');
                },
            },
        });
        expect(result.status).toBe(502);
        expect(await result.text()).not.toContain('secret');
    });
    it('rejects contradictory states and coerced country fields', () => {
        const quality = {
            ...emptyResult(source('ippure'), 'ok', null),
            ip: '203.0.113.1',
            family: 4,
            riskScore: 0,
            isResidential: false,
            isBroadcast: false,
        };
        for (const patch of [
            { countryCode: ['US'] },
            { error: 'network_error' },
            { riskScore: null },
            { status: 'timeout' },
            { checkedAt: [new Date().toISOString()] },
        ]) {
            expect(() =>
                validateReport(
                    {
                        version: 1,
                        requestId: id,
                        scope: 'node',
                        results: [{ ...quality, ...patch }],
                    },
                    id,
                    [source('ippure')],
                    Date.now()
                )
            ).toThrow('invalid_report');
        }
    });
    it('bounds response streams', async () => {
        await expect(readBoundedText(response('x'.repeat(101)), 100)).rejects.toThrow(
            'response_too_large'
        );
    });
});
