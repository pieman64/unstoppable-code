import {
  EXTERNAL_AGENT_ACCESS_LEVELS,
  EXTERNAL_AGENT_DESTRUCTIVE_GROUPS,
  EXTERNAL_AGENT_TOOL_GROUPS,
  externalAgentAccessDecisionSchema,
  externalAgentAccessSchema,
  externalAgentAccessUpdateSchema,
  isExternalAgentDestructiveGroup,
} from '../index';

function decision(group: string, access: string): Record<string, unknown> {
  return {
    groups: { [group]: access },
    disabledTools: [],
    enabledDefaultOff: [],
    organizations: { mode: 'all', organizationIds: [] },
    remotes: { mode: 'all', remoteIds: [] },
    durationDays: null,
  };
}

function access(group: string, level: string): Record<string, unknown> {
  return {
    groups: { [group]: level },
    disabledTools: [],
    enabledDefaultOff: [],
    organizations: { mode: 'all', organizationIds: [] },
    remotes: { mode: 'all', remoteIds: [] },
  };
}

function update(group: string, level: string): Record<string, unknown> {
  return {
    revision: 1,
    access: access(group, level),
    expiry: { kind: 'keep' },
  };
}

describe('external-agent access protocol', () => {
  it('exports destructive access levels and the groups that can hold them', () => {
    expect(EXTERNAL_AGENT_ACCESS_LEVELS).toEqual([
      'read',
      'write',
      'destructive',
    ]);
    expect(EXTERNAL_AGENT_DESTRUCTIVE_GROUPS).toEqual(['org', 'library']);
    expect(isExternalAgentDestructiveGroup('org')).toBe(true);
    expect(isExternalAgentDestructiveGroup('library')).toBe(true);
    expect(isExternalAgentDestructiveGroup('account')).toBe(false);
    expect(isExternalAgentDestructiveGroup('unknown')).toBe(false);
  });

  it.each(EXTERNAL_AGENT_DESTRUCTIVE_GROUPS)(
    'accepts destructive access for %s in decisions, access and updates',
    (group) => {
      expect(
        externalAgentAccessDecisionSchema.safeParse(
          decision(group, 'destructive'),
        ).success,
      ).toBe(true);
      expect(
        externalAgentAccessSchema.safeParse(access(group, 'destructive'))
          .success,
      ).toBe(true);
      expect(
        externalAgentAccessUpdateSchema.safeParse(update(group, 'destructive'))
          .success,
      ).toBe(true);
    },
  );

  it.each(
    EXTERNAL_AGENT_TOOL_GROUPS.filter(
      (group) => !isExternalAgentDestructiveGroup(group),
    ),
  )(
    'rejects destructive access for %s in decisions, access and updates',
    (group) => {
      expect(
        externalAgentAccessDecisionSchema.safeParse(
          decision(group, 'destructive'),
        ).success,
      ).toBe(false);
      expect(
        externalAgentAccessSchema.safeParse(access(group, 'destructive'))
          .success,
      ).toBe(false);
      expect(
        externalAgentAccessUpdateSchema.safeParse(update(group, 'destructive'))
          .success,
      ).toBe(false);
    },
  );

  it.each(EXTERNAL_AGENT_TOOL_GROUPS)(
    'continues to accept read and write access for %s',
    (group) => {
      for (const level of ['read', 'write']) {
        expect(
          externalAgentAccessDecisionSchema.safeParse(decision(group, level))
            .success,
        ).toBe(true);
        expect(
          externalAgentAccessSchema.safeParse(access(group, level)).success,
        ).toBe(true);
        expect(
          externalAgentAccessUpdateSchema.safeParse(update(group, level))
            .success,
        ).toBe(true);
      }
    },
  );
});
