/** Signal that stops a delegated process and its descendants. On Windows,
 * SIGTERM becomes `taskkill /t` without `/f`, which fails for hidden console
 * processes and then falls back to terminating only the root process, so
 * delegation uses SIGKILL (`taskkill /f /t`) there. */
export function delegationStopSignal(
  platform: NodeJS.Platform = process.platform,
): NodeJS.Signals {
  return platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
}
