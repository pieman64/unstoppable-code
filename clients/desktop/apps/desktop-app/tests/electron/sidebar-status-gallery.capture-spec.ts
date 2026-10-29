// @capture-keep: reusable gallery covering every documented sidebar status
// @capture-reference: docs/sidebar-worktree-status.md
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
/**
 * Sidebar worktree-row status GALLERY — one row per state of the sidebar
 * status system, captured as individual row screenshots plus the whole
 * sidebar, so every state can be verified visually in one place. Also the
 * regression harness for three behaviors:
 *
 *   1. Per-state rendering: the leading slot promotes the highest-priority
 *      subject glyph (plan shield > pipeline glyph > done check), trailing
 *      dots carry chat/pipeline states, and subject badges tint by state.
 *   2. Trailing dots STACK: question + spinner + unread + pipeline severity
 *      all stay visible at once instead of one-at-a-time.
 *   3. Hover persistence: hovering a row keeps the trailing status cluster
 *      VISIBLE beside the revealed action buttons (it used to hide).
 *
 * Rows (real git worktrees in one source-backed workspace):
 *   state-idle        — no indicators
 *   state-unread      — unread chat (blue dot)
 *   state-question    — pending question + unread chat (orange + blue dots)
 *   state-streaming   — streaming chat (accent spinner) + unread, injected
 *   state-plan-review — pending plan approval (orange map shield, leading)
 *   state-pipe-running / -paused / -unseen / -failed — pipeline states
 *   state-script      — running launch script (cyan rocket), injected
 *   state-graph       — code-graph build (pulsing badge), injected
 *   state-watchers    — idle chat with watchers (gray eye)
 *   state-scheduled   — scheduled chat message (gray clock)
 *   state-warning     — broken checkout (orange warning triangle)
 *   state-done        — merged PR (purple check + "PR merged")
 *   state-multi       — question + streaming + unread + failed pipeline +
 *                       graph build all at once (the overlap showcase)
 *
 * Deliberately not covered here: terminal states (the terminal activity
 * store derives from live terminal processes and has no injection seam —
 * colors are unit-tested in WorktreeRow.test.tsx), split-PR states (live
 * split workflow sessions), and the transient setup/teardown/discovery
 * spinners (startup lifecycle would race the seeded rows).
 *
 * Deterministic: workspaces, chats, pipeline executions, watchers, and
 * automations are seeded on disk; the script run, code-graph build, and
 * streaming turns are injected through the same IPC channels the main
 * process uses. No live agents, no network. Screenshots land in
 * `.playwright/sidebar-status-gallery/` (gitignored), suffixed with the
 * stage.
 *
 * Stage the run with `GALLERY_STAGE` (defaults to `after`, so the spec stays
 * runnable in the normal suite). The `before` stage runs against the
 * unchanged tree and asserts the pre-change behavior where it diverges
 * (one-at-a-time trailing dots, hover hiding the cluster, untinted
 * script/terminal badges); single-state rows are identical in both stages.
 *
 *   GALLERY_STAGE=before pnpm run test:electron:captures:built sidebar-status-gallery.capture-spec.ts --reporter=line
 *   # apply the change, rebuild with `pnpm run build:e2e`
 *   GALLERY_STAGE=after  pnpm run test:electron:captures:built sidebar-status-gallery.capture-spec.ts --reporter=line
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  buildPrStatusData,
  injectChatEvent,
  injectCodeGraphBuildStatusEvent,
  injectGithubPrStatus,
  injectScriptRunEvent,
  seedAutomations,
  seedPipelineExecution,
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
// Imported directly (not via the barrel) so the staged `before` run — which
// checks out the baseline tree where the barrel lacks these exports — can
// still drive the terminal events.
import {
  injectTerminalExit,
  injectTerminalRunningChanged,
} from './seeders/injectTerminalActivityEvent.mjs';
import { seedWorktreeLastKnownPrStatus } from './seeders/seedSplitPr.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'status-gallery';
const META_WORKSPACE_ID = 'status-gallery-meta';
const STAGE = process.env.GALLERY_STAGE === 'before' ? 'before' : 'after';

const GALLERY_WORKTREES = [
  'state-idle',
  'state-unread',
  'state-question',
  'state-streaming',
  'state-plan-review',
  'state-pipe-running',
  'state-pipe-paused',
  'state-pipe-paused-seen',
  'state-pipe-unseen',
  'state-pipe-failed',
  'state-term-running',
  'state-term-done',
  'state-term-failed',
  'state-script',
  'state-setup',
  'state-graph',
  'state-watchers',
  'state-scheduled',
  'state-done',
  'state-multi',
];
const BROKEN_WORKTREE_ID = 'state-warning';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'sidebar-status-gallery');
type SeedChatOptions = Parameters<typeof seedWorktreeChat>[0];
type GalleryWorktree = {
  id: string;
  branchName: string;
  createdAt: string;
  status?: 'done';
  seenPipelineExecutionIds?: string[];
  healthIssue?: {
    status: 'broken';
    code: string;
    message: string;
    checkedAt: string;
    worktreePath: string;
  };
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Build the gallery workspace: one source repo, one real git worktree per
 * state row, plus a deliberately broken checkout for the warning row. */
