[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateNotNullOrEmpty()][string]$UploadUri = 'https://aia.example.com/api/v1/crls',
    [ValidateNotNullOrEmpty()][string]$UploadTokenFile,
    [ValidateNotNullOrEmpty()][string]$SourceDir = 'C:\ProgramData\PKI\crl-uploader\CertEnroll',
    [ValidateNotNullOrEmpty()][string]$LogPath = 'C:\ProgramData\PKI\crl-uploader\upload.log',
    [ValidateNotNullOrEmpty()][string]$LedgerPath = 'C:\ProgramData\PKI\crl-uploader\published.json',
    [ValidateRange(1, 3600)][int]$TimeoutSec = 60,
    [switch]$AllowInsecureHttp,
    [ValidateRange(0, 600000)][int]$UploadIntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ReadAttempts = 5
$ReadRetryMs = 1000

function Write-Log {
    param(
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SUCCESS')][string]$Level = 'INFO',
        [Parameter(Mandatory)][string]$Message
    )
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fffK', [cultureinfo]::InvariantCulture)
    $line = "[$ts][$Level] $Message"
    try { New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null } catch {}
    try { Add-Content -LiteralPath $LogPath -Value $line } catch {}
    $color = switch ($Level) {
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        'SUCCESS' { 'Green' }
        default { 'White' }
    }
    try { Write-Host $line -ForegroundColor $color } catch {}
}

function Format-Exception {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    $messages = [System.Collections.Generic.List[string]]::new()
    for ($e = $Exception; $e; $e = $e.InnerException) {
        if ($messages.Count -eq 0 -or -not $messages[$messages.Count - 1].Contains($e.Message)) {
            $messages.Add($e.Message)
        }
    }
    $messages -join ' -> '
}


function Read-UploadToken {
    if (-not $UploadTokenFile) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $UploadTokenFile -PathType Leaf)) {
        Write-Log ERROR "Token file not found: $UploadTokenFile"
        exit 1
    }
    try {
        $text = Get-Content -LiteralPath $UploadTokenFile -Raw
    }
    catch {
        Write-Log ERROR ("Cannot read the token file {0}: {1}" -f $UploadTokenFile, (Format-Exception $_.Exception))
        exit 1
    }
    $plain = if ($null -eq $text) { '' } else { $text.Trim() }
    if (-not $plain) {
        Write-Log ERROR "Token file is empty: $UploadTokenFile"
        exit 1
    }
    if ($plain -notmatch '^[A-Za-z0-9._~+/-]+=*$') {
        Write-Log ERROR "Token file holds characters a bearer token cannot have: $UploadTokenFile"
        exit 1
    }
    ConvertTo-SecureString -String $plain -AsPlainText -Force
}


function Read-Ledger {
    param([Parameter(Mandatory)][string]$Uri)
    $ledger = @{}
    if (-not (Test-Path -LiteralPath $LedgerPath -PathType Leaf)) {
        Write-Log WARN "Ledger not found, starting empty: $LedgerPath"
        return $ledger
    }
    try {
        $data = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json -AsHashtable
        if ($data -isnot [System.Collections.IDictionary] -or $data.uploadUri -isnot [string] -or
            $data.files -isnot [System.Collections.IDictionary]) {
            throw 'not a JSON object with uploadUri and files'
        }
        if ($data.uploadUri -cne $Uri) {
            Write-Log WARN ("Ledger was written for {0}, starting empty for {1}: {2}" -f
                $data.uploadUri, $Uri, $LedgerPath)
            return $ledger
        }
        foreach ($entry in $data.files.GetEnumerator()) {
            if ($entry.Value -isnot [string] -or $entry.Value -cnotmatch '^[0-9a-f]{64}$') {
                throw "the entry for $($entry.Key) is not a SHA-256"
            }
            $ledger[$entry.Key] = $entry.Value
        }
    }
    catch {
        Write-Log WARN ("Ledger unreadable, starting empty: {0}: {1}" -f $LedgerPath, (Format-Exception $_.Exception))
        $ledger.Clear()
    }
    $ledger
}

