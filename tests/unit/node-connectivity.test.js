// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectivityHandler } from '../../functions/services/node-connectivity.js';
import { createProbeNodePreparer } from '../../functions/services/probe-node.js';
import { urlToClashProxy } from '../../functions/utils/url-to-clash.js';
import {
    isPublicConnectivityIp,
    resolveConnectivityTarget,
} from '../../functions/services/connectivity-target.js';

const ORIGIN = 'https://misub.example';
const secret = 'fixture-password-never-forward';
const node = { id: 'saved', url: `trojan://${secret}@example.com:443` };
const request = (body = { nodeId: 'saved' }, options = {}) =>
    new Request(`${ORIGIN}/api/nodes/connectivity`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...options,
    });
function fixture(overrides = {}) {
    const socket = {
        opened: Promise.resolve({ remoteAddress: '8.8.8.8' }),
        closed: Promise.resolve(),
        close: vi.fn().mockResolvedValue(),
        readable: { getReader: vi.fn() },
        writable: { getWriter: vi.fn() },
    };
    const deps = {
        authorizeAdmin: vi.fn().mockResolvedValue(true),
        loadManualNodes: vi.fn().mockResolvedValue([node]),
        prepareNodes: createProbeNodePreparer(urlToClashProxy),
        resolveTarget: vi.fn().mockResolvedValue('8.8.8.8'),
        connect: vi.fn().mockReturnValue(socket),
        ...overrides,
    };
    return { socket, ...deps, handle: createConnectivityHandler(deps) };
}
afterEach(() => vi.useRealTimers());

