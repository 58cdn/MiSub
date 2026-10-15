& {
    if ($PSVersionTable.PSVersion -lt [Version]'5.1') { throw 'PowerShell_5_1_or_newer_required' }
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $probeRelease = @{ Version = '@@VERSION@@'; SourceCommit = '@@COMMIT@@'; Sha256 = '@@HASH@@'; Size = @@SIZE@@ }
function Initialize-ProbeNative {
    if ('MiSub.Bootstrap.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace MiSub.Bootstrap {
    public static class Native {
        [StructLayout(LayoutKind.Sequential)] struct SystemInfo {
            public ushort Architecture, Reserved; public uint PageSize;
            public IntPtr Minimum, Maximum, Mask; public uint Count, Type, Granularity;
            public ushort Level, Revision;
        }
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(out SystemInfo info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("advapi32.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

        public static string Architecture() {
            SystemInfo info; GetNativeSystemInfo(out info);
            return MapArchitecture(info.Architecture);
        }
        public static string MapArchitecture(ushort architecture) {
            if (architecture != 9) throw new InvalidOperationException("unsupported_windows_architecture_requires_x64");
            return "windows-amd64";
        }
        public static string RegularUserError(bool system, bool administratorRoleEnabled, bool builtInAdministrator) {
            if (!system && !administratorRoleEnabled) return null;
            const string prefix = "bootstrap_requires_regular_user: ";
            if (system)
                return prefix + "SYSTEM is not supported. Sign in to an existing standard Windows user and open PowerShell normally.";
            if (builtInAdministrator)
                return prefix + "The built-in Administrator account currently has an enabled administrator role. Use an existing standard Windows user. Reopening a terminal in this session may keep full privileges.";
            return prefix + "This PowerShell process has an enabled administrator role. Close it and open PowerShell normally from your user desktop Start menu, without Run as administrator. A child terminal may inherit elevation. If it remains administrative, use an existing standard Windows user.";
        }
        public static void RegularUser() {
            using (var identity = WindowsIdentity.GetCurrent()) {
                bool administrator = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
                bool builtIn = administrator && identity.User != null && identity.User.IsWellKnown(WellKnownSidType.AccountAdministratorSid);
                string error = RegularUserError(identity.IsSystem, administrator, builtIn);
                if (error != null) throw new InvalidOperationException(error);
            }
        }
        public static string LocalPath(string path) {
            if (String.IsNullOrEmpty(path) || path.Length > 240 || path.Length < 4 || !(path[0] >= 'A' && path[0] <= 'Z' || path[0] >= 'a' && path[0] <= 'z') || path[1] != ':' || path[2] != '\\' || path.Substring(2).IndexOfAny(new char[]{':','/','\0','\r','\n','<','>','"','|','?','*'}) >= 0)
                throw new InvalidOperationException("bootstrap_requires_local_absolute_path");
            if (Path.GetFullPath(path) != path) throw new InvalidOperationException("bootstrap_invalid_path");
            foreach (string part in path.Substring(3).Split('\\')) {
                string stem = part.Split('.')[0].ToUpperInvariant();
                if (part.Length == 0 || part.TrimEnd(' ','.') != part || stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CONIN$" || stem == "CONOUT$" || System.Text.RegularExpressions.Regex.IsMatch(stem, "^(COM|LPT)[0-9\u00B9\u00B2\u00B3]$"))
                    throw new InvalidOperationException("bootstrap_invalid_path");
            }
            return path;
        }
        internal static SafeFileHandle Pin(string path, bool privateDirectory) {
            var handle = CreateFileW(path, 0x20081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            try {
                FileInfo info;
                if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0)
                    throw new InvalidOperationException("bootstrap_unsafe_directory");
                if (privateDirectory) ValidatePrivate(handle);
                return handle;
            } catch { handle.Dispose(); throw; }
        }
        static void ValidatePrivate(SafeFileHandle handle) {
            IntPtr owner, group, dacl, sacl, descriptor;
            if (GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0)
                throw new InvalidOperationException("bootstrap_acl_unavailable");
            try {
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 65536) throw new InvalidOperationException("bootstrap_invalid_acl");
                byte[] data = new byte[length]; Marshal.Copy(descriptor, data, 0, data.Length);
                var security = new RawSecurityDescriptor(data, 0);
                string current = WindowsIdentity.GetCurrent().User.Value;
                if (security.Owner.Value != current || (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count != 2)
                    throw new InvalidOperationException("bootstrap_directory_not_private");
                var seen = new HashSet<string>();
                foreach (GenericAce entry in security.DiscretionaryAcl) {
                    var ace = entry as CommonAce;
                    if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != (AceFlags.ObjectInherit | AceFlags.ContainerInherit) || ace.AccessMask != 0x1f01ff || (ace.SecurityIdentifier.Value != current && ace.SecurityIdentifier.Value != "S-1-5-18") || !seen.Add(ace.SecurityIdentifier.Value))
                        throw new InvalidOperationException("bootstrap_directory_not_private");
                }
            } finally { LocalFree(descriptor); }
        }
        internal static void CreatePrivate(string path) {
            string sid = WindowsIdentity.GetCurrent().User.Value;
            IntPtr descriptor; uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + sid + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")", 1, out descriptor, out size))
                throw new InvalidOperationException("bootstrap_acl_unavailable");
            try {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
                if (!CreateDirectoryW(path, ref attributes)) throw new InvalidOperationException("bootstrap_temporary_directory_failed");
            } finally { LocalFree(descriptor); }
        }
    }

    public sealed class Workspace : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        bool created;
        public string Path { get; private set; }
        public Workspace(string parent) {
            Native.LocalPath(parent);
            try {
                string current = parent.Substring(0, 3); handles.Add(Native.Pin(current, false));
                foreach (string part in parent.Substring(3).Split('\\')) {
                    current = System.IO.Path.Combine(current, part); handles.Add(Native.Pin(current, false));
                }
                Path = System.IO.Path.Combine(parent, "misub-probe-bootstrap-" + Guid.NewGuid().ToString("N"));
                Native.LocalPath(Path); Native.CreatePrivate(Path); created = true; handles.Add(Native.Pin(Path, true));
            } catch { Dispose(); throw; }
        }
        public void Dispose() {
            // Only a fixed downloaded filename is removed, while its parent remains pinned.
            if (created && Path != null && handles.Count > 0) {
                try { File.Delete(System.IO.Path.Combine(Path, "misub-probe-windows-amd64.exe")); } catch {}
            }
            for (int i = handles.Count - 1; i >= 0; --i) handles[i].Dispose();
            handles.Clear();
            if (created && Path != null) { try { Directory.Delete(Path, false); } catch {} }
            created = false; Path = null;
        }
    }
}
'@
}

