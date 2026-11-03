import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { diffWorkCounters, evaluateMainWithRetry } from './monitor.mjs';
import { percentile } from './statistics.mjs';

/*
 * CAN-5532 (B6) W5 store scenarios. Each launch runs under one W5 store arm
 * (`--w5-store`, `w5-store-arms.mjs`); the arms compare by these timings and
 * by main's `w5` work counters, taken per task here and over the measured
 * window by the monitor.
 *
 * Fixture: `w5StoreWorkspaces` workspaces whose ids match the capture's id
 * rule, the first with `w5StoreLargeWorkspaceWorktrees` rows and each other
 * with one, plus the default Chats workspace. Every row is settled, so
 * neither startup nor a reload writes: current-version chat badges (no
 * launch backfill) and the PR status the poller derives for a repository
 * without a GitHub remote (an equivalent observation writes nothing).
 *
 * `scenarios.mjs` passes its shared helpers to `w5StoreScenarios`, so this
 * module never imports it back.
 */

/**
 * The W5 store scenario steps over `helpers`: `FatalWaitError`,
 * `readWorktreeSetupStatus`, `recordTask`, `seedWorkspace`,
 * `sidebarWorktreeRow`, `startupJourneyMilestones` and `waitUntil`.
 */
export function w5StoreScenarios(helpers) {
  return {
    prepare: (userDataDir, config) =>
      prepareW5StoreScenario(helpers, userDataDir, config),
    runStartup: (context) => runW5StoreStartup(helpers, context),
    reloadSidebar: (context) => reloadW5StoreSidebar(helpers, context),
    runReload: (context) => runW5StoreReload(helpers, context),
    runWrites: (context) => runW5StoreWrites(helpers, context),
  };
}

const W5_ROW_SELECTOR =
  '[data-testid="app-sidebar"] [data-testid="worktree-row"]';
const FIRST_ROW_TIMEOUT_MS = 60_000;
/**
 * Projects the sidebar lists before "More" (`PROJECT_PAGE_SIZE` in
 * `@canopy/ui-app`'s `useProjectListPagination`). Startup waits for this page;
 * the rest stay unrendered until the user asks.
 */
export const W5_SIDEBAR_PROJECT_PAGE = 10;
// `CHAT_BADGES_SUMMARY_VERSION`: an older version is rewritten at launch.
const SETTLED_BADGES = Object.freeze({
  version: 2,
  unreadChats: [],
  approvalChats: [],
  needsHydration: false,
  updatedAt: '2026-07-20T12:00:00.000Z',
});
const DEFAULT_CHATS_WORKSPACE = Object.freeze({
  id: 'cowork-default',
  name: 'Chats',
  type: 'cowork',
  color: '#14B8A6',
  collapsed: false,
});

/**
 * A fixture row's settled fields. The PR status is what the poller derives
 * for a checkout without a GitHub remote, keyed by the checkout directory
 * name, which is the row id; its `lastCheckedAt` is not compared.
 */
