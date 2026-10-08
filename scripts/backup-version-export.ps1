param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Get-Content -LiteralPath (Join-Path $BackupDirectory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -notin @(1, 2)) { throw '不支持此备份格式。' }
if ($manifest.status -ne 'complete' -or $manifest.userData.status -ne 'complete') {
    throw '备份未完成或没有用户数据，拒绝导出。'
}
if (Test-Path -LiteralPath $Destination) { throw '目标目录已存在，请指定新目录以避免覆盖。' }
$encryptedPath = Join-Path $BackupDirectory 'user-data.dpapi'
$expectedHash = ($manifest.artifacts | Where-Object name -eq 'user-data.dpapi').sha256
if (-not $expectedHash -or (Get-FileHash -LiteralPath $encryptedPath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw '加密备份文件 SHA256 校验失败。'
}
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes($encryptedPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$sha = [Security.Cryptography.SHA256]::Create()
$stream = $null
$archive = $null
$secretHash = $null
try {
    $plainHash = ([BitConverter]::ToString($sha.ComputeHash($plainBytes))).Replace('-', '')
    if ($plainHash -ne $manifest.userData.plaintextArchiveSHA256) { throw '解密内容校验失败。' }
    $stream = [IO.MemoryStream]::new($plainBytes, $false)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read)
    $expectedEntries = @('data/cpe-monitor.db', 'runtime-secrets.json')
    if ($manifest.userData.included -contains 'runtime-secrets.dpapi') {
        $expectedEntries += 'runtime-secrets.dpapi'
    }
    if ($archive.Entries.Count -ne $expectedEntries.Count) { throw '数据备份目录不符合预期。' }
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
    if (@($entryNames | Sort-Object -Unique).Count -ne $entryNames.Count) {
        throw '数据备份包含重复文件。'
    }
    foreach ($expectedEntry in $expectedEntries) {
        if ($entryNames -notcontains $expectedEntry) { throw '数据备份缺少数据库或配套密钥。' }
    }
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notin $expectedEntries) { throw '数据备份包含非预期文件。' }
    }
    $jsonEntry = $archive.GetEntry('runtime-secrets.json')
    $jsonStream = $jsonEntry.Open()
    $jsonMemory = [IO.MemoryStream]::new()
    try {
        $jsonStream.CopyTo($jsonMemory)
        $jsonBytes = $jsonMemory.ToArray()
        $jsonValue = [Text.Encoding]::UTF8.GetString($jsonBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if (-not $jsonValue -or $jsonValue -is [Array] -or $jsonValue -is [string]) { throw '运行密钥 JSON 格式无效。' }
        $canonical = [ordered]@{}
        foreach ($property in ($jsonValue.PSObject.Properties | Sort-Object Name)) {
            if ($property.Value -isnot [string]) { throw '运行密钥 JSON 格式无效。' }
            $canonical[$property.Name] = $property.Value
        }
        if ($canonical.Count -lt 1) { throw '运行密钥 JSON 格式无效。' }
        $canonicalBytes = [Text.Encoding]::UTF8.GetBytes(($canonical | ConvertTo-Json -Compress))
        try {
            $sha = [Security.Cryptography.SHA256]::Create()
            $secretHash = ([BitConverter]::ToString($sha.ComputeHash($canonicalBytes))).Replace('-', '')
            $sha.Dispose()
        } finally { [Array]::Clear($canonicalBytes, 0, $canonicalBytes.Length) }
    } finally {
        $jsonStream.Dispose(); $jsonMemory.Dispose()
        if ($jsonBytes) { [Array]::Clear($jsonBytes, 0, $jsonBytes.Length) }
    }
    if ($manifest.userData.runtimeSecretsContentSHA256 -and
        $secretHash -ne $manifest.userData.runtimeSecretsContentSHA256) {
        throw '运行密钥内容校验失败。'
    }
    if ($expectedEntries -contains 'runtime-secrets.dpapi') {
        $protectedEntry = $archive.GetEntry('runtime-secrets.dpapi')
        $protectedStream = $protectedEntry.Open()
        $protectedMemory = [IO.MemoryStream]::new()
        try {
            $protectedStream.CopyTo($protectedMemory)
            $protectedBytes = $protectedMemory.ToArray()
            $unprotected = [Security.Cryptography.ProtectedData]::Unprotect(
                $protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            try {
                $protectedValue = [Text.Encoding]::UTF8.GetString($unprotected).TrimStart([char]0xFEFF) | ConvertFrom-Json
                if (-not $protectedValue -or $protectedValue -is [Array] -or $protectedValue -is [string]) { throw 'DPAPI 运行密钥格式无效。' }
                $protectedCanonical = [ordered]@{}
                foreach ($property in ($protectedValue.PSObject.Properties | Sort-Object Name)) {
                    if ($property.Value -isnot [string]) { throw 'DPAPI 运行密钥格式无效。' }
                    $protectedCanonical[$property.Name] = $property.Value
                }
                $protectedCanonicalBytes = [Text.Encoding]::UTF8.GetBytes(($protectedCanonical | ConvertTo-Json -Compress))
                try {
                    $protectedSha = [Security.Cryptography.SHA256]::Create()
                    $protectedHash = ([BitConverter]::ToString($protectedSha.ComputeHash($protectedCanonicalBytes))).Replace('-', '')
                    $protectedSha.Dispose()
                } finally { [Array]::Clear($protectedCanonicalBytes, 0, $protectedCanonicalBytes.Length) }
                if ($protectedHash -ne $secretHash) { throw 'JSON 与 DPAPI 运行密钥内容不一致。' }
            } finally { [Array]::Clear($unprotected, 0, $unprotected.Length) }
        } finally {
            $protectedStream.Dispose(); $protectedMemory.Dispose()
            if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
        }
    }
    [IO.Directory]::CreateDirectory((Join-Path $Destination 'data')) | Out-Null
    foreach ($entry in $archive.Entries) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Destination $entry.FullName), $false)
    }
} finally {
    if ($archive) { $archive.Dispose() }
    if ($stream) { $stream.Dispose() }
    $sha.Dispose()
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
}
Write-Output "用户数据已导出到：$Destination。应用仍使用原来的数据，本脚本不会执行回退。"