function Test-ProbeReleaseVersion {
    param([object] $Version)
    if ($Version -isnot [string]) { return $false }
    if ($Version -cmatch '\A(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\z') { return $true }
    if ($Version -cnotmatch '\A0\.0\.1\.([0-9]{6})\.[1-9][0-9]{0,5}\z') { return $false }
    $date = [datetime]::MinValue
    return [datetime]::TryParseExact(('20' + $Matches[1]), 'yyyyMMdd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref] $date)
}

function Assert-ProbeRelease {
    param([hashtable] $Release)
    if (-not (Test-ProbeReleaseVersion $Release.Version) -or
        $Release.SourceCommit -cnotmatch '^[a-f0-9]{40}$' -or
        $Release.Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        ($Release.Size -isnot [long] -and $Release.Size -isnot [int]) -or
        $Release.Size -lt 1024 -or $Release.Size -gt 268435456) {
        throw 'release_unavailable_use_the_supported_install_command_from_MiSub'
    }
}

function Assert-ProbePairingOptions {
    param([string] $Origin, [string] $Window)
    $uri = $null
    if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref] $uri) -or
        $uri.Scheme -cne 'https' -or $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or
        $uri.AbsolutePath -ne '/' -or $Origin -notmatch '^https://[a-z0-9.-]+(?::[0-9]{1,5})?/?$' -or
        $Window -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
        throw 'invalid_pairing_options_get_a_new_command_from_MiSub'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Assert-ProbeAssetRedirect {
    param([Uri] $Uri)
    if ($Uri.Scheme -cne 'https' -or $Uri.Port -ne 443 -or $Uri.UserInfo -ne '' -or $Uri.Fragment -ne '' -or
        $Uri.DnsSafeHost -cnotin @('release-assets.githubusercontent.com', 'objects.githubusercontent.com')) {
        throw 'release_download_redirect_refused'
    }
}

function New-ProbeDownloadClient {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.UseDefaultCredentials = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('MiSub-Probe-Bootstrap/1')
    return $client
}

