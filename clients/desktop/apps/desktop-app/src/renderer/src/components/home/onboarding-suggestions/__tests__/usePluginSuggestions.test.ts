/**
 * Pure composition of the onboarding queue's plugin tail: the hardcoded
 * universally-useful entries lead with their exact prompts, selected-role
 * shortlists follow, catalog `recommended` picks remain available after
 * those, and enablement state maps onto add/try steps.
 */

import { PROFILE_ROLES } from '@canopy/protocol/plugin-catalog';
import type { CuratedOnboardingPlugin } from '@/lib/onboarding/curatedOnboardingPlugins';
import {
  composeBlueprintPluginSuggestions,
  composePluginSuggestions,
} from '../usePluginSuggestions';
import { ROLE_PLUGIN_RECOMMENDATIONS } from '@canopy/desktop-shared/lib/role-plugin-recommendations';

function catalogPlugin(
  name: string,
  overrides: Partial<CuratedOnboardingPlugin> = {},
): CuratedOnboardingPlugin {
  return {
    key: `curated/${name}`,
    marketplaceId: 'curated',
    name,
    displayName: name,
    description: `${name} plugin`,
    recommended: false,
    ...overrides,
  };
}

describe('composePluginSuggestions', () => {
  it('provides the catalog-backed shortlist for every work role', () => {
    const catalog = Array.from(
      new Set(Object.values(ROLE_PLUGIN_RECOMMENDATIONS).flat()),
      (name) => catalogPlugin(name),
    );
    for (const role of PROFILE_ROLES) {
      const suggestions = composePluginSuggestions(catalog, new Set(), [role]);
      expect(suggestions.map((row) => row.name)).toEqual(
        ROLE_PLUGIN_RECOMMENDATIONS[role],
      );
      expect(
        suggestions.every((row) => row.recommendationTier === 'role'),
      ).toBe(true);
    }
  });

  it('uses the software-engineer shortlist when no role is selected', () => {
    const catalog = ['vercel', 'snowflake', 'bigquery'].map((name) =>
      catalogPlugin(name),
    );
    const suggestions = composePluginSuggestions(catalog, new Set(), null);
    expect(suggestions.map((row) => row.name)).toEqual([
      'bigquery',
      'snowflake',
      'vercel',
    ]);
    expect(suggestions.every((row) => row.recommendationTier === 'role')).toBe(
      true,
    );
  });

  it.each([
    ['marketing'],
    ['sales'],
    ['marketing', 'sales'],
    ['marketing-sales'],
  ] as const)(
    'includes Salesforce and Airtable once after general tools for %j when catalog-backed',
    (...roles) => {
      const catalog = [
        'salesforce',
        'ahrefs',
        'klaviyo',
        'hubspot',
        'airtable',
        'slack',
        'gmail',
      ].map((name) => catalogPlugin(name));
      const suggestions = composePluginSuggestions(catalog, new Set(), roles);
      expect(suggestions.map((row) => row.name)).toEqual([
        'gmail-gmailmcp',
        'slack',
        'hubspot',
        'klaviyo',
        'ahrefs',
        'salesforce',
        'airtable',
      ]);
      expect(
        suggestions.find((row) => row.name === 'salesforce'),
      ).toMatchObject({
        enabled: false,
        enableKeys: ['curated/salesforce'],
        recommendationTier: 'role',
      });
      expect(suggestions.find((row) => row.name === 'airtable')).toMatchObject({
        enabled: false,
        enableKeys: ['curated/airtable'],
        recommendationTier: 'role',
      });
      expect(
        composePluginSuggestions(
          catalog.filter((plugin) => plugin.name !== 'salesforce'),
          new Set(),
          roles,
        ).some((row) => row.name === 'salesforce'),
      ).toBe(false);
    },
  );

  it('appends each selected role shortlist without duplicates, then catalog recommendations', () => {
    const catalog = [
      catalogPlugin('figma'),
      catalogPlugin('posthog'),
      catalogPlugin('miro'),
      catalogPlugin('amplitude'),
      catalogPlugin('canva'),
      catalogPlugin('airtable', { recommended: true }),
    ];
    const suggestions = composePluginSuggestions(catalog, new Set(), [
      'designer',
      'product-manager',
    ]);
    expect(suggestions.map((row) => row.name)).toEqual([
      'figma',
      'miro',
      'canva',
      'posthog',
      'amplitude',
      'airtable',
    ]);
    expect(suggestions.find((row) => row.name === 'figma')?.promptText).toBe(
      'Summarize the latest changes in my Figma designs and flag what needs review',
    );
    expect(
      suggestions.find((row) => row.name === 'airtable')?.recommendationTier,
    ).toBeUndefined();
  });

  it('never invents a role plugin absent from the active curated catalog', () => {
    const suggestions = composePluginSuggestions(
      [catalogPlugin('posthog')],
      new Set(),
      ['product-manager'],
    );
    expect(suggestions.map((row) => row.name)).toEqual(['posthog']);
  });

  it('keeps the entire recommendation queue available beyond the visible window', () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      catalogPlugin(`tool-${index}`, { recommended: true }),
    );
    const suggestions = composePluginSuggestions(many, new Set());
    expect(
      suggestions.filter((entry) => entry.key.startsWith('curated/')),
    ).toHaveLength(80);
    expect(suggestions).toHaveLength(80);
  });
  it('does not recommend unbundled plugins from an empty catalog', () => {
    const suggestions = composePluginSuggestions([], new Set());
    expect(suggestions).toEqual([]);
  });

  it('leads with available universal entries and their exact prompts', () => {
    const suggestions = composePluginSuggestions(
      [catalogPlugin('gmail'), catalogPlugin('slack')],
      new Set(),
    );
    expect(suggestions.map((s) => s.key)).toEqual([
      'universal:gmail',
      'universal:slack',
    ]);
    expect(suggestions[0].promptText).toBe(
      'Summarize the emails waiting on my reply',
    );
    expect(suggestions[1].promptText).toBe(
      'Are there any threads I need to follow up with in Slack?',
    );
    expect(suggestions[0].enableKeys).toEqual(['curated/gmail']);
    expect(suggestions.map((s) => s.searchQuery)).toEqual(['gmail', 'slack']);
    expect(suggestions.every((s) => !s.enabled)).toBe(true);
  });

  it('keeps Gmail and Google Calendar as separate universal tools', () => {
    const suggestions = composePluginSuggestions(
      [
        catalogPlugin('gmail'),
        catalogPlugin('google-calendar'),
        catalogPlugin('slack'),
      ],
      new Set(),
    );
    const gmail = suggestions.find((s) => s.key === 'universal:gmail');
    expect(gmail?.enableKeys).toEqual(['curated/gmail']);
    const calendar = suggestions.find(
      (s) => s.key === 'universal:google-calendar',
    );
    expect(calendar?.enableKeys).toEqual(['curated/google-calendar']);
    const slack = suggestions.find((s) => s.key === 'universal:slack');
    expect(slack?.enableKeys).toEqual(['curated/slack']);
  });

  it('marks a universal entry enabled when a prompt-backing plugin is enabled', () => {
    const suggestions = composePluginSuggestions(
      [catalogPlugin('google-calendar')],
      new Set(['google-calendar']),
    );
    expect(
      suggestions.find((s) => s.key === 'universal:google-calendar')?.enabled,
    ).toBe(true);
  });

  it('does not advance a universal entry when only a non-prompt plugin is enabled', () => {
    // Drive belongs to the Google group's Add action, but the try prompt
    // asks for Gmail and Calendar — Drive alone must not flip the row.
    const suggestions = composePluginSuggestions(
      [catalogPlugin('gmail')],
      new Set(['google-drive']),
    );
    expect(suggestions.find((s) => s.key === 'universal:gmail')?.enabled).toBe(
      false,
    );
  });

  it('appends recommended catalog picks without duplicating universal coverage', () => {
    const suggestions = composePluginSuggestions(
      [
        catalogPlugin('slack', { recommended: true }),
        catalogPlugin('figma', { recommended: true }),
        catalogPlugin('sentry', { recommended: false }),
      ],
      new Set(),
    );
    const keys = suggestions.map((s) => s.key);
    // Slack is covered by its universal entry; figma joins as a catalog
    // pick; non-recommended sentry stays out.
    expect(keys.filter((key) => key.includes('slack'))).toEqual([
      'universal:slack',
    ]);
    expect(keys).toContain('curated/figma');
    expect(keys).not.toContain('curated/sentry');
  });

  it('uses the curated prompt index for catalog picks with a fallback', () => {
    const suggestions = composePluginSuggestions(
      [
        catalogPlugin('figma', { recommended: true }),
        catalogPlugin('obscure-tool', {
          recommended: true,
          displayName: 'Obscure Tool',
        }),
      ],
      new Set(),
    );
    expect(suggestions.find((s) => s.key === 'curated/figma')?.promptText).toBe(
      'Implement my latest Figma design as code',
    );
    expect(
      suggestions.find((s) => s.key === 'curated/obscure-tool')?.promptText,
    ).toBe('Show me what I can do with Obscure Tool');
  });

  it('does not duplicate services already covered by fixed onboarding steps', () => {
    const suggestions = composePluginSuggestions(
      [
        catalogPlugin('github', { recommended: true }),
        catalogPlugin('linear', { recommended: true }),
        catalogPlugin('datadog', { recommended: true }),
        catalogPlugin('vercel', { recommended: true }),
      ],
      new Set(),
    );
    expect(suggestions.map((entry) => entry.name)).toEqual([
      'datadog',
      'vercel',
    ]);
    expect(
      suggestions.some(
        (entry) => entry.name === 'github' || entry.name === 'linear',
      ),
    ).toBe(false);
  });

  it('prioritizes BigQuery, Snowflake, then Vercel only when catalog-backed', () => {
    const all = composePluginSuggestions(
      ['bigquery', 'snowflake', 'vercel'].map((name) => catalogPlugin(name)),
      new Set(),
      ['software-engineer'],
    );
    expect(all.map((entry) => entry.name)).toEqual([
      'bigquery',
      'snowflake',
      'vercel',
    ]);
    expect(
      composePluginSuggestions(
        [catalogPlugin('bigquery'), catalogPlugin('vercel')],
        new Set(),
        ['software-engineer'],
      ).map((entry) => entry.name),
    ).toEqual(['bigquery', 'vercel']);
  });
});

