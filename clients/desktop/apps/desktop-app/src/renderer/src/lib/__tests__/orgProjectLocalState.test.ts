import type {
  OrgProjectSetupProgress,
  OrgProjectSetupState,
} from '@canopy/protocol/org-projects';
import {
  deriveOrgProjectLocalStatuses,
  ORG_PROJECT_SETTING_UP_MESSAGE,
  ORG_PROJECT_SETUP_FAILED_MESSAGE,
} from '../orgProjectLocalState';

function progress(
  projectId: string,
  state: OrgProjectSetupState,
  message: string | null = null,
): Record<string, OrgProjectSetupProgress> {
  return {
    [projectId]: {
      projectId,
      instanceId: null,
      state,
      message,
      percent: null,
      updatedAt: '2026-10-19T00:00:00.000Z',
    },
  };
}

function local(
  organizationId: string,
  projectId: string,
): {
  owner: {
    type: 'organization';
    organizationId: string;
    projectId: string;
    instanceId: string;
    bindingGeneration: number;
  };
} {
  return {
    owner: {
      type: 'organization',
      organizationId,
      projectId,
      instanceId: `instance-${projectId}`,
      bindingGeneration: 1,
    },
  };
}

const base = {
  organizationId: 'org',
  localProjects: [],
  linkedProjectIds: [],
  setupProgress: {},
};

describe('deriveOrgProjectLocalStatuses', () => {
  it('leaves a project with no checkout, link or progress absent (not set up)', () => {
    expect(deriveOrgProjectLocalStatuses(base).size).toBe(0);
  });

  it('marks this organization’s checked-out projects ready', () => {
    const statuses = deriveOrgProjectLocalStatuses({
      ...base,
      localProjects: [local('org', 'p1'), local('other', 'p2'), {}],
    });
    expect(statuses.get('p1')).toEqual({ state: 'ready' });
    expect(statuses.has('p2')).toBe(false);
  });

  it('marks linked projects, and those linked after listing, ready', () => {
    const statuses = deriveOrgProjectLocalStatuses({
      ...base,
      linkedProjectIds: ['p1'],
      linkedAfterListing: ['p2'],
    });
    expect(statuses.get('p1')).toEqual({ state: 'ready' });
    expect(statuses.get('p2')).toEqual({ state: 'ready' });
  });

  it.each(['claiming', 'materializing'] as const)(
    'reports %s as setting up with its message, even when checked out',
    (state) => {
      const statuses = deriveOrgProjectLocalStatuses({
        ...base,
        localProjects: [local('org', 'p1')],
        setupProgress: progress('p1', state, 'Cloning 40%'),
      });
      expect(statuses.get('p1')).toEqual({
        state: 'setting-up',
        message: 'Cloning 40%',
      });
    },
  );

  it('falls back to a default setting-up message', () => {
    const statuses = deriveOrgProjectLocalStatuses({
      ...base,
      setupProgress: progress('p1', 'claiming'),
    });
    expect(statuses.get('p1')).toEqual({
      state: 'setting-up',
      message: ORG_PROJECT_SETTING_UP_MESSAGE,
    });
  });

  it('keeps a failed setup failed even when the project is also linked', () => {
    const statuses = deriveOrgProjectLocalStatuses({
      ...base,
      linkedProjectIds: ['p1'],
      setupProgress: progress('p1', 'failed', 'Clone failed'),
    });
    expect(statuses.get('p1')).toEqual({
      state: 'failed',
      message: 'Clone failed',
    });
  });

  it('falls back to a default failure message', () => {
    const statuses = deriveOrgProjectLocalStatuses({
      ...base,
      setupProgress: progress('p1', 'failed'),
    });
    expect(statuses.get('p1')).toEqual({
      state: 'failed',
      message: ORG_PROJECT_SETUP_FAILED_MESSAGE,
    });
  });

  it.each(['cancelled', 'ready'] as const)(
    'lets %s progress fall through to the membership rules',
    (state) => {
      expect(
        deriveOrgProjectLocalStatuses({
          ...base,
          setupProgress: progress('p1', state),
        }).has('p1'),
      ).toBe(false);
      expect(
        deriveOrgProjectLocalStatuses({
          ...base,
          localProjects: [local('org', 'p1')],
          setupProgress: progress('p1', state),
        }).get('p1'),
      ).toEqual({ state: 'ready' });
    },
  );
});
