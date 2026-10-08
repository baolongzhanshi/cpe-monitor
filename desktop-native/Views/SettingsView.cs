using System.Globalization;
using System.Text.Json;
using System.Windows.Forms;

namespace CpeMonitor.Native;

internal sealed class SettingsView : UserControl, INativeView
{
    private readonly ApiClient _api;
    private readonly TabControl _tabs = new() { Dock = DockStyle.Fill };
    private readonly HashSet<string> _dirtySections = [];
    private readonly Label _status = NativeUi.Label("");
    private readonly Label _passwordState = NativeUi.Label("");
    private readonly Label _pushplusState = NativeUi.Label("");
    private readonly Label _emailState = NativeUi.Label("");
    private readonly Label _wechatState = NativeUi.Label("");
    private readonly TextBox _url = NativeUi.TextBox();
    private readonly TextBox _username = NativeUi.TextBox();
    private readonly TextBox _password = NativeUi.TextBox();
    private readonly TextBox _token = NativeUi.TextBox();
    private readonly CheckBox _pushplusEnabled = Toggle("启用 PushPlus");
    private readonly CheckBox _quotaEnabled = Toggle("启用套餐配额");
    private readonly NumericUpDown _quotaGb = NumberInput(0.01m, 10000000m, 890m, 2);
    private readonly TextBox _alertLevels = NativeUi.TextBox();
    private readonly NumericUpDown _resetDay = NumberInput(1, 31, 1);
    private readonly CheckBox _deviceEnabled = Toggle("自动同步设备信息");
    private readonly NumericUpDown _deviceInterval = NumberInput(30, 10080, 360);
    private readonly CheckBox _smsEnabled = Toggle("自动同步短信");
    private readonly NumericUpDown _smsInterval = NumberInput(15, 86400, 15, 2);
    private readonly CheckBox _emailEnabled = Toggle("启用邮件通知");
    private readonly TextBox _smtpHost = NativeUi.TextBox();
    private readonly NumericUpDown _smtpPort = NumberInput(1, 65535, 587);
    private readonly TextBox _smtpUser = NativeUi.TextBox();
    private readonly TextBox _smtpPassword = NativeUi.TextBox();
    private readonly TextBox _emailFrom = NativeUi.TextBox();
    private readonly TextBox _emailTo = NativeUi.TextBox();
    private readonly CheckBox _wechatEnabled = Toggle("启用企业微信通知");
    private readonly TextBox _webhook = NativeUi.TextBox();
    private readonly List<Button> _buttons = [];
    private CancellationTokenSource _operations = new();
    private bool _loaded;
    private bool _busy;
    private bool _passwordConfigured;
    private bool _pushplusConfigured;
    private bool _applying;
    private bool _resourcesDisposed;

    public int RefreshIntervalSeconds => 0;

