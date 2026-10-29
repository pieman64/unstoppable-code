/**
 * Cross-harness "Continue on <Provider>" (model picker).
 *
 * A chat with history locks the model picker to its own execution harness.
 * Before this change the mismatched rows were greyed out with NO tooltip at
 * all, and there was no way forward. Now:
 *   - a blocked row explains itself ("This chat is running on ... Start a new
 *     chat to use ... models."), and
 *   - an idle, eligible chat renders the other harness's rows as ordinary
 *     selectable models; picking one opens a confirm dialog that creates a NEW
 *     chat on the target provider carrying an LLM handoff summary.
 *
 * Deterministic: the workspace, worktree and chat transcript are all seeded on
 * disk, the model catalog is injected, and the `chat:generate-handoff-summary`
 * IPC handler is stubbed in the main process, so no agent is spawned and no
 * network call is made.
 *
 * Run:
 *   pnpm run build:e2e
 *   pnpm exec playwright test continue-on-provider.spec.mjs --reporter=line
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  protocolEntries,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'continue-on-provider-chat';
const CLAUDE_MODEL_ID = 'sonnet';
// Use a featured model: older entries now live under the More flyout.
const CODEX_MODEL_ID = 'gpt-6-astra';
const OLLAMA_MODEL_ID = 'ollama-llama-local';
const CLAUDE_ROW = `chat-model-option-${CLAUDE_MODEL_ID}`;
const CODEX_ROW = `chat-model-option-${CODEX_MODEL_ID}`;
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';
const HANDOFF_SUMMARY_CHANNEL = 'chat:generate-handoff-summary';
const SUMMARY = 'The user asked to fix a flaky archive spec. It now passes.';

/** A Claude chat with real history, so the picker locks to Claude. */
function seedClaudeChatWithHistory(
  userDataDir,
  tabOverrides = {},
  historyPrefixCount = 0,
) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Original title',
        description: 'Fix the flaky archive spec',
        model: 'sonnet',
        messages: [
          ...Array.from({ length: historyPrefixCount }, (_, index) => ({
            id: `older-history-${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
            blocks: [{ type: 'text', text: `Older history ${index}` }],
            timestamp: Date.parse('2026-04-10T10:00:00.000Z') + index * 1_000,
          })),
          {
            id: 'msg-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix the flaky archive spec' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
          {
            id: 'msg-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Done, it passes now.' }],
            timestamp: Date.parse('2026-04-10T12:00:05.000Z'),
          },
        ],
        ...tabOverrides,
      },
    ],
  });
}

/**
 * Replace the handoff-summary IPC handler in the MAIN process so confirming the
 * dialog resolves to a fixed summary instead of spawning a Claude helper. The
 * preload bridge is frozen, so the renderer-side API object cannot be patched.
 */
async function stubHandoffSummary(electronApp, summary) {
  await electronApp.evaluate(
    ({ ipcMain }, { channel, text }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ summary: text }));
    },
    { channel: HANDOFF_SUMMARY_CHANNEL, text: summary },
  );
}

/**
 * Push a deterministic model catalog so the picker always has one Claude row,
 * one Codex row, and one Ollama row regardless of what is installed locally.
 */
async function injectModelRegistry(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, snapshot }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error('No BrowserWindow available for model registry update');
      }
      window.webContents.send(channel, snapshot);
    },
    {
      channel: MODEL_REGISTRY_UPDATED_CHANNEL,
      snapshot: {
        // Context windows let a continued chat seed its usage meter (CAN-2799).
        claude: [{ id: 'sonnet', label: 'Sonnet', contextWindow: 200_000 }],
        codex: [
          { id: CODEX_MODEL_ID, label: 'GPT-6 Astra', contextWindow: 400_000 },
        ],
        // Ollama rows only render for entries that declare the required
        // completion + tools capabilities.
        ollama: [
          {
            id: OLLAMA_MODEL_ID,
            label: 'Llama Local',
            show: { capabilities: ['completion', 'tools'] },
          },
        ],
        agents: [],
        aliases: {},
      },
    },
  );
}

test('continues an idle Claude chat onto Codex as a new linked chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-'),
  );
  seedClaudeChatWithHistory(userDataDir, {}, 510);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await stubHandoffSummary(electronApp, SUMMARY);
    await injectModelRegistry(electronApp);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();

    // The cross-harness row renders exactly like any other selectable model:
    // enabled, with no locked reason node and no extra affordance.
    const codexRow = window.getByTestId(CODEX_ROW);
    await expect(codexRow).toBeVisible();
    await expect(codexRow).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      codexRow.getByTestId('chat-model-option-locked-codex'),
    ).toHaveCount(0);

    // Read the row's own label rather than hard-coding the seeded one: main
    // broadcasts the real bundled catalog after this spec injects its snapshot,
    // so whichever arrives last owns the display name. Asserting against the row
    // is also the stronger claim — the dialog must name the model using exactly
    // the words the user just clicked, whatever those words are.
    const modelLabel = (
      await window
        .getByTestId(`chat-model-option-label-${CODEX_MODEL_ID}`)
        .textContent()
    ).trim();
    expect(modelLabel.length).toBeGreaterThan(0);

    // Clicking it opens the confirm dialog instead of switching the model.
    await codexRow.click();
    const dialog = window.getByTestId('continue-on-provider-dialog');
    await expect(dialog).toBeVisible();
    // The dialog speaks to the user in the only vocabulary they have: the model
    // they just picked. Harness names are internal and must not appear in it.
    await expect(dialog).toContainText(`Start a new chat with ${modelLabel}?`);
    await expect(dialog).toContainText(
      `This chat isn't compatible with ${modelLabel}, so Canopy will start a new chat with it`,
    );
    await expect(dialog).toContainText('this chat stays open');
    await expect(dialog).not.toContainText('Codex');
    await expect(dialog).not.toContainText('Claude');

    await window.getByTestId('continue-on-provider-confirm').click();
    await expect(dialog).toHaveCount(0);

    // A NEW chat was created on Codex, immediately after the source, and the
    // source chat is still present and untouched.
    // Provider identity now lives in the tab's leading icon; the visible title
    // deliberately stays clean instead of repeating a `Codex:` prefix. Wait
    // for the new active chat tab, then verify its provider through the picker
    // below and its canonical persisted record.
    const chatTabs = window.locator('[role="tab"][data-panel-kind="chat"]');
    await expect(chatTabs).toHaveCount(2);
    await expect(chatTabs.last()).toHaveAttribute('aria-selected', 'true');

    const transcriptRoot = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-v2',
      WORKTREE_ID,
    );
    await expect
      .poll(() => existsSync(path.join(transcriptRoot, 'live-index.json')), {
        timeout: 30_000,
      })
      .toBe(true);
    const live = JSON.parse(
      readFileSync(path.join(transcriptRoot, 'live-index.json'), 'utf8'),
    );
    const continued = live.tabs.find((tab) => tab.id !== CHAT_ID);
    expect(continued, 'continued canonical chat').toBeTruthy();
    const canonicalMessages = readFileSync(
      path.join(transcriptRoot, 'transcripts', `${continued.id}.jsonl`),
      'utf8',
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(canonicalMessages).toHaveLength(512);

    // The provenance divider is the disclosure that everything above it was
    // transferred as a summary rather than verbatim.
    await expect(
      window.getByText('Continued from Claude, summary only'),
    ).toBeVisible();

    // The continued chat is now running on Codex: reopening the picker shows
    // the Codex row selected.
    await picker.click();
    await expect(window.getByTestId(CODEX_ROW)).toHaveAttribute(
      'aria-checked',
      'true',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retains oversized context before a short error in the real handoff helper', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-handoff-context-'),
  );
  const marker = `Canopy-CHANDOFF${path.basename(userDataDir).replace(/[^a-zA-Z0-9]/g, '')}`;
  const summary =
    'Retained the essential final constraint from the oversized response.';
  seedClaudeChatWithHistory(userDataDir, {
    messages: [
      {
        id: 'prompt',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Continue the work' }],
      },
      {
        id: 'large',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'text',
            text:
              'Earlier details. '.repeat(4000) +
              ` Essential final constraint. [${marker}]`,
          },
        ],
      },
      {
        id: 'error',
        role: 'system',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Provider failed; please continue.' }],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'archive-handoff-summary': { text: summary, stopReason: 'end_turn' },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectModelRegistry(electronApp);
    await window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first()
      .click();
    await window.getByTestId(CODEX_ROW).click();
    await expect(
      window.getByTestId('continue-on-provider-dialog'),
    ).toBeVisible();
    await window.getByTestId('continue-on-provider-confirm').click();
    await expect(window.getByTestId('continue-on-provider-dialog')).toHaveCount(
      0,
      { timeout: 60_000 },
    );
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toHaveCount(2);
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      },
    );
    const continued = snapshot.tabsFile.tabs.find((tab) => tab.id !== CHAT_ID);
    expect(
      continued?.pendingSystemInstructions?.map((item) => item.text).join('\n'),
    ).toContain(summary);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
  }
});

