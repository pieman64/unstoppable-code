import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  clearScenario,
  registerScenario,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Regression coverage for host-owned worktree-chat routing across Electron
// windows. Queue dispatch used to select `BrowserWindow.getAllWindows()[0]`;
// after App Advisor opened, that could be the advisor window. The provider turn
// still completed (and appeared in Audit Trail), but the main renderer never
// received or persisted its transcript events.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKTREE_MARKER = 'Canopy-CMULTI-WINDOW-WORKTREE';
const ADVISOR_MARKER = 'Canopy-CMULTI-WINDOW-ADVISOR';

const WORKTREE_FIRST_REPLY = 'Worktree reply before opening App Advisor';
const ADVISOR_REPLY = 'App Advisor reply from its own window';
const WORKTREE_SECOND_REPLY = 'Worktree reply after opening App Advisor';
const HOST_IMPORTED_CHAT_ID = 'host-imported-chat';

function persistedChatIncludes(userDataDir, text) {
  try {
    const root = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    const { live: file } = readChatStorageIndexes(root, WORKTREE_ID);
    return file.tabs.some((tab) =>
      readChatStorageMessages(root, WORKTREE_ID, tab.id).some((message) =>
        message.blocks?.some(
          (block) => block.type === 'text' && block.text.includes(text),
        ),
      ),
    );
  } catch {
    return false;
  }
}

function persistedChatHasTab(userDataDir, tabId) {
  try {
    const root = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    const { live: file } = readChatStorageIndexes(root, WORKTREE_ID);
    return file.tabs.some((tab) => tab.id === tabId);
  } catch {
    return false;
  }
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      defaultWorktreeProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'sonnet', thinkingLevel: 'off' },
      },
    },
  });
}

async function sendWorktreeMessage(page, message, reply) {
  const panel = page.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  const composer = panel.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await panel.getByRole('button', { name: 'Send message' }).click();

  await expect(panel.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.getByText(reply).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    panel.getByRole('button', { name: 'Stop generating' }),
  ).toHaveCount(0, { timeout: 30_000 });
}

async function sendAdvisorMessage(advisor, message, reply) {
  const composer = advisor.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await advisor.getByRole('button', { name: 'Send message' }).click();

  const transcript = advisor.getByTestId('app-advisor-workspace-surface');
  await expect(transcript.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(reply).first()).toBeVisible({
    timeout: 90_000,
  });
}

