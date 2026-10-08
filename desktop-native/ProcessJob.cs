using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CpeMonitor.Native;

/// <summary>
/// 作业对象封装：把本机后台进程纳入宿主的作业。
/// 宿主一旦消失（正常退出、崩溃或被强制结束），由 Windows 结束作业内进程，
/// 避免留下占着端口和数据库的孤儿后台进程。
/// </summary>
internal sealed class ProcessJob : IDisposable
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private IntPtr handle;

    private ProcessJob(IntPtr handle) => this.handle = handle;

    internal static ProcessJob? TryCreate()
    {
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return null;

        var limit = new JobObjectExtendedLimitInfo
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose },
        };
        var size = Marshal.SizeOf<JobObjectExtendedLimitInfo>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limit, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                CloseHandle(job);
                return null;
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        return new ProcessJob(job);
    }

    /// <summary>把进程绑定到作业。失败时返回 false，调用方保留原有的显式结束逻辑。</summary>
    internal bool TryAssign(Process process)
    {
        if (handle == IntPtr.Zero) return false;
        try { return AssignProcessToJobObject(handle, process.Handle); }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { return false; }
    }

    public void Dispose()
    {
        var current = handle;
        handle = IntPtr.Zero;
        if (current != IntPtr.Zero) CloseHandle(current);
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInfo
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
