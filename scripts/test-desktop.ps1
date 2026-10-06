$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CpeSmokeWindows {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
function Get-CpeMainWindow([int]$appProcessId) {
    $handle = [CpeSmokeWindows]::FindWindow($null, 'CPEye 5G CPE 监控')
    if ($handle -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
    [uint32]$ownerId = 0
    [void][CpeSmokeWindows]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    if ($ownerId -ne $appProcessId) { return [IntPtr]::Zero }
    return $handle
}

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
        if ((Get-CpeMainWindow $appProcess.Id) -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 500
    }
    $originalWindow = Get-CpeMainWindow $appProcess.Id
    if ($originalWindow -eq [IntPtr]::Zero) { throw '未找到应用主窗口' }
    Write-Output "关闭前：进程=$($appProcess.Id)，窗口=$($appProcess.MainWindowHandle)，已退出=$($appProcess.HasExited)"
    if (-not $appProcess.CloseMainWindow()) { throw '未能关闭测试窗口' }
    Start-Sleep -Seconds 3
    $appProcess.Refresh()
    Write-Output "关闭后：进程=$($appProcess.Id)，窗口=$($appProcess.MainWindowHandle)，已退出=$($appProcess.HasExited)"
    # 托盘可能另有原生窗口；验收只判断刚关闭的应用主窗口是否销毁。
    if ($appProcess.HasExited -or [CpeSmokeWindows]::IsWindow($originalWindow)) { throw '托盘后台状态验收失败' }
    $backgroundHealth = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/health' -TimeoutSec 5
    if ($backgroundHealth.status -ne 'ok') { throw '关闭窗口后后台服务停止' }
    $serverPid = (Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess
    $secondLaunch = Start-Process -FilePath (Join-Path $installRoot 'cpeye-desktop.exe') -WindowStyle Hidden -PassThru
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $appProcess.Refresh()
            if ((Get-CpeMainWindow $appProcess.Id) -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 500
        }
        if ((Get-CpeMainWindow $appProcess.Id) -eq [IntPtr]::Zero) { throw '未能重新打开窗口' }
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
