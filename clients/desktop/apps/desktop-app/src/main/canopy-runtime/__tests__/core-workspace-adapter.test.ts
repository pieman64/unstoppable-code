import {
  CoreWorkspaceSchema,
  CoreWorktreeSchema,
  hasHostAbsolutePath,
} from '@canopy/protocol/canopy-core';
import type {
  SidebarItemsFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.workspace.read', 'core.worktree.read'],
};

const worktree: WorktreeData = {
  id: 'wt-1',
  branchName: 'feature',
  createdAt: '2026-09-01T00:00:00Z',
  trackedBaseBranch: null,
};

function fixture(
  kind: 'single-repo' | 'multi-repo' | 'cowork',
): SidebarItemsFile {
  const common = {
    id: 'ws-1',
    name: 'Workspace',
    color: 'blue',
    collapsed: false,
    order: 0,
  };
  if (kind === 'cowork')
    return {
      version: 1,
      items: [
        {
          ...common,
          type: 'cowork',
          externalPath: '/secret/home',
          archivedContainerCount: 2,
        },
      ],
    };
  if (kind === 'multi-repo')
    return {
      version: 1,
      items: [
        {
          ...common,
          type: 'multi-repo',
          sourceRepoPath: '/secret/source',
          repos: [
            {
              id: 'repo-1',
              name: 'Repo',
              repoPath: '/secret/repo',
              manifestUrl: 'https://example.com/repo.git',
            },
          ],
          worktrees: [worktree],
          archivedContainerCount: 2,
        },
      ],
    };
  return {
    version: 1,
    items: [
      {
        ...common,
        type: 'single-repo',
        repoPath: '/secret/repo',
        worktrees: [worktree],
      },
    ],
  };
}

function makeRuntime(
  sidebar: SidebarItemsFile,
  persistedWorktrees: WorktreeData[] = sidebar.items[0]?.type === 'cowork'
    ? []
    : [worktree],
): {
  runtime: DesktopCanopyDispatcher;
  reads: {
    readAllSidebarItems: jest.Mock;
    readWorkspaceWorktrees: jest.Mock;
    readWorkspaceConfig: jest.Mock;
    readEffectiveWorkspaceConfig: jest.Mock;
    readWorkspaceIndexEntry: jest.Mock;
  };
} {
  const readAllSidebarItems = jest.fn().mockResolvedValue(sidebar);
  const readWorkspaceWorktrees = jest
    .fn()
    .mockResolvedValue(persistedWorktrees);
  const readWorkspaceConfig = jest
    .fn()
    .mockResolvedValue({ version: 1, type: 'multi-repo', repos: [] });
  const readEffectiveWorkspaceConfig = jest.fn().mockResolvedValue({
    repos: [{ id: 'repo-1', manifestUrl: 'https://example.com/repo.git' }],
  });
  const readWorkspaceIndexEntry = jest.fn().mockResolvedValue({
    id: 'ws-1',
    name: 'Workspace',
    type: sidebar.items[0]?.type,
  });
  return {
    runtime: createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems,
        readWorkspaceWorktrees,
        readWorkspaceConfig,
        readEffectiveWorkspaceConfig,
        readWorkspaceIndexEntry,
      },
    }),
    reads: {
      readAllSidebarItems,
      readWorkspaceWorktrees,
      readWorkspaceConfig,
      readEffectiveWorkspaceConfig,
      readWorkspaceIndexEntry,
    },
  };
}

function withManifestUrl(manifestUrl: string): SidebarItemsFile {
  const sidebar = fixture('multi-repo');
  if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
  sidebar.items[0].repos[0].manifestUrl = manifestUrl;
  return sidebar;
}

const HOST_PATH_SPELLINGS = [
  'FILE:///Users/alice/repo',
  'File://localhost/Users/alice/repo',
  'file:/Users/alice/repo',
  '\\Users\\alice\\repo',
  '\\\\server\\share\\repo',
  'C:\\Users\\alice\\repo',
  'c:/Users/alice/repo',
];

