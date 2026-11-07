param([string]$Node, [string]$Addon, [string]$Child, [string]$Request, [string]$Sid)
$ErrorActionPreference = 'Stop'
# A fresh B profile has no module-analysis cache; never scan the runner's installed modules.
$PSModuleAutoLoadingPreference = 'None'
$clock = [Diagnostics.Stopwatch]::StartNew()
$diagnostic = [IO.Path]::Combine([IO.Path]::GetDirectoryName($Request),'profile-child-ps.log')
function Write-Stage([string]$Stage) {
  try { [IO.File]::AppendAllText($diagnostic,('credential-profile-child stage={0} elapsedMs={1}{2}' -f $Stage,$clock.ElapsedMilliseconds,[Environment]::NewLine)) }
  catch { [Console]::Error.WriteLine('credential-profile-child diagnostic-write-refused') }
}
try {
Write-Stage 'command-entry-file'
Write-Stage 'identity:start'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $Sid) { throw 'independent-profile-identity-mismatch' }
Write-Stage 'identity:done'
Write-Stage 'temp-probe:start'
$temporaryProbe = [IO.Path]::Combine($env:TEMP,'credential-profile-write-probe')
[IO.File]::WriteAllText($temporaryProbe,'disposable')
[IO.File]::Delete($temporaryProbe)
Write-Stage 'temp-probe:done'
Write-Stage 'utility-import:start'
# JSON and Add-Member only: a full manifest path bypasses PSModulePath discovery.
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
Write-Stage 'utility-import:done'
$data = [IO.File]::ReadAllText($Request) | ConvertFrom-Json
Write-Stage 'mutex-probe:start'
$denied = $false
try {
  $handle = [Threading.Mutex]::OpenExisting($data.mutex,[Security.AccessControl.MutexRights]'Synchronize,ReadPermissions')
  $handle.Dispose()
} catch [UnauthorizedAccessException] { $denied = $true }
if (!$denied) { throw 'synchronization-acl-not-isolated' }
Write-Stage 'mutex-probe:done'
$start = [Diagnostics.ProcessStartInfo]::new($Node)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Arguments = '"' + $Child + '" "' + $Addon + '" "' + $Request + '" "' + $Sid + '"'
Write-Stage 'node-start:start'
$process = [Diagnostics.Process]::Start($start)
try {
  Write-Stage ('node-start:done pid=' + $process.Id)
  Write-Stage 'pipe-drain:start'
  $streams = @($process.StandardOutput,$process.StandardError) | ForEach-Object {
    $buffer = [char[]]::new(1024)
    [pscustomobject]@{ Reader = $_; Buffer = $buffer; Pending = $_.ReadAsync($buffer,0,$buffer.Length); Captured = [Text.StringBuilder]::new(); Truncated = $false }
  }
  # Drain both pipes after the capture bound too, so a noisy child cannot deadlock.
  while ($streams[0].Pending -or $streams[1].Pending) {
    $pending = [Threading.Tasks.Task[]]@($streams | Where-Object { $null -ne $_.Pending } | ForEach-Object { $_.Pending })
    [Threading.Tasks.Task]::WaitAny($pending) | Out-Null
    foreach ($stream in $streams) {
      if ($null -eq $stream.Pending -or !$stream.Pending.IsCompleted) { continue }
      $count = $stream.Pending.GetAwaiter().GetResult()
      $remaining = 1536 - $stream.Captured.Length
      if ($count -gt $remaining) { $stream.Truncated = $true }
      if ($remaining -gt 0 -and $count -gt 0) {
        $stream.Captured.Append($stream.Buffer,0,[Math]::Min($count,$remaining)) | Out-Null
      }
      if ($count -eq 0) { $stream.Pending = $null }
      else { $stream.Pending = $stream.Reader.ReadAsync($stream.Buffer,0,$stream.Buffer.Length) }
    }
  }
  Write-Stage 'pipe-drain:done'
  Write-Stage 'node-wait:start'
  $process.WaitForExit()
  Write-Stage ('node-wait:done exit=' + $process.ExitCode)
  if ($process.ExitCode -ne 0) {
    throw ('credential-child-exit:' + $process.ExitCode + "`nstdout (truncated=" + $streams[0].Truncated + "):`n" + $streams[0].Captured + "`nstderr (truncated=" + $streams[1].Truncated + "):`n" + $streams[1].Captured)
  }
} finally { $process.Dispose() }
Write-Stage 'receipt:start'
$receipt = [IO.File]::ReadAllText($data.output) | ConvertFrom-Json
if (!$data.challenge -or $receipt.challenge -ne $data.challenge) { throw 'profile-receipt-challenge-mismatch' }
$receipt | Add-Member -NotePropertyName mutexDenied -NotePropertyValue $denied
[IO.File]::WriteAllText($data.output,($receipt | ConvertTo-Json -Depth 8))
Write-Stage 'receipt:done'

} catch {
  $message = $_.Exception.ToString()
  if ($message.Length -gt 4096) { $message = $message.Substring(0,2048) + "`n[diagnostic truncated]`n" + $message.Substring($message.Length - 2048) }
  try { [IO.File]::AppendAllText($diagnostic,$message) }
  catch { [Console]::Error.WriteLine($message) }
  exit 1
}
