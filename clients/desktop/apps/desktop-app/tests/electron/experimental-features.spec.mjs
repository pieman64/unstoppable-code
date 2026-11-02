import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

/**
 * Independent feature choices: Sidebar style in Appearance, retained Labs
 * experiments, and Remote access's own switch. Choices persist locally while
 * standard compact tool calls and sentence-case titles need no Labs opt-in.
 */

function readSidebarEnabled(window) {
  return window.evaluate(() =>
    window.api.experiments
      .getSnapshot()
      .then(
        (snapshot) =>
          snapshot.experiments.find((entry) => entry.id === 'sidebar')
            ?.enabled ?? false,
      ),
  );
}

/** The durable signed-out Sidebar style choice main writes. */
function readStoredLocalChoice(userDataDir) {
  const filePath = path.join(userDataDir, 'labs-experiments', 'choices.json');
  if (!existsSync(filePath)) return null;
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  return stored.accounts?.local?.sidebar ?? null;
}

test('remote access is on by default and follows its own switch', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const remoteAccess = window.getByTestId('settings-nav-remote-access');
    const available = () =>
      window.evaluate(() =>
        window.api.remoteControl.getState().then((state) => state.available),
      );
    const saved = () =>
      window.evaluate(() =>
        window.api
          .loadPreferences()
          .then((prefs) => prefs.remoteControlEnabled),
      );

    // Remote access starts on while independent Labs choices start off.
    await expect.poll(available).toBe(true);
    expect(await saved()).toBe(true);
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(remoteAccess).toBeVisible();
    await expect(
      window.getByTestId('labs-experiment-toggle-activity-card'),
    ).toHaveCount(0);
    const toggle = window.getByTestId('remote-control-opt-in-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Turning it off withdraws it at once, without a restart.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(remoteAccess).toHaveCount(0);
    await expect.poll(available).toBe(false);
    await expect.poll(saved).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(remoteAccess).toBeVisible();
    await expect.poll(available).toBe(true);
    await expect.poll(saved).toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Sidebar style stores its independent local choice through Appearance', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    expect(await readSidebarEnabled(window)).toBe(false);
    expect(readStoredLocalChoice(launched.userDataDir)).toBe(false);

    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('labs-experiment-toggle-sidebar'),
    ).toHaveCount(0);
    await app.openSettingsSection('display');
    const picker = window.getByTestId('sidebar-style-picker');
    await expect(picker).toBeEnabled();
    await expect(picker).toContainText('Advanced');
    await picker.click();
    await window.getByTestId('sidebar-style-compact').click();
    await expect(picker).toContainText('Compact');
    await expect.poll(() => readSidebarEnabled(window)).toBe(true);
    await expect
      .poll(() => readStoredLocalChoice(launched.userDataDir))
      .toBe(true);

    // Leave and return: the picker reads the saved choice rather than local state.
    await app.openSettingsSection('experiments');
    await app.openSettingsSection('display');
    await expect(picker).toContainText('Compact');
    await picker.click();
    await window.getByTestId('sidebar-style-advanced').click();
    await expect(picker).toContainText('Advanced');
    await expect.poll(() => readSidebarEnabled(window)).toBe(false);
    await expect
      .poll(() => readStoredLocalChoice(launched.userDataDir))
      .toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Sidebar style keeps the stored sidebar nav layout', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Workflows (CAN-3980) replaces the Automations and Pipelines rows, with
    // the Library tab (CAN-3981) that lists pipelines included. Remote
    // Control opens from the account menu (CAN-3659), never the nav.
    const mainNavKeys = ['app-advisor', 'workflows'];
    const expectDefaultRegions = async () => {
      for (const key of mainNavKeys) {
        await expect(window.getByTestId(`sidebar-nav-${key}`)).toBeVisible();
      }
      await expect(window.getByTestId('sidebar-nav-automations')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('sidebar-nav-pipelines')).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-nav-remote-control'),
      ).toHaveCount(0);
      await window.getByTestId('sidebar-more').click();
      const moreItems = window.locator('[data-testid^="sidebar-more-item-"]');
      await expect(moreItems.first()).toBeVisible();
      for (const key of [...mainNavKeys, 'remote-control']) {
        await expect(
          window.getByTestId(`sidebar-more-item-${key}`),
        ).toHaveCount(0);
      }
      await window.keyboard.press('Escape');
      await expect(moreItems).toHaveCount(0);
      const accountMenu = window.getByTestId('sidebar-account-menu');
      await window.getByTestId('sidebar-account-row').click();
      await expect(
        accountMenu.getByTestId('sidebar-account-menu-item-remote-control'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(accountMenu).toHaveCount(0);
    };
    await expectDefaultRegions();

    // The experiments snapshot push reaches the sidebar without a reload, and
    // leaves App Advisor where the layout stores it and Remote Control in the
    // account menu.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: true,
      }),
    );
    await expectDefaultRegions();
    const workflows = window.getByTestId('sidebar-nav-workflows');
    await workflows.click();
    const libraryTab = window.getByTestId('workflows-tab-workflows-library');
    await expect(libraryTab).toBeVisible();
    await libraryTab.click();
    await expect(window.getByTestId('page-workflows-library')).toBeVisible();

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: false,
      }),
    );
    await expectDefaultRegions();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

