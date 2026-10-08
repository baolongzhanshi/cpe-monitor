using System.Text.Json;

namespace CpeMonitor.Native;

internal sealed class DeviceView : UserControl, INativeView, INativeActivity
{
    private readonly ApiClient _api;
    private readonly SemaphoreSlim _requests = new(1, 1);
    private CancellationTokenSource _foreground = new();
    private readonly Label _status = NativeUi.Label("等待设备信息", 9);
    private readonly DataGridView _identity = NativeUi.Grid();
    private readonly DataGridView _network = NativeUi.Grid();
    private readonly DataGridView _devices = NativeUi.Grid();
    private readonly Button _refresh;
    private DateTime _identityAt = DateTime.MinValue;
    private string _deviceSignature = "";
    private string _identityWarning = "";

    public int RefreshIntervalSeconds => 30;

    public DeviceView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Margin = Padding.Empty };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 265)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(NativeUi.Label("设备", 18, true), 0, 0);
        _refresh = NativeUi.Button("刷新设备");
        _refresh.Click += async (_, _) =>
        {
            if (!await _requests.WaitAsync(0)) return;
            _refresh.Enabled = false;
            try { _identityAt = DateTime.MinValue; await RefreshCoreAsync(_foreground.Token); }
            catch (OperationCanceledException) { }
            catch (Exception error) { if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
            finally { if (!IsDisposed) _refresh.Enabled = true; _requests.Release(); }
        };
        header.Controls.Add(_refresh, 1, 0);
        _status.Dock = DockStyle.Fill; _status.AutoSize = false; _status.AutoEllipsis = true;
        var identityLayout = NativeUi.Table(2, 1);
        InitializeDetails(_identity, ["型号", "软件版本", "WebUI 版本", "硬件版本", "序列号", "IMEI", "WAN IPv4", "WAN IPv6"]);
        InitializeDetails(_network, ["网络", "运营商", "频段", "小区 ID", "PCI", "RSRP", "RSRQ / SINR", "设备信息更新时间"]);
        _identity.Margin = new Padding(0, 0, 10, 10); _network.Margin = new Padding(0, 0, 0, 10);
        identityLayout.Controls.Add(_identity, 0, 0); identityLayout.Controls.Add(_network, 1, 0);
        _devices.Columns.Add("name", "名称"); _devices.Columns.Add("ip", "IP 地址"); _devices.Columns.Add("mac", "MAC 地址");
        _devices.Columns.Add("interface", "连接方式"); _devices.Columns.Add("signal", "信号");
        _devices.Columns.Add("download", "已下载"); _devices.Columns.Add("upload", "已上传");
        _devices.Columns[0].FillWeight = 120; _devices.Columns[2].FillWeight = 130;
        NativeUi.EmptyText(_devices, "尚未读取在线终端");
        root.Controls.Add(header, 0, 0); root.Controls.Add(_status, 0, 1); root.Controls.Add(identityLayout, 0, 2);
        root.Controls.Add(_devices, 0, 3); Controls.Add(root);
        ResumeLayout(true);
    }

    private static void InitializeDetails(DataGridView grid, IEnumerable<string> names)
    {
        grid.ColumnHeadersVisible = false; grid.RowTemplate.Height = 28;
        grid.Columns.Add("name", "项目"); grid.Columns.Add("value", "数值");
        grid.Columns[0].FillWeight = 35; grid.Columns[1].FillWeight = 65;
        foreach (var name in names) grid.Rows.Add(name, "—");
    }

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!await _requests.WaitAsync(0, cancellationToken)) return;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _foreground.Token);
        try { await RefreshCoreAsync(linked.Token); } finally { _requests.Release(); }
    }

    private async Task RefreshCoreAsync(CancellationToken token)
    {
        if ((DateTime.UtcNow - _identityAt).TotalMinutes >= 5)
        {
            var page = await _api.GetAsync("/api/dashboard/device", token);
            token.ThrowIfCancellationRequested();
            if (IsDisposed) return;
            var info = NativeUi.Object(page, "deviceInformation"); var cell = NativeUi.Object(page, "cellInformation");
            var keys = new[] { "DeviceName", "SoftwareVersion", "WebUIVersion", "HardwareVersion", "SerialNumber", "Imei", "WanIPAddress", "WanIPv6Address" };
            for (var i = 0; i < keys.Length; i++) SetDetail(_identity, i, NativeUi.String(info, keys[i], "—"));
            var fallbackName = NativeUi.String(info, "spreadname_zh", NativeUi.String(info, "spreadname_en", "—"));
            if (NativeUi.String(info, "DeviceName").Length == 0) SetDetail(_identity, 0, fallbackName);
            SetDetail(_network, 0, NativeUi.String(cell, "networkType", "—")); SetDetail(_network, 1, NativeUi.String(cell, "carrier", "—"));
            SetDetail(_network, 2, NativeUi.String(NativeUi.Object(cell, "signal"), "bandInfo", NativeUi.String(cell, "band", "—")));
            SetDetail(_network, 3, NativeUi.String(cell, "cellId", "—")); SetDetail(_network, 4, NativeUi.String(cell, "pci", "—"));
            SetDetail(_network, 5, $"{NativeUi.String(cell, "rsrp", "—")} dBm");
            SetDetail(_network, 6, $"{NativeUi.String(cell, "rsrq", "—")} dB / {NativeUi.String(cell, "sinr", "—")} dB");
            _identityWarning = NativeUi.String(page, "cpeError");
            var cached = NativeUi.String(page, "source") == "database";
            SetDetail(_network, 7, cached ? $"缓存 {NativeUi.Timestamp(NativeUi.String(page, "cachedAt"))}" : DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            _identityAt = DateTime.UtcNow;
        }
        var response = await _api.GetAsync("/api/dashboard/devices", token);
        token.ThrowIfCancellationRequested();
        if (IsDisposed) return;
        if (NativeUi.Object(response, "devices").ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("终端列表格式不正确");
        var signature = response.GetRawText();
        if (signature != _deviceSignature)
        {
            var selectedMac = _devices.CurrentRow?.Cells[2].Value?.ToString();
            var firstRow = _devices.FirstDisplayedScrollingRowIndex;
            _devices.Rows.Clear();
            foreach (var item in NativeUi.Array(response, "devices"))
            {
                var name = NativeUi.String(item, "ActualName", NativeUi.String(item, "HostName", "未命名"));
                var row = _devices.Rows.Add(name, NativeUi.String(item, "IPAddress", "—"), NativeUi.String(item, "MACAddress", "—"),
                    NativeUi.String(item, "InterfaceType", "—"), NativeUi.String(item, "rssi", NativeUi.String(item, "SignalStrength", "—")),
                    HostBytes(item, "DownloadBytes", "RxKBytes"), HostBytes(item, "UploadBytes", "TxKBytes"));
                if (Equals(_devices.Rows[row].Cells[2].Value?.ToString(), selectedMac)) _devices.CurrentCell = _devices.Rows[row].Cells[0];
            }
            _deviceSignature = signature;
            if (firstRow >= 0 && firstRow < _devices.Rows.Count) _devices.FirstDisplayedScrollingRowIndex = firstRow;
        }
        NativeUi.EmptyText(_devices, "当前没有在线终端");
        NativeUi.Status(_status, string.IsNullOrEmpty(_identityWarning)
            ? $"在线 {_devices.Rows.Count} 台，终端列表更新于 {DateTime.Now:HH:mm:ss}" : $"设备身份来自缓存：{_identityWarning}", !string.IsNullOrEmpty(_identityWarning));
    }

    private static string HostBytes(JsonElement item, string byteName, string kiloName)
    {
        var value = NativeUi.Number(item, byteName, double.NaN);
        if (!double.IsFinite(value)) value = NativeUi.Number(item, kiloName, double.NaN) * 1024;
        return double.IsFinite(value) ? NativeUi.Bytes(value) : "—";
    }

    private static void SetDetail(DataGridView grid, int row, string value)
    {
        if (!Equals(grid.Rows[row].Cells[1].Value, value)) grid.Rows[row].Cells[1].Value = value;
    }

    public void SetForeground(bool active)
    {
        if (!active) _foreground.Cancel();
        else if (_foreground.IsCancellationRequested) { _foreground.Dispose(); _foreground = new CancellationTokenSource(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !IsDisposed) { _foreground.Cancel(); _foreground.Dispose(); }
        base.Dispose(disposing);
    }
}