test('closes the continue dialog when the user switches to another chat', async () => {
  // INVARIANT GUARD, not a fixed bug.
  //
  // A review raised that `ChatInput` is mounted without a `key={tab.id}`, so an
  // open continue dialog could survive a chat switch and rebind to the NEW tab
  // on confirm — continuing a chat the user never opened it for. Both chats
  // here are Claude-locked, so the store's eligibility recheck would accept the
  // wrong one rather than reject it.
  //
  // That does not currently happen: only the active tab's surface renders a
  // composer, and switching tabs unmounts it rather than reusing the instance
  // (verified by tagging the composer DOM node and observing it does not
  // survive the switch), so the dialog's component state cannot cross. This
  // test pins that behavior so a future refactor that hoists the composer to a
  // single shared instance fails here instead of silently continuing the wrong
  // chat.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-switch-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Chat A',
        description: 'Fix the flaky archive spec',
        model: 'sonnet',
        messages: [
          {
            id: 'a-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix the flaky archive spec' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
          {
            id: 'a-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Done, it passes now.' }],
            timestamp: Date.parse('2026-04-10T12:00:05.000Z'),
          },
        ],
      },
      {
        id: 'continue-on-provider-chat-b',
        title: 'Chat B',
        description: 'Rename the config loader',
        model: 'sonnet',
        messages: [
          {
            id: 'b-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Rename the config loader' }],
            timestamp: Date.parse('2026-04-10T13:00:00.000Z'),
          },
          {
            id: 'b-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Renamed.' }],
            timestamp: Date.parse('2026-04-10T13:00:05.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await stubHandoffSummary(electronApp, SUMMARY);
    await injectModelRegistry(electronApp);

    const chatTabs = window.locator('[role="tab"][data-panel-kind="chat"]');
    await expect(chatTabs).toHaveCount(2);

    // Open the continue dialog on Chat A.
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await window.getByTestId(CODEX_ROW).click();
    const dialog = window.getByTestId('continue-on-provider-dialog');
    await expect(dialog).toBeVisible();

    // Switch to Chat B without confirming.
    //
    // `force` is deliberate: in this window the dialog's backdrop covers the tab
    // bar, so an ordinary click would hit the backdrop and dismiss the dialog —
    // which would make this test pass for the wrong reason. Forcing the click
    // drives the tab change directly, which is also the shape the tab change
    // takes when it does not come from a mouse press on the covered bar (a
    // popped-out composer renders its dialog into its own document while the
    // main window stays interactive).
    await chatTabs.nth(1).click({ force: true });

    // The dialog must not survive the switch.
    await expect(dialog).toHaveCount(0);

    // And nothing was continued: still exactly the two seeded chats.
    await expect(chatTabs).toHaveCount(2);
    await expect(
      window.getByText('Continued from Claude, summary only'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('drops a pending provider pick when Pipeline Assistant switches chats', async () => {
  // Pipeline Assistant keeps one unkeyed ChatContent mounted while its active
  // tab changes. A pending provider pick must therefore be discarded, not
  // merely hidden, or switching back resurrects a dialog bound to stale state.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-pipeline-'),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'pipeline-editor',
    worktreeId: 'pipeline-editor',
    providerType: 'claude',
    activeTabId: 'pipeline-chat-a',
    tabs: [
      {
        id: 'pipeline-chat-a',
        title: 'Pipeline chat A',
        description: 'Fix the flaky archive spec',
        model: 'sonnet',
        messages: [
          {
            id: 'pipeline-a-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix the flaky archive spec' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
          {
            id: 'pipeline-a-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Done, it passes now.' }],
            timestamp: Date.parse('2026-04-10T12:00:05.000Z'),
          },
        ],
      },
      {
        id: 'pipeline-chat-b',
        title: 'Pipeline chat B',
        description: 'Rename the config loader',
        model: 'sonnet',
        messages: [
          {
            id: 'pipeline-b-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Rename the config loader' }],
            timestamp: Date.parse('2026-04-10T13:00:00.000Z'),
          },
          {
            id: 'pipeline-b-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Renamed.' }],
            timestamp: Date.parse('2026-04-10T13:00:05.000Z'),
          },
        ],
      },
    ],
  });
  mkdirSync(path.join(userDataDir, 'app-workspaces'), { recursive: true });
  renameSync(
    path.join(userDataDir, 'workspaces', 'pipeline-editor'),
    path.join(userDataDir, 'app-workspaces', 'pipeline-editor'),
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await injectModelRegistry(electronApp);
    await app.openPipelinesPage();

    const panel = window.getByTestId('pipeline-chat-panel');
    const tabA = panel.getByTestId('chat-tab-pipeline-chat-a');
    const tabB = panel.getByTestId('chat-tab-pipeline-chat-b');
    await expect(tabA).toBeVisible({ timeout: 20_000 });
    await expect(tabB).toBeVisible();
    await expect(tabA).toHaveAttribute('aria-selected', 'true');
    const tabs = panel.locator('[role="tab"]');
    const tabCountBefore = await tabs.count();

    // The drawer can compress Model into More actions at the current window
    // width or interface scale. Open whichever control is visible to the user.
    const inlineModel = panel.getByTestId('chat-model-picker');
    if (await inlineModel.isVisible()) {
      await inlineModel.click();
    } else {
      const plus = panel.getByTestId('chat-input-plus-button');
      await expect(plus).toBeVisible();
      await plus.click();
      const modelItem = window.getByTestId('chat-input-model-button');
      await expect(modelItem).toBeVisible();
      await modelItem.focus();
      await modelItem.press('Enter');
    }
    await expect(window.getByTestId('chat-model-menu')).toBeVisible();
    await window.getByTestId(CODEX_ROW).click();
    const dialog = window.getByTestId('continue-on-provider-dialog');
    await expect(dialog).toBeVisible();

    // The dialog backdrop covers the tab bar; dispatch directly so dismissal
    // proves the tab-identity effect ran rather than a backdrop click.
    await tabB.dispatchEvent('click');
    await expect(tabB).toHaveAttribute('aria-selected', 'true');
    await expect(dialog).toHaveCount(0);

    await tabA.dispatchEvent('click');
    await expect(tabA).toHaveAttribute('aria-selected', 'true');
    await expect(dialog).toHaveCount(0);
    await expect(tabs).toHaveCount(tabCountBefore);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('offers a fresh chat for a permanently non-continuable Ollama pair', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-blocked-'),
  );
  // An Ollama-backed chat is never continuable in either direction (small local
  // models follow a handoff summary poorly). CAN-2349 turns that permanent wall
  // into case H: the row looks selectable and offers a genuinely fresh chat,
  // without promising the summary that the normal continue flow provides.
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'ollama',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Local model chat',
        model: OLLAMA_MODEL_ID,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Summarize this file' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectModelRegistry(electronApp);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();

    // Legacy Ollama chats are repaired onto the Codex harness, so Codex is a
    // valid in-place switch. Claude remains the genuinely non-continuable pair.
    const claudeRow = window.getByTestId(CLAUDE_ROW);
    await expect(claudeRow).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      claudeRow.getByTestId('chat-model-option-locked-claude'),
    ).toHaveCount(0);

    const tabs = window.locator('[role="tab"][data-panel-kind="chat"]');
    const countBefore = await tabs.count();
    const modelLabel = (
      await window
        .getByTestId(`chat-model-option-label-${CLAUDE_MODEL_ID}`)
        .textContent()
    ).trim();
    await claudeRow.click();
    const modal = window.getByTestId('model-recovery-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      'Start a new chat with the Claude harness?',
    );
    await expect(modal).toContainText(
      "This chat uses the Codex harness and can't switch to the Claude harness. Starting a new chat leaves this one unchanged.",
    );
    await expect(modal).not.toContainText('Ollama harness');
    await expect(modal).not.toContainText('summary');

    await window.getByTestId('model-recovery-start-new-chat').click();
    await expect(modal).toHaveCount(0);
    await expect(tabs).toHaveCount(countBefore + 1);
    await expect(
      window.getByText('Continued from Ollama, summary only'),
    ).toHaveCount(0);
    await expect(picker).toContainText(modelLabel);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps a busy source disabled with the transient busy reason', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-busy-'),
  );
  seedClaudeChatWithHistory(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectModelRegistry(electronApp);

    // Start a canonical turn before its assistant delta. Late assistant events
    // alone must not revive a completed transcript.
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      turnUserMessageId: 'busy-turn',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'busy-turn',
      },
    });
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Still working...' }] },
      },
    });

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();

    // The busy chat cannot leave its harness, so the picker opens on the
    // Claude tab; Codex models are reached from All.
    await window.getByTestId('chat-model-harness-tab-all').click();
    const codexRow = window.locator(`[data-testid="${CODEX_ROW}"]:visible`);
    await expect(codexRow).toHaveAttribute('aria-disabled', 'true');
    const reason = codexRow.getByTestId('chat-model-option-locked-codex');
    await expect(reason).toHaveText(
      'This chat is still working. Stop or finish the current turn, then switch.',
    );
    // The harness picker has no hover detail: the reason is the row's
    // accessible description, and clicking the row reveals it inline.
    await expect(codexRow).toHaveAccessibleDescription(
      'This chat is still working. Stop or finish the current turn, then switch.',
    );
    await expect(reason).toHaveClass(/\bsr-only\b/);
    await codexRow.click({ force: true });
    await expect(reason).toBeVisible();
    await expect(reason).not.toHaveClass(/\bsr-only\b/);
    await expect(codexRow).toHaveAttribute('aria-checked', 'false');
    await expect(
      window.getByTestId('chat-model-unavailable-tooltip'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('context window still shows after continue on another harness', async () => {
  // CAN-2799: the continued chat starts a new provider session with fresh
  // counters, but the composer's context meter must stay usable — before the
  // fix the continued tab carried no `usage` at all, so the ring painted 0%
  // and the popover never opened until the first turn on the new provider.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-on-provider-usage-'),
  );
  seedClaudeChatWithHistory(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await stubHandoffSummary(electronApp, SUMMARY);
    await injectModelRegistry(electronApp);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    const usageButton = window
      .locator('button[aria-label="Usage indicator"]:visible')
      .first();
    const emptyHint = window.getByTestId('usage-indicator-empty-hint');
    const emptyContext = window.getByTestId('usage-indicator-context-empty');

    // ---- Claude -> Codex ---------------------------------------------------
    await picker.click();
    await window.getByTestId(CODEX_ROW).click();
    const codexDialog = window.getByTestId('continue-on-provider-dialog');
    await expect(codexDialog).toBeVisible();
    await window.getByTestId('continue-on-provider-confirm').click();
    await expect(codexDialog).toHaveCount(0);
    const chatTabs = window.locator('[role="tab"][data-panel-kind="chat"]');
    await expect(chatTabs).toHaveCount(2);
    await expect(chatTabs.last()).toHaveAttribute('aria-selected', 'true');

    // The meter is alive on the continued Codex chat: the popover opens
    // before any turn. Codex only reports context through
    // `token_usage_updated`, so the seeded window is deliberately NOT shown —
    // synthetic data is never labelled as Codex data. Whether the zero row or
    // the hint stands depends on whether the injected window survives main's
    // catalog re-broadcast; neither names the window.
    const popover = window.getByTestId('usage-indicator-popover');
    await expect(usageButton).toBeVisible();
    await usageButton.click();
    await expect(popover).toBeVisible();
    await expect(popover).not.toContainText('400.0k');
    await expect(popover.getByTestId('usage-indicator-context')).toHaveCount(0);
    // Before the first reply every figure is 0, so none show.
    await expect(window.getByText('Turns', { exact: true })).toHaveCount(0);
    // Unpin the popover before driving the picker again.
    await usageButton.click();
    await expect(popover).toHaveCount(0);

    // ---- Codex -> Claude ---------------------------------------------------
    await picker.click();
    await window.getByTestId(CLAUDE_ROW).click();
    const claudeDialog = window.getByTestId('continue-on-provider-dialog');
    await expect(claudeDialog).toBeVisible();
    await window.getByTestId('continue-on-provider-confirm').click();
    await expect(claudeDialog).toHaveCount(0);
    await expect(chatTabs).toHaveCount(3);
    await expect(chatTabs.last()).toHaveAttribute('aria-selected', 'true');

    // The continued Claude chat opens on the same row: nothing counted yet,
    // over the empty bar of the model's window.
    await usageButton.click();
    await expect(emptyContext).toHaveText('Context0');
    await expect(
      emptyContext.getByRole('progressbar', { name: 'Context window used' }),
    ).toHaveAttribute('aria-valuenow', '0');
    await expect(emptyHint).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// ── Saved Conversation handoff model (CAN-3894) ─────────────────────────────

const HANDOFF_PROMPT_FINGERPRINT = 'handed off to a new session';

function seedHandoffPreferences(userDataDir, model, thinkingLevel) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        handoffSummaryModel: model,
        handoffSummaryThinkingLevel: thinkingLevel,
      },
    }),
  );
}

