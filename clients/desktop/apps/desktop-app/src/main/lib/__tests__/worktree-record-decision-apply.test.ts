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
  admitCoworkPublishManifest,
  admitCoworkStageManifest,
  allocateCoworkMigrationTo,
  applyAdoptedWorkspaceIndexReleaseTo,
  applyArchiveRestoreRecordTo,
  applyArchiveRestoreRemovalTo,
  applyCoworkCreationIndexTo,
  applyCoworkCreationManifestTo,
  applyCoworkMetadataIndexTo,
  applyCoworkMetadataTo,
  applyCoworkPublishIndexTo,
  applyCoworkPublishManifestTo,
  applyCoworkStageManifestTo,
  checkCoworkDiscardIndex,
  CoworkWorkspaceRecordRefusedError,
  coworkCreationItemFor,
  coworkCreationTaken,
  discardsCoworkStaging,
  applyCoworkMigrationManifestTo,
  applyCoworkProvisionIndexTo,
  applyCoworkProvisionManifestTo,
  applyHookExecutionContextsRebindTo,
  applyOrganizationPrivateMemoryTo,
  applyPipelineResultsSeenTo,
  applyWorktreeBranchRename,
  applyWorktreeListDecisionTo,
  applyWorktreeRowDecisionTo,
  checkAdoptedWorkspaceRelease,
  decideOrganizationOwnerRefresh,
  isDeepStrictEqualData,
  withUnknownCoworkFields,
  workspaceAdditionWriteFor,
  workspaceCreationIds,
  workspaceCreationWriteFor,
} from '../worktree-record-decision-apply';
import type * as ApplyModule from '../worktree-record-decision-apply';
import type {
  ArchiveRestoreRecordDecision,
  ArchiveRestoreRemovalDecision,
  CoworkCreationAllocationDecision,
  CoworkDiscardDecision,
  CoworkMetadataDecision,
  CoworkProvisionDecision,
  CoworkPublishDecision,
  CoworkStageDecision,
  OrganizationOwnerBinding,
  W5ManifestRead,
  WorkspaceAdditionDecision,
  WorkspaceCreationDecision,
  WorktreeBranchRenameDecision,
  WorktreeListDecision,
  WorktreeRowDecision,
} from '../worktree-record-decisions';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
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
        checkDetails: [],
        reviewStatus: 'none',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-10-02T00:00:00.000Z',
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
  const sharedDir = path.resolve(
    libDir,
    '../../../../../packages/desktop-shared/src/node',
  );
  const ALLOWED = new Set([
    '@canopy/desktop-shared/types',
    '@canopy/desktop-shared/node/worktree-record-decision-apply',
    '@canopy/desktop-shared/node/worktree-record-decisions',
    './worktree-record-decisions',
  ]);

  function importsOf(file: string, directory = libDir): string[] {
    const source = readFileSync(path.join(directory, file), 'utf8');
    return ts
      .preProcessFile(source, true, true)
      .importedFiles.map((entry) => entry.fileName);
  }

  it('imports only shared types, hook normalization and its sibling pure modules', () => {
    expect(
      importsOf('worktree-record-decision-apply.ts').filter(
        (specifier) =>
          !ALLOWED.has(specifier) &&
          specifier !== '@canopy/desktop-shared/hooks',
      ),
    ).toEqual([]);
    expect(
      importsOf('worktree-record-decisions.ts').filter(
        (specifier) => !ALLOWED.has(specifier),
      ),
    ).toEqual([]);
    expect(
      importsOf('worktree-record-decision-apply.ts', sharedDir).filter(
        (specifier) =>
          specifier !== '../types' &&
          specifier !== './worktree-record-decisions',
      ),
    ).toEqual([]);
    expect(
      importsOf('worktree-record-decisions.ts', sharedDir).filter(
        (specifier) => specifier !== '../types',
      ),
    ).toEqual([]);
  });

  // W6f2 reuses the existing in-memory hook normalizer and overlay key;
  // duplicating them would let source recording drift from source conversion.
  it('keeps hook normalization dependencies within the reviewed pure graph', () => {
    const root = path.resolve(libDir, '../../../../..');
    const config = ts.readConfigFile(
      path.join(root, 'tsconfig.base.json'),
      (fileName) => ts.sys.readFile(fileName),
    );
    const { options } = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      root,
    );
    const pureFiles = new Set([
      'packages/desktop-shared/src/hooks.ts',
      'packages/desktop-shared/src/brand/env.ts',
      'packages/desktop-shared/src/lib/codex-speed.ts',
      'packages/desktop-shared/src/lib/plugin-selections-normalization.ts',
      'packages/desktop-shared/src/lib/scoped-config-utils.ts',
      'packages/desktop-shared/src/plugin-refs.ts',
      'packages/desktop-shared/src/scripts.ts',
      'packages/desktop-shared/src/thinking.ts',
      'packages/desktop-shared/src/types/approvals.ts',
      'packages/desktop-shared/src/node/worktree-record-decision-apply.ts',
      'packages/desktop-shared/src/node/worktree-record-decisions.ts',
      'packages/plugin-interop/src/github-repo.ts',
      'packages/protocol/src/agents/index.ts',
      'packages/protocol/src/automations/index.ts',
      'packages/protocol/src/capability-files/index.ts',
      'packages/protocol/src/configured-prompt-references/index.ts',
      'packages/protocol/src/hook-triggers.ts',
      'packages/protocol/src/installed-items/index.ts',
      'packages/protocol/src/marketplace/index.ts',
      'packages/protocol/src/pipelines/package.ts',
      'packages/protocol/src/plugins/catalog.ts',
      'packages/protocol/src/plugins/index.ts',
      'packages/protocol/src/scripts/index.ts',
      'packages/protocol/src/thinking/index.ts',
      'packages/protocol/src/try-it/index.ts',
    ]);
    const visited = new Set<string>();
    function visit(file: string): void {
      if (visited.has(file)) return;
      visited.add(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      // Generated brand modules contain constants and their current re-export.
      expect(
        pureFiles.has(relative) ||
          /^\.cache\/brand\/[^/]+\/desktop-brand\.ts$/.test(relative),
      ).toBe(true);
      const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext },
      });
      for (const { fileName } of ts.preProcessFile(outputText, true, true)
        .importedFiles) {
        // The only external runtime dependency is Zod's pure schema validation.
        if (fileName === 'zod') continue;
        const resolved = ts.resolveModuleName(
          fileName,
          file,
          options,
          ts.sys,
        ).resolvedModule;
        if (!resolved)
          throw new Error(`Unresolved pure dependency: ${fileName}`);
        visit(resolved.resolvedFileName);
      }
    }
    visit(path.join(root, 'packages/desktop-shared/src/hooks.ts'));
    visit(path.join(sharedDir, 'worktree-record-decision-apply.ts'));
    visit(path.join(sharedDir, 'worktree-record-decisions.ts'));
    expect(visited.size).toBeGreaterThan(1);
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

