import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';
import {
  computePluginShareableRef,
  getShareablePluginRefKey,
} from '@canopy/desktop-shared/plugin-refs';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import {
  canShareSkill,
  pluginDisplayName,
  resolveShareTarget,
  shareAudienceForTarget,
  shareTargetForEntry,
  shareTargetForInstalledSkill,
} from '../invocableShareTarget';

function skill(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    name: 'release-notes',
    sourceId: 'custom:app',
    description: '',
    source: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
    ...overrides,
  };
}

const PLUGIN = {
  name: 'release-tools',
  displayName: 'Release tools',
  description: 'Ship releases.',
  facets: { claude: {} },
} as unknown as PluginInfo;

const MARKETPLACE = {
  id: 'acme-market',
  name: 'Acme',
  sourceType: 'github',
  sourceUrl: 'https://github.com/acme/plugins',
  plugins: [PLUGIN],
} as unknown as MarketplaceInfo;

const LOCAL_MARKETPLACE = {
  id: 'local-market',
  name: 'Local',
  sourceType: 'directory',
  sourceUrl: '/Users/someone/plugins',
  plugins: [{ ...PLUGIN, name: 'local-tool' }],
} as unknown as MarketplaceInfo;

const PLUGIN_TARGET = {
  kind: 'plugin',
  marketplaceId: 'acme-market',
  pluginName: 'release-tools',
} as const;