function Receive-ProbeAsset {
    param([hashtable] $Release, [string] $Destination)
    Assert-ProbeRelease $Release
    $client = New-ProbeDownloadClient
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $attemptClock = [Diagnostics.Stopwatch]::StartNew()
            $response = $null; $stream = $null; $file = $null
            $cancel = New-Object Threading.CancellationTokenSource
            $cancel.CancelAfter(45000)
            try {
                $uri = [Uri] ('https://github.com/58cdn/MiSub/releases/download/probe-v' + $Release.Version + '/misub-probe-windows-amd64.exe')
                for ($redirect = 0; $redirect -le 3; $redirect++) {
                    $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
                    if ([int] $response.StatusCode -notin @(301, 302, 303, 307, 308)) { break }
                    if ($redirect -eq 3 -or $null -eq $response.Headers.Location) { throw 'release_download_redirect_refused' }
                    $uri = New-Object Uri($uri, $response.Headers.Location)
                    Assert-ProbeAssetRedirect $uri
                    $response.Dispose(); $response = $null
                }
                if ([int] $response.StatusCode -eq 404) { throw 'release_asset_unavailable' }
                if ([int] $response.StatusCode -ge 400 -and [int] $response.StatusCode -lt 500) { throw 'release_download_client_error' }
                if ([int] $response.StatusCode -ne 200) { throw 'release_download_http_error' }
                if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $Release.Size) { throw 'release_size_mismatch' }
                $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $file = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $buffer = New-Object byte[] 65536
                [long] $total = 0
                while ($true) {
                    $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
                    if (-not $read.Wait([Math]::Max(1, 45000 - [int] $attemptClock.ElapsedMilliseconds))) { $cancel.Cancel(); throw 'release_download_timeout' }
                    $count = $read.GetAwaiter().GetResult()
                    if ($count -eq 0) { break }
                    $total += $count
                    if ($total -gt $Release.Size) { throw 'release_size_mismatch' }
                    $file.Write($buffer, 0, $count)
                }
                $file.Dispose(); $file = $null
                if ($total -ne $Release.Size -or (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Release.Sha256) { throw 'release_checksum_mismatch' }
                return
            } catch {
                if ($null -ne $file) { $file.Dispose(); $file = $null }
                if ([IO.File]::Exists($Destination)) { [IO.File]::Delete($Destination) }
                $permanent = $_.Exception.Message -match 'redirect_refused|asset_unavailable|client_error|size_mismatch|checksum_mismatch'
                if ($permanent) {
                    foreach ($reason in @('release_download_redirect_refused', 'release_asset_unavailable', 'release_download_client_error', 'release_size_mismatch', 'release_checksum_mismatch')) {
                        if ($_.Exception.Message.Contains($reason)) { throw $reason }
                    }
                }
                if ($attempt -eq 3 -or $clock.Elapsed.TotalSeconds -ge 150) { throw 'release_download_failed_no_detector_was_executed' }
                Start-Sleep -Seconds $attempt
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
                if ($null -ne $response) { $response.Dispose() }
                $cancel.Dispose()
            }
        }
    } finally { $client.Dispose() }
}

function Invoke-ProbeCommand {
    param([string] $Executable, [string[]] $Arguments, [switch] $Json, [switch] $Text)
    if ($Json -or $Text) {
        $output = & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { throw 'detector_command_failed' }
        $text = $output -join "`n"
        if ($text.Length -gt 32768) { throw 'detector_response_too_large' }
        if ($Text) { return $text }
        return ConvertFrom-Json -InputObject $text
    }
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'detector_command_failed_check_its_message_before_retrying' }
}

function Assert-ProbeRegularUser {
    [MiSub.Bootstrap.Native]::RegularUser()
}

function Get-ProbeEnvironment {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'unsupported_platform' }
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'unsupported_windows_version_requires_10_or_server_2016' }
    Initialize-ProbeNative
    Assert-ProbeRegularUser
    $platform = [MiSub.Bootstrap.Native]::Architecture()
    $base = [MiSub.Bootstrap.Native]::LocalPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
    $config = [MiSub.Bootstrap.Native]::LocalPath([IO.Path]::Combine($base, 'MiSubProbe', 'probe.json'))
    return @{ Platform = $platform; Config = $config }
}

function New-ProbeWorkspace {
    return New-Object MiSub.Bootstrap.Workspace([IO.Path]::GetTempPath().TrimEnd('\'))
}


    Assert-ProbeRelease $probeRelease
    $environment = Get-ProbeEnvironment
    $workspace = New-ProbeWorkspace
    $guard = $null
    try {
        $executable = [IO.Path]::Combine($workspace.Path, 'misub-probe-windows-amd64.exe')
        Receive-ProbeAsset $probeRelease $executable
        $guard = New-Object IO.FileStream($executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($guard.Length -ne $probeRelease.Size -or (Get-FileHash -InputStream $guard -Algorithm SHA256).Hash.ToLowerInvariant() -cne $probeRelease.Sha256) { throw 'release_checksum_mismatch' }
        $capabilities = Invoke-ProbeCommand $executable @('--capabilities') -Text
        $expected = 'misub-probe-bootstrap-v1 ' + $probeRelease.Version + ' ' + $probeRelease.SourceCommit + ' ' + $environment.Platform
        if ($capabilities -cne $expected) { throw 'release_capabilities_mismatch' }
        @@INVOCATION@@
    } finally {
        if ($null -ne $guard) { $guard.Dispose() }
        $workspace.Dispose()
    }
}
