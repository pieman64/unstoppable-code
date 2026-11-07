# Shared only by the owned Windows credential test fixtures.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProfileCredentialChild {
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  static void Trace(string stage,string detail = "") {
    Console.Error.WriteLine("credential-profile-native stage=" + stage + " elapsedMs=" + clock.ElapsedMilliseconds + " " + detail);
  }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectoryW(string path,ref SECURITY_ATTRIBUTES attributes);
  public static void CreateStage(string path,byte[] descriptor) {
    IntPtr security = Marshal.AllocHGlobal(descriptor.Length);
    try {
      Marshal.Copy(descriptor,0,security,descriptor.Length);
      var attributes = new SECURITY_ATTRIBUTES();
      attributes.length = Marshal.SizeOf(attributes); attributes.descriptor = security;
      // Refuse existing directories, including leftovers; never reuse or repair their ACLs.
      if (!CreateDirectoryW(path,ref attributes)) throw new Exception("profile-staging-create-refused:" + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(security); }
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool LogonUserW(string user,string domain,string password,int type,int provider,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr attributes,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path,uint access,uint share,ref SECURITY_ATTRIBUTES attributes,uint disposition,uint flags,IntPtr template);
  public static void CheckInputs(string user,string password,string[] paths) {
    IntPtr token;
    Trace("preflight-logon:start");
    if (!LogonUserW(user,".",password,2,0,out token)) throw new Exception("profile-preflight-logon:" + Marshal.GetLastWin32Error());
    Trace("preflight-logon:done");
    bool impersonated = false;
    try {
      Trace("preflight-impersonate:start");
      if (!ImpersonateLoggedOnUser(token)) throw new Exception("profile-preflight-impersonate:" + Marshal.GetLastWin32Error());
      impersonated = true;
      Trace("preflight-inputs:start");
      // Node realpaths its entry and addon; readable leaf files alone are insufficient.
      for (string directory = System.IO.Path.GetDirectoryName(paths[0]); directory != null; directory = System.IO.Path.GetDirectoryName(directory)) {
        IntPtr ancestor = CreateFileW(directory,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        if (ancestor == new IntPtr(-1)) throw new Exception("profile-ancestor-unreadable:" + directory + ":win32=" + Marshal.GetLastWin32Error());
        CloseHandle(ancestor);
      }
      string[] labels = { "node", "addon", "child", "request", "profile-child", "receipt", "powershell-diagnostic", "node-diagnostic" };
      for (int i = 0; i < paths.Length; ++i) {
        uint access = i < 5 ? 0x80000000u : 0xC0000000u;
        IntPtr file = CreateFileW(paths[i],access,7,IntPtr.Zero,3,0,IntPtr.Zero);
        if (file == new IntPtr(-1)) throw new Exception("profile-input-unreadable:" + labels[i] + ":win32=" + Marshal.GetLastWin32Error());
        CloseHandle(file);
        if (i < 5) {
          IntPtr writable = CreateFileW(paths[i],0x40000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
          if (writable != new IntPtr(-1)) { CloseHandle(writable); throw new Exception("profile-input-writable:" + labels[i]); }
          if (Marshal.GetLastWin32Error() != 5) throw new Exception("profile-input-write-probe-inconclusive:" + labels[i]);
        }
      }
      foreach (uint access in new uint[] { 2, 0x10000 }) {
        IntPtr mutable = CreateFileW(System.IO.Path.GetDirectoryName(paths[0]),access,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        if (mutable != new IntPtr(-1)) { CloseHandle(mutable); throw new Exception("profile-staging-mutable"); }
        if (Marshal.GetLastWin32Error() != 5) throw new Exception("profile-staging-write-probe-inconclusive");
      }
      Trace("preflight-inputs:done");
    } finally {
      Trace("preflight-revert:start");
      bool reverted = !impersonated || RevertToSelf();
      CloseHandle(token);
      if (!reverted) throw new Exception("profile-preflight-revert-refused");
      Trace("preflight-revert:done");
    }
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessWithLogonW(string user,string domain,string password,int flags,string application,string command,int creation,string environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long perProcess, perJob; public uint flags; public UIntPtr minWorking, maxWorking; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limit,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long totalUser,totalKernel,periodUser,periodKernel; public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out BASIC_ACCOUNTING accounting,int size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [StructLayout(LayoutKind.Sequential)] struct COMPLETION_PORT { public IntPtr key,port; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,IntPtr key,uint threads);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref COMPLETION_PORT port,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out IntPtr key,out IntPtr process,uint timeout);
  public static void Run(string user,string password,string node,string command,string root,string systemRoot,int budgetMilliseconds,int maximumWaitMilliseconds) {
    Run(user,password,node,command,root,systemRoot,budgetMilliseconds,maximumWaitMilliseconds,root,null);
  }
  public static void Run(string user,string password,string node,string command,string root,string systemRoot,int budgetMilliseconds,int maximumWaitMilliseconds,string temporaryRoot,string hostDiagnostic) {
    if (budgetMilliseconds <= 0 || maximumWaitMilliseconds <= 0) throw new Exception("profile-launch-deadline-exceeded");
    long deadline = clock.ElapsedMilliseconds + budgetMilliseconds;
    var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero;
    try {
      if (hostDiagnostic != null) {
        var attributes = new SECURITY_ATTRIBUTES(); attributes.length = Marshal.SizeOf(attributes); attributes.inherit = 1;
        // Files, not pipes: startup errors must survive a stalled host without a drain thread.
        output = CreateFileW(hostDiagnostic,0x40000000,7,ref attributes,3,0,IntPtr.Zero);
        if (output == new IntPtr(-1)) throw new Exception("profile-host-output-refused:" + Marshal.GetLastWin32Error());
        input = CreateFileW("NUL",0x80000000,7,ref attributes,3,0,IntPtr.Zero);
        if (input == new IntPtr(-1)) throw new Exception("profile-host-input-refused:" + Marshal.GetLastWin32Error());
        startup.flags = 0x100;
        startup.input = input; startup.output = output; startup.error = output;
        Trace("host-streams:ready");
      }
      RunProcess(user,password,node,command,root,systemRoot,deadline,maximumWaitMilliseconds,temporaryRoot,ref startup);
    } finally {
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
      if (output != IntPtr.Zero && output != new IntPtr(-1)) CloseHandle(output);
      if (hostDiagnostic != null) Trace("host-streams:closed");
    }
  }
  static void RunProcess(string user,string password,string node,string command,string root,string systemRoot,long deadline,int maximumWaitMilliseconds,string temporaryRoot,ref STARTUPINFO startup) {
    PROCESS_INFORMATION process;
    // Private credential fixture material is never inherited by the child.
    string environment = "SystemRoot=" + systemRoot + "\0TEMP=" + temporaryRoot + "\0TMP=" + temporaryRoot + "\0\0";
    Trace("job-create:start");
    IntPtr job = CreateJobObject(IntPtr.Zero,null);
    var limit = new EXTENDED_LIMIT(); limit.basic.flags = 0x2000;
    if (job == IntPtr.Zero || !SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit))) {
      int error = Marshal.GetLastWin32Error();
      if (job != IntPtr.Zero) CloseHandle(job);
      throw new Exception("profile-job-refused:" + error);
    }
    Trace("job-create:done");
    IntPtr completion = CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1);
    var association = new COMPLETION_PORT(); association.key = job; association.port = completion;
    if (completion == IntPtr.Zero || !SetInformationJobObject(job,7,ref association,Marshal.SizeOf(association))) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      if (completion != IntPtr.Zero) CloseHandle(completion);
      throw new Exception("profile-job-completion-refused:" + error);
    }
    Trace("profile-load-launch:start");
    if (!CreateProcessWithLogonW(user,".",password,1,node,command,0x08000404,environment,root,ref startup,out process)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(job); CloseHandle(completion);
      throw new Exception("profile-launch-refused:" + error);
    }
    bool admitted = false;
    Trace("profile-load-launch:done","pid=" + process.pid);
    try {
      Trace("job-admission:start");
      if (!AssignProcessToJobObject(job,process.process)) {
        int error = Marshal.GetLastWin32Error();
        Trace("job-admission:failed","win32=" + error);
        throw new Exception("profile-job-admission-refused:" + error);
      }
      admitted = true;
      if (clock.ElapsedMilliseconds >= deadline) {
        throw new Exception("profile-load-launch-deadline-exceeded");
      }
      Trace("host-resume:start");
      if (ResumeThread(process.thread) == UInt32.MaxValue) {
        int error = Marshal.GetLastWin32Error();
        throw new Exception("profile-resume-refused:" + error);
      }
      Trace("host-resume:done");
      Trace("job-admission:done");
      Trace("child-wait:start","remainingMs=" + Math.Max(0,deadline - clock.ElapsedMilliseconds));
      uint remaining = (uint)Math.Max(0,Math.Min(maximumWaitMilliseconds,deadline - clock.ElapsedMilliseconds));
      uint wait = WaitForSingleObject(process.process,remaining);
      int waitError = wait == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
      Trace("child-wait:done","result=" + wait + " win32=" + waitError);
      if (wait != 0) {
        throw new Exception("profile-child-wait-failed:result=" + wait + ":win32=" + waitError);
      }
      uint code;
      if (!GetExitCodeProcess(process.process,out code)) throw new Exception("profile-exit-code-refused:" + Marshal.GetLastWin32Error());
      if (code != 0) throw new Exception("profile-child-exit:0x" + code.ToString("X8"));
    } finally {
      try { TerminateAndWait(process.process,job,completion,admitted); }
      finally {
        Trace("handles-close:start");
        CloseHandle(job); CloseHandle(completion); CloseHandle(process.thread); CloseHandle(process.process);
        Trace("handles-close:done");
      }
    }
  }
  static void TerminateAndWait(IntPtr process,IntPtr job,IntPtr completion,bool admitted) {
    long deadline = clock.ElapsedMilliseconds + 5000;
    // Closing a job kills asynchronously; confirm the whole tree before profile cleanup.
    bool jobTerminated = TerminateJobObject(job,1);
    int jobError = jobTerminated ? 0 : Marshal.GetLastWin32Error();
    Trace("job-terminate:done","success=" + jobTerminated + " win32=" + jobError);
    if (!admitted || !jobTerminated) {
      Trace("child-terminate:start");
      bool terminated = TerminateProcess(process,1);
      int error = terminated ? 0 : Marshal.GetLastWin32Error();
      Trace("child-terminate:done","success=" + terminated + " win32=" + error);
    }
    Trace("termination-wait:start");
    uint wait = WaitForSingleObject(process,(uint)Math.Max(0,deadline - clock.ElapsedMilliseconds));
    int waitError = wait == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
    Trace("termination-wait:done","result=" + wait + " win32=" + waitError);
    if (wait != 0) throw new Exception("profile-termination-unconfirmed:result=" + wait + ":win32=" + waitError);
    if (!jobTerminated) throw new Exception("profile-job-termination-refused:win32=" + jobError);
    if (!admitted) return;
    Trace("job-empty:start");
    // Notifications can be dropped; only accounting confirms the job is empty.
    while (true) {
      BASIC_ACCOUNTING accounting;
      if (!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(BASIC_ACCOUNTING)),IntPtr.Zero)) {
        int error = Marshal.GetLastWin32Error();
        Trace("job-empty:failed","win32=" + error);
        throw new Exception("profile-job-query-refused:win32=" + error);
      }
      if (accounting.activeProcesses == 0) break;
      uint remaining = (uint)Math.Max(0,deadline - clock.ElapsedMilliseconds);
      if (remaining == 0) {
        Trace("job-empty:failed","activeProcesses=" + accounting.activeProcesses);
        throw new Exception("profile-job-termination-unconfirmed:activeProcesses=" + accounting.activeProcesses);
      }
      uint message; IntPtr key,child;
      GetQueuedCompletionStatus(completion,out message,out key,out child,Math.Min(remaining,100u));
    }
    Trace("job-empty:done");
  }
}
'@