describe('core workspace read projections', () => {
  test('legacy projections report the authority of the read that produced them', async () => {
    const sidebar = fixture('multi-repo');
    const config = {
      version: 1 as const,
      type: 'multi-repo' as const,
      repos: [],
    };
    const readAllSidebarItems = jest.fn();
    const readWorkspaceWorktrees = jest.fn();
    const readWorkspaceConfig = jest.fn();
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems,
        readWorkspaceWorktrees,
        readWorkspaceConfig,
        readEffectiveWorkspaceConfig: jest
          .fn()
          .mockResolvedValue({ repos: [] }),
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
          id: 'ws-1',
          name: 'Workspace',
          type: 'multi-repo',
        }),
        readAllSidebarItemsSnapshot: jest.fn().mockResolvedValue({
          file: sidebar,
          authority: 'partial',
          indexAuthority: 'ok',
        }),
        readWorkspaceConfigDetailed: jest.fn().mockResolvedValue({
          config,
          authority: 'unreadable',
          ownerMalformed: true,
        }),
        readWorkspaceWorktreesDetailed: jest.fn().mockResolvedValue({
          worktrees: [worktree],
          authority: 'unreadable',
        }),
      },
    });

    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    const worktrees = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const allWorktrees = await runtime.queryWorktreeListForLegacyIpc(
      {},
      { caller },
    );

    // The index read alone stays separate from the aggregate, so one
    // unreadable project manifest cannot hide the whole inventory.
    expect(listed).toMatchObject({
      legacyResult: sidebar,
      legacyAuthority: { authority: 'partial', indexAuthority: 'ok' },
    });
    expect(got).toMatchObject({
      legacyResult: config,
      legacyAuthority: { authority: 'unreadable', ownerMalformed: true },
    });
    expect(worktrees).toMatchObject({
      legacyResult: [worktree],
      legacyAuthority: { authority: 'unreadable' },
    });
    expect(allWorktrees).toMatchObject({
      legacyResult: sidebar,
      legacyAuthority: { authority: 'partial' },
    });
    // The authority comes from the same read as the content.
    expect(readAllSidebarItems).not.toHaveBeenCalled();
    expect(readWorkspaceConfig).not.toHaveBeenCalled();
    expect(readWorkspaceWorktrees).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('legacy projections omit authority when only plain reads exist', async () => {
    const { runtime } = makeRuntime(fixture('single-repo'));
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    expect(listed).not.toHaveProperty('legacyAuthority');
    await runtime.shutdown();
  });

  test.each(['single-repo', 'multi-repo', 'cowork'] as const)(
    '%s list preserves the exact sidebar read',
    async (kind) => {
      const sidebar = fixture(kind);
      const { runtime, reads } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(reads.readAllSidebarItems).toHaveBeenCalledTimes(1);
      expect(canonicalResult?.items[0]).toMatchObject({
        workspaceId: 'ws-1',
        kind: kind === 'cowork' ? 'cowork' : 'git',
      });
      expect(JSON.stringify(canonicalResult)).not.toContain('/secret/');
      await runtime.shutdown();
    },
  );

  test('workspace get uses source-backed overlay and captures its config', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    const { canonicalResult, legacyResult } =
      await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      );
    expect(legacyResult).toEqual({ version: 1, type: 'multi-repo', repos: [] });
    expect(reads.readWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(reads.readEffectiveWorkspaceConfig).toHaveBeenCalledWith(
      'ws-1',
      legacyResult,
    );
    expect(canonicalResult?.repositorySources).toEqual([
      { repoId: 'repo-1', remoteUrl: 'https://example.com/repo.git' },
    ]);
    expect(JSON.stringify(canonicalResult)).not.toContain('/secret/');
    await runtime.shutdown();
  });

  test.each(['/tmp/repo.git', 'file:///tmp/repo.git', 'C:\\repo.git'])(
    'workspace list preserves a local manifest locator %s in the legacy result',
    async (manifestUrl) => {
      const sidebar = fixture('multi-repo');
      if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
      sidebar.items[0].repos[0].manifestUrl = manifestUrl;
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test('long manifest locators preserve list and get legacy reads', async () => {
    const manifestUrl = `https://example.com/${'x'.repeat(5_000)}`;
    const sidebar = fixture('multi-repo');
    if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
    sidebar.items[0].repos[0].manifestUrl = manifestUrl;
    const { runtime, reads } = makeRuntime(sidebar);
    reads.readEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [{ id: 'repo-1', manifestUrl }],
    });
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    expect(listed.legacyResult).toBe(sidebar);
    expect(listed.canonicalResult?.items[0].repositorySources).toEqual([]);
    expect(got.legacyResult).toEqual({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    expect(got.canonicalResult?.repositorySources).toEqual([]);
    await runtime.shutdown();
  });

  test('organization scope only lists workspaces owned by that organization', async () => {
    const sidebar = fixture('single-repo');
    const other = fixture('single-repo').items[0];
    other.id = 'ws-2';
    sidebar.items[0].owner = {
      type: 'organization',
      organizationId: 'org-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      bindingGeneration: 1,
    };
    other.owner = {
      type: 'organization',
      organizationId: 'org-2',
      projectId: 'project-2',
      instanceId: 'instance-2',
      bindingGeneration: 1,
    };
    sidebar.items.push(other);
    const { runtime } = makeRuntime(sidebar);
    const result = await runtime.query(
      'core.workspace.list',
      {
        scope: { organizationId: 'org-1' },
      },
      { caller },
    );
    expect(result.items.map((item) => item.workspaceId)).toEqual(['ws-1']);
    await runtime.shutdown();
  });

  test('workspace get rejects conflicting workspace and organization scope', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.get',
        {
          workspaceId: 'ws-1',
          scope: { workspaceId: 'ws-2' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    reads.readWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await expect(
      runtime.query(
        'core.workspace.get',
        {
          workspaceId: 'ws-1',
          scope: { organizationId: 'org-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    await runtime.shutdown();
  });

  test('workspace reads reject unrelated scope dimensions', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.list',
        {
          scope: { chatId: 'chat-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each(['/tmp/repo.git', 'file:///tmp/repo.git', 'C:\\repo.git'])(
    'workspace get preserves a local manifest locator %s in the legacy result',
    async (manifestUrl) => {
      const { runtime, reads } = makeRuntime(fixture('multi-repo'));
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: 'repo-1', manifestUrl }],
      });
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceGetForLegacyIpc(
          { workspaceId: 'ws-1' },
          { caller },
        );
      expect(legacyResult).toEqual({
        version: 1,
        type: 'multi-repo',
        repos: [],
      });
      expect(canonicalResult?.repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test.each(['/tmp', 'file://notes', 'N'.repeat(300)])(
    'workspace list accepts the existing display name %s',
    async (name) => {
      const sidebar = fixture('single-repo');
      sidebar.items[0].name = name;
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].name).toBe(name);
      await runtime.shutdown();
    },
  );
  test('worktree list and get retain the exact persisted rows', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    const listed = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const got = await runtime.queryWorktreeGetForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, worktreeId: 'wt-1' },
      { caller },
    );
    expect(listed.legacyResult).toEqual([worktree]);
    expect(got.legacyResult).toBe(worktree);
    expect(listed.canonicalResult?.items[0]).toMatchObject({
      baseBranch: null,
      createdAt: worktree.createdAt,
      state: 'ready',
    });
    expect(JSON.stringify(got.canonicalResult)).not.toContain('/secret/');
    expect(reads.readWorkspaceWorktrees).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  test.each(['single-repo', 'multi-repo', 'cowork'] as const)(
    'worktree projections preserve %s sidebar and scoped reads',
    async (kind) => {
      const sidebar = fixture(kind);
      const { runtime, reads } = makeRuntime(sidebar);
      const unscoped = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      const scoped = await runtime.queryWorktreeListForLegacyIpc(
        { scope: { workspaceId: 'ws-1' } },
        { caller },
      );
      expect(unscoped.legacyResult).toBe(sidebar);
      expect(scoped.legacyResult).toEqual(kind === 'cowork' ? [] : [worktree]);
      expect(unscoped.canonicalResult?.items).toHaveLength(
        kind === 'cowork' ? 0 : 1,
      );
      expect(JSON.stringify(unscoped.canonicalResult)).not.toContain(
        '/secret/',
      );
      expect(reads.readAllSidebarItems).toHaveBeenCalledTimes(1);
      expect(reads.readWorkspaceWorktrees).toHaveBeenCalledTimes(1);
      await runtime.shutdown();
    },
  );

  test('scoped missing worktree does not read another workspace', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.queryWorktreeGetForLegacyIpc(
        { scope: { workspaceId: 'ws-1' }, worktreeId: 'other' },
        { caller },
      ),
    ).rejects.toThrow();
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('scoped worktree reads reject traversal and unknown workspace IDs before disk access', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    for (const workspaceId of ['../outside', 'ws-2']) {
      if (workspaceId === 'ws-2') {
        reads.readWorkspaceIndexEntry.mockResolvedValue(null);
      }
      await expect(
        runtime.query(
          'core.worktree.list',
          {
            scope: { workspaceId },
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
      await expect(
        runtime.query(
          'core.worktree.get',
          {
            scope: { workspaceId },
            worktreeId: 'wt-1',
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    }
    expect(reads.readWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(reads.readWorkspaceConfig).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('worktree list applies organization and worktree scope', async () => {
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.owner = {
      type: 'organization',
      organizationId: 'org-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      bindingGeneration: 1,
    };
    item.worktrees.push({ ...worktree, id: 'wt-2' });
    const { runtime, reads } = makeRuntime(sidebar, item.worktrees);
    reads.readWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      owner: item.owner,
      repos: [],
    });

    const matching = await runtime.query(
      'core.worktree.list',
      {
        scope: { organizationId: 'org-1', worktreeId: 'wt-2' },
      },
      { caller },
    );
    expect(matching.items.map((entry) => entry.worktreeId)).toEqual(['wt-2']);

    const mismatched = await runtime.query(
      'core.worktree.list',
      {
        scope: { workspaceId: 'ws-1', organizationId: 'org-2' },
      },
      { caller },
    );
    expect(mismatched.items).toEqual([]);
    await runtime.shutdown();
  });

  test('worktree get rejects conflicting scope and unsupported dimensions', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.worktree.get',
        {
          worktreeId: 'wt-1',
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-2' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      runtime.query(
        'core.worktree.get',
        {
          worktreeId: 'wt-1',
          scope: { workspaceId: 'ws-1', organizationId: 'org-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      runtime.query(
        'core.worktree.list',
        {
          scope: { repoId: 'repo-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(reads.readWorkspaceWorktrees).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('preserves date-only createdAt in scoped and unscoped reads', async () => {
    const historical: WorktreeData = {
      ...worktree,
      createdAt: '2026-01-01',
    };
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.worktrees = [historical];
    const { runtime } = makeRuntime(sidebar, [historical]);
    const unscoped = await runtime.queryWorktreeListForLegacyIpc(
      {},
      { caller },
    );
    const scoped = await runtime.queryWorktreeGetForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, worktreeId: historical.id },
      { caller },
    );
    expect(unscoped.canonicalResult?.items[0]?.createdAt).toBe('2026-01-01');
    expect(scoped.canonicalResult?.createdAt).toBe('2026-01-01');
    expect(scoped.legacyResult).toBe(historical);
    await runtime.shutdown();
  });

  test.each(['/fix', 'C:\\notes', 'file://notes', 'x'.repeat(300)])(
    'worktree display name %s remains readable',
    async (label) => {
      const sidebar = fixture('single-repo');
      const item = sidebar.items[0];
      if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
      item.worktrees = [{ ...worktree, label }];
      const { runtime } = makeRuntime(sidebar, item.worktrees);
      const listed = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      expect(listed.canonicalResult?.items[0]?.name).toBe(label);
      expect(listed.legacyResult).toBe(sidebar);
      await runtime.shutdown();
    },
  );

  test('invalid canonical worktree rows fail the dispatcher op but keep legacy reads', async () => {
    const row: WorktreeData = { ...worktree, branchName: 'b'.repeat(513) };
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.worktrees = [row];
    const { runtime } = makeRuntime(sidebar, [row]);
    await expect(
      runtime.query('core.worktree.list', {}, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    const listed = await runtime.queryWorktreeListForLegacyIpc({}, { caller });
    const scoped = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const got = await runtime.queryWorktreeGetForLegacyIpc(
      { worktreeId: row.id },
      { caller },
    );
    expect(listed).toEqual({ canonicalResult: null, legacyResult: sidebar });
    expect(listed.legacyResult).toBe(sidebar);
    expect(scoped).toEqual({ canonicalResult: null, legacyResult: [row] });
    expect(got.canonicalResult).toBeNull();
    expect(got.legacyResult).toBe(row);
    await runtime.shutdown();
  });

  test.each([
    ['creating', { setupPhase: 'git-pending' }],
    [
      'error',
      {
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: 'Failed',
          checkedAt: worktree.createdAt,
          worktreePath: '/secret/worktree',
        },
      },
    ],
  ] as const)(
    'projects %s from persisted worktree health',
    async (state, changes) => {
      const row: WorktreeData = { ...worktree, ...changes };
      const { runtime } = makeRuntime(fixture('single-repo'), [row]);
      const got = await runtime.queryWorktreeGetForLegacyIpc(
        { scope: { workspaceId: 'ws-1' }, worktreeId: row.id },
        { caller },
      );
      expect(got.canonicalResult?.state).toBe(state);
      await runtime.shutdown();
    },
  );

  test('unscoped get rejects duplicate workspace-local worktree IDs', async () => {
    const first = fixture('single-repo');
    const sidebar: SidebarItemsFile = {
      version: 1,
      items: [
        ...first.items,
        ...first.items.map((item) => ({ ...item, id: 'ws-2' })),
      ],
    };
    const { runtime } = makeRuntime(sidebar);
    await expect(
      runtime.queryWorktreeGetForLegacyIpc({ worktreeId: 'wt-1' }, { caller }),
    ).rejects.toThrow('Workspace scope required');
    await runtime.shutdown();
  });

  test('serialization rejects host paths in canonical extension data', () => {
    expect(
      CoreWorkspaceSchema.safeParse({
        workspaceId: 'ws-1',
        name: 'Workspace',
        kind: 'git',
        repositorySources: [],
        settings: { localPath: '/secret/repo' },
      }).success,
    ).toBe(false);
    expect(
      CoreWorktreeSchema.safeParse({
        worktreeId: 'wt-1',
        workspaceId: 'ws-1',
        name: 'feature',
        state: 'ready',
        baseBranch: null,
        branch: 'feature',
        createdAt: worktree.createdAt,
        hostPath: 'C:\\secret\\repo',
      }).success,
    ).toBe(false);
  });

  test('foreign target selection fails closed', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.list',
        { scope: { targetId: 'remote' } },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each([
    [
      'https://user:token@github.com/org/repo.git?token=abc#frag',
      'https://github.com/org/repo.git',
    ],
    [
      'ssh://deploy:secret@example.com/org/repo.git',
      'ssh://example.com/org/repo.git',
    ],
    ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
  ])(
    'list and get strip credentials from remote %s',
    async (manifestUrl, remoteUrl) => {
      const sidebar = withManifestUrl(manifestUrl);
      const { runtime, reads } = makeRuntime(sidebar);
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: 'repo-1', manifestUrl }],
      });
      const listed = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller },
      );
      const got = await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      );
      expect(listed.legacyResult).toBe(sidebar);
      expect(sanitizeRemoteUrl(manifestUrl)).toBe(remoteUrl);
      expect(listed.canonicalResult?.items[0].repositorySources).toEqual([
        { repoId: 'repo-1', remoteUrl },
      ]);
      expect(got.canonicalResult?.repositorySources).toEqual([
        { repoId: 'repo-1', remoteUrl },
      ]);
      await runtime.shutdown();
    },
  );

  test('credential-only scp remotes are omitted from the canonical result', async () => {
    const sidebar = withManifestUrl('deploy@example.com:org/repo.git');
    const { runtime } = makeRuntime(sidebar);
    const { canonicalResult, legacyResult } =
      await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    expect(legacyResult).toBe(sidebar);
    expect(canonicalResult?.items[0].repositorySources).toEqual([]);
    await runtime.shutdown();
  });

  test.each(HOST_PATH_SPELLINGS)(
    'host path spelling %s is detected and kept out of canonical results',
    async (manifestUrl) => {
      expect(hasHostAbsolutePath(manifestUrl)).toBe(true);
      expect(
        CoreWorkspaceSchema.safeParse({
          workspaceId: 'ws-1',
          name: 'Workspace',
          kind: 'git',
          repositorySources: [{ repoId: 'repo-1', remoteUrl: manifestUrl }],
          settings: {},
        }).success,
      ).toBe(false);
      const sidebar = withManifestUrl(manifestUrl);
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test.each(HOST_PATH_SPELLINGS)(
    'workspace id spelled as host path %s is rejected before any read',
    async (workspaceId) => {
      const { runtime, reads } = makeRuntime(fixture('single-repo'));
      await expect(
        runtime.query('core.workspace.get', { workspaceId }, { caller }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        runtime.query(
          'core.workspace.list',
          { scope: { workspaceId } },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(reads.readWorkspaceIndexEntry).not.toHaveBeenCalled();
      expect(reads.readWorkspaceConfig).not.toHaveBeenCalled();
      expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
      await runtime.shutdown();
    },
  );

  test('overlong repo ids fail the dispatcher op but keep legacy reads', async () => {
    const repoId = 'r'.repeat(513);
    const sidebar = fixture('multi-repo');
    if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
    sidebar.items[0].repos[0].id = repoId;
    const { runtime, reads } = makeRuntime(sidebar);
    reads.readEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [{ id: repoId, manifestUrl: 'https://example.com/repo.git' }],
    });
    await expect(
      runtime.query('core.workspace.list', {}, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      runtime.query('core.workspace.get', { workspaceId: 'ws-1' }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    expect(listed).toEqual({ canonicalResult: null, legacyResult: sidebar });
    expect(listed.legacyResult).toBe(sidebar);
    expect(got).toEqual({
      canonicalResult: null,
      legacyResult: { version: 1, type: 'multi-repo', repos: [] },
    });
    await runtime.shutdown();
  });

  test('legacy helpers still surface grant failures', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: { ...caller, grants: [] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each([undefined, '/tmp/repo.git'])(
    'overlong repo ids fail the dispatcher op even without a publishable remote (%s)',
    async (manifestUrl) => {
      const repoId = 'r'.repeat(513);
      const sidebar = fixture('multi-repo');
      if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
      sidebar.items[0].repos[0].id = repoId;
      sidebar.items[0].repos[0].manifestUrl = manifestUrl;
      const { runtime, reads } = makeRuntime(sidebar);
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: repoId, manifestUrl }],
      });
      await expect(
        runtime.query('core.workspace.list', {}, { caller }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        runtime.query(
          'core.workspace.get',
          { workspaceId: 'ws-1' },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await runtime.shutdown();
    },
  );

  test('a failing source-backed overlay keeps the legacy get read', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    reads.readEffectiveWorkspaceConfig.mockRejectedValue(
      new Error('malformed source manifest'),
    );
    await expect(
      runtime.query('core.workspace.get', { workspaceId: 'ws-1' }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    await expect(
      runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      ),
    ).resolves.toEqual({
      canonicalResult: null,
      legacyResult: { version: 1, type: 'multi-repo', repos: [] },
    });
    await runtime.shutdown();
  });

  test('a legacy config read failure still surfaces through the get helper', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    const failure = new Error('config unreadable');
    reads.readWorkspaceConfig.mockRejectedValue(failure);
    await expect(
      runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(reads.readEffectiveWorkspaceConfig).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});