// W6a2 (CAN-4814): the pure apply of the remaining Cowork decisions, at the
// edges the real-worker suite does not reach.
describe('remaining Cowork apply', () => {
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
  const ABSENT: W5ManifestRead = { ...OK, authority: 'absent' };
  function manifest(
    fields: Partial<WorkspaceConfigFile> = {},
  ): WorkspaceConfigFile {
    return { version: 1, type: 'cowork', repos: [], ...fields };
  }
  function entry(
    id: string,
    type: WorkspaceIndexEntry['type'] = 'cowork',
  ): WorkspaceIndexEntry {
    return { id, name: id, type, color: '#123456', collapsed: false, order: 0 };
  }
  /** The reason `work` was refused for. */
  function refusal(work: () => unknown): unknown {
    try {
      work();
    } catch (error) {
      return error instanceof CoworkWorkspaceRecordRefusedError
        ? error.reason
        : error;
    }
    return undefined;
  }

  it('allocates from a JSON round trip of its decision, and refuses a taken id at publication', () => {
    const decision: CoworkCreationAllocationDecision = {
      kind: 'cowork.create.allocate',
      name: 'Fresh',
      createdAt: CREATED_AT,
      owner: OWNER,
      pendingIds: ['pending'],
    };
    expect(coworkCreationTaken([entry('a')], decision)).toEqual(
      new Set(['a', 'pending']),
    );
    const index = { count: 1, color: '#000000' };
    const item = coworkCreationItemFor('fresh', index, decision);
    expect(coworkCreationItemFor('fresh', index, roundTrip(decision))).toEqual(
      item,
    );
    expect(item).toMatchObject({ order: 1, owner: OWNER });
    const create = { kind: 'cowork.create', item } as const;
    expect(applyCoworkCreationIndexTo([entry('a')], create)).toHaveLength(2);
    expect(
      refusal(() => applyCoworkCreationIndexTo([entry('fresh')], create)),
    ).toBe('identity-changed');
    const config = manifest();
    expect(
      refusal(() =>
        applyCoworkCreationManifestTo(config, OK, {
          kind: 'cowork.create.manifest',
          item,
        }),
      ),
    ).toBe('identity-changed');
    expect(config).toEqual(manifest());
  });

  it('stages only over its own project, never claiming an indexed id without a manifest', () => {
    const decision: CoworkStageDecision = {
      kind: 'cowork.stage',
      item: { ...entry('staged'), type: 'cowork', owner: OWNER },
      owner: OWNER,
    };
    for (const [config, read] of [
      [manifest({ owner: { ...OWNER, projectId: 'other' } }), OK],
      [manifest({ owner: OWNER }), { ...OK, ownerMalformed: true }],
      [manifest({ type: 'single-repo', owner: OWNER }), OK],
    ] as const)
      expect(
        refusal(() => admitCoworkStageManifest(config, read, decision)),
      ).toBe('identity-changed');
    // Another instance of the same project refreshes the owner.
    const rebound = manifest({ owner: { ...OWNER, instanceId: 'other' } });
    admitCoworkStageManifest(rebound, OK, decision);
    expect(applyCoworkStageManifestTo(rebound, OK, true, decision)).toBe(false);
    expect(rebound.owner).toEqual(OWNER);
    expect(
      refusal(() =>
        applyCoworkStageManifestTo(manifest(), ABSENT, true, decision),
      ),
    ).toBe('identity-changed');
  });

  it('projects a publish before its owner changes and writes nothing for the same name and binding', () => {
    const decision: CoworkPublishDecision = {
      kind: 'cowork.publish',
      workspaceId: 'staged',
      name: 'Published',
      owner: OWNER,
    };
    expect(
      refusal(() => admitCoworkPublishManifest(manifest(), ABSENT, decision)),
    ).toBe('configuration-unavailable');
    const transfer: WorkspaceOwnershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: 'org',
      projectId: 'project',
      convertedAt: CREATED_AT,
    };
    const config = manifest({
      owner: { ...OWNER, bindingGeneration: 1 },
      ownershipTransfer: transfer,
    });
    const index = { entry: undefined, count: 3, color: '#000000' };
    const outcome = applyCoworkPublishManifestTo(config, index, decision);
    expect(outcome).toMatchObject({
      changed: true,
      item: { order: 3, owner: OWNER, ownershipTransfer: transfer },
    });
    expect(config.ownershipTransfer).toBeUndefined();
    expect(applyCoworkPublishIndexTo([], undefined, outcome)).toHaveLength(1);
    const published = { ...entry('staged'), name: 'Published' };
    const same = applyCoworkPublishManifestTo(
      manifest({ owner: OWNER }),
      { ...index, entry: published },
      decision,
    );
    expect(same.changed).toBe(false);
    expect(applyCoworkPublishIndexTo([published], published, same)).toBe(
      undefined,
    );
  });

  it('imports only the fields it carries and renames only from an import', () => {
    const decision: CoworkMetadataDecision = {
      kind: 'cowork.metadata.import',
      workspaceId: 'fresh',
      name: ' Bundle ',
      cowork: { description: 'imported' },
    };
    const settings = Object.assign(
      { future: 1 },
      { description: 'old', defaultModel: 'old' },
    );
    const config = manifest({ cowork: settings });
    applyCoworkMetadataTo(config, settings, roundTrip(decision));
    expect(config.cowork).toEqual({ future: 1, description: 'imported' });
    const entries = [entry('a'), entry('fresh')];
    expect(applyCoworkMetadataIndexTo(entries, entries[1], decision)).toEqual([
      entries[0],
      { ...entries[1], name: 'Bundle' },
    ]);
    const install: CoworkMetadataDecision = {
      kind: 'cowork.metadata.install',
      workspaceId: 'fresh',
      externalId: 'template',
      contentHash: 'hash',
    };
    expect(
      applyCoworkMetadataIndexTo(entries, entries[1], install),
    ).toBeUndefined();
    // A non-import change writes the hidden settings back, even when absent.
    const bare = manifest();
    applyCoworkMetadataTo(bare, {}, install);
    expect(bare.cowork).toEqual({});
  });

  it('discards by project, not instance, and only an unpublished staging the index can prove', () => {
    const decision: CoworkDiscardDecision = {
      kind: 'cowork.discard',
      workspaceId: 'staged',
      projectId: 'project',
    };
    expect(checkCoworkDiscardIndex('partial', [], decision)).toBe(
      'index-unavailable',
    );
    expect(checkCoworkDiscardIndex('ok', [entry('staged')], decision)).toBe(
      'published',
    );
    expect(checkCoworkDiscardIndex('absent', [], decision)).toBeNull();
    const read = {
      authority: 'ok',
      ownerMalformed: false,
      type: 'cowork',
      owner: { ...OWNER, instanceId: 'other', bindingGeneration: 9 },
    } as const;
    expect(discardsCoworkStaging(read, decision)).toBe(true);
    for (const kept of [
      { ...read, owner: { ...OWNER, projectId: 'other' } },
      { ...read, owner: undefined },
      { ...read, ownerMalformed: true },
      { ...read, type: 'single-repo' },
      { ...read, authority: 'absent' },
      { ...read, authority: 'unreadable' },
    ] as const)
      expect(discardsCoworkStaging(kept, decision)).toBe(false);
  });
});

