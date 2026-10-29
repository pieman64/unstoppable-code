import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { PlanFileRef, PlanFileScope } from '../lib/plan-file-sync';

const mockGetCanopyDataDir = jest.fn<string, []>();
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
}));
jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(),
}));

interface ScopeKey {
  projectId: string;
  worktreeId: string;
}
const callOrder: string[] = [];
// Stand-in for `ChatStateService.deleteScope`: the real repository commits
// removal of every chat, then drops the manifest and the v2 directory.
const mockedDeleteScope = jest.fn(async (scope: ScopeKey): Promise<void> => {
  callOrder.push(`deleteScope:${scope.projectId}/${scope.worktreeId}`);
  const dataDir = mockGetCanopyDataDir();
  const scopeId = `plan-explore-chats-${scope.worktreeId}`;
  await rm(join(dataDir, 'chat-storage-manifests', `${scopeId}.json`), {
    force: true,
  });
  await rm(join(dataDir, 'chat-storage-v2', scopeId), {
    recursive: true,
    force: true,
  });
});
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { deleteScope: typeof mockedDeleteScope } => ({
    deleteScope: mockedDeleteScope,
  }),
}));
const mockedDeleteWorktreeDocs = jest.fn();
jest.mock('../chat-search/service', () => ({
  getChatSearchService: (): { deleteWorktreeDocs: jest.Mock } => ({
    deleteWorktreeDocs: mockedDeleteWorktreeDocs,
  }),
}));
const mockedCleanupLiveWorktreeState = jest.fn(
  (projectId: string, worktreeId: string): Promise<void> => {
    callOrder.push(`live:${projectId}/${worktreeId}`);
    return Promise.resolve();
  },
);
jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: (
    projectId: string,
    worktreeId: string,
  ): Promise<void> => mockedCleanupLiveWorktreeState(projectId, worktreeId),
}));
const mockedForgetPlanFile = jest.fn<void, [PlanFileRef]>();
const mockedForgetScope = jest.fn<void, [PlanFileScope]>();
jest.mock('../lib/plan-file-sync', () => ({
  getPlanFileSyncService: (): {
    forgetPlanFile: (ref: PlanFileRef) => void;
    forgetScope: (scope: PlanFileScope) => void;
  } => ({
    forgetPlanFile: (ref: PlanFileRef): void => {
      mockedForgetPlanFile(ref);
    },
    forgetScope: (scope: PlanFileScope): void => {
      mockedForgetScope(scope);
    },
  }),
}));

import {
  releasePlanFileSyncForWorktree,
  removePlanExploreChat,
  removePlanExploreChatsForWorktree,
} from '../lib/plan-explore-cleanup';
import {
  getPlanExploreTarget,
  listPlanExploreTargetIdsForScope,
  registerPlanExploreTarget,
  removePlanExploreTarget,
} from '../lib/plan-explore-registry';

const W1 = { projectId: 'ws-1', worktreeId: 'wt-1' };
const W2 = { projectId: 'ws-1', worktreeId: 'wt-2' };

let dataDir = '';

async function writeFixture(filePath: string, content = 'x'): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface SeededPlan {
  manifest: string;
  storageDir: string;
  attachmentsDir: string;
  worktreeDataDir: string;
  planFileDir: string;
}

function planFileDirFor(
  planId: string,
  target: { projectId: string; worktreeId: string },
): string {
  return join(
    dataDir,
    'workspaces',
    target.projectId,
    'worktree-data',
    target.worktreeId,
    'plan-explore',
    planId,
  );
}

async function seedExploredPlan(
  planId: string,
  target: { projectId: string; worktreeId: string },
): Promise<SeededPlan> {
  await registerPlanExploreTarget(planId, target);
  const scopeId = `plan-explore-chats-${planId}`;
  const seeded: SeededPlan = {
    manifest: join(dataDir, 'chat-storage-manifests', `${scopeId}.json`),
    storageDir: join(dataDir, 'chat-storage-v2', scopeId),
    attachmentsDir: join(
      dataDir,
      'app-workspaces',
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      'attachments',
      planId,
    ),
    worktreeDataDir: join(
      dataDir,
      'app-workspaces',
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      'worktree-data',
      planId,
    ),
    planFileDir: planFileDirFor(planId, target),
  };
  await writeFixture(
    seeded.manifest,
    JSON.stringify({ version: 1, scopeId, format: 'v2' }),
  );
  await writeFixture(join(seeded.storageDir, 'transcripts', 'chat-1.jsonl'));
  await writeFixture(join(seeded.attachmentsDir, 'notes.txt'));
  await writeFixture(
    join(seeded.worktreeDataDir, 'claude-terminal', 'state.json'),
  );
  await writeFixture(join(seeded.planFileDir, 'plan.md'), '# plan');
  return seeded;
}

