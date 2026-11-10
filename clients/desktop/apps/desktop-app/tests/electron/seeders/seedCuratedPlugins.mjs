import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

const ISO = '2026-06-17T00:00:00.000Z';

// Mirrors `CURATED_PLUGIN_MARKETPLACE_ID` / `CURATED_PLUGIN_MARKETPLACE_SOURCE_URL`
// in `packages/execution-engine/src/types/plugins.ts`. Kept as literals here
// (this is a plain .mjs harness fixture, not part of the TS build graph).
const CURATED_MARKETPLACE_ID = 'curated/cloud';
const CURATED_MARKETPLACE_SOURCE_URL = 'curated:cloud';
// Mirrors `getCuratedPluginMarketplaceName()` / the curated display name in
// `apps/desktop-app/src/main/plugins/curated-plugin-sync.ts` and
// `curated-plugin-marketplace.ts` for the default `canopy` brand
// (`brands/canopy/brand.json`: displayName "Canopy", internalName "canopy").
// This is fixture/test data, not user-facing product copy, so it is exempt
// from the brand-neutral UI-copy rule (see CLAUDE.md "Branding").
const CURATED_MARKETPLACE_PROVIDER_NAME = 'canopy-curated';
const CURATED_MARKETPLACE_DISPLAY_NAME = 'Canopy Curated Marketplace';
const CURATED_MARKETPLACE_DESCRIPTION =
  'Curated plugins synced from the Canopy catalog.';

const EMPTY_DETAILS = () => ({
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
});

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The two seeded curated plugins. `writer-toolkit` covers the skill
 * materialization path (SKILL.md + one extra file); `repo-search` covers the
 * `.mcp.json` materialization path. Field names mirror
 * `CuratedPluginEntry`/`PluginProviderFacet` in
 * `apps/desktop-app/src/main/plugins/curated-plugin-sync.ts` and
 * `packages/execution-engine/src/types/plugins.ts`.
 */
const PLUGIN_DEFS = [
  {
    key: 'writer-toolkit',
    displayName: 'Writer Toolkit',
    shortDescription: 'Drafting and editing helpers for long-form writing.',
    version: '1.2.0',
    authorName: 'Canopy Curated',
    category: 'productivity',
    recommended: true,
    docsUrl: 'https://example.com/docs/writer-toolkit',
    skill: {
      key: 'drafting-notes',
      name: 'Drafting Notes',
      description: 'Capture and organize drafting notes.',
    },
    mcpServer: null,
  },
  {
    key: 'repo-search',
    displayName: 'Repo Search',
    shortDescription:
      'Search across repository content via a hosted MCP server.',
    version: '0.9.0',
    authorName: 'Canopy Curated',
    category: 'developer-tools',
    docsUrl: 'https://example.com/docs/repo-search',
    skill: null,
    mcpServer: {
      key: 'repo-search',
      url: 'https://mcp.example.com/repo-search',
    },
  },
];