// W6a1 (CAN-4815): the sidebar writes of the workspace-service staging
// decisions, which the real-worker suite applies through the writer.
describe('workspace-service staging apply', () => {
  function single(id: string, order: number): SingleRepoSidebarItem {
    return {
      type: 'single-repo',
      id,
      name: id,
      repoPath: `/repos/${id}`,
      color: '#0EA5E9',
      worktrees: [],
      collapsed: false,
      order,
    };
  }
  const project: MultiRepoSidebarItem = {
    type: 'multi-repo',
    id: 'source',
    name: 'source',
    color: '#0EA5E9',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 1,
    sourceRepoPath: '/repos/source',
  };
  /** The decision after a JSON round trip, as a host other than main gets it. */
  function serialized<T>(decision: T): T {
    return JSON.parse(JSON.stringify(decision)) as T;
  }

  it('writes a scoped addition alone, keeping every other entry', () => {
    const decision: WorkspaceAdditionDecision = {
      kind: 'workspace.add',
      item: single('fresh', 1),
      scope: { kind: 'workspace' },
    };
    const write = workspaceAdditionWriteFor(decision);
    expect(write).toEqual({
      items: [single('fresh', 1)],
      options: {
        preserveEmptyTemporary: false,
        preserveUnmentionedWorkspaceIds: true,
        replaceOwnershipWorkspaceIds: ['fresh'],
      },
    });
    expect(workspaceAdditionWriteFor(serialized(decision))).toEqual(write);
  });

  it('writes an unscoped addition after the sidebar it read, binding only the addition', () => {
    const decision: WorkspaceAdditionDecision = {
      kind: 'workspace.add',
      item: single('claimed', 2),
      scope: {
        kind: 'sidebar',
        previousItems: [single('a', 0), single('b', 1)],
        preserveWorkspaceIds: ['warned'],
      },
    };
    const write = workspaceAdditionWriteFor(decision);
    expect(write).toEqual({
      items: [single('a', 0), single('b', 1), single('claimed', 2)],
      options: {
        preserveWorkspaceIds: ['warned'],
        replaceOwnershipWorkspaceIds: ['claimed'],
      },
    });
    // Omitted empty temporary workspaces stay the writer's to preserve.
    expect(write.options).not.toHaveProperty('preserveEmptyTemporary');
    expect(workspaceAdditionWriteFor(serialized(decision))).toEqual(write);
  });

  it('publishes a create alone, binding its owner', () => {
    const decision: WorkspaceCreationDecision = {
      kind: 'workspace.create.publish',
      item: single('fresh', 1),
    };
    expect(workspaceCreationWriteFor(decision)).toEqual({
      items: [single('fresh', 1)],
      options: {
        preserveEmptyTemporary: false,
        preserveUnmentionedWorkspaceIds: true,
        replaceOwnershipWorkspaceIds: ['fresh'],
      },
    });
    expect(workspaceCreationIds(decision)).toEqual(['fresh']);
  });

  it('publishes an import with its children in order, keeping every binding on disk', () => {
    const decision: WorkspaceCreationDecision = {
      kind: 'workspace.import.publish',
      workspace: project,
      childWorkspaces: [single('first', 2), single('second', 3)],
    };
    const write = workspaceCreationWriteFor(decision);
    expect(write).toEqual({
      items: [project, single('first', 2), single('second', 3)],
      options: {
        preserveEmptyTemporary: false,
        preserveUnmentionedWorkspaceIds: true,
      },
    });
    expect(workspaceCreationIds(decision)).toEqual([
      'source',
      'first',
      'second',
    ]);
    expect(workspaceCreationWriteFor(serialized(decision))).toEqual(write);
    // An import without new members locks only its project.
    expect(workspaceCreationIds({ ...decision, childWorkspaces: [] })).toEqual([
      'source',
    ]);
  });
});

