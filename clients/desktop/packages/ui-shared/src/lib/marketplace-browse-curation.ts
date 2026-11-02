import type { UnifiedPluginEntry } from './unified-plugin-entry';

interface MarketplaceCategoryDefinition {
  title: string;
  aliases: readonly string[];
  priority: readonly string[];
}

export interface MarketplaceBrowseCategory {
  slug: string;
  title: string;
  entries: UnifiedPluginEntry[];
}

export interface MarketplaceBrowseCuration {
  featured: UnifiedPluginEntry[];
  categories: MarketplaceBrowseCategory[];
}

export interface MarketplaceBrowseCurationOptions {
  /**
   * Host-resolved, ordered plugin names that replace the fixed Featured
   * picks. The lead group then holds only entries that are still available
   * to add and not installed from any source, in this order. Omit to keep
   * the fixed Featured ranking.
   */
  suggestedNames?: readonly string[];
}

const FEATURED_PRIORITY = [
  'Gmail',
  'GitHub',
  'Google Drive',
  'Google Calendar',
  'Notion',
  'Slack',
  'Linear',
  'Figma',
  'Atlassian Rovo',
  'Canva',
  'Granola',
] as const;

const CATEGORY_DEFINITIONS: readonly MarketplaceCategoryDefinition[] = [
  {
    title: 'Productivity',
    aliases: ['productivity'],
    priority: [
      'Granola',
      'Fireflies',
      'Outlook Calendar',
      'Plaud',
      'Otter.ai',
      'Atlassian Rovo',
    ],
  },
  {
    title: 'Creativity',
    aliases: ['creativity', 'creative', 'design'],
    priority: [
      'Canva',
      'Higgsfield',
      'Product Design',
      'Figma',
      'Magnific',
      'HeyGen',
    ],
  },
  {
    title: 'Developer tools',
    aliases: [
      'developer tools',
      'developer-tools',
      'code',
      'engineering',
      'technology',
    ],
    priority: [
      'Datadog (Preview)',
      'Supabase',
      'Vercel',
      'Exa',
      'Neon Postgres',
      'Devpost Hackathons',
    ],
  },
  {
    title: 'Business & operations',
    aliases: [
      'business & operations',
      'business-productivity',
      'sales-and-marketing',
      'commerce-shopping',
      'e-commerce',
    ],
    priority: [
      'Shopify',
      'Zoho CRM',
      'HubSpot',
      'Apollo.io',
      'Webflow',
      'ZoomInfo',
    ],
  },
  {
    title: 'Data & analytics',
    aliases: ['data & analytics', 'data', 'data-analytics', 'analytics'],
    priority: [
      'PostHog',
      'Data Analytics',
      'Mixpanel',
      'BigQuery',
      'MotherDuck',
      'Coupler.io',
    ],
  },
  {
    title: 'Communication',
    aliases: ['communication'],
    priority: [
      'Outlook Email',
      'Superhuman Mail',
      'Teams',
      'Zoom',
      'Hostinger Mail',
      'Mailopoly Inbox',
    ],
  },
  {
    title: 'Education & research',
    aliases: ['education & research', 'education'],
    priority: [
      'Readwise',
      'Acumen by Talarion',
      'Consensus',
      'Sider Scholar',
      'Elicit',
      'SciSpace',
    ],
  },
  {
    title: 'Scientific research',
    aliases: ['scientific research', 'life-sciences', 'health-life-sciences'],
    priority: [
      'Tamarind Bio',
      'Undermind',
      'NVIDIA BioNeMo Agent Toolkit',
      'Biohub ESM',
      'Boltz',
      'Inductive Bio',
    ],
  },
  {
    title: 'Security',
    aliases: ['security'],
    priority: [
      'Codex Security',
      'Malwarebytes',
      'Bitdefender',
      'Vanta',
      'Ansvar Gateway',
      'Is It Legit by M8ven',
    ],
  },
  {
    title: 'Finance',
    aliases: ['finance', 'financial-services'],
    priority: [
      'Longbridge',
      'Interactive Brokers (IBKR)',
      'Public Equity Investing',
      'Quartr',
      'Alpaca',
      'Binance',
    ],
  },
  {
    title: 'Healthcare',
    aliases: ['healthcare', 'health'],
    priority: [
      'Health',
      'Fitness AI Connector',
      'COROS',
      'Tredict',
      'Calorie Tracker',
      'freddy',
    ],
  },
  {
    title: 'Travel',
    aliases: ['travel'],
    priority: [
      'Skyscanner',
      'Trip.com',
      'Flight Network',
      'eDreams',
      'Wikiloc',
      'komoot',
    ],
  },
  {
    title: 'Entertainment',
    aliases: ['entertainment', 'media-entertainment'],
    priority: [
      'Apple Music',
      'Podcast App',
      'Chessy',
      'Ticketmaster',
      'Shazam',
      'Flixor',
    ],
  },
  {
    title: 'Other',
    aliases: ['other'],
    priority: [
      'Indeed',
      'LinkedIn',
      'Tarot',
      'idealista',
      'Ask Tarot Cards',
      'Etsy',
    ],
  },
] as const;

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\(preview\)\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const NAME_ALIASES: Readonly<Record<string, string>> = {
  'google cloud bigquery': 'bigquery',
  'hyperframes by heygen': 'heygen',
  'zoom for claude': 'zoom',
};

