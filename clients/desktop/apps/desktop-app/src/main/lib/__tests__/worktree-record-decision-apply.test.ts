// W6-0 (CAN-4401): the pure apply of the W5 record decisions. Every kind
// must survive JSON serialization unchanged, give the same result when the
// locked updater runs it again, and load without the desktop persistence
// module or Electron.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeCreationIdentity,
  type WorktreeData,
  type WorktreeHealthIssue,
  type WorktreePrStatus,
} from '@canopy/desktop-shared/types';
import {
  allocateCoworkMigrationTo,
  applyAdoptedWorkspaceIndexReleaseTo,
  applyCoworkMigrationManifestTo,
  applyCoworkProvisionIndexTo,
  applyCoworkProvisionManifestTo,
  applyHookExecutionContextsRebindTo,
  applyOrganizationPrivateMemoryTo,
  applyPipelineResultsSeenTo,
  applyWorktreeListDecisionTo,
  applyWorktreeRowDecisionTo,
  checkAdoptedWorkspaceRelease,
  decideOrganizationOwnerRefresh,
  isDeepStrictEqualData,
  withUnknownCoworkFields,
} from '../worktree-record-decision-apply';
import type * as ApplyModule from '../worktree-record-decision-apply';
import type {
  CoworkProvisionDecision,
  OrganizationOwnerBinding,
  W5ManifestRead,
  WorktreeListDecision,
  WorktreeRowDecision,
} from '../worktree-record-decisions';
import type {
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const NOW = new Date('2026-10-17T08:30:00.000Z');

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: CREATED_AT,
    ...extra,
  };
}

const PR_STATUS: WorktreePrStatus = {
  repos: [
    {
      repoId: 'r1',
      repoName: 'r1',
      status: {
        prNumber: 1,
        prUrl: 'https://example.test/pr/1',
        state: 'merged',
        title: 'Feature',
        checkStatus: 'passing',
      },
    },
  ],
  lastCheckedAt: '2026-10-02T00:00:00.000Z',
};

const HEALTH_ISSUE: WorktreeHealthIssue = {
  status: 'broken',
  code: 'missing-worktree-path',
  message: 'Worktree directory does not exist.',
  checkedAt: '2026-10-03T00:00:00.000Z',
  worktreePath: '/worktrees/wt-1',
  repoIssues: [
    {
      repoId: 'b',
      repoName: 'b',
      repoPath: '/worktrees/wt-1/b',
      code: 'missing-worktree-path',
      message: 'gone',
    },
  ],
};

const PENDING_CREATION: WorktreeCreationIdentity = {
  operationId: 'op-1',
  state: 'recovery-required',
  phase: 'source-root-repair',
  checkouts: [{ repositoryPath: '/repos/r1', checkoutPath: '/worktrees/wt-1' }],
};