describe('basic connectivity HTTP boundary', () => {
    it('reports authentication and storage failures before any connection attempt', async () => {
        for (const [overrides, code] of [
            [
                {
                    authorizeAdmin: async () => {
                        throw new Error(secret);
                    },
                },
                'authorization_unavailable',
            ],
            [
                {
                    loadManualNodes: async () => {
                        throw new Error(secret);
                    },
                },
                'storage_unavailable',
            ],
            [{ loadManualNodes: async () => null }, 'storage_unavailable'],
        ]) {
            const f = fixture(overrides);
            const res = await f.handle(request(), {});
            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({ success: false, error: { code } });
            expect(f.resolveTarget).not.toHaveBeenCalled();
            expect(f.connect).not.toHaveBeenCalled();
        }
    });
    it('reports resolver transport failure as DNS inconclusive without connecting', async () => {
        const f = fixture({
            resolveTarget: async () => {
                throw new Error(secret);
            },
        });
        expect((await (await f.handle(request(), {})).json()).data).toMatchObject({
            status: 'unknown',
            code: 'dns_failed',
        });
        expect(f.connect).not.toHaveBeenCalled();
    });
    it('authenticates before parsing, loading, resolving or connecting', async () => {
        const f = fixture({ authorizeAdmin: vi.fn().mockResolvedValue(false) });
        expect((await f.handle(request(), {})).status).toBe(401);
        for (const spy of [f.loadManualNodes, f.resolveTarget, f.connect])
            expect(spy).not.toHaveBeenCalled();
    });
    it.each([null, 'https://other.example'])(
        'requires the exact same origin: %s',
        async (origin) => {
            const f = fixture();
            const headers = {
                'Content-Type': 'application/json',
                ...(origin ? { Origin: origin } : {}),
            };
            expect((await f.handle(request(undefined, { headers }), {})).status).toBe(403);
            expect(f.loadManualNodes).not.toHaveBeenCalled();
        }
    );
    it.each([
        { nodeId: 'saved', host: '8.8.8.8' },
        { nodeId: 'saved', port: 80 },
        { nodeId: 'saved', node: node.url },
        {},
        { nodeId: '../saved' },
        { nodeId: ['saved'] },
    ])('accepts only a single saved ID: %j', async (body) => {
        const f = fixture();
        expect((await f.handle(request(body), {})).status).toBe(400);
        expect(f.resolveTarget).not.toHaveBeenCalled();
    });
    it('rejects missing IDs, query input, wrong methods, types and oversized bodies', async () => {
        const f = fixture();
        expect((await f.handle(request({ nodeId: 'absent' }), {})).status).toBe(404);
        expect(
            (
                await f.handle(
                    new Request(`${ORIGIN}/api/nodes/connectivity?host=8.8.8.8`, {
                        method: 'POST',
                        headers: { Origin: ORIGIN },
                    }),
                    {}
                )
            ).status
        ).toBe(400);
        expect((await f.handle(new Request(`${ORIGIN}/api/nodes/connectivity`), {})).status).toBe(
            405
        );
        expect(
            (await f.handle(request(undefined, { headers: { Origin: ORIGIN } }), {})).status
        ).toBe(415);
        expect((await f.handle(request({ nodeId: 'x'.repeat(300) }), {})).status).toBe(413);
        expect(f.connect).not.toHaveBeenCalled();
    });
    it('opens only the validated literal and port, never writes or returns secrets/addresses', async () => {
        const f = fixture();
        const res = await f.handle(request(), {});
        const body = await res.json();
        expect(body.data).toMatchObject({
            status: 'ok',
            code: 'port_reachable',
            measurement: 'worker_tcp_connect',
            vantage: 'cloudflare_worker',
        });
        expect(Number.isInteger(body.data.latencyMs)).toBe(true);
        expect(body.data.checkedAt).toBeGreaterThan(0);
        expect(f.resolveTarget).toHaveBeenCalledWith('example.com', expect.any(AbortSignal));
        expect(f.connect).toHaveBeenCalledExactlyOnceWith(
            { hostname: '8.8.8.8', port: 443 },
            { secureTransport: 'off', allowHalfOpen: false }
        );
        expect(f.socket.close).toHaveBeenCalledOnce();
        expect(f.socket.readable.getReader).not.toHaveBeenCalled();
        expect(f.socket.writable.getWriter).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toMatch(/fixture-password|8\.8\.8\.8|example\.com/);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
    it.each(['hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard'])(
        'does not probe UDP %s',
        async (scheme) => {
            const f = fixture({
                loadManualNodes: async () => [{ ...node, url: `${scheme}://fixture@8.8.8.8:443` }],
            });
            expect((await (await f.handle(request(), {})).json()).data).toMatchObject({
                status: 'unsupported',
                code: 'udp_not_applicable',
                latencyMs: null,
            });
            expect(f.connect).not.toHaveBeenCalled();
            expect(f.resolveTarget).not.toHaveBeenCalled();
        }
    );
    it.each(['quic', 'kcp', 'udp'])('does not probe UDP-based transport %s', async (network) => {
        const f = fixture({
            prepareNodes: async () => [
                { proxy: { type: 'vmess', server: '8.8.8.8', port: 443, network } },
            ],
        });
        expect((await (await f.handle(request(), {})).json()).data.code).toBe('udp_not_applicable');
        expect(f.connect).not.toHaveBeenCalled();
    });
    it('does not connect port 25 or malformed credential-bearing nodes', async () => {
        for (const uri of [
            'trojan://fixture@8.8.8.8:25',
            `vmess://${btoa('{"id":"' + secret + '",')}`,
        ]) {
            const f = fixture({ loadManualNodes: async () => [{ ...node, url: uri }] });
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            expect((await (await f.handle(request(), {})).json()).data.status).toBe('unsupported');
            expect(f.connect).not.toHaveBeenCalled();
            expect(f.resolveTarget).not.toHaveBeenCalled();
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        }
    });
    it.each([
        'proxy request failed, cannot connect to the specified address',
        'TCP Loop detected',
        'Connections to port 25 are prohibited',
    ])('distinguishes platform restriction: %s', async (message) => {
        const f = fixture({
            connect: () => {
                throw new Error(message + secret);
            },
        });
        expect((await (await f.handle(request(), {})).json()).data).toMatchObject({
            status: 'unsupported',
            code: 'platform_restricted',
            latencyMs: null,
        });
    });
    it('keeps ordinary refusal inconclusive and redacts errors, including close rejection', async () => {
        const f = fixture();
        f.socket.opened = Promise.reject(new Error(secret));
        f.socket.close.mockRejectedValue(new Error(secret));
        expect((await (await f.handle(request(), {})).json()).data).toMatchObject({
            status: 'unknown',
            code: 'connect_failed',
            latencyMs: null,
        });
        expect(f.socket.close).toHaveBeenCalledOnce();
    });
    it('times out and closes a pending connection', async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.socket.opened = new Promise(() => {});
        const pending = f.handle(request(), {});
        await vi.advanceTimersByTimeAsync(5001);
        expect((await (await pending).json()).data).toMatchObject({
            status: 'timeout',
            code: 'deadline',
        });
        expect(f.socket.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('aborts late DNS without creating a socket after the response', async () => {
        vi.useFakeTimers();
        let resolve;
        const f = fixture({
            resolveTarget: vi.fn(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    })
            ),
        });
        const pending = f.handle(request(), {});
        await vi.advanceTimersByTimeAsync(5001);
        expect((await (await pending).json()).data.code).toBe('deadline');
        expect(f.resolveTarget.mock.calls[0][1].aborted).toBe(true);
        resolve('8.8.8.8');
        await Promise.resolve();
        expect(f.connect).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('closes an already-created pending socket when the client cancels', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const f = fixture();
        let created;
        const connected = new Promise((resolve) => {
            created = resolve;
        });
        f.socket.opened = new Promise(() => {});
        f.connect.mockImplementation(() => {
            created();
            return f.socket;
        });
        const pending = f.handle(request(undefined, { signal: controller.signal }), {});
        await connected;
        controller.abort();
        expect((await (await pending).json()).data).toMatchObject({
            status: 'cancelled',
            code: 'cancelled',
            latencyMs: null,
        });
        expect(f.socket.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('cancels requests and releases their active slot', async () => {
        const controller = new AbortController();
        controller.abort();
        const f = fixture();
        expect(
            (await (await f.handle(request(undefined, { signal: controller.signal }), {})).json())
                .data?.code
        ).toBe('cancelled');
        expect(f.connect).not.toHaveBeenCalled();
    });
    it('limits active requests before loading a fourth saved node', async () => {
        vi.useFakeTimers();
        const f = fixture({ loadManualNodes: () => new Promise(() => {}) });
        const pending = ['a', 'b', 'c'].map((nodeId) => f.handle(request({ nodeId }), {}));
        await vi.advanceTimersByTimeAsync(1);
        const res = await f.handle(request({ nodeId: 'd' }), {});
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('5');
        await vi.advanceTimersByTimeAsync(5001);
        await Promise.all(pending);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('enforces per-node cooldown and an isolate-wide fixed-window limit', async () => {
        let now = 100000;
        const f = fixture({ now: () => now });
        expect((await f.handle(request(), {})).status).toBe(200);
        expect((await f.handle(request(), {})).status).toBe(429);
        now += 10001;
        expect((await f.handle(request(), {})).status).toBe(200);
        for (let i = 0; i < 57; i++) await f.handle(request({ nodeId: `absent${i}` }), {});
        expect((await f.handle(request({ nodeId: 'overflow' }), {})).status).toBe(429);
        now += 60000;
        expect((await f.handle(request(), {})).status).toBe(200);
    });
});

function dnsFetch(answers = { 1: ['8.8.8.8'], 28: ['2001:4860:4860::8888'] }, alter = (x) => x) {
    return vi.fn(async (input) => {
        const url = new URL(input),
            type = Number(url.searchParams.get('type'));
        return Response.json(
            alter(
                {
                    Status: 0,
                    TC: false,
                    Question: [{ name: url.searchParams.get('name') + '.', type }],
                    Answer: answers[type].map((data) =>
                        typeof data === 'string' ? { type, data } : data
                    ),
                },
                type
            )
        );
    });
}
describe('public-only pinned DNS target', () => {
    it.each([
        '127.0.0.1',
        '10.0.0.1',
        '0.0.0.0',
        '100.64.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.0.1',
        '198.18.0.1',
        '192.0.2.1',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        'fc00::1',
        'fe80::1',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:8.8.8.8',
        '64:ff9b::808:808',
        '2002:0808:0808::1',
        '2001:db8::1',
        '2001::1',
        '3fff::1',
    ])('rejects unsafe literal %s', async (ip) => {
        expect(isPublicConnectivityIp(ip)).toBe(false);
        const fetch = vi.fn();
        await expect(resolveConnectivityTarget(ip, undefined, fetch)).rejects.toMatchObject({
            connectivityCode: 'unsafe_target',
        });
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111'])(
        'accepts global literal %s without DNS',
        async (ip) => {
            expect(isPublicConnectivityIp(ip)).toBe(true);
            const fetch = vi.fn();
            expect(await resolveConnectivityTarget(ip, undefined, fetch)).toBe(ip);
            expect(fetch).not.toHaveBeenCalled();
        }
    );
    it.each([
        'localhost',
        'host.local',
        'metadata.google.internal',
        'a.lan',
        'a.invalid',
        '127.1',
        '2130706433',
        '0x7f000001',
        '01.2.3.4',
        'a.com/path',
        'a.com@b.com',
        'a.com:443',
        'a.com\n',
        'a%2ecom',
    ])('rejects ambiguous/nonpublic hostname %s', async (host) => {
        const fetch = vi.fn();
        await expect(resolveConnectivityTarget(host, undefined, fetch)).rejects.toMatchObject({
            connectivityCode: 'unsafe_target',
        });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('queries both families at a fixed resolver then returns a pinned literal', async () => {
        const fetch = dnsFetch();
        const signal = new AbortController().signal;
        expect(await resolveConnectivityTarget('EXAMPLE.COM.', signal, fetch)).toBe('8.8.8.8');
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const [url, options] of fetch.mock.calls) {
            expect(new URL(url).origin).toBe('https://cloudflare-dns.com');
            expect(options).toEqual({
                headers: { Accept: 'application/dns-json' },
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                signal,
            });
        }
    });
    it.each([
        { 1: ['8.8.8.8', '10.0.0.1'], 28: [] },
        { 1: ['8.8.8.8'], 28: ['::ffff:127.0.0.1'] },
        { 1: [{ type: 5, data: 'metadata.google.internal.' }, '8.8.8.8'], 28: [] },
    ])('rejects the entire answer when any family/alias is unsafe', async (answers) => {
        await expect(
            resolveConnectivityTarget('example.com', undefined, dnsFetch(answers))
        ).rejects.toMatchObject({ connectivityCode: 'unsafe_target' });
    });
    it.each([
        (x) => ({ ...x, Status: 3 }),
        (x) => ({ ...x, TC: true }),
        (x) => ({ ...x, Question: [] }),
        (x) => ({ ...x, Answer: [] }),
        (x) => ({ ...x, Answer: [{ type: 1, data: '127.1' }] }),
        (x) => ({ ...x, Question: [{ name: 'other.com.', type: 1 }] }),
        (x) => ({ ...x, Answer: Array(33).fill({ type: 1, data: '8.8.8.8' }) }),
    ])('fails closed for incomplete or malformed DNS answers', async (alter) => {
        await expect(
            resolveConnectivityTarget('example.com', undefined, dnsFetch(undefined, alter))
        ).rejects.toMatchObject({ connectivityCode: 'dns_failed' });
    });
    it('rejects redirects, oversized bodies and DNS reader aborts', async () => {
        await expect(
            resolveConnectivityTarget(
                'example.com',
                undefined,
                async () => new Response('', { status: 302 })
            )
        ).rejects.toMatchObject({ connectivityCode: 'dns_failed' });
        await expect(
            resolveConnectivityTarget(
                'example.com',
                undefined,
                async () => new Response('x'.repeat(16385))
            )
        ).rejects.toMatchObject({ connectivityCode: 'dns_failed' });
        const controller = new AbortController();
        controller.abort();
        await expect(
            resolveConnectivityTarget('example.com', controller.signal, dnsFetch())
        ).rejects.toMatchObject({ connectivityCode: 'dns_failed' });
    });
});