function writeText(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function claudePluginManifest(def, hasMcpServers) {
  return {
    name: def.key,
    version: def.version,
    description: def.shortDescription,
    author: { name: def.authorName },
    homepage: def.docsUrl,
    ...(hasMcpServers ? { mcpServers: './.mcp.json' } : {}),
  };
}

function codexPluginManifest(def, hasMcpServers) {
  return {
    ...claudePluginManifest(def, hasMcpServers),
    ...(def.skill ? { skills: './skills/' } : {}),
    interface: { displayName: def.displayName },
  };
}

function claudeMarketplaceEntry(def) {
  return {
    name: def.key,
    description: def.shortDescription,
    version: def.version,
    source: `./${def.key}`,
    category: def.category,
    author: { name: def.authorName },
    homepage: def.docsUrl,
    ...(def.recommended ? { recommended: true } : {}),
  };
}

function codexMarketplaceEntry(def) {
  return {
    name: def.key,
    source: { source: 'local', path: `./${def.key}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: def.category,
    author: { name: def.authorName },
  };
}

/**
 * Materializes one plugin directory the way
 * `apps/desktop-app/src/main/plugins/curated-plugin-sync.ts` `stagePlugin` +
 * `writeStagedManifests`/`writeStagedSkills` would: both provider manifests,
 * an optional `.mcp.json`, and an optional `skills/<key>/...` tree with a
 * SKILL.md plus one extra file.
 *
 * Returns the sync-lock entry for this plugin (see
 * `CuratedPluginSyncLockEntry`) — `files` maps each materialized
 * skill-relative path to a real sha256 of its written bytes. NOTE: verified
 * against `scanCuratedMarketplaceUncached()` in
 * `curated-plugin-marketplace.ts` — the scan path only JSON.parses the
 * manifests and walks the skills directory; it never re-hashes file content
 * against the lock, so these hashes are for fixture fidelity only and are not
 * read back by anything under test.
 */
function materializePlugin(marketplaceDir, def) {
  const pluginDir = path.join(marketplaceDir, def.key);
  const hasMcpServers = !!def.mcpServer;

  writeJson(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    claudePluginManifest(def, hasMcpServers),
  );
  writeJson(
    path.join(pluginDir, '.codex-plugin', 'plugin.json'),
    codexPluginManifest(def, hasMcpServers),
  );

  const files = {};
  const curatedMcpKeys = [];

  if (def.mcpServer) {
    const mcpJson = {
      mcpServers: {
        [def.mcpServer.key]: { type: 'http', url: def.mcpServer.url },
      },
    };
    writeJson(path.join(pluginDir, '.mcp.json'), mcpJson);
    curatedMcpKeys.push(def.mcpServer.key);
  }

  if (def.skill) {
    const skillDir = path.join(pluginDir, 'skills', def.skill.key);
    const skillMd = [
      '---',
      `name: ${def.skill.name}`,
      `description: ${def.skill.description}`,
      '---',
      '',
      `# ${def.skill.name}`,
      '',
      `Guidance for ${def.skill.description.toLowerCase()}`,
      '',
    ].join('\n');
    const referenceMd = [
      '# Reference',
      '',
      `Extra reference material for the ${def.skill.name} skill.`,
      '',
    ].join('\n');
    writeText(path.join(skillDir, 'SKILL.md'), skillMd);
    writeText(path.join(skillDir, 'reference.md'), referenceMd);
    files[`skills/${def.skill.key}/SKILL.md`] = sha256(skillMd);
    files[`skills/${def.skill.key}/reference.md`] = sha256(referenceMd);
  }

  return {
    contentHash: sha256(`${def.key}@${def.version}`),
    version: def.version,
    syncedAt: ISO,
    files,
    curatedMcpKeys,
  };
}

/**
 * Builds the `PluginInfo` row `scanCuratedMarketplace()` would produce for a
 * materialized plugin: both facets populated (native/native — curated
 * plugins are never `externalSource`d, they are already local once
 * materialized), `curated: true`, and a not-yet-installed
 * `globalInstallStatus` so `BuiltInProviderInstallPanel` renders both install
 * rows. See `mergeProviderPluginFacets()` / `withManagedPluginInstallStatus()`
 * in `apps/desktop-app/src/main/plugins/plugin-service.ts`.
 */
function buildPluginInfo(
  marketplaceDir,
  claudeManifestPath,
  codexManifestPath,
  def,
) {
  const pluginDir = path.join(marketplaceDir, def.key);
  const details = EMPTY_DETAILS();
  if (def.skill) {
    details.skills.push({
      name: def.skill.name,
      description: def.skill.description,
      path: path.posix.join('skills', def.skill.key),
    });
  }
  if (def.mcpServer) {
    details.mcpServers.push({
      name: def.mcpServer.key,
      type: 'http',
      url: def.mcpServer.url,
    });
  }

  const claudeFacet = {
    provider: 'claude',
    mode: 'native',
    name: def.key,
    description: def.shortDescription,
    version: def.version,
    author: def.authorName,
    category: def.category,
    homepage: def.docsUrl,
    installLocation: pluginDir,
    sourcePath: `./${def.key}`,
    marketplacePath: claudeManifestPath,
    details,
  };
  const codexFacet = {
    provider: 'codex',
    mode: 'native',
    name: def.key,
    displayName: def.displayName,
    description: def.shortDescription,
    version: def.version,
    author: def.authorName,
    category: def.category,
    homepage: def.docsUrl,
    installLocation: pluginDir,
    sourcePath: pluginDir,
    marketplacePath: codexManifestPath,
    details,
  };

  return {
    name: def.key,
    displayName: def.displayName,
    description: def.shortDescription,
    version: def.version,
    author: def.authorName,
    category: def.category,
    homepage: def.docsUrl,
    sourcePath: `./${def.key}`,
    marketplaceId: CURATED_MARKETPLACE_ID,
    details,
    curated: true,
    recommended: def.recommended === true,
    globalInstallStatus: {
      claude: { available: true, installed: false },
      codex: { available: true, installed: false },
      checkedAt: ISO,
    },
    providerSupport: { claude: 'native', codex: 'native' },
    facets: { claude: claudeFacet, codex: codexFacet },
  };
}

function readExistingCache(cacheFilePath) {
  if (!existsSync(cacheFilePath)) {
    return { version: 2, lastRefreshed: ISO, marketplaces: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
    if (parsed && parsed.version === 2 && Array.isArray(parsed.marketplaces)) {
      return parsed;
    }
  } catch {
    // Fall through to a fresh v2 cache below.
  }
  return { version: 2, lastRefreshed: ISO, marketplaces: [] };
}

/**
 * Seeds a materialized curated plugin marketplace: the on-disk tree the sync
 * engine (`curated-plugin-sync.ts`) would produce, its sync lock, and a
 * `curated/cloud` row merged into `<userDataDir>/plugins-cache.json`.
 *
 * Following `seedPluginsCache.mjs` conventions: writes/merges the v2
 * `plugins-cache.json` a real `getPluginsCacheFilePath()` read would see, and
 * documents the main-process reader.
 *
 * Main-process reader: `apps/desktop-app/src/main/plugins/plugin-service.ts`
 *   `getPluginsCacheFilePath()` → `path.join(getDataDir(), 'plugins-cache.json')`
 *
 * IMPORTANT E2E-build wrinkle (verified against `loadMarketplaces()` in
 * `plugin-service.ts`): under `isE2eBuild()`, a cached v2 marketplaces array
 * is served AS-IS — `mergeManagedMarketplaces()` (which would scan
 * `curated-plugins/marketplace/` fresh on every load) is skipped entirely.
 * So the seeded `plugins-cache.json` row, not the on-disk tree, is what the
 * renderer actually sees. The on-disk tree is still materialized here for
 * fixture fidelity (byte-for-byte layout parity with what the real sync
 * engine writes) and so a future test that opens a seeded skill's content via
 * `plugins:read-component` resolves real files.
 *
 * Merges into (rather than overwriting) any existing `plugins-cache.json`, so
 * this can be layered on top of `seedPluginsCache()` in the same test.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {Array<object>} [options.pluginDefs] plugin definitions in the
 *   `PLUGIN_DEFS` shape; defaults to the two standard plugins. A def's
 *   `mcpServer.key` is the curated MCP catalog key the plugin declares, so a
 *   spec can seed a plugin that folds into an integration card (REG-3033).
 * @returns {{
 *   cacheFilePath: string,
 *   marketplaceDir: string,
 *   syncLockFilePath: string,
 *   pluginKeys: string[],
 * }}
 */
export function seedCuratedPlugins(options) {
  const { userDataDir, pluginDefs = PLUGIN_DEFS } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedCuratedPlugins requires userDataDir');
  }
  if (!Array.isArray(pluginDefs) || pluginDefs.length === 0) {
    throw new Error('seedCuratedPlugins requires a non-empty pluginDefs');
  }

  const curatedRoot = path.join(userDataDir, 'curated-plugins');
  const marketplaceDir = path.join(curatedRoot, 'marketplace');
  const claudeManifestPath = path.join(
    marketplaceDir,
    '.claude-plugin',
    'marketplace.json',
  );
  const codexManifestPath = path.join(
    marketplaceDir,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  const syncLockFilePath = path.join(curatedRoot, 'sync-lock.json');

  // 1. Materialize each plugin directory + collect its sync-lock entry.
  const lockPlugins = {};
  for (const def of pluginDefs) {
    lockPlugins[def.key] = materializePlugin(marketplaceDir, def);
  }

  // 2. Materialize both marketplace manifests (same relative locations the
  //    bundled built-in marketplace uses — see curated-plugin-sync.ts header).
  writeJson(claudeManifestPath, {
    name: CURATED_MARKETPLACE_PROVIDER_NAME,
    version: '1.0.0',
    description: 'Curated plugin marketplace for Canopy.',
    metadata: { description: CURATED_MARKETPLACE_DESCRIPTION },
    owner: { name: 'Canopy' },
    plugins: pluginDefs.map(claudeMarketplaceEntry),
  });
  writeJson(codexManifestPath, {
    name: CURATED_MARKETPLACE_PROVIDER_NAME,
    interface: { displayName: CURATED_MARKETPLACE_DISPLAY_NAME },
    plugins: pluginDefs.map(codexMarketplaceEntry),
  });

  // 3. Sync lock consistent with the materialized tree.
  writeJson(syncLockFilePath, {
    version: 1,
    syncedAt: ISO,
    plugins: lockPlugins,
  });

  // 4. Merge the curated marketplace row into plugins-cache.json, mirroring
  //    the shape `scanCuratedMarketplace()` builds in
  //    `curated-plugin-marketplace.ts`.
  const plugins = pluginDefs.map((def) =>
    buildPluginInfo(marketplaceDir, claudeManifestPath, codexManifestPath, def),
  );
  const providerStatusFor = (provider, marketplacePath) => ({
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: plugins.length,
    lastCheckedAt: ISO,
    marketplaceName: CURATED_MARKETPLACE_PROVIDER_NAME,
    marketplacePath,
    installLocation: marketplaceDir,
  });
  const curatedMarketplace = {
    id: CURATED_MARKETPLACE_ID,
    name: CURATED_MARKETPLACE_DISPLAY_NAME,
    description: CURATED_MARKETPLACE_DESCRIPTION,
    sourceType: 'curated',
    sourceUrl: CURATED_MARKETPLACE_SOURCE_URL,
    installLocation: marketplaceDir,
    lastUpdated: ISO,
    builtIn: false,
    curated: true,
    removable: false,
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: providerStatusFor('claude', claudeManifestPath),
      codex: providerStatusFor('codex', codexManifestPath),
    },
    validProviders: ['claude', 'codex'],
  };

  const cacheFilePath = path.join(userDataDir, 'plugins-cache.json');
  const existing = readExistingCache(cacheFilePath);
  const marketplaces = [
    ...existing.marketplaces.filter((m) => m.id !== CURATED_MARKETPLACE_ID),
    curatedMarketplace,
  ];
  writeJson(cacheFilePath, {
    version: 2,
    lastRefreshed: existing.lastRefreshed || ISO,
    ...(existing.lastProviderRefreshAt
      ? { lastProviderRefreshAt: existing.lastProviderRefreshAt }
      : {}),
    marketplaces,
  });

  return {
    cacheFilePath,
    marketplaceDir,
    syncLockFilePath,
    pluginKeys: pluginDefs.map((def) => def.key),
  };
}
