import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chatPanelLocator, DEFAULT_GROUP_IDS } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PRIOR_TURN_STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');
const PRIOR_TURN_COMPLETED_AT = PRIOR_TURN_STARTED_AT + 5_000;
const SEEDED_PRIOR_REPLY = 'Prior seeded assistant reply for the fork spec';

/** @param {{ captureDir?: string, stage?: 'before' | 'after', popOut?: boolean }} [options] */
export async function runBranchOwnerFlow(options = {}) {
  const captureDir = options.captureDir;
  const stage = options.stage ?? 'after';
  const popOut = options.popOut ?? true;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'branch-owner-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  const sourceChatId = 'branch-owner-source';
  const marker = 'Canopy-CBRANCHOWNER';
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: sourceChatId,
        title: 'Branch owner source',
        model: 'claude-haiku-4-5-20251001',
        hasStartedSession: true,
        messages: [
          {
            id: 'owner-user',
            role: 'user',
            timestamp: PRIOR_TURN_STARTED_AT,
            blocks: [
              {
                type: 'text',
                text: 'Continue this conversation in a branch',
              },
            ],
          },
          {
            id: 'owner-reply',
            role: 'assistant',
            timestamp: PRIOR_TURN_STARTED_AT + 1_000,
            blocks: [{ type: 'text', text: SEEDED_PRIOR_REPLY }],
          },
          {
            id: 'owner-timer',
            role: 'system',
            timestamp: PRIOR_TURN_COMPLETED_AT,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: PRIOR_TURN_STARTED_AT,
                completedAt: PRIOR_TURN_COMPLETED_AT,
              },
            ],
          },
        ],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Unexpected untagged request', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        child: { text: 'Reply owned by the branch', stopReason: 'end_turn' },
        source: {
          text: 'Original turn remains interruptible',
          streamMs: 120_000,
        },
      },
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    let auxiliary = window;
    if (popOut) {
      // Popping out an empty group is refused, so wait for the seeded chat to
      // land in it first; selecting the worktree does not wait for its tabs.
      await expect(chatPanelLocator(window, sourceChatId)).toBeVisible();
      const auxiliaryWindow = electronApp.waitForEvent('window');
      await window.evaluate(
        (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
        DEFAULT_GROUP_IDS.chat,
      );
      auxiliary = await auxiliaryWindow;
      await expect(
        auxiliary.getByTestId('panel-aux-window-root'),
      ).toBeVisible();
      // The retained panel belongs to the source even when global navigation
      // points at another project with the same local worktree id.
      await window
        .locator(
          '[data-testid="worktree-row"][data-project-id="demo-ts-npm-next"][data-worktree-id="demo-main"]',
        )
        .click();
    }
    await auxiliary.getByTestId('turn-more-actions').last().click();
    await auxiliary.getByTestId('turn-more-branch').click();
    const selected = window
      .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
      .first();
    const dismissUnrelatedToasts = async () => {
      const dismiss = window
        .getByTestId('toast-card')
        .getByRole('button', { name: 'Dismiss' });
      for (
        let index = 0;
        index < 10 && (await dismiss.count()) > 0;
        index += 1
      ) {
        await dismiss.first().click();
      }
    };
    if (captureDir && stage === 'before') {
      if (popOut) {
        await expect(selected).toHaveAttribute(
          'data-project-id',
          'demo-ts-npm-next',
        );
      } else {
        await expect(selected).not.toHaveAttribute(
          'data-worktree-id',
          WORKTREE_ID,
        );
      }
      mkdirSync(captureDir, { recursive: true });
      await dismissUnrelatedToasts();
      await window.getByTestId('sidebar-scrolling-navigation').screenshot({
        path: path.join(captureDir, 'main-before.png'),
        animations: 'disabled',
      });
      await chatPanelLocator(auxiliary).screenshot({
        path: path.join(
          captureDir,
          popOut ? 'source-before.png' : 'child-before.png',
        ),
        animations: 'disabled',
      });
      return;
    }
    await expect(selected).not.toHaveAttribute('data-worktree-id', WORKTREE_ID);
    const childWorktreeId = await selected.getAttribute('data-worktree-id');
    // Submit through the first visible branch composer before any canonical
    // read can give hydration extra time to replace an earlier panel binding.
    const childPanel = chatPanelLocator(window);
    await expect(
      childPanel.getByText('Continue this conversation in a branch'),
    ).toBeVisible();
    const childText = `[${marker}] [Canopy-Mock-Request:child] First message in the branch`;
    await childPanel.getByRole('textbox').fill(childText);
    await childPanel.getByRole('textbox').press('Enter');
    await expect(
      childPanel.getByText('Reply owned by the branch').first(),
    ).toBeVisible({ timeout: 60_000 });
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await dismissUnrelatedToasts();
      await window.getByTestId('sidebar-scrolling-navigation').screenshot({
        path: path.join(captureDir, 'main-after.png'),
        animations: 'disabled',
      });
      await childPanel.screenshot({
        path: path.join(captureDir, 'child-after.png'),
        animations: 'disabled',
      });
    }
    const childState = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      { projectId: WORKSPACE_ID, worktreeId: childWorktreeId },
    );
    const child = childState.tabsFile.tabs.find(
      (tab) => tab.forkedFrom?.chatId === sourceChatId,
    );
    expect(child?.forkedFrom?.worktreeId).toBe(WORKTREE_ID);
    expect(
      child?.messages.some((message) =>
        message.blocks.some(
          (block) => block.type === 'text' && block.text.includes(childText),
        ),
      ),
    ).toBe(true);
    const sourceScope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const sourceBefore = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      sourceScope,
    );
    expect(
      sourceBefore.tabsFile.tabs
        .find((tab) => tab.id === sourceChatId)
        ?.messages.some((message) =>
          message.blocks.some(
            (block) => block.type === 'text' && block.text.includes(childText),
          ),
        ),
    ).toBe(false);
    if (!popOut) await app.selectWorktree(WORKTREE_ID);
    const sourcePanel = chatPanelLocator(auxiliary, sourceChatId);
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('chat:cancel');
      globalThis.__branchStopRequests = [];
      ipcMain.removeHandler('chat:cancel');
      ipcMain.handle('chat:cancel', async (event, request) => {
        const receipt = { target: request, phase: 'started' };
        globalThis.__branchStopRequests.push(receipt);
        try {
          const result = await original(event, request);
          receipt.phase = 'completed';
          return result;
        } catch (error) {
          receipt.phase = 'failed';
          receipt.error = String(error);
          throw error;
        }
      });
    });
    await sourcePanel
      .getByRole('textbox')
      .fill(`[${marker}] [Canopy-Mock-Request:source] Run the original turn`);
    await sourcePanel.getByRole('textbox').press('Enter');
    const sourceStop = sourcePanel.getByTestId('chat-stop-generation');
    await expect(sourceStop).toBeVisible({ timeout: 30_000 });
    await sourceStop.click();
    try {
      await expect(sourceStop).toBeHidden({ timeout: 30_000 });
    } catch (error) {
      const receipts = await electronApp.evaluate(
        () => globalThis.__branchStopRequests,
      );
      const sourceState = await window.evaluate(
        (scope) => window.api.chat.getState(scope),
        sourceScope,
      );
      await test.info().attach('source-stop-state', {
        body: Buffer.from(JSON.stringify({ receipts, sourceState })),
        contentType: 'application/json',
      });
      throw error;
    }
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await dismissUnrelatedToasts();
      await sourcePanel.screenshot({
        path: path.join(captureDir, 'source-after.png'),
        animations: 'disabled',
      });
    }

    if (!popOut) await app.selectWorktree(childWorktreeId);
    await expect(
      childPanel.getByText('Reply owned by the branch').first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}
