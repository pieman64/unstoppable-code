import {
  canManageOrganizationProjects,
  organizationProjectsPath,
  organizationIntegrationsPath,
  isOrgRepositoryOwnerLookup,
  ORG_REPOSITORY_OWNER_URL_MAX_LENGTH,
  isOrgProjectCatalogSetupSupported,
  isOrgProjectSummary,
  isRefreshOrgProjectRepositoriesResponse,
  deriveOrgProjectPlaceholderState,
  orgProjectPlaceholderLocalId,
  parseOrgProjectPlaceholderLocalId,
  type OrgProjectSummary,
  type OrgProjectRepository,
} from '../index';
import type { WorkspaceContextOrganizationRole } from '../../workspace-context';

describe('organization project management helpers', () => {
  it.each<[WorkspaceContextOrganizationRole, boolean]>([
    ['OWNER', true],
    ['ADMIN', true],
    ['MEMBER', false],
  ])('resolves %s management permission to %s', (role, expected) => {
    expect(canManageOrganizationProjects(role)).toBe(expected);
  });

  it.each([
    [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ],
    ['org /?#%雪', 'org%20%2F%3F%23%25%E9%9B%AA'],
  ])('encodes the organization id %s in both paths', (id, encoded) => {
    expect(organizationProjectsPath(id)).toBe(
      `/organization/${encoded}/projects`,
    );
    expect(organizationIntegrationsPath(id)).toBe(
      `/organization/${encoded}/settings?tab=integrations`,
    );
  });
});

describe('repository owner wire contract', () => {
  const match = {
    kind: 'organization',
    organizationId: 'org',
    organizationName: 'Acme',
    projectId: 'project',
    projectName: 'Catalog',
    repositoryName: 'acme/catalog',
  };

  it('accepts both variants, including the existing empty-string semantics', () => {
    expect(ORG_REPOSITORY_OWNER_URL_MAX_LENGTH).toBe(2048);
    expect(isOrgRepositoryOwnerLookup({ kind: 'none' })).toBe(true);
    expect(isOrgRepositoryOwnerLookup(match)).toBe(true);
    expect(isOrgRepositoryOwnerLookup({ ...match, projectId: '' })).toBe(true);
  });

  it.each([null, undefined, [], 'none', 1, {}, { kind: 'unknown' }])(
    'rejects invalid variants: %p',
    (value) => expect(isOrgRepositoryOwnerLookup(value)).toBe(false),
  );

  it.each([
    'organizationId',
    'organizationName',
    'projectId',
    'projectName',
    'repositoryName',
  ])('requires a string %s', (field) => {
    for (const value of [undefined, null, 42, false, [], {}]) {
      expect(isOrgRepositoryOwnerLookup({ ...match, [field]: value })).toBe(
        false,
      );
    }
  });
});

const summary: OrgProjectSummary = {
  id: 'project',
  organizationId: null,
  name: 'Project',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: null,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: true, manageCloud: false, use: true },
  instance: null,
};
const repository: OrgProjectRepository = {
  provider: 'github',
  host: 'github.com',
  owner: 'owner',
  name: 'repo',
  providerRepoId: null,
  defaultBranch: null,
  verification: 'VERIFIED',
};

