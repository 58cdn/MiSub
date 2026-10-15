#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1')

$script:Passed = 0
function Check([bool] $Condition, [string] $Name) {
    if (-not $Condition) { throw ('FAIL: ' + $Name) }
    $script:Passed++
    Write-Host ('PASS: ' + $Name)
}
function Reject([scriptblock] $Action, [string] $Code, [string] $Name) {
    try { & $Action } catch {
        Check ($_.Exception.Message.Contains($Code)) $Name
        return
    }
    throw ('FAIL accepted: ' + $Name)
}

foreach ($validVersion in @('0.0.1-alpha.1', '0.0.1-alpha.9', '0.0.1-alpha.10', ('0.0.1-alpha.' + ('9' * 52)))) {
    Check (Test-ProbeReleaseVersion $validVersion) ('valid release version: ' + $validVersion)
}
foreach ($invalidVersion in @('0.1.0', '0.2.0', '0.3.0', '0.0.1', '0.0.1-alpha.0', '0.0.1-alpha.01', '0.0.1-alpha.-1', '0.0.1-beta.1', '0.0.1-rc.1', '0.0.1-alpha.1.sha.abcdef012345', '0.0.1-alpha.1+build', '0.0.1.261015.1', 'v0.0.1-alpha.1', ('0.0.1-alpha.' + ('9' * 54)), "0.0.1-alpha.1`n")) {
    Check (-not (Test-ProbeReleaseVersion $invalidVersion)) 'invalid release version refused before download'
}

Reject { Assert-ProbeRelease @{ Version = '0.0.1-alpha.1'; SourceCommit = ('0' * 40); Sha256 = ('a' * 64); Size = 2048 } } 'release_unavailable' 'zero revision rejected before download'
Reject { Assert-ProbeRelease @{ Version = '0.0.1-alpha.1'; SourceCommit = (('a' * 40) + "`n"); Sha256 = ('a' * 64); Size = 2048 } } 'release_unavailable' 'revision newline rejected before download'

