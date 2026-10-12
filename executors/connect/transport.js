import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { SOURCES } from '../../functions/services/diagnostics/contract.js';
import { resolvePinned } from './address-policy.js';

const allowedTargets = new Set(SOURCES.filter((s) => s.url).map((s) => new URL(s.url).href));
const MAX_BODY = 16384;
const DEADLINE_MS = 5000;
const hostname = (url) => url.hostname.replace(/^\[|\]$/g, '');

function parseProxy(node) {
    if (typeof node !== 'string' || node.length > 8192 || /[\x00-\x20\x7f]/.test(node))
        throw new Error('invalid_node');
    let url;
    try {
        url = new URL(node);
    } catch {
        throw new Error('invalid_node');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
    if (url.pathname !== '/' || url.search || !url.hostname) throw new Error('invalid_node');
    let username, password;
    try {
        username = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
    } catch {
        throw new Error('invalid_node');
    }
    if (
        username.includes(':') ||
        /[\x00-\x1f\x7f]/.test(username + password) ||
        username.length + password.length > 2048
    )
        throw new Error('invalid_node');
    return {
        host: hostname(url),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        secure: url.protocol === 'https:',
        authorization:
            username || password
                ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
                : null,
    };
}

// Every request receives exactly its already-connected socket. There is no agent
// path that can create a fresh connection to a target or honor proxy environment variables.
function socketAgent(socket) {
    const agent = new http.Agent({ keepAlive: false });
    let used = false;
    agent.createConnection = () => {
        if (used || socket.destroyed) throw new Error('transport_closed');
        used = true;
        return socket;
    };
    return agent;
}

function waitFor(socket, event) {
    return new Promise((resolve, reject) => {
        const done = () => {
            cleanup();
            resolve(socket);
        };
        const fail = (error) => {
            cleanup();
            reject(error);
        };
        const closed = () => fail(new Error('transport_closed'));
        const cleanup = () => {
            socket.off(event, done);
            socket.off('error', fail);
            socket.off('close', closed);
        };
        socket.once(event, done);
        socket.once('error', fail);
        socket.once('close', closed);
    });
}

export function createConnectTransport({
    node,
    requestId,
    allowLoopbackProxy = false,
    resolver,
    proxyCa,
    targetCa,
}) {
    if (typeof requestId !== 'string' || !requestId) throw new Error('invalid_request');
    const proxy = parseProxy(node);
    let active = 0;
    return {
        scope: 'node',
        requestId,
        async fetch(input, options = {}) {
            const target = new URL(input);
            if (
                !allowedTargets.has(target.href) ||
                (options.method && options.method !== 'GET') ||
                options.body !== undefined
            )
                throw new Error('target_rejected');
            const headers = new Headers(options.headers);
            for (const name of headers.keys()) {
                if (
                    !['accept', 'user-agent', 'authorization'].includes(name) ||
                    (name === 'authorization' && target.hostname !== 'api.ipinfo.io')
                )
                    throw new Error('header_rejected');
            }
            headers.set('Accept-Encoding', 'identity');
            headers.set('Connection', 'close');
            if (active >= 3) throw new Error('rate_limited');
            active++;
            const controller = new AbortController();
            const sockets = new Set();
            const agents = new Set();
            let rejectStop;
            const stopped = new Promise((_, reject) => {
                rejectStop = reject;
            });
            const stop = (code) => {
                if (controller.signal.aborted) return;
                controller.abort();
                for (const socket of sockets) socket.destroy();
                rejectStop(new Error(code));
            };
            const onAbort = () => stop('cancelled');
            options.signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => stop('timeout'), DEADLINE_MS);
            const check = () => {
                if (controller.signal.aborted) throw new Error('cancelled');
            };
            const track = (socket) => {
                socket.on('error', () => {});
                sockets.add(socket);
                socket.once('close', () => sockets.delete(socket));
                return socket;
            };
            const agentFor = (socket) => {
                const agent = socketAgent(socket);
                agents.add(agent);
                return agent;
            };
            const secure = async (socket, host, ca) => {
                check();
                const wrapped = track(
                    tls.connect({
                        socket,
                        servername: net.isIP(host) ? undefined : host,
                        rejectUnauthorized: true,
                        minVersion: 'TLSv1.2',
                        ca,
                        checkServerIdentity: (_server, certificate) =>
                            tls.checkServerIdentity(host, certificate),
                        ALPNProtocols: ['http/1.1'],
                    })
                );
                await waitFor(wrapped, 'secureConnect');
                if (!wrapped.authorized) throw new Error('tls_rejected');
                return wrapped;
            };
            const operation = async () => {
                check();
                const [proxyAddress, targetAddress] = await Promise.all([
                    resolvePinned(proxy.host, { allowLoopback: allowLoopbackProxy, resolver }),
                    resolvePinned(target.hostname, { resolver }),
                ]);
                check();
                let tunnel = track(
                    net.connect({
                        host: proxyAddress.address,
                        port: proxy.port,
                        family: proxyAddress.family,
                    })
                );
                await waitFor(tunnel, 'connect');
                if (proxy.secure) tunnel = await secure(tunnel, proxy.host, proxyCa);
                check();
                const authority = `${targetAddress.family === 6 ? `[${targetAddress.address}]` : targetAddress.address}:443`;
                const connectHeaders = { Host: authority };
                if (proxy.authorization)
                    connectHeaders['Proxy-Authorization'] = proxy.authorization;
                tunnel = await new Promise((resolve, reject) => {
                    const request = http.request({
                        method: 'CONNECT',
                        host: proxy.host,
                        port: proxy.port,
                        path: authority,
                        agent: agentFor(tunnel),
                        headers: connectHeaders,
                        maxHeaderSize: 8192,
                    });
                    request.once('error', reject);
                    request.once('connect', (response, socket, head) => {
                        if (response.statusCode !== 200 || head.length) {
                            socket.destroy();
                            reject(new Error('proxy_rejected'));
                            return;
                        }
                        resolve(socket);
                    });
                    request.once('response', (response) => {
                        response.destroy();
                        reject(new Error('proxy_rejected'));
                    });
                    request.end();
                });
                const connection = await secure(tunnel, target.hostname, targetCa);
                check();
                return await new Promise((resolve, reject) => {
                    const request = http.request({
                        host: target.hostname,
                        port: 443,
                        method: 'GET',
                        path: target.pathname + target.search,
                        agent: agentFor(connection),
                        headers: Object.fromEntries(headers),
                        maxHeaderSize: 8192,
                    });
                    request.once('error', reject);
                    request.once('response', (response) => {
                        const makeResponse = (body) =>
                            new Response(body, {
                                status: response.statusCode,
                                headers: Object.entries(response.headers)
                                    .filter(([, value]) => value !== undefined)
                                    .map(([key, value]) => [
                                        key,
                                        Array.isArray(value) ? value.join(', ') : value,
                                    ]),
                            });
                        const chunks = [];
                        let size = 0;
                        response.on('error', reject);
                        // These statuses are decided from headers by the runner.
                        // A hostile/stalled body must not hide Retry-After or turn
                        // a rejected redirect into a different observation.
                        if (
                            response.statusCode === 429 ||
                            (response.statusCode >= 300 && response.statusCode < 400)
                        ) {
                            try {
                                resolve(makeResponse(null));
                            } catch (error) {
                                reject(error);
                            }
                            response.destroy();
                            return;
                        }
                        response.once('aborted', () => reject(new Error('incomplete_response')));
                        response.on('data', (chunk) => {
                            size += chunk.length;
                            if (size > MAX_BODY) {
                                reject(new Error('response_too_large'));
                                response.destroy();
                                return;
                            }
                            chunks.push(chunk);
                        });
                        response.once('end', () => {
                            try {
                                if (!response.complete) throw new Error('incomplete_response');
                                resolve(
                                    makeResponse(
                                        response.statusCode === 204 ? null : Buffer.concat(chunks)
                                    )
                                );
                            } catch (error) {
                                reject(error);
                            }
                        });
                    });
                    request.end();
                });
            };
            try {
                if (options.signal?.aborted) stop('cancelled');
                return await Promise.race([operation(), stopped]);
            } finally {
                controller.abort();
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                for (const socket of sockets) socket.destroy();
                for (const agent of agents) agent.destroy();
                active--;
            }
        },
    };
}