describe('isOrgProjectSummary', () => {
  it('accepts omitted and explicit private memory values only', () => {
    expect(isOrgProjectSummary(summary)).toBe(true);
    expect(isOrgProjectSummary({ ...summary, privateMemory: false })).toBe(
      true,
    );
    expect(isOrgProjectSummary({ ...summary, privateMemory: true })).toBe(true);
    expect(isOrgProjectSummary({ ...summary, privateMemory: 'true' })).toBe(
      false,
    );
  });
  it('accepts complete nullable and populated shapes', () => {
    expect(isOrgProjectSummary(summary)).toBe(true);
    for (const state of ['CLAIMED', 'READY', 'DETACHED', 'ACCESS_REVOKED']) {
      expect(
        isOrgProjectSummary({
          ...summary,
          repository,
          instance: { id: 'instance', state },
        }),
      ).toBe(true);
    }
  });
  it.each([
    undefined,
    'repo',
    {},
    { ...repository, provider: 'gitlab' },
    { ...repository, host: null },
    { ...repository, owner: 1 },
    { ...repository, name: false },
    { ...repository, providerRepoId: 1 },
    { ...repository, defaultBranch: false },
    { ...repository, verification: 'INVALID' },
  ])('rejects malformed repository %p', (value: unknown) => {
    expect(isOrgProjectSummary({ ...summary, repository: value })).toBe(false);
  });
  it.each([undefined, null, 'false', 1])(
    'rejects malformed manageCloud %p',
    (value: unknown) => {
      expect(
        isOrgProjectSummary({
          ...summary,
          capabilities: { ...summary.capabilities, manageCloud: value },
        }),
      ).toBe(false);
    },
  );
  it.each([undefined, null, 'PROJECT', 'default'])(
    'rejects malformed purpose %p',
    (value: unknown) => {
      expect(isOrgProjectSummary({ ...summary, purpose: value })).toBe(false);
    },
  );
  it.each([undefined, null, 'PRIVATE', 'public'])(
    'rejects malformed visibility %p',
    (value: unknown) => {
      expect(isOrgProjectSummary({ ...summary, visibility: value })).toBe(
        false,
      );
    },
  );
  it.each([
    undefined,
    {},
    { id: 1, state: 'READY' },
    { id: 'i' },
    { id: 'i', state: 'INVALID' },
    { id: 'i', state: null },
  ])('rejects malformed instance %p', (value: unknown) => {
    expect(isOrgProjectSummary({ ...summary, instance: value })).toBe(false);
  });
});

describe('multi-repository projects (CAN-3532)', () => {
  it('accepts a topology when present, and a summary without one', () => {
    expect(isOrgProjectSummary({ ...summary, topology: 'multi-repo' })).toBe(
      true,
    );
    expect(isOrgProjectSummary({ ...summary, topology: 'single-repo' })).toBe(
      true,
    );
    for (const topology of [null, 'MULTI_REPO', 2])
      expect(isOrgProjectSummary({ ...summary, topology })).toBe(false);
  });
  it('offers catalog setup only for a single-repository project', () => {
    expect(isOrgProjectCatalogSetupSupported(summary)).toBe(true);
    expect(
      isOrgProjectCatalogSetupSupported({
        ...summary,
        topology: 'single-repo',
      }),
    ).toBe(true);
    expect(
      isOrgProjectCatalogSetupSupported({ ...summary, topology: 'multi-repo' }),
    ).toBe(false);
  });
});

describe('repository metadata (CAN-3489)', () => {
  it('accepts a repository with or without GitHub metadata', () => {
    expect(
      isOrgProjectSummary({
        ...summary,
        repository: {
          ...repository,
          description: 'Payments service',
          visibility: 'INTERNAL',
          updatedAt: '2026-09-30T10:00:00.000Z',
        },
      }),
    ).toBe(true);
    expect(
      isOrgProjectSummary({
        ...summary,
        repository: {
          ...repository,
          description: null,
          visibility: null,
          updatedAt: null,
        },
      }),
    ).toBe(true);
  });
  it.each([
    { description: 1 },
    { visibility: 'public' },
    { visibility: 'SECRET' },
    { updatedAt: 5 },
    { updatedAt: 'yesterday' },
  ])('rejects malformed metadata %p', (metadata: object) => {
    expect(
      isOrgProjectSummary({
        ...summary,
        repository: { ...repository, ...metadata },
      }),
    ).toBe(false);
  });
});

describe('isRefreshOrgProjectRepositoriesResponse', () => {
  it.each(['refreshed', 'recent', 'timed-out', 'failed', 'not-connected'])(
    'accepts %s',
    (status) => {
      expect(isRefreshOrgProjectRepositoriesResponse({ status })).toBe(true);
    },
  );
  it.each([undefined, null, {}, { status: 'done' }, { status: 1 }])(
    'rejects %p',
    (value: unknown) => {
      expect(isRefreshOrgProjectRepositoriesResponse(value)).toBe(false);
    },
  );
});

