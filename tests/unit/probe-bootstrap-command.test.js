import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import catalog from '../../detector/release-catalog.json';
import { probeInstallationCapabilities } from '../../src/shared/probe-release.js';
import {
    buildProbeBootstrapCommand,
    isProbeCommandOrigin,
    probeTerminalAvailable,
} from '../../src/shared/probe-bootstrap-command.js';
import {
    syntheticProbeInstallation,
    syntheticProbeReleaseCatalog,
    unpublishedProbeInstallation,
} from '../fixtures/probe-release.js';

const origin = 'https://misub.fixture.invalid';
const id = '11111111-1111-4111-8111-111111111111';
const now = 1000000;
const options = (terminal = 'unix') => ({
    installation: syntheticProbeInstallation(),
    terminal,
    origin,
    now,
    window: { id, origin, status: 'open', checkedAt: now - 1000, expiresAt: now + 200000 },
});
const productionOptions = (terminal, resume = false) => ({
    ...(resume ? { terminal, resume: true } : options(terminal)),
    installation: probeInstallationCapabilities(catalog),
});
const read = (path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
const bash =
    process.platform === 'win32'
        ? ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'].find(
              existsSync
          )
        : 'bash';

describe('auditable one-command probe bootstrap', () => {
    it.each(['unix', 'windows'])(
        'pins the %s script and passes only public arguments',
        (terminal) => {
            for (const resume of [false, true]) {
                const fixture = syntheticProbeInstallation();
                const command = buildProbeBootstrapCommand({
                    ...(resume ? { terminal, resume: true } : options(terminal)),
                    installation: fixture,
                });
                const file = fixture.release.bootstrap[terminal];
                expect(command).toContain(file.url);
                expect(command).toContain(file.sha256);
                expect(command).toContain(String(file.size));
                expect(command).not.toMatch(
                    /@@|Set-ExecutionPolicy|\s-ExecutionPolicy\s|EncodedCommand|Invoke-Expression/
                );
                expect(command.length).toBeLessThan(terminal === 'unix' ? 1900 : 3200);
                if (resume) {
                    expect(command).not.toContain(origin);
                    expect(command).not.toContain(id);
                    expect(command).toContain(terminal === 'unix' ? '--resume' : '-Resume');
                } else {
                    expect(command).toContain(origin);
                    expect(command).toContain(id);
                    expect(command).toContain(
                        terminal === 'unix' ? '--server "$1" --pair-window "$2"' : '-Server'
                    );
                }
            }
        }
    );
    it.each(['unix', 'windows'])(
        'offers no %s command while production distribution is paused',
        (terminal) => {
            for (const resume of [false, true]) {
                expect(buildProbeBootstrapCommand(productionOptions(terminal, resume))).toBe('');
            }
            expect(probeTerminalAvailable(probeInstallationCapabilities(catalog), terminal)).toBe(
                false
            );
            const example = read(`../../docs/examples/probe-install-${terminal}.txt`);
            expect(example).not.toMatch(/releases\/download|bash -c|Invoke-WebRequest/);
        }
    );
    it('binds each platform to its script rather than binary digest', () => {
        const fixture = syntheticProbeReleaseCatalog();
        fixture.release.bootstrap.unix.sha256 = 'e'.repeat(64);
        fixture.release.bootstrap.windows.sha256 = 'd'.repeat(64);
        for (const terminal of ['unix', 'windows']) {
            const command = buildProbeBootstrapCommand({
                ...options(terminal),
                installation: probeInstallationCapabilities(fixture),
            });
            expect(command).toContain(fixture.release.bootstrap[terminal].sha256);
            expect(command).not.toContain('a'.repeat(64));
        }
    });
    it.each(['unix', 'windows'])(
        'rejects an oversized %s script before offering an install window',
        (terminal) => {
            const fixture = syntheticProbeReleaseCatalog();
            fixture.release.bootstrap[terminal].size = 65537;
            const installation = probeInstallationCapabilities(fixture);
            expect(probeTerminalAvailable(installation, terminal)).toBe(false);
            expect(buildProbeBootstrapCommand({ ...options(terminal), installation })).toBe('');
        }
    );
    it.each(['unix', 'windows'])(
        'fails closed for unavailable %s release and mixed resume input',
        (terminal) => {
            expect(
                buildProbeBootstrapCommand({
                    ...options(terminal),
                    installation: unpublishedProbeInstallation(),
                })
            ).toBe('');
            expect(buildProbeBootstrapCommand({ ...options(terminal), resume: true })).toBe('');
            const fixture = syntheticProbeReleaseCatalog();
            fixture.release.bootstrap[terminal].url = 'https://attacker.invalid/install';
            expect(
                buildProbeBootstrapCommand({
                    ...options(terminal),
                    installation: probeInstallationCapabilities(fixture),
                })
            ).toBe('');
        }
    );
    it.each(['unix', 'windows'])(
        'separates %s resume from every old pairing parameter',
        (terminal) => {
            const command = buildProbeBootstrapCommand({
                installation: syntheticProbeInstallation(),
                terminal,
                resume: true,
            });
            expect(command).toContain(terminal === 'windows' ? '-Resume' : '--resume');
            expect(command).not.toContain(origin);
            expect(command).not.toContain(id);
            if (terminal === 'windows') expect(command).toContain('& $installer -Resume');
            else expect(command).toContain('command bash -c "$body" -- --resume');
            expect(buildProbeBootstrapCommand({ ...options(terminal), resume: true })).toBe('');
        }
    );
    it.each([
        [
            'cancelled',
            (value) => {
                value.window.status = 'cancelled';
            },
        ],
        [
            'expired state',
            (value) => {
                value.window.status = 'expired';
            },
        ],
        [
            'expired clock',
            (value) => {
                value.now = value.window.expiresAt;
            },
        ],
        [
            'clock before response',
            (value) => {
                value.now = value.window.checkedAt - 1;
            },
        ],
        [
            'invalid timestamp',
            (value) => {
                value.now = NaN;
            },
        ],
        [
            'other origin',
            (value) => {
                value.window.origin = 'https://other.invalid';
            },
        ],
        [
            'invalid ID',
            (value) => {
                value.window.id = "'; touch PWN; #";
            },
        ],
        [
            'invalid terminal',
            (value) => {
                value.terminal = 'other';
            },
        ],
        [
            'unknown capabilities',
            (value) => {
                value.installation = { available: true };
            },
        ],
        [
            'missing window',
            (value) => {
                value.window = null;
            },
        ],
    ])('does not emit a command for %s', (_, mutate) => {
        const value = options();
        mutate(value);
        expect(buildProbeBootstrapCommand(value)).toBe('');
    });
    it.each([
        "https://bad'host.invalid",
        'https://host.invalid/$(touch-pwn)',
        'https://user:pass@host.invalid',
        'http://host.invalid',
        'https://host.invalid/',
        'https://host.invalid?x=y',
        'https://host.invalid:443',
        'https://HOST.invalid',
        'https://host.invalid\n',
        'https://host.invalid:99999',
    ])('rejects noncanonical or shell-unsafe origins: %s', (value) => {
        expect(isProbeCommandOrigin(value)).toBe(false);
        expect(buildProbeBootstrapCommand({ ...options(), origin: value })).toBe('');
    });
    it('supports canonical HTTPS origins with a nondefault port', () => {
        const value = options();
        value.origin += ':8443';
        value.window.origin = value.origin;
        expect(buildProbeBootstrapCommand(value)).not.toBe('');
    });
    it('requires all four Unix targets and only the Windows x64 target for its native loader', () => {
        expect(probeTerminalAvailable(syntheticProbeInstallation(['darwin-arm64']), 'unix')).toBe(
            false
        );
        expect(
            probeTerminalAvailable(syntheticProbeInstallation(['windows-amd64']), 'windows')
        ).toBe(true);
        expect(probeTerminalAvailable(syntheticProbeInstallation(['windows-amd64']), 'unix')).toBe(
            false
        );
    });
    it('shares the exact audited Windows safety helpers with the advanced bootstrap', () => {
        const source = read('../../detector/bootstrap/install.ps1');
        const template = read('../../src/shared/probe-bootstrap-windows.ps1');
        const fragment = source.slice(
            source.indexOf('function Initialize-ProbeNative {'),
            source.indexOf('function Invoke-ProbeBootstrap {')
        );
        expect(fragment.length).toBeGreaterThan(1000);
        expect(template).toContain(fragment);
    });
    it('shares the exact audited Unix download and private-directory helpers with the installer', () => {
        const source = read('../../detector/bootstrap/install.sh');
        const template = read('../../src/shared/probe-bootstrap-unix.sh');
        for (const name of [
            'bootstrap_error',
            'bootstrap_platform',
            'bootstrap_stat',
            'bootstrap_home',
            'bootstrap_private_directory',
            'bootstrap_cleanup',
            'bootstrap_download',
        ]) {
            const start = source.indexOf(`${name}() {`),
                end = source.indexOf('\n}\n', start) + 3;
            expect(start).toBeGreaterThan(0);
            expect(template).toContain(source.slice(start, end));
        }
    });
    it.skipIf(!bash)(
        'parses complete Unix install and resume commands with Bash without executing them',
        () => {
            for (const settings of [
                options(),
                { installation: syntheticProbeInstallation(), terminal: 'unix', resume: true },
            ]) {
                const command = buildProbeBootstrapCommand(settings);
                expect(command).not.toBe('');
                const result = spawnSync(bash, ['-n'], {
                    input: command,
                    encoding: 'utf8',
                    timeout: 10000,
                });
                expect(result.error).toBeUndefined();
                expect(result.stderr).toBe('');
                expect(result.status).toBe(0);
            }
        }
    );
    it.skipIf(process.platform !== 'win32')(
        'parses complete native commands with Windows PowerShell 5.1 without executing them',
        () => {
            const parser =
                '$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if($errors.Count){[Console]::Error.WriteLine(($errors.Message -join "; "));exit 1}';
            for (const settings of [
                options('windows'),
                { installation: syntheticProbeInstallation(), terminal: 'windows', resume: true },
            ]) {
                const command = buildProbeBootstrapCommand(settings);
                expect(command).not.toBe('');
                const result = spawnSync(
                    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-Command', parser],
                    {
                        input: command,
                        encoding: 'utf8',
                        timeout: 10000,
                    }
                );
                expect(result.error).toBeUndefined();
                expect(result.stderr).toBe('');
                expect(result.status).toBe(0);
            }
        }
    );
});