export function settledW5Row(row) {
  return {
    ...row,
    chatBadges: { ...SETTLED_BADGES },
    lastKnownPrStatus: {
      repos: [
        {
          repoId: row.id,
          repoName: row.id,
          status: null,
          prLookupAvailable: false,
        },
      ],
      lastCheckedAt: '2026-07-20T12:00:00.000Z',
    },
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const ordinal = (index) => String(index).padStart(3, '0');

function prepareW5StoreScenario(helpers, userDataDir, config) {
  const seed = helpers.seedWorkspace(userDataDir);
  const primary = seed.workspaces[0];
  if (!primary?.worktreePath || !primary.repoPath)
    throw new Error('W5 store fixture has no default Git worktree');
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const manifest = readJson(
    path.join(workspacesRoot, primary.id, 'workspace.json'),
  );
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = readJson(indexPath);
  const addWorktree = (workspaceId, id, createdAtIndex) => {
    execFileSync(
      'git',
      [
        '-C',
        primary.worktreePath,
        'worktree',
        'add',
        '-b',
        id,
        path.join(workspacesRoot, workspaceId, 'worktrees', id),
        'HEAD',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return settledW5Row({
      id,
      branchName: id,
      createdAt: new Date(
        Date.parse('2026-07-01T12:00:00.000Z') + createdAtIndex * 1_000,
      ).toISOString(),
      trackedBaseBranch: 'main',
    });
  };

  const largeListPath = path.join(workspacesRoot, primary.id, 'worktrees.json');
  const largeList = readJson(largeListPath);
  largeList.worktrees = largeList.worktrees.map(settledW5Row);
  for (
    let row = largeList.worktrees.length;
    row < config.w5StoreLargeWorkspaceWorktrees;
    row += 1
  )
    largeList.worktrees.push(
      addWorktree(primary.id, `perf-w5-wt-${ordinal(row)}`, row),
    );
  writeJson(largeListPath, largeList);

  const workspaceIds = [primary.id];
  for (
    let workspace = 1;
    workspace < config.w5StoreWorkspaces;
    workspace += 1
  ) {
    const id = `perf-w5-ws-${ordinal(workspace + 1)}`;
    workspaceIds.push(id);
    index.workspaces.push({
      id,
      name: `W5 Workspace ${ordinal(workspace + 1)}`,
      type: 'single-repo',
      color: '#3B82F6',
      collapsed: false,
      order: index.workspaces.length,
    });
    const workspaceDir = path.join(workspacesRoot, id);
    mkdirSync(workspaceDir, { recursive: true });
    writeJson(path.join(workspaceDir, 'workspace.json'), manifest);
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [addWorktree(id, `${id}-wt`, 10_000 + workspace)],
    });
  }
  // Seeded, so the first launch does not create it (an index and a manifest
  // commit) inside the startup window.
  if (!index.workspaces.some(({ id }) => id === DEFAULT_CHATS_WORKSPACE.id)) {
    index.workspaces.push({
      ...DEFAULT_CHATS_WORKSPACE,
      order: index.workspaces.length,
    });
    const chatsDir = path.join(workspacesRoot, DEFAULT_CHATS_WORKSPACE.id);
    mkdirSync(chatsDir, { recursive: true });
    writeJson(path.join(chatsDir, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: {
        createdAt: '2025-01-01T00:00:00.000Z',
        archiveRetentionDays: 7,
      },
      alwaysShow: true,
    });
  }
  writeJson(indexPath, index);
  return {
    workspaceIds,
    largeWorkspaceId: primary.id,
    largeRowIds: largeList.worktrees.map((row) => row.id),
    repoPath: primary.repoPath,
  };
}

/** Main's `w5` counters now, or null in a build without the query. */
async function readW5Counters(electronApp) {
  const snapshot = await evaluateMainWithRetry(() =>
    electronApp.evaluate(
      () => globalThis.__CANOPY_WORK_COUNTERS__?.snapshot() ?? null,
    ),
  );
  return snapshot?.w5
    ? { generation: snapshot.generation, w5: snapshot.w5 }
    : null;
}

/** The `w5` counter change between two reads; null when either is missing. */
function w5Delta(before, after) {
  return before && after && before.generation === after.generation
    ? diffWorkCounters(before.w5, after.w5)
    : null;
}

/** Host commits in a delta, excluding the `.us` and `.failed` totals. */
function hostCommits(delta) {
  return Object.entries(delta ?? {})
    .filter(
      ([key]) =>
        key.startsWith('host.commit.') &&
        key !== 'host.commit.us' &&
        key !== 'host.commit.failed',
    )
    .reduce((sum, [, value]) => sum + value, 0);
}

/**
 * W5 commits attempted in a delta: host commits, or in the daemon arm the
 * record-port commits, which include the ones the authority refused.
 */
export function w5CommitAttempts(delta) {
  return Math.max(hostCommits(delta), delta?.['port.commit'] ?? 0);
}

/**
 * A W5 write (a commit or a keyed reservation) the authority refused because
 * storage ownership does not admit the daemon writer: the daemon arm without
 * daemon-owned rows. Named, so the scenario fails with the mechanism.
 */
export function w5WriteRefusal(delta) {
  return Object.keys(delta ?? {}).find((key) =>
    /^port\.\w+\.refused\.writeRefused(\.|$)/.test(key),
  );
}

async function failOnWriteRefusal(electronApp, before, error) {
  const refusal = w5WriteRefusal(
    w5Delta(before, await readW5Counters(electronApp)),
  );
  if (!refusal) throw error;
  throw new Error(
    `The daemon-record-port arm refused W5 writes (${refusal}): its record-port authority does not own the W5 storage rows, so write timings cannot be measured. ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Launch to the first visible worktree row and to the first project page:
 * headers for `min(W5_SIDEBAR_PROJECT_PAGE, workspaces)` fixture workspaces.
 * Polls each frame, or every 16 ms while the document is hidden, where
 * frames may not run.
 */
async function waitForSidebar(page, workspaceIds) {
  return page.evaluate(
    ({ selector, workspaceIds: ids, pageSize, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const started = performance.now();
        const expected = Math.min(pageSize, ids.length);
        let firstRowAt = null;
        const headers = () =>
          ids.filter((id) =>
            document.querySelector(
              `[data-testid="sidebar-project-header-${id}"]`,
            ),
          ).length;
        const check = () => {
          if (firstRowAt === null) {
            const row = document.querySelector(selector);
            if (row && row.getBoundingClientRect().height > 0)
              firstRowAt = performance.now();
          }
          const shown = headers();
          if (firstRowAt !== null && shown >= expected) {
            resolve({
              timeOrigin: performance.timeOrigin,
              firstRowAt,
              firstProjectPageAt: performance.now(),
              headers: shown,
            });
            return;
          }
          if (performance.now() - started > timeoutMs) {
            reject(
              new Error(
                firstRowAt === null
                  ? `The sidebar did not show a worktree row within ${timeoutMs} ms`
                  : `The sidebar showed ${shown} of the first ${expected} workspace headers within ${timeoutMs} ms`,
              ),
            );
            return;
          }
          if (document.hidden) setTimeout(check, 16);
          else requestAnimationFrame(check);
        };
        check();
      }),
    {
      selector: W5_ROW_SELECTOR,
      workspaceIds,
      pageSize: W5_SIDEBAR_PROJECT_PAGE,
      timeoutMs: FIRST_ROW_TIMEOUT_MS,
    },
  );
}

/** Main's W5 marks and J1 milestones, on main's clock (ms since process start). */
async function readStartupMilestones(
  helpers,
  electronApp,
  page,
  launchEpochMs,
) {
  const [main, renderer] = await Promise.all([
    evaluateMainWithRetry(() =>
      electronApp.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        marks: globalThis.__CANOPY_E2E_STARTUP_MARKS__ ?? null,
        bootstrapCompleteMs: performance.nodeTiming?.bootstrapComplete ?? null,
      })),
    ),
    page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation');
      return {
        timeOrigin: performance.timeOrigin,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
        reactFirstCommitMs:
          window.__CANOPY_REACT_WORK__?.snapshot().milestones
            ?.firstCommitAtMs ?? null,
      };
    }),
  ]);
  return {
    j1: helpers.startupJourneyMilestones({ launchEpochMs, main, renderer }),
    marks: main.marks ?? {},
  };
}

const finite = (entries) =>
  Object.fromEntries(entries.filter(([, value]) => Number.isFinite(value)));

/**
 * Startup to first sidebar row and to the first project page, plus the
 * eager-attach stand-in: `w5_store_ready_ms` (daemon arm only) and
 * `w5_first_read_served_ms`, both on main's clock (ms since main started).
 * The settled fixture makes startup read-only: `w5StartupCommits` counts W5
 * commits since the window opened at DOMContentLoaded (the monitor resets the
 * counters there), and must be 0.
 */
async function runW5StoreStartup(
  helpers,
  { page, electronApp, tasks, fixture, launchStartedAt },
) {
  const launchEpochMs = performance.timeOrigin + launchStartedAt;
  const sidebar = await waitForSidebar(page, fixture.workspaceIds);
  const fromLaunch = (at) => sidebar.timeOrigin + at - launchEpochMs;
  const { j1, marks } = await readStartupMilestones(
    helpers,
    electronApp,
    page,
    launchEpochMs,
  );
  tasks.timings.w5 = finite([
    ['first_sidebar_row_ms', fromLaunch(sidebar.firstRowAt)],
    ['first_project_page_ms', fromLaunch(sidebar.firstProjectPageAt)],
    ['w5_store_ready_ms', marks.w5StoreReady],
    ['w5_first_read_served_ms', marks.w5FirstReadServed],
  ]);
  tasks.timings.j1 = j1;
  const sinceWindow = await readW5Counters(electronApp);
  return {
    w5Workspaces: fixture.workspaceIds.length,
    w5LargeWorkspaceWorktrees: fixture.largeRowIds.length,
    w5ProjectHeadersShown: sidebar.headers,
    w5StartupCommits: sinceWindow ? w5CommitAttempts(sinceWindow.w5) : null,
    w5StartupCaptures: sinceWindow?.w5['host.capture'] ?? null,
    ...w5CaptureCost(sinceWindow?.w5),
    ...tasks.timings.w5,
  };
}

/**
 * Per-capture cost and commit-log history behind it (CAN-5562): each
 * capture's chain evidence aggregates every retained decision of each
 * captured path, so its cost grows with history. Means over a delta.
 */
export function w5CaptureCost(delta) {
  const captures = delta?.['host.capture'] ?? 0;
  if (!delta || captures === 0)
    return {
      w5CaptureMeanMs: null,
      w5CaptureMeanChainDecisions: null,
      w5CaptureMeanRetainedCommits: null,
    };
  return {
    w5CaptureMeanMs: (delta['host.capture.us'] ?? 0) / captures / 1000,
    w5CaptureMeanChainDecisions:
      (delta['host.capture.chainDecisions'] ?? 0) / captures,
    w5CaptureMeanRetainedCommits:
      (delta['host.capture.retainedCommits'] ?? 0) / captures,
  };
}

/**
 * K renderer reloads to the first worktree row, before the measured window.
 * Each task carries its `w5` delta; captures per reload are summarized.
 */
async function reloadW5StoreSidebar(
  { recordTask },
  { page, electronApp, config, tasks },
) {
  for (let reload = 0; reload < config.w5StoreReloads; reload += 1) {
    const before = await readW5Counters(electronApp);
    await recordTask(
      tasks,
      'w5_sidebar_reload',
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page
          .locator(W5_ROW_SELECTOR)
          .first()
          .waitFor({ state: 'visible', timeout: FIRST_ROW_TIMEOUT_MS });
      },
      { reload },
    );
    tasks.at(-1).w5 = w5Delta(before, await readW5Counters(electronApp));
  }
}

/** K `projects:load` calls, the sidebar's reload IPC, in the measured window. */
async function runW5StoreReload(
  { recordTask },
  { page, electronApp, config, tasks },
) {
  for (let load = 0; load < config.w5StoreReloads; load += 1) {
    const before = await readW5Counters(electronApp);
    await recordTask(
      tasks,
      'w5_projects_load',
      () => page.evaluate(() => window.api.loadProjects().then(() => null)),
      { load },
    );
    tasks.at(-1).w5 = w5Delta(before, await readW5Counters(electronApp));
  }
  return {
    w5Reloads: config.w5StoreReloads,
    ...w5CapturesPer(tasks, 'w5_sidebar_reload', 'w5CapturesPerReload'),
    ...w5CapturesPer(tasks, 'w5_projects_load', 'w5CapturesPerProjectsLoad'),
    ...w5ReadOnlyCheck(tasks, ['w5_sidebar_reload', 'w5_projects_load']),
    ...w5CaptureCost(
      sumW5Deltas(
        tasks.filter((task) => task.kind === 'w5_projects_load' && task.w5),
      ),
    ),
  };
}

/** The sum of the tasks' `w5` deltas, or null when none has one. */
export function sumW5Deltas(tasks) {
  const deltas = tasks.map((task) => task.w5).filter(Boolean);
  if (deltas.length === 0) return null;
  const sum = {};
  for (const delta of deltas)
    for (const [key, value] of Object.entries(delta))
      sum[key] = (sum[key] ?? 0) + value;
  return sum;
}

/**
 * W5 commits attempted during the read-only tasks of `kinds`. The settled
 * fixture makes these 0; anything else is a writer the reload numbers
 * include, and in the daemon arm a refusal and its recovery.
 */
export function w5ReadOnlyCheck(tasks, kinds) {
  const counted = tasks.filter((task) => kinds.includes(task.kind) && task.w5);
  return {
    w5ReadTaskCommits: counted.reduce(
      (sum, task) => sum + w5CommitAttempts(task.w5),
      0,
    ),
    w5ReadTaskSamples: counted.length,
  };
}

/**
 * Host captures per task of `kind`, from the tasks' `w5` deltas: the median,
 * and how many tasks had counters. Expect about 2 per load in either arm.
 */
export function w5CapturesPer(tasks, kind, name) {
  const captures = tasks
    .filter((task) => task.kind === kind && task.w5)
    .map((task) => task.w5['host.capture'] ?? 0);
  return {
    [`${name}P50`]: captures.length > 0 ? percentile(captures, 0.5) : null,
    [`${name}Samples`]: captures.length,
  };
}

async function waitForRow({ sidebarWorktreeRow }, page, worktreeId, state) {
  await sidebarWorktreeRow(page, worktreeId).waitFor({
    state,
    timeout: FIRST_ROW_TIMEOUT_MS,
  });
}

/** Times one IPC and, separately, the IPC start to its sidebar effect. */
async function timedIpcToRow(
  { recordTask },
  tasks,
  kind,
  metadata,
  invoke,
  settle,
) {
  let ipcMs = null;
  const value = await recordTask(
    tasks,
    `${kind}_to_row`,
    async () => {
      const startedAt = performance.now();
      const result = await invoke();
      ipcMs = performance.now() - startedAt;
      await settle(result);
      return result;
    },
    metadata,
  );
  tasks.push({
    kind: `${kind}_ipc`,
    status: 'ok',
    durationMs: ipcMs,
    ...metadata,
  });
  return value;
}

/**
 * N worktree create and archive cycles, then the write burst: an unrecorded
 * warm-up of `w5StoreBurstWarmup` label writes, `w5StoreBurstSequential`
 * sequential label toggles, and `w5StoreBurstConcurrent` concurrent ones.
 * Each label write is one `core.worktree.update` list commit. A timed
 * `projects:load` after the burst samples capture cost at the history the
 * run built.
 */
async function runW5StoreWrites(
  helpers,
  { page, electronApp, config, tasks, fixture },
) {
  const {
    FatalWaitError,
    readWorktreeSetupStatus,
    recordTask,
    sidebarWorktreeRow,
    waitUntil,
  } = helpers;
  const projectId = fixture.largeWorkspaceId;
  const rowIds = [...fixture.largeRowIds];
  await waitForRow(helpers, page, rowIds[0], 'attached');
  const cycles = [];
  for (let cycle = 0; cycle < config.w5StoreWriteCycles; cycle += 1) {
    const before = await readW5Counters(electronApp);
    const metadata = { cycle };
    let created;
    try {
      created = await timedIpcToRow(
        helpers,
        tasks,
        'w5_worktree_create',
        metadata,
        () =>
          page.evaluate((request) => window.api.createWorktree(request), {
            projectId,
            repoPath: fixture.repoPath,
            existingWorktreeIds: rowIds,
            baseBranch: 'main',
            branchName: `perf-w5-created-${cycle + 1}`,
          }),
        (response) => waitForRow(helpers, page, response.id, 'visible'),
      );
    } catch (error) {
      await failOnWriteRefusal(electronApp, before, error);
    }
    // Git setup is not part of the store's cost; archive once it settled.
    await waitUntil(
      async () => {
        const status = await readWorktreeSetupStatus(
          sidebarWorktreeRow(page, created.id),
        );
        if (status.error)
          throw new FatalWaitError(
            `Worktree ${created.id} setup failed: ${status.error}`,
          );
        return status.ready;
      },
      {
        timeoutMs: 120_000,
        label: `worktree ${created.id} setup`,
        intervalMs: 50,
      },
    );
    const createDelta = w5Delta(before, await readW5Counters(electronApp));
    const archiveBefore = await readW5Counters(electronApp);
    await timedIpcToRow(
      helpers,
      tasks,
      'w5_worktree_archive',
      metadata,
      () =>
        page.evaluate((request) => window.api.archiveWorktree(request), {
          projectId,
          repoPath: fixture.repoPath,
          worktreeId: created.id,
          expectedCreatedAt: created.createdAt,
          deleteBranch: true,
        }),
      () => waitForRow(helpers, page, created.id, 'detached'),
    );
    cycles.push({
      worktreeId: created.id,
      create: createDelta,
      archive: w5Delta(archiveBefore, await readW5Counters(electronApp)),
    });
  }

  const label = (worktreeId, value) =>
    page.evaluate((request) => window.api.setWorktreeLabel(request), {
      projectId,
      worktreeId,
      label: value,
    });
  // One list write mints every row's replica, so a short warm-up settles the
  // list and warms the write path without growing its history much.
  const warmBefore = await readW5Counters(electronApp);
  try {
    for (const worktreeId of rowIds.slice(0, config.w5StoreBurstWarmup))
      await label(worktreeId, 'w5-warm');
  } catch (error) {
    await failOnWriteRefusal(electronApp, warmBefore, error);
  }

  // Each write's own `w5` delta, read between writes and outside its timing.
  // The total is the sum of the writes, without the harness's work brackets.
  const sequentialBefore = await readW5Counters(electronApp);
  let previous = sequentialBefore;
  let sequentialTotalMs = 0;
  for (let write = 0; write < config.w5StoreBurstSequential; write += 1) {
    const worktreeId = rowIds[write % rowIds.length];
    // Each pass over the rows writes the other value, so no write is a no-op.
    const pass = Math.floor(write / rowIds.length);
    await recordTask(
      tasks,
      'w5_burst_sequential_write',
      () => label(worktreeId, `w5-burst-${pass % 2}`),
      { write },
    );
    const task = tasks.at(-1);
    sequentialTotalMs += task.durationMs;
    const current = await readW5Counters(electronApp);
    task.w5 = w5Delta(previous, current);
    previous = current;
  }
  const sequential = w5Delta(sequentialBefore, previous);
  const sequentialTasks = tasks.filter(
    (task) => task.kind === 'w5_burst_sequential_write',
  );
  const commitMs = sequentialTasks
    .map((task) => w5CommitMs(task.w5))
    .filter((value) => value !== null);

  const concurrentRows = rowIds.slice(0, config.w5StoreBurstConcurrent);
  const concurrentBefore = await readW5Counters(electronApp);
  const concurrentStartedAt = performance.now();
  await Promise.all(
    concurrentRows.map(async (worktreeId, write) => {
      const startedAt = performance.now();
      await label(worktreeId, 'w5-concurrent');
      tasks.push({
        kind: 'w5_burst_concurrent_write',
        status: 'ok',
        durationMs: performance.now() - startedAt,
        write,
      });
    }),
  );
  const concurrentTotalMs = performance.now() - concurrentStartedAt;
  const concurrent = w5Delta(
    concurrentBefore,
    await readW5Counters(electronApp),
  );

  // One captured read after the burst: capture cost at the history this run
  // built on the hot list path (CAN-5562), which grows with every commit.
  const probeBefore = await readW5Counters(electronApp);
  await recordTask(tasks, 'w5_post_burst_projects_load', () =>
    page.evaluate(() => window.api.loadProjects().then(() => null)),
  );
  const postBurstRead = w5Delta(probeBefore, await readW5Counters(electronApp));

  tasks.timings.w5 = finite([
    ['burst_sequential_total_ms', sequentialTotalMs],
    ['burst_concurrent_total_ms', concurrentTotalMs],
    [
      'burst_sequential_commit_p50_ms',
      commitMs.length > 0 ? percentile(commitMs, 0.5) : null,
    ],
    [
      'burst_sequential_commit_p95_ms',
      commitMs.length > 0 ? percentile(commitMs, 0.95) : null,
    ],
  ]);
  const perToggle = (delta, toggles) =>
    delta && toggles > 0 ? w5CommitAttempts(delta) / toggles : null;
  const labelCommits = (delta) =>
    Math.max(
      delta?.['host.commit.core.worktree.update'] ?? 0,
      delta?.['port.commit'] ?? 0,
    );
  return {
    w5WriteCycles: cycles,
    w5BurstWarmupWrites: Math.min(config.w5StoreBurstWarmup, rowIds.length),
    w5BurstSequentialWrites: config.w5StoreBurstSequential,
    w5BurstConcurrentWrites: concurrentRows.length,
    w5BurstSequential: sequential,
    w5BurstConcurrent: concurrent,
    w5BurstSequentialCommitsPerToggle: perToggle(
      sequential,
      config.w5StoreBurstSequential,
    ),
    w5BurstConcurrentCommitsPerToggle: perToggle(
      concurrent,
      concurrentRows.length,
    ),
    // Host commits other than the label writes: background writers the burst
    // timings include. The settled fixture makes this 0 in-process.
    w5BurstSequentialOtherCommits: sequential
      ? hostCommits(sequential) -
        (sequential['host.commit.core.worktree.update'] ?? 0)
      : null,
    w5BurstSequentialLabelCommits: sequential ? labelCommits(sequential) : null,
    w5BurstSequentialCommitSamples: commitMs.length,
    w5BurstSequentialRetries: sequential?.['retry.attempt'] ?? 0,
    w5BurstConcurrentRetries: concurrent?.['retry.attempt'] ?? 0,
    // Captures during the burst (none expected) and in the read after it.
    w5BurstCaptureCost: w5CaptureCost(sequential),
    w5PostBurstRead: {
      commits: w5CommitAttempts(postBurstRead),
      ...w5CaptureCost(postBurstRead),
    },
  };
}

/**
 * Main-side commit time of one write, in ms: its record-port commit time in
 * the daemon arm, which contains the host commit, else its host commit time.
 * Null without counters or when the write committed nothing.
 */
export function w5CommitMs(delta) {
  if (!delta) return null;
  const port = delta['port.commit.us'] ?? 0;
  const host = delta['host.commit.us'] ?? 0;
  const us = (delta['port.commit'] ?? 0) > 0 ? port : host;
  return w5CommitAttempts(delta) > 0 ? us / 1000 : null;
}