function sharedPlugin(
  overrides: Partial<SharedPluginSummary>,
): SharedPluginSummary {
  const ref = computePluginShareableRef(PLUGIN, MARKETPLACE);
  if (!ref) throw new Error('fixture plugin must be shareable');
  return {
    owner: { type: 'user', id: 'me', name: 'Me' },
    shareScope: 'private',
    createdBy: { id: 'me', name: 'Me' },
    externalId: 'shared-1',
    refKey: getShareablePluginRefKey(ref),
    ref,
    name: 'Release tools',
    description: null,
    marketplaceOrigin: 'github',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('canShareSkill', () => {
  it('allows custom and built-in app skills only', () => {
    expect(canShareSkill(skill({}))).toBe(true);
    expect(
      canShareSkill(
        skill({ custom: false, builtIn: true, sourceId: 'builtin:app' }),
      ),
    ).toBe(true);
    expect(
      canShareSkill(skill({ custom: false, sourceId: 'github:acme/skills' })),
    ).toBe(false);
    // A custom flag under another source is not the app's custom source.
    expect(canShareSkill(skill({ sourceId: 'github:acme/skills' }))).toBe(
      false,
    );
  });
});

describe('resolveShareTarget', () => {
  const target = {
    kind: 'skill',
    sourceId: 'custom:app',
    name: 'release-notes',
  } as const;

  it('is unknown while the inventory has not loaded', () => {
    expect(resolveShareTarget(target, null, null)).toEqual({
      status: 'unknown',
    });
    expect(resolveShareTarget(PLUGIN_TARGET, [], null)).toEqual({
      status: 'unknown',
    });
  });

  it('resolves a standalone skill by its full installed identity', () => {
    const custom = skill({});
    const sameNameElsewhere = skill({
      sourceId: 'github:acme/skills',
      custom: false,
    });
    const resolution = resolveShareTarget(
      target,
      [sameNameElsewhere, custom],
      [],
    );
    expect(resolution).toEqual({
      status: 'resolved',
      resolved: {
        kind: 'skill',
        target,
        skill: custom,
        displayName: 'release-notes',
      },
    });
  });

  it('is ineligible for a missing or unshareable skill once loaded', () => {
    expect(resolveShareTarget(target, [], []).status).toBe('ineligible');
    expect(
      resolveShareTarget(
        { ...target, sourceId: 'github:acme/skills' },
        [skill({ sourceId: 'github:acme/skills', custom: false })],
        [],
      ).status,
    ).toBe('ineligible');
  });

  it('resolves a plugin to its shareable reference', () => {
    const resolution = resolveShareTarget(PLUGIN_TARGET, [], [MARKETPLACE]);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.resolved).toMatchObject({
      kind: 'plugin',
      displayName: 'Release tools',
      description: 'Ship releases.',
      pluginRef: computePluginShareableRef(PLUGIN, MARKETPLACE),
    });
  });

  it('never matches a plugin of the same name in another marketplace', () => {
    expect(
      resolveShareTarget(
        { ...PLUGIN_TARGET, marketplaceId: 'other-market' },
        [],
        [MARKETPLACE],
      ).status,
    ).toBe('ineligible');
  });

  it('is ineligible for a plugin without a public source', () => {
    expect(
      resolveShareTarget(
        {
          kind: 'plugin',
          marketplaceId: 'local-market',
          pluginName: 'local-tool',
        },
        [],
        [LOCAL_MARKETPLACE],
      ).status,
    ).toBe('ineligible');
  });
});

describe('entry and installed-skill targets', () => {
  it('maps a plugin skill or command to its owning plugin', () => {
    expect(
      shareTargetForEntry(
        {
          enableRef: {
            kind: 'plugin',
            marketplaceId: 'acme-market',
            pluginName: 'release-tools',
          },
        },
        [],
        [MARKETPLACE],
      ),
    ).toEqual(PLUGIN_TARGET);
  });

  it('returns null when the inventory is missing or the entry cannot be shared', () => {
    const enableRef = {
      kind: 'skill',
      sourceId: 'custom:app',
      skillName: 'release-notes',
    } as const;
    expect(shareTargetForEntry({ enableRef }, null, null)).toBeNull();
    expect(shareTargetForEntry({ enableRef }, [], [])).toBeNull();
    expect(shareTargetForEntry({ enableRef }, [skill({})], [])).toEqual({
      kind: 'skill',
      sourceId: 'custom:app',
      name: 'release-notes',
    });
  });

  it('applies the standalone rule to an installed skill', () => {
    expect(
      shareTargetForInstalledSkill('custom:app', 'release-notes', [skill({})]),
    ).toEqual({ kind: 'skill', sourceId: 'custom:app', name: 'release-notes' });
    expect(
      shareTargetForInstalledSkill('custom:app', 'release-notes', null),
    ).toBeNull();
    expect(
      shareTargetForInstalledSkill('github:acme/skills', 'release-notes', [
        skill({ sourceId: 'github:acme/skills', custom: false }),
      ]),
    ).toBeNull();
  });

  it('names a plugin by its display name, falling back to its id name', () => {
    expect(pluginDisplayName(PLUGIN_TARGET, [MARKETPLACE])).toBe(
      'Release tools',
    );
    expect(pluginDisplayName(PLUGIN_TARGET, null)).toBe('release-tools');
  });
});

describe('shareAudienceForTarget', () => {
  const skillTarget = {
    kind: 'skill',
    sourceId: 'custom:app',
    name: 'release-notes',
  } as const;
  const base = {
    installedSkills: null,
    marketplaces: null,
    sharedPlugins: null,
    accountId: null,
  };
  const remote = {
    remoteId: 'remote-1',
    contentHash: 'hash',
    sharedAt: '2026-01-01T00:00:00.000Z',
  };

  it('is unknown for a skill until installed skills load', () => {
    expect(shareAudienceForTarget(skillTarget, base)).toEqual({
      status: 'unknown',
    });
  });

  it('reads a skill audience from its author-side link', () => {
    const audience = (overrides: Partial<InstalledSkillInfo>): unknown =>
      shareAudienceForTarget(skillTarget, {
        ...base,
        accountId: 'me',
        installedSkills: [skill(overrides)],
      });
    expect(audience({})).toEqual({ status: 'unshared' });
    expect(audience({ remote: { ...remote, shareScope: 'private' } })).toEqual({
      status: 'unshared',
    });
    expect(
      audience({
        remote: { ...remote, shareScope: 'team', ownerName: 'Growth' },
      }),
    ).toEqual({ status: 'shared', audience: 'team', teamName: 'Growth' });
    expect(
      audience({ remote: { ...remote, shareScope: 'organization' } }),
    ).toEqual({ status: 'shared', audience: 'organization' });
    expect(
      audience({
        remote: {
          ...remote,
          shareScope: 'private',
          publicLink: 'https://example.test/s/1',
        },
      }),
    ).toEqual({ status: 'shared', audience: 'public' });
  });

  it('keeps skill audience unknown while account identity is unresolved', () => {
    expect(
      shareAudienceForTarget(skillTarget, {
        ...base,
        installedSkills: [skill({})],
      }),
    ).toEqual({ status: 'unknown' });
    expect(
      shareAudienceForTarget(skillTarget, {
        ...base,
        installedSkills: [skill({ remote: { ...remote, shareScope: 'team' } })],
      }),
    ).toEqual({ status: 'unknown' });
  });

  it('counts a curated plugin as shared without inventing an audience', () => {
    expect(
      shareAudienceForTarget(
        {
          kind: 'plugin',
          marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
          pluginName: 'anything',
        },
        base,
      ),
    ).toEqual({ status: 'shared' });
  });

  it('keeps a plugin unknown while signed out, loading, or after a failed list', () => {
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...base,
        marketplaces: [MARKETPLACE],
        accountId: 'me',
      }),
    ).toEqual({ status: 'unknown' });
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...base,
        marketplaces: [MARKETPLACE],
        sharedPlugins: [],
      }),
    ).toEqual({ status: 'unknown' });
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...base,
        sharedPlugins: [],
        accountId: 'me',
      }),
    ).toEqual({ status: 'unknown' });
  });

  it("matches only this account's own share of the same reference", () => {
    const inputs = {
      ...base,
      marketplaces: [MARKETPLACE],
      accountId: 'me',
    };
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, { ...inputs, sharedPlugins: [] }),
    ).toEqual({ status: 'unshared' });
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...inputs,
        sharedPlugins: [
          sharedPlugin({
            shareScope: 'organization',
            createdBy: { id: 'someone-else', name: null },
          }),
        ],
      }),
    ).toEqual({ status: 'unshared' });
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...inputs,
        sharedPlugins: [
          sharedPlugin({
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Growth',
              organization: { id: 'org-1', name: 'Acme' },
            },
          }),
        ],
      }),
    ).toEqual({ status: 'shared', audience: 'team', teamName: 'Growth' });
    expect(
      shareAudienceForTarget(PLUGIN_TARGET, {
        ...inputs,
        sharedPlugins: [
          sharedPlugin({
            publicShare: {
              externalId: 'public-1',
              sharePath: '/s/1',
              updatedAt: '2026-01-01T00:00:00.000Z',
            } as SharedPluginSummary['publicShare'],
          }),
        ],
      }),
    ).toEqual({ status: 'shared', audience: 'public' });
  });
});
