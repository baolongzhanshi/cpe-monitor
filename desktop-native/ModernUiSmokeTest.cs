using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace CpeMonitor.Native;

internal static class ModernUiSmokeTest
{
    public static int Run()
    {
        var reportPath = Environment.GetEnvironmentVariable("CPE_MONITOR_SMOKE_REPORT");
        if (string.IsNullOrWhiteSpace(reportPath) || ServerHost.Port == 3210
            || string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CPE_MONITOR_DATA_DIR"))) return 2;
        using var api = new ApiClient();
        using var server = new ServerHost();
        using var startupTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(75));
        try { Task.Run(() => server.StartAsync(api, startupTimeout.Token)).GetAwaiter().GetResult(); }
        catch (Exception error)
        {
            File.WriteAllText(reportPath, JsonSerializer.Serialize(new { success = false, error = error.Message }));
            return 1;
        }
        using var timeout = new System.Windows.Forms.Timer { Interval = 30_000 };
        var report = new Dictionary<string, object?>
        {
            ["success"] = false,
            ["webView2"] = false,
            ["navigation"] = false,
            ["error"] = null,
            ["isolatedData"] = true,
            ["deviceAccessed"] = false,
            ["usesBrowserFixture"] = true,
        };
        using var form = new ModernMainForm(async core =>
        {
            report["webView2"] = true;
            core.NavigationCompleted += (_, args) => report["navigation"] = args.IsSuccess;
            core.AddWebResourceRequestedFilter("*/api/system/setup-status", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, args) =>
            {
                if (new Uri(args.Request.Uri).AbsolutePath == "/api/system/setup-status")
                    args.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes("{\"completed\":true}")), 200, "OK", "Content-Type: application/json");
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(FixtureScript);
        });
        form.Shown += async (_, _) =>
        {
            try
            {
                for (var i = 0; i < 80 && !form.Ready && form.InitializationError is null; i++) await Task.Delay(250);
                if (!form.Ready) throw new InvalidOperationException(form.InitializationError ?? "浏览器初始化超时");
                await Task.Delay(4_000);
                var browser = form.Browser!;
                var text = JsonSerializer.Deserialize<string>(await browser.ExecuteScriptAsync("document.body.innerText")) ?? "";
                if (!text.Contains("CPE Monitor", StringComparison.Ordinal) && !text.Contains("CPE", StringComparison.Ordinal))
                    throw new InvalidOperationException("现代页面未渲染产品内容");
                report["pageRendered"] = true;
                var firstRates = string.Join("|", Regex.Matches(text, @"\d+(?:\.\d+)?\s*Mbps").Select(match => match.Value));
                await Task.Delay(2_500);
                var secondText = JsonSerializer.Deserialize<string>(await browser.ExecuteScriptAsync("document.body.innerText")) ?? "";
                var secondRates = string.Join("|", Regex.Matches(secondText, @"\d+(?:\.\d+)?\s*Mbps").Select(match => match.Value));
                if (firstRates.Length == 0 || firstRates == secondRates) throw new InvalidOperationException("模拟事件没有使页面速率发生变化");
                report["fixtureMetricsChangedVisibleRates"] = true;
                var screenshotPath = Path.Combine(Path.GetDirectoryName(reportPath)!, "modern-ui.png");
                using (var screenshot = File.Create(screenshotPath)) await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, screenshot);
                report["screenshot"] = screenshotPath;
                var screenshots = new List<string> { screenshotPath };
                foreach (var page in new[] { "sms", "alerts", "reports", "settings" })
                {
                    await browser.ExecuteScriptAsync($"document.querySelector('a[href=\"/{page}\"]')?.click()");
                    await Task.Delay(1_500);
                    var pagePath = Path.Combine(Path.GetDirectoryName(reportPath)!, $"modern-{page}.png");
                    using (var image = File.Create(pagePath)) await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                    screenshots.Add(pagePath);
                }
                report["screenshots"] = screenshots;
                form.WindowState = FormWindowState.Minimized;
                await Task.Delay(750);
                report["minimizedHostVisibility"] = !form.EmbeddedViewVisible;
                report["rendererSuspended"] = form.PageSuspended;
                form.WindowState = FormWindowState.Normal;
                await Task.Delay(750);
                var visible = JsonSerializer.Deserialize<bool>(await browser.ExecuteScriptAsync("window.__CPE_MONITOR_VISIBLE__ === true"));
                report["restoredHostVisibility"] = visible;
            }
            catch (Exception error) { report["error"] = error.Message; }
            finally { if (!form.IsDisposed) form.Close(); }
        };
        timeout.Tick += (_, _) => { timeout.Stop(); form.Close(); };
        form.FormClosed += (_, _) =>
        {
            report["success"] = form.Ready && Equals(report["webView2"], true) && Equals(report["navigation"], true)
                && Equals(report.GetValueOrDefault("pageRendered"), true)
                && Equals(report.GetValueOrDefault("minimizedHostVisibility"), true)
                && Equals(report.GetValueOrDefault("restoredHostVisibility"), true) && report["error"] is null;
            if (!form.Ready && !string.IsNullOrWhiteSpace(form.InitializationError)) report["error"] = form.InitializationError;
            File.WriteAllText(reportPath, JsonSerializer.Serialize(report));
            Application.ExitThread();
        };
        timeout.Start();
        Application.Run(form);
        return Equals(report["success"], true) ? 0 : 1;
    }

    // 此事件源仅存在于验收浏览器内，不修改后台数据，不调用设备或通知接口。
    private const string FixtureScript = """
      window.__fixtureStreams = 0;
      window.EventSource = class {
        constructor(url) {
          this.url = url; this.readyState = 1; this.sequence = 0; window.__fixtureStreams++;
          setTimeout(() => this.onopen?.({}), 80);
          this.timer = setInterval(() => {
            this.sequence++;
            const payload = {
              overview: { currentDownload: (this.sequence + 1) * 125000, currentUpload: 62500,
                connectedDevices: 3, signalStrength: -71, connectionStatus: '901', networkType: '5G NR', source: 'cpe', cpeError: '',
                updateState: '0', networkSnapshot: {signalStrength:-71,connectionStatus:'901',networkType:'5G NR',carrier:'验收模拟网络',rsrp:'-71',rsrq:'-10',sinr:'33',band:'N41',cellId:'FIXTURE',pci:'549'},
                schedulerStatus: {enabled:false,running:false,interval:30},collectionHealth: {label:'模拟采样'} },
              trafficStats: {CurrentDownloadRate:String((this.sequence+1)*125000),CurrentUploadRate:'62500',CurrentDownload:'104857600',CurrentUpload:'10485760'},
              collectedAt:new Date().toISOString(),stale:false
            };
            this.onmessage?.({data:JSON.stringify({type:'metrics',payload,timestamp:payload.collectedAt})});
          }, 1000);
        }
        close() { if(this.readyState===2)return; this.readyState=2;clearInterval(this.timer);window.__fixtureStreams--; }
      };
      """;
}
