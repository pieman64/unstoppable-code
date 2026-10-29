import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Agent Ledger phases 05 and 06 — Ledger tool-call rendering in the real
// desktop chat, for every surface that records Ledger calls.
//
// Each seeded chat tab holds a completed turn whose hidden steps are the three
// Ledger tools (AddFeedEntry, SearchFeedEntries, UpdateFeedEntry) under
// the raw names that surface persists, followed by a final reply and a
// completed turn timer:
//
// - Claude and Codex worktree tabs: `mcp__canopy__AddFeedEntry`,
//   `canopy_add_feed_entry`, and so on.
// - A Cursor worktree tab, exactly as the Cursor event projection persists an
//   app MCP call: the CLI title (`canopy: AddFeedEntry`, the registry's
//   `cursorToolName`) with the raw ACP input, plus the display projection
//   beside them (the Claude name and the unwrapped arguments) that the
//   renderer shows. The result is the `rawOutput` the Cursor ACP fixture sends
//   for a completed MCP call.
// - Claude and Codex tabs of an App Advisor Work Entry, opened in the App
//   Advisor window: `mcp__canopy_app_advisor__AddFeedEntry`,
//   `canopy_app_advisor_add_feed_entry`, and so on.
//
// The worktree chat uses the same two-phase seeding as
// local-memory-tool-rendering.spec.mjs: `seedDemoWorkspaces` materializes
// `demo-ts-pnpm-vite`/`demo-main`, then `seedWorktreeChat` writes the legacy
// chat file the app migrates on launch. The App Advisor chat is the same
// legacy shape under `app-workspaces/app-advisor/`.
//
// For each tab the spec asserts the collapsed turn summary (turn-utils folds
// the three calls into the generic `canopy` bucket, which the summary shows as
// one "app" chip: "Agent steps: 3 app"; in App Advisor too, where App
// Advisor's own tools count in its "app advisor" chip instead), expands the
// turn, and checks every tool card: `data-tool-name`,
// `data-tool-status="success"`, the `canopy` family on the toggle, the exact
// label behind the `chat-tool-call-*-ledger-*-label` test ids, and the paired
// result. Every tab shares one label and family expectation set, which proves
// the renderer folds each surface's raw names into the same UX. Deterministic
// — no live agents, no network. Rendering a persisted call does not depend on
// `canopy-ledger-enabled`, so the E2E default (off) is kept.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CLAUDE_TAB_ID = 'ledger-tools-claude';
const CODEX_TAB_ID = 'ledger-tools-codex';
const CURSOR_TAB_ID = 'ledger-tools-cursor';
const ADVISOR_ENTRY_ID = 'ledger-tools-advisor';
const ADVISOR_CLAUDE_TAB_ID = 'ledger-tools-advisor-claude';
const ADVISOR_CODEX_TAB_ID = 'ledger-tools-advisor-codex';
const CLAUDE_TOOL_NAMES = {
  add: 'mcp__canopy__AddFeedEntry',
  search: 'mcp__canopy__SearchFeedEntries',
  update: 'mcp__canopy__UpdateFeedEntry',
};
const CODEX_TOOL_NAMES = {
  add: 'canopy_add_feed_entry',
  search: 'canopy_search_feed_entries',
  update: 'canopy_update_feed_entry',
};
// The Cursor CLI titles an MCP call "<server>: <tool>".
const CURSOR_TOOL_TITLES = {
  add: 'canopy: AddFeedEntry',
  search: 'canopy: SearchFeedEntries',
  update: 'canopy: UpdateFeedEntry',
};
const ADVISOR_CLAUDE_TOOL_NAMES = {
  add: 'mcp__canopy_app_advisor__AddFeedEntry',
  search: 'mcp__canopy_app_advisor__SearchFeedEntries',
  update: 'mcp__canopy_app_advisor__UpdateFeedEntry',
};
const ADVISOR_CODEX_TOOL_NAMES = {
  add: 'canopy_app_advisor_add_feed_entry',
  search: 'canopy_app_advisor_search_feed_entries',
  update: 'canopy_app_advisor_update_feed_entry',
};
const LEDGER_TIMESTAMP = Date.parse('2026-09-29T12:00:00.000Z');
const ENTRY_ID = '8d0c7a52-4b1e-4f3a-9c6d-2e7b5a1f0c93';
const SELF_ACTOR_ID = '5b9e2f47-8a3c-4d1e-b6f2-7c0a9d4e3b18';
const ENTRY_TITLE = 'Fix the checkout retry loop';
const ENTRY_CONTENT = 'Checkout retries forever after a declined card.';
const SEARCH_QUERY = 'checkout retry';
const USER_PROMPT = 'Track the checkout retry fix in the Ledger and start it.';
const FINAL_REPLY =
  'Recorded the checkout retry fix as a Ledger task and marked it in progress.';
