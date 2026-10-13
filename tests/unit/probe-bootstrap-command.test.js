import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    buildProbeBootstrapCommand,
    isProbeCommandOrigin,
    probeTerminalAvailable,
} from '../../src/shared/probe-bootstrap-command.js';
import {
    syntheticProbeInstallation,
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
const read = (path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
const bash =
    process.platform === 'win32'
        ? ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'].find(
              existsSync
          )
        : 'bash';

describe('auditable one-command probe bootstrap', () => {
    it('never supplies an installation or resume command from the explicit unpublished fixture', () => {
        for (const terminal of ['unix', 'windows']) {
            const installation = unpublishedProbeInstallation();
            expect(buildProbeBootstrapCommand({ ...options(terminal), installation })).toBe('');
            expect(buildProbeBootstrapCommand({ installation, terminal, resume: true })).toBe('');
        }
    });
    it('downloads and verifies the fixed Unix script before calling its actual private path', () => {
        const command = buildProbeBootstrapCommand(options());
        expect(command).toMatch(/^bash -c '/);
        expect(command).toContain(
            'https://github.com/58cdn/MiSub/releases/download/probe-v9.9.9/install.sh'
        );
        expect(command).toContain('a'.repeat(64));
        expect(command).toContain('12345');
        expect(command).toContain(
            'command bash "$work_dir/client" --server "$1" --pair-window "$2"'
        );
        expect(command).toMatch(new RegExp(` -- '${origin}' '${id}'$`));
        expect(command.indexOf('bootstrap_download\ncommand bash')).toBeGreaterThan(0);
        expect(command).not.toMatch(/@@|curl[^\n]*\|.*bash|misub-probe --pair/);
    });
    it('downloads the raw Windows executable and verifies locked bytes and capabilities before native setup', () => {
        const command = buildProbeBootstrapCommand(options('windows'));
        expect(command).toMatch(/^& \{/);
        expect(command).toContain("'/misub-probe-windows-amd64.exe'");
        expect(command).toContain('[IO.FileShare]::Read');
        expect(command).toContain('$guard.Length -ne $probeRelease.Size');
        expect(command).toContain('Get-FileHash -InputStream $guard');
        const setup = `Invoke-ProbeCommand $executable @('--setup', '--server', '${origin}', '--pair-window', '${id}', '--config', $environment.Config)`;
        expect(command).toContain(setup);
        expect(command.indexOf('release_capabilities_mismatch')).toBeLessThan(
            command.indexOf(setup)
        );
        expect(command.lastIndexOf('$guard.Dispose()')).toBeGreaterThan(command.indexOf(setup));
        expect(command).not.toMatch(
            /@@|install\.ps1|Invoke-Expression|ScriptBlock\]::Create|EncodedCommand|ExecutionPolicy|Unblock-File/
        );
    });
    it.each(['unix', 'windows'])(
        'separates %s resume from every old pairing parameter',
        (terminal) => {
            const command = buildProbeBootstrapCommand({
                installation: syntheticProbeInstallation(),
                terminal,
                resume: true,
            });
            expect(command).toContain('--resume');
            expect(command).not.toContain(origin);
            expect(command).not.toContain(id);
            if (terminal === 'windows')
                expect(command).toContain(
                    "@('--setup', '--resume', '--config', $environment.Config)"
                );
            else expect(command).toContain('command bash "$work_dir/client" --resume');
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
                const result = spawnSync(bash, ['-n'], {
                    input: buildProbeBootstrapCommand(settings),
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
                const result = spawnSync(
                    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-Command', parser],
                    {
                        input: buildProbeBootstrapCommand(settings),
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