test('worktree chat keeps receiving and persisting replies after App Advisor opens', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-multi-window-routing-'),
  );

  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'routing-chat', title: 'Routing regression' }],
  });

  await registerScenario(DEFAULT_MOCK_BASE_URL, WORKTREE_MARKER, {
    llm: {
      steps: [
        { text: WORKTREE_FIRST_REPLY, stopReason: 'end_turn' },
        { text: WORKTREE_SECOND_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, ADVISOR_MARKER, {
    llm: {
      steps: [{ text: ADVISOR_REPLY, stopReason: 'end_turn' }],
    },
  });

  const first = await launchCanopy({ userDataDir });
  let firstClosed = false;
  try {
    const mainWindow = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const firstMessage = `[${WORKTREE_MARKER}] First worktree turn.`;
    await sendWorktreeMessage(mainWindow, firstMessage, WORKTREE_FIRST_REPLY);
    await expect
      .poll(() => persistedChatIncludes(userDataDir, WORKTREE_FIRST_REPLY), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .toBe(true);

    const advisor = await app.openAppAdvisorWindow(first.electronApp);
    const advisorMessage = `[${ADVISOR_MARKER}] App Advisor turn.`;
    await sendAdvisorMessage(advisor, advisorMessage, ADVISOR_REPLY);

    // Keep App Advisor open while returning to the already-selected worktree.
    // The second worktree response must route to the main renderer, and the
    // first turn must still be present in that same transcript.
    const panel = mainWindow.getByTestId('panel-content-chat');
    await expect(panel.getByText(firstMessage).first()).toBeVisible();
    await expect(panel.getByText(WORKTREE_FIRST_REPLY).first()).toBeVisible();

    const secondMessage = `[${WORKTREE_MARKER}] Second worktree turn.`;
    await sendWorktreeMessage(mainWindow, secondMessage, WORKTREE_SECOND_REPLY);
    await expect
      .poll(() => persistedChatIncludes(userDataDir, WORKTREE_SECOND_REPLY), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .toBe(true);

    // Model a main-process session import through the canonical command port.
    // Closing that host-created tab must emit an explicit removal, otherwise
    // main-process reconciliation resurrects it.
    const importedTab = {
      id: HOST_IMPORTED_CHAT_ID,
      title: 'Host imported session',
      createdAt: '2026-08-12T18:00:00.000Z',
      providerType: 'claude',
      messages: [],
    };
    const importResult = await mainWindow.evaluate(
      async ({ projectId, worktreeId, tab }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-multi-window-host-import',
          projectId,
          worktreeId,
          command: {
            type: 'chat.create_tab',
            tabId: tab.id,
            title: tab.title,
            providerType: tab.providerType,
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        tab: importedTab,
      },
    );
    expect(importResult.outcome).toBe('applied');
    const importedPanelTab = mainWindow.getByTestId(
      `panel-tab-panel-chat-${HOST_IMPORTED_CHAT_ID}`,
    );
    await expect(importedPanelTab).toBeVisible();
    // The redesigned tab reveals its close affordance on hover (#2568). A
    // SINGLE hover is not enough on a loaded runner: the tab's live icon
    // re-renders under the stationary pointer, Chromium drops `:hover`, and
    // the click keeps hit-testing the icon instead. closePanelTab re-hovers
    // and retries the pair — see its doc comment.
    await closePanelTab(mainWindow, `panel-chat-${HOST_IMPORTED_CHAT_ID}`);
    await expect(importedPanelTab).toHaveCount(0);
    await expect
      .poll(() => persistedChatHasTab(userDataDir, HOST_IMPORTED_CHAT_ID), {
        timeout: 30_000,
        intervals: [100, 250, 500],
      })
      .toBe(false);

    await closeCanopy(first.electronApp, userDataDir, {
      keepUserData: true,
    });
    firstClosed = true;

    // Reuse the same data directory to prove both routed replies reached the
    // canonical main renderer and were persisted, rather than existing only in
    // the provider/audit transcript.
    const second = await launchCanopy({ userDataDir });
    try {
      const relaunchedMainWindow = await second.electronApp.firstWindow();
      const relaunchedApp = new CanopyAppDriver(relaunchedMainWindow);
      await relaunchedApp.waitForShell({ timeout: 30_000 });
      await relaunchedApp.openMainPage();
      await relaunchedApp.selectWorktree(WORKTREE_BRANCH);

      const relaunchedPanel =
        relaunchedMainWindow.getByTestId('panel-content-chat');
      await expect(
        relaunchedPanel.getByText(firstMessage).first(),
      ).toBeVisible();
      await expect(
        relaunchedPanel.getByText(WORKTREE_FIRST_REPLY).first(),
      ).toBeVisible();
      await expect(
        relaunchedPanel.getByText(secondMessage).first(),
      ).toBeVisible();
      await expect(
        relaunchedPanel.getByText(WORKTREE_SECOND_REPLY).first(),
      ).toBeVisible();
      await expect(
        relaunchedMainWindow.getByTestId(
          `panel-tab-panel-chat-${HOST_IMPORTED_CHAT_ID}`,
        ),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  } finally {
    if (!firstClosed) {
      await closeCanopy(first.electronApp, userDataDir);
    }
    await clearScenario(DEFAULT_MOCK_BASE_URL, WORKTREE_MARKER).catch(
      () => undefined,
    );
    await clearScenario(DEFAULT_MOCK_BASE_URL, ADVISOR_MARKER).catch(
      () => undefined,
    );
  }
});