function seedGalleryWorkspace(userDataDir: string, fixtureDir: string): void {
  const sourceRepoPath = path.join(fixtureDir, 'source');
  mkdirSync(sourceRepoPath, { recursive: true });
  git(sourceRepoPath, ['init']);
  git(sourceRepoPath, ['config', 'user.email', 'test@example.com']);
  git(sourceRepoPath, ['config', 'user.name', 'Canopy Test']);
  writeJson(path.join(sourceRepoPath, 'canopy.json'), {
    version: 1,
    scripts: {},
    repos: [],
  });
  git(sourceRepoPath, ['add', 'canopy.json']);
  git(sourceRepoPath, ['commit', '-m', 'initial']);

  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  for (const id of GALLERY_WORKTREES) {
    const worktreePath = path.join(workspaceDir, 'worktrees', id);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(sourceRepoPath, ['worktree', 'add', '-b', id, worktreePath, 'HEAD']);
  }
  // Broken checkout: a directory with no git metadata plus a persisted
  // healthIssue, so live health re-validation agrees it is broken.
  const brokenPath = path.join(workspaceDir, 'worktrees', BROKEN_WORKTREE_ID);
  mkdirSync(brokenPath, { recursive: true });

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Status Gallery',
        type: 'multi-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
      {
        id: META_WORKSPACE_ID,
        name: 'Status Gallery Meta',
        type: 'single-repo',
        color: '#a78bfa',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [],
    sourceRepoPath,
    alwaysShow: true,
  });

  const worktrees: GalleryWorktree[] = GALLERY_WORKTREES.map((id, index) => ({
    id,
    branchName: id,
    createdAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  const doneEntry = worktrees.find((entry) => entry.id === 'state-done');
  if (!doneEntry) throw new Error('Missing state-done gallery fixture');
  doneEntry.status = 'done';
  // A paused run whose id is already in the seen list resolves to `paused`
  // (not `unseen`), so this row shows the orange paused glyph.
  const pausedSeenEntry = worktrees.find(
    (entry) => entry.id === 'state-pipe-paused-seen',
  );
  if (!pausedSeenEntry) {
    throw new Error('Missing state-pipe-paused-seen gallery fixture');
  }
  pausedSeenEntry.seenPipelineExecutionIds = ['g-pipe-paused-seen'];
  worktrees.push({
    id: BROKEN_WORKTREE_ID,
    branchName: BROKEN_WORKTREE_ID,
    createdAt: '2026-08-01T00:00:59.000Z',
    healthIssue: {
      status: 'broken',
      code: 'missing-git-metadata',
      message: 'Seeded broken checkout (no git metadata).',
      checkedAt: '2026-08-01T00:00:59.000Z',
      worktreePath: brokenPath,
    },
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees,
  });
}

/**
 * Composite metadata workspace (single-repo, so the PR badge reads
 * `PR #<n>`): a base worktree plus a child branched from it (depth badge 1)
 * carrying committed changes (diff stats), an approved passing open PR, and
 * — injected at runtime — a running launch script (blue inline stop control
 * + rocket badge).
 */
function seedMetaWorkspace(userDataDir: string, fixtureDir: string): void {
  const sourceRepoPath = path.join(fixtureDir, 'meta-source');
  mkdirSync(sourceRepoPath, { recursive: true });
  git(sourceRepoPath, ['init']);
  git(sourceRepoPath, ['config', 'user.email', 'test@example.com']);
  git(sourceRepoPath, ['config', 'user.name', 'Canopy Test']);
  writeFileSync(
    path.join(sourceRepoPath, 'notes.txt'),
    Array.from({ length: 40 }, (_, i) => `note line ${i + 1}`).join('\n') +
      '\n',
    'utf8',
  );
  git(sourceRepoPath, ['add', 'notes.txt']);
  git(sourceRepoPath, ['commit', '-m', 'initial']);

  const workspaceDir = path.join(userDataDir, 'workspaces', META_WORKSPACE_ID);
  const basePath = path.join(workspaceDir, 'worktrees', 'meta-base');
  mkdirSync(path.dirname(basePath), { recursive: true });
  git(sourceRepoPath, ['worktree', 'add', '-b', 'meta-base', basePath, 'HEAD']);
  const childPath = path.join(workspaceDir, 'worktrees', 'meta-child');
  git(sourceRepoPath, [
    'worktree',
    'add',
    '-b',
    'meta-child',
    childPath,
    'meta-base',
  ]);
  // Committed work on the child branch: a new file plus trimmed notes, so
  // the sidebar diff badge shows insertions AND deletions vs the base.
  writeFileSync(
    path.join(childPath, 'feature.txt'),
    Array.from({ length: 120 }, (_, i) => `feature line ${i + 1}`).join('\n') +
      '\n',
    'utf8',
  );
  writeFileSync(
    path.join(childPath, 'notes.txt'),
    Array.from({ length: 15 }, (_, i) => `note line ${i + 1}`).join('\n') +
      '\n',
    'utf8',
  );
  git(childPath, ['add', '.']);
  git(childPath, ['commit', '-m', 'feature work']);

  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: sourceRepoPath,
    repos: [],
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: 'meta-base',
        branchName: 'meta-base',
        createdAt: '2026-08-01T00:01:00.000Z',
      },
      {
        id: 'meta-child',
        branchName: 'meta-child',
        createdAt: '2026-08-01T00:01:01.000Z',
        trackedBaseBranch: 'meta-base',
        // Parent link keeps the ancestry even before live base-branch
        // resolution; with default grouping the row nests under its parent
        // and shows the "1" nested-depth indicator beside the PR badge.
        branchGroupingParentWorktreeId: 'meta-base',
      },
    ],
  });
}

