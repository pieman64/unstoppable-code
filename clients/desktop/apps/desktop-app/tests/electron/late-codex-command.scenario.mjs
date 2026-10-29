import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { withoutChatSummaryTraffic } from './fixtures/codex-chat-summary-traffic.mjs';

const reply = 'Completed Codex fixture reply';
const followup = 'Use the Claude review pipeline for subsequent reviews.';

export async function withLateCodexCommand(
  verify,
  { emitLateCommand = true } = {},
) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-late-codex-'));
  const runtimeDir = path.join(userDataDir, 'fixture');
  mkdirSync(runtimeDir);
  const statePath = path.join(runtimeDir, 'state.json');
  const logPath = path.join(runtimeDir, 'protocol.jsonl');
  const releasePath = path.join(runtimeDir, 'release');
  writeFileSync(
    statePath,
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: 'late-command-chat',
    tabs: [
      {
        id: 'late-command-chat',
        title: 'Review follow-up',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });
  // The conversation's protocol only: the chat-summary helper runs its own
  // thread on the same fake app-server.
  const protocol = () =>
    existsSync(logPath)
      ? withoutChatSummaryTraffic(
          readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
      : [];
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CODEX_EXECUTABLE: fileURLToPath(
        new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url),
      ),
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: runtimeDir,
      CANOPY_E2E_CODEX_REPLY: reply,
      CANOPY_E2E_CODEX_MODE: 'late-command',
      CANOPY_E2E_CODEX_RELEASE_PATH: releasePath,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    await expect(window.getByTestId('chat-model-picker')).toHaveAttribute(
      'aria-label',
      /^Select model, current model (?!Workspace default$).+/,
      { timeout: 30_000 },
    );
    const send = async (text) => {
      await panel.getByRole('textbox').first().fill(text);
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    };
    await send('Start the review and finish this turn.');
    await expect(panel.getByText(reply, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(composerIdleAction(panel)).toBeVisible();
    if (emitLateCommand) {
      writeFileSync(releasePath, 'release');
      await expect
        .poll(() =>
          protocol().some((row) => row.direction === 'late-command-emitted'),
        )
        .toBe(true);
      // Deliver after the terminal has settled, then allow the ordered host
      // event commit to finish before interacting with the idle composer.
      await window.waitForTimeout(1000);
    }
    await send(followup);
    await verify({ window, panel, reply, followup, protocol });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}
