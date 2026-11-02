// CAN-3653: shared seed for the Slack plugin-entity flow specs (desktop and
// Portal) and the `.playwright/can-3653/` captures.
//
// Two catalogs publish a Slack plugin that bundles the same hosted MCP
// endpoint, a curated MCP catalog card points at that endpoint, and the
// installed Codex plugin already brought its server into the MCP index. Before
// CAN-3653, searching "slack" listed four look-alike rows; the fixture is the
// smallest shape that reproduces that and the projection's joins.
//
// Mirrors the real rows' shape (checked read-only against a developer's
// `~/.canopy/plugins-cache.json` on 2026-10-23; no values copied beyond public
// catalog metadata):
// - `claude-plugins-official/slack` carries `externalSource {source:'url',
//   url:'https://github.com/slackapi/slack-mcp-plugin.git'}`, v1.0.0,
//   providerSupport {claude: native, codex: compat}, `details` with two skills
//   and one http MCP server `slack`, and no `globalInstallStatus`. The fixture
//   omits its `details`: the desktop counts an external-source plugin with
//   content as installed (`pluginNeedsInstall`), and the flow needs the Claude
//   copy available, in Browse with Add.
// - `openai-curated/slack` ("Codex official") carries NO `externalSource`
//   (none of the 62 `openai-curated` rows does), no `cachePath`, v0.1.7,
//   providerSupport {claude: none, codex: native}, the same bundled server and
//   no skills. The fixture therefore omits `externalSource` and `cachePath` on
//   it too; it marks the row installed through `globalInstallStatus`.
// - No `openai-curated-remote` marketplace was present. 19 same-name pairs
//   across `OVERLAPPING_MARKETPLACE_IDS` have exactly one copy with an
//   `externalSource` (the `claude-plugins-official` one, Slack among them), so
//   they no longer collapse under the package-key rule; `github` and `linear`
//   have none on either side and still collapse by name.
//
// Hosts are deterministic: the MCP endpoint is under `.example` and the Codex
// catalog under `.invalid`. The one github.com URL is the Slack package's
// public source; it is what yields the `Claude · slackapi` source label, and
// it also makes the Claude card ask for the `slackapi` owner avatar. Specs
// assert on test ids and text, never on that logo; a capture without network
// shows the monogram instead. The Codex card wears the bundled Slack mark.
//
// The bundled server is a normal installed server (not needs-auth), so
// Customize hides it behind the Codex plugin; the standalone server stays.
import path from 'node:path';
import { writeJson } from '../seeders/fsHelpers.mjs';
import { seedMcpServers } from '../seeders/seedMcpServers.mjs';

export const CLAUDE_SLACK_ENTRY = 'mkt:claude-plugins-official/slack';
export const CODEX_SLACK_ENTRY = 'mkt:openai-curated/slack';
export const SLACK_CATALOG_ENTRY = 'mcp-catalog:slack';
export const SLACK_BUNDLED_SERVER_ID = 'slack-codex-plugin';
export const STANDALONE_SERVER_ID = 'team-notes';
export const SLACK_MCP_URL = 'https://mcp.slack.example/mcp';

const ISO = '2026-10-23T00:00:00.000Z';

function details({ skills }) {
  return {
    skills,
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [{ name: 'slack', type: 'http', url: SLACK_MCP_URL }],
    lspServers: [],
    hasReadme: false,
  };
}

function providerStatus({ claude, codex, pluginCount }) {
  const row = (provider, valid) => ({
    provider,
    state: valid ? 'valid' : 'invalid',
    accepted: valid,
    pluginCount: valid ? pluginCount : 0,
    lastCheckedAt: ISO,
  });
  return { claude: row('claude', claude), codex: row('codex', codex) };
}

function claudeMarketplace() {
  const plugins = [
    {
      name: 'slack',
      description:
        'Search Slack, read threads, and post messages from your agent.',
      version: '1.0.0',
      author: 'Slack',
      category: 'communication',
      homepage: 'https://example.test/slack',
      sourcePath: '',
      marketplaceId: 'claude-plugins-official',
      // No `details`: not yet materialized, so available on both hosts.
      externalSource: {
        source: 'url',
        url: 'https://github.com/slackapi/slack-mcp-plugin.git',
      },
      globalInstallStatus: null,
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: {},
    },
  ];
  return {
    // The official Claude catalog's display name is its id.
    id: 'claude-plugins-official',
    name: 'claude-plugins-official',
    description: 'Official Claude plugins',
    sourceType: 'github',
    sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
    installLocation: '/tmp/claude-plugins-official',
    lastUpdated: ISO,
    pluginCount: plugins.length,
    plugins,
    providerStatus: providerStatus({
      claude: true,
      codex: false,
      pluginCount: plugins.length,
    }),
    validProviders: ['claude'],
  };
}