    public SettingsView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        Dock = DockStyle.Fill;
        Padding = new Padding(20);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        var header = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        header.Controls.Add(NativeUi.Label("设置", 18, true));
        var reload = NativeUi.Button("重新加载");
        reload.Click += async (_, _) =>
        {
            if (_busy) return;
            if (_dirtySections.Count > 0 && MessageBox.Show(FindForm(), "放弃尚未保存的修改并重新加载？", "重新加载设置",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            await RunAsync(LoadAsync, _operations.Token, "设置已加载");
        };
        _buttons.Add(reload);
        header.Controls.Add(reload);
        root.Controls.Add(header, 0, 0);
        var tabs = _tabs;
        root.Controls.Add(_tabs, 0, 1);
        _status.Dock = DockStyle.Fill;
        _status.AutoSize = false;
        root.Controls.Add(_status, 0, 2);
        Controls.Add(root);
        ResumeLayout(true);

        _password.UseSystemPasswordChar = _token.UseSystemPasswordChar = true;
        _smtpPassword.UseSystemPasswordChar = _webhook.UseSystemPasswordChar = true;
        _password.PlaceholderText = "留空保留已有密码";
        _token.PlaceholderText = "留空保留已有 Token";
        _smtpPassword.PlaceholderText = "留空保留已有密码";
        _webhook.PlaceholderText = "留空保留已有 Webhook";
        _url.Text = "http://192.168.31.1";
        _username.Text = "admin";
        _alertLevels.Text = "80,90,100";

        var cpe = AddTab(tabs, "CPE 连接");
        AddField(cpe, "管理地址", _url);
        AddField(cpe, "用户名", _username);
        AddField(cpe, "设备密码", _password);
        AddField(cpe, "密码状态", _passwordState);
        AddCommands(cpe,
            Command("保存连接", SaveCpeAsync),
            Command("测试连接", TestCpeAsync));

        var pushplus = AddTab(tabs, "PushPlus");
        AddField(pushplus, "通知开关", _pushplusEnabled);
        AddField(pushplus, "Token", _token);
        AddField(pushplus, "凭据状态", _pushplusState);
        AddCommands(pushplus, Command("保存 PushPlus", SavePushplusAsync));

        var quota = AddTab(tabs, "套餐配额");
        AddField(quota, "配额开关", _quotaEnabled);
        AddField(quota, "总流量 (GB)", _quotaGb);
        AddField(quota, "告警百分比", _alertLevels);
        AddField(quota, "每月重置日", _resetDay);
        AddCommands(quota, Command("保存配额", SaveQuotaAsync));

        var background = AddTab(tabs, "后台同步");
        AddField(background, "短信同步", _smsEnabled);
        AddField(background, "短信间隔 (秒)", _smsInterval);
        AddCommands(background, Command("保存短信同步", SaveSmsSyncAsync));
        AddField(background, "设备信息", _deviceEnabled);
        AddField(background, "同步间隔 (分钟)", _deviceInterval);
        AddCommands(background, Command("保存设备同步", SaveDeviceSyncAsync));

        var notifications = AddTab(tabs, "其他通知");
        AddField(notifications, "邮件通知", _emailEnabled);
        AddField(notifications, "SMTP 地址", _smtpHost);
        AddField(notifications, "SMTP 端口", _smtpPort);
        AddField(notifications, "SMTP 用户名", _smtpUser);
        AddField(notifications, "SMTP 密码", _smtpPassword);
        AddField(notifications, "密码状态", _emailState);
        AddField(notifications, "发件地址", _emailFrom);
        AddField(notifications, "收件地址", _emailTo);
        AddCommands(notifications, Command("保存邮件通知", SaveEmailAsync));
        AddField(notifications, "企业微信", _wechatEnabled);
        AddField(notifications, "Webhook", _webhook);
        AddField(notifications, "凭据状态", _wechatState);
        AddCommands(notifications, Command("保存企业微信", SaveWechatAsync));
        Track("cpe", _url, _username, _password);
        Track("pushplus", _pushplusEnabled, _token);
        Track("quota", _quotaEnabled, _quotaGb, _alertLevels, _resetDay);
        Track("device", _deviceEnabled, _deviceInterval);
        Track("sms", _smsEnabled, _smsInterval);
        Track("email", _emailEnabled, _smtpHost, _smtpPort, _smtpUser, _smtpPassword, _emailFrom, _emailTo);
        Track("wechat", _wechatEnabled, _webhook);
    }

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (_loaded || _dirtySections.Count > 0 || _busy || IsDisposed) return;
        await RunAsync(LoadAsync, cancellationToken, "设置已加载");
    }