function seedChats(userDataDir: string): void {
  const seedTabs = (
    worktreeId: string,
    tabs: SeedChatOptions['tabs'],
    pendingQuestions: SeedChatOptions['pendingQuestions'] = undefined,
  ): void => {
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId,
      tabs,
      ...(pendingQuestions ? { pendingQuestions } : {}),
    });
  };

  seedTabs('state-unread', [
    { id: 'g-unread', title: 'Refactor follow-up', unread: true },
  ]);
  seedTabs(
    'state-question',
    [
      { id: 'g-question', title: 'Migration planning' },
      { id: 'g-question-unread', title: 'Design review', unread: true },
    ],
    [
      {
        requestId: 'g-question-request',
        chatId: 'g-question',
        questions: [
          {
            header: 'Strategy',
            question: 'Which migration strategy should I use?',
            options: ['Expand-contract', 'Big bang'],
            multiSelect: false,
          },
        ],
      },
    ],
  );
  seedTabs('state-streaming', [
    { id: 'g-streaming', title: 'Implement feature' },
    { id: 'g-streaming-unread', title: 'Bug triage', unread: true },
  ]);
  seedTabs('state-plan-review', [
    {
      id: 'g-plan',
      title: 'Plan the rollout',
      pendingPlanExit: { plan: 'Seeded plan awaiting approval' },
    },
  ]);
  seedTabs('state-watchers', [
    { id: 'g-watcher-chat', title: 'Release follow-up' },
  ]);
  seedTabs('state-scheduled', [
    { id: 'g-scheduled-chat', title: 'Nightly summary' },
  ]);
  seedTabs(
    'state-multi',
    [
      { id: 'g-multi-question', title: 'Choose an approach' },
      { id: 'g-multi-streaming', title: 'Implement feature' },
      { id: 'g-multi-unread', title: 'Review results', unread: true },
    ],
    [
      {
        requestId: 'g-multi-question-request',
        chatId: 'g-multi-question',
        questions: [
          {
            header: 'Approach',
            question: 'Ship behind a flag?',
            options: ['Yes', 'No'],
            multiSelect: false,
          },
        ],
      },
    ],
  );
}