/** Each row kind with a row it changes and a row it leaves (or refuses). */
const ROW_CASES: [string, WorktreeRowDecision, WorktreeData[]][] = [
  [
    'activity.watermark',
    { kind: 'activity.watermark', touchedAt: '2026-10-05T12:00:00.000Z' },
    [
      row('a', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }),
      row('a', { lastTouchedAt: '2026-10-06T00:00:00.000Z' }),
      row('a'),
    ],
  ],
  [
    'chatBadges (chat_commit)',
    {
      kind: 'chatBadges',
      source: 'chat_commit',
      summary: {
        version: 2,
        unreadChats: [{ chatId: 'c1', title: 'One', providerType: 'claude' }],
        approvalChats: [],
        needsHydration: false,
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    },
    [row('a'), row('a', { chatBadges: undefined })],
  ],
  [
    'chatBadges (launch_backfill)',
    {
      kind: 'chatBadges',
      source: 'launch_backfill',
      summary: {
        version: 2,
        unreadChats: [],
        approvalChats: [],
        needsHydration: false,
        chatName: 'Named',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    },
    [
      row('a'),
      row('a', {
        chatBadges: {
          version: 1,
          unreadChats: [],
          approvalChats: [],
          needsHydration: false,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      }),
    ],
  ],
  [
    'git.branch',
    {
      kind: 'git.branch',
      branchName: 'feature/next',
      updatesSidebarBranch: true,
    },
    [
      row('a', { lastKnownPrStatus: PR_STATUS, status: 'done' }),
      row('a', { branchName: 'feature/next', lastKnownPrStatus: null }),
    ],
  ],
  [
    'git.pr-status',
    { kind: 'git.pr-status', status: PR_STATUS },
    [
      row('a'),
      row('a', { lastKnownPrStatus: PR_STATUS, status: 'done' }),
      row('a', { lastKnownPrStatus: null }),
    ],
  ],
  [
    'git.split-child-grouping',
    { kind: 'git.split-child-grouping' },
    [row('a'), row('a', { branchGroupingOverride: 'group' })],
  ],
  [
    'git.split-original-retarget',
    {
      kind: 'git.split-original-retarget',
      branchName: 'integration',
      trackedBaseBranch: 'main',
    },
    [
      row('a'),
      row('a', { branchName: 'integration', trackedBaseBranch: 'main' }),
    ],
  ],
  [
    'health (diff-stats)',
    { kind: 'health', source: 'diff-stats', issue: HEALTH_ISSUE },
    [
      row('a'),
      row('a', {
        healthIssue: { ...HEALTH_ISSUE, checkedAt: '2026-10-01T00:00:00.000Z' },
      }),
    ],
  ],
  [
    'health (healthy)',
    { kind: 'health', source: 'health-check', issue: null },
    [
      row('a', { healthIssue: HEALTH_ISSUE, splitRecoveryRequired: true }),
      row('a'),
    ],
  ],
  [
    'discovery.environment',
    {
      kind: 'discovery.environment',
      discovery: {
        slashCommands: [{ name: 'review', description: 'Review' }],
        mcpServers: [],
        discoveredAt: '2026-10-02T00:00:00.000Z',
        providerType: 'claude',
      },
    },
    [row('a')],
  ],
  [
    'discovery.branch-prompt',
    { kind: 'discovery.branch-prompt', sent: false },
    [
      row('a', { branchPromptSent: true }),
      row('a', { branchPromptSent: false }),
    ],
  ],
  [
    'recovery.promote-pending',
    {
      kind: 'recovery.promote-pending',
      createdAt: CREATED_AT,
      branchName: 'feature/checked-out',
    },
    [
      row('a', { setupPhase: 'git-pending' }),
      row('a', { setupPhase: 'git-ready' }),
      row('a', {
        setupPhase: 'git-pending',
        createdAt: '2026-10-09T00:00:00Z',
      }),
    ],
  ],
  [
    'recovery.complete-source-root-repair',
    {
      kind: 'recovery.complete-source-root-repair',
      createdAt: CREATED_AT,
      operationId: 'op-1',
    },
    [
      row('a', { setupPhase: 'git-pending', creation: PENDING_CREATION }),
      row('a', {
        setupPhase: 'git-pending',
        creation: { ...PENDING_CREATION, operationId: 'op-2' },
      }),
      row('a', { setupPhase: 'git-ready', creation: PENDING_CREATION }),
    ],
  ],
  [
    'recovery.expose-create-reservation',
    {
      kind: 'recovery.expose-create-reservation',
      createdAt: CREATED_AT,
      operationId: 'op-1',
      worktreePath: '/worktrees/wt-1',
    },
    [
      row('a', {
        setupPhase: 'git-pending',
        creation: { ...PENDING_CREATION, state: 'pending', phase: 'git-setup' },
      }),
      row('a', { creation: PENDING_CREATION }),
      row('a'),
    ],
  ],
  [
    'recovery.expose-split-reservation',
    {
      kind: 'recovery.expose-split-reservation',
      createdAt: CREATED_AT,
      worktreePath: '/worktrees/wt-1',
    },
    [
      row('a', { hidden: true, setupPhase: 'git-pending' }),
      row('a', { createdAt: '2026-10-09T00:00:00.000Z' }),
    ],
  ],
];

const LIST_CASES: [string, WorktreeListDecision, WorktreeData[][]][] = [
  [
    'activity.auto-delete-baseline',
    {
      kind: 'activity.auto-delete-baseline',
      touchedAt: '2026-10-05T12:00:00.000Z',
    },
    [
      [
        row('a', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }),
        row('b', { lastTouchedAt: '2026-10-09T00:00:00.000Z' }),
        row('c'),
      ],
      [row('a', { lastTouchedAt: '2026-10-09T00:00:00.000Z' })],
      [],
    ],
  ],
  [
    'git.merged-base-retarget',
    {
      kind: 'git.merged-base-retarget',
      repoIds: [null, 'r1', WORKSPACE_ROOT_REPO_ID],
      mergedBranchName: 'feature',
      mergedIntoBranchName: 'main',
      mergedWorktreeId: 'merged',
    },
    [
      [
        row('merged', { trackedBaseBranch: 'feature' }),
        row('a', { trackedBaseBranch: 'feature' }),
        row('b', {
          trackedRepoBaseBranches: {
            r1: 'feature',
            [WORKSPACE_ROOT_REPO_ID]: 'feature',
            other: 'feature',
          },
        }),
        row('c', { trackedBaseBranch: 'develop' }),
      ],
      [row('c', { trackedBaseBranch: 'develop' })],
    ],
  ],
];

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('worktree record decision apply', () => {
  it('covers every decision kind', () => {
    const kinds = new Set([
      ...ROW_CASES.map(([, decision]) => decision.kind),
      ...LIST_CASES.map(([, decision]) => decision.kind),
    ]);
    expect(kinds.size).toBe(15);
  });

  describe.each(ROW_CASES)('%s', (_name, decision, rows) => {
    it.each(rows.map((current, index) => [index, current]))(
      'gives the same row after a JSON round trip (row %i)',
      (_index, current) => {
        expect(
          applyWorktreeRowDecisionTo(current, roundTrip(decision), {
            now: NOW,
          }),
        ).toEqual(applyWorktreeRowDecisionTo(current, decision, { now: NOW }));
      },
    );

    it.each(rows.map((current, index) => [index, current]))(
      'gives equal output when applied again (row %i)',
      (_index, current) => {
        const snapshot = structuredClone(current);
        const first = applyWorktreeRowDecisionTo(current, decision, {
          now: NOW,
        });
        const second = applyWorktreeRowDecisionTo(current, decision, {
          now: NOW,
        });
        expect(second).toEqual(first);
        // The input row is never mutated, so a retried updater sees it as read.
        expect(current).toEqual(snapshot);
        if (first !== null) {
          expect(
            applyWorktreeRowDecisionTo(first, decision, { now: NOW }),
          ).toEqual(first);
        }
      },
    );
  });

  describe.each(LIST_CASES)('%s', (_name, decision, lists) => {
    it.each(lists.map((current, index) => [index, current]))(
      'gives the same list after a JSON round trip (list %i)',
      (_index, current) => {
        expect(
          applyWorktreeListDecisionTo(current, roundTrip(decision)),
        ).toEqual(applyWorktreeListDecisionTo(current, decision));
      },
    );

    it.each(lists.map((current, index) => [index, current]))(
      'gives equal output when applied again (list %i)',
      (_index, current) => {
        const snapshot = structuredClone(current);
        const first = applyWorktreeListDecisionTo(current, decision);
        expect(applyWorktreeListDecisionTo(current, decision)).toEqual(first);
        expect(current).toEqual(snapshot);
        expect(applyWorktreeListDecisionTo(first, decision)).toEqual(first);
      },
    );
  });

  it('returns the same row or list object when the decision writes nothing', () => {
    const current = row('a', { branchGroupingOverride: 'group' });
    expect(
      applyWorktreeRowDecisionTo(
        current,
        { kind: 'git.split-child-grouping' },
        { now: NOW },
      ),
    ).toBe(current);
    const list = [row('a', { lastTouchedAt: '2026-10-09T00:00:00.000Z' })];
    expect(
      applyWorktreeListDecisionTo(list, {
        kind: 'activity.auto-delete-baseline',
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
    ).toBe(list);
  });

  it('refuses another incarnation with null for every recovery kind', () => {
    const replaced = row('a', { createdAt: '2026-10-09T00:00:00.000Z' });
    for (const [, decision] of ROW_CASES) {
      if (!decision.kind.startsWith('recovery.')) continue;
      expect(
        applyWorktreeRowDecisionTo(replaced, decision, { now: NOW }),
      ).toBeNull();
    }
  });

  it('stamps exposed reservations with the supplied clock only', () => {
    const exposed = applyWorktreeRowDecisionTo(
      row('a', { hidden: true }),
      {
        kind: 'recovery.expose-split-reservation',
        createdAt: CREATED_AT,
        worktreePath: '/worktrees/wt-1',
      },
      { now: NOW },
    );
    expect(exposed?.healthIssue?.checkedAt).toBe(NOW.toISOString());
  });
});

describe('worktree record decision apply imports', () => {
  const libDir = path.join(__dirname, '..');
  const ALLOWED = new Set([
    '@canopy/desktop-shared/types',
    './worktree-record-decisions',
  ]);

  function importsOf(file: string): string[] {
    const source = readFileSync(path.join(libDir, file), 'utf8');
    return ts
      .preProcessFile(source, true, true)
      .importedFiles.map((entry) => entry.fileName);
  }

  it('imports only shared types and its sibling pure modules', () => {
    expect(
      importsOf('worktree-record-decision-apply.ts').filter(
        (specifier) => !ALLOWED.has(specifier),
      ),
    ).toEqual([]);
    expect(
      importsOf('worktree-record-decisions.ts').filter(
        (specifier) => !ALLOWED.has(specifier),
      ),
    ).toEqual([]);
  });

  it('loads alone, without Electron or the desktop persistence module', () => {
    jest.isolateModules(() => {
      jest.doMock(
        'electron',
        () => {
          throw new Error('electron must not load');
        },
        { virtual: true },
      );
      jest.doMock('../workspace-persistence', () => {
        throw new Error('workspace-persistence must not load');
      });
      const apply = jest.requireActual<typeof ApplyModule>(
        '../worktree-record-decision-apply',
      );
      expect(
        apply.applyWorktreeRowDecisionTo(
          row('a'),
          { kind: 'git.split-child-grouping' },
          { now: NOW },
        ),
      ).toEqual(row('a', { branchGroupingOverride: 'group' }));
    });
  });
});

// W6d1 (CAN-4410): the composition undo compares rows and fields with
// `util.isDeepStrictEqual`; the pure module may not import `node:util`.
describe('composition data equality', () => {
  const symlink = {
    path: '/links/a',
    targetPath: '/targets/a',
    reason: 'adhoc-multi-repo-transition',
    sourceWorkspaceId: 'w',
    sourceWorktreeId: 'r',
    createdAt: CREATED_AT,
  };
  const sparse: unknown[] = [];
  sparse.length = 1;
  const PAIRS: [string, unknown, unknown][] = [
    ['equal rows', row('a', { label: 'x' }), row('a', { label: 'x' })],
    ['a changed field', row('a', { label: 'x' }), row('a', { label: 'y' })],
    ['a key holding undefined', { ...row('a'), label: undefined }, row('a')],
    ['undefined both sides', { label: undefined }, { label: undefined }],
    ['undefined and null', { label: undefined }, { label: null }],
    ['absent and undefined leaves', undefined, undefined],
    ['nested records', { b: { r: 'main' } }, { b: { r: 'main' } }],
    ['nested records differ', { b: { r: 'main' } }, { b: { r: 'dev' } }],
    ['key order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['symlinks', [symlink], [{ ...symlink }]],
    [
      'symlink order',
      [symlink, { ...symlink, path: 'b' }],
      [{ ...symlink, path: 'b' }, symlink],
    ],
    ['array lengths', ['a'], ['a', 'a']],
    ['a hole and undefined', sparse, [undefined]],
    ['an array and a record', ['a'], { 0: 'a' }],
    ['a string and a number', '1', 1],
    ['NaN', Number.NaN, Number.NaN],
    ['signed zero', 0, -0],
    ['null and an empty record', null, {}],
    ['empty records', {}, {}],
    ['a null prototype', Object.create(null), {}],
  ];
  it.each(PAIRS)('agrees on %s', (_name, left, right) => {
    expect(isDeepStrictEqualData(left, right)).toBe(
      isDeepStrictEqual(left, right),
    );
    expect(isDeepStrictEqualData(right, left)).toBe(
      isDeepStrictEqual(right, left),
    );
  });
});

// W5c2 (CAN-4807): the pure apply of the ownership, seed, Cowork and seen
// decisions, at the edges the real-worker suite does not reach.
describe('ownership, Cowork and seen apply', () => {
  const OWNER: OrganizationOwnerBinding = {
    type: 'organization',
    organizationId: 'org',
    projectId: 'project',
    instanceId: 'instance',
    bindingGeneration: 2,
  };
  const OK: W5ManifestRead = {
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
  function manifest(
    fields: Partial<WorkspaceConfigFile> = {},
  ): WorkspaceConfigFile {
    return { version: 1, type: 'single-repo', repos: [], ...fields };
  }
  function entry(
    id: string,
    type: WorkspaceIndexEntry['type'],
  ): WorkspaceIndexEntry {
    return { id, name: id, type, color: '#123456', collapsed: false, order: 0 };
  }

  it('holds nothing for another organization, project or instance, and keeps a fence that is not behind', () => {
    const refresh = {
      kind: 'ownership.organization.refresh',
      owner: OWNER,
    } as const;
    for (const owner of [
      { ...OWNER, organizationId: 'other' },
      { ...OWNER, projectId: 'other' },
      { ...OWNER, instanceId: 'other' },
    ])
      expect(
        decideOrganizationOwnerRefresh(
          { authority: 'ok', type: 'single-repo', owner },
          refresh,
        ),
      ).toEqual({ replacement: null });
    expect(
      decideOrganizationOwnerRefresh(
        { authority: 'ok', type: 'single-repo' },
        refresh,
      ),
    ).toEqual({ replacement: null });
    expect(
      decideOrganizationOwnerRefresh(
        { authority: 'ok', type: 'single-repo', owner: OWNER },
        refresh,
      ),
    ).toEqual({ held: OWNER, replacement: null });
    const transfer: WorkspaceOwnershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: 'org',
      projectId: 'project',
      convertedAt: CREATED_AT,
    };
    const next = { ...OWNER, bindingGeneration: 3 };
    expect(
      decideOrganizationOwnerRefresh(
        {
          authority: 'ok',
          type: 'single-repo',
          owner: OWNER,
          ownershipTransfer: transfer,
        },
        { kind: 'ownership.organization.refresh', owner: next },
      ),
    ).toEqual({
      held: next,
      replacement: {
        kind: 'ownership.owner',
        owner: next,
        ownershipTransfer: transfer,
      },
    });
  });

  it('rebinds only unbound or previous-context executable hooks, skipping plugin-only overlays', () => {
    const config = manifest({
      hooks: {
        'worktree:created': [
          { type: 'chat', prompt: 'a' },
          { type: 'chat', prompt: 'b', executionContext: 'elsewhere' },
          {
            type: 'chat',
            prompt: 'c',
            localPluginSelectionOverlay: true,
          },
          { type: 'command', command: 'echo' },
        ],
      },
    });
    expect(
      applyHookExecutionContextsRebindTo(config, {
        kind: 'ownership.hook-contexts.rebind',
        previousContext: 'personal',
        nextContext: 'org:org',
      }),
    ).toEqual(['workspace-root:worktree:created:0']);
    expect(config.hooks?.['worktree:created']?.[1]).toMatchObject({
      executionContext: 'elsewhere',
    });
  });

  it('checks a release in its write order: absent, unreadable owner, then the binding', () => {
    const release = {
      kind: 'ownership.adoption.release',
      instanceId: 'instance',
      index: { kind: 'ownership.adoption.release.index', workspaceId: 'a' },
    } as const;
    expect(
      checkAdoptedWorkspaceRelease(
        manifest({ owner: OWNER }),
        { ...OK, authority: 'absent', ownerMalformed: true },
        release,
      ),
    ).toBe('absent');
    expect(
      checkAdoptedWorkspaceRelease(
        manifest({ owner: OWNER }),
        { ...OK, ownerMalformed: true },
        release,
      ),
    ).toBe('owner-unreadable');
    expect(checkAdoptedWorkspaceRelease(manifest(), OK, release)).toBe(
      'bound-elsewhere',
    );
    expect(
      checkAdoptedWorkspaceRelease(manifest({ owner: OWNER }), OK, release),
    ).toBe('bound');
    const entries = [entry('a', 'single-repo'), entry('b', 'single-repo')];
    expect(applyAdoptedWorkspaceIndexReleaseTo(entries, release.index)).toEqual(
      [entries[1]],
    );
    expect(
      applyAdoptedWorkspaceIndexReleaseTo([entries[1]], release.index),
    ).toBeNull();
  });

  it('refuses organization private memory over a malformed policy or owner without changing the manifest', () => {
    const decision = {
      kind: 'ownership.private-memory',
      organizationId: 'org',
      projectId: 'project',
      privateMemory: false,
    } as const;
    for (const read of [
      { ...OK, memoryMalformed: true },
      { ...OK, ownerMalformed: true },
      { ...OK, authority: 'absent' as const },
    ]) {
      const config = manifest({ owner: OWNER, privateMemory: true });
      expect(applyOrganizationPrivateMemoryTo(config, read, decision)).toBe(
        'refused',
      );
      expect(config).toEqual(manifest({ owner: OWNER, privateMemory: true }));
    }
    // An unmarked policy with the same value still records the marker.
    const unmarked = manifest({ owner: OWNER, privateMemory: false });
    expect(applyOrganizationPrivateMemoryTo(unmarked, OK, decision)).toBe(
      'recorded',
    );
    expect(unmarked.privateMemoryManagedBy).toBe('organization');
  });

  it('restores only unknown Cowork fields from a raw record, never from an array', () => {
    const config = manifest({
      type: 'cowork',
      cowork: { description: 'kept' },
    });
    expect(
      withUnknownCoworkFields(
        { future: 1, description: 'raw', archiveRetentionDays: 'bad' },
        config,
      ),
    ).toEqual({ future: 1, description: 'kept' });
    expect(withUnknownCoworkFields(['future'], manifest())).toEqual({});
    const none = manifest();
    withUnknownCoworkFields({ future: 1 }, none);
    expect(none.cowork).toBeUndefined();
  });

  it('allocates a migration past every non-Cowork entry and reuses a Cowork one', () => {
    const decision = {
      kind: 'cowork.migration',
      candidateId: 'legacy',
      name: 'Legacy',
    } as const;
    const taken = [
      entry('legacy', 'multi-repo'),
      entry('legacy-2', 'single-repo'),
    ];
    const allocated = allocateCoworkMigrationTo(taken, decision, '#000000');
    expect(allocated.id).toBe('legacy-3');
    expect(allocated.entries?.[2]).toEqual({
      id: 'legacy-3',
      name: 'Legacy',
      type: 'cowork',
      color: '#000000',
      collapsed: false,
      order: 2,
    });
    expect(
      allocateCoworkMigrationTo(
        [...taken, entry('legacy-3', 'cowork')],
        decision,
        '#000000',
      ),
    ).toEqual({ id: 'legacy-3' });
    // A field this version does not know, as a newer one may have written.
    const settings = Object.assign({ future: 1 }, { description: 'old' });
    const config = manifest({ cowork: settings });
    applyCoworkMigrationManifestTo(config, settings, {
      kind: 'cowork.migration.manifest',
    });
    expect(config).toMatchObject({
      type: 'cowork',
      repos: [],
      cowork: { future: 1 },
    });
  });

  it('provisions without publishing when asked not to, and never notifies then', () => {
    const decision: CoworkProvisionDecision = {
      kind: 'cowork.provision',
      workspaceId: 'cowork',
      publishToIndex: false,
      name: 'Chats',
      createdAt: CREATED_AT,
    };
    const config = manifest();
    const pass = applyCoworkProvisionManifestTo(
      config,
      { ...OK, authority: 'absent' },
      { entry: undefined, count: 0, color: '#000000' },
      decision,
    );
    expect(pass).toMatchObject({
      changed: true,
      scaffold: true,
      deferManifest: true,
    });
    // An unpublished default defers nothing: its manifest is not written.
    expect(applyCoworkProvisionIndexTo([], undefined, pass, decision)).toEqual({
      result: { item: pass.item, notify: false },
    });
  });

  it('marks seen only on its incarnation and reports nothing for another one', () => {
    const rows = [row('a', { seenPipelineExecutionIds: ['x'] })];
    const decision = {
      kind: 'pipelineResults.markSeen',
      worktree: { id: 'a', createdAt: 'other' },
      seen: ['y'],
      unseen: [],
    } as const;
    const other = applyPipelineResultsSeenTo(rows, decision);
    expect(other.worktrees).toBe(rows);
    expect(other.newlySeen).toBeUndefined();
    const same = applyPipelineResultsSeenTo(rows, {
      ...decision,
      worktree: { id: 'a', createdAt: CREATED_AT },
      seen: ['x'],
    });
    expect(same).toEqual({ worktrees: rows, newlySeen: [] });
    expect(same.worktrees).toBe(rows);
  });
});