const COMPACT_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const COMPACT_WORKTREE_ID = 'demo-main';
const COMPACT_CHAT_ID = 'compact-tool-calls-chat';
const COMPACT_T = Date.parse('2026-10-05T12:00:00.000Z');

/** One assistant message per tool call, each with its result, as providers write them. */
function toolCallMessage(index, toolName, input) {
  const toolUseId = `compact-tool-${index}`;
  return {
    id: `compact-call-${index}`,
    role: 'assistant',
    blocks: [
      { type: 'tool_use', toolUseId, toolName, input: JSON.stringify(input) },
      {
        type: 'tool_result',
        toolUseId,
        toolName,
        output: 'ok',
        isError: false,
      },
    ],
    timestamp: COMPACT_T + index * 1_000,
  };
}

function compactToolCallsTranscript() {
  return [
    {
      id: 'compact-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Why does the tooltip stay?' }],
      timestamp: COMPACT_T,
    },
    {
      id: 'compact-intro',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'I will look at the indicator first.' }],
      timestamp: COMPACT_T + 500,
    },
    toolCallMessage(1, 'Grep', { pattern: 'WakeLockIndicator', path: 'src' }),
    toolCallMessage(2, 'Read', { file_path: '/repo/WakeLockIndicator.tsx' }),
    toolCallMessage(3, 'Read', { file_path: '/repo/wakeLockStore.ts' }),
    {
      id: 'compact-answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The tooltip is cached on start.' }],
      timestamp: COMPACT_T + 5_000,
    },
    {
      id: 'compact-timer',
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: COMPACT_T,
          completedAt: COMPACT_T + 6_000,
        },
      ],
      timestamp: COMPACT_T + 6_000,
    },
  ];
}

test('Tool calls show one row each until Chat detail is Compact', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-compact-tool-calls-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: COMPACT_WORKSPACE_ID,
    worktreeId: COMPACT_WORKTREE_ID,
    providerType: 'claude',
    activeTabId: COMPACT_CHAT_ID,
    tabs: [
      {
        id: COMPACT_CHAT_ID,
        title: 'Compact tool calls',
        messages: compactToolCallsTranscript(),
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(COMPACT_WORKTREE_ID);
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${COMPACT_CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible();

    // Chat detail "Detailed" keeps every tool call its own row.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    // Open the finished turn so its steps show.
    const turnSteps = chatPanel.getByRole('button', { name: /^Agent steps:/ });
    await expect(turnSteps).toBeVisible();
    if ((await turnSteps.getAttribute('aria-expanded')) !== 'true') {
      await turnSteps.click();
    }
    const toolRows = chatPanel.getByTestId('chat-tool-call');
    const group = chatPanel.getByTestId('chat-tool-step-group');
    await expect(toolRows).toHaveCount(3);
    await expect(group).toHaveCount(0);

    // Compact folds the calls between two replies into one line.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'compact' }),
    );
    await expect(group).toHaveCount(1);
    await expect(group.getByTestId('chat-tool-step-summary')).toHaveText(
      'Searched once, read 2 files',
    );
    await expect(toolRows).toHaveCount(0);
    // Agent text around the calls stays visible.
    await expect(
      chatPanel.getByText('I will look at the indicator first.'),
    ).toBeVisible();
    await expect(
      chatPanel.getByText('The tooltip is cached on start.'),
    ).toBeVisible();

    const summaryButton = group.getByRole('button', {
      name: 'Searched once, read 2 files',
    });
    await expect(summaryButton).toHaveAttribute('aria-expanded', 'false');
    await summaryButton.click();
    await expect(summaryButton).toHaveAttribute('aria-expanded', 'true');
    await expect(group.getByTestId('chat-tool-call')).toHaveCount(3);
    await summaryButton.click();
    await expect(toolRows).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
  }
});