function seedPipelines(userDataDir: string): void {
  const seed = (
    worktreeId: string,
    execution: Parameters<typeof seedPipelineExecution>[0]['execution'],
  ): void => {
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId,
      execution,
    });
  };
  seed('state-pipe-running', {
    id: 'g-pipe-running',
    pipelineName: 'Gallery Running Pipeline',
    status: 'running',
  });
  seed('state-pipe-paused', {
    id: 'g-pipe-paused',
    pipelineName: 'Gallery Paused Pipeline',
    status: 'paused',
    pendingInput: {
      jobId: 'build',
      stepId: 'step',
      title: 'Continue?',
      message: 'Resume when ready.',
    },
  });
  seed('state-pipe-unseen', {
    id: 'g-pipe-unseen',
    pipelineName: 'Gallery Completed Pipeline',
    status: 'success',
  });
  seed('state-pipe-failed', {
    id: 'g-pipe-failed',
    pipelineName: 'Gallery Failed Pipeline',
    status: 'failure',
  });
  seed('state-pipe-paused-seen', {
    id: 'g-pipe-paused-seen',
    pipelineName: 'Gallery Seen Paused Pipeline',
    status: 'paused',
    pendingInput: {
      jobId: 'build',
      stepId: 'step',
      title: 'Continue?',
      message: 'Resume when ready.',
    },
  });
  seed('state-multi', {
    id: 'g-multi-pipe-failed',
    pipelineName: 'Gallery Multi Failed Pipeline',
    status: 'failure',
  });
}