function Save-Ledger {
    param([Parameter(Mandatory)][hashtable]$Ledger, [Parameter(Mandatory)][string]$Uri)
    $sorted = [ordered]@{}
    foreach ($key in ($Ledger.Keys | Sort-Object)) {
        $sorted[$key] = $Ledger[$key]
    }
    $dir = Split-Path -Parent $LedgerPath
    if ($dir) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $temp = "$LedgerPath.tmp"
    [ordered]@{ uploadUri = $Uri; files = $sorted } | ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath $temp -Encoding utf8NoBOM
    Move-Item -LiteralPath $temp -Destination $LedgerPath -Force
}


function Read-CrlFile {
    param([Parameter(Mandatory)][string]$Path)
    for ($attempt = 1; ; $attempt++) {
        try {
            $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            try {
                $buffer = [System.IO.MemoryStream]::new()
                $stream.CopyTo($buffer)
                return , $buffer.ToArray()
            }
            finally {
                $stream.Dispose()
            }
        }
        catch [System.IO.IOException] {
            if ($attempt -ge $ReadAttempts) {
                throw
            }
            Write-Log WARN ("Cannot read {0} yet (attempt {1} of {2}): {3}" -f
                $Path, $attempt, $ReadAttempts, (Format-Exception $_.Exception))
            Start-Sleep -Milliseconds $ReadRetryMs
        }
    }
}

function Get-CrlMediaType {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    if ($Bytes.Length -gt 0 -and $Bytes[0] -eq 0x30) {
        return 'application/pkix-crl'
    }
    if ([System.Text.Encoding]::ASCII.GetString($Bytes).Contains('-----BEGIN X509 CRL-----')) {
        return 'application/x-pem-file'
    }
    $null
}


function Send-Crl {
    param(
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][string]$ContentType,
        [securestring]$Token
    )
    $request = @{
        Method             = 'Post'
        Uri                = $UploadUri
        ContentType        = $ContentType
        Body               = $Bytes
        TimeoutSec         = $TimeoutSec
        SkipHttpErrorCheck = $true
        StatusCodeVariable = 'status'
    }
    if ($Token) {
        $request.Authentication = 'Bearer'
        $request.Token = $Token
        $request.AllowUnencryptedAuthentication = $AllowInsecureHttp.IsPresent
    }
    $body = Invoke-RestMethod @request
    [pscustomobject]@{ Status = $status; Body = $body }
}

function Format-Time {
    param($Value)
    if ($Value -is [datetime]) {
        return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture)
    }
    "$Value"
}

function Format-Details {
    param($Details)
    if ($null -eq $Details) {
        return ''
    }
    ' ' + ($Details | ConvertTo-Json -Compress -Depth 5)
}


