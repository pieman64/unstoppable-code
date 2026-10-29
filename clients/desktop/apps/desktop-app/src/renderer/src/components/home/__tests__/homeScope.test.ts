import {
  orgDefaultCoworkWorkspaceId,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  resolveHomeContextRebind,
  resolveHomeScope,
  shouldAttemptHomeSeed,
  shouldRebindHomeToContext,
  type HomeContextRebindInput,
} from '../homeScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

function owner(organizationId: string): SidebarItem['owner'] {
  return {
    type: 'organization',
    organizationId,
    projectId: `project-${organizationId}`,
    instanceId: `instance-${organizationId}`,
    bindingGeneration: 1,
  };
}

const personalChats: SidebarItem = {
  id: 'cowork-default',
  name: 'Chats',
  type: 'cowork',
  color: '#7c3aed',
  collapsed: false,
  order: 0,
};
const personalProject: SidebarItem = {
  id: 'sharing-test',
  name: 'Sharing test',
  type: 'cowork',
  color: '#ea580c',
  collapsed: false,
  order: 1,
};
const linkedPersonalProject: SidebarItem = {
  id: 'calculate-pi',
  name: 'qrtp/calculate-pi',
  type: 'single-repo',
  repoPath: '/tmp/calculate-pi',
  color: '#16a34a',
  worktrees: [],
  collapsed: false,
  order: 2,
};
const orgProject: SidebarItem = {
  id: 'org-repo',
  name: 'Org repo',
  type: 'single-repo',
  repoPath: '/tmp/org-repo',
  color: '#2563eb',
  worktrees: [],
  collapsed: false,
  order: 3,
  owner: owner(ORG),
};
const otherOrgProject: SidebarItem = {
  ...orgProject,
  id: 'other-org-repo',
  name: 'Other org repo',
  order: 4,
  owner: owner(OTHER_ORG),
};

const projects = [
  personalChats,
  personalProject,
  linkedPersonalProject,
  orgProject,
  otherOrgProject,
];

describe('resolveHomeScope', () => {
  it('leaves everything in scope while org projects are off or unhydrated', () => {
    const scope = resolveHomeScope(undefined, projects, []);
    expect(scope.projects).toEqual(projects);
    expect(scope.isInScope('other-org-repo')).toBe(true);
    expect(scope.isOutOfScope('other-org-repo')).toBe(false);
    expect(scope.defaultCoworkId).toBe('cowork-default');
    expect(scope.fallbackWorkspaceId).toBe('cowork-default');
  });

  it('keeps Personal to Personal projects', () => {
    const scope = resolveHomeScope({ kind: 'personal' }, projects, []);
    expect(scope.projects.map((project) => project.id)).toEqual([
      'cowork-default',
      'sharing-test',
      'calculate-pi',
    ]);
    expect(scope.isInScope('org-repo')).toBe(false);
    expect(scope.fallbackWorkspaceId).toBe('cowork-default');
  });

  it('keeps an organization to its own projects and linked Personal checkouts', () => {
    const scope = resolveHomeScope(
      { kind: 'organization', organizationId: ORG },
      projects,
      ['calculate-pi'],
    );
    expect(scope.projects.map((project) => project.id)).toEqual([
      'calculate-pi',
      'org-repo',
    ]);
    expect(scope.isInScope('sharing-test')).toBe(false);
    expect(scope.isInScope('other-org-repo')).toBe(false);
    expect(scope.defaultCoworkId).toBe(orgDefaultCoworkWorkspaceId(ORG));
  });

  it("treats the organization's Chats as in scope before it is provisioned", () => {
    const scope = resolveHomeScope(
      { kind: 'organization', organizationId: ORG },
      [personalChats, personalProject],
      [],
    );
    expect(scope.projects).toEqual([]);
    expect(scope.isInScope(orgDefaultCoworkWorkspaceId(ORG))).toBe(true);
    expect(scope.fallbackWorkspaceId).toBe(orgDefaultCoworkWorkspaceId(ORG));
  });

  it('judges only selections known to belong to another context', () => {
    const scope = resolveHomeScope(
      { kind: 'organization', organizationId: ORG },
      projects,
      [],
    );
    expect(scope.isOutOfScope('sharing-test')).toBe(true);
    expect(scope.isOutOfScope('cowork-default')).toBe(true);
    expect(scope.isOutOfScope(orgDefaultCoworkWorkspaceId(OTHER_ORG))).toBe(
      true,
    );
    // Not loaded yet (a project just added): left alone.
    expect(scope.isOutOfScope('just-added')).toBe(false);
    expect(scope.isOutOfScope('org-repo')).toBe(false);
  });

  it('retries seeding once projects load, but not for the same count', () => {
    // The first attempt ran before the projects store loaded.
    expect(shouldAttemptHomeSeed(null, null, 0)).toBe(true);
    expect(shouldAttemptHomeSeed(null, 0, 0)).toBe(false);
    expect(shouldAttemptHomeSeed(null, 0, 2)).toBe(true);
    expect(shouldAttemptHomeSeed('cowork-default', 0, 2)).toBe(false);
  });

  it('seeds nothing when unscoped with no projects loaded', () => {
    expect(resolveHomeScope(undefined, [], []).fallbackWorkspaceId).toBeNull();
  });
});

