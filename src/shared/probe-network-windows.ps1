& {
    $ErrorActionPreference = 'Stop'
    foreach ($scope in 'MachinePolicy','UserPolicy') {
        if ((Get-ExecutionPolicy -Scope $scope) -in @('Restricted','AllSigned','RemoteSigned')) { throw 'MiSub: organization script policy requires an administrator-approved installation method.' }
    }
    if ((Get-ExecutionPolicy) -eq 'AllSigned') { throw 'MiSub: signed scripts are required; use an administrator-approved installation method.' }
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $handler.UseProxy = $false
    $handler.UseDefaultCredentials = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.MaxResponseContentBufferSize = @@SIZE@@
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    $url = '@@URL@@'
    try {
        for ($i = 0; $i -lt 3; $i++) {
            $response = $client.GetAsync($url).GetAwaiter().GetResult()
            try {
                if ([int]$response.StatusCode -eq 200) {
                    $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                    break
                }
                $url = [string]$response.Headers.Location.OriginalString
                if ([int]$response.StatusCode -notin @(301,302,303,307,308) -or $i -eq 2 -or $url -cnotmatch '^https://(release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)/[^\s\\#]+$') { throw 'download_refused' }
            } finally { $response.Dispose() }
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        if ($bytes.Length -ne @@SIZE@@ -or $hash -cne '@@HASH@@') { throw 'checksum_mismatch' }
        $installer = [ScriptBlock]::Create([Text.UTF8Encoding]::new($false, $true).GetString($bytes))
    } catch { throw 'MiSub: download/verification failed. This Windows release requires direct HTTPS access (system proxies are not used). Check the network and retry. No installer was executed.' }
    finally { $client.Dispose() }
    & $installer @@INVOCATION@@
}
