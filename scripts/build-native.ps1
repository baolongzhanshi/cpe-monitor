param([switch]$SkipInstaller)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$publishDir = Join-Path $repoRoot 'native-dist\publish'
$payloadDir = Join-Path $repoRoot 'native-dist\payload'
$installerDir = Join-Path $repoRoot 'installers'
$installerPath = Join-Path $installerDir "CPEMonitor_${version}_x64-setup.exe"
$projectPath = Join-Path $repoRoot 'desktop-native\CpeMonitor.Native.csproj'
$resourceServer = Join-Path $repoRoot 'src-tauri\resources\server'
$runtimeSource = Join-Path $repoRoot 'src-tauri\binaries\node-x86_64-pc-windows-msvc.exe'
$nsiPath = Join-Path $repoRoot 'scripts\native-installer.nsi'
$webViewBootstrap = Join-Path $repoRoot 'tools\MicrosoftEdgeWebview2Setup.exe'

function Invoke-NativeStep([string]$FilePath, [string[]]$ArgumentList) {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "命令失败（$LASTEXITCODE）：$FilePath $($ArgumentList -join ' ')" }
}

$sdkCandidates = @((Join-Path $repoRoot 'tools\dotnet\dotnet.exe'))
$sdkCandidates += @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'tools') -Directory -Filter 'dotnet*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'dotnet.exe' })
$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnetCommand) { $sdkCandidates += $dotnetCommand.Source }
$dotnet = $null
foreach ($sdkCandidate in $sdkCandidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $sdkCandidate)) { continue }
    $sdkList = & $sdkCandidate --list-sdks
    if ($LASTEXITCODE -eq 0 -and ($sdkList | Where-Object { $_ -match '^10\.' })) {
        $dotnet = $sdkCandidate
        break
    }
}
if (-not $dotnet) { throw '未找到 dotnet。CI 或本机需要安装 .NET 10 SDK。' }
if (-not (Test-Path -LiteralPath $projectPath)) { throw "未找到原生项目：$projectPath" }
if (-not $env:CPE_NODE_RUNTIME -or -not (Test-Path -LiteralPath $env:CPE_NODE_RUNTIME)) {
    throw '缺少 CPE_NODE_RUNTIME。请提供与当前 Node ABI 匹配的 x64 node.exe。'
}
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }
$npmArguments = @('run', 'build:desktop')
if (-not $npm) {
    $nodeDirectory = Split-Path -Parent $env:CPE_NODE_RUNTIME
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { throw '未找到 npm。请在构建机安装 Node.js 与 npm。' }
    $npm = $env:CPE_NODE_RUNTIME
    $npmArguments = @($npmCli, 'run', 'build:desktop')
}

Write-Output '构建 Next.js 后台资源并校验 SQLite 原生模块…'
Push-Location $repoRoot
try { Invoke-NativeStep $npm $npmArguments } finally { Pop-Location }

if (-not (Test-Path -LiteralPath (Join-Path $resourceServer 'server.js'))) { throw '后台 server.js 未生成。' }
if (-not (Test-Path -LiteralPath $runtimeSource)) { throw "内置 Node 运行时未生成：$runtimeSource" }

foreach ($cleanDir in @($publishDir, $payloadDir)) {
    $resolvedCleanDir = [IO.Path]::GetFullPath($cleanDir)
    $allowedCleanRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'native-dist')).TrimEnd('\') + '\'
    if (-not $resolvedCleanDir.StartsWith($allowedCleanRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "清理路径不在工作区 native-dist 内：$resolvedCleanDir"
    }
    if (Test-Path -LiteralPath $cleanDir) {
        try { Remove-Item -LiteralPath $cleanDir -Recurse -Force -ErrorAction Stop }
        catch { throw "无法清理 $cleanDir，可能有 CPE Monitor 文件被占用。请关闭本 CPE Monitor 后重试。" }
    }
}
New-Item -ItemType Directory -Path $publishDir, $payloadDir, $installerDir -Force | Out-Null

Write-Output '发布 self-contained .NET 10 WinForms 单文件…'
Push-Location $repoRoot
try {
    Invoke-NativeStep $dotnet @('publish', $projectPath, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-o', $publishDir)
} finally { Pop-Location }

$appSource = Join-Path $publishDir 'CPEMonitor.exe'
if (-not (Test-Path -LiteralPath $appSource)) { throw "未找到原生可执行文件：$appSource" }
Copy-Item -LiteralPath $appSource -Destination (Join-Path $payloadDir 'CPEMonitor.exe') -Force
New-Item -ItemType Directory -Path (Join-Path $payloadDir 'resources') -Force | Out-Null
Copy-Item -LiteralPath $resourceServer -Destination (Join-Path $payloadDir 'resources\server') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $payloadDir 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $payloadDir 'runtime\node.exe') -Force
if (-not (Test-Path -LiteralPath $webViewBootstrap)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $webViewBootstrap) -Force | Out-Null
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webViewBootstrap
}
$bootstrapSignature = Get-AuthenticodeSignature -LiteralPath $webViewBootstrap
if ($bootstrapSignature.Status -ne 'Valid' -or $bootstrapSignature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw 'WebView2 运行时引导安装器签名校验失败，拒绝打包。'
}
New-Item -ItemType Directory -Path (Join-Path $payloadDir 'support') -Force | Out-Null
Copy-Item -LiteralPath $webViewBootstrap -Destination (Join-Path $payloadDir 'support\MicrosoftEdgeWebview2Setup.exe') -Force

if ($SkipInstaller) {
    Write-Output "原生运行目录已生成：$payloadDir；按要求跳过 NSIS 安装器生成。"
    return
}

if (Test-Path -LiteralPath $installerPath) {
    try { Remove-Item -LiteralPath $installerPath -Force -ErrorAction Stop }
    catch { throw "无法覆盖旧安装包 $installerPath，可能正在使用。请关闭本 CPE Monitor 后重试。" }
}
$makensisCandidates = @(
    (Join-Path $repoRoot 'tools\nsis\makensis.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$makensis = $makensisCandidates | Select-Object -First 1
if (-not $makensis) {
    $nsisCommand = Get-Command makensis -ErrorAction SilentlyContinue
    if ($nsisCommand) { $makensis = $nsisCommand.Source }
}
if (-not $makensis) { throw '未找到 NSIS makensis.exe。Windows CI 需要安装 NSIS。' }

Write-Output '生成不需要管理员权限的当前用户安装包…'
Invoke-NativeStep $makensis @("/DINPUT_DIR=$payloadDir", "/DOUTPUT_EXE=$installerPath", "/DPRODUCT_VERSION=$version", $nsiPath)
if (-not (Test-Path -LiteralPath $installerPath)) { throw "NSIS 未生成安装包：$installerPath" }
$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
Write-Output "安装包：$installerPath"
Write-Output "SHA256：$hash"
