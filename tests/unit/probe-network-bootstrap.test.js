import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProbeBootstrapCommand } from '../../src/shared/probe-bootstrap-command.js';
import { probeInstallationCapabilities } from '../../src/shared/probe-release.js';
import { syntheticProbeReleaseCatalog } from '../fixtures/probe-release.js';

const directory = mkdtempSync(join(tmpdir(), 'misub-network-fixture-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const home = join(directory, 'home');
mkdirSync(home);
const configDirectory = join(home, '.misub-probe');
mkdirSync(configDirectory);
const configuration = 'synthetic existing configuration\n';
writeFileSync(join(configDirectory, 'probe.json'), configuration);
const fixtureEnvironment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    BASH_ENV: '',
    ENV: '',
};
function expectConfigurationPreserved() {
    expect(readdirSync(configDirectory)).toEqual(['probe.json']);
    expect(readFileSync(join(configDirectory, 'probe.json'), 'utf8')).toBe(configuration);
}
if (
    process.env.MISUB_INSTALLER_NATIVE_TARGET &&
    process.env.MISUB_INSTALLER_NATIVE_TARGET !== `${process.platform}-${process.arch}`
) {
    throw new Error('Installer fixture requires the selected native OS and architecture');
}
const bash =
    process.platform === 'win32'
        ? ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'].find(
              existsSync
          )
        : '/bin/bash';
const powershell =
    process.platform === 'win32'
        ? process.env.MISUB_TEST_POWERSHELL ||
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : null;
const bashPath = (path) =>
    path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const origin = 'https://fixture.invalid:8443';
