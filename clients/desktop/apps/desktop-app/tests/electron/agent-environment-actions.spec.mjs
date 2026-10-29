// Agent environment actions on desktop (REG-3057): a real Claude turn against
// the mock provider searches the actions, lists chats, starts a chat with an
// inline watcher, and starts a sixth chat in the same turn, which desktop does
// not refuse: it has no per-turn cap. The child's mock reply fires the watcher
// back into the parent chat.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PARENT_CHAT_ID = 'agent-actions-parent';
const PARENT_MARKER = 'Canopy-CAGENTENVPARENT';
const CHILD_MARKER = 'Canopy-CAGENTENVCHILD';
const CHILD_REPLY = 'Child review complete: the parser handles empty input.';
const PARENT_REPLY = 'Started the review chats.';
const PARENT_FOLLOW_UP = 'The child review finished and found no issues.';
const WATCHER_LABEL = 'Parser review finished';
const DISPATCH = 'mcp__canopy__DispatchAction';

function createChat(index) {
  return {
    name: DISPATCH,
    input: {
      action: {
        type: 'chat.create',
        message: `[${CHILD_MARKER}] Review parser case ${index}.`,
      },
    },
  };
}

async function transcript(
  window,
  chatId,
  scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
) {
  return window.evaluate(
    async (request) => window.api.chat.getTranscriptPage(request),
    { ...scope, chatId },
  );
}

// Mock tool-use ids repeat across steps, so pair each call with the result
// that follows it in transcript order.
function toolResults(page) {
  const blocks = page.messages.flatMap((message) => message.blocks);
  const calls = blocks.filter((block) => block.type === 'tool_use');
  const results = blocks.filter((block) => block.type === 'tool_result');
  return calls.map((call, index) => ({ call, result: results[index] }));
}

function hasAssistantText(page, text) {
  return page.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.blocks.some(
        (block) => block.type === 'text' && block.text.includes(text),
      ),
  );
}

