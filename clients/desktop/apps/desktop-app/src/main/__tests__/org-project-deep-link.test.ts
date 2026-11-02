import {
  openOrgProjectDeepLink,
  type OrgProjectLinkDeps,
} from '../deep-link/org-project-deep-link';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
const project: OrgProjectSummary = {
  id: 'p',
  organizationId: 'org',
  name: 'Payments',
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
  capabilities: { use: true, administer: false, manageCloud: false },
  instance: null,
};
const archivedProject: OrgProjectSummary = { ...project };
// Keep the intentionally unsupported archived input at the test boundary.
Reflect.set(archivedProject, 'state', 'ARCHIVED');
function deps(
  projects: readonly OrgProjectSummary[] = [project],
): OrgProjectLinkDeps {
  return {
    accountId: jest.fn(() => Promise.resolve('account')),
    accountEpoch: jest.fn(() => 0),
    enabled: () => true,
    projects: jest.fn(() => Promise.resolve(projects)),
    workspaceId: jest.fn(() => Promise.resolve(null)),
    switchContext: jest.fn(() => Promise.resolve()),
    deliver: jest.fn(),
    unavailable: jest.fn(),
  };
}
describe('organization project deep-link authorization', () => {
  it('switches context and delegates setup for a known authorized project', async () => {
    const host = deps();
    await openOrgProjectDeepLink('p', 'org', host);
    expect(host.projects).toHaveBeenCalledWith('org');
    expect(host.switchContext).toHaveBeenCalledWith('org');
    expect(host.deliver).toHaveBeenCalledWith({
      projectId: 'p',
      organizationId: 'org',
      workspaceId: null,
    });
  });
  it.each([
    [],
    [{ ...project, capabilities: { ...project.capabilities, use: false } }],
    [{ ...project, organizationId: 'other' }],
    [archivedProject],
  ])(
    'reports unknown, unauthorized, cross-context and archived projects identically (%#)',
    async (...rows: OrgProjectSummary[]): Promise<void> => {
      const host = deps(rows);
      await openOrgProjectDeepLink('p', 'org', host);
      expect(host.unavailable).toHaveBeenCalledTimes(1);
      expect(host.deliver).not.toHaveBeenCalled();
      expect(host.switchContext).not.toHaveBeenCalled();
    },
  );
  it('selects an existing bound workspace', async () => {
    const host = deps();
    host.workspaceId = jest.fn(() => Promise.resolve('local'));
    await openOrgProjectDeepLink('p', 'org', host);
    expect(host.deliver).toHaveBeenCalledWith({
      projectId: 'p',
      organizationId: 'org',
      workspaceId: 'local',
    });
  });
  it('does no catalog work with the flag disabled', async () => {
    const host = deps();
    host.enabled = (): boolean => false;
    await openOrgProjectDeepLink('p', 'org', host);
    expect(host.projects).not.toHaveBeenCalled();
    expect(host.unavailable).toHaveBeenCalled();
  });
});

it('aborts when the account is signed out and back in under the same id', async () => {
  const host = deps();
  // Same account id on both sides of the transition: only the epoch moves.
  let epoch = 0;
  host.accountEpoch = jest.fn((): number => epoch);
  host.projects = jest.fn(() => {
    epoch += 1;
    return Promise.resolve([project]);
  });
  await openOrgProjectDeepLink('p', 'org', host);
  expect(host.unavailable).toHaveBeenCalledTimes(1);
  expect(host.switchContext).not.toHaveBeenCalled();
  expect(host.deliver).not.toHaveBeenCalled();
});
it('aborts when the account transitions during the context switch', async () => {
  const host = deps();
  let epoch = 0;
  host.accountEpoch = jest.fn((): number => epoch);
  host.switchContext = jest.fn(() => {
    epoch += 1;
    return Promise.resolve();
  });
  await openOrgProjectDeepLink('p', 'org', host);
  expect(host.unavailable).toHaveBeenCalledTimes(1);
  expect(host.deliver).not.toHaveBeenCalled();
});
it('aborts when the account transitions during the first account read', async () => {
  const host = deps();
  let epoch = 0;
  host.accountEpoch = jest.fn((): number => epoch);
  // The transition happens INSIDE the first read, so the pre-transition id is
  // paired with a post-transition epoch unless the epoch is sampled first.
  host.accountId = jest.fn(() => {
    const current = epoch;
    if (current === 0) epoch = 1;
    return Promise.resolve('account');
  });
  await openOrgProjectDeepLink('p', 'org', host);
  expect(host.unavailable).toHaveBeenCalledTimes(1);
  expect(host.switchContext).not.toHaveBeenCalled();
  expect(host.deliver).not.toHaveBeenCalled();
});