const id = '11111111-1111-4111-8111-111111111111';
const scripts = {
    unix: 'printf "executed"; printf "|%s" "$@"\n',
    windows:
        'param([string]$Server,[string]$PairWindow,[switch]$Resume)\nWrite-Output ("executed|{0}|{1}|{2}" -f $Server,$PairWindow,$Resume)\n',
};
function commandFor(terminal, script = scripts[terminal], resume = false) {
    const fixture = syntheticProbeReleaseCatalog();
    Object.assign(fixture.release.bootstrap[terminal], {
        size: Buffer.byteLength(script),
        sha256: createHash('sha256').update(script).digest('hex'),
    });
    return buildProbeBootstrapCommand({
        terminal,
        installation: probeInstallationCapabilities(fixture),
        ...(resume
            ? { resume: true }
            : {
                  origin,
                  now: 1000,
                  window: { id, origin, checkedAt: 999, expiresAt: 2000, status: 'open' },
              }),
    });
}
const forbidden = [
    'http://release-assets.githubusercontent.com/fixture',
    'https://release-assets.githubusercontent.com.evil.invalid/fixture',
    'https://user@release-assets.githubusercontent.com/fixture',
    'https://release-assets.githubusercontent.com:444/fixture',
    'https://release-assets.githubusercontent.com/fixture#fragment',
    'https://release-assets.githubusercontent.com/fixture\\evil',
    'https://evil.invalid/fixture',
    '/relative',
];
const curl = join(directory, 'curl');
writeFileSync(
    curl,
    `#!/usr/bin/env bash
for url; do :; done
printf '%s\\n' "$url" >> "$FIXTURE_CALLS"
case "$FIXTURE_MODE" in
  timeout) exit 28 ;;
  http) printf '\\n404 '; exit 22 ;;
  redirect) printf '\\n302 %s' "$FIXTURE_LOCATION" ;;
  chain)
    case "$url" in
      https://github.com/*) printf '\\n302 https://release-assets.githubusercontent.com/fixture' ;;
      https://release-assets.githubusercontent.com/*) printf '\\n307 https://objects.githubusercontent.com/fixture' ;;
      *) cat "$FIXTURE_BODY"; printf '\\n200 ' ;;
    esac ;;
  *) cat "$FIXTURE_BODY"; printf '\\n200 '; if [ "$FIXTURE_MODE" = failed ]; then exit 18; fi ;;
esac
`
);
chmodSync(curl, 0o700);
function runUnix({
    mode = 'ok',
    body = scripts.unix,
    script = scripts.unix,
    location = '',
    resume = false,
} = {}) {
    const file = join(directory, 'body'),
        calls = join(directory, 'calls');
    writeFileSync(file, body);
    writeFileSync(calls, '');
    const launch =
        'export PATH="$FIXTURE_BIN:/usr/bin:/bin"; [ "$(command -v curl)" = "$FIXTURE_BIN/curl" ] || exit 99; ';
    const result = spawnSync(bash, ['-s'], {
        input: launch + commandFor('unix', script, resume),
        encoding: 'utf8',
        timeout: 10000,
        env: {
            ...fixtureEnvironment,
            HOME: bashPath(home),
            FIXTURE_BIN: bashPath(directory),
            FIXTURE_MODE: mode,
            FIXTURE_BODY: bashPath(file),
            FIXTURE_CALLS: bashPath(calls),
            FIXTURE_LOCATION: location,
        },
    });
    expectConfigurationPreserved();
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

describe.skipIf(!bash)('Unix short installer with an offline curl transport', () => {
    it.each(['', '\n', '\n\n'])('preserves exact script bytes with suffix %j', (suffix) => {
        const script = scripts.unix.trimEnd() + suffix;
        const result = runUnix({ script, body: script });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`executed|--server|${origin}|--pair-window|${id}`);
    });
    it('accepts both permitted CDN hops and isolates resume arguments', () => {
        const result = runUnix({ mode: 'chain', resume: true });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toHaveLength(3);
        expect(result.stdout).toBe('executed|--resume');
    });
    it.each(forbidden)('rejects redirect %s without requesting it', (location) => {
        const result = runUnix({ mode: 'redirect', location });
        expect(result.status).not.toBe(0);
        expect(result.calls, JSON.stringify(result.calls)).toHaveLength(1);
        expect(result.stdout).not.toContain('executed');
        expect(result.stderr).not.toContain(location);
    });
    it('bounds otherwise trusted redirect loops', () => {
        const result = runUnix({
            mode: 'redirect',
            location: 'https://objects.githubusercontent.com/loop',
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).toHaveLength(3);
        expect(result.stdout).toBe('');
    });
    it.each(['http', 'timeout', 'failed'])('never executes after transport failure %s', (mode) => {
        const result = runUnix({ mode });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('No installer was executed');
    });
    it.each([
        ['truncated', scripts.unix.slice(0, -1)],
        ['altered', scripts.unix.replace('executed', 'tampered')],
        ['NUL insertion', Buffer.from(`${scripts.unix}\0`)],
        ['NUL replacing LF', Buffer.from(scripts.unix.replace('\n', '\0'))],
        ['CR replacing LF', scripts.unix.replace('\n', '\r')],
        ['oversized', scripts.unix + 'x'.repeat(100000)],
        ['forged trailer', scripts.unix + '\n200 \n'],
        ['padded forged trailer', scripts.unix + '\n200 ' + '\n'.repeat(8192)],
    ])('rejects %s bytes before execution', (_, body) => {
        const result = runUnix({ body });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('No installer was executed');
    });
});

const handlerSource = `
using System; using System.Net; using System.Net.Http; using System.Threading; using System.Threading.Tasks;
public class OfflineInstallerHandler : HttpMessageHandler {
    public static int Calls;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        Calls++;
        string mode = Environment.GetEnvironmentVariable("FIXTURE_MODE");
        if (mode == "timeout") { var task = new TaskCompletionSource<HttpResponseMessage>(); task.SetCanceled(); return task.Task; }
        var response = new HttpResponseMessage(HttpStatusCode.OK);
        if (mode == "http") response.StatusCode = HttpStatusCode.NotFound;
        if (mode == "redirect" || (mode == "chain" && Calls < 3)) {
            response.StatusCode = HttpStatusCode.Redirect;
            response.Headers.TryAddWithoutValidation("Location", mode == "chain" ? (Calls == 1 ? "https://release-assets.githubusercontent.com/fixture" : "https://objects.githubusercontent.com/fixture") : Environment.GetEnvironmentVariable("FIXTURE_LOCATION"));
            response.Content = new ByteArrayContent(new byte[0]);
        } else response.Content = new ByteArrayContent(Convert.FromBase64String(Environment.GetEnvironmentVariable("FIXTURE_BODY")));
        return Task.FromResult(response);
    }
}`;
function runWindows({
    mode = 'ok',
    body = scripts.windows,
    script = scripts.windows,
    location = '',
    resume = false,
    policy = 'Undefined',
    policyScope = 'MachinePolicy',
    localPolicy = 'RemoteSigned',
} = {}) {
    const generated = commandFor('windows', script, resume);
    const transport = '[Net.Http.HttpClient]::new($handler)';
    expect(generated.split(transport)).toHaveLength(2);
    const command = generated.replace(
        transport,
        '[Net.Http.HttpClient]::new([OfflineInstallerHandler]::new())'
    );
    const test = `Add-Type -AssemblyName System.Net.Http
$compilerOptions = @{}
if ($PSVersionTable.PSVersion.Major -lt 6) { $compilerOptions.ReferencedAssemblies = @('System.Net.Http', 'System') }
Add-Type @compilerOptions -TypeDefinition @'
${handlerSource}
'@
function Get-ExecutionPolicy { param($Scope) if ($Scope -eq '${policyScope}') { return '${policy}' }; if ($Scope) { return 'Undefined' }; return '${localPolicy}' }
try { ${command} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 } finally { [Console]::Error.WriteLine('fixture_calls=' + [OfflineInstallerHandler]::Calls) }`;
    const result = spawnSync(
        powershell,
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))',
        ],
        {
            input: test,
            encoding: 'utf8',
            timeout: 15000,
            env: {
                ...fixtureEnvironment,
                FIXTURE_MODE: mode,
                FIXTURE_BODY: Buffer.from(body).toString('base64'),
                FIXTURE_LOCATION: location,
            },
        }
    );
    expectConfigurationPreserved();
    return result;
}
// Allow PowerShell startup and Add-Type compilation within the child's 15-second bound.
describe.skipIf(!powershell)(
    'Windows short installer with an offline HttpMessageHandler',
    { timeout: 20000 },
    () => {
        it('verifies a two-hop download and passes discrete arguments', () => {
            const result = runWindows({ mode: 'chain' });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout.trim()).toBe(`executed|${origin}|${id}|False`);
            expect(result.stderr).toContain('fixture_calls=3');
        });
        it('isolates resume and never sends a previous window', () => {
            const result = runWindows({ resume: true });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout.trim()).toBe('executed|||True');
        });
        it.each(forbidden)('rejects redirect %s without requesting it', (location) => {
            const result = runWindows({ mode: 'redirect', location });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('fixture_calls=1');
            expect(result.stderr).not.toContain(location);
        });
        it('bounds trusted redirect loops', () => {
            const result = runWindows({
                mode: 'redirect',
                location: 'https://objects.githubusercontent.com/loop',
            });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('fixture_calls=3');
        });
        it.each(['http', 'timeout'])('never executes after %s', (mode) => {
            const result = runWindows({ mode });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('No installer was executed');
        });
        it.each([
            ['truncated', scripts.windows.slice(0, -1)],
            ['altered', scripts.windows.replace('executed', 'tampered')],
            ['oversized', scripts.windows + 'x'.repeat(4000)],
        ])('rejects %s before script parsing', (_, body) => {
            const result = runWindows({ body });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('No installer was executed');
        });
        it('rejects a digest-matching malformed UTF-8 script', () => {
            const script = Buffer.concat([Buffer.from(scripts.windows), Buffer.from([0xff])]);
            const result = runWindows({ script, body: script });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('No installer was executed');
        });
        it.each(
            ['MachinePolicy', 'UserPolicy'].flatMap((policyScope) =>
                ['Restricted', 'AllSigned', 'RemoteSigned'].map((policy) => [policyScope, policy])
            )
        )('honors organization %s %s before network access', (policyScope, policy) => {
            const result = runWindows({ policy, policyScope });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('organization script policy');
            expect(result.stderr).toContain('fixture_calls=0');
        });
        it('honors local AllSigned before network access', () => {
            const result = runWindows({ localPolicy: 'AllSigned' });
            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('signed scripts are required');
            expect(result.stderr).toContain('fixture_calls=0');
        });
    }
);
