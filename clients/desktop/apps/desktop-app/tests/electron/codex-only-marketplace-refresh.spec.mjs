import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CODEX_SECURITY_MARKETPLACE_ID,
  CODEX_SECURITY_PLUGIN_NAME,
  FAKE_CODEX_APP_SERVER_PATH,
  MANAGED_BUILTIN_MARKETPLACE_NAME,
  seedPoisonedCodexSecurityMarketplace,
} from './seeders/seedCodexSecurityMarketplace.mjs';

const MARKETPLACE_ID = 'fixture/codex-only';
const ISO = '2026-08-20T00:00:00.000Z';

function writeJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function seedCodexOnlyMarketplace(userDataDir) {
  const marketplaceRoot = path.join(
    userDataDir,
    'provider-state',
    'codex',
    '.tmp',
    'plugins',
  );
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'fixture-plugin');
  writeJson(
    path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    {
      name: 'fixture-codex-only',
      plugins: [{ name: 'fixture-plugin', source: 'plugins/fixture-plugin' }],
    },
  );
  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'fixture-plugin',
    description: 'Deterministic Codex-only fixture',
  });
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: ISO,
    marketplaces: [
      {
        id: MARKETPLACE_ID,
        name: 'Fixture Codex Only',
        sourceType: 'github',
        sourceUrl: marketplaceRoot,
        installLocation: marketplaceRoot,
        lastUpdated: ISO,
        pluginCount: 1,
        plugins: [],
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
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: ISO,
            marketplaceName: 'fixture-codex-only',
            installLocation: marketplaceRoot,
          },
        },
        validProviders: ['codex'],
      },
    ],
  });
}

const STRUCTURAL_MARKETPLACE_ID = 'fixture/codex-structural';
const STRUCTURAL_REVISION = 'fixture0000000000000000000000000000000000';

/**
 * Seed a marketplace whose repository can never produce Codex capabilities
 * (no `.codex-plugin/plugin.json`). Phase B deregisters it from Codex and
 * stamps `structurallyInvalidAtRevision`, which leaves `validProviders` empty
 * and suppresses automatic Codex rechecks until the revision moves.
 *
 * The install root is a plain directory, not a Git checkout, so the startup
 * discovery pass resolves no HEAD revision, takes the "revision unchanged"
 * skip branch and carries the seeded structural stamp forward unmodified.
 * That is what makes this fixture stable across the background refresh.
 */
function seedStructurallyInvalidCodexMarketplace(userDataDir) {
  const marketplaceRoot = path.join(
    userDataDir,
    'provider-state',
    'codex',
    '.tmp',
    'structural-plugins',
  );
  writeJson(
    path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    {
      name: 'fixture-codex-structural',
      plugins: [{ name: 'fixture-plugin', source: 'plugins/fixture-plugin' }],
    },
  );
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: ISO,
    lastProviderRefreshAt: ISO,
    marketplaces: [
      {
        id: STRUCTURAL_MARKETPLACE_ID,
        name: 'Fixture Codex Structural',
        sourceType: 'github',
        sourceUrl: marketplaceRoot,
        installLocation: marketplaceRoot,
        lastUpdated: ISO,
        pluginCount: 0,
        plugins: [],
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
            marketplaceName: 'fixture-codex-structural',
            installLocation: marketplaceRoot,
            error:
              'Marketplace did not contain .codex-plugin/plugin.json for any plugin.',
            structurallyInvalidAtRevision: STRUCTURAL_REVISION,
          },
        },
        validProviders: [],
      },
    ],
  });
}

const SIGNED_OUT_CURATED_MARKETPLACE_ID = 'openai-api-curated';
const SIGNED_OUT_CURATED_PLUGIN_NAMES = ['game-studio', 'superpowers'];
const SIGNED_OUT_CURATED_GIT_PLUGIN_NAME = 'qodo';

function signedOutCuratedPluginSummary(name, source) {
  return {
    id: `${name}@${SIGNED_OUT_CURATED_MARKETPLACE_ID}`,
    remotePluginId: null,
    version: null,
    localVersion: null,
    name,
    shareContext: null,
    source,
    installed: false,
    installedAt: null,
    enabled: false,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: null,
    keywords: [],
  };
}

/**
 * Seed the curated catalog Codex serves while signed out. The app-server
 * lists it from `api_marketplace.json`, a sibling of `marketplace.json` in
 * the same checkout, while its plugins sit under the checkout root. Signed
 * out, `plugin/installed` reports no marketplaces. Like the real catalog, it
 * also lists a `git`-source plugin, which Canopy cannot resolve.
 */
