/**
 * CAN-3457: org memory follows the owner of the work. Two-org matrix for
 * `resolveOrgMemoryOrganization`, driven through the real background
 * owner/matching rules with only the persistence and link reads mocked.
 * CAN-3477: a Cowork workspace follows its saved owner too.
 */
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type WorkspaceType = 'single-repo' | 'multi-repo' | 'cowork';

interface DetailedRead {
  config: Record<string, unknown>;
  authority: 'ok' | 'absent' | 'unreadable';
  ownerMalformed: boolean;
  memoryMalformed?: boolean;
}

const readWorkspaceConfigDetailedMock = jest.fn<
  Promise<DetailedRead>,
  [string]
>(() => Promise.reject(new Error('unconfigured')));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (workspaceId: string): Promise<DetailedRead> =>
    readWorkspaceConfigDetailedMock(workspaceId),
}));

const linkedOrganizationIdsMock = jest.fn<string[], [string]>(() => []);
jest.mock('../services/workspace-target', () => ({
  resolveWorkspaceTarget: (
    projectId: string,
    options: { workspaceOwner: unknown },
  ): Promise<{ workspaceOwner: unknown; linkedOrganizationIds: string[] }> =>
    Promise.resolve({
      workspaceOwner: options.workspaceOwner,
      linkedOrganizationIds: linkedOrganizationIdsMock(projectId),
    }),
}));

type TargetRef = { projectId: string; worktreeId: string } | null;
const getPlanExploreTargetMock = jest.fn<Promise<TargetRef>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: (
    planId: string,
  ): Promise<{ projectId: string; worktreeId: string } | null> =>
    getPlanExploreTargetMock(planId),
}));

const getCodeReviewTargetMock = jest.fn<Promise<TargetRef>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (
    scopeKey: string,
  ): Promise<{ projectId: string; worktreeId: string } | null> =>
    getCodeReviewTargetMock(scopeKey),
}));

const liveContextMock = jest.fn(
  ():
    | { kind: 'personal' }
    | { kind: 'organization'; organizationId: string } => ({
    kind: 'personal',
  }),
);
// Resolves once queued context switches settle; a test can hold it open.
const whenIdleMock = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    initialize: () => Promise<void>;
    whenIdle: () => Promise<void>;
    getState: () => { context: unknown };
  } => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => whenIdleMock(),
    getState: (): { context: unknown } => ({ context: liveContextMock() }),
  }),
}));

const resolveCoworkWorkspaceIdMock = jest.fn((id: string): string => id);
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string =>
    resolveCoworkWorkspaceIdMock(id),
}));

import {
  resolveOrgMemoryOrganization,
  resolveOrgMemoryOwner,
} from '../memory/memory-owner';

function workspace(
  owner: string | undefined,
  type: WorkspaceType = 'single-repo',
): void {
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config: {
      version: 1,
      type,
      repos: [],
      ...(owner
        ? { owner: { type: 'organization', organizationId: owner } }
        : {}),
    },
    authority: 'ok',
    ownerMalformed: false,
  });
}