test('captures every worktree-row state for the status gallery', async () => {
  test.setTimeout(300_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-gallery-'));
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'gallery-fixture-'));

  seedGalleryWorkspace(userDataDir, fixtureDir);
  seedChats(userDataDir);
  seedPipelines(userDataDir);
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'g-watcher',
        label: 'Gallery idle chat watcher',
        status: 'active',
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: WORKSPACE_ID,
          worktreeId: 'state-watchers',
          chatId: 'g-watcher-chat',
          chatTitle: 'Release follow-up',
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: 'state-watchers',
          chatId: 'g-watcher-chat',
          chatTitle: 'Release follow-up',
        },
      },
    ],
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: 'g-scheduled-activity',
        name: 'Gallery scheduled message',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'state-scheduled',
          chatId: 'g-scheduled-chat',
          prompt: 'Post the nightly summary',
          purpose: 'scheduled_send',
          chatTitle: 'Nightly summary',
        },
        nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  // Persisted `WorktreePrStatus` is repos-based; a flat shape fails the
  // strict worktrees.json validation and drops the whole workspace.
  seedWorktreeLastKnownPrStatus({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'state-done',
    lastKnownPrStatus: {
      repos: [
        {
          repoId: 'workspace-root',
          repoName: 'Status Gallery',
          status: buildPrStatusData({
            prNumber: 101,
            state: 'merged',
            title: 'Gallery merged PR',
          }),
        },
      ],
      lastCheckedAt: '2026-08-01T12:00:00.000Z',
    },
  });
  seedMetaWorkspace(userDataDir, fixtureDir);
  // Wider than the 280px default so the composite metadata row shows
  // its full subtitle — depth · launch control · PR badge · diff — without
  // truncation. `{ version, preferences }` matches preferences-store.ts.
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { sidebarWidth: 340 },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = (worktreeId: string): Locator =>
      window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
      );

    // This fixture creates and discovers 22 real git worktrees plus one broken
    // checkout before the gallery can render. Keep the readiness budget aligned
    // with the newer sidebar capture specs so a loaded shell is not mistaken for
    // loaded rows when CI is running another Electron worker concurrently.
    await expect(row('state-idle')).toBeVisible({ timeout: 30_000 });

    // Script events are dropped until the target worktree's runs are loaded
    // (`loadedWorktreeKeys` gate), so each script-bearing row is selected
    // before its injection. meta-child goes first; selecting state-script
    // afterwards leaves the meta row unselected with its launch running.
    await row('meta-child').click();
    await expect(window.getByTestId('panel-content-chat').first()).toBeVisible({
      timeout: 15_000,
    });
    await injectScriptRunEvent(electronApp, {
      projectId: META_WORKSPACE_ID,
      worktreeId: 'meta-child',
      script: {
        scriptKey: 'launch:project',
        scriptName: 'launch',
        label: 'Dev Server',
        command: 'npm run dev',
        lifecycle: 'launch',
        target: 'project',
      },
      invocation: 'manual-lifecycle',
      outputLines: ['ready'],
    });

    await row('state-setup').click();
    await expect(window.getByTestId('panel-content-chat').first()).toBeVisible({
      timeout: 15_000,
    });
    await injectScriptRunEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-setup',
      script: {
        scriptKey: 'setup:project',
        scriptName: 'setup',
        label: 'Install dependencies',
        command: 'npm ci',
        lifecycle: 'setup',
        target: 'project',
      },
      invocation: 'manual-lifecycle',
      outputLines: ['installing…'],
    });

    await row('state-script').click();
    await expect(window.getByTestId('panel-content-chat').first()).toBeVisible({
      timeout: 15_000,
    });
    await injectScriptRunEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-script',
      script: {
        scriptKey: 'launch:project',
        scriptName: 'launch',
        label: 'Dev Server',
        command: 'npm run dev',
        lifecycle: 'launch',
        target: 'project',
      },
      invocation: 'manual-lifecycle',
      outputLines: ['ready'],
    });
    await injectCodeGraphBuildStatusEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-graph',
      status: 'building',
    });
    await injectCodeGraphBuildStatusEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-multi',
      status: 'building',
    });
    // Persisted `lastKnownPrStatus` is not reliable for OPEN PRs in E2E:
    // without gh auth the github poller's refresh clears (and re-persists)
    // the status as null. Inject the live PR status event instead, like the
    // other PR-badge specs do.
    await injectGithubPrStatus(electronApp, {
      projectId: META_WORKSPACE_ID,
      worktreeId: 'meta-child',
      status: {
        repos: [
          {
            repoId: 'repo',
            repoName: 'Status Gallery Meta',
            status: {
              // Approved + passing with no mergeability fields collapses to
              // isMergeReady, so the green ready-to-merge checkmark renders.
              ...buildPrStatusData({
                prNumber: 2423,
                state: 'open',
                checkStatus: 'passing',
                title: 'Composite metadata PR',
              }),
              reviewStatus: 'approved',
            },
          },
        ],
        lastCheckedAt: '2026-08-01T12:00:00.000Z',
      },
    });

    // Terminal states — same IPC events the terminal service broadcasts; no
    // selection precondition (the activity subscription is global). Unseen
    // states require the worktree to be UNSELECTED, which these rows are.
    await injectTerminalRunningChanged(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-term-running',
      terminalId: 'g-term-running',
      running: true,
      processName: 'npm',
    });
    await injectTerminalRunningChanged(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-term-done',
      terminalId: 'g-term-done',
      running: true,
      processName: 'vitest',
    });
    // A clean exit marks the completion unseen immediately (the running:false
    // completion path is gated on a 3s foreground-duration threshold).
    await injectTerminalExit(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-term-done',
      terminalId: 'g-term-done',
      exitCode: 0,
      signal: null,
    });
    await injectTerminalRunningChanged(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-term-failed',
      terminalId: 'g-term-failed',
      running: true,
      processName: 'make',
    });
    await injectTerminalExit(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: 'state-term-failed',
      terminalId: 'g-term-failed',
      exitCode: 1,
      signal: null,
    });

    const streamEvent = (worktreeId: string, chatId: string) =>
      injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId,
        chatId,
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Working…' }] },
        },
      });
    await streamEvent('state-streaming', 'g-streaming');
    await streamEvent('state-multi', 'g-multi-streaming');

    await window.mouse.move(0, 0);

    // --- Per-row assertions --------------------------------------------
    const assertClass = async (
      locator: Locator,
      cls: string,
    ): Promise<void> => {
      expect(await locator.getAttribute('class')).toContain(cls);
    };

    // Idle: no indicators at all.
    await expect(
      row('state-idle').getByTestId('worktree-row-trailing-slot'),
    ).toHaveCount(0);

    // Unread: blue dot.
    const unreadBadge = row('state-unread').getByTestId('worktree-row-unread');
    await expect(unreadBadge).toBeVisible({ timeout: 15_000 });
    await expect(unreadBadge.locator('.bg-fg-blue')).toHaveCount(1);

    // Question: needs-input outranks unread (the orange dot replaces the
    // blue one in both stages); the question-mark glyph names the subject
    // in the leading slot (after only).
    await expect(
      row('state-question').getByTestId('worktree-row-question'),
    ).toBeVisible();
    await expect(
      row('state-question').getByTestId('worktree-row-unread'),
    ).toHaveCount(0);
    if (STAGE === 'after') {
      await expect(
        row('state-question').getByTestId('worktree-row-question-glyph'),
      ).toBeVisible();
    } else {
      await expect(
        row('state-question').getByTestId('worktree-row-question-glyph'),
      ).toHaveCount(0);
    }

    // Streaming spinner + unread dot stack together (before: the spinner
    // suppresses the unread dot).
    const streamingSpinner = row('state-streaming').getByTestId(
      'worktree-row-classic-streaming-spinner',
    );
    await expect(streamingSpinner).toBeVisible({ timeout: 15_000 });
    await expect(streamingSpinner.locator('.fg-accent')).toHaveCount(1);
    if (STAGE === 'after') {
      await expect(
        row('state-streaming').getByTestId('worktree-row-unread'),
      ).toBeVisible();
    } else {
      await expect(
        row('state-streaming').getByTestId('worktree-row-unread'),
      ).toHaveCount(0);
    }

    // Plan review: orange map shield in the leading slot.
    await expect(
      row('state-plan-review').getByTestId('worktree-row-awaiting-approval'),
    ).toBeVisible();

    // Pipeline states: the leading glyph names the subject (highest-priority
    // indicator), the trailing severity dot carries unseen results.
    await expect(
      row('state-pipe-running').getByTestId('worktree-row-working-pipeline'),
    ).toBeVisible({ timeout: 15_000 });
    // A paused run is blocked on the user whether or not it has been
    // acknowledged, so it presents the dedicated orange paused glyph from the
    // moment it pauses — `paused` outranks `unseen` in `resolvePipelineStatus`.
    const pausedFreshGlyph = row('state-pipe-paused').getByTestId(
      'worktree-row-paused-pipeline',
    );
    await expect(pausedFreshGlyph).toBeVisible({ timeout: 15_000 });
    if (STAGE === 'after') {
      await expect(pausedFreshGlyph.locator('.fg-warning')).toHaveCount(1);
    }
    const unseenRowGlyph = row('state-pipe-unseen').getByTestId(
      'worktree-row-pipeline-glyph',
    );
    await expect(unseenRowGlyph).toBeVisible({ timeout: 15_000 });
    const unseenDot = row('state-pipe-unseen').getByTestId(
      'worktree-row-pipeline-attention',
    );
    await expect(unseenDot).toBeVisible();
    await expect(unseenDot.locator('.bg-fg-blue')).toHaveCount(1);
    const failedGlyph = row('state-pipe-failed').getByTestId(
      'worktree-row-pipeline-glyph',
    );
    await expect(failedGlyph).toBeVisible({ timeout: 15_000 });
    const failedDot = row('state-pipe-failed').getByTestId(
      'worktree-row-pipeline-attention',
    );
    await expect(failedDot).toBeVisible();
    await expect(failedDot.locator('.bg-fg-destructive')).toHaveCount(1);
    if (STAGE === 'after') {
      // The glyph carries the outcome color: completed green, failed red.
      await expect(unseenRowGlyph.locator('.fg-success')).toHaveCount(1);
      await expect(failedGlyph.locator('.fg-destructive')).toHaveCount(1);
    }

    // The acknowledged pause renders identically to the fresh one: being seen
    // does not resolve the blocker, so the orange glyph stays put.
    const pausedSeenGlyph = row('state-pipe-paused-seen').getByTestId(
      'worktree-row-paused-pipeline',
    );
    await expect(pausedSeenGlyph).toBeVisible({ timeout: 15_000 });
    if (STAGE === 'after') {
      await expect(pausedSeenGlyph.locator('.fg-warning')).toHaveCount(1);
    } else {
      await expect(pausedSeenGlyph.locator('.fg-warning')).toHaveCount(0);
    }

    // Terminal states: badge tinted by state after the change (with the
    // `data-terminal-status` automation hook); untinted before.
    const termCases = [
      ['state-term-running', 'running', 'fg-info'],
      ['state-term-done', 'unseen', 'fg-info'],
      ['state-term-failed', 'unseen-failure', 'fg-destructive-strong'],
    ];
    for (const [worktreeId, status, color] of termCases) {
      const badge = row(worktreeId).getByTestId('worktree-row-terminal-badge');
      await expect(badge).toBeVisible({ timeout: 15_000 });
      if (STAGE === 'after') {
        await expect(badge).toHaveAttribute('data-terminal-status', status);
        expect(await badge.getAttribute('class')).toContain(color);
      } else {
        expect(await badge.getAttribute('class')).not.toContain('fg-status');
      }
    }

    // Setup: gray lifecycle spinner in the trailing slot plus the subtitle
    // label — identical treatment in both stages.
    const setupRow = row('state-setup');
    await expect(
      setupRow.locator('[aria-label="Running setup…"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(setupRow).toContainText('Running setup…');

    // Script: rocket — promoted into the leading slot (cyan) after the
    // change; an untinted subtitle badge before.
    const scriptBadge = row('state-script').getByTestId(
      'worktree-row-script-badge',
    );
    await expect(scriptBadge).toBeVisible({ timeout: 15_000 });
    const scriptInLeading = row('state-script')
      .getByTestId('worktree-row-leading-slot')
      .getByTestId('worktree-row-script-badge');
    if (STAGE === 'after') {
      await expect(scriptInLeading).toBeVisible();
      expect(await scriptBadge.locator('.fg-info').count()).toBeGreaterThan(0);
    } else {
      await expect(scriptInLeading).toHaveCount(0);
      expect(await scriptBadge.getAttribute('class')).not.toContain('fg-info');
    }

    // Graph: pulsing badge in the neutral subtitle gray.
    const graphBadge = row('state-graph').getByTestId(
      'worktree-row-graph-badge',
    );
    await expect(graphBadge).toBeVisible({ timeout: 15_000 });
    await assertClass(graphBadge, 'animate-pulse');

    // Watchers + scheduled: neutral info icons — promoted into the leading
    // slot after the change when nothing outranks them.
    await expect(
      row('state-watchers').getByTestId('worktree-row-watchers'),
    ).toBeVisible();
    await expect(
      row('state-scheduled').getByTestId('worktree-row-scheduled-messages'),
    ).toBeVisible();
    const watchersInLeading = row('state-watchers')
      .getByTestId('worktree-row-leading-slot')
      .getByTestId('worktree-row-watchers');
    const scheduledInLeading = row('state-scheduled')
      .getByTestId('worktree-row-leading-slot')
      .getByTestId('worktree-row-scheduled-messages');
    if (STAGE === 'after') {
      await expect(watchersInLeading).toBeVisible();
      await expect(scheduledInLeading).toBeVisible();
    } else {
      await expect(watchersInLeading).toHaveCount(0);
      await expect(scheduledInLeading).toHaveCount(0);
    }

    // Broken checkout: warning triangle.
    await expect(
      row(BROKEN_WORKTREE_ID).locator(
        '[aria-label="Worktree issue - click for details"]',
      ),
    ).toBeVisible();

    // Done: purple check + "PR merged".
    await expect(row('state-done')).toContainText('PR merged');

    // Composite metadata row: depth badge + running launch script (blue
    // inline stop control + rocket badge) + approved passing PR + committed
    // diff stats, all on one unselected row.
    const metaRow = row('meta-child');
    await expect(metaRow).toBeVisible({ timeout: 15_000 });
    await expect(
      metaRow.getByTestId('worktree-row-nested-child-depth'),
    ).toBeVisible({ timeout: 15_000 });
    const metaStop = metaRow.getByTestId('worktree-row-stop-launch');
    await expect(metaStop).toBeVisible({ timeout: 15_000 });
    expect(await metaStop.getAttribute('class')).toContain('fg-info');
    const metaPr = metaRow.getByTestId('worktree-row-pr-badge');
    await expect(metaPr).toBeVisible({ timeout: 15_000 });
    await expect(metaPr).toContainText('PR #2423');
    await expect(metaRow.getByTestId('worktree-row-pr-approved')).toBeVisible();
    await expect(metaRow.getByTestId('diff-stats-badge')).toBeVisible({
      timeout: 15_000,
    });
    const metaScriptBadge = metaRow.getByTestId('worktree-row-script-badge');
    await expect(metaScriptBadge).toBeVisible({ timeout: 15_000 });
    if (STAGE === 'after') {
      // Promoted to the leading slot; the cyan sits on its inner icon span.
      expect(await metaScriptBadge.locator('.fg-info').count()).toBeGreaterThan(
        0,
      );
    } else {
      expect(await metaScriptBadge.getAttribute('class')).not.toContain(
        'fg-info',
      );
    }

    // Multi overlap: the loader coexists with the single top-priority
    // attention dot — needs-input wins, so the orange question dot shows and
    // the unread/failed dots yield. In the finalized chain the red pipeline
    // glyph outranks the question glyph in the leading slot (the question
    // keeps the trailing orange dot), and the graph badge pulses in the
    // subtitle. Before the change only the question dot survived (no spinner
    // beside it) with the pipeline glyph leading.
    const multi = row('state-multi');
    await expect(multi.getByTestId('worktree-row-question')).toBeVisible();
    await expect(multi.getByTestId('worktree-row-graph-badge')).toBeVisible();
    await expect(multi.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect(
      multi.getByTestId('worktree-row-pipeline-attention'),
    ).toHaveCount(0);
    if (STAGE === 'after') {
      await expect(
        multi.getByTestId('worktree-row-pipeline-glyph'),
      ).toBeVisible();
      await expect(
        multi.getByTestId('worktree-row-question-glyph'),
      ).toHaveCount(0);
      await expect(
        multi.getByTestId('worktree-row-classic-streaming-spinner'),
      ).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(
        multi.getByTestId('worktree-row-pipeline-glyph'),
      ).toBeVisible();
      await expect(
        multi.getByTestId('worktree-row-classic-streaming-spinner'),
      ).toHaveCount(0);
    }

    // --- Screenshots ----------------------------------------------------
    const shoot = async (locator: Locator, name: string): Promise<void> => {
      await expect(async () => {
        await locator.screenshot({
          path: path.join(captureDir, `${name}-${STAGE}.png`),
          animations: 'disabled',
        });
      }).toPass({ timeout: 15_000 });
    };
    for (const id of [...GALLERY_WORKTREES, BROKEN_WORKTREE_ID]) {
      await shoot(row(id), id);
    }
    await shoot(metaRow, 'state-meta');

    // Hover persistence: the trailing cluster stays visible BESIDE the
    // revealed action buttons instead of hiding under them (before: the
    // cluster hides while the row is hovered).
    await multi.hover();
    const multiActions = multi.getByTestId('worktree-row-action-chip');
    await expect(multiActions).toBeVisible();
    const multiTrailing = multi.getByTestId('worktree-row-trailing-slot');
    if (STAGE === 'after') {
      await expect(multiTrailing).toBeVisible();
      await expect(multi.getByTestId('worktree-row-question')).toBeVisible();
      // The cluster sits fully left of the action chip's buttons.
      const trailingBox = await multiTrailing.boundingBox();
      const actionsBox = await multiActions.boundingBox();
      if (!trailingBox || !actionsBox) {
        throw new Error('Expected visible trailing and action geometry');
      }
      expect(trailingBox.x + trailingBox.width).toBeLessThanOrEqual(
        actionsBox.x + 1,
      );
    } else {
      await expect(multiTrailing).toBeHidden();
    }
    await shoot(multi, 'state-multi-hovered');
    await window.mouse.move(0, 0);

    // Whole-sidebar overview.
    const codeSection = window.locator(
      '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
    );
    await expect(codeSection).toBeVisible({ timeout: 15_000 });
    await shoot(codeSection, 'sidebar-gallery');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
