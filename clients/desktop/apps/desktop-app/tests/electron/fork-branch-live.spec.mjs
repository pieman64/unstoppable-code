import { runBranchOwnerFlow } from './branch-owner.scenario.mjs';
import { runSplitAgentFailure } from './split-agent-failure.scenario.mjs';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  getScenarioActivity,
  seedCoworkWorkspace,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  chatPanelLocator,
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
} from './panelHarness.mjs';

// Doc 2 — Spec 14 (LIVE) — `fork-branch-live.spec.mjs` (PR 743).
test('failed StartForkedAgent removes the new tab and preserves the original chat across reload', async () => {
  test.setTimeout(180_000);
  await runSplitAgentFailure();
});
test('failed initial setup-queued StartBranchedAgent closes only its child and permits retry', async () => {
  test.setTimeout(180_000);
  await runSplitAgentFailure({ branched: true });
});
//
// PR 743 added the per-turn Fork / Branch actions rendered by the desktop
// `TurnTimer` (`apps/desktop-app/src/renderer/src/components/chat/TurnTimer.tsx`)
// on the last forkable, completed turn group:
//   - "Fork Chat"  (aria-label="Fork Chat") — renderer-only; duplicates the
//     conversation into a new chat tab, no agent involved.
//   - "Branch Chat into new worktree" (aria-label="Branch Chat into new
//     worktree") — creates a new worktree; the focused branch scenarios below
//     complete that flow and verify canonical persistence across reload.
//
// FORKABLE-TURN MODEL (verified against the renderer):
//   `findLastForkableTurnGroupIndex` (incremental-turn-groups.ts) picks the
//   latest turn group that is `isComplete` (its `turn_timer` block has a
//   non-null `completedAt`) and has real assistant content. Only that group
//   renders the Fork / Branch buttons (`TurnGroupRenderer.tsx` →
//   `showForkAction`). `canBranch` additionally requires a real worktree
//   (non-standalone), which the `demo-ts-pnpm-vite` / `demo-main` fixture is.
//
// LIVE COMPOSITION (why this is the LIVE spec, not a seeded-only one):
//   The first, forkable turn is SEEDED so the Fork/Branch buttons are present
//   from launch (a completed user→assistant→turn_timer triple). Then a REAL
//   Claude turn is driven against the shared mock provider via the
//   `[Canopy-CFORKLIVE]` marker (same provider seam as
//   `chat-live-turn.spec.mjs`: composer send → chatStore.sendMessage IPC →
//   bundled `claude` binary pointed at the mock → scripted reply streams back
//   and renders). The assertion is that the Fork / Branch actions remain
//   reachable across a live turn and that clicking Fork (renderer-only) adds a
//   chat tab — proving the PR 743 fork/branch surface works in a live session,
//   not just from static seeded state.
//
//   `hasStartedSession: true` is seeded WITHOUT an `sdkSessionId` so the live
//   turn starts a fresh Claude session (no resume of a non-existent thread)
//   while still suppressing the first-message branch-naming prompt.
//
// See `chat-live-turn.spec.mjs` for the env-hygiene / prereq rationale.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CFORKLIVE';
const SEEDED_PRIOR_REPLY = 'Prior seeded assistant reply for the fork spec';
const LIVE_REPLY = 'Live forkable reply from the deterministic Canopy mock';

const PRIOR_TURN_STARTED_AT = Date.parse('2026-04-10T12:00:00.000Z');
const PRIOR_TURN_COMPLETED_AT = PRIOR_TURN_STARTED_AT + 5_000;
const CANONICAL_HISTORY_MARKER = 'History older than the renderer page';
const OVERSIZED_BRANCH_OUTPUT = 'branch artifact closure\n'.repeat(5_000);

async function chatGroupPanels(window) {
  const layout = await getLayout(window);
  const leaf = collectLeaves(layout.root).find(
    (node) => node.groupId === DEFAULT_GROUP_IDS.chat,
  );
  return leaf?.panels ?? [];
}

