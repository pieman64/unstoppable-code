import {
  customizeRowEditedLine,
  customizeRowSecondLine,
  customizeRowSourceLine,
  bundledSkillStatusReason,
  isBundledSkill,
  pendingSignInLabel,
  removalBusyLabel,
  removalConfirmTitle,
  removalFallbackError,
  removalMenuLabel,
  removalVerb,
  sharedByMeLine,
  updateMenuLabel,
} from '../customize-row-copy';
import { sharedByYouSinceLabel } from '../shared-by-you';
import type { UnifiedPluginEntry } from '../unified-plugin-entry';

function makeEntry(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id: 'skill:github:repo/alpha',
    kind: 'skill',
    origin: 'installed-standalone',
    name: 'Alpha',
    description: 'An alpha skill.',
    categories: [],
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'github:repo', skillName: 'alpha' },
    ...overrides,
  };
}

const SINCE = '2026-10-12T00:00:00.000Z';

describe('customizeRowSourceLine', () => {
  it('names the bundling plugin first', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'app',
          origin: 'shared',
          custom: true,
          sourceLabel: 'Local',
          bundledBy: { entryId: 'mkt:a/b/slack', name: 'Slack' },
          ref: { type: 'local-mcp', serverId: 's1' },
        }),
      ),
    ).toBe('From the Slack plugin');
  });

  it('reads Shared by the author on shared rows', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          origin: 'shared',
          authorName: 'Dana Lee',
          sourceLabel: 'GitHub',
          ref: { type: 'shared-skill', skillId: 'sk1' },
        }),
      ),
    ).toBe('Shared by Dana Lee');
  });

  it('reads Shared when a shared row has no author', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          origin: 'shared',
          authorName: '  ',
          ref: { type: 'shared-skill', skillId: 'sk1' },
        }),
      ),
    ).toBe('Shared');
  });

  it('reads Created by you on items the viewer authored', () => {
    expect(
      customizeRowSourceLine(makeEntry({ custom: true, sourceLabel: 'Local' })),
    ).toBe('Created by you');
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'collection',
          origin: 'custom',
          ref: { type: 'local-collection', collectionId: 'c1' },
        }),
      ),
    ).toBe('Created by you');
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'agent',
          origin: 'custom',
          ref: { type: 'local-agent', agentId: 'a1' },
        }),
      ),
    ).toBe('Created by you');
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'automation',
          origin: 'custom',
          ref: { type: 'automation', activityId: 'act1' },
        }),
      ),
    ).toBe('Created by you');
  });

  it('reads Created by you on a shared item the viewer made', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          origin: 'shared',
          authorName: 'Dana Lee',
          ownedByViewer: true,
          ref: { type: 'shared-skill', skillId: 'sk1' },
        }),
      ),
    ).toBe('Created by you');
  });

  it('names a GitHub skills source and a marketplace skill’s catalog', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({ sourceLabel: 'GitHub', ownershipLabel: 'acme/skills' }),
      ),
    ).toBe('GitHub · acme/skills');
    expect(customizeRowSourceLine(makeEntry({ sourceLabel: 'GitHub' }))).toBe(
      'GitHub',
    );
    expect(
      customizeRowSourceLine(
        makeEntry({ origin: 'marketplace', sourceLabel: 'Claude · slackapi' }),
      ),
    ).toBe('Claude · slackapi');
  });

  it('maps internal source labels to plain words', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'automation',
          origin: 'built-in',
          sourceLabel: 'Built-in',
          ref: { type: 'automation', activityId: 'act1' },
        }),
      ),
    ).toBe('Built-in');
    expect(
      customizeRowSourceLine(
        makeEntry({
          builtIn: true,
          sourceLabel: 'Built-in',
          ref: { type: 'skill', sourceId: 'builtin:app', skillName: 'alpha' },
        }),
      ),
    ).toBe('Built-in');
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'pipeline',
          origin: 'project',
          sourceLabel: 'Project',
          ref: { type: 'pipeline', pipelineId: 'p1', source: 'project' },
        }),
      ),
    ).toBe('From project');
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'plugin',
          origin: 'curated',
          sourceLabel: 'Curated',
          ref: { type: 'curated-plugin', key: 'slack' },
        }),
      ),
    ).toBe('From the curated catalog');
  });

  it('never shows the raw Curated or Local labels on MCP server rows', () => {
    const curated = makeEntry({
      kind: 'app',
      origin: 'curated',
      name: 'Acme Search',
      description: 'Search **Acme** docs.',
      sourceLabel: 'Curated',
      ref: { type: 'curated-mcp', key: 'acme' },
    });
    const local = makeEntry({
      kind: 'app',
      name: 'Local tools',
      description: 'Tools on this machine.',
      sourceLabel: 'Local',
      ref: { type: 'local-mcp', serverId: 's1' },
    });
    expect(customizeRowSourceLine(curated)).toBeUndefined();
    expect(customizeRowSourceLine(local)).toBeUndefined();
    expect(customizeRowSecondLine(curated)).toBe('Search Acme docs.');
    expect(customizeRowSecondLine(local)).toBe('Tools on this machine.');
  });

  it('names a marketplace plugin’s catalog on the second line (CAN-5050)', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({
          kind: 'plugin',
          origin: 'marketplace',
          sourceLabel: 'Claude · slackapi',
          ref: {
            type: 'marketplace-plugin',
            marketplaceId: 'claude',
            pluginName: 'slack',
          },
        }),
      ),
    ).toBe('Claude · slackapi');
  });

  it('returns undefined when nothing names the source', () => {
    const local = makeEntry({
      sourceLabel: 'Local',
      ref: { type: 'skill', sourceId: 'local:user', skillName: 'alpha' },
    });
    expect(customizeRowSourceLine(local)).toBeUndefined();
  });
});

