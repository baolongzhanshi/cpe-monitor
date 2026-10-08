namespace CpeMonitor.Native;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Length == 1 && args[0] == "--web-ui-smoke") return ModernUiSmokeTest.Run();
        if (args.Length == 1 && args[0] == "--ui-smoke") return UiSmokeTest.Run();
        if (args.Length == 1 && args[0] == "--smoke-test") return NativeSmokeTest.Run();
        using var mutex = new Mutex(true, "Local\\CPEMonitor.Native", out var firstInstance);
        if (!firstInstance)
        {
            try { using var signal = EventWaitHandle.OpenExisting("Local\\CPEMonitor.ShowWindow"); signal.Set(); }
            catch (WaitHandleCannotBeOpenedException) { }
            return 0;
        }
        try
        {
            using var context = new NativeApplicationContext();
            Application.Run(context);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "CPE Monitor 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally { mutex.ReleaseMutex(); }
    }
}
