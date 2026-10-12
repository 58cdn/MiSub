import { digest, probeError, requireValue, randomToken } from './probe-contract.js';

export const PAIRING_BODY_BYTES = 8192;
export const PAIRING_TTL_MS = 300000;
export const PAIRING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function pairingBody(body, keys) {
    requireValue(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key)), 'invalid_pairing_request');
    return body;
}
export function pairingId(id) {
    requireValue(typeof id === 'string' && PAIRING_ID.test(id), 'invalid_pairing_request');
    return id;
}
export function pairingCode(value) {
    requireValue(typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{5}-?[0-9A-HJKMNP-TV-Z]{5}$/i.test(value), 'invalid_pairing_request');
    return value.toUpperCase().replace('-', '');
}
export function pairingStart(body) {
    pairingBody(body, ['windowId', 'name', 'version', 'platform', 'proofHash']);
    pairingId(body.windowId);
    requireValue(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 60 && !/[\x00-\x1f\x7f]/.test(body.name), 'invalid_pairing_request');
    requireValue(typeof body.version === 'string' && /^[A-Za-z0-9_.+-]{1,50}$/.test(body.version), 'invalid_pairing_request');
    requireValue(typeof body.platform === 'string' && /^[a-z0-9_-]{1,30}$/.test(body.platform), 'invalid_pairing_request');
    requireValue(typeof body.proofHash === 'string' && HEX.test(body.proofHash), 'invalid_pairing_request');
    return { ...body, name: body.name.trim() };
}
export function pairingToken(body) {
    pairingBody(body, ['windowId', 'id', 'deviceCode', 'proof']);
    pairingId(body.windowId); pairingId(body.id);
    requireValue(typeof body.deviceCode === 'string' && /^pdc1_[0-9a-f]{64}$/.test(body.deviceCode), 'invalid_pairing_request');
    requireValue(typeof body.proof === 'string' && HEX.test(body.proof), 'invalid_pairing_request');
    return body;
}
export function newPairingCodes() {
    const code = [...crypto.getRandomValues(new Uint8Array(10))].map(x => CODE_ALPHABET[x & 31]).join('');
    return { deviceCode: `pdc1_${randomToken()}`, userCode: `${code.slice(0, 5)}-${code.slice(5)}` };
}
export function pairingFingerprint(proofHash) {
    return proofHash.slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
}
export function samePairingHash(a, b) {
    let difference = a.length ^ b.length;
    for (let i = 0; i < 64; i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return difference === 0;
}
export function pairingRateLimit(seconds, code = 'pairing_rate_limited') {
    return Object.assign(probeError(code, 429), { retryAfterSeconds: Math.max(1, Math.min(3600, Math.ceil(seconds))) });
}
export function pairingDeviceHash(origin, deviceCode) {
    return digest(`misub-probe-device:v1\0${origin}\0${deviceCode}`);
}
