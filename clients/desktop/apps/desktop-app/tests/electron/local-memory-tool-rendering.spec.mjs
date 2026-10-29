import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// CAN-2748 — ReadMemory tool-call rendering in the real desktop chat.
//
// Seeds a persisted worktree chat transcript containing a completed
// `mcp__canopy__ReadMemory` tool_use/tool_result pair (the same two-phase
// seeding as ask-user-question.spec.mjs: `seedDemoWorkspaces` materializes
// `demo-ts-pnpm-vite`/`demo-main`, then `seedWorktreeChat` overwrites the
// chat file), launches the app, opens the worktree, and asserts the rendered
// tool row: the `chat-tool-call-read-memory-label` test id, the scope in the
// label, and the file key chunk. Deterministic — no live agents, no network.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'read-memory-render';
const READ_FILE_KEY = 'topics/service-history.md';
const CLAUDE_MEMORY_TAB_ID = 'memory-tools-claude';
const CODEX_MEMORY_TAB_ID = 'memory-tools-codex';
const CLAUDE_SAVE_TOOL_NAME = 'mcp__canopy__SaveMemory';
const CLAUDE_SEARCH_TOOL_NAME = 'mcp__canopy__SearchMemory';
const CODEX_SAVE_TOOL_NAME = 'canopy_save_memory';
const CODEX_SEARCH_TOOL_NAME = 'canopy_search_memory';
const SAVE_OUTPUT = 'Saved to user memory.';
const SEARCH_OUTPUT = '1 match: Prefers pnpm for JavaScript package management';
const MEMORY_TIMESTAMP = Date.parse('2026-08-05T12:00:00.000Z');

function seedReadMemoryChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'ReadMemory Rendering',
        providerType: 'claude',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            blocks: [
              { type: 'text', text: 'What is the current service port?' },
            ],
            timestamp: Date.parse('2026-09-02T12:00:00.000Z'),
          },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'read-memory-1',
                toolName: 'mcp__canopy__ReadMemory',
                input: JSON.stringify({
                  scope: 'workspace',
                  file: READ_FILE_KEY,
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'read-memory-1',
                toolName: 'mcp__canopy__ReadMemory',
                output: '# Service history\nThe current port is 4713.',
                isError: false,
              },
              {
                type: 'text',
                text: 'The current service port is 4713.',
              },
            ],
            timestamp: Date.parse('2026-09-02T12:01:00.000Z'),
          },
        ],
      },
    ],
  });
}

function memoryToolMessages(saveToolName, searchToolName) {
  return [
    {
      id: `memory-user-${saveToolName}`,
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Remember my package manager choice, then search for it.',
        },
      ],
      timestamp: MEMORY_TIMESTAMP,
    },
    {
      id: `memory-assistant-${saveToolName}`,
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: 'Saving the preference and searching existing memory.',
        },
        {
          type: 'tool_use',
          toolUseId: `save-${saveToolName}`,
          toolName: saveToolName,
          input: JSON.stringify({
            text: 'Prefers pnpm for JavaScript package management',
            scope: 'user',
          }),
        },
        {
          type: 'tool_result',
          toolUseId: `save-${saveToolName}`,
          toolName: saveToolName,
          output: SAVE_OUTPUT,
          isError: false,
        },
        {
          type: 'tool_use',
          toolUseId: `search-${searchToolName}`,
          toolName: searchToolName,
          input: JSON.stringify({ query: 'package manager' }),
        },
        {
          type: 'tool_result',
          toolUseId: `search-${searchToolName}`,
          toolName: searchToolName,
          output: SEARCH_OUTPUT,
          isError: false,
        },
      ],
      timestamp: MEMORY_TIMESTAMP + 10_000,
    },
    {
      id: `memory-timer-${saveToolName}`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: MEMORY_TIMESTAMP,
          completedAt: MEMORY_TIMESTAMP + 30_000,
        },
      ],
      timestamp: MEMORY_TIMESTAMP + 20_000,
    },
  ];
}

