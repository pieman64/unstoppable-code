import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Doc 2 Spec 14 — Chat transcript actions: fork/branch affordances,
// Codex file-change delete icon, and composer model resolution.
// PRs 743 / 752 / 807.
//
// Two-phase seeding (worktree chat):
//   1. `seedDemoWorkspaces({ apps: ['ts-pnpm-vite'] })` materializes the demo
//      workspace `demo-ts-pnpm-vite` with a default `demo-main` worktree.
//   2. A hand-written `preferences.json` (onboarding complete + worktree model
//      defaults) so the composer's ModelPicker resolves a worktree default
//      (chatStore.loadModelDefaults reads `defaultWorktreeProvider` /
//      `defaultWorktreeModelByProvider` from preferences).
//   3. `seedWorktreeChat(...)` writes a transcript with multiple turn groups
//      (one completed + forkable) plus a Codex `file_change` delete tool call.
//
// Then `launchCanopy({ userDataDir })`, `openMainPage()`,
// `selectWorktree('demo-main')`, assert the chat panel content (`panel-content-chat`).
//
// Rendering model (verified against the renderer):
//
//  - Turn grouping (`groupIntoTurns`, turn-utils.ts): a turn group is
//    `user → assistant(s) → system message whose single block is a completed
//    turn_timer`. A group with a completed timer (`completedAt !== null`) is
//    `isComplete`. `findLastForkableTurnGroupIndex`
//    (incremental-turn-groups.ts) returns the LAST complete group that has
//    forkable assistant content (any block that is not a turn_timer and not a
//    task-management tool).
//
//  - Fork/Branch (PR 743/752): `TurnGroupRenderer` passes the completed
//    timer's TurnTimer `showForkAction` only on that last forkable group, and
//    `showBranchAction` additionally requires a non-standalone worktree
//    (`canBranch`). The desktop `TurnTimer` (TurnTimer.tsx) renders the Fork
//    button with `aria-label="Fork Chat"` and the Branch button with
//    `aria-label="Branch Chat into new worktree"`. We seed two completed
//    forkable turns so the buttons appear on the PRIOR (last) forkable turn
//    and we can assert they persist after load.
//
//  - Codex delete icon (PR 807): a Codex `file_change` tool_use with input
//    `delete: <path>` renders, via `renderFileChange` in
//    `packages/ui-shared/.../tool-display.tsx`, the shared `TrashIcon` with
//    the `trash-2` glyph (not the document-pencil `square-pen` glyph).
//
//  - Composer model (ModelPicker.tsx): the seeded tab has no `model`, so
//    `ChatInput`'s `fallbackModel` resolves it from `modelDefaults`
//    (worktree default provider/model). The picker button (`chat-model-picker`)
//    exposes the resolved model name via its `aria-label`
//    (`Select model, current model <label>`); it is NOT "Project default".
//
// Determinism: no live agents, no network. Everything is static persisted JSON.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'seeded-transcript';
const CHAT_UNIT_LABEL = 'Chat';

const T = Date.parse('2026-04-10T12:00:00.000Z');

const MANAGED_IMAGE_ALT = 'Managed attachment preview';
const MANAGED_IMAGE_NAME = 'transcript-markdown-preview.png';
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8WcWQAAAABJRU5ErkJggg==';
const SEND_MESSAGE_INPUT = JSON.stringify({
  to: 'agent-reviewer-1',
  summary: 'Review transcript rendering',
  message: 'Please inspect the SendMessage transcript row.',
});
const FORK_CODEX_THREAD_CHANNEL = 'chat:fork-codex-thread';
const UPDATE_CHAT_PLUGINS_CHANNEL = 'chat:update-plugins';

// Build a `user → assistant → system(turn_timer completed)` triple for one turn
// group. `order` spaces timestamps so grouping stays deterministic and the
// assistant text never matches the user text within 1s (which would trip
// `isLikelyClaudeQueueEcho` and drop the assistant message).
function buildTurnGroup(order, assistantBlocks) {
  const base = T + order * 120_000;
  return [
    {
      id: `turn-${order}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Request number ${order}.` }],
      timestamp: base,
    },
    {
      id: `turn-${order}-assistant`,
      role: 'assistant',
      blocks: assistantBlocks,
      timestamp: base + 10_000,
    },
    {
      id: `turn-${order}-timer`,
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: base, completedAt: base + 30_000 },
      ],
      timestamp: base + 20_000,
    },
  ];
}

