using System.Drawing.Imaging;
using System.Net;
using System.Text;
using System.Text.Json;

namespace CpeMonitor.Native;

// 本测试只使用内存响应。测试数据、截图和结论不能当作真实设备的运行状态。
internal static class UiSmokeTest
{
    internal static int Run()
    {
        var output = Environment.GetEnvironmentVariable("CPE_MONITOR_UI_REPORT_DIR");
        if (string.IsNullOrWhiteSpace(output)) return 2;
        Directory.CreateDirectory(output);
        var results = new List<object>();
        var screenshots = new List<string>();
        var exitCode = 1;
        var application = new ApplicationContext();
        var dispatcher = new Form { ShowInTaskbar = false, Opacity = 0, Size = new Size(1, 1), StartPosition = FormStartPosition.Manual };
        application.MainForm = dispatcher;
        dispatcher.Shown += async (_, _) =>
        {
            try
            {
                foreach (var populated in new[] { false, true })
                {
                    using var handler = new FixtureHandler(populated);
                    using var api = new ApiClient(handler, "http://fixture.invalid");
                    using var form = new MainForm(api, () => { }, automaticRefresh: false)
                    {
                        Text = "CPE Monitor — 固定测试数据",
                        StartPosition = FormStartPosition.Manual,
                        Location = new Point(20, 20)
                    };
                    form.Show();
                    foreach (var size in new[] { new Size(900, 680), new Size(1200, 780) })
                    {
                        // 用逻辑像素定义验收尺寸，避免高 DPI 下强制缩到物理 900 像素。
                        form.Size = new Size((int)Math.Round(size.Width * form.DeviceDpi / 96.0), (int)Math.Round(size.Height * form.DeviceDpi / 96.0));
                        for (var page = 0; page < 6; page++)
                        {
                            var view = await form.SelectTestPageAsync(page);
                            await Task.Delay(120);
                            Assert(view.Visible && view.Width > 0 && view.Height > 0, "页面应当可见");
                            var errors = Descendants(view).OfType<Label>().Select(label => label.Text)
                                .Where(text => text.Contains("格式不正确") || text.Contains("未命中固定响应") || text.StartsWith("读取失败"))
                                .ToArray();
                            Assert(errors.Length == 0, "页面响应错误：" + string.Join(";", errors));
                            var name = $"{(populated ? "long" : "empty")}-{size.Width}x{size.Height}-{page}.png";
                            Capture(form, Path.Combine(output, name)); screenshots.Add(name);
                            results.Add(new { fixture = populated ? "长文本" : "空数据", size = $"{size.Width}x{size.Height}", physicalSize = $"{form.Width}x{form.Height}", dpi = form.DeviceDpi, page, visible = true });
                        }
                    }
                    var settings = await form.SelectTestPageAsync(5);
                    var tabs = Descendants(settings).OfType<TabControl>().Single();
                    tabs.SelectedIndex = 3;
                    var smsToggle = Descendants(settings).OfType<CheckBox>().Single(box => box.Text == "自动同步短信");
                    var smsSeconds = Descendants(settings).OfType<NumericUpDown>().Single(number => number.Maximum == 86400);
                    Assert(smsToggle.Checked && smsSeconds.Value == 15m, "接口 0.25 分钟应显示为启用、15 秒");
                    smsSeconds.Value = 120m;
                    smsToggle.Checked = false;
                    Descendants(settings).OfType<Button>().Single(button => button.Text == "保存短信同步").PerformClick();
                    await Task.Delay(150);
                    Assert(handler.SmsSaveCount == 1 && handler.SmsIntervalMinutes == 2m && !handler.SmsEnabled,
                        "短信保存应将 120 秒换算为 2 分钟");
                    var smsShot = $"{(populated ? "long" : "empty")}-sms-settings.png";
                    Capture(form, Path.Combine(output, smsShot)); screenshots.Add(smsShot);
                    results.Add(new { fixture = populated ? "长文本" : "空数据", smsLoadSeconds = 15, smsSavedMinutes = 2, writes = handler.SmsSaveCount });
                    Assert(handler.Requests.All(request => request.Method == "GET" || request.Path == "/api/dashboard/sms/settings"),
                        "隔离测试不得触发真实设备或通知操作");
                    form.Hide();
                    var count = handler.Requests.Count;
                    await Task.Delay(1150);
                    Assert(handler.Requests.Count == count, "关闭自动刷新后不应产生定时请求");
                    form.Close();
                }
                using (var handler = new FixtureHandler(true))
                using (var api = new ApiClient(handler, "http://fixture.invalid"))
                {
                    using var liveWindow = new MainForm(api, () => { });
                    liveWindow.Show(); liveWindow.Activate();
                    await Task.Delay(600);
                    Assert(handler.Requests.Count > 0, "正常窗口应能自动读取数据");
                    liveWindow.Hide();
                    var hiddenRequests = handler.Requests.Count;
                    await Task.Delay(6200);
                    Assert(handler.Requests.Count == hiddenRequests, "隐藏窗口后应停止前台定时读取");
                    liveWindow.Close();
                    Assert(liveWindow.IsDisposed, "关闭窗口应释放前台控件");
                    using var reopened = new MainForm(api, () => { });
                    reopened.Show();
                    await Task.Delay(600);
                    Assert(handler.Requests.Count > hiddenRequests, "新建窗口后应恢复数据读取");
                    reopened.Close();
                    results.Add(new { automaticRequestsStoppedWhileHidden = true, closedWindowDisposed = true, recreatedWindowReadsAgain = true });
                }
                exitCode = 0;
                WriteReport(output, exitCode, results, screenshots, null);
            }
            catch (Exception error)
            {
                WriteReport(output, exitCode, results, screenshots, error.ToString());
            }
            finally { dispatcher.Close(); application.ExitThread(); }
        };
        dispatcher.Show();
        Application.Run(application);
        dispatcher.Dispose(); application.Dispose();
        return exitCode;
    }