test.describe('fork / branch live turn (743)', () => {
  test('a popped-out chat branches its owner and keeps child sends and source Stop separate', async () => {
    test.setTimeout(180_000);
    await runBranchOwnerFlow();
  });

  test('a main-window branch routes its first send to the child and keeps the original stoppable', async () => {
    test.setTimeout(180_000);
    await runBranchOwnerFlow({ popOut: false });
  });

  for (const mode of ['full-access', 'ask']) {
    test(`Branch Chat preserves ${mode} through canonical reload`, async () => {
      test.setTimeout(90_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'branch-approval-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      const preferencesPath = path.join(userDataDir, 'preferences.json');
      const preferences = {
        version: 1,
        preferences: { onboardingCompleted: ['v1'] },
      };
      preferences.preferences.approvalDefaults = {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      };
      writeFileSync(preferencesPath, JSON.stringify(preferences));
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          {
            id: 'approval-source',
            title: 'Approval source',
            customTitle: 'User-owned source name',
            approvalMode: mode,
            hasStartedSession: true,
            messages: [
              {
                id: 'approval-user',
                role: 'user',
                timestamp: PRIOR_TURN_STARTED_AT,
                blocks: [
                  {
                    type: 'text',
                    text: 'Keep my approval setting when branching.',
                  },
                ],
              },
              {
                id: 'approval-assistant',
                role: 'assistant',
                timestamp: PRIOR_TURN_STARTED_AT + 1000,
                blocks: [{ type: 'text', text: 'Ready to branch.' }],
              },
              {
                id: 'approval-timer',
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
      const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);
        const modeLabel = mode === 'full-access' ? 'Full access' : 'Ask';
        const sourceState = await window.evaluate(
          (target) => window.api.chat.getState(target),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        expect(sourceState.tabsFile.tabs[0].customTitle).toBe(
          'User-owned source name',
        );
        await expect(
          window.getByTestId('approval-mode-picker'),
        ).toHaveAttribute(
          'aria-label',
          `Tool approval mode, current mode ${modeLabel}`,
        );
        await window.getByTestId('turn-more-actions').last().click();
        await window.getByTestId('turn-more-branch').click();
        const selected = window
          .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
          .first();
        await expect(selected).not.toHaveAttribute(
          'data-worktree-id',
          WORKTREE_ID,
        );
        const branchedId = await selected.getAttribute('data-worktree-id');
        expect(branchedId).toBeTruthy();
        const scope = { projectId: WORKSPACE_ID, worktreeId: branchedId };
        const branchState = await window.evaluate(
          (target) => window.api.chat.getState(target),
          scope,
        );
        const child = branchState.tabsFile.tabs.find(
          (tab) => tab.forkedFrom?.chatId === 'approval-source',
        );
        expect(child?.approvalMode).toBe(mode);
        expect(child).not.toHaveProperty('customTitle');
        await window.reload();
        await app.waitForShell();
        await app.openMainPage();
        await window
          .locator(
            `[data-testid="worktree-row"][data-worktree-id="${branchedId}"]`,
          )
          .click();
        await expect(
          window.getByTestId('approval-mode-picker'),
        ).toHaveAttribute(
          'aria-label',
          `Tool approval mode, current mode ${modeLabel}`,
        );
        const reloaded = await window.evaluate(
          (target) => window.api.chat.getState(target),
          scope,
        );
        expect(
          reloaded.tabsFile.tabs.find((tab) => tab.id === child.id)
            ?.approvalMode,
        ).toBe(mode);
        expect(
          reloaded.tabsFile.tabs.find((tab) => tab.id === child.id),
        ).not.toHaveProperty('customTitle');
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('Branch Chat waits for an in-flight approval downgrade', async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'branch-approval-transition-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const preferencesPath = path.join(userDataDir, 'preferences.json');
    writeFileSync(
      preferencesPath,
      JSON.stringify({
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          approvalDefaults: {
            worktree: 'full-access',
            cowork: 'full-access',
            appAdvisor: 'full-access',
          },
        },
      }),
    );
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'approval-transition-source',
          title: 'Approval transition source',
          approvalMode: 'full-access',
          hasStartedSession: true,
          messages: [
            {
              id: 'transition-user',
              role: 'user',
              timestamp: PRIOR_TURN_STARTED_AT,
              blocks: [
                {
                  type: 'text',
                  text: 'Branch only after my approval change settles.',
                },
              ],
            },
            {
              id: 'transition-assistant',
              role: 'assistant',
              timestamp: PRIOR_TURN_STARTED_AT + 1000,
              blocks: [{ type: 'text', text: 'Ready to branch safely.' }],
            },
            {
              id: 'transition-timer',
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

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const picker = window.getByTestId('approval-mode-picker');
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Full access',
      );
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('approval:mode-set');
        if (!original) throw new Error('Missing approval mode handler');
        const held = new Promise((resolve) => {
          globalThis.__releaseBranchApproval = resolve;
        });
        ipcMain.removeHandler('approval:mode-set');
        ipcMain.handle('approval:mode-set', async (event, request) => {
          globalThis.__branchApprovalHeld = true;
          await held;
          return original(event, request);
        });
      });
      await picker.click();
      await window.getByTestId('approval-mode-option-ask').click();
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__branchApprovalHeld))
        .toBe(true);
      // Hold the real approval IPC until Branch has been invoked through its
      // menu. This preserves the pending-transition race across menu renders.
      await window.getByTestId('turn-more-actions').last().click();
      await window.getByTestId('turn-more-branch').click();
      await electronApp.evaluate(() => globalThis.__releaseBranchApproval());

      const selected = window
        .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
        .first();
      await expect(selected).not.toHaveAttribute(
        'data-worktree-id',
        WORKTREE_ID,
      );
      const branchedId = await selected.getAttribute('data-worktree-id');
      expect(branchedId).toBeTruthy();
      const scope = { projectId: WORKSPACE_ID, worktreeId: branchedId };
      await expect(picker).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
      );
      const branchState = await window.evaluate(
        (target) => window.api.chat.getState(target),
        scope,
      );
      expect(
        branchState.tabsFile.tabs.find(
          (tab) => tab.forkedFrom?.chatId === 'approval-transition-source',
        )?.approvalMode,
      ).toBe('ask');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Branch Chat can commit first without leaking an idle local Commit action', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-branch-chat-commit-first-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = demoSeed.workspaces[0];
    const repoPath = workspace?.repoPath;
    const worktreePath = workspace?.worktreePath;
    expect(repoPath, 'seeded source repo path').toBeTruthy();
    expect(worktreePath, 'seeded worktree path').toBeTruthy();

    // A local bare origin makes this a remote-enabled repo without introducing
    // network access. The idle status-bar action must stay remote-aware.
    const bareOriginPath = path.join(userDataDir, 'branch-chat-origin.git');
    execFileSync('git', ['init', '--bare', bareOriginPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync(
      'git',
      ['-C', repoPath, 'remote', 'add', 'origin', bareOriginPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const dirtyFileName = 'CANOPY_E2E_BRANCH_CHAT_DIRTY.txt';
    writeFileSync(
      path.join(worktreePath, dirtyFileName),
      'commit this before branching the chat\n',
      'utf8',
    );

    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'branch-source-chat',
          title: 'Branch source',
          hasStartedSession: true,
          messages: [
            ...Array.from({ length: 510 }, (_, index) => ({
              id: `branch-history-${index}`,
              role: index === 1 ? 'assistant' : 'system',
              blocks:
                index === 0
                  ? [{ type: 'text', text: CANONICAL_HISTORY_MARKER }]
                  : index === 1
                    ? [
                        {
                          type: 'tool_result',
                          toolUseId: 'branch-large-output',
                          toolName: 'shell',
                          output: OVERSIZED_BRANCH_OUTPUT,
                          isError: false,
                        },
                      ]
                    : [{ type: 'text', text: `Historical note ${index}` }],
              timestamp: PRIOR_TURN_STARTED_AT - (511 - index) * 1_000,
            })),
            {
              id: 'branch-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prepare this branch.' }],
              timestamp: PRIOR_TURN_STARTED_AT,
            },
            {
              id: 'branch-assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: SEEDED_PRIOR_REPLY }],
              timestamp: PRIOR_TURN_STARTED_AT + 2_000,
            },
            {
              // Main-owned V2 storage mints transcript anchors in this
              // composite form. Keep the branch flow realistic so IPC cannot
              // accidentally regress to repository entity-id validation.
              id: 'branch-source-chat:mutation-1:513',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: PRIOR_TURN_STARTED_AT,
                  completedAt: PRIOR_TURN_COMPLETED_AT,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 3_000,
            },
          ],
        },
      ],
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
      await expect(window.getByText(SEEDED_PRIOR_REPLY).first()).toBeVisible({
        timeout: 30_000,
      });

      const prBar = window.getByTestId('pr-status-bar');
      const remoteAction = prBar.getByTestId('pr-status-bar-primary-action');
      // Visible copy is always the short outcome; the commit+push the click
      // also performs is carried by the accessible name.
      // #2441 (dea4ad40cd) made the label responsive: `CreatePrLabel` keeps
      // BOTH the compact ("PR") and full ("Create PR") strings in the DOM
      // and swaps them via a container query — the component doc says
      // "automation can find either". `toHaveText` reads textContent
      // (display:none included), so accept the optional compact prefix while
      // still rejecting the long "Commit, push & create PR" copy leaking
      // into the visible label.
      await expect(remoteAction).toHaveText(/^(?:\d+ PRs|PR)?Create PR$/, {
        timeout: 30_000,
      });
      await expect(remoteAction).toHaveAttribute(
        'aria-label',
        'Commit, push & create PR',
      );
      await expect(prBar.getByTestId('pr-status-bar-local-commit')).toHaveCount(
        0,
      );

      const rows = window.getByTestId('worktree-row');
      const rowCountBefore = await rows.count();
      await window.getByTestId('turn-more-actions').last().click();
      await window.getByTestId('turn-more-branch').click();

      const warning = window.getByTestId('branch-from-uncommitted-warning');
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Continue' }).click();
      await window.getByRole('menuitem', { name: 'Commit first' }).click();

      // The existing commit-only progress button is intentionally visible
      // while this explicit operation is active, even though the repo has an
      // origin. Its visible label stays compact while the tooltip exposes the
      // local commit phases.
      const activeCommit = prBar.getByTestId('pr-status-bar-local-commit');
      await expect(activeCommit).toBeVisible({ timeout: 90_000 });
      // #2441 (dea4ad40cd) deliberately stopped swapping this button's LABEL
      // to the running phase: it removed the
      // `gitStatsRefreshing ? 'Refreshing…' : getCommitPushPhaseLabel(...)`
      // branch in favour of a static 'Commit', because (quoting the sibling
      // BranchSyncButton it now matches) "the label stays put while the action
      // runs — only the leading icon becomes a spinner. Swapping to
      // 'Pushing…'/'Refreshing…' made the control appear to change identity
      // mid-click." The phases moved to the tooltip, asserted just below.
      // Wait on the app-emitted running state instead: the button only carries
      // aria-label="Cancel commit" while the commit-only operation is active
      // (`localCommitCancellable` in PrStatusBar.tsx), so this still proves the
      // progress surface is live before the tooltip is opened.
      await expect(activeCommit).toHaveAttribute(
        'aria-label',
        'Cancel commit',
        { timeout: 90_000 },
      );
      await activeCommit.hover();
      const progressTooltip = window
        .getByRole('tooltip')
        .filter({ hasText: 'Generating message' });
      await expect(progressTooltip).toContainText('Staging');
      await expect(progressTooltip).toContainText('Committing');

      await expect
        .poll(async () => rows.count(), { timeout: 120_000 })
        .toBe(rowCountBefore + 1);
      const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
      const worktrees = JSON.parse(
        readFileSync(path.join(workspaceRoot, 'worktrees.json'), 'utf8'),
      ).worktrees;
      const branchedWorktree = worktrees.find(
        (candidate) => candidate.id !== WORKTREE_ID,
      );
      expect(branchedWorktree, 'branched worktree metadata').toBeTruthy();
      const targetRoot = path.join(
        workspaceRoot,
        'chat-storage-v2',
        branchedWorktree.id,
      );
      await expect
        .poll(
          () => {
            const liveIndexPath = path.join(targetRoot, 'live-index.json');
            if (!existsSync(liveIndexPath)) return 0;
            return JSON.parse(readFileSync(liveIndexPath, 'utf8')).tabs.length;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      const live = JSON.parse(
        readFileSync(path.join(targetRoot, 'live-index.json'), 'utf8'),
      );
      const targetChat = live.tabs[0];
      const targetMessages = readFileSync(
        path.join(targetRoot, 'transcripts', `${targetChat.id}.jsonl`),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(targetMessages).toHaveLength(513);
      expect(JSON.stringify(targetMessages[0])).toContain(
        CANONICAL_HISTORY_MARKER,
      );
      const largeBlock = targetMessages[1].blocks[0];
      expect(largeBlock.fullOutputRef).toBeTruthy();
      expect(
        existsSync(
          path.join(
            targetRoot,
            'transcripts',
            'tool-output',
            targetChat.id,
            `${largeBlock.fullOutputRef.artifactId}.txt`,
          ),
        ),
      ).toBe(true);
      const branchedId = await window
        .locator(
          `[data-testid="worktree-row"]:not([data-worktree-id="${WORKTREE_ID}"])`,
        )
        .last()
        .getAttribute('data-worktree-id');
      // Creation publishes the row before the branch seed is durable. The
      // branch action uses select:false and selects only after chat.create_tab
      // succeeds, so selection is the user-visible handoff completion point.
      await expect(
        window
          .locator('[data-sidebar-selected-item] [data-testid="worktree-row"]')
          .first(),
      ).toHaveAttribute('data-worktree-id', branchedId, { timeout: 30_000 });
      const branchState = await window.evaluate(
        async (scope) => window.api.chat.getState(scope),
        { projectId: WORKSPACE_ID, worktreeId: branchedId },
      );
      await test.info().attach('persisted-branch-state', {
        body: JSON.stringify(branchState, null, 2),
        contentType: 'application/json',
      });
      const branchChats = branchState.tabsFile.tabs.filter(
        (tab) => tab.kind !== 'file',
      );
      // The branch action owns the destination's initial chat. Background
      // hydration must not materialize a separate blank starter while the
      // branched transcript is being persisted.
      expect(branchChats).toHaveLength(1);
      await expect(
        window.locator('[role="tab"][data-panel-kind="chat"]'),
      ).toHaveCount(1);
      await expect(window.getByRole('tab', { name: 'New Chat' })).toHaveCount(
        0,
      );
      await expect(
        window.getByRole('button', { name: 'Forked from conversation' }),
      ).toBeVisible();
      for (const chat of branchChats) {
        const instruction = chat.pendingSystemInstructions?.find(
          (item) => item.id === 'worktree-relocation',
        );
        expect(instruction?.text).toContain('read-only reference');
        expect(instruction?.text).toContain(
          'Limit all changes to the new working directory',
        );
        expect(instruction?.text).toContain(worktreePath);
        expect(instruction?.text).toContain('Originating branch: "demo-main"');
        expect(instruction?.text).not.toContain('Follow-up instruction');
        expect(
          chat.pendingSystemInstructions?.some(
            (item) => item.id === 'independent-agent-start',
          ),
        ).toBe(false);
        expect(
          chat.messages.some((message) =>
            message.blocks.some(
              (block) =>
                block.type === 'text' &&
                block.text.includes('read-only reference'),
            ),
          ),
        ).toBe(false);
      }
      const status = execFileSync(
        'git',
        ['-C', worktreePath, 'status', '--short'],
        { encoding: 'utf8' },
      );
      expect(status.trim()).toBe('');
      const trackedDirtyFile = execFileSync(
        'git',
        ['-C', worktreePath, 'ls-files', '--error-unmatch', dirtyFileName],
        { encoding: 'utf8' },
      ).trim();
      expect(trackedDirtyFile).toBe(dirtyFileName);

      // Once the explicit commit ends, selecting the remote-enabled source
      // again must remove the local Commit button and restore remote actions.
      const sourceRow = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await sourceRow.click();
      await expect(
        window
          .getByTestId('pr-status-bar')
          .getByTestId('pr-status-bar-local-commit'),
      ).toHaveCount(0);
      const restoredRemoteAction = window.getByTestId(
        'pr-status-bar-primary-action',
      );
      await expect(restoredRemoteAction).toHaveAttribute(
        'aria-label',
        'Create PR',
      );
      // Same responsive `CreatePrLabel` as the earlier assertion in this test:
      // #2441 (dea4ad40cd) keeps BOTH the compact ("PR") and full ("Create PR")
      // strings in the DOM and swaps them via a container query, and
      // `toHaveText` reads textContent including the display:none copy. The
      // #2579 (3c742de27f) sweep relaxed the first occurrence but missed this
      // one, which only became reachable once the phase-label assertion above
      // stopped failing first. Accept the optional compact prefix while still
      // rejecting the long "Commit, push & create PR" copy.
      await expect(restoredRemoteAction).toHaveText(
        /^(?:\d+ PRs|PR)?Create PR$/,
        { timeout: 30_000 },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('forked chat durably copies output and is placed next to a pinned source panel', async () => {
    test.setTimeout(60_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fork-panel-placement-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'source-chat',
          title: 'Source Chat',
          hasStartedSession: true,
          messages: [
            {
              id: 'prior-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prior user prompt.' }],
              timestamp: PRIOR_TURN_STARTED_AT,
            },
            {
              id: 'prior-assistant',
              role: 'assistant',
              blocks: [
                { type: 'text', text: SEEDED_PRIOR_REPLY },
                {
                  type: 'tool_result',
                  toolUseId: 'retained-output',
                  toolName: 'Read',
                  output: OVERSIZED_BRANCH_OUTPUT,
                  isError: false,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 2_000,
            },
            {
              id: 'prior-timer',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: PRIOR_TURN_STARTED_AT,
                  completedAt: PRIOR_TURN_COMPLETED_AT,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 3_000,
            },
          ],
        },
      ],
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

      const sourcePanel = chatPanelLocator(window, 'source-chat');
      await expect(sourcePanel).toBeVisible({ timeout: 30_000 });
      await expect(
        sourcePanel.getByText(SEEDED_PRIOR_REPLY).first(),
      ).toBeVisible({
        timeout: 30_000,
      });

      const sourceTab = window.getByTestId('panel-tab-panel-chat-source-chat');
      await sourceTab.click({ button: 'right' });
      const menu = window.getByTestId('panel-tab-context-menu');
      await expect(menu).toBeVisible();
      await window.getByTestId('panel-tab-context-pin').click();
      await expect(menu).toBeHidden();
      await expect(sourceTab).toHaveAttribute('data-pinned', 'true');

      // Observe real successful fsyncs after migration, through the UI's fork
      // transaction. A synced file/leaf alone cannot preserve a new directory
      // entry after power loss; its parents must be synced before success too.
      await electronApp.evaluate(() => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const originalOpen = fs.open;
        globalThis.__forkSyncPaths = [];
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            await originalSync();
            globalThis.__forkSyncPaths.push(String(args[0]));
          };
          return handle;
        };
        globalThis.__restoreForkSyncTrace = () => {
          fs.open = originalOpen;
          process.getBuiltinModule('node:module').syncBuiltinESMExports();
        };
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      });
      await window.getByRole('button', { name: 'Fork chat' }).click();

      let placement = null;
      await expect
        .poll(
          async () => {
            const chatPanels = (await chatGroupPanels(window)).filter(
              (panel) => panel.kind === 'chat',
            );
            const sourceIndex = chatPanels.findIndex(
              (panel) => panel.instance?.chatTabId === 'source-chat',
            );
            const nextPanel =
              sourceIndex >= 0 ? chatPanels[sourceIndex + 1] : undefined;
            placement = {
              count: chatPanels.length,
              sourceIndex,
              nextChatTabId: nextPanel?.instance?.chatTabId ?? null,
              nextPinned: nextPanel?.pinned === true,
            };
            return placement;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          count: 2,
          sourceIndex: 0,
          nextPinned: true,
        });

      expect(placement.nextChatTabId).not.toBe('source-chat');
      await expect(
        window.locator(
          `.canopy-panel-tab-strip-wrap-pinned [data-testid="panel-tab-panel-chat-${placement.nextChatTabId}"]`,
        ),
      ).toHaveCount(1);
      const copiedDirectory = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'chat-storage-v2',
        WORKTREE_ID,
        'transcripts',
        'tool-output',
        placement.nextChatTabId,
      );
      // Panel placement is optimistic; artifact copying finishes with the
      // asynchronous canonical fork command.
      await expect
        .poll(
          () =>
            existsSync(copiedDirectory)
              ? readdirSync(copiedDirectory).filter((entry) =>
                  entry.endsWith('.txt'),
                )
              : [],
          { timeout: 30_000 },
        )
        .toHaveLength(1);
      const copiedFiles = readdirSync(copiedDirectory).filter((entry) =>
        entry.endsWith('.txt'),
      );
      expect(copiedFiles).toHaveLength(1);
      expect(
        readFileSync(path.join(copiedDirectory, copiedFiles[0]), 'utf8'),
      ).toBe(OVERSIZED_BRANCH_OUTPUT);
      // Directory fsync is intentionally unsupported on Windows, where the
      // surrounding fork and retained-output assertions still run.
      if (process.platform !== 'win32') {
        await expect
          .poll(
            () => electronApp.evaluate(() => globalThis.__forkSyncPaths ?? []),
            { timeout: 10_000 },
          )
          .toEqual(
            expect.arrayContaining([
              copiedDirectory,
              path.dirname(copiedDirectory),
              path.dirname(path.dirname(copiedDirectory)),
            ]),
          );
      }
      await electronApp.evaluate(() => globalThis.__restoreForkSyncTrace());
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Forked source link returns to the original live chat tab', async () => {
    test.setTimeout(60_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fork-source-link-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: 'forked-chat',
      tabs: [
        {
          id: 'source-chat',
          title: 'Source Chat',
          hasStartedSession: true,
          messages: [
            {
              id: 'prior-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prior user prompt.' }],
              timestamp: PRIOR_TURN_STARTED_AT,
            },
            {
              id: 'prior-assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: SEEDED_PRIOR_REPLY }],
              timestamp: PRIOR_TURN_STARTED_AT + 2_000,
            },
            {
              id: 'prior-timer',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: PRIOR_TURN_STARTED_AT,
                  completedAt: PRIOR_TURN_COMPLETED_AT,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 3_000,
            },
          ],
        },
        {
          id: 'forked-chat',
          title: 'Fork: Source Chat',
          hasStartedSession: true,
          forkedFrom: {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: 'source-chat',
            atMessageId: 'prior-assistant',
          },
          messages: [
            {
              id: 'prior-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prior user prompt.' }],
              timestamp: PRIOR_TURN_STARTED_AT,
            },
            {
              id: 'prior-assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: SEEDED_PRIOR_REPLY }],
              timestamp: PRIOR_TURN_STARTED_AT + 2_000,
            },
            {
              id: 'prior-timer',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: PRIOR_TURN_STARTED_AT,
                  completedAt: PRIOR_TURN_COMPLETED_AT,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 3_000,
            },
          ],
        },
      ],
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

      // Two chat tabs are seeded (source + fork), and BOTH keep their panel
      // content mounted; address the active forked tab's panel explicitly.
      const panel = chatPanelLocator(window, 'forked-chat');
      await expect(panel).toBeVisible();
      await expect(panel.getByText(SEEDED_PRIOR_REPLY).first()).toBeVisible({
        timeout: 30_000,
      });

      const sourceTab = window.getByTestId('panel-tab-panel-chat-source-chat');
      await expect(sourceTab).toHaveAttribute('aria-selected', 'false');
      const sourceLink = window.getByRole('button', {
        name: 'Forked from conversation',
      });
      await expect(sourceLink).toBeVisible({ timeout: 30_000 });
      await sourceLink.click();
      await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Fork and Branch stay visible across a live turn; Fork adds a chat tab', async () => {
    // The live provider turn normally completes quickly, but Electron shutdown
    // can wait for the spawned mock-agent process after the assertions finish.
    // Keep teardown inside the test budget without changing any interaction
    // waits or masking a stalled live turn.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fork-branch-live-'),
    );

    // Phase 1: real git worktree.
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Phase 1: a Claude chat tab with one SEEDED completed (forkable) turn:
    // user → assistant → system(turn_timer completedAt set). `hasStartedSession`
    // (without an sdkSessionId) suppresses the first-message branch-naming
    // prompt while letting the live turn start a fresh session.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 't1',
          title: 'Chat',
          hasStartedSession: true,
          messages: [
            {
              id: 'prior-user',
              role: 'user',
              blocks: [{ type: 'text', text: 'Prior user prompt.' }],
              timestamp: PRIOR_TURN_STARTED_AT,
            },
            {
              id: 'prior-assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: SEEDED_PRIOR_REPLY }],
              timestamp: PRIOR_TURN_STARTED_AT + 2_000,
            },
            {
              id: 'prior-timer',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: PRIOR_TURN_STARTED_AT,
                  completedAt: PRIOR_TURN_COMPLETED_AT,
                },
              ],
              timestamp: PRIOR_TURN_STARTED_AT + 3_000,
            },
          ],
        },
      ],
    });

    // The scripted live turn: a single completed step. Its text can only come
    // from the mock answering the live turn.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: LIVE_REPLY, stopReason: 'end_turn' }],
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

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      // The seeded prior turn renders.
      await expect(panel.getByText(SEEDED_PRIOR_REPLY).first()).toBeVisible({
        timeout: 30_000,
      });

      // These literal labels intentionally mirror CHAT_UNIT_LABEL in
      // packages/protocol/src/ui-labels.ts while asserting real a11y names.
      const forkButton = window.getByRole('button', { name: 'Fork chat' });
      const branchButton = window.getByTestId('turn-more-branch');

      // Before the live turn: Fork + Branch are present on the seeded forkable
      // turn (PR 743 surface).
      await expect(forkButton.last()).toBeVisible({ timeout: 30_000 });
      await window.getByTestId('turn-more-actions').last().click();
      await expect(branchButton).toBeVisible();
      await window.keyboard.press('Escape');
      await forkButton.last().hover();
      const forkTooltip = window
        .getByRole('tooltip')
        .filter({ hasText: 'Fork chat' });
      await expect(forkTooltip).toBeVisible();
      await expect(forkButton.last()).toHaveAttribute(
        'aria-describedby',
        await forkTooltip.getAttribute('id'),
      );

      // Count chat panel tabs before forking so we can assert the fork adds
      // one. Chat tabs render as bound panel tabs (`data-panel-kind="chat"`)
      // in the panel grid's tab strips.
      const chatTabs = window.locator('[role="tab"][data-panel-kind="chat"]');
      const tabCountBefore = await chatTabs.count();

      // Drive a REAL Claude turn against the mock.
      const userMessage = `[${CONVERSATION_MARKER}] Continue.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders, then the live scripted reply streams in. This
      // text can only originate from the mock answering the live turn.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel.getByText(LIVE_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // After the live turn completes, the Fork / Branch actions remain
      // reachable on the latest forkable turn (PR 743 survives a live turn).
      await expect(forkButton.last()).toBeVisible({ timeout: 30_000 });
      await window.getByTestId('turn-more-actions').last().click();
      await expect(branchButton).toBeVisible();
      await window.keyboard.press('Escape');

      // Fork is renderer-only: clicking it duplicates the conversation into a
      // new chat tab (no agent). Assert the tab count increases by one.
      await forkButton.last().click();
      await expect
        .poll(async () => chatTabs.count(), { timeout: 30_000 })
        .toBeGreaterThan(tabCountBefore);

      // We deliberately do not click Branch — it would create a real worktree.
      // Asserting it stayed visible above is the full extent of branch coverage
      // here.
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

for (const [toolName, branched, rejectAnchor] of [
  ['StartForkedAgent', false, false],
  ['StartBranchedAgent', true, false],
  ['StartForkedAgent', false, true],
]) {
  test(
    rejectAnchor
      ? `${toolName} recovers from a rejected native Claude resume anchor`
      : `${toolName} starts an independent chat mid-turn and lets the source continue`,
    async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-split-agent-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          {
            id: 'split-source',
            title: 'Split source',
            ...(branched ? {} : { description: 'Generated split source' }),
            approvalMode: 'full-access',
            hasStartedSession: true,
          },
        ],
      });
      const marker = `Canopy-CSPLIT${branched ? 'BRANCH' : 'FORK'}${rejectAnchor ? 'REJECTED' : ''}`;
      const childMarker = `${marker}CHILD`;
      const instruction = `[${childMarker}] [Canopy-Mock-Request:split-child] Complete the independent task`;
      const sourceReply =
        'Source continued after independent agent confirmation';
      const childReply = 'Independent agent received its follow up instruction';
      const resumedReply = 'Resumed the independent child conversation';
      const pluginReply = 'Child retained context after plugin reload';
      const requestTextObservers = [
        { key: 'child-history', text: childReply },
        {
          key: 'hidden-handoff',
          text: `Follow-up instruction from the originating tool call:\n${instruction}`,
        },
        {
          key: 'fork-identity',
          text: 'You are now running as an independent forked chat.',
        },
        ...(branched
          ? [
              {
                key: 'readonly-source',
                text: 'Limit all changes to the new working directory',
              },
            ]
          : []),
      ];
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: {
          requestTextObservers,
          stepsByRequestTag: {
            'split-child': { text: childReply, stopReason: 'end_turn' },
            'fork-continuation': { text: resumedReply, stopReason: 'end_turn' },
            'plugin-continuation': {
              text: pluginReply,
              stopReason: 'end_turn',
            },
          },
          steps: [
            {
              toolCalls: [
                {
                  name: `mcp__canopy__${toolName}`,
                  input: { followUpInstruction: instruction },
                },
              ],
              stopReason: 'tool_use',
            },
            { text: sourceReply, stopReason: 'end_turn' },
          ],
        },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
        llm: {
          requestTextObservers,
          stepsByRequestTag: {
            'fork-continuation': { text: resumedReply, stopReason: 'end_turn' },
            'plugin-continuation': {
              text: pluginReply,
              stopReason: 'end_turn',
            },
          },
          steps: [
            { text: childReply, stopReason: 'end_turn' },
            { text: childReply, stopReason: 'end_turn' },
            { text: childReply, stopReason: 'end_turn' },
          ],
        },
      });
      let { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);
        if (rejectAnchor) {
          // Exercise the bundled Claude CLI's actual missing-UUID failure, then
          // the provider's fresh-query recovery and normal initial dispatch.
          const probePath = path.join(userDataDir, 'utility-probe.cjs');
          writeFileSync(
            probePath,
            'process.parentPort.on("message", () => {});',
          );
          await electronApp.evaluate(({ utilityProcess }, probePath) => {
            // CLI spawning lives in the utility host. Intercept its real spawn
            // protocol, including a host already warmed before the first send.
            const probe = utilityProcess.fork(probePath);
            const prototype = Object.getPrototypeOf(probe);
            const originalPost = prototype.postMessage;
            globalThis.__rejectedSplitAnchorCount = 0;
            prototype.postMessage = function (message, ...rest) {
              const args = message?.type === 'spawn' ? message.args : undefined;
              if (
                !globalThis.__rejectedSplitAnchorCount &&
                Array.isArray(args)
              ) {
                const index = args.findIndex(
                  (arg) =>
                    arg === '--resume-session-at' ||
                    arg.startsWith('--resume-session-at='),
                );
                if (index >= 0) {
                  const patched = [...args];
                  const uuid = process
                    .getBuiltinModule('node:crypto')
                    .randomUUID();
                  if (patched[index] === '--resume-session-at')
                    patched[index + 1] = uuid;
                  else patched[index] = `--resume-session-at=${uuid}`;
                  globalThis.__rejectedSplitAnchorCount++;
                  return originalPost.call(
                    this,
                    { ...message, args: patched },
                    ...rest,
                  );
                }
              }
              return originalPost.call(this, message, ...rest);
            };
            probe.kill();
          }, probePath);
        }
        const panel = window.getByTestId('panel-content-chat');
        const composer = panel.getByRole('textbox').first();
        await composer.fill(
          `[${marker}] Explicitly start an independent ${branched ? 'branched' : 'forked'} agent, then continue this task`,
        );
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect
          .poll(
            async () => {
              const page = await window.evaluate(
                async (request) => window.api.chat.getTranscriptPage(request),
                {
                  projectId: WORKSPACE_ID,
                  worktreeId: WORKTREE_ID,
                  chatId: 'split-source',
                },
              );
              return page.messages.some((message) =>
                message.blocks.some(
                  (block) =>
                    block.type === 'text' && block.text === sourceReply,
                ),
              );
            },
            { timeout: 90_000 },
          )
          .toBe(true);
        await app.selectWorktree(WORKTREE_BRANCH);
        await window.getByTestId('panel-tab-panel-chat-split-source').click();
        await expect(panel.getByText(sourceReply).first()).toBeVisible();
        const sourcePage = await window.evaluate(
          async (request) => window.api.chat.getTranscriptPage(request),
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: 'split-source',
          },
        );
        const blocks = sourcePage.messages.flatMap((message) => message.blocks);
        const call = blocks.find(
          (block) =>
            block.type === 'tool_use' && block.toolName?.endsWith(toolName),
        );
        const tool = blocks.find(
          (block) =>
            block.type === 'tool_result' && block.toolUseId === call?.toolUseId,
        );
        expect(tool, JSON.stringify(sourcePage.messages, null, 2)).toBeTruthy();
        expect(tool.isError, tool.output).toBe(false);
        expect(tool.output).toBeTruthy();
        const receipt = JSON.parse(tool.output);
        expect(receipt).toMatchObject({
          ok: true,
          delivery: 'submitted',
          independent: true,
        });
        expect(receipt.chatId).not.toBe('split-source');
        expect(receipt.worktreeId === WORKTREE_ID).toBe(!branched);
        await expect
          .poll(
            async () => {
              const page = await window.evaluate(
                async (request) => window.api.chat.getTranscriptPage(request),
                {
                  projectId: WORKSPACE_ID,
                  worktreeId: receipt.worktreeId,
                  chatId: receipt.chatId,
                },
              );
              return page.messages.some(
                (message) =>
                  message.role === 'assistant' &&
                  message.blocks.some(
                    (block) =>
                      block.type === 'text' && block.text.includes(childReply),
                  ),
              );
            },
            { timeout: 90_000 },
          )
          .toBe(true);
        const childState = await window.evaluate(
          async (scope) => window.api.chat.getState(scope),
          { projectId: WORKSPACE_ID, worktreeId: receipt.worktreeId },
        );
        const child = childState.tabsFile.tabs.find(
          (tab) => tab.id === receipt.chatId,
        );
        const childPage = await window.evaluate(
          async (request) => window.api.chat.getTranscriptPage(request),
          {
            projectId: WORKSPACE_ID,
            worktreeId: receipt.worktreeId,
            chatId: receipt.chatId,
          },
        );
        const childMessages = childPage.messages;
        if (!branched) {
          expect(child.title).toBe('Fork: Generated split source');
          expect(child.description).toBe('Generated split source');
          // Fill tabs also show a position number; assert only the title.
          await expect(
            window
              .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
              .locator('.canopy-panel-tab-title'),
          ).toHaveText('Generated split source');
        }
        if (branched) {
          const worktrees = JSON.parse(
            readFileSync(
              path.join(
                userDataDir,
                'workspaces',
                WORKSPACE_ID,
                'worktrees.json',
              ),
              'utf8',
            ),
          );
          expect(
            worktrees.worktrees.find(
              (worktree) => worktree.id === receipt.worktreeId,
            )?.trackedBaseBranch,
          ).toBe(WORKTREE_BRANCH);
          await app.selectWorktree(receipt.worktreeId);
          await window
            .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
            .click();
          // The loaded child transcript carries no setup annotation
          // (CAN-4981); wait for its reply before asserting absence.
          await expect(
            panel.getByText(childReply, { exact: false }).first(),
          ).toBeVisible();
          await expect(
            panel.getByText('Chat initiated before project setup', {
              exact: false,
            }),
          ).toHaveCount(0);
        }
        expect(child.forkedFrom).toMatchObject({
          worktreeId: WORKTREE_ID,
          chatId: 'split-source',
        });
        expect(child.sdkSessionId).toBeTruthy();
        expect(child.claudeForkSessionOnNextSend).toBeUndefined();
        expect(child.forkedFrom?.resumePointRequired).toBeUndefined();
        // A true fork resumes the source conversation rather than starting fresh.
        if (rejectAnchor) {
          expect(
            await electronApp.evaluate(
              () => globalThis.__rejectedSplitAnchorCount,
            ),
          ).toBe(1);
          expect(child.forkedFrom?.modelContext).toBe('fresh');
        } else if (!branched)
          expect(child.forkedFrom?.modelContext).not.toBe('fresh');
        expect(
          childMessages.some(
            (message) =>
              message.role === 'user' &&
              message.blocks.some(
                (block) => block.type === 'text' && block.text === 'Continue',
              ),
          ),
        ).toBe(true);
        const lastUserMessage = childMessages
          .filter((message) => message.role === 'user')
          .at(-1);
        expect(
          lastUserMessage.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text),
        ).toEqual(['Continue']);
        // A native Claude fork may send only the new child prompt, making its
        // hidden marker the mock scenario key. A replayed fork may also carry
        // the source marker. Count observations from whichever route was used.
        const [{ activity: sourceActivity }, { activity: childActivity }] =
          await Promise.all([
            getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker),
            getScenarioActivity(DEFAULT_MOCK_BASE_URL, childMarker),
          ]);
        const observed = (key) =>
          (sourceActivity[`llmObserved:${key}`] ?? 0) +
          (childActivity[`llmObserved:${key}`] ?? 0);
        expect(observed('hidden-handoff')).toBeGreaterThan(0);
        expect(observed('fork-identity')).toBeGreaterThan(0);
        if (branched) expect(observed('readonly-source')).toBeGreaterThan(0);
        await app.selectWorktree(receipt.worktreeId);
        await window
          .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
          .click();
        await expect(
          panel.getByText('Continue', { exact: true }),
        ).toBeVisible();
        // A real app restart must resume the child session, including the
        // child-only response, rather than re-forking at the source anchor.
        if (!rejectAnchor) {
          const historyBefore = observed('child-history');
          // Saving capabilities uses the same session recreation boundary as
          // deferred plugin loading. Drive the next child turn through the UI.
          await window.evaluate(
            async (request) => window.api.chat.updatePlugins(request),
            {
              projectId: WORKSPACE_ID,
              worktreeId: receipt.worktreeId,
              chatId: receipt.chatId,
              pluginSelections: child.pluginSelections ?? {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [],
              },
            },
          );
          await panel
            .getByRole('textbox')
            .first()
            .fill(
              `[${childMarker}] [Canopy-Mock-Request:plugin-continuation] Continue after the plugin reload`,
            );
          await panel.getByRole('button', { name: 'Send message' }).click();
          await expect(
            panel.getByText(pluginReply, { exact: true }).first(),
          ).toBeVisible({ timeout: 90_000 });
          const pluginState = await window.evaluate(
            async (scope) => window.api.chat.getState(scope),
            { projectId: WORKSPACE_ID, worktreeId: receipt.worktreeId },
          );
          expect(
            pluginState.tabsFile.tabs.find((tab) => tab.id === receipt.chatId)
              .sdkSessionId,
          ).toBe(child.sdkSessionId);
          const [{ activity: pluginSource }, { activity: pluginChild }] =
            await Promise.all([
              getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker),
              getScenarioActivity(DEFAULT_MOCK_BASE_URL, childMarker),
            ]);
          const historyAfterPlugin =
            (pluginSource['llmObserved:child-history'] ?? 0) +
            (pluginChild['llmObserved:child-history'] ?? 0);
          expect(historyAfterPlugin).toBeGreaterThan(historyBefore);
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
          ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
            launchCanopy({ userDataDir }),
          ));
          const resumedWindow = await electronApp.firstWindow();
          const resumedApp = new CanopyAppDriver(resumedWindow);
          await resumedApp.waitForShell({ timeout: 30_000 });
          await resumedApp.openMainPage();
          await resumedApp.selectWorktree(receipt.worktreeId);
          await resumedWindow
            .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
            .click();
          const resumedPanel = resumedWindow.getByTestId('panel-content-chat');
          await resumedPanel
            .getByRole('textbox')
            .first()
            .fill(
              `[${childMarker}] [Canopy-Mock-Request:fork-continuation] Continue the child-only task`,
            );
          await resumedPanel
            .getByRole('button', { name: 'Send message' })
            .click();
          await expect(
            resumedPanel.getByText(resumedReply, { exact: true }).first(),
          ).toBeVisible({ timeout: 90_000 });
          const resumedState = await resumedWindow.evaluate(
            async (scope) => window.api.chat.getState(scope),
            { projectId: WORKSPACE_ID, worktreeId: receipt.worktreeId },
          );
          const resumedChild = resumedState.tabsFile.tabs.find(
            (tab) => tab.id === receipt.chatId,
          );
          expect(resumedChild.sdkSessionId).toBe(child.sdkSessionId);
          expect(resumedChild.claudeForkSessionOnNextSend).toBeUndefined();
          expect(resumedChild.forkedFrom?.resumePointRequired).toBeUndefined();
          const [{ activity: afterSource }, { activity: afterChild }] =
            await Promise.all([
              getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker),
              getScenarioActivity(DEFAULT_MOCK_BASE_URL, childMarker),
            ]);
          expect(
            (afterSource['llmObserved:child-history'] ?? 0) +
              (afterChild['llmObserved:child-history'] ?? 0),
          ).toBeGreaterThan(historyAfterPlugin);
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    },
  );
}

test('Cowork StartForkedAgent keeps the source entry and starts an independent chat', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-fork-'),
  );
  const { workspaceId, chatId } = seedCoworkWorkspace({
    userDataDir,
    collapsed: false,
  });
  const tabsPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chats',
    'home.json',
  );
  const seeded = JSON.parse(readFileSync(tabsPath, 'utf8'));
  seeded.tabs[0].providerType = 'claude';
  seeded.tabs[0].model = 'claude-sonnet-4-6';
  seeded.tabs[0].approvalMode = 'full-access';
  seeded.tabs[0].thinkingLevel = 'high';
  writeFileSync(tabsPath, JSON.stringify(seeded));

  const marker = 'Canopy-CCOWORKFORK';
  const childMarker = 'Canopy-CCOWORKFORKCHILD';
  const instruction = `[${childMarker}] [Canopy-Mock-Request:cowork-child] Continue independently`;
  const sourceReply = 'Cowork source continued after the fork';
  const childReply = 'Cowork fork received its independent instruction';
  const requestTextObservers = [
    {
      key: 'cowork-hidden-handoff',
      text: `Follow-up instruction from the originating tool call:\n${instruction}`,
    },
    {
      key: 'cowork-fork-identity',
      text: 'You are now running as an independent forked chat.',
    },
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      requestTextObservers,
      stepsByRequestTag: {
        'cowork-child': { text: childReply, stopReason: 'end_turn' },
      },
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__StartForkedAgent',
              input: { followUpInstruction: instruction },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: sourceReply, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
    llm: {
      requestTextObservers,
      steps: [{ text: childReply, stopReason: 'end_turn' }],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();
    await window.getByTestId(`sidebar-work-entry-${chatId}`).click();
    const target = await window.evaluate(
      async ({ projectId, sourceChatId }) => {
        const entry = await window.api.workEntries.resolveChat({
          projectId,
          chatId: sourceChatId,
        });
        return { projectId, worktreeId: entry.entryId ?? 'home' };
      },
      { projectId: workspaceId, sourceChatId: chatId },
    );
    const panel = window.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Explicitly fork this Cowork chat, then continue here`);
    await panel.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(
        async () => {
          const page = await window.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...target, chatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === sourceReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const sourcePage = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...target, chatId },
    );
    const blocks = sourcePage.messages.flatMap((message) => message.blocks);
    const call = blocks.find(
      (block) =>
        block.type === 'tool_use' &&
        block.toolName?.endsWith('StartForkedAgent'),
    );
    const tool = blocks.find(
      (block) =>
        block.type === 'tool_result' && block.toolUseId === call?.toolUseId,
    );
    expect(tool, JSON.stringify(sourcePage.messages, null, 2)).toBeTruthy();
    expect(tool.isError, tool.output).not.toBe(true);
    const receipt = JSON.parse(tool.output);
    expect(receipt).toMatchObject({
      ok: true,
      worktreeId: target.worktreeId,
      delivery: 'submitted',
      independent: true,
    });
    expect(receipt.chatId).not.toBe(chatId);
    await expect
      .poll(
        async () => {
          const page = await window.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...target, chatId: receipt.chatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === childReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const state = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      target,
    );
    const child = state.tabsFile.tabs.find((tab) => tab.id === receipt.chatId);
    expect(child).toMatchObject({
      approvalMode: 'full-access',
      thinkingLevel: 'high',
      forkedFrom: {
        projectId: workspaceId,
        worktreeId: target.worktreeId,
        chatId,
      },
    });
    // A true fork resumes the source conversation rather than starting fresh.
    expect(child.forkedFrom?.modelContext).not.toBe('fresh');
    expect(state.tabsFile.tabs.find((tab) => tab.id === chatId)).toBeTruthy();
    const [{ activity: sourceActivity }, { activity: childActivity }] =
      await Promise.all([
        getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker),
        getScenarioActivity(DEFAULT_MOCK_BASE_URL, childMarker),
      ]);
    for (const key of ['cowork-hidden-handoff', 'cowork-fork-identity']) {
      expect(
        (sourceActivity[`llmObserved:${key}`] ?? 0) +
          (childActivity[`llmObserved:${key}`] ?? 0),
      ).toBeGreaterThan(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
