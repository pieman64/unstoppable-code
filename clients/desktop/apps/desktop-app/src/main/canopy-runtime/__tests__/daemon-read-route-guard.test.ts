import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import {
  evaluateReadRoute,
  READ_ROUTE_SCOPE_SHAPES,
  READ_ROUTE_TABLE,
  resolveReadRoutePlatform,
  type ReadRouteInput,
  type ReadRouteLookups,
  type ReadRouteOperation,
  type ReadRoutePlatform,
} from '../daemon-read-route-guard';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

const SENDER = 7;
const PLATFORMS: readonly ReadRoutePlatform[] = ['darwin', 'win32', 'linux'];
const OPERATIONS: readonly ReadRouteOperation[] = [
  'files.roots',
  'files.directory',
  'files.file',
  'files.search',
  'files.link',
  'git.branch.list',
  'git.remote.get',
  'git.worktree.health.get',
  'git.executable.get',
  'git.status.get',
  'git.diff.get',
];

function windowCaller(
  overrides: Partial<CanopyCallerDescriptor> = {},
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `electron-web-contents:${SENDER}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
    ...overrides,
  };
}

interface Lookups extends ReadRouteLookups {
  readonly resolveWorktreeTargetIds: jest.Mock<
    { projectId: string; worktreeId: string } | null,
    [string, string]
  >;
  readonly workspaceType: jest.Mock<WorkspaceType | null, [string]>;
}

function lookups(types: Record<string, WorkspaceType> = {}): Lookups {
  const registered: Record<string, WorkspaceType> = {
    single: 'single-repo',
    multi: 'multi-repo',
    cowork: 'cowork',
    ...types,
  };
  return {
    resolveWorktreeTargetIds: jest.fn(
      (projectId: string, worktreeId: string) =>
        projectId === 'alias'
          ? { projectId: 'cowork', worktreeId: 'home' }
          : projectId === 'dangling'
            ? null
            : { projectId, worktreeId },
    ),
    workspaceType: jest.fn((id: string) => registered[id] ?? null),
    excludedWorkspaceIds: new Set(['app-advisor']),
    routedWorkspaceTypes: new Set<WorkspaceType>([
      'single-repo',
      'multi-repo',
      'cowork',
    ]),
  };
}

function evaluate(
  overrides: Partial<ReadRouteInput> = {},
): ReturnType<typeof evaluateReadRoute> {
  return evaluateReadRoute({
    operation: 'files.roots',
    platform: 'darwin',
    caller: windowCaller(),
    senderId: SENDER,
    scope: { workspaceId: 'single', worktreeId: 'task' },
    lookups: lookups(),
    ...overrides,
  });
}

describe('operation × platform table', () => {
  it('declares every cell as decided for N1', () => {
    const cells = Object.fromEntries(
      OPERATIONS.map((operation) => [
        operation,
        PLATFORMS.map((platform) => {
          const cell = READ_ROUTE_TABLE[operation][platform];
          return cell.kind === 'eligible' ? 'E' : cell.until;
        }),
      ]),
    );
    // [darwin, win32, linux]
    expect(cells).toEqual({
      'files.roots': ['E', 'E', 'E'],
      'files.directory': ['E', 'E', 'E'],
      'files.file': ['E', 'CAN-4732', 'CAN-4966'],
      'files.search': ['E', 'CAN-4732', 'CAN-4966'],
      'files.link': ['E', 'CAN-4732', 'CAN-4966'],
      'git.branch.list': ['E', 'CAN-4732', 'CAN-4966'],
      'git.remote.get': ['CAN-4729', 'CAN-4729', 'CAN-4729'],
      'git.worktree.health.get': ['CAN-4729', 'CAN-4729', 'CAN-4729'],
      'git.executable.get': ['CAN-4729', 'CAN-4729', 'CAN-4729'],
      'git.status.get': ['CAN-4103', 'CAN-4732', 'CAN-4966'],
      'git.diff.get': ['CAN-4103', 'CAN-4732', 'CAN-4966'],
    });
    expect(Object.keys(READ_ROUTE_TABLE).sort()).toEqual(
      [...OPERATIONS].sort(),
    );
  });

  it('names the ticket and reason for every blocked cell', () => {
    for (const operation of OPERATIONS)
      for (const platform of PLATFORMS) {
        const cell = READ_ROUTE_TABLE[operation][platform];
        if (cell.kind === 'eligible') continue;
        expect(cell.until).toMatch(/^CAN-\d+$/);
        expect(cell.reason.length).toBeGreaterThan(0);
      }
  });

  it.each(
    OPERATIONS.flatMap((operation) =>
      PLATFORMS.filter(
        (platform) => READ_ROUTE_TABLE[operation][platform].kind === 'blocked',
      ).map((platform) => [operation, platform] as const),
    ),
  )(
    'keeps blocked %s on %s in-process, before any lookup',
    (operation, platform) => {
      const local = lookups();
      const scope: CanopyWorkspaceScope =
        READ_ROUTE_SCOPE_SHAPES[operation] === 'worktree'
          ? { workspaceId: 'single', worktreeId: 'task' }
          : { workspaceId: 'single', worktreeId: 'task', repoId: 'single' };
      expect(
        evaluate({ operation, platform, scope, lookups: local }),
      ).toBeNull();
      expect(local.resolveWorktreeTargetIds).not.toHaveBeenCalled();
      expect(local.workspaceType).not.toHaveBeenCalled();
    },
  );

  it.each(OPERATIONS)(
    'keeps %s in-process on an unknown platform',
    (operation) => {
      expect(evaluate({ operation, platform: null })).toBeNull();
    },
  );

  it.each(PLATFORMS)('routes Files roots and directory on %s', (platform) => {
    for (const operation of ['files.roots', 'files.directory'] as const)
      expect(evaluate({ operation, platform })).toEqual({
        shape: 'worktree',
        workspaceId: 'single',
        worktreeId: 'task',
      });
  });
});

describe('platform resolution', () => {
  it('reads the host platform, and maps an unsupported host to null', () => {
    expect(resolveReadRoutePlatform(() => 'win32')).toBe('win32');
    expect(
      resolveReadRoutePlatform(() => {
        throw new Error('No platform services for host platform "aix".');
      }),
    ).toBeNull();
    expect(PLATFORMS).toContain(resolveReadRoutePlatform());
  });
});

describe('caller eligibility', () => {
  it('routes the trusted window caller for this exact sender', () => {
    expect(evaluate()).toEqual({
      shape: 'worktree',
      workspaceId: 'single',
      worktreeId: 'task',
    });
  });

  it.each([
    [
      'another sender',
      windowCaller({ clientInstanceId: 'electron-web-contents:8' }),
    ],
    [
      'the remote bridge',
      windowCaller({ clientInstanceId: `remote-bridge:${SENDER}` }),
    ],
    [
      'a renderer relay',
      windowCaller({ clientInstanceId: 'renderer-relay:x' }),
    ],
    ['main itself', windowCaller({ clientInstanceId: 'desktop-core' })],
    [
      'a Portal session',
      windowCaller({
        interfaceKind: 'portal',
        clientInstanceId: `portal-session:${SENDER}`,
      }),
    ],
    ['a CLI caller', windowCaller({ interfaceKind: 'cli' })],
    ['another authority', windowCaller({ authorityId: 'other' })],
  ])('keeps %s in-process', (_label, caller) => {
    const local = lookups();
    expect(evaluate({ caller, lookups: local })).toBeNull();
    expect(local.workspaceType).not.toHaveBeenCalled();
  });
});

describe('scope shapes', () => {
  it.each<[string, CanopyWorkspaceScope]>([
    ['no workspace', { worktreeId: 'task' }],
    ['no worktree', { workspaceId: 'single' }],
    ['a repo id', { workspaceId: 'single', worktreeId: 'task', repoId: 'r' }],
    [
      'an authority',
      { workspaceId: 'single', worktreeId: 'task', authorityId: 'x' },
    ],
    ['a target', { workspaceId: 'single', worktreeId: 'task', targetId: 'x' }],
    [
      'an organization',
      { workspaceId: 'single', worktreeId: 'task', organizationId: 'x' },
    ],
    ['a chat', { workspaceId: 'single', worktreeId: 'task', chatId: 'x' }],
  ])('keeps a Files scope with %s in-process', (_label, scope) => {
    expect(evaluate({ scope })).toBeNull();
    expect(evaluate({ operation: 'files.file', scope })).toBeNull();
  });

  it('ignores a selector present only as undefined, as before', () => {
    expect(
      evaluate({
        scope: { workspaceId: 'single', worktreeId: 'task', repoId: undefined },
      }),
    ).toEqual({ shape: 'worktree', workspaceId: 'single', worktreeId: 'task' });
  });

  it('accepts a repository scope with a repo id and an optional worktree', () => {
    expect(
      evaluate({
        operation: 'git.branch.list',
        scope: { workspaceId: 'multi', worktreeId: 'task', repoId: 'api' },
      }),
    ).toEqual({
      shape: 'repository',
      workspaceId: 'multi',
      worktreeId: 'task',
      repoId: 'api',
    });
    const local = lookups();
    expect(
      evaluate({
        operation: 'git.branch.list',
        scope: { workspaceId: 'multi', repoId: 'api' },
        lookups: local,
      }),
    ).toEqual({ shape: 'repository', workspaceId: 'multi', repoId: 'api' });
    expect(local.resolveWorktreeTargetIds).not.toHaveBeenCalled();
    expect(local.workspaceType).toHaveBeenCalledWith('multi');
  });

  it('keeps a repository scope with a foreign selector in-process', () => {
    for (const scope of [
      { workspaceId: 'multi', repoId: 'api', authorityId: 'x' },
      { workspaceId: 'multi', targetId: 'x' },
      { repoId: 'api' },
    ])
      expect(evaluate({ operation: 'git.branch.list', scope })).toBeNull();
  });
});

describe('workspace eligibility', () => {
  it('maps a trusted alias to its target', () => {
    const local = lookups();
    expect(
      evaluate({
        scope: { workspaceId: 'alias', worktreeId: 'single' },
        lookups: local,
      }),
    ).toEqual({ shape: 'worktree', workspaceId: 'cowork', worktreeId: 'home' });
    expect(local.workspaceType).toHaveBeenCalledWith('cowork');
  });

  it('keeps an excluded workspace in-process before alias resolution', () => {
    const local = lookups({ 'app-advisor': 'single-repo' });
    expect(
      evaluate({
        scope: { workspaceId: 'app-advisor', worktreeId: 'task' },
        lookups: local,
      }),
    ).toBeNull();
    expect(local.resolveWorktreeTargetIds).not.toHaveBeenCalled();
  });

  it.each<[string, CanopyWorkspaceScope]>([
    ['an unresolvable alias', { workspaceId: 'dangling', worktreeId: 'x' }],
    ['an unregistered id', { workspaceId: 'never-seen', worktreeId: 'x' }],
  ])('keeps %s in-process', (_label, scope) => {
    expect(evaluate({ scope })).toBeNull();
  });

  it('keeps a workspace type the route does not serve in-process', () => {
    expect(
      evaluate({
        scope: { workspaceId: 'cowork', worktreeId: 'home' },
        lookups: {
          ...lookups(),
          routedWorkspaceTypes: new Set<WorkspaceType>(['single-repo']),
        },
      }),
    ).toBeNull();
  });
});
