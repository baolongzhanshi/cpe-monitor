param([string]$AppPath)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppPath) { $AppPath = Join-Path $repoRoot 'native-dist\payload\CPEMonitor.exe' }
$port = 13210
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot "cpe-monitor-native-smoke-$([Guid]::NewGuid().ToString('N'))"))
if (-not $testRoot.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '隔离目录不在临时目录内，拒绝验收。' }
$dataDir = Join-Path $testRoot 'user-data'
$report = Join-Path $testRoot 'report.json'
$process = $null
$savedEnvironment = @{}
$testEnvironment = @{
    CPE_MONITOR_PORT = [string]$port
    CPE_MONITOR_DATA_DIR = $dataDir
    CPE_MONITOR_SMOKE_REPORT = $report
    CPE_DESKTOP_MODE = 'true'
}

if (-not (Test-Path -LiteralPath $AppPath)) { throw "未找到原生程序：$AppPath。请先运行 scripts/build-native.ps1。" }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "隔离端口 $port 已被占用，拒绝开始验收。" }
if (Test-Path -LiteralPath $testRoot) { throw '隔离目录已存在，拒绝覆盖。' }
New-Item -ItemType Directory -Path $dataDir | Out-Null
foreach ($key in $testEnvironment.Keys) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $testEnvironment[$key], 'Process')
}

try {
    $process = Start-Process -FilePath $AppPath -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(90000)) {
        try { $process.Kill($true) } catch { }
        throw '原生隔离验收超时；已仅终止本次验收进程树。'
    }
    if (-not (Test-Path -LiteralPath $report)) { throw "隔离验收未生成报告，退出码 $($process.ExitCode)。" }
    $result = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
    if (-not $result.success -or $process.ExitCode -ne 0) { throw "原生隔离验收失败：$($result.error)" }
    if (-not $result.nativeUi -or -not $result.desktopMode -or -not $result.isolatedData) { throw '隔离验收报告字段不完整。' }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "验收结束后隔离端口 $port 仍被占用。" }
    Write-Output '原生构造与隔离后台验收通过。可视布局、交互及资源占用仍需单独验收。'
}
finally {
    if ($process -and -not $process.HasExited) { try { $process.Kill($true) } catch { } }
    foreach ($key in $testEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    if ($process) { $process.Dispose() }
    if (Test-Path -LiteralPath $testRoot) {
        $confirmedRoot = [IO.Path]::GetFullPath($testRoot)
        if ($confirmedRoot.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
