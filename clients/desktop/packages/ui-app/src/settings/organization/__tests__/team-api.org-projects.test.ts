import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  createOrganizationProjects,
  getOrganizationProject,
  listOrganizationProjects,
  listOrganizationRepositories,
  refreshOrganizationProjectsFromGitHub,
  replaceOrganizationProjectGrants,
  setOrganizationRepositoryHidden,
} from '../team-api';
import { respondWith } from './helpers/settings-responses';

const ORG_ID = 'org-1';
const PROJECT_ID = 'project-1';
const CREATE_REQUEST = {
  repositories: [{ providerRepoId: '1', owner: 'acme', name: 'payments' }],
  grants: [],
};

function detail(): Record<string, unknown> {
  return {
    id: 'project-1',
    organizationId: 'org-1',
    name: 'Payments',
    description: null,
    kind: 'CODE',
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'payments',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: true, manageCloud: true, use: true },
    instance: { id: 'instance-1', state: 'READY' },
    grants: [
      {
        principal: { type: 'user', userId: 'user-1' },
        defaultListed: true,
      },
    ],
    createdBy: { id: 'user-1', name: 'Owner' },
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  };
}

function projectClient(
  body: unknown,
): ReturnType<typeof createFakeSettingsClient> {
  return createFakeSettingsClient({
    'organization.projects.get': respondWith('organization.projects.get', body),
  });
}

function createClient(
  body: unknown,
): ReturnType<typeof createFakeSettingsClient> {
  return createFakeSettingsClient({
    'organization.projects.create': respondWith(
      'organization.projects.create',
      body,
    ),
  });
}