function seedSignedOutCuratedCodexMarketplace(userDataDir) {
  const marketplaceRoot = path.join(
    userDataDir,
    'provider-state',
    'codex',
    '.tmp',
    'plugins',
  );
  const marketplacePath = path.join(
    marketplaceRoot,
    '.agents',
    'plugins',
    'api_marketplace.json',
  );
  const codexStatePath = path.join(userDataDir, 'codex-state.json');
  const pluginFixturePath = path.join(userDataDir, 'codex-plugin-fixture.json');
  const plugins = SIGNED_OUT_CURATED_PLUGIN_NAMES.map((name) => {
    const pluginRoot = path.join(marketplaceRoot, 'plugins', name);
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name,
      description: `Deterministic ${name} fixture`,
      version: '1.0.0',
    });
    return signedOutCuratedPluginSummary(name, {
      type: 'local',
      path: pluginRoot,
    });
  });
  plugins.push(
    signedOutCuratedPluginSummary(SIGNED_OUT_CURATED_GIT_PLUGIN_NAME, {
      type: 'git',
      url: 'https://github.com/qodo-ai/qodo-skills.git',
      path: null,
      refName: null,
      sha: null,
    }),
  );
  writeJson(marketplacePath, {
    name: SIGNED_OUT_CURATED_MARKETPLACE_ID,
    plugins: SIGNED_OUT_CURATED_PLUGIN_NAMES.map((name) => ({
      name,
      source: { source: 'local', path: `./plugins/${name}` },
    })),
  });
  writeJson(codexStatePath, { nextThread: 1, nextTurn: 1, threads: {} });
  writeJson(pluginFixturePath, {
    pluginList: {
      marketplaces: [
        {
          name: SIGNED_OUT_CURATED_MARKETPLACE_ID,
          path: marketplacePath,
          interface: { displayName: 'Codex official' },
          plugins,
        },
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    },
    pluginInstalled: { marketplaces: [], marketplaceLoadErrors: [] },
  });
  return {
    cachePath: path.join(userDataDir, 'plugins-cache.json'),
    env: {
      CODEX_EXECUTABLE: FAKE_CODEX_APP_SERVER_PATH,
      CANOPY_E2E_CODEX_LOG_PATH: path.join(userDataDir, 'codex-protocol.jsonl'),
      CANOPY_E2E_CODEX_STATE_PATH: codexStatePath,
      CANOPY_E2E_CODEX_PLUGIN_FIXTURE_PATH: pluginFixturePath,
    },
  };
}

function claudeMarketplaceEntries(userDataDir) {
  const root = path.join(
    userDataDir,
    'provider-state',
    'claude',
    'plugins',
    'marketplaces',
  );
  return existsSync(root) ? readdirSync(root) : [];
}

function readCodexSecurityMarketplace(cachePath) {
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  return cache.marketplaces.find(
    (marketplace) => marketplace.id === CODEX_SECURITY_MARKETPLACE_ID,
  );
}

function codexClientRequests(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

async function refreshMarketplacesFromUi(window) {
  const refresh = window.getByTestId('marketplaces-refresh');
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
}

test('refreshes a warm Codex-only marketplace twice and manually without touching Claude state', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-only-marketplace-'),
  );
  let electronApp;

  try {
    seedCodexOnlyMarketplace(userDataDir);
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');

    const row = window.getByTestId(`marketplace-row-${MARKETPLACE_ID}`);
    await expect(row).toBeVisible();

    const refresh = window.getByTestId('marketplaces-refresh');
    await refresh.click();
    await expect(refresh).toBeEnabled({ timeout: 30_000 });
    await refresh.click();
    await expect(refresh).toBeEnabled({ timeout: 30_000 });

    const update = window.getByTestId(`marketplace-update-${MARKETPLACE_ID}`);
    await update.click();
    await expect(update).toBeEnabled({ timeout: 30_000 });

    await expect(row).not.toContainText('Failed to add marketplace');
    expect(claudeMarketplaceEntries(userDataDir)).toEqual([]);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});

test('unblocks the Code Review (Multi-Provider) dispatch after repairing the built-in Codex marketplace', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-security-dispatch-'),
  );
  let electronApp;

  try {
    const fixture = seedPoisonedCodexSecurityMarketplace({ userDataDir });
    const launched = await launchCanopy({
      userDataDir,
      seedDemoWorkspaces: true,
      env: fixture.env,
    });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');
    await refreshMarketplacesFromUi(window);

    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    await app.openPipelineDispatchModal('Code Review (Multi-Provider)');
    const runButton = window.getByTestId('pipeline-trigger-modal-run');
    await expect(runButton).toBeEnabled({ timeout: 30_000 });
    await expect(runButton).toHaveText('Continue');
    await runButton.click();
    await expect(runButton).toHaveText('Run');

    await expect(
      window.getByTestId('pipeline-trigger-modal-required-blocking'),
    ).toHaveCount(0);
    await expect(runButton).toBeEnabled();
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});

