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
    # 关闭页面后释放 WebView，后台服务保持原进程；再次运行只恢复窗口。
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $appProcess.Refresh()
        if ($appProcess.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $appProcess.CloseMainWindow()) { throw '未能关闭测试窗口' }
    Start-Sleep -Seconds 3
    $appProcess.Refresh()
    if ($appProcess.HasExited -or $appProcess.MainWindowHandle -ne 0) { throw '托盘后台状态验收失败' }
    $backgroundHealth = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/health' -TimeoutSec 5
    if ($backgroundHealth.status -ne 'ok') { throw '关闭窗口后后台服务停止' }
    $serverPid = (Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess
    $secondLaunch = Start-Process -FilePath (Join-Path $installRoot 'cpeye-desktop.exe') -WindowStyle Hidden -PassThru
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $appProcess.Refresh()
            if ($appProcess.MainWindowHandle -ne 0) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($appProcess.MainWindowHandle -eq 0) { throw '未能重新打开窗口' }
        if ((Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess -ne $serverPid) { throw '重新打开窗口重启了后台服务' }
        if (-not $secondLaunch.WaitForExit(5000)) { throw '单实例检查失败' }
    } finally {
        if (-not $secondLaunch.HasExited) { Stop-Process -Id $secondLaunch.Id -Force }
    }
    Write-Output '安装、服务、登录、首次密码、托盘后台及重新打开验收通过'
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        & taskkill.exe /PID $appProcess.Id /T /F | Out-Null
    }
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait
    }
}
