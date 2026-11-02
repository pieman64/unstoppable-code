import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  computeRelationships,
  type PersonalRepository,
} from '../lib/org-project-relationships';

function project(
  id = 'project',
  providerRepoId: string | null = '123',
  owner = 'acme',
  name = 'repo',
): OrgProjectSummary {
  return {
    id,
    organizationId: 'org',
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner,
      name,
      providerRepoId,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
  };
}
function personal(remoteUrl: string): PersonalRepository {
  return { id: 'personal', type: 'single-repo', remoteUrl };
}
const expected = [{ projectId: 'project', personalWorkspaceId: 'personal' }];

it.each([
  'https://github.com/Acme/Repo.git',
  'https://user@github.com/acme/repo/',
  'git@github.com:acme/repo.git',
  'ssh://git@github.com/acme/repo.git',
])('normalizes supported aliases: %s', (remote): void => {
  expect(computeRelationships([project()], [personal(remote)])).toEqual(
    expected,
  );
});
it('prefers a verified immutable identity over an unverified alias', (): void => {
  const unverified = project('old', null);
  if (unverified.repository) unverified.repository.verification = 'UNVERIFIED';
  expect(
    computeRelationships(
      [unverified, project()],
      [personal('https://github.com/acme/repo')],
    ),
  ).toEqual(expected);
});
it('matches a unique unverified alias but rejects ambiguity', (): void => {
  const first = project('project', null);
  const second = project('other', null);
  expect(
    computeRelationships([first], [personal('git@github.com:acme/repo')]),
  ).toEqual(expected);
  expect(
    computeRelationships(
      [first, second],
      [personal('git@github.com:acme/repo')],
    ),
  ).toEqual([]);
});
it('rejects reused names with conflicting verified ids', (): void => {
  expect(
    computeRelationships(
      [project(), project('other', '456')],
      [personal('git@github.com:acme/repo')],
    ),
  ).toEqual([]);
});
it.each([
  'https://github.com/fork-owner/repo',
  'https://github.com/acme/old-name',
  'https://github.com:443/acme/repo',
  'ssh://git@github.com:22/acme/repo',
  'git@github.com:22/acme/repo',
  'https://github.com/acme/repo?redirect=1',
  'https://github.com/acme/repo/../repo',
  'https://github.com.evil/acme/repo',
  'https:/github.com/acme/repo',
  'https:////github.com/acme/repo',
  'https://github.com//acme/repo',
  'https://github.com/acme//repo',
  'https://github.com/acme/%2e%2e/acme/repo',
])(
  'rejects forks, unresolved redirects and ambiguous remotes: %s',
  (remote): void => {
    expect(computeRelationships([project()], [personal(remote)])).toEqual([]);
  },
);
it('excludes organization-owned workspaces and catalog rows without member access', (): void => {
  const item = personal('git@github.com:acme/repo');
  item.owner = {
    type: 'organization',
    organizationId: 'org',
    projectId: 'other',
    instanceId: 'instance',
    bindingGeneration: 0,
  };
  expect(computeRelationships([project()], [item])).toEqual([]);
  const inaccessible = project();
  inaccessible.capabilities.use = false;
  expect(
    computeRelationships(
      [inaccessible],
      [personal('git@github.com:acme/repo')],
    ),
  ).toEqual([]);
});

it('joins verified aliases by immutable provider id before considering names', (): void => {
  expect(
    computeRelationships(
      [
        project('alias', '123', 'acme', 'old-name'),
        project('project', '123'),
        project('fork', '456', 'fork-owner'),
      ],
      [personal('git@github.com:acme/old-name')],
    ),
  ).toEqual([
    { projectId: 'alias', personalWorkspaceId: 'personal' },
    { projectId: 'project', personalWorkspaceId: 'personal' },
  ]);
});
it('never links a checkout to a multi-repository project whose first repository it is (CAN-3532)', (): void => {
  // A member's converted multi-repo project copies the organization's
  // repositories; the organization's own project for the repository is still
  // the one a checkout of it belongs to, and never ambiguous with it.
  const multiRepo = { ...project('multi'), topology: 'multi-repo' as const };
  expect(
    computeRelationships(
      [multiRepo, project()],
      [personal('https://github.com/acme/repo')],
    ),
  ).toEqual(expected);
  expect(
    computeRelationships(
      [multiRepo],
      [personal('https://github.com/acme/repo')],
    ),
  ).toEqual([]);
});