function canonicalName(value: string): string {
  const normalized = normalizeName(value);
  return NAME_ALIASES[normalized] ?? normalized;
}

function categorySlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FEATURED_INDEX = new Map(
  FEATURED_PRIORITY.map((name, index) => [canonicalName(name), index]),
);
const CATEGORY_PRIORITY = new Map<string, MarketplaceCategoryDefinition>();
const CATEGORY_ALIAS = new Map<string, MarketplaceCategoryDefinition>();

for (const category of CATEGORY_DEFINITIONS) {
  for (const name of category.priority) {
    CATEGORY_PRIORITY.set(canonicalName(name), category);
  }
  for (const alias of category.aliases) {
    CATEGORY_ALIAS.set(normalizeName(alias), category);
  }
}

function sourcePriority(entry: UnifiedPluginEntry): number {
  // The plugin is the visible entity when a plugin and an MCP card share a
  // display name (CAN-3653): the plugin ships the server plus its skills, and
  // the MCP card stays on the MCP servers tab. What the user already has
  // wins outright, an installed plugin ahead of an installed server it may
  // bundle, and a card that folds in its curated plugin (REG-3033) ranks as
  // that plugin.
  if (entry.state !== 'available') return entry.kind === 'plugin' ? 0 : 1;
  if (entry.ref.type === 'curated-plugin') return 2;
  if (entry.ref.type === 'curated-mcp' && entry.integration?.plugin) return 2;
  if (entry.ref.type === 'marketplace-plugin') {
    return entry.ref.marketplaceId === 'openai-curated' ? 3 : 4;
  }
  if (entry.ref.type === 'curated-mcp') return 5;
  return 6;
}

function dedupeByCapabilityName(
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  const entriesByName = new Map<string, UnifiedPluginEntry>();
  for (const entry of entries) {
    const key = canonicalName(entry.name);
    const existing = entriesByName.get(key);
    if (!existing || sourcePriority(entry) < sourcePriority(existing)) {
      entriesByName.set(key, entry);
    }
  }
  return Array.from(entriesByName.values());
}

