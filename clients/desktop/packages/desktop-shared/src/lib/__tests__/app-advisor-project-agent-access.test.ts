import type {
  AppAdvisorProjectAgentAccess,
  ProjectOwnerContext,
} from '../../types';
import {
  DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS,
  isProjectOwnerAllowedAppAdvisorAccess,
  normalizeAppAdvisorProjectAgentAccess,
} from '../app-advisor-project-agent-access';

const organizationA: ProjectOwnerContext = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
const organizationB: ProjectOwnerContext = {
  kind: 'organization',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};
const personal: ProjectOwnerContext = { kind: 'personal' };

describe('normalizeAppAdvisorProjectAgentAccess', () => {
  it('uses the enabled default when the preference is missing or invalid', () => {
    expect(DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(normalizeAppAdvisorProjectAgentAccess(undefined)).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(normalizeAppAdvisorProjectAgentAccess(null)).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(normalizeAppAdvisorProjectAgentAccess({ mode: 'invalid' })).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(normalizeAppAdvisorProjectAgentAccess([])).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
  });

  it('keeps selected-owner mode but drops invalid and duplicate owners', () => {
    const access = normalizeAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [
        personal,
        { kind: 'personal' },
        { kind: 'organization', organizationId: ' organization-a ' },
        { kind: 'organization', organizationId: 'organization-a' },
        { kind: 'organization', organizationId: '   ' },
        { kind: 'workspace', workspaceId: 'not-an-owner' },
        null,
        'personal',
      ],
    });

    expect(access).toEqual({
      mode: 'selected-owners',
      selectedOwners: [
        personal,
        { kind: 'organization', organizationId: 'organization-a' },
      ],
    });
  });

  it('uses an empty selection when selectedOwners is absent or malformed', () => {
    expect(
      normalizeAppAdvisorProjectAgentAccess({ mode: 'selected-owners' }),
    ).toEqual({ mode: 'selected-owners', selectedOwners: [] });
    expect(
      normalizeAppAdvisorProjectAgentAccess({
        mode: 'selected-owners',
        selectedOwners: 'personal',
      }),
    ).toEqual({ mode: 'selected-owners', selectedOwners: [] });
  });
});

describe('isProjectOwnerAllowedAppAdvisorAccess', () => {
  it('allows every saved owner in enabled mode', () => {
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'enabled',
      selectedOwners: [],
    };

    expect(isProjectOwnerAllowedAppAdvisorAccess(access, personal)).toBe(true);
    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationA)).toBe(
      true,
    );
  });

  it('allows only exact selected Personal and organization owners', () => {
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [personal, organizationA],
    };

    expect(isProjectOwnerAllowedAppAdvisorAccess(access, personal)).toBe(true);
    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationA)).toBe(
      true,
    );
    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationB)).toBe(
      false,
    );
  });

  it('does not let a stale organization selection match another organization', () => {
    const staleOrganization: ProjectOwnerContext = {
      kind: 'organization',
      organizationId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    };
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [staleOrganization],
    };

    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationA)).toBe(
      false,
    );
    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationB)).toBe(
      false,
    );
  });

  it('disallows every owner in disabled mode, even if selected', () => {
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'disabled',
      selectedOwners: [personal, organizationA],
    };

    expect(isProjectOwnerAllowedAppAdvisorAccess(access, personal)).toBe(false);
    expect(isProjectOwnerAllowedAppAdvisorAccess(access, organizationA)).toBe(
      false,
    );
  });
});
