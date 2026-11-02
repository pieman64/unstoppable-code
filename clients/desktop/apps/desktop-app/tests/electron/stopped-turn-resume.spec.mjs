import { expandTurnSteps } from './turnSteps.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

// CAN-3137 — explicit Resume after the user stops a turn.
//
// The stopped turn is a real Bash tool call that never finishes on its own, so
// the stop always lands mid-turn. Its tool_use assistant message is always in
// the provider history, which makes the deterministic mock provider answer the
// resume request with the second scripted step.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const RESUMED_TEXT = 'Resumed and finished the verification';

async function launchWithStoppableTurn({ marker, chatId, tmpPrefix }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const stopFile = path.join(userDataDir, 'never-created');
  const command = `until test -f ${JSON.stringify(stopFile)}; do sleep 2; done`;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Stoppable turn', messages: [] }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'Bash', input: { command } }],
          stopReason: 'tool_use',
        },
        { text: RESUMED_TEXT, stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  return { electronApp, userDataDir };
}

function bashToolCard(window) {
  return window
    .locator('[data-testid="chat-tool-call"][data-tool-name="Bash"]')
    .first();
}

async function startAndStopTurn(window, marker, prompt) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Individual-step assertions use the Detailed preference.
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await window.getByTestId('approval-mode-picker').click();
  await window.getByTestId('approval-mode-option-full-access').click();

  const composer = window.getByRole('textbox').first();
  await composer.fill(`[${marker}] ${prompt}`);
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect(bashToolCard(window)).toBeVisible({ timeout: 90_000 });
  await window.getByTestId('chat-stop-generation').click();
  await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0, {
    timeout: 30_000,
  });
}

test('a stopped turn resumes once in the same chat without repeating the prompt', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CRESUMESTOPPED';
  const prompt = 'Run the long verification step.';
  const { electronApp, userDataDir } = await launchWithStoppableTurn({
    marker,
    chatId: 'resume-stopped-chat',
    tmpPrefix: 'canopy-stopped-turn-resume-',
  });
  try {
    const window = await electronApp.firstWindow();
    await startAndStopTurn(window, marker, prompt);

    const notice = window.getByTestId('stopped-turn-resume');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const resume = window.getByTestId('stopped-turn-resume-button');
    // Rapid repeated clicks must dispatch a single resume.
    await resume.dblclick();

    await expect(window.getByText(RESUMED_TEXT)).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(notice).toHaveCount(0);
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
    // Completed turns collapse intermediate steps. Expanding the retained
    // summary proves the stopped turn's partial tool output stayed attached
    // to the same turn rather than being replaced by the continuation.
    await expandTurnSteps(window);
    await expect(bashToolCard(window)).toBeVisible();
    await expect(
      window.getByText(`[${marker}] ${prompt}`, { exact: true }),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('starting a new turn retires the stale Resume offer', async () => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CRESUMESTALE';
  const { electronApp, userDataDir } = await launchWithStoppableTurn({
    marker,
    chatId: 'resume-stale-chat',
    tmpPrefix: 'canopy-stopped-turn-stale-',
  });
  try {
    const window = await electronApp.firstWindow();
    await startAndStopTurn(window, marker, 'Run the long verification step.');

    const notice = window.getByTestId('stopped-turn-resume');
    await expect(notice).toBeVisible({ timeout: 30_000 });

    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Do something else instead.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(notice).toHaveCount(0);
    await expect(window.getByText(RESUMED_TEXT)).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(notice).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
