// W6c1: pure apply and JSON decision semantics, not product lifecycle evidence.
import { jsonRecordRoundTrip as roundTrip } from './fixtures/json-record-round-trip';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  applyArchiveJournalTo,
  removesArchivedWorktree,
} from '../worktree-record-decision-apply';
import type {
  ArchiveCleanupTombstoneDecision,
  ArchiveJournalDecision,
  ArchivedWorktreeRowRemovalDecision,
} from '../worktree-record-decisions';

const createdAt = '2026-10-24T00:00:00.000Z';
const single = {
  referenceRepoPath: '/repo',
  repositoryIdentity: '/repo/.git',
  branchName: 'feature',
  expectedTip: 'a'.repeat(40),
};
const multi = [
  { repoId: 'child', ...single, branchName: 'child-feature' },
  { repoId: '__workspace_root__', ...single },
];
const row: WorktreeData = {
  id: 'otter',
  branchName: 'feature',
  createdAt,
  label: 'Kept',
  pinned: true,
};
const guarded: WorktreeData = {
  ...row,
  pendingArchiveBranchDeletion: single,
  pendingArchiveBranchDeletions: multi,
};

const decisions: ArchiveJournalDecision[] = [
  {
    kind: 'worktree.archive.journal.record',
    workspaceKind: 'single-repo',
    pendingBranchDeletion: single,
  },
  {
    kind: 'worktree.archive.journal.record',
    workspaceKind: 'multi-repo',
    pendingBranchDeletions: multi,
  },
  { kind: 'worktree.archive.journal.clear', workspaceKind: 'single-repo' },
  { kind: 'worktree.archive.journal.clear', workspaceKind: 'multi-repo' },
];

it('W6c1 decisions are plain data', () => {
  const removal: ArchivedWorktreeRowRemovalDecision = {
    kind: 'worktree.archive.row.remove',
    remainingWorktreeOrder: ['b', 'a'],
    expectedRemainingWorktreeOrder: ['a', 'b'],
  };
  const tombstone: ArchiveCleanupTombstoneDecision = {
    kind: 'worktree.archive.cleanup.tombstone',
    createdAt,
  };
  for (const decision of [...decisions, removal, tombstone])
    expect(roundTrip(decision)).toEqual(decision);
  expect(roundTrip({ kind: 'worktree.archive.row.remove' })).toEqual({
    kind: 'worktree.archive.row.remove',
  });
});

it('records the single-repository guard, keeping every other field', () => {
  const next = applyArchiveJournalTo(row, roundTrip(decisions[0]));
  expect(next).toEqual({ ...row, pendingArchiveBranchDeletion: single });
  expect(row).not.toHaveProperty('pendingArchiveBranchDeletion');
});

it('records the multi-repository guards, replacing earlier ones', () => {
  const earlier: WorktreeData = {
    ...row,
    pendingArchiveBranchDeletion: single,
    pendingArchiveBranchDeletions: [multi[0]],
  };
  expect(applyArchiveJournalTo(earlier, roundTrip(decisions[1]))).toEqual({
    ...earlier,
    pendingArchiveBranchDeletions: multi,
  });
});

it.each([
  [
    'single-repo',
    'pendingArchiveBranchDeletion',
    'pendingArchiveBranchDeletions',
  ],
  [
    'multi-repo',
    'pendingArchiveBranchDeletions',
    'pendingArchiveBranchDeletion',
  ],
] as const)('a %s clear drops only %s', (workspaceKind, cleared, kept) => {
  const next = applyArchiveJournalTo(
    guarded,
    roundTrip({ kind: 'worktree.archive.journal.clear', workspaceKind }),
  );
  expect(next).not.toHaveProperty(cleared);
  expect(next[kept]).toEqual(guarded[kept]);
  expect(next).toMatchObject(row);
  expect(guarded).toHaveProperty(cleared);
});

it.each(decisions)(
  '$kind ($workspaceKind) always returns a new row, so the row writer writes',
  (decision) => {
    const next = applyArchiveJournalTo(row, decision);
    expect(next).not.toBe(row);
    const again = applyArchiveJournalTo(next, decision);
    expect(again).not.toBe(next);
    expect(again).toEqual(next);
  },
);

it('the row removal matches every incarnation at the id and nothing else', () => {
  expect(removesArchivedWorktree(row, 'otter')).toBe(true);
  expect(
    removesArchivedWorktree({ ...row, createdAt: 'replacement' }, 'otter'),
  ).toBe(true);
  expect(removesArchivedWorktree({ ...row, id: 'sibling' }, 'otter')).toBe(
    false,
  );
});