    private static void WriteReport(string directory, int exitCode, List<object> results, List<string> screenshots, string? error) =>
        File.WriteAllText(Path.Combine(directory, "ui-smoke.json"), JsonSerializer.Serialize(new
        {
            success = exitCode == 0,
            source = "内存固定响应（fixture），无 ServerHost、无真实设备、无 PushPlus 请求",
            collectedAt = DateTimeOffset.Now,
            results, screenshots, error,
            scope = "真实 WinForms 消息循环：六页空数据和长文本、两种窗口尺寸、短信设置读取及秒/分钟保存换算；截图不代表生产数据或性能基准"
        }, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));

    private static void Capture(Form form, string path)
    {
        form.PerformLayout(); form.Refresh();
        using var bitmap = new Bitmap(form.Width, form.Height);
        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
        bitmap.Save(path, ImageFormat.Png);
    }

    private static IEnumerable<Control> Descendants(Control root)
    {
        foreach (Control child in root.Controls)
        {
            yield return child;
            foreach (var nested in Descendants(child)) yield return nested;
        }
    }
    private static void Assert(bool condition, string message)
    { if (!condition) throw new InvalidOperationException(message); }

    private sealed class FixtureHandler(bool populated) : HttpMessageHandler
    {
        private const string Time = "2026-10-07T10:00:00Z";
        private readonly string _long = string.Concat(Enumerable.Repeat("仅用于界面验收的长文本测试数据，包含中文和空格。", 12));
        internal List<(string Method, string Path)> Requests { get; } = [];
        internal int SmsSaveCount { get; private set; }
        internal decimal SmsIntervalMinutes { get; private set; }
        internal bool SmsEnabled { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = request.RequestUri!.AbsolutePath;
            Requests.Add((request.Method.Method, path));
            object response;
            if (request.Method == HttpMethod.Post && path == "/api/dashboard/sms/settings")
            {
                var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                using var json = JsonDocument.Parse(body);
                SmsSaveCount++; SmsIntervalMinutes = json.RootElement.GetProperty("interval").GetDecimal();
                SmsEnabled = json.RootElement.GetProperty("enabled").GetBoolean();
                response = new { success = true, sync = new { enabled = SmsEnabled, interval = SmsIntervalMinutes } };
            }
            else if (request.Method == HttpMethod.Get) response = Fixture(path);
            else throw new InvalidOperationException("隔离验收禁止其他写请求：" + path);
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent(JsonSerializer.Serialize(response), Encoding.UTF8, "application/json") };
        }

