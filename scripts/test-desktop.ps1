$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CpeSmokeWindows {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr argument);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr argument);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int limit);
    public static IntPtr FindOwnedWindow(uint owner, string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((window, argument) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != owner) return true;
            var text = new System.Text.StringBuilder(512);
            GetWindowText(window, text, text.Capacity);
            if (text.ToString() != title) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
function Get-CpeMainWindow([int]$appProcessId) {
    $handle = [CpeSmokeWindows]::FindOwnedWindow([uint32]$appProcessId, $script:cpeWindowTitle)
    if ($handle -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
    [uint32]$ownerId = 0
    [void][CpeSmokeWindows]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    if ($ownerId -ne $appProcessId) { return [IntPtr]::Zero }
    return $handle
}

$installer = Get-ChildItem src-tauri/target/release/bundle/nsis/*-setup.exe | Select-Object -First 1
if (-not $installer) { throw '未找到安装包' }
$installRoot = Join-Path $env:RUNNER_TEMP 'cpeye-smoke-install'
if (Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue) { throw '3210 端口已被使用，不能开始安装验收' }
$setup = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw '安装器执行失败' }
$appProcess = $null
$serverPid = $null
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
    # 桌面模式无需登录；无 Cookie 直接访问核心页面和设置接口。
    $dashboard = Invoke-WebRequest 'http://127.0.0.1:3210/dashboard' -MaximumRedirection 0 -TimeoutSec 10
    $authMe = Invoke-WebRequest 'http://127.0.0.1:3210/api/auth/me' -TimeoutSec 5
    $setupStatus = Invoke-WebRequest 'http://127.0.0.1:3210/api/system/setup-status' -TimeoutSec 5
    $cpeConfig = Invoke-WebRequest 'http://127.0.0.1:3210/api/settings/cpe' -TimeoutSec 5
    if ($dashboard.StatusCode -ne 200 -or $authMe.StatusCode -ne 200 -or $setupStatus.StatusCode -ne 200 -or $cpeConfig.StatusCode -ne 200) {
        throw '桌面模式无密码访问验收失败'
    }
    if (($authMe.Content | ConvertFrom-Json).desktopMode -ne $true) { throw '内置服务未启用桌面模式' }
    if (-not (($setupStatus.Content | ConvertFrom-Json).PSObject.Properties.Name -contains 'completed')) { throw '引导设置状态接口返回无效内容' }
    if (-not (($cpeConfig.Content | ConvertFrom-Json).PSObject.Properties.Name -contains 'cpe_url')) { throw 'CPE 配置接口返回无效内容' }
    $firstRun = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/first-run-password' -TimeoutSec 5
    if ($firstRun.PSObject.Properties.Name -contains 'password' -or $firstRun.available -ne $false) { throw '首次密码接口仍泄露管理员密码' }
    $serverPid = (Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess
    $desktopLog = Join-Path $env:APPDATA 'com.cpeye.monitor/desktop-events.log'
    function Get-BrowserOpenCount {
        if (-not (Test-Path $desktopLog)) { return 0 }
        return [regex]::Matches([IO.File]::ReadAllText($desktopLog), '已请求默认浏览器打开控制台').Count
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ((Get-BrowserOpenCount) -gt 0) { break }
        Start-Sleep -Milliseconds 500
    }
    $initialBrowserOpens = Get-BrowserOpenCount
    if ($initialBrowserOpens -eq 0) {
        if (Test-Path $desktopLog) { Get-Content $desktopLog }
        throw '未能请求默认浏览器打开控制台'
    }
    function Assert-NoAppWebView {
        $processes = @(Get-CimInstance Win32_Process)
        $descendants = [Collections.Generic.HashSet[int]]::new()
        [void]$descendants.Add($appProcess.Id)
        do {
            $added = $false
            foreach ($process in $processes) {
                if ($descendants.Contains([int]$process.ParentProcessId) -and $descendants.Add([int]$process.ProcessId)) { $added = $true }
            }
        } while ($added)
        if ($processes | Where-Object { $descendants.Contains([int]$_.ProcessId) -and $_.Name -eq 'msedgewebview2.exe' }) {
            throw '浏览器模式仍创建了应用 WebView 子进程'
        }
    }
    Assert-NoAppWebView
    # 无应用窗口时后台独立存活；重复运行只打开浏览器，复用已有 Node。
    $backgroundHealth = Invoke-RestMethod 'http://127.0.0.1:3210/api/system/health' -TimeoutSec 5
    if ($backgroundHealth.status -ne 'ok') { throw '托盘后台服务停止' }
    $serverPid = (Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess
    $secondLaunch = Start-Process -FilePath (Join-Path $installRoot 'cpeye-desktop.exe') -WindowStyle Hidden -PassThru
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $appProcess.Refresh()
            if ((Get-BrowserOpenCount) -gt $initialBrowserOpens) { break }
            Start-Sleep -Milliseconds 500
        }
        if ((Get-BrowserOpenCount) -le $initialBrowserOpens) {
            if (Test-Path $desktopLog) { Get-Content $desktopLog }
            throw '重复启动未请求浏览器打开控制台'
        }
        if ((Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess -ne $serverPid) { throw '重复启动重启了后台服务' }
        if (-not $secondLaunch.WaitForExit(5000)) { throw '单实例检查失败' }
        Assert-NoAppWebView
    } finally {
        if (-not $secondLaunch.HasExited) { Stop-Process -Id $secondLaunch.Id -Force }
    }
    Write-Output '安装、无密码控制台、核心 API、托盘后台、默认浏览器、无 WebView 及单实例验收通过'
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        & taskkill.exe /PID $appProcess.Id /T /F | Out-Null
    }
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
        if ($uninstall.ExitCode -ne 0) { throw '测试安装卸载失败' }
    }
    # NSIS 卸载器会启动临时进程，等待程序文件和监听端口完全释放。
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Test-Path (Join-Path $installRoot 'cpeye-desktop.exe')) -and -not (Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path (Join-Path $installRoot 'cpeye-desktop.exe')) { throw '测试程序文件卸载后仍有残留' }
    if (Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue) { throw '仍有测试服务占用 3210' }
    if ($appProcess -and (Get-Process -Id $appProcess.Id -ErrorAction SilentlyContinue)) { throw '测试桌面程序进程未清理' }
    if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { throw '测试服务进程未清理' }
    Write-Output '测试安装已卸载，程序文件、进程和监听端口无残留'
}
