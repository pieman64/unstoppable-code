jest.mock('../lib/project-owner', () => ({
  decideSameOwnerAccess: jest.fn(),
  resolveProjectSavedOwner: jest.fn(),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    accountEpoch: (): number => 1,
    getState: (): never => {
      throw new Error(
        'Project discovery must not read selected workspace context.',
      );
    },
  })),
}));
jest.mock('../lib/org-cowork-binding-deps', () => ({
  isOrgCoworkOperationEligible: jest.fn(() => Promise.resolve(true)),
  isOrgMemberCodeOperationEligible: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => {
  const runtime = {
    queryChatStateForLegacyIpc: jest.fn(),
    queryWorkspaceGetForLegacyIpc: jest.fn(),
    queryWorkspaceListForLegacyIpc: jest.fn(),
    queryWorktreeListForLegacyIpc: jest.fn(),
  };
  return { getActiveDesktopRuntime: jest.fn(() => runtime) };
});
jest.mock('../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
}));

import type {
  AppAdvisorActionResponse,
  ChatStateSnapshot,
  CoworkWorkEntriesFile,
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { COWORK_HOME_WORKTREE_ID } from '@canopy/desktop-shared/types';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
} from '@canopy/protocol/ui-labels';
import {
  decideSameOwnerAccess,
  resolveProjectSavedOwner,
} from '../lib/project-owner';
import {
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
} from '../lib/org-cowork-binding-deps';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import {
  getCallerOwner,
  listAuthorizedProjects,
  requireAuthorizedProject,
} from '../project-discovery/owner-policy';
import { dispatchProjectDiscoveryAction } from '../project-discovery/index';
import {
  filterProjectCandidates,
  hydrateProjectRow,
  type ProjectsListAction,
} from '../project-discovery/projects-list';
import {
  organizationChatsReadiness,
  type OrganizationReadinessDependencies,
  type OrganizationReadinessFacts,
} from '../project-discovery/readiness';
import * as readinessModule from '../project-discovery/readiness';
import {
  readProjectWorktrees,
  readProjectInventory,
  readTaskSnapshot,
} from '../project-discovery/sources';
import type { AuthorizedProject } from '../project-discovery/owner-policy';
import { parseProjectDiscoveryAction } from '@canopy/desktop-shared/lib/project-discovery';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

function binding(bindingGeneration: number): WorkspaceOwnerBinding {
  return {
    type: 'organization',
    organizationId: ORGANIZATION_ID,
    projectId: '22222222-2222-4222-8222-222222222222',
    instanceId: '33333333-3333-4333-8333-333333333333',
    bindingGeneration,
  };
}

const reliableReadyFacts: OrganizationReadinessFacts = {
  indexed: true,
  inventoryAuthority: 'ok',
  inventoryOwner: binding(4),
  configAuthority: 'ok',
  configOwner: binding(4),
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockContext.getWorkspaceContextService.mockReturnValue({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    accountEpoch: () => 1,
    getState: () => {
      throw new Error('Selected context must not be read');
    },
  });
});

const mockContext = jest.requireMock<{ getWorkspaceContextService: jest.Mock }>(
  '../lib/workspace-context-service',
);

type SnapshotReader = ReturnType<
  typeof getActiveDesktopRuntime
>['queryChatStateForLegacyIpc'];
interface OrganizationFixture {
  cowork: CoworkSidebarItem;
  code: SingleRepoSidebarItem;
  snapshotRead: jest.SpyInstance<
    ReturnType<SnapshotReader>,
    Parameters<SnapshotReader>
  >;
  initialize: jest.Mock<Promise<void>, []>;
  whenIdle: jest.Mock<Promise<void>, []>;
  queueRemoval(): void;
}

