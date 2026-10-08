using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
namespace CpeMonitor.Native;

internal sealed class ServerHost : IDisposable
{
    private Process? server;
    private ProcessJob? job;
    private readonly CancellationTokenSource stopping = new();
    private bool disposed;
    private static readonly Lazy<int> resolvedPort = new(ResolvePort);
    internal static int Port => resolvedPort.Value;

    /// <summary>
    /// 解析本机后台端口。默认从 3210 起找第一个空闲端口。
    ///
    /// 这里遇到占用时不再直接报错：第二个实例会被单实例锁拦在前面，
    /// 遗留后台也在启动时清理过了，所以此时占着端口的通常是无关程序，
    /// 顺延一个端口比让用户自己去排查更合适。全部被占时才回退到 3210 并报错。
    /// </summary>
    private static int ResolvePort()
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("CPE_MONITOR_PORT"), out var configured)
            && configured is > 1024 and <= 65535)
            return configured;
        for (var candidate = 3210; candidate <= 3220; candidate++)
        {
            if (IsPortFree(candidate)) return candidate;
        }
        return 3210;
    }

    private static bool IsPortFree(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException) { return false; }
    }
    internal static string DataDirectory => Environment.GetEnvironmentVariable("CPE_MONITOR_DATA_DIR") ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "com.cpeye.monitor");
    public async Task StartAsync(ApiClient api, CancellationToken ct)
    {
        var isolatedTest = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CPE_MONITOR_SMOKE_REPORT"));
        if (isolatedTest && (Port == 3210 || string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CPE_MONITOR_DATA_DIR")) ||
            (Directory.Exists(DataDirectory) && Directory.EnumerateFileSystemEntries(DataDirectory).Any())))
            throw new InvalidOperationException("验收必须使用独立端口和全新的空数据目录。");
        var nodePath = Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
        var serverPath = Path.Combine(AppContext.BaseDirectory, "resources", "server", "server.js");
        if (!File.Exists(nodePath) || !File.Exists(serverPath)) throw new InvalidOperationException("内置后台文件不完整，请重新安装 CPE Monitor。");
        RemoveOrphanedBackend(nodePath);
        using (var probe = new TcpClient())
        {
            try
            {
                await probe.ConnectAsync(IPAddress.Loopback, Port, ct);
                throw new InvalidOperationException($"本机 {Port} 端口已被占用，请关闭占用该端口的程序后重试。");
            }
            catch (SocketException) { }
        }
        Directory.CreateDirectory(DataDirectory);
        var secretPath = Path.Combine(DataDirectory, "runtime-secrets.json");
        var protectedPath = Path.Combine(DataDirectory, "runtime-secrets.dpapi");
        Dictionary<string, string> secrets;
        if (File.Exists(protectedPath))
        {
            var protectedBytes = Dpapi.Unprotect(File.ReadAllBytes(protectedPath));
            try { secrets = JsonSerializer.Deserialize<Dictionary<string, string>>(protectedBytes) ?? throw new InvalidOperationException("运行密钥无效。"); }
            finally { CryptographicOperations.ZeroMemory(protectedBytes); }
            if (File.Exists(secretPath))
            {
                var legacy = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(secretPath)) ?? throw new InvalidOperationException("旧版运行密钥无效。");
                if (legacy.Count != secrets.Count || legacy.Any(pair => !secrets.TryGetValue(pair.Key, out var value) || !string.Equals(pair.Value, value, StringComparison.Ordinal)))
                    throw new InvalidOperationException("两份运行密钥不一致，已停止启动以保护原有配置。请从完整备份修复数据库与配套密钥。");
                // 两份内容一致且加密格式已回读成功，删除遗留明文。
                File.Delete(secretPath);
            }
        }
        else
        {
            secrets = File.Exists(secretPath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(secretPath)) ?? throw new InvalidOperationException("旧版运行密钥无效。") : new();
            if (File.Exists(Path.Combine(DataDirectory, "data", "cpe-monitor.db")))
                foreach (var key in new[] { "jwt_secret", "cpe_config_secret", "cpe_session_secret" })
                    if (!secrets.TryGetValue(key, out var existing) || string.IsNullOrWhiteSpace(existing)) throw new InvalidOperationException("数据库缺少配套运行密钥，请从完整备份恢复。");
            foreach (var key in new[] { "admin_password", "jwt_secret", "cpe_config_secret", "cpe_session_secret" })
                if (!secrets.ContainsKey(key)) secrets[key] = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var bytes = JsonSerializer.SerializeToUtf8Bytes(secrets);
            File.WriteAllBytes(protectedPath + ".tmp", Dpapi.Protect(bytes));
            var verified = Dpapi.Unprotect(File.ReadAllBytes(protectedPath + ".tmp"));
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(bytes, verified)) throw new InvalidOperationException("运行密钥加密校验失败，已保留旧版密钥。");
            }
            finally { CryptographicOperations.ZeroMemory(verified); }
            File.Move(protectedPath + ".tmp", protectedPath, true);
            CryptographicOperations.ZeroMemory(bytes);
            // 迁移成功后删除明文运行密钥；完整回退备份仍包含旧版配套密钥。
            if (File.Exists(secretPath)) File.Delete(secretPath);
        }
        foreach (var key in new[] { "jwt_secret", "cpe_config_secret", "cpe_session_secret" })
            if (!secrets.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("缺少配套运行密钥，请从完整备份恢复。");
        var start = new ProcessStartInfo(nodePath)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(serverPath)!, RedirectStandardError = true
        };
        start.ArgumentList.Add(serverPath);
        // 桌面版仅读本地配置，避免继承命令行任务中的设备或通知凭据。
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("CPE_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("PUSHPLUS", StringComparison.OrdinalIgnoreCase) || key.StartsWith("SMTP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("WECOM_", StringComparison.OrdinalIgnoreCase) || key is "ADMIN_PASSWORD" or "JWT_SECRET").ToArray())
            start.Environment.Remove(key);
        start.Environment["NODE_ENV"] = "production";
        start.Environment["HOSTNAME"] = "127.0.0.1";
        start.Environment["PORT"] = Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["CPE_DESKTOP_MODE"] = "true";
        start.Environment["CPE_ISOLATED_TEST"] = isolatedTest ? "true" : "false";
        start.Environment["CPE_DATABASE_PATH"] = Path.Combine(DataDirectory, "data", "cpe-monitor.db");
        start.Environment["JWT_SECRET"] = secrets["jwt_secret"];
        start.Environment["CPE_CONFIG_SECRET"] = secrets["cpe_config_secret"];
        start.Environment["CPE_SESSION_SECRET"] = secrets["cpe_session_secret"];
        server = Process.Start(start) ?? throw new InvalidOperationException("无法启动本机后台。");
        // 绑定到作业对象：宿主消失时由系统回收后台，覆盖崩溃和被强制结束的情况。
        job = ProcessJob.TryCreate();
        job?.TryAssign(server);
        _ = DrainErrorAsync(server.StandardError, stopping.Token);
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct);
        startup.CancelAfter(TimeSpan.FromSeconds(60));
        while (!startup.IsCancellationRequested)
        {
            if (server.HasExited) throw new InvalidOperationException("本机后台提前退出，请检查安装文件。");
            try
            {
                var health = await api.GetAsync("/api/system/health", startup.Token);
                if (JsonValues.Text(health, "status") == "ok") return;
            }
            catch (HttpRequestException) { }
            await Task.Delay(500, startup.Token);
        }
        throw new InvalidOperationException("本机后台启动超时。");
    }

    /// <summary>
    /// 清理无人管理的遗留后台进程。宿主崩溃或被强制结束时会绕过 Dispose，
    /// 遗留的后台进程会占住端口和数据库，导致下次启动失败。
    /// 仅当没有其他存活宿主时才清理，且只结束本安装目录下的 node 进程。
    /// </summary>
    private static void RemoveOrphanedBackend(string nodePath)
    {
        var target = Path.GetFullPath(nodePath);
        var ownName = Process.GetCurrentProcess().ProcessName;
        var liveHosts = Process.GetProcessesByName(ownName).Where(process => process.Id != Environment.ProcessId).ToArray();
        if (liveHosts.Length > 0)
        {
            foreach (var host in liveHosts) host.Dispose();
            return;
        }
        foreach (var process in Process.GetProcessesByName("node"))
        {
            try
            {
                if (!string.Equals(process.MainModule?.FileName, target, StringComparison.OrdinalIgnoreCase)) continue;
                AppendHostEvent($"清理无人管理的遗留后台进程，PID {process.Id}");
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
            finally { process.Dispose(); }
        }
    }

    private static void AppendHostEvent(string message)
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            File.AppendAllText(
                Path.Combine(DataDirectory, "host-events.log"),
                $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {message}{Environment.NewLine}");
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static async Task DrainErrorAsync(StreamReader reader, CancellationToken ct)
    {
        try
        {
            using var file = new StreamWriter(Path.Combine(DataDirectory, "startup-error.log"), false);
            var retained = 0; var buffer = new char[2048];
            while (true)
            {
                var length = await reader.ReadAsync(buffer.AsMemory(), ct);
                if (length == 0) break;
                var count = Math.Min(length, Math.Max(0, 32768 - retained));
                if (count > 0) { await file.WriteAsync(buffer.AsMemory(0, count), ct); retained += count; }
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; stopping.Cancel();
        if (server is not null)
        {
            try { if (!server.HasExited) { server.Kill(entireProcessTree: true); server.WaitForExit(5000); } }
            catch (InvalidOperationException) { }
            finally { server.Dispose(); server = null; }
        }
        job?.Dispose(); job = null;
        stopping.Dispose();
    }
}
