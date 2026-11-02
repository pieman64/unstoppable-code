// W6-0 (CAN-4401): the in-process record decision port. A fake port records
// the decisions the six record functions build; replaying them through the
// in-process port on a copy of the data root must write the same
// `worktrees.json` bytes, and return the same outcomes, as the record
// functions writing directly. Runs the real workspace persistence module.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

type MockPortCall =
  | { entry: 'row'; args: [WorktreeRecordTarget, WorktreeRowDecision] }
  | { entry: 'list'; args: [string, WorktreeListDecision] };
const mockPortCalls: MockPortCall[] = [];
const mockPortOutcomes: unknown[] = [];
let mockRecordOnly = false;

jest.mock('../worktree-record-decision-port', () => {
  const actual = jest.requireActual<typeof Port>(
    '../worktree-record-decision-port',
  );
  const record = async (
    call: MockPortCall,
    apply: () => Promise<unknown>,
  ): Promise<unknown> => {
    // Recorded as JSON, so a replay proves the decision is plain data.
    mockPortCalls.push(JSON.parse(JSON.stringify(call)) as MockPortCall);
    if (mockRecordOnly) return undefined;
    const outcome = await apply();
    mockPortOutcomes.push(outcome);
    return outcome;
  };
  return {
    applyWorktreeRowDecision: (
      target: WorktreeRecordTarget,
      decision: WorktreeRowDecision,
    ): Promise<unknown> =>
      record({ entry: 'row', args: [target, decision] }, () =>
        actual.applyWorktreeRowDecision(target, decision),
      ),
    applyWorktreeListDecision: (
      workspaceId: string,
      decision: WorktreeListDecision,
    ): Promise<unknown> =>
      record({ entry: 'list', args: [workspaceId, decision] }, () =>
        actual.applyWorktreeListDecision(workspaceId, decision),
      ),
  };
});

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { getWorkspaceWorktreesFilePath } from '../paths';
import * as persistence from '../workspace-persistence';
import { registerWorkspaceTypes } from '../workspace-registry';
import type * as Port from '../worktree-record-decision-port';
import type {
  W5RecordDecisionPort,
  WorktreeListDecision,
  WorktreeRecordTarget,
  WorktreeRowDecision,
} from '../worktree-record-decisions';

// This module implements the port's row and list members; the rest are in
// `workspace-record-decision-port.ts`.
const port: Pick<
  W5RecordDecisionPort,
  'applyWorktreeRowDecision' | 'applyWorktreeListDecision'
> = jest.requireActual<typeof Port>('../worktree-record-decision-port');

import {
  CREATED_AT,
  NOW,
  SCENARIOS,
  WORKSPACE_ID,
  badges,
  creation,
  issue,
  prStatus,
  row,
  target,
} from './fixtures/worktree-record-scenarios';

