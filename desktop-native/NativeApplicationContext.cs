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
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出并停止同步", null, (_, _) => ExitThread());
        tray = new NotifyIcon { Text = "CPE Monitor 正在启动", Visible = true, ContextMenuStrip = menu, Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowWindow(); };
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
            tray.Dispose(); menu?.Dispose(); icon?.Dispose(); dispatcher.Dispose(); api.Dispose(); host.Dispose(); lifetime.Dispose(); showEvent.Dispose(); exitEvent.Dispose();
        }
        base.Dispose(disposing);
    }
}
