import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  compareWorkspaces,
  compareWorktrees,
  isWorktreeDone,
  partitionWorkspaces,
  partitionWorktrees,
  pendingWorkspaceIdsAfterSnapshot,
  projectWorktreeRuntime,
  rollUpPendingQuestionWorktreeKeys,
} from '../workspace-sections-model';

type Workspace = PortalSessionShellState['workspaces'][number];
type Worktree = PortalSessionShellState['worktrees'][number];

const workspace = (
  localId: string,
  partial: Partial<Workspace> = {},
): Workspace => ({
  localId,
  name: localId,
  type: 'single-repo',
  ...partial,
});
const worktree = (
  localId: string,
  workspaceLocalId = 'workspace',
  partial: Partial<Worktree> = {},
): Worktree => ({
  localId,
  workspaceLocalId,
  branch: localId,
  ...partial,
});

describe('project sections model', () => {
  it('keeps branch stacks attached while ordering roots and siblings by activity', () => {
    const rows = [
      worktree('older-root', 'workspace', {
        order: 0,
        lastActivityAt: '2026-01-01',
      }),
      worktree('older-child', 'workspace', {
        order: 1,
        branchGroupingParentWorktreeId: 'older-root',
        lastActivityAt: '2026-01-02',
      }),
      worktree('newer-root', 'workspace', {
        order: 2,
        lastActivityAt: '2026-01-03',
      }),
      worktree('newer-child', 'workspace', {
        order: 3,
        branchGroupingParentWorktreeId: 'older-root',
        lastActivityAt: '2026-01-04',
      }),
    ];
    expect(
      partitionWorktrees(rows, 'workspace', 'last-updated').visible.map(
        ({ localId }) => localId,
      ),
    ).toEqual(['newer-root', 'older-root', 'newer-child', 'older-child']);
  });

  it('orders timestamped unpinned rows by activity while preserving pins, unknown slots and ties', () => {
    const rows = [
      worktree('pinned', 'workspace', {
        pinned: true,
        order: 0,
        lastActivityAt: '2026-01-01',
      }),
      worktree('older', 'workspace', {
        order: 1,
        lastActivityAt: '2026-01-02',
      }),
      worktree('unknown', 'workspace', { order: 2 }),
      worktree('newer', 'workspace', {
        order: 3,
        lastActivityAt: '2026-01-04',
      }),
      worktree('tie', 'workspace', { order: 4, lastActivityAt: '2026-01-04' }),
    ];
    expect(
      partitionWorktrees(rows, 'workspace', 'last-updated').visible.map(
        ({ localId }) => localId,
      ),
    ).toEqual(['pinned', 'newer', 'unknown', 'tie', 'older']);
    expect(partitionWorktrees(rows, 'workspace', 'manual').visible).toEqual(
      rows,
    );
  });

  it('filters cowork and partitions explicit and automatic hidden projects', () => {
    const workspaces = [
      workspace('cowork', { type: 'cowork' }),
      workspace('visible'),
      workspace('explicit', { hidden: true }),
      workspace('automatic', { alwaysShow: false }),
      workspace('automatic-visible', { alwaysShow: false }),
    ];
    const result = partitionWorkspaces(workspaces, [
      worktree('row', 'automatic-visible'),
    ]);
    expect(result.visible.map(({ localId }) => localId)).toEqual([
      'automatic-visible',
      'visible',
    ]);
    expect(result.hidden.map(({ localId }) => localId)).toEqual([
      'automatic',
      'explicit',
    ]);
  });

  it('never lists catalog placeholder rows as workspaces', () => {
    const placeholder: PortalSessionShellState['workspaces'][number] = {
      ...workspace('org-project:p1', { name: 'Catalog project' }),
      owner: {
        type: 'organization',
        organizationId: '11111111-1111-4111-8111-111111111111',
        projectId: 'p1',
      },
      placeholder: { projectId: 'p1', state: 'ready-to-set-up' },
    };
    const result = partitionWorkspaces(
      [workspace('real', { name: 'Real' }), placeholder],
      [],
      { includeFlat: true },
    );
    expect(result.visible.map(({ localId }) => localId)).toEqual(['real']);
    expect(result.hidden).toHaveLength(0);
  });

  it('includes flat-layout projects only when explicitly requested', () => {
    const workspaces = [
      workspace('git'),
      workspace('cowork', { type: 'cowork' }),
    ];

    expect(
      partitionWorkspaces(workspaces, []).visible.map(({ localId }) => localId),
    ).toEqual(['git']);
    expect(
      partitionWorkspaces(workspaces, [], { includeFlat: true }).visible.map(
        ({ localId }) => localId,
      ),
    ).toEqual(['cowork', 'git']);
  });

  // REG-2819 regression guard. A cloud workspace is repoless — so it classifies
  // as `cowork` — but tree-shaped: it projects its chats into `worktrees`. It
  // must therefore survive the partition gate unconditionally, exactly like a
  // repo-backed workspace, and never depend on the flat-layout opt-in. Pinned
  // before `type` was made honest; the assertions below are unchanged by that
  // flip, only the fixture's shape is.
  it('includes a tree-layout cloud project regardless of the flat opt-in', () => {
    const workspaces = [
      workspace('git'),
      workspace('desktop-cowork', { type: 'cowork', layout: 'flat' }),
      workspace('cloud', {
        type: 'cowork',
        layout: 'tree',
        backend: 'cloud',
      }),
    ];

    expect(
      partitionWorkspaces(workspaces, []).visible.map(({ localId }) => localId),
    ).toEqual(['cloud', 'git']);
    expect(
      partitionWorkspaces(workspaces, [], { includeFlat: true }).visible.map(
        ({ localId }) => localId,
      ),
    ).toEqual(['cloud', 'desktop-cowork', 'git']);
  });

  // A flat (desktop Cowork) project never has worktrees: its live content is
  // its standalone chats. Turning "Always show project" off must hide it only
  // once those are gone, as the desktop legacy rail did (`workEntryCount`).
  it('keeps an alwaysShow:false flat project visible while it has live chats', () => {
    const workspaces = [
      workspace('live-cowork', {
        type: 'cowork',
        layout: 'flat',
        alwaysShow: false,
      }),
      workspace('archived-cowork', {
        type: 'cowork',
        layout: 'flat',
        alwaysShow: false,
      }),
      workspace('empty-cowork', {
        type: 'cowork',
        layout: 'flat',
        alwaysShow: false,
      }),
    ];
    const result = partitionWorkspaces(workspaces, [], {
      includeFlat: true,
      standaloneChats: [
        { projectLocalId: 'live-cowork' },
        { projectLocalId: 'archived-cowork', archived: true },
      ],
    });
    expect(result.visible.map(({ localId }) => localId)).toEqual([
      'live-cowork',
    ]);
    expect(result.hidden.map(({ localId }) => localId)).toEqual([
      'archived-cowork',
      'empty-cowork',
    ]);
  });

  it('does not let standalone chats keep an empty tree project visible', () => {
    const result = partitionWorkspaces(
      [workspace('temporary', { alwaysShow: false })],
      [],
      { standaloneChats: [{ projectLocalId: 'temporary' }] },
    );
    expect(result.visible).toHaveLength(0);
    expect(result.hidden.map(({ localId }) => localId)).toEqual(['temporary']);
  });

  it('orders projects by order, name, then id', () => {
    const values = [
      workspace('z', { name: 'Beta', order: 1 }),
      workspace('b', { name: 'Alpha', order: 1 }),
      workspace('a', { name: 'Alpha', order: 1 }),
      workspace('first', { order: 0 }),
    ];
    expect(
      values.sort(compareWorkspaces).map(({ localId }) => localId),
    ).toEqual(['first', 'a', 'b', 'z']);
  });

  it('orders and partitions worktrees by order, label-or-branch, then id', () => {
    const values = [
      worktree('z', 'workspace', { branch: 'beta', order: 1 }),
      worktree('b', 'workspace', {
        branch: 'ignored',
        label: ' alpha ',
        order: 1,
      }),
      worktree('a', 'workspace', { branch: 'alpha', order: 1 }),
      worktree('hidden', 'workspace', { hidden: true, order: 0 }),
    ];
    expect(
      values
        .slice()
        .sort(compareWorktrees)
        .map(({ localId }) => localId),
    ).toEqual(['hidden', 'a', 'b', 'z']);
    const result = partitionWorktrees(values, 'workspace');
    expect(result.visible.map(({ localId }) => localId)).toEqual([
      'a',
      'b',
      'z',
    ]);
    expect(result.hidden.map(({ localId }) => localId)).toEqual(['hidden']);
    expect(partitionWorktrees([], 'workspace')).toEqual({
      visible: [],
      hidden: [],
    });
  });

  it('places grouped branch children directly after their parent in flat order', () => {
    const values = [
      worktree('parent', 'workspace', { order: 1 }),
      worktree('sibling', 'workspace', { order: 2 }),
      {
        ...worktree('child', 'workspace', { order: 3 }),
        branchGroupingParentWorktreeId: 'parent',
      },
    ];

    expect(
      partitionWorktrees(values, 'workspace').visible.map(
        ({ localId }) => localId,
      ),
    ).toEqual(['parent', 'child', 'sibling']);
  });

  it('projects every runtime field and canonical conflicting status priority', () => {
    const result = projectWorktreeRuntime(
      worktree('row', 'workspace', {
        status: 'done',
        busy: true,
        isStreaming: true,
        isRunningRun: false,
        isDiscovering: true,
        pipelineStatus: 'running',
        terminalStatus: 'unseen',
        scriptStatus: 'running',
        hookStatus: 'running',
        awaitingApproval: true,
        hasUnread: true,
        healthIssue: { status: 'broken', reason: 'gone' },
        setupPhase: 'running-setup',
        diffStats: { insertions: 2, deletions: 1 },
      }),
    );
    expect(result).toMatchObject({
      uiStatus: 'done',
      isStreaming: true,
      isRunningRun: false,
      isDiscovering: true,
      pipelineStatus: 'running',
      terminalStatus: 'unseen',
      scriptStatus: 'running',
      hookStatus: 'running',
      awaitingApproval: true,
      hasUnread: true,
      setupPhase: 'running-setup',
      diffStats: { insertions: 2, deletions: 1 },
      runtimeState: 'done',
    });
  });

  it('rolls unanswered chat questions up onto their worktree', () => {
    expect(
      Array.from(
        rollUpPendingQuestionWorktreeKeys([
          {
            workspaceLocalId: 'ws',
            worktreeLocalId: 'waiting',
            pendingQuestions: [{ answered: true }, { answered: false }],
          },
          {
            workspaceLocalId: 'ws',
            worktreeLocalId: 'answered',
            pendingQuestions: [{ answered: true }],
          },
          // Standalone chats carry no worktree and never light a row.
          { pendingQuestions: [{ answered: false }] },
          { workspaceLocalId: 'ws', worktreeLocalId: 'none' },
        ]),
      ),
    ).toEqual(['ws/waiting']);
    expect(rollUpPendingQuestionWorktreeKeys(undefined).size).toBe(0);
    expect(
      projectWorktreeRuntime(worktree('row'), { hasPendingQuestion: true })
        .hasPendingQuestion,
    ).toBe(true);
    expect(projectWorktreeRuntime(worktree('row')).hasPendingQuestion).toBe(
      false,
    );
  });

  it("masks only a muted space's blue-dot sources (CAN-4378)", () => {
    const unread = worktree('row', 'workspace', {
      hasUnread: true,
      pipelineStatus: 'unseen',
    });
    expect(projectWorktreeRuntime(unread, { spaceMuted: true })).toMatchObject({
      uiStatus: 'idle',
      hasUnread: undefined,
      pipelineStatus: undefined,
    });
    expect(projectWorktreeRuntime(unread)).toMatchObject({
      uiStatus: 'unread',
      hasUnread: true,
      pipelineStatus: 'unseen',
    });
    expect(
      projectWorktreeRuntime(unread, { spaceMuted: false }).hasUnread,
    ).toBe(true);

    // Orange, red and live work are not routine activity: they pass through.
    expect(
      projectWorktreeRuntime(
        worktree('row', 'workspace', {
          hasUnread: true,
          isStreaming: true,
          awaitingApproval: true,
          pipelineStatus: 'unseen-failure',
        }),
        { spaceMuted: true, hasPendingQuestion: true },
      ),
    ).toMatchObject({
      uiStatus: 'working',
      hasUnread: undefined,
      isStreaming: true,
      awaitingApproval: true,
      hasPendingQuestion: true,
      pipelineStatus: 'unseen-failure',
    });
    for (const pipelineStatus of ['running', 'paused'] as const) {
      expect(
        projectWorktreeRuntime(
          worktree('row', 'workspace', { pipelineStatus }),
          {
            spaceMuted: true,
          },
        ).pipelineStatus,
      ).toBe(pipelineStatus);
    }
    expect(
      projectWorktreeRuntime(
        worktree('row', 'workspace', { pipelineStatus: 'paused' }),
        { spaceMuted: true },
      ).uiStatus,
    ).toBe('planning');
  });

  it("carries a worktree's background count to its row (turn-state phase 41f)", () => {
    expect(
      projectWorktreeRuntime({ ...worktree('row'), backgroundTasks: 2 })
        .backgroundTasks,
    ).toBe(2);
  });

  it.each([
    ['explicit done', 'done', 'open', true],
    ['legacy omitted status with merged PRs', undefined, 'merged', true],
    ['active with stale merged PRs', 'active', 'merged', false],
    ['omitted status with an open PR', undefined, 'open', false],
  ] as const)(
    'guards done state for %s',
    (_label, status, prState, expected) => {
      expect(
        isWorktreeDone(
          worktree('row', 'workspace', {
            status,
            lastKnownPrStatus: {
              repos: [
                {
                  repoId: 'repo',
                  repoName: 'repo',
                  status: {
                    state: prState,
                    prNumber: 1,
                    prUrl: 'https://github.com/example/repo/pull/1',
                    title: 'PR',
                    checkStatus: 'passing',
                    reviewStatus: 'approved',
                    hasConflicts: false,
                    commentCount: 0,
                    updatedAt: '2026-10-06T00:00:00.000Z',
                  },
                },
              ],
              lastCheckedAt: '2026-10-06T00:00:00.000Z',
            },
          }),
        ),
      ).toBe(expected);
    },
  );

  it('retains pending rows until an authoritative snapshot adds an id', () => {
    const pending = new Map([['workspace', new Set(['old'])]]);
    expect(
      pendingWorkspaceIdsAfterSnapshot(pending, [
        worktree('old', 'workspace'),
      ]).has('workspace'),
    ).toBe(true);
    expect(
      pendingWorkspaceIdsAfterSnapshot(pending, [
        worktree('old', 'workspace'),
        worktree('new', 'workspace'),
      ]).has('workspace'),
    ).toBe(false);
  });

  it('clears pending when ids change without increasing the count', () => {
    const pending = new Map([['workspace', new Set(['old'])]]);
    expect(
      pendingWorkspaceIdsAfterSnapshot(pending, [
        worktree('replacement', 'workspace'),
      ]).has('workspace'),
    ).toBe(false);
  });
});