/** A short Claude source chat whose helper requests resolve `marker`. */
function seedMarkedSourceChat(userDataDir, marker) {
  seedClaudeChatWithHistory(userDataDir, {
    messages: [
      {
        id: 'prompt',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: `Fix the archive spec [${marker}]` }],
      },
      {
        id: 'reply',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Done, it passes now.' }],
      },
    ],
  });
}

function latestHandoffAuditEntry(userDataDir) {
  const auditPath = path.join(
    userDataDir,
    'agent-observability',
    'audit',
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  if (!existsSync(auditPath)) return undefined;
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.eventType === 'chat_handoff_summary')
    .at(-1);
}

/** Every observability transcript record that mentions `text`. */
function observedTranscriptRecords(userDataDir, text) {
  const root = path.join(userDataDir, 'agent-observability', 'transcripts');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .filter((file) => String(file).endsWith('.jsonl'))
    .map((file) => readFileSync(path.join(root, String(file)), 'utf8'))
    .filter((content) => content.includes(text))
    .flatMap((content) => content.split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

/** Seed a Claude source chat, continue it onto Codex, return both tabs. */
async function continueSeededChatOntoCodex(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await injectModelRegistry(electronApp);
  await window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first()
    .click();
  await window.getByTestId(CODEX_ROW).click();
  await window.getByTestId('continue-on-provider-confirm').click();
  await expect(window.getByTestId('continue-on-provider-dialog')).toHaveCount(
    0,
    { timeout: 60_000 },
  );
  await expect(
    window.locator('[role="tab"][data-panel-kind="chat"]'),
  ).toHaveCount(2);
  const { tabsFile } = await window.evaluate(
    (scope) => window.api.chat.getState(scope),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  return {
    source: tabsFile.tabs.find((tab) => tab.id === CHAT_ID),
    continued: tabsFile.tabs.find((tab) => tab.id !== CHAT_ID),
  };
}

function pendingInstructionText(tab) {
  return (tab?.pendingSystemInstructions ?? [])
    .map((item) => item.text)
    .join('\n');
}

test('summarizes a provider switch with the saved Claude handoff model', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-handoff-saved-claude-'),
  );
  const marker = `Canopy-CHANDOFFMODEL${path.basename(userDataDir).replace(/[^a-zA-Z0-9]/g, '')}`;
  const summary = 'Saved Opus handoff summary for the archive spec fix.';
  seedMarkedSourceChat(userDataDir, marker);
  // Neither the source (Sonnet) nor the destination (Codex) model.
  seedHandoffPreferences(userDataDir, 'opus[1m]', 'medium');
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'archive-handoff-summary': { text: summary, stopReason: 'end_turn' },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { source, continued } =
      await continueSeededChatOntoCodex(electronApp);
    expect(pendingInstructionText(continued)).toContain(summary);
    expect(source?.model).toBe(CLAUDE_MODEL_ID);
    expect(continued?.model).toBe(CODEX_MODEL_ID);

    await expect
      .poll(() => latestHandoffAuditEntry(userDataDir)?.status, {
        timeout: 30_000,
      })
      .toBe('success');
    // Like chat turns, the helper's audit entry records the model the SDK
    // reports, so the saved `opus[1m]` appears resolved.
    expect(latestHandoffAuditEntry(userDataDir)).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5',
    });
    // The Claude runtime reports the model it actually ran, with the
    // summary-only capability set rather than the source chat's tools.
    const init = observedTranscriptRecords(
      userDataDir,
      HANDOFF_PROMPT_FINGERPRINT,
    ).find((record) => record.type === 'system' && record.subtype === 'init');
    expect(init?.model).toBe('claude-opus-5-5[1m]');
    expect(init?.tools).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
  }
});

