namespace CpeMonitor.Native;

internal sealed class NativeApplicationContext : ApplicationContext
{
    private readonly ApiClient api = new();
    private readonly ServerHost host = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Control dispatcher = new();
    private readonly EventWaitHandle showEvent = new(false, EventResetMode.AutoReset, "Local\\CPEMonitor.ShowWindow");
    private readonly EventWaitHandle exitEvent = new(false, EventResetMode.AutoReset, "Local\\CPEMonitor.Exit");
    private readonly NotifyIcon tray;
    private readonly Thread receiver;
    private readonly System.Windows.Forms.Timer smsWatcher;
    private ProcessTreeSampler? sampler;
    private int? lastSmsUnread;
    private Form? window;
    private bool ready;
    private bool needsSetup;
    private volatile bool exiting;
    private bool resourcesDisposed;
    public NativeApplicationContext()
    {
        _ = dispatcher.Handle;
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 CPE Monitor", null, (_, _) => ShowWindow());
        menu.Items.Add("导出诊断信息", null, async (_, _) => await ExportDiagnosticsAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出并停止同步", null, (_, _) => ExitThread());
        tray = new NotifyIcon { Text = "CPE Monitor 正在启动", Visible = true, ContextMenuStrip = menu, Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowWindow(); };
        // 点击提醒直接打开短信页，省掉一次手动导航。
        tray.BalloonTipClicked += (_, _) =>
        {
            ShowWindow();
            if (window is ModernMainForm { Ready: true } modern && modern.Browser is { } browser)
            {
                try { browser.Navigate($"http://127.0.0.1:{ServerHost.Port}/sms"); }
                catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException or System.Runtime.InteropServices.COMException) { }
            }
        };
        receiver = new Thread(() =>
        {
            // 同时等待“显示窗口”和“请退出”两个信号；后者供安装器在覆盖安装前请求程序自行退出。
            var signals = new WaitHandle[] { showEvent, exitEvent };
            while (!exiting)
            {
                var signaled = WaitHandle.WaitAny(signals);
                if (exiting) break;
                try
                {
                    if (signaled == 0) dispatcher.BeginInvoke((Action)ShowWindow);
                    else dispatcher.BeginInvoke((Action)ExitThread);
                }
                catch (InvalidOperationException) { break; }
            }
        }) { IsBackground = true, Name = "CPE Monitor 单实例通知" };
        receiver.Start();
        // 新短信到达时在本机提醒：推送走 PushPlus，但应用开着时用户在本机也应该有反馈。
        smsWatcher = new System.Windows.Forms.Timer { Interval = 10_000 };
        smsWatcher.Tick += async (_, _) => await CheckNewSmsAsync();
        smsWatcher.Start();
        // 灰度版才创建采样器；正式版没有 canary.flag，这里不会执行。
        if (ProcessTreeSampler.CanaryEnabled) { sampler = new ProcessTreeSampler(api, () => ready); sampler.Start(); }
        var startup = new System.Windows.Forms.Timer { Interval = 1 };
        startup.Tick += async (_, _) =>
        {
            startup.Stop(); startup.Dispose();
            try
            {
                await host.StartAsync(api, lifetime.Token);
                var setup = await api.GetAsync("/api/system/setup-status", lifetime.Token);
                needsSetup = !JsonValues.Bool(setup, "completed");
                ready = true; tray.Text = "CPE Monitor 后台运行中"; ShowWindow();
            }
            catch (OperationCanceledException) { if (!exiting) { MessageBox.Show("本机后台启动超时。", "CPE Monitor", MessageBoxButtons.OK, MessageBoxIcon.Error); ExitThread(); } }
            catch (Exception error) { if (!exiting) { MessageBox.Show(error.Message, "CPE Monitor 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error); ExitThread(); } }
        };
        startup.Start();
    }

    /// <summary>
    /// 轮询本机后台的未读短信数。首次只记录基线，避免启动时为历史未读弹窗；
    /// 之后只在数量增加时提醒一次。
    /// </summary>
    private async Task CheckNewSmsAsync()
    {
        if (!ready || exiting) return;
        try
        {
            var response = await api.GetAsync("/api/dashboard/sms?page=1&pageSize=1", lifetime.Token);
            var unread = (int)JsonValues.Number(response, "unread");
            if (lastSmsUnread is null) { lastSmsUnread = unread; return; }
            if (unread > lastSmsUnread) ShowNewSmsTip(unread - lastSmsUnread.Value);
            lastSmsUnread = unread;
        }
        catch (OperationCanceledException) { }
        catch (Exception error) when (error is HttpRequestException or InvalidOperationException) { }
    }

    private void ShowNewSmsTip(int count)
    {
        try
        {
            tray.BalloonTipTitle = "CPE Monitor";
            tray.BalloonTipText = count > 1 ? $"收到 {count} 条新短信" : "收到 1 条新短信";
            tray.BalloonTipIcon = ToolTipIcon.Info;
            tray.ShowBalloonTip(5000);
        }
        catch (InvalidOperationException) { }
    }

    /// <summary>
    /// 从本机后台取脱敏诊断报告并存到桌面，方便转发排查。
    /// </summary>
    private async Task ExportDiagnosticsAsync()
    {
        if (!ready || exiting) return;
        try
        {
            var text = await api.GetTextAsync("/api/system/diagnostics", lifetime.Token);
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var path = Path.Combine(desktop, $"CPE-Monitor-诊断-{DateTime.Now:yyyyMMdd-HHmmss}.json");
            File.WriteAllText(path, text);
            MessageBox.Show($"诊断信息已保存到：\n{path}", "CPE Monitor", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error) when (error is HttpRequestException or InvalidOperationException or IOException or UnauthorizedAccessException or OperationCanceledException)
        {
            MessageBox.Show($"导出诊断信息失败：{error.Message}", "CPE Monitor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
    private void ShowWindow()
    {
        if (!ready || exiting) return;
        if (window is null || window.IsDisposed)
        {
            // 首次安装直接进入设置，已有设备配置的用户仍进入仪表盘。
            window = new ModernMainForm();
            window.FormClosed += (_, _) => window = null;
        }
        window.Show();
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Activate();
    }
    protected override void ExitThreadCore()
    {
        if (exiting) return;
        exiting = true; lifetime.Cancel(); showEvent.Set(); window?.Close(); tray.Visible = false; host.Dispose(); base.ExitThreadCore();
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !resourcesDisposed)
        {
            resourcesDisposed = true;
            exiting = true; lifetime.Cancel(); showEvent.Set(); receiver.Join(1000);
            window?.Dispose(); tray.Visible = false;
            var menu = tray.ContextMenuStrip;
            var icon = tray.Icon;
            sampler?.Dispose(); smsWatcher.Dispose(); tray.Dispose(); menu?.Dispose(); icon?.Dispose(); dispatcher.Dispose(); api.Dispose(); host.Dispose(); lifetime.Dispose(); showEvent.Dispose(); exitEvent.Dispose();
        }
        base.Dispose(disposing);
    }
}
