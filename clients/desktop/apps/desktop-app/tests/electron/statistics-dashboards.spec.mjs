import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedObservabilityAudit, seedUsageEvents } from './seeders/index.mjs';

// Doc 2 Spec 5 — statistics/observability dashboards (PRs 714, 720, 729, 734,
// 746, 727, 814). This file owns the Statistics + Usage dashboard surfaces.
//
// Seeding mirrors `observability.spec.mjs`: we create our own
// `CANOPY_DATA_DIR`, seed `agent-observability/usage-events/<day>.jsonl` and
// `audit/<day>.jsonl` BEFORE launch, then launch Electron pointed at that dir.
// The harness runs `TZ=UTC` (see `launchCanopy.mjs`), so the seeders default
// their day buckets to the UTC ISO day of each event/entry timestamp, which
// lands inside the default retention window and the "today" panel window.

const WORKSPACE_ID = 'workspace-stats-seeded';
const WORKTREE_ID = 'worktree-stats-seeded';
const REPO_ID = 'repo-stats-seeded';
const REPO_LABEL = 'stats-seeded-repo';

function repoScope() {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceLabel: 'Stats Seeded',
    worktreeId: WORKTREE_ID,
    repoId: REPO_ID,
    repoLabel: REPO_LABEL,
  };
}

/**
 * Build a deterministic set of usage-metric events that populate both the
 * Worktrees tab (worktree_created / worktree_pr_merged) and the Tokens +
 * Chats tabs (chat_turn_completed with token totals). All timestamps land
 * within the current UTC day so the Today panel and the retention window both
 * include them.
 */
function buildUsageEvents() {
  const nowMs = Date.now();
  const iso = (offsetMs) => new Date(nowMs - offsetMs).toISOString();

  return [
    {
      version: 1,
      id: 'stats-worktree-created-1',
      type: 'worktree_created',
      timestamp: iso(30 * 60_000),
      workspaceId: WORKSPACE_ID,
      workspaceLabel: 'Stats Seeded',
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      initiationSource: 'user',
      worktreeCreatedAt: iso(30 * 60_000),
      repos: [repoScope()],
    },
    {
      version: 1,
      id: 'stats-worktree-merged-1',
      type: 'worktree_pr_merged',
      timestamp: iso(20 * 60_000),
      workspaceId: WORKSPACE_ID,
      workspaceLabel: 'Stats Seeded',
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      initiationSource: 'user',
      prNumber: 4242,
      prUrl: 'https://example.test/pr/4242',
      mergedAt: iso(20 * 60_000),
      repos: [repoScope()],
    },
    {
      version: 1,
      id: 'stats-chat-turn-completed-1',
      type: 'chat_turn_completed',
      timestamp: iso(15 * 60_000),
      workspaceId: WORKSPACE_ID,
      workspaceLabel: 'Stats Seeded',
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      provider: 'codex',
      initiationSource: 'user',
      chatId: 'chat-stats-seeded',
      auditEntryId: 'stats-audit-chat-1',
      model: 'gpt-6-luna',
      turnStartedAt: iso(16 * 60_000),
      turnCompletedAt: iso(15 * 60_000),
      turnDurationMs: 60_000,
      turnIndexInChat: 0,
      turnIndexInWorktree: 0,
      tokens: {
        input: 4200,
        output: 1300,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
      },
      toolUseCount: 3,
      status: 'success',
    },
    {
      version: 1,
      id: 'stats-chat-turn-completed-2',
      type: 'chat_turn_completed',
      timestamp: iso(10 * 60_000),
      workspaceId: WORKSPACE_ID,
      workspaceLabel: 'Stats Seeded',
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      provider: 'claude',
      initiationSource: 'user',
      chatId: 'chat-stats-seeded',
      auditEntryId: 'stats-audit-chat-2',
      model: 'claude-sonnet-4-6',
      turnStartedAt: iso(11 * 60_000),
      turnCompletedAt: iso(10 * 60_000),
      turnDurationMs: 45_000,
      turnIndexInChat: 1,
      turnIndexInWorktree: 1,
      tokens: {
        input: 2100,
        output: 800,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      toolUseCount: 1,
      status: 'success',
    },
  ];
}

function createToolCounts(overrides = {}) {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    writeEdit: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    appAdvisor: 0,
    mcp: 0,
    other: 0,
    ...overrides,
  };
}

/**
 * Audit entries dated today so the Today panel + Audit page have recent,
 * deterministic rows — including a `pr_generation` helper-task entry (Doc 2
 * Spec 5 / PR 720).
 */