async function expectSeededPlanState(
  seeded: SeededPlan,
  present: boolean,
): Promise<void> {
  await expect(exists(seeded.manifest)).resolves.toBe(present);
  await expect(exists(seeded.storageDir)).resolves.toBe(present);
  await expect(exists(seeded.attachmentsDir)).resolves.toBe(present);
  await expect(exists(seeded.worktreeDataDir)).resolves.toBe(present);
  await expect(exists(seeded.planFileDir)).resolves.toBe(present);
}

interface W2ScopeObservation {
  liveTeardownCalls: unknown[][];
  sentinelDeleteScopeCalls: unknown[][];
  registryRow: { projectId: string; worktreeId: string } | null;
  planFilePresent: boolean;
  chatStoragePresent: boolean;
}

const UNTOUCHED_W2: W2ScopeObservation = {
  liveTeardownCalls: [],
  sentinelDeleteScopeCalls: [],
  registryRow: W2,
  planFilePresent: true,
  chatStoragePresent: true,
};

/** Every effect a W1 cleanup could have on W2's same-id plan, in one diff. */
async function observeW2Scope(seeded: SeededPlan): Promise<W2ScopeObservation> {
  return {
    liveTeardownCalls: mockedCleanupLiveWorktreeState.mock.calls,
    sentinelDeleteScopeCalls: mockedDeleteScope.mock.calls,
    registryRow: await getPlanExploreTarget('plan-x'),
    planFilePresent: await exists(seeded.planFileDir),
    chatStoragePresent: await exists(seeded.storageDir),
  };
}

