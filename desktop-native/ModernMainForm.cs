using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Text.Json;

namespace CpeMonitor.Native;

/// <summary>
/// 现代页面宿主：页面来自随安装包分发的本机后台，仍在软件窗口内显示。
/// </summary>
internal sealed class ModernMainForm : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Label _loading = new()
    {
        Dock = DockStyle.Fill,
        Text = "正在启动 CPE Monitor…",
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Microsoft YaHei UI", 12f),
    };
    private bool _initialized;
    private bool _disposed;
    private bool _suspended;
    private bool _updatingVisibility;
    private bool _visibilityPending;
    private bool? _pageDarkTheme;
    private readonly Func<CoreWebView2, Task>? _configureBrowser;
    internal Microsoft.Web.WebView2.Core.CoreWebView2? Browser => _webView.CoreWebView2;
    internal bool Ready => _initialized;
    internal bool EmbeddedViewVisible => _webView.Visible;
    internal bool PageSuspended => _suspended;
    internal string? InitializationError { get; private set; }

    public ModernMainForm(Func<CoreWebView2, Task>? configureBrowser = null)
    {
        SuspendLayout();
        _configureBrowser = configureBrowser;
        Text = "CPE Monitor";
        Size = new Size(1200, 780);
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        BackColor = Color.FromArgb(244, 248, 249);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Controls.Add(_loading);
        Controls.Add(_webView);
        _webView.Visible = false;
        Shown += async (_, _) => await InitializeAsync();
        Resize += async (_, _) => await UpdateVisibilityAsync();
        VisibleChanged += async (_, _) => await UpdateVisibilityAsync();
        ResumeLayout(true);
    }

    private async Task InitializeAsync()
    {
        if (_initialized || _disposed) return;
        try
        {
            var userData = Path.Combine(ServerHost.DataDirectory, "webview-profile");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            if (_disposed) return;
            await _webView.EnsureCoreWebView2Async(environment);
            if (_disposed) return;
            var core = _webView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__CPE_MONITOR_DESKTOP__ = true; window.__CPE_MONITOR_VISIBLE__ = true;");
            if (_disposed) return;
            // 页面会汇报实际生效的主题；标题栏跟随页面，页面跟随系统时即等于跟随系统。
            core.WebMessageReceived += (_, args) =>
            {
                try
                {
                    using var message = JsonDocument.Parse(args.WebMessageAsJson);
                    var root = message.RootElement;
                    if (root.TryGetProperty("type", out var type) && type.GetString() == "theme"
                        && root.TryGetProperty("dark", out var dark)
                        && (dark.ValueKind == JsonValueKind.True || dark.ValueKind == JsonValueKind.False))
                    {
                        _pageDarkTheme = dark.GetBoolean();
                        ApplyWindowTheme();
                    }
                }
                catch (JsonException) { }
            };
            core.NavigationStarting += (_, args) =>
            {
                var port = ServerHost.Port;
                var allowed = $"http://127.0.0.1:{port}/";
                if (!args.Uri.StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
            };
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                    && uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
                    && uri.Port == ServerHost.Port)
                    core.Navigate(args.Uri);
            };
            core.FrameNavigationStarting += (_, args) =>
            {
                if (!args.Uri.StartsWith($"http://127.0.0.1:{ServerHost.Port}/", StringComparison.OrdinalIgnoreCase)) args.Cancel = true;
            };
            if (_configureBrowser is not null) await _configureBrowser(core);
            if (_disposed) return;
            core.NavigationCompleted += async (_, _) => await UpdateVisibilityAsync();
            core.Navigate($"http://127.0.0.1:{ServerHost.Port}/dashboard?desktopVersion=0.3.7");
            _initialized = true;
            _loading.Visible = false;
            _webView.Visible = true;
            await UpdateVisibilityAsync();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            InitializationError = "未检测到 Microsoft Edge WebView2 Runtime，请重新运行安装包补齐运行时。";
            if (!_disposed) _loading.Text = InitializationError;
        }
        catch (Exception error)
        {
            InitializationError = error.Message;
            if (!_disposed) _loading.Text = $"页面启动失败：{error.Message}";
        }
    }

    private async Task UpdateVisibilityAsync()
    {
        if (!_initialized || _disposed) return;
        // 更新期间到达的新请求不丢弃，标记后由当前循环重新应用一次。
        // 丢弃会导致快速最小化/恢复时状态停留在旧值，页面会误以为仍不可见而暂停刷新。
        if (_updatingVisibility) { _visibilityPending = true; return; }
        _updatingVisibility = true;
        try
        {
            do
            {
                _visibilityPending = false;
                var visible = Visible && WindowState != FormWindowState.Minimized;
                if (visible)
                {
                    // 恢复可见时把内存目标还原为正常，并结束渲染进程挂起。
                    _webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal;
                    if (_suspended) { _webView.CoreWebView2.Resume(); _suspended = false; }
                }
                _webView.Visible = true;
                await _webView.CoreWebView2.ExecuteScriptAsync($"window.__CPE_MONITOR_VISIBLE__ = {visible.ToString().ToLowerInvariant()}; window.dispatchEvent(new CustomEvent('cpe-monitor-visibility', {{ detail: {{ visible: window.__CPE_MONITOR_VISIBLE__ }} }}));");
                if (_disposed) return;
                if (!visible)
                {
                    // 不可见时先降低内存目标（引擎会丢弃缓存并把内存换出），再挂起渲染进程。
                    // 两项都是尽力而为，失败不应影响窗口隐藏。
                    try { _webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; }
                    catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException or System.Runtime.InteropServices.COMException) { }
                    _webView.Visible = false;
                    _suspended = await _webView.CoreWebView2.TrySuspendAsync();
                }
            }
            while (_visibilityPending && !_disposed);
        }
        catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException or System.Runtime.InteropServices.COMException) { }
        finally { _updatingVisibility = false; }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_disposed)
        {
            _disposed = true;
            try
            {
                // 关闭窗口时主动停止页面并释放浏览器进程，避免渲染/GPU 进程继续驻留。
                var core = _webView.CoreWebView2;
                if (core is not null)
                {
                    core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low;
                    core.Stop();
                }
            }
            catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException or System.Runtime.InteropServices.COMException) { }
            _webView.Dispose();
            _loading.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyWindowTheme();
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        // WM_SETTINGCHANGE：系统主题或个性化设置变化时重新应用标题栏配色。
        if (m.Msg == 0x001A && !_disposed) ApplyWindowTheme();
    }

    private void ApplyWindowTheme()
    {
        if (_disposed || !IsHandleCreated) return;
        WindowTheme.Apply(Handle, _pageDarkTheme ?? WindowTheme.IsSystemDark());
    }
}