function seedSaveAndSearchMemoryChats(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CLAUDE_MEMORY_TAB_ID,
    tabs: [
      {
        id: CLAUDE_MEMORY_TAB_ID,
        title: 'Memory tools (Claude)',
        providerType: 'claude',
        messages: memoryToolMessages(
          CLAUDE_SAVE_TOOL_NAME,
          CLAUDE_SEARCH_TOOL_NAME,
        ),
      },
      {
        id: CODEX_MEMORY_TAB_ID,
        title: 'Memory tools (Codex)',
        providerType: 'codex',
        messages: memoryToolMessages(
          CODEX_SAVE_TOOL_NAME,
          CODEX_SEARCH_TOOL_NAME,
        ),
      },
    ],
  });
}

function chatPanel(window, chatId) {
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

async function assertMemoryToolCards(panel, saveToolName, searchToolName) {
  const saveCard = panel.locator(
    `[data-testid="chat-tool-call"][data-tool-name="${saveToolName}"]`,
  );
  const searchCard = panel.locator(
    `[data-testid="chat-tool-call"][data-tool-name="${searchToolName}"]`,
  );
  await expect(saveCard).toHaveCount(1);
  await expect(searchCard).toHaveCount(1);
  await expect(saveCard).toHaveAttribute('data-tool-status', 'success');
  await expect(searchCard).toHaveAttribute('data-tool-status', 'success');
  await expect(
    saveCard.locator('button[data-tool-family="canopy"]'),
  ).toBeVisible();
  await expect(
    searchCard.locator('button[data-tool-family="canopy"]'),
  ).toBeVisible();
  await expect(
    saveCard.getByTestId('chat-tool-call-save-memory-label'),
  ).toHaveText('Save user memory');
  await expect(
    searchCard.getByTestId('chat-tool-call-search-memory-label'),
  ).toHaveText('Search memory package manager');

  const saveResult = saveCard.getByText(SAVE_OUTPUT);
  await expect(saveResult).toBeHidden();
  await saveCard.getByRole('button').first().click();
  await expect(saveResult).toBeVisible();
  await expect(saveCard).toContainText('Result');
  await saveCard.getByRole('button').first().click();
  await expect(saveResult).toBeHidden();

  const searchResult = searchCard.getByText(SEARCH_OUTPUT);
  await expect(searchResult).toBeHidden();
  await searchCard.getByRole('button').first().click();
  await expect(searchResult).toBeVisible();
  await searchCard.getByRole('button').first().click();
  await expect(searchResult).toBeHidden();
}

test('renders a completed ReadMemory tool call with scope and file key', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'read-memory-render-'),
  );
  seedReadMemoryChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    const label = window.getByTestId('chat-tool-call-read-memory-label');
    await expect(label).toHaveCount(1);
    await expect(label).toContainText('Read workspace memory');
    await expect(label).toContainText(READ_FILE_KEY);
    await expect(
      window.getByText('The current service port is 4713.'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders successful SaveMemory and SearchMemory cards for Claude and Codex', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'save-search-memory-render-'),
  );
  seedSaveAndSearchMemoryChats(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const claudePanel = chatPanel(window, CLAUDE_MEMORY_TAB_ID);
    await expect(claudePanel).toBeVisible();
    await assertMemoryToolCards(
      claudePanel,
      CLAUDE_SAVE_TOOL_NAME,
      CLAUDE_SEARCH_TOOL_NAME,
    );

    await window
      .getByTestId(`panel-tab-panel-chat-${CODEX_MEMORY_TAB_ID}`)
      .click();
    const codexPanel = chatPanel(window, CODEX_MEMORY_TAB_ID);
    await expect(codexPanel).toBeVisible();
    await assertMemoryToolCards(
      codexPanel,
      CODEX_SAVE_TOOL_NAME,
      CODEX_SEARCH_TOOL_NAME,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
