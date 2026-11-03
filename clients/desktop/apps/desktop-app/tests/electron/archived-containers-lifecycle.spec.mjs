import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
/**
 * Full archived-container LIFECYCLE coverage (Archive & Retention), one test
 * per container kind:
 *
 *   create → chat in multiple chats (live turns against the mock provider) →
 *   archive one chat → [worktree only: run a pipeline; verify the tracked
 *   plan + attachment activity cards] → archive the worktree/work entry →
 *   verify the archive viewer shows every chat's full transcript (and, for
 *   worktrees, the pipeline run + Attachments + Plans tabs) → restore →
 *   verify the restored surface is fully interactive (chats, pipeline run,
 *   plan card + Plan panel, attachment card) → RESUME the restored chats
 *   with new live turns → restore the per-chat archived chat and resume it
 *   too.
 *
 * The resume legs are the real validators: a post-restore live turn succeeds
 * only when the provider session id AND its transcript survived capture +
 * restore (for worktrees the transcript must be re-homed to the NEW worktree
 * path's Claude project slug — the exact code under test).
 *
 * Scope notes:
 * - The worktree itself comes from `seedDemoWorkspaces` (a real git worktree
 *   on disk); in-UI worktree creation is covered by its own suites. The
 *   cowork Work Entry IS created through the UI ("+" in the sidebar row,
 *   then the first prompt through the shared New Task composer).
 * - The cowork test has no pipeline legs: work-entry containers are
 *   chats-only by design (no Pipelines tab).
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CanopyAppDriver,
  closePanelTab,
  expandDefaultActivityRail,
} from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedStoredPipeline,
  seedTrackedPlans,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import {
  legacyPlanChatExists,
  legacyPlanChatOwner,
  planDocumentPanel,
  planPanelId,
  seedLegacyPlanChat,
} from './planPanelHarness.mjs';
import {
  closePipelineRunPanels,
  expectPipelineRunPanel,
  showPipelineJobList,
} from './pipelineUi.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const COWORK_WORKSPACE_ID = 'cowork-lifecycle-e2e';
const COWORK_WORKSPACE_NAME = 'Lifecycle Cowork';

const PLAN_ID = 'plan-lifecycle';
const PLAN_TITLE = 'Lifecycle archive plan';
const PLAN_BODY = 'Lifecycle plan body retained.';
const ATTACHMENT_NAME = 'lifecycle-notes.txt';

const PIPELINE_ID = 'e2e-lifecycle-echo';
const PIPELINE_NAME = 'E2E Lifecycle Echo Pipeline';
const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  echo:',
  '    name: Echo',
  '    steps:',
  '      - id: say',
  '        name: Say',
  '        run: echo lifecycle',
  '',
].join('\n');

/**
 * One scenario per CHAT (the mock resolves the conversation by the marker
 * found anywhere in the request history, so a resumed session keeps its
 * original marker); each request consumes the next scripted step, so the
 * second step is the post-restore RESUME reply.
 */
const SCENARIOS = {
  'Canopy-CLC-A': [
    'Lifecycle reply alpha from the mock provider',
    'Lifecycle resume alpha confirmed by the mock provider',
  ],
  'Canopy-CLC-B': ['Lifecycle reply bravo from the mock provider'],
  'Canopy-CLC-C': [
    'Lifecycle reply charlie from the mock provider',
    'Lifecycle resume charlie confirmed by the mock provider',
  ],
  'Canopy-CLCW-A': [
    'Cowork lifecycle reply alpha from the mock provider',
    'Cowork resume alpha confirmed by the mock provider',
  ],
  'Canopy-CLCW-B': [
    'Cowork lifecycle reply bravo from the mock provider',
    'Cowork resume bravo confirmed by the mock provider',
  ],
};

function makeLifecyclePlan() {
  const createdAt = new Date().toISOString();
  const content = `# ${PLAN_TITLE}\n\n${PLAN_BODY}`;
  return {
    id: PLAN_ID,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: PLAN_TITLE,
    content,
    reviewStatus: 'approved',
    createdAt,
    updatedAt: createdAt,
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content,
        source: 'claude',
        reviewStatus: 'approved',
        createdAt,
      },
    ],
    linkedExecutionIds: [],
  };
}

/**
 * Asserts the live worktree surface exposes the seeded tracked plan and
 * attachment through their activity cards — used both before archiving and
 * again on the RESTORED worktree, where the same payloads must reappear
 * under the new worktree id.
 */
async function expectPlanAndAttachmentCards(window) {
  await expect(window.getByTestId('activity-plans-section')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    window.getByTestId(`activity-plan-row-${PLAN_ID}`),
  ).toContainText(PLAN_TITLE, { timeout: 30_000 });
  await expect(
    window
      .getByTestId('workspace-attachments-item')
      .filter({ hasText: ATTACHMENT_NAME })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
}

function seedPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      defaultWorktreeProvider: 'claude',
      defaultChatProvider: 'claude',
      canopyBackgroundProcessesMode: 'canopy',
      // Off-default port so live sends never trip the MCP proxy port-in-use
      // error against another running Canopy instance.
      mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
    },
  });
}

async function registerMarkers(markers) {
  for (const marker of markers) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: SCENARIOS[marker].map((text) => ({
          text,
          stopReason: 'end_turn',
        })),
      },
    });
  }
}

/**
 * Sends a marker-bearing message through the ACTIVE chat panel's composer and
 * waits for the scripted mock reply to render — proof of a completed live
 * provider turn on that chat.
 */
async function sendLiveTurn(window, marker, expectedReply) {
  const chatPanel = chatPanelLocator(window);
  await expect(chatPanel).toBeVisible();
  const message = `[${marker}] Continue the lifecycle test.`;
  const composer = chatPanel.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(message);
  await chatPanel.getByRole('button', { name: 'Send message' }).click();
  await expect(chatPanel.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(chatPanel.getByText(expectedReply).first()).toBeVisible({
    timeout: 90_000,
  });
}

/** Currently rendered chat tab ids (`panel-tab-panel-chat-<id>` strip). */
async function chatTabIds(window) {
  const ids = await window
    .locator('[data-testid^="panel-tab-panel-chat-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid'))
        .filter((id) => id !== null && !id.includes('panel-tab-close')),
    );
  return ids.map((id) => id.replace('panel-tab-panel-chat-', ''));
}

/** Creates a new chat tab via the chat group's "+" menu; returns its id. */
async function createChatTab(window) {
  const before = new Set(await chatTabIds(window));
  // The tab-strip + opens the Add menu; choose New chat explicitly.
  await window.getByTestId('panel-add-tab-group-chat').click();
  await window.getByTestId('panel-add-menu-item-new-chat').click();
  let created = null;
  await expect
    .poll(async () => {
      const after = await chatTabIds(window);
      created = after.find((id) => !before.has(id)) ?? null;
      return created;
    })
    .not.toBeNull();
  return created;
}

