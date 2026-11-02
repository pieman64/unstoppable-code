import { readChatStorageTabs } from './readChatStorage.mjs';
// ---------------------------------------------------------------------------
// Codex MCP tool-call rendering — deterministic lifecycle + persistence spec.
//
// Injects normalized Codex `mcp_tool_call` items through the real `chat:event`
// renderer subscription (no fake app-server) and asserts the shared
// `chat-tool-call` card exposes the pending → success/error lifecycle through
// the stable `data-tool-name`/`data-tool-status` hooks, that concurrent calls
// stay distinct, that both Cowork and Code chat surfaces render and persist
// terminal blocks, and that the Code cards restore after an Electron relaunch
// against the same isolated user-data directory.
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'codex-mcp-render-chat';
const SECOND_CHAT_ID = 'codex-mcp-render-second-chat';
const THREAD_ID = 'thread-mcp-render';
const TURN_ID = 'turn-mcp-render';
const COWORK_WORKSPACE_ID = 'cowork-mcp-render';
const COWORK_ENTRY_ID = 'cowork-mcp-entry';
const COWORK_CHAT_ID = 'cowork-mcp-chat';

const MCP_SERVER = 'appproxy-internal-hub-prod--opaque';
const SUCCESS_TOOL = 'query-gcp-logs';
const FAILURE_TOOL = 'restart-ingest-workload';
const SUCCESS_TOOL_NAME = `mcp__${MCP_SERVER}__${SUCCESS_TOOL}`;
const FAILURE_TOOL_NAME = `mcp__${MCP_SERVER}__${FAILURE_TOOL}`;
const IMMEDIATE_RESTART_TOOL_NAME = 'canopy_immediate_turn_restart';
const SUCCESS_RESULT_TEXT = '3 log entries matched';
const STRUCTURED_SENTINEL = 'structured-content-sentinel-9f2';
const FAILURE_MESSAGE = 'HTTP 504 gateway timeout from upstream MCP proxy';

function codexEvent(
  event,
  {
    workspaceId = WORKSPACE_ID,
    worktreeId = WORKTREE_ID,
    chatId = CHAT_ID,
  } = {},
) {
  return {
    projectId: workspaceId,
    worktreeId,
    chatId,
    data: { type: 'codex', event },
  };
}

function readPersistedTabs(
  userDataDir,
  workspaceId = WORKSPACE_ID,
  worktreeId = WORKTREE_ID,
) {
  return readChatStorageTabs(
    path.join(userDataDir, 'workspaces', workspaceId),
    worktreeId,
  );
}

/** Count persisted blocks of `type` paired to `codex-<itemId>`. */
function countBlocks(file, itemId, type, chatId = CHAT_ID) {
  const tab = file.tabs.find((candidate) => candidate.id === chatId);
  if (!tab) return 0;
  let count = 0;
  for (const message of tab.messages ?? []) {
    for (const block of message.blocks ?? []) {
      if (block.type === type && block.toolUseId === `codex-${itemId}`) {
        count += 1;
      }
    }
  }
  return count;
}

async function openChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Inspect individual steps without changing the product's Recent default.
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(
    window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    ),
  ).toBeVisible();
  return window;
}

/**
 * Main settles a running turn with no live host whenever it reads the chat's
 * snapshot (the Activity rail, a tab switch), closing its open tool calls as
 * "Interrupted by app restart". A real provider turn holds the host queue
 * gate, so hold it for the injected one. Injected terminal events don't
 * release it; closing the app discards it.
 */
async function holdChatTurn(electronApp, target, turnUserMessageId) {
  await electronApp.evaluate(
    async (_, hold) => globalThis.__CANOPY_E2E_HOLD_CHAT_TURN__(hold),
    {
      projectId: target.workspaceId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      turnUserMessageId,
    },
  );
}

function cardByToolName(window, toolName) {
  return window.locator(
    `[data-testid="chat-tool-call"][data-tool-name="${toolName}"]`,
  );
}