function buildActiveTurnGroup(order) {
  const base = T + order * 120_000;
  return [
    {
      id: `turn-${order}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Request number ${order}.` }],
      timestamp: base,
    },
    {
      id: `turn-${order}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: base,
          pausedAt: base + 30_000,
          completedAt: null,
        },
      ],
      timestamp: base + 1_000,
    },
  ];
}

function buildSeededChat(userDataDir) {
  const managedImagePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'attachments',
    WORKTREE_ID,
    MANAGED_IMAGE_NAME,
  );
  mkdirSync(path.dirname(managedImagePath), { recursive: true });
  writeFileSync(managedImagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

  const messages = [
    // Turn 1 — completed + forkable. Contains the Codex `file_change` delete
    // tool call so the delete (trash) icon is exercised inside a real turn.
    ...buildTurnGroup(1, [
      { type: 'text', text: 'Removing the obsolete module.' },
      {
        type: 'tool_use',
        toolUseId: 'codex-delete-1',
        toolName: 'file_change',
        input: 'delete: src/legacy/old-module.ts',
      },
      {
        type: 'tool_use',
        toolUseId: 'send-message-1',
        toolName: 'SendMessage',
        input: SEND_MESSAGE_INPUT,
      },
      {
        type: 'tool_result',
        toolUseId: 'send-message-1',
        toolName: 'SendMessage',
        output: 'Message delivered to agent-reviewer-1',
        isError: false,
      },
      {
        type: 'tool_use',
        toolUseId: 'computer-use-js-1',
        toolName: 'mcp__cua_repl__js',
        input: JSON.stringify({ code: 'await cua.getState();' }),
      },
      {
        type: 'tool_result',
        toolUseId: 'computer-use-js-1',
        toolName: 'mcp__cua_repl__js',
        output: 'Application state inspected.',
        isError: false,
      },
      {
        type: 'tool_use',
        toolUseId: 'computer-use-reset-1',
        toolName: 'mcp__cua_repl__js_reset',
        input: '{}',
      },
      {
        type: 'tool_result',
        toolUseId: 'computer-use-reset-1',
        toolName: 'mcp__cua_repl__js_reset',
        output: 'Persistent bindings reset.',
        isError: false,
      },
    ]),
    // Turn 2 — completed + forkable. This is the LAST forkable turn group, so
    // the Fork/Branch buttons render on its timer.
    ...buildTurnGroup(2, [
      {
        type: 'text',
        text: [
          '## Verification summary',
          '',
          'Verified the build passes after removal.',
          '',
          '- Existing transcript actions remain available',
          '- Markdown links remain interactive',
          '',
          '[Open documentation](https://example.com/transcript-docs)',
          '',
          `![${MANAGED_IMAGE_ALT}](${managedImagePath})`,
          '',
          '> Markdown-heavy transcript rendering keeps semantic structure.',
          '',
          '| Surface | Expected output |',
          '| --- | --- |',
          '| Desktop transcript | Semantic HTML |',
          '',
          '```ts',
          'const markdownProfile = "covered";',
          '```',
          '',
          'This retains **parser-backed formatting**.',
          '',
          '- [x] Markdown rendering covered',
        ].join('\n'),
      },
      {
        type: 'text',
        text: '    const parserBackedIndentedCode = true;',
      },
      {
        type: 'text',
        text: ' \tconst parserBackedMixedIndentOne = true;',
      },
      {
        type: 'text',
        text: '  \tconst parserBackedMixedIndentTwo = true;',
      },
      {
        type: 'text',
        text: '   \tconst parserBackedMixedIndentThree = true;',
      },
      {
        type: 'text',
        text: '---',
      },
    ]),
    // Turn 3 — active via a paused timer. The tab carries the active-turn
    // auto-archive marker so the transient toggle renders without a live
    // provider session.
    ...buildActiveTurnGroup(3),
  ];

  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Transcript Actions',
        providerType: 'codex',
        status: 'streaming',
        autoArchive: true,
        autoArchiveToggleVisible: true,
        usage: {
          contextTokens: 64_000,
          contextWindow: 200_000,
          maxOutputTokens: 0,
          totalCostUsd: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 1,
          model: 'gpt-6-sol',
        },
        // NOTE: intentionally no `model` — the composer resolves the worktree
        // default from `modelDefaults` (seeded via preferences below).
        messages,
      },
    ],
  });
}

