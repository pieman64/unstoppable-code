// W6f3: host routing and ordered plain-data decisions through fake X1/X2/X3.
// The fake applies the pure decisions to in-memory records; this is not
// unmodified product lifecycle evidence.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type * as DecisionApply from '../worktree-record-decision-apply';
import type {
  ProjectApplySourceChangesRequest,
  WorkspaceApplySourceChangesRequest,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  SourceChangeBindingsDecision,
  WorkspaceManifestDecision,
  WorktreeListPreconditions,
  WorktreeListRemovalDecision,
  WorktreeListRemovalOutcome,
  WorktreeListUpdateDecision,
  WorktreeListUpdateOutcome,
} from '../worktree-record-decisions';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];
let mockRows: WorktreeData[] = [];
let mockManifest: WorkspaceConfigFile | undefined;
let mockFailure: { kind: string; error: Error } | undefined;
function mockRecord(entry: unknown): void {
  mockEvents.push(JSON.parse(JSON.stringify(entry)));
}
function mockFail(kind: string): Promise<never> | undefined {
  if (mockFailure?.kind !== kind) return undefined;
  const { error } = mockFailure;
  mockFailure = undefined;
  return Promise.reject(error);
}
jest.mock('../workspace-record-decision-port', () => {
  const pure = jest.requireActual<typeof DecisionApply>(
    '../worktree-record-decision-apply',
  );
  return {
    applyWorktreeListUpdate: jest.fn(
      (
        workspaceId: string,
        decision: WorktreeListUpdateDecision,
        preconditions: WorktreeListPreconditions,
      ): Promise<WorktreeListUpdateOutcome> => {
        mockRecord({ workspaceId, decision, preconditions });
        if (decision.kind !== 'workspace.sourceChanges.target.record')
          throw new Error(`Unexpected ${decision.kind}`);
        const failed = mockFail(decision.kind);
        if (failed) return failed;
        mockRows = pure.applySourceChangeTargetRecordTo(mockRows, decision);
        return Promise.resolve({ worktrees: mockRows });
      },
    ),
    applyWorktreeListRemoval: jest.fn(
      (
        workspaceId: string,
        decision: WorktreeListRemovalDecision,
        preconditions: WorktreeListPreconditions,
      ): Promise<WorktreeListRemovalOutcome> => {
        mockRecord({ workspaceId, decision, preconditions });
        if (decision.kind !== 'workspace.sourceChanges.target.remove')
          throw new Error(`Unexpected ${decision.kind}`);
        const rows = mockRows.filter((row) =>
          pure.removesSourceChangeTarget(row, decision),
        );
        const order = mockRows.map((row) => row.id);
        mockRows = mockRows.filter((row) => !rows.includes(row));
        return Promise.resolve({ rows, order });
      },
    ),
    applyWorkspaceManifestDecision: jest.fn(
      (
        workspaceId: string,
        decision: WorkspaceManifestDecision,
      ): Promise<void> => {
        mockRecord({ workspaceId, decision });
        if (decision.kind !== 'workspace.sourceChanges.bindings')
          throw new Error(`Unexpected ${decision.kind}`);
        const failed = mockFail(decision.kind);
        if (failed) return failed;
        if (mockManifest)
          pure.applySourceChangeBindingsTo(mockManifest, 'ok', decision);
        return Promise.resolve();
      },
    ),
  };
});
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../git', () => ({
  bestEffortPruneWorktrees: jest.fn(),
  createWorktree: jest.fn(),
  getRepoRootFromWorktree: jest.fn((repoPath: string) =>
    Promise.resolve(repoPath),
  ),
  removeWorktree: jest.fn(),
}));
jest.mock('../workspace-source-control', () => ({
  repairWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
  validateWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../workspace-worktree-runtime', () => ({
  resolveWorkspaceWorktreeBranchName: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import * as canopy from '../canopy-json';
import { createWorktree, removeWorktree } from '../git';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { applyProjectSourceChangesToWorktree } from '../project-source-change-apply';
import { applyWorkspaceSourceChangesToWorktree } from '../workspace-source-change-apply';
import {
  applyWorkspaceManifestDecision,
  applyWorktreeListRemoval,
} from '../workspace-record-decision-port';

let dir: string;
let root: string;
let repo: string;
let originalDataDir: string | undefined;
const interruption = new Error('interrupted');
const createdAt: unknown = expect.any(String);
const branchName = 'source-change-branch';
const bound = { id: 'r', name: 'R', repoPath: '' };
const manifestRepo = { id: 'r', name: 'Renamed', url: 'https://x.test/r.git' };
const bindings: SourceChangeBindingsDecision = {
  kind: 'workspace.sourceChanges.bindings',
  manifestRepositories: [manifestRepo],
  repositoryAdds: [],
  repositoryRemovals: [],
};

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockRows = [];
  mockManifest = undefined;
  mockFailure = undefined;
  jest
    .mocked(createWorktree)
    .mockImplementation(async (_repoPath, worktreePath) => {
      mockEvents.push('git:create');
      await mkdir(worktreePath, { recursive: true });
      return branchName;
    });
  jest.mocked(removeWorktree).mockImplementation(() => {
    mockEvents.push('git:remove');
    return Promise.resolve();
  });
  const write = canopy.writeCanopyJson;
  jest.spyOn(canopy, 'writeCanopyJson').mockImplementation(async (...args) => {
    mockEvents.push('canopy.json');
    return write(...args);
  });
});
afterEach(async () => {
  await settleDetachedWork();
  jest.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function multiRepo(repos: WorkspaceConfigFile['repos'] = []): void {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos,
    }),
  );
}
function workspaceRequest(
  target: WorkspaceApplySourceChangesRequest['target'] = {
    mode: 'new',
    existingWorktreeIds: [],
  },
): WorkspaceApplySourceChangesRequest {
  return { workspaceId: 'a', target, workspaceScripts: { dev: 'echo dev' } };
}
const projectRequest: ProjectApplySourceChangesRequest = {
  projectId: 'a',
  target: { mode: 'new', existingWorktreeIds: [] },
  scripts: { dev: 'echo dev' },
};
function applied(): () => void {
  return (): void => {
    mockEvents.push('applied');
  };
}
function readManifestRepos(): void {
  const read = canopy.readCanopyJson;
  jest.spyOn(canopy, 'readCanopyJson').mockImplementation(async (...args) => ({
    ...(await read(...args)),
    version: 1,
    repos: [manifestRepo],
  }));
}
function targetRecord(id: string): unknown {
  return {
    workspaceId: 'a',
    decision: {
      kind: 'workspace.sourceChanges.target.record',
      worktree: { id, branchName, createdAt },
    },
    preconditions: {},
  };
}
function targetRemoval(id: string): unknown {
  return {
    workspaceId: 'a',
    decision: { kind: 'workspace.sourceChanges.target.remove', worktreeId: id },
    preconditions: {},
  };
}

