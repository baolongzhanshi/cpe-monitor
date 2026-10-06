$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function New-RandomSecret([int]$ByteCount) {
    $bytes = New-Object byte[] $ByteCount
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    } finally {
        $generator.Dispose()
    }
}

function Read-SecretText([string]$Prompt) {
    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function ConvertTo-DotEnvValue([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace("'", "\'")
    return "'$escaped'"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '未找到 Docker。请先安装并启动 Docker Desktop，再重新运行此脚本。'
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    throw '当前 Docker 未启用 Compose v2。请更新 Docker Desktop 后重试。'
}

$envPath = Join-Path (Get-Location) '.env'
if (Test-Path -LiteralPath $envPath) {
    $answer = Read-Host '检测到已有 .env。输入 Y 使用现有配置继续启动，其他输入退出'
    if ($answer -notin @('Y', 'y')) {
        Write-Host '已退出，现有配置没有改动。'
        exit 0
    }
} else {
    Write-Host '首次设置：输入 CPE 管理页面地址和登录凭据。'
    $cpeUrl = Read-Host 'CPE 地址（默认 http://192.168.31.1）'
    if ([string]::IsNullOrWhiteSpace($cpeUrl)) { $cpeUrl = 'http://192.168.31.1' }
    $cpeUsername = Read-Host 'CPE 用户名（默认 admin）'
    if ([string]::IsNullOrWhiteSpace($cpeUsername)) { $cpeUsername = 'admin' }
    $cpePassword = Read-SecretText 'CPE 密码'
    if ([string]::IsNullOrWhiteSpace($cpePassword)) { throw 'CPE 密码不能为空。' }

    $portInput = Read-Host '网页端口（默认 3000）'
    $appPort = 3000
    if (-not [string]::IsNullOrWhiteSpace($portInput)) {
        $parsedPort = 0
        if ([int]::TryParse($portInput, [ref]$parsedPort) -and $parsedPort -ge 1 -and $parsedPort -le 65535) {
            $appPort = $parsedPort
        } else {
            throw '端口必须是 1 到 65535 之间的整数。'
        }
    }

    $adminPassword = New-RandomSecret 18
    $lines = @(
        "APP_PORT=$appPort"
        "ADMIN_PASSWORD=$(ConvertTo-DotEnvValue $adminPassword)"
        "JWT_SECRET=$(ConvertTo-DotEnvValue (New-RandomSecret 48))"
        "CPE_DEFAULT_URL=$(ConvertTo-DotEnvValue $cpeUrl.TrimEnd('/'))"
        "CPE_USERNAME=$(ConvertTo-DotEnvValue $cpeUsername)"
        "CPE_PASSWORD=$(ConvertTo-DotEnvValue $cpePassword)"
        "CPE_SESSION_SECRET=$(ConvertTo-DotEnvValue (New-RandomSecret 48))"
        "CPE_CONFIG_SECRET=$(ConvertTo-DotEnvValue (New-RandomSecret 48))"
        'CPE_SESSION_MAX_IDLE_HOURS=24'
        'CPE_REQUEST_TIMEOUT_MS=15000'
    )
    [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host "首次登录密码：$adminPassword"
    Write-Host '请立即保存该密码；它也保存在本机 .env 文件中。'
}

docker compose up --detach --build
if ($LASTEXITCODE -ne 0) {
    throw '容器启动失败。请检查上方 Docker 输出；配置保存在 .env 中，可修正后重新运行本脚本。'
}

Write-Host ''
Write-Host 'CPE Monitor 已在后台启动。首次构建可能需要几分钟。'
if (Test-Path -LiteralPath $envPath) {
    $portLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^APP_PORT=' } | Select-Object -First 1
    $port = if ($portLine) { $portLine.Substring('APP_PORT='.Length) } else { '3000' }
    Write-Host "访问地址：http://localhost:$port"
}
