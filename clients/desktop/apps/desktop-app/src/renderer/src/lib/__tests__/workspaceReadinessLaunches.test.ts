import type {
  SidebarItem,
  WorkspaceReadinessIssue,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  isLaunchedReadinessFixObsolete,
  launchDestinationLabel,
  launchedReadinessFixKey,
  launchedReadinessFixesForTarget,
  parseLaunchedReadinessFixes,
  resolveLaunchedReadinessFixStatus,
  resolvedLaunchedReadinessFixes,
  serializeLaunchedReadinessFixes,
  workspaceReadinessLaunchKey,
  workspaceReadinessLaunchNoun,
  type LaunchedReadinessFix,
  type LaunchedReadinessFixStatusInput,
  type WorkspaceReadinessLaunchInventory,
} from '../workspaceReadinessLaunches';

const record: LaunchedReadinessFix = {
  workspaceId: 'workspace-1',
  issueKey: 'api:configure-agent-instructions',
  issueCode: 'configure-agent-instructions',
  worktreeId: 'fix-worktree',
  chatId: 'fix-chat',
  launchedAt: '2026-10-31T12:00:00.000Z',
};

const issue: WorkspaceReadinessIssue = {
  code: 'configure-agent-instructions',
  title: 'Initialize agent instructions',
  message: 'No AGENTS.md.',
  repoId: 'api',
  repoName: 'API',
  fixPrompt: 'Write instructions.',
};

function worktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: 'fix-worktree',
    branchName: 'fix-agents',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function workspace(worktrees: WorktreeData[]): SidebarItem {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    type: 'single-repo',
    repoPath: '/repos/api',
    color: '#fff',
    collapsed: false,
    order: 0,
    worktrees,
  };
}

const mergedPr: WorktreePrStatus = {
  lastCheckedAt: '2026-10-31T12:00:00.000Z',
  repos: [
    {
      repoId: 'api',
      repoName: 'API',
      status: {
        prNumber: 1,
        prUrl: 'https://github.com/example/api/pull/1',
        state: 'merged',
        title: 'Add agent instructions',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-10-31T12:00:00.000Z',
        mergedAt: '2026-10-31T12:00:00.000Z',
      },
    },
  ],
};

function inventory(
  overrides: Partial<WorkspaceReadinessLaunchInventory> = {},
): WorkspaceReadinessLaunchInventory {
  return {
    projects: [workspace([worktree()])],
    complete: true,
    failedWorkspaceIds: new Set(),
    prStatuses: {},
    ...overrides,
  };
}

describe('launch keys', () => {
  it('separates workspaces, audit targets and issues without delimiter collisions', () => {
    const keys = new Set([
      workspaceReadinessLaunchKey('a:b', undefined, 'c'),
      workspaceReadinessLaunchKey('a', undefined, 'b:c'),
      workspaceReadinessLaunchKey('a', 'reference', 'c'),
      workspaceReadinessLaunchKey('a', undefined, 'c'),
      workspaceReadinessLaunchKey('a', 'worktree-1', 'c'),
      workspaceReadinessLaunchKey('b', undefined, 'c'),
    ]);
    expect(keys.size).toBe(6);
  });

  it('keys a record by its workspace, target and issue', () => {
    expect(launchedReadinessFixKey(record)).toBe(
      workspaceReadinessLaunchKey('workspace-1', undefined, record.issueKey),
    );
    expect(
      launchedReadinessFixKey({ ...record, baseWorktreeId: 'base' }),
    ).not.toBe(launchedReadinessFixKey(record));
  });
});

