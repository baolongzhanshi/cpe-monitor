using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace CpeMonitor.Native;

internal sealed class ReportsView : UserControl, INativeView
{
    private readonly ApiClient _api;
    private readonly ComboBox _period = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 150 };
    private readonly DataGridView _reports = NativeUi.Grid();
    private readonly DataGridView _devices = NativeUi.Grid();
    private readonly Label _status = NativeUi.Label("");
    private readonly Label _summary = NativeUi.Label("请选择报告");
    private readonly Button _refresh;
    private readonly Button _export;
    private CancellationTokenSource _operations = new();
    private bool _busy;
    private int _loadedPeriod = -1;

    public int RefreshIntervalSeconds => 0;

    public ReportsView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        Dock = DockStyle.Fill;
        Padding = new Padding(20);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 60));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.Controls.Add(NativeUi.Label("报告", 18, true), 0, 0);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        _period.Items.AddRange(["日报", "周报", "月报"]);
        _period.SelectedIndex = 0;
        _period.Margin = new Padding(0, 5, 12, 0);
        _refresh = NativeUi.Button("刷新");
        _refresh.Click += async (_, _) => await RunAsync(LoadAsync, _operations.Token);
        _export = NativeUi.Button("导出 CSV");
        _export.Click += async (_, _) => await RunAsync(ExportAsync, _operations.Token);
        toolbar.Controls.AddRange([_period, _refresh, _export]);
        root.Controls.Add(toolbar, 0, 1);
        _reports.Dock = DockStyle.Fill;
        AddColumn(_reports, "日期 / 周期", 22);
        AddColumn(_reports, "下载", 16); AddColumn(_reports, "上传", 16);
        AddColumn(_reports, "平均信号", 16); AddColumn(_reports, "网络质量", 18);
        AddColumn(_reports, "生成时间", 25);
        _reports.SelectionChanged += (_, _) => ShowDetails();
        root.Controls.Add(_reports, 0, 2);
        _summary.AutoSize = false; _summary.Dock = DockStyle.Fill;
        _summary.Padding = new Padding(0, 10, 0, 0);
        root.Controls.Add(_summary, 0, 3);
        _devices.Dock = DockStyle.Fill;
        AddColumn(_devices, "终端名称", 24); AddColumn(_devices, "IP 地址", 18);
        AddColumn(_devices, "MAC 地址", 22); AddColumn(_devices, "下载", 16);
        AddColumn(_devices, "上传", 16); AddColumn(_devices, "合计", 16);
        root.Controls.Add(_devices, 0, 4);
        _status.Dock = DockStyle.Fill; _status.AutoSize = false;
        root.Controls.Add(_status, 0, 5);
        Controls.Add(root);
        ResumeLayout(true);
        _period.SelectedIndexChanged += async (_, _) => await RunAsync(LoadAsync, _operations.Token);
    }

    public Task RefreshAsync(CancellationToken cancellationToken) => RunAsync(LoadAsync, cancellationToken);

    private async Task LoadAsync(CancellationToken token)
    {
        var period = _period.SelectedIndex;
        var path = period switch
        {
            1 => "/api/reports/period?type=weekly&limit=52",
            2 => "/api/reports/period?type=monthly&limit=52",
            _ => "/api/reports/daily"
        };
        var response = await _api.GetAsync(path, token);
        token.ThrowIfCancellationRequested(); if (IsDisposed) return;
        var reports = period == 0 ? Items(response) : NativeUi.Array(response, "reports");
        _reports.Rows.Clear();
        foreach (var report in reports)
        {
            var index = _reports.Rows.Add(NativeUi.String(report, period == 0 ? "reportDate" : "periodKey"),
                Bytes(report, "totalDownload"), Bytes(report, "totalUpload"), Numeric(report, "avgSignal", " dBm"),
                NativeUi.String(report, "networkQuality", "数据不足"), LocalTime(NativeUi.String(report, "createdAt")));
            _reports.Rows[index].Tag = report.Clone();
        }
        _loadedPeriod = period;
        if (_reports.Rows.Count > 0) _reports.Rows[0].Selected = true;
        ShowDetails();
        NativeUi.Status(_status, _reports.Rows.Count == 0 ? "暂无已生成的报告" : $"已加载 {_reports.Rows.Count} 份报告");
    }

    private void ShowDetails()
    {
        if (IsDisposed) return;
        _devices.Rows.Clear();
        if (_reports.SelectedRows.Count == 0 || _reports.SelectedRows[0].Tag is not JsonElement report)
        { _summary.Text = "请选择报告"; return; }
        var peak = report.TryGetProperty("peakHour", out var hour) && hour.ValueKind == JsonValueKind.Number
            ? hour.GetInt32().ToString("00") + ":00" : "--";
        _summary.Text = $"下载 {Bytes(report, "totalDownload")}    上传 {Bytes(report, "totalUpload")}    " +
            $"在线率 {Numeric(report, "uptimePercent", "%")}    流量峰值时段 {peak}";
        foreach (var device in NativeUi.Array(report, "topDevices"))
            _devices.Rows.Add(NativeUi.String(device, "name", "未知终端"), NativeUi.String(device, "ip", "--"),
                NativeUi.String(device, "mac", "--"), Bytes(device, "downloadBytes"), Bytes(device, "uploadBytes"), Bytes(device, "totalBytes"));
    }

    private async Task ExportAsync(CancellationToken token)
    {
        if (_loadedPeriod != _period.SelectedIndex) throw new InvalidOperationException("请先刷新当前周期报告");
        if (_reports.Rows.Count == 0) throw new InvalidOperationException("暂无可导出的报告");
        using var dialog = new SaveFileDialog
        {
            Filter = "CSV 文件 (*.csv)|*.csv", DefaultExt = "csv", AddExtension = true,
            FileName = $"CPE-Monitor-{_period.SelectedItem}-{DateTime.Now:yyyyMMdd}.csv", OverwritePrompt = true
        };
        if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
        var csv = new StringBuilder("日期或周期,下载字节,上传字节,平均信号dBm,在线率百分比,网络质量,生成时间\r\n");
        foreach (DataGridViewRow row in _reports.Rows)
        {
            if (row.Tag is not JsonElement report) continue;
            csv.Append(Csv(NativeUi.String(report, _loadedPeriod == 0 ? "reportDate" : "periodKey"))).Append(',')
                .Append(RawNumber(report, "totalDownload")).Append(',').Append(RawNumber(report, "totalUpload")).Append(',')
                .Append(RawNumber(report, "avgSignal")).Append(',').Append(RawNumber(report, "uptimePercent")).Append(',')
                .Append(Csv(NativeUi.String(report, "networkQuality"))).Append(',')
                .Append(Csv(LocalTime(NativeUi.String(report, "createdAt")))).Append("\r\n");
        }
        await File.WriteAllTextAsync(dialog.FileName, csv.ToString(), new UTF8Encoding(true), token);
        if (!IsDisposed && !token.IsCancellationRequested) NativeUi.Status(_status, $"已导出：{dialog.FileName}");
    }

    private async Task RunAsync(Func<CancellationToken, Task> action, CancellationToken token)
    {
        if (_busy || IsDisposed) return;
        _busy = true; _refresh.Enabled = _export.Enabled = _period.Enabled = false;
        NativeUi.Status(_status, "处理中...");
        try { await action(token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        { if (!IsDisposed) NativeUi.Status(_status, "操作已取消", true); }
        catch (Exception error) { if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
        finally
        {
            _busy = false;
            if (!IsDisposed) _refresh.Enabled = _export.Enabled = _period.Enabled = true;
        }
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (!Visible) _operations.Cancel();
        else if (_operations.IsCancellationRequested) { _operations.Dispose(); _operations = new(); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !IsDisposed) { _operations.Cancel(); _operations.Dispose(); }
        base.Dispose(disposing);
    }

    private static string Bytes(JsonElement value, string key)
    {
        if (!HasValue(value, key)) return "--";
        var bytes = NativeUi.Number(value, key);
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var unit = 0;
        while (Math.Abs(bytes) >= 1024 && unit < units.Length - 1) { bytes /= 1024; unit++; }
        return bytes.ToString("0.##", CultureInfo.CurrentCulture) + " " + units[unit];
    }
    private static string Numeric(JsonElement value, string key, string unit) => HasValue(value, key)
        ? NativeUi.Number(value, key).ToString("0.##", CultureInfo.CurrentCulture) + unit : "--";
    private static string RawNumber(JsonElement value, string key) => HasValue(value, key)
        ? NativeUi.Number(value, key).ToString("R", CultureInfo.InvariantCulture) : "";
    private static bool HasValue(JsonElement value, string key) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(key, out var field) && field.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined;
    private static string Csv(string value)
    {
        // 文本列避免被电子表格解释为公式，数值列保持数字。
        if (value.Length > 0 && "=+-@\t\r".Contains(value[0])) value = "'" + value;
        return "\"" + value.Replace("\"", "\"\"") + "\"";
    }
    private static string LocalTime(string raw) => NativeUi.Timestamp(raw);
    private static IEnumerable<JsonElement> Items(JsonElement value) => value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : [];
    private static void AddColumn(DataGridView grid, string name, int weight) => grid.Columns.Add(new DataGridViewTextBoxColumn
    { HeaderText = name, FillWeight = weight, AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, MinimumWidth = 75 });
}