describe('organization project placeholders', () => {
  it('round-trips placeholder ids and rejects real or empty ids', (): void => {
    expect(orgProjectPlaceholderLocalId('project')).toBe('org-project:project');
    expect(parseOrgProjectPlaceholderLocalId('org-project:project')).toBe(
      'project',
    );
    expect(parseOrgProjectPlaceholderLocalId('workspace')).toBeNull();
    expect(parseOrgProjectPlaceholderLocalId('org-project:')).toBeNull();
  });
  it('marks a project that does not run on this machine before anything else', (): void => {
    // A cloud project can never become ready locally, so no catalog or GitHub
    // condition should be able to describe it as something to set up here.
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: { ...summary, location: 'CLOUD' },
      }),
    ).toBe('not-local');
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: 'offline',
        project: { ...summary, location: 'CLOUD' },
      }),
    ).toBe('not-local');
    expect(isOrgProjectSummary({ ...summary, kind: 'DOC' })).toBe(false);
  });

  it('gives snapshot and instance access states precedence over repository verification', (): void => {
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: 'offline',
        project: summary,
      }),
    ).toBe('offline');
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: 'access-changed',
        project: summary,
      }),
    ).toBe('access-changed');
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: {
          ...summary,
          instance: { id: 'instance', state: 'ACCESS_REVOKED' },
        },
      }),
    ).toBe('access-changed');
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: 'offline',
        project: {
          ...summary,
          instance: { id: 'instance', state: 'ACCESS_REVOKED' },
        },
      }),
    ).toBe('offline');
  });
  it('requires a verified repository for setup', (): void => {
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: summary,
      }),
    ).toBe('needs-github-access');
    for (const verification of ['UNVERIFIED', 'STALE', 'VERIFIED'] as const) {
      const project: OrgProjectSummary = {
        ...summary,
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'repo',
          providerRepoId: null,
          defaultBranch: null,
          verification,
        },
      };
      expect(
        deriveOrgProjectPlaceholderState({ snapshotError: null, project }),
      ).toBe(
        verification === 'VERIFIED' ? 'ready-to-set-up' : 'needs-github-access',
      );
    }
  });
  it('lets members set up their own unverified repository and choose a folder for a repository-less Code project', (): void => {
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: {
          ...summary,
          memberOwned: true,
          repository: { ...repository, verification: 'UNVERIFIED' },
        },
      }),
    ).toBe('ready-to-set-up');
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: { ...summary, memberOwned: true, repository: null },
      }),
    ).toBe('choose-folder');
  });
  it('makes a local Cowork project ready to set up without a repository', (): void => {
    expect(
      deriveOrgProjectPlaceholderState({
        snapshotError: null,
        project: { ...summary, kind: 'COWORK' },
      }),
    ).toBe('ready-to-set-up');
  });
});

describe('versioned shared multi-repo setup (CAN-3571)', () => {
  const repo = {
    ...repository,
    provider: 'github' as const,
    verification: 'VERIFIED' as const,
    host: 'github.com',
    providerRepoId: '1',
  };
  const full: OrgProjectSummary = {
    ...summary,
    organizationId: 'org',
    topology: 'multi-repo',
    materializationVersion: 1,
    repositories: [repo],
    repository: repo,
    repositoryCount: 1,
    repositoriesComplete: true,
  };
  it('supports one-repository combinations with complete metadata', () => {
    expect(isOrgProjectSummary(full)).toBe(true);
    expect(isOrgProjectCatalogSetupSupported(full)).toBe(true);
  });
  it.each([
    { materializationVersion: undefined },
    { materializationVersion: 2 },
    { repositoriesComplete: false },
    { repositoryCount: 2 },
    { repository: null },
    { revision: 0 },
    { memberOwned: true, visibility: 'private' as const },
    { repositories: [repo, repo], repositoryCount: 2 },
  ])(
    'refuses incomplete, unknown, private, or contradictory metadata: %p',
    (patch) => {
      expect(isOrgProjectCatalogSetupSupported({ ...full, ...patch })).toBe(
        false,
      );
    },
  );
  it('rejects known-version count contradictions at the wire boundary', () => {
    expect(isOrgProjectSummary({ ...full, repositoryCount: 4 })).toBe(false);
  });
});