describe('resolveHomeContextRebind', () => {
  // Real installs sort each context's Chats ahead of its projects: Personal's
  // is created first, and an organization's is provisioned before its
  // projects are set up.
  const orgChats: SidebarItem = {
    ...personalChats,
    id: orgDefaultCoworkWorkspaceId(ORG),
    order: 2,
    owner: owner(ORG),
  };
  const installProjects = [
    personalChats,
    personalProject,
    orgChats,
    orgProject,
    otherOrgProject,
  ];

  it('lands on the first listed project when the organization Chats sorts first', () => {
    const rebind = resolveHomeContextRebind(
      resolveHomeScope(
        { kind: 'organization', organizationId: ORG },
        installProjects,
        [],
      ),
    );
    expect(rebind).toEqual({
      workspaceId: 'org-repo',
    });
  });

  it('lands on the first listed Personal project, not Personal Chats', () => {
    const rebind = resolveHomeContextRebind(
      resolveHomeScope({ kind: 'personal' }, installProjects, []),
    );
    expect(rebind).toEqual({
      workspaceId: 'sharing-test',
    });
  });

  it('follows sidebar order, not store order', () => {
    const rebind = resolveHomeContextRebind(
      resolveHomeScope(
        { kind: 'organization', organizationId: ORG },
        [orgProject, { ...linkedPersonalProject, owner: owner(ORG) }],
        [],
      ),
    );
    expect(rebind.workspaceId).toBe('calculate-pi');
  });

  it("falls back to the context's Chats when it lists no project", () => {
    const provisioned = resolveHomeContextRebind(
      resolveHomeScope(
        { kind: 'organization', organizationId: ORG },
        [personalChats, personalProject, orgChats],
        [],
      ),
    );
    expect(provisioned).toEqual({
      workspaceId: orgDefaultCoworkWorkspaceId(ORG),
    });
    const unprovisioned = resolveHomeContextRebind(
      resolveHomeScope(
        { kind: 'organization', organizationId: ORG },
        [personalChats, personalProject],
        [],
      ),
    );
    expect(unprovisioned).toEqual(provisioned);
  });
});

describe('shouldRebindHomeToContext', () => {
  const settled: HomeContextRebindInput = {
    previousContextKey: 'personal',
    contextKey: 'personal',
    workspaceId: 'sharing-test',
    stillVisible: true,
    enteredOrganizationWithPersonalSelection: false,
    hasDraft: false,
    draftBelongsToOtherContext: false,
  };

  it('leaves a selection that is still in the selected context alone', () => {
    expect(shouldRebindHomeToContext(settled)).toBe(false);
    expect(
      shouldRebindHomeToContext({ ...settled, previousContextKey: null }),
    ).toBe(false);
  });

  it('rebinds a selection the new context does not hold', () => {
    expect(
      shouldRebindHomeToContext({
        ...settled,
        contextKey: `org:${ORG}`,
        stillVisible: false,
      }),
    ).toBe(true);
    // Home reopened after a switch made while it was unmounted.
    expect(
      shouldRebindHomeToContext({
        ...settled,
        previousContextKey: null,
        contextKey: `org:${ORG}`,
        stillVisible: false,
      }),
    ).toBe(true);
  });

  it('rebinds a selection that leaves scope without a context switch', () => {
    expect(shouldRebindHomeToContext({ ...settled, stillVisible: false })).toBe(
      true,
    );
  });

  it('rebinds a linked Personal selection on entering an organization', () => {
    expect(
      shouldRebindHomeToContext({
        ...settled,
        contextKey: `org:${ORG}`,
        enteredOrganizationWithPersonalSelection: true,
      }),
    ).toBe(true);
  });

  it('leaves an empty selection to the seed while the context is unchanged', () => {
    // Projects can load before the first seed lands. Nothing was selected, so
    // there is no change to announce.
    const unseeded = { ...settled, workspaceId: null, stillVisible: false };
    expect(shouldRebindHomeToContext(unseeded)).toBe(false);
    expect(
      shouldRebindHomeToContext({ ...unseeded, previousContextKey: null }),
    ).toBe(false);
    // A draft typed before the seed lands stays for the seed's target.
    expect(shouldRebindHomeToContext({ ...unseeded, hasDraft: true })).toBe(
      false,
    );
    expect(
      shouldRebindHomeToContext({
        ...unseeded,
        previousContextKey: null,
        hasDraft: true,
      }),
    ).toBe(false);
    // A draft another context owns is still cleared.
    expect(
      shouldRebindHomeToContext({
        ...unseeded,
        hasDraft: true,
        draftBelongsToOtherContext: true,
      }),
    ).toBe(true);
  });

  it('targets the new context when nothing was selected at a switch', () => {
    expect(
      shouldRebindHomeToContext({
        ...settled,
        contextKey: `org:${ORG}`,
        workspaceId: null,
        stillVisible: false,
      }),
    ).toBe(true);
  });

  it('rebinds a draft written in another context', () => {
    expect(
      shouldRebindHomeToContext({
        ...settled,
        hasDraft: true,
        draftBelongsToOtherContext: true,
      }),
    ).toBe(true);
  });
});
