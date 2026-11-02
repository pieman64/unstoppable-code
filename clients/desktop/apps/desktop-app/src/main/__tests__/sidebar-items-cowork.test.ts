import type * as FsPromises from 'node:fs/promises';

jest.mock('node:fs/promises');
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(
    async (
      target: string,
      data: string,
      options?: { encoding?: BufferEncoding },
    ): Promise<void> => {
      const { writeFile } =
        jest.requireMock<typeof FsPromises>('node:fs/promises');
      await writeFile(target, data, options?.encoding);
    },
  ),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceIndexFilePath: jest.fn(() => '/tmp/workspaces/index.json'),
  getWorkspaceWorktreeDir: jest.fn(
    (wsId: string, wtId: string) => `/tmp/workspaces/${wsId}/worktrees/${wtId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (wsId: string, wtId: string, repoId: string) =>
      `/tmp/workspaces/${wsId}/worktrees/${wtId}/repos/${repoId}`,
  ),
}));

const mockedWorktreesAuthority = { value: 'ok' };
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<unknown>, [string]>();
  const writeWorkspaceConfig = jest.fn<
    Promise<void>,
    [string, unknown, { ownership: string }]
  >(() => Promise.resolve());
  return {
    readWorkspaceConfig,
    WorkspaceConfigUnreadableError: class extends Error {},
    // The real guarded read-modify-write, over the mocked reader and writer.
    updateWorkspaceConfig: jest.fn(
      async (
        workspaceId: string,
        update: (config: object) => unknown,
        options?: { ownership?: string },
      ): Promise<void> => {
        const read = await readWorkspaceConfig(workspaceId);
        const config = typeof read === 'object' && read !== null ? read : {};
        const next = { ...config };
        await update(next);
        await writeWorkspaceConfig(workspaceId, next, {
          ownership: options?.ownership ?? 'preserve',
        });
      },
    ),
    readWorkspaceConfigDetailed: jest.fn(
      async (workspaceId: string): Promise<unknown> => ({
        config: await readWorkspaceConfig(workspaceId),
        authority: 'ok',
      }),
    ),
    readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
    readWorkspaceWorktreesDetailed: jest.fn(() =>
      Promise.resolve({
        worktrees: [],
        authority: mockedWorktreesAuthority.value,
      }),
    ),
    writeWorkspaceConfig,
    writeWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
  };
});

jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntrySidebarSummary: jest.fn(() =>
    Promise.resolve({
      count: 1,
      lastActivityAt: '2026-09-15T00:00:00.000Z',
    }),
  ),
  readWorkEntriesFile: jest.fn(() =>
    Promise.resolve({ version: 1, entries: [] }),
  ),
}));

jest.mock('../lib/script-resolver', () => ({
  resolveProjectScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(() => undefined),
}));

jest.mock('../lib/hook-resolver', () => ({
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoDataHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(() => undefined),
}));

import { readFile, writeFile } from 'node:fs/promises';
import type {
  CoworkSidebarItem,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  validateSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  readWorkspaceConfig,
  readWorkspaceWorktreesDetailed,
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  resolveProjectHooks,
  resolveWorkspaceRepoDataHooks,
  resolveWorkspaceRootHooks,
} from '../lib/hook-resolver';
import {
  resolveProjectScripts,
  resolveWorkspaceRootScripts,
} from '../lib/script-resolver';
import {
  readWorkEntrySidebarSummary,
  readWorkEntriesFile,
} from '../lib/cowork-work-entries-file';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
  isCoworkWorkspace,
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
const mockedWriteWorkspaceWorktrees = jest.mocked(writeWorkspaceWorktrees);
const mockedReadWorkspaceWorktreesDetailed = jest.mocked(
  readWorkspaceWorktreesDetailed,
);
const mockedResolveWorkspaceRepoDataHooks = jest.mocked(
  resolveWorkspaceRepoDataHooks,
);
const mockedResolveProjectHooks = jest.mocked(resolveProjectHooks);
const mockedResolveWorkspaceRootHooks = jest.mocked(resolveWorkspaceRootHooks);
const mockedResolveProjectScripts = jest.mocked(resolveProjectScripts);
const mockedResolveWorkspaceRootScripts = jest.mocked(
  resolveWorkspaceRootScripts,
);
const mockedReadWorkEntrySidebarSummary = jest.mocked(
  readWorkEntrySidebarSummary,
);
const mockedReadWorkEntriesFile = jest.mocked(readWorkEntriesFile);

const INDEX_PATH = '/tmp/workspaces/index.json';

function buildCoworkItem(
  overrides?: Partial<CoworkSidebarItem>,
): CoworkSidebarItem {
  return {
    id: 'cw-1',
    name: 'Research',
    type: 'cowork',
    color: '#aabbcc',
    collapsed: false,
    order: 0,
    externalPath: '/Users/me/Research',
    cowork: { description: 'notes' },
    ...overrides,
  };
}

function expectWrittenIndexContents(): string {
  const indexWriteCall = mockedWriteFile.mock.calls.find(
    (call) => call[0] === INDEX_PATH,
  );
  expect(indexWriteCall).toBeDefined();
  const writtenIndexContents = indexWriteCall?.[1];
  if (typeof writtenIndexContents !== 'string') {
    throw new Error('Expected project index write contents to be a string');
  }
  return writtenIndexContents;
}

describe('sidebar-items cowork support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockedReadWorkspaceConfig.mockReset();
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
    });
    mockedReadWorkEntrySidebarSummary.mockResolvedValue({
      count: 1,
      lastActivityAt: '2026-09-15T00:00:00.000Z',
    });
    mockedReadWorkEntriesFile.mockResolvedValue({ version: 1, entries: [] });
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
  });

  it('round-trips a cowork sidebar item through write + read', async () => {
    const cowork = buildCoworkItem();
    const configsById = new Map<string, WorkspaceConfigFile>();
    mockedWriteWorkspaceConfig.mockImplementation((id, config) => {
      configsById.set(id, config);
      return Promise.resolve();
    });

    await writeAllSidebarItems([cowork]);

    const writtenIndexContents = expectWrittenIndexContents();
    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH) {
        return Promise.resolve(writtenIndexContents);
      }
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      const config = configsById.get(id);
      if (!config) {
        return Promise.reject(new Error(`no config seeded for project ${id}`));
      }
      return Promise.resolve(config);
    });

    const result = await readAllSidebarItems();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.type).toBe('cowork');
    expect(result.items[0]).toMatchObject({
      id: 'cw-1',
      externalPath: '/Users/me/Research',
    });
  });

  it('hydrates the live work-entry count used by Always show visibility', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'cw-1',
            name: 'Research',
            type: 'cowork',
            color: '#aabbcc',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );
    const result = await readAllSidebarItems();

    expect(mockedReadWorkEntrySidebarSummary).toHaveBeenCalledWith('cw-1');
    expect(mockedReadWorkEntriesFile).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      id: 'cw-1',
      workEntryCount: 1,
      lastActivityAt: '2026-09-15T00:00:00.000Z',
    });
  });

  it('does not write worktrees.json for cowork items', async () => {
    const cowork = buildCoworkItem();

    await writeAllSidebarItems([cowork]);

    expect(mockedWriteWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      'cw-1',
      expect.objectContaining({ type: 'cowork' }),
      { ownership: 'preserve' },
    );
  });

  it('never writes Private memory from a sidebar row (CAN-3562)', async () => {
    // The row is a projection: a renderer (or a main read-modify-write) may
    // hold one from before the value was saved or reconciled. Only the
    // dedicated IPC and the organization materialization writer set it.
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
      privateMemory: true,
      privateMemoryManagedBy: 'organization',
    });

    await writeAllSidebarItems([buildCoworkItem({ privateMemory: false })]);

    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(mockedWriteWorkspaceConfig.mock.calls[0]?.[1]).toMatchObject({
      privateMemory: true,
      privateMemoryManagedBy: 'organization',
    });
  });

  it('isolates a transient multi-repo load failure to that project', async () => {
    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH) {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            workspaces: [
              {
                id: 'cw-1',
                name: 'Research',
                type: 'cowork',
                color: '#aabbcc',
                collapsed: false,
                order: 0,
              },
              {
                id: 'ws-failing',
                name: 'Failing Workspace',
                type: 'multi-repo',
                color: '#bbccdd',
                collapsed: false,
                order: 1,
              },
            ],
          }),
        );
      }
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });
    const failingConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
        },
      ],
    };
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      if (id === 'cw-1') {
        return Promise.resolve({
          version: 1,
          type: 'cowork',
          repos: [],
          externalPath: '/Users/me/Research',
          cowork: { description: 'notes' },
        });
      }
      if (id === 'ws-failing') {
        return Promise.resolve(failingConfig);
      }
      return Promise.reject(new Error(`Unexpected project ${id}`));
    });
    mockedResolveWorkspaceRepoDataHooks.mockRejectedValueOnce(
      new Error('Repo repo-a not found in project ws-failing'),
    );

    const result = await readAllSidebarItems();

    expect(result.items.map((item) => item.id)).toEqual(['cw-1']);
    expect(result.warnings).toEqual([
      {
        code: 'workspace-load-failed',
        workspaceId: 'ws-failing',
        workspaceName: 'Failing Workspace',
        reason: 'Repo repo-a not found in project ws-failing',
      },
    ]);
  });

  it('keeps failed project registry data while the id remains indexed', async () => {
    registerWorkspaceTypes(new Map([['cw-1', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['cw-1', '/Users/me/Research']]));
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'cw-1',
            name: 'Research',
            type: 'cowork',
            color: '#aabbcc',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );
    mockedReadWorkspaceConfig.mockRejectedValue(
      new Error('transient config read failure'),
    );

    await readAllSidebarItems();

    expect(getWorkspaceType('cw-1')).toBe('cowork');
    expect(getWorkspaceExternalPath('cw-1')).toBe('/Users/me/Research');

    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, workspaces: [] }),
    );
    await readAllSidebarItems();

    expect(getWorkspaceType('cw-1')).toBeNull();
    expect(getWorkspaceExternalPath('cw-1')).toBeNull();
  });

  it('does not rewrite preserved project snapshots during full saves', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'cw-1',
            name: 'Persisted Research',
            type: 'cowork',
            color: '#aabbcc',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );

    await writeAllSidebarItems([buildCoworkItem({ name: 'Stale Research' })], {
      preserveEmptyTemporary: false,
      preserveWorkspaceIds: ['cw-1'],
    });

    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockedWriteWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(
      mockedWriteFile.mock.calls.filter((call) => call[0] === INDEX_PATH),
    ).toEqual([]);
  });

  it('keeps preserved snapshots out of runtime reconciliation results', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({
            name: 'Persisted Research',
            externalPath: '/Users/me/Authoritative',
          }),
        ],
      }),
    );
    registerWorkspaceExternalPaths(
      new Map([['cw-1', '/Users/me/Authoritative']]),
    );

    const result = await writeAllSidebarItems(
      [
        buildCoworkItem({
          name: 'Stale Research',
          externalPath: '/Users/me/Stale',
        }),
      ],
      {
        preserveEmptyTemporary: false,
        preserveWorkspaceIds: ['cw-1'],
      },
    );

    expect(result.items).toEqual([]);
    expect(result.preservedWorkspaceIds).toEqual(['cw-1']);
    expect(getWorkspaceExternalPath('cw-1')).toBe('/Users/me/Authoritative');
  });

  it('retains a failed cold-start project omitted from the save payload', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({
            id: 'cw-failed',
            name: 'Persisted Failed Workspace',
            order: 0,
          }),
          buildCoworkItem({
            id: 'cw-loaded',
            name: 'Loaded Workspace',
            order: 1,
          }),
        ],
      }),
    );

    await writeAllSidebarItems(
      [
        buildCoworkItem({
          id: 'cw-loaded',
          name: 'Loaded Workspace Updated',
          order: 0,
        }),
      ],
      {
        preserveEmptyTemporary: false,
        preserveWorkspaceIds: ['cw-failed'],
      },
    );

    const written = expectWrittenIndexContents();
    expect(written).toContain('"id": "cw-failed"');
    expect(written).toContain('"name": "Persisted Failed Workspace"');
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalledWith(
      'cw-failed',
      expect.anything(),
    );
  });

  it('protects transiently failed projects during main-process read-modify-write saves', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({
            id: 'cw-failed',
            name: 'Persisted Failed Workspace',
            order: 0,
          }),
          buildCoworkItem({
            id: 'cw-loaded',
            name: 'Loaded Workspace',
            order: 1,
          }),
        ],
      }),
    );
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      if (id === 'cw-failed') {
        return Promise.reject(new Error('transient config read failure'));
      }
      return Promise.resolve({
        version: 1,
        type: 'cowork',
        repos: [],
      });
    });

    const partial = await readAllSidebarItems();
    expect(partial.items.map((item) => item.id)).toEqual(['cw-loaded']);

    await writeAllSidebarItems(
      [
        ...partial.items,
        buildCoworkItem({
          id: 'cw-new',
          name: 'New Workspace',
          order: 1,
        }),
      ],
      {
        preserveEmptyTemporary: false,
        preserveWorkspaceIds: partial.warnings?.map(
          (warning) => warning.workspaceId,
        ),
      },
    );

    const written = expectWrittenIndexContents();
    expect(written).toContain('"id": "cw-failed"');
    expect(written).toContain('"name": "Persisted Failed Workspace"');
    expect(written).toContain('"id": "cw-new"');
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalledWith(
      'cw-failed',
      expect.anything(),
    );
  });

  it('keeps per-read failed ids after a concurrent refresh recovers', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({
            id: 'cw-failed',
            name: 'Persisted Failed Workspace',
            order: 0,
          }),
          buildCoworkItem({
            id: 'cw-loaded',
            name: 'Loaded Workspace',
            order: 1,
          }),
        ],
      }),
    );
    let failedWorkspaceReadCount = 0;
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      if (id === 'cw-failed' && failedWorkspaceReadCount++ === 0) {
        return Promise.reject(new Error('transient config read failure'));
      }
      return Promise.resolve({
        version: 1,
        type: 'cowork',
        repos: [],
      });
    });

    const partial = await readAllSidebarItems();
    expect(partial.items.map((item) => item.id)).toEqual(['cw-loaded']);
    const preserveWorkspaceIds = partial.warnings?.map(
      (warning) => warning.workspaceId,
    );

    const recovered = await readAllSidebarItems();
    expect(recovered.warnings).toBeUndefined();

    await writeAllSidebarItems(
      [
        ...partial.items,
        buildCoworkItem({
          id: 'cw-new',
          name: 'New Workspace',
          order: 1,
        }),
      ],
      { preserveWorkspaceIds },
    );

    const written = expectWrittenIndexContents();
    expect(written).toContain('"id": "cw-failed"');
    expect(written).toContain('"name": "Persisted Failed Workspace"');
    expect(written).toContain('"id": "cw-new"');
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalledWith(
      'cw-failed',
      expect.anything(),
    );
  });

  it('allows an explicit deletion to remove a transiently failed project', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({
            id: 'cw-failed',
            name: 'Failed Workspace',
          }),
        ],
      }),
    );
    mockedReadWorkspaceConfig.mockRejectedValue(
      new Error('transient config read failure'),
    );
    await readAllSidebarItems();

    await writeAllSidebarItems([], {
      preserveEmptyTemporary: false,
      deletedWorkspaceIds: ['cw-failed'],
    });

    expect(expectWrittenIndexContents()).not.toContain('"id": "cw-failed"');
  });

  it('does not resurrect a deleted project from a stale protected snapshot', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, workspaces: [] }),
    );
    registerWorkspaceExternalPaths(
      new Map([['cw-deleted', '/Users/me/Stale']]),
    );

    const result = await writeAllSidebarItems(
      [buildCoworkItem({ id: 'cw-deleted', name: 'Stale Workspace' })],
      {
        preserveEmptyTemporary: false,
        preserveWorkspaceIds: ['cw-deleted'],
      },
    );

    expect(
      mockedWriteFile.mock.calls.filter((call) => call[0] === INDEX_PATH),
    ).toEqual([]);
    expect(result.items).toEqual([]);
    expect(getWorkspaceExternalPath('cw-deleted')).toBeNull();
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalledWith(
      'cw-deleted',
      expect.anything(),
    );
  });

  it('preserves the latest persisted project order during ordinary writes', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({ id: 'cw-b', name: 'B', order: 0 }),
          buildCoworkItem({ id: 'cw-a', name: 'A', order: 1 }),
        ],
      }),
    );

    await writeAllSidebarItems([
      buildCoworkItem({ id: 'cw-a', name: 'A updated', order: 0 }),
      buildCoworkItem({ id: 'cw-b', name: 'B', order: 1 }),
    ]);

    const written = expectWrittenIndexContents();
    expect(written).toMatch(/"id": "cw-b"[\s\S]*"id": "cw-a"/);
    expect(written).toContain('"name": "A updated"');
  });

  it('replaces project order only when explicitly requested', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        workspaces: [
          buildCoworkItem({ id: 'cw-b', name: 'B', order: 0 }),
          buildCoworkItem({ id: 'cw-a', name: 'A', order: 1 }),
        ],
      }),
    );

    await writeAllSidebarItems(
      [
        buildCoworkItem({ id: 'cw-a', name: 'A', order: 0 }),
        buildCoworkItem({ id: 'cw-b', name: 'B', order: 1 }),
      ],
      { replaceWorkspaceOrder: true },
    );

    const written = expectWrittenIndexContents();
    expect(written).toMatch(/"id": "cw-a"[\s\S]*"id": "cw-b"/);
  });

  it('keeps cowork entries when normalizing the index, dropping bogus types', async () => {
    const rawIndex = {
      version: 1,
      workspaces: [
        {
          id: 'single-1',
          name: 'Single Repo',
          type: 'single-repo',
          color: '#111111',
          collapsed: false,
          order: 0,
        },
        {
          id: 'cw-1',
          name: 'Research',
          type: 'cowork',
          color: '#aabbcc',
          collapsed: false,
          order: 1,
        },
        {
          id: 'bogus-1',
          name: 'Bogus',
          type: 'bogus-type',
          color: '#222222',
          collapsed: false,
          order: 2,
        },
      ],
    };

    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH) {
        return Promise.resolve(JSON.stringify(rawIndex));
      }
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      if (id === 'single-1') {
        return Promise.resolve({
          version: 1,
          type: 'single-repo',
          repoPath: '/repo/single-1',
          repos: [],
        });
      }
      if (id === 'cw-1') {
        return Promise.resolve({
          version: 1,
          type: 'cowork',
          repos: [],
          externalPath: '/Users/me/Research',
        });
      }
      return Promise.reject(
        new Error(`unexpected project config lookup for ${id}`),
      );
    });

    const result = await readAllSidebarItems();

    expect(result.items.map((item) => item.id).sort()).toEqual([
      'cw-1',
      'single-1',
    ]);
    expect(result.items.find((item) => item.id === 'cw-1')?.type).toBe(
      'cowork',
    );
  });

  it('carries the globals each workspace turned off to the renderer and back', async () => {
    const disabled = {
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'global-tool' }],
    };
    const configs = new Map<string, WorkspaceConfigFile>([
      [
        'single-1',
        {
          version: 1,
          type: 'single-repo',
          repoPath: '/repo/single-1',
          repos: [],
          disabledGlobalPluginSelections: disabled,
        },
      ],
      [
        'multi-1',
        {
          version: 1,
          type: 'multi-repo',
          repos: [],
          disabledGlobalPluginSelections: disabled,
        },
      ],
      [
        'cw-1',
        {
          version: 1,
          type: 'cowork',
          repos: [],
          disabledGlobalPluginSelections: disabled,
        },
      ],
    ]);
    mockedReadFile.mockImplementation((path) =>
      path === INDEX_PATH
        ? Promise.resolve(
            JSON.stringify({
              version: 1,
              workspaces: [
                ['single-1', 'single-repo'],
                ['multi-1', 'multi-repo'],
                ['cw-1', 'cowork'],
              ].map(([id, type], order) => ({
                id,
                name: id,
                type,
                color: '#111111',
                collapsed: false,
                order,
              })),
            }),
          )
        : Promise.reject(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          ),
    );
    mockedReadWorkspaceConfig.mockImplementation((id) => {
      const config = configs.get(id);
      return config
        ? Promise.resolve(config)
        : Promise.reject(new Error(`unexpected project config lookup ${id}`));
    });

    const { items } = await readAllSidebarItems();

    expect(
      Object.fromEntries(
        items.map((item) => [item.id, item.disabledGlobalPluginSelections]),
      ),
    ).toEqual({ 'single-1': disabled, 'multi-1': disabled, 'cw-1': disabled });

    await writeAllSidebarItems(items);

    for (const id of configs.keys())
      expect(
        mockedWriteWorkspaceConfig.mock.calls.find(
          ([writtenId]) => writtenId === id,
        )?.[1].disabledGlobalPluginSelections,
      ).toEqual(disabled);
  });

  it('rejects a cowork item with a relative externalPath', () => {
    const cowork = buildCoworkItem({ externalPath: 'relative/path' });

    expect(() => validateSidebarItems([cowork])).toThrow(
      'must be an absolute path',
    );
  });

  it('registers cowork ids in the project registry on read', async () => {
    const rawIndex = {
      version: 1,
      workspaces: [
        {
          id: 'cw-1',
          name: 'Research',
          type: 'cowork',
          color: '#aabbcc',
          collapsed: false,
          order: 0,
        },
      ],
    };
    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH) {
        return Promise.resolve(JSON.stringify(rawIndex));
      }
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });
    mockedReadWorkspaceConfig.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        type: 'cowork',
        repos: [],
        externalPath: '/Users/me/Research',
      }),
    );

    await readAllSidebarItems();

    expect(getWorkspaceType('cw-1')).toBe('cowork');
    expect(isCoworkWorkspace('cw-1')).toBe(true);
  });

  it('registers/clears the external path for a cowork project on read', async () => {
    const rawIndex = {
      version: 1,
      workspaces: [
        {
          id: 'cw-1',
          name: 'Research',
          type: 'cowork',
          color: '#aabbcc',
          collapsed: false,
          order: 0,
        },
      ],
    };
    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH) {
        return Promise.resolve(JSON.stringify(rawIndex));
      }
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });
    mockedReadWorkspaceConfig.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        type: 'cowork',
        repos: [],
        externalPath: '/Users/me/Research',
      }),
    );

    await readAllSidebarItems();
    expect(getWorkspaceExternalPath('cw-1')).toBe('/Users/me/Research');

    // A subsequent read of a managed (non-external) cowork workspace with the
    // same id must clear the stale external-path registration rather than
    // accumulate it.
    mockedReadWorkspaceConfig.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        type: 'cowork',
        repos: [],
      }),
    );
    await readAllSidebarItems();
    expect(getWorkspaceExternalPath('cw-1')).toBeNull();
  });

  it('does not reject until a sibling project write still in flight settles', async () => {
    const failure = new Error('config write failed');
    let releaseSlowWrite = (): void => undefined;
    let slowWriteFinished = false;
    mockedWriteWorkspaceConfig.mockImplementation((id) =>
      id === 'cw-fail'
        ? Promise.reject(failure)
        : new Promise<void>((resolve) => {
            releaseSlowWrite = (): void => {
              slowWriteFinished = true;
              resolve();
            };
          }),
    );
    let settled = false;
    const outcome = writeAllSidebarItems(
      [buildCoworkItem({ id: 'cw-fail' }), buildCoworkItem({ id: 'cw-slow' })],
      { preserveEmptyTemporary: false },
    ).finally(() => {
      settled = true;
    });

    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      'cw-slow',
      expect.anything(),
      expect.anything(),
    );
    expect(settled).toBe(false);

    releaseSlowWrite();
    await expect(outcome).rejects.toBe(failure);
    expect(slowWriteFinished).toBe(true);
  });
});

describe('readAllSidebarItemsSnapshot index authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockedReadWorkspaceConfig.mockReset();
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
    });
    mockedReadWorkEntrySidebarSummary.mockResolvedValue({
      count: 1,
      lastActivityAt: '2026-09-15T00:00:00.000Z',
    });
    mockedReadWorkEntriesFile.mockResolvedValue({ version: 1, entries: [] });
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
  });

  function indexReads(raw: string | null): void {
    mockedReadFile.mockImplementation((path) => {
      if (path === INDEX_PATH && raw !== null) return Promise.resolve(raw);
      return Promise.reject(
        Object.assign(new Error(raw === null ? 'ENOENT' : 'EACCES'), {
          code: raw === null ? 'ENOENT' : 'EACCES',
        }),
      );
    });
  }

  it('reports a missing index as absent and an unreadable one as unreadable', async () => {
    indexReads(null);
    await expect(readAllSidebarItemsSnapshot()).resolves.toMatchObject({
      file: { items: [] },
      authority: 'absent',
    });

    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await expect(readAllSidebarItemsSnapshot()).resolves.toMatchObject({
      file: { items: [] },
      authority: 'unreadable',
    });

    indexReads('{ not json');
    await expect(readAllSidebarItemsSnapshot()).resolves.toMatchObject({
      file: { items: [] },
      authority: 'unreadable',
    });

    indexReads(JSON.stringify({ version: 2, workspaces: [] }));
    await expect(readAllSidebarItemsSnapshot()).resolves.toMatchObject({
      file: { items: [] },
      authority: 'unreadable',
    });
  });

  it('keeps the recoverable entries of a partly malformed index but reports it as partial', async () => {
    const valid = {
      id: 'cw-1',
      name: 'Research',
      type: 'cowork',
      color: '#aabbcc',
      collapsed: false,
      order: 0,
    };
    indexReads(
      JSON.stringify({
        version: 1,
        workspaces: [valid, { name: 'no id', type: 'cowork' }],
      }),
    );
    const partial = await readAllSidebarItemsSnapshot();
    expect(partial.file.items.map((item) => item.id)).toEqual(['cw-1']);
    expect(partial.authority).toBe('partial');

    indexReads(JSON.stringify({ version: 1, workspaces: [valid] }));
    const ok = await readAllSidebarItemsSnapshot();
    expect(ok.file.items.map((item) => item.id)).toEqual(['cw-1']);
    expect(ok.authority).toBe('ok');
  });

  it('reports a project that could not be projected as partial', async () => {
    // A readable config that lacks an absolute repoPath: the workspace is
    // left out of the sidebar, but that omission proves nothing about its
    // worktrees.
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: 'relative/path',
      repos: [],
    });
    indexReads(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'ws-1',
            name: 'Repo',
            type: 'single-repo',
            color: '#aabbcc',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );
    const snapshot = await readAllSidebarItemsSnapshot();
    expect(snapshot.file.items).toEqual([]);
    expect(snapshot.file.warnings).toBeUndefined();
    expect(snapshot.authority).toBe('partial');
  });

  it('reports an unreadable worktree manifest even when the index is fine', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/Users/me/repo',
      repos: [],
    });
    indexReads(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'ws-1',
            name: 'Repo',
            type: 'single-repo',
            color: '#aabbcc',
            collapsed: false,
            order: 0,
          },
        ],
      }),
    );
    mockedWorktreesAuthority.value = 'unreadable';
    try {
      const snapshot = await readAllSidebarItemsSnapshot();
      // The workspace still renders (with no worktrees), but the snapshot
      // cannot prove that its worktrees are gone.
      expect(snapshot.file.items.map((item) => item.id)).toEqual(['ws-1']);
      expect(snapshot.authority).toBe('unreadable');
      // The aggregate folds it in; the workspace's own reads keep it apart.
      expect(snapshot.indexAuthority).toBe('ok');
      expect(snapshot.workspaceReads.get('ws-1')).toEqual({
        manifest: 'ok',
        worktrees: 'unreadable',
      });
    } finally {
      mockedWorktreesAuthority.value = 'ok';
    }
  });
});

describe('sidebar-items fan-outs settle every sibling before failing', () => {
  const failure = new Error('invalid conductor.json');

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockedResolveProjectScripts.mockReset();
    mockedResolveProjectScripts.mockResolvedValue({});
    mockedResolveProjectHooks.mockReset();
    mockedResolveProjectHooks.mockResolvedValue({});
    mockedResolveWorkspaceRootScripts.mockReset();
    mockedResolveWorkspaceRootScripts.mockResolvedValue({});
    mockedResolveWorkspaceRootHooks.mockReset();
    mockedResolveWorkspaceRootHooks.mockResolvedValue({});
    mockedResolveWorkspaceRepoDataHooks.mockReset();
    mockedResolveWorkspaceRepoDataHooks.mockResolvedValue({
      id: 'repo',
      name: 'Repo',
      repoPath: '/repos/repo',
    });
    mockedReadWorkspaceWorktreesDetailed.mockReset();
    mockedReadWorkspaceWorktreesDetailed.mockResolvedValue({
      worktrees: [],
      authority: 'ok',
    });
    mockedReadWorkspaceConfig.mockReset();
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
  });

  /** A sibling branch held in flight until the test releases it. */
  function holdSibling<T>(value: T): {
    promise: Promise<T>;
    release: () => void;
    finished: () => boolean;
  } {
    let finished = false;
    let release = (): void => undefined;
    const promise = new Promise<T>((resolve) => {
      release = (): void => {
        finished = true;
        resolve(value);
      };
    });
    return { promise, release: () => release(), finished: () => finished };
  }

  async function drainTurns(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function indexWith(type: 'single-repo' | 'multi-repo'): void {
    mockedReadFile.mockImplementation((path) =>
      path === INDEX_PATH
        ? Promise.resolve(
            JSON.stringify({
              version: 1,
              workspaces: [
                {
                  id: 'ws-1',
                  name: 'Repo',
                  type,
                  color: '#aabbcc',
                  collapsed: false,
                  order: 0,
                },
              ],
            }),
          )
        : Promise.reject(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          ),
    );
  }

  async function expectReadWaitsFor(sibling: {
    release: () => void;
    finished: () => boolean;
  }): Promise<void> {
    let settled = false;
    const outcome = readAllSidebarItems().finally(() => {
      settled = true;
    });

    await drainTurns();
    expect(settled).toBe(false);

    sibling.release();
    await expect(outcome).resolves.toMatchObject({
      items: [],
      warnings: [
        expect.objectContaining({
          workspaceId: 'ws-1',
          reason: 'invalid conductor.json',
        }),
      ],
    });
    expect(sibling.finished()).toBe(true);
  }

  it('waits for single-repo hook resolution when its scripts reject', async () => {
    indexWith('single-repo');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/Users/me/repo',
      repos: [],
    });
    const hooks = holdSibling({});
    mockedResolveProjectScripts.mockRejectedValueOnce(failure);
    mockedResolveProjectHooks.mockReturnValueOnce(hooks.promise);

    await expectReadWaitsFor(hooks);
    expect(mockedResolveProjectHooks).toHaveBeenCalled();
  });

  it('waits for multi-repo root hook resolution when root scripts reject', async () => {
    indexWith('multi-repo');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    const hooks = holdSibling({});
    mockedResolveWorkspaceRootScripts.mockRejectedValueOnce(failure);
    mockedResolveWorkspaceRootHooks.mockReturnValueOnce(hooks.promise);

    await expectReadWaitsFor(hooks);
    expect(mockedResolveWorkspaceRootHooks).toHaveBeenCalled();
  });

  it('waits for every repo hook resolution when another repo rejects', async () => {
    indexWith('multi-repo');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: ['repo-a', 'repo-b'].map((id) => ({
        id,
        name: id,
        repoPath: `/repos/${id}`,
      })),
    });
    const repoB = holdSibling({
      id: 'repo-b',
      name: 'Repo B',
      repoPath: '/repos/repo-b',
    });
    mockedResolveWorkspaceRepoDataHooks
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(repoB.promise);

    await expectReadWaitsFor(repoB);
    expect(mockedResolveWorkspaceRepoDataHooks).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ id: 'repo-b' }),
      expect.anything(),
    );
  });

  it('does not reject a save until a sibling worktree read settles', async () => {
    const pruneFailure = new Error('worktrees.json prune failed');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/Users/me/repo',
      repos: [],
    });
    const prunedRead = holdSibling({ worktrees: [], authority: 'ok' as const });
    mockedReadWorkspaceWorktreesDetailed
      .mockRejectedValueOnce(pruneFailure)
      .mockReturnValueOnce(prunedRead.promise);
    let settled = false;
    const outcome = writeAllSidebarItems(
      ['ws-fail', 'ws-slow'].map((id, order) => ({
        id,
        name: id,
        type: 'single-repo' as const,
        repoPath: `/Users/me/${id}`,
        color: '#aabbcc',
        worktrees: [],
        collapsed: false,
        order,
      })),
      { preserveEmptyTemporary: false },
    ).finally(() => {
      settled = true;
    });

    await drainTurns();
    expect(mockedReadWorkspaceWorktreesDetailed).toHaveBeenCalledWith(
      'ws-slow',
    );
    expect(settled).toBe(false);

    prunedRead.release();
    await expect(outcome).rejects.toBe(pruneFailure);
    expect(prunedRead.finished()).toBe(true);
  });
});
