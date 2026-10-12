using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CpeMonitor.Native;

/// <summary>
/// 灰度版资源采样器。
///
/// 只有载荷里带 canary.flag 时才启动；正式版没有这个标记，采样器根本不会被创建，
/// 也不会产生任何数据。测量范围是宿主所在的整棵进程树（宿主、内置 Node、WebView2）。
/// </summary>
internal sealed class ProcessTreeSampler : IDisposable
{
    private const int SampleIntervalMs = 60_000;

    private readonly ApiClient api;
    private readonly Func<bool> isReady;
    private readonly System.Windows.Forms.Timer timer;
    private double lastCpuSeconds;
    private DateTime lastSampleAt;
    private bool sampling;
    private bool disposed;

    /// <summary>正式版没有标记文件，采样逻辑保持休眠。</summary>
    internal static bool CanaryEnabled =>
        File.Exists(Path.Combine(AppContext.BaseDirectory, "resources", "server", "canary.flag"));

    internal ProcessTreeSampler(ApiClient api, Func<bool> isReady)
    {
        this.api = api;
        this.isReady = isReady;
        timer = new System.Windows.Forms.Timer { Interval = SampleIntervalMs };
        timer.Tick += async (_, _) => await SampleAsync();
    }

    internal void Start()
    {
        // 灰度采样只是测试功能，任何测量失败都不允许影响应用启动。
        try
        {
            lastSampleAt = DateTime.UtcNow;
            lastCpuSeconds = SumTree().CpuSeconds;
        }
        catch (Exception error) when (error is InvalidOperationException
            or System.ComponentModel.Win32Exception or NotSupportedException or IOException)
        {
            lastSampleAt = DateTime.UtcNow;
            lastCpuSeconds = 0;
        }
        timer.Start();
    }

    private async Task SampleAsync()
    {
        if (disposed || sampling || !isReady()) return;
        sampling = true;
        try
        {
            var snapshot = SumTree();
            var now = DateTime.UtcNow;
            var window = (now - lastSampleAt).TotalSeconds;
            var cpuPercent = window > 0 && snapshot.CpuSeconds >= lastCpuSeconds
                ? Math.Round((snapshot.CpuSeconds - lastCpuSeconds) / window / Environment.ProcessorCount * 100, 2)
                : 0;
            lastCpuSeconds = snapshot.CpuSeconds;
            lastSampleAt = now;

            if (snapshot.ProcessCount == 0) return;
            await api.PostAsync("/api/system/resource-samples", new
            {
                sampledAt = now.ToString("o"),
                processCount = snapshot.ProcessCount,
                workingSetBytes = snapshot.WorkingSet,
                privateBytes = snapshot.Private,
                cpuPercent,
                handles = snapshot.Handles,
                threads = snapshot.Threads,
                uptimeSeconds = snapshot.UptimeSeconds,
                // 单进程明细，用于把增长定位到具体进程。
                processes = snapshot.Processes.Select(entry => new
                {
                    processId = entry.ProcessId,
                    parentProcessId = entry.ParentProcessId,
                    processName = entry.Name,
                    workingSetBytes = entry.WorkingSet,
                    privateBytes = entry.Private,
                    handles = entry.Handles,
                    threads = entry.Threads,
                    cpuSeconds = entry.CpuSeconds,
                }).ToArray(),
            });
        }
        catch (Exception error) when (error is HttpRequestException or InvalidOperationException
            or OperationCanceledException or System.ComponentModel.Win32Exception) { }
        finally { sampling = false; }
    }

    /// <summary>单个进程的明细，用于把资源增长定位到具体进程。</summary>
    private readonly record struct ProcessEntry(
        int ProcessId, int ParentProcessId, string Name, long WorkingSet,
        long Private, long Handles, long Threads, double CpuSeconds);

    private readonly record struct TreeSnapshot(
        int ProcessCount, long WorkingSet, long Private, double CpuSeconds,
        long Handles, long Threads, double UptimeSeconds, IReadOnlyList<ProcessEntry> Processes);

    private static TreeSnapshot SumTree()
    {
        var all = Process.GetProcesses();
        try
        {
            var parents = new Dictionary<int, int>();
            var byId = new Dictionary<int, Process>();
            foreach (var process in all)
            {
                byId[process.Id] = process;
                var parent = TryGetParentId(process);
                if (parent is not null) parents[process.Id] = parent.Value;
            }

            var treeIds = new HashSet<int> { Environment.ProcessId };
            var changed = true;
            while (changed)
            {
                changed = false;
                foreach (var pair in parents)
                {
                    if (treeIds.Contains(pair.Value) && treeIds.Add(pair.Key)) changed = true;
                }
            }

            long workingSet = 0, privateBytes = 0, handles = 0, threads = 0;
            double cpuSeconds = 0;
            var count = 0;
            var oldestStart = DateTime.MaxValue;
            var entries = new List<ProcessEntry>();
            foreach (var id in treeIds)
            {
                if (!byId.TryGetValue(id, out var process)) continue;
                try
                {
                    var processWorkingSet = process.WorkingSet64;
                    var processPrivate = process.PrivateMemorySize64;
                    var processHandles = process.HandleCount;
                    var processThreads = process.Threads.Count;
                    var processCpuSeconds = process.TotalProcessorTime.TotalSeconds;
                    workingSet += processWorkingSet;
                    privateBytes += processPrivate;
                    handles += processHandles;
                    threads += processThreads;
                    cpuSeconds += processCpuSeconds;
                    entries.Add(new ProcessEntry(
                        process.Id,
                        parents.TryGetValue(process.Id, out var parentId) ? parentId : 0,
                        TryGetName(process),
                        processWorkingSet,
                        processPrivate,
                        processHandles,
                        processThreads,
                        Math.Round(processCpuSeconds, 3)));
                    if (process.StartTime < oldestStart) oldestStart = process.StartTime;
                    count += 1;
                }
                catch (Exception error) when (error is InvalidOperationException
                    or System.ComponentModel.Win32Exception or NotSupportedException) { }
            }

            var uptime = oldestStart == DateTime.MaxValue
                ? 0
                : Math.Round((DateTime.Now - oldestStart).TotalSeconds, 1);
            return new TreeSnapshot(count, workingSet, privateBytes, cpuSeconds, handles, threads, uptime, entries);
        }
        finally
        {
            foreach (var process in all) process.Dispose();
        }
    }

    /// <summary>进程可能刚好退出，名字取不到时记 unknown，不让整次采样失败。</summary>
    private static string TryGetName(Process process)
    {
        try
        {
            var name = process.ProcessName;
            return string.IsNullOrWhiteSpace(name) ? "unknown" : name;
        }
        catch (Exception error) when (error is InvalidOperationException
            or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return "unknown";
        }
    }

    /// <summary>通过 NtQueryInformationProcess 取父进程 ID，避免引入额外依赖。</summary>
    private static int? TryGetParentId(Process process)
    {
        try
        {
            var info = new ProcessBasicInformation();
            var size = Marshal.SizeOf<ProcessBasicInformation>();
            var status = NtQueryInformationProcess(process.Handle, 0, ref info, size, out _);
            if (status != 0) return null;
            var parent = info.InheritedFromUniqueProcessId.ToInt64();
            return parent is > 0 and <= int.MaxValue ? (int)parent : null;
        }
        catch (Exception error) when (error is InvalidOperationException
            or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            // 系统进程或其它用户的进程拿不到句柄，跳过即可，不能让它冒到启动流程。
            return null;
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        timer.Stop();
        timer.Dispose();
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr handle, int informationClass, ref ProcessBasicInformation information, int length, out int returnLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }
}