it('records a created workspace target between Git and canopy.json, and its bindings only after acceptance', async () => {
  multiRepo([{ ...bound, repoPath: repo }]);
  mockManifest = {
    version: 1,
    type: 'multi-repo',
    repos: [
      { ...bound, repoPath: repo },
      { id: 'later', name: 'Later', repoPath: '/later' },
    ],
  };
  readManifestRepos();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const result = await applyWorkspaceSourceChangesToWorktree(
    workspaceRequest(),
    () => null,
    applied(),
  );
  expect(result).toMatchObject({
    createdWorktree: true,
    localRepoBindingsUpdated: true,
  });
  await settleDetachedWork();
  const { worktreeId } = result;
  // The root checkout precedes its row; the repository checkout follows in
  // the background, after the bindings decision.
  expect(mockEvents).toEqual([
    'git:create',
    targetRecord(worktreeId),
    'canopy.json',
    'applied',
    { workspaceId: 'a', decision: bindings },
    'git:create',
  ]);
  expect(mockRows).toEqual([{ id: worktreeId, branchName, createdAt }]);
  if (mockManifest === undefined) {
    throw new Error('Expected workspace manifest after source change');
  }
  expect(mockManifest.repos).toEqual([
    {
      ...bound,
      repoPath: repo,
      name: 'Renamed',
      source: 'manifest',
      manifestUrl: manifestRepo.url,
    },
    { id: 'later', name: 'Later', repoPath: '/later' },
  ]);
});

it('records a created project target between Git and canopy.json, without bindings', async () => {
  const result = await applyProjectSourceChangesToWorktree(
    projectRequest,
    () => null,
    applied(),
  );
  await settleDetachedWork();
  expect(mockEvents).toEqual([
    'git:create',
    targetRecord(result.worktreeId),
    'canopy.json',
    'applied',
  ]);
  expect(applyWorkspaceManifestDecision).not.toHaveBeenCalled();
});