function resolve(
  overrides: {
    projectId?: string;
    worktreeId?: string;
    executionContext?: string;
    userInitiated?: boolean;
  } = {},
): Promise<string | null> {
  return resolveOrgMemoryOrganization({
    projectId: 'project-1',
    worktreeId: 'wt-1',
    userInitiated: true,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  linkedOrganizationIdsMock.mockReturnValue([]);
  liveContextMock.mockReturnValue({ kind: 'personal' });
  getPlanExploreTargetMock.mockResolvedValue(null);
  getCodeReviewTargetMock.mockResolvedValue(null);
  whenIdleMock.mockImplementation(() => Promise.resolve());
  resolveCoworkWorkspaceIdMock.mockImplementation((id) =>
    id === 'legacy-1' ? 'cowork-a' : id,
  );
});

describe('resolveOrgMemoryOwner', () => {
  it('reports a Cowork owner from the persisted workspace type', async () => {
    workspace(ORG_A, 'cowork');
    await expect(
      resolveOrgMemoryOwner({
        projectId: 'cowork-a',
        worktreeId: 'entry-1',
        userInitiated: true,
      }),
    ).resolves.toEqual({ organizationId: ORG_A, isCowork: true });
  });

  it('reports a code-workspace owner as not Cowork', async () => {
    workspace(ORG_B, 'multi-repo');
    await expect(
      resolveOrgMemoryOwner({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        userInitiated: true,
      }),
    ).resolves.toEqual({ organizationId: ORG_B, isCowork: false });
  });

  it('reports a linked Personal single repo as not Cowork', async () => {
    workspace(undefined, 'single-repo');
    linkedOrganizationIdsMock.mockReturnValue([ORG_A]);
    await expect(
      resolveOrgMemoryOwner({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        executionContext: `org:${ORG_A}`,
        userInitiated: true,
      }),
    ).resolves.toEqual({ organizationId: ORG_A, isCowork: false });
  });
});

describe('resolveOrgMemoryOrganization', () => {
  it('returns A for an A-owned project', async () => {
    workspace(ORG_A);
    await expect(resolve()).resolves.toBe(ORG_A);
  });

  it('returns B for a B-owned project', async () => {
    workspace(ORG_B, 'multi-repo');
    await expect(resolve()).resolves.toBe(ORG_B);
  });

  it('returns null for a Personal project', async () => {
    workspace(undefined, 'multi-repo');
    await expect(resolve()).resolves.toBeNull();
    // Not a linked candidate, so neither the live context nor the tab's
    // captured context is consulted.
    expect(liveContextMock).not.toHaveBeenCalled();
  });

  it('returns null for an A-owned project with Private memory on', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: {
        version: 1,
        type: 'multi-repo',
        repos: [],
        owner: { type: 'organization', organizationId: ORG_A },
        privateMemory: true,
      },
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
    });
    await expect(resolve()).resolves.toBeNull();
    // The setting comes from the same read as the owner.
    expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the Private memory setting is malformed', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: {
        version: 1,
        type: 'multi-repo',
        repos: [],
        owner: { type: 'organization', organizationId: ORG_A },
      },
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: true,
    });
    await expect(resolve()).resolves.toBeNull();
    expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledTimes(1);
  });

  describe('Personal single repo linked to A', () => {
    beforeEach(() => {
      workspace(undefined, 'single-repo');
      linkedOrganizationIdsMock.mockReturnValue([ORG_A]);
    });

    it('returns A when the tab captured context A', async () => {
      await expect(resolve({ executionContext: `org:${ORG_A}` })).resolves.toBe(
        ORG_A,
      );
      // The captured context wins over the live one.
      expect(liveContextMock).not.toHaveBeenCalled();
    });

    it('returns A when the live context is A and the tab captured none', async () => {
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      await expect(resolve()).resolves.toBe(ORG_A);
      expect(liveContextMock).toHaveBeenCalledTimes(1);
    });

    it('reads the workspace config once', async () => {
      await expect(resolve({ executionContext: `org:${ORG_A}` })).resolves.toBe(
        ORG_A,
      );
      expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledTimes(1);
    });

    it('waits for a queued context switch before reading the live context', async () => {
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      let settle: () => void = () => undefined;
      whenIdleMock.mockImplementation(
        () =>
          new Promise<void>((resolveIdle) => {
            settle = resolveIdle;
          }),
      );
      const pending = resolve();
      await new Promise((resolveTick) => setImmediate(resolveTick));
      // The switch to B lands before the queue settles.
      expect(liveContextMock).not.toHaveBeenCalled();
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_B,
      });
      settle();
      // Linked only to A, so the settled context B searches nothing.
      await expect(pending).resolves.toBeNull();
      expect(liveContextMock).toHaveBeenCalledTimes(1);
    });

    it('searches nothing for a background turn with no captured context', async () => {
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      await expect(resolve({ userInitiated: false })).resolves.toBeNull();
      expect(liveContextMock).not.toHaveBeenCalled();
    });

    it("uses a background turn's captured context", async () => {
      await expect(
        resolve({ userInitiated: false, executionContext: `org:${ORG_A}` }),
      ).resolves.toBe(ORG_A);
    });

    it('reads the persisted context lazily when the caller holds no tab', async () => {
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      const readPersisted = jest.fn(() => Promise.resolve('personal'));
      await expect(
        resolveOrgMemoryOrganization({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          readPersistedExecutionContext: readPersisted,
          userInitiated: true,
        }),
      ).resolves.toBeNull();
      expect(readPersisted).toHaveBeenCalledTimes(1);
      expect(liveContextMock).not.toHaveBeenCalled();
    });

    it('returns null when the context is Personal', async () => {
      await expect(
        resolve({ executionContext: 'personal' }),
      ).resolves.toBeNull();
    });

    it('returns null when the context is B', async () => {
      await expect(
        resolve({ executionContext: `org:${ORG_B}` }),
      ).resolves.toBeNull();
    });

    it('returns null for an unparseable captured context', async () => {
      await expect(
        resolve({ executionContext: 'org:not-a-uuid' }),
      ).resolves.toBeNull();
    });
  });

  it('returns null for App Advisor without reading any config', async () => {
    await expect(resolve({ projectId: 'app-advisor' })).resolves.toBeNull();
    expect(readWorkspaceConfigDetailedMock).not.toHaveBeenCalled();
  });

  describe('Cowork follows its saved owner (CAN-3477)', () => {
    it('returns A for an A-owned Cowork workspace', async () => {
      workspace(ORG_A, 'cowork');
      await expect(
        resolve({ projectId: 'cowork-default', worktreeId: 'entry-1' }),
      ).resolves.toBe(ORG_A);
      expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith(
        'cowork-default',
      );
    });

    it('returns B for a B-owned Cowork workspace', async () => {
      workspace(ORG_B, 'cowork');
      await expect(
        resolve({ projectId: 'cowork-b', worktreeId: 'entry-1' }),
      ).resolves.toBe(ORG_B);
    });

    it('returns null for a Personal Cowork workspace without consulting any context', async () => {
      workspace(undefined, 'cowork');
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      linkedOrganizationIdsMock.mockReturnValue([ORG_A]);
      const readPersisted = jest.fn(() => Promise.resolve(`org:${ORG_A}`));
      await expect(
        resolveOrgMemoryOrganization({
          projectId: 'cowork-personal',
          worktreeId: 'entry-1',
          executionContext: `org:${ORG_A}`,
          readPersistedExecutionContext: readPersisted,
          userInitiated: true,
        }),
      ).resolves.toBeNull();
      expect(liveContextMock).not.toHaveBeenCalled();
      expect(readPersisted).not.toHaveBeenCalled();
      expect(linkedOrganizationIdsMock).not.toHaveBeenCalled();
    });

    it('maps the legacy sentinel to its A-owned Cowork workspace', async () => {
      workspace(ORG_A, 'cowork');
      await expect(
        resolve({ projectId: 'standalone-chat', worktreeId: 'legacy-1' }),
      ).resolves.toBe(ORG_A);
      expect(resolveCoworkWorkspaceIdMock).toHaveBeenCalledWith('legacy-1');
      expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith('cowork-a');
      // Private memory is read from the mapped workspace, never the legacy id.
      expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledTimes(1);
    });

    it('returns null for the legacy sentinel mapped to a Personal Cowork workspace', async () => {
      workspace(undefined, 'cowork');
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      await expect(
        resolve({ projectId: 'standalone-chat', worktreeId: 'legacy-1' }),
      ).resolves.toBeNull();
      expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith('cowork-a');
      expect(liveContextMock).not.toHaveBeenCalled();
    });

    it.each(['absent', 'unreadable'] as const)(
      'returns null when the Cowork config is %s',
      async (authority) => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: {
            version: 1,
            type: 'cowork',
            owner: { type: 'organization', organizationId: ORG_A },
          },
          authority,
          ownerMalformed: false,
        });
        await expect(
          resolve({ projectId: 'cowork-default', worktreeId: 'entry-1' }),
        ).resolves.toBeNull();
      },
    );

    it('returns null when the Cowork owner is malformed', async () => {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { version: 1, type: 'cowork' },
        authority: 'ok',
        ownerMalformed: true,
      });
      liveContextMock.mockReturnValue({
        kind: 'organization',
        organizationId: ORG_A,
      });
      await expect(
        resolve({ projectId: 'cowork-default', worktreeId: 'entry-1' }),
      ).resolves.toBeNull();
      expect(liveContextMock).not.toHaveBeenCalled();
    });
  });

  it('maps a plan-explore sentinel to its A-owned target', async () => {
    getPlanExploreTargetMock.mockResolvedValue({
      projectId: 'project-a',
      worktreeId: 'wt-a',
    });
    workspace(ORG_A);
    await expect(
      resolve({ projectId: 'plan-explore-chat', worktreeId: 'plan-1' }),
    ).resolves.toBe(ORG_A);
    expect(getPlanExploreTargetMock).toHaveBeenCalledWith('plan-1');
    expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith('project-a');
  });

  it('maps a code-review sentinel to its B-owned target', async () => {
    getCodeReviewTargetMock.mockResolvedValue({
      projectId: 'project-b',
      worktreeId: 'wt-b',
    });
    workspace(ORG_B);
    await expect(
      resolve({ projectId: 'code-review-chat', worktreeId: 'wt-b' }),
    ).resolves.toBe(ORG_B);
    expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith('project-b');
  });

  it('returns null when a sentinel has no registry entry', async () => {
    await expect(
      resolve({ projectId: 'plan-explore-chat', worktreeId: 'plan-missing' }),
    ).resolves.toBeNull();
    expect(readWorkspaceConfigDetailedMock).not.toHaveBeenCalled();
  });

  it.each(['absent', 'unreadable'] as const)(
    'returns null when the config is %s',
    async (authority) => {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { version: 1, type: 'single-repo', repos: [] },
        authority,
        ownerMalformed: false,
      });
      await expect(resolve()).resolves.toBeNull();
    },
  );

  it('returns null when the owner is malformed', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: { version: 1, type: 'single-repo', repos: [] },
      authority: 'ok',
      ownerMalformed: true,
    });
    await expect(resolve()).resolves.toBeNull();
  });

  it('returns null when the config read throws', async () => {
    readWorkspaceConfigDetailedMock.mockRejectedValue(new Error('EIO'));
    await expect(resolve()).resolves.toBeNull();
  });
});