describe('worktree record decision port (real fs)', () => {
  let originalDataDir: string | undefined;
  const dataDirs: string[] = [];

  async function newDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-record-port-'));
    dataDirs.push(dir);
    return dir;
  }

  function useDataDir(dir: string): string {
    process.env.CANOPY_DATA_DIR = dir;
    persistence.clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    return getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  }

  async function readBytes(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      // fs errors come from another realm, so test the shape, not the class.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    }
  }

  async function replay(calls: MockPortCall[]): Promise<unknown[]> {
    const outcomes: unknown[] = [];
    for (const call of calls) {
      outcomes.push(
        call.entry === 'row'
          ? await port.applyWorktreeRowDecision(...call.args)
          : await port.applyWorktreeListDecision(...call.args),
      );
    }
    return outcomes;
  }

  beforeEach(() => {
    // Only the clock is fixed; file system timers stay real.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
    originalDataDir = process.env.CANOPY_DATA_DIR;
    mockPortCalls.length = 0;
    mockPortOutcomes.length = 0;
    mockRecordOnly = false;
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    registerWorkspaceTypes(new Map());
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('covers every decision kind', async () => {
    const kinds = new Set<string>();
    for (const scenario of SCENARIOS) {
      useDataDir(await newDataDir());
      mockRecordOnly = true;
      mockPortCalls.length = 0;
      await scenario.run();
      for (const call of mockPortCalls) kinds.add(call.args[1].kind);
    }
    expect(kinds.size).toBe(15);
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
    'replays %s through the in-process port to identical bytes and outcomes',
    async (_name, scenario) => {
      const direct = await newDataDir();
      const copy = await newDataDir();
      const directFile = useDataDir(direct);
      if (scenario.seed !== null) {
        await mkdir(path.dirname(directFile), { recursive: true });
        await writeFile(
          directFile,
          JSON.stringify({ version: 1, worktrees: scenario.seed }, null, 2),
        );
      }
      await cp(direct, copy, { recursive: true });

      await scenario.run();
      const directCalls = mockPortCalls.splice(0);
      const directOutcomes = mockPortOutcomes.splice(0);
      const directBytes = await readBytes(directFile);

      const copyFile = useDataDir(copy);
      mockRecordOnly = true;
      await scenario.run();
      const recorded = mockPortCalls.splice(0);
      expect(recorded).toEqual(directCalls);
      expect(await readBytes(copyFile)).toBe(
        scenario.seed === null
          ? null
          : JSON.stringify({ version: 1, worktrees: scenario.seed }, null, 2),
      );

      const replayOutcomes = await replay(recorded);
      expect(replayOutcomes).toEqual(directOutcomes);
      expect(await readBytes(copyFile)).toBe(directBytes);
    },
  );

  describe('the outcome comes from the last pass of the updater', () => {
    function updaterRunsOn(rows: WorktreeData[]): void {
      jest
        .spyOn(persistence, 'updateWorkspaceWorktree')
        .mockImplementation((_workspaceId, _worktreeId, updater) => {
          for (const current of rows) updater(current);
          return Promise.resolve(true);
        });
    }

    it('reports a git row from its last pass', async () => {
      const last = row('a', { branchGroupingOverride: 'group' });
      updaterRunsOn([row('a'), last]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'git.split-child-grouping',
        }),
      ).resolves.toEqual({ status: 'unchanged', worktree: last });
    });

    it('reports a recovery of a replaced incarnation as not-found', async () => {
      updaterRunsOn([
        row('a', { setupPhase: 'git-pending' }),
        row('a', { createdAt: '2026-10-09T00:00:00.000Z' }),
      ]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'recovery.promote-pending',
          createdAt: CREATED_AT,
          branchName: 'feature',
        }),
      ).resolves.toEqual({ status: 'not-found', worktree: null });
    });

    it('reports a watermark and badges from their last pass', async () => {
      const last = row('a', {
        lastTouchedAt: '2026-10-09T00:00:00.000Z',
        chatBadges: badges(),
      });
      updaterRunsOn([row('a'), last]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'activity.watermark',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
      ).resolves.toEqual({ worktrees: [last], changed: false });
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'chatBadges',
          source: 'launch_backfill',
          summary: badges({ chatName: 'Named' }),
        }),
      ).resolves.toEqual({ status: 'unchanged' });
    });

    it('reports a merged base retarget from its last pass', async () => {
      jest
        .spyOn(persistence, 'updateWorkspaceWorktrees')
        .mockImplementation(async (_workspaceId, updater) => {
          await updater([row('a', { trackedBaseBranch: 'feature' })]);
          return updater([row('a', { trackedBaseBranch: 'main' })]);
        });
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'git.merged-base-retarget',
          repoIds: [null],
          mergedBranchName: 'feature',
          mergedIntoBranchName: 'main',
        }),
      ).resolves.toEqual({ status: 'unchanged', updates: [] });
    });

    // Each family keeps its record function's outcome formula when the
    // writer's `found` and whether the updater ran disagree (as with a mocked
    // writer): git observations follow the writer's `found`; repair and
    // reconcile, badges and the watermark follow the updater.
    const hiddenRow = row('a', {
      hidden: true,
      setupPhase: 'git-pending',
      creation: { ...creation, state: 'pending', phase: 'git-setup' },
    });
    const FAMILY_DECISIONS: {
      decision: WorktreeRowDecision;
      /** The row the updater sees; defaults to `hiddenRow`. */
      current?: WorktreeData;
      foundWithoutPass: unknown;
      passWithoutFound: (next: WorktreeData) => unknown;
    }[] = [
      ...(
        [
          {
            kind: 'git.branch',
            branchName: 'next',
            updatesSidebarBranch: true,
          },
          { kind: 'git.pr-status', status: prStatus(['open']) },
          { kind: 'git.split-child-grouping' },
          {
            kind: 'git.split-original-retarget',
            branchName: 'integration',
            trackedBaseBranch: 'main',
          },
        ] satisfies WorktreeRowDecision[]
      ).map((decision) => ({
        decision,
        foundWithoutPass: { status: 'unchanged', worktree: null },
        passWithoutFound: () => ({ status: 'not-found', worktree: null }),
      })),
      ...(
        [
          { kind: 'health', source: 'health-check', issue: issue() },
          {
            kind: 'discovery.environment',
            discovery: {
              slashCommands: [],
              mcpServers: [],
              discoveredAt: '2026-10-02T00:00:00.000Z',
              providerType: 'claude',
            },
          },
          { kind: 'discovery.branch-prompt', sent: true },
          {
            kind: 'recovery.expose-create-reservation',
            createdAt: CREATED_AT,
            operationId: 'op-1',
            worktreePath: '/worktrees/a',
          },
          {
            kind: 'recovery.expose-split-reservation',
            createdAt: CREATED_AT,
            worktreePath: '/worktrees/a',
          },
        ] satisfies WorktreeRowDecision[]
      ).map((decision) => ({
        decision,
        foundWithoutPass: { status: 'not-found', worktree: null },
        passWithoutFound: (next: WorktreeData) => ({
          status: 'recorded',
          worktree: next,
        }),
      })),
      ...(
        [
          {
            decision: {
              kind: 'recovery.promote-pending',
              createdAt: CREATED_AT,
              branchName: 'feature',
            },
            current: row('a', { setupPhase: 'git-pending' }),
          },
          {
            decision: {
              kind: 'recovery.complete-source-root-repair',
              createdAt: CREATED_AT,
              operationId: 'op-1',
            },
            current: row('a', { setupPhase: 'git-pending', creation }),
          },
        ] satisfies { decision: WorktreeRowDecision; current: WorktreeData }[]
      ).map((entry) => ({
        ...entry,
        foundWithoutPass: { status: 'not-found', worktree: null },
        passWithoutFound: (next: WorktreeData) => ({
          status: 'recorded',
          worktree: next,
        }),
      })),
      {
        decision: {
          kind: 'chatBadges',
          source: 'launch_backfill',
          summary: badges(),
        },
        foundWithoutPass: { status: 'not-found' },
        passWithoutFound: () => ({ status: 'recorded' }),
      },
      {
        decision: {
          kind: 'activity.watermark',
          touchedAt: '2026-10-05T12:00:00.000Z',
        },
        foundWithoutPass: { worktrees: [], changed: false },
        passWithoutFound: (next: WorktreeData) => ({
          worktrees: [next],
          changed: true,
        }),
      },
    ];

    it.each(FAMILY_DECISIONS.map((entry) => [entry.decision.kind, entry]))(
      'reports %s when the writer finds the row without running the updater',
      async (_kind, { decision, foundWithoutPass }) => {
        const write = jest
          .spyOn(persistence, 'updateWorkspaceWorktree')
          .mockResolvedValue(true);
        await expect(
          port.applyWorktreeRowDecision(target, decision),
        ).resolves.toEqual(foundWithoutPass);
        expect(write).toHaveBeenCalledTimes(1);
      },
    );

    it.each(FAMILY_DECISIONS.map((entry) => [entry.decision.kind, entry]))(
      'reports %s when the updater runs but the writer reports not found',
      async (_kind, { decision, current = hiddenRow, passWithoutFound }) => {
        let next: WorktreeData | undefined;
        jest
          .spyOn(persistence, 'updateWorkspaceWorktree')
          .mockImplementation((_workspaceId, _worktreeId, updater) => {
            next = updater(current);
            return Promise.resolve(false);
          });
        const outcome = await port.applyWorktreeRowDecision(target, decision);
        expect(next).toBeDefined();
        expect(next).not.toBe(current);
        if (next) expect(outcome).toEqual(passWithoutFound(next));
      },
    );

    it('reports a list decision the writer never applied as unchanged', async () => {
      jest.spyOn(persistence, 'updateWorkspaceWorktrees').mockResolvedValue([]);
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'git.merged-base-retarget',
          repoIds: [null],
          mergedBranchName: 'feature',
          mergedIntoBranchName: 'main',
        }),
      ).resolves.toEqual({ status: 'unchanged', updates: [] });
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'activity.auto-delete-baseline',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
      ).resolves.toEqual({ worktrees: [], changed: false });
    });

    it('reports a recovery whose last pass is the same incarnation', async () => {
      updaterRunsOn([
        row('a', { createdAt: '2026-10-09T00:00:00.000Z' }),
        row('a', { setupPhase: 'git-pending' }),
      ]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'recovery.promote-pending',
          createdAt: CREATED_AT,
          branchName: 'feature',
        }),
      ).resolves.toMatchObject({
        status: 'recorded',
        worktree: { id: 'a', setupPhase: 'git-ready' },
      });
    });

    it('reads the clock inside each pass', async () => {
      const stamps: string[] = [];
      jest
        .spyOn(persistence, 'updateWorkspaceWorktree')
        .mockImplementation((_workspaceId, _worktreeId, updater) => {
          for (const at of ['2026-10-18T00:00:00.000Z', NOW.toISOString()]) {
            jest.setSystemTime(new Date(at));
            stamps.push(
              updater(row('a', { hidden: true })).healthIssue?.checkedAt ?? '',
            );
          }
          return Promise.resolve(true);
        });
      await port.applyWorktreeRowDecision(target, {
        kind: 'recovery.expose-split-reservation',
        createdAt: CREATED_AT,
        worktreePath: '/worktrees/a',
      });
      expect(stamps).toEqual(['2026-10-18T00:00:00.000Z', NOW.toISOString()]);
    });
  });
});
