import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  getHookSourceInfoThroughCore,
  listHookSourcesThroughCore,
} from '../hook-source-dispatch';
import { readCanopyJson } from '../../lib/canopy-json';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import { recordOrganizationHookBindings } from '../../lib/workspace-ownership';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';
import { BRAND } from '@canopy/brand/current';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));
jest.mock('../../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  getManifestRepoById: jest.fn(
    (manifest: { repos?: Array<{ id: string }> }, repoId: string) =>
      manifest.repos?.find((repo) => repo.id === repoId),
  ),
}));
// Plain mocks: spreading the real modules here handed the resolver a
// different mock instance than the one this test configures.
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../../lib/workspace-ownership', () => ({
  recordOrganizationHookBindings: jest.fn(),
}));
jest.mock('../../lib/paths', (): object => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getWorktreeDir: (projectId: string, worktreeId: string): string =>
    `/data/${projectId}/${worktreeId}`,
  getWorkspaceWorktreeRootRepoDir: (
    workspaceId: string,
    worktreeId: string,
  ): string => `/data/${workspaceId}/${worktreeId}/root`,
  getWorkspaceWorktreeRepoDir: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ): string => `/data/${workspaceId}/${worktreeId}/${repoId}`,
}));

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedRecordBindings = jest.mocked(recordOrganizationHookBindings);

const desktop: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.chat.read'],
};

const files: Record<string, CanopyJsonFile> = {
  '/data/ws-1/wt-1': {
    version: 1,
    hooks: {
      'pr:create': [{ type: 'command', command: 'repo-open' }],
      'pr:merged': [{ type: 'command', command: 'repo-merged' }],
    },
  },
  '/data/ws-2/wt-1/root': {
    version: 1,
    hooks: { 'pr:create': [{ type: 'command', command: 'root-open' }] },
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        url: 'https://github.com/acme/repo-a.git',
        hooks: { 'pr:create': null },
      },
    ],
  },
  '/data/ws-2/wt-1/repo-a': {
    version: 1,
    hooks: { 'pr:create': [{ type: 'command', command: 'repo-a-open' }] },
  },
};

const OWNER = {
  type: 'organization',
  organizationId: 'acme',
  projectId: 'project-a',
  instanceId: 'instance-a',
  bindingGeneration: 1,
} as const;

const configs: Record<string, WorkspaceConfigFile> = {
  'ws-1': {
    version: 1,
    type: 'single-repo',
    repoPath: '/repos/app',
    repos: [],
    hooks: { 'pr:create': [{ type: 'command', command: 'local-open' }] },
  },
  'ws-2': {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/repos/root',
    owner: OWNER,
    repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
  },
};

