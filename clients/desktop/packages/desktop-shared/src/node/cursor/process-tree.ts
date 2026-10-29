import { killProcessGroupByPid } from '../lib/process-kill';

/**
 * Best-effort termination of a Cursor child and everything it spawned.
 *
 * The platform split lives in the shared helper, which signals the POSIX
 * process group, falls back to `taskkill /T [/F]` on Windows where process
 * groups do not exist, hides the console window that would otherwise flash,
 * and retries a direct `process.kill` when taskkill is unavailable. This
 * wrapper only adapts the optional pid the Cursor call sites carry and drops
 * the promise, because every caller signals from a synchronous teardown path
 * and an already-exited process is the common case rather than an error.
 */
export function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  // A missing, zero, or negative pid would signal the caller's own group.
  if (!pid || pid <= 0) return;
  // Windows children are spawned with `windowsHide`, so they own no window for
  // a graceful `taskkill /T` to close; it exits non-zero and the shared helper
  // falls back to terminating the parent alone, leaving every tool subprocess
  // reparented and holding worktree file handles. Ask for the forced tree kill
  // up front — the graceful attempt degrades to an unconditional terminate
  // there regardless, so no flush is lost.
  const effective: NodeJS.Signals =
    process.platform === 'win32' ? 'SIGKILL' : signal;
  // Swallow rather than `void`: an unhandled rejection here would surface as a
  // main-process `main_unhandled_rejection`, and a process that already exited
  // is the ordinary case, not an error worth propagating out of teardown.
  void killProcessGroupByPid(pid, effective).catch(() => undefined);
}