        private object Fixture(string path)
        {
            var sync = new { enabled = true, interval = 0.25, lastSyncedAt = Time, lastError = "" };
            var cell = new { carrier = populated ? _long : "", networkType = populated ? "5G NR" : "", band = "N41",
                signal = new { bandInfo = populated ? _long : "" }, cellId = populated ? _long : "", pci = "549", rsrp = -71, rsrq = -10, sinr = 33 };
            var deviceRows = populated ? new object[] { new { ActualName = _long, IPAddress = "192.0.2.10", MACAddress = "02:00:00:00:00:01",
                InterfaceType = "固定测试 WLAN", rssi = "-50", DownlinkBytes = 123456789L, UplinkBytes = 2345678L } } : [];
            return path switch
            {
                "/api/dashboard/live" => new { stale = !populated, collectedAt = Time,
                    overview = new { source = populated ? "cpe" : "database", cpeError = populated ? "" : "固定空数据测试",
                        currentDownload = populated ? (double?)3125000 : null, currentUpload = populated ? (double?)1250000 : null,
                        connectedDevices = populated ? (int?)1 : null, signalStrength = populated ? (int?)-71 : null,
                        connectionStatus = populated ? "connected" : "", networkSnapshot = cell,
                        collectionHealth = new { label = "固定测试" }, schedulerStatus = new { enabled = false, interval = 30 } },
                    trafficStats = populated ? new Dictionary<string, object> { ["CurrentDownload"] = 123456789, ["CurrentUpload"] = 123456,
                        ["TotalDownload"] = 234567890L, ["TotalUpload"] = 2345678, ["CurrentConnectTime"] = 10000, ["TotalConnectTime"] = 100000,
                        ["CurrentMonthDownload"] = 234567890, ["CurrentMonthUpload"] = 2345678 } : [] },
                "/api/dashboard/start-date" => new { trafficmaxlimit = 890L * 1024 * 1024 * 1024 },
                "/api/dashboard/traffic" => populated ? Enumerable.Range(0, 10).Select(i => new { timestamp = DateTimeOffset.Parse(Time).AddMinutes(i).ToString("O"),
                    downloadBps = 1000000L + 200000L * i, uploadBps = 200000L + i * 100000L, rsrp = -71 - i, connectedDevices = i % 4 }).ToArray() : [],
                "/api/dashboard/device" => new { source = "database", cpeError = "固定数据，不访问设备", cachedAt = Time,
                    deviceInformation = new { DeviceName = populated ? "H153-381（固定数据）" : "", SoftwareVersion = populated ? _long : "",
                        WebUIVersion = populated ? _long : "", HardwareVersion = "fixture", SerialNumber = "fixture", Imei = "fixture",
                        WanIPAddress = "192.0.2.1", WanIPv6Address = "2001:db8::1" }, cellInformation = cell },
                "/api/dashboard/devices" => new { devices = deviceRows },
                "/api/dashboard/sms" => new { total = populated ? 1 : 0, unread = populated ? 1 : 0, sync,
                    messages = populated ? new object[] { new { id = "fixture-1", phone = "测试号码", date = Time, content = _long, unread = true, direction = "inbound" } } : [] },
                "/api/alerts/rules" => populated ? new object[] { new { id = 1, name = _long, metricType = "rsrp", @operator = "<", threshold = -100,
                    enabled = false, notifyEmail = false, notifyWechat = false, cooldownMinutes = 30 } } : [],
                "/api/alerts/logs" => new { total = populated ? 1 : 0, logs = populated ? new object[] { new { triggeredAt = Time, ruleName = _long,
                    message = _long, notified = false } } : [] },
                "/api/reports/daily" => populated ? new object[] { new { reportDate = "2026-10-07", totalDownload = 123456789L,
                    totalUpload = 2345678L, avgSignal = -71, networkQuality = _long, createdAt = Time, uptimePercent = 99.5, peakHour = 12,
                    topDevices = new[] { new { name = _long, ip = "192.0.2.10", mac = "02:00:00:00:00:01", downloadBytes = 123456789L, uploadBytes = 2345678L, totalBytes = 125802467L } } } } : [],
                "/api/reports/period" => new { reports = Array.Empty<object>() },
                "/api/settings/cpe" => new { cpe_url = "http://192.0.2.1", cpe_username = populated ? _long : "admin", cpe_password_set = false },
                "/api/settings/notification" => new object[] {
                    new { type = "pushplus", enabled = false, config = (object)new { tokenConfigured = false } },
                    new { type = "email", enabled = false, config = (object)new { smtpHost = populated ? _long : "", smtpPort = 587, smtpUser = "", from = "", to = Array.Empty<string>(), smtpPasswordSet = false } },
                    new { type = "wechat", enabled = false, config = (object)new { webhookConfigured = false } } },
                "/api/settings/quota" => new { enabled = false, quotaGb = 890, alertLevels = "80,90,100", resetDay = 1 },
                "/api/settings/device-info-sync" => new { enabled = false, interval = 360 },
                "/api/dashboard/sms/settings" => sync,
                _ => throw new InvalidOperationException("未命中固定响应：" + path)
            };
        }
    }
}
