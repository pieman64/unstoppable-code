import path from 'node:path';
import { getCanopyRuntimeMode } from '@canopy/execution-engine/canopy-paths';
import { listMissingDesktopBundledBinaries } from '../pipelines/config-paths';
import { logMainProcessWarn } from './main-process-logging';

function getMissingBinaryHint(expectedPath: string): string {
  if (getCanopyRuntimeMode() !== 'dev') {
    return 'Reinstall the app to restore its bundled tools.';
  }
  const target = path.basename(path.dirname(expectedPath));
  return `Run \`node scripts/stage-host-binaries.mjs\`, then \`node scripts/verify-staged-binaries.mjs --target ${target}\`.`;
}

/** Logs one warning per promised bundle member that is not staged. */
export function warnAboutMissingBundledBinaries(): void {
  for (const missing of listMissingDesktopBundledBinaries()) {
    logMainProcessWarn(`Bundled ${missing.member} binary is missing.`, {
      member: missing.member,
      expectedPath: missing.path,
      hint: getMissingBinaryHint(missing.path),
    });
  }
}

/**
 * Reports missing bundled binaries once `startupSettled` resolves. Startup
 * passes the login-shell PATH prewarm, so a macOS development host fallback is
 * classified against the full user PATH; the synchronous existence checks then
 * run on a later macrotask, off the first-window path.
 */
export function scheduleMissingBundledBinaryReport(
  startupSettled: Promise<unknown>,
): void {
  const report = (): void => {
    setImmediate(warnAboutMissingBundledBinaries);
  };
  void startupSettled.then(report, report);
}