describe('customizeRowSecondLine', () => {
  it('prefers the source line', () => {
    expect(customizeRowSecondLine(makeEntry({ custom: true }))).toBe(
      'Created by you',
    );
  });

  it('falls back to the description when no source is worth naming', () => {
    expect(
      customizeRowSecondLine(
        makeEntry({
          kind: 'plugin',
          origin: 'marketplace',
          description: 'Read and manage Slack',
          sourceLabel: ' ',
          ref: {
            type: 'marketplace-plugin',
            marketplaceId: 'claude',
            pluginName: 'slack',
          },
        }),
      ),
    ).toBe('Read and manage Slack');
  });

  it('prefers the marketplace catalog to the description without clipping its copy', () => {
    expect(
      customizeRowSecondLine(
        makeEntry({
          kind: 'plugin',
          origin: 'marketplace',
          sourceLabel: '  Claude · Demo Market  ',
          description: 'A plugin description.',
          ref: {
            type: 'marketplace-plugin',
            marketplaceId: 'demo',
            pluginName: 'demo',
          },
        }),
      ),
    ).toBe('Claude · Demo Market');
  });

  it('is absent when neither a source nor a description exists', () => {
    expect(
      customizeRowSecondLine(
        makeEntry({
          description: ' ',
          ref: { type: 'skill', sourceId: 'local:user', skillName: 'alpha' },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('pendingSignInLabel', () => {
  it('counts sign-ins with the right plural', () => {
    expect(pendingSignInLabel(1)).toBe('1 sign-in pending');
    expect(pendingSignInLabel(2)).toBe('2 sign-ins pending');
  });
});

describe('removal copy', () => {
  it('deletes what the viewer created', () => {
    expect(removalVerb(makeEntry({ custom: true }))).toBe('Delete');
    expect(
      removalVerb(
        makeEntry({
          kind: 'collection',
          origin: 'custom',
          ref: { type: 'local-collection', collectionId: 'c1' },
        }),
      ),
    ).toBe('Delete');
    expect(
      removalVerb(
        makeEntry({
          kind: 'agent',
          origin: 'custom',
          ref: { type: 'local-agent', agentId: 'a1' },
        }),
      ),
    ).toBe('Delete');
  });

  it('removes apps and collections others made', () => {
    expect(
      removalVerb(
        makeEntry({ kind: 'app', ref: { type: 'local-mcp', serverId: 's1' } }),
      ),
    ).toBe('Remove');
    expect(
      removalVerb(
        makeEntry({
          kind: 'collection',
          origin: 'shared',
          ref: { type: 'shared-collection', collectionId: 'c1' },
        }),
      ),
    ).toBe('Remove');
  });

  it('uninstalls plugins and installed skills', () => {
    expect(
      removalVerb(
        makeEntry({
          kind: 'plugin',
          origin: 'marketplace',
          ref: {
            type: 'marketplace-plugin',
            marketplaceId: 'demo/market',
            pluginName: 'gamma',
          },
        }),
      ),
    ).toBe('Uninstall');
    expect(removalVerb(makeEntry())).toBe('Uninstall');
  });

  it('builds the menu label and confirmation title from the verb', () => {
    const app = makeEntry({
      kind: 'app',
      name: 'Slack',
      ref: { type: 'local-mcp', serverId: 's1' },
    });
    expect(removalMenuLabel(app)).toBe('Remove…');
    expect(removalConfirmTitle(app)).toBe('Remove Slack?');
    expect(removalMenuLabel(makeEntry({ custom: true }))).toBe('Delete…');
    expect(removalMenuLabel(makeEntry())).toBe('Uninstall…');
  });

  it('names the busy state and fallback error for every verb', () => {
    expect(removalBusyLabel('Uninstall')).toBe('Uninstalling…');
    expect(removalBusyLabel('Remove')).toBe('Removing…');
    expect(removalBusyLabel('Delete')).toBe('Deleting…');
    expect(removalFallbackError('Uninstall')).toBe(
      'Could not uninstall. Try again.',
    );
    expect(removalFallbackError('Remove')).toBe('Could not remove. Try again.');
    expect(removalFallbackError('Delete')).toBe('Could not delete. Try again.');
  });
});

describe('updateMenuLabel', () => {
  it('names the version when one is known', () => {
    expect(updateMenuLabel('1.3.0')).toBe('Update to v1.3.0');
    expect(updateMenuLabel('v1.3.0')).toBe('Update to v1.3.0');
  });

  it('reads Update when the version is unknown', () => {
    expect(updateMenuLabel(undefined)).toBe('Update');
    expect(updateMenuLabel(' ')).toBe('Update');
  });
});

describe('sharedByMeLine', () => {
  const LINK_SINCE = '2026-09-26T12:00:00.000Z';
  const shared = (
    overrides: Partial<UnifiedPluginEntry> = {},
  ): UnifiedPluginEntry => makeEntry({ origin: 'shared', ...overrides });

  it('names a team audience without its kind, then the short share date', () => {
    expect(
      sharedByMeLine(
        shared({
          sharedWith: { audience: 'team', name: 'Growth' },
          sharedSince: SINCE,
        }),
      ),
    ).toEqual({
      audience: 'Growth',
      since: sharedByYouSinceLabel(SINCE),
      publicLink: false,
    });
  });

  it('names an organization audience without its kind', () => {
    expect(
      sharedByMeLine(
        shared({
          sharedWith: { audience: 'organization', name: 'Northwind' },
        }),
      ),
    ).toEqual({ audience: 'Northwind', publicLink: false });
  });

  it.each([
    [{ audience: 'team' as const }, 'Team'],
    [{ audience: 'team' as const, name: '  ' }, 'Team'],
    [{ audience: 'organization' as const }, 'Organization'],
    [{ audience: 'organization' as const, personal: true }, 'Personal'],
  ])('falls back to the audience kind for %j', (sharedWith, audience) => {
    expect(sharedByMeLine(shared({ sharedWith }))?.audience).toBe(audience);
  });

  it('uses the detail card date format and drops a date that does not parse', () => {
    expect(sharedByMeLine(shared({ sharedSince: SINCE }))).toEqual({
      since: sharedByYouSinceLabel(SINCE),
      publicLink: false,
    });
    expect(
      sharedByMeLine(
        shared({
          sharedWith: { audience: 'team', name: 'Growth' },
          sharedSince: 'not-a-date',
        }),
      ),
    ).toEqual({ audience: 'Growth', publicLink: false });
  });

  it.each([
    ['dated', { since: LINK_SINCE, upToDate: true }],
    ['empty', {}],
    ['stale', { since: LINK_SINCE, upToDate: false }],
  ])('marks a %s public link', (_label, publicShare) => {
    expect(
      sharedByMeLine(
        shared({
          sharedWith: { audience: 'organization', name: 'Northwind' },
          publicShare,
        }),
      )?.publicLink,
    ).toBe(true);
  });

  it('titles the badge with the link date, distinct from the share date', () => {
    const line = sharedByMeLine(
      shared({
        sharedWith: { audience: 'organization', name: 'Northwind' },
        sharedSince: SINCE,
        publicShare: { since: LINK_SINCE },
      }),
    );
    expect(line).toEqual({
      audience: 'Northwind',
      since: sharedByYouSinceLabel(SINCE),
      publicLink: true,
      publicLinkTitle: `Public link · ${sharedByYouSinceLabel(LINK_SINCE)}`,
    });
    expect(line?.since).not.toBe(sharedByYouSinceLabel(LINK_SINCE));
  });

  it('omits the badge title without a valid link date', () => {
    expect(sharedByMeLine(shared({ publicShare: { since: 'nope' } }))).toEqual({
      publicLink: true,
    });
    expect(
      sharedByMeLine(
        shared({ sharedWith: { audience: 'team', name: 'Growth' } }),
      )?.publicLinkTitle,
    ).toBeUndefined();
  });

  it('shows a public-link-only entry without inventing an audience or date', () => {
    expect(
      sharedByMeLine(shared({ publicShare: { since: LINK_SINCE } })),
    ).toEqual({
      publicLink: true,
      publicLinkTitle: `Public link · ${sharedByYouSinceLabel(LINK_SINCE)}`,
    });
  });

  it('returns undefined when nothing is known', () => {
    expect(sharedByMeLine(shared())).toBeUndefined();
  });
});

describe('customizeRowSourceLine — receipt attribution (CAN-5223)', () => {
  const custom = (
    installedFrom: UnifiedPluginEntry['installedFrom'],
  ): UnifiedPluginEntry =>
    makeEntry({
      custom: true,
      ...(installedFrom ? { installedFrom } : {}),
      ref: { type: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
    });

  it.each([
    [
      { sharedByName: 'Ada', ownerName: 'Northwind' },
      'Shared by Ada · Northwind',
    ],
    [{ sharedByName: 'Ada' }, 'Shared by Ada'],
    [{ ownerName: 'Northwind' }, 'Shared · Northwind'],
    [{ sharedByName: ' ', ownerName: '' }, 'Shared'],
    [{}, 'Shared'],
    [{ teamName: 'Design' }, 'Shared'],
  ])('names a receipted copy %j as %s', (installedFrom, line) => {
    const entry = custom(installedFrom);
    expect(customizeRowSourceLine(entry)).toBe(line);
    expect(entry.custom).toBe(true);
  });

  it('keeps Created by you for a custom skill without a receipt', () => {
    expect(customizeRowSourceLine(custom(undefined))).toBe('Created by you');
  });

  it('still names a bundling plugin before the receipt', () => {
    expect(
      customizeRowSourceLine({
        ...custom({ sharedByName: 'Ada' }),
        bundledBy: { entryId: 'mkt:a/b/slack', name: 'Slack' },
      }),
    ).toBe('From the Slack plugin');
  });

  it('keeps receipt attribution when the copy also has an edit date', () => {
    const entry = {
      ...custom({ sharedByName: 'Ada', ownerName: 'Northwind' }),
      editedAt: '2026-10-10T12:00:00.000Z',
    };
    expect(customizeRowSourceLine(entry)).toBe('Shared by Ada · Northwind');
    expect(customizeRowEditedLine(entry)).toBeUndefined();
  });

  it('keeps Delete for a receipted custom copy', () => {
    expect(removalVerb(custom({ sharedByName: 'Ada' }))).toBe('Delete');
  });
});

it('preserves added collection ownership before local/custom shortcuts', () => {
  const added = makeEntry({
    kind: 'collection',
    custom: true,
    ownedByViewer: false,
    sharedSource: { remoteId: 's1', sharedBy: 'Priya Shah' },
    ref: { type: 'local-collection', collectionId: 'c1' },
  });
  expect(customizeRowSourceLine(added)).toBe('Shared by Priya Shah');
  expect(removalVerb(added)).toBe('Remove');
});

describe('CAN-4844 — custom and bundled skill copy', () => {
  it('names the edit date on a custom skill', () => {
    expect(
      customizeRowSourceLine(
        makeEntry({ custom: true, editedAt: '2026-10-10T12:00:00.000Z' }),
      ),
    ).toBe('Created by you · Edited Oct 10, 2026');
  });

  it('splits the dated line into the parts the source line joins', () => {
    const dated = makeEntry({
      custom: true,
      editedAt: '2026-10-10T12:00:00.000Z',
    });
    const parts = customizeRowEditedLine(dated);
    expect(parts).toEqual({
      lead: 'Created by you ·',
      edited: 'Edited Oct 10, 2026',
    });
    expect(`${parts?.lead} ${parts?.edited}`).toBe(
      customizeRowSourceLine(dated),
    );
    expect(customizeRowEditedLine(makeEntry({ custom: true }))).toBeUndefined();
    expect(
      customizeRowEditedLine(makeEntry({ editedAt: '2026-10-10T12:00:00Z' })),
    ).toBeUndefined();
    expect(
      customizeRowEditedLine(
        makeEntry({
          custom: true,
          editedAt: '2026-10-10T12:00:00.000Z',
          bundledBy: { entryId: 'mkt:a/slack', name: 'Slack' },
        }),
      ),
    ).toBeUndefined();
  });

  it('omits Edited when the custom skill has no edit date', () => {
    expect(customizeRowSourceLine(makeEntry({ custom: true }))).toBe(
      'Created by you',
    );
    expect(
      customizeRowSourceLine(makeEntry({ custom: true, editedAt: '' })),
    ).toBe('Created by you');
    expect(
      customizeRowSourceLine(
        makeEntry({ custom: true, editedAt: 'not-a-date' }),
      ),
    ).toBe('Created by you');
  });

  it('recognizes a plugin-bundled skill', () => {
    const bundled = makeEntry({
      bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
      ref: {
        type: 'plugin-skill',
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
        skillName: 'review',
      },
    });
    expect(isBundledSkill(bundled)).toBe(true);
    expect(isBundledSkill(makeEntry())).toBe(false);
    expect(
      isBundledSkill(
        makeEntry({
          kind: 'app',
          bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
        }),
      ),
    ).toBe(false);
    expect(bundledSkillStatusReason('Slack')).toBe(
      'Set by the Slack plugin. Change it on the plugin.',
    );
    expect(customizeRowSourceLine(bundled)).toBe('From the Slack plugin');
  });
});