    private async Task LoadAsync(CancellationToken token)
    {
            var cpe = await _api.GetAsync("/api/settings/cpe", token);
            var notifications = await _api.GetAsync("/api/settings/notification", token);
            var quota = await _api.GetAsync("/api/settings/quota", token);
            var device = await _api.GetAsync("/api/settings/device-info-sync", token);
            var sms = await _api.GetAsync("/api/dashboard/sms/settings", token);
            var notificationRows = Items(notifications).Select(row => (Row: row, Config: ParseNotification(row))).ToArray();
            token.ThrowIfCancellationRequested();
            if (IsDisposed) return;
            _applying = true;
            try
            {
            _url.Text = NativeUi.String(cpe, "cpe_url", "http://192.168.31.1");
            _username.Text = NativeUi.String(cpe, "cpe_username", "admin");
            _passwordConfigured = NativeUi.Bool(cpe, "cpe_password_set");
            _passwordState.Text = _passwordConfigured ? "已保存" : "未设置";
            foreach (var row in notificationRows) LoadNotification(row.Row, row.Config);
            _quotaEnabled.Checked = NativeUi.Bool(quota, "enabled");
            SetNumber(_quotaGb, quota, "quotaGb", 890);
            _alertLevels.Text = NativeUi.String(quota, "alertLevels", "80,90,100");
            SetNumber(_resetDay, quota, "resetDay", 1);
            _deviceEnabled.Checked = NativeUi.Bool(device, "enabled");
            SetNumber(_deviceInterval, device, "interval", 360);
            _smsEnabled.Checked = NativeUi.Bool(sms, "enabled");
            // 后台以分钟保存，界面统一以秒显示，避免 15 秒误填为 15 分钟。
            _smsInterval.Value = (decimal)Math.Clamp(NativeUi.Number(sms, "interval", 0.25) * 60,
                (double)_smsInterval.Minimum, (double)_smsInterval.Maximum);
            _password.Clear(); _token.Clear(); _smtpPassword.Clear(); _webhook.Clear();
            _dirtySections.Clear();
            _loaded = true;
            }
            finally { _applying = false; }
    }

    private static JsonElement ParseNotification(JsonElement row)
    {
        var config = NativeUi.Object(row, "config");
        if (config.ValueKind == JsonValueKind.String)
        {
            using var parsed = JsonDocument.Parse(config.GetString() ?? "{}");
            config = parsed.RootElement.Clone();
        }
        if (config.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("通知配置格式不正确，请重新加载");
        return config;
    }

    private void LoadNotification(JsonElement row, JsonElement config)
    {
            var enabled = NativeUi.Bool(row, "enabled");
            switch (NativeUi.String(row, "type"))
            {
                case "pushplus":
                    _pushplusEnabled.Checked = enabled;
                    _pushplusConfigured = NativeUi.Bool(config, "tokenConfigured");
                    _pushplusState.Text = _pushplusConfigured ? "Token 已保存" : "Token 未设置";
                    break;
                case "email":
                    _emailEnabled.Checked = enabled;
                    _smtpHost.Text = NativeUi.String(config, "smtpHost");
                    SetNumber(_smtpPort, config, "smtpPort", 587);
                    _smtpUser.Text = NativeUi.String(config, "smtpUser");
                    _emailFrom.Text = NativeUi.String(config, "from");
                    _emailTo.Text = config.TryGetProperty("to", out var to) && to.ValueKind == JsonValueKind.Array
                        ? string.Join("; ", to.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()))
                        : NativeUi.String(config, "to");
                    _emailState.Text = NativeUi.Bool(config, "smtpPasswordSet") ? "密码已保存" : "密码未设置";
                    break;
                case "wechat":
                    _wechatEnabled.Checked = enabled;
                    _wechatState.Text = NativeUi.Bool(config, "webhookConfigured") ? "Webhook 已保存" : "Webhook 未设置";
                    break;
            }
    }

    private Dictionary<string, object> CpeBody()
    {
        if (string.IsNullOrWhiteSpace(_url.Text) || string.IsNullOrWhiteSpace(_username.Text))
            throw new InvalidOperationException("请填写 CPE 管理地址和用户名");
        if (!_passwordConfigured && string.IsNullOrWhiteSpace(_password.Text))
            throw new InvalidOperationException("请填写设备密码");
        var body = new Dictionary<string, object>
        {
            ["cpeUrl"] = _url.Text.Trim(),
            ["cpeUsername"] = _username.Text.Trim()
        };
        if (!string.IsNullOrWhiteSpace(_password.Text)) body["cpePassword"] = _password.Text;
        return body;
    }