function organizationFixture(): OrganizationFixture {
  const cowork = { ...coworkItem('org-cowork'), owner: binding(4) };
  const code: SingleRepoSidebarItem = {
    id: 'org-code',
    type: 'single-repo',
    name: 'Org code',
    repoPath: '/not-read',
    color: 'blue',
    worktrees: [],
    collapsed: false,
    order: 0,
    owner: binding(4),
  };
  const runtime = getActiveDesktopRuntime();
  jest.spyOn(runtime, 'queryWorkspaceListForLegacyIpc').mockResolvedValue({
    canonicalResult: null,
    legacyResult: { version: 1, items: [cowork, code] },
    legacyAuthority: { authority: 'ok' },
  });
  jest
    .spyOn(runtime, 'queryWorkspaceGetForLegacyIpc')
    .mockImplementation(({ workspaceId }) =>
      Promise.resolve({
        canonicalResult: null,
        legacyResult: {
          version: 1,
          id: workspaceId,
          type: workspaceId === cowork.id ? 'cowork' : 'single-repo',
          name: workspaceId,
          repos: [],
          owner: binding(4),
        },
        legacyAuthority: { authority: 'ok' },
      }),
    );
  jest.mocked(resolveProjectSavedOwner).mockResolvedValue({
    kind: 'organization',
    organizationId: ORGANIZATION_ID,
  });
  jest.mocked(decideSameOwnerAccess).mockResolvedValue({ kind: 'allowed' });
  jest.mocked(isOrgCoworkOperationEligible).mockResolvedValue(true);
  jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(true);
  jest.mocked(readWorkEntriesFileStrict).mockResolvedValue({
    version: 1,
    entries: [{ id: 'task-a', createdAt: '2026-10-01', status: 'active' }],
  });
  jest.spyOn(runtime, 'queryWorktreeListForLegacyIpc').mockResolvedValue({
    canonicalResult: null,
    legacyResult: [
      { id: 'task-a', branchName: 'main', createdAt: '2026-10-01' },
    ],
    legacyAuthority: { authority: 'ok' },
  });
  const snapshotRead = jest.spyOn(runtime, 'queryChatStateForLegacyIpc');
  snapshotRead.mockImplementation(({ scope }) =>
    Promise.resolve({
      canonicalResult: null,
      legacyResult: {
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        schemaVersion: 1,
        revision: 1,
        tabsFile: {
          version: 1,
          tabs: [
            { id: 'chat-a', title: 'A', createdAt: '2026-10-01', messages: [] },
            { id: 'chat-b', title: 'B', createdAt: '2026-10-01', messages: [] },
          ],
          activeTabId: 'chat-a',
        },
        archives: [],
        runtimeByChatId: {},
        queue: [],
      },
    }),
  );
  let organizations = [{ id: ORGANIZATION_ID }];
  let epoch = 1;
  let queuedRemoval = false;
  const initialize = jest.fn(() => Promise.resolve());
  const whenIdle = jest.fn(() => {
    if (queuedRemoval) {
      organizations = [];
      epoch++;
      queuedRemoval = false;
    }
    return Promise.resolve();
  });
  mockContext.getWorkspaceContextService.mockReturnValue({
    initialize,
    whenIdle,
    accountEpoch: () => epoch,
    getState: () => ({
      organizations,
      get context(): never {
        throw new Error('Navigation must not authorize');
      },
    }),
  });
  return {
    cowork,
    code,
    snapshotRead,
    initialize,
    whenIdle,
    queueRemoval: (): void => {
      queuedRemoval = true;
    },
  };
}

async function discover(
  value: unknown,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  const parsed = parseProjectDiscoveryAction(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return dispatchProjectDiscoveryAction(parsed.action, {
    kind: 'app_advisor',
    chatId: 'advisor',
  });
}

describe('queued discovery account changes', () => {
  test.each(['projects.list_tasks', 'projects.list_task_chats'])(
    'queued membership removal hides organization data for %s exactly like unknown',
    async (type) => {
      const fixture = organizationFixture();
      fixture.queueRemoval();
      const denied = await discover({ type, projectId: fixture.code.id });
      expect(denied).toEqual(await discover({ type, projectId: 'unknown' }));
      expect(denied).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(fixture.snapshotRead).not.toHaveBeenCalled();
      expect(fixture.initialize).toHaveBeenCalled();
      expect(fixture.whenIdle).toHaveBeenCalled();
    },
  );
  test.each(['projects.list_tasks', 'projects.list_task_chats'])(
    'queued mid-request membership removal rejects the %s result',
    async (type) => {
      const fixture = organizationFixture();
      const read = fixture.snapshotRead.getMockImplementation();
      if (!read) throw new Error('Expected snapshot reader');
      fixture.snapshotRead.mockImplementation(async (...args) => {
        const result = await read(...args);
        fixture.queueRemoval();
        return result;
      });
      const result = await discover({ type, projectId: fixture.code.id });
      expect(result).toMatchObject({ ok: false });
      expect(result.result).toBeUndefined();
      expect(fixture.whenIdle).toHaveBeenCalled();
    },
  );
  test('queued mid-request membership removal rejects a chat continuation', async () => {
    const fixture = organizationFixture();
    const query = {
      type: 'projects.list_task_chats',
      projectId: fixture.code.id,
      pageSize: 1,
    };
    const first = await discover(query);
    if (
      !first.ok ||
      !first.result ||
      typeof first.result !== 'object' ||
      Array.isArray(first.result) ||
      typeof first.result.nextCursor !== 'string'
    )
      throw new Error('Expected cursor');
    const read = fixture.snapshotRead.getMockImplementation();
    if (!read) throw new Error('Expected snapshot reader');
    fixture.snapshotRead.mockImplementation(async (...args) => {
      const result = await read(...args);
      fixture.queueRemoval();
      return result;
    });
    expect(
      await discover({ ...query, cursor: first.result.nextCursor }),
    ).toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });
  });
});