describe('plan-explore cleanup', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plan-explore-cleanup-'));
    mockGetCanopyDataDir.mockReturnValue(dataDir);
    callOrder.length = 0;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('removePlanExploreChat', () => {
    it('removes every artifact of the plan and leaves a sibling plan untouched', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      const planB = await seedExploredPlan('plan-b', W1);

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([]);

      await expectSeededPlanState(planA, false);
      await expectSeededPlanState(planB, true);
      await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
      await expect(listPlanExploreTargetIdsForScope(W1)).resolves.toEqual([
        'plan-b',
      ]);
      expect(mockedDeleteScope).toHaveBeenCalledTimes(1);
      expect(mockedDeleteScope).toHaveBeenCalledWith({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-a',
      });
      expect(mockedDeleteWorktreeDocs).toHaveBeenCalledWith(
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        'plan-a',
      );
      expect(mockedForgetPlanFile).toHaveBeenCalledWith({
        ...W1,
        planId: 'plan-a',
      });
      // Live sessions are torn down before the chat-state deletion boundary.
      expect(callOrder).toEqual([
        `live:${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-a`,
        `deleteScope:${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-a`,
      ]);
    });

    it('is idempotent and skips chat-state deletion for a plan that was never explored', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      await removePlanExploreChat('plan-a', W1);
      mockedDeleteScope.mockClear();
      mockedCleanupLiveWorktreeState.mockClear();

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([]);
      await expect(
        removePlanExploreChat('never-explored', W1),
      ).resolves.toEqual([]);

      await expectSeededPlanState(planA, false);
      expect(mockedDeleteScope).not.toHaveBeenCalled();
      expect(mockedCleanupLiveWorktreeState).not.toHaveBeenCalled();
    });

    it('removes the owner plan file directory when the plan was never registered', async () => {
      // Ordinary plan-file flows materialize `plan.md` without ever writing the
      // sentinel registry, so plan deletion must reclaim it from the owner.
      const planFileDir = planFileDirFor('plan-a', W1);
      await writeFixture(join(planFileDir, 'plan.md'), '# plan');

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([]);

      await expect(exists(planFileDir)).resolves.toBe(false);
      expect(mockedForgetPlanFile).toHaveBeenCalledWith({
        ...W1,
        planId: 'plan-a',
      });
      expect(mockedDeleteScope).not.toHaveBeenCalled();
      expect(mockedCleanupLiveWorktreeState).not.toHaveBeenCalled();
      await expect(
        exists(join(dataDir, 'plan-explore-chats', 'registry.json')),
      ).resolves.toBe(false);
    });

    it('still reclaims orphaned chat storage when the registry row is already gone', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      await removePlanExploreTarget('plan-a', W1);

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([]);

      await expectSeededPlanState(planA, false);
      expect(mockedDeleteScope).toHaveBeenCalledWith({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-a',
      });
    });

    it('leaves a same-id plan registered to another worktree untouched', async () => {
      // The sentinel chat scope is keyed by plan id alone, so W2's takeover
      // chat for `plan-x` is not W1's to delete even though the ids collide.
      const w2Plan = await seedExploredPlan('plan-x', W2);
      const w1PlanFileDir = planFileDirFor('plan-x', W1);
      await writeFixture(join(w1PlanFileDir, 'plan.md'), '# W1 plan');

      const warnings = await removePlanExploreChat('plan-x', W1);

      await expect(observeW2Scope(w2Plan)).resolves.toEqual(UNTOUCHED_W2);
      await expectSeededPlanState(w2Plan, true);
      await expect(exists(w1PlanFileDir)).resolves.toBe(false);
      expect(mockedForgetPlanFile).toHaveBeenCalledWith({
        ...W1,
        planId: 'plan-x',
      });
      expect(warnings).toEqual([]);
    });

    it('reports a failed step as a warning and keeps the registry row for a later sweep', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      mockedDeleteScope.mockRejectedValueOnce(
        new Error("EBUSY: '/private/tmp/locked' is busy"),
      );

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([
        "Failed to remove plan-explore chat state for plan plan-a: EBUSY: '<path>' is busy",
      ]);

      await expect(exists(planA.manifest)).resolves.toBe(true);
      await expect(exists(planA.attachmentsDir)).resolves.toBe(false);
      await expect(getPlanExploreTarget('plan-a')).resolves.toEqual(W1);
      await expect(listPlanExploreTargetIdsForScope(W1)).resolves.toEqual([
        'plan-a',
      ]);
    });

    it('removes the registry row when derived search cleanup fails', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      mockedDeleteWorktreeDocs.mockRejectedValueOnce(
        new Error('Search index worker is closing'),
      );

      await expect(removePlanExploreChat('plan-a', W1)).resolves.toEqual([]);

      await expectSeededPlanState(planA, false);
      await expect(getPlanExploreTarget('plan-a')).resolves.toBeNull();
    });
  });

  describe('removePlanExploreChatsForWorktree', () => {
    it('removes every explore chat registered to the worktree plus the known plan ids', async () => {
      const planA = await seedExploredPlan('plan-a', W1);
      const planB = await seedExploredPlan('plan-b', W1);
      const planC = await seedExploredPlan('plan-c', W2);
      // plan-b is only reachable through the registry sweep; plan-a's row is
      // gone but its id is still in the tracked-plans file being deleted.
      await removePlanExploreTarget('plan-a', W1);

      await expect(
        removePlanExploreChatsForWorktree('ws-1', 'wt-1', ['plan-a']),
      ).resolves.toEqual([]);

      await expectSeededPlanState(planA, false);
      await expectSeededPlanState(planB, false);
      await expectSeededPlanState(planC, true);
      const registry: unknown = JSON.parse(
        await readFile(
          join(dataDir, 'plan-explore-chats', 'registry.json'),
          'utf8',
        ),
      );
      expect(registry).toEqual({
        version: 1,
        targets: { 'plan-c': W2 },
      });
      expect(mockedForgetScope).toHaveBeenCalledWith(W1);
    });

    it('never reclaims another worktree scope for a colliding plan id', async () => {
      const w2Plan = await seedExploredPlan('plan-x', W2);
      const w1PlanFileDir = planFileDirFor('plan-x', W1);
      await writeFixture(join(w1PlanFileDir, 'plan.md'), '# W1 plan');

      const warnings = await removePlanExploreChatsForWorktree('ws-1', 'wt-1', [
        'plan-x',
      ]);

      await expect(observeW2Scope(w2Plan)).resolves.toEqual(UNTOUCHED_W2);
      await expectSeededPlanState(w2Plan, true);
      await expect(exists(w1PlanFileDir)).resolves.toBe(false);
      expect(mockedForgetScope).toHaveBeenCalledWith(W1);
      expect(warnings).toEqual([]);
    });
  });

  describe('releasePlanFileSyncForWorktree', () => {
    it('drops only the plan-file sync state and keeps the legacy plan chats', async () => {
      const planA = await seedExploredPlan('plan-a', W1);

      releasePlanFileSyncForWorktree('ws-1', 'wt-1');

      expect(mockedForgetScope).toHaveBeenCalledWith(W1);
      await expectSeededPlanState(planA, true);
      await expect(getPlanExploreTarget('plan-a')).resolves.toEqual(W1);
    });
  });
});
