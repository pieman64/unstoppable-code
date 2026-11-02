// W6f3: pure apply and JSON decision semantics, not product lifecycle evidence.
import { jsonRecordRoundTrip as roundTrip } from './fixtures/json-record-round-trip';
import type {
  WorkspaceConfigFile,
  WorkspaceRepoData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  applySourceChangeBindingsTo,
  applySourceChangeTargetRecordTo,
  removesSourceChangeTarget,
  syncSourceChangeRepoBindings,
} from '../worktree-record-decision-apply';
import type {
  SourceChangeBindingsDecision,
  SourceChangeTargetRecordDecision,
  SourceChangeTargetRemovalDecision,
} from '../worktree-record-decisions';

const createdAt = '2026-10-24T00:00:00.000Z';
const target: WorktreeData = { id: 'otter', branchName: 'otter', createdAt };
const concurrent: WorktreeData = {
  id: 'concurrent',
  branchName: 'concurrent',
  createdAt,
  pinned: true,
};
const record: SourceChangeTargetRecordDecision = {
  kind: 'workspace.sourceChanges.target.record',
  worktree: target,
};
const removal: SourceChangeTargetRemovalDecision = {
  kind: 'workspace.sourceChanges.target.remove',
  worktreeId: 'otter',
};
const bindings: SourceChangeBindingsDecision = {
  kind: 'workspace.sourceChanges.bindings',
  manifestRepositories: [
    { id: 'bound', name: 'Renamed', url: 'https://example.test/bound.git' },
    { id: 'added', name: 'Added', url: 'https://example.test/added.git' },
    { id: 'pathless', name: 'Pathless', url: 'https://example.test/p.git' },
  ],
  repositoryAdds: [
    { repoId: 'added', repoPath: '/added' },
    { repoId: 'pathless' },
  ],
  repositoryRemovals: ['removed'],
};
function repos(): WorkspaceRepoData[] {
  return [
    { id: 'bound', name: 'Bound', repoPath: '/bound', scripts: { dev: 'x' } },
    {
      id: 'removed',
      name: 'Removed',
      repoPath: '/removed',
      source: 'manifest',
      manifestUrl: 'https://example.test/removed.git',
      hooks: { setup: null },
    },
    { id: 'local', name: 'Local', repoPath: '/local' },
  ];
}

it('records the target row once after the rows the locked list holds', () => {
  const rows = [concurrent];
  const decision = roundTrip(record);
  expect(applySourceChangeTargetRecordTo(rows, decision)).toEqual([
    concurrent,
    target,
  ]);
  expect(rows).toEqual([concurrent]);
  expect(applySourceChangeTargetRecordTo([], decision)).toEqual([target]);
});

it.each([target, { ...target, createdAt: 'another incarnation' }])(
  'refuses any row at the target id with the existing copy, without mutation',
  (row) => {
    const rows = [row, concurrent];
    const before = structuredClone(rows);
    expect(() => applySourceChangeTargetRecordTo(rows, record)).toThrow(
      new Error('Project worktree otter already exists'),
    );
    expect(rows).toEqual(before);
  },
);

it('rolls back by id, as the legacy rollback did, and keeps other rows', () => {
  const decision = roundTrip(removal);
  expect(removesSourceChangeTarget(target, decision)).toBe(true);
  expect(
    removesSourceChangeTarget({ ...target, createdAt: 'other' }, decision),
  ).toBe(true);
  expect(removesSourceChangeTarget(concurrent, decision)).toBe(false);
  expect(
    removesSourceChangeTarget({ ...concurrent, branchName: 'otter' }, decision),
  ).toBe(false);
});

it('binds removals, manifest renames and added paths over the given repositories', () => {
  const current = repos();
  const before = structuredClone(current);
  const synced = syncSourceChangeRepoBindings(current, roundTrip(bindings));
  expect(synced).toEqual({
    updated: true,
    repos: [
      {
        ...before[0],
        name: 'Renamed',
        source: 'manifest',
        manifestUrl: 'https://example.test/bound.git',
      },
      { ...before[1], source: 'local', hooks: undefined },
      before[2],
      {
        id: 'added',
        name: 'Added',
        repoPath: '/added',
        source: 'manifest',
        manifestUrl: 'https://example.test/added.git',
      },
    ],
  });
  expect(synced.repos[1]).toHaveProperty('manifestUrl', before[1]?.manifestUrl);
  expect(current).toEqual(before);
});

it('reports no update, and returns the read, when the bindings already hold', () => {
  const current = syncSourceChangeRepoBindings(repos(), bindings).repos;
  const again = syncSourceChangeRepoBindings(current, bindings);
  expect(again).toEqual({ updated: false, repos: current });
  expect(again.repos).toBe(current);
  const empty: SourceChangeBindingsDecision = {
    kind: 'workspace.sourceChanges.bindings',
    manifestRepositories: [],
    repositoryAdds: [],
    repositoryRemovals: [],
  };
  const unchanged = repos();
  expect(syncSourceChangeRepoBindings(unchanged, empty).repos).toBe(unchanged);
  expect(syncSourceChangeRepoBindings([], empty)).toEqual({
    updated: false,
    repos: [],
  });
});

it('keeps the last duplicate manifest entry and add, and skips an empty path', () => {
  const synced = syncSourceChangeRepoBindings([], {
    kind: 'workspace.sourceChanges.bindings',
    manifestRepositories: [
      { id: 'dup', name: 'First', url: 'first' },
      { id: 'empty', name: 'Empty', url: 'empty' },
      { id: 'dup', name: 'Last', url: 'last' },
    ],
    repositoryAdds: [
      { repoId: 'dup', repoPath: '/first' },
      { repoId: 'dup', repoPath: '/last' },
      { repoId: 'empty', repoPath: '' },
    ],
    repositoryRemovals: [],
  });
  expect(synced.repos).toEqual([
    {
      id: 'dup',
      name: 'Last',
      repoPath: '/last',
      source: 'manifest',
      manifestUrl: 'last',
    },
  ]);
});

it('applies bindings to the queued read, keeping repositories and fields written since', () => {
  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [...repos(), { id: 'later', name: 'Later', repoPath: '/later' }],
    itemSortMode: 'last-updated',
  };
  const before = structuredClone(config);
  expect(applySourceChangeBindingsTo(config, 'ok', roundTrip(bindings))).toBe(
    true,
  );
  expect(config).toEqual({
    ...before,
    repos: syncSourceChangeRepoBindings(before.repos, bindings).repos,
  });
  expect(config.repos.map((repo) => repo.id)).toEqual([
    'bound',
    'removed',
    'local',
    'later',
    'added',
  ]);
  expect(applySourceChangeBindingsTo(config, 'ok', bindings)).toBe(false);
});

it('never creates an absent manifest', () => {
  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: repos(),
  };
  const before = structuredClone(config);
  expect(applySourceChangeBindingsTo(config, 'absent', bindings)).toBe(false);
  expect(config).toEqual(before);
});
