# Test-only. No network-logon fallback: both profiles must actually use Credential Manager.
param([string]$Node, [string]$Addon, [string]$Child, [string]$Request, [string]$Root, [string]$Stage)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProfileCredentialChild {
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
  public static void CheckInputs(string user,string password,string[] paths) {
    IntPtr token;
    if (!LogonUserW(user,".",password,2,0,out token)) throw new Exception("profile-preflight-logon:" + Marshal.GetLastWin32Error());
    bool impersonated = false;
    try {
      if (!ImpersonateLoggedOnUser(token)) throw new Exception("profile-preflight-impersonate:" + Marshal.GetLastWin32Error());
      impersonated = true;
      // Node realpaths its entry and addon; readable leaf files alone are insufficient.
      for (string directory = System.IO.Path.GetDirectoryName(paths[0]); directory != null; directory = System.IO.Path.GetDirectoryName(directory)) {
        IntPtr ancestor = CreateFileW(directory,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        if (ancestor == new IntPtr(-1)) throw new Exception("profile-ancestor-unreadable:" + directory + ":win32=" + Marshal.GetLastWin32Error());
        CloseHandle(ancestor);
      }
      string[] labels = { "node", "addon", "child", "request", "profile-child", "receipt", "diagnostic" };
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
    } finally {
      bool reverted = !impersonated || RevertToSelf();
      CloseHandle(token);
      if (!reverted) throw new Exception("profile-preflight-revert-refused");
    }
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessWithLogonW(string user,string domain,string password,int flags,string application,string command,int creation,string environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long perProcess, perJob; public uint flags; public UIntPtr minWorking, maxWorking; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limit,int size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  public static void Run(string user,string password,string node,string command,string root,string systemRoot) {
    var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
    PROCESS_INFORMATION process;
    // Private credential fixture material is never inherited by the child.
    string environment = "SystemRoot=" + systemRoot + "\0TEMP=" + root + "\0TMP=" + root + "\0\0";
    IntPtr job = CreateJobObject(IntPtr.Zero,null);
    var limit = new EXTENDED_LIMIT(); limit.basic.flags = 0x2000;
    if (job == IntPtr.Zero || !SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit))) {
      if (job != IntPtr.Zero) CloseHandle(job);
      throw new Exception("profile-job-refused");
    }
    if (!CreateProcessWithLogonW(user,".",password,1,node,command,0x08000404,environment,root,ref startup,out process)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(job);
      throw new Exception("profile-launch-refused:" + error);
    }
    try {
      if (!AssignProcessToJobObject(job,process.process) || ResumeThread(process.thread) == UInt32.MaxValue) {
        TerminateProcess(process.process,1); WaitForSingleObject(process.process,5000);
        throw new Exception("profile-job-admission-refused");
      }
      if (WaitForSingleObject(process.process,30000) != 0) {
        TerminateProcess(process.process,1); WaitForSingleObject(process.process,5000);
        throw new Exception("profile-child-timeout");
      }
      uint code;
      if (!GetExitCodeProcess(process.process,out code)) throw new Exception("profile-exit-code-refused:" + Marshal.GetLastWin32Error());
      if (code != 0) throw new Exception("profile-child-exit:0x" + code.ToString("X8"));
    } finally { CloseHandle(job); CloseHandle(process.thread); CloseHandle(process.process); }
  }
}
'@
function Assert-FileAcl($Actual,$Expected,[string]$Failure) {
  $rules = @($Actual,$Expected) | ForEach-Object {
    $entries = $_.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
      '{0}:{1}:{2}:{3}:{4}:{5}' -f $_.IdentityReference.Value,[int]$_.FileSystemRights,[int]$_.InheritanceFlags,[int]$_.PropagationFlags,[int]$_.AccessControlType,$_.IsInherited
    }
    (@($entries | Sort-Object) -join ';')
  }
  if (!$Actual.AreAccessRulesProtected -or $Actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $Expected.GetOwner([Security.Principal.SecurityIdentifier]) -or $rules[0] -ne $rules[1]) { throw $Failure }
}
$user = $env:CANOPY_CREDENTIAL_PROBE_USER
$password = $env:CANOPY_CREDENTIAL_PROBE_PASSWORD
# The local runner supplies a pre-existing profile-capable account through its probe inputs.
if (!$user -and !$password -and !$env:CI) {
  $user = $env:CANOPY_PIPE_PROBE_USER
  $password = $env:CANOPY_PIPE_PROBE_PASSWORD
}
if (!$user -or !$password) { throw 'two-profile-fixture-required' }
$sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME,$user)).Translate([Security.Principal.SecurityIdentifier])
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($sid -eq $me) { throw 'independent-profile-required' }
# Stage outside owner-only TEMP ancestors without widening any existing directory ACL.
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($me)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
$sourceRoot = $Root
$data = [IO.File]::ReadAllText($Request) | ConvertFrom-Json
$output = $data.output
$base = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if (!$base -or ![IO.Directory]::Exists($base)) { throw 'profile-staging-base-unavailable' }
if (!$Stage -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Stage)) -ne $base -or [IO.Path]::GetFileName($Stage) -notmatch '^canopy-credential-[a-f0-9-]{36}$') { throw 'profile-staging-path-invalid' }
$Root = $Stage
$created = $false
$mutex = $null
try {
  [ProfileCredentialChild]::CreateStage($Root,$acl.GetSecurityDescriptorBinaryForm())
  $created = $true
  [IO.File]::WriteAllText((Join-Path $sourceRoot 'profile-stage-created'),'created')
  $staged = [IO.Directory]::GetAccessControl($Root)
  Assert-FileAcl $staged $acl 'profile-staging-acl-not-private'
  Copy-Item -LiteralPath $Node -Destination (Join-Path $Root 'node.exe')
  Copy-Item -LiteralPath $Addon -Destination (Join-Path $Root 'profile.node')
  Copy-Item -LiteralPath $Child -Destination (Join-Path $Root 'credential-child.ts')
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'credential-profile-child.ps1') -Destination (Join-Path $Root 'credential-profile-child.ps1')
  $Node = Join-Path $Root 'node.exe'
  $Addon = Join-Path $Root 'profile.node'
  $Child = Join-Path $Root 'credential-child.ts'
  $Request = Join-Path $Root 'profile.json'
  $data.output = Join-Path $Root 'profile-output.json'
  $data.vaultFile = Join-Path $Root 'vault/synthetic.db'
  [IO.File]::WriteAllText($Request,($data | ConvertTo-Json -Depth 8))
  $vault = Join-Path $Root 'vault'
  [IO.Directory]::CreateDirectory($vault) | Out-Null
  $private = [Security.AccessControl.DirectorySecurity]::new()
  $private.SetOwner($me)
  $private.SetAccessRuleProtection($true,$false)
  $private.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  [IO.Directory]::SetAccessControl($vault,$private)
  [IO.File]::WriteAllBytes((Join-Path $vault 'synthetic.db'),[byte[]]@(31))
  $sd = [IO.Directory]::GetAccessControl($vault)
  Assert-FileAcl $sd $private 'vault-acl-not-private'
  # B may write receipts, not replace fixture executables or the private vault's ancestor.
  $diagnostic = Join-Path $Root 'profile-child-error.log'
  foreach ($file in @($data.output,$diagnostic)) {
    [IO.File]::WriteAllText($file,'')
    $fileAcl = [Security.AccessControl.FileSecurity]::new()
    $fileAcl.SetOwner($me)
    $fileAcl.SetAccessRuleProtection($true,$false)
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow'))
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write','Allow'))
    [IO.File]::SetAccessControl($file,$fileAcl)
    Assert-FileAcl ([IO.File]::GetAccessControl($file)) $fileAcl 'profile-receipt-acl-not-private'
  }
  $mutex = [Threading.Mutex]::OpenExisting($data.mutex,[Security.AccessControl.MutexRights]'Synchronize,ReadPermissions')
  $observed = $mutex.GetAccessControl()
  $mutexRules = @($observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if (!$observed.AreAccessRulesProtected -or $mutexRules.Count -ne 1 -or $observed.GetOwner([Security.Principal.SecurityIdentifier]) -ne $me -or $mutexRules[0].IdentityReference -ne $me -or $mutexRules[0].IsInherited -or $mutexRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $mutexRules[0].MutexRights -ne [Security.AccessControl.MutexRights]'Modify,Synchronize,ReadPermissions') { throw 'mutex-acl-not-private' }
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $profileChild = Join-Path $Root 'credential-profile-child.ps1'
  # Read under B's token, not A's. Never widen an ancestor ACL to make the probe pass.
  # Indices: node, addon, JS child, request, PowerShell child, receipt, diagnostic.
  $command = '"' + $powershell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $profileChild + '" "' + $Node + '" "' + $Addon + '" "' + $Child + '" "' + $Request + '" "' + $sid.Value + '"'
  try {
    [ProfileCredentialChild]::CheckInputs($user,$password,[string[]]@($Node,$Addon,$Child,$Request,$profileChild,$data.output,$diagnostic))
    [ProfileCredentialChild]::Run($user,$password,$powershell,$command,$Root,$env:SystemRoot)
    Copy-Item -LiteralPath $data.output -Destination $output
  }
  catch {
    $diagnostic = Join-Path $Root 'profile-child-error.log'
    if ([IO.File]::Exists($diagnostic)) {
      $details = [IO.File]::ReadAllText($diagnostic)
      if ($details.Length -gt 4096) { $details = $details.Substring(0,4096) + '[diagnostic truncated]' }
      throw ($_.Exception.Message + [Environment]::NewLine + $details)
    }
    throw
  }
} finally {
  if ($null -ne $mutex) { $mutex.Dispose() }
  if ($created) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
