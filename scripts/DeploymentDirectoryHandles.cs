using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// No remote handles are closed. Duplicates are used only to identify open
// directories, then released. An unavailable native snapshot fails closed.
public static class DeploymentDirectoryHandles
{
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr buffer, int size, out int needed);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetLongPathName(string path, StringBuilder expanded, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string path, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [StructLayout(LayoutKind.Sequential)]
    struct StandardInfo
    {
        public long AllocationSize, EndOfFile;
        public uint Links;
        public byte DeletePending, Directory;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out StandardInfo info, uint size);

    static string DirectoryName(IntPtr handle)
    {
        StandardInfo info;
        // Current-directory handles have traverse rights, not READ_ATTRIBUTES.
        // Standard information and FILE_NAME_OPENED work with those rights.
        if (GetFileType(handle) != 1 || !GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo))) || info.Directory == 0) return null;
        var name = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, name, (uint)name.Capacity, 8);
        if (length == 0 || length >= name.Capacity) return null;
        var expanded = new StringBuilder(32768);
        uint expandedLength = GetLongPathName(name.ToString(), expanded, (uint)expanded.Capacity);
        return expandedLength > 0 && expandedLength < expanded.Capacity ? expanded.ToString().TrimEnd('\\') : null;
    }

    public static string ResolveRoot(string root)
    {
        if (!Path.IsPathRooted(root) || Path.GetPathRoot(root).TrimEnd('\\').Equals(root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid project root");
        IntPtr handle = CreateFile(root, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new InvalidOperationException("Cannot inspect project root");
        try {
            string directory = DirectoryName(handle);
            if (directory == null) throw new InvalidOperationException("Not a directory");
            return directory;
        }
        finally { CloseHandle(handle); }
    }

    public static bool HoldsDirectory(IntPtr process, string canonicalRoot)
    {
        foreach (string directory in OpenDirectories(process))
            if (directory.Equals(canonicalRoot, StringComparison.OrdinalIgnoreCase)
                || directory.StartsWith(canonicalRoot + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    public static string[] OpenDirectories(IntPtr process)
    {
        // System.Diagnostics.Process.Handle does not request PROCESS_DUP_HANDLE.
        // The caller holds that original handle throughout identity verification
        // and termination; acquire additional inspection rights on the same PID.
        uint pid = GetProcessId(process);
        if (pid == 0) throw new InvalidOperationException("Process identity unavailable");
        IntPtr inspection = OpenProcess(0x0440, false, pid);
        if (inspection == IntPtr.Zero) throw new InvalidOperationException("Process inspection denied");
        try { return ReadDirectories(inspection); }
        finally { CloseHandle(inspection); }
    }

    static string[] ReadDirectories(IntPtr process)
    {
        // ProcessHandleInformation (51), PROCESS_HANDLE_SNAPSHOT_INFORMATION.
        // Layout: https://github.com/winsiderss/phnt/blob/master/ntpsapi.h
        // Validate sizes/counts and bound allocation because this NT interface
        // can be unavailable or change on future Windows versions.
        for (int size = 65536; size <= 16 * 1024 * 1024; size *= 2)
        {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int needed;
                int status = NtQueryInformationProcess(process, 51, buffer, size, out needed);
                if (status == unchecked((int)0xC0000004) || status == unchecked((int)0xC0000023)) continue;
                if (status != 0 || needed < IntPtr.Size * 2 || needed > size) throw new InvalidOperationException("Handle snapshot unavailable");
                long count = Marshal.ReadIntPtr(buffer).ToInt64();
                int header = IntPtr.Size * 2;
                int entry = IntPtr.Size * 3 + 16;
                if (count < 0 || count > (needed - header) / entry) throw new InvalidOperationException("Invalid handle snapshot");
                var directories = new List<string>();
                for (int i = 0; i < count; i++)
                {
                    IntPtr remote = Marshal.ReadIntPtr(buffer, header + i * entry);
                    IntPtr copy;
                    if (!DuplicateHandle(process, remote, GetCurrentProcess(), out copy, 0, false, 2)) continue;
                    try
                    {
                        string directory = DirectoryName(copy);
                        if (directory != null) directories.Add(directory);
                    }
                    finally { CloseHandle(copy); }
                }
                return directories.ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Handle snapshot too large");
    }
}