describe('context scoping (CAN-2954)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rows = [
    workspace('unowned'),
    workspace('personal', { owner: { type: 'personal' } }),
    workspace('acme', {
      owner: { type: 'organization', organizationId: ORG_A, projectId: 'p1' },
    }),
    workspace('zen', {
      owner: { type: 'organization', organizationId: ORG_B, projectId: 'p2' },
    }),
  ];

  it('keeps the unscoped list when no context is given', () => {
    expect(partitionWorkspaces(rows, []).visible.map((w) => w.localId)).toEqual(
      ['acme', 'personal', 'unowned', 'zen'],
    );
  });

  it('shows unowned and Personal rows in the Personal context', () => {
    expect(
      partitionWorkspaces(rows, [], {
        context: { kind: 'personal' },
      }).visible.map((w) => w.localId),
    ).toEqual(['personal', 'unowned']);
  });

  it('admits linked Personal rows without admitting another organization', () => {
    const options = {
      context: { kind: 'organization', organizationId: ORG_A } as const,
      linkedPersonalWorkspaceIds: ['unowned', 'personal', 'zen'],
    };
    expect(
      partitionWorkspaces(rows, [], options).visible.map((w) => w.localId),
    ).toEqual(['acme', 'personal', 'unowned']);
    expect(
      partitionWorkspaces(rows, [], {
        ...options,
        visibleWorkspaceIds: new Set(['acme']),
      }).visible.map((w) => w.localId),
    ).toEqual(['acme']);
  });

  it('shows only that organization in an organization context', () => {
    expect(
      partitionWorkspaces(rows, [], {
        context: { kind: 'organization', organizationId: ORG_A },
      }).visible.map((w) => w.localId),
    ).toEqual(['acme']);
    expect(
      partitionWorkspaces(rows, [], {
        context: { kind: 'organization', organizationId: ORG_B },
      }).hidden,
    ).toEqual([]);
  });

  it('lists an org-owned cloud workspace only under its organization (CAN-3458)', () => {
    const cloudRows = [
      ...rows,
      workspace('cloud-a', {
        owner: { type: 'cloud-organization', organizationId: ORG_A },
      }),
    ];
    expect(
      partitionWorkspaces(cloudRows, [], {
        context: { kind: 'organization', organizationId: ORG_A },
      }).visible.map((w) => w.localId),
    ).toEqual(['acme', 'cloud-a']);
    expect(
      partitionWorkspaces(cloudRows, [], {
        context: { kind: 'organization', organizationId: ORG_B },
      }).visible.map((w) => w.localId),
    ).toEqual(['zen']);
    expect(
      partitionWorkspaces(cloudRows, [], {
        context: { kind: 'personal' },
      }).visible.map((w) => w.localId),
    ).toEqual(['personal', 'unowned']);
  });

  it('lists a temporary combination only in the scope its owner names (CAN-3846)', () => {
    const combination = (
      localId: string,
      partial: Partial<Workspace> = {},
    ): Workspace =>
      workspace(localId, {
        type: 'multi-repo',
        temporary: true,
        alwaysShow: false,
        ...partial,
      });
    const combinationRows = [
      ...rows,
      combination('combo-bound', {
        owner: {
          type: 'organization',
          organizationId: ORG_A,
          projectId: 'p-combo',
        },
      }),
      combination('combo-unowned'),
    ];
    const combinationWorktrees = [
      worktree('combo-bound-wt', 'combo-bound'),
      worktree('combo-unowned-wt', 'combo-unowned'),
    ];
    const scoped = (
      context: NonNullable<
        Parameters<typeof partitionWorkspaces>[2]
      >['context'],
    ): string[] => {
      const result = partitionWorkspaces(
        combinationRows,
        combinationWorktrees,
        { context },
      );
      return [...result.visible, ...result.hidden].map((w) => w.localId);
    };
    const visibleIn = (
      context: NonNullable<
        Parameters<typeof partitionWorkspaces>[2]
      >['context'],
    ): string[] =>
      partitionWorkspaces(combinationRows, combinationWorktrees, {
        context,
      }).visible.map((w) => w.localId);

    const orgA = { kind: 'organization', organizationId: ORG_A } as const;
    expect(visibleIn(orgA)).toContain('combo-bound');
    expect(scoped(orgA)).not.toContain('combo-unowned');

    const personal = { kind: 'personal' } as const;
    expect(visibleIn(personal)).toContain('combo-unowned');
    expect(scoped(personal)).not.toContain('combo-bound');

    const orgB = { kind: 'organization', organizationId: ORG_B } as const;
    expect(scoped(orgB)).not.toContain('combo-bound');
    expect(scoped(orgB)).not.toContain('combo-unowned');
  });

  it('applies the visible-id filter on top of the context', () => {
    expect(
      partitionWorkspaces(rows, [], {
        context: { kind: 'personal' },
        visibleWorkspaceIds: new Set(['unowned']),
      }).visible.map((w) => w.localId),
    ).toEqual(['unowned']);
  });
});