function priorityIndex(
  entry: UnifiedPluginEntry,
  priority: readonly string[],
): number {
  const canonical = canonicalName(entry.name);
  const index = priority.findIndex((name) => canonicalName(name) === canonical);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function compareCategoryEntries(
  category: MarketplaceCategoryDefinition,
): (a: UnifiedPluginEntry, b: UnifiedPluginEntry) => number {
  return (a, b) => {
    const priorityDifference =
      priorityIndex(a, category.priority) - priorityIndex(b, category.priority);
    if (priorityDifference !== 0) return priorityDifference;
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const sortOrderDifference =
      (a.catalogSortOrder ?? Number.POSITIVE_INFINITY) -
      (b.catalogSortOrder ?? Number.POSITIVE_INFINITY);
    if (sortOrderDifference !== 0) return sortOrderDifference;
    return a.name.localeCompare(b.name);
  };
}

function categoryForEntry(
  entry: UnifiedPluginEntry,
): MarketplaceCategoryDefinition {
  const explicit = CATEGORY_PRIORITY.get(canonicalName(entry.name));
  if (explicit) return explicit;

  for (const category of entry.categories) {
    const mapped = CATEGORY_ALIAS.get(normalizeName(category));
    if (mapped) return mapped;
  }
  return CATEGORY_DEFINITIONS[CATEGORY_DEFINITIONS.length - 1];
}

function isOneClickInstall(entry: UnifiedPluginEntry): boolean {
  return (
    entry.state === 'available' &&
    (entry.ref.type === 'curated-plugin' ||
      (entry.ref.type === 'marketplace-plugin' &&
        entry.ref.marketplaceId === 'openai-curated'))
  );
}

function featuredPluginSourcePriority(entry: UnifiedPluginEntry): number {
  if (
    entry.ref.type === 'marketplace-plugin' &&
    entry.ref.marketplaceId === 'openai-curated'
  ) {
    return 0;
  }
  if (entry.ref.type === 'curated-plugin') return 1;
  return 2;
}

function dedupeFeaturedPlugins(
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  const pluginsByName = new Map<string, UnifiedPluginEntry>();
  for (const entry of entries) {
    if (!isOneClickInstall(entry)) continue;
    const key = canonicalName(entry.name);
    const existing = pluginsByName.get(key);
    if (
      !existing ||
      featuredPluginSourcePriority(entry) <
        featuredPluginSourcePriority(existing)
    ) {
      pluginsByName.set(key, entry);
    }
  }
  return Array.from(pluginsByName.values());
}

function fixedFeaturedPlugins(
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  return dedupeFeaturedPlugins(entries)
    .filter(
      (entry) =>
        FEATURED_INDEX.has(canonicalName(entry.name)) || entry.recommended,
    )
    .sort((a, b) => {
      const featuredDifference =
        (FEATURED_INDEX.get(canonicalName(a.name)) ??
          Number.POSITIVE_INFINITY) -
        (FEATURED_INDEX.get(canonicalName(b.name)) ?? Number.POSITIVE_INFINITY);
      if (featuredDifference !== 0) return featuredDifference;
      return compareCategoryEntries(categoryForEntry(a))(a, b);
    });
}

/**
 * One addable entry per suggested name, in suggestion order. A name that is
 * installed or needs sign-in from any source is left to the Installed view,
 * so the same capability never appears as both installed and suggested.
 */
function suggestedPlugins(
  entries: readonly UnifiedPluginEntry[],
  suggestedNames: readonly string[],
): UnifiedPluginEntry[] {
  const installed = new Set(
    entries
      .filter((entry) => entry.kind === 'plugin' && entry.state !== 'available')
      .map((entry) => canonicalName(entry.name)),
  );
  const addable = new Map<string, UnifiedPluginEntry>();
  for (const entry of entries) {
    if (entry.state !== 'available') continue;
    if (entry.kind !== 'plugin') continue;
    const key = canonicalName(entry.name);
    const existing = addable.get(key);
    if (
      !existing ||
      featuredPluginSourcePriority(entry) <
        featuredPluginSourcePriority(existing)
    ) {
      addable.set(key, entry);
    }
  }
  const seen = new Set<string>();
  return suggestedNames.flatMap((name) => {
    const key = canonicalName(name);
    const entry = addable.get(key);
    if (!entry || installed.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [entry];
  });
}

/**
 * Canonical capability-name key used to join host-resolved plugin names
 * (for example role recommendations) against browse entries.
 */
export function marketplaceBrowseNameKey(name: string): string {
  return canonicalName(name);
}

/**
 * Turn the mixed capability browse pool into the same compact discovery shape
 * as Codex: one Featured group reserved for plugins with a direct Add
 * action, then consistently named category groups for every capability. The
 * first ten entries are deliberate leaders rather than an alphabetical
 * accident. Search deliberately bypasses this projection.
 */
export function curateMarketplaceBrowse(
  entries: readonly UnifiedPluginEntry[],
  options: MarketplaceBrowseCurationOptions = {},
): MarketplaceBrowseCuration {
  const deduped = dedupeByCapabilityName(entries);
  const featured = options.suggestedNames
    ? suggestedPlugins(entries, options.suggestedNames)
    : fixedFeaturedPlugins(entries);
  const featuredNames = new Set(
    featured.map((entry) => canonicalName(entry.name)),
  );
  const grouped = new Map<
    MarketplaceCategoryDefinition,
    UnifiedPluginEntry[]
  >();

  for (const entry of deduped) {
    if (featuredNames.has(canonicalName(entry.name))) continue;
    const category = categoryForEntry(entry);
    const existing = grouped.get(category);
    if (existing) existing.push(entry);
    else grouped.set(category, [entry]);
  }

  return {
    featured,
    categories: CATEGORY_DEFINITIONS.flatMap((category) => {
      const categoryEntries = grouped.get(category);
      if (!categoryEntries || categoryEntries.length === 0) return [];
      return [
        {
          slug: categorySlug(category.title),
          title: category.title,
          entries: [...categoryEntries].sort(compareCategoryEntries(category)),
        },
      ];
    }),
  };
}
