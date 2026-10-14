import unixLoader from './probe-network-unix.sh?raw';
import windowsLoader from './probe-network-windows.ps1?raw';
import { readProbeInstallation } from './probe-release.js';

export function isProbeCommandOrigin(value) {
    if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(value))
        return false;
    try {
        const url = new URL(value);
        return url.origin === value && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function probeTerminalAvailable(installation, terminal) {
    const verified = readProbeInstallation(installation);
    if (!verified?.distributionReady || !['unix', 'windows'].includes(terminal)) return false;
    // Keep verified scripts comfortably below Bash's per-argument OS limit.
    if (verified.release.bootstrap[terminal]?.size > 64 * 1024) return false;
    const targets = verified.targets.filter(({ target }) =>
        terminal === 'windows' ? target === 'windows-amd64' : target !== 'windows-amd64'
    );
    return targets.length > 0 && targets.every(({ available }) => available);
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const uuid = (value) =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const finiteTime = (value) => Number.isFinite(value) && value > 0;

/** Download a fixed release script, verify all bytes, then pass pairing data as arguments. */
export function buildProbeBootstrapCommand({
    installation,
    terminal,
    origin,
    window: pairingWindow,
    now,
    resume = false,
} = {}) {
    if (!probeTerminalAvailable(installation, terminal) || typeof resume !== 'boolean') return '';
    if (resume) {
        if (origin !== undefined || pairingWindow !== undefined || now !== undefined) return '';
    } else if (
        !isProbeCommandOrigin(origin) ||
        !pairingWindow ||
        !uuid(pairingWindow.id) ||
        pairingWindow.origin !== origin ||
        pairingWindow.status !== 'open' ||
        !finiteTime(pairingWindow.checkedAt) ||
        !finiteTime(pairingWindow.expiresAt) ||
        !finiteTime(now) ||
        now < pairingWindow.checkedAt ||
        now >= pairingWindow.expiresAt
    )
        return '';
    const release = readProbeInstallation(installation).release;
    const file = release.bootstrap[terminal];
    const tokens = {
        HASH: file.sha256,
        SIZE: String(file.size),
        URL: file.url,
        INVOCATION:
            terminal === 'windows'
                ? resume
                    ? '-Resume'
                    : `-Server '${origin}' -PairWindow '${pairingWindow.id}'`
                : resume
                  ? '--resume'
                  : '--server "$1" --pair-window "$2"',
    };
    const template = (terminal === 'windows' ? windowsLoader : unixLoader).replaceAll('\r\n', '\n');
    const source = template.replace(/@@([A-Z]+)@@/g, (_, key) => tokens[key] ?? '');
    if (source.includes('@@')) return '';
    return terminal === 'windows'
        ? source
        : `bash -c ${shellQuote(source)} --${resume ? '' : ` ${shellQuote(origin)} ${shellQuote(pairingWindow.id)}`}`;
}