function candidate(
  projectId: string,
  owner: AuthorizedProject['owner'],
): AuthorizedProject {
  const item: CoworkSidebarItem = {
    id: projectId,
    type: 'cowork',
    name: projectId,
    color: '#6B7280',
    collapsed: false,
    order: 0,
  };
  return {
    projectId,
    type: 'cowork',
    purpose: 'project',
    name: item.name,
    displayName: item.name,
    isDefault: false,
    item,
    owner,
    readiness: 'ready',
    synthetic: false,
    incarnation: projectId,
    inventoryAuthority: 'ok',
    inventoryOwnerMalformed: false,
  };
}

describe('project discovery organization Chats readiness', () => {
  test.each([true, false])(
    'non-default organization project eligibility is type-specific (Cowork eligible: %s)',
    async (coworkEligible) => {
      const fixture = organizationFixture();
      jest
        .mocked(isOrgCoworkOperationEligible)
        .mockResolvedValue(coworkEligible);
      jest
        .mocked(isOrgMemberCodeOperationEligible)
        .mockResolvedValue(!coworkEligible);
      const projects = await listAuthorizedProjects({
        kind: 'app_advisor',
        chatId: 'advisor',
      });
      expect(projects).toContainEqual(
        expect.objectContaining({
          projectId: fixture.cowork.id,
          readiness: coworkEligible ? 'ready' : 'unavailable',
        }),
      );
      expect(projects).toContainEqual(
        expect.objectContaining({
          projectId: fixture.code.id,
          readiness: coworkEligible ? 'unavailable' : 'ready',
        }),
      );
      const allowedId = coworkEligible ? fixture.cowork.id : fixture.code.id;
      const deniedId = coworkEligible ? fixture.code.id : fixture.cowork.id;
      for (const type of ['projects.list_tasks', 'projects.list_task_chats']) {
        expect(await discover({ type, projectId: allowedId })).toMatchObject({
          ok: true,
          result: {
            projectId: allowedId,
            returned: type === 'projects.list_tasks' ? 1 : 2,
          },
        });
        fixture.snapshotRead.mockClear();
        expect(await discover({ type, projectId: deniedId })).toMatchObject({
          ok: false,
          error: { code: 'execution_failed' },
        });
        expect(fixture.snapshotRead).not.toHaveBeenCalled();
      }
      expect(isOrgCoworkOperationEligible).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        { scope: 'membership' },
      );
      expect(isOrgMemberCodeOperationEligible).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        { scope: 'membership' },
      );
    },
  );
  test('uses membership eligibility for saved owner A while navigation context is irrelevant', async () => {
    const isEligible = jest.fn(() => Promise.resolve(true));
    const dependencies: OrganizationReadinessDependencies = {
      getOrganizations: () => Promise.resolve([{ id: ORGANIZATION_ID }]),
      isEligible,
      isMemberCodeEligible: () => Promise.resolve(true),
    };

    await expect(
      organizationChatsReadiness(
        ORGANIZATION_ID,
        reliableReadyFacts,
        dependencies,
      ),
    ).resolves.toBe('ready');
    expect(isEligible).toHaveBeenCalledWith(ORGANIZATION_ID, {
      scope: 'membership',
    });
  });

  test('requires an exact saved instance and generation binding match', async () => {
    const dependencies: OrganizationReadinessDependencies = {
      getOrganizations: () => Promise.resolve([{ id: ORGANIZATION_ID }]),
      isEligible: () => Promise.resolve(true),
      isMemberCodeEligible: () => Promise.resolve(true),
    };

    await expect(
      organizationChatsReadiness(
        ORGANIZATION_ID,
        { ...reliableReadyFacts, configOwner: binding(5) },
        dependencies,
      ),
    ).resolves.toBe('pending');
    await expect(
      organizationChatsReadiness(
        ORGANIZATION_ID,
        {
          ...reliableReadyFacts,
          configOwner: {
            ...binding(4),
            instanceId: '44444444-4444-4444-8444-444444444444',
          },
        },
        dependencies,
      ),
    ).resolves.toBe('pending');
  });

  test('marks lapsed or unavailable organization eligibility unavailable', async () => {
    const dependencies: OrganizationReadinessDependencies = {
      getOrganizations: () => Promise.resolve([{ id: ORGANIZATION_ID }]),
      isEligible: () => Promise.resolve(false),
      isMemberCodeEligible: () => Promise.resolve(false),
    };

    await expect(
      organizationChatsReadiness(
        ORGANIZATION_ID,
        reliableReadyFacts,
        dependencies,
      ),
    ).resolves.toBe('unavailable');
  });

  test('does not infer readiness from index presence or fall back when membership is absent', async () => {
    const eligible = jest.fn(() => Promise.resolve(true));
    const missingBinding: OrganizationReadinessFacts = {
      ...reliableReadyFacts,
      inventoryOwner: undefined,
      configOwner: undefined,
    };
    const dependencies: OrganizationReadinessDependencies = {
      getOrganizations: () =>
        Promise.resolve([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]),
      isEligible: eligible,
      isMemberCodeEligible: () => Promise.resolve(true),
    };

    await expect(
      organizationChatsReadiness(ORGANIZATION_ID, missingBinding, dependencies),
    ).resolves.toBe('unavailable');
    expect(eligible).not.toHaveBeenCalled();
  });

  test('keeps an authorized missing organization Chats identity pending without using Personal identity', async () => {
    const dependencies: OrganizationReadinessDependencies = {
      getOrganizations: () => Promise.resolve([{ id: ORGANIZATION_ID }]),
      isEligible: () => Promise.resolve(true),
      isMemberCodeEligible: () => Promise.resolve(true),
    };

    await expect(
      organizationChatsReadiness(
        ORGANIZATION_ID,
        {
          indexed: false,
          inventoryAuthority: 'absent',
        },
        dependencies,
      ),
    ).resolves.toBe('pending');
  });

  test('Advisor does not resynthesize indexed Personal Chats with unresolved ownership', async () => {
    const inventory = jest.spyOn(
      getActiveDesktopRuntime(),
      'queryWorkspaceListForLegacyIpc',
    );
    const resolveOwner = jest.mocked(resolveProjectSavedOwner);
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([]);
    inventory.mockResolvedValue({
      canonicalResult: null,
      legacyResult: {
        version: 1,
        items: [coworkItem(DEFAULT_COWORK_WORKSPACE_ID)],
      },
      legacyAuthority: { authority: 'ok' },
    });

    for (const savedOwner of [{ kind: 'unknown' }, { kind: 'none' }] as const) {
      resolveOwner.mockResolvedValue(savedOwner);
      await expect(
        listAuthorizedProjects({
          kind: 'app_advisor',
          chatId: 'advisor-chat',
        }),
      ).resolves.toEqual([]);
    }
  });

  test('a revoked-membership organization caller gets only its unavailable missing Chats descriptor', async () => {
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: { version: 1, items: [] },
        legacyAuthority: { authority: 'ok' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([]);
    jest.mocked(resolveProjectSavedOwner).mockResolvedValue({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });
    jest.mocked(decideSameOwnerAccess).mockResolvedValue({ kind: 'allowed' });
    const projects = await listAuthorizedProjects({
      kind: 'project_agent',
      projectId: 'org-code',
      worktreeId: 'task',
      chatId: 'chat',
    });
    expect(projects.map((project) => project.projectId)).toEqual([
      orgDefaultCoworkWorkspaceId(ORGANIZATION_ID),
    ]);
    if (!projects[0]) throw new Error('Expected unavailable Chats descriptor');
    const row = await hydrateProjectRow(projects[0]);
    expect(row).toMatchObject({
      owner: { kind: 'organization', organizationId: ORGANIZATION_ID },
      purpose: 'chats',
      readiness: 'unavailable',
      countsAvailable: false,
      taskCount: null,
      activeTaskCount: null,
      doneTaskCount: null,
    });
    expect(readWorkEntriesFileStrict).not.toHaveBeenCalled();
    const advisorProjects = await listAuthorizedProjects({
      kind: 'app_advisor',
      chatId: 'advisor',
    });
    expect(advisorProjects.map((project) => project.projectId)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
    ]);
  });
  test('an absent inventory is a successful empty list without synthetic Chats', async () => {
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: { version: 1, items: [] },
        legacyAuthority: { authority: 'absent' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }]);

    await expect(
      listAuthorizedProjects({ kind: 'app_advisor', chatId: 'advisor-chat' }),
    ).resolves.toEqual([]);
  });

  test('Advisor lists organization code as unavailable without member-code entitlement', async () => {
    const item: SingleRepoSidebarItem = {
      id: 'org-code-project',
      type: 'single-repo',
      name: 'Organization code project',
      repoPath: '/private/repo',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: { version: 1, items: [item] },
        legacyAuthority: { authority: 'ok' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }]);
    jest.mocked(resolveProjectSavedOwner).mockResolvedValue({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });
    jest.mocked(decideSameOwnerAccess).mockResolvedValue({ kind: 'allowed' });
    jest.mocked(isOrgCoworkOperationEligible).mockResolvedValue(true);
    jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(false);

    const projects = await listAuthorizedProjects({
      kind: 'app_advisor',
      chatId: 'advisor-chat',
    });

    expect(projects).toContainEqual(
      expect.objectContaining({
        projectId: item.id,
        readiness: 'unavailable',
      }),
    );
    expect(isOrgMemberCodeOperationEligible).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      { scope: 'membership' },
    );
  });

  test('inventory listing isolates saved owners and paged totals for Advisor and project agents', async () => {
    const personalCode: SingleRepoSidebarItem = {
      id: 'personal-code',
      type: 'single-repo',
      name: 'Personal code',
      repoPath: '/private/personal',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const organizationCode: SingleRepoSidebarItem = {
      id: 'organization-code',
      type: 'single-repo',
      name: 'Organization code',
      repoPath: '/private/org',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 1,
    };
    const organizationChatsId = orgDefaultCoworkWorkspaceId(ORGANIZATION_ID);
    const personalCowork = coworkItem('personal-cowork');
    const organizationChats = coworkItem(organizationChatsId);
    const owners = new Map<string, AuthorizedProject['owner']>([
      [personalCode.id, { kind: 'personal' }],
      [personalCowork.id, { kind: 'personal' }],
      [
        organizationCode.id,
        {
          kind: 'organization',
          organizationId: ORGANIZATION_ID,
        },
      ],
      [
        organizationChats.id,
        {
          kind: 'organization',
          organizationId: ORGANIZATION_ID,
        },
      ],
    ]);
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: {
          version: 1,
          items: [
            personalCode,
            personalCowork,
            organizationCode,
            organizationChats,
          ],
        },
        legacyAuthority: { authority: 'ok' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }]);
    jest
      .mocked(resolveProjectSavedOwner)
      .mockImplementation(({ projectId }) =>
        Promise.resolve(owners.get(projectId) ?? { kind: 'unknown' }),
      );
    jest.mocked(decideSameOwnerAccess).mockResolvedValue({ kind: 'allowed' });
    jest.mocked(isOrgCoworkOperationEligible).mockResolvedValue(true);
    jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(true);

    const advisor = { kind: 'app_advisor', chatId: 'advisor-chat' } as const;
    const personalAgent = {
      kind: 'project_agent',
      projectId: personalCode.id,
      worktreeId: 'personal-task',
      chatId: 'personal-chat',
    } as const;
    const organizationAgent = {
      kind: 'project_agent',
      projectId: organizationCode.id,
      worktreeId: 'organization-task',
      chatId: 'organization-chat',
    } as const;
    const pageAction: ProjectsListAction = {
      type: 'projects.list',
      pageSize: 1,
      includeDefault: true,
      sort: 'name',
      order: 'asc',
    };

    const advisorPage = await dispatchProjectDiscoveryAction(
      pageAction,
      advisor,
    );
    expect(advisorPage).toMatchObject({
      ok: true,
      result: { totalMatches: 5 },
    });
    if (
      !advisorPage.ok ||
      advisorPage.result === null ||
      typeof advisorPage.result !== 'object'
    ) {
      throw new Error('Advisor inventory page did not return a result.');
    }
    const nextCursor: unknown = Reflect.get(advisorPage.result, 'nextCursor');
    if (typeof nextCursor !== 'string') {
      throw new Error('Advisor inventory page did not return a cursor.');
    }
    await expect(
      dispatchProjectDiscoveryAction(
        { ...pageAction, cursor: nextCursor },
        personalAgent,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cursor_context_changed' },
    });

    await expect(
      dispatchProjectDiscoveryAction(
        { ...pageAction, pageSize: 20 },
        personalAgent,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { totalMatches: 3 },
    });
    await expect(
      dispatchProjectDiscoveryAction(
        { ...pageAction, pageSize: 20 },
        organizationAgent,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { totalMatches: 2 },
    });
    await expect(
      dispatchProjectDiscoveryAction(
        {
          ...pageAction,
          pageSize: 20,
          owner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        },
        advisor,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { totalMatches: 0, items: [] },
    });
  });

  test('unknown and ownerless project-agent callers fail closed; only Advisor has no owner', async () => {
    const resolveOwner = jest.mocked(resolveProjectSavedOwner);
    const decide = jest.mocked(decideSameOwnerAccess);
    resolveOwner.mockResolvedValue({ kind: 'none' });

    await expect(
      getCallerOwner({
        kind: 'project_agent',
        projectId: 'project-a',
        worktreeId: 'task-a',
        chatId: 'chat-a',
      }),
    ).rejects.toMatchObject({ code: 'owner_context_unavailable' });
    await expect(
      getCallerOwner({ kind: 'app_advisor', chatId: 'advisor-chat' }),
    ).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  test('caller owner comes from saved owner even when selected context would be another owner', async () => {
    const resolveOwner = jest.mocked(resolveProjectSavedOwner);
    resolveOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });

    await expect(
      getCallerOwner({
        kind: 'project_agent',
        projectId: 'project-a',
        worktreeId: 'task-a',
        chatId: 'chat-a',
      }),
    ).resolves.toEqual({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });
    expect(getWorkspaceContextService).not.toHaveBeenCalled();
  });

  test('omits indexed canonical organization Chats when saved ownership is unknown or cross-owner', async () => {
    const orgB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const chatAId = orgDefaultCoworkWorkspaceId(ORGANIZATION_ID);
    const chatBId = orgDefaultCoworkWorkspaceId(orgB);
    const inventory = jest.spyOn(
      getActiveDesktopRuntime(),
      'queryWorkspaceListForLegacyIpc',
    );
    const resolveOwner = jest.mocked(resolveProjectSavedOwner);
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }, { id: orgB }]);
    inventory.mockResolvedValue({
      canonicalResult: null,
      legacyResult: {
        version: 1,
        items: [coworkItem(chatAId), coworkItem(chatBId)],
      },
      legacyAuthority: { authority: 'ok' },
    });
    resolveOwner.mockImplementation(({ projectId }) =>
      Promise.resolve(
        projectId === chatAId
          ? { kind: 'unknown' }
          : { kind: 'organization', organizationId: ORGANIZATION_ID },
      ),
    );

    const projects = await listAuthorizedProjects({
      kind: 'app_advisor',
      chatId: 'advisor-chat',
    });
    expect(projects.map((project) => project.projectId)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
    ]);
  });

  test('a target whose saved owner becomes unknown is hidden like a nonexistent target', async () => {
    const inventory = jest.spyOn(
      getActiveDesktopRuntime(),
      'queryWorkspaceListForLegacyIpc',
    );
    const resolveOwner = jest.mocked(resolveProjectSavedOwner);
    const decide = jest.mocked(decideSameOwnerAccess);
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }]);
    inventory.mockResolvedValue({
      canonicalResult: null,
      legacyResult: { version: 1, items: [coworkItem('project-a')] },
      legacyAuthority: { authority: 'ok' },
    });
    resolveOwner
      .mockResolvedValueOnce({
        kind: 'organization',
        organizationId: ORGANIZATION_ID,
      })
      .mockResolvedValueOnce({ kind: 'unknown' });
    decide.mockResolvedValue({ kind: 'allowed' });

    await expect(
      requireAuthorizedProject('project-a', {
        kind: 'app_advisor',
        chatId: 'advisor-chat',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('owner filters narrow already authorized candidate rows', () => {
    const action: ProjectsListAction = {
      type: 'projects.list',
      pageSize: 50,
      includeDefault: true,
      sort: 'name',
      order: 'asc',
      owner: { kind: 'organization', organizationId: ORGANIZATION_ID },
    };
    const candidates = [
      candidate('personal-project', { kind: 'personal' }),
      candidate('org-project', {
        kind: 'organization',
        organizationId: ORGANIZATION_ID,
      }),
    ];

    expect(filterProjectCandidates(candidates, action)).toEqual([
      candidates[1],
    ]);
  });

  test('name is exact while query searches the id and description', () => {
    const orgProject = candidate('org-project', {
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });
    const exactNameAction: ProjectsListAction = {
      type: 'projects.list',
      pageSize: 50,
      includeDefault: true,
      sort: 'name',
      order: 'asc',
      name: 'org',
    };
    const queryAction: ProjectsListAction = {
      ...exactNameAction,
      name: undefined,
      query: 'org-project',
    };

    expect(filterProjectCandidates([orgProject], exactNameAction)).toEqual([]);
    expect(filterProjectCandidates([orgProject], queryAction)).toEqual([
      orgProject,
    ]);
  });

  test('source-controlled config availability follows the canonical item projection', async () => {
    const config = (
      type: WorkspaceConfigFile['type'],
    ): WorkspaceConfigFile => ({
      version: 1,
      type,
      repos: [],
    });
    const singleRepo: SingleRepoSidebarItem = {
      id: 'single',
      type: 'single-repo',
      name: 'Single',
      repoPath: '/private/repo',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const multiRepo = (
      sourceRepoPath: string | undefined,
      temporary = false,
    ): MultiRepoSidebarItem => ({
      id: `multi-${sourceRepoPath ?? 'none'}-${temporary}`,
      type: 'multi-repo',
      name: 'Multi',
      color: '#123456',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      ...(sourceRepoPath ? { sourceRepoPath } : {}),
      temporary,
    });
    const toCodeCandidate = (
      item: SingleRepoSidebarItem | MultiRepoSidebarItem,
      workspaceConfig: WorkspaceConfigFile,
    ): AuthorizedProject => ({
      ...candidate(item.id, { kind: 'personal' }),
      item,
      type: 'code',
      name: item.name,
      displayName: item.name,
      config: workspaceConfig,
      configAuthority: 'ok',
      readiness: 'pending',
    });

    await expect(
      hydrateProjectRow(toCodeCandidate(singleRepo, config('single-repo'))),
    ).resolves.toMatchObject({
      type: 'code',
      details: { sourceControlledConfigAvailable: true },
    });
    await expect(
      hydrateProjectRow(
        toCodeCandidate(
          multiRepo('/private/source-repo'),
          config('multi-repo'),
        ),
      ),
    ).resolves.toMatchObject({
      type: 'code',
      details: { sourceControlledConfigAvailable: true },
    });
    await expect(
      hydrateProjectRow(
        toCodeCandidate(multiRepo(undefined), config('multi-repo')),
      ),
    ).resolves.toMatchObject({
      type: 'code',
      details: { sourceControlledConfigAvailable: false },
    });
    await expect(
      hydrateProjectRow(
        toCodeCandidate(
          multiRepo('/private/source-repo', true),
          config('multi-repo'),
        ),
      ),
    ).resolves.toMatchObject({
      type: 'code',
      details: {
        temporary: true,
        sourceControlledConfigAvailable: false,
      },
    });
  });

  it('lists the effective repositories, not the raw config, and counts them like the sidebar', async () => {
    const item: MultiRepoSidebarItem = {
      id: 'multi-effective',
      type: 'multi-repo',
      name: 'Multi',
      color: '#123456',
      repos: [
        {
          id: '__workspace_root__',
          name: 'Workspace',
          repoPath: '/private/ws',
        },
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/private/a',
          manifestUrl: 'https://example.com/a.git',
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const rawConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/private/a' },
        {
          id: 'repo-suppressed',
          name: 'Suppressed',
          repoPath: '/private/suppressed',
        },
      ],
    };
    const row = await hydrateProjectRow({
      ...candidate(item.id, { kind: 'personal' }),
      item,
      type: 'code',
      name: item.name,
      displayName: item.name,
      config: rawConfig,
      configAuthority: 'ok',
      readiness: 'pending',
    });

    expect(row).toMatchObject({
      type: 'code',
      details: {
        repoCount: 1,
        repos: [
          { repoId: '__workspace_root__', name: 'Workspace' },
          {
            repoId: 'repo-a',
            name: 'Repo A',
            manifestUrl: 'https://example.com/a.git',
          },
        ],
      },
    });
    expect(JSON.stringify(row)).not.toContain('repo-suppressed');
    expect(JSON.stringify(row)).not.toContain('/private/');
  });
});

describe('project discovery index authority isolation', () => {
  const advisor = { kind: 'app_advisor', chatId: 'advisor-chat' } as const;
  const query: ProjectsListAction = {
    type: 'projects.list',
    pageSize: 50,
    includeDefault: false,
    sort: 'name',
    order: 'asc',
  };

  test.each(['unreadable', 'partial', 'absent'] as const)(
    'readable index isolates a broken registry despite aggregate %s',
    async (authority) => {
      const { cowork, code } = organizationFixture();
      jest
        .spyOn(readinessModule, 'getOrganizationMemberships')
        .mockResolvedValue([{ id: ORGANIZATION_ID }]);
      jest
        .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
        .mockResolvedValue({
          canonicalResult: null,
          legacyResult: { version: 1, items: [cowork, code] },
          legacyAuthority: { authority, indexAuthority: 'ok' },
        });
      jest
        .spyOn(getActiveDesktopRuntime(), 'queryWorktreeListForLegacyIpc')
        .mockResolvedValue({
          canonicalResult: null,
          legacyResult: [],
          legacyAuthority: { authority: 'unreadable' },
        });

      await expect(
        dispatchProjectDiscoveryAction(query, advisor),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          totalMatches: 2,
          items: [
            {
              projectId: code.id,
              countsAvailable: false,
              taskCount: null,
              activeTaskCount: null,
              doneTaskCount: null,
            },
            {
              projectId: cowork.id,
              readiness: 'ready',
              countsAvailable: true,
              taskCount: 1,
              activeTaskCount: 1,
              doneTaskCount: 0,
            },
          ],
        },
      });
      await expect(
        dispatchProjectDiscoveryAction(
          {
            type: 'projects.list_tasks',
            projectId: cowork.id,
            pageSize: 50,
            sort: 'last_activity',
            order: 'desc',
            retentionStates: ['retained'],
          },
          advisor,
        ),
      ).resolves.toMatchObject({ ok: true, result: { totalMatches: 1 } });
    },
  );

  test.each(['ok', 'partial', 'absent', 'unreadable'] as const)(
    'older adapters without indexAuthority fall back to aggregate %s',
    async (authority) => {
      const item = coworkItem('project-a');
      jest
        .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
        .mockResolvedValue({
          canonicalResult: null,
          legacyResult: { version: 1, items: [item] },
          legacyAuthority: { authority },
        });
      if (authority === 'unreadable') {
        await expect(readProjectInventory()).rejects.toMatchObject({
          code: 'execution_failed',
        });
      } else {
        await expect(readProjectInventory()).resolves.toMatchObject({
          authority,
          indexAuthority: authority,
          items: authority === 'absent' ? [] : [item],
        });
      }
    },
  );

  test('unreadable index fails even when aggregate authority is ok', async () => {
    organizationFixture();
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: { version: 1, items: [] },
        legacyAuthority: { authority: 'ok', indexAuthority: 'unreadable' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([]);
    await expect(
      dispatchProjectDiscoveryAction(query, advisor),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
  });

  test('absent index yields an empty page without synthetic Chats or projected rows', async () => {
    const { cowork } = organizationFixture();
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorkspaceListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: { version: 1, items: [cowork] },
        legacyAuthority: { authority: 'ok', indexAuthority: 'absent' },
      });
    jest
      .spyOn(readinessModule, 'getOrganizationMemberships')
      .mockResolvedValue([{ id: ORGANIZATION_ID }]);
    await expect(
      dispatchProjectDiscoveryAction(
        { ...query, includeDefault: true },
        advisor,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { items: [], totalMatches: 0 },
    });
  });
});

