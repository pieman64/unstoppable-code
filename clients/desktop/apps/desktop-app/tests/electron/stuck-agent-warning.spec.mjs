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

// Stuck-agent warning regression coverage.
//
// Both tests drive real live turns through the deterministic E2E mock provider.
// The first runs a genuinely long Bash command. The second delays the real
// agent response so the warning can be observed and then proven to clear.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function makeRendererVisibleAndPoll(window) {
  await window.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('long-running steps stay warning-free past the quiet threshold', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CSTUCKCOMMAND';
  const chatId = 'active-step-chat';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stuck-agent-warning-'),
  );
  const stopFile = path.join(userDataDir, 'stop-long-command');
  const command = `until test -f ${JSON.stringify(stopFile)}; do sleep 2; done`;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Active long command', messages: [] }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'Bash', input: { command } }],
          stopReason: 'tool_use',
        },
      ],
    },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.getByTestId('approval-mode-picker').click();
    await window.getByTestId('approval-mode-option-full-access').click();
    await window.clock.install();

    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Run the long verification step.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    const toolCard = window
      .locator('[data-testid="chat-tool-call"][data-tool-name="Bash"]')
      .first();
    await expect(toolCard).toBeVisible({ timeout: 90_000 });
    await expect(toolCard).toContainText('until test -f');
    await expect(toolCard).toHaveAttribute('data-tool-status', 'pending');

    const clockNow = await window.evaluate(() => Date.now());
    await window.clock.setSystemTime(clockNow + 6 * 60_000);
    await makeRendererVisibleAndPoll(window);
    await expect(window.getByTestId('stuck-agent-warning')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a fresh agent response clears an existing warning immediately', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CSTUCKRESPONSE';
  const response = 'Still working on this response';
  const chatId = 'quiet-chat';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stuck-agent-response-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Delayed response', messages: [] }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: response,
          stopReason: 'end_turn',
          streamMs: 30_000,
        },
      ],
    },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.clock.install();

    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Send a delayed response.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });

    const clockNow = await window.evaluate(() => Date.now());
    await window.clock.setSystemTime(clockNow + 6 * 60_000);
    await makeRendererVisibleAndPoll(window);
    await expect(window.getByTestId('stuck-agent-warning')).toContainText(
      'No response for 6 minutes',
    );

    await expect(window.getByText(response).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(window.getByTestId('stuck-agent-warning')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('starting a new turn in an old session never flashes the previous turn warning', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CSTUCKNEWTURN';
  const response = 'The new turn is active';
  const chatId = 'old-existing-chat';
  const oldTimestamp = Date.now() - 10 * 60_000;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stuck-agent-new-turn-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Old existing session',
        messages: [
          {
            id: 'old-user-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Previous turn' }],
            timestamp: oldTimestamp - 1_000,
          },
          {
            id: 'old-assistant-message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Previous response' }],
            timestamp: oldTimestamp,
          },
        ],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: response, stopReason: 'end_turn', streamMs: 1_000 }],
    },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.evaluate(() => {
      window.__stuckAgentWarningSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="stuck-agent-warning"]')) {
          window.__stuckAgentWarningSeen = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Start another turn.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(window.getByText(response).first()).toBeVisible({
      timeout: 60_000,
    });

    expect(await window.evaluate(() => window.__stuckAgentWarningSeen)).toBe(
      false,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