describe('organization project response guards', (): void => {
  it('accepts the everyone grant and rejects an unknown principal', async (): Promise<void> => {
    const project = detail();
    project.grants = [
      { principal: { type: 'organization' }, defaultListed: false },
    ];
    const client = projectClient(project);
    await expect(
      getOrganizationProject(client, ORG_ID, PROJECT_ID),
    ).resolves.toMatchObject({
      grants: [{ principal: { type: 'organization' }, defaultListed: false }],
    });
    expect(client.calls).toEqual([
      {
        operation: 'organization.projects.get',
        input: { organizationId: ORG_ID, projectId: PROJECT_ID },
      },
    ]);

    project.grants = [
      { principal: { type: 'group', id: 'g1' }, defaultListed: false },
    ];
    await expect(
      getOrganizationProject(projectClient(project), ORG_ID, PROJECT_ID),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });

  it('rejects a project missing capabilities.manageCloud', async (): Promise<void> => {
    const project = detail();
    project.capabilities = { administer: true, use: true };
    await expect(
      getOrganizationProject(projectClient(project), ORG_ID, PROJECT_ID),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });

  it('rejects an unknown create outcome', async (): Promise<void> => {
    await expect(
      createOrganizationProjects(
        createClient({
          results: [
            { providerRepoId: '1', outcome: 'surprise', project: detail() },
          ],
        }),
        ORG_ID,
        CREATE_REQUEST,
      ),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });

  it('rejects a repository missing required fields', async (): Promise<void> => {
    const project = detail();
    project.repository = { provider: 'github', owner: 'acme' };
    await expect(
      getOrganizationProject(projectClient(project), ORG_ID, PROJECT_ID),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });

  it.each([
    { providerRepoId: '1', outcome: 'created', error: 'bad' },
    { providerRepoId: '1', outcome: 'created', project: detail(), error: 'x' },
    { providerRepoId: '1', outcome: 'exists' },
    { providerRepoId: '1', outcome: 'error', project: detail() },
    { providerRepoId: '1', outcome: 'error', error: 'x', project: detail() },
  ])(
    'rejects outcome-dependent fields for $outcome',
    async (result): Promise<void> => {
      await expect(
        createOrganizationProjects(
          createClient({ results: [result] }),
          ORG_ID,
          CREATE_REQUEST,
        ),
      ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
    },
  );

  it('sends the create request as the operation input', async (): Promise<void> => {
    const client = createClient({
      results: [{ providerRepoId: '1', outcome: 'created', project: detail() }],
    });
    await expect(
      createOrganizationProjects(client, ORG_ID, {
        privateMemory: true,
        repositories: [
          {
            providerRepoId: '1',
            owner: 'acme',
            name: 'payments',
            defaultBranch: null,
          },
        ],
        grants: [{ principal: { type: 'organization' }, defaultListed: false }],
      }),
    ).resolves.toMatchObject({ results: [{ outcome: 'created' }] });
    expect(client.calls).toEqual([
      {
        operation: 'organization.projects.create',
        input: {
          organizationId: ORG_ID,
          privateMemory: true,
          repositories: [
            {
              providerRepoId: '1',
              owner: 'acme',
              name: 'payments',
              defaultBranch: null,
            },
          ],
          grants: [
            { principal: { type: 'organization' }, defaultListed: false },
          ],
        },
      },
    ]);
  });

  it('lists the management and member views through their operations', async (): Promise<void> => {
    const page = { data: [], revision: 'r1', nextCursor: null };
    const client = createFakeSettingsClient({
      'organization.projects.list': respondWith(
        'organization.projects.list',
        page,
      ),
      'organization.projects.memberList': respondWith(
        'organization.projects.memberList',
        page,
      ),
    });
    await listOrganizationProjects(client, ORG_ID, 'management', {
      cursor: 'c1',
      limit: 50,
    });
    await listOrganizationProjects(client, ORG_ID, 'member');
    expect(client.calls).toEqual([
      {
        operation: 'organization.projects.list',
        input: { organizationId: ORG_ID, limit: 50, cursor: 'c1' },
      },
      {
        operation: 'organization.projects.memberList',
        input: { organizationId: ORG_ID },
      },
    ]);
  });

  it('sends only the contract fields of each replaced grant', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.projects.grants.replace': respondWith(
        'organization.projects.grants.replace',
        detail(),
      ),
    });
    const extra = {
      principal: { type: 'user' as const, userId: 'user-2', label: 'Grace' },
      defaultListed: true,
      displayName: 'Grace',
    };
    await replaceOrganizationProjectGrants(client, ORG_ID, PROJECT_ID, {
      authorizationVersion: 3,
      grants: [extra],
    });
    expect(client.calls[0]).toEqual({
      operation: 'organization.projects.grants.replace',
      input: {
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        authorizationVersion: 3,
        grants: [
          {
            principal: { type: 'user', userId: 'user-2' },
            defaultListed: true,
          },
        ],
      },
    });
  });
});

describe('organization repository admin requests (CAN-3414)', (): void => {
  function repository(): Record<string, unknown> {
    return {
      id: 1,
      fullName: 'acme/payments',
      owner: 'acme',
      name: 'payments',
      defaultBranch: 'main',
      private: true,
      archived: false,
      htmlUrl: 'https://github.com/acme/payments',
      hidden: true,
      project: { id: 'p1', name: 'Payments', state: 'ARCHIVED', seeded: true },
    };
  }

  function listClient(
    body: unknown,
  ): ReturnType<typeof createFakeSettingsClient> {
    return createFakeSettingsClient({
      'organization.repositories.list': respondWith(
        'organization.repositories.list',
        body,
      ),
    });
  }

  it('lists repositories with the cursor and validates the hidden state', async (): Promise<void> => {
    const client = listClient({
      repositories: [repository()],
      repositorySelection: 'all',
      nextCursor: null,
    });
    await expect(
      listOrganizationRepositories(client, ORG_ID, { cursor: '2' }),
    ).resolves.toMatchObject({ repositories: [{ id: 1, hidden: true }] });
    expect(client.calls).toEqual([
      {
        operation: 'organization.repositories.list',
        input: { organizationId: ORG_ID, cursor: '2' },
      },
    ]);

    const fresh = listClient({
      repositories: [],
      repositorySelection: 'all',
      nextCursor: null,
    });
    await listOrganizationRepositories(fresh, ORG_ID, { fresh: true });
    expect(fresh.calls[0]?.input).toEqual({
      organizationId: ORG_ID,
      fresh: true,
    });

    const withoutHidden = repository();
    delete withoutHidden.hidden;
    await expect(
      listOrganizationRepositories(
        listClient({
          repositories: [withoutHidden],
          repositorySelection: 'all',
          nextCursor: null,
        }),
        ORG_ID,
      ),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });

  it('writes a refresh and a hide', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.repositories.refresh': respondWith(
        'organization.repositories.refresh',
        { added: 1, skippedHidden: 0, skippedExisting: 2, failed: 0 },
      ),
      'organization.repositories.setHidden': respondWith(
        'organization.repositories.setHidden',
        { providerRepoId: '1', hidden: true, changed: true, project: detail() },
      ),
    });
    await expect(
      refreshOrganizationProjectsFromGitHub(client, ORG_ID),
    ).resolves.toMatchObject({ added: 1 });
    await expect(
      setOrganizationRepositoryHidden(client, ORG_ID, '1', { hidden: true }),
    ).resolves.toMatchObject({ changed: true });
    expect(client.calls).toEqual([
      {
        operation: 'organization.repositories.refresh',
        input: { organizationId: ORG_ID },
      },
      {
        operation: 'organization.repositories.setHidden',
        input: { organizationId: ORG_ID, repositoryId: '1', hidden: true },
      },
    ]);
  });
});
