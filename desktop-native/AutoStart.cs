using Microsoft.Win32;

namespace CpeMonitor.Native;

/// <summary>
/// 开机自启的注册表读写。
///
/// 只写 HKCU，不需要管理员权限，也不会影响这台电脑上的其他 Windows 用户。
///
/// 用两个键分工，不能只靠 Run 键推断用户意图：
///   HKCU\Software\CPE Monitor\AutoStart  —— 用户的偏好（1 开 / 0 关），不存在表示从未选择过
///   HKCU\...\Run\CPE Monitor             —— 实际生效的启动项，指向当前 exe
/// 只用一个的话，升级安装时分不清"用户主动关掉了"和"这个功能刚引入还没配过"，
/// 结果不是覆盖用户的选择，就是老用户升级后拿不到默认开启。
/// </summary>
internal static class AutoStart
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "CPE Monitor";
    private const string AppKeyPath = @"Software\CPE Monitor";
    private const string PreferenceName = "AutoStart";

    /// <summary>启动项当前是否真的生效（以 Run 键为准，不以偏好为准）。</summary>
    internal static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            return key?.GetValue(ValueName) is string value && value.Length > 0;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException)
        {
            ServerHost.AppendHostEvent($"读取开机自启状态失败：{error.Message}");
            return false;
        }
    }

    /// <summary>用户的偏好；null 表示这台机器上还从未选择过。</summary>
    private static bool? ReadPreference()
    {
        using var key = Registry.CurrentUser.OpenSubKey(AppKeyPath, writable: false);
        return key?.GetValue(PreferenceName) switch
        {
            int value => value != 0,
            string value when value.Length > 0 => value != "0",
            _ => null,
        };
    }

    /// <summary>按用户意愿设置：同时写偏好和启动项，返回 Run 键是否处在期望状态。</summary>
    internal static bool Apply(bool wanted)
    {
        try
        {
            using (var app = Registry.CurrentUser.CreateSubKey(AppKeyPath, writable: true))
                app?.SetValue(PreferenceName, wanted ? 1 : 0, RegistryValueKind.DWord);

            if (wanted)
            {
                using var run = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
                if (run is null) return false;
                run.SetValue(ValueName, Quote(ExecutablePath()), RegistryValueKind.String);
            }
            else
            {
                using var run = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
                run?.DeleteValue(ValueName, throwOnMissingValue: false);
            }
            return IsEnabled() == wanted;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException or NotSupportedException)
        {
            ServerHost.AppendHostEvent($"设置开机自启失败：{error.Message}");
            return false;
        }
    }

    /// <summary>
    /// 启动时对齐一次：
    /// 从未选择过 → 按默认（开启）写一次，让升级上来的老用户也能拿到这个功能；
    /// 已经选择过 → 按偏好维护启动项，路径变了就改成当前 exe（程序被移动或换目录重装）。
    /// </summary>
    internal static void EnsureConfigured()
    {
        try
        {
            var preference = ReadPreference();
            if (preference is null)
            {
                if (Apply(true)) ServerHost.AppendHostEvent("已按默认值开启开机自启");
                return;
            }

            if (!preference.Value)
            {
                // 用户明确关掉了：不主动开回来，但要确保启动项确实不存在。
                if (IsEnabled()) Apply(false);
                return;
            }

            var expected = Quote(ExecutablePath());
            using var run = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (run is null) return;
            if (run.GetValue(ValueName) is string current && string.Equals(current, expected, StringComparison.OrdinalIgnoreCase)) return;
            run.SetValue(ValueName, expected, RegistryValueKind.String);
            ServerHost.AppendHostEvent($"开机自启路径已对齐为 {expected}");
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            ServerHost.AppendHostEvent($"对齐开机自启失败：{error.Message}");
        }
    }

    /// <summary>默认安装目录 "$LOCALAPPDATA\CPE Monitor" 含空格，路径必须加引号。</summary>
    private static string Quote(string path) => $"\"{path}\"";

    private static string ExecutablePath() => Application.ExecutablePath;
}
