// Managed Claude terminal transcript import through the real desktop UI and IPC.
// A local sleeping executable keeps the PTY alive; seeded JSONL supplies the
// provider records, so no model or network call controls the result.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  installExactFileIoCounter,
  readExactFileIoCounter,
  stopExactFileIoCounter,
} from './seeders/exactFileIoCounter.mjs';
import { chooseChatInterfaceMode } from './chatInterfaceMode.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'terminal-import-chat';
const SESSION_ID = 'terminal-import-session';

function pathCounterDelta(after, before, trackedPath) {
  const current = after.paths[trackedPath];
  const previous = before.paths[trackedPath];
  return Object.fromEntries(
    Object.keys(current).map((key) => [key, current[key] - previous[key]]),
  );
}

test('imports an appended Claude terminal record after its partial JSONL write completes', async ({}, testInfo) => {
  test.skip(
    process.platform === 'win32',
    'The local fixture executable is a POSIX shell script; Windows terminal sync remains unit-covered.',
  );
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-terminal-transcript-sync-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seeded.workspaces?.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) throw new Error('Expected seeded worktree');
  const projectSlug = realpathSync(worktreePath).replace(/[^A-Za-z0-9-]/g, '-');
  const transcriptPath = path.join(
    userDataDir,
    'provider-state',
    'claude',
    'projects',
    projectSlug,
    `${SESSION_ID}.jsonl`,
  );
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const measureIo = process.env.CANOPY_ADJACENT_IO_MEASURE === '1';
  const productionBuild =
    process.env.CANOPY_ADJACENT_IO_BUILD_KIND === 'production';
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: 'terminal-user',
      message: { role: 'user', content: 'Explain café and 🚀' },
    })}\n${
      measureIo
        ? `${JSON.stringify({
            type: 'ai-title',
            uuid: 'terminal-padding',
            title: 'x'.repeat(1024 * 1024),
          })}\n`
        : ''
    }`,
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Terminal import',
        sdkSessionId: SESSION_ID,
        hasStartedSession: true,
      },
    ],
  });
  const fakeClaudePath = path.join(userDataDir, 'fake-claude.sh');
  writeFileSync(fakeClaudePath, '#!/bin/sh\nwhile :; do sleep 10; done\n');
  chmodSync(fakeClaudePath, 0o755);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CLAUDE_CODE_EXECUTABLE: fakeClaudePath },
    ...(productionBuild
      ? { buildKind: 'production', productionWindowMode: 'headless' }
      : {}),
  });
  let ioCounterInstalled = false;
  let beforePartial;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    await chooseChatInterfaceMode(window, panel, 'claude-code');
    await expect
      .poll(() =>
        window.evaluate(async () =>
          window.api.claudeTerminal.getState(
            'demo-ts-pnpm-vite',
            'demo-main',
            'terminal-import-chat',
          ),
        ),
      )
      .toMatchObject({ terminalId: expect.any(String) });

    const sync = () =>
      window.evaluate(async () =>
        window.api.claudeTerminal.syncTranscript({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          chatId: 'terminal-import-chat',
        }),
      );
    expect(await sync()).toMatchObject({ importedEventCount: 1 });

    if (measureIo) {
      await installExactFileIoCounter(electronApp, [transcriptPath]);
      ioCounterInstalled = true;
      beforePartial = await readExactFileIoCounter(electronApp);
    }

    const assistantLine = JSON.stringify({
      type: 'assistant',
      uuid: 'terminal-assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The café rocket is ready.' }],
      },
    });
    appendFileSync(transcriptPath, assistantLine.slice(0, -2), 'utf8');
    expect(await sync()).toMatchObject({ importedEventCount: 0 });
    const afterPartial = ioCounterInstalled
      ? await readExactFileIoCounter(electronApp)
      : undefined;
    appendFileSync(transcriptPath, `${assistantLine.slice(-2)}\n`, 'utf8');
    expect(await sync()).toMatchObject({ importedEventCount: 1 });
    const afterCompleted = ioCounterInstalled
      ? await readExactFileIoCounter(electronApp)
      : undefined;
    expect(await sync()).toMatchObject({ importedEventCount: 0 });

    if (ioCounterInstalled) {
      const totals = await stopExactFileIoCounter(electronApp);
      ioCounterInstalled = false;
      expect(totals.paths[transcriptPath].readBytes).toBeGreaterThan(0);
      const counts = {
        totals,
        perSync: {
          partial: pathCounterDelta(
            afterPartial,
            beforePartial,
            transcriptPath,
          ),
          completed: pathCounterDelta(
            afterCompleted,
            afterPartial,
            transcriptPath,
          ),
          repeat: pathCounterDelta(totals, afterCompleted, transcriptPath),
        },
      };
      await testInfo.attach('terminal-managed-io', {
        body: JSON.stringify(counts, null, 2),
        contentType: 'application/json',
      });
    }

    await chooseChatInterfaceMode(window, panel, 'canopy');
    await expect(
      panel.getByText('The café rocket is ready.', { exact: true }),
    ).toHaveCount(1);

    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('The café rocket is ready.', { exact: true }),
    ).toHaveCount(1);
  } finally {
    if (ioCounterInstalled) await stopExactFileIoCounter(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
