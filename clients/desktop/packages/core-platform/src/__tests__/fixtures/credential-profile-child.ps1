param([string]$Node, [string]$Addon, [string]$Child, [string]$Request, [string]$Sid)
$ErrorActionPreference = 'Stop'
try {
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $Sid) { throw 'independent-profile-identity-mismatch' }
$data = [IO.File]::ReadAllText($Request) | ConvertFrom-Json
$denied = $false
try {
  $handle = [Threading.Mutex]::OpenExisting($data.mutex,[Security.AccessControl.MutexRights]'Synchronize,ReadPermissions')
  $handle.Dispose()
} catch [UnauthorizedAccessException] { $denied = $true }
if (!$denied) { throw 'synchronization-acl-not-isolated' }
$start = [Diagnostics.ProcessStartInfo]::new($Node)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Arguments = '"' + $Child + '" "' + $Addon + '" "' + $Request + '" "' + $Sid + '"'
$process = [Diagnostics.Process]::Start($start)
try {
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
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw ('credential-child-exit:' + $process.ExitCode + "`nstdout (truncated=" + $streams[0].Truncated + "):`n" + $streams[0].Captured + "`nstderr (truncated=" + $streams[1].Truncated + "):`n" + $streams[1].Captured)
  }
} finally { $process.Dispose() }
$receipt = [IO.File]::ReadAllText($data.output) | ConvertFrom-Json
if (!$data.challenge -or $receipt.challenge -ne $data.challenge) { throw 'profile-receipt-challenge-mismatch' }
$receipt | Add-Member -NotePropertyName mutexDenied -NotePropertyValue $denied
[IO.File]::WriteAllText($data.output,($receipt | ConvertTo-Json -Depth 8))

} catch {
  $message = $_.Exception.ToString()
  if ($message.Length -gt 4096) { $message = $message.Substring(0,4096) + '[diagnostic truncated]' }
  [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($Request)) 'profile-child-error.log'),$message)
  exit 1
}