const NAMED_WORKSPACE_ID = 'demo-ts-npm-next';
const NAMED_WORKTREE_ID = 'demo-main';
const NAMED_BRANCH = 'demo/fix-sidebar-toggle';
const CHAT_NAME = 'Fix the sidebar toggle';

/** One demo worktree whose first chat has a generated summary. */
function seedChatNamedWorktree() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-named-rows-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-npm-next'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: NAMED_WORKSPACE_ID,
    worktreeId: NAMED_WORKTREE_ID,
    tabs: [
      {
        id: 'named-chat',
        title: 'the sidebar toggle does not...',
        description: CHAT_NAME,
        providerType: 'claude',
      },
    ],
  });
  // The demo branch shares the worktree's name; a distinct one shows which of
  // the two the subtitle carries (the worktree's name, never the branch). Rename it in git too, since startup
  // reconciles the stored branch name with the checkout.
  const worktreePath = seed.workspaces.find(
    (workspace) => workspace.id === NAMED_WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) throw new Error('Seeded worktree path missing');
  execFileSync('git', ['branch', '-m', NAMED_BRANCH], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  // The summary main saves with every chat write, as a launch would read it.
  const filePath = path.join(
    userDataDir,
    'workspaces',
    NAMED_WORKSPACE_ID,
    'worktrees.json',
  );
  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  file.worktrees = file.worktrees.map((worktree) => {
    if (worktree.id !== NAMED_WORKTREE_ID) return worktree;
    return {
      ...worktree,
      branchName: NAMED_BRANCH,
      chatBadges: {
        version: 2,
        chatName: CHAT_NAME,
        unreadChats: [],
        approvalChats: [],
        needsHydration: false,
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    };
  });
  writeJson(filePath, file);
  return { userDataDir, seed };
}

test('Compact sidebar names worktree rows after their chat, worktree name underneath', async () => {
  const { userDataDir, seed } = seedChatNamedWorktree();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const row = window.locator(
      `[data-testid="worktree-row"][data-project-id="${NAMED_WORKSPACE_ID}"][data-worktree-id="${NAMED_WORKTREE_ID}"]`,
    );
    const title = row.getByTestId('worktree-row-title');
    const subtitle = row.getByTestId('worktree-row-subtitle');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(title).not.toHaveText(CHAT_NAME);
    await expect(subtitle).toContainText(NAMED_WORKTREE_ID);

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: true,
      }),
    );
    await expect(title).toHaveText(CHAT_NAME);
    // The second line stays the worktree's own name; the branch is on the
    // row's hover card.
    await expect(subtitle).toContainText(NAMED_WORKTREE_ID);
    await expect(subtitle).not.toContainText(NAMED_BRANCH);

    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: false,
      }),
    );
    await expect(title).not.toHaveText(CHAT_NAME);
    await expect(subtitle).toContainText(NAMED_WORKTREE_ID);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seed);
  }
});

test('Chat activity card preserves Activity panels with standard sentence-case rows', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sentence-case-sections-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Seeded worktree path missing');
  // One dirty file so the Changed Files section shows.
  writeFileSync(
    path.join(worktreePath, 'SENTENCE_CASE.txt'),
    'sentence case fixture\n',
    'utf8',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(COMPACT_WORKTREE_ID);
    const changedFiles = window.getByTestId('changed-files-section');
    await expect(changedFiles).toBeVisible({ timeout: 20_000 });
    const title = changedFiles.locator('[data-panel-section-title]');
    await expect(title).toHaveText('Changed files');

    // #4881 preserves existing panels when the activity-card choice changes. The
    // experiments snapshot push updates their titles and adds the optional card
    // without rebuilding the open layout.
    await window.evaluate(async (enabled) => {
      for (const experimentId of ['activity-card'])
        await window.api.experiments.setChoice({ experimentId, enabled });
    }, true);
    await expect(title).toHaveText('Changed files');
    await expect(changedFiles).toBeVisible();
    const toggle = window.getByTestId('worktree-activity-card-toggle');
    await toggle.click();
    await expect(
      window
        .getByTestId('activity-card')
        .getByTestId('activity-card-row-changed-files'),
    ).toContainText('Changes', { timeout: 20_000 });

    await window.evaluate(async (enabled) => {
      for (const experimentId of ['activity-card'])
        await window.api.experiments.setChoice({ experimentId, enabled });
    }, false);
    await expect(toggle).toHaveCount(0);
    await expect(window.getByTestId('activity-card')).toHaveCount(0);
    await expect(changedFiles).toBeVisible();
    await expect(title).toHaveText('Changed files');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seed);
  }
});
