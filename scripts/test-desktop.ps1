$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem src-tauri/target/release/bundle/nsis/*-setup.exe | Select-Object -First 1
if (-not $installer) { throw '未找到安装包' }
$installRoot = Join-Path $env:RUNNER_TEMP 'cpeye-smoke-install'
$setup = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw '安装器执行失败' }
$appProcess = $null
try {
    $appProcess = Start-Process -FilePath (Join-Path $installRoot 'cpeye-desktop.exe') -WindowStyle Hidden -PassThru
    $healthy = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($appProcess.HasExited) { throw '桌面程序提前退出' }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/health' -TimeoutSec 1
            if ($health.status -eq 'ok') { $healthy = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) {
        $logPath = Join-Path $env:APPDATA 'com.cpeye.monitor/startup-error.log'
        if (Test-Path $logPath) { Get-Content $logPath }
        throw '内置服务未能启动'
    }
    $login = Invoke-WebRequest 'http://127.0.0.1:3210/login' -TimeoutSec 10
    $firstRun = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/first-run-password' -TimeoutSec 5
    if ($login.StatusCode -ne 200 -or -not $firstRun.available) { throw '首次登录流程验收失败' }
    Write-Output '安装、内置服务、登录页及首次密码提示验收通过'
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        & taskkill.exe /PID $appProcess.Id /T /F | Out-Null
    }
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait
    }
}