test('repairs a poisoned built-in Codex marketplace cache without requesting a Git upgrade', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-security-cache-'),
  );
  let electronApp;

  try {
    const fixture = seedPoisonedCodexSecurityMarketplace({ userDataDir });
    const launched = await launchCanopy({
      userDataDir,
      seedDemoWorkspaces: true,
      env: fixture.env,
    });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');

    await refreshMarketplacesFromUi(window);
    await expect(
      window.getByTestId(`marketplace-row-${CODEX_SECURITY_MARKETPLACE_ID}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(
        `marketplace-error-banner-${CODEX_SECURITY_MARKETPLACE_ID}`,
      ),
    ).toHaveCount(0);

    const assertRepairedCache = () => {
      const marketplace = readCodexSecurityMarketplace(fixture.cachePath);
      expect(marketplace).toBeDefined();
      expect(marketplace.pluginCount).toBe(1);
      expect(marketplace.plugins.map((plugin) => plugin.name)).toContain(
        CODEX_SECURITY_PLUGIN_NAME,
      );
      expect(marketplace.validProviders).toEqual(['codex']);
      expect(marketplace.providerStatus.codex.state).toBe('valid');
      expect(marketplace.providerStatus.codex.error).toBeUndefined();
    };
    assertRepairedCache();

    await refreshMarketplacesFromUi(window);
    assertRepairedCache();

    const invalidUpgradeRequests = codexClientRequests(
      fixture.codexLogPath,
    ).filter(
      (request) =>
        request.method === 'marketplace/upgrade' &&
        request.params?.marketplaceName === MANAGED_BUILTIN_MARKETPLACE_NAME,
    );
    expect(invalidUpgradeRequests).toEqual([]);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});

test('lists the signed-out Codex curated catalog without an error banner', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-signed-out-curated-'),
  );
  let electronApp;

  try {
    const fixture = seedSignedOutCuratedCodexMarketplace(userDataDir);
    const launched = await launchCanopy({ userDataDir, env: fixture.env });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');
    await refreshMarketplacesFromUi(window);

    const row = window.getByTestId(
      `marketplace-row-${SIGNED_OUT_CURATED_MARKETPLACE_ID}`,
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId(
        `marketplace-error-banner-${SIGNED_OUT_CURATED_MARKETPLACE_ID}`,
      ),
    ).toHaveCount(0);
    await expect(row).not.toContainText('No providers');

    const cache = JSON.parse(readFileSync(fixture.cachePath, 'utf8'));
    const marketplace = cache.marketplaces.find(
      (entry) => entry.id === SIGNED_OUT_CURATED_MARKETPLACE_ID,
    );
    expect(marketplace.validProviders).toEqual(['codex']);
    expect(marketplace.providerStatus.codex.pluginCount).toBe(
      SIGNED_OUT_CURATED_PLUGIN_NAMES.length,
    );
    // The git-source plugin stays unresolved without failing the marketplace.
    expect(marketplace.providerStatus.codex.error).toContain(
      `Codex plugin "${SIGNED_OUT_CURATED_GIT_PLUGIN_NAME}" uses git source`,
    );
    expect(marketplace.providerStatus.codex.error).not.toContain(
      'could not be resolved inside the marketplace root',
    );
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});

test('explains suppressed Codex rechecks on a structurally invalid marketplace row', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-structural-marketplace-'),
  );
  let electronApp;

  try {
    seedStructurallyInvalidCodexMarketplace(userDataDir);
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');

    const row = window.getByTestId(
      `marketplace-row-${STRUCTURAL_MARKETPLACE_ID}`,
    );
    await expect(row).toBeVisible();
    await expect(row).toContainText('No providers');

    await expect(
      window.getByTestId(
        `marketplace-error-banner-${STRUCTURAL_MARKETPLACE_ID}`,
      ),
    ).toBeVisible();

    const note = window.getByTestId(
      `marketplace-codex-structural-note-${STRUCTURAL_MARKETPLACE_ID}`,
    );
    await expect(note).toBeVisible();
    await expect(note).toContainText('Retry refresh');

    // The escape hatch the note points at must actually be actionable.
    await expect(
      window.getByTestId(`marketplace-retry-${STRUCTURAL_MARKETPLACE_ID}`),
    ).toBeEnabled();
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});
