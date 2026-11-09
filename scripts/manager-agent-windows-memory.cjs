'use strict';
// Read-only native counters avoid cold/stalled WMI providers on new Windows VMs.
// Layouts: Microsoft psapi.h PERFORMANCE_INFORMATION/ENUM_PAGE_FILE_INFORMATION
// and tlhelp32.h PROCESSENTRY32W. No commands, paths or environment are collected.
module.exports = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ManagerMemorySnapshot {
  [StructLayout(LayoutKind.Sequential)] public struct Performance {
    public uint cb;
    public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
    public uint HandleCount, ProcessCount, ThreadCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PageFile {
    public uint cb, Reserved;
    public UIntPtr TotalSize, TotalInUse, PeakUsage;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetPerformanceInfo(out Performance info, uint size);
  delegate bool PageCallback(IntPtr context, ref PageFile info, IntPtr name);
  [DllImport("psapi.dll", EntryPoint="EnumPageFilesW", SetLastError=true)] static extern bool EnumPageFiles(PageCallback callback, IntPtr context);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode)] static extern bool First(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode)] static extern bool Next(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static object Read() {
    Performance perf;
    if(!GetPerformanceInfo(out perf, (uint)Marshal.SizeOf(typeof(Performance)))) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    double scale=perf.PageSize.ToUInt64()/1048576.0, pageTotal=0, pageUsed=0;
    PageCallback callback=delegate(IntPtr context, ref PageFile info, IntPtr name) { pageTotal+=info.TotalSize.ToUInt64()*scale; pageUsed+=info.TotalInUse.ToUInt64()*scale; return true; };
    bool pages=EnumPageFiles(callback, IntPtr.Zero);
    var rows=new List<object>();
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      Entry entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(First(snapshot,ref entry)) do {
        try { using(Process p=Process.GetProcessById((int)entry.pid)) {
          double started=0; try { started=new DateTimeOffset(p.StartTime).ToUnixTimeMilliseconds(); } catch {}
          rows.Add(new {pid=entry.pid,ppid=entry.parent,name=entry.name,privateBytes=p.PrivateMemorySize64,workingBytes=p.WorkingSet64,started=started});
        }} catch {} // Protected or already-exited processes are unavailable.
      } while(rows.Count<4000 && Next(snapshot,ref entry));
    } finally { CloseHandle(snapshot); }
    return new {processes=rows,commitMb=perf.CommitTotal.ToUInt64()*scale,commitLimitMb=perf.CommitLimit.ToUInt64()*scale,pageFileMb=pages?(double?)pageTotal:null,pageFileUsedMb=pages?(double?)pageUsed:null};
  }
}
'@
[ManagerMemorySnapshot]::Read() | ConvertTo-Json -Depth 5 -Compress`;
