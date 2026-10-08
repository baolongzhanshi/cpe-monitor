using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace CpeMonitor.Native;

/// <summary>
/// 原生窗口标题栏配色。
///
/// WinForms 的内容区可以跟随系统深色，但标题栏属于非客户区，默认始终是浅色。
/// 需要显式告诉桌面窗口管理器使用沉浸式深色，否则页面已经变深、标题栏仍然是白的。
/// </summary>
internal static class WindowTheme
{
    // Windows 10 20H1 起使用 20；更早的版本用 19。
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    /// <summary>读回窗口当前的沉浸式深色状态，供验收脚本取证；不可用时返回 null。</summary>
    internal static bool? IsWindowDark(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return null;
        if (DwmGetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, out var value, sizeof(int)) == 0) return value != 0;
        if (DwmGetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeLegacy, out var legacy, sizeof(int)) == 0) return legacy != 0;
        return null;
    }

    /// <summary>按指定深浅色刷新窗口标题栏。</summary>
    internal static void Apply(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero) return;
        var value = dark ? 1 : 0;
        var result = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref value, sizeof(int));
        if (result != 0) DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeLegacy, ref value, sizeof(int));
    }

    /// <summary>读取系统“应用”主题：AppsUseLightTheme 为 0 表示深色。</summary>
    internal static bool IsSystemDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int useLight && useLight == 0;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or System.IO.IOException)
        {
            return false;
        }
    }
}
