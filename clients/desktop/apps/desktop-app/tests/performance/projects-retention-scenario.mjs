import { PassThrough } from 'node:stream';
import { expect } from '@playwright/test';
import { countHeapSnapshotShapes } from '../../../../scripts/lib/heapsnapshot-summary.mjs';
import { seedDemoWorkspaces } from '../electron/demoWorkspaces.mjs';

// Renderer retention of old `projects` lists (docs/planning/2026-11-07-renderer-memory).
// Each cycle reloads the projects (the path worktree events and file changes
// take) and selects a worktree row, which is what made render closures chain
// old lists together. Opt-in, perf profile and local runs only (not CI).
const WARMUP_CYCLES = 20;
const MEASURED_CYCLES = 40;
const CYCLE_PAUSE_MS = 250;
const SETTLE_MS = 2_000;

/**
 * Growth allowed between the warmed-up and the final snapshot. With phase 01
 * (structural sharing) a cycle retains under 1 project object; before it, about
 * 10. Discovery data must never be copied. `MediaQuerySet` growth guards the
 * Chrome 156 table rule (#8326). Animations and listeners are reported only.
 */
export const PROJECTS_RETENTION_CEILINGS = Object.freeze({
  projectObjectsPerCycle: 2,
  discoveryObjects: 0,
  mediaQuerySets: 10,
});

const COUNTED_SHAPES = Object.freeze({
  natives: ['blink::MediaQuerySet', 'Animation', 'V8EventListener'],
  objects: {
    project: ['worktrees', 'defaultPluginSelections'],
    discovery: ['slashCommands', 'discoveredAt'],
  },
});

export function prepareProjectsRetention(userDataDir) {
  // The first-wave demo set: several workspaces, each with a worktree row.
  seedDemoWorkspaces({ userDataDir });
  return {};
}

async function countRetention(cdp) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snapshot = new PassThrough();
  const counted = countHeapSnapshotShapes(snapshot, COUNTED_SHAPES);
  // Observed now so a failed snapshot surfaces below, not as an unhandled
  // rejection that would end the whole perf runner.
  counted.catch(() => undefined);
  const onChunk = ({ chunk }) => snapshot.write(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    snapshot.end();
  } catch (error) {
    snapshot.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  const counts = await counted;
  return {
    projectObjects: counts.objects.project,
    discoveryObjects: counts.objects.discovery,
    mediaQuerySets: counts.natives['blink::MediaQuerySet'],
    animations: counts.natives.Animation,
    eventListeners: counts.natives.V8EventListener,
    heapSelfBytes: counts.totalSelfSize,
  };
}

async function worktreeCycler(page) {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__canopyProjectsTestApi)), {
      message: 'projects-retention needs the E2E build (not --release-like)',
    })
    .toBe(true);
  const rows = page.getByTestId('worktree-row');
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(1);
  const rowCount = await rows.count();
  return {
    rowCount,
    cycle: async (index) => {
      // requireSuccess: a failed reload must fail the run, not count as a cycle.
      await page.evaluate(() =>
        window.__canopyProjectsTestApi.loadProjects({ requireSuccess: true }),
      );
      await page.waitForTimeout(CYCLE_PAUSE_MS);
      await rows.nth(index % rowCount).click();
      await page.waitForTimeout(CYCLE_PAUSE_MS);
    },
  };
}

/**
 * Runs before the measured window: heap snapshots freeze the renderer for
 * seconds, which the responsiveness verdict would otherwise report as a hang.
 * An exceeded ceiling throws, so the scenario fails.
 */
export async function measureProjectsRetention({ page, fixture }) {
  const { rowCount, cycle } = await worktreeCycler(page);
  const cdp = await page.context().newCDPSession(page);
  for (let index = 0; index < WARMUP_CYCLES; index += 1) await cycle(index);
  const warm = await countRetention(cdp);
  for (let index = 0; index < MEASURED_CYCLES; index += 1) {
    await cycle(WARMUP_CYCLES + index);
  }
  const final = await countRetention(cdp);
  await cdp.detach();

  const growth = Object.fromEntries(
    Object.keys(final).map((key) => [key, final[key] - warm[key]]),
  );
  const exceeded = [];
  if (
    growth.projectObjects >
    PROJECTS_RETENTION_CEILINGS.projectObjectsPerCycle * MEASURED_CYCLES
  ) {
    exceeded.push(
      `project objects +${growth.projectObjects} over ${MEASURED_CYCLES} cycles`,
    );
  }
  if (growth.discoveryObjects > PROJECTS_RETENTION_CEILINGS.discoveryObjects) {
    exceeded.push(`discovery objects +${growth.discoveryObjects}`);
  }
  if (growth.mediaQuerySets > PROJECTS_RETENTION_CEILINGS.mediaQuerySets) {
    exceeded.push(`MediaQuerySet +${growth.mediaQuerySets}`);
  }
  fixture.projectsRetention = {
    worktreeRows: rowCount,
    warmupCycles: WARMUP_CYCLES,
    measuredCycles: MEASURED_CYCLES,
    ceilings: PROJECTS_RETENTION_CEILINGS,
    warm,
    final,
    growth,
  };
  if (exceeded.length > 0) {
    throw new Error(
      `Renderer projects retention exceeded its ceilings: ${exceeded.join('; ')}`,
    );
  }
}

/**
 * The measured window only settles: worktree-switch responsiveness belongs to
 * the `worktrees` scenario, and timing it here made this verdict host noise.
 */
export async function runProjectsRetention({ page, fixture }) {
  await page.waitForTimeout(SETTLE_MS);
  return { projectsRetention: fixture.projectsRetention };
}