function seedCoworkMcpChat(userDataDir) {
  const createdAt = '2026-07-30T12:00:00.000Z';
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    COWORK_WORKSPACE_ID,
  );
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_WORKSPACE_ID,
        name: 'MCP Cowork',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt, archiveRetentionDays: null },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { createdAt, archiveRetentionDays: null },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt }],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: COWORK_WORKSPACE_ID,
    worktreeId: COWORK_ENTRY_ID,
    providerType: 'codex',
    activeTabId: COWORK_CHAT_ID,
    tabs: [
      {
        id: COWORK_CHAT_ID,
        title: 'Cowork Codex MCP',
        providerType: 'codex',
        messages: [
          {
            id: 'cowork-mcp-user-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Check the fixture logs.' }],
            timestamp: Date.parse(createdAt),
          },
        ],
      },
    ],
  });
}

test('Codex MCP calls render as tool cards in a Cowork project chat', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-codex-mcp-render-'),
  );
  seedCoworkMcpChat(userDataDir);

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Inspect individual steps without changing the product's Recent default.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openChatPage();

    const workspaceToggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
    );
    await expect(workspaceToggle).toBeVisible();
    if ((await workspaceToggle.getAttribute('aria-expanded')) !== 'true') {
      await workspaceToggle.click();
    }
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(
      window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COWORK_CHAT_ID}"]`,
      ),
    ).toBeVisible();

    const target = {
      workspaceId: COWORK_WORKSPACE_ID,
      worktreeId: COWORK_ENTRY_ID,
      chatId: COWORK_CHAT_ID,
    };
    await holdChatTurn(launched.electronApp, target, 'cowork-mcp-turn');
    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'thread.started',
          thread_id: 'cowork-mcp-thread',
        },
        target,
      ),
    );
    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'turn.started',
          thread_id: 'cowork-mcp-thread',
          turn_id: 'cowork-mcp-turn',
        },
        target,
      ),
    );
    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'item.started',
          thread_id: 'cowork-mcp-thread',
          turn_id: 'cowork-mcp-turn',
          item: {
            type: 'mcp_tool_call',
            id: 'cowork-mcp-call',
            server: MCP_SERVER,
            tool: SUCCESS_TOOL,
            status: 'inProgress',
            arguments: { filter: 'severity>=ERROR' },
            result: null,
            error: null,
          },
        },
        target,
      ),
    );

    const card = cardByToolName(window, SUCCESS_TOOL_NAME);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-tool-status', 'pending');
    await expect(card).toContainText('Internal Hub Prod');
    await expect(card).toContainText('Query Gcp Logs');

    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'item.completed',
          thread_id: 'cowork-mcp-thread',
          turn_id: 'cowork-mcp-turn',
          item: {
            type: 'mcp_tool_call',
            id: 'cowork-mcp-call',
            server: MCP_SERVER,
            tool: SUCCESS_TOOL,
            status: 'completed',
            arguments: { filter: 'severity>=ERROR' },
            result: {
              content: [{ type: 'text', text: SUCCESS_RESULT_TEXT }],
            },
            error: null,
          },
        },
        target,
      ),
    );
    await expect(card).toHaveAttribute('data-tool-status', 'success');
    await card.getByRole('button').click();
    await expect(card).toContainText(SUCCESS_RESULT_TEXT);

    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'item.completed',
          thread_id: 'cowork-mcp-thread',
          turn_id: 'cowork-mcp-turn',
          item: {
            type: 'dynamic_tool_call',
            id: 'cowork-immediate-turn-restart',
            namespace: null,
            tool: IMMEDIATE_RESTART_TOOL_NAME,
            arguments: {},
            status: 'completed',
            content_items: [],
            success: true,
          },
        },
        target,
      ),
    );
    const restartCard = cardByToolName(window, IMMEDIATE_RESTART_TOOL_NAME);
    await expect(restartCard).toBeVisible();
    await expect(restartCard).toHaveAttribute('data-tool-status', 'success');
    await expect(restartCard.getByRole('button')).toHaveAttribute(
      'data-step-row',
      '',
    );
    await expect(restartCard).toContainText('Refresh and resume');
    await expect(
      restartCard
        .getByRole('button')
        .locator(':scope > span[aria-hidden="true"]')
        .first()
        .locator('svg'),
    ).toHaveCount(1);

    await injectChatEvent(
      launched.electronApp,
      codexEvent(
        {
          type: 'turn.completed',
          thread_id: 'cowork-mcp-thread',
          turn_id: 'cowork-mcp-turn',
        },
        target,
      ),
    );
    // Cowork keeps the completed tool cards inline instead of collapsing them
    // behind a family chip. Verify the card itself survives turn completion.
    await expect(restartCard).toBeVisible();
    await expect(restartCard).toHaveAttribute('data-tool-status', 'success');
    await expect
      .poll(
        () => {
          try {
            const file = readPersistedTabs(
              userDataDir,
              COWORK_WORKSPACE_ID,
              COWORK_ENTRY_ID,
            );
            return {
              uses: countBlocks(
                file,
                'cowork-mcp-call',
                'tool_use',
                COWORK_CHAT_ID,
              ),
              results: countBlocks(
                file,
                'cowork-mcp-call',
                'tool_result',
                COWORK_CHAT_ID,
              ),
            };
          } catch {
            return null;
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({ uses: 1, results: 1 });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('Codex MCP calls render lifecycle-accurate tool cards that persist across relaunch', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-mcp-render-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Codex MCP render',
        providerType: 'codex',
        messages: [],
      },
      {
        id: SECOND_CHAT_ID,
        title: 'Second chat',
        providerType: 'codex',
        messages: [],
      },
    ],
  });

  try {
    const firstLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await openChat(firstLaunch.electronApp);

      await holdChatTurn(
        firstLaunch.electronApp,
        { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
        TURN_ID,
      );
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({ type: 'thread.started', thread_id: THREAD_ID }),
      );
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'turn.started',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
        }),
      );
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'item.started',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-success',
            server: MCP_SERVER,
            tool: SUCCESS_TOOL,
            status: 'inProgress',
            arguments: { filter: 'operationId="fixture-operation"' },
            result: null,
            error: null,
          },
        }),
      );

      // Pending card: visible, canonical name, pending status, friendly
      // label without the opaque proxy identifiers, collapsed, spinner shown.
      const successCard = cardByToolName(window, SUCCESS_TOOL_NAME);
      await expect(successCard).toBeVisible();
      await expect(successCard).toHaveAttribute('data-tool-status', 'pending');
      await expect(successCard).toContainText('Internal Hub Prod');
      await expect(successCard).toContainText('Query Gcp Logs');
      await expect(successCard).not.toContainText('appproxy');
      await expect(successCard).not.toContainText('opaque');
      await expect(successCard.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(successCard).not.toContainText('operationId');
      await expect(
        successCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
      ).toBeVisible();

      // `item.updated` must not duplicate the card or complete it.
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'item.updated',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-success',
            server: MCP_SERVER,
            tool: SUCCESS_TOOL,
            status: 'inProgress',
            arguments: { filter: 'operationId="fixture-operation"' },
            result: null,
            error: null,
          },
        }),
      );
      await expect(successCard).toHaveCount(1);
      await expect(successCard).toHaveAttribute('data-tool-status', 'pending');

      // A second pending item with a different ID renders a second,
      // separately addressable card in first-appearance order.
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'item.started',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-failure',
            server: MCP_SERVER,
            tool: FAILURE_TOOL,
            status: 'inProgress',
            arguments: { workload: 'ingest-primary' },
            result: null,
            error: null,
          },
        }),
      );
      const failureCard = cardByToolName(window, FAILURE_TOOL_NAME);
      await expect(failureCard).toBeVisible();
      const allCards = window.locator('[data-testid="chat-tool-call"]');
      await expect(allCards).toHaveCount(2);
      await expect(allCards.nth(0)).toHaveAttribute(
        'data-tool-name',
        SUCCESS_TOOL_NAME,
      );
      await expect(allCards.nth(1)).toHaveAttribute(
        'data-tool-name',
        FAILURE_TOOL_NAME,
      );

      // Pending cards survive tab navigation without being duplicated when
      // their chat becomes active again.
      await window
        .getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`)
        .click();
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`),
      ).toHaveAttribute('aria-selected', 'true');
      await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(successCard).toHaveCount(1);
      await expect(failureCard).toHaveCount(1);
      await expect(allCards).toHaveCount(2);
      await expect(successCard).toHaveAttribute('data-tool-status', 'pending');
      await expect(failureCard).toHaveAttribute('data-tool-status', 'pending');

      // Complete the first successfully (short text + structured sentinel
      // that must not be duplicated into the rendered output) and fail the
      // second with a transport-level error message.
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'item.completed',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-success',
            server: MCP_SERVER,
            tool: SUCCESS_TOOL,
            status: 'completed',
            arguments: { filter: 'operationId="fixture-operation"' },
            result: {
              content: [{ type: 'text', text: SUCCESS_RESULT_TEXT }],
              structuredContent: { rows: [STRUCTURED_SENTINEL] },
            },
            error: null,
          },
        }),
      );
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'item.completed',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-failure',
            server: MCP_SERVER,
            tool: FAILURE_TOOL,
            status: 'failed',
            arguments: { workload: 'ingest-primary' },
            result: null,
            error: { message: FAILURE_MESSAGE },
          },
        }),
      );

      await expect(successCard).toHaveAttribute('data-tool-status', 'success');
      await expect(failureCard).toHaveAttribute('data-tool-status', 'error');
      await expect(successCard).toHaveCount(1);
      await expect(failureCard).toHaveCount(1);
      await expect(allCards).toHaveCount(2);
      await expect(
        successCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
      ).toHaveCount(0);
      await expect(
        failureCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
      ).toHaveCount(0);

      // Success expansion: serialized input, "Result" heading, text result,
      // and no structured-content duplicate.
      await successCard.getByRole('button').click();
      await expect(successCard.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(successCard).toContainText(
        'filter: operationId="fixture-operation"',
      );
      await expect(successCard).toContainText(SUCCESS_RESULT_TEXT);
      await expect(successCard).not.toContainText(STRUCTURED_SENTINEL);
      await successCard.getByRole('button').click();
      await expect(successCard.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(successCard).not.toContainText(SUCCESS_RESULT_TEXT);

      // Failure expansion preserves the transport error message.
      await failureCard.getByRole('button').click();
      await expect(failureCard.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(failureCard).toContainText(FAILURE_MESSAGE);

      // Terminal persistence: exactly one paired tool_use/tool_result per
      // item in the worktree chat JSON.
      await injectChatEvent(
        firstLaunch.electronApp,
        codexEvent({
          type: 'turn.completed',
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
        }),
      );
      await expect
        .poll(
          () => {
            try {
              const file = readPersistedTabs(userDataDir);
              return {
                successUse: countBlocks(file, 'mcp-success', 'tool_use'),
                successResult: countBlocks(file, 'mcp-success', 'tool_result'),
                failureUse: countBlocks(file, 'mcp-failure', 'tool_use'),
                failureResult: countBlocks(file, 'mcp-failure', 'tool_result'),
              };
            } catch {
              return null;
            }
          },
          { timeout: 30_000 },
        )
        .toEqual({
          successUse: 1,
          successResult: 1,
          failureUse: 1,
          failureResult: 1,
        });
    } finally {
      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    // Relaunch against the same user-data directory: terminal cards restore
    // with their statuses, labels, and expansion behavior intact.
    const secondLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await openChat(secondLaunch.electronApp);

      const successCard = cardByToolName(window, SUCCESS_TOOL_NAME);
      const failureCard = cardByToolName(window, FAILURE_TOOL_NAME);
      await expect(successCard).toBeVisible();
      await expect(failureCard).toBeVisible();
      await expect(successCard).toHaveAttribute('data-tool-status', 'success');
      await expect(failureCard).toHaveAttribute('data-tool-status', 'error');
      await expect(successCard).toContainText('Internal Hub Prod');
      await expect(successCard).toContainText('Query Gcp Logs');
      await expect(failureCard).toContainText('Restart Ingest Workload');
      await expect(
        window.locator('[data-testid="chat-tool-call"]'),
      ).toHaveCount(2);

      await successCard.getByRole('button').click();
      await expect(successCard).toContainText(SUCCESS_RESULT_TEXT);
      await expect(successCard).not.toContainText(STRUCTURED_SENTINEL);

      await failureCard.getByRole('button').click();
      await expect(failureCard).toContainText(FAILURE_MESSAGE);
    } finally {
      await closeCanopy(secondLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }
  } finally {
    for (const target of [userDataDir, `${userDataDir}-secure`]) {
      try {
        rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch {
        // Best-effort cleanup; the OS temp directory stays isolated if a
        // transient handle blocks removal.
      }
    }
  }
});
