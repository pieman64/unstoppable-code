import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  waitForGitLogToSettle,
  writeLoggingGitShim,
} from '../seeders/gitCommandLog.mjs';

async function withTempDir(run) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'git-command-log-test-'),
  );
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('writeLoggingGitShim preserves command-only logging and delegates to git', async () => {
  await withTempDir((userDataDir) => {
    const logPath = path.join(userDataDir, 'git.log');
    writeFileSync(logPath, '');
    const shimPath = writeLoggingGitShim({
      userDataDir,
      fileName: 'command-only.sh',
    });

    const output = execFileSync(shimPath, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, CANOPY_E2E_GIT_COMMAND_LOG: logPath },
    });

    assert.match(output, /^git version /);
    assert.equal(readFileSync(logPath, 'utf8'), '--version\n');
  });
});

test('writeLoggingGitShim preserves source attribution and optional status delay', async () => {
  await withTempDir((userDataDir) => {
    const logPath = path.join(userDataDir, 'git.log');
    writeFileSync(logPath, '');
    const shimPath = writeLoggingGitShim({
      userDataDir,
      fileName: 'attributed.sh',
      attribution: 'source-request',
      statusDelaySeconds: 0.01,
    });

    execFileSync(shimPath, ['status', '--porcelain'], {
      env: {
        ...process.env,
        CANOPY_E2E_GIT_COMMAND_LOG: logPath,
        CANOPY_GIT_REQUEST_SOURCE: 'renderer-test',
        CANOPY_GIT_REQUEST_ID: 'request-7',
      },
    });

    assert.equal(
      readFileSync(logPath, 'utf8'),
      'renderer-test|request-7|status --porcelain\n',
    );
  });
});

test('waitForGitLogToSettle waits for a stable sample window', async () => {
  await withTempDir(async (userDataDir) => {
    const logPath = path.join(userDataDir, 'git.log');
    writeFileSync(logPath, 'first\n');
    const writer = setTimeout(
      () => writeFileSync(logPath, 'first\nsecond\n'),
      5,
    );

    await waitForGitLogToSettle(logPath, {
      intervalMs: 10,
      maxAttempts: 10,
      stableSamples: 2,
    });
    clearTimeout(writer);

    assert.equal(readFileSync(logPath, 'utf8'), 'first\nsecond\n');
  });
});