function codexMarketplace() {
  const plugins = [
    {
      name: 'slack',
      displayName: 'Slack',
      description: 'Work with Slack channels and messages from Codex.',
      version: '0.1.7',
      author: 'Slack',
      category: 'Communication',
      homepage: 'https://example.test/slack',
      sourcePath: '',
      marketplaceId: 'openai-curated',
      details: details({ skills: [] }),
      // The real row has no `externalSource` and no `cachePath`; see header.
      cachedAt: ISO,
      globalInstallStatus: {
        codex: { available: true, installed: true },
        claude: { available: false, installed: false },
        checkedAt: ISO,
      },
      providerSupport: { claude: 'none', codex: 'native' },
      facets: {},
    },
  ];
  return {
    id: 'openai-curated',
    name: 'Codex official',
    sourceType: 'github',
    // Not github.com: no owner avatar is fetched, and the label falls back to
    // the catalog name (`Codex official`).
    sourceUrl: 'https://github.invalid/openai/curated',
    installLocation: '/tmp/openai-curated',
    lastUpdated: ISO,
    pluginCount: plugins.length,
    plugins,
    providerStatus: providerStatus({
      claude: false,
      codex: true,
      pluginCount: plugins.length,
    }),
    validProviders: ['codex'],
  };
}

function mcpServer({ id, name, description, url }) {
  return {
    definition: {
      id,
      name,
      description,
      type: 'http',
      url,
      createdAt: ISO,
      updatedAt: ISO,
    },
    configs: [
      {
        id: 'default',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: ISO,
        updatedAt: ISO,
      },
    ],
  };
}

/**
 * Seed the Slack plugin-entity fixture into a desktop data dir: the plugins
 * cache (two marketplaces), the curated MCP catalog (one Slack card) and the
 * MCP index (the Codex plugin's Slack server plus a standalone server).
 *
 * The E2E build never refreshes marketplaces at startup, so the seeded cache
 * is served as written. The curated catalog is stamped now: an older stamp
 * makes the app refresh it from a cloud the fixture does not answer.
 *
 * @param {{ userDataDir: string }} options
 * @returns {{ cacheFilePath: string, catalogFilePath: string }}
 */
export function seedSlackPluginEntity({ userDataDir }) {
  if (!userDataDir) {
    throw new Error('seedSlackPluginEntity requires userDataDir');
  }
  const cacheFilePath = path.join(userDataDir, 'plugins-cache.json');
  writeJson(cacheFilePath, {
    version: 2,
    lastRefreshed: ISO,
    lastProviderRefreshAt: ISO,
    marketplaces: [claudeMarketplace(), codexMarketplace()],
  });

  const catalogFilePath = path.join(
    userDataDir,
    'mcp-servers',
    'curated-catalog.json',
  );
  writeJson(catalogFilePath, {
    version: 1,
    fetchedAt: new Date().toISOString(),
    servers: [
      {
        key: 'slack',
        name: 'Slack',
        shortDescription: 'Channels, threads, and messages.',
        url: SLACK_MCP_URL,
        transport: 'http',
        categories: ['communication'],
        popular: false,
        sortOrder: 0,
        updatedAt: ISO,
      },
    ],
  });

  seedMcpServers({
    userDataDir,
    servers: [
      mcpServer({
        id: SLACK_BUNDLED_SERVER_ID,
        name: 'Slack',
        description: 'Installed with the Codex Slack plugin.',
        url: SLACK_MCP_URL,
      }),
      mcpServer({
        id: STANDALONE_SERVER_ID,
        name: 'Team notes MCP',
        description: 'Shared team notes over MCP.',
        url: 'https://notes.example.test/mcp',
      }),
    ],
  });

  return { cacheFilePath, catalogFilePath };
}

/**
 * The curated Slack card as the cloud's curated MCP list serves it, for a
 * Portal spec that answers `/api/cloud/mcp-servers/curated` itself: the web
 * reads its catalog from the cloud, not from the paired desktop.
 */
export const SLACK_CURATED_MCP_SERVER = Object.freeze({
  key: 'slack',
  name: 'Slack',
  shortDescription: 'Channels, threads, and messages.',
  url: SLACK_MCP_URL,
  transport: 'http',
  categories: ['communication'],
  popular: false,
  sortOrder: 0,
  updatedAt: ISO,
});