function buildAuditEntries() {
  const nowMs = Date.now();
  const iso = (offsetMs) => new Date(nowMs - offsetMs).toISOString();

  return [
    {
      id: 'stats-audit-chat-1',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'codex',
      label: 'Seeded Stats Chat Turn',
      startedAt: iso(15 * 60_000),
      completedAt: iso(14 * 60_000),
      durationMs: 60_000,
      model: 'gpt-6-luna',
      tokens: {
        input: 4200,
        output: 1300,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
      },
      messageCount: 2,
      assistantMessageCount: 1,
      toolUseCount: 3,
      subAgentCount: 0,
      toolCounts: createToolCounts({ bash: 2, read: 1 }),
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      chatId: 'chat-stats-seeded',
      hasTranscript: false,
    },
    {
      id: 'stats-audit-pr-generation',
      eventType: 'pr_generation',
      status: 'success',
      provider: 'claude',
      label: 'Seeded Stats PR Generation',
      startedAt: iso(8 * 60_000),
      completedAt: iso(7 * 60_000),
      durationMs: 12_000,
      model: 'claude-sonnet-4-6',
      totalCostUsd: 0.0123,
      tokens: {
        input: 900,
        output: 240,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 1,
      assistantMessageCount: 1,
      toolUseCount: 0,
      subAgentCount: 0,
      toolCounts: createToolCounts(),
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      repoLabel: REPO_LABEL,
      hasTranscript: false,
    },
  ];
}

async function launchSeededStatisticsCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-statistics-'));
  seedUsageEvents({ userDataDir, events: buildUsageEvents() });
  seedObservabilityAudit({ userDataDir, entries: buildAuditEntries() });

  try {
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

// Tabs and a headline-card key that is guaranteed present per tab. The chart
// (`usage-chart-${id}`) and breakdown (`usage-breakdown-${id}`) testids are
// derived from the tab id. Headline-card testids are `usage-headline-card-${key}`
// where `key` comes from the tab spec's card list
// (`components/pages/usage/tab-specs.ts`).
const TAB_CASES = [
  { id: 'tokens', headlineKey: 'total_tokens' },
  { id: 'worktrees', headlineKey: 'created' },
  { id: 'chats', headlineKey: 'total_turns' },
  { id: 'plans', headlineKey: 'created' },
  { id: 'pipelines', headlineKey: 'runs_started' },
  { id: 'tools', headlineKey: 'tool_calls' },
];

test('Statistics dashboard renders seeded tabs, headline cards, charts, and Today panel', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } =
    await launchSeededStatisticsCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    // Statistics is the first of two intentionally-separate nav items.
    await app.openStatisticsPage();
    await expect(window.getByTestId('page-statistics')).toBeVisible();

    // The Today panel renders its tiles deterministically.
    const todayPanel = window.getByTestId('statistics-today-panel');
    await expect(todayPanel).toBeVisible();
    await expect(todayPanel.getByText('Total tokens')).toBeVisible();
    await expect(todayPanel.getByText('Agent PRs')).toBeVisible();

    // Parametrized per-tab structural surface (PRs 714 / 729 / 734). For every
    // tab assert the tab panel, a headline card, the chart, and the breakdown
    // panel render. No chart should surface a crash boundary (`role="alert"`),
    // which is the no-regression / boundary happy path (PR 727).
    for (const { id, headlineKey } of TAB_CASES) {
      await window.getByTestId(`statistics-tab-${id}`).click();

      const tabPanel = window.getByTestId(`usage-metrics-tab-${id}`);
      await expect(tabPanel).toBeVisible();

      await expect(
        window.getByTestId(`usage-headline-card-${headlineKey}`),
      ).toBeVisible();

      const chart = window.getByTestId(`usage-chart-${id}`);
      await expect(chart).toBeVisible();
      await expect(chart.getByRole('alert')).toHaveCount(0);

      await expect(window.getByTestId(`usage-breakdown-${id}`)).toBeVisible();
    }

    // Spot-check that the Tokens and Worktrees tabs reflect seeded data by
    // re-selecting them and confirming the seeded-driven surfaces persist.
    await window.getByTestId('statistics-tab-tokens').click();
    await expect(window.getByTestId('usage-metrics-tab-tokens')).toBeVisible();
    await expect(
      window.getByTestId('usage-headline-card-total_tokens'),
    ).toBeVisible();
    await expect(window.getByTestId('usage-chart-tokens')).toBeVisible();

    await window.getByTestId('statistics-tab-worktrees').click();
    await expect(
      window.getByTestId('usage-metrics-tab-worktrees'),
    ).toBeVisible();
    await expect(
      window.getByTestId('usage-headline-card-created'),
    ).toBeVisible();
    await expect(window.getByTestId('usage-chart-worktrees')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('statistics-dashboard.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

test('Usage page is a distinct nav item from Statistics (provider cards only)', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } =
    await launchSeededStatisticsCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    // Both entries exist — the split into separate Statistics / Usage
    // destinations is intentional (PRs 734 / 746). Statistics is a main-nav
    // row while its Labs experiment is on (CAN-3678); Usage lives in the
    // account menu.
    await expect(window.getByTestId('sidebar-nav-statistics')).toBeVisible();
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-item-usage')).toHaveCount(0);
    await window.keyboard.press('Escape');

    await window.getByTestId('sidebar-account-row').click();
    await expect(
      window.getByTestId('sidebar-account-menu-item-usage'),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    // Statistics page: has the tablist of metric tabs.
    await app.openStatisticsPage();
    await expect(window.getByTestId('page-statistics')).toBeVisible();
    await expect(window.getByTestId('statistics-tab-tokens')).toBeVisible();

    // Usage page: a distinct page with provider cards and no statistics tablist.
    await app.openUsagePage();
    await expect(window.getByTestId('page-usage')).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(window.getByTestId('page-statistics')).toBeHidden();
    await expect(window.getByTestId('statistics-tab-tokens')).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('usage-distinct-page.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});
