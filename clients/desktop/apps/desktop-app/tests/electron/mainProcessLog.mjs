import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

/**
 * Attach the desktop's main-process log to the running test.
 *
 * A failure that only shows up on CI often leaves nothing in the renderer to
 * explain it: a dialog still waiting on a main-process call looks the same
 * whether that call is slow, stuck, or was never made. The app writes its
 * main-process log under the launch's data directory, so call this from a
 * test's failure path, before the launch is closed and that directory is
 * removed. A launch that never wrote a log attaches nothing.
 *
 * @param {string} userDataDir The data directory the app was launched with.
 * @param {string} [name] Attachment name shown in the report.
 */
export async function attachMainProcessLog(
  userDataDir,
  name = 'main-process-log',
) {
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  if (!existsSync(logPath)) return;
  await test.info().attach(name, { path: logPath, contentType: 'text/plain' });
}