Initialize-ProbeNative
$normalMessage = [MiSub.Bootstrap.Native]::RegularUserError($false, $false, $false)
Check ($null -eq $normalMessage) 'ordinary token accepted'
Check ($null -eq [MiSub.Bootstrap.Native]::RegularUserError($false, $false, $true)) 'filtered built-in administrator is not rejected by account identity'
$adminMessage = [MiSub.Bootstrap.Native]::RegularUserError($false, $true, $false)
Check ($adminMessage.Contains('enabled administrator role') -and $adminMessage.Contains('Start menu') -and $adminMessage.Contains('inherit elevation')) 'administrator-token rejection explains non-elevated desktop launch'
$builtInMessage = [MiSub.Bootstrap.Native]::RegularUserError($false, $true, $true)
Check ($builtInMessage.Contains('built-in Administrator') -and $builtInMessage.Contains('existing standard Windows user') -and $builtInMessage.Contains('may keep full privileges')) 'full built-in administrator explains supported existing-account path'
foreach ($system in @($false, $true)) {
    foreach ($admin in @($false, $true)) {
        foreach ($builtIn in @($false, $true)) {
            $message = [MiSub.Bootstrap.Native]::RegularUserError($system, $admin, $builtIn)
            Check (($null -ne $message) -eq ($system -or $admin)) 'complete synthetic identity matrix preserves the permission boundary'
            if ($system) { Check ($message.Contains('SYSTEM') -and $message.Contains('Sign in')) 'SYSTEM rejection has explicit interactive-user guidance' }
        }
    }
}
$builtInSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-500')
Check ($builtInSid.IsWellKnown([Security.Principal.WellKnownSidType]::AccountAdministratorSid)) 'built-in account identification uses SID independent of account name'
$ordinarySid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-1001')
Check (-not $ordinarySid.IsWellKnown([Security.Principal.WellKnownSidType]::AccountAdministratorSid)) 'ordinary account SID is not the built-in administrator'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $enabledAdmin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($identity.IsSystem -or $enabledAdmin) {
        Reject { Assert-ProbeRegularUser } 'bootstrap_requires_regular_user:' 'real current identity is rejected when privileged'
    } else {
        Assert-ProbeRegularUser
        Check $true 'real ordinary current identity passes read-only permission check'
    }
} finally { $identity.Dispose() }
Check ([MiSub.Bootstrap.Native]::Architecture() -eq 'windows-amd64') 'native Windows x64 mapping'
Reject { [MiSub.Bootstrap.Native]::MapArchitecture(12) } 'unsupported_windows_architecture' 'native ARM64 refused even when shell emulates x64'
Reject { [MiSub.Bootstrap.Native]::MapArchitecture(0) } 'unsupported_windows_architecture' 'native x86 refused'
Reject { Invoke-ProbeBootstrap 'https://fixture.invalid' '00000000-0000-0000-0000-000000000000' } 'release_unavailable' 'unavailable template fails before network or pairing'
foreach ($badPath in @('relative.exe', '\\server\share\x', 'C:\safe\..\x', 'C:\safe\file:stream', 'C:\safe\CON.txt', 'C:\safe\tail.', 'C:\safe\tail ', 'C:/safe/x')) {
    Reject { [MiSub.Bootstrap.Native]::LocalPath($badPath) } 'bootstrap_' ('unsafe path rejected: ' + $badPath)
}
Check ((Assert-ProbePairingOptions 'https://fixture.invalid:8443/' '00000000-0000-0000-0000-000000000000') -eq 'https://fixture.invalid:8443') 'HTTPS origin normalized'
foreach ($badOrigin in @('http://fixture.invalid', 'https://user@fixture.invalid', 'https://fixture.invalid/path', 'https://fixture.invalid?x=1', 'https://fixture.invalid/#fragment', 'https://fixture.invalid;write-host')) {
    Reject { Assert-ProbePairingOptions $badOrigin '00000000-0000-0000-0000-000000000000' } 'invalid_pairing_options' 'untrusted pairing origin rejected'
}
Reject { Assert-ProbePairingOptions 'https://fixture.invalid' 'window;command' } 'invalid_pairing_options' 'window injection rejected'
foreach ($badRedirect in @('http://release-assets.githubusercontent.com/x', 'https://evil.invalid/x', 'https://release-assets.githubusercontent.com.evil.invalid/x', 'https://user@release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com:444/x')) {
    Reject { Assert-ProbeAssetRedirect ([Uri] $badRedirect) } 'redirect_refused' 'unsafe asset redirect rejected'
}
Assert-ProbeAssetRedirect ([Uri] 'https://release-assets.githubusercontent.com/asset?token=fixture')
Check $true 'exact HTTPS asset host permitted'

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('misub-bootstrap-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$workspace = $null
try {
    $workspace = New-Object MiSub.Bootstrap.Workspace($fixtureRoot)
    $directory = $workspace.Path
    $acl = Get-Acl -LiteralPath $directory
    Check ($acl.AreAccessRulesProtected -and $acl.Access.Count -eq 2) 'temporary directory has exact protected private ACL'
    Reject { [IO.Directory]::Move($directory, $directory + '-moved') } '' 'directory lease prevents substitution'
    $asset = Join-Path $directory 'misub-probe-windows-amd64.exe'
    [IO.File]::WriteAllText($asset, 'fixture')
    $workspace.Dispose(); $workspace = $null
    Check (-not [IO.Directory]::Exists($directory)) 'cleanup removes only pinned fixture asset and empty directory'

    Add-Type -AssemblyName System.Net.Http
    $compilerOptions = @{}
    if ($PSVersionTable.PSVersion.Major -lt 6) { $compilerOptions.ReferencedAssemblies = @('System.Net.Http', 'System') }
    Add-Type @compilerOptions -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public sealed class ProbeFixtureHandler : HttpMessageHandler {
    public static string Mode = "ok";
    public static int Calls;
    public static string LastUri;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        Calls++; LastUri = request.RequestUri.AbsoluteUri;
        var response = new HttpResponseMessage(HttpStatusCode.OK);
        if (Mode == "missing") response.StatusCode = HttpStatusCode.NotFound;
        if (Mode == "rate") response.StatusCode = (HttpStatusCode)429;
        if (Mode == "retry" && Calls < 3 || Mode == "unavailable") response.StatusCode = HttpStatusCode.ServiceUnavailable;
        if (Mode == "timeout") throw new TaskCanceledException("fixture timeout");
        if (Mode == "redirect") { response.StatusCode = HttpStatusCode.Redirect; response.Headers.Location = new Uri("https://evil.invalid/exe"); }
        if (Mode == "redirect-loop" || Mode == "redirect-ok" && Calls == 1) { response.StatusCode = HttpStatusCode.Redirect; response.Headers.Location = new Uri("https://release-assets.githubusercontent.com/fixture"); }
        byte[] data = new byte[Mode == "oversize" ? 2049 : Mode == "short" ? 2047 : 2048];
        for (int i = 0; i < data.Length; i++) data[i] = 65;
        response.Content = new ByteArrayContent(data);
        response.Content.Headers.ContentLength = 2048;
        return Task.FromResult(response);
    }
}
'@
    function New-ProbeDownloadClient { return New-Object Net.Http.HttpClient((New-Object ProbeFixtureHandler)) }
    function Start-Sleep { param([int] $Seconds) }
    $script:ProbeRelease = @{ Version = '0.0.1-alpha.1'; SourceCommit = ('a' * 40); Sha256 = ''; Size = 2048 }
    $bytes = New-Object byte[] 2048
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = 65 }
    $sha = [Security.Cryptography.SHA256]::Create()
    $script:ProbeRelease.Sha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    $sha.Dispose()
    $downloadWorkspace = New-Object MiSub.Bootstrap.Workspace($fixtureRoot)
    try {
        $download = Join-Path $downloadWorkspace.Path 'misub-probe-windows-amd64.exe'
        Receive-ProbeAsset $script:ProbeRelease $download
        Check (([IO.FileInfo] $download).Length -eq 2048 -and [ProbeFixtureHandler]::Calls -eq 1) 'mock download validates exact byte count and SHA256'
        Check ([ProbeFixtureHandler]::LastUri -eq 'https://github.com/58cdn/MiSub/releases/download/probe-v0.0.1-alpha.1/misub-probe-windows-amd64.exe') 'download URL pins repository tag and raw asset'
        [IO.File]::Delete($download)
        foreach ($scenario in @(@('missing', 'asset_unavailable'), @('rate', 'client_error'), @('redirect', 'redirect_refused'), @('oversize', 'size_mismatch'), @('short', 'checksum_mismatch'))) {
            [ProbeFixtureHandler]::Mode = $scenario[0]; [ProbeFixtureHandler]::Calls = 0
            Reject { Receive-ProbeAsset $script:ProbeRelease $download } $scenario[1] ('download fails closed: ' + $scenario[0])
            Check ([ProbeFixtureHandler]::Calls -eq 1 -and -not [IO.File]::Exists($download)) 'permanent download error neither retries nor leaves executable'
        }
        [ProbeFixtureHandler]::Mode = 'ok'; [ProbeFixtureHandler]::Calls = 0
        $wrong = $script:ProbeRelease.Clone(); $wrong.Sha256 = '0' * 64
        Reject { Receive-ProbeAsset $wrong $download } 'checksum_mismatch' 'hash mismatch rejected before execution'
        Check (-not [IO.File]::Exists($download)) 'hash mismatch removes downloaded file'
        [ProbeFixtureHandler]::Mode = 'retry'; [ProbeFixtureHandler]::Calls = 0
        Receive-ProbeAsset $script:ProbeRelease $download
        Check ([ProbeFixtureHandler]::Calls -eq 3) 'transient download retries bounded at three'
        [IO.File]::Delete($download)
        foreach ($mode in @('unavailable', 'timeout')) {
            [ProbeFixtureHandler]::Mode = $mode; [ProbeFixtureHandler]::Calls = 0
            Reject { Receive-ProbeAsset $script:ProbeRelease $download } 'release_download_failed' ('bounded transient failure: ' + $mode)
            Check ([ProbeFixtureHandler]::Calls -eq 3 -and -not [IO.File]::Exists($download)) 'exhausted retries leave no executable'
        }
        [ProbeFixtureHandler]::Mode = 'redirect-loop'; [ProbeFixtureHandler]::Calls = 0
        Reject { Receive-ProbeAsset $script:ProbeRelease $download } 'redirect_refused' 'redirect chain has a fixed limit'
        Check ([ProbeFixtureHandler]::Calls -eq 4) 'redirect loop does not trigger retry loops'
        [ProbeFixtureHandler]::Mode = 'redirect-ok'; [ProbeFixtureHandler]::Calls = 0
        Receive-ProbeAsset $script:ProbeRelease $download
        Check ([ProbeFixtureHandler]::Calls -eq 2 -and [ProbeFixtureHandler]::LastUri -eq 'https://release-assets.githubusercontent.com/fixture') 'official asset redirect completes with matching hash'
    } finally { $downloadWorkspace.Dispose() }

    $script:FixtureRoot = $fixtureRoot
    $script:FixtureConfig = Join-Path $fixtureRoot 'fixture-config.json'
    $script:Calls = New-Object 'Collections.Generic.List[string]'
    $script:Scenario = 'new'
    $realEnvironment = ${function:Get-ProbeEnvironment}
    $realUserGuard = ${function:Assert-ProbeRegularUser}
    function Get-ProbeEnvironment { return @{ Platform = 'windows-amd64'; Config = $script:FixtureConfig } }
    function New-ProbeWorkspace {
        $script:WorkspaceCalls++
        return New-Object MiSub.Bootstrap.Workspace($script:FixtureRoot)
    }
    function Receive-ProbeAsset {
        param($Release, $Destination)
        $script:Calls.Add('download')
        [IO.File]::WriteAllBytes($Destination, $bytes)
    }
    function Invoke-ProbeCommand {
        param([string] $Executable, [string[]] $Arguments, [switch] $Json, [switch] $Text)
        if (-not [IO.Path]::IsPathRooted($Executable) -or [IO.Path]::GetFileName($Executable) -ne 'misub-probe-windows-amd64.exe') { throw 'fixture_nonabsolute_executable' }
        $script:Calls.Add(($Arguments -join '|'))
        switch ($Arguments[0]) {
            '--capabilities' {
                if ($script:Scenario -eq 'old') { return 'misub-probe 0.1.0' }
                return ('misub-probe-bootstrap-v1 0.0.1-alpha.1 ' + ('a' * 40) + ' windows-amd64')
            }
            '--setup' {
                if ($script:Scenario -eq 'installed') { throw 'setup_existing_installation_preserved_use_resume' }
                if ($script:Scenario -eq 'concurrent') { throw 'setup_in_progress_or_lock_unsafe' }
                if ($script:Scenario -eq 'expired') { throw 'pairing_cancelled_or_expired_cancel_window_in_misub' }
                if ($Arguments -contains '--resume') {
                    if ($Arguments -contains '--server' -or $Arguments -contains '--pair-window') { throw 'fixture_resume_received_pairing_parameters' }
                    if ($script:Scenario -eq 'mismatch') { throw 'installation_resume_mismatch' }
                    return
                }
                [IO.File]::WriteAllText($script:FixtureConfig, 'offline fixture, no credential')
                if ($script:Scenario -eq 'start-failed') { throw 'setup_start_failed_configuration_preserved_use_resume' }
            }
            default { throw 'fixture_unexpected_command' }
        }
    }
    function Reset-Fixture([string] $Scenario) {
        $script:Scenario = $Scenario; $script:Calls.Clear(); $script:WorkspaceCalls = 0
        if ([IO.File]::Exists($script:FixtureConfig)) { [IO.File]::Delete($script:FixtureConfig) }
    }
    $origin = 'https://fixture.invalid'
    $window = '00000000-0000-0000-0000-000000000000'
    $fixtureEnvironment = ${function:Get-ProbeEnvironment}
    Set-Item Function:Get-ProbeEnvironment $realEnvironment
    try {
        foreach ($rejectedContext in @(@($false, $true, $false), @($false, $true, $true), @($true, $true, $false))) {
            $script:RejectedContext = $rejectedContext
            function Assert-ProbeRegularUser {
                throw [MiSub.Bootstrap.Native]::RegularUserError($script:RejectedContext[0], $script:RejectedContext[1], $script:RejectedContext[2])
            }
            Reset-Fixture 'permission-rejected'
            Reject { Invoke-ProbeBootstrap $origin $window } 'bootstrap_requires_regular_user:' 'privileged context rejected through the real environment preflight'
            Check ($script:WorkspaceCalls -eq 0 -and $script:Calls.Count -eq 0 -and -not [IO.File]::Exists($script:FixtureConfig)) 'permission rejection prevents workspace creation, download, CLI execution and credentials'
        }
    } finally {
        Set-Item Function:Get-ProbeEnvironment $fixtureEnvironment
        Set-Item Function:Assert-ProbeRegularUser $realUserGuard
    }
    Reset-Fixture 'new'
    Invoke-ProbeBootstrap $origin $window
    Check (($script:Calls -join ',') -eq ('download,--capabilities,--setup|--server|' + $origin + '|--pair-window|' + $window + '|--config|' + $script:FixtureConfig)) 'new installation invokes native setup once through absolute verified executable'
    $script:Calls.Clear()
    Reject { Invoke-ProbeBootstrap $origin $window } 'existing_configuration_preserved' 'existing configuration protected before download'
    Check ($script:Calls.Count -eq 0) 'existing configuration does not cause download or credential exchange'
    Reset-Fixture 'old'
    Reject { Invoke-ProbeBootstrap $origin $window } 'capabilities_mismatch' 'old CLI refused before pairing'
    Check ($script:Calls.Count -eq 2) 'capability mismatch performs no management actions'
    Reset-Fixture 'expired'
    Reject { Invoke-ProbeBootstrap $origin $window } 'expired' 'expired pairing stops installation'
    Check ($script:Calls.Count -eq 3 -and @($script:Calls | Where-Object { $_ -like '--setup|*' }).Count -eq 1 -and -not [IO.File]::Exists($script:FixtureConfig)) 'expired setup is never automatically retried'
    Reset-Fixture 'start-failed'
    Reject { Invoke-ProbeBootstrap $origin $window } 'start_failed' 'start failure preserves paired configuration'
    Check ([IO.File]::Exists($script:FixtureConfig)) 'paired configuration remains recoverable'
    $script:Calls.Clear(); $script:Scenario = 'resume-installed'
    $preservedConfig = [IO.File]::ReadAllText($script:FixtureConfig)
    Invoke-ProbeBootstrap -ResumeExisting
    Check (($script:Calls -join ',') -eq ('download,--capabilities,--setup|--resume|--config|' + $script:FixtureConfig)) 'explicit resume invokes native setup without pairing parameters'
    Check ([IO.File]::ReadAllText($script:FixtureConfig) -ceq $preservedConfig) 'resume preserves configuration bytes'
    $script:Calls.Clear(); $script:Scenario = 'mismatch'
    Reject { Invoke-ProbeBootstrap $origin $window -ResumeExisting } 'installation_resume_mismatch' 'resume protects different installed version'
    Check ($script:Calls.Count -eq 3 -and [IO.File]::ReadAllText($script:FixtureConfig) -ceq $preservedConfig) 'version mismatch has no fallback and preserves configuration'
    Reset-Fixture 'installed'
    Reject { Invoke-ProbeBootstrap $origin $window } 'existing_installation_preserved' 'native setup protects existing installation'
    Check ($script:Calls.Count -eq 3 -and -not [IO.File]::Exists($script:FixtureConfig)) 'existing installation has no fallback pairing or reinstall'
    Reset-Fixture 'concurrent'
    Reject { Invoke-ProbeBootstrap $origin $window } 'setup_in_progress' 'concurrent native setup failure is preserved'
    Check ($script:Calls.Count -eq 3 -and -not [IO.File]::Exists($script:FixtureConfig)) 'concurrent failure never retries setup or writes configuration'
} finally {
    if ($null -ne $workspace) { $workspace.Dispose() }
    if ($fixtureRoot -and [IO.Path]::GetFileName($fixtureRoot).StartsWith('misub-bootstrap-fixture-')) {
        $configFixture = Join-Path $fixtureRoot 'fixture-config.json'
        if ([IO.File]::Exists($configFixture)) { [IO.File]::Delete($configFixture) }
        try { [IO.Directory]::Delete($fixtureRoot, $false) } catch { Write-Warning 'Fixture directory could not be removed; retained for diagnosis.' }
    }
}
Write-Host ('Passed ' + $script:Passed + ' offline Windows bootstrap assertions; no network, pairing, installation or process start was performed.')
