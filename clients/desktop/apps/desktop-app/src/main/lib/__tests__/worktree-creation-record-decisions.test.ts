// W6b: pure apply and JSON decision semantics, not product lifecycle evidence.
import { jsonRecordRoundTrip as roundTrip } from './fixtures/json-record-round-trip';
import type {
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import {
  applyReservedWorktreeRecordTo,
  applyWorktreeCreationReservationTo,
  applyWorktreeCreationSetupTo,
  removesReservedWorktree,
} from '../worktree-record-decision-apply';
import type {
  WorktreeCreationPromoteDecision,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationRemovalDecision,
  WorktreeCreationSetupDecision,
} from '../worktree-record-decisions';

const createdAt = '2026-10-24T00:00:00.000Z';
const reserved: WorktreeData = {
  id: 'otter',
  branchName: 'feature',
  createdAt,
  setupPhase: 'git-pending',
  trackedBaseBranch: 'main',
  creation: {
    operationId: 'operation',
    state: 'pending',
    phase: 'reserved',
    checkouts: [{ repositoryPath: '/repo', checkoutPath: '/checkouts/otter' }],
  },
};
const sibling: WorktreeData = {
  id: 'sibling',
  branchName: 'sibling',
  createdAt,
  pinned: true,
  creation: {
    operationId: 'other',
    state: 'complete',
    phase: 'git-ready',
    checkouts: [{ repositoryPath: '/repo', checkoutPath: '/checkouts/sib' }],
  },
};
const legacy: WorktreeData = { id: 'legacy', branchName: 'legacy', createdAt };
const health: WorktreeHealthIssue = {
  status: 'broken',
  code: 'git-error',
  message: 'Git setup failed',
  checkedAt: createdAt,
  worktreePath: '/checkouts/otter',
};
const reserve: WorktreeCreationReservationDecision = {
  kind: 'worktree.create.reserve',
  worktree: reserved,
  sidebarItemGroupId: 'group',
};
const target = { id: 'otter', createdAt };

function apply(
  rows: WorktreeData[],
  decision: WorktreeCreationSetupDecision,
): ReturnType<typeof applyReservedWorktreeRecordTo> {
  return applyReservedWorktreeRecordTo(rows, target, roundTrip(decision));
}

it('leads the list with the reserved row, keeping every other row', () => {
  const rows = [sibling, legacy];
  expect(applyWorktreeCreationReservationTo(rows, roundTrip(reserve))).toEqual({
    worktrees: [reserved, sibling, legacy],
    status: 'reserved',
  });
  expect(rows).toEqual([sibling, legacy]);
  expect(applyWorktreeCreationReservationTo([], reserve)).toEqual({
    worktrees: [reserved],
    status: 'reserved',
  });
});

it.each([
  ['the same incarnation', reserved],
  ['another incarnation', { ...reserved, createdAt: 'other', branchName: 'x' }],
])('reports a collision with %s and returns the read list', (_name, row) => {
  const rows = [row, sibling];
  const pass = applyWorktreeCreationReservationTo(rows, reserve);
  expect(pass).toEqual({ worktrees: rows, status: 'collision' });
  // The same list, so the writer skips the write.
  expect('worktrees' in pass && pass.worktrees).toBe(rows);
});

it('refuses a branch or checkout path another row holds before any write', () => {
  expect(
    applyWorktreeCreationReservationTo(
      [{ ...legacy, branchName: 'feature' }],
      reserve,
    ),
  ).toEqual({ refusal: { reason: 'branch-reserved', branchName: 'feature' } });
  const occupied: WorktreeData = {
    ...sibling,
    creation: {
      operationId: 'other',
      state: 'recovery-required',
      phase: 'git-setup',
      checkouts: [
        { repositoryPath: '/elsewhere', checkoutPath: '/checkouts/otter' },
      ],
    },
  };
  expect(applyWorktreeCreationReservationTo([occupied], reserve)).toEqual({
    refusal: { reason: 'checkout-reserved' },
  });
  // A row without a creation identity reserves no checkout path.
  expect(
    applyWorktreeCreationReservationTo(
      [legacy],
      roundTrip({ ...reserve, worktree: { ...reserved, creation: undefined } }),
    ),
  ).toMatchObject({ status: 'reserved' });
});

it('records a phase, recovery and health issue, keeping an absent phase', () => {
  expect(
    apply([reserved], {
      kind: 'worktree.create.phase',
      phase: 'git-setup',
      recoveryRequired: false,
    }),
  ).toEqual({
    worktrees: [
      {
        ...reserved,
        creation: { ...reserved.creation, phase: 'git-setup' },
      },
    ],
    updated: true,
  });
  expect(
    apply([reserved], {
      kind: 'worktree.create.phase',
      phase: undefined,
      recoveryRequired: true,
      healthIssue: health,
    }),
  ).toEqual({
    worktrees: [
      {
        ...reserved,
        creation: { ...reserved.creation, state: 'recovery-required' },
        healthIssue: health,
      },
    ],
    updated: true,
  });
  // A row without a creation identity gains only the health issue.
  expect(
    applyReservedWorktreeRecordTo(
      [{ ...legacy, id: 'otter' }],
      target,
      roundTrip({
        kind: 'worktree.create.phase',
        phase: 'source-root-repair',
        recoveryRequired: true,
        healthIssue: health,
      }),
    ),
  ).toEqual({
    worktrees: [{ ...legacy, id: 'otter', healthIssue: health }],
    updated: true,
  });
});

it.each<[string, WorktreeCreationPromoteDecision, Partial<WorktreeData>]>([
  [
    'single-repository base',
    {
      kind: 'worktree.create.promote',
      workspaceKind: 'single-repo',
      branchName: 'promoted',
      trackedBaseBranch: 'develop',
    },
    { trackedBaseBranch: 'develop' },
  ],
  [
    'cleared single-repository base',
    {
      kind: 'worktree.create.promote',
      workspaceKind: 'single-repo',
      branchName: 'promoted',
    },
    { trackedBaseBranch: undefined },
  ],
  [
    'multi-repository bases',
    {
      kind: 'worktree.create.promote',
      workspaceKind: 'multi-repo',
      branchName: 'promoted',
      trackedRepoBaseBranches: { app: 'main' },
    },
    { trackedRepoBaseBranches: { app: 'main' } },
  ],
])(
  'promotes with the %s and completes its creation',
  (_name, decision, base) => {
    const promoted: WorktreeData = {
      ...reserved,
      branchName: 'promoted',
      ...base,
      setupPhase: 'git-ready',
      creation: {
        operationId: 'operation',
        state: 'complete',
        phase: 'git-ready',
        checkouts: reserved.creation?.checkouts ?? [],
      },
    };
    expect(apply([sibling, reserved], decision)).toEqual({
      worktrees: [sibling, promoted],
      updated: true,
    });
    expect(applyWorktreeCreationSetupTo(reserved, roundTrip(decision))).toEqual(
      promoted,
    );
    // A legacy row has no creation identity to complete.
    expect(applyWorktreeCreationSetupTo(legacy, decision)).not.toHaveProperty(
      'creation',
    );
  },
);

it('records a reconciled branch and refuses one another row holds', () => {
  const branch: WorktreeCreationSetupDecision = {
    kind: 'worktree.create.branch',
    branchName: 'reconciled',
  };
  expect(apply([reserved, sibling], branch)).toEqual({
    worktrees: [{ ...reserved, branchName: 'reconciled' }, sibling],
    updated: true,
  });
  const rows = [reserved, { ...sibling, branchName: 'reconciled' }];
  const before = structuredClone(rows);
  expect(apply(rows, branch)).toEqual({
    refusal: { reason: 'branch-reserved', branchName: 'reconciled' },
  });
  expect(rows).toEqual(before);
  // An unchanged branch is never refused, even when another row shares it.
  expect(
    apply([reserved, { ...sibling, branchName: 'feature' }], {
      kind: 'worktree.create.phase',
      phase: 'git-setup',
      recoveryRequired: false,
    }),
  ).toMatchObject({ updated: true });
});

it.each([
  ['a replacement incarnation', [{ ...reserved, createdAt: 'replacement' }]],
  ['an absent row', [sibling]],
  ['an empty list', []],
])('changes nothing for %s but still returns a new list', (_name, rows) => {
  const pass = apply(rows, {
    kind: 'worktree.create.promote',
    workspaceKind: 'single-repo',
    branchName: 'promoted',
  });
  expect(pass).toEqual({ worktrees: rows, updated: false });
  // The legacy updater mapped the list, so the writer still wrote it.
  expect('worktrees' in pass && pass.worktrees).not.toBe(rows);
});

it('removes only the reserved incarnation', () => {
  const removal: WorktreeCreationReservationRemovalDecision = roundTrip({
    kind: 'worktree.create.reservation.remove',
    remainingWorktreeOrder: ['sibling'],
    expectedRemainingWorktreeOrder: [],
  });
  expect(removal.kind).toBe('worktree.create.reservation.remove');
  expect(removesReservedWorktree(reserved, target)).toBe(true);
  expect(
    removesReservedWorktree({ ...reserved, createdAt: 'replacement' }, target),
  ).toBe(false);
  expect(removesReservedWorktree(sibling, target)).toBe(false);
});