// Hand-write `preferences.json` so the worktree model default resolves in the
// composer. `launchCanopy`'s `seedOnboardingCompleted` is a no-op when the file
// already exists, so we own the whole file here. The model fields are
// normalized by the main process on read (preferences-store.ts): unknown model
// ids fall back to the per-provider defaults, but `defaultWorktreeProvider`
// of `codex` is preserved, so the composer resolves the Codex worktree default
// (and the picker label is therefore never "Project default").
function seedPreferences(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function launchTranscriptCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-transcript-'));
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    buildSeededChat(userDataDir);
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

test('routes plugins and forks an Ollama-source chat through its captured Codex harness', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ollama-codex-fork-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'ollama',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Ollama on Codex',
        providerType: 'ollama',
        executionHarness: 'codex',
        model: 'ollama-qwen3-coder',
        sdkSessionId: 'thread-source',
        messages: buildTurnGroup(1, [
          { type: 'text', text: 'The Codex-harnessed task is complete.' },
        ]),
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    await electronApp.evaluate(
      ({ ipcMain }, { forkChannel, updatePluginsChannel }) => {
        ipcMain.removeHandler(forkChannel);
        ipcMain.handle(forkChannel, () => ({
          forkedThreadId: 'thread-forked',
        }));
        ipcMain.removeHandler(updatePluginsChannel);
        ipcMain.handle(updatePluginsChannel, (_event, request) => {
          globalThis.__ollamaCodexPluginUpdateRequest = request;
          return {
            pluginSelections: request.pluginSelections,
            deferredToolsAllowed: request.deferredToolsAllowed,
            sdkSessionId: 'thread-materialized',
          };
        });
      },
      {
        forkChannel: FORK_CODEX_THREAD_CHANNEL,
        updatePluginsChannel: UPDATE_CHAT_PLUGINS_CHANNEL,
      },
    );

    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.getByTestId('panel-content-chat');
    await chatPanel.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    await window.getByTestId('chat-plugins-deferred-tools-toggle').click();
    await window.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() =>
        electronApp.evaluate(() =>
          globalThis.__ollamaCodexPluginUpdateRequest
            ? {
                materializeCodexThread:
                  globalThis.__ollamaCodexPluginUpdateRequest
                    .materializeCodexThread,
                expectedCurrentThreadId:
                  globalThis.__ollamaCodexPluginUpdateRequest
                    .expectedCurrentThreadId,
              }
            : null,
        ),
      )
      .toEqual({
        materializeCodexThread: false,
        expectedCurrentThreadId: 'thread-source',
      });

    await chatPanel
      .getByRole('button', { name: `Fork ${CHAT_UNIT_LABEL}` })
      .click();

    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(2);
    await expect
      .poll(async () => {
        const persisted = await window.evaluate(
          async ({ projectId, worktreeId }) =>
            window.api.chat.loadTabs({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return persisted.tabs.find((tab) => tab.id !== TAB_ID)?.sdkSessionId;
      })
      .toBe('thread-forked');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('persists fork/branch actions, renders the delete icon, and resolves the composer model', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } = await launchTranscriptCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await app.selectWorktree(WORKTREE_ID);
    const chatPanel = window.getByTestId('panel-content-chat');
    await expect(chatPanel).toBeVisible();

    // ---- Plain and Markdown transcript rendering remain intact ------------
    // Performance fast paths may bypass the Markdown parser only for text
    // whose display semantics are identical. Keep real heading/list/link
    // structure covered through the Electron renderer so conservative
    // classification cannot silently flatten authored Markdown.
    await expect(
      chatPanel.getByRole('heading', {
        name: 'Verification summary',
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      chatPanel.getByRole('listitem').filter({
        hasText: 'Existing transcript actions remain available',
      }),
    ).toBeVisible();
    await expect(
      chatPanel.getByRole('link', { name: 'Open documentation' }),
    ).toHaveAttribute('href', 'https://example.com/transcript-docs');
    const managedImage = chatPanel.locator(`img[alt="${MANAGED_IMAGE_ALT}"]`);
    await expect(managedImage).toBeVisible();
    await expect(managedImage).toHaveJSProperty('naturalWidth', 1);
    await expect(managedImage).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    );
    await expect(
      chatPanel.getByText('Removing the obsolete module.', { exact: true }),
    ).toBeVisible();
    await expect(
      chatPanel.getByText('const parserBackedIndentedCode = true;', {
        exact: true,
      }),
    ).toHaveJSProperty('tagName', 'CODE');
    for (const text of [
      'const parserBackedMixedIndentOne = true;',
      'const parserBackedMixedIndentTwo = true;',
      'const parserBackedMixedIndentThree = true;',
    ]) {
      await expect(chatPanel.getByText(text, { exact: true })).toHaveJSProperty(
        'tagName',
        'CODE',
      );
    }
    await expect(chatPanel.locator('hr')).toHaveCount(1);
    await expect(
      chatPanel
        .locator('blockquote')
        .filter({ hasText: 'Markdown-heavy transcript rendering' }),
    ).toBeVisible();
    await expect(
      chatPanel.getByRole('columnheader', { name: 'Surface' }),
    ).toBeVisible();
    await expect(
      chatPanel.getByRole('cell', { name: 'Semantic HTML' }),
    ).toBeVisible();
    await expect(
      chatPanel.locator('pre code').filter({
        hasText: 'const markdownProfile = "covered";',
      }),
    ).toBeVisible();
    const strongFormatting = chatPanel.locator('strong').filter({
      hasText: 'parser-backed formatting',
    });
    await expect(strongFormatting).toBeVisible();
    expect(
      await strongFormatting.evaluate(
        (element) => window.getComputedStyle(element).fontWeight,
      ),
    ).toBe('500');
    const checkedTask = chatPanel.locator('input[type="checkbox"][checked]');
    await expect(checkedTask).toHaveCount(1);
    await expect(checkedTask).toBeDisabled();

    // ---- Fork/Branch persist on the last forkable turn (PR 743/752) -------
    // These labels intentionally mirror CHAT_UNIT_LABEL in
    // packages/protocol/src/ui-labels.ts while asserting real a11y names.
    const forkButton = chatPanel.getByRole('button', {
      name: `Fork ${CHAT_UNIT_LABEL}`,
    });
    const branchButton = chatPanel.getByRole('button', {
      name: `Branch ${CHAT_UNIT_LABEL} into new worktree`,
    });
    await expect(forkButton).toBeVisible();
    await expect(branchButton).toBeVisible();
    // They appear once — only on the single last forkable turn group.
    await expect(forkButton).toHaveCount(1);
    await expect(branchButton).toHaveCount(1);

    // ---- Share control moved to the last forkable completed turn ----------
    // Scope to the chat panel, which includes both the transcript and composer:
    // there should be exactly one Share session button, and it should be the
    // turn-level control rendered by TurnGroupRenderer.
    const shareButton = chatPanel.getByRole('button', {
      name: 'Share session',
    });
    await expect(shareButton).toHaveCount(1);
    await expect(chatPanel.getByTestId('turn-share-session')).toBeVisible();
    await shareButton.hover();
    const shareTooltip = window.getByRole('tooltip');
    await expect(shareTooltip).toContainText(`Share ${CHAT_UNIT_LABEL}`);
    await expect(shareTooltip).toContainText(
      `Share a redacted, read-only copy of this ${CHAT_UNIT_LABEL} with your team or organization.`,
    );

    // ---- Active-turn auto-archive toggle renders and updates --------------
    const disableAutoArchiveButton = chatPanel.getByRole('button', {
      name: 'Disable auto-archive for this turn',
    });
    await expect(disableAutoArchiveButton).toBeVisible();
    await expect(disableAutoArchiveButton).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      disableAutoArchiveButton.locator(
        'svg[data-app-icon="true"][data-glyph="archive"]',
      ),
    ).toHaveCount(1);
    await disableAutoArchiveButton.click();

    const enableAutoArchiveButton = chatPanel.getByRole('button', {
      name: 'Enable auto-archive for this turn',
    });
    await expect(enableAutoArchiveButton).toBeVisible();
    await expect(enableAutoArchiveButton).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // ---- Codex file_change delete renders the trash icon (PR 807) ---------
    // The delete card renders as a tool-call button whose label is
    // "Delete <basename>". Scope to that exact card and assert its icon is the
    // shared TrashIcon and not the document-pencil icon used for non-delete
    // file changes. Assert the shared glyph identity instead of SVG path data,
    // which changes when the icon artwork is updated.
    const deleteCard = chatPanel
      .locator('button[aria-expanded]')
      .filter({ hasText: 'Delete' })
      .filter({ hasText: 'old-module.ts' });
    await expect(deleteCard).toHaveCount(1);
    await expect(deleteCard).toBeVisible();
    await expect(
      deleteCard.locator('svg[data-app-icon="true"][data-glyph="trash-2"]'),
    ).toHaveCount(1);
    await expect(
      deleteCard.locator('svg[data-app-icon="true"][data-glyph="square-pen"]'),
    ).toHaveCount(0);

    // ---- SendMessage transcript rows collapse and expand ------------------
    // SendMessage uses the desktop `ToolCallBlock` expanded slot: the
    // collapsed row should show the friendly Agent Message summary, and the
    // expanded body should show the parsed message payload plus the tool
    // result instead of raw JSON.
    const sendMessageCard = chatPanel
      .locator('button[aria-expanded][data-tool-family="agent"]')
      .filter({ hasText: 'Agent message' })
      .filter({ hasText: 'Review transcript rendering' });
    await expect(sendMessageCard).toHaveCount(1);
    await expect(sendMessageCard).toBeVisible();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'false');
    await expect(sendMessageCard).toContainText('agent-reviewer-1');
    await expect(sendMessageCard).not.toContainText('"to":"agent-reviewer-1"');

    await sendMessageCard.click();
    await expect(sendMessageCard).toHaveAttribute('aria-expanded', 'true');
    const sendMessageExpanded = sendMessageCard.locator(
      'xpath=following-sibling::div[1]',
    );
    await expect(
      sendMessageExpanded.getByText('Message', { exact: true }),
    ).toBeVisible();
    await expect(
      sendMessageExpanded.getByText(
        'Please inspect the SendMessage transcript row.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      sendMessageExpanded.getByText('Result', { exact: true }),
    ).toBeVisible();
    await expect(
      sendMessageExpanded.getByText('Message delivered to agent-reviewer-1', {
        exact: true,
      }),
    ).toBeVisible();

    // ---- CUA REPL gets a dedicated Computer Use presentation -------------
    const computerUseRun = chatPanel.locator(
      '[data-testid="chat-tool-call"][data-tool-name="mcp__cua_repl__js"]',
    );
    const computerUseReset = chatPanel.locator(
      '[data-testid="chat-tool-call"][data-tool-name="mcp__cua_repl__js_reset"]',
    );
    const computerUseRunButton = computerUseRun.locator('button');
    const computerUseResetButton = computerUseReset.locator('button');
    await expect(computerUseRun).toContainText('Computer use');
    await expect(computerUseRunButton).toHaveAttribute(
      'data-tool-family',
      'computer-use',
    );
    await expect(computerUseReset).toContainText('Computer use');
    await expect(computerUseReset.locator('code')).toHaveText('Reset');
    await expect(computerUseResetButton).toHaveAttribute(
      'data-tool-family',
      'computer-use',
    );
    await expect(
      computerUseReset.locator('svg[data-glyph="mouse-pointer-click"]'),
    ).toHaveCount(1);
    await expect(computerUseResetButton).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await computerUseResetButton.click();
    await expect(computerUseResetButton).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(computerUseReset).toContainText('Persistent bindings reset.');

    // ---- Composer resolves the worktree default model (ModelPicker) -------
    const modelPicker = chatPanel.getByTestId('chat-model-picker');
    await expect(modelPicker).toBeVisible();
    // The picker's aria-label carries the resolved model label and works in
    // both the full and compact toolbar layouts (the visible label is hidden
    // when compact). A resolved worktree default is never "Project default".
    const ariaLabel = await modelPicker.getAttribute('aria-label');
    expect(ariaLabel, 'model picker aria-label').toBeTruthy();
    expect(ariaLabel).toMatch(/^Select model, current model /);
    expect(ariaLabel).not.toContain('Project default');
    const resolvedLabel = ariaLabel.replace(
      /^Select model, current model /,
      '',
    );
    expect(resolvedLabel.trim().length).toBeGreaterThan(0);

    // ---- Codex context-window usage renders in the composer popover -------
    const usageButton = chatPanel.getByRole('button', {
      name: 'Usage indicator',
    });
    await expect(usageButton).toBeVisible();
    await usageButton.click();
    await expect(
      window.getByText('64.0k / 200.0k (32%)', { exact: true }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('chat-transcript-actions.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});
