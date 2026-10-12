import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalIP } from '../../functions/services/diagnostics/contract.js';

const blockedV4 = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];
const blockedV6 = [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
];

function integer(address, family) {
    if (family === 4) return address.split('.').reduce((n, part) => (n << 8n) + BigInt(part), 0n);
    const [left, right] = address.split('::');
    const a = left ? left.split(':') : [];
    const b = right ? right.split(':') : [];
    const parts =
        right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
    return parts.reduce((n, part) => (n << 16n) + BigInt(`0x${part}`), 0n);
}
function within(address, prefix, bits, family) {
    const shift = BigInt((family === 4 ? 32 : 128) - bits);
    return integer(address, family) >> shift === integer(prefix, family) >> shift;
}

export function isPublicAddress(value) {
    const address = canonicalIP(value);
    const family = isIP(address || '');
    if (family === 4) return !blockedV4.some(([prefix, bits]) => within(address, prefix, bits, 4));
    // Conservatively accept global unicast only, excluding special-purpose space,
    // mapped IPv4, translation and transition mechanisms that can hide private IPs.
    return (
        family === 6 &&
        within(address, '2000::', 3, 6) &&
        !blockedV6.some(([prefix, bits]) => within(address, prefix, bits, 6))
    );
}

export async function resolvePinned(host, { allowLoopback = false, resolver = lookup } = {}) {
    const literal = canonicalIP(host);
    const records = literal
        ? [{ address: literal, family: isIP(literal) }]
        : await resolver(host, { all: true, verbatim: true });
    if (!Array.isArray(records) || !records.length || records.length > 16)
        throw new Error('address_rejected');
    // Reject mixed public/private answers, not merely the selected first answer.
    for (const record of records) {
        const localException =
            allowLoopback &&
            literal &&
            (literal === '127.0.0.1' || literal === '::1') &&
            record.address === literal;
        if (
            isIP(record.address) !== record.family ||
            (!localException && !isPublicAddress(record.address))
        )
            throw new Error('address_rejected');
    }
    return { address: canonicalIP(records[0].address), family: records[0].family };
}
