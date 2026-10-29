import type {
  AppAdvisorProjectAgentAccess,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS,
  appAdvisorProjectAgentAccessEquals,
  buildAppAdvisorProjectAgentAccessOwnerOptions,
  coerceAppAdvisorProjectAgentAccess,
} from '../app-advisor-project-agent-access-preferences';

function makeOrganization(
  id: string,
  name: string,
): WorkspaceContextOrganization {
  return { id, name, role: 'MEMBER' };
}

describe('coerceAppAdvisorProjectAgentAccess', () => {
  it('defaults absent and null values to enabled', () => {
    expect(DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(coerceAppAdvisorProjectAgentAccess(undefined)).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
    expect(coerceAppAdvisorProjectAgentAccess(null)).toEqual({
      mode: 'enabled',
      selectedOwners: [],
    });
  });

  it('defaults invalid modes and drops invalid or duplicate owners', () => {
    expect(
      coerceAppAdvisorProjectAgentAccess({
        mode: 'unknown',
        selectedOwners: [{ kind: 'personal' }],
      }),
    ).toEqual({ mode: 'enabled', selectedOwners: [] });

    expect(
      coerceAppAdvisorProjectAgentAccess({
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal', secret: 'drop' },
          { kind: 'personal' },
          {
            kind: 'organization',
            organizationId: ' org-a ',
            secret: 'drop',
          },
          { kind: 'organization', organizationId: 'org-a' },
          { kind: 'organization', organizationId: '   ' },
          { kind: 'organization', organizationId: 42 },
          { kind: 'project', projectId: 'project-a' },
          null,
        ],
      }),
    ).toEqual({
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'personal' },
        { kind: 'organization', organizationId: 'org-a' },
      ],
    });
  });

  it('preserves valid disabled and selected-owner values', () => {
    const value: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'personal' },
        { kind: 'organization', organizationId: 'org-a' },
      ],
    };
    expect(coerceAppAdvisorProjectAgentAccess(value)).toEqual(value);
    expect(
      coerceAppAdvisorProjectAgentAccess({
        mode: 'disabled',
        selectedOwners: [],
      }),
    ).toEqual({ mode: 'disabled', selectedOwners: [] });
  });

  it('returns a fresh object, owner array, and owner records on each call', () => {
    const value = {
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'organization', organizationId: 'org-a' }],
    };
    const first = coerceAppAdvisorProjectAgentAccess(value);
    const second = coerceAppAdvisorProjectAgentAccess(value);

    expect(first).not.toBe(second);
    expect(first.selectedOwners).not.toBe(second.selectedOwners);
    expect(first.selectedOwners[0]).not.toBe(second.selectedOwners[0]);
  });
});

describe('buildAppAdvisorProjectAgentAccessOwnerOptions', () => {
  it('puts Personal first and sorts organizations by name independent of input order', () => {
    const organizations = [
      makeOrganization('org-z', 'Zulu'),
      makeOrganization('org-b', 'bravo'),
      makeOrganization('org-a', 'Alpha'),
    ];
    const expected = [
      { owner: { kind: 'personal' }, label: 'Personal' },
      {
        owner: { kind: 'organization', organizationId: 'org-a' },
        label: 'Alpha',
      },
      {
        owner: { kind: 'organization', organizationId: 'org-b' },
        label: 'bravo',
      },
      {
        owner: { kind: 'organization', organizationId: 'org-z' },
        label: 'Zulu',
      },
    ];

    expect(
      buildAppAdvisorProjectAgentAccessOwnerOptions(organizations),
    ).toEqual(expected);
    expect(
      buildAppAdvisorProjectAgentAccessOwnerOptions(
        [...organizations].reverse(),
      ),
    ).toEqual(expected);
  });

  it('sorts case-insensitively and breaks equal-name ties by organization id', () => {
    const options = buildAppAdvisorProjectAgentAccessOwnerOptions([
      makeOrganization('org-z', 'beta'),
      makeOrganization('org-b', 'Alpha'),
      makeOrganization('org-a', 'alpha'),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      'Personal',
      'alpha',
      'Alpha',
      'beta',
    ]);
    expect(options.slice(1).map((option) => option.owner)).toEqual([
      { kind: 'organization', organizationId: 'org-a' },
      { kind: 'organization', organizationId: 'org-b' },
      { kind: 'organization', organizationId: 'org-z' },
    ]);
  });

  it('deduplicates ids deterministically, skips blank ids, and falls back for blank names', () => {
    const organizations = [
      makeOrganization('org-duplicate', 'Zulu'),
      makeOrganization('org-duplicate', 'Alpha'),
      makeOrganization('', 'Missing id'),
      makeOrganization('   ', 'Whitespace id'),
      makeOrganization('org-unnamed', '  '),
    ];
    const expected = [
      { owner: { kind: 'personal' }, label: 'Personal' },
      {
        owner: { kind: 'organization', organizationId: 'org-duplicate' },
        label: 'Alpha',
      },
      {
        owner: { kind: 'organization', organizationId: 'org-unnamed' },
        label: 'Organization',
      },
    ];

    expect(
      buildAppAdvisorProjectAgentAccessOwnerOptions(organizations),
    ).toEqual(expected);
    expect(
      buildAppAdvisorProjectAgentAccessOwnerOptions(
        [...organizations].reverse(),
      ),
    ).toEqual(expected);
  });

  it('returns only Personal when there are no organizations', () => {
    expect(buildAppAdvisorProjectAgentAccessOwnerOptions([])).toEqual([
      { owner: { kind: 'personal' }, label: 'Personal' },
    ]);
  });
});

describe('appAdvisorProjectAgentAccessEquals', () => {
  const access: AppAdvisorProjectAgentAccess = {
    mode: 'selected-owners',
    selectedOwners: [
      { kind: 'personal' },
      { kind: 'organization', organizationId: 'org-a' },
    ],
  };

  it('compares mode and owner kind/id in the same order', () => {
    expect(
      appAdvisorProjectAgentAccessEquals(access, {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal' },
          { kind: 'organization', organizationId: 'org-a' },
        ],
      }),
    ).toBe(true);
    expect(
      appAdvisorProjectAgentAccessEquals(access, {
        mode: 'disabled',
        selectedOwners: access.selectedOwners,
      }),
    ).toBe(false);
    expect(
      appAdvisorProjectAgentAccessEquals(access, {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'organization', organizationId: 'org-a' },
          { kind: 'personal' },
        ],
      }),
    ).toBe(false);
    expect(
      appAdvisorProjectAgentAccessEquals(access, {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal' },
          { kind: 'organization', organizationId: 'org-b' },
        ],
      }),
    ).toBe(false);
    expect(
      appAdvisorProjectAgentAccessEquals(access, {
        mode: 'selected-owners',
        selectedOwners: [{ kind: 'personal' }],
      }),
    ).toBe(false);
  });
});
