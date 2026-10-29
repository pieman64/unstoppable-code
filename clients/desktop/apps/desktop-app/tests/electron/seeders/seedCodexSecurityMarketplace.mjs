import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './fsHelpers.mjs';

export const CODEX_SECURITY_MARKETPLACE_ID = 'openai-curated';
export const CODEX_SECURITY_PLUGIN_NAME = 'codex-security';
export const MANAGED_BUILTIN_MARKETPLACE_NAME = 'canopy-plugins';

const ISO = '2026-08-20T00:00:00.000Z';
const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_CODEX_APP_SERVER_PATH = path.resolve(
  currentDir,
  '../fixtures/fake-codex-app-server.mjs',
);

function pluginSummary(pluginRoot) {
  return {
    id: `${CODEX_SECURITY_PLUGIN_NAME}@${CODEX_SECURITY_MARKETPLACE_ID}`,
    remotePluginId: null,
    version: '1.0.0',
    localVersion: '1.0.0',
    name: CODEX_SECURITY_PLUGIN_NAME,
    shareContext: null,
    source: { type: 'local', path: pluginRoot },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: 'allowed',
    installPolicySource: null,
    mustShowInstallationInterstitial: false,
    authPolicy: 'none',
    availability: 'available',
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: {
      displayName: 'Codex Security',
      shortDescription: 'Deterministic security review fixture',
      developerName: 'OpenAI',
      category: 'Developer Tools',
      websiteUrl: null,
    },
    keywords: ['security'],
  };
}

/**
 * Seed a poisoned v2 cache plus the on-disk and app-server evidence needed to
 * repair the built-in Codex marketplace deterministically.
 *
 * @param {{ userDataDir: string }} options
 */
export function seedPoisonedCodexSecurityMarketplace(options) {
  const { userDataDir } = options ?? {};
  if (!userDataDir) {
    throw new Error(
      'seedPoisonedCodexSecurityMarketplace requires userDataDir',
    );
  }

  const marketplaceRoot = path.join(
    userDataDir,
    'provider-state',
    'codex',
    '.tmp',
    'plugins',
  );
  const pluginRoot = path.join(
    marketplaceRoot,
    'plugins',
    CODEX_SECURITY_PLUGIN_NAME,
  );
  const marketplacePath = path.join(
    marketplaceRoot,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const codexStatePath = path.join(userDataDir, 'codex-state.json');
  const codexLogPath = path.join(userDataDir, 'codex-protocol.jsonl');
  const pluginFixturePath = path.join(userDataDir, 'codex-plugin-fixture.json');
  const summary = pluginSummary(pluginRoot);
  const marketplace = {
    name: CODEX_SECURITY_MARKETPLACE_ID,
    path: marketplacePath,
    interface: { displayName: 'OpenAI Curated' },
    plugins: [summary],
  };

  writeJson(marketplacePath, {
    name: CODEX_SECURITY_MARKETPLACE_ID,
    plugins: [
      {
        name: CODEX_SECURITY_PLUGIN_NAME,
        source: `plugins/${CODEX_SECURITY_PLUGIN_NAME}`,
      },
    ],
  });
  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: CODEX_SECURITY_PLUGIN_NAME,
    description: 'Deterministic security review fixture',
    version: '1.0.0',
    author: { name: 'OpenAI' },
  });
  writeJson(cachePath, {
    version: 2,
    lastRefreshed: ISO,
    marketplaces: [
      {
        id: CODEX_SECURITY_MARKETPLACE_ID,
        name: 'OpenAI Curated',
        sourceType: 'codex',
        sourceUrl: CODEX_SECURITY_MARKETPLACE_ID,
        installLocation: marketplaceRoot,
        lastUpdated: ISO,
        pluginCount: 0,
        plugins: [],
        validProviders: [],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: ISO,
            error: 'Marketplace is available only through Codex.',
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: ISO,
            marketplaceName: CODEX_SECURITY_MARKETPLACE_ID,
            installLocation: marketplaceRoot,
            error:
              "marketplace 'openai-curated' is not configured as a Git marketplace",
          },
        },
      },
    ],
  });
  writeJson(path.join(userDataDir, 'built-in-plugin-marketplaces.json'), {
    version: 1,
    entries: [
      {
        provider: 'codex',
        marketplaceName: MANAGED_BUILTIN_MARKETPLACE_NAME,
        sourceRoot: marketplaceRoot,
        brandId: 'canopy',
        recordedAt: ISO,
      },
    ],
  });
  writeJson(codexStatePath, { nextThread: 1, nextTurn: 1, threads: {} });
  writeJson(pluginFixturePath, {
    pluginList: {
      marketplaces: [marketplace],
      marketplaceLoadErrors: [],
      featuredPluginIds: [
        `${CODEX_SECURITY_PLUGIN_NAME}@${CODEX_SECURITY_MARKETPLACE_ID}`,
      ],
    },
    pluginInstalled: {
      marketplaces: [marketplace],
      marketplaceLoadErrors: [],
    },
    rejectedUpgradeMarketplaceNames: [CODEX_SECURITY_MARKETPLACE_ID],
  });

  return {
    cachePath,
    codexLogPath,
    marketplaceRoot,
    pluginFixturePath,
    env: {
      CODEX_EXECUTABLE: FAKE_CODEX_APP_SERVER_PATH,
      CANOPY_E2E_CODEX_LOG_PATH: codexLogPath,
      CANOPY_E2E_CODEX_STATE_PATH: codexStatePath,
      CANOPY_E2E_CODEX_PLUGIN_FIXTURE_PATH: pluginFixturePath,
    },
  };
}
