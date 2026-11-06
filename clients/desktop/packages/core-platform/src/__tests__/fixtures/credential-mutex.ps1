# Independent synchronization-object ACL observer/holder. stdin EOF releases the handle.
param([string]$Name, [string]$Mode = 'private')
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'event') {
  $event = [Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,$Name)
  try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }
  finally { $event.Dispose() }
  return
}
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.MutexSecurity]::new()
$security.SetOwner($me)
$security.SetAccessRuleProtection($true,$false)
$rights = [Security.AccessControl.MutexRights]'Modify,Synchronize,ReadPermissions'
$security.AddAccessRule([Security.AccessControl.MutexAccessRule]::new($me,$rights,'Allow'))
if ($Mode -eq 'collision') {
  $security.AddAccessRule([Security.AccessControl.MutexAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),$rights,'Allow'))
}
$created = $false
$mutex = [Threading.Mutex]::new($true,$Name,[ref]$created,$security)
try {
  $observed = $mutex.GetAccessControl()
  if (!$created -or !$observed.AreAccessRulesProtected -or $observed.GetOwner([Security.Principal.SecurityIdentifier]) -ne $me) { throw 'mutex-acl-not-owned' }
  if ($Mode -eq 'private' -and ($observed.Access.Count -ne 1 -or $observed.Access[0].MutexRights -ne $rights)) { throw 'mutex-acl-not-private' }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
