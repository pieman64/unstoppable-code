import {
  CoreWorkspaceSchema,
  CoreWorktreeSchema,
  hasHostAbsolutePath,
} from '@canopy/protocol/canopy-core/core';
import {
  projectW5ReorderOutcome,
  projectW5WorkspaceCreationOutcome,
  projectW5WorktreeBranchRenameOutcome,
  projectW5WorktreeCreationOutcome,
  projectW5WorktreeUpdateOutcome,
  W5_STORED_OUTCOME_VERSION,
  W5OutcomeDecodeError,
  w5StoredOutcomeForm,
  w5StoredOutcomeVersion,
} from '../stored-outcome-projection';

/*
 * Historical receipts: `outcome_json` exactly as the commit log saved it for
 * each keyed family before W5a3 (unversioned, so version 1). Never edit a
 * fixture to fit a projector; add a new version instead.
 */
const HISTORICAL = {
  workspaceCreate:
    '{"workspace":{"id":"alpha","name":"Alpha","type":"single-repo","color":"#7C3AED","order":3},"clonedRepoIds":[],"scriptActionsOperationId":"3f2b6c1e-7d0a-4c55-9a43-1b9e0c6d2f10"}',
  workspaceImportCowork:
    '{"workspace":{"id":"notes","name":"Notes","type":"cowork","color":"#0EA5E9","order":0,"collapsed":true},"clonedRepoIds":[]}',
  workspaceImportManifest:
    '{"workspace":{"id":"suite","name":"Suite","type":"multi-repo","color":"teal","order":7,"collapsed":false},"clonedRepoIds":["api","web"],"scriptActionsOperationId":"0b8f2d5a-1c3e-4f60-8a71-92d4e5f6a7b8"}',
  worktreeCreateSingle:
    '{"status":"created","workspaceKind":"single-repo","record":{"worktreeId":"otter","branchName":"otter-1730000000000","createdAt":"2026-10-01T10:00:00.000Z","setupPhase":"git-ready","trackedBaseBranch":"main","trackedRepoBaseBranches":{},"includedRepoIds":null},"response":{"id":"otter","branchName":"otter-1730000000000","createdAt":"2026-10-01T10:00:00.000Z","setupPhase":"git-ready","trackedBaseBranch":"main"}}',
  worktreeCreateDeferred:
    '{"status":"created","workspaceKind":"multi-repo","record":{"worktreeId":"heron","branchName":"heron-1730000000000","createdAt":"2026-10-02T08:30:00.000Z","setupPhase":"git-pending","trackedBaseBranch":null,"trackedRepoBaseBranches":{"api":"develop"},"includedRepoIds":["api"]},"response":{"id":"heron","branchName":"heron-1730000000000","createdAt":"2026-10-02T08:30:00.000Z","setupPhase":"git-pending","trackedRepoBaseBranches":{"api":"develop"}}}',
  worktreeCreateNeedsRepair:
    '{"status":"needs-repair","workspaceKind":"multi-repo","worktreeId":"lynx","branchName":"lynx-1730000000000","repairIssues":[{"code":"invalid-canopy-json","message":"ENOENT: no such file or directory, open \'/Users/alex/projects/suite/canopy.json\'","blocking":true}],"response":{"id":"lynx","branchName":"lynx-1730000000000","needsRepair":true,"repairIssues":[{"code":"invalid-canopy-json","message":"ENOENT: no such file or directory, open \'/Users/alex/projects/suite/canopy.json\'","blocking":true}]}}',
  worktreeUpdate:
    '{"worktree":{"id":"one","branchName":"old","createdAt":"2026-10-01T10:00:00.000Z","label":"keyed","hidden":true,"trackedBaseBranch":null,"setupPhase":"git-ready"},"changed":true}',
  worktreeUpdateUnlabelled:
    '{"worktree":{"id":"two","branchName":"second","createdAt":"2026-10-01T10:00:00.000Z","label":"","trackedBaseBranch":"release","trackedRepoBaseBranches":{"api":"main"},"includedRepoIds":["api"]},"changed":false}',
  worktreeRename:
    '{"branchName":"renamed","worktree":{"id":"one","branchName":"renamed","createdAt":"2026-10-01T10:00:00.000Z","trackedBaseBranch":"main"}}',
  worktreeRenameMissing: '{"branchName":"renamed","worktree":null}',
  worktreeMove: 'null',
  workspaceReorder: '{"workspaceIds":["c","a","b"]}',
} as const;

