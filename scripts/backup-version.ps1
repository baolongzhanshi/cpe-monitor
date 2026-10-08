param(
    [string]$Version,
    [string]$InstallerPath,
    [ValidateSet('before-change', 'released')][string]$Phase = 'before-change'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRoot = Join-Path $projectRoot 'backups'
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $package.version }
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw '版本号包含无效字符。' }
if (-not $InstallerPath) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $InstallerPath = Join-Path $desktop "CPEMonitor_${Version}_x64-setup.exe"
    if (-not [IO.File]::Exists($InstallerPath)) {
        $InstallerPath = Join-Path $desktop "CPEye_${Version}_x64-setup.exe"
    }
}
$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Extension -ne '.exe') { throw '安装包必须是 .exe 文件。' }
$node = (Get-Command node -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction Stop).Source
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Security

function Invoke-BackupGit {
    param([string[]]$Arguments)
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $git -C $projectRoot @Arguments 2>&1 }
    finally { $ErrorActionPreference = $previousErrorAction }
    if ($LASTEXITCODE -ne 0) { throw "Git 操作失败：$($output -join [Environment]::NewLine)" }
    return $output
}

function Add-BackupZipFile {
    param($Archive, [string]$EntryName, [string]$SourcePath)
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $Archive, $SourcePath, $EntryName, [IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
}

function Get-BackupByteHash {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Add-BackupZipBytes {
    param($Archive, [string]$EntryName, [byte[]]$Bytes)
    $entry = $Archive.CreateEntry($EntryName, [IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    try { $entryStream.Write($Bytes, 0, $Bytes.Length) }
    finally { $entryStream.Dispose() }
}

function Get-BackupSecretsHash {
    param([byte[]]$Bytes)
    $value = [Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if (-not $value -or $value -is [Array] -or $value -is [string]) { throw '运行密钥格式无效。' }
    $canonical = [ordered]@{}
    foreach ($property in ($value.PSObject.Properties | Sort-Object Name)) {
        if ($property.Value -isnot [string]) { throw '运行密钥格式无效。' }
        $canonical[$property.Name] = $property.Value
    }
    if ($canonical.Count -lt 1) { throw '运行密钥格式无效。' }
    $canonicalBytes = [Text.Encoding]::UTF8.GetBytes(($canonical | ConvertTo-Json -Compress))
    try { return Get-BackupByteHash $canonicalBytes }
    finally { [Array]::Clear($canonicalBytes, 0, $canonicalBytes.Length) }
}

$stamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss-fff')
$backupDirectory = Join-Path $backupRoot "v${Version}-${Phase}-${stamp}"
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$snapshotPath = Join-Path $backupDirectory '.database-snapshot.tmp'
$manifestPath = Join-Path $backupDirectory 'manifest.json'
$manifest = [ordered]@{
    format = 2
    status = 'in-progress'
    version = $Version
    phase = $Phase
    createdAt = [DateTimeOffset]::Now.ToString('o')
    head = (Invoke-BackupGit -Arguments @('rev-parse', 'HEAD') | Out-String).Trim()
    tree = (Invoke-BackupGit -Arguments @('rev-parse', 'HEAD^{tree}') | Out-String).Trim()
    worktreeStatus = @(Invoke-BackupGit -Arguments @('status', '--short', '--untracked-files=all'))
    sourceFiles = 0
    database = $null
    userData = $null
    artifacts = @()
}

try {
    # 使用工作区文件而不是仅归档 HEAD，保留尚未提交的修改与新增文件。
    $sourceFiles = @(Invoke-BackupGit -Arguments @('-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard'))
    $sourcePath = Join-Path $backupDirectory 'source.zip'
    $sourceZip = [IO.Compression.ZipFile]::Open($sourcePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relativePath in ($sourceFiles | Sort-Object -Unique)) {
            $relativePath = [string]$relativePath
            if ($relativePath -match '^(?:\.git|node_modules|\.next|build|out|coverage|backups|tools|native-dist|installers)(?:/|$)' -or
                $relativePath -match '^src-tauri/(?:target|resources|binaries)(?:/|$)' -or
                $relativePath -match '^desktop-native/(?:bin|obj)(?:/|$)' -or
                $relativePath -match '(^|/)(?:runtime-secrets\.json|\.env(?:\..*)?|[^/]+\.db(?:-wal|-shm)?|[^/]+\.dpapi)$') {
                if ($relativePath -ne '.env.example') { continue }
            }
            $absolutePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
            if (-not $absolutePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw '源码文件路径越出项目目录。'
            }
            if ([IO.File]::Exists($absolutePath)) {
                Add-BackupZipFile $sourceZip $relativePath $absolutePath
                $manifest.sourceFiles++
            }
        }
    } finally { $sourceZip.Dispose() }
    $sourceCheck = [IO.Compression.ZipFile]::OpenRead($sourcePath)
    try {
        if ($sourceCheck.Entries.Count -ne $manifest.sourceFiles -or $manifest.sourceFiles -lt 1) {
            throw '源码 ZIP 文件数量校验失败。'
        }
    } finally { $sourceCheck.Dispose() }

    $bundlePath = Join-Path $backupDirectory 'history.bundle'
    Invoke-BackupGit -Arguments @('bundle', 'create', $bundlePath, '--all') | Out-Null
    Invoke-BackupGit -Arguments @('bundle', 'verify', $bundlePath) | Out-Null
    $installerTarget = Join-Path $backupDirectory $installer.Name
    [IO.File]::Copy($installer.FullName, $installerTarget, $false)
    if ((Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $installerTarget -Algorithm SHA256).Hash) {
        throw '安装包复制校验失败。'
    }

    $appDataRoot = Join-Path $env:APPDATA 'com.cpeye.monitor'
    $databasePath = Join-Path $appDataRoot 'data/cpe-monitor.db'
    $legacySecretsPath = Join-Path $appDataRoot 'runtime-secrets.json'
    $protectedSecretsPath = Join-Path $appDataRoot 'runtime-secrets.dpapi'
    $hasLegacySecrets = [IO.File]::Exists($legacySecretsPath)
    $hasProtectedSecrets = [IO.File]::Exists($protectedSecretsPath)
    if ([IO.File]::Exists($databasePath) -or $hasLegacySecrets -or $hasProtectedSecrets) {
        if (-not [IO.File]::Exists($databasePath) -or (-not $hasLegacySecrets -and -not $hasProtectedSecrets)) {
            throw '发现不完整的用户数据：数据库与 runtime-secrets.json 或 runtime-secrets.dpapi 必须成对备份。'
        }
        $dataStream = [IO.MemoryStream]::new()
        $plainSecretsBytes = $null
        $protectedSecretsBytes = $null
        $legacySecretsBytes = $null
        $plainBytes = $null
        $verified = $null
        try {
            $secretsPath = if ($hasProtectedSecrets) { $protectedSecretsPath } else { $legacySecretsPath }
            $secretsBefore = (Get-FileHash -LiteralPath $secretsPath -Algorithm SHA256).Hash
            if ($hasProtectedSecrets) {
                $protectedSecretsBytes = [IO.File]::ReadAllBytes($protectedSecretsPath)
                $plainSecretsBytes = [Security.Cryptography.ProtectedData]::Unprotect(
                    $protectedSecretsBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
                )
            } else {
                $plainSecretsBytes = [IO.File]::ReadAllBytes($legacySecretsPath)
            }
            $secretsContentHash = Get-BackupSecretsHash $plainSecretsBytes
            $legacySecretsBefore = $null
            if ($hasProtectedSecrets -and $hasLegacySecrets) {
                $legacySecretsBefore = (Get-FileHash -LiteralPath $legacySecretsPath -Algorithm SHA256).Hash
                $legacySecretsBytes = [IO.File]::ReadAllBytes($legacySecretsPath)
                if ($secretsContentHash -ne (Get-BackupSecretsHash $legacySecretsBytes)) {
                    throw '两种格式的运行密钥内容不一致，拒绝备份。'
                }
            }
            $databaseResult = & $node (Join-Path $PSScriptRoot 'backup-version-db.mjs') $databasePath $snapshotPath
            if ($LASTEXITCODE -ne 0) { throw '数据库在线备份失败。' }
            $manifest.database = ($databaseResult | Out-String | ConvertFrom-Json)
            $included = @('data/cpe-monitor.db', 'runtime-secrets.json')
            $dataZip = [IO.Compression.ZipArchive]::new($dataStream, [IO.Compression.ZipArchiveMode]::Create, $true)
            try {
                Add-BackupZipFile $dataZip 'data/cpe-monitor.db' $snapshotPath
                # 旧版回退需要 JSON，明文只存在于内存和整体加密前的内存 ZIP。
                Add-BackupZipBytes $dataZip 'runtime-secrets.json' $plainSecretsBytes
                if ($hasProtectedSecrets) {
                    Add-BackupZipBytes $dataZip 'runtime-secrets.dpapi' $protectedSecretsBytes
                    $included += 'runtime-secrets.dpapi'
                }
            } finally { $dataZip.Dispose() }
            if ($secretsBefore -ne (Get-FileHash -LiteralPath $secretsPath -Algorithm SHA256).Hash -or
                ($legacySecretsBefore -and $legacySecretsBefore -ne (Get-FileHash -LiteralPath $legacySecretsPath -Algorithm SHA256).Hash)) {
                throw '备份期间运行密钥发生变化，请重新备份。'
            }
            $plainBytes = $dataStream.ToArray()
            $encrypted = [Security.Cryptography.ProtectedData]::Protect(
                $plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            $encryptedPath = Join-Path $backupDirectory 'user-data.dpapi'
            [IO.File]::WriteAllBytes($encryptedPath, $encrypted)
            $verified = [Security.Cryptography.ProtectedData]::Unprotect(
                [IO.File]::ReadAllBytes($encryptedPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            if ((Get-BackupByteHash $plainBytes) -ne (Get-BackupByteHash $verified)) {
                throw '用户数据加密回读校验失败。'
            }
            $manifest.userData = [ordered]@{
                status = 'complete'
                encryption = 'Windows DPAPI CurrentUser'
                windowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
                plaintextArchiveSHA256 = Get-BackupByteHash $plainBytes
                included = $included
                runtimeSecretsFile = [IO.Path]::GetFileName($secretsPath)
                runtimeSecretsSHA256 = $secretsBefore
                runtimeSecretsContentSHA256 = $secretsContentHash
            }
        } finally {
            $dataStream.Dispose()
            foreach ($buffer in @($plainBytes, $verified, $plainSecretsBytes, $protectedSecretsBytes, $legacySecretsBytes, $encrypted)) {
                if ($buffer) { [Array]::Clear($buffer, 0, $buffer.Length) }
            }
        }
    } else {
        $manifest.userData = @{ status = 'not-present'; reason = '此 Windows 用户尚未产生应用数据。' }
    }

    $restoreNotes = @"
版本 $Version 的本机回退备份

1. 从托盘选择退出，确认 CPEMonitor.exe、旧版 cpeye-desktop.exe 与其内置 Node 服务均已停止。
2. 回退前再次运行 scripts/backup-version.ps1，保留当前源码、安装包与数据。
3. 双击本目录中的安装包安装对应版本。仅恢复程序时，保留当前配置即可；若新旧数据库结构不兼容，则执行第 4 步。
4. 使用同一 Windows 用户执行 scripts/backup-version-export.ps1 -BackupDirectory '<本备份目录>' -Destination '<新建的临时目录>'，将 data/cpe-monitor.db 和配套运行密钥一起恢复到 %APPDATA%\com.cpeye.monitor。恢复前另存当前数据，删除旧的 cpe-monitor.db-wal 和 cpe-monitor.db-shm，以及目标目录原有的 runtime-secrets.json 和 runtime-secrets.dpapi，再恢复本备份中导出的密钥文件；若同时存在两种格式，两者必须属于同一份备份且内容相同，禁止混用其他版本密钥。旧版使用 runtime-secrets.json，新版优先使用 runtime-secrets.dpapi 并迁移旧 JSON。
5. 恢复数据后再启动程序，检查设备连接与推送配置；数据会回到此备份的时间点。

source.zip 包含备份时的源码（含未提交改动）；history.bundle 保存提交历史。
用户数据使用 Windows DPAPI 加密，只能由创建备份的 Windows 用户解密，不可用于跨机迁移。请勿上传用户数据或密钥到 GitHub。
manifest.json 记录版本、提交、文件 SHA256 与 SQLite 完整性结果。配置、短信、历史记录只在 user-data.dpapi 中。
"@
    [IO.File]::WriteAllText((Join-Path $backupDirectory '回退说明.txt'), $restoreNotes, [Text.UTF8Encoding]::new($false))
    $manifest.artifacts = @(Get-ChildItem -LiteralPath $backupDirectory -File | Where-Object {
        $_.Name -ne 'manifest.json' -and $_.Name -notlike '*.tmp*'
    } | ForEach-Object {
        [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
    $manifest.status = 'complete'
} catch {
    $manifest.status = 'failed'
    $manifest.error = $_.Exception.Message
    throw
} finally {
    foreach ($temporaryPath in @($snapshotPath, "$snapshotPath-wal", "$snapshotPath-shm")) {
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

Write-Output "完整备份已完成：$backupDirectory"
Write-Output "源码文件：$($manifest.sourceFiles)；数据库：$($manifest.userData.status)；安装包 SHA256：$((Get-FileHash -LiteralPath $installerTarget -Algorithm SHA256).Hash)"
