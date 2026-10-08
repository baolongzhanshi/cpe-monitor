namespace CpeMonitor.Native;

internal sealed class MainForm : Form
{
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1000 };
    private readonly Panel _content = new() { Dock = DockStyle.Fill, Padding = new Padding(18, 14, 18, 12) };
    private readonly ToolStripStatusLabel _status = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly List<(Button Button, UserControl View)> _pages = [];
    private readonly HashSet<INativeView> _loadedViews = [];
    private CancellationTokenSource _lifetime = new();
    private INativeView? _selected;
    private DateTime _lastRefresh = DateTime.MinValue;
    private bool _active;
    private bool _refreshing;
    private bool _wasMinimized;
    private bool _resourcesDisposed;
    private int _generation;
    private readonly bool _automaticRefresh;

    public MainForm(ApiClient api, Action requestExit, bool automaticRefresh = true, int initialPage = 0)
    {
        SuspendLayout();
        _automaticRefresh = automaticRefresh;
        Text = "CPE Monitor";
        Size = new Size(1200, 780);
        MinimumSize = new Size(900, 680);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9f);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        BackColor = NativeUi.Background;
        ForeColor = NativeUi.Foreground;

        var menu = new MenuStrip();
        var file = new ToolStripMenuItem("程序");
        file.DropDownItems.Add("退出程序", null, (_, _) => requestExit());
        menu.Items.Add(file);
        MainMenuStrip = menu;

        var navigation = new FlowLayoutPanel
        {
            Dock = DockStyle.Left, Width = 168, FlowDirection = FlowDirection.TopDown,
            WrapContents = false, BackColor = Color.White, Padding = new Padding(12, 18, 12, 12),
        };
        var brand = NativeUi.Label("CPE Monitor", 13, true);
        brand.AutoSize = false;
        brand.Size = new Size(144, 54);
        brand.MaximumSize = brand.Size;
        brand.AutoEllipsis = true;
        brand.Margin = new Padding(0, 0, 0, 22);
        navigation.Controls.Add(brand);
        AddPage("仪表盘", new DashboardView(api), navigation);
        AddPage("设备", new DeviceView(api), navigation);
        AddPage("短信", new SmsView(api), navigation);
        AddPage("告警", new AlertsView(api), navigation);
        AddPage("报告", new ReportsView(api), navigation);
        AddPage("设置", new SettingsView(api), navigation);

        var statusBar = new StatusStrip { SizingGrip = true };
        statusBar.Items.Add(_status);
        Controls.Add(_content);
        Controls.Add(navigation);
        Controls.Add(statusBar);
        Controls.Add(menu);

        _timer.Tick += async (_, _) => await RefreshCurrentAsync();
        Activated += async (_, _) =>
        {
            if (IsDisposed) return;
            _active = true;
            RenewLifetime();
            SetForegroundActivity();
            if (_selected == null || _selected.RefreshIntervalSeconds > 0 || !_loadedViews.Contains(_selected))
                _lastRefresh = DateTime.MinValue;
            if (_automaticRefresh) await RefreshCurrentAsync();
        };
        Deactivate += (_, _) => { _active = false; CancelPending(); SetForegroundActivity(); };
        Resize += async (_, _) =>
        {
            var minimized = WindowState == FormWindowState.Minimized;
            if (minimized == _wasMinimized) return;
            _wasMinimized = minimized;
            if (minimized)
            {
                SetForegroundActivity();
                CancelPending();
            }
            else if (_active)
            {
                // 最小化期间取消的令牌不能复用，恢复时重新建立本页生命周期。
                RenewLifetime();
                SetForegroundActivity();
                if (_selected == null || _selected.RefreshIntervalSeconds > 0 || !_loadedViews.Contains(_selected))
                    _lastRefresh = DateTime.MinValue;
                if (_automaticRefresh) await RefreshCurrentAsync();
            }
        };
        Shown += async (_, _) =>
        {
            _active = true;
            SelectPage(Math.Clamp(initialPage, 0, _pages.Count - 1));
            if (_automaticRefresh)
            {
                _timer.Start();
                await RefreshCurrentAsync();
            }
        };
        ResumeLayout(true);
    }

    private void AddPage(string title, UserControl view, FlowLayoutPanel navigation)
    {
        view.Dock = DockStyle.Fill;
        view.Visible = false;
        view.BackColor = NativeUi.Background;
        var button = NativeUi.Button(title);
        button.AutoSize = false;
        button.Size = new Size(144, 42);
        button.TextAlign = ContentAlignment.MiddleLeft;
        button.Margin = new Padding(0, 0, 0, 6);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        var index = _pages.Count;
        button.Click += async (_, _) => { SelectPage(index); await RefreshCurrentAsync(); };
        _pages.Add((button, view));
        navigation.Controls.Add(button);
        _content.Controls.Add(view);
    }

    // 隔离界面验收只读取内存 HTTP 响应，不创建后台进程。
    internal async Task<UserControl> SelectTestPageAsync(int index)
    {
        if (_automaticRefresh) throw new InvalidOperationException("界面验收必须关闭自动刷新");
        _active = true;
        SelectPage(index);
        await ((INativeView)_pages[index].View).RefreshAsync(CancellationToken.None);
        return _pages[index].View;
    }

    private void SelectPage(int index)
    {
        var view = (INativeView)_pages[index].View;
        if (ReferenceEquals(_selected, view)) return;
        RenewLifetime();
        for (var i = 0; i < _pages.Count; i++)
        {
            var selected = i == index;
            _pages[i].View.Visible = selected;
            _pages[i].Button.BackColor = selected ? Color.FromArgb(222, 239, 241) : Color.White;
            _pages[i].Button.ForeColor = selected ? NativeUi.Accent : NativeUi.Foreground;
        }
        _pages[index].View.BringToFront();
        _selected = view;
        SetForegroundActivity();
        _lastRefresh = DateTime.MinValue;
        _status.Text = view.RefreshIntervalSeconds <= 0 && _loadedViews.Contains(view)
            ? "" : "正在读取数据…";
    }

    private async Task RefreshCurrentAsync()
    {
        if (_refreshing || !_active || !Visible || WindowState == FormWindowState.Minimized || _selected == null || IsDisposed)
            return;
        var interval = _selected.RefreshIntervalSeconds;
        // 设置等表单只在首次进入时加载，避免自动刷新覆盖未保存输入。
        if (interval <= 0 && _loadedViews.Contains(_selected)) return;
        if (_lastRefresh != DateTime.MinValue && (interval <= 0 || (DateTime.UtcNow - _lastRefresh).TotalSeconds < interval))
            return;
        var generation = _generation;
        var view = _selected;
        var token = _lifetime.Token;
        _refreshing = true;
        _lastRefresh = DateTime.UtcNow;
        try
        {
            await view.RefreshAsync(token);
            if (!IsDisposed && generation == _generation && !token.IsCancellationRequested)
            {
                _loadedViews.Add(view);
                _status.Text = $"最近刷新 {DateTime.Now:HH:mm:ss}";
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (!IsDisposed && generation == _generation)
                _status.Text = $"读取失败：{error.Message}";
        }
        finally { _refreshing = false; }
    }

    private void CancelPending()
    {
        _generation++;
        // 关闭窗口时的事件可能晚于资源释放，取消操作允许重复调用。
        try { _lifetime.Cancel(); }
        catch (ObjectDisposedException) { }
    }

    private void SetForegroundActivity()
    {
        foreach (var page in _pages)
            if (page.View is INativeActivity activity)
                activity.SetForeground(_active && page.View.Visible && WindowState != FormWindowState.Minimized);
    }

    private void RenewLifetime()
    {
        CancelPending();
        _lifetime.Dispose();
        _lifetime = new CancellationTokenSource();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_resourcesDisposed)
        {
            // 先标记，避免关闭事件或重复 Dispose 再次释放托管资源。
            _resourcesDisposed = true;
            _timer.Stop();
            _timer.Dispose();
            CancelPending();
            _lifetime.Dispose();
        }
        base.Dispose(disposing);
    }
}