it('decides only bindings for an existing workspace target, and none when they already hold', async () => {
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: 'otter', branchName: 'otter', createdAt: 'x' }],
    }),
  );
  multiRepo([{ ...bound, repoPath: repo }]);
  readManifestRepos();
  const existing = workspaceRequest({ mode: 'existing', worktreeId: 'otter' });
  const result = await applyWorkspaceSourceChangesToWorktree(
    existing,
    () => null,
    applied(),
  );
  await settleDetachedWork();
  expect(result).toMatchObject({ createdWorktree: false });
  expect(mockEvents).toEqual([
    'canopy.json',
    'applied',
    { workspaceId: 'a', decision: bindings },
  ]);
  mockEvents.length = 0;
  multiRepo([
    {
      ...bound,
      repoPath: repo,
      name: 'Renamed',
      source: 'manifest',
      manifestUrl: manifestRepo.url,
    },
  ]);
  await expect(
    applyWorkspaceSourceChangesToWorktree(existing, () => null, applied()),
  ).resolves.toMatchObject({ localRepoBindingsUpdated: false });
  await settleDetachedWork();
  expect(mockEvents).toEqual(['canopy.json', 'applied']);
});

it.each(['workspace', 'project'] as const)(
  'rolls back a created %s target row after its checkout when the apply fails',
  async (kind) => {
    if (kind === 'workspace') multiRepo();
    const onApplied = (): void => {
      throw interruption;
    };
    const pending =
      kind === 'workspace'
        ? applyWorkspaceSourceChangesToWorktree(
            workspaceRequest(),
            () => null,
            onApplied,
          )
        : applyProjectSourceChangesToWorktree(
            projectRequest,
            () => null,
            onApplied,
          );
    await expect(pending).rejects.toBe(interruption);
    await settleDetachedWork();
    const created = basename(
      jest.mocked(createWorktree).mock.calls[0]?.[1] ?? '',
    );
    expect(created).not.toBe('');
    expect(mockEvents).toEqual([
      'git:create',
      targetRecord(created),
      'canopy.json',
      'git:remove',
      targetRemoval(created),
    ]);
    expect(mockRows).toEqual([]);
  },
);

it('keeps the legacy rollback triggers when the target row decision fails', async () => {
  const failure = new Error('row write failed');
  mockFailure = {
    kind: 'workspace.sourceChanges.target.record',
    error: failure,
  };
  await expect(
    applyProjectSourceChangesToWorktree(projectRequest, () => null, applied()),
  ).rejects.toBe(failure);
  const created = basename(
    jest.mocked(createWorktree).mock.calls[0]?.[1] ?? '',
  );
  expect(mockEvents).toEqual([
    'git:create',
    targetRecord(created),
    'git:remove',
    targetRemoval(created),
  ]);
  expect(mockRows).toEqual([]);

  // A workspace target has no rollback around its row step: its checkout stays.
  mockEvents.length = 0;
  multiRepo();
  mockFailure = {
    kind: 'workspace.sourceChanges.target.record',
    error: failure,
  };
  await expect(
    applyWorkspaceSourceChangesToWorktree(
      workspaceRequest(),
      () => null,
      applied(),
    ),
  ).rejects.toBe(failure);
  const checkout = jest.mocked(createWorktree).mock.calls[1]?.[1] ?? '';
  expect(mockEvents).toEqual(['git:create', targetRecord(basename(checkout))]);
  expect(existsSync(checkout)).toBe(true);
});

it('logs a failed background bindings decision without changing the accepted result', async () => {
  multiRepo([{ ...bound, repoPath: repo }]);
  readManifestRepos();
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockFailure = {
    kind: 'workspace.sourceChanges.bindings',
    error: interruption,
  };
  const result = await applyWorkspaceSourceChangesToWorktree(
    workspaceRequest(),
    () => null,
    applied(),
  );
  await settleDetachedWork();
  expect(result).toMatchObject({ localRepoBindingsUpdated: true });
  expect(logged).toHaveBeenCalledWith(
    'Failed to sync workspace repo bindings:',
    interruption,
  );
  expect(applyWorktreeListRemoval).not.toHaveBeenCalled();
});