let runtime: DesktopCanopyDispatcher | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  mockedReadCanopyJson.mockImplementation((path) =>
    Promise.resolve(files[path] ?? null),
  );
  mockedReadWorkspaceConfig.mockImplementation((workspaceId) =>
    Promise.resolve(structuredClone(configs[workspaceId])),
  );
  mockedRecordBindings.mockImplementation((record) =>
    Promise.resolve({ hooks: record.localHooks, owner: record.owner }),
  );
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('core.initiatedWork.source on the desktop dispatcher', () => {
  it('requires core.initiatedWork.read and rejects unknown params before reading', async () => {
    runtime = createDesktopRuntime();
    await expect(
      runtime.query(
        'core.initiatedWork.source.get',
        {
          sourceKind: 'hook',
          target: { kind: 'project', workspaceId: 'ws-1' },
          triggerName: 'pr:create',
        },
        { caller: desktop },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    const withPath = {
      sourceKind: 'hook' as const,
      target: { kind: 'project' as const, workspaceId: 'ws-1', path: '/etc' },
    };
    await expect(
      runtime.query('core.initiatedWork.source.list', withPath, {
        caller: { ...desktop, grants: ['core.initiatedWork.read'] },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockedReadCanopyJson).not.toHaveBeenCalled();
  });

  it('projects source info for a project worktree with the legacy labels', async () => {
    runtime = createDesktopRuntime();
    await expect(
      getHookSourceInfoThroughCore(runtime, desktop, {
        target: 'project',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        triggerName: 'pr:create',
      }),
    ).resolves.toEqual({
      triggerName: 'pr:create',
      triggerDisplayName: 'PR Created',
      effectiveActions: [{ type: 'command', command: 'local-open' }],
      layers: [
        {
          sourceKey: 'local-override',
          sourceLabel: `${BRAND.displayName} Local Override`,
          actions: [{ type: 'command', command: 'local-open' }],
          status: 'active',
        },
        {
          sourceKey: 'repo-canopy',
          sourceLabel: 'canopy.json',
          actions: [{ type: 'command', command: 'repo-open' }],
          status: 'overridden',
        },
      ],
    });
    expect(mockedReadCanopyJson).toHaveBeenCalledWith('/data/ws-1/wt-1');
  });

  it('projects workspace root and repo layers from the worktree checkouts', async () => {
    runtime = createDesktopRuntime();
    const root = await getHookSourceInfoThroughCore(runtime, desktop, {
      target: 'workspace-root',
      workspaceId: 'ws-2',
      worktreeId: 'wt-1',
      triggerName: 'pr:create',
    });
    expect(root.layers).toEqual([
      {
        sourceKey: 'workspace-hook',
        sourceLabel: 'canopy.json (project)',
        actions: [{ type: 'command', command: 'root-open' }],
        status: 'active',
      },
    ]);
    const repo = await getHookSourceInfoThroughCore(runtime, desktop, {
      target: 'workspace-repo',
      workspaceId: 'ws-2',
      repoId: 'repo-a',
      worktreeId: 'wt-1',
      triggerName: 'pr:create',
    });
    expect(repo).toMatchObject({
      effectiveActions: null,
      layers: [
        {
          sourceKey: 'workspace-manifest',
          sourceLabel: 'canopy.json (project manifest)',
          actions: null,
          status: 'disabled',
        },
        {
          sourceKey: 'repo-canopy',
          sourceLabel: 'canopy.json',
          status: 'overridden',
        },
      ],
    });
    expect(mockedRecordBindings).not.toHaveBeenCalled();
  });

  it('lists resolved hooks and applies the ownership decision for an owned workspace', async () => {
    runtime = createDesktopRuntime();
    const resolved = await listHookSourcesThroughCore(runtime, desktop, {
      kind: 'workspace-repo',
      workspaceId: 'ws-2',
      repoId: 'repo-a',
      worktreeId: 'wt-1',
    });
    expect(resolved).toEqual({
      'pr:create': { source: 'workspace-manifest-disabled' },
    });
    expect(mockedRecordBindings).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      repoId: 'repo-a',
      source: 'hook_resolution',
      sourceHooks: { 'pr:create': null },
      localHooks: undefined,
      owner: OWNER,
    });
    const canonical = await runtime.query(
      'core.initiatedWork.source.list',
      {
        sourceKind: 'hook',
        target: { kind: 'project', workspaceId: 'ws-1', worktreeId: 'wt-1' },
      },
      { caller: { ...desktop, grants: ['core.initiatedWork.read'] } },
    );
    expect(canonical).toEqual({
      sources: [
        {
          sourceKind: 'hook',
          triggerName: 'pr:create',
          origin: 'local-override',
          actions: [{ type: 'command', command: 'local-open' }],
        },
        {
          sourceKind: 'hook',
          triggerName: 'pr:merged',
          origin: 'repo-canopy',
          actions: [{ type: 'command', command: 'repo-merged' }],
        },
      ],
    });
  });

  it.each([
    { kind: 'project' as const, workspaceId: '..', worktreeId: 'wt-1' },
    { kind: 'project' as const, workspaceId: 'ws-1', worktreeId: '../../x' },
    { kind: 'workspace-root' as const, workspaceId: 'ws-2', worktreeId: '..' },
    {
      kind: 'workspace-repo' as const,
      workspaceId: 'ws-2',
      repoId: '../../../etc',
      worktreeId: 'wt-1',
    },
  ])(
    'refuses a traversal-shaped target ID before any read: %o',
    async (target) => {
      runtime = createDesktopRuntime();
      const reader: CanopyCallerDescriptor = {
        ...desktop,
        grants: ['core.initiatedWork.read'],
      };
      const active = runtime;
      const calls = [
        (): Promise<unknown> =>
          active.query(
            'core.initiatedWork.source.list',
            { sourceKind: 'hook', target },
            { caller: reader },
          ),
        (): Promise<unknown> =>
          active.query(
            'core.initiatedWork.source.get',
            { sourceKind: 'hook', target, triggerName: 'pr:create' },
            { caller: reader },
          ),
      ];
      for (const call of calls)
        await expect(call()).rejects.toMatchObject({
          payload: {
            kind: 'invalid_argument',
            code: 'core.initiatedWork.source.invalidTarget',
          },
        });
      expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
      expect(mockedReadCanopyJson).not.toHaveBeenCalled();
    },
  );

  it('keeps legacy identifier and read errors for the compatibility projections', async () => {
    runtime = createDesktopRuntime();
    await expect(
      getHookSourceInfoThroughCore(runtime, desktop, {
        target: 'project',
        projectId: 'Bad Id',
        triggerName: 'pr:create',
      }),
    ).rejects.toThrow(
      new IdentifierValidationError(
        'Invalid projectId: must be lowercase alphanumeric with hyphens',
      ),
    );
    const io = new Error('EACCES: permission denied');
    mockedReadWorkspaceConfig.mockRejectedValueOnce(io);
    await expect(
      getHookSourceInfoThroughCore(runtime, desktop, {
        target: 'project',
        projectId: 'ws-1',
        triggerName: 'pr:create',
      }),
    ).rejects.toBe(io);
    mockedReadWorkspaceConfig.mockRejectedValueOnce(
      new IdentifierValidationError('Invalid workspaceId'),
    );
    await expect(
      runtime.query(
        'core.initiatedWork.source.get',
        {
          sourceKind: 'hook',
          target: { kind: 'project', workspaceId: 'ws-1' },
          triggerName: 'pr:create',
        },
        { caller: { ...desktop, grants: ['core.initiatedWork.read'] } },
      ),
    ).rejects.toBeInstanceOf(CanopyOperationError);
  });
});

describe('hook source reader callers', () => {
  const mainRoot = resolve(__dirname, '../..');
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === '__tests__' ? [] : sources(path);
      return name.endsWith('.ts') ? [path] : [];
    });
  }

  it('keeps IPC and Portal entry points on the core projection', () => {
    const direct = ['ipc', 'portal']
      .flatMap((dir) => sources(join(mainRoot, dir)))
      .filter((path) =>
        readFileSync(path, 'utf8').includes('lib/hook-resolver'),
      )
      .map((path) => path.slice(mainRoot.length + 1));
    expect(direct).toEqual([]);
  });
});