describe('storage parsing', () => {
  it('round-trips valid records, including a worktree target', () => {
    const targeted = { ...record, baseWorktreeId: 'base-worktree' };
    const raw = serializeLaunchedReadinessFixes({
      [launchedReadinessFixKey(record)]: record,
      [launchedReadinessFixKey(targeted)]: targeted,
    });
    expect(parseLaunchedReadinessFixes(raw)).toEqual({
      [launchedReadinessFixKey(record)]: record,
      [launchedReadinessFixKey(targeted)]: targeted,
    });
  });

  it.each([
    ['missing storage', null],
    ['malformed JSON', '{'],
    ['an array container', '[]'],
    ['an unsupported version', JSON.stringify({ version: 2, records: [] })],
    [
      'records that are not a list',
      JSON.stringify({ version: 1, records: {} }),
    ],
  ])('ignores %s', (_label, raw) => {
    expect(parseLaunchedReadinessFixes(raw)).toEqual({});
  });

  it('drops malformed records and keeps valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      records: [
        record,
        { ...record, issueKey: 'other', issueCode: 'unknown-code' },
        { ...record, issueKey: 'empty-chat', chatId: '' },
        { ...record, issueKey: 'bad-date', launchedAt: 'not a date' },
        { ...record, issueKey: 'bad-target', baseWorktreeId: 42 },
        { ...record, issueKey: 'empty-target', baseWorktreeId: '' },
        'not an object',
        null,
      ],
    });
    expect(Object.values(parseLaunchedReadinessFixes(raw))).toEqual([record]);
  });
});

describe('audit resolution', () => {
  it('selects only records launched from the audited target', () => {
    const targeted = { ...record, baseWorktreeId: 'base' };
    const other = { ...record, workspaceId: 'workspace-2' };
    const records = Object.fromEntries(
      [record, targeted, other].map((entry) => [
        launchedReadinessFixKey(entry),
        entry,
      ]),
    );
    expect(
      launchedReadinessFixesForTarget(records, 'workspace-1', undefined),
    ).toEqual([record]);
    expect(
      launchedReadinessFixesForTarget(records, 'workspace-1', 'base'),
    ).toEqual([targeted]);
  });

  it('resolves records the audit no longer reports and keeps reported ones', () => {
    expect(resolvedLaunchedReadinessFixes([record], [issue])).toEqual([]);
    expect(resolvedLaunchedReadinessFixes([record], [])).toEqual([record]);
    expect(
      resolvedLaunchedReadinessFixes(
        [record],
        [{ ...issue, repoId: 'web', repoName: 'Web' }],
      ),
    ).toEqual([record]);
  });
});

