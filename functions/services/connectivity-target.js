import { isIP } from 'node:net';
import { readBoundedText } from './diagnostics/runner.js';

export function connectivityError(code) {
    return Object.assign(new Error(code), { connectivityCode: code });
}

// Deliberately conservative: only global unicast destinations are eligible.
export function isPublicConnectivityIp(ip) {
    const family = isIP(ip);
    if (family === 4) {
        const [a, b, c] = ip.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (family !== 6) return false;
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [first, second] = canonical.split(':').map((part) => parseInt(part || '0', 16));
    return (
        first >= 0x2000 &&
        first <= 0x3fff &&
        first !== 0x2002 &&
        first !== 0x3fff &&
        !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
}

function publicHostname(value) {
    if (typeof value !== 'string') throw connectivityError('unsafe_target');
    const host = value.toLowerCase().replace(/\.$/, '');
    if (
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
        /\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host)
    ) {
        throw connectivityError('unsafe_target');
    }
    return host;
}

// Both families must resolve safely before any socket is opened. The socket uses
// one validated literal, so a subsequent hostname lookup cannot rebind the target.
export async function resolveConnectivityTarget(rawHost, signal, fetchImpl = fetch) {
    const host = rawHost.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
        if (!isPublicConnectivityIp(host)) throw connectivityError('unsafe_target');
        return host;
    }
    const name = publicHostname(host);
    const answers = await Promise.all(
        [1, 28].map(async (type) => {
            const url = new URL('https://cloudflare-dns.com/dns-query');
            url.search = new URLSearchParams({ name, type: String(type) }).toString();
            const response = await fetchImpl(url.toString(), {
                headers: { Accept: 'application/dns-json' },
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                signal,
            });
            if (!response.ok || response.redirected) {
                void response.body?.cancel().catch(() => {});
                throw connectivityError('dns_failed');
            }
            let data;
            try {
                data = JSON.parse(await readBoundedText(response, 16384, signal));
            } catch {
                throw connectivityError('dns_failed');
            }
            if (
                data.Status !== 0 ||
                data.TC === true ||
                !Array.isArray(data.Question) ||
                data.Question.length !== 1 ||
                data.Question[0].type !== type ||
                typeof data.Question[0].name !== 'string' ||
                data.Question[0].name.toLowerCase().replace(/\.$/, '') !== name ||
                (data.Answer !== undefined && !Array.isArray(data.Answer)) ||
                (data.Answer?.length || 0) > 32
            )
                throw connectivityError('dns_failed');
            const addresses = [];
            for (const answer of data.Answer || []) {
                if (answer.type === 5) {
                    publicHostname(answer.data);
                } else if (answer.type === 1 || answer.type === 28) {
                    if (isIP(answer.data) !== (answer.type === 1 ? 4 : 6))
                        throw connectivityError('dns_failed');
                    if (!isPublicConnectivityIp(answer.data))
                        throw connectivityError('unsafe_target');
                    addresses.push(answer.data);
                } else throw connectivityError('dns_failed');
            }
            return addresses;
        })
    );
    const addresses = [...new Set(answers.flat())];
    if (!addresses.length) throw connectivityError('dns_failed');
    return addresses[0];
}
