import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  waitForGitLogToSettle,
  writeLoggingGitShim,
} from './seeders/gitCommandLog.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

const GIT_LOG_SETTLE_OPTIONS = {
  maxAttempts: 80,
  timeoutMessage: 'Git attribution log did not settle',
};

function attachLocalOrigin(userDataDir, worktreePath) {
  const remotePath = path.join(userDataDir, 'origin.git');
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: remotePath,
  });
}

function readAttributedCommands(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [source, requestId, ...commandParts] = line.split('|');
      return { source, requestId, command: commandParts.join('|') };
    });
}

function commandsForSource(commands, source) {
  return commands.filter((entry) => entry.source === source);
}

// Tracked totals come from `--numstat`; `--shortstat` is only the rename and
// copy fallback.
function worktreeStatsCommands(commands) {
  return commands.filter(
    (entry) =>
      entry.command.startsWith('status --porcelain') ||
      entry.command.includes(' --numstat') ||
      entry.command.includes(' --shortstat') ||
      entry.command.startsWith('ls-files --others --exclude-standard'),
  );
}

test('explicit stats Git commands retain attribution while session snapshots stay cache-only', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-stats-attribution-'),
  );
  const commandLogPath = path.join(userDataDir, 'git-commands.log');
  writeFileSync(commandLogPath, '');
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seed.workspaces.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) {
    throw new Error(`Missing seeded worktree for ${WORKSPACE_ID}`);
  }
  attachLocalOrigin(userDataDir, worktreePath);

  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_GIT_COMMAND_LOG: commandLogPath,
      CANOPY_GIT_EXECUTABLE: writeLoggingGitShim({
        userDataDir,
        fileName: 'git-source-attribution-shim.sh',
        attribution: 'source-request',
      }),
    },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);

    const startupBranchWatcherCommands = readAttributedCommands(
      commandLogPath,
    ).filter((entry) =>
      entry.command.startsWith('rev-parse --git-path HEAD --abbrev-ref HEAD'),
    );
    expect(startupBranchWatcherCommands).toHaveLength(0);

    writeFileSync(commandLogPath, '');
    await window.evaluate(
      ({ workspaceId, worktreeId }) =>
        window.api.getDiffStatsBatch({
          worktrees: [{ projectId: workspaceId, worktreeId }],
          source: 'renderer-targeted',
        }),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    const targetedCommands = readAttributedCommands(commandLogPath);
    const targeted = commandsForSource(targetedCommands, 'renderer-targeted');
    expect(targeted.length).toBeGreaterThan(0);
    expect(targeted.some((entry) => entry.command.includes(' --numstat'))).toBe(
      true,
    );
    expect(
      targeted.some((entry) => entry.command.startsWith('rev-parse ')),
    ).toBe(true);
    // Default-branch discovery may be served by the resolver cache. When it
    // does execute, it must retain the same request attribution.
    expect(
      targetedCommands
        .filter(
          (entry) =>
            entry.source === 'untagged' &&
            (entry.command === 'symbolic-ref refs/remotes/origin/HEAD' ||
              entry.command === 'ls-remote --symref origin HEAD'),
        )
        .map((entry) => entry.command),
    ).toEqual([]);
    const targetedRequestIds = new Set(
      targeted.map((entry) => entry.requestId),
    );
    expect(targetedRequestIds.size).toBe(1);
    expect(targetedRequestIds.has('unset')).toBe(false);

    // Even after the completed-result fresh window expires, desktop session
    // projection stays cache-only and must not launch Git. Refresh attribution
    // belongs to the explicit renderer request above.
    await delay(5_250);
    writeFileSync(commandLogPath, '');
    await window.evaluate(
      ({ workspaceId, worktreeId }) =>
        window.api.getDesktopSessionSnapshot({
          workspaceLocalId: workspaceId,
          worktreeLocalId: worktreeId,
        }),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    await waitForGitLogToSettle(commandLogPath, GIT_LOG_SETTLE_OPTIONS);
    // Unrelated background branch/common-dir probes may overlap this window.
    // Reject the complete worktree-stats command family across every source so
    // missing or incorrect attribution cannot hide a snapshot regression.
    expect(
      worktreeStatsCommands(readAttributedCommands(commandLogPath)),
    ).toEqual([]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