// W6f1 (CAN-4836): the branch rename's row write, which the real-worker suite
// applies through the row writer.
describe('branch rename apply', () => {
  function apply(
    current: WorktreeData,
    decision: WorktreeBranchRenameDecision,
  ): WorktreeData {
    const next = applyWorktreeBranchRename(current, decision);
    // A JSON copy applies alike, and a retried updater pass agrees.
    const copy = JSON.parse(
      JSON.stringify(decision),
    ) as WorktreeBranchRenameDecision;
    expect(applyWorktreeBranchRename(current, copy)).toEqual(next);
    expect(applyWorktreeBranchRename(next, decision)).toBe(next);
    return next;
  }

  it('moves the sidebar branch on a root rename, clearing the PR status', () => {
    expect(
      apply(row('a', { lastKnownPrStatus: PR_STATUS, status: 'done' }), {
        kind: 'worktree.branch.rename',
        branchName: 'renamed',
        updatesSidebarBranch: true,
      }),
    ).toEqual(row('a', { branchName: 'renamed', lastKnownPrStatus: null }));
  });

  it('keeps the sidebar branch on a member repository rename', () => {
    expect(
      apply(row('a', { lastKnownPrStatus: PR_STATUS }), {
        kind: 'worktree.branch.rename',
        branchName: 'member',
        updatesSidebarBranch: false,
      }),
    ).toEqual(row('a', { lastKnownPrStatus: null }));
  });

  it('returns the row itself when it already holds the rename', () => {
    const renamed = row('a', {
      branchName: 'renamed',
      lastKnownPrStatus: null,
    });
    expect(
      applyWorktreeBranchRename(renamed, {
        kind: 'worktree.branch.rename',
        branchName: 'renamed',
        updatesSidebarBranch: true,
      }),
    ).toBe(renamed);
  });

  it('stores the name as given, without trimming', () => {
    expect(
      apply(row('a'), {
        kind: 'worktree.branch.rename',
        branchName: 'renamed\u00a0',
        updatesSidebarBranch: true,
      }).branchName,
    ).toBe('renamed\u00a0');
  });
});

