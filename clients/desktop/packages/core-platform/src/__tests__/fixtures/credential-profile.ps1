# Test-only. No network-logon fallback: both profiles must actually use Credential Manager.
param([string]$Node, [string]$Addon, [string]$Child, [string]$Request, [string]$Root, [string]$Stage)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$clock = [Diagnostics.Stopwatch]::StartNew()
function Write-Stage([string]$Stage) {
  [Console]::Error.WriteLine(('credential-profile stage={0} elapsedMs={1} utc={2}' -f $Stage,$clock.ElapsedMilliseconds,[DateTime]::UtcNow.ToString('o')))
}
function New-ProfileChildCommand([string]$PowerShell,[Security.Principal.SecurityIdentifier]$Sid,[string]$Directory) {
  $inputs = @('credential-profile-child.ps1','node.exe','profile.node','credential-child.ts','profile.json') | ForEach-Object { '"' + [IO.Path]::Combine($Directory,$_) + '"' }
  $command = '"' + $PowerShell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + ($inputs -join ' ') + ' "' + $Sid.Value + '"'
  if ($command.Length -ge 1024) { throw 'profile-command-too-long' }
  return $command
}
Write-Stage 'add-type:start'
. (Join-Path $PSScriptRoot 'credential-profile-native.ps1')
Write-Stage 'add-type:done'
function Assert-FileAcl($Actual,$Expected,[string]$Failure) {
  $rules = @($Actual,$Expected) | ForEach-Object {
    $entries = $_.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
      '{0}:{1}:{2}:{3}:{4}:{5}' -f $_.IdentityReference.Value,[int]$_.FileSystemRights,[int]$_.InheritanceFlags,[int]$_.PropagationFlags,[int]$_.AccessControlType,$_.IsInherited
    }
    (@($entries | Sort-Object) -join ';')
  }
  if (!$Actual.AreAccessRulesProtected -or $Actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $Expected.GetOwner([Security.Principal.SecurityIdentifier]) -or $rules[0] -ne $rules[1]) { throw $Failure }
}
function Read-ChildDiagnostic([string]$Path) {
  $label = 'credential-profile diagnostic=' + [IO.Path]::GetFileName($Path)
  if (![IO.File]::Exists($Path)) { return ($label + ' state=missing') }
  try {
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite,Delete')
    try {
      if ($stream.Length -eq 0) { return ($label + ' state=empty') }
      $buffer = [byte[]]::new(4096)
      if ($stream.Length -le $buffer.Length) {
        $count = $stream.Read($buffer,0,$buffer.Length)
        return ($label + " state=content`n" + [Text.Encoding]::UTF8.GetString($buffer,0,$count))
      }
      $first = $stream.Read($buffer,0,2048)
      $stream.Seek(-2048,[IO.SeekOrigin]::End) | Out-Null
      $last = $stream.Read($buffer,2048,2048)
      return ($label + ' state=truncated bytes=' + $stream.Length + "`n" + [Text.Encoding]::UTF8.GetString($buffer,0,$first) + "`n[diagnostic truncated]`n" + [Text.Encoding]::UTF8.GetString($buffer,2048,$last))
    } finally { $stream.Dispose() }
  } catch { return ($label + ' state=read-refused') }
}
function Remove-StageEntry([string]$Path) {
  $attributes = [IO.File]::GetAttributes($Path)
  $directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  # Windows PowerShell's recursive provider removal can traverse B-created junctions.
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($directory) { [IO.Directory]::Delete($Path) }
    else { [IO.File]::Delete($Path) }
    return
  }
  if ($attributes -band [IO.FileAttributes]::ReadOnly) { [IO.File]::SetAttributes($Path,($attributes -band (-bnot [IO.FileAttributes]::ReadOnly))) }
  if ($directory) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Remove-StageEntry $entry }
    [IO.Directory]::Delete($Path)
  } else {
    [IO.File]::Delete($Path)
  }
}
$user = $env:CANOPY_CREDENTIAL_PROBE_USER
$password = $env:CANOPY_CREDENTIAL_PROBE_PASSWORD
# The local runner supplies a pre-existing profile-capable account through its probe inputs.
if (!$user -and !$password -and !$env:CI) {
  $user = $env:CANOPY_PIPE_PROBE_USER
  $password = $env:CANOPY_PIPE_PROBE_PASSWORD
}
if (!$user -or !$password) { throw 'two-profile-fixture-required' }
Write-Stage 'identity:start'
$sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME,$user)).Translate([Security.Principal.SecurityIdentifier])
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($sid -eq $me) { throw 'independent-profile-required' }
Write-Stage 'identity:done'
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
$diagnostics = @()
try {
  Write-Stage 'staging:start'
  [ProfileCredentialChild]::CreateStage($Root,$acl.GetSecurityDescriptorBinaryForm())
  $created = $true
  [IO.File]::WriteAllText((Join-Path $sourceRoot 'profile-stage-created'),'created')
  $staged = [IO.Directory]::GetAccessControl($Root)
  Assert-FileAcl $staged $acl 'profile-staging-acl-not-private'
  Write-Stage 'staging-copy:start'
  Copy-Item -LiteralPath $Node -Destination (Join-Path $Root 'node.exe')
  Copy-Item -LiteralPath $Addon -Destination (Join-Path $Root 'profile.node')
  Copy-Item -LiteralPath $Child -Destination (Join-Path $Root 'credential-child.ts')
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'credential-profile-child.ps1') -Destination (Join-Path $Root 'credential-profile-child.ps1')
  Write-Stage 'staging-copy:done'
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
  # B needs writable TEMP without permission to replace the fixture inputs.
  $temporaryRoot = Join-Path $Root 'child-temp'
  $temporaryAcl = [Security.AccessControl.DirectorySecurity]::new()
  $temporaryAcl.SetOwner($me)
  $temporaryAcl.SetAccessRuleProtection($true,$false)
  $temporaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  $temporaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute,Write','None','None','Allow'))
  $temporaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','InheritOnly','Allow'))
  [ProfileCredentialChild]::CreateStage($temporaryRoot,$temporaryAcl.GetSecurityDescriptorBinaryForm())
  Assert-FileAcl ([IO.Directory]::GetAccessControl($temporaryRoot)) $temporaryAcl 'profile-temp-acl-not-private'
  # B may write receipts, not replace fixture executables or the private vault's ancestor.
  $childDiagnostics = @((Join-Path $Root 'profile-child-ps.log'),(Join-Path $Root 'profile-child-node.log'))
  $hostDiagnostic = Join-Path $Root 'profile-child-host.log'
  $diagnostics = @($hostDiagnostic) + $childDiagnostics
  foreach ($file in (@($data.output) + $childDiagnostics)) {
    [IO.File]::WriteAllText($file,'')
    $fileAcl = [Security.AccessControl.FileSecurity]::new()
    $fileAcl.SetOwner($me)
    $fileAcl.SetAccessRuleProtection($true,$false)
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow'))
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read,Write','Allow'))
    [IO.File]::SetAccessControl($file,$fileAcl)
    Assert-FileAcl ([IO.File]::GetAccessControl($file)) $fileAcl 'profile-receipt-acl-not-private'
  }
  # A opens the host log; B receives only its inherited handle, not path write access.
  [IO.File]::WriteAllText($hostDiagnostic,'')
  $hostAcl = [Security.AccessControl.FileSecurity]::new()
  $hostAcl.SetOwner($me)
  $hostAcl.SetAccessRuleProtection($true,$false)
  $hostAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow'))
  [IO.File]::SetAccessControl($hostDiagnostic,$hostAcl)
  Assert-FileAcl ([IO.File]::GetAccessControl($hostDiagnostic)) $hostAcl 'profile-host-diagnostic-acl-not-private'
  Write-Stage 'staging:done'
  Write-Stage 'mutex-check:start'
  $mutex = [Threading.Mutex]::OpenExisting($data.mutex,[Security.AccessControl.MutexRights]'Synchronize,ReadPermissions')
  $observed = $mutex.GetAccessControl()
  $mutexRules = @($observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if (!$observed.AreAccessRulesProtected -or $mutexRules.Count -ne 1 -or $observed.GetOwner([Security.Principal.SecurityIdentifier]) -ne $me -or $mutexRules[0].IdentityReference -ne $me -or $mutexRules[0].IsInherited -or $mutexRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $mutexRules[0].MutexRights -ne [Security.AccessControl.MutexRights]'Modify,Synchronize,ReadPermissions') { throw 'mutex-acl-not-private' }
  Write-Stage 'mutex-check:done'
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $profileChild = Join-Path $Root 'credential-profile-child.ps1'
  # Read under B's token, not A's. Never widen an ancestor ACL to make the probe pass.
  # Indices: node, addon, JS child, request, PowerShell child, receipt, PowerShell diagnostic, Node diagnostic.
  $command = New-ProfileChildCommand $powershell $sid $Root
  Write-Stage ('child-command:file chars=' + $command.Length)
  [ProfileCredentialChild]::CheckInputs($user,$password,[string[]](@($Node,$Addon,$Child,$Request,$profileChild,$data.output) + $childDiagnostics))
  # Reserve 5 s for termination and 5 s for cleanup inside execFile's unchanged 45 s budget.
  [ProfileCredentialChild]::Run($user,$password,$powershell,$command,$Root,$env:SystemRoot,[int][Math]::Max(0,35000 - $clock.ElapsedMilliseconds),30000,$temporaryRoot,$hostDiagnostic)
  Write-Stage 'receipt-copy:start'
  Copy-Item -LiteralPath $data.output -Destination $output
  Write-Stage 'receipt-copy:done'
} finally {
  Write-Stage 'cleanup:start'
  try {
    if ($created) {
      $report = [Text.StringBuilder]::new()
      foreach ($childDiagnostic in $diagnostics) {
        $details = Read-ChildDiagnostic $childDiagnostic
        [Console]::Error.WriteLine($details)
        $report.AppendLine($details) | Out-Null
      }
      try { [IO.File]::WriteAllText((Join-Path $sourceRoot 'profile-child-diagnostics.log'),$report.ToString()) }
      catch { [Console]::Error.WriteLine('credential-profile diagnostic-persist-refused') }
    }
  } finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
    if ($created) { Remove-StageEntry $Root }
  }
  Write-Stage 'cleanup:done'
}