describe('isLaunchedReadinessFixObsolete', () => {
  it('keeps a listed, unmerged fix worktree', () => {
    expect(isLaunchedReadinessFixObsolete(record, inventory())).toBe(false);
  });

  it('retires a fix worktree absent from a complete list', () => {
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({ projects: [workspace([])] }),
      ),
    ).toBe(true);
    expect(
      isLaunchedReadinessFixObsolete(record, inventory({ projects: [] })),
    ).toBe(true);
  });

  it('does not treat a loading or failed list as absence', () => {
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({ projects: [], complete: false }),
      ),
    ).toBe(false);
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [workspace([])],
          failedWorkspaceIds: new Set(['workspace-1']),
        }),
      ),
    ).toBe(false);
  });

  it('does not retire a launch from a list requested before that launch', () => {
    const launchedAt = Date.parse(record.launchedAt);
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [],
          readStartedAt: launchedAt - 1,
        }),
      ),
    ).toBe(false);
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [],
          readStartedAt: launchedAt + 1,
        }),
      ),
    ).toBe(true);
  });

  it('retires a merged fix worktree but not one only marked done', () => {
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({ projects: [workspace([worktree({ status: 'done' })])] }),
      ),
    ).toBe(false);
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [workspace([worktree({ status: 'done' })])],
          prStatuses: { 'workspace-1/fix-worktree': mergedPr },
        }),
      ),
    ).toBe(true);
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [
            workspace([
              worktree({ status: 'done', lastKnownPrStatus: mergedPr }),
            ]),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('prefers live PR status over the persisted snapshot', () => {
    expect(
      isLaunchedReadinessFixObsolete(
        record,
        inventory({
          projects: [
            workspace([
              worktree({ status: 'done', lastKnownPrStatus: mergedPr }),
            ]),
          ],
          prStatuses: { 'workspace-1/fix-worktree': null },
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveLaunchedReadinessFixStatus', () => {
  const idleTab: NonNullable<LaunchedReadinessFixStatusInput['tab']> = {
    status: 'idle',
    queuedMessages: [],
  };
  const queuedMessage = { text: 'Next step' };
  const base: LaunchedReadinessFixStatusInput = {
    worktree: { setupPhase: 'git-ready' },
    tab: idleTab,
    chatsHydrated: true,
    sendPending: false,
    sendFailed: false,
  };

  it.each<[string, Partial<LaunchedReadinessFixStatusInput>]>([
    ['streaming', { tab: { ...idleTab, status: 'streaming' } }],
    ['queued', { tab: { ...idleTab, queuedMessages: [queuedMessage] } }],
    [
      'setup pending',
      {
        worktree: { setupPhase: 'git-pending' },
        tab: undefined,
        chatsHydrated: false,
      },
    ],
    ['send pending', { sendPending: true }],
    [
      'a pending sending lease',
      {
        tab: {
          ...idleTab,
          sendingLease: {
            userMessageId: 'u',
            kind: 'send',
            issuedAt: 0,
            deadline: 1,
            state: 'pending',
          },
        },
      },
    ],
  ])('reports in progress while %s', (_label, overrides) => {
    expect(resolveLaunchedReadinessFixStatus({ ...base, ...overrides })).toBe(
      'in-progress',
    );
  });

  it('reports ready to review for an idle hydrated chat', () => {
    expect(resolveLaunchedReadinessFixStatus(base)).toBe('ready-to-review');
  });

  it('does not treat an unhydrated idle tab as completed work', () => {
    expect(
      resolveLaunchedReadinessFixStatus({ ...base, chatsHydrated: false }),
    ).toBe('unknown');
  });

  it('reports needs attention for a known failure', () => {
    expect(
      resolveLaunchedReadinessFixStatus({ ...base, sendFailed: true }),
    ).toBe('needs-attention');
    expect(
      resolveLaunchedReadinessFixStatus({
        ...base,
        tab: { ...idleTab, status: 'error' },
      }),
    ).toBe('needs-attention');
  });

  it('reports unknown until the chat hydrates, then a missing chat', () => {
    expect(
      resolveLaunchedReadinessFixStatus({
        ...base,
        tab: undefined,
        chatsHydrated: false,
      }),
    ).toBe('unknown');
    expect(resolveLaunchedReadinessFixStatus({ ...base, tab: undefined })).toBe(
      'chat-missing',
    );
  });
});

describe('copy helpers', () => {
  it('names each fixable issue and falls back to its title', () => {
    expect(workspaceReadinessLaunchNoun(issue)).toBe('Agent instructions');
    expect(
      workspaceReadinessLaunchNoun({ ...issue, code: 'configure-scripts' }),
    ).toBe('Setup and launch scripts');
    expect(
      workspaceReadinessLaunchNoun({ ...issue, code: 'configure-hooks' }),
    ).toBe('Repository hooks');
    expect(
      workspaceReadinessLaunchNoun({ ...issue, code: 'recovery-required' }),
    ).toBe(issue.title);
  });

  it('prefers a nonempty worktree label over the branch name', () => {
    expect(launchDestinationLabel(worktree({ label: 'Docs pass' }))).toBe(
      'Docs pass',
    );
    expect(launchDestinationLabel(worktree({ label: '  ' }))).toBe(
      'fix-agents',
    );
    expect(launchDestinationLabel(worktree({ branchName: '' }))).toBe(
      undefined,
    );
    expect(launchDestinationLabel(undefined)).toBe(undefined);
  });
});