const stored = (key: keyof typeof HISTORICAL): unknown =>
  JSON.parse(HISTORICAL[key]);
function storedRecord(key: keyof typeof HISTORICAL): Record<string, unknown> {
  const value = stored(key);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${key} is not an object receipt`);
  return { ...value };
}
const context = { workspaceId: 'a' };

function refusal(project: () => unknown): W5OutcomeDecodeError {
  try {
    project();
  } catch (error) {
    if (error instanceof W5OutcomeDecodeError) return error;
    throw error;
  }
  throw new Error('Expected a decode refusal');
}

describe('historical receipts', () => {
  it('projects create and import receipts to path-free workspaces', () => {
    expect(
      projectW5WorkspaceCreationOutcome(stored('workspaceCreate')),
    ).toStrictEqual({
      workspace: {
        workspaceId: 'alpha',
        name: 'Alpha',
        kind: 'git',
        repositorySources: [],
        settings: {},
        color: '#7C3AED',
      },
      clonedRepoIds: [],
      scriptActionsOperationId: '3f2b6c1e-7d0a-4c55-9a43-1b9e0c6d2f10',
    });
    expect(
      projectW5WorkspaceCreationOutcome(stored('workspaceImportCowork')),
    ).toStrictEqual({
      workspace: {
        workspaceId: 'notes',
        name: 'Notes',
        kind: 'cowork',
        repositorySources: [],
        settings: {},
        color: '#0EA5E9',
        collapsed: true,
      },
      clonedRepoIds: [],
    });
    // A color outside the result schema is omitted, as a read omits it.
    expect(
      projectW5WorkspaceCreationOutcome(stored('workspaceImportManifest')),
    ).toStrictEqual({
      workspace: {
        workspaceId: 'suite',
        name: 'Suite',
        kind: 'git',
        repositorySources: [],
        settings: {},
        collapsed: false,
      },
      clonedRepoIds: ['api', 'web'],
      scriptActionsOperationId: '0b8f2d5a-1c3e-4f60-8a71-92d4e5f6a7b8',
    });
  });

  it('projects created worktree receipts to path-free worktrees', () => {
    expect(
      projectW5WorktreeCreationOutcome(stored('worktreeCreateSingle'), context),
    ).toStrictEqual({
      status: 'created',
      worktree: {
        worktreeId: 'otter',
        workspaceId: 'a',
        name: 'otter-1730000000000',
        state: 'ready',
        baseBranch: 'main',
        branch: 'otter-1730000000000',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    });
    expect(
      projectW5WorktreeCreationOutcome(
        stored('worktreeCreateDeferred'),
        context,
      ),
    ).toStrictEqual({
      status: 'created',
      worktree: {
        worktreeId: 'heron',
        workspaceId: 'a',
        name: 'heron-1730000000000',
        state: 'creating',
        baseBranch: null,
        branch: 'heron-1730000000000',
        createdAt: '2026-10-02T08:30:00.000Z',
      },
    });
  });

  it('drops the stored repair messages, which can name host paths', () => {
    const projected = projectW5WorktreeCreationOutcome(
      stored('worktreeCreateNeedsRepair'),
      context,
    );
    expect(projected).toStrictEqual({
      status: 'needs-repair',
      worktreeId: 'lynx',
      branchName: 'lynx-1730000000000',
      repairIssues: [{ code: 'invalid-canopy-json', blocking: true }],
    });
    expect(JSON.stringify(projected)).not.toContain('/Users/');
  });

  it('projects update and rename receipts to worktrees', () => {
    expect(
      projectW5WorktreeUpdateOutcome(stored('worktreeUpdate'), context),
    ).toStrictEqual({
      worktree: {
        worktreeId: 'one',
        workspaceId: 'a',
        name: 'keyed',
        state: 'ready',
        baseBranch: null,
        branch: 'old',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
      changed: true,
    });
    // An empty label names the row by its branch, as `core.worktree.get` does.
    expect(
      projectW5WorktreeUpdateOutcome(
        stored('worktreeUpdateUnlabelled'),
        context,
      ),
    ).toStrictEqual({
      worktree: {
        worktreeId: 'two',
        workspaceId: 'a',
        name: 'second',
        state: 'ready',
        baseBranch: 'release',
        branch: 'second',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
      changed: false,
    });
    expect(
      projectW5WorktreeBranchRenameOutcome(stored('worktreeRename'), context),
    ).toStrictEqual({
      branchName: 'renamed',
      worktree: {
        worktreeId: 'one',
        workspaceId: 'a',
        name: 'renamed',
        state: 'ready',
        baseBranch: 'main',
        branch: 'renamed',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    });
    expect(
      projectW5WorktreeBranchRenameOutcome(
        stored('worktreeRenameMissing'),
        context,
      ),
    ).toStrictEqual({ branchName: 'renamed', worktree: null });
  });

  it('acknowledges void/null move and workspace reorder receipts (A17(a))', () => {
    expect(
      projectW5ReorderOutcome('core.worktree.reorder', stored('worktreeMove')),
    ).toStrictEqual({ acknowledged: true });
    expect(
      projectW5ReorderOutcome('core.worktree.reorder', undefined),
    ).toStrictEqual({ acknowledged: true });
    expect(
      projectW5ReorderOutcome(
        'core.workspace.reorder',
        stored('workspaceReorder'),
      ),
    ).toStrictEqual({ acknowledged: true });
  });

  it('every projection satisfies the protocol read shapes and names no host path', () => {
    const results = [
      projectW5WorkspaceCreationOutcome(stored('workspaceCreate')).workspace,
      projectW5WorkspaceCreationOutcome(stored('workspaceImportCowork'))
        .workspace,
      projectW5WorkspaceCreationOutcome(stored('workspaceImportManifest'))
        .workspace,
    ];
    for (const workspace of results)
      expect(CoreWorkspaceSchema.parse(workspace)).toStrictEqual(workspace);
    const worktrees = [
      projectW5WorktreeCreationOutcome(stored('worktreeCreateSingle'), context),
      projectW5WorktreeCreationOutcome(
        stored('worktreeCreateDeferred'),
        context,
      ),
      projectW5WorktreeUpdateOutcome(stored('worktreeUpdate'), context),
      projectW5WorktreeUpdateOutcome(
        stored('worktreeUpdateUnlabelled'),
        context,
      ),
      projectW5WorktreeBranchRenameOutcome(stored('worktreeRename'), context),
    ].flatMap((result) =>
      'worktree' in result && result.worktree ? [result.worktree] : [],
    );
    expect(worktrees).toHaveLength(5);
    for (const worktree of worktrees)
      expect(CoreWorktreeSchema.parse(worktree)).toStrictEqual(worktree);
    for (const [key, json] of Object.entries(HISTORICAL))
      expect(hasHostAbsolutePath(projectStored(key, JSON.parse(json)))).toBe(
        false,
      );
  });
});

describe('first response and replay', () => {
  /*
   * The live value a boundary returns can hold keys a saved receipt cannot:
   * undefined optionals, unknown host fields and non-JSON values. A first
   * response projected from the stored form equals the replay of the bytes
   * the commit log saved.
   */
  const live: Record<keyof typeof HISTORICAL, unknown> = {
    workspaceCreate: {
      workspace: {
        id: 'alpha',
        name: 'Alpha',
        type: 'single-repo',
        color: '#7C3AED',
        order: 3,
        collapsed: undefined,
        repoPath: '/Users/alex/repos/alpha',
      },
      clonedRepoIds: [],
      scriptActionsOperationId: '3f2b6c1e-7d0a-4c55-9a43-1b9e0c6d2f10',
    },
    workspaceImportCowork: {
      workspace: {
        id: 'notes',
        name: 'Notes',
        type: 'cowork',
        color: '#0EA5E9',
        order: 0,
        collapsed: true,
      },
      clonedRepoIds: [],
      scriptActionsOperationId: undefined,
    },
    workspaceImportManifest: JSON.parse(HISTORICAL.workspaceImportManifest),
    worktreeCreateSingle: JSON.parse(HISTORICAL.worktreeCreateSingle),
    worktreeCreateDeferred: JSON.parse(HISTORICAL.worktreeCreateDeferred),
    worktreeCreateNeedsRepair: JSON.parse(HISTORICAL.worktreeCreateNeedsRepair),
    worktreeUpdate: {
      worktree: {
        id: 'one',
        branchName: 'old',
        createdAt: '2026-10-01T10:00:00.000Z',
        label: 'keyed',
        hidden: true,
        pinned: undefined,
        trackedBaseBranch: null,
        setupPhase: 'git-ready',
        healthIssue: { kind: 'missing-path', path: '/Users/alex/wt/one' },
      },
      changed: true,
    },
    worktreeUpdateUnlabelled: JSON.parse(HISTORICAL.worktreeUpdateUnlabelled),
    worktreeRename: JSON.parse(HISTORICAL.worktreeRename),
    worktreeRenameMissing: { branchName: 'renamed', worktree: null },
    worktreeMove: undefined,
    workspaceReorder: { workspaceIds: ['c', 'a', 'b'] },
  };

  it.each(Object.entries(HISTORICAL))('%s', (key, json) => {
    const first = projectStored(
      key,
      w5StoredOutcomeForm(Reflect.get(live, key)),
    );
    const replay = projectStored(key, JSON.parse(json));
    expect(first).toStrictEqual(replay);
    expect(JSON.stringify(first)).toBe(JSON.stringify(replay));
  });

  it('saves the bytes the commit log writes', () => {
    expect(JSON.stringify(w5StoredOutcomeForm(live.workspaceCreate))).toBe(
      '{"workspace":{"id":"alpha","name":"Alpha","type":"single-repo","color":"#7C3AED","order":3,"repoPath":"/Users/alex/repos/alpha"},"clonedRepoIds":[],"scriptActionsOperationId":"3f2b6c1e-7d0a-4c55-9a43-1b9e0c6d2f10"}',
    );
    expect(w5StoredOutcomeForm(undefined)).toBeNull();
    expect(w5StoredOutcomeForm(null)).toBeNull();
  });
});

function projectStored(key: string, value: unknown): unknown {
  if (key.startsWith('workspaceCreate') || key.startsWith('workspaceImport'))
    return projectW5WorkspaceCreationOutcome(value);
  if (key.startsWith('worktreeCreate'))
    return projectW5WorktreeCreationOutcome(value, context);
  if (key.startsWith('worktreeUpdate'))
    return projectW5WorktreeUpdateOutcome(value, context);
  if (key.startsWith('worktreeRename'))
    return projectW5WorktreeBranchRenameOutcome(value, context);
  if (key === 'worktreeMove')
    return projectW5ReorderOutcome('core.worktree.reorder', value);
  return projectW5ReorderOutcome('core.workspace.reorder', value);
}

describe('versions', () => {
  it('reads a missing version, and null, as version 1', () => {
    expect(W5_STORED_OUTCOME_VERSION).toBe(1);
    expect(w5StoredOutcomeVersion(stored('workspaceCreate'))).toBe(1);
    expect(w5StoredOutcomeVersion(null)).toBe(1);
    expect(w5StoredOutcomeVersion(['version'])).toBe(1);
    // An inherited `version` is not the outcome's own.
    expect(w5StoredOutcomeVersion(Object.create({ version: 2 }))).toBe(1);
  });

  it('accepts an explicit version 1 and refuses every other version', () => {
    const outcome = { ...storedRecord('worktreeUpdate'), version: 1 };
    expect(projectW5WorktreeUpdateOutcome(outcome, context)).toStrictEqual(
      projectW5WorktreeUpdateOutcome(stored('worktreeUpdate'), context),
    );
    for (const version of [2, 0, '1', 1.5, null, undefined]) {
      const future = { ...storedRecord('worktreeUpdate'), version };
      expect(
        refusal(() => projectW5WorktreeUpdateOutcome(future, context)).path,
      ).toBe('version');
      expect(
        refusal(() =>
          projectW5WorkspaceCreationOutcome({
            ...storedRecord('workspaceCreate'),
            version,
          }),
        ).path,
      ).toBe('version');
    }
  });
});

describe('refusals', () => {
  it.each([
    ['a move receipt that is not void', 'core.worktree.reorder', {}],
    ['a move receipt that is false', 'core.worktree.reorder', false],
    ['a workspace reorder without ids', 'core.workspace.reorder', {}],
    ['a void workspace reorder', 'core.workspace.reorder', null],
    [
      'a workspace reorder with a non-string id',
      'core.workspace.reorder',
      { workspaceIds: ['a', 1] },
    ],
  ] as const)('refuses %s', (_label, operation, outcome) => {
    expect(() => projectW5ReorderOutcome(operation, outcome)).toThrow(
      W5OutcomeDecodeError,
    );
  });

  it.each([
    ['a missing workspace', {}, 'workspace'],
    [
      'an unknown workspace type',
      {
        workspace: {
          id: 'w',
          name: 'W',
          type: 'folder',
          color: '#000000',
          order: 0,
        },
      },
      'workspace.type',
    ],
    [
      'a missing order',
      {
        workspace: { id: 'w', name: 'W', type: 'cowork', color: '#000000' },
        clonedRepoIds: [],
      },
      'workspace.order',
    ],
    [
      'a null collapsed flag',
      {
        workspace: {
          id: 'w',
          name: 'W',
          type: 'cowork',
          color: '#000000',
          order: 0,
          collapsed: null,
        },
        clonedRepoIds: [],
      },
      'workspace.collapsed',
    ],
    [
      'missing cloned ids',
      {
        workspace: {
          id: 'w',
          name: 'W',
          type: 'cowork',
          color: '#000000',
          order: 0,
        },
      },
      'clonedRepoIds',
    ],
    [
      'a null operation id',
      {
        workspace: {
          id: 'w',
          name: 'W',
          type: 'cowork',
          color: '#000000',
          order: 0,
        },
        clonedRepoIds: [],
        scriptActionsOperationId: null,
      },
      'scriptActionsOperationId',
    ],
  ])('refuses a workspace receipt with %s', (_label, outcome, path) => {
    expect(refusal(() => projectW5WorkspaceCreationOutcome(outcome)).path).toBe(
      path,
    );
  });

  const record = {
    worktreeId: 'otter',
    branchName: 'otter-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    setupPhase: 'git-ready',
    trackedBaseBranch: 'main',
    trackedRepoBaseBranches: {},
    includedRepoIds: null,
  };
  const created = {
    status: 'created',
    workspaceKind: 'single-repo',
    record,
    response: {
      id: 'otter',
      branchName: 'otter-1',
      createdAt: record.createdAt,
    },
  };
  const issue = { code: 'invalid-canopy-json', message: 'x', blocking: true };
  const repair = {
    status: 'needs-repair',
    workspaceKind: 'multi-repo',
    worktreeId: 'lynx',
    branchName: 'lynx-1',
    repairIssues: [issue],
    response: {
      id: 'lynx',
      branchName: 'lynx-1',
      needsRepair: true,
      repairIssues: [issue],
    },
  };
  const withoutBase: Record<string, unknown> = { ...record };
  delete withoutBase.trackedBaseBranch;
  const withoutIncluded: Record<string, unknown> = { ...record };
  delete withoutIncluded.includedRepoIds;
  it.each([
    ['an unknown status', { ...created, status: 'pending' }, 'status'],
    [
      'a needs-repair single-repo receipt',
      { ...repair, workspaceKind: 'single-repo' },
      'workspaceKind',
    ],
    [
      'a missing tracked base',
      { ...created, record: withoutBase },
      'record.trackedBaseBranch',
    ],
    [
      'missing included repositories',
      { ...created, record: withoutIncluded },
      'record.includedRepoIds',
    ],
    ['a missing response', { ...created, response: undefined }, 'response'],
    [
      'an unknown repair code',
      { ...repair, repairIssues: [{ ...issue, code: 'missing-readme' }] },
      'repairIssues.0.code',
    ],
    [
      'a repair response that does not need repair',
      { ...repair, response: { ...repair.response, needsRepair: false } },
      'response.needsRepair',
    ],
  ])('refuses a worktree create receipt with %s', (_label, outcome, path) => {
    expect(
      refusal(() => projectW5WorktreeCreationOutcome(outcome, context)).path,
    ).toBe(path);
  });

  it('refuses update and rename receipts the row decoder refuses', () => {
    expect(
      refusal(() =>
        projectW5WorktreeUpdateOutcome(
          { worktree: null, changed: true },
          context,
        ),
      ).path,
    ).toBe('worktree');
    expect(
      refusal(() =>
        projectW5WorktreeBranchRenameOutcome({ worktree: null }, context),
      ).path,
    ).toBe('branchName');
  });
});
