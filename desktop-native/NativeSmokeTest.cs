using System.Text.Json;
namespace CpeMonitor.Native;

internal static class NativeSmokeTest
{
    public static int Run()
    {
        var reportPath = Environment.GetEnvironmentVariable("CPE_MONITOR_SMOKE_REPORT");
        if (string.IsNullOrWhiteSpace(reportPath) || string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CPE_MONITOR_DATA_DIR"))) return 2;
        using var api = new ApiClient(); using var server = new ServerHost();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(75));
        try
        {
            Task.Run(async () =>
            {
                await server.StartAsync(api, timeout.Token);
                var health = await api.GetAsync("/api/system/health", timeout.Token);
                var auth = await api.GetAsync("/api/auth/me", timeout.Token);
                var setup = await api.GetAsync("/api/system/setup-status", timeout.Token);
                if (!JsonValues.Bool(auth, "desktopMode") || JsonValues.Text(health, "status") != "ok" || !setup.TryGetProperty("completed", out _)) throw new InvalidOperationException("后台免密码验收失败。");
            }).GetAwaiter().GetResult();
            using var form = new ModernMainForm(); form.CreateControl();
            File.WriteAllText(reportPath, JsonSerializer.Serialize(new { success = true, version = "0.3.9", nativeUi = true, embeddedWebUi = true, desktopMode = true, isolatedData = true })); return 0;
        }
        catch (Exception error) { File.WriteAllText(reportPath, JsonSerializer.Serialize(new { success = false, error = error.Message })); return 1; }
    }
}
