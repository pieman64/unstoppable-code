// The fake port records host routing; pure apply tests cover the decisions.
import type * as DecisionApply from '../worktree-record-decision-apply';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type {
  SplitDestinationDecision,
  SplitDestinationRemovalDecision,
  SplitDestinationRow,
  WorkspaceIndexRemovalDecision,
  WorktreeListPreconditions,
  WorktreeListUpdateOutcome,
  WorktreeListRemovalOutcome,
} from '../worktree-record-decisions';
const mockDecisions: unknown[] = [];
let mockRows: WorktreeData[] = [];
let mockFailure: Error | undefined;
let mockIndexPresent = true;
jest.mock('../workspace-record-decision-port', () => ({
  applyWorktreeListUpdate: (
    workspaceId: string,
    decision: SplitDestinationDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<WorktreeListUpdateOutcome> => {
    mockDecisions.push(
      JSON.parse(JSON.stringify({ workspaceId, decision, preconditions })),
    );
    if (mockFailure) return Promise.reject(mockFailure);
    const { applySplitDestinationTo } = jest.requireActual<
      typeof DecisionApply
    >('../worktree-record-decision-apply');
    mockRows = applySplitDestinationTo(workspaceId, mockRows, decision, false);
    return Promise.resolve({ worktrees: mockRows });
  },
  applyWorktreeListRemoval: (
    workspaceId: string,
    decision: SplitDestinationRemovalDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<WorktreeListRemovalOutcome> => {
    mockDecisions.push(
      JSON.parse(JSON.stringify({ workspaceId, decision, preconditions })),
    );
    if (mockFailure) return Promise.reject(mockFailure);
    const rows = mockRows.filter(
      (row) =>
        row.id === decision.worktree.id &&
        row.createdAt === decision.worktree.createdAt,
    );
    const order = mockRows.map((row) => row.id);
    mockRows = mockRows.filter((row) => !rows.includes(row));
    return Promise.resolve({ rows, order });
  },
  applyWorkspaceIndexRemoval: (
    workspaceId: string,
    decision: WorkspaceIndexRemovalDecision,
  ): Promise<boolean> => {
    mockDecisions.push(JSON.parse(JSON.stringify({ workspaceId, decision })));
    if (mockFailure) return Promise.reject(mockFailure);
    return Promise.resolve(mockIndexPresent);
  },
}));
jest.mock('../workspace-persistence', () => ({
  updateWorkspaceWorktrees: jest.fn(
    (
      _workspaceId: string,
      update: Parameters<typeof updateWorkspaceWorktrees>[1],
    ) => Promise.resolve(update(mockRows)),
  ),
}));
jest.mock('node:fs/promises', () => ({ rm: jest.fn(() => Promise.resolve()) }));
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: jest.fn(() => Promise.resolve()),
}));
import { rm } from 'node:fs/promises';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { updateWorkspaceWorktrees } from '../workspace-persistence';
import {
  applySplitDestinationTo,
  removesSplitDestination,
  SplitRecordRefusedError,
} from '../worktree-record-decision-apply';
import {
  reserveSplitDestinationRecord,
  removeSplitDestinationRecord,
  markSplitRecoveryRecord,
  promoteSplitDestinationRecord,
  recordSplitArchiveDestination,
  removeSplitCreatedWorkspace,
} from '../split-temporary-workspace-records';
const workspaceId = 'destination';
const createdAt = '2026-10-24T00:00:00.000Z';
const worktree: SplitDestinationRow = {
  id: 'reserved',
  createdAt,
  branchName: 'topic',
  setupPhase: 'git-pending' as const,
  splitRecoveryRequired: true,
  hidden: true,
};
const identity = {
  source: 'temporary_split' as const,
  workspaceId,
  worktreeId: worktree.id,
  createdAt,
};
const incarnation = { id: worktree.id, createdAt };
const healthIssue = {
  status: 'broken' as const,
  code: 'git-error' as const,
  message: 'retained',
  checkedAt: createdAt,
  worktreePath: '/checkout',
  gitError: 'failed',
};
const preconditions = {
  requireAuthoritativeRead: true,
  requireExistingList: true,
};
beforeEach(() => {
  mockRows = [];
  mockDecisions.length = 0;
  mockFailure = undefined;
  mockIndexPresent = true;
  jest.clearAllMocks();
});
it('builds only the six append-slot decisions, in record call order, as JSON data', async () => {
  await reserveSplitDestinationRecord({
    source: identity.source,
    workspaceId,
    worktree,
  });
  await markSplitRecoveryRecord({
    ...identity,
    fallbackWorktree: worktree,
    healthIssue,
  });
  await promoteSplitDestinationRecord({ ...identity, branchName: 'moved' });
  const archived = { ...worktree, status: 'done' as const };
  await recordSplitArchiveDestination({
    source: identity.source,
    workspaceId,
    worktree: archived,
  });
  await removeSplitDestinationRecord(identity);
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId,
      worktreeIds: ['reserved'],
      containsRollbackData: () => Promise.resolve(false),
    }),
  ).resolves.toBe(true);
  expect(mockDecisions).toEqual([
    {
      workspaceId,
      decision: { kind: 'split.destination.reserve', worktree },
      preconditions,
    },
    {
      workspaceId,
      decision: {
        kind: 'split.destination.recovery',
        worktree: incarnation,
        fallbackWorktree: worktree,
        healthIssue,
      },
      preconditions,
    },
    {
      workspaceId,
      decision: {
        kind: 'split.destination.promote',
        worktree: incarnation,
        branchName: 'moved',
      },
      preconditions,
    },
    {
      workspaceId,
      decision: { kind: 'split.destination.archive', worktree: archived },
      preconditions,
    },
    {
      workspaceId,
      decision: { kind: 'split.destination.remove', worktree: incarnation },
      preconditions,
    },
    { workspaceId, decision: { kind: 'split.created-workspace.cleanup' } },
  ]);
  expect(removePersistedWorktreeDataDirectory).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(1);
  const shouldWrite: unknown = expect.any(Function);
  expect(updateWorkspaceWorktrees).toHaveBeenCalledWith(
    workspaceId,
    expect.any(Function),
    { ...preconditions, shouldWrite },
  );
});
it('admits before reaching the port, including fallback identity and cleanup worktree ids', async () => {
  for (const request of [
    { ...identity, workspaceId: '../invalid' },
    { ...identity, createdAt: ' ' },
  ]) {
    await expect(removeSplitDestinationRecord(request)).rejects.toMatchObject({
      reason: 'invalid-request',
    });
  }
  await expect(
    markSplitRecoveryRecord({
      ...identity,
      fallbackWorktree: { ...worktree, id: 'other' },
      healthIssue,
    }),
  ).rejects.toMatchObject({
    reason: 'invalid-request',
    message: 'A split recovery row needs the reservation identity',
  });
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId,
      worktreeIds: ['../invalid'],
      containsRollbackData: () => Promise.resolve(false),
    }),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
  expect(mockDecisions).toEqual([]);
});
it.each([false, true])(
  'cleanup probes only an empty locked list and retains rollback data (%s)',
  async (populated) => {
    mockRows = populated ? [worktree] : [];
    const containsRollbackData = jest.fn(() => Promise.resolve(true));
    await expect(
      removeSplitCreatedWorkspace({
        source: identity.source,
        workspaceId,
        worktreeIds: [],
        containsRollbackData,
      }),
    ).resolves.toBe(false);
    expect(containsRollbackData).toHaveBeenCalledTimes(populated ? 0 : 1);
    expect(mockDecisions).toEqual([]);
    expect(rm).not.toHaveBeenCalled();
  },
);
it('does not delete files when the cleanup index decision fails', async () => {
  mockFailure = new Error('index write failed');
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId,
      worktreeIds: ['reserved'],
      containsRollbackData: () => Promise.resolve(false),
    }),
  ).rejects.toBe(mockFailure);
  expect(removePersistedWorktreeDataDirectory).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
});
it('propagates rejected record decisions without changing rows or running cleanup', async () => {
  mockRows = [worktree];
  const rows = mockRows;
  mockFailure = new Error('record write failed');
  for (const decide of [
    (): Promise<void> =>
      reserveSplitDestinationRecord({
        source: identity.source,
        workspaceId,
        worktree,
      }),
    (): Promise<void> =>
      markSplitRecoveryRecord({
        ...identity,
        fallbackWorktree: worktree,
        healthIssue,
      }),
    (): Promise<void> =>
      promoteSplitDestinationRecord({ ...identity, branchName: 'moved' }),
    (): Promise<void> =>
      recordSplitArchiveDestination({
        source: identity.source,
        workspaceId,
        worktree,
      }),
    (): Promise<void> => removeSplitDestinationRecord(identity),
  ]) {
    await expect(decide()).rejects.toBe(mockFailure);
    expect(mockRows).toBe(rows);
    expect(mockRows).toStrictEqual([worktree]);
  }
  expect(mockDecisions).toHaveLength(5);
  expect(updateWorkspaceWorktrees).not.toHaveBeenCalled();
  expect(removePersistedWorktreeDataDirectory).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
});
it('propagates a rollback-data probe failure without deciding cleanup', async () => {
  const failure = new Error('probe failed');
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId,
      worktreeIds: [],
      containsRollbackData: () => Promise.reject(failure),
    }),
  ).rejects.toBe(failure);
  expect(mockDecisions).toEqual([]);
  expect(rm).not.toHaveBeenCalled();
});
it.each(['persisted-data', 'workspace-directory'])(
  'retains the post-index cleanup gap when %s deletion fails',
  async (stage) => {
    const failure = new Error('cleanup failed');
    if (stage === 'persisted-data')
      jest
        .mocked(removePersistedWorktreeDataDirectory)
        .mockRejectedValueOnce(failure);
    else jest.mocked(rm).mockRejectedValueOnce(failure);
    await expect(
      removeSplitCreatedWorkspace({
        source: identity.source,
        workspaceId,
        worktreeIds: ['reserved', 'second'],
        containsRollbackData: () => Promise.resolve(false),
      }),
    ).rejects.toBe(failure);
    expect(mockDecisions).toEqual([
      { workspaceId, decision: { kind: 'split.created-workspace.cleanup' } },
    ]);
    expect(removePersistedWorktreeDataDirectory).toHaveBeenCalledTimes(
      stage === 'persisted-data' ? 1 : 2,
    );
    expect(rm).toHaveBeenCalledTimes(stage === 'persisted-data' ? 0 : 1);
  },
);
it('still cleans an empty workspace when its index entry is already absent', async () => {
  mockIndexPresent = false;
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId,
      worktreeIds: ['reserved'],
      containsRollbackData: () => Promise.resolve(false),
    }),
  ).resolves.toBe(true);
  expect(mockDecisions).toEqual([
    { workspaceId, decision: { kind: 'split.created-workspace.cleanup' } },
  ]);
  expect(removePersistedWorktreeDataDirectory).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(1);
});
const decisions: SplitDestinationDecision[] = [
  { kind: 'split.destination.reserve', worktree },
  {
    kind: 'split.destination.recovery',
    worktree: incarnation,
    fallbackWorktree: worktree,
    healthIssue,
  },
  {
    kind: 'split.destination.promote',
    worktree: incarnation,
    branchName: 'moved',
  },
  {
    kind: 'split.destination.archive',
    worktree: { ...worktree, branchName: 'moved' },
  },
];
it.each(decisions)(
  'pure $kind refuses replaced and tombstoned incarnations without mutation',
  (decision) => {
    const rows = [{ ...worktree, createdAt: 'replacement' }];
    const before = JSON.stringify(rows);
    expect(() =>
      applySplitDestinationTo(workspaceId, rows, decision, false),
    ).toThrow(SplitRecordRefusedError);
    expect(() =>
      applySplitDestinationTo(workspaceId, rows, decision, false),
    ).toThrow('Destination worktree id "reserved" is already reserved.');
    expect(JSON.stringify(rows)).toBe(before);
    expect(() =>
      applySplitDestinationTo(workspaceId, [], decision, true),
    ).toThrow(
      'Split destination reservation destination/reserved disappeared before promotion.',
    );
  },
);
it('pure transitions retain concurrent fields and rows, retry reservation and ignore stale tombstones for a present incarnation', () => {
  const current = {
    ...worktree,
    pinned: true,
    label: 'Concurrent',
    future: 'kept',
  };
  const other = { id: 'other', createdAt, branchName: 'other' };
  const rows = [current, other];
  const before = JSON.stringify(rows);
  expect(applySplitDestinationTo(workspaceId, rows, decisions[0], true)).toBe(
    rows,
  );
  const recovered = applySplitDestinationTo(
    workspaceId,
    rows,
    decisions[1],
    true,
  );
  expect(recovered[0]).toEqual({
    ...current,
    hidden: undefined,
    setupPhase: undefined,
    splitRecoveryRequired: true,
    healthIssue,
  });
  expect(recovered[0]).not.toHaveProperty('hidden');
  expect(recovered[0]).toHaveProperty('setupPhase', undefined);
  const promoted = applySplitDestinationTo(
    workspaceId,
    recovered,
    decisions[2],
    false,
  );
  expect(promoted[0]).toEqual({
    ...recovered[0],
    branchName: 'moved',
    setupPhase: 'git-ready',
    splitRecoveryRequired: undefined,
  });
  expect(promoted[0]).not.toHaveProperty('splitRecoveryRequired');
  const archived = applySplitDestinationTo(
    workspaceId,
    promoted,
    decisions[3],
    false,
  );
  expect(archived[0]).toEqual({
    ...promoted[0],
    hidden: undefined,
    setupPhase: undefined,
    splitRecoveryRequired: undefined,
  });
  expect(archived[0]).not.toHaveProperty('hidden');
  expect(archived[0]).not.toHaveProperty('setupPhase');
  expect(archived[0]).not.toHaveProperty('splitRecoveryRequired');
  expect(archived[1]).toBe(other);
  expect(JSON.stringify(rows)).toBe(before);
});
it('pure recovery and archive may append but promotion may not, and removal keeps replacements', () => {
  expect(
    applySplitDestinationTo(workspaceId, [], decisions[1], false)[0],
  ).toMatchObject({ id: 'reserved', splitRecoveryRequired: true, healthIssue });
  expect(applySplitDestinationTo(workspaceId, [], decisions[3], false)).toEqual(
    [{ id: 'reserved', createdAt, branchName: 'moved' }],
  );
  expect(() =>
    applySplitDestinationTo(workspaceId, [], decisions[2], false),
  ).toThrow(SplitRecordRefusedError);
  const remove: SplitDestinationRemovalDecision = {
    kind: 'split.destination.remove',
    worktree: incarnation,
  };
  expect(removesSplitDestination(worktree, remove)).toBe(true);
  expect(
    removesSplitDestination({ ...worktree, createdAt: 'replacement' }, remove),
  ).toBe(false);
  expect(removesSplitDestination({ ...worktree, id: 'other' }, remove)).toBe(
    false,
  );
});