try {
    Write-Log INFO ("Startup: UploadUri={0}; SourceDir={1}; LedgerPath={2}; UploadTokenFile={3}" -f
        $UploadUri, $SourceDir, $LedgerPath, ($UploadTokenFile ? $UploadTokenFile : '(none)'))

    $uri = $null
    if (-not [System.Uri]::TryCreate($UploadUri, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin 'http', 'https') {
        Write-Log ERROR "UploadUri is not an absolute http:// or https:// URI: $UploadUri"
        exit 1
    }
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        Write-Log ERROR "SourceDir not found: $SourceDir"
        exit 1
    }
    $token = Read-UploadToken
    if ($token -and $uri.Scheme -eq 'http' -and -not $AllowInsecureHttp) {
        Write-Log ERROR 'Refusing to send the upload token over http://: use https:// (-AllowInsecureHttp is for tests)'
        exit 1
    }

    $files = @(Get-ChildItem -LiteralPath $SourceDir -File |
            Where-Object Extension -In '.crl', '.dcrl', '.pem' |
            Sort-Object LastWriteTimeUtc, Name)
    if ($files.Count -eq 0) {
        Write-Log WARN "No CRL files found in $SourceDir"
        exit 0
    }
    $names = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$files.Name, [System.StringComparer]::OrdinalIgnoreCase)

    $ledgerUri = $uri.AbsoluteUri
    $ledger = Read-Ledger -Uri $ledgerUri
    $counts = [ordered]@{ Created = 0; Updated = 0; Unchanged = 0; Skipped = 0; Failed = 0 }
    $uploaded = $false

    foreach ($file in $files) {
        try {
            if ($file.Extension -eq '.pem' -and $names.Contains($file.BaseName)) {
                Write-Log INFO ("Skipped: {0} ({1} is uploaded instead)" -f $file.Name, $file.BaseName)
                $counts.Skipped++
                continue
            }

            $bytes = Read-CrlFile -Path $file.FullName
            $sha256 = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($bytes)) -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($ledger[$file.FullName] -eq $sha256) {
                Write-Log INFO ("Skipped: {0} (accepted before, sha256 {1})" -f $file.Name, $sha256)
                $counts.Skipped++
                continue
            }
            $contentType = Get-CrlMediaType -Bytes $bytes
            if (-not $contentType) {
                Write-Log ERROR ("{0}: neither DER nor PEM with an X509 CRL block, not uploaded" -f $file.Name)
                $counts.Failed++
                continue
            }

            if ($uploaded -and $UploadIntervalMs -gt 0) {
                Start-Sleep -Milliseconds $UploadIntervalMs
            }
            $uploaded = $true
            Write-Log INFO ("Uploading: {0} ({1}, {2} bytes, sha256 {3})" -f
                $file.Name, $contentType, $bytes.Length, $sha256)
            $response = Send-Crl -Bytes $bytes -ContentType $contentType -Token $token
            $status = $response.Status
            $body = $response.Body

            if ($status -in 200, 201 -and $body.outcome -in 'created', 'updated', 'unchanged') {
                $ledger[$file.FullName] = $sha256
                try {
                    Save-Ledger -Ledger $ledger -Uri $ledgerUri
                }
                catch {
                    $ledger.Remove($file.FullName)
                    Write-Log ERROR ("{0}: {1} on the service, but the ledger could not be written: {2}" -f
                        $file.Name, $body.outcome, (Format-Exception $_.Exception))
                    $counts.Failed++
                    continue
                }
                $number = if ($null -eq $body.crlNumber) { 'none' } else { $body.crlNumber }
                Write-Log SUCCESS ("{0}: {1} (target {2}, {3} CRL Number {4}, thisUpdate {5})" -f
                    $file.Name, $body.outcome, $body.target, $body.kind, $number, (Format-Time $body.thisUpdate))
                $counts[$body.outcome]++
                continue
            }

            $counts.Failed++
            $code = $body.error.code
            if (-not $code) {
                Write-Log ERROR ("{0}: HTTP {1}, not an upload result" -f $file.Name, $status)
                continue
            }
            $message = "{0}: HTTP {1} {2}: {3}{4}" -f
                $file.Name, $status, $code, $body.error.message, (Format-Details $body.error.details)
            if ($code -eq 'stale_crl') {
                $message += ' (the CA wrote a CRL older than the published one)'
            }
            elseif ($status -eq 401) {
                $message += $token ? ' (the token in -UploadTokenFile is wrong)' :
                    ' (the service requires a token: pass -UploadTokenFile)'
            }
            Write-Log ERROR $message
        }
        catch {
            Write-Log ERROR ("{0}: {1}" -f $file.Name, (Format-Exception $_.Exception))
            $counts.Failed++
        }
    }

    $level = if ($counts.Failed -gt 0) { 'ERROR' } else { 'SUCCESS' }
    Write-Log $level ("Completed. Created: {0}, Updated: {1}, Unchanged: {2}, Skipped: {3}, Failed: {4}" -f
        $counts.Created, $counts.Updated, $counts.Unchanged, $counts.Skipped, $counts.Failed)
    if ($counts.Failed -gt 0) {
        exit 1
    }
    exit 0
}
catch {
    Write-Log ERROR (Format-Exception $_.Exception)
    exit 1
}
