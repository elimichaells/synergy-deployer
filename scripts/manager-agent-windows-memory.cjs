'use strict';
// Read-only native counters avoid cold/stalled WMI providers on new Windows VMs.
// Layouts: Microsoft psapi.h PERFORMANCE_INFORMATION/ENUM_PAGE_FILE_INFORMATION
// and tlhelp32.h PROCESSENTRY32W. No commands, paths or environment are collected.
module.exports = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ManagerMemorySnapshot {
  [StructLayout(LayoutKind.Sequential)] public struct Memory {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
  }
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process, out Memory memory, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
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
        // Query one handle directly. System.Diagnostics.Process refresh can
        // enumerate the entire process table for each individual process.
        IntPtr process=OpenProcess(0x1000,false,entry.pid); // QUERY_LIMITED_INFORMATION
        if(process!=IntPtr.Zero) try {
          Memory memory; long created,exited,kernel,user;
          if(GetProcessMemoryInfo(process,out memory,(uint)Marshal.SizeOf(typeof(Memory)))) {
            double started=GetProcessTimes(process,out created,out exited,out kernel,out user)?(created-116444736000000000L)/10000.0:0;
            rows.Add(new {pid=entry.pid,ppid=entry.parent,name=entry.name,privateBytes=memory.PrivateUsage.ToUInt64(),workingBytes=memory.WorkingSetSize.ToUInt64(),started=started});
          }
        } finally {CloseHandle(process);} // Protected/exited processes are skipped.
      } while(rows.Count<4000 && Next(snapshot,ref entry));
    } finally { CloseHandle(snapshot); }
    return new {processes=rows,commitMb=perf.CommitTotal.ToUInt64()*scale,commitLimitMb=perf.CommitLimit.ToUInt64()*scale,pageFileMb=pages?(double?)pageTotal:null,pageFileUsedMb=pages?(double?)pageUsed:null};
  }
}
'@
[ManagerMemorySnapshot]::Read() | ConvertTo-Json -Depth 5 -Compress`;