describe('composeBlueprintPluginSuggestions (CAN-3032)', () => {
  it('maps every template plugin to an add/try input with its live enablement', () => {
    const rows = [
      catalogPlugin('builtin-git', {
        key: 'builtin/builtin-git',
        marketplaceId: 'builtin',
        displayName: 'Git',
        description: 'Git tools',
      }),
      catalogPlugin('slack', { displayName: 'Slack' }),
    ];
    const suggestions = composeBlueprintPluginSuggestions(
      rows,
      new Set(['slack']),
    );
    expect(suggestions.map((row) => row.key)).toEqual([
      'builtin/builtin-git',
      'curated/slack',
    ]);
    const [git, slack] = suggestions;
    expect(git).toMatchObject({
      name: 'builtin-git',
      displayName: 'Git',
      description: 'Git tools',
      enabled: false,
      enableKeys: ['builtin/builtin-git'],
      searchQuery: 'builtin-git',
    });
    expect(git.promptText).toContain('Git');
    expect(git.promptTexts[0]).toBe(git.promptText);
    expect(slack).toMatchObject({
      name: 'slack',
      enabled: true,
      enableKeys: ['curated/slack'],
    });
  });

  it('keeps template plugins out of the general tools shortlist', () => {
    const general = composePluginSuggestions(
      [catalogPlugin('builtin-git', { key: 'builtin/builtin-git' })],
      new Set(),
      ['marketing'],
    );
    expect(general.some((row) => row.name === 'builtin-git')).toBe(false);
  });
});