describe('project discovery dispatcher source boundaries', () => {
  function snapshot(
    projectId: string,
    worktreeId: string,
    recoveryError?: string,
  ): ChatStateSnapshot {
    return {
      schemaVersion: 1,
      projectId,
      worktreeId,
      revision: 0,
      tabsFile: { version: 1, tabs: [], activeTabId: '' },
      archives: [],
      runtimeByChatId: {},
      queue: [],
      ...(recoveryError ? { recoveryError } : {}),
    };
  }

  test('scoped worktree source rejects the unscoped SidebarItemsFile fallback', async () => {
    const query = jest.spyOn(
      getActiveDesktopRuntime(),
      'queryWorktreeListForLegacyIpc',
    );
    query.mockResolvedValue({
      canonicalResult: null,
      legacyResult: { version: 1, items: [coworkItem('project-a')] },
      legacyAuthority: { authority: 'ok' },
    });

    await expect(readProjectWorktrees('project-a')).rejects.toMatchObject({
      code: 'execution_failed',
    });
  });

  test('task snapshots reject recovery errors and mismatched project or task identities', async () => {
    const query = jest.spyOn(
      getActiveDesktopRuntime(),
      'queryChatStateForLegacyIpc',
    );
    const validSnapshot = snapshot('project-a', 'task-a');
    const canonicalResult = {
      workspaceId: 'project-a',
      worktreeId: 'task-a',
      revision: 0,
      tabs: { activeTabId: '', items: [] },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };
    query.mockResolvedValue({
      canonicalResult,
      legacyResult: snapshot(
        'project-a',
        'task-a',
        'recovered incomplete state',
      ),
    });

    await expect(readTaskSnapshot('project-a', 'task-a')).rejects.toMatchObject(
      {
        code: 'execution_failed',
      },
    );

    query.mockResolvedValue({
      canonicalResult,
      legacyResult: snapshot('project-b', 'task-a'),
    });
    await expect(readTaskSnapshot('project-a', 'task-a')).rejects.toMatchObject(
      {
        code: 'execution_failed',
      },
    );

    query.mockResolvedValue({
      canonicalResult,
      legacyResult: snapshot('project-a', 'task-b'),
    });
    await expect(readTaskSnapshot('project-a', 'task-a')).rejects.toMatchObject(
      {
        code: 'execution_failed',
      },
    );

    query.mockResolvedValue({ canonicalResult, legacyResult: validSnapshot });
    await expect(readTaskSnapshot('project-a', 'task-a')).resolves.toEqual(
      validSnapshot,
    );
  });

  test('project counts exclude hidden and internal tasks in both project kinds', async () => {
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repos: [],
    };
    const codeItem: SingleRepoSidebarItem = {
      id: 'code-project',
      type: 'single-repo',
      name: 'Code project',
      repoPath: '/private/repo',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
    };
    const codeCandidate: AuthorizedProject = {
      ...candidate(codeItem.id, { kind: 'personal' }),
      item: codeItem,
      type: 'code',
      name: codeItem.name,
      displayName: codeItem.name,
      readiness: 'ready',
      config,
      configAuthority: 'ok',
    };
    const worktrees: WorktreeData[] = [
      {
        id: 'hidden-task',
        branchName: 'hidden',
        createdAt: '2026-01-01T00:00:00.000Z',
        hidden: true,
      },
      {
        id: COWORK_HOME_WORKTREE_ID,
        branchName: 'internal',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'visible-task',
        branchName: 'visible',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'done',
      },
    ];
    jest
      .spyOn(getActiveDesktopRuntime(), 'queryWorktreeListForLegacyIpc')
      .mockResolvedValue({
        canonicalResult: null,
        legacyResult: worktrees,
        legacyAuthority: { authority: 'ok' },
      });

    const codeRow = await hydrateProjectRow(codeCandidate);
    expect(codeRow).toMatchObject({
      countsAvailable: true,
      taskCount: 1,
      activeTaskCount: 0,
      doneTaskCount: 1,
    });

    const coworkFile: CoworkWorkEntriesFile = {
      version: 1,
      entries: [
        {
          id: COWORK_HOME_WORKTREE_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'active-entry',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
        },
        {
          id: 'done-entry',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'done',
        },
      ],
    };
    jest.mocked(readWorkEntriesFileStrict).mockResolvedValue(coworkFile);
    const coworkCandidate: AuthorizedProject = {
      ...candidate('cowork-project', { kind: 'personal' }),
      readiness: 'ready',
      config: { ...config, type: 'cowork' },
      configAuthority: 'ok',
    };

    const coworkRow = await hydrateProjectRow(coworkCandidate);
    expect(coworkRow).toMatchObject({
      countsAvailable: true,
      taskCount: 2,
      activeTaskCount: 1,
      doneTaskCount: 1,
    });
  });
});

function coworkItem(projectId: string): CoworkSidebarItem {
  return {
    id: projectId,
    type: 'cowork',
    name: projectId,
    color: '#6B7280',
    collapsed: false,
    order: 0,
  };
}
