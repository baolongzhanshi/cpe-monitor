using System.Globalization;
using System.Text.Json;
using System.Windows.Forms;

namespace CpeMonitor.Native;

internal sealed class AlertsView : UserControl, INativeView
{
    private readonly ApiClient _api;
    private readonly DataGridView _rules = NativeUi.Grid();
    private readonly DataGridView _logs = NativeUi.Grid();
    private readonly Label _status = NativeUi.Label("");
    private readonly Label _pageLabel = NativeUi.Label("");
    private readonly List<Button> _buttons = [];
    private readonly Button _previous;
    private readonly Button _next;
    private CancellationTokenSource _operations = new();
    private bool _busy;
    private int _page = 1;
    private int _total;
    private const int PageSize = 30;

    public int RefreshIntervalSeconds => 0;

    public AlertsView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        Dock = DockStyle.Fill;
        Padding = new Padding(20);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        root.Controls.Add(NativeUi.Label("告警", 18, true), 0, 0);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        toolbar.Controls.AddRange([
            Command("刷新", ReloadAsync),
            Command("新建规则", token => EditAsync(false, token)),
            Command("编辑规则", token => EditAsync(true, token)),
            Command("删除规则", DeleteAsync)
        ]);
        root.Controls.Add(toolbar, 0, 1);
        var tabs = new TabControl { Dock = DockStyle.Fill };
        var rulesTab = new TabPage("规则") { Padding = new Padding(6) };
        _rules.Dock = DockStyle.Fill;
        AddColumn(_rules, "名称", 24); AddColumn(_rules, "指标", 22);
        AddColumn(_rules, "条件", 18); AddColumn(_rules, "状态", 10);
        AddColumn(_rules, "静默期", 12); AddColumn(_rules, "通知渠道", 14);
        _rules.CellDoubleClick += async (_, e) =>
        {
            if (e.RowIndex >= 0) await RunAsync(token => EditAsync(true, token), _operations.Token);
        };
        rulesTab.Controls.Add(_rules); tabs.TabPages.Add(rulesTab);
        var logsTab = new TabPage("历史") { Padding = new Padding(6) };
        var logsLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        logsLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        logsLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        _logs.Dock = DockStyle.Fill;
        AddColumn(_logs, "时间", 20); AddColumn(_logs, "规则", 20);
        AddColumn(_logs, "内容", 48); AddColumn(_logs, "通知", 12);
        logsLayout.Controls.Add(_logs, 0, 0);
        var pager = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        _previous = Command("上一页", token => ChangePageAsync(-1, token));
        _next = Command("下一页", token => ChangePageAsync(1, token));
        _pageLabel.Margin = new Padding(12, 9, 12, 0);
        pager.Controls.AddRange([_previous, _pageLabel, _next]);
        logsLayout.Controls.Add(pager, 0, 1);
        logsTab.Controls.Add(logsLayout); tabs.TabPages.Add(logsTab);
        root.Controls.Add(tabs, 0, 2);
        _status.Dock = DockStyle.Fill; _status.AutoSize = false;
        root.Controls.Add(_status, 0, 3); Controls.Add(root);
        ResumeLayout(true); UpdatePager();
    }

    public Task RefreshAsync(CancellationToken cancellationToken) => RunAsync(ReloadAsync, cancellationToken);

    private async Task ReloadAsync(CancellationToken token)
    {
        await LoadRulesAsync(token);
        await LoadLogsAsync(token);
    }

    private async Task ChangePageAsync(int delta, CancellationToken token)
    {
        var original = _page; _page = Math.Max(1, _page + delta);
        try { await LoadLogsAsync(token); }
        catch { _page = original; UpdatePager(); throw; }
    }

    private async Task LoadRulesAsync(CancellationToken token)
    {
        var selectedId = SelectedRule() is { } selected ? NativeUi.Number(selected, "id") : 0;
        var response = await _api.GetAsync("/api/alerts/rules", token);
        token.ThrowIfCancellationRequested(); if (IsDisposed) return;
        _rules.Rows.Clear();
        foreach (var rule in Items(response))
        {
            var channels = new List<string>();
            if (NativeUi.Bool(rule, "notifyEmail")) channels.Add("邮件");
            if (NativeUi.Bool(rule, "notifyWechat")) channels.Add("企业微信");
            var row = _rules.Rows[_rules.Rows.Add(
                NativeUi.String(rule, "name"), MetricLabel(NativeUi.String(rule, "metricType")),
                NativeUi.String(rule, "operator") + " " + NativeUi.Number(rule, "threshold").ToString("0.###", CultureInfo.CurrentCulture),
                NativeUi.Bool(rule, "enabled") ? "启用" : "停用",
                NativeUi.Number(rule, "cooldownMinutes", 30).ToString("0") + " 分钟",
                channels.Count == 0 ? "仅记录" : string.Join("、", channels))];
            row.Tag = rule.Clone();
            if (NativeUi.Number(rule, "id") == selectedId) row.Selected = true;
        }
    }

    private async Task LoadLogsAsync(CancellationToken token)
    {
        var response = await _api.GetAsync($"/api/alerts/logs?page={_page}&pageSize={PageSize}", token);
        token.ThrowIfCancellationRequested(); if (IsDisposed) return;
        _total = (int)NativeUi.Number(response, "total");
        _logs.Rows.Clear();
        foreach (var log in NativeUi.Array(response, "logs"))
            _logs.Rows.Add(LocalTime(NativeUi.String(log, "triggeredAt")), NativeUi.String(log, "ruleName", "已删除规则"),
                NativeUi.String(log, "message"), NativeUi.Bool(log, "notified") ? "已通知" : "未通知");
        UpdatePager();
    }

    private async Task EditAsync(bool existing, CancellationToken token)
    {
        var selected = existing ? SelectedRule() : null;
        if (existing && selected is null) throw new InvalidOperationException("请先选择一条规则");
        using var editor = new RuleEditor(selected);
        if (editor.ShowDialog(FindForm()) != DialogResult.OK) return;
        token.ThrowIfCancellationRequested();
        var body = editor.Body();
        if (selected is { } value) body["id"] = (int)NativeUi.Number(value, "id");
        if (existing) await _api.PutAsync("/api/alerts/rules", body, token);
        else await _api.PostAsync("/api/alerts/rules", body, token);
        await ReloadAsync(token);
    }

    private async Task DeleteAsync(CancellationToken token)
    {
        var rule = SelectedRule() ?? throw new InvalidOperationException("请先选择一条规则");
        if (MessageBox.Show(FindForm(), $"删除规则“{NativeUi.String(rule, "name")}”？", "删除告警规则",
            MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        await _api.DeleteAsync($"/api/alerts/rules?id={(int)NativeUi.Number(rule, "id")}", token);
        await ReloadAsync(token);
    }

    private JsonElement? SelectedRule() => _rules.SelectedRows.Count > 0 && _rules.SelectedRows[0].Tag is JsonElement rule ? rule : null;
    private Button Command(string text, Func<CancellationToken, Task> action)
    {
        var button = NativeUi.Button(text);
        button.Click += async (_, _) => await RunAsync(action, _operations.Token);
        _buttons.Add(button); return button;
    }

    private async Task RunAsync(Func<CancellationToken, Task> action, CancellationToken token)
    {
        if (_busy || IsDisposed) return;
        _busy = true; foreach (var button in _buttons) button.Enabled = false;
        NativeUi.Status(_status, "处理中...");
        try
        {
            await action(token);
            if (!IsDisposed && !token.IsCancellationRequested)
                NativeUi.Status(_status, $"{_rules.Rows.Count} 条规则，{_total} 条告警记录");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        { if (!IsDisposed) NativeUi.Status(_status, "操作已取消；规则修改可能已生效，可刷新确认", true); }
        catch (Exception error) { if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
        finally
        {
            _busy = false;
            if (!IsDisposed) { foreach (var button in _buttons) button.Enabled = true; UpdatePager(); }
        }
    }

    private void UpdatePager()
    {
        var pages = Math.Max(1, (_total + PageSize - 1) / PageSize);
        _pageLabel.Text = $"第 {_page} / {pages} 页，共 {_total} 条";
        _previous.Enabled = !_busy && _page > 1; _next.Enabled = !_busy && _page < pages;
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
    private static IEnumerable<JsonElement> Items(JsonElement value) => value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : [];
    private static string LocalTime(string raw) => NativeUi.Timestamp(raw);
    private static void AddColumn(DataGridView grid, string name, int weight) => grid.Columns.Add(new DataGridViewTextBoxColumn
    { HeaderText = name, FillWeight = weight, AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill, MinimumWidth = 75 });

    private static readonly (string Key, string Label)[] Metrics =
    [
        ("traffic_down", "区间下载流量 (MB)"), ("traffic_up", "区间上传流量 (MB)"),
        ("download_rate", "平均下载速率 (Mbps)"), ("upload_rate", "平均上传速率 (Mbps)"),
        ("devices", "在线设备数量 (台)"), ("rsrp", "RSRP (dBm)"), ("rsrq", "RSRQ (dB)"),
        ("sinr", "SINR (dB)"), ("rssi", "RSSI (dBm)"), ("signal", "兼容信号强度 (dBm)"),
        ("collection_failures", "连续采集失败 (次)")
    ];
    private static string MetricLabel(string key) => Metrics.FirstOrDefault(item => item.Key == key).Label ?? key;
    private sealed class RuleEditor : Form
    {
        private readonly TextBox _name = NativeUi.TextBox();
        private readonly ComboBox _metric = new() { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly ComboBox _operator = new() { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly NumericUpDown _threshold = new() { Minimum = -1000000000000m, Maximum = 1000000000000m, DecimalPlaces = 3 };
        private readonly NumericUpDown _cooldown = new() { Minimum = 1, Maximum = 10080, Value = 30 };
        private readonly CheckBox _enabled = new() { Text = "启用规则", AutoSize = true, Checked = true };
        private readonly CheckBox _email = new() { Text = "邮件", AutoSize = true };
        private readonly CheckBox _wechat = new() { Text = "企业微信", AutoSize = true };
        private readonly Label _validation = NativeUi.Label("");

        public RuleEditor(JsonElement? rule)
        {
            Text = rule is null ? "新建告警规则" : "编辑告警规则";
            StartPosition = FormStartPosition.CenterParent; FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false; ClientSize = new System.Drawing.Size(540, 390);
            Padding = new Padding(18); Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);
            var table = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 9 };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            _metric.Items.AddRange(Metrics.Select(item => (object)item.Label).ToArray()); _metric.SelectedIndex = 0;
            _operator.Items.AddRange([">", "<", ">=", "<="]); _operator.SelectedIndex = 0;
            Add(table, 0, "规则名称", _name); Add(table, 1, "监控指标", _metric);
            Add(table, 2, "比较条件", _operator); Add(table, 3, "阈值", _threshold);
            Add(table, 4, "静默期 (分钟)", _cooldown); Add(table, 5, "规则状态", _enabled);
            var channels = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            channels.Controls.AddRange([_email, _wechat]); Add(table, 6, "通知渠道", channels);
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            _validation.Dock = DockStyle.Fill; table.Controls.Add(_validation, 0, 7); table.SetColumnSpan(_validation, 2);
            var commands = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
            var cancel = NativeUi.Button("取消"); cancel.DialogResult = DialogResult.Cancel;
            var save = NativeUi.Button("保存");
            save.Click += (_, _) =>
            {
                if (string.IsNullOrWhiteSpace(_name.Text) || _name.Text.Trim().Length > 100)
                { NativeUi.Status(_validation, "规则名称不能为空且不能超过 100 字", true); return; }
                DialogResult = DialogResult.OK;
            };
            commands.Controls.AddRange([save, cancel]); table.Controls.Add(commands, 0, 8); table.SetColumnSpan(commands, 2);
            Controls.Add(table); AcceptButton = save; CancelButton = cancel;
            if (rule is { } value)
            {
                _name.Text = NativeUi.String(value, "name");
                _metric.SelectedIndex = Math.Max(0, Array.FindIndex(Metrics, item => item.Key == NativeUi.String(value, "metricType")));
                _operator.SelectedItem = NativeUi.String(value, "operator", ">");
                _threshold.Value = (decimal)Math.Clamp(NativeUi.Number(value, "threshold"), (double)_threshold.Minimum, (double)_threshold.Maximum);
                _cooldown.Value = (decimal)Math.Clamp(NativeUi.Number(value, "cooldownMinutes", 30), 1, 10080);
                _enabled.Checked = NativeUi.Bool(value, "enabled"); _email.Checked = NativeUi.Bool(value, "notifyEmail");
                _wechat.Checked = NativeUi.Bool(value, "notifyWechat");
            }
        }

        public Dictionary<string, object> Body() => new()
        {
            ["name"] = _name.Text.Trim(), ["metricType"] = Metrics[_metric.SelectedIndex].Key,
            ["operator"] = _operator.SelectedItem?.ToString() ?? ">", ["threshold"] = _threshold.Value,
            ["enabled"] = _enabled.Checked, ["notifyEmail"] = _email.Checked, ["notifyWechat"] = _wechat.Checked,
            ["cooldownMinutes"] = (int)_cooldown.Value
        };
        private static void Add(TableLayoutPanel table, int row, string label, Control control)
        {
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 37));
            table.Controls.Add(NativeUi.Label(label), 0, row); control.Dock = DockStyle.Fill; table.Controls.Add(control, 1, row);
        }
    }
}