test('a chat starts and watches another chat through environment actions', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-environment-actions-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: PARENT_CHAT_ID,
        title: 'Review coordinator',
        approvalMode: 'full-access',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, PARENT_MARKER, {
    llm: {
      stepsByRequestTag: {
        'watcher-fired': { text: PARENT_FOLLOW_UP, stopReason: 'end_turn' },
      },
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__SearchActions',
              input: { query: 'start chat' },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            { name: DISPATCH, input: { action: { type: 'chat.list' } } },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              name: DISPATCH,
              input: {
                action: {
                  type: 'chat.create',
                  title: 'Parser review',
                  message: `[${CHILD_MARKER}] Review the parser.`,
                  watchers: [
                    {
                      label: WATCHER_LABEL,
                      followUpInstruction:
                        '[Canopy-Mock-Request:watcher-fired] Summarize the review.',
                    },
                  ],
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [2, 3, 4, 5].map(createChat),
          stopReason: 'tool_use',
        },
        { toolCalls: [createChat(6)], stopReason: 'tool_use' },
        { text: PARENT_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  // The children answer after the parent's turn ends, as real reviews do, so
  // the watcher reaches an idle parent.
  await registerScenario(DEFAULT_MOCK_BASE_URL, CHILD_MARKER, {
    llm: {
      steps: [{ text: CHILD_REPLY, stopReason: 'end_turn', streamMs: 30_000 }],
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
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${PARENT_CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const composer = panel.getByRole('textbox').first();
    await composer.fill(
      `[${PARENT_MARKER}] Start a parser review in a separate chat and tell me when it finishes.`,
    );
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, PARENT_CHAT_ID),
            PARENT_REPLY,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const calls = toolResults(await transcript(window, PARENT_CHAT_ID));
    expect(calls.map(({ call }) => call.toolName)).toEqual([
      'mcp__canopy__SearchActions',
      DISPATCH,
      DISPATCH,
      DISPATCH,
      DISPATCH,
      DISPATCH,
      DISPATCH,
      DISPATCH,
    ]);
    for (const { result } of calls) expect(result, 'tool result').toBeTruthy();
    const [search, list, created, ...more] = calls.map(({ result }) => result);
    expect(search.isError).not.toBe(true);
    expect(
      JSON.parse(search.output).actions.map((action) => action.type),
    ).toContain('chat.create');
    expect(list.isError, list.output).not.toBe(true);
    const listed = JSON.parse(list.output);
    expect(listed.ok, list.output).toBe(true);
    expect(listed.result.chats).toContainEqual(
      expect.objectContaining({ chatId: PARENT_CHAT_ID, isCurrent: true }),
    );
    expect(created.isError, created.output).not.toBe(true);
    const receipt = JSON.parse(created.output);
    expect(receipt).toMatchObject({
      ok: true,
      result: {
        worktreeId: WORKTREE_ID,
        placement: 'current',
        delivery: 'submitted',
        independent: true,
        watchers: [{ ok: true }],
      },
    });
    const childChatId = receipt.result.chatId;
    expect(more).toHaveLength(5);
    for (const result of more) {
      expect(result.isError, result.output).not.toBe(true);
      expect(JSON.parse(result.output)).toMatchObject({ ok: true });
    }

    // The started chat opens as a new chat tab in the parent's worktree, in
    // the background: the parent's panel stays selected and visible.
    const childTab = window.getByTestId(`panel-tab-panel-chat-${childChatId}`);
    const parentTab = window.getByTestId(
      `panel-tab-panel-chat-${PARENT_CHAT_ID}`,
    );
    await expect(childTab).toBeVisible({ timeout: 30_000 });
    await expect(childTab).toHaveAttribute('aria-selected', 'false');
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();

    await expect
      .poll(
        async () =>
          hasAssistantText(await transcript(window, childChatId), CHILD_REPLY),
        { timeout: 90_000 },
      )
      .toBe(true);

    // The child's completion fires the inline watcher into the parent, whose
    // next turn sees the follow-up instruction. The parent is still the
    // selected panel; nothing clicks back to it. The watcher names the child
    // by its explicit title, set before the watcher was armed.
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();
    const watcherBubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_LABEL });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      'Chat completion (Parser review) watcher has fired',
      { timeout: 90_000 },
    );
    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, PARENT_CHAT_ID),
            PARENT_FOLLOW_UP,
          ),
        { timeout: 90_000 },
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

const COWORK_ID = 'cowork-default';
const COWORK_ENTRY_ID = 'agent-actions-entry';
const COWORK_PARENT_CHAT_ID = 'agent-actions-cowork-parent';
const COWORK_PARENT_MARKER = 'Canopy-CAGENTENVCOWORKPARENT';
const COWORK_CHILD_MARKER = 'Canopy-CAGENTENVCOWORKCHILD';
const COWORK_CHILD_REPLY = 'Notes reviewed: nothing is missing.';
const COWORK_PARENT_REPLY = 'Started the notes review.';
const COWORK_FOLLOW_UP = 'The notes review finished.';
const COWORK_WATCHER_LABEL = 'Notes review finished';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedCoworkParent(userDataDir) {
  const workspacesDir = path.join(userDataDir, 'workspaces');
  const workspaceDir = path.join(workspacesDir, COWORK_ID);
  const cowork = {
    createdAt: '2026-07-01T10:00:00.000Z',
    archiveRetentionDays: null,
  };
  writeJson(path.join(workspacesDir, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: COWORK_ID,
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork,
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt: '2026-07-01T10:00:00.000Z' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${COWORK_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: COWORK_PARENT_CHAT_ID,
    tabs: [
      {
        id: COWORK_PARENT_CHAT_ID,
        title: 'Notes coordinator',
        createdAt: '2026-07-01T10:05:00.000Z',
        kind: 'chat',
        providerType: 'claude',
        approvalMode: 'full-access',
        messages: [
          {
            id: `${COWORK_PARENT_CHAT_ID}-m1`,
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep track of the notes.' }],
            timestamp: Date.parse('2026-07-01T10:05:00.000Z'),
          },
        ],
      },
    ],
  });
}

// In a Cowork workspace the watcher targets the child as a standalone chat,
// which must already be a chat of its Work Entry when the watcher is armed.
test('a Cowork chat starts and watches another chat through environment actions', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-environment-actions-cowork-'),
  );
  seedCoworkParent(userDataDir);
  const scope = { projectId: COWORK_ID, worktreeId: COWORK_ENTRY_ID };
  await registerScenario(DEFAULT_MOCK_BASE_URL, COWORK_PARENT_MARKER, {
    llm: {
      stepsByRequestTag: {
        'cowork-watcher-fired': {
          text: COWORK_FOLLOW_UP,
          stopReason: 'end_turn',
        },
      },
      steps: [
        {
          toolCalls: [
            {
              name: DISPATCH,
              input: {
                action: {
                  type: 'chat.create',
                  message: `[${COWORK_CHILD_MARKER}] Review the notes.`,
                  watchers: [
                    {
                      label: COWORK_WATCHER_LABEL,
                      followUpInstruction:
                        '[Canopy-Mock-Request:cowork-watcher-fired] Summarize the review.',
                    },
                  ],
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: COWORK_PARENT_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, COWORK_CHILD_MARKER, {
    llm: {
      steps: [
        { text: COWORK_CHILD_REPLY, stopReason: 'end_turn', streamMs: 15_000 },
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
    await window
      .getByTestId('sidebar-section-chats-content')
      .locator(`[data-standalone-chat-id="${COWORK_ENTRY_ID}"]`)
      .click({ timeout: 30_000 });
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COWORK_PARENT_CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const composer = panel.getByRole('textbox').first();
    await composer.fill(
      `[${COWORK_PARENT_MARKER}] Review the notes in a separate chat and tell me when it finishes.`,
    );
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, COWORK_PARENT_CHAT_ID, scope),
            COWORK_PARENT_REPLY,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const [{ result: created }] = toolResults(
      await transcript(window, COWORK_PARENT_CHAT_ID, scope),
    );
    expect(created, 'chat.create result').toBeTruthy();
    expect(created.isError, created.output).not.toBe(true);
    const receipt = JSON.parse(created.output);
    expect(receipt).toMatchObject({
      ok: true,
      result: {
        worktreeId: COWORK_ENTRY_ID,
        placement: 'current',
        delivery: 'submitted',
        watchers: [{ ok: true }],
      },
    });
    const childChatId = receipt.result.chatId;

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, childChatId, scope),
            COWORK_CHILD_REPLY,
          ),
        { timeout: 90_000 },
      )
      .toBe(true);
    // The child's completion wakes the parent through the armed watcher.
    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, COWORK_PARENT_CHAT_ID, scope),
            COWORK_FOLLOW_UP,
          ),
        { timeout: 90_000 },
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const NEW_WORKTREE_PARENT_MARKER = 'Canopy-CAGENTENVNEWWTPARENT';
const NEW_WORKTREE_CHILD_MARKER = 'Canopy-CAGENTENVNEWWTCHILD';
const NEW_WORKTREE_CHILD_REPLY = 'Prototype finished: the spike works.';
const NEW_WORKTREE_PARENT_REPLY = 'Started the prototype in a new worktree.';
const NEW_WORKTREE_FOLLOW_UP = 'The prototype finished.';
const NEW_WORKTREE_TITLE = 'Prototype spike';
const NEW_WORKTREE_WATCHER_LABEL = 'Prototype finished';
const PARENT_SESSION_DENY = {
  id: 'parent-deny-src',
  behavior: 'deny',
  target: { kind: 'file-write', path: 'src/**' },
  createdAt: '2026-10-01T09:00:00.000Z',
  origin: 'prompt',
};
const PARENT_SESSION_GRANT = {
  id: 'parent-allow-publish',
  behavior: 'allow',
  target: { kind: 'command', pattern: 'npm publish' },
  createdAt: '2026-10-01T09:00:00.000Z',
  origin: 'prompt',
};

test('a chat starts a titled chat in a new worktree without moving the selection', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-environment-new-worktree-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: PARENT_CHAT_ID,
        title: 'Prototype coordinator',
        approvalMode: 'full-access',
        sessionApprovalRules: [PARENT_SESSION_DENY, PARENT_SESSION_GRANT],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, NEW_WORKTREE_PARENT_MARKER, {
    llm: {
      stepsByRequestTag: {
        'watcher-fired': {
          text: NEW_WORKTREE_FOLLOW_UP,
          stopReason: 'end_turn',
        },
      },
      steps: [
        {
          toolCalls: [
            {
              name: DISPATCH,
              input: {
                action: {
                  type: 'chat.create',
                  placement: 'new_worktree',
                  title: NEW_WORKTREE_TITLE,
                  message: `[${NEW_WORKTREE_CHILD_MARKER}] Build the spike.`,
                  watchers: [
                    {
                      label: NEW_WORKTREE_WATCHER_LABEL,
                      followUpInstruction:
                        '[Canopy-Mock-Request:watcher-fired] Summarize it.',
                    },
                  ],
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: NEW_WORKTREE_PARENT_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, NEW_WORKTREE_CHILD_MARKER, {
    llm: {
      steps: [
        {
          text: NEW_WORKTREE_CHILD_REPLY,
          stopReason: 'end_turn',
          streamMs: 15_000,
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
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${PARENT_CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const selectedRow = window
      .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
      .first();
    await expect(selectedRow).toHaveAttribute('data-worktree-id', WORKTREE_ID);
    const composer = panel.getByRole('textbox').first();
    await composer.fill(
      `[${NEW_WORKTREE_PARENT_MARKER}] Prototype it in a new worktree and tell me when it finishes.`,
    );
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, PARENT_CHAT_ID),
            NEW_WORKTREE_PARENT_REPLY,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const [{ result: created }] = toolResults(
      await transcript(window, PARENT_CHAT_ID),
    );
    expect(created, 'chat.create result').toBeTruthy();
    expect(created.isError, created.output).not.toBe(true);
    const receipt = JSON.parse(created.output);
    expect(receipt).toMatchObject({
      ok: true,
      result: {
        placement: 'new_worktree',
        delivery: 'queued_for_setup',
        watchers: [{ ok: true }],
      },
    });
    const { chatId: childChatId, worktreeId: childWorktreeId } = receipt.result;
    expect(childWorktreeId).not.toBe(WORKTREE_ID);
    const childScope = { projectId: WORKSPACE_ID, worktreeId: childWorktreeId };

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, childChatId, childScope),
            NEW_WORKTREE_CHILD_REPLY,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    // The new worktree and its chat start in the background: the parent's
    // worktree and chat stay selected throughout.
    await expect(selectedRow).toHaveAttribute('data-worktree-id', WORKTREE_ID);
    await expect(panel).toBeVisible();
    // The explicit title survives the first message, and the watcher names
    // the child by it.
    const childState = await window.evaluate(
      async (scope) => window.api.chat.getState(scope),
      childScope,
    );
    const childTab = childState.tabsFile.tabs.find(
      (tab) => tab.id === childChatId,
    );
    expect(childTab?.title).toBe(NEW_WORKTREE_TITLE);
    // The child starts with the parent's deny rules, not its grants. The
    // parent's relative src/** still protects the parent's own src, written
    // as an absolute path in its worktree, and protects the child's copy too.
    const childRules = childTab?.sessionApprovalRules ?? [];
    expect(childRules.map((rule) => rule.behavior)).toEqual(['deny', 'deny']);
    expect(childRules.map((rule) => rule.target.path)).toEqual([
      expect.stringMatching(
        new RegExp(`/worktrees/${WORKTREE_ID}/src/\\*\\*$`),
      ),
      expect.stringMatching(
        new RegExp(`/worktrees/${childWorktreeId}/src/\\*\\*$`),
      ),
    ]);
    const watcherBubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: NEW_WORKTREE_WATCHER_LABEL });
    await expect(watcherBubble.getByTestId('watcher-fired-title')).toHaveText(
      `Chat completion (${NEW_WORKTREE_TITLE}) watcher has fired`,
      { timeout: 90_000 },
    );
    await expect(selectedRow).toHaveAttribute('data-worktree-id', WORKTREE_ID);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

const HELD_PARENT_MARKER = 'Canopy-CAGENTENVHELDPARENT';
const HELD_CHILD_MARKER = 'Canopy-CAGENTENVHELDCHILD';
const HELD_CHILD_REPLY = 'This reply must never run.';
const HELD_PARENT_REPLY = 'Started the spike in a new worktree.';
const HELD_SETUP_SECONDS = 60;

function writeSlowWorktreeAddGit(userDataDir) {
  const shimPath = path.join(userDataDir, 'git-slow-worktree-add.sh');
  writeFileSync(
    shimPath,
    `#!/bin/sh\ncase "$*" in *"worktree add"*) sleep ${HELD_SETUP_SECONDS};; esac\nexec /usr/bin/git "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

test('a chat started in a new worktree and stopped during its setup ends as a stopped turn', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-environment-held-stop-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: PARENT_CHAT_ID,
        title: 'Prototype coordinator',
        approvalMode: 'full-access',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, HELD_PARENT_MARKER, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: DISPATCH,
              input: {
                action: {
                  type: 'chat.create',
                  placement: 'new_worktree',
                  message: `[${HELD_CHILD_MARKER}] Build the spike.`,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: HELD_PARENT_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, HELD_CHILD_MARKER, {
    llm: { steps: [{ text: HELD_CHILD_REPLY, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: { CANOPY_GIT_EXECUTABLE: writeSlowWorktreeAddGit(userDataDir) },
    }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${PARENT_CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${HELD_PARENT_MARKER}] Prototype it in a new worktree.`);
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, PARENT_CHAT_ID),
            HELD_PARENT_REPLY,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    const [{ result: created }] = toolResults(
      await transcript(window, PARENT_CHAT_ID),
    );
    const receipt = JSON.parse(created.output);
    expect(receipt).toMatchObject({
      ok: true,
      result: { placement: 'new_worktree', delivery: 'queued_for_setup' },
    });
    const { chatId: childChatId, worktreeId: childWorktreeId } = receipt.result;
    const childScope = { projectId: WORKSPACE_ID, worktreeId: childWorktreeId };

    await app.selectWorktree(childWorktreeId);
    const child = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${childChatId}"]`,
    );
    await expect(child).toBeVisible({ timeout: 30_000 });
    await expect(child.getByText('Build the spike.').first()).toBeVisible({
      timeout: 30_000,
    });
    const timer = child.getByTestId('turn-timer');
    await expect(timer).toHaveCount(0);

    await child.getByTestId('chat-stop-generation').click();

    await expect(timer).toHaveCount(1, { timeout: 10_000 });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await expect(timer.getByTestId('turn-timer-label')).toHaveText(
      /^Completed in \d+:\d{2}$/,
    );
    await expect(child.getByTestId('chat-stop-generation')).toHaveCount(0);

    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              async (scope) => window.api.chat.getState(scope),
              childScope,
            )
          ).runtimeByChatId[childChatId]?.status,
        { timeout: 10_000 },
      )
      .toBe('cancelled');
    expect(
      hasAssistantText(
        await transcript(window, childChatId, childScope),
        HELD_CHILD_REPLY,
      ),
    ).toBe(false);
    await expect(timer).toHaveCount(1);
    await expect(timer).toHaveAttribute('data-state', 'completed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

const SIBLING_ENTRY_ID = 'agent-actions-sibling-entry';
const SIBLING_SENDER_ID = 'agent-actions-sibling-sender';
const SIBLING_TARGET_ID = 'agent-actions-sibling-target';
const SIBLING_SENDER_TITLE = 'Messenger';
const SIBLING_SENDER_MARKER = 'Canopy-CAGENTENVSIBLINGSENDER';
const SIBLING_TARGET_MARKER = 'Canopy-CAGENTENVSIBLINGTARGET';
const SIBLING_SENDER_REPLY = 'Said hi to the sibling chat.';
const SIBLING_TARGET_REPLY = 'Hello back.';

function seedCoworkSiblings(userDataDir) {
  seedCoworkParent(userDataDir);
  const workspaceDir = path.join(userDataDir, 'workspaces', COWORK_ID);
  const tab = (id, title) => ({
    id,
    title,
    createdAt: '2026-07-01T10:05:00.000Z',
    kind: 'chat',
    providerType: 'claude',
    approvalMode: 'full-access',
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        blocks: [{ type: 'text', text: `Earlier ${title} context` }],
        timestamp: Date.parse('2026-07-01T10:05:00.000Z'),
      },
      {
        id: `${id}-m2`,
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Noted.' }],
        timestamp: Date.parse('2026-07-01T10:05:01.000Z'),
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: SIBLING_ENTRY_ID, createdAt: '2026-07-01T10:00:00.000Z' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${SIBLING_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: SIBLING_SENDER_ID,
    tabs: [
      tab(SIBLING_TARGET_ID, 'Browser research'),
      tab(SIBLING_SENDER_ID, SIBLING_SENDER_TITLE),
    ],
  });
}

// chat.send_message is an alias of projects.send_message, so its message
// carries the same sender attribution: the receiving chat names the sender,
// and the title opens it.
test("a Cowork chat's message to its sibling names the sender, whose title opens it", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-environment-sibling-'),
  );
  seedCoworkSiblings(userDataDir);
  const scope = { projectId: COWORK_ID, worktreeId: SIBLING_ENTRY_ID };
  await registerScenario(DEFAULT_MOCK_BASE_URL, SIBLING_SENDER_MARKER, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: DISPATCH,
              input: {
                action: {
                  type: 'chat.send_message',
                  chatId: SIBLING_TARGET_ID,
                  message: `[${SIBLING_TARGET_MARKER}] hi`,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: SIBLING_SENDER_REPLY, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, SIBLING_TARGET_MARKER, {
    llm: { steps: [{ text: SIBLING_TARGET_REPLY, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window
      .getByTestId('sidebar-section-chats-content')
      .locator(`[data-standalone-chat-id="${SIBLING_ENTRY_ID}"]`)
      .click({ timeout: 30_000 });
    const sender = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SIBLING_SENDER_ID}"]`,
    );
    await expect(sender).toBeVisible({ timeout: 30_000 });
    await sender
      .getByRole('textbox')
      .first()
      .fill(`[${SIBLING_SENDER_MARKER}] message your sibling chat "hi"`);
    await sender.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () =>
          hasAssistantText(
            await transcript(window, SIBLING_TARGET_ID, scope),
            SIBLING_TARGET_REPLY,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const [{ result: sent }] = toolResults(
      await transcript(window, SIBLING_SENDER_ID, scope),
    );
    expect(sent.isError, sent.output).not.toBe(true);
    const delivered = (
      await transcript(window, SIBLING_TARGET_ID, scope)
    ).messages.find(
      (message) =>
        message.role === 'user' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' && block.text.includes(SIBLING_TARGET_MARKER),
        ),
    );
    expect(delivered).toMatchObject({
      userMessageSource: 'agent',
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'cowork',
          projectId: COWORK_ID,
          taskId: SIBLING_ENTRY_ID,
          chatId: SIBLING_SENDER_ID,
        },
        chatTitle: SIBLING_SENDER_TITLE,
      },
    });

    await window
      .getByTestId(`panel-tab-panel-chat-${SIBLING_TARGET_ID}`)
      .click();
    const target = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${SIBLING_TARGET_ID}"]`,
    );
    const title = target
      .locator('[data-role="user"]')
      .filter({ hasText: SIBLING_TARGET_MARKER })
      .getByTestId('agent-sent-title');
    // Same project: the sender's chat title alone.
    await expect(title).toHaveText(SIBLING_SENDER_TITLE, { timeout: 30_000 });
    await title.click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${SIBLING_SENDER_ID}`),
    ).toHaveAttribute('data-active', 'true');
    await expect(sender).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
