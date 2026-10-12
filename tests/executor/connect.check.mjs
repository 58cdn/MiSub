import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectTransport } from '../../executors/connect/transport.js';
import { isPublicAddress, resolvePinned } from '../../executors/connect/address-policy.js';
import { executeRequest } from '../../executors/connect/cli.js';

const originalConnect = net.connect;
const originalSocketConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;
const originalHttpConnect = http.Agent.prototype.createConnection;
const originalHttpsConnect = https.Agent.prototype.createConnection;
const originalFetch = globalThis.fetch;
const actualConnections = [];
const clientSockets = [];
const proxyPorts = new Set();
const fixturePorts = new Set();
let fixtureDirectory, key, cert;
const root = fileURLToPath(new URL('../../', import.meta.url));
const resolver = async (host) => [
    { address: host === 'proxy.test' ? '93.184.216.35' : '93.184.216.34', family: 4 },
];

before(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'misub-connect-fixture-'));
    const openssl = process.env.OPENSSL_PATH || 'openssl';
    execFileSync(
        openssl,
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-keyout',
            join(fixtureDirectory, 'key.pem'),
            '-out',
            join(fixtureDirectory, 'cert.pem'),
            '-subj',
            '/CN=MiSub offline fixture',
            '-addext',
            'subjectAltName=DNS:proxy.test,DNS:api64.ipify.org,DNS:api.ip.sb,DNS:www.gstatic.com,DNS:my.ippure.com,DNS:api.ipinfo.io,DNS:api.openai.com,IP:127.0.0.1',
        ],
        { stdio: 'ignore' }
    );
    key = readFileSync(join(fixtureDirectory, 'key.pem'));
    cert = readFileSync(join(fixtureDirectory, 'cert.pem'));
    // Stop regressions before DNS or a socket can reach an external service,
    // including default Agents that keep aliases to net.createConnection.
    net.Socket.prototype.connect = function (...args) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        assert.ok(
            options &&
                typeof options === 'object' &&
                fixturePorts.has(Number(options.port)) &&
                options.host === '127.0.0.1',
            'non-fixture socket connection forbidden'
        );
        return originalSocketConnect.apply(this, args);
    };
    http.Agent.prototype.createConnection = https.Agent.prototype.createConnection = () => {
        throw new Error('default Agent connection forbidden');
    };
    tls.connect = (options) => {
        assert.ok(options.socket, 'TLS direct connection forbidden');
        return originalTlsConnect(options);
    };
    // This is an assertion seam, not a production transport override. Only the
    // registered local proxy may be dialed by the executor. Fixture upstreams use
    // originalConnect explicitly. Any attempted direct target connection fails.
    net.connect = (options) => {
        actualConnections.push({ host: options.host, port: options.port });
        assert.ok(proxyPorts.has(options.port), 'executor attempted to bypass the proxy port');
        assert.ok(
            ['127.0.0.1', '93.184.216.35'].includes(options.host),
            'executor attempted a direct/unknown destination'
        );
        const socket = originalConnect({ ...options, host: '127.0.0.1' });
        clientSockets.push(socket);
        return socket;
    };
    globalThis.fetch = () => {
        throw new Error('global fetch fallback forbidden');
    };
});
after(() => {
    net.connect = originalConnect;
    net.Socket.prototype.connect = originalSocketConnect;
    tls.connect = originalTlsConnect;
    http.Agent.prototype.createConnection = originalHttpConnect;
    https.Agent.prototype.createConnection = originalHttpsConnect;
    globalThis.fetch = originalFetch;
    // This test owns only its freshly-created temporary directory.
    if (fixtureDirectory && resolve(fixtureDirectory).startsWith(resolve(tmpdir()) + sep))
        rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}
async function fixture(t, options = {}) {
    const sockets = new Set();
    const requests = [],
        connects = [],
        sni = [];
    const track = (socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
    };
    let targetSeen;
    const targetHit = new Promise((resolve) => {
        targetSeen = resolve;
    });
    const target =
        options.stall === 'targetTls'
            ? net.createServer((socket) => socket.resume())
            : https.createServer({ key, cert }, (request, response) => {
                  requests.push({ path: request.url, headers: request.headers });
                  targetSeen();
                  if (options.handler) return options.handler(request, response);
                  response.writeHead(200, { 'content-type': 'application/json' });
                  response.end(JSON.stringify({ ip: '198.51.100.10' }));
              });
    target.on('connection', track);
    target.on('secureConnection', (socket) => sni.push(socket.servername));
    const targetPort = await listen(target);
    fixturePorts.add(targetPort);
    const proxy =
        options.stall === 'proxyTls'
            ? net.createServer((socket) => socket.resume())
            : options.https
              ? https.createServer({ key, cert })
              : http.createServer();
    proxy.on('connection', track);
    proxy.on('connect', (request, socket, head) => {
        connects.push({ authority: request.url, headers: request.headers });
        if (options.stall === 'connect') {
            socket.once('end', () => socket.end());
            socket.resume();
            return;
        }
        if (options.status) {
            socket.end(`HTTP/1.1 ${options.status} Rejected\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        if (options.extraHead) {
            socket.end('HTTP/1.1 200 Connection Established\r\n\r\ninvalid');
            return;
        }
        const upstream = originalConnect({ host: '127.0.0.1', port: targetPort });
        track(upstream);
        upstream.once('connect', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy());
    });
    const proxyPort = await listen(proxy);
    proxyPorts.add(proxyPort);
    fixturePorts.add(proxyPort);
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all(
            [target, proxy].map((server) => new Promise((resolve) => server.close(resolve)))
        );
        proxyPorts.delete(proxyPort);
        fixturePorts.delete(proxyPort);
        fixturePorts.delete(targetPort);
    });
    return {
        proxyPort,
        requests,
        connects,
        sni,
        sockets,
        targetHit,
        node: `${options.https ? 'https' : 'http'}://fixture-user:fixture-pass@127.0.0.1:${proxyPort}`,
        transport(extra = {}) {
            return createConnectTransport({
                node: this.node,
                requestId: 'fixture',
                allowLoopbackProxy: true,
                resolver,
                proxyCa: cert,
                targetCa: cert,
                ...extra,
            });
        },
    };
}

test('public-address policy rejects private, reserved, mapped and transition addresses', () => {
    for (const address of [
        '0.0.0.0',
        '10.1.2.3',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.0.1',
        '192.0.2.1',
        '198.18.0.1',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        '::ffff:127.0.0.1',
        'fc00::1',
        'fe80::1',
        '64:ff9b::7f00:1',
        '2001::1',
        '2001:db8::1',
        '2002:7f00:1::',
        '3fff::1',
        'garbage',
    ])
        assert.equal(isPublicAddress(address), false, address);
    for (const address of [
        '1.1.1.1',
        '8.8.8.8',
        '93.184.216.34',
        '2606:4700:4700::1111',
        '2001:4860:4860::8888',
    ])
        assert.equal(isPublicAddress(address), true, address);
});
test('mixed DNS answers fail closed; loopback exception only permits an explicit literal proxy', async () => {
    await assert.rejects(
        resolvePinned('provider.test', {
            resolver: async () => [
                { address: '8.8.8.8', family: 4 },
                { address: '127.0.0.1', family: 4 },
            ],
        }),
        /address_rejected/
    );
    await assert.rejects(
        resolvePinned('localhost', {
            allowLoopback: true,
            resolver: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
        /address_rejected/
    );
    await assert.rejects(resolvePinned('127.0.0.1'), /address_rejected/);
    assert.equal((await resolvePinned('127.0.0.1', { allowLoopback: true })).address, '127.0.0.1');
});
for (const httpsProxy of [false, true])
    test(`${httpsProxy ? 'HTTPS' : 'HTTP'} CONNECT actually carries target TLS/HTTP, with credential separation`, async (t) => {
        const f = await fixture(t, { https: httpsProxy });
        const connectionStart = actualConnections.length;
        const response = await f.transport().fetch('https://api.ipinfo.io/lite/me', {
            headers: { Authorization: 'Bearer fixture-token', 'User-Agent': 'MiSub-test' },
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).ip, '198.51.100.10');
        assert.equal(f.connects.length, 1);
        assert.equal(f.requests.length, 1);
        assert.equal(f.connects[0].authority, '93.184.216.34:443');
        assert.equal(
            f.connects[0].headers['proxy-authorization'],
            `Basic ${Buffer.from('fixture-user:fixture-pass').toString('base64')}`
        );
        assert.equal(f.connects[0].headers.authorization, undefined);
        assert.equal(f.requests[0].headers['proxy-authorization'], undefined);
        assert.equal(f.requests[0].headers.authorization, 'Bearer fixture-token');
        assert.equal(f.requests[0].headers.host, 'api.ipinfo.io:443');
        assert.deepEqual(f.sni, ['api.ipinfo.io']);
        assert.deepEqual(actualConnections.slice(connectionStart), [
            { host: '127.0.0.1', port: f.proxyPort },
        ]);
    });
test('DNS is resolved once, pinned numerically, with original proxy hostname certificate verification', async (t) => {
    const f = await fixture(t, { https: true });
    const lookups = [];
    const transport = f.transport({
        node: `https://proxy.test:${f.proxyPort}`,
        resolver: async (host) => {
            // A second resolution would rebind to loopback; no second lookup is allowed.
            if (lookups.includes(host)) return [{ address: '127.0.0.1', family: 4 }];
            lookups.push(host);
            return resolver(host);
        },
    });
    await transport.fetch('https://api64.ipify.org/?format=json');
    assert.deepEqual(lookups.sort(), ['api64.ipify.org', 'proxy.test']);
    assert.deepEqual(actualConnections.at(-1), { host: '93.184.216.35', port: f.proxyPort });
    assert.equal(f.connects[0].authority, '93.184.216.34:443');
});
for (const status of [302, 403, 407, 502])
    test(`CONNECT ${status} never reaches the target or retries directly`, async (t) => {
        const f = await fixture(t, { status });
        const start = actualConnections.length;
        await assert.rejects(
            f.transport().fetch('https://api64.ipify.org?format=json'),
            /proxy_rejected/
        );
        assert.equal(f.requests.length, 0);
        assert.equal(f.connects.length, 1);
        assert.equal(actualConnections.length - start, 1);
    });
test('unexpected CONNECT bytes are rejected instead of consumed as a target response', async (t) => {
    const f = await fixture(t, { extraHead: true });
    await assert.rejects(
        f.transport().fetch('https://api64.ipify.org?format=json'),
        /proxy_rejected/
    );
    assert.equal(f.requests.length, 0);
});
test('both TLS layers reject untrusted certificates', async (t) => {
    const f = await fixture(t, { https: true });
    await assert.rejects(
        f.transport({ proxyCa: undefined }).fetch('https://api64.ipify.org?format=json')
    );
    assert.equal(f.connects.length, 0);
    await assert.rejects(
        f.transport({ targetCa: undefined }).fetch('https://api64.ipify.org?format=json')
    );
    assert.equal(f.connects.length, 1);
    assert.equal(f.requests.length, 0);
});
test('valid chain with wrong proxy or target identity still fails', async (t) => {
    const f = await fixture(t, { https: true });
    await assert.rejects(
        f
            .transport({
                node: `https://wrong.test:${f.proxyPort}`,
                resolver: async (host) => [
                    {
                        address: host === 'wrong.test' ? '93.184.216.35' : '93.184.216.34',
                        family: 4,
                    },
                ],
            })
            .fetch('https://api64.ipify.org?format=json'),
        /Hostname\/IP does not match/
    );
    await assert.rejects(
        f.transport().fetch('https://ifconfig.me/ip'),
        /Hostname\/IP does not match/
    );
    assert.equal(f.requests.length, 0);
});
test('target allowlist and private DNS cannot be bypassed by loopback-proxy permission', async (t) => {
    const f = await fixture(t);
    const start = actualConnections.length;
    for (const url of [
        'https://127.0.0.1/',
        'https://api64.ipify.org/other',
        'https://api64.ipify.org/?format=json#extra',
        'http://api64.ipify.org/?format=json',
    ])
        await assert.rejects(f.transport().fetch(url), /target_rejected/);
    await assert.rejects(
        f
            .transport({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] })
            .fetch('https://api64.ipify.org?format=json'),
        /address_rejected/
    );
    assert.equal(actualConnections.length, start);
});
test('pre-abort and a DNS answer arriving after cancellation cannot open a socket', async (t) => {
    const f = await fixture(t);
    const start = actualConnections.length;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        f.transport().fetch('https://api64.ipify.org?format=json', { signal: controller.signal }),
        /cancelled/
    );
    let finishDns;
    const pendingDns = new Promise((resolve) => {
        finishDns = resolve;
    });
    const duringDns = new AbortController();
    const pending = f
        .transport({ resolver: () => pendingDns })
        .fetch('https://api64.ipify.org?format=json', { signal: duringDns.signal });
    duringDns.abort();
    await assert.rejects(pending, /cancelled/);
    finishDns([{ address: '93.184.216.34', family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(actualConnections.length, start);
});
test('DNS failure and disguised private proxy addresses produce no connections', async () => {
    const start = actualConnections.length;
    for (const node of [
        'http://2130706433:80',
        'http://0x7f000001:80',
        'http://[::ffff:127.0.0.1]:80',
    ]) {
        const transport = createConnectTransport({ node, requestId: 'test', resolver });
        await assert.rejects(
            transport.fetch('https://api64.ipify.org?format=json'),
            /address_rejected/
        );
    }
    const transport = createConnectTransport({
        node: 'https://proxy.test',
        requestId: 'test',
        resolver: async () => {
            throw new Error('ENOTFOUND');
        },
    });
    await assert.rejects(transport.fetch('https://api64.ipify.org?format=json'), /ENOTFOUND/);
    assert.equal(actualConnections.length, start);
});
test('transport bounds concurrent sockets and cancels all three active operations', async (t) => {
    const f = await fixture(t, { stall: 'connect' });
    const transport = f.transport();
    const controller = new AbortController();
    const start = clientSockets.length;
    const pending = Array.from({ length: 3 }, () =>
        transport.fetch('https://api64.ipify.org?format=json', { signal: controller.signal })
    );
    await assert.rejects(transport.fetch('https://api64.ipify.org?format=json'), /rate_limited/);
    controller.abort();
    for (const result of await Promise.allSettled(pending)) {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, /cancelled/);
    }
    assert.ok(clientSockets.slice(start).every((socket) => socket.destroyed));
});
test('target response-header stall can be cancelled', async (t) => {
    const f = await fixture(t, { handler: () => {} });
    const controller = new AbortController();
    const pending = f
        .transport()
        .fetch('https://api64.ipify.org?format=json', { signal: controller.signal });
    await f.targetHit;
    controller.abort();
    await assert.rejects(pending, /cancelled/);
});
test('oversized target headers are rejected before a result is returned', async (t) => {
    const f = await fixture(t, {
        handler: (_request, response) => {
            response.writeHead(200, { 'X-Oversized': 'x'.repeat(9000) });
            response.end('{}');
        },
    });
    await assert.rejects(
        f.transport().fetch('https://api64.ipify.org?format=json'),
        /Header overflow/
    );
});
for (const stall of ['proxyTls', 'connect', 'targetTls'])
    test(`cancellation releases stalled ${stall} connections`, async (t) => {
        const f = await fixture(t, { stall, https: stall === 'proxyTls' });
        const start = clientSockets.length;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 50);
        t.after(() => clearTimeout(timer));
        await assert.rejects(
            f
                .transport()
                .fetch('https://api64.ipify.org?format=json', { signal: controller.signal }),
            /cancelled/
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(clientSockets.slice(start).every((socket) => socket.destroyed));
        assert.equal(f.sockets.size, 0);
    });
test('a stalled CONNECT response has a hard five-second deadline', { timeout: 8000 }, async (t) => {
    const f = await fixture(t, { stall: 'connect' });
    const started = Date.now();
    await assert.rejects(f.transport().fetch('https://api64.ipify.org?format=json'), /timeout/);
    assert.ok(Date.now() - started < 7000);
});
test('response body cancellation closes the entire tunnel', async (t) => {
    const f = await fixture(t, {
        handler: (_request, response) => {
            response.writeHead(200);
            response.write('partial');
        },
    });
    const controller = new AbortController();
    const pending = f
        .transport()
        .fetch('https://api64.ipify.org?format=json', { signal: controller.signal });
    await f.targetHit;
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.sockets.size, 0);
});
test('oversized and truncated responses cannot become successful evidence', async (t) => {
    const large = await fixture(t, {
        handler: (_request, response) => response.end('x'.repeat(16385)),
    });
    await assert.rejects(
        large.transport().fetch('https://api64.ipify.org?format=json'),
        /response_too_large/
    );
    const truncated = await fixture(t, {
        handler: (_request, response) => {
            response.writeHead(200, { 'content-length': '100' });
            response.write('short');
            response.socket.end();
        },
    });
    await assert.rejects(truncated.transport().fetch('https://api64.ipify.org?format=json'));
});
test('runner receives real 204 URLTest over the proxy, not site duration or direct fetch', async (t) => {
    const f = await fixture(t, {
        handler: (_request, response) => {
            response.writeHead(204);
            response.end();
        },
    });
    const report = await executeRequest(
        { node: f.node, sources: ['latency'], consent: true },
        {
            allowLoopbackProxy: true,
            resolver,
            targetCa: cert,
        }
    );
    assert.equal(report.results[0].status, 'ok');
    assert.equal(report.results[0].measurement, 'node_http_urltest');
    assert.equal(typeof report.results[0].latencyMs, 'number');
    assert.equal(f.connects.length, 1);
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(report).includes('fixture-pass'));
});
test('runner preserves redirect rejection, rate limits and partial quality from real fixture transport', async (t) => {
    for (const [source, status, body, expected] of [
        ['ipify', 302, '', 'error'],
        ['ipify', 429, '', 'rate_limited'],
        ['ippure', 200, JSON.stringify({ ip: '198.51.100.10', fraudScore: 0 }), 'partial'],
        ['openai', 200, '{}', 'unknown'],
    ]) {
        const f = await fixture(t, {
            handler: (_request, response) => {
                response.writeHead(status, {
                    Location: 'https://127.0.0.1/',
                    'Retry-After': '120',
                });
                response.end(body);
            },
        });
        const report = await executeRequest(
            { node: f.node, sources: [source], consent: true },
            {
                allowLoopbackProxy: true,
                resolver,
                targetCa: cert,
            }
        );
        assert.equal(report.results[0].status, expected);
        if (source === 'ippure') assert.equal(report.results[0].riskScore, 0);
        if (status === 429) assert.equal(report.results[0].retryAfterSeconds, 120);
        assert.equal(f.connects.length, 1);
    }
});
test('executor preserves conflicting source evidence with validated timestamps and freshness', async (t) => {
    const bodies = {
        'api64.ipify.org:443': { ip: '198.51.100.11' },
        'api.ip.sb:443': { ip: '198.51.100.10', country_code: 'US' },
        'my.ippure.com:443': {
            ip: '198.51.100.10',
            countryCode: 'DE',
            fraudScore: 0,
            isResidential: false,
        },
    };
    const f = await fixture(t, {
        handler: (request, response) => {
            response.end(JSON.stringify(bodies[request.headers.host]));
        },
    });
    const report = await executeRequest(
        { node: f.node, sources: ['ipify', 'ip_sb', 'ippure'], consent: true },
        {
            allowLoopbackProxy: true,
            resolver,
            targetCa: cert,
        }
    );
    assert.deepEqual(
        report.results.map((result) => result.source),
        ['ipify', 'ip_sb', 'ippure']
    );
    assert.equal(report.results[2].riskScore, 0);
    assert.equal(report.results[2].isResidential, false);
    assert.equal(report.results[2].isBroadcast, null);
    assert.deepEqual(report.conflicts, [
        { type: 'ip', family: 4, values: ['198.51.100.11', '198.51.100.10'] },
        { type: 'country', ip: '198.51.100.10', values: ['US', 'DE'] },
    ]);
    assert.equal(Date.parse(report.expiresAt) - Date.parse(report.checkedAt), 600000);
    assert.ok(report.results.every((result) => Number.isFinite(Date.parse(result.checkedAt))));
    assert.equal(f.connects.length, 3);
    assert.equal(f.requests.length, 3);
});
test('429 headers preserve Retry-After even when the body is oversized or never ends', async (t) => {
    for (const body of ['', 'x'.repeat(20000)]) {
        const f = await fixture(t, {
            handler: (_request, response) => {
                response.writeHead(429, { 'Retry-After': '300' });
                response.flushHeaders();
                if (body) response.write(body);
            },
        });
        const started = Date.now();
        const report = await executeRequest(
            { node: f.node, sources: ['ipify'], consent: true },
            {
                allowLoopbackProxy: true,
                resolver,
                targetCa: cert,
            }
        );
        assert.equal(report.results[0].status, 'rate_limited');
        assert.equal(report.results[0].retryAfterSeconds, 300);
        assert.ok(Date.now() - started < 2000);
        assert.equal(f.connects.length, 1);
    }
});
test('provider authorization stays inside target TLS when invoked by the runner', async (t) => {
    const f = await fixture(t);
    const report = await executeRequest(
        { node: f.node, sources: ['ipinfo'], consent: true },
        {
            allowLoopbackProxy: true,
            resolver,
            targetCa: cert,
            ipinfoToken: 'fixture-ipinfo-token',
        }
    );
    assert.equal(report.results[0].status, 'ok');
    assert.equal(f.requests[0].headers.authorization, 'Bearer fixture-ipinfo-token');
    assert.equal(f.connects[0].headers.authorization, undefined);
    assert.ok(!JSON.stringify(report).includes('fixture-ipinfo-token'));
});
test('unsupported protocol, missing consent and header injection fail before network access', async () => {
    const start = actualConnections.length;
    await assert.rejects(
        executeRequest({
            node: 'ss://secret@example.invalid:443',
            sources: ['ipify'],
            consent: true,
        }),
        /unsupported_protocol/
    );
    await assert.rejects(
        executeRequest({ node: 'http://example.invalid:80', sources: ['ipify'] }),
        /invalid_request/
    );
    const transport = createConnectTransport({
        node: 'http://example.invalid:80',
        requestId: 'test',
    });
    await assert.rejects(
        transport.fetch('https://api64.ipify.org?format=json', {
            headers: { 'Proxy-Authorization': 'secret' },
        }),
        /header_rejected/
    );
    assert.equal(actualConnections.length, start);
});

function cli(args, input, { keepInputOpen = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['executors/connect/cli.js', ...args], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.on('error', () => {});
        if (!keepInputOpen) child.stdin.end(input);
    });
}
test('CLI rejects missing consent, unknown protocols and oversized stdin without exposing credentials', async () => {
    const secret = 'ss://must-not-appear@example.invalid:443';
    const input = JSON.stringify({ node: secret, sources: ['ipify'], consent: true });
    const results = [
        await cli([], input),
        await cli(['--consent'], input),
        await cli(['--consent'], 'x'.repeat(16385)),
    ];
    assert.deepEqual(
        results.map((r) => JSON.parse(r.stdout).error),
        ['consent_required', 'unsupported_protocol', 'input_too_large']
    );
    for (const result of results) {
        assert.equal(result.code, 1);
        assert.ok(!result.stdout.includes(secret));
        assert.equal(result.stderr, '');
    }
});
test('CLI bounds a stalled stdin stream', { timeout: 8000 }, async () => {
    const result = await cli(['--consent'], '', { keepInputOpen: true });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error, 'input_timeout');
});