// Accessible name of the collapsed turn summary: every Ledger call counts as
// one `canopy` step, rendered as the "app" chip.
const COLLAPSED_SUMMARY_NAME = 'Agent steps: 3 app';

// Tool arguments match the protocol tool-input schemas; results are the
// bounded JSON `ledger-tools-runtime.ts` returns (entry projections, no
// provenance).
const LEDGER_ARGS = {
  add: { type: 'TASK', title: ENTRY_TITLE, content: ENTRY_CONTENT },
  search: {
    query: SEARCH_QUERY,
    owner: 'self',
    statuses: ['TODO', 'IN_PROGRESS'],
  },
  update: {
    entryId: ENTRY_ID,
    expectedRevision: 1,
    status: 'IN_PROGRESS',
    owner: 'self',
  },
};
const SELF_OWNER = { actorId: SELF_ACTOR_ID, kind: 'chat', isSelf: true };
const LEDGER_OUTPUTS = {
  add: JSON.stringify({
    ok: true,
    changed: true,
    entry: {
      entryId: ENTRY_ID,
      revision: 1,
      type: 'TASK',
      status: 'TODO',
      title: ENTRY_TITLE,
      owner: SELF_OWNER,
      updatedAt: '2026-09-29T12:00:02.000Z',
    },
  }),
  search: JSON.stringify({
    entries: [
      {
        entryId: ENTRY_ID,
        revision: 1,
        type: 'TASK',
        status: 'TODO',
        title: ENTRY_TITLE,
        content: ENTRY_CONTENT,
        owner: SELF_OWNER,
        author: SELF_OWNER,
        attribution: 'self_reported',
        createdAt: '2026-09-29T12:00:02.000Z',
        updatedAt: '2026-09-29T12:00:02.000Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
    watermark: '1',
  }),
  update: JSON.stringify({
    ok: true,
    changed: true,
    entry: {
      entryId: ENTRY_ID,
      revision: 2,
      type: 'TASK',
      status: 'IN_PROGRESS',
      title: ENTRY_TITLE,
      owner: SELF_OWNER,
      updatedAt: '2026-09-29T12:00:06.000Z',
    },
  }),
};
// What the Cursor projection persists for a completed MCP call: the fixture
// CLI's `rawOutput`, the same for all three calls.
const CURSOR_OUTPUT = JSON.stringify({ success: true });
const CURSOR_OUTPUTS = {
  add: CURSOR_OUTPUT,
  search: CURSOR_OUTPUT,
  update: CURSOR_OUTPUT,
};
const LEDGER_TOOLS = ['add', 'search', 'update'];

function toolCall(toolUseId, toolName, input, output) {
  return [
    { type: 'tool_use', toolUseId, toolName, input },
    { type: 'tool_result', toolUseId, toolName, output, isError: false },
  ];
}

/** The three Ledger calls under a provider's own raw names. */
function ledgerToolCalls(prefix, toolNames) {
  return LEDGER_TOOLS.flatMap((tool) =>
    toolCall(
      `${prefix}-${tool}`,
      toolNames[tool],
      JSON.stringify(LEDGER_ARGS[tool]),
      LEDGER_OUTPUTS[tool],
    ),
  );
}

/**
 * The three Ledger calls as the Cursor event projection persists them: the CLI
 * title and raw ACP input stay provider-accurate, and `display` carries the
 * canonical name and unwrapped arguments for the renderer.
 */
function cursorLedgerToolCalls(prefix) {
  return LEDGER_TOOLS.flatMap((tool) => {
    const toolUseId = `${prefix}-${tool}`;
    const title = CURSOR_TOOL_TITLES[tool];
    const [server, toolName] = title.split(': ');
    return [
      {
        type: 'tool_use',
        toolUseId,
        toolName: title,
        input: JSON.stringify({
          providerIdentifier: server,
          toolName,
          args: LEDGER_ARGS[tool],
        }),
        display: {
          toolName: CLAUDE_TOOL_NAMES[tool],
          input: JSON.stringify(LEDGER_ARGS[tool]),
        },
      },
      {
        type: 'tool_result',
        toolUseId,
        toolName: title,
        output: CURSOR_OUTPUTS[tool],
        isError: false,
      },
    ];
  });
}

function ledgerTurnMessages(prefix, toolBlocks) {
  return [
    {
      id: `${prefix}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: USER_PROMPT }],
      timestamp: LEDGER_TIMESTAMP,
    },
    {
      // No text in this message, so the turn keeps it among the hidden steps
      // and the collapsed summary counts its three tool calls.
      id: `${prefix}-ledger-tools`,
      role: 'assistant',
      blocks: toolBlocks,
      timestamp: LEDGER_TIMESTAMP + 10_000,
    },
    {
      id: `${prefix}-final`,
      role: 'assistant',
      blocks: [{ type: 'text', text: FINAL_REPLY }],
      timestamp: LEDGER_TIMESTAMP + 20_000,
    },
    {
      id: `${prefix}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: LEDGER_TIMESTAMP,
          completedAt: LEDGER_TIMESTAMP + 30_000,
        },
      ],
      timestamp: LEDGER_TIMESTAMP + 30_000,
    },
  ];
}