test('summarizes a provider switch on the saved Codex handoff model', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-handoff-saved-codex-'),
  );
  const marker = `Canopy-CHANDOFFCODEX${path.basename(userDataDir).replace(/[^a-zA-Z0-9]/g, '')}`;
  const codexSummary = 'Codex-generated handoff summary for the archive fix.';
  const claudeSentinel = 'Claude helper answered instead of Codex.';
  const fixture = createFixture('normal', codexSummary);
  seedMarkedSourceChat(userDataDir, marker);
  seedHandoffPreferences(userDataDir, 'gpt-6.1-sol', 'low');
  // A Claude route would answer with this sentinel; the Codex route must not.
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'archive-handoff-summary': {
          text: claudeSentinel,
          stopReason: 'end_turn',
        },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const { source, continued } =
      await continueSeededChatOntoCodex(electronApp);
    const instructions = pendingInstructionText(continued);
    expect(instructions).toContain(codexSummary);
    expect(instructions).not.toContain(claudeSentinel);
    expect(source?.model).toBe(CLAUDE_MODEL_ID);
    expect(continued?.model).toBe(CODEX_MODEL_ID);

    const clientRequests = protocolEntries(fixture.logPath)
      .filter((entry) => entry.direction === 'client')
      .map((entry) => entry.message);
    // One ephemeral Codex thread ran the handoff on the saved model and was
    // released afterwards. Codex rejects thread/delete for an ephemeral
    // thread, so the release is an unsubscribe.
    const handoffStarts = clientRequests.filter(
      (request) =>
        request.method === 'thread/start' &&
        String(request.params?.developerInstructions).includes(
          HANDOFF_PROMPT_FINGERPRINT,
        ),
    );
    expect(handoffStarts).toHaveLength(1);
    expect(handoffStarts[0].params).toMatchObject({
      model: 'gpt-6.1-sol',
      ephemeral: true,
    });
    const turns = clientRequests.filter(
      (request) => request.method === 'turn/start',
    );
    expect(turns).toHaveLength(1);
    const handoffThreadRequests = (method) =>
      clientRequests.filter(
        (request) =>
          request.method === method &&
          request.params?.threadId === turns[0].params.threadId,
      );
    expect(handoffThreadRequests('thread/unsubscribe')).toHaveLength(1);
    expect(handoffThreadRequests('thread/delete')).toHaveLength(0);

    await expect
      .poll(() => latestHandoffAuditEntry(userDataDir)?.status, {
        timeout: 30_000,
      })
      .toBe('success');
    expect(latestHandoffAuditEntry(userDataDir)).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
    });
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
  }
});
