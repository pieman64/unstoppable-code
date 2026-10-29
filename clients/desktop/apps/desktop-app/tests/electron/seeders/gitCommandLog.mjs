import { chmodSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOG_FORMATS = {
  command: 'printf \'%s\\n\' "$*"',
  source: 'printf \'%s|%s\\n\' "${CANOPY_GIT_REQUEST_SOURCE:-untagged}" "$*"',
  'source-request':
    'printf \'%s|%s|%s\\n\' "${CANOPY_GIT_REQUEST_SOURCE:-untagged}" "${CANOPY_GIT_REQUEST_ID:-unset}" "$*"',
};

/**
 * Writes a real-git delegating shim with the command-log formats used by the
 * Git polling Electron specs. Distinct attribution and delay behavior remains
 * explicit at each call site.
 */
export function writeLoggingGitShim({
  userDataDir,
  fileName = 'git-command-log-shim.sh',
  attribution = 'command',
  statusDelaySeconds = 0,
}) {
  if (path.basename(fileName) !== fileName) {
    throw new Error('Git shim fileName must be a basename');
  }
  const logCommand = LOG_FORMATS[attribution];
  if (!logCommand) {
    throw new Error(`Unsupported Git command log attribution: ${attribution}`);
  }
  if (!Number.isFinite(statusDelaySeconds) || statusDelaySeconds < 0) {
    throw new Error('statusDelaySeconds must be a non-negative number');
  }

  const shimPath = path.join(userDataDir, fileName);
  const statusDelay =
    statusDelaySeconds > 0
      ? `case "$*" in *"status --porcelain"*) sleep ${statusDelaySeconds};; esac\n`
      : '';
  writeFileSync(
    shimPath,
    `#!/bin/sh\n${logCommand} >> "$CANOPY_E2E_GIT_COMMAND_LOG"\n${statusDelay}exec /usr/bin/git "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

/**
 * Resolves only after the command log remains byte-stable for a bounded number
 * of samples. Callers choose the existing timeout/error contract explicitly.
 */
export async function waitForGitLogToSettle(
  logPath,
  {
    intervalMs = 250,
    maxAttempts = 40,
    stableSamples = 4,
    timeoutMessage = 'Git command log did not settle',
  } = {},
) {
  let previousSize = -1;
  let stableSampleCount = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentSize = statSync(logPath).size;
    if (currentSize === previousSize) {
      stableSampleCount += 1;
      if (stableSampleCount >= stableSamples) return;
    } else {
      previousSize = currentSize;
      stableSampleCount = 0;
    }
    await delay(intervalMs);
  }
  throw new Error(timeoutMessage);
}