/** Archives a chat by closing its tab (close-with-archive for sent chats). */
async function archiveChatTab(window, tabId) {
  // Hover-revealed close control; closePanelTab retries the hover+click pair
  // because a single hover can be dropped by a tab re-render before the
  // click's hit-test runs (CAN-2436, verify run 32464410606).
  await closePanelTab(window, `panel-chat-${tabId}`);
  await expect(window.getByTestId(`panel-tab-panel-chat-${tabId}`)).toHaveCount(
    0,
  );
  await expect(window.getByTestId('chat-tab-archive')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Clicks every chat row in the archived viewer's left nav and collects which
 * scripted replies render, proving each transcript is retained in full.
 */
async function collectViewerTranscripts(
  window,
  viewer,
  expectedReplies,
  { allowedEmptyChatLabels = [] } = {},
) {
  const archivedToggle = viewer.getByTestId('archived-inner-chats-toggle');
  const rows = viewer.locator('[data-testid^="archived-chat-row-"]');
  const rowTestIds = new Set();
  const discoveredEmptyChatLabels = new Set();
  // The viewer streams chat metadata in phases, and an incoming refresh can
  // reset the archived-chat disclosure. Track stable row identities across
  // those renders instead of requiring every row in one transient frame.
  await expect
    .poll(
      async () => {
        if (
          (await archivedToggle.isVisible().catch(() => false)) &&
          (await archivedToggle.getAttribute('aria-expanded')) !== 'true'
        ) {
          await archivedToggle.click();
        }
        for (const row of await rows.evaluateAll((elements) =>
          elements.map((element) => ({
            testId: element.getAttribute('data-testid'),
            text: element.textContent?.trim() ?? '',
          })),
        )) {
          if (row.testId) rowTestIds.add(row.testId);
          if (allowedEmptyChatLabels.includes(row.text)) {
            discoveredEmptyChatLabels.add(row.text);
          }
        }
        return (
          rowTestIds.size ===
          expectedReplies.length + discoveredEmptyChatLabels.size
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const rowIds = [...rowTestIds];
  const seen = new Set();
  const seenEmptyChatLabels = new Set();
  for (const rowTestId of rowIds) {
    const row = viewer.getByTestId(rowTestId);
    if (!(await row.isVisible().catch(() => false))) {
      if ((await archivedToggle.getAttribute('aria-expanded')) !== 'true') {
        await archivedToggle.click();
      }
      await expect(row).toBeVisible();
    }
    const selectedRowClass = 'bg-fg-primary/[0.08]';
    const wasSelected = ((await row.getAttribute('class')) ?? '')
      .split(/\s+/)
      .includes(selectedRowClass);
    const previouslyVisibleReplies = [];
    for (const reply of expectedReplies) {
      if ((await viewer.getByText(reply).count()) > 0) {
        previouslyVisibleReplies.push(reply);
      }
    }
    await row.click();
    await expect(row).toHaveClass(/(?:^|\s)bg-fg-primary\/\[0\.08\](?:\s|$)/);
    if (!wasSelected && previouslyVisibleReplies.length > 0) {
      await expect
        .poll(async () => {
          let visibleCount = 0;
          for (const reply of previouslyVisibleReplies) {
            visibleCount += await viewer.getByText(reply).count();
          }
          return visibleCount;
        })
        .toBe(0);
    }
    let observedReply = null;
    await expect
      .poll(async () => {
        for (const reply of expectedReplies) {
          if (!seen.has(reply) && (await viewer.getByText(reply).count()) > 0) {
            seen.add(reply);
            observedReply = reply;
            return reply;
          }
        }
        return null;
      })
      .not.toBeNull()
      .catch(() => undefined);
    if (observedReply !== null) continue;

    let emptyChatLabel = null;
    for (const label of allowedEmptyChatLabels) {
      if ((await row.getByText(label, { exact: true }).count()) > 0) {
        emptyChatLabel = label;
        break;
      }
    }
    expect(emptyChatLabel).not.toBeNull();
    seenEmptyChatLabels.add(emptyChatLabel);
  }
  expect([...seen].sort()).toEqual([...expectedReplies].sort());
  expect(seenEmptyChatLabels.size).toBe(rowIds.length - expectedReplies.length);
}

/**
 * Restores the archived chat from the archive modal and awaits its tab.
 *
 * The row is located by its stable `data-archived-chat-id` hook rather than by
 * text: the row label leads with the agent-generated title (`description`),
 * which these live provider turns produce, so no seeded marker survives in it.
 */
async function restoreArchivedChat(window, chatId) {
  await window.getByTestId('chat-tab-archive').click();
  const modal = window.getByTestId('archived-chats-modal');
  await expect(modal).toBeVisible();
  const row = modal
    .locator(
      `[data-testid="archived-chats-modal-row"][data-archived-chat-id="${chatId}"]`,
    )
    .first();
  await expect(row).toBeVisible();
  const restoreButton = row.getByTestId('archived-chat-restore');
  // Restorable: the per-chat restore action is offered and enabled.
  await expect(restoreButton).toBeEnabled();
  await restoreButton.click();
  await expect(modal).toHaveCount(0, { timeout: 15_000 });
}

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function runGitRaw(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath });
}

test.describe('archived container lifecycle', () => {
  test('archive confirmation keeps its target after the worktree label changes', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-label-regression-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await expect(row).toBeVisible();
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-archive').click();
      const dialog = window.getByRole('dialog', {
        name: /^Archive worktree/,
      });
      await expect(dialog).toBeVisible();

      await window.evaluate(
        async ({ projectId, worktreeId }) => {
          await window.api.setWorktreeLabel({
            projectId,
            worktreeId,
            label: 'Renamed task',
          });
          window.__canopyProjectsTestApi.loadProjects();
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      await expect(row).toContainText('Renamed task');
      await expect(
        dialog.getByTestId('worktree-removal-target-identity'),
      ).toContainText('demo-main');

      const preserveLocal = dialog.getByTestId(
        'worktree-removal-preserve-branch',
      );
      await expect(preserveLocal).toBeEnabled();
      await preserveLocal.click();
      await expect(row).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('archiving a worktree keeps its legacy plan chat until the archive is permanently deleted', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-legacy-plan-chat-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    seedTrackedPlans({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      plans: [makeLifecyclePlan()],
    });
    const owner = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    // A dedicated plan chat the retired Plan Explore takeover left behind.
    seedLegacyPlanChat({
      userDataDir,
      planId: PLAN_ID,
      owner,
      chatId: 'legacy-plan-chat',
      messages: [
        {
          id: 'legacy-user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Tighten the rollout step.' }],
          timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
        },
        {
          id: 'legacy-assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Rollout step tightened.' }],
          timestamp: Date.parse('2026-09-01T12:00:05.000Z'),
        },
      ],
    });
    const livePlansPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'plans',
      `${WORKTREE_ID}.json`,
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-archive').click();
      const confirmDialog = window.getByRole('dialog', {
        name: /^Archive worktree/,
      });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
      await expect(row).toHaveCount(0, { timeout: 60_000 });
      const archivedLink = window.getByTestId(
        `sidebar-project-${WORKSPACE_ID}-archived-link`,
      );
      await expect(archivedLink).toHaveText('Archived and deleted 1', {
        timeout: 60_000,
      });
      // The live tracked plans are dropped in the same cleanup step that
      // decides the legacy plan chat's fate, so wait for it to have run.
      await expect
        .poll(() => existsSync(livePlansPath), { timeout: 30_000 })
        .toBe(false);

      // The archive can be restored, so it keeps the plan chat's transcript
      // and its owner.
      expect(legacyPlanChatExists(userDataDir, PLAN_ID)).toBe(true);
      expect(legacyPlanChatOwner(userDataDir, PLAN_ID)).toEqual(owner);

      await archivedLink.click();
      await window.getByTestId(`archived-overview-open-${WORKTREE_ID}`).click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await viewer.getByTestId('archived-delete-permanently').click();
      await viewer.getByRole('button', { name: 'Delete?' }).click();

      // A permanent delete reclaims the plan chat with the archive.
      await expect
        .poll(() => legacyPlanChatExists(userDataDir, PLAN_ID), {
          timeout: 30_000,
        })
        .toBe(false);
      expect(legacyPlanChatOwner(userDataDir, PLAN_ID)).toBeNull();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('restoring an archived worktree moves its legacy plan chat to the restored worktree', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-restore-legacy-plan-chat-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    seedTrackedPlans({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      plans: [makeLifecyclePlan()],
    });
    seedLegacyPlanChat({
      userDataDir,
      planId: PLAN_ID,
      owner: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      chatId: 'legacy-plan-chat',
      messages: [
        {
          id: 'legacy-user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Tighten the rollout step.' }],
          timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
        },
      ],
    });
    const worktreesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees.json',
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-archive').click();
      const confirmDialog = window.getByRole('dialog', {
        name: /^Archive worktree/,
      });
      await confirmDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
      await expect(row).toHaveCount(0, { timeout: 60_000 });
      const archivedLink = window.getByTestId(
        `sidebar-project-${WORKSPACE_ID}-archived-link`,
      );
      await expect(archivedLink).toHaveText('Archived and deleted 1', {
        timeout: 60_000,
      });

      await archivedLink.click();
      await window.getByTestId(`archived-overview-open-${WORKTREE_ID}`).click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await viewer.getByTestId('archived-restore').click();
      await expect(
        window.locator('[data-testid="worktree-row"]').first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect(viewer).toHaveCount(0);

      // Restore creates a fresh worktree id; the legacy plan chat the archive
      // kept must now belong to it, or cleaning up the restored worktree
      // would skip it as another scope's and leak it.
      const restored = JSON.parse(
        readFileSync(worktreesPath, 'utf8'),
      ).worktrees.filter((worktree) => worktree.id !== WORKTREE_ID);
      expect(restored).toHaveLength(1);
      await expect
        .poll(() => legacyPlanChatOwner(userDataDir, PLAN_ID), {
          timeout: 30_000,
        })
        .toEqual({ projectId: WORKSPACE_ID, worktreeId: restored[0].id });
      expect(legacyPlanChatExists(userDataDir, PLAN_ID)).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const damage of [
    'healthy',
    'missing-git-pointer',
    'missing-git-metadata',
    'restored-setup',
  ]) {
    test(`archive recovery: delete, restore, delete preserves files (${damage})`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-archive-recovery-'),
      );
      const {
        workspaces: [workspace],
      } = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedPreferences(userDataDir);
      const root = path.join(userDataDir, 'workspaces', workspace.id);
      const registry = path.join(root, 'worktrees.json');
      const readWorktrees = () => {
        try {
          return JSON.parse(readFileSync(registry, 'utf8')).worktrees;
        } catch {
          return null;
        }
      };
      const original = readWorktrees()[0];
      const setupPidPath = path.join(userDataDir, 'restored-setup.pid');
      const setupAlive = () => {
        if (!existsSync(setupPidPath)) return false;
        try {
          process.kill(Number(readFileSync(setupPidPath, 'utf8')), 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      writeFileSync(
        path.join(workspace.worktreePath, 'retained-work.txt'),
        'uncommitted work survives both archives\n',
      );
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
        await app.selectWorktree(original.branchName);
        if (damage === 'missing-git-metadata') {
          const privateGitDir = runGit(workspace.worktreePath, [
            'rev-parse',
            '--absolute-git-dir',
          ]);
          rmSync(privateGitDir, { recursive: true });
        }
        if (damage === 'missing-git-pointer')
          rmSync(path.join(workspace.worktreePath, '.git'));
        const archiveThroughUi = async (id) => {
          const row = window.locator(
            `[data-testid="worktree-row"][data-worktree-id="${id}"]`,
          );
          await row.hover();
          await row.getByTestId('worktree-actions-menu-button').click();
          await window.getByTestId('worktree-actions-menu-archive').click();
          const dialog = window.getByRole('dialog', {
            name: /^Archive worktree/,
          });
          await expect(dialog).toBeVisible();
          const choice = dialog.getByTestId('worktree-removal-preserve-branch');
          await expect(choice).toBeEnabled({ timeout: 30_000 });
          await choice.click();
          await expect.poll(readWorktrees, { timeout: 30_000 }).toHaveLength(0);
          await expect(row).toHaveCount(0);
          expect(existsSync(path.join(root, 'worktrees', id))).toBe(false);
          expect(
            existsSync(
              path.join(root, 'worktrees', `.${id}.archive-quarantine`),
            ),
          ).toBe(false);
        };
        await archiveThroughUi(original.id);
        if (damage === 'missing-git-metadata') {
          const warning = window
            .getByTestId('toast-card')
            .filter({ hasText: 'Recovered remaining files' })
            .first();
          // The warning names the live project; its worktree is gone by now.
          await expect(warning.getByTestId('toast-meta-title')).toHaveText(
            'TypeScript pnpm Vite',
          );
        }
        if (damage === 'restored-setup') {
          const script = path.join(userDataDir, 'hold-restored-setup.cjs');
          writeFileSync(
            script,
            `require('node:fs').writeFileSync(${JSON.stringify(setupPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
          );
          const configPath = path.join(root, 'workspace.json');
          const config = JSON.parse(readFileSync(configPath, 'utf8'));
          config.scripts = {
            ...config.scripts,
            setup: `"${process.execPath}" "${script}"`,
          };
          writeFileSync(configPath, JSON.stringify(config));
        }
        const archivedLink = window
          .locator('[data-testid$="-archived-link"]')
          .filter({ hasText: 'Archived' })
          .first();
        await expect(archivedLink).toBeVisible({ timeout: 30_000 });
        await archivedLink.click();
        await window
          .getByTestId(`archived-overview-open-${original.id}`)
          .click();
        if (damage === 'missing-git-metadata') {
          await expect(
            window.getByTestId('archived-file-recovery-banner'),
          ).toContainText(
            'Restore brings back the remaining files. Git history and staging require separate recovery.',
          );
        }
        await window.getByTestId('archived-restore').click();
        await expect.poll(readWorktrees, { timeout: 30_000 }).toHaveLength(1);
        const restored = readWorktrees()[0];
        if (damage === 'restored-setup')
          await expect.poll(setupAlive, { timeout: 30_000 }).toBe(true);
        await expect
          .poll(
            () =>
              existsSync(
                path.join(root, 'worktrees', restored.id, 'retained-work.txt'),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        expect(
          readFileSync(
            path.join(root, 'worktrees', restored.id, 'retained-work.txt'),
            'utf8',
          ),
        ).toBe('uncommitted work survives both archives\n');
        await archiveThroughUi(restored.id);
        if (damage === 'restored-setup')
          await expect.poll(setupAlive, { timeout: 10_000 }).toBe(false);
        await expect
          .poll(
            () =>
              existsSync(
                path.join(
                  root,
                  'archived-containers',
                  restored.id,
                  'container.json',
                ),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
      } finally {
        if (setupAlive())
          process.kill(Number(readFileSync(setupPidPath, 'utf8')), 'SIGKILL');
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('worktree: chats + pipeline survive archive, restore, and resume live', async () => {
    test.setTimeout(480_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-lifecycle-worktree-'),
    );
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const seededWorktreePath = seeded.workspaces[0].worktreePath;
    writeFileSync(
      path.join(seededWorktreePath, 'lifecycle-git-state.txt'),
      'staged lifecycle Git state\n',
    );
    runGit(seededWorktreePath, ['add', 'lifecycle-git-state.txt']);
    writeFileSync(
      path.join(seededWorktreePath, 'lifecycle-git-state.txt'),
      'working lifecycle Git state\n',
    );
    const lifecycleGitHead = runGit(seededWorktreePath, ['rev-parse', 'HEAD']);
    const lifecycleGitStatus = runGitRaw(seededWorktreePath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    seedPreferences(userDataDir);
    seedStoredPipeline({
      userDataDir,
      id: PIPELINE_ID,
      name: PIPELINE_NAME,
      yaml: PIPELINE_YAML,
    });
    // One empty Claude tab so the composer mounts ready to send; the other
    // chats are created through the UI below.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 'chat-a', title: 'Chat A' }],
    });
    // A tracked plan and an attachment the archive must carry end-to-end.
    // Both are seeded pre-launch so the activity cards list them on mount;
    // the in-UI import/creation flows have their own suites.
    seedTrackedPlans({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      plans: [makeLifecyclePlan()],
    });
    const attachmentsDir = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'attachments',
      WORKTREE_ID,
    );
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(
      path.join(attachmentsDir, ATTACHMENT_NAME),
      'lifecycle attachment retained\n',
    );
    await registerMarkers(['Canopy-CLC-A', 'Canopy-CLC-B', 'Canopy-CLC-C']);

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(
        window,
        'csk_archived_containers_lifecycle_attachments_e2e',
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      // --- Multiple chats with real provider turns -----------------------
      await sendLiveTurn(window, 'Canopy-CLC-A', SCENARIOS['Canopy-CLC-A'][0]);
      const chatB = await createChatTab(window);
      await sendLiveTurn(window, 'Canopy-CLC-B', SCENARIOS['Canopy-CLC-B'][0]);
      const chatC = await createChatTab(window);
      await sendLiveTurn(window, 'Canopy-CLC-C', SCENARIOS['Canopy-CLC-C'][0]);

      // --- Archive one chat (close-with-archive) -------------------------
      await archiveChatTab(window, chatC);

      // --- Run a pipeline to completion -----------------------------------
      await expect(
        window.getByTestId('panel-content-activity-section'),
      ).toBeVisible();
      await app.openPipelineDispatchModal(PIPELINE_NAME);
      const runButton = window.getByTestId('pipeline-trigger-modal-run');
      await expect(runButton).toBeEnabled();
      await runButton.click();
      const runCard = window
        .locator('[data-testid^="pipeline-run-card-"]')
        .filter({ hasText: PIPELINE_NAME })
        .first();
      await expect(runCard).toBeVisible({ timeout: 30_000 });
      await expect(runCard).toContainText('success', { timeout: 60_000 });

      // --- Plan + attachment cards are live before archiving ---------------
      await expectPlanAndAttachmentCards(window);

      // --- Archive the worktree (kept until deleted) ----------------------
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      // Archive is its own menu item; no lock toggle inside the dialog.
      await window.getByTestId('worktree-actions-menu-archive').click();
      const confirmDialog = window.getByRole('dialog', {
        name: /^Archive worktree/,
      });
      await expect(confirmDialog).toBeVisible();
      await expect(
        confirmDialog.getByTestId('worktree-removal-lock-toggle'),
      ).toHaveCount(0);
      await expect(confirmDialog).toContainText('until you delete the archive');
      await confirmDialog
        .getByTestId('worktree-removal-preserve-branch')
        .click();
      await expect(row).toHaveCount(0, { timeout: 60_000 });

      // --- Verify the archive viewer: all chats in full + the pipeline ----
      const archivedLink = window.getByTestId(
        `sidebar-project-${WORKSPACE_ID}-archived-link`,
      );
      await expect(archivedLink).toHaveText('Archived and deleted 1', {
        timeout: 60_000,
      });
      await archivedLink.click();
      await expect(
        window.getByTestId(`archived-overview-row-${WORKTREE_ID}`),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        window.getByTestId(`archived-overview-state-${WORKTREE_ID}`),
      ).toHaveAttribute('data-state', 'archived');
      await window.getByTestId(`archived-overview-open-${WORKTREE_ID}`).click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      await expect(viewer.getByTestId('archived-state-badge')).toHaveAttribute(
        'data-state',
        'archived',
      );

      await collectViewerTranscripts(window, viewer, [
        SCENARIOS['Canopy-CLC-A'][0],
        SCENARIOS['Canopy-CLC-B'][0],
        SCENARIOS['Canopy-CLC-C'][0],
      ]);
      // Exactly one inner chat was already archived before the worktree.
      await expect(
        viewer.getByTestId('archived-inner-chats-toggle'),
      ).toContainText('Archived (1)');

      await expect(
        viewer.getByTestId('archived-container-tab-chats'),
      ).toContainText('Chats (3)');
      await expect(
        viewer.getByTestId('archived-container-tab-pipelines'),
      ).toContainText('Workflows (1)');
      await expect(
        viewer.getByTestId('archived-container-tab-attachments'),
      ).toContainText('Attachments (1)');
      await expect(
        viewer.getByTestId('archived-container-tab-plans'),
      ).toContainText('Plans (1)');

      const lockedManifest = JSON.parse(
        readFileSync(
          path.join(
            userDataDir,
            'workspaces',
            WORKSPACE_ID,
            'archived-containers',
            WORKTREE_ID,
            'container.json',
          ),
          'utf8',
        ),
      );
      expect(typeof lockedManifest.lockedAt).toBe('string');

      await viewer.getByTestId('archived-container-tab-pipelines').click();
      const execRow = viewer.locator(
        '[data-testid^="archived-execution-row-"]',
      );
      await expect(execRow).toHaveCount(1, { timeout: 15_000 });
      await expect(execRow.first()).toContainText(PIPELINE_NAME);
      await execRow.first().click();
      const modal = window.getByRole('dialog').last();
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(modal).toContainText(PIPELINE_NAME);
      // Read-only: no lifecycle actions on archived executions.
      await expect(
        modal.getByRole('button', {
          name: /^(Cancel|Try|Rerun|Debug|Resume)/,
        }),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');

      // --- Attachments and Plans tabs retain their payloads ----------------
      await viewer.getByTestId('archived-container-tab-attachments').click();
      await expect(
        viewer.getByTestId(`archived-attachment-row-${ATTACHMENT_NAME}`),
      ).toBeVisible({ timeout: 15_000 });

      await viewer.getByTestId('archived-container-tab-plans').click();
      await expect(
        viewer.getByTestId(`archived-plan-row-${PLAN_ID}`),
      ).toBeVisible({ timeout: 15_000 });
      await expect(viewer.getByTestId('archived-plan-content')).toContainText(
        PLAN_BODY,
      );

      // --- Restore --------------------------------------------------------
      await viewer.getByTestId('archived-restore').click();
      const restoredRow = window.locator('[data-testid="worktree-row"]');
      await expect(restoredRow.first()).toBeVisible({ timeout: 90_000 });
      await expect(viewer).toHaveCount(0);

      const restoredWorktrees = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'),
          'utf8',
        ),
      ).worktrees.filter((worktree) => worktree.id !== WORKTREE_ID);
      expect(restoredWorktrees).toHaveLength(1);
      const restoredWorktreePath = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'worktrees',
        restoredWorktrees[0].id,
      );
      expect(runGit(restoredWorktreePath, ['rev-parse', 'HEAD'])).toBe(
        lifecycleGitHead,
      );
      expect(
        runGitRaw(restoredWorktreePath, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ]),
      ).toEqual(lifecycleGitStatus);
      expect(
        readFileSync(
          path.join(restoredWorktreePath, 'lifecycle-git-state.txt'),
          'utf8',
        ),
      ).toBe('working lifecycle Git state\n');

      // --- Verify the restored surface -------------------------------------
      // Both live chats return as interactive tabs with their transcripts.
      const restoredTabA = window.getByTestId('panel-tab-panel-chat-chat-a');
      await expect(restoredTabA).toBeVisible({ timeout: 60_000 });
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${chatB}`),
      ).toBeVisible();
      await restoredTabA.click();
      await expect(
        chatPanelLocator(window)
          .getByText(SCENARIOS['Canopy-CLC-A'][0])
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      // No read-only degradation: the restored chats resume, not archive.
      await expect(
        window.getByText('This session has been archived', { exact: false }),
      ).toHaveCount(0);

      // The pipeline run was re-homed into the restored worktree's activity.
      await expect(
        window.getByTestId('panel-content-activity-section'),
      ).toBeVisible();
      const restoredRunCard = window
        .locator('[data-testid^="pipeline-run-card-"]')
        .filter({ hasText: PIPELINE_NAME })
        .first();
      await expect(restoredRunCard).toBeVisible({ timeout: 30_000 });
      const restoredExecutionId = (
        await restoredRunCard.getAttribute('data-testid')
      ).replace('pipeline-run-card-', '');
      await restoredRunCard.click({ position: { x: 10, y: 10 } });
      // The run opens in its own panel tab, which becomes the chat group's
      // active tab and does not close on Escape (the old takeover did). Close
      // it and bring chat A back, so the resume leg below runs on chat A as
      // it did when Escape dismissed the takeover.
      const restoredRunPanel = await expectPipelineRunPanel(
        window,
        restoredExecutionId,
      );
      await showPipelineJobList(restoredRunPanel, { timeout: 15_000 });
      await closePipelineRunPanels(window);
      await restoredTabA.click();
      await expect(
        chatPanelLocator(window)
          .getByText(SCENARIOS['Canopy-CLC-A'][0])
          .first(),
      ).toBeVisible({ timeout: 30_000 });

      // --- Plan + attachment are accessible again on the restored worktree -
      await expectPlanAndAttachmentCards(window);
      // The restored plan opens in its Plan panel with its full content.
      await window.getByTestId(`activity-plan-row-${PLAN_ID}`).click();
      const planPanel = planDocumentPanel(window, PLAN_ID);
      await expect(planPanel).toBeVisible({ timeout: 15_000 });
      await expect(planPanel).toContainText(PLAN_BODY);
      await closePanelTab(window, planPanelId(PLAN_ID));
      await expect(planPanel).toHaveCount(0, { timeout: 15_000 });
      // Opening the plan beside the chat collapsed the activity rail; restore
      // the default surface for the resume legs below.
      await expandDefaultActivityRail(window, { optional: true });

      // --- Resume the restored live chat with a NEW provider turn ---------
      await sendLiveTurn(window, 'Canopy-CLC-A', SCENARIOS['Canopy-CLC-A'][1]);

      // --- Restore the per-chat archived chat and resume it too -----------
      await restoreArchivedChat(window, chatC);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${chatC}`),
      ).toBeVisible({ timeout: 15_000 });
      await window.getByTestId(`panel-tab-panel-chat-${chatC}`).click();
      await expect(
        chatPanelLocator(window)
          .getByText(SCENARIOS['Canopy-CLC-C'][0])
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await sendLiveTurn(window, 'Canopy-CLC-C', SCENARIOS['Canopy-CLC-C'][1]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // Archive and Delete are withheld while a chat turn runs. The shared
  // sidebar reads that from the session snapshot's `isStreaming` as well as
  // the live chat store, so a snapshot rebuilt mid-turn (a branch rename or
  // PR status write) must go stale again when the turn ends. Without a portal
  // session nothing staled it, and both actions stayed disabled after the
  // turn until some unrelated write rebuilt the snapshot.
  test('Archive and Delete come back as soon as a live chat turn ends', async () => {
    test.setTimeout(180_000);
    const marker = 'Canopy-CLC-TURNEND';
    const firstReply = 'Turn-end first reply from the mock provider';
    const slowReply = 'Turn-end slow reply from the mock provider';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-lifecycle-turn-end-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 'chat-a', title: 'Chat A' }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          { text: firstReply, stopReason: 'end_turn' },
          // Long enough to open the menu and rebuild the snapshot mid-turn.
          { text: slowReply, stopReason: 'end_turn', streamMs: 6_000 },
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
      await app.selectWorktree(WORKTREE_BRANCH);
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      const rowSpinner = row.getByTestId(
        'worktree-row-classic-streaming-spinner',
      );

      // The first turn of a new chat renames the branch. Wait for that write
      // to reach the rail so it cannot be what refreshes the snapshot later.
      await sendLiveTurn(window, marker, firstReply);
      await expect(row).not.toHaveAttribute('data-branch', WORKTREE_BRANCH, {
        timeout: 60_000,
      });
      await expect(rowSpinner).toHaveCount(0, { timeout: 15_000 });

      const chatPanel = chatPanelLocator(window);
      const composer = chatPanel.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${marker}] Keep going slowly.`);
      await chatPanel.getByRole('button', { name: 'Send message' }).click();
      await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
        timeout: 30_000,
      });
      // An unrelated write rebuilds the snapshot while the turn runs. The stop
      // control shows before main starts the turn, so rebuild until the
      // snapshot has seen it.
      await expect(async () => {
        await window.evaluate(() =>
          window.api.invalidateDesktopSessionSnapshot(),
        );
        await expect(rowSpinner).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });

      await expect(chatPanel.getByText(slowReply).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        chatPanel.getByRole('button', { name: 'Send message' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(rowSpinner).toHaveCount(0, { timeout: 15_000 });
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      await expect(
        window.getByTestId('worktree-actions-menu-archive'),
      ).toBeEnabled({ timeout: 15_000 });
      await expect(
        window.getByTestId('worktree-actions-menu-delete'),
      ).toBeEnabled();
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('offers Delete and confirms Archive for a done worktree with a legacy retention-off setting', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-hard-delete-lock-toggle-'),
    );
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    seedPreferences(userDataDir);
    expect(seeded.workspaces.some((entry) => entry.id === WORKSPACE_ID)).toBe(
      true,
    );
    const workspaceConfigPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'workspace.json',
    );
    const workspaceConfig = JSON.parse(
      readFileSync(workspaceConfigPath, 'utf8'),
    );
    workspaceConfig.archiveRetentionDays = null;
    writeFileSync(
      workspaceConfigPath,
      `${JSON.stringify(workspaceConfig, null, 2)}\n`,
      'utf8',
    );
    const worktreesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees.json',
    );
    const worktreesConfig = JSON.parse(readFileSync(worktreesPath, 'utf8'));
    worktreesConfig.worktrees = worktreesConfig.worktrees.map((worktree) =>
      worktree.id === WORKTREE_ID ? { ...worktree, status: 'done' } : worktree,
    );
    writeFileSync(
      worktreesPath,
      `${JSON.stringify(worktreesConfig, null, 2)}\n`,
      'utf8',
    );

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      // A done worktree takes the immediate-delete path. Archive must still
      // require confirmation because it is a durable state choice.
      await window.getByTestId('worktree-actions-menu-archive').click();
      const archiveDialog = window.getByRole('dialog', {
        name: /^Archive worktree/,
      });
      await expect(archiveDialog).toBeVisible();
      await expect(archiveDialog).toContainText('until you delete the archive');
      await archiveDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(archiveDialog).toHaveCount(0);

      await row.hover();
      await window.getByTestId('worktree-actions-menu-button').click();
      // Legacy `null` retention resolves to the default window. A done
      // worktree still takes the immediate Delete path into that retention.
      await window.getByTestId('worktree-actions-menu-delete').click();
      await expect(row).toHaveCount(0, { timeout: 60_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const cloneScenario of ['none', 'temporary', 'configured-collision']) {
    const temporaryClone = cloneScenario !== 'none';
    const configuredCollision = cloneScenario === 'configured-collision';
    test(`source-backed multi-repo root and child Git state survive archive and restore${temporaryClone ? ' with a temporary clone' : ''}${configuredCollision ? ' and a newly configured repository collision' : ''}`, async () => {
      test.setTimeout(240_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-lifecycle-multi-repo-'),
      );
      const seeded = seedDemoWorkspaces({
        userDataDir,
        apps: ['multi-repo-fullstack'],
      });
      seedPreferences(userDataDir);
      const workspace = seeded.workspaces[0];
      const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
      const config = JSON.parse(
        readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
      );
      const child = config.repos[0];
      const childWorktreePath = path.join(
        workspace.worktreePath,
        'repos',
        child.id,
      );

      // The raw demo source root intentionally fails the app's validation.
      // Bring `main` to the shape the workspace creator writes, then advance the
      // seeded branch before adding archive state so restore does not detour to
      // the unrelated needs-repair flow.
      appendFileSync(
        path.join(config.sourceRepoPath, '.gitignore'),
        '\n# Nested project repositories\nrepos/\n',
      );
      writeFileSync(
        path.join(config.sourceRepoPath, 'CLAUDE.md'),
        '# Project instructions\n',
      );
      symlinkSync('CLAUDE.md', path.join(config.sourceRepoPath, 'AGENTS.md'));
      runGit(config.sourceRepoPath, ['add', '-A']);
      runGit(config.sourceRepoPath, ['commit', '-m', 'validate project root']);
      runGit(workspace.worktreePath, ['reset', '--hard', 'main']);

      writeFileSync(
        path.join(workspace.worktreePath, 'archive-root-staged.txt'),
        'root staged\n',
      );
      runGit(workspace.worktreePath, ['add', 'archive-root-staged.txt']);
      writeFileSync(
        path.join(workspace.worktreePath, 'archive-root-untracked.txt'),
        'root untracked\n',
      );
      writeFileSync(
        path.join(childWorktreePath, 'archive-child-both.txt'),
        'child staged\n',
      );
      runGit(childWorktreePath, ['add', 'archive-child-both.txt']);
      writeFileSync(
        path.join(childWorktreePath, 'archive-child-both.txt'),
        'child working\n',
      );

      const clonePath = path.join(workspace.worktreePath, 'repos', 'temporary');
      let cloneHead;
      let cloneStatus;
      if (temporaryClone) {
        const thirdReference = path.join(userDataDir, 'third-reference');
        runGit(workspace.worktreePath, [
          'clone',
          '--no-hardlinks',
          child.repoPath,
          thirdReference,
        ]);
        runGit(thirdReference, [
          'worktree',
          'add',
          '-b',
          WORKTREE_BRANCH,
          path.join(workspace.worktreePath, 'repos', 'third'),
          'main',
        ]);
        config.repos.push({
          id: 'third',
          name: 'Third',
          repoPath: thirdReference,
        });
        writeFileSync(
          path.join(workspaceDir, 'workspace.json'),
          JSON.stringify(config),
        );
        expect(config.repos).toHaveLength(3);
        runGit(workspace.worktreePath, [
          'clone',
          '--no-hardlinks',
          child.repoPath,
          clonePath,
        ]);
        writeFileSync(
          path.join(clonePath, 'local-only.txt'),
          'local-only commit\n',
        );
        appendFileSync(
          path.join(clonePath, '.gitignore'),
          '\nprivate-cache.txt\n',
        );
        runGit(clonePath, ['add', '.']);
        runGit(clonePath, [
          '-c',
          'user.name=E2E',
          '-c',
          'user.email=e2e@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          'Temporary clone local work',
        ]);
        cloneHead = runGit(clonePath, ['rev-parse', 'HEAD']);
        writeFileSync(
          path.join(clonePath, 'local-only.txt'),
          'staged clone work\n',
        );
        runGit(clonePath, ['add', 'local-only.txt']);
        writeFileSync(
          path.join(clonePath, 'local-only.txt'),
          'unstaged clone work\n',
        );
        writeFileSync(
          path.join(clonePath, 'untracked.txt'),
          'untracked clone work\n',
        );
        writeFileSync(
          path.join(clonePath, 'private-cache.txt'),
          'ignored clone work\n',
        );
        cloneStatus = runGitRaw(clonePath, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ]);
      }

      const rootHead = runGit(workspace.worktreePath, ['rev-parse', 'HEAD']);
      const childHead = runGit(childWorktreePath, ['rev-parse', 'HEAD']);
      const rootStatus = runGitRaw(workspace.worktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      const childStatus = runGitRaw(childWorktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);

      const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();

        const row = window.locator(
          `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
        );
        await row.hover();
        await window.getByTestId('worktree-actions-menu-button').click();
        await window.getByTestId('worktree-actions-menu-archive').click();
        const confirmDialog = window.getByRole('dialog', {
          name: /^Archive worktree/,
        });
        await expect(confirmDialog).toBeVisible();
        const branchChoice = confirmDialog.getByTestId(
          'worktree-removal-preserve-branch',
        );
        await expect(branchChoice).toBeEnabled({ timeout: 60_000 });
        await branchChoice.click();
        await expect(row).toHaveCount(0, { timeout: 60_000 });

        await expect
          .poll(
            () => {
              try {
                return JSON.parse(
                  readFileSync(
                    path.join(workspaceDir, 'worktrees.json'),
                    'utf8',
                  ),
                ).worktrees;
              } catch {
                return undefined;
              }
            },
            { timeout: 60_000 },
          )
          .toHaveLength(0);

        await window.reload();
        await app.waitForShell({ timeout: 30_000 });
        await expect(row).toHaveCount(0);
        if (temporaryClone) {
          const archivedClone = path.join(
            workspaceDir,
            'archived-containers',
            WORKTREE_ID,
            'workspace-root',
            'repos',
            'temporary',
          );
          expect(runGit(archivedClone, ['rev-parse', 'HEAD'])).toBe(cloneHead);
          expect(
            readFileSync(path.join(archivedClone, 'private-cache.txt'), 'utf8'),
          ).toBe('ignored clone work\n');
        }

        const archivedLink = window
          .locator('[data-testid$="-archived-link"]')
          .filter({ hasText: /^Archived and deleted 1$/ })
          .first();
        await expect(archivedLink).toBeVisible({ timeout: 60_000 });
        await archivedLink.click();
        await expect(
          window.getByTestId(`archived-overview-row-${WORKTREE_ID}`),
        ).toBeVisible({ timeout: 60_000 });
        await window
          .getByTestId(`archived-overview-open-${WORKTREE_ID}`)
          .click();
        const viewer = window.getByTestId('archived-container-view');
        await viewer.getByTestId('archived-container-tab-changes').click();
        await expect(
          viewer.getByTestId(
            'diff-file-tree-row-__workspace_root__:archive-root-staged.txt',
          ),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          viewer.getByTestId(
            `diff-file-tree-row-${child.id}:archive-child-both.txt`,
          ),
        ).toBeVisible({ timeout: 30_000 });

        for (const repository of [
          { path: config.sourceRepoPath, head: rootHead },
          { path: child.repoPath, head: childHead },
        ]) {
          try {
            runGit(repository.path, [
              'show-ref',
              '--verify',
              '--quiet',
              `refs/heads/${WORKTREE_BRANCH}`,
            ]);
          } catch {
            runGit(repository.path, [
              'branch',
              WORKTREE_BRANCH,
              repository.head,
            ]);
          }
        }

        let collisionReference;
        if (configuredCollision) {
          collisionReference = path.join(userDataDir, 'collision-reference');
          runGit(child.repoPath, [
            'clone',
            '--no-hardlinks',
            child.repoPath,
            collisionReference,
          ]);
          config.repos.push({
            id: 'temporary',
            name: 'Newly configured',
            repoPath: collisionReference,
          });
          writeFileSync(
            path.join(workspaceDir, 'workspace.json'),
            JSON.stringify(config),
          );
        }

        const restoreResponse = await window.evaluate(
          ({ projectId, containerId }) =>
            window.api.archivedContainers.restore({ projectId, containerId }),
          { projectId: workspace.id, containerId: WORKTREE_ID },
        );
        const restoredWorktrees = JSON.parse(
          readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
        ).worktrees.filter((worktree) => worktree.id !== WORKTREE_ID);
        expect(restoredWorktrees).toHaveLength(1);
        expect(restoreResponse).toMatchObject({
          kind: 'worktree',
          restoredWorktreeId: restoredWorktrees[0].id,
        });
        const restoredRoot = path.join(
          workspaceDir,
          'worktrees',
          restoredWorktrees[0].id,
        );
        const restoredChild = path.join(restoredRoot, 'repos', child.id);
        expect(runGit(restoredRoot, ['rev-parse', 'HEAD'])).toBe(rootHead);
        expect(runGit(restoredChild, ['rev-parse', 'HEAD'])).toBe(childHead);
        expect(
          runGitRaw(restoredRoot, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ]),
        ).toEqual(rootStatus);
        expect(
          runGitRaw(restoredChild, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ]),
        ).toEqual(childStatus);
        expect(
          readFileSync(
            path.join(restoredRoot, 'archive-root-untracked.txt'),
            'utf8',
          ),
        ).toBe('root untracked\n');
        expect(
          readFileSync(
            path.join(restoredChild, 'archive-child-both.txt'),
            'utf8',
          ),
        ).toBe('child working\n');
        if (temporaryClone) {
          const restoredClone = path.join(
            restoredRoot,
            'repos',
            configuredCollision ? 'temporary-archived' : 'temporary',
          );
          if (configuredCollision) {
            const configuredCheckout = path.join(
              restoredRoot,
              'repos',
              'temporary',
            );
            expect(runGit(configuredCheckout, ['rev-parse', 'HEAD'])).toBe(
              runGit(collisionReference, ['rev-parse', 'main']),
            );
            expect(
              runGit(configuredCheckout, ['status', '--porcelain=v1']),
            ).toBe('');
            expect(
              readFileSync(path.join(configuredCheckout, '.git'), 'utf8'),
            ).toMatch(/^gitdir:/);
            expect(restoreResponse.warnings).toContain(
              'Restored archived repository repos/temporary to repos/temporary-archived because its original path is already in use.',
            );
          }
          expect(runGit(restoredClone, ['rev-parse', 'HEAD'])).toBe(cloneHead);
          expect(
            runGitRaw(restoredClone, [
              'status',
              '--porcelain=v1',
              '-z',
              '--untracked-files=all',
            ]),
          ).toEqual(cloneStatus);
          expect(
            readFileSync(path.join(restoredClone, 'private-cache.txt'), 'utf8'),
          ).toBe('ignored clone work\n');
          expect(
            readFileSync(path.join(restoredClone, 'untracked.txt'), 'utf8'),
          ).toBe('untracked clone work\n');
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('cowork: work entry chats survive archive, restore, and resume live', async ({}, testInfo) => {
    test.setTimeout(420_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-lifecycle-cowork-'),
    );
    seedPreferences(userDataDir);
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
          name: COWORK_WORKSPACE_NAME,
          type: 'cowork',
          color: '#7C9B6D',
          collapsed: false,
          order: 0,
          cowork: { createdAt: new Date().toISOString() },
        },
      ],
    });
    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { createdAt: new Date().toISOString() },
    });
    writeJson(path.join(workspaceDir, 'work-entries.json'), {
      version: 1,
      entries: [],
    });
    await registerMarkers(['Canopy-CLCW-A', 'Canopy-CLCW-B']);

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // --- Create the Work Entry through the UI ---------------------------
      const workspaceToggle = window.getByTestId(
        `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
      );
      await expect(workspaceToggle).toBeVisible();
      if ((await workspaceToggle.getAttribute('aria-expanded')) !== 'true') {
        await workspaceToggle.click();
      }
      const homePage = await app.openHomeForProject(COWORK_WORKSPACE_ID);
      await expect(homePage.getByTestId('home-workspace-select')).toContainText(
        COWORK_WORKSPACE_NAME,
      );
      const chatIdsBeforeHomeSend = new Set(await chatTabIds(window));
      await window.evaluate(() => {
        window.__coworkLifecycleEvents = [];
        window.api.chat.onStateChanged((event) =>
          window.__coworkLifecycleEvents.push(event),
        );
      });
      const firstMessage = '[Canopy-CLCW-A] Continue the lifecycle test.';
      const homeComposer = homePage.getByTestId('home-composer-editor');
      await homeComposer.click();
      await homeComposer.fill(firstMessage);
      await homePage.getByTestId('home-send-button').click();
      await expect(homePage).toHaveCount(0);

      const firstChatPanel = chatPanelLocator(window);
      await expect(firstChatPanel).toBeVisible({ timeout: 30_000 });
      try {
        await expect(
          firstChatPanel.getByText(firstMessage).first(),
        ).toBeVisible({
          timeout: 30_000,
        });
      } catch (error) {
        await testInfo.attach('home-cowork-state-events', {
          body: JSON.stringify(
            await window.evaluate(() => window.__coworkLifecycleEvents),
            null,
            2,
          ),
          contentType: 'application/json',
        });
        throw error;
      }
      await expect(
        firstChatPanel.getByText(SCENARIOS['Canopy-CLCW-A'][0]).first(),
      ).toBeVisible({ timeout: 90_000 });
      let chatA = null;
      await expect
        .poll(async () => {
          chatA =
            (await chatTabIds(window)).find(
              (chatId) => !chatIdsBeforeHomeSend.has(chatId),
            ) ?? null;
          return chatA;
        })
        .not.toBeNull();

      const entryRows = window.locator(
        '[data-testid^="sidebar-work-entry-"][data-standalone-chat-id]',
      );
      await expect(entryRows.first()).toBeVisible({ timeout: 15_000 });
      const entryId = (
        await entryRows.first().getAttribute('data-testid')
      ).replace('sidebar-work-entry-', '');

      // --- Multiple chats with real provider turns ------------------------
      // The Home send above created the Work Entry and its first live chat.
      const chatB = await createChatTab(window);
      await sendLiveTurn(
        window,
        'Canopy-CLCW-B',
        SCENARIOS['Canopy-CLCW-B'][0],
      );

      // --- Archive one chat (close-with-archive) --------------------------
      await archiveChatTab(window, chatB);

      // --- Archive the work entry (kept until deleted) --------------------
      const entryRow = window.getByTestId(`sidebar-work-entry-${entryId}`);
      await entryRow.hover();
      await window.getByTestId(`sidebar-work-entry-${entryId}-menu`).click();
      // Delete (destructive, retention window) and Archive (neutral, kept
      // until deleted) are separate items; this leg archives.
      const deleteItem = window.getByTestId(
        `sidebar-work-entry-${entryId}-delete`,
      );
      await expect(deleteItem).toHaveText('Delete');
      await expect(deleteItem).not.toHaveClass(/fg-destructive/);
      const archiveItem = window.getByTestId(
        `sidebar-work-entry-${entryId}-archive`,
      );
      await expect(archiveItem).toHaveText('Archive');
      await expect(archiveItem).not.toHaveClass(/fg-destructive/);
      await archiveItem.click();
      await window
        .getByTestId(`sidebar-work-entry-${entryId}-delete-dialog`)
        .getByTestId(`sidebar-work-entry-${entryId}-confirm-delete`)
        .click();
      await expect(entryRow).toHaveCount(0, { timeout: 30_000 });

      // --- Verify the archive viewer: chats only, in full ------------------
      const archivedLink = window.getByTestId(
        `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-archived-link`,
      );
      await expect(archivedLink).toBeVisible({ timeout: 15_000 });
      await archivedLink.click();
      await window.getByTestId(`archived-overview-open-${entryId}`).click();
      const viewer = window.getByTestId('archived-container-view');
      await expect(viewer).toBeVisible();
      // Work-entry containers are chats-only: no Chats/Pipelines tab bar.
      await expect(
        viewer.getByTestId('archived-container-tab-pipelines'),
      ).toHaveCount(0);

      await collectViewerTranscripts(
        window,
        viewer,
        [SCENARIOS['Canopy-CLCW-A'][0], SCENARIOS['Canopy-CLCW-B'][0]],
        {
          // Reusing an otherwise empty Work entry preserves its existing blank
          // chat so unsent drafts and settings are not discarded.
          allowedEmptyChatLabels: ['New Chat'],
        },
      );
      await expect(
        viewer.getByTestId('archived-inner-chats-toggle'),
      ).toContainText('Archived (1)');

      // --- Restore ---------------------------------------------------------
      await viewer.getByTestId('archived-restore').click();
      await expect(viewer).toHaveCount(0, { timeout: 30_000 });
      const restoredEntryRow = window.locator(
        '[data-testid^="sidebar-work-entry-"][data-standalone-chat-id]',
      );
      await expect(restoredEntryRow.first()).toBeVisible({ timeout: 30_000 });

      // --- Verify the restored surface + resume ----------------------------
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${chatA}`),
      ).toBeVisible({ timeout: 30_000 });
      await window.getByTestId(`panel-tab-panel-chat-${chatA}`).click();
      await expect(
        chatPanelLocator(window)
          .getByText(SCENARIOS['Canopy-CLCW-A'][0])
          .first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        window.getByText('This session has been archived', { exact: false }),
      ).toHaveCount(0);
      await sendLiveTurn(
        window,
        'Canopy-CLCW-A',
        SCENARIOS['Canopy-CLCW-A'][1],
      );

      // --- Restore the per-chat archived chat and resume it too ------------
      await restoreArchivedChat(window, chatB);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${chatB}`),
      ).toBeVisible({ timeout: 15_000 });
      await window.getByTestId(`panel-tab-panel-chat-${chatB}`).click();
      await expect(
        chatPanelLocator(window)
          .getByText(SCENARIOS['Canopy-CLCW-B'][0])
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await sendLiveTurn(
        window,
        'Canopy-CLCW-B',
        SCENARIOS['Canopy-CLCW-B'][1],
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