function seedLedgerToolChats(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CLAUDE_TAB_ID,
    tabs: [
      {
        id: CLAUDE_TAB_ID,
        title: 'Ledger tools (Claude)',
        providerType: 'claude',
        messages: ledgerTurnMessages(
          'claude',
          ledgerToolCalls('claude', CLAUDE_TOOL_NAMES),
        ),
      },
      {
        id: CODEX_TAB_ID,
        title: 'Ledger tools (Codex)',
        providerType: 'codex',
        messages: ledgerTurnMessages(
          'codex',
          ledgerToolCalls('codex', CODEX_TOOL_NAMES),
        ),
      },
      {
        id: CURSOR_TAB_ID,
        title: 'Ledger tools (Cursor)',
        providerType: 'cursor',
        messages: ledgerTurnMessages('cursor', cursorLedgerToolCalls('cursor')),
      },
    ],
  });
}

function seedAppAdvisorLedgerChats(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const createdAt = new Date(LEDGER_TIMESTAMP).toISOString();
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ADVISOR_ENTRY_ID, createdAt, title: 'Ledger tools' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ADVISOR_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: ADVISOR_CLAUDE_TAB_ID,
    tabs: [
      {
        id: ADVISOR_CLAUDE_TAB_ID,
        title: 'Ledger tools (App Advisor, Claude)',
        createdAt,
        providerType: 'claude',
        messages: ledgerTurnMessages(
          'advisor-claude',
          ledgerToolCalls('advisor-claude', ADVISOR_CLAUDE_TOOL_NAMES),
        ),
      },
      {
        id: ADVISOR_CODEX_TAB_ID,
        title: 'Ledger tools (App Advisor, Codex)',
        createdAt,
        providerType: 'codex',
        messages: ledgerTurnMessages(
          'advisor-codex',
          ledgerToolCalls('advisor-codex', ADVISOR_CODEX_TOOL_NAMES),
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

async function openChatTab(window, chatId) {
  await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  const panel = chatPanel(window, chatId);
  await expect(panel).toBeVisible();
  return panel;
}

function toolCard(panel, toolName) {
  return panel.locator(
    `[data-testid="chat-tool-call"][data-tool-name="${toolName}"]`,
  );
}

/**
 * `toolNames` are the names the cards render under (a tab's raw names, or
 * Cursor's display projection) and `outputs` the results they pair with.
 */
async function assertLedgerTurn(
  panel,
  { toolNames, outputs = LEDGER_OUTPUTS },
) {
  await expect(panel.getByText(FINAL_REPLY)).toBeVisible();

  // A completed turn opens collapsed: the Ledger calls sit behind the sticky
  // turn summary, which counts them in the single "app" chip.
  const summary = panel
    .getByTestId('sticky-turn-summary')
    .getByRole('button', { name: COLLAPSED_SUMMARY_NAME, exact: true });
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary.locator('span[title="app"]')).toContainText('3');
  const toolCards = panel.getByTestId('chat-tool-call');
  await expect(toolCards).toHaveCount(0);

  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(toolCards).toHaveCount(3);

  for (const [index, tool] of LEDGER_TOOLS.entries()) {
    await expect(toolCards.nth(index)).toHaveAttribute(
      'data-tool-name',
      toolNames[tool],
    );
    const card = toolCard(panel, toolNames[tool]);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-tool-status', 'success');
    await expect(
      card.locator('button[data-tool-family="canopy"]'),
    ).toBeVisible();
  }

  await expect(
    toolCard(panel, toolNames.add).getByTestId(
      'chat-tool-call-add-ledger-entry-label',
    ),
  ).toHaveText(`Add Feed entry ${ENTRY_TITLE}`);
  await expect(
    toolCard(panel, toolNames.search).getByTestId(
      'chat-tool-call-search-ledger-entries-label',
    ),
  ).toHaveText(`Search Feed ${SEARCH_QUERY}`);
  // The owner snippet is set off from the status chunk by a margin rather
  // than a text space, so the label's text has no space before "owner".
  await expect(
    toolCard(panel, toolNames.update).getByTestId(
      'chat-tool-call-update-ledger-entry-label',
    ),
  ).toHaveText(/^Update Feed entry IN_PROGRESS\s*owner self$/);

  for (const tool of LEDGER_TOOLS) {
    const card = toolCard(panel, toolNames[tool]);
    const result = card.getByText(outputs[tool]);
    await expect(result).toBeHidden();
    await card.getByRole('button').first().click();
    await expect(result).toBeVisible();
    await expect(card).toContainText('Result');
    await card.getByRole('button').first().click();
    await expect(result).toBeHidden();
  }

  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(toolCards).toHaveCount(0);
}

test('renders Ledger tool calls and the collapsed turn summary for Claude, Codex and Cursor', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'ledger-tool-display-'),
  );
  seedLedgerToolChats(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const claudePanel = chatPanel(window, CLAUDE_TAB_ID);
    await expect(claudePanel).toBeVisible();
    await assertLedgerTurn(claudePanel, { toolNames: CLAUDE_TOOL_NAMES });

    await assertLedgerTurn(await openChatTab(window, CODEX_TAB_ID), {
      toolNames: CODEX_TOOL_NAMES,
    });

    // The renderer shows Cursor's display projection, so the cards carry the
    // Claude names while the persisted blocks keep the CLI titles.
    await assertLedgerTurn(await openChatTab(window, CURSOR_TAB_ID), {
      toolNames: CLAUDE_TOOL_NAMES,
      outputs: CURSOR_OUTPUTS,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders App Advisor Ledger tool calls like the worktree Ledger tool calls', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'ledger-tool-display-advisor-'),
  );
  seedAppAdvisorLedgerChats(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await app.openAppAdvisorWindow(electronApp);

    const claudePanel = chatPanel(advisor, ADVISOR_CLAUDE_TAB_ID);
    await expect(claudePanel).toBeVisible();
    await assertLedgerTurn(claudePanel, {
      toolNames: ADVISOR_CLAUDE_TOOL_NAMES,
    });

    await assertLedgerTurn(await openChatTab(advisor, ADVISOR_CODEX_TAB_ID), {
      toolNames: ADVISOR_CODEX_TOOL_NAMES,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