// W6e1 (CAN-4917): the archive restore records' list writes, which the
// real-worker suite applies through the list writer.
describe('archive restore apply', () => {
  const NEWER = '2026-10-05T00:00:00.000Z';
  const STAGED = row('recovery-1', {
    label: 'Archived work',
    restoredFromFilesOnlyArchiveId: 'archive-1',
  });
  const RECORD: ArchiveRestoreRecordDecision = {
    kind: 'archive.container.restore.record',
    worktree: STAGED,
  };
  const REMOVAL: ArchiveRestoreRemovalDecision = {
    kind: 'archive.container.restore.remove',
    worktree: { id: 'recovery-1', createdAt: CREATED_AT },
  };
  function copy<T>(decision: T): T {
    return JSON.parse(JSON.stringify(decision)) as T;
  }

  it('appends the staged row after the current rows', () => {
    const current = [row('a'), row('b')];
    const pass = applyArchiveRestoreRecordTo(current, RECORD);
    expect(pass).toEqual({
      worktrees: [row('a'), row('b'), STAGED],
      decided: { status: 'recorded', worktree: STAGED },
    });
    expect(current).toEqual([row('a'), row('b')]);
    // A JSON copy applies alike.
    expect(applyArchiveRestoreRecordTo(current, copy(RECORD))).toEqual(pass);
  });

  it('keeps the list when the same incarnation already holds the id', () => {
    const existing = row('recovery-1', { label: 'Renamed' });
    const current = [row('a'), existing];
    const pass = applyArchiveRestoreRecordTo(current, RECORD);
    expect(pass.worktrees).toBe(current);
    expect(pass.decided).toEqual({
      status: 'already-recorded',
      worktree: existing,
    });
    // A retried pass over its own result agrees.
    expect(applyArchiveRestoreRecordTo(pass.worktrees, RECORD)).toEqual(pass);
  });

  it('reports another incarnation at the id without changing the list', () => {
    const other = row('recovery-1', { createdAt: NEWER });
    const current = [other];
    const pass = applyArchiveRestoreRecordTo(current, RECORD);
    expect(pass.worktrees).toBe(current);
    expect(pass.decided).toEqual({
      status: 'identity-changed',
      worktree: other,
    });
  });

  it('removes only the recorded incarnation, keeping the order of the rest', () => {
    const current = [row('a'), STAGED, row('b')];
    const pass = applyArchiveRestoreRemovalTo(current, REMOVAL);
    expect(pass).toEqual({ worktrees: [row('a'), row('b')], removed: true });
    expect(applyArchiveRestoreRemovalTo(current, copy(REMOVAL))).toEqual(pass);
    // A retried pass over its own result removes nothing more.
    const again = applyArchiveRestoreRemovalTo(pass.worktrees, REMOVAL);
    expect(again.worktrees).toBe(pass.worktrees);
    expect(again.removed).toBe(false);
  });

  it.each([
    ['another incarnation', [row('recovery-1', { createdAt: NEWER })]],
    ['no row', [row('a')]],
    ['an empty list', []],
  ])('keeps the list itself for %s at the id', (_label, current) => {
    const pass = applyArchiveRestoreRemovalTo(current, REMOVAL);
    expect(pass.worktrees).toBe(current);
    expect(pass.removed).toBe(false);
  });
});
