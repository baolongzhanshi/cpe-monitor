using System.Globalization;
using System.Text.Json;

namespace CpeMonitor.Native;

internal sealed class DashboardView : UserControl, INativeView, INativeActivity
{
    private readonly ApiClient _api;
    private readonly SemaphoreSlim _requests = new(1, 1);
    private CancellationTokenSource _visibleLifetime = new();
    private readonly Label _status = NativeUi.Label("等待实时数据", 9);
    private readonly Label _download = NativeUi.Label("—", 17, true);
    private readonly Label _upload = NativeUi.Label("—", 17, true);
    private readonly Label _devices = NativeUi.Label("—", 17, true);
    private readonly Label _signal = NativeUi.Label("—", 17, true);
    private readonly Label _connection = NativeUi.Label("连接：—", 10);
    private readonly Label _health = NativeUi.Label("采集：—", 10);
    private readonly Label _scheduler = NativeUi.Label("定时监控：—", 10);
    private readonly DataGridView _networkDetails = NativeUi.Grid();
    private readonly DataGridView _trafficDetails = NativeUi.Grid();
    private readonly NativeLineChart _trafficChart = new("下载", "上传", "Mbps");
    private readonly NativeLineChart _signalChart = new("RSRP", null, "dBm");
    private readonly NativeLineChart _deviceChart = new("在线终端", null, "台");
    private readonly ComboBox _range = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 110 };
    private readonly Button _collect;
    private readonly Button _refresh;
    private DateTime _historyAt = DateTime.MinValue;
    private DateTime _planAt = DateTime.MinValue;
    private JsonElement _plan;
    private string _planError = "";

    public int RefreshIntervalSeconds => 5;

    public DashboardView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Margin = Padding.Empty };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 90));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 186));
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(NativeUi.Label("仪表盘", 18, true), 0, 0);
        var commands = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        _refresh = NativeUi.Button("刷新数据", async (_, _) => await RunCommandAsync(async token =>
        {
            _historyAt = DateTime.MinValue; _planAt = DateTime.MinValue;
            await RefreshCoreAsync(token);
        }));
        _collect = NativeUi.Button("立即采集", async (_, _) => await RunCommandAsync(async token =>
        {
            await _api.PostAsync("/api/dashboard/collect", new { }, token);
            _historyAt = DateTime.MinValue; await RefreshCoreAsync(token);
        }));
        commands.Controls.Add(_refresh); commands.Controls.Add(_collect);
        header.Controls.Add(commands, 1, 0);
        _status.Dock = DockStyle.Fill; _status.AutoSize = false; _status.AutoEllipsis = true;
        var metrics = NativeUi.Table(4, 1);
        AddMetric(metrics, 0, "下载速率", _download, NativeUi.Accent);
        AddMetric(metrics, 1, "上传速率", _upload, Color.FromArgb(60, 108, 184));
        AddMetric(metrics, 2, "在线设备", _devices, Color.FromArgb(37, 113, 76));
        AddMetric(metrics, 3, "信号强度", _signal, Color.FromArgb(160, 106, 18));
        var connection = NativeUi.Table(3, 1);
        connection.Controls.Add(_connection, 0, 0); connection.Controls.Add(_health, 1, 0); connection.Controls.Add(_scheduler, 2, 0);
        foreach (Control label in connection.Controls) { label.Dock = DockStyle.Fill; ((Label)label).AutoSize = false; ((Label)label).AutoEllipsis = true; }
        var history = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0, 4, 0, 10) };
        history.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); history.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var rangeBar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        rangeBar.Controls.Add(NativeUi.Label("历史趋势", 10, true));
        _range.Items.AddRange(["近 1 小时", "近 6 小时", "近 24 小时", "近 7 天", "近 30 天"]); _range.SelectedIndex = 2;
        _range.SelectedIndexChanged += async (_, _) => await RunCommandAsync(async token =>
        {
            _historyAt = DateTime.MinValue; await RefreshHistoryAsync(token);
        });
        rangeBar.Controls.Add(_range);
        var tabs = new TabControl { Dock = DockStyle.Fill };
        AddChartTab(tabs, "流量", _trafficChart); AddChartTab(tabs, "信号", _signalChart); AddChartTab(tabs, "终端", _deviceChart);
        history.Controls.Add(rangeBar, 0, 0); history.Controls.Add(tabs, 0, 1);
        var details = NativeUi.Table(2, 1);
        InitializeDetailsGrid(_networkDetails, ["运营商", "网络", "频段", "小区 ID", "PCI", "RSRQ / SINR"]);
        InitializeDetailsGrid(_trafficDetails, ["本次下载 / 上传", "累计下载 / 上传", "本次连接", "累计连接", "月度用量", "套餐总量 / 剩余"]);
        details.Controls.Add(_networkDetails, 0, 0); details.Controls.Add(_trafficDetails, 1, 0);
        _networkDetails.Margin = new Padding(0, 0, 10, 0); _trafficDetails.Margin = Padding.Empty;
        root.Controls.Add(header, 0, 0); root.Controls.Add(_status, 0, 1); root.Controls.Add(metrics, 0, 2);
        root.Controls.Add(connection, 0, 3); root.Controls.Add(history, 0, 4); root.Controls.Add(details, 0, 5);
        Controls.Add(root);
        ResumeLayout(true);
    }

    private static void AddMetric(TableLayoutPanel table, int index, string title, Label value, Color color)
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.White, ColumnCount = 1, RowCount = 2,
            Margin = new Padding(0, 0, index == 3 ? 0 : 10, 6), Padding = new Padding(12, 5, 8, 5) };
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 26)); panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        value.ForeColor = color; value.AutoSize = false; value.AutoEllipsis = true; value.Dock = DockStyle.Fill;
        panel.Controls.Add(NativeUi.Label(title, 9), 0, 0); panel.Controls.Add(value, 0, 1); table.Controls.Add(panel, index, 0);
    }

    private static void AddChartTab(TabControl tabs, string name, Control chart)
    {
        var tab = new TabPage(name) { Padding = new Padding(6), BackColor = Color.White };
        tab.Controls.Add(chart); tabs.TabPages.Add(tab);
    }

    private static void InitializeDetailsGrid(DataGridView grid, IEnumerable<string> labels)
    {
        grid.ColumnHeadersVisible = false; grid.RowTemplate.Height = 27;
        grid.Columns.Add("name", "项目"); grid.Columns.Add("value", "数值");
        grid.Columns[0].FillWeight = 40; grid.Columns[1].FillWeight = 60;
        foreach (var label in labels) grid.Rows.Add(label, "—");
    }

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!await _requests.WaitAsync(0, cancellationToken)) return;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _visibleLifetime.Token);
        try { await RefreshCoreAsync(linked.Token); } finally { _requests.Release(); }
    }

    private async Task RefreshCoreAsync(CancellationToken token)
    {
        var live = await _api.GetAsync("/api/dashboard/live", token);
        token.ThrowIfCancellationRequested();
        if (IsDisposed) return;
        var overview = NativeUi.Object(live, "overview"); var snapshot = NativeUi.Object(overview, "networkSnapshot");
        var traffic = NativeUi.Object(live, "trafficStats"); var error = NativeUi.String(overview, "cpeError");
        var stale = NativeUi.Bool(live, "stale") || NativeUi.String(overview, "source") != "cpe";
        _download.Text = stale ? "—" : Rate(NativeUi.Number(overview, "currentDownload", double.NaN));
        _upload.Text = stale ? "—" : Rate(NativeUi.Number(overview, "currentUpload", double.NaN));
        var deviceCount = NativeUi.Number(overview, "connectedDevices", double.NaN);
        _devices.Text = double.IsFinite(deviceCount) ? $"{deviceCount:N0} 台" : "—";
        var signal = NativeUi.Number(overview, "signalStrength", double.NaN);
        _signal.Text = double.IsFinite(signal) && signal != 0 ? $"{signal:N0} dBm" : "—";
        _connection.Text = $"连接：{Connection(NativeUi.String(overview, "connectionStatus"))}";
        _health.Text = $"采集：{NativeUi.String(NativeUi.Object(overview, "collectionHealth"), "label", "未知")}";
        var scheduler = NativeUi.Object(overview, "schedulerStatus");
        _scheduler.Text = NativeUi.Bool(scheduler, "enabled") ? $"定时监控：每 {NativeUi.Number(scheduler, "interval"):N0} 分钟" : "定时监控：已关闭";
        NativeUi.Status(_status, stale ? $"实时数据暂不可用：{error}" : $"最近更新 {NativeUi.Timestamp(NativeUi.String(live, "collectedAt"))}", stale);
        SetDetail(_networkDetails, 0, NativeUi.String(snapshot, "carrier", "—"));
        SetDetail(_networkDetails, 1, NativeUi.String(snapshot, "networkType", "—"));
        SetDetail(_networkDetails, 2, NativeUi.String(NativeUi.Object(snapshot, "signal"), "bandInfo", NativeUi.String(snapshot, "band", "—")));
        SetDetail(_networkDetails, 3, NativeUi.String(snapshot, "cellId", "—"));
        SetDetail(_networkDetails, 4, NativeUi.String(snapshot, "pci", "—"));
        SetDetail(_networkDetails, 5, $"{NativeUi.String(snapshot, "rsrq", "—")} dB / {NativeUi.String(snapshot, "sinr", "—")} dB");
        SetDetail(_trafficDetails, 0, $"{NativeUi.Bytes(NativeUi.Number(traffic, "CurrentDownload", double.NaN))} / {NativeUi.Bytes(NativeUi.Number(traffic, "CurrentUpload", double.NaN))}");
        SetDetail(_trafficDetails, 1, $"{NativeUi.Bytes(NativeUi.Number(traffic, "TotalDownload", double.NaN))} / {NativeUi.Bytes(NativeUi.Number(traffic, "TotalUpload", double.NaN))}");
        SetDetail(_trafficDetails, 2, Duration(NativeUi.Number(traffic, "CurrentConnectTime", double.NaN)));
        SetDetail(_trafficDetails, 3, Duration(NativeUi.Number(traffic, "TotalConnectTime", double.NaN)));
        var used = NativeUi.Number(traffic, "CurrentMonthDownload", double.NaN) + NativeUi.Number(traffic, "CurrentMonthUpload", double.NaN);
        var hasMonth = double.IsFinite(used);
        SetDetail(_trafficDetails, 4, hasMonth ? NativeUi.Bytes(used) : "设备未提供月度计数");
        if ((DateTime.UtcNow - _planAt).TotalMinutes >= 5)
        {
            _planAt = DateTime.UtcNow;
            try
            {
                _plan = await _api.GetAsync("/api/dashboard/start-date", token);
                _planError = "";
            }
            catch (OperationCanceledException) { _planAt = DateTime.MinValue; throw; }
            catch (Exception exception) { _planError = exception.Message; }
        }
        var limit = NativeUi.Number(_plan, "trafficmaxlimit");
        SetDetail(_trafficDetails, 5, limit > 0 ? $"{NativeUi.Bytes(limit)} / {(hasMonth ? NativeUi.Bytes(Math.Max(0, limit - used)) : "—")}" : string.IsNullOrEmpty(_planError) ? "未设置套餐上限" : "套餐信息暂不可用");
        if ((DateTime.UtcNow - _historyAt).TotalSeconds >= 60) await RefreshHistoryAsync(token);
        if (!string.IsNullOrEmpty(_planError) && !stale)
            NativeUi.Status(_status, $"实时数据已更新；套餐读取失败：{_planError}", true);
    }

    private async Task RefreshHistoryAsync(CancellationToken token)
    {
        var ranges = new[] { "1h", "6h", "24h", "7d", "30d" };
        var data = await _api.GetAsync($"/api/dashboard/traffic?range={ranges[Math.Max(0, _range.SelectedIndex)]}", token);
        token.ThrowIfCancellationRequested();
        if (IsDisposed) return;
        if (data.ValueKind != JsonValueKind.Array) throw new InvalidDataException("历史数据格式不正确");
        var traffic = new List<ChartSample>(); var signal = new List<ChartSample>(); var devices = new List<ChartSample>();
        foreach (var item in data.EnumerateArray())
        {
            var text = NativeUi.String(item, "timestamp");
            var normalized = text.Replace(' ', 'T');
            if (normalized.Length == 19) normalized += "Z";
            if (!DateTimeOffset.TryParse(normalized, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time)) continue;
            traffic.Add(new ChartSample(time, NullableNumber(item, "downloadBps", 1_000_000), NullableNumber(item, "uploadBps", 1_000_000)));
            signal.Add(new ChartSample(time, NullableNumber(item, "rsrp"))); devices.Add(new ChartSample(time, NullableNumber(item, "connectedDevices")));
        }
        _trafficChart.SetSamples(traffic.OrderBy(item => item.Time).ToArray());
        _signalChart.SetSamples(signal.OrderBy(item => item.Time).ToArray());
        _deviceChart.SetSamples(devices.OrderBy(item => item.Time).ToArray());
        _historyAt = DateTime.UtcNow;
    }

    private static double? NullableNumber(JsonElement item, string name, double divisor = 1)
    {
        var value = NativeUi.Number(item, name, double.NaN); return double.IsFinite(value) ? value / divisor : null;
    }

    private static void SetDetail(DataGridView grid, int row, string value)
    {
        if (!Equals(grid.Rows[row].Cells[1].Value, value)) grid.Rows[row].Cells[1].Value = value;
    }

    private async Task RunCommandAsync(Func<CancellationToken, Task> command)
    {
        if (!await _requests.WaitAsync(0)) return;
        _refresh.Enabled = false; _collect.Enabled = false;
        try { await command(_visibleLifetime.Token); }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
        finally { if (!IsDisposed) { _refresh.Enabled = true; _collect.Enabled = true; } _requests.Release(); }
    }

    public void SetForeground(bool active)
    {
        if (!active) _visibleLifetime.Cancel();
        else if (_visibleLifetime.IsCancellationRequested) { _visibleLifetime.Dispose(); _visibleLifetime = new CancellationTokenSource(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !IsDisposed) { _visibleLifetime.Cancel(); _visibleLifetime.Dispose(); }
        base.Dispose(disposing);
    }

    private static string Rate(double bytesPerSecond) => double.IsFinite(bytesPerSecond) && bytesPerSecond >= 0 ? $"{bytesPerSecond * 8 / 1_000_000:N2} Mbps" : "—";
    private static string Duration(double seconds) => double.IsFinite(seconds) && seconds >= 0 ? $"{Math.Floor(seconds / 3600):N0} 小时 {Math.Floor(seconds % 3600 / 60):N0} 分钟" : "—";
    private static string Connection(string status) => status switch { "connected" or "已连接" or "901" => "已连接", "disconnected" or "已断开" or "902" => "已断开", _ => string.IsNullOrEmpty(status) ? "未知" : status };
}