    private async Task SaveCpeAsync(CancellationToken token)
    {
        await _api.PostAsync("/api/settings/cpe", CpeBody(), token);
        _password.Clear();
        _passwordConfigured = true;
        _passwordState.Text = "已保存";
        _dirtySections.Remove("cpe");
        try { await _api.PostAsync("/api/system/setup-status", new { completed = true }, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw new InvalidOperationException("连接已保存，但初始化状态更新失败：" + error.Message); }
    }

    private async Task TestCpeAsync(CancellationToken token)
    {
        var response = await _api.PostAsync("/api/settings/cpe/test", CpeBody(), token);
        if (!NativeUi.Bool(response, "success"))
            throw new InvalidOperationException(NativeUi.String(response, "message", "CPE 连接失败"));
        NativeUi.Status(_status, NativeUi.String(response, "message", "CPE 连接成功") + " " + NativeUi.String(response, "latency"));
    }

    private async Task SavePushplusAsync(CancellationToken token)
    {
        if (_pushplusEnabled.Checked && !_pushplusConfigured && string.IsNullOrWhiteSpace(_token.Text))
            throw new InvalidOperationException("启用 PushPlus 前请填写 Token");
        await _api.PostAsync("/api/settings/notification", new
        {
            type = "pushplus", enabled = _pushplusEnabled.Checked,
            config = new { token = _token.Text.Trim() }
        }, token);
        _pushplusConfigured |= !string.IsNullOrWhiteSpace(_token.Text);
        _token.Clear();
        _pushplusState.Text = _pushplusConfigured ? "Token 已保存" : "Token 未设置";
        _dirtySections.Remove("pushplus");
    }

    private async Task SaveQuotaAsync(CancellationToken token)
    {
        var levels = _alertLevels.Text.Split([',', '，'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (levels.Length == 0 || levels.Any(level => !int.TryParse(level, out var number) || number < 1 || number > 100))
            throw new InvalidOperationException("告警百分比应是 1 至 100 的整数，用逗号分隔");
        await _api.PostAsync("/api/settings/quota", new
        {
            enabled = _quotaEnabled.Checked,
            quotaGb = _quotaGb.Value.ToString(CultureInfo.InvariantCulture),
            alertLevels = string.Join(",", levels), resetDay = _resetDay.Value.ToString(CultureInfo.InvariantCulture)
        }, token);
        _dirtySections.Remove("quota");
    }

    private async Task SaveDeviceSyncAsync(CancellationToken token)
    {
        await _api.PostAsync("/api/settings/device-info-sync", new { enabled = _deviceEnabled.Checked, interval = (int)_deviceInterval.Value }, token);
        _dirtySections.Remove("device");
    }

    private async Task SaveSmsSyncAsync(CancellationToken token)
    {
        await _api.PostAsync("/api/dashboard/sms/settings", new { enabled = _smsEnabled.Checked, interval = _smsInterval.Value / 60m }, token);
        _dirtySections.Remove("sms");
    }

    private async Task SaveEmailAsync(CancellationToken token)
    {
        var recipients = _emailTo.Text.Split([';', ',', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (_emailEnabled.Checked && (string.IsNullOrWhiteSpace(_smtpHost.Text) || recipients.Length == 0))
            throw new InvalidOperationException("请填写 SMTP 地址和收件地址");
        await _api.PostAsync("/api/settings/notification", new
        {
            type = "email", enabled = _emailEnabled.Checked,
            config = new { smtpHost = _smtpHost.Text.Trim(), smtpPort = (int)_smtpPort.Value, smtpUser = _smtpUser.Text.Trim(),
                smtpPass = _smtpPassword.Text, from = _emailFrom.Text.Trim(), to = recipients }
        }, token);
        if (!string.IsNullOrWhiteSpace(_smtpPassword.Text)) _emailState.Text = "密码已保存";
        _smtpPassword.Clear();
        _dirtySections.Remove("email");
    }

    private async Task SaveWechatAsync(CancellationToken token)
    {
        await _api.PostAsync("/api/settings/notification", new
        { type = "wechat", enabled = _wechatEnabled.Checked, config = new { webhookUrl = _webhook.Text.Trim() } }, token);
        if (!string.IsNullOrWhiteSpace(_webhook.Text)) _wechatState.Text = "Webhook 已保存";
        _webhook.Clear();
        _dirtySections.Remove("wechat");
    }

    private Button Command(string text, Func<CancellationToken, Task> action)
    {
        var button = NativeUi.Button(text);
        button.Click += async (_, _) => await RunAsync(action, _operations.Token, text == "测试连接" ? null : "设置已保存");
        _buttons.Add(button);
        return button;
    }

    private async Task RunAsync(Func<CancellationToken, Task> action, CancellationToken token, string? success)
    {
        if (_busy || IsDisposed) return;
        _busy = true;
        _tabs.Enabled = false;
        foreach (var button in _buttons) button.Enabled = false;
        NativeUi.Status(_status, "处理中...");
        try
        {
            await action(token);
            if (!IsDisposed && !token.IsCancellationRequested && success is not null) NativeUi.Status(_status, success);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            if (!IsDisposed) NativeUi.Status(_status, "操作已取消；保存请求可能已生效，可重新加载确认", true);
        }
        catch (Exception error) { if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
        finally
        {
            _busy = false;
            if (!IsDisposed)
            {
                _tabs.Enabled = true;
                foreach (var button in _buttons) button.Enabled = true;
            }
        }
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (_resourcesDisposed) return;
        if (!Visible) _operations.Cancel();
        else if (_operations.IsCancellationRequested)
        {
            _operations.Dispose();
            _operations = new CancellationTokenSource();
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_resourcesDisposed) { _resourcesDisposed = true; _operations.Cancel(); _operations.Dispose(); }
        base.Dispose(disposing);
    }

    private static TableLayoutPanel AddTab(TabControl tabs, string text)
    {
        var page = new TabPage(text) { Padding = new Padding(18), AutoScroll = true };
        var table = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Top };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        page.Controls.Add(table);
        tabs.TabPages.Add(page);
        return table;
    }

    private static void AddField(TableLayoutPanel table, string label, Control control)
    {
        var row = table.RowCount++;
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var caption = NativeUi.Label(label);
        caption.Margin = new Padding(0, 9, 16, 9);
        control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        control.Margin = new Padding(0, 5, 0, 5);
        control.MinimumSize = new System.Drawing.Size(0, 26);
        table.Controls.Add(caption, 0, row);
        table.Controls.Add(control, 1, row);
    }

    private static void AddCommands(TableLayoutPanel table, params Button[] buttons)
    {
        var panel = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 12) };
        panel.Controls.AddRange(buttons);
        AddField(table, "", panel);
    }

    private static CheckBox Toggle(string text) => new() { Text = text, AutoSize = true };
    private void Track(string section, params Control[] controls)
    {
        void Changed(object? sender, EventArgs e) { if (!_applying) _dirtySections.Add(section); }
        foreach (var control in controls)
        {
            if (control is TextBox text) text.TextChanged += Changed;
            else if (control is CheckBox toggle) toggle.CheckedChanged += Changed;
            else if (control is NumericUpDown number) number.ValueChanged += Changed;
        }
    }
    private static NumericUpDown NumberInput(decimal min, decimal max, decimal value, int places = 0) => new()
    { Minimum = min, Maximum = max, Value = value, DecimalPlaces = places, ThousandsSeparator = true };
    private static void SetNumber(NumericUpDown control, JsonElement value, string key, double fallback) =>
        control.Value = (decimal)Math.Clamp(NativeUi.Number(value, key, fallback), (double)control.Minimum, (double)control.Maximum);
    private static IEnumerable<JsonElement> Items(JsonElement value) => value.ValueKind == JsonValueKind.Array
        ? value.EnumerateArray().ToArray() : [];
}
