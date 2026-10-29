import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  clearScenario,
  getScenarioActivity,
  registerScenario,
  seedAutomations,
  seedCuratedPlugins,
  seedMcpServers,
  seedPluginsCache,
  seedStoredPipeline,
} from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  getAvailablePort,
  seedVendorOAuthCatalog,
  startOAuthFixtureServer,
} from './mcpOauthCallbackFixture.mjs';

import {
  seedPluginConnectionDesign,
  seedCursorPluginConnectionDesign,
  installPluginConnectionDesignHandlers,
  openPluginConnectionDesign,
  openCuratedStatusFixture,
  openUnversionedOAuthFixture,
  emitUnversionedOAuthFailure,
  openOAuthLoadingFixture,
  openLocalConnectionFixture,
  seedDualFacetConnection,
} from './pluginConnectionDesignFixture.mjs';

import {
  openCalmPluginDetail,
  skillDescription,
} from './pluginDetailCalmFixture.mjs';
import {
  openPendingPluginInstall,
  completePendingPluginInstall,
} from './pluginInstallCompletionFixture.mjs';

test('marketplace reflects an install that completes after leaving details', async () => {
  const { electronApp, window, userDataDir } = await openPendingPluginInstall();
  try {
    await completePendingPluginInstall(electronApp);
    await expect(
      window.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
    ).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-add-mkt:demo/market/alpha-tool'),
    ).toHaveCount(0);
    await window.getByTestId('plugins-search-clear').click();
    await expect(
      window.getByTestId('customize-row-mkt:demo/market/alpha-tool'),
    ).toBeVisible();
    expect(
      await electronApp.evaluate(
        () => globalThis.__pluginInstallCompletionFixture.calls,
      ),
    ).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automatic installation shows details when the user stays on the page', async () => {
  const { electronApp, window, userDataDir } = await openPendingPluginInstall({
    leaveDetails: false,
  });
  try {
    await expect(window.getByTestId('plugin-detail-loading')).toBeVisible();
    await completePendingPluginInstall(electronApp);
    await expect(window.getByTestId('plugin-detail-loading')).toHaveCount(0);
    await expect(window.getByTestId('plugin-detail-host')).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-current'),
    ).toHaveText('Alpha Tool');
    expect(
      await electronApp.evaluate(
        () => globalThis.__pluginInstallCompletionFixture.calls,
      ),
    ).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function requestAdvisorTool(electronApp, request) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for browser action')),
          15_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

/** The dual-auth plugin's `vendor` servers as the MCP inventory reports them. */
async function detectedVendorServers(window) {
  const inventory = await window.evaluate(() =>
    window.mcpServers.listDetected({
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'demo/market', pluginName: 'dual-auth' }],
      },
    }),
  );
  return inventory.servers.filter(
    (server) => server.pluginServerName === 'vendor',
  );
}

test('plugin detail keeps long descriptions scannable and installation aligned', async () => {
  const { electronApp, window, userDataDir } = await openCalmPluginDetail();
  try {
    // CAN-3723: verify the installed full detail is page-presented and keep
    // its shared reading column unchanged. The titlebar trail is separate.
    const shell = window.getByTestId('plugins-entry-detail');
    await expect(shell).toHaveJSProperty('tagName', 'SECTION');
    // CAN-4261: a page draws no plugin Back; the breadcrumb leads out.
    await expect(window.getByTestId('plugin-detail-back')).toHaveCount(0);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1920, height: 1080 },
    ]) {
      await window.setViewportSize(viewport);
      await window.evaluate(() => document.fonts.ready);
      const box = await shell.boundingBox();
      if (!box)
        throw new Error('Desktop full-detail shell has no bounding box');
      const bounds = await shell.locator('..').evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        const px = (value) => Number.parseFloat(value) || 0;
        return {
          left: rect.left + px(style.paddingLeft) + px(style.borderLeftWidth),
          right:
            rect.right - px(style.paddingRight) - px(style.borderRightWidth),
        };
      });
      for (const edge of [window.getByTestId('plugin-detail-chrome')]) {
        await expect(edge).toBeVisible();
        await expect
          .poll(async () => {
            const edgeBox = await edge.boundingBox();
            if (!edgeBox)
              throw new Error('Desktop full-detail edge has no bounding box');
            return Math.abs(edgeBox.x - box.x);
          })
          .toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs(box.x - bounds.left - (bounds.right - box.x - box.width)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.width - Math.min(768, bounds.right - bounds.left)),
      ).toBeLessThanOrEqual(1);
    }
    for (const width of [1280, 820]) {
      await window.setViewportSize({ width, height: 1100 });
      const chrome = window.getByTestId('plugin-detail-chrome');
      const harness = window.getByTestId('plugin-harness-connections');
      await expect(harness).toBeVisible();
      const bounds = await chrome.boundingBox();
      const table = await harness.boundingBox();
      expect
        .soft(Math.abs(table.x + table.width - bounds.x - bounds.width))
        .toBeLessThan(2);
      const row = window.getByRole('row').filter({
        has: window.getByRole('button', {
          name: 'ai-agents-development',
          exact: true,
        }),
      });
      expect.soft((await row.boundingBox()).height).toBeLessThan(100);
      const description = row.locator('summary');
      await expect(description).toHaveAccessibleName(
        'Description for ai-agents-development',
      );
      await expect(row.locator('details')).not.toHaveAttribute('open', '');
      await description.focus();
      await window.keyboard.press('Enter');
      await expect(row.locator('details')).toHaveAttribute('open', '');
      await expect(row.locator('details p')).toHaveText(skillDescription);
      await window.keyboard.press('Enter');
      await expect(row.locator('details')).not.toHaveAttribute('open', '');
      const readme = window.getByRole('button', {
        name: 'README',
        exact: true,
      });
      await readme.focus();
      await window.keyboard.press('Enter');
      await expect(readme).toHaveAttribute('aria-expanded', 'true');
      await expect(
        window.getByText(
          'Full agent development instructions remain available.',
        ),
      ).toBeVisible();
      await window.keyboard.press('Enter');
      await expect(readme).toHaveAttribute('aria-expanded', 'false');
      expect(
        await window
          .getByTestId('page-plugins')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await window
      .getByRole('button', { name: 'ai-agents-development', exact: true })
      .click();
    await expect(
      window.getByText('Full agent development instructions remain available.'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('installed plugin details show installation by harness and never offer sign-in', async () => {
  const userDataDir = makeUserDataDir('plugin-connection-design-');
  seedPluginConnectionDesign(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await installPluginConnectionDesignHandlers(electronApp);
    const window = await electronApp.firstWindow();
    await openPluginConnectionDesign(window, new CanopyAppDriver(window));
    await expect(window.locator('h2#plugin-detail-title')).toBeVisible();
    await expect(window.locator('h1#plugin-detail-title')).toHaveCount(0);
    const endpoint = window.getByText('https://gmail.example.test/mcp', {
      exact: true,
    });
    await expect(endpoint).toBeHidden();
    await window.locator('summary').filter({ hasText: 'MCP servers' }).focus();
    await window.keyboard.press('Enter');
    await expect(endpoint).toBeVisible();
    await window.locator('summary').filter({ hasText: 'MCP servers' }).click();
    await expect(endpoint).toBeHidden();
    await expect(window.getByTestId('related-pipelines-section')).toHaveCount(
      0,
    );
    await window.getByRole('button', { name: 'README', exact: true }).click();
    await expect(
      window.getByText(
        'Search and manage your Gmail messages from your workspace.',
      ),
    ).toBeVisible();
    await window.getByRole('button', { name: 'README', exact: true }).click();
    await expect(window.getByTestId('plugin-harness-claude')).toContainText(
      'Not supported',
    );
    await expect(window.getByTestId('plugin-harness-codex')).toContainText(
      'Installed',
    );
    // Adding a plugin only installs it: its MCP servers sign in from a chat's
    // MCP Servers panel once a chat uses the plugin (REG-3015).
    await expect(window.getByTestId('plugin-account-connection')).toHaveCount(
      0,
    );
    await expect(
      window.getByRole('button', { name: /^Connect\b/ }),
    ).toHaveCount(0);
    // The app is where the plugin is added, not a harness it installs into.
    await expect(window.getByTestId('plugin-harness-app')).toHaveCount(0);
    for (const harness of ['codex', 'cursor']) {
      const status = window
        .getByTestId(`plugin-harness-${harness}`)
        .getByRole('cell');
      await expect(status.locator('svg')).toBeVisible();
      await expect(status).toHaveClass(/fg-success/);
    }
    await expect(
      window
        .getByTestId('plugin-harness-claude')
        .getByRole('cell')
        .locator('svg'),
    ).toHaveCount(0);
    await window.setViewportSize({ width: 820, height: 900 });
    expect(
      await window
        .getByTestId('plugin-harness-connections')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await window
      .getByTestId('related-capabilities-section')
      .getByRole('button', { name: /Outlook Email/ })
      .click();
    await expect(window.locator('#plugin-detail-title')).toHaveText(
      'Outlook Email',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('plugin installation rows distinguish providers in a partial installation', async () => {
  const userDataDir = makeUserDataDir('plugin-partial-install-');
  seedPluginConnectionDesign(userDataDir);
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const plugin = cache.marketplaces[0].plugins.find(
    (entry) => entry.name === 'gmail',
  );
  plugin.providerSupport.claude = 'native';
  plugin.facets.claude = { ...plugin.facets.codex, provider: 'claude' };
  writeJson(cachePath, cache);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await installPluginConnectionDesignHandlers(electronApp);
    const window = await electronApp.firstWindow();
    await openPluginConnectionDesign(window, new CanopyAppDriver(window));
    await expect(window.getByTestId('plugin-harness-claude')).toContainText(
      'Not installed',
    );
    await expect(
      window.getByTestId('plugin-harness-claude').locator('svg'),
    ).toHaveCount(0);
    await expect(window.getByTestId('plugin-harness-codex')).toContainText(
      'Installed',
    );
    await expect(
      window.getByTestId('plugin-harness-codex').locator('svg'),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A Cursor session loads a plugin's MCP servers, skills, and commands from
// the facet it reads (Claude first, else native Codex), so a skills-only
// plugin is supported and an empty facet is not.
for (const [kind, expected] of [
  ['claude-only', 'Installed'],
  ['claude-skills-only', 'Installed'],
  ['codex-empty', 'Not supported'],
  ['claude-preferred', 'Not installed'],
]) {
  test(`Cursor installation follows the facet it loads: ${kind}`, async () => {
    const userDataDir = makeUserDataDir('plugin-cursor-facet-');
    seedCursorPluginConnectionDesign(userDataDir, kind);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await installPluginConnectionDesignHandlers(electronApp);
      const window = await electronApp.firstWindow();
      await openPluginConnectionDesign(window, new CanopyAppDriver(window));
      const status = window
        .getByTestId('plugin-harness-cursor')
        .getByRole('cell');
      await expect(status).toHaveText(expected);
      await expect(status.locator('svg')).toHaveCount(
        expected === 'Installed' ? 1 : 0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

{
  test('curated connection settles an unversioned OAuth failure without waiting for timeout', async () => {
    const { electronApp, userDataDir, window } =
      await openUnversionedOAuthFixture('curated');
    try {
      await expect(window.getByRole('alert')).toContainText('Couldn’t connect');
      await window.getByTestId('mcp-browse-detail-add').click();
      // The old versioned failure does not interrupt this new attempt.
      await expect(window.getByTestId('plugin-oauth-browser')).toBeVisible();
      // While sign-in is pending, the shared primary is a disabled Try it.
      await expect(
        window.getByTestId('plugin-account-connection'),
      ).toContainText('Waiting for sign-in');
      const primary = window.getByTestId('detail-primary-cta');
      await expect(primary).toHaveAttribute('data-state', 'pending');
      await expect(primary).toHaveText('Try it');
      await expect(primary).toBeDisabled();
      await emitUnversionedOAuthFailure(electronApp);
      await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
      await expect(window.getByRole('alert')).toContainText('Couldn’t connect');
      await window.getByText('Technical details', { exact: true }).click();
      await expect(window.getByRole('alert')).toContainText(
        'Secure storage unavailable',
      );
      await expect(window.getByTestId('mcp-browse-detail-add')).toBeEnabled();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__cancelledOAuthFlows),
        )
        .toEqual(['fixture-flow']);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('curated sign-in keeps its page private, reports its state, and retries browser cleanup on close', async () => {
  const { electronApp, userDataDir, window } =
    await openUnversionedOAuthFixture('curated');
  try {
    await window.getByTestId('mcp-browse-detail-add').click();
    const consent = window.getByTestId('plugin-oauth-browser');
    await expect(consent).toBeVisible();
    await expect(
      consent.locator('[data-testid^="browser-pane-"]').first(),
    ).toBeVisible();
    await expect(consent.getByTestId('browser-profile-picker')).toHaveCount(0);

    const advisor = await requestAdvisorTool(electronApp, {
      kind: 'get_current_ui_state',
      requestId: 'plugin-signin-state',
    });
    expect(advisor.uiState.snapshot.plugins.connection).toMatchObject({
      pending: true,
      browserOpen: true,
    });
    expect(advisor.uiState.snapshot.plugins.oauthPanel).toMatchObject({
      open: true,
      errorVisible: false,
    });
    const blocked = await requestAdvisorTool(electronApp, {
      kind: 'dispatch_action',
      requestId: 'plugin-signin-private',
      action: {
        type: 'browser.input_snapshot',
        projectId: 'app-oauth',
        worktreeId: 'mcp',
      },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.message).toContain('Sign-in pages are private');

    const closingId = (
      await consent
        .locator('[data-testid^="browser-pane-"]')
        .first()
        .getAttribute('data-testid')
    ).slice('browser-pane-'.length);
    await electronApp.evaluate(({ ipcMain }, targetId) => {
      const original = ipcMain._invokeHandlers.get('browser:destroy');
      globalThis.__pluginDestroyAttempts = 0;
      ipcMain.removeHandler('browser:destroy');
      ipcMain.handle('browser:destroy', (event, request) => {
        if (request.browserId === targetId) {
          globalThis.__pluginDestroyAttempts += 1;
          if (globalThis.__pluginDestroyAttempts === 1)
            throw new Error('Transient browser cleanup failure');
        }
        return original(event, request);
      });
    }, closingId);
    await consent.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__pluginDestroyAttempts),
      )
      .toBe(2);
    await expect(consent).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const requiredClient of [false, true]) {
  test(`curated Add preserves ${requiredClient ? 'required client configuration guidance' : 'public no-auth setup'}`, async () => {
    const userDataDir = makeUserDataDir('plugin-curated-setup-');
    seedVendorOAuthCatalog(userDataDir, 3118, 'http://127.0.0.1:1');
    const file = path.join(userDataDir, 'mcp-servers', 'curated-catalog.json');
    const catalog = JSON.parse(readFileSync(file, 'utf8'));
    delete catalog.servers[0].oauthHints;
    if (requiredClient)
      catalog.servers[0].requiredConfigFields = [
        { kind: 'oauth-client-id', label: 'Client ID' },
      ];
    writeJson(file, catalog);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('mcp-servers:get-tools');
        ipcMain.handle('mcp-servers:get-tools', () => ({ tools: [] }));
        ipcMain.removeHandler('mcp-servers:start-oauth-login');
        ipcMain.handle('mcp-servers:start-oauth-login', () => {
          throw new Error('Public services must not start OAuth');
        });
      });
      const window = await electronApp.firstWindow();
      await window.reload();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
      await window
        .getByTestId('plugins-entry-add-mcp-catalog:vendor-oauth-callback')
        .click();
      if (requiredClient) {
        await expect(window.getByRole('alert')).toContainText(
          'Advanced configuration',
        );
      } else {
        await expect(
          window.getByTestId('plugin-account-connection'),
        ).toContainText('Not required');
        const data = await window.evaluate(async () => {
          const index = await window.mcpServers.loadIndex();
          return window.mcpServers.loadServer(
            index.servers.find((x) => x.curatedKey === 'vendor-oauth-callback')
              .id,
          );
        });
        expect(data.server.definition.oauth).toBeUndefined();
      }
      await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('curated Add lists harness availability without listing the app as a harness', async () => {
  const userDataDir = makeUserDataDir('plugin-curated-harnesses-');
  seedVendorOAuthCatalog(userDataDir, 3118, 'http://127.0.0.1:1');
  const file = path.join(userDataDir, 'mcp-servers', 'curated-catalog.json');
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  delete catalog.servers[0].oauthHints;
  writeJson(file, catalog);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mcp-servers:get-tools');
      ipcMain.handle('mcp-servers:get-tools', () => ({ tools: [] }));
      for (const channel of [
        'settings:claude-auth-status',
        'settings:codex-auth-status',
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({
          authenticated: true,
          accountLabel: 'Fixture account',
          detail: null,
        }));
      }
    });
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
    await window
      .getByTestId('plugins-entry-mcp-catalog:vendor-oauth-callback')
      .click();
    const add = window.getByTestId('mcp-browse-detail-add');
    await expect(add).toBeVisible();
    for (const harness of ['claude', 'codex']) {
      await expect(
        window.getByTestId(`plugin-harness-${harness}`).getByRole('cell'),
      ).toHaveText('Not installed');
    }
    await expect(window.getByTestId('plugin-harness-app')).toHaveCount(0);
    await add.click();
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'Not required',
    );
    for (const harness of ['claude', 'codex']) {
      await expect(
        window.getByTestId(`plugin-harness-${harness}`).getByRole('cell'),
      ).toHaveText('Installed');
    }
    await expect(window.getByTestId('plugin-harness-app')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('leaving curated Add while status loads does not begin sign-in later', async () => {
  const userDataDir = makeUserDataDir('plugin-late-status-');
  seedVendorOAuthCatalog(userDataDir, 3118, 'http://127.0.0.1:1');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__pluginStatusWaiting = false;
      globalThis.__pluginLateStarts = 0;
      const gate = new Promise((resolve) => {
        globalThis.__releasePluginStatus = resolve;
      });
      ipcMain.removeHandler('mcp-servers:list-status');
      ipcMain.handle('mcp-servers:list-status', async () => {
        globalThis.__pluginStatusWaiting = true;
        await gate;
        return [];
      });
      ipcMain.removeHandler('mcp-servers:start-oauth-login');
      ipcMain.handle('mcp-servers:start-oauth-login', () => {
        globalThis.__pluginLateStarts += 1;
        return { status: 'completed' };
      });
    });
    await window
      .getByTestId('plugins-entry-add-mcp-catalog:vendor-oauth-callback')
      .click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__pluginStatusWaiting))
      .toBe(true);
    // CAN-4261: the page has no Back; leave through the breadcrumb.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await electronApp.evaluate(() => globalThis.__releasePluginStatus());
    // An IPC round trip drains the earlier released status response first.
    await window.evaluate(() => window.mcpServers.listStatus());
    expect(
      await electronApp.evaluate(() => globalThis.__pluginLateStarts),
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const scenario of [
  { type: 'http', removedCatalog: false },
  { type: 'command', removedCatalog: false },
  { type: 'http', removedCatalog: true },
]) {
  test(`saved ${scenario.type} connection opens details before advanced configuration (removed catalog: ${scenario.removedCatalog})`, async () => {
    const { electronApp, userDataDir, window } =
      await openLocalConnectionFixture(scenario);
    try {
      const detail = window.getByTestId('mcp-browse-detail');
      await expect(detail).toBeVisible();
      // A page action: it sits in the detail's top-right action bar, not the
      // connection body.
      const configure = window
        .getByTestId('detail-action-bar')
        .getByRole('button', { name: 'Advanced configuration', exact: true });
      await expect(configure).toBeVisible();
      const editor = window.getByRole('dialog', { name: 'Edit MCP server' });
      await expect(editor).toHaveCount(0);
      await expect(
        window.getByTestId('plugins-entry-detail-page'),
      ).toBeVisible();
      expect(
        await electronApp.evaluate(() => globalThis.__localDetailCalls),
      ).toEqual({ login: [], health: [], test: [] });
      if (scenario.type === 'http') {
        await expect(
          detail.getByTestId('plugin-account-connection'),
        ).toContainText("isn't connected on this desktop");
        // Connect is the detail's primary action, last in its action bar.
        await window
          .getByTestId('detail-action-bar')
          .getByRole('button', { name: /^Connect\b/ })
          .click();
        await expect(
          detail.getByTestId('plugin-account-connection'),
        ).toContainText('is connected on this desktop');
        expect(
          await electronApp.evaluate(() => globalThis.__localDetailCalls.login),
        ).toEqual([
          expect.objectContaining({
            serverId: 'aabbcc',
            configId: 'ddeeff',
            browser: 'embedded',
          }),
        ]);
      } else {
        await expect(
          detail.getByTestId('plugin-account-connection'),
        ).toContainText('Not required');
        await expect(
          window.getByRole('button', { name: /^Connect\b/ }),
        ).toHaveCount(0);
        expect(
          await electronApp.evaluate(() => globalThis.__localDetailCalls.login),
        ).toEqual([]);
      }
      await configure.click();
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole('button', {
          name: scenario.type === 'http' ? 'HTTP' : 'Command',
          exact: true,
        }),
      ).toBeVisible();
      for (const label of ['Health check', 'Test connection']) {
        await editor.getByRole('button', { name: label, exact: true }).click();
      }
      const calls = await electronApp.evaluate(
        () => globalThis.__localDetailCalls,
      );
      expect(calls.health).toEqual([
        expect.objectContaining({ serverId: 'aabbcc', configId: 'ddeeff' }),
      ]);
      expect(calls.test).toEqual([
        expect.objectContaining({ serverId: 'aabbcc', configId: 'ddeeff' }),
      ]);
      await window.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      await expect(detail).toBeVisible();
      await configure.click();
      const serverName = editor.getByPlaceholder('My MCP server');
      await expect(serverName).toHaveValue(
        scenario.type === 'http' ? 'Slack' : 'Local tools',
      );
      await serverName.fill('Updated connection');
      await expect(serverName).toHaveValue('Updated connection');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(detail).toContainText('Updated connection');
      const saved = await window.evaluate(async () => ({
        index: await window.mcpServers.loadIndex(),
        file: await window.mcpServers.loadServer('aabbcc'),
      }));
      expect(saved.index.servers).toHaveLength(1);
      expect(saved.file.server.definition.name).toBe('Updated connection');
      expect(saved.file.server.definition.type).toBe(scenario.type);
      expect(saved.file.server.configs[0].id).toBe('ddeeff');
      // CAN-4261: the page has no Back; the breadcrumb root keeps the search.
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(window.getByTestId('plugins-search')).toHaveValue(
        scenario.type === 'http' ? 'Slack' : 'Local tools',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('a selected nested device copy opens its curated connection after catalog arrival', async () => {
  const { electronApp, userDataDir, window } = await openCuratedStatusFixture({
    localSelection: true,
    nestedDevice: true,
  });
  try {
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await expect(
      window.getByRole('dialog', { name: 'Edit MCP server' }),
    ).toHaveCount(0);
    await window
      .getByRole('button', { name: 'Advanced configuration', exact: true })
      .click();
    await expect(
      window
        .getByRole('dialog', { name: 'Edit MCP server' })
        .getByPlaceholder('My MCP server'),
    ).toHaveValue('Vendor OAuth Callback');
    await expect(window.getByTestId('mcp-account-details')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an account-only curated connection opens its detail without a device Add and keeps its account tools', async () => {
  const { electronApp, userDataDir, window } = await openCuratedStatusFixture({
    accountOnly: true,
  });
  try {
    // CAN-4265: an account-only card opens the shared MCP detail (health,
    // placement, delete) like every other card; the account's tool details
    // open from Advanced configuration there.
    const detail = window.getByTestId('mcp-browse-detail');
    await expect(detail).toBeVisible();
    await expect(window.getByTestId('mcp-browse-detail-add')).toHaveCount(0);
    await window
      .getByRole('button', { name: 'Advanced configuration', exact: true })
      .click();
    const details = window.getByTestId('mcp-account-details');
    await expect(details).toBeVisible();
    const allTools = details.getByRole('switch', { name: 'Allow all tools' });
    await expect(allTools).toBeChecked();
    await expect(details.getByRole('textbox')).toHaveCount(0);

    // Restricting starts from every tool the server offers, already on. The
    // switch's explanation line flips it too.
    await details.getByText('Includes tools the server adds later.').click();
    await expect(allTools).not.toBeChecked();
    const tools = details.getByTestId('mcp-account-tools-tool');
    await expect(tools).toHaveCount(3);
    await expect(details.getByTestId('mcp-account-tools-count')).toHaveText(
      '3 of 3 on',
    );
    await expect(tools.first()).toContainText('Search docs');
    await expect(tools.first()).toContainText('search_docs');
    await details
      .locator('[data-tool-name="delete_page"]')
      .getByRole('checkbox')
      .uncheck();
    await expect(details.getByTestId('mcp-account-tools-count')).toHaveText(
      '2 of 3 on',
    );
    await details.getByTestId('mcp-account-tools-save').click();
    await expect(details).toHaveCount(0);
    await expect(detail).toBeVisible();
    expect(
      await electronApp.evaluate(() => globalThis.__savedAccountTools),
    ).toEqual(['search_docs', 'read_page']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('OAuth opening state shows shared loading feedback and remains cancellable', async () => {
  const { electronApp, userDataDir, window } = await openOAuthLoadingFixture();
  try {
    const panel = window.getByTestId('plugin-oauth-browser');
    await expect(panel.getByRole('status')).toContainText('Opening sign-in…');
    await expect(
      panel.getByRole('status').getByLabel('Loading', { exact: true }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await electronApp.evaluate(({ ipcMain }) =>
      ipcMain.emit('e2e:release-oauth-browser'),
    );
    await expect(panel).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('late curated catalog preserves the selected local connection and edits without duplication', async () => {
  const { electronApp, userDataDir, window } = await openCuratedStatusFixture({
    localSelection: true,
  });
  try {
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await window
      .getByRole('button', { name: 'Advanced configuration', exact: true })
      .click();
    const editor = window.getByRole('dialog', { name: 'Edit MCP server' });
    await expect(editor.getByPlaceholder('My MCP server')).toHaveValue(
      'Vendor OAuth Callback',
    );
    await editor
      .getByPlaceholder('My MCP server')
      .fill('Selected vendor account');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeHidden();
    const saved = await window.evaluate(async () => ({
      index: await window.mcpServers.loadIndex(),
      selected: await window.mcpServers.loadServer('aabbcc'),
      other: await window.mcpServers.loadServer('001122'),
    }));
    expect(saved.index.servers).toHaveLength(2);
    expect(saved.selected.server.definition.name).toBe(
      'Selected vendor account',
    );
    expect(saved.other.server.definition.name).toBe('Other vendor connection');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('curated detail clears a transient status error after a successful update', async () => {
  const { electronApp, userDataDir, window } = await openCuratedStatusFixture();
  try {
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await electronApp.evaluate(({ BrowserWindow }) => {
      globalThis.__failStatusRead = true;
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('mcp-servers:auth-changed');
    });
    await expect(window.getByRole('alert')).toBeVisible();
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('mcp-servers:auth-changed');
    });
    await expect(window.getByRole('alert')).toHaveCount(0);
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('curated detail updates expiry after the maximum timer delay', async () => {
  const { electronApp, userDataDir, window } = await openCuratedStatusFixture();
  try {
    const connection = window.getByTestId('plugin-account-connection');
    await expect(connection).toContainText('is connected on this desktop');
    await window.clock.fastForward(2_147_483_647);
    await window.evaluate(() => window.mcpServers.listStatus());
    await electronApp.evaluate(() => {
      globalThis.__statusFixture.authStatus = 'expired';
    });
    await window.clock.fastForward(20_000);
    await expect(connection).toContainText("isn't connected on this desktop");
    await expect(
      window.getByRole('button', { name: /^Connect \S/ }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('distinct Codex connection adopts a matching original legacy credential without another sign-in', async () => {
  const fixture = await startOAuthFixtureServer();
  const userDataDir = makeUserDataDir('plugin-original-legacy-');
  seedDualFacetConnection(
    userDataDir,
    fixture.baseUrl,
    await getAvailablePort(),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const encrypted = await electronApp.evaluate(({ safeStorage }) =>
      safeStorage.encryptString('fixture-legacy-account').toString('base64'),
    );
    const digest = createHash('sha256')
      .update('demo/market\0dual-auth\0vendor')
      .digest('hex');
    const serverId = digest.slice(0, 32);
    const configId = digest.slice(32);
    const tokenPath = path.join(
      `${userDataDir}-secure`,
      'mcp-oauth-tokens.json',
    );
    writeJson(tokenPath, {
      version: 1,
      records: {
        [`${serverId}:${configId}`]: {
          serverId,
          configId,
          encryptedAccessTokenBase64: encrypted,
          upstreamUrl: 'https://mcp.vendor.test/mcp',
          clientId: 'vendor-client',
          authorizationUrl: `${fixture.baseUrl}/authorize`,
          tokenUrl: `${fixture.baseUrl}/token`,
          tokenType: 'Bearer',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Dual Auth');
    await window.getByTestId('plugins-entry-mkt:demo/market/dual-auth').click();
    // Plugin details never sign in; the inventory a chat reads adopts the
    // legacy credential.
    await expect(window.getByTestId('plugin-account-connection')).toHaveCount(
      0,
    );
    expect(await detectedVendorServers(window)).toMatchObject([
      { authStatus: 'connected' },
    ]);
    const records = JSON.parse(readFileSync(tokenPath, 'utf8')).records;
    expect(records[`${serverId}:${configId}`]).toBeUndefined();
    expect(Object.values(records)).toHaveLength(1);
    expect(Object.values(records)[0].encryptedAccessTokenBase64).toBe(
      encrypted,
    );
    expect(fixture.tokenRequests).toHaveLength(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('normalized declarations preserve a previously connected account without another sign-in', async () => {
  const fixture = await startOAuthFixtureServer();
  const userDataDir = makeUserDataDir('plugin-normalized-legacy-');
  seedDualFacetConnection(
    userDataDir,
    fixture.baseUrl,
    await getAvailablePort(),
  );
  const original = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'fixture-plugins', 'codex', 'servers.json'),
      'utf8',
    ),
  ).mcpServers.vendor;
  for (const provider of ['claude', 'codex']) {
    writeJson(
      path.join(userDataDir, 'fixture-plugins', provider, 'servers.json'),
      {
        mcpServers: {
          vendor: {
            ...original,
            headers: {
              [provider === 'claude' ? 'X-Tenant' : 'x-tenant']: 'same-team',
            },
            oauth: {
              ...original.oauth,
              scopes:
                provider === 'claude' ? ['write', 'read'] : ['read', 'write'],
            },
          },
        },
      },
    );
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const encrypted = await electronApp.evaluate(({ safeStorage }) =>
      safeStorage.encryptString('fixture-legacy-account').toString('base64'),
    );
    const digest = createHash('sha256')
      .update(
        'demo/market\0dual-auth\0vendor\0oauth-v2\0' +
          JSON.stringify({
            url: original.url,
            oauth: {
              clientId: 'vendor-client',
              authorizationUrl: `${fixture.baseUrl}/authorize`,
              tokenUrl: `${fixture.baseUrl}/token`,
              scopes: ['write', 'read'],
              usePkce: true,
            },
            headers: { 'X-Tenant': 'same-team' },
            envHeaders: {},
          }),
      )
      .digest('hex');
    const serverId = digest.slice(0, 32);
    const configId = digest.slice(32);
    const tokenPath = path.join(
      `${userDataDir}-secure`,
      'mcp-oauth-tokens.json',
    );
    writeJson(tokenPath, {
      version: 1,
      records: {
        [`${serverId}:${configId}`]: {
          serverId,
          configId,
          encryptedAccessTokenBase64: encrypted,
          upstreamUrl: 'https://mcp.vendor.test/mcp',
          clientId: 'vendor-client',
          authorizationUrl: `${fixture.baseUrl}/authorize`,
          tokenUrl: `${fixture.baseUrl}/token`,
          tokenType: 'Bearer',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Dual Auth');
    await window.getByTestId('plugins-entry-mkt:demo/market/dual-auth').click();
    await expect(window.getByTestId('plugin-account-connection')).toHaveCount(
      0,
    );
    expect(await detectedVendorServers(window)).toMatchObject([
      { authStatus: 'connected' },
    ]);
    const records = JSON.parse(readFileSync(tokenPath, 'utf8')).records;
    expect(records[`${serverId}:${configId}`]).toBeUndefined();
    expect(Object.values(records)).toHaveLength(1);
    expect(Object.values(records)[0].encryptedAccessTokenBase64).toBe(
      encrypted,
    );
    expect(fixture.tokenRequests).toHaveLength(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

for (const difference of [
  'URL fragment',
  'environment binding',
  'header casing',
  'scope order',
  'environment header casing',
]) {
  test(`connection inventory and sign-in agree about provider ${difference}`, async () => {
    const fixture = await startOAuthFixtureServer();
    const userDataDir = makeUserDataDir('plugin-equivalent-declarations-');
    seedDualFacetConnection(
      userDataDir,
      fixture.baseUrl,
      await getAvailablePort(),
    );
    const original = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'fixture-plugins', 'codex', 'servers.json'),
        'utf8',
      ),
    ).mcpServers.vendor;
    for (const provider of ['claude', 'codex']) {
      writeJson(
        path.join(userDataDir, 'fixture-plugins', provider, 'servers.json'),
        {
          mcpServers: {
            vendor: {
              ...original,
              ...(difference === 'URL fragment'
                ? { url: original.url + '#' + provider }
                : difference === 'header casing'
                  ? {
                      headers: {
                        [provider === 'claude' ? 'X-Tenant' : 'x-tenant']:
                          'same-team',
                      },
                    }
                  : difference === 'scope order'
                    ? {
                        oauth: {
                          ...original.oauth,
                          scopes:
                            provider === 'claude'
                              ? ['read', 'write']
                              : ['write', 'read', 'read'],
                        },
                      }
                    : difference === 'environment header casing'
                      ? {
                          env_http_headers: {
                            [provider === 'claude' ? 'X-Tenant' : 'x-tenant']:
                              'PR3758_CLAUDE_AUTH',
                          },
                        }
                      : {
                          env_http_headers: {
                            'X-API-Key': `PR3758_${provider.toUpperCase()}_AUTH`,
                          },
                        }),
            },
          },
        },
      );
    }
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl,
        PR3758_CLAUDE_AUTH: 'same-fixture-token',
        PR3758_CODEX_AUTH: 'same-fixture-token',
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill('Dual Auth');
      const vendor = await detectedVendorServers(window);
      const expected = difference === 'environment binding' ? 2 : 1;
      expect(vendor).toHaveLength(expected);
      // Each distinct declaration is one sign-in a chat's MCP Servers panel
      // offers.
      expect(vendor.filter((server) => server.canConnect)).toHaveLength(
        expected,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await new Promise((resolve) => fixture.server.close(resolve));
    }
  });
}

test('plugin-managed HTTP remains available when secure storage is unavailable', async () => {
  const fixture = await startOAuthFixtureServer();
  const userDataDir = makeUserDataDir('plugin-managed-no-storage-');
  seedDualFacetConnection(
    userDataDir,
    fixture.baseUrl,
    await getAvailablePort(),
  );
  writeJson(
    path.join(userDataDir, 'fixture-plugins', 'codex', 'servers.json'),
    {
      mcpServers: {
        vendor: {
          type: 'http',
          url: 'https://mcp.vendor.test/mcp',
          headers: { Authorization: 'Bearer fixture-plugin-managed' },
        },
      },
    },
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Dual Auth');
    expect(await detectedVendorServers(window)).toMatchObject([
      { type: 'http', canConnect: false },
    ]);
    expect(fixture.tokenRequests).toHaveLength(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

for (const matchingClaude of [false, true, 'unavailable-first']) {
  test(`dual-facet plugin signs in its native Codex MCP through the real OAuth handler (matching Claude: ${matchingClaude})`, async () => {
    const fixture = await startOAuthFixtureServer();
    const userDataDir = makeUserDataDir('plugin-dual-facet-');
    const proxyPort = await getAvailablePort();
    seedDualFacetConnection(userDataDir, fixture.baseUrl, proxyPort);
    const claudeDirectory = path.join(userDataDir, 'fixture-plugins', 'claude');
    if (matchingClaude) {
      writeFileSync(
        path.join(claudeDirectory, 'servers.json'),
        readFileSync(
          path.join(userDataDir, 'fixture-plugins', 'codex', 'servers.json'),
        ),
      );
    }
    if (matchingClaude === 'unavailable-first') {
      renameSync(claudeDirectory, `${claudeDirectory}-away`);
    }
    const { electronApp } = await launchCanopy({
      userDataDir,
      extraEnv: { CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill('Dual Auth');
      await window
        .getByTestId('plugins-entry-mkt:demo/market/dual-auth')
        .click();
      // Plugin details no longer sign in (REG-3015); a chat's MCP Servers
      // panel does. Start the same embedded sign-in that panel requests and
      // open its private page, as the panel's sign-in browser would.
      await expect(
        window.getByRole('button', { name: /^Connect\b/ }),
      ).toHaveCount(0);
      const [connectable] = (await detectedVendorServers(window)).filter(
        (server) => server.canConnect,
      );
      expect(connectable).toBeTruthy();
      const started = await window.evaluate(
        (server) =>
          window.mcpServers.startOAuthLogin({
            plugin: {
              marketplaceId: 'demo/market',
              pluginName: 'dual-auth',
              serverName: server.pluginServerName,
              ...(server.pluginProvider
                ? { provider: server.pluginProvider }
                : {}),
            },
            browser: 'embedded',
          }),
        connectable,
      );
      expect(started.authorizationUrl).toBeTruthy();
      await window.evaluate(
        (url) =>
          window.api.browser.create({
            projectId: 'app-oauth',
            worktreeId: 'mcp',
            url,
          }),
        started.authorizationUrl,
      );
      await expect
        .poll(() =>
          electronApp.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .some(
                (page) =>
                  page.getURL().includes('/authorize?') && !page.isLoading(),
              ),
          ),
        )
        .toBe(true);
      await electronApp.evaluate(async ({ webContents }) => {
        const page = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes('/authorize?'));
        await page.executeJavaScript(
          "document.querySelector('#authorize').click()",
        );
      });
      await expect
        .poll(async () =>
          (await detectedVendorServers(window)).some(
            (server) => server.authStatus === 'connected',
          ),
        )
        .toBe(true);
      expect(fixture.tokenRequests).toHaveLength(1);
      const inventory = await window.evaluate(() =>
        window.mcpServers.listDetected({
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'demo/market', pluginName: 'dual-auth' },
            ],
          },
        }),
      );
      expect(
        inventory.servers.find(
          (server) => server.pluginServerName === 'vendor',
        ),
      ).toMatchObject({
        authStatus: 'connected',
        ...(!matchingClaude ? { pluginProvider: 'codex' } : {}),
      });
      if (matchingClaude) {
        if (matchingClaude === 'unavailable-first') {
          renameSync(`${claudeDirectory}-away`, claudeDirectory);
        }
        renameSync(claudeDirectory, `${claudeDirectory}-away`);
        const unavailableInventory = await window.evaluate(() =>
          window.mcpServers.listDetected({
            selections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [
                { marketplaceId: 'demo/market', pluginName: 'dual-auth' },
              ],
            },
          }),
        );
        expect(
          unavailableInventory.servers.find(
            (server) => server.pluginServerName === 'vendor',
          ),
        ).toMatchObject({ authStatus: 'connected', pluginProvider: 'codex' });
        renameSync(`${claudeDirectory}-away`, claudeDirectory);
        const restoredInventory = await window.evaluate(() =>
          window.mcpServers.listDetected({
            selections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [
                { marketplaceId: 'demo/market', pluginName: 'dual-auth' },
              ],
            },
          }),
        );
        expect(
          restoredInventory.servers.filter(
            (server) => server.pluginServerName === 'vendor',
          ),
        ).toMatchObject([{ authStatus: 'connected' }]);
        expect(fixture.tokenRequests).toHaveLength(1);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await new Promise((resolve) => fixture.server.close(resolve));
    }
  });
}

test('curated reconnect silently renews an expired account and preserves its refresh token', async () => {
  const fixture = await startOAuthFixtureServer();
  const userDataDir = makeUserDataDir('plugin-refreshable-reconnect-');
  const callbackPort = await getAvailablePort();
  seedVendorOAuthCatalog(userDataDir, callbackPort, fixture.baseUrl);
  const now = new Date().toISOString();
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: 'Vendor OAuth Callback',
          description: '',
          type: 'http',
          url: 'https://mcp.vendor.test/mcp',
          httpAuthHandler: 'canopy',
          curated: { key: 'vendor-oauth-callback' },
          oauth: {
            clientId: 'vendor-client',
            callbackPort,
            vendorRegisteredRedirect: true,
            authorizationUrl: `${fixture.baseUrl}/authorize`,
            tokenUrl: `${fixture.baseUrl}/token`,
            usePkce: true,
          },
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            enabled: true,
            description: '',
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl },
  });
  const tokenPath = path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json');
  try {
    const encrypted = await electronApp.evaluate(({ safeStorage, ipcMain }) => {
      // Tool discovery is unrelated to reconnect; keep it from refreshing first.
      ipcMain.removeHandler('mcp-servers:get-tools');
      ipcMain.handle('mcp-servers:get-tools', () => ({ tools: [] }));
      return {
        access: safeStorage.encryptString('expired-access').toString('base64'),
        refresh: safeStorage
          .encryptString('renewable-refresh')
          .toString('base64'),
      };
    });
    writeJson(tokenPath, {
      version: 1,
      records: {
        'aabbcc:ddeeff': {
          serverId: 'aabbcc',
          configId: 'ddeeff',
          encryptedAccessTokenBase64: encrypted.access,
          encryptedRefreshTokenBase64: encrypted.refresh,
          upstreamUrl: 'https://mcp.vendor.test/mcp',
          clientId: 'vendor-client',
          tokenUrl: `${fixture.baseUrl}/token`,
          tokenType: 'Bearer',
          expiresAt: '2000-01-01T00:00:00.000Z',
          updatedAt: now,
        },
      },
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
    await window
      .getByTestId('plugins-entry-mcp-catalog:vendor-oauth-callback')
      .click();
    await expect(window.getByTestId('mcp-browse-detail-add')).toHaveText(
      'Connect Vendor OAuth Callback',
    );
    expect(fixture.tokenRequests).toEqual([]);
    const statuses = await window.evaluate(() =>
      window.mcpServers.listStatus(),
    );
    expect(
      statuses.find((item) => item.serverId === 'aabbcc').configs[0],
    ).toMatchObject({
      authStatus: 'expired',
      canRefresh: true,
    });
    await window.getByTestId('mcp-browse-detail-add').click();
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    expect(fixture.tokenRequests).toEqual([
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'renewable-refresh',
      }),
    ]);
    const saved = JSON.parse(readFileSync(tokenPath, 'utf8')).records[
      'aabbcc:ddeeff'
    ];
    const tokens = await electronApp.evaluate(
      ({ safeStorage }, record) => ({
        access: safeStorage.decryptString(
          Buffer.from(record.encryptedAccessTokenBase64, 'base64'),
        ),
        refresh: safeStorage.decryptString(
          Buffer.from(record.encryptedRefreshTokenBase64, 'base64'),
        ),
      }),
      saved,
    );
    expect(tokens).toEqual({
      access: 'e2e-access-token',
      refresh: 'renewable-refresh',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('closing sign-in during credential persistence discards that account and permits retry', async () => {
  const fixture = await startOAuthFixtureServer();
  const userDataDir = makeUserDataDir('plugin-cancel-write-');
  seedVendorOAuthCatalog(
    userDataDir,
    await getAvailablePort(),
    fixture.baseUrl,
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl },
  });
  const tokenPath = path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json');
  try {
    await electronApp.evaluate(({ ipcMain }, target) => {
      const fs = process.getBuiltinModule('node:fs/promises');
      const originalRename = fs.rename;
      const gate = new Promise((resolve) => {
        globalThis.__releaseCredentialWrite = resolve;
      });
      globalThis.__credentialWriteHeld = false;
      fs.rename = async (...args) => {
        await originalRename(...args);
        if (String(args[1]) === target && !globalThis.__credentialWriteHeld) {
          globalThis.__credentialWriteHeld = true;
          await gate;
        }
      };
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
      const cancel = ipcMain._invokeHandlers.get(
        'mcp-servers:cancel-oauth-login',
      );
      globalThis.__credentialFlowCanceled = false;
      ipcMain.removeHandler('mcp-servers:cancel-oauth-login');
      ipcMain.handle(
        'mcp-servers:cancel-oauth-login',
        async (event, ...args) => {
          await cancel(event, ...args);
          globalThis.__credentialFlowCanceled = true;
        },
      );
    }, tokenPath);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
    await window
      .getByTestId('plugins-entry-add-mcp-catalog:vendor-oauth-callback')
      .click();
    const consent = async () => {
      await expect
        .poll(() =>
          electronApp.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .some(
                (page) =>
                  page.getURL().includes('/authorize?') && !page.isLoading(),
              ),
          ),
        )
        .toBe(true);
      await electronApp.evaluate(async ({ webContents }) => {
        const page = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes('/authorize?'));
        if (!page) throw new Error('Fixture consent page is missing');
        await page.executeJavaScript(
          "document.querySelector('#authorize').click()",
        );
      });
    };
    await consent();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__credentialWriteHeld))
      .toBe(true);
    await window
      .getByTestId('plugin-oauth-browser')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__credentialFlowCanceled),
      )
      .toBe(true);
    await electronApp.evaluate(() => globalThis.__releaseCredentialWrite());
    // Status and token readers must await the canceled write's rollback.
    const statuses = await window.evaluate(() =>
      window.mcpServers.listStatus(),
    );
    expect(
      statuses
        .flatMap((server) => server.configs)
        .some((config) => config.authStatus === 'connected'),
    ).toBe(false);
    expect(JSON.parse(readFileSync(tokenPath, 'utf8')).records).toEqual({});
    await window.getByTestId('mcp-browse-detail-add').click();
    await consent();
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
  } finally {
    await electronApp.evaluate(() => globalThis.__releaseCredentialWrite?.());
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('marketplace Add signs in once for configured harnesses, then adds the server to a project on request', async () => {
  test.setTimeout(120_000);
  const fixture = await startOAuthFixtureServer({
    failFirstTokenRequest: true,
  });
  const userDataDir = makeUserDataDir('canopy-plugin-connect-');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedVendorOAuthCatalog(
    userDataDir,
    await getAvailablePort(),
    fixture.baseUrl,
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: fixture.baseUrl },
  });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      for (const channel of [
        'settings:claude-auth-status',
        'settings:codex-auth-status',
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({
          authenticated: true,
          accountLabel: 'Fixture account',
          detail: null,
        }));
      }
    });
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
    await window
      .getByTestId('plugins-entry-add-mcp-catalog:vendor-oauth-callback')
      .click();

    // Add used to stop at an unsaved HTTP/OAuth form. It must save a shared
    // connection and begin sign-in from this single, realistic user action.
    await expect(
      window.getByRole('dialog', { name: 'New MCP server' }),
    ).toHaveCount(0);
    const connections = window.getByTestId('plugin-harness-connections');
    await expect(connections).toBeVisible();
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'Waiting for sign-in',
    );
    await expect(window.getByTestId('plugin-oauth-browser')).toBeVisible();
    await expect(
      connections.getByTestId('plugin-harness-claude'),
    ).toContainText('Installed');
    await expect(connections.getByTestId('plugin-harness-codex')).toContainText(
      'Installed',
    );
    const index = await window.evaluate(() => window.mcpServers.loadIndex());
    const server = index.servers.find(
      (entry) => entry.curatedKey === 'vendor-oauth-callback',
    );
    expect(server).toBeTruthy();
    const saved = await window.evaluate(
      (id) => window.mcpServers.loadServer(id),
      server.id,
    );
    expect(saved.server.definition.httpAuthHandler).toBe('canopy');
    expect(saved.server.definition.oauth.usePkce).toBe(true);

    const pane = window
      .getByTestId('plugin-oauth-browser')
      .locator('[data-testid^="browser-pane-"]')
      .first();
    let browserId = (await pane.getAttribute('data-testid')).slice(
      'browser-pane-'.length,
    );
    const inspection = await window.evaluate(
      (id) =>
        window.api.browser.automation({
          browserId: id,
          command: { kind: 'inspect', locator: 'body' },
        }),
      browserId,
    );
    expect(inspection.ok).toBe(false);
    expect(inspection.error.message).toContain('Sign-in pages are private');
    const normalBrowser = await window.evaluate(
      (url) =>
        window.api.browser.create({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          url,
        }),
      fixture.baseUrl,
    );
    try {
      // Profile-aware automation requires an explicit target; an omitted ID
      // must not fall back to the private sign-in page or another account.
      await expect(
        window.evaluate(() =>
          window.api.browser.automation({
            command: { kind: 'inspect', locator: 'body' },
          }),
        ),
      ).rejects.toThrow('Automation requires an explicit browserId');
      const explicit = await window.evaluate(
        (snapshot) =>
          window.api.browser.automation({
            browserId: snapshot.id,
            expectedRuntimeGeneration: snapshot.profile.runtimeGeneration,
            command: { kind: 'inspect', locator: 'body' },
          }),
        normalBrowser,
      );
      expect(explicit).toMatchObject({
        ok: true,
        browser: { id: normalBrowser.id },
      });
    } finally {
      await window.evaluate(
        (id) => window.api.browser.destroy({ browserId: id }),
        normalBrowser.id,
      );
    }
    await electronApp.evaluate(async ({ webContents }) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes('/authorize?'));
      if (!page) throw new Error('Fixture consent page is missing');
      await page.executeJavaScript(
        "document.querySelector('#authorize').click()",
      );
    });
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    await expect(window.getByRole('alert')).toContainText('Couldn’t connect');
    await window.getByText('Technical details', { exact: true }).click();
    await expect(window.getByText('503', { exact: false })).toBeVisible();
    await window.getByTestId('mcp-browse-detail-add').click();
    await expect(window.getByTestId('plugin-oauth-browser')).toBeVisible();
    browserId = (await pane.getAttribute('data-testid')).slice(
      'browser-pane-'.length,
    );
    await electronApp.evaluate(async ({ webContents }) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes('/authorize?'));
      if (!page) throw new Error('Fixture consent page is missing');
      await page.executeJavaScript(
        "document.querySelector('#authorize').click()",
      );
    });
    await expect(window.getByTestId('plugin-account-connection')).toContainText(
      'is connected on this desktop',
    );
    await expect(connections).not.toContainText('is connected');
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (id) =>
                window.api.browser.automation({
                  browserId: id,
                  command: { kind: 'inspect', locator: 'body' },
                }),
              browserId,
            )
          ).ok,
      )
      .toBe(false);

    // Signing in adds the server to no project. The card says so and offers
    // to add it; the project's defaults change only on that request.
    const projectDefaults = () =>
      window.evaluate(async () => {
        const file = await window.api.loadProjects();
        return (
          file.items.find((item) => item.id === 'demo-ts-pnpm-vite')
            ?.defaultPluginSelections?.mcpServerRefs ?? []
        );
      });
    const ref = {
      serverId: server.id,
      configId: saved.server.configs.find((config) => config.enabled).id,
    };
    const projects = window.getByTestId('mcp-browse-detail-projects');
    await expect(
      projects.getByTestId('mcp-browse-detail-projects-status'),
    ).toHaveText(
      'Not in any project yet. Chats use it once you add it to a project or turn it on in a chat.',
    );
    expect(await projectDefaults()).not.toContainEqual(ref);
    const select = projects.getByTestId('mcp-browse-detail-projects-select');
    if ((await select.count()) > 0)
      await select.selectOption('demo-ts-pnpm-vite');
    const add = projects.getByTestId('mcp-browse-detail-projects-add');
    await expect(add).toHaveText(/^Add to .+/);
    await add.click();
    await expect.poll(projectDefaults).toContainEqual(ref);
    await expect(
      projects.getByTestId('mcp-browse-detail-projects-status'),
    ).toHaveText(/^Enabled in .+\.$/);
    await projects.getByTestId('mcp-browse-detail-projects-remove').click();
    await expect.poll(projectDefaults).not.toContainEqual(ref);
    await expect(
      projects.getByTestId('mcp-browse-detail-projects-add'),
    ).toBeVisible();

    await window
      .getByRole('button', { name: 'Advanced configuration', exact: true })
      .click();
    await expect(window.getByTestId('mcp-server-use-oauth')).toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

// Plugins discovery page (API-2153 redesign, design.md §2/§3). Covers the
// five scenarios the redesign's Task 5 spec calls for:
//
//   1. Materialized curated plugins remain installed, while available role
//      recommendations appear in Suggested. Recommended badges and category overflow
//      remain covered, including the Developer tools group.
//   2. A search query flattens curated + marketplace content into one result
//      list with availability actions. The brief calls for "a
//      claude-plugins-official row from
//      seeded cache" — no such fixture exists in `seedPluginsCache.mjs` or
//      anywhere else in the harness (verified by search), so this uses that
//      seeder's real `demo/market` marketplace plugins instead. Query "tool"
//      deliberately matches both the seeded curated plugin (Writer *Tool*kit)
//      and every seeded marketplace plugin (alpha/beta/gamma/delta-*tool*),
//      which is enough to prove cross-source search without inventing fixture
//      data the seeder doesn't produce.
//   3. The Installed gear opens the management view directly, which uses the
//      shared sidebar structure; all five sections are reachable from its nav.
//   4. The "Add custom" dropdown's "Add marketplace…" item opens
//      `AddMarketplaceModal`.
//   5. With no curated content seeded, the page still renders: no
//      recommended/curated sections appear, and search still works over
//      marketplace-only rows.
//
// All state is seeded on disk before launch; no live agents, provider CLIs,
// or network requests are involved.

/**
 * Seed the Microsoft 365 family exactly as OpenAI's official feed ships it:
 * `logoUrl: null` on every row, and OpenAI credited as the author of products
 * it maintains for Microsoft — on the Codex facet as well as the top-level row.
 * A Codex-native row always carries `facets.codex`, and the plugin detail reads
 * the facet author first, so omitting the facet hides the bug this guards.
 */
function seedOfficialMicrosoftFamily(userDataDir) {
  const iso = '2026-08-27T00:00:00.000Z';
  const plugins = [
    ['outlook-calendar', 'Outlook Calendar', 'calendar-app'],
    ['outlook-email', 'Outlook Email', 'email-and-calendar-software'],
    ['sharepoint', 'SharePoint', 'sharepoint/collaboration'],
    ['teams', 'Teams', 'microsoft-teams/group-chat-software'],
  ].map(([name, displayName, slug]) => ({
    name,
    displayName,
    description: `${displayName} reference capability.`,
    category: 'Productivity',
    version: '0.1.8',
    author: 'OpenAI',
    logoUrl: null,
    homepage: `https://www.microsoft.com/en-us/${slug}`,
    sourcePath: '',
    marketplaceId: 'openai-curated',
    details: null,
    providerSupport: { claude: 'none', codex: 'native' },
    facets: {
      codex: {
        provider: 'codex',
        mode: 'native',
        name,
        displayName,
        version: '0.1.8',
        author: 'OpenAI',
        category: 'Productivity',
        homepage: `https://www.microsoft.com/en-us/${slug}`,
        installLocation: `/tmp/openai-curated/plugins/${name}`,
        sourcePath: `/tmp/openai-curated/plugins/${name}`,
      },
    },
  }));
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: iso,
    lastProviderRefreshAt: iso,
    marketplaces: [
      {
        id: 'openai-curated',
        name: 'Codex official',
        sourceType: 'github',
        sourceUrl: 'https://github.invalid/openai/curated',
        installLocation: '/tmp/openai-curated',
        lastUpdated: iso,
        pluginCount: plugins.length,
        plugins,
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: iso,
          },
          codex: {
            provider: 'codex',
            state: 'valid',
            accepted: true,
            pluginCount: plugins.length,
            lastCheckedAt: iso,
          },
        },
        validProviders: ['codex'],
      },
    ],
  });
}

function makeUserDataDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedCustomSkill(userDataDir) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    'aaa-marketplace-custom-skill',
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: aaa-marketplace-custom-skill',
      'description: Marketplace custom skill fixture.',
      '---',
      '',
      '# Marketplace Custom Skill',
      '',
      'Custom skill content loaded from the installed pill.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function seedMarketplaceDetailCollection(userDataDir) {
  const collection = {
    id: 'face-feed',
    name: 'Marketplace Local Review',
    description: 'Local release review capabilities.',
    skills: [],
    plugins: [],
    mcpServers: [],
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
  const collectionsDir = path.join(userDataDir, 'collections');
  writeJson(path.join(collectionsDir, 'index.json'), {
    version: 2,
    collections: [
      {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        updatedAt: collection.updatedAt,
        skillCount: 0,
        pluginCount: 0,
        mcpServerCount: 0,
      },
    ],
  });
  writeJson(path.join(collectionsDir, `collection-${collection.id}.json`), {
    version: 2,
    collection,
  });
}

/** Cards seeded for the windowing scenario; must clear the per-section cap. */
const WINDOWED_PLUGIN_COUNT = 150;

/**
 * Write a plugins cache holding `count` marketplace plugins in one
 * marketplace. `seedPluginsCache` deliberately seeds a fixed four-plugin
 * fixture that every other test asserts against, so the windowing scenario
 * writes its own cache rather than parameterizing the shared seeder.
 */
function seedManyMarketplacePlugins(userDataDir, count) {
  const iso = '2026-06-17T00:00:00.000Z';
  const plugins = Array.from({ length: count }, (_unused, index) => ({
    name: `windowed-tool-${String(index).padStart(3, '0')}`,
    description: 'A windowed marketplace plugin.',
    category: 'developer-tools',
    sourcePath: `plugins/windowed-tool-${index}`,
    marketplaceId: 'demo/market',
    details: {
      skills: [],
      agents: [],
      commands: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      hasReadme: false,
    },
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  }));
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: iso,
    lastProviderRefreshAt: iso,
    marketplaces: [
      {
        id: 'demo/market',
        name: 'Demo Market',
        description: 'Seeded marketplace',
        sourceType: 'github',
        // Not github.com — see the note in `seeders/seedPluginsCache.mjs`: a
        // real github.com owner would make these runs fetch a live avatar.
        sourceUrl: 'https://github.invalid/demo/market',
        installLocation: '/tmp/demo-market',
        lastUpdated: iso,
        pluginCount: plugins.length,
        plugins,
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: plugins.length,
            lastCheckedAt: iso,
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: iso,
          },
        },
        validProviders: ['claude'],
      },
    ],
  });
}

/**
 * Seed the recognizable category leaders shown in the supplied Codex
 * marketplace reference. The source array is intentionally reverse-priority:
 * the test proves browse curation, not fixture order, chooses what is visible.
 */
function seedCodexReferenceMarketplace(userDataDir, extraDefinitions = []) {
  const iso = '2026-08-27T00:00:00.000Z';
  const definitions = [
    ...extraDefinitions,
    ['granola', 'Granola', 'Productivity'],
    ['fireflies', 'Fireflies', 'Communication'],
    ['outlook-calendar', 'Outlook Calendar', 'Productivity'],
    ['plaud', 'Plaud', 'Business & Operations'],
    ['otter-ai', 'Otter.ai', 'Productivity'],
    ['atlassian-rovo', 'Atlassian Rovo', 'Productivity'],
    ['figma', 'Figma', 'Creativity'],
    ['canva', 'Canva', 'Creativity'],
    ['linear', 'Linear', 'Productivity'],
    ['slack', 'Slack', 'Communication'],
    ['notion', 'Notion', 'Productivity'],
    ['google-calendar', 'Google Calendar', 'Productivity'],
    ['google-drive', 'Google Drive', 'Productivity'],
    ['github', 'GitHub', 'Developer Tools'],
    ['gmail', 'Gmail', 'Communication'],
  ];
  const plugins = definitions
    .reverse()
    .map(([name, displayName, category]) => ({
      name,
      displayName,
      description: `${displayName} reference capability.`,
      category,
      // The official catalog does not consistently use OpenAI as publisher;
      // product marks must be keyed by the trusted marketplace source.
      author:
        name === 'notion' ? 'Notion' : name === 'figma' ? 'Figma' : 'OpenAI',
      homepage: `https://example.test/${name}`,
      sourcePath: '',
      marketplaceId: 'openai-curated',
      details: null,
      externalSource: {
        source: 'github',
        url: `https://github.invalid/openai/${name}.git`,
      },
      providerSupport: { claude: 'none', codex: 'native' },
      facets: {},
    }));
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: iso,
    lastProviderRefreshAt: iso,
    marketplaces: [
      {
        id: 'openai-curated',
        name: 'Codex official',
        sourceType: 'github',
        sourceUrl: 'https://github.invalid/openai/curated',
        installLocation: '/tmp/openai-curated',
        lastUpdated: iso,
        pluginCount: plugins.length,
        plugins,
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: iso,
          },
          codex: {
            provider: 'codex',
            state: 'valid',
            accepted: true,
            pluginCount: plugins.length,
            lastCheckedAt: iso,
          },
        },
        validProviders: ['codex'],
      },
    ],
  });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: new Date().toISOString(),
    servers: [
      {
        key: 'google-drive',
        name: 'Google Drive',
        shortDescription: 'Search, read, and manage files in Google Drive.',
        longDescription:
          'Connect Google Drive to search documents, read file contents, and upload new files.',
        url: 'https://google-drive.example.test/mcp',
        transport: 'http',
        authorName: 'Google',
        authorUrl: 'https://workspace.google.com/products/drive/',
        docsUrl: 'https://developers.google.com/drive',
        supportUrl: 'https://support.google.com/drive',
        privacyPolicyUrl: 'https://policies.google.com/privacy',
        categories: ['productivity', 'data'],
        popular: true,
        sortOrder: 0,
        updatedAt: iso,
      },
    ],
  });
}

/** Add deterministic non-recommended rows to the seeded Curated marketplace. */
function seedCuratedOverflow(userDataDir, count) {
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const marketplace = cache.marketplaces.find(
    (entry) => entry.id === 'curated/cloud',
  );
  const template = marketplace?.plugins.find(
    (plugin) => plugin.recommended !== true,
  );
  if (!marketplace || !template) {
    throw new Error(
      'Curated overflow fixture requires a seeded Curated plugin',
    );
  }

  const existing = marketplace.plugins.filter(
    (plugin) => plugin.recommended !== true,
  ).length;
  for (let index = existing; index < count; index += 1) {
    marketplace.plugins.push({
      ...JSON.parse(JSON.stringify(template)),
      name: `curated-overflow-${index}`,
      displayName: `Curated Overflow ${index}`,
      description: 'Deterministic Curated overflow fixture.',
      sourcePath: `curated-overflow-${index}`,
      recommended: false,
    });
  }
  marketplace.pluginCount = marketplace.plugins.length;
  writeJson(cachePath, cache);
}

function markMarketplacePluginInstalled(userDataDir, pluginName) {
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const plugin = cache.marketplaces
    .flatMap((marketplace) => marketplace.plugins)
    .find((candidate) => candidate.name === pluginName);
  if (!plugin) {
    throw new Error(`Marketplace plugin ${pluginName} was not seeded`);
  }
  plugin.globalInstallStatus = {
    claude: { available: true, installed: true },
    codex: { available: false, installed: false },
  };
  writeJson(cachePath, cache);
}

/** Materialize a seeded marketplace plugin so the app treats it as installed. */
function markMarketplacePluginMaterialized(userDataDir, pluginName) {
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const plugin = cache.marketplaces
    .flatMap((marketplace) => marketplace.plugins)
    .find((candidate) => candidate.name === pluginName);
  if (!plugin) {
    throw new Error(`Marketplace plugin ${pluginName} was not seeded`);
  }
  plugin.details = {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  writeJson(cachePath, cache);
}

async function saveProfileRoles(window, profileRoles) {
  await window.evaluate(
    (roles) => window.api.savePreferences({ profileRoles: roles }),
    profileRoles,
  );
}

function cleanupUnusedDir(userDataDir) {
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
}

test.describe('plugins discovery page', () => {
  let electronApp;
  let userDataDir;

  test.afterEach(async () => {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
      electronApp = undefined;
      userDataDir = undefined;
    }
  });

  test('Suggested separates catalog details from the direct Add flow', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-curation-');

    try {
      seedCodexReferenceMarketplace(userDataDir);
      markMarketplacePluginInstalled(userDataDir, 'github');

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const pluginFixture = JSON.parse(
        readFileSync(path.join(userDataDir, 'plugins-cache.json'), 'utf8'),
      ).marketplaces[0].plugins.find((plugin) => plugin.name === 'canva');
      await electronApp.evaluate(({ ipcMain }, plugin) => {
        let attempts = 0;
        ipcMain.removeHandler('plugins:install-plugin');
        ipcMain.handle('plugins:install-plugin', () => {
          attempts += 1;
          if (attempts === 1)
            return {
              success: false,
              error: 'Fixture installation failed. Try again.',
            };
          return {
            success: true,
            data: {
              ...plugin,
              details: {
                skills: [],
                agents: [],
                commands: [],
                hooks: [],
                mcpServers: [],
                lspServers: [],
                hasReadme: false,
              },
            },
          };
        });
      }, pluginFixture);
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // Designer picks are Figma, Miro and Canva; Miro is not in this catalog.
      await saveProfileRoles(window, ['designer']);
      await app.openPluginsPage();
      const marketplaceSearch = window.getByTestId('plugins-search');
      await expect(marketplaceSearch).toHaveAttribute('placeholder', 'Search…');
      await marketplaceSearch.fill('g');
      await marketplaceSearch.fill('');
      const typeTabs = window.getByTestId('plugins-type-tabs');
      const allTypeTab = window.getByTestId('plugins-type-tab-all');
      const pluginsTypeTab = window.getByTestId('plugins-type-tab-plugin');
      await expect(typeTabs).toBeVisible();
      await expect(typeTabs).toHaveCSS('overflow-y', 'hidden');
      await expect(allTypeTab).toHaveAttribute('aria-selected', 'true');
      // No producer of `extension` entries exists, so the tab is not offered.
      await expect(
        window.getByTestId('plugins-type-tab-extension'),
      ).toHaveCount(0);
      const allTypeTabBox = await allTypeTab.boundingBox();
      expect(allTypeTabBox).not.toBeNull();
      expect(allTypeTabBox.height).toBeGreaterThanOrEqual(28);
      const expandedHitTargets = await allTypeTab.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const testIdAt = (x, y) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[data-testid]')
            ?.getAttribute('data-testid') ?? null;
        return {
          rightExpansion: testIdAt(rect.right + 6, rect.top + rect.height / 2),
        };
      });
      expect(expandedHitTargets).toEqual({
        rightExpansion: 'plugins-type-tab-all',
      });
      await pluginsTypeTab.click();
      await expect(pluginsTypeTab).toHaveAttribute('aria-selected', 'true');
      await expect(allTypeTab).toHaveAttribute('aria-selected', 'false');
      await allTypeTab.click();
      await expect(allTypeTab).toHaveAttribute('aria-selected', 'true');

      const suggested = window.getByTestId('plugins-section-suggested');
      await expect(suggested).toBeVisible();
      await expect(
        suggested.getByTestId('plugins-section-heading-suggested'),
      ).toHaveText('Suggested');
      await expect(window.getByText('Featured', { exact: true })).toHaveCount(
        0,
      );
      await expect(
        suggested.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([/Figma/, /Canva/]);
      const visibleCardSubtitles = window.locator(
        '[data-testid^="plugins-card-subtitle-"]:visible',
      );
      expect(await visibleCardSubtitles.count()).toBeGreaterThan(0);
      const subtitleWordCounts = (
        await visibleCardSubtitles.allTextContents()
      ).map((subtitle) => subtitle.trim().split(/\s+/).filter(Boolean).length);
      expect(subtitleWordCounts.every((count) => count <= 7)).toBe(true);
      const canvaCard = suggested.getByTestId(
        'plugins-entry-mkt:openai-curated/canva',
      );
      const canvaAdd = suggested.getByTestId(
        'plugins-entry-add-mkt:openai-curated/canva',
      );
      const figmaCard = suggested.getByTestId(
        'plugins-entry-mkt:openai-curated/figma',
      );
      const developerTools = window.getByTestId(
        'plugins-section-category-developer-tools',
      );
      const githubMenu = developerTools.getByTestId(
        'plugins-entry-menu-mkt:openai-curated/github',
      );
      const githubCard = developerTools.getByTestId(
        'plugins-entry-mkt:openai-curated/github',
      );
      await expect(canvaAdd).toBeVisible();
      await expect(suggested).not.toContainText('GitHub');
      await expect(suggested).not.toContainText('Gmail');
      await expect(developerTools).toContainText('GitHub');
      await expect(githubMenu).toHaveCount(0);
      const productLogoSources = await Promise.all([
        figmaCard.locator('img').getAttribute('src'),
        canvaCard.locator('img').getAttribute('src'),
        githubCard.locator('img').getAttribute('src'),
      ]);
      expect(productLogoSources.every(Boolean)).toBe(true);
      // OpenAI publishes these integrations, but each card must keep the
      // connected product's identity instead of repeating one publisher mark.
      expect(new Set(productLogoSources).size).toBe(3);
      const addBox = await canvaAdd.boundingBox();
      expect(addBox).not.toBeNull();
      expect(addBox.height).toBeGreaterThanOrEqual(28);

      // Former fixed picks are no longer pulled out of their categories.
      const productivity = window.getByTestId(
        'plugins-section-category-productivity',
      );
      await expect(productivity).toBeVisible();
      await expect(
        productivity.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([
        /Granola/,
        /Fireflies/,
        /Outlook Calendar/,
        /Plaud/,
        /Otter.ai/,
        /Atlassian Rovo/,
        /Google Drive/,
        /Google Calendar/,
        /Linear/,
        /Notion/,
      ]);

      await canvaCard.click();
      const pluginDetail = window.getByTestId('plugin-catalog-detail');
      await expect(pluginDetail).toBeVisible();
      // The summary component draws no Back of its own, and neither does the
      // page around it: the titlebar breadcrumb leads out (CAN-4261).
      await expect(
        pluginDetail.getByRole('button', { name: 'Back' }),
      ).toHaveCount(0);
      await expect(pluginDetail).not.toContainText('Back to plugins');
      // Not a nested scroller: the page scrolls, and a scroll box here would
      // clip the ring and shadow of the header controls at its edge.
      await expect(pluginDetail).toHaveCSS('overflow-y', 'visible');
      // Add is the page's primary action, last in the Back row's action bar.
      const detailAdd = window
        .getByTestId('detail-action-bar')
        .getByTestId('plugin-catalog-detail-add');
      await expect(detailAdd).toBeVisible();
      await expect(detailAdd).toHaveAttribute(
        'data-execution-action-button',
        'true',
      );
      const detailAddBox = await detailAdd.boundingBox();
      expect(detailAddBox).not.toBeNull();
      expect(detailAddBox.height).toBeGreaterThanOrEqual(28);
      // Canva is Canva's product. The fixture credits OpenAI, as the official
      // feed does for the wrappers it maintains, and the source line already
      // names that marketplace. The detail must agree with the mark beside it.
      await expect(pluginDetail).toContainText('By Canva');
      await expect(pluginDetail).not.toContainText('By OpenAI');
      await expect(pluginDetail).toContainText('Canva reference capability.');
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();

      await canvaAdd.click();
      const addDialog = window.getByTestId('plugins-entry-detail');
      await expect(addDialog).toBeVisible();
      await expect(addDialog).toContainText('Canva');
      await expect(
        addDialog.getByRole('button', { name: 'Install Canva' }),
      ).toBeVisible();
      await expect(addDialog).toContainText(
        'Fixture installation failed. Try again.',
      );
      await addDialog.getByRole('button', { name: 'Install Canva' }).click();
      // Installing only installs: the details never offer sign-in.
      await expect(
        addDialog.getByRole('button', { name: 'Install Canva' }),
      ).toHaveCount(0);
      await expect(
        addDialog.getByTestId('plugin-account-connection'),
      ).toHaveCount(0);
      await expect(addDialog).not.toContainText(
        'Fixture installation failed. Try again.',
      );
      await expect(window.getByTestId('plugin-catalog-detail')).toHaveCount(0);
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      // Cached content is installed in the app even when no external provider
      // app has a global installation. Returning must not advertise Add again,
      // and the installed plugin leaves Suggested for Installed.
      await expect(
        window.getByTestId('plugins-entry-add-mkt:openai-curated/canva'),
      ).toHaveCount(0);
      await expect(
        suggested.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([/Figma/]);
      // CAN-4261: All previews 8 installed rows; a search lists every match.
      await window.getByTestId('plugins-search').fill('Canva');
      await window
        .getByTestId('customize-section-installed')
        .getByTestId('customize-row-mkt:openai-curated/canva')
        .click();
      await expect(window.getByTestId('plugin-catalog-detail')).toHaveCount(0);
      await expect(window.getByTestId('plugin-detail-host')).toBeVisible();
      await expect(
        window.getByRole('button', { name: 'Install Canva', exact: true }),
      ).toHaveCount(0);
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await window.getByTestId('plugins-search-clear').click();

      const visibleOfficialPluginCards = window.locator(
        '[data-testid^="plugins-entry-mkt:openai-curated/"]:visible',
      );
      await expect(
        window.locator(
          '[data-testid^="marketplace-product-logo-mkt:openai-curated/"]:visible',
        ),
      ).toHaveCount(await visibleOfficialPluginCards.count());
      await expect(
        window.locator(
          '[data-testid^="marketplace-product-logo-fallback-mkt:openai-curated/"]:visible',
        ),
      ).toHaveCount(0);

      await window.getByTestId('plugins-type-tab-app').click();
      await window
        .getByTestId('plugins-entry-mcp-catalog:google-drive')
        .click();
      const mcpDetail = window.getByTestId('mcp-browse-detail');
      await expect(mcpDetail).toBeVisible();
      // No Back in the curated-app component either, as above (CAN-4261).
      await expect(mcpDetail.getByRole('button', { name: 'Back' })).toHaveCount(
        0,
      );
      await expect(mcpDetail).not.toContainText('Back to plugins');
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('Suggested follows the saved role and leaves installed picks to Installed', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-suggested-');

    try {
      seedCodexReferenceMarketplace(userDataDir, [
        ['hubspot', 'HubSpot', 'Business & Operations'],
        ['stripe', 'Stripe', 'Business & Operations'],
      ]);
      markMarketplacePluginMaterialized(userDataDir, 'figma');

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await saveProfileRoles(window, ['designer']);
      await app.openPluginsPage();

      // Figma is a designer pick but already installed: it belongs to
      // Installed, and Suggested does not backfill another role's picks.
      const suggested = window.getByTestId('plugins-section-suggested');
      await expect(
        suggested.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([/Canva/]);
      // CAN-4261: All previews 8 installed rows; a search lists every match.
      await window.getByTestId('plugins-search').fill('Figma');
      await expect(
        window
          .getByTestId('customize-section-installed')
          .getByTestId('customize-row-mkt:openai-curated/figma'),
      ).toBeVisible();
      await window.getByTestId('plugins-search-clear').click();
      await expect(
        suggested.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([/Canva/]);

      // Changing the saved role while the page is open replaces the picks.
      await saveProfileRoles(window, ['founder']);
      await expect(
        suggested.locator('[data-marketplace-entry="true"]'),
      ).toHaveText([/HubSpot/, /Stripe/]);
      await expect(suggested).not.toContainText('Canva');

      // A role whose picks are absent from this catalog falls back to the
      // default role, which is also absent here, so the section disappears.
      await saveProfileRoles(window, ['support']);
      await expect(window.getByTestId('plugins-section-suggested')).toHaveCount(
        0,
      );
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('materialized curated plugin stays installed with category overflow capped', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-curated-');

    try {
      seedPluginsCache({ userDataDir });
      seedCuratedPlugins({ userDataDir });
      seedCuratedOverflow(userDataDir, 13);

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      await window.setViewportSize({ width: 1400, height: 900 });
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await expect(
        window.locator('[data-testid^="plugins-category-chip-"]'),
      ).toHaveCount(0);

      // The curated seeder materializes both plugins. App availability must
      // not depend on either external provider's global installation flags.
      await expect(window.getByTestId('plugins-section-suggested')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('customize-row-curated:writer-toolkit'),
      ).toBeVisible();
      const writerToolkitEntry = window.getByTestId(
        'plugins-entry-curated:writer-toolkit',
      );
      await expect(
        window.getByTestId('plugins-entry-add-curated:writer-toolkit'),
      ).toHaveCount(0);
      await expect(writerToolkitEntry).toBeVisible();
      await expect(writerToolkitEntry).toContainText('Writer Toolkit');
      await expect(writerToolkitEntry).toContainText('Recommended');
      const cardBox = await writerToolkitEntry.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox.height).toBeGreaterThanOrEqual(44);

      const developerToolsSection = window.getByTestId(
        'plugins-section-category-developer-tools',
      );
      await expect(developerToolsSection).toBeVisible();
      await expect(developerToolsSection).toHaveAttribute(
        'data-row-count',
        '10',
      );
      const developerToolsCollapsedCount = Number(
        await developerToolsSection.getAttribute('data-collapsed-count'),
      );
      expect(developerToolsCollapsedCount).toBeGreaterThan(0);
      const developerToolsHeading = developerToolsSection.getByTestId(
        'plugins-section-heading-category-developer-tools',
      );
      await expect(developerToolsHeading).toHaveText('Developer tools');
      await expect(developerToolsHeading).toHaveAttribute(
        'aria-label',
        'Browse Developer tools',
      );
      await expect(
        developerToolsSection.getByTestId(
          'plugins-section-more-category-developer-tools',
        ),
      ).toHaveCount(0);
      await developerToolsHeading.click();
      const categoryPage = window.getByTestId('plugins-category-page');
      await expect(categoryPage).toBeVisible();
      const categoryHeading = categoryPage.getByRole('heading', {
        name: 'Developer tools',
        level: 1,
      });
      await expect(categoryHeading).toBeVisible();
      await expect(
        window.getByTestId('plugins-category-breadcrumb-current'),
      ).toHaveAttribute('aria-current', 'page');
      const categorySearch = categoryPage.getByTestId(
        'plugins-category-search',
      );
      await expect(categorySearch).toHaveAttribute('placeholder', 'Search…');
      await categorySearch.fill('repo');
      await categorySearch.fill('');
      await expect(
        categoryPage.getByTestId('plugins-section-category-page'),
      ).toHaveAttribute(
        'data-row-count',
        String(developerToolsCollapsedCount + 10),
      );
      const developerToolsEntry = categoryPage.getByTestId(
        'plugins-entry-curated:repo-search',
      );
      await expect(developerToolsEntry).toBeVisible();
      await expect(developerToolsEntry).toContainText('Repo Search');
      await expect(developerToolsEntry).not.toContainText('Available');
      // The non-recommended row must NOT carry the badge — otherwise the
      // assertions above would be meaningless (every row could match).
      await expect(developerToolsEntry.getByText('Recommended')).toHaveCount(0);
      const titlebarBack = window.getByTestId('nav-history-back');
      await expect(titlebarBack).toBeEnabled();
      await titlebarBack.click();
      await expect(categoryPage).toHaveCount(0);
      await expect(
        window.getByRole('heading', { name: 'Customize', level: 1 }),
      ).toBeVisible();
      await expect(developerToolsSection).toBeVisible();
      await expect(developerToolsSection).toHaveAttribute(
        'data-row-count',
        '10',
      );
      const installedHeading = window.locator(
        '#customize-section-installed-heading',
      );
      const installedSection = window.getByTestId(
        'customize-section-installed',
      );
      await expect(installedHeading).toBeVisible();
      await expect(installedSection).toBeVisible();

      const developerToolsColumns = await developerToolsSection
        .getByTestId('plugins-section-body-category-developer-tools')
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(' ').length,
        );
      expect(developerToolsColumns).toBe(2);
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('search renders one flat list with Add and installed actions', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-search-');

    try {
      seedPluginsCache({ userDataDir });
      markMarketplacePluginInstalled(userDataDir, 'gamma-tool');
      seedCuratedPlugins({ userDataDir });
      const now = '2026-08-27T00:00:00.000Z';
      seedMcpServers({
        userDataDir,
        servers: [
          {
            definition: {
              id: 'search-fixture-mcp',
              name: 'Search Fixture MCP',
              description: 'MCP server used to verify the peer type tab.',
              type: 'http',
              url: 'https://mcp.example.test',
              createdAt: now,
              updatedAt: now,
            },
            configs: [
              {
                id: 'default',
                name: 'Default',
                enabled: true,
                envVars: {},
                extraArgs: [],
                extraHeaders: {},
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      await window.setViewportSize({ width: 1400, height: 900 });
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      const mcpTab = window.getByTestId('plugins-type-tab-app');
      await expect(mcpTab).toBeVisible();
      await expect(mcpTab).toHaveText('MCP servers');
      await mcpTab.click();
      await expect(mcpTab).toHaveAttribute('aria-selected', 'true');
      // An installed MCP server is an Installed row, not a catalog card.
      await expect(
        window
          .getByTestId('customize-section-installed')
          .getByTestId('customize-row-mcp-local:search-fixture-mcp'),
      ).toBeVisible();
      await window.getByTestId('plugins-type-tab-all').click();

      await window.getByTestId('plugins-search').fill('tool');

      const searchResults = window.getByTestId(
        'plugins-section-plugins-and-mcp',
      );
      await expect(searchResults).toBeVisible();
      await expect(searchResults.getByRole('heading')).toHaveText(
        'Plugins and MCP servers',
      );
      await expect(
        searchResults.getByTestId('plugins-entry-curated:writer-toolkit'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugins-section-recommended'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('customize-section-installed'),
      ).toBeVisible();

      await expect(
        searchResults.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toBeVisible();
      await expect(
        searchResults.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toContainText('Alpha Tool');
      await expect(
        searchResults.getByTestId('plugins-entry-mkt:demo/market/beta-tool'),
      ).toBeVisible();
      await expect(
        searchResults.getByTestId(
          'plugins-entry-add-mkt:demo/market/alpha-tool',
        ),
      ).toHaveText('Add');
      await expect(
        searchResults.getByTestId(
          'plugins-entry-menu-mkt:demo/market/gamma-tool',
        ),
      ).toHaveCount(0);
      await expect(
        searchResults.getByTestId(
          'plugins-entry-add-mkt:demo/market/gamma-tool',
        ),
      ).toHaveCount(0);

      // Search keeps the same two-column maximum as browse mode.
      await expect
        .poll(() =>
          searchResults
            .getByTestId('plugins-section-body-plugins-and-mcp')
            .evaluate(
              (element) =>
                getComputedStyle(element).gridTemplateColumns.split(' ').length,
            ),
        )
        .toBe(2);

      // A query that matches nothing narrows every band away.
      await window.getByTestId('plugins-search').fill('zzz-no-match-zzz');
      await expect(
        window.getByText('Nothing matches your search.'),
      ).toBeVisible();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('available shared pipeline Add opens details before its editor flow', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-capability-marketplace-search-');

    try {
      seedPluginsCache({ userDataDir });
      seedStoredPipeline({
        userDataDir,
        id: 'tool-release',
        name: 'Tool Release Pipeline',
        description: 'Publishes the tool release artifact.',
        yaml: [
          'name: Tool Release Pipeline',
          'description: Publishes the tool release artifact.',
          'on: dispatch',
          'jobs:',
          '  release:',
          '    steps:',
          '      - run: echo release',
          '',
        ].join('\n'),
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const saveResult = await window.evaluate(async () => {
        return window.api.saveCanopyCloudApiKey({
          apiKey: 'csk_marketplace_shared_pipeline_add_e2e',
        });
      });
      expect(saveResult.status.authenticated).toBe(true);
      await app.openPluginsPage();

      await expect(
        window.getByRole('heading', { name: 'Customize', exact: true }),
      ).toBeVisible();
      const search = window.getByTestId('plugins-search');
      await search.fill('Shared Dispatch');

      await search.press('ArrowDown');
      await expect(
        window.getByTestId(
          'plugins-entry-pipeline:shared:shared:canopy-cloud:shared-dispatch',
        ),
      ).toBeFocused();
      await search.focus();
      await search.press('Escape');
      await expect(search).toHaveValue('');
      await search.fill('Shared Dispatch');
      const pipelineEntry = window.getByTestId(
        'plugins-entry-pipeline:shared:shared:canopy-cloud:shared-dispatch',
      );
      await expect(pipelineEntry).toBeVisible();
      await expect(pipelineEntry).toContainText('Pipeline');

      await window.getByTestId('plugins-type-tab-workflow').click();
      await expect(search).toHaveValue('Shared Dispatch');
      await expect(pipelineEntry).toBeVisible();
      await expect(
        window.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toHaveCount(0);

      await window
        .getByTestId(
          'plugins-entry-add-pipeline:shared:shared:canopy-cloud:shared-dispatch',
        )
        .click();
      await expect(window.getByTestId('pipeline-catalog-detail')).toBeVisible();
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-current'),
      ).toHaveText('Shared Dispatch Pipeline');
      // CAN-3484: the entity type sits between Marketplace and the title.
      await expect(
        window
          .getByTestId('plugins-entry-detail-breadcrumbs')
          .getByRole('listitem'),
      ).toHaveText(['Customize', 'Workflows', 'Shared Dispatch Pipeline']);
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-type'),
      ).toHaveAttribute('data-entry-kind', 'pipeline');
      await expect(window.getByTestId('pipeline-editor-back')).toHaveCount(0);

      await window.getByTestId('pipeline-catalog-open-editor').click();
      await expect(window.getByTestId('pipeline-editor-back')).toBeVisible();
      await expect(
        window.getByText('Shared Dispatch Pipeline', { exact: true }),
      ).toBeVisible();

      await window.getByTestId('pipeline-editor-back').click();
      await expect(window.getByTestId('pipeline-catalog-detail')).toBeVisible();
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(search).toHaveValue('Shared Dispatch');
      await expect(
        window.getByTestId('plugins-type-tab-workflow'),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(pipelineEntry).toBeVisible();
      await window.getByTestId('plugins-search-clear').click();
      await expect(search).toHaveValue('');
      await expect(
        window
          .getByTestId('customize-section-browse')
          .getByRole('heading', { name: /^Browse workflows/ }),
      ).toBeVisible();

      // An installed detail can cross into the pipeline editor. Returning
      // must preserve its Installed breadcrumb, which leads back to the
      // management section (CAN-4261: the page has no Back).
      await window.getByTestId('plugins-type-tab-all').click();
      await app.openPluginsTab('installed');
      const installedSection = window.getByTestId(
        'plugins-management-section-installed',
      );
      await installedSection
        .getByText('Tool Release Pipeline', { exact: true })
        .click();
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-installed'),
      ).toBeVisible();
      await window.getByTestId('pipeline-catalog-open-editor').click();
      await window.getByTestId('pipeline-editor-back').click();
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-installed'),
      ).toBeVisible();
      await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
        0,
      );
      await window
        .getByTestId('plugins-entry-detail-breadcrumb-installed')
        .click();
      await expect(installedSection).toBeVisible();

      // Pipelines has no dedicated management section, so its type crumb
      // returns to the existing Marketplace Pipelines filtered view.
      await installedSection
        .getByText('Tool Release Pipeline', { exact: true })
        .click();
      await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
      await expect(
        window.getByTestId('plugins-type-tab-workflow'),
      ).toHaveAttribute('aria-selected', 'true');
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('automations are a first-class Marketplace kind: one row each, added and opened from their details', async () => {
    test.setTimeout(150_000);
    userDataDir = makeUserDataDir('canopy-marketplace-automations-');
    const apiKey = 'csk_can3533_marketplace_automations';
    // The mock serves one shared-automation document, under this id.
    const availableShareId = 'c1f5d3a2-7b6e-4c2d-9a1b-0e8f7d6c5b4a';
    const installedShareId = '5d0a7c1e-3b2f-4a6d-8e9c-0f1a2b3c4d5e';
    const publicShareId = '7a1c3e5f-9b2d-4f6a-8c0e-1d3b5a7f9c2e';
    const installedShareHash = 'e2'.repeat(32);
    const sharedAutomation = (id, name, contentHash) => ({
      id,
      name,
      description: 'Shared with the team.',
      triggerKind: 'cron',
      actionType: 'app_advisor_prompt',
      contentHash,
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'can3533-team',
        name: 'Platform',
        organization: { id: 'can3533-org', name: 'Acme' },
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      createdBy: { id: 'can3533-author', name: 'Author', email: null },
      canUpdate: false,
      canDelete: false,
      publicShare: null,
    });
    const localActivity = (id, name, extra = {}) => ({
      version: 1,
      id,
      name,
      // Disabled so nothing is scheduled while the spec runs.
      enabled: false,
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Summarize the day.' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      failureCount: 0,
      ...extra,
    });

    try {
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
        cloud: {
          sharedAutomations: [
            sharedAutomation(
              availableShareId,
              'Nightly review',
              'd1'.repeat(32),
            ),
            sharedAutomation(
              installedShareId,
              'Team digest',
              installedShareHash,
            ),
            {
              ...sharedAutomation(
                publicShareId,
                'Public channel review',
                'f3'.repeat(32),
              ),
              shareScope: 'private',
              owner: { type: 'user', id: 'can3533-author', name: 'Author' },
              publicShare: {
                externalId: '8b2d4f6a-0c1e-4a3b-9d5f-7e2c4a6b8d0f',
              },
            },
          ],
        },
      });
      seedPluginsCache({ userDataDir });
      seedAutomations({
        userDataDir,
        activities: [
          localActivity('morning-standup', 'Morning standup'),
          localActivity('team-digest-copy', 'Team digest', {
            installedFrom: {
              remoteId: installedShareId,
              contentHash: installedShareHash,
              installedAt: '2026-09-01T00:00:00.000Z',
            },
          }),
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const saveResult = await window.evaluate(
        async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
        apiKey,
      );
      expect(saveResult.status.authenticated).toBe(true);

      // Both section names keep finding the same navigation command.
      for (const query of ['marketplace', 'customize']) {
        await window.getByTestId('sidebar-search').click();
        const palette = window.getByTestId('command-palette');
        await window.getByTestId('command-palette-input').fill(query);
        const command = palette
          .getByTestId('command-palette-result')
          .filter({ hasText: 'Open Customize' });
        await expect(command).toHaveCount(1);
        await command.click();
        await app.expectPluginsPage();
      }
      await window.getByTestId('sidebar-nav-workflows').click();
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+5' : 'Control+5',
      );
      await app.expectPluginsPage();

      // The sidebar row is named after the page it opens.
      await expect(window.getByTestId('sidebar-nav-plugins')).toHaveText(
        'Customize',
      );
      await app.openPluginsPage();
      await expect(
        window.getByRole('heading', { name: 'Customize', exact: true }),
      ).toBeVisible();
      await expect(
        window.getByText(
          'Add and manage plugins, MCP servers, skills, workflows, collections, and agents.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugins-type-tabs').getByRole('tab'),
      ).toHaveText([
        'All',
        'Plugins',
        'MCP servers',
        'Skills',
        'Workflows',
        'Collections',
        // Shared agents list behind the Agents rollout flag, which is on by
        // default in this build (CAN-3009).
        'Agents',
        // Marketplace sources, listed when the host can manage them
        // (CAN-4262).
        'Marketplaces',
      ]);

      // Local automations live in Installed; catalog shares live in Browse.
      await window.getByTestId('plugins-type-tab-workflow').click();
      const installedSection = window.getByTestId(
        'customize-section-installed',
      );
      const local = installedSection.getByTestId(
        'customize-row-automation:local:morning-standup',
      );
      await expect(local).toBeVisible();
      await expect(
        installedSection.getByTestId(
          'customize-row-automation:local:team-digest-copy',
        ),
      ).toBeVisible();
      const section = window.getByTestId('customize-section-browse');
      const available = section.getByTestId(
        `plugins-entry-automation:shared:${availableShareId}`,
      );
      await expect(available).toBeVisible();
      await expect(local).toContainText('Automation');
      const sectionOrder = await window
        .getByTestId('customize-sections')
        .locator(':scope > section')
        .evaluateAll((nodes) => nodes.map((node) => node.id));
      expect(sectionOrder.indexOf('customize-section-installed')).toBeLessThan(
        sectionOrder.indexOf('customize-section-browse'),
      );
      // An installed publication remains in Browse with its own identity.
      await expect(
        section.getByTestId(
          `plugins-entry-automation:shared:${installedShareId}`,
        ),
      ).toBeVisible();
      await expect(
        section.getByTestId(`plugins-entry-automation:shared:${publicShareId}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(
          'plugins-entry-add-automation:local:morning-standup',
        ),
      ).toHaveCount(0);

      // Add on a team share opens the install review straight from the card
      // (CAN-3710); the detail page is not visited first.
      await window
        .getByTestId(`plugins-entry-add-automation:shared:${availableShareId}`)
        .click();
      const modal = window.getByTestId('install-shared-automation-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByTestId('install-automation-submit')).toHaveText(
        'Install and enable',
      );
      // No Cancel: the close button dismisses the wizard (CAN-3651).
      await expect(
        modal.getByRole('button', { name: 'Cancel', exact: true }),
      ).toHaveCount(0);
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(
        window.getByTestId('shared-automation-marketplace-detail'),
      ).toHaveCount(0);
      // Opening the card previews the share without starting an install.
      await window
        .getByTestId(`plugins-entry-automation:shared:${availableShareId}`)
        .click();
      await expect(
        window.getByTestId('shared-automation-marketplace-detail'),
      ).toBeVisible();
      await expect(
        window.getByTestId('shared-automation-preview'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-type'),
      ).toHaveText('Workflows');
      await expect(window.getByTestId('automation-source-install')).toHaveText(
        'Add',
      );

      // The type crumb returns to the Automations tab.
      await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
      await expect(
        window.getByRole('tab', { name: 'Workflows', exact: true }),
      ).toHaveAttribute('aria-selected', 'true');

      // A local automation opens in the Automations editor from its detail.
      await local.click();
      const detail = window.getByTestId('automation-catalog-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId('automation-catalog-origin')).toHaveText(
        'Local',
      );
      await expect(detail.getByTestId('automation-catalog-status')).toHaveText(
        'Disabled',
      );
      await window
        .getByTestId('detail-action-bar')
        .getByTestId('automation-catalog-open')
        .click();
      // It opens in the Workflows edit shell (CAN-4072).
      await expect(window.getByTestId('workflow-edit-shell')).toHaveAttribute(
        'data-kind',
        'automation',
      );
      await expect(window.getByTestId('automations-form-name')).toHaveValue(
        'Morning standup',
      );
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => undefined);
    }
  });

  test('Workflows without automations still shows installed pipelines', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-marketplace-automations-empty-');
    seedPluginsCache({ userDataDir });

    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();

    await window.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await expect(
      window.getByTestId('customize-section-installed'),
    ).toBeVisible();
    await expect(
      window.getByText('No automations yet', { exact: true }),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('plugins-automations-empty-open'),
    ).toHaveCount(0);
  });

  test('skills tab opens installed details and preserves management deep links', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-skills-');

    try {
      seedPluginsCache({ userDataDir });
      seedCustomSkill(userDataDir);

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      await window.getByTestId('plugins-type-tab-skill').click();
      const installedStrip = window.getByTestId('customize-section-installed');
      await expect(installedStrip).toBeVisible();
      await expect(
        installedStrip.locator('[data-testid^="customize-row-"]'),
      ).not.toHaveCount(0);
      await expect(window.getByTestId('plugins-section-installed')).toHaveCount(
        0,
      );
      await expect(
        installedStrip.getByRole('heading', { name: /^Installed/ }),
      ).toBeVisible();
      await expect(
        window.getByText(
          'Nothing here yet. Use Add custom to bring in your own.',
          { exact: true },
        ),
      ).toHaveCount(0);

      await window
        .getByTestId(
          'customize-row-skill:custom:app:aaa-marketplace-custom-skill',
        )
        .click();
      // CAN-3483: custom skills open the same detail page as every other
      // installed skill instead of a dialog.
      const customSkillPage = window.getByTestId('plugins-entry-detail');
      await expect(customSkillPage).toBeVisible();
      await expect(customSkillPage).not.toHaveAttribute('role', 'dialog');
      await expect(customSkillPage).toContainText(
        'Custom skill content loaded from the installed pill.',
      );
      await expect(window.getByTestId('skill-read-detail-edit')).toBeVisible();
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(customSkillPage).toHaveCount(0);

      await window
        .getByTestId('customize-row-skill:builtin:app:canopy-config')
        .click();
      const skillDetail = window.getByTestId('plugins-entry-detail');
      await expect(skillDetail).toBeVisible();
      await expect(skillDetail).not.toHaveAttribute('role', 'dialog');
      // The breadcrumb shows the title-cased display name, not the raw slug.
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-current'),
      ).toHaveText('Canopy Config');
      await expect(skillDetail).toContainText(
        'This skill is the source of truth for:',
      );
      // CAN-3484: a detail opened from an installed list keeps that level.
      const breadcrumbs = window
        .getByTestId('plugins-entry-detail-breadcrumbs')
        .getByRole('listitem');
      await expect(breadcrumbs).toHaveText([
        'Customize',
        'Skills',
        'Canopy Config',
      ]);
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(skillDetail).toHaveCount(0);

      // The type breadcrumb returns to the Skills catalog, without management.
      await window
        .getByTestId('customize-row-skill:builtin:app:canopy-config')
        .click();
      await expect(skillDetail).toBeVisible();
      await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
      await expect(skillDetail).toHaveCount(0);
      await expect(
        window.getByTestId('plugins-type-tab-skill'),
      ).toHaveAttribute('aria-selected', 'true');

      // The Installed crumb of a detail opened in management restores that
      // exact section (CAN-4261: the page has no Back).
      await window.getByTestId('plugins-type-tab-all').click();
      await app.openPluginsTab('installed');
      await expect(window.getByTestId('plugins-management-view')).toBeVisible();
      await expect(
        window.getByTestId('plugins-management-section-installed'),
      ).toBeVisible();
      await window
        .getByTestId('plugins-management-section-installed')
        .getByTestId('plugins-entry-skill:builtin:app:canopy-config')
        .click();
      await expect(skillDetail).toBeVisible();
      await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
        0,
      );
      await window
        .getByTestId('plugins-entry-detail-breadcrumb-installed')
        .click();
      await expect(skillDetail).toHaveCount(0);
      await expect(
        window.getByTestId('plugins-management-section-installed'),
      ).toBeVisible();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('shared skills and local/shared Collections open detail sub-pages and return', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-shared-details-');

    try {
      seedPluginsCache({ userDataDir });
      seedMarketplaceDetailCollection(userDataDir);
      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.evaluate(async () =>
        window.api.saveCanopyCloudApiKey({
          apiKey: 'csk_marketplace_shared_details_e2e',
        }),
      );
      await app.openPluginsPage();

      await expect
        .poll(async () => {
          const { activity } = await getScenarioActivity(
            DEFAULT_MOCK_BASE_URL,
            'csk_marketplace_shared_details_e2e',
          );
          return [
            activity.marketplaceSharedAgentsList ?? 0,
            activity.marketplaceSharedPluginsList ?? 0,
            activity.marketplaceSharedTemplatesList ?? 0,
          ];
        })
        // Agents read twice: the catalog page and the viewer's own shares
        // (`createdBy=me`) for "Shared by me" (CAN-4261). Each reads once.
        .toEqual([2, 1, 1]);

      for (const [query, entryId, displayName, coreTestId] of [
        [
          'Marketplace Review Skill',
          'skill:shared:marketplace-review-skill',
          'Marketplace Review Skill',
          'skill-read-detail',
        ],
        [
          'Marketplace Local Review',
          'collection:local:face-feed',
          'Marketplace Local Review',
          null,
        ],
        [
          'Marketplace Review Collection',
          'collection:shared:marketplace-review-collection',
          'Marketplace Review Collection',
          null,
        ],
      ]) {
        const search = window.getByTestId('plugins-search');
        await search.fill(query);
        // CAN-4261: installed and owned items are section rows, catalog
        // items Browse cards.
        await window
          .getByTestId(`plugins-entry-${entryId}`)
          .or(window.getByTestId(`customize-row-${entryId}`))
          .first()
          .click();
        const detail = window.getByTestId('plugins-entry-detail');
        await expect(detail).toBeVisible();
        await expect(detail).not.toHaveAttribute('role', 'dialog');
        await expect(
          window.getByTestId('plugins-entry-detail-breadcrumb-current'),
        ).toHaveText(displayName);
        if (coreTestId) {
          await expect(window.getByTestId(coreTestId)).toBeVisible();
        }
        await window
          .getByTestId('plugins-entry-detail-breadcrumb-root')
          .click();
        await expect(detail).toHaveCount(0);
      }
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
    }
  });

  test('installed strip keeps chip heights aligned and its heading opens management directly', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-management-');

    try {
      seedManyMarketplacePlugins(userDataDir, 10);
      for (let index = 0; index < 10; index += 1) {
        markMarketplacePluginInstalled(
          userDataDir,
          `windowed-tool-${String(index).padStart(3, '0')}`,
        );
      }

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      const dormantManagementView = window.getByTestId(
        'plugins-management-view',
      );
      await expect(dormantManagementView).toBeHidden();
      await expect(dormantManagementView).toHaveAttribute('data-open', 'false');
      const resourceMonitor = window.getByTestId(
        'sidebar-titlebar-resource-monitor',
      );
      await expect(resourceMonitor).toBeVisible();

      const installed = window.getByTestId('customize-section-installed');
      await expect(installed).toBeVisible();
      await expect(installed.locator('li')).toHaveCount(8);
      const expand = installed.getByRole('button', { name: /^Show all / });
      await expect(expand).toBeVisible();
      await expand.click();
      await expect(expand).toHaveCount(0);
      await app.openPluginsTab('installed');
      const managementView = window.getByTestId('plugins-management-view');
      await expect(managementView).toBeVisible();
      await expect(managementView).toHaveAttribute('data-open', 'true');
      await expect(
        window.getByTestId('plugins-management-section-installed'),
      ).toBeVisible();
      const installedSection = window.getByTestId(
        'plugins-management-section-installed',
      );
      const installedHeading = installedSection.getByRole('heading', {
        name: 'Installed plugins',
        level: 1,
      });
      await expect(installedHeading).toBeVisible();
      await expect(
        window.getByTestId('plugins-installed-gear-surface'),
      ).toHaveCount(0);

      const sidebar = window.getByTestId('plugins-management-sidebar');
      await expect(sidebar).toBeVisible();
      await expect(
        window.getByTestId('plugins-management-sidebar-resize-handle'),
      ).toBeVisible();
      await expect(window.getByTestId('plugins-management-back')).toBeVisible();

      for (const [section, heading] of [
        ['installed', 'Installed plugins'],
        ['skills', 'Skills'],
        ['mcp', 'MCP servers'],
        ['collections', 'Collections'],
        ['marketplaces', 'Marketplaces'],
      ]) {
        await window.getByTestId(`plugins-management-nav-${section}`).click();
        const managementSection = window.getByTestId(
          `plugins-management-section-${section}`,
        );
        await expect(managementSection).toBeVisible();
        await expect(
          managementSection.getByTestId('page-heading'),
        ).toBeVisible();
        await expect(
          managementSection.getByRole('heading', { name: heading, level: 1 }),
        ).toBeVisible();
      }

      await window.getByTestId('plugins-management-back').click();
      await expect(managementView).toBeHidden();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('installed strip keeps a bundled brand mark when the curated catalog is empty', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-installed-mark-');

    try {
      // No curated catalog is seeded and the harness has no network, so the
      // MCP catalog resolves empty — the same degraded state a real install
      // hits offline or under a brand whose catalog omits a key. The server
      // still stores the key it was installed under, and the mark for
      // `stripe` ships with the app.
      const now = '2026-09-08T00:00:00.000Z';
      const configs = [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ];
      seedMcpServers({
        userDataDir,
        servers: [
          {
            definition: {
              id: 'curated-stripe',
              name: 'Stripe',
              description: 'Curated Stripe MCP server',
              type: 'http',
              url: 'https://stripe.example.test/mcp',
              httpAuthHandler: 'canopy',
              curated: { key: 'stripe' },
              createdAt: now,
              updatedAt: now,
            },
            configs,
          },
          {
            definition: {
              id: 'custom-http',
              name: 'Custom',
              description: 'Hand-added server with no catalog lineage',
              type: 'http',
              url: 'https://custom.example.test/mcp',
              createdAt: now,
              updatedAt: now,
            },
            configs,
          },
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      const strip = window.getByTestId('customize-section-installed');
      await expect(strip).toBeVisible();

      // Projected as a local server (the catalog did not claim the key)...
      const stripeTile = strip.getByTestId(
        'customize-row-mcp-local:curated-stripe',
      );
      await expect(stripeTile).toBeVisible();
      // ...yet the chip shows the bundled Stripe mark, not an "S" monogram,
      // matching what a discovery card for the same key would render.
      const stripeLogo = stripeTile.locator('img');
      await expect(stripeLogo).toBeVisible();
      await expect(stripeLogo).toHaveJSProperty('tagName', 'IMG');
      await expect(stripeLogo).toHaveAttribute('src', /^data:image\/svg\+xml/);
      await expect(
        stripeTile.locator('img').locator('..').getByText('S', { exact: true }),
      ).toHaveCount(0);

      // A server with no catalog lineage still falls back to its monogram.
      const customTile = strip.getByTestId(
        'customize-row-mcp-local:custom-http',
      );
      await expect(customTile).toBeVisible();
      await expect(customTile.getByText('C', { exact: true })).toHaveText('C');
      await expect(customTile.locator('img')).toHaveCount(0);

      // Device-local servers say where they run.
      await expect(
        customTile.getByTestId('plugins-surface-mcp-local:custom-http'),
      ).toHaveText('Desktop only');
      // The row reads its name, then its type label (CAN-4261), then where it
      // runs.
      await expect(customTile).toHaveAccessibleName(
        /Custom MCP server.*Desktop only/i,
      );
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('the add-custom dropdown prioritizes HTTP MCP servers and opens its editors', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-add-custom-');

    try {
      seedPluginsCache({ userDataDir });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      // An empty Collections tab points at the way forward instead of the
      // generic "No capabilities" line: its action opens the create editor.
      await window.getByTestId('plugins-type-tab-collection').click();
      const emptyCreate = window.getByTestId(
        'plugins-collections-empty-create',
      );
      await expect(emptyCreate).toBeVisible();
      await expect(window.getByText('No collections yet')).toBeVisible();
      const emptyCreateBox = await emptyCreate.boundingBox();
      expect(emptyCreateBox).not.toBeNull();
      expect(emptyCreateBox.height).toBeGreaterThanOrEqual(28);
      await emptyCreate.click();
      const collectionEditor = window.getByRole('dialog', {
        name: 'New collection',
      });
      await expect(collectionEditor).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(collectionEditor).toBeHidden();
      await window.getByTestId('plugins-type-tab-all').click();

      const addCustomTrigger = window.getByTestId('plugins-add-custom-menu');
      await expect(addCustomTrigger).toBeVisible();
      await expect(addCustomTrigger).toHaveClass(/(?:^|\s)bg-accent(?:\s|$)/);
      const triggerBox = await addCustomTrigger.boundingBox();
      expect(triggerBox).not.toBeNull();
      expect(triggerBox.height).toBeGreaterThanOrEqual(28);
      const labelChevronGap = await addCustomTrigger.evaluate((button) => {
        const label = button.firstElementChild;
        const chevron = button.querySelector('[data-app-icon="true"]');
        if (
          !(label instanceof HTMLElement) ||
          !(chevron instanceof SVGElement)
        ) {
          throw new Error('Add custom label or chevron is missing');
        }
        const labelRange = document.createRange();
        labelRange.selectNodeContents(label);
        return (
          chevron.getBoundingClientRect().left -
          labelRange.getBoundingClientRect().right
        );
      });
      expect(labelChevronGap).toBeCloseTo(2, 0);
      await expect(
        addCustomTrigger.getByTestId('plugins-add-custom-divider'),
      ).toHaveCount(0);

      await addCustomTrigger.click();
      const addCustomMenu = window.getByRole('menu');
      await expect(addCustomMenu).toBeVisible();
      await expect(addCustomMenu.getByRole('menuitem').first()).toHaveAttribute(
        'data-testid',
        'plugins-add-custom-mcp',
      );
      await window.getByTestId('plugins-add-custom-mcp').click();
      const mcpDialog = window.getByRole('dialog', { name: 'New MCP server' });
      await expect(mcpDialog).toBeVisible();
      await expect(
        mcpDialog.getByRole('button', { name: 'HTTP', exact: true }),
      ).toHaveClass(/(?:^|\s)bg-accent(?:\s|$)/);
      await expect(
        mcpDialog.getByPlaceholder('https://mcp.example.com/sse'),
      ).toBeVisible();
      await mcpDialog
        .getByRole('button', { name: 'Command', exact: true })
        .click();
      await expect(mcpDialog.getByPlaceholder('npx')).toBeVisible();
      await window.keyboard.press('Escape');
      await addCustomTrigger.click();
      await window.getByTestId('plugins-add-custom-mcp').click();
      await expect(
        mcpDialog.getByRole('button', { name: 'HTTP', exact: true }),
      ).toHaveClass(/(?:^|\s)bg-accent(?:\s|$)/);
      await window.keyboard.press('Escape');
      await addCustomTrigger.click();
      for (const action of [
        'marketplace',
        'mcp',
        'skills-github',
        'skill-custom',
        'collection',
      ]) {
        await expect(
          window.getByTestId(`plugins-add-custom-${action}-icon`),
        ).toBeVisible();
      }
      // "Add collection…" opens the same create-mode editor the
      // Installed > Collections page uses; it used to be reachable only there.
      await window.getByTestId('plugins-add-custom-collection').click();
      await expect(collectionEditor).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(collectionEditor).toBeHidden();
      await addCustomTrigger.click();
      await expect(addCustomMenu).toBeVisible();
      await window.getByTestId('plugins-add-custom-marketplace').click();

      const modal = window.getByRole('dialog', { name: 'Add marketplace' });
      await expect(modal).toBeVisible();
      await expect(
        modal.getByPlaceholder('owner/repo or https://github.com/owner/repo'),
      ).toBeVisible();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('only auth-required installed rows offer Connect in their menu', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-menu-switch-');

    try {
      seedPluginsCache({ userDataDir });
      seedCuratedPlugins({ userDataDir });
      const now = '2026-08-26T00:00:00.000Z';
      seedMcpServers({
        userDataDir,
        servers: [
          {
            definition: {
              id: 'curated-github',
              name: 'GitHub',
              description: 'Curated GitHub MCP server',
              type: 'http',
              url: 'https://github.example.test/mcp',
              httpAuthHandler: 'canopy',
              curated: { key: 'github' },
              createdAt: now,
              updatedAt: now,
            },
            configs: [
              {
                id: 'default',
                name: 'Default',
                enabled: true,
                envVars: {},
                extraArgs: [],
                extraHeaders: {},
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('mcp-servers:list-status');
        ipcMain.handle('mcp-servers:list-status', () => [
          {
            serverId: 'curated-github',
            transport: 'http',
            connectionStatus: 'auth_required',
            reachability: 'reachable',
            handler: 'canopy',
            handlerSource: 'server',
            configs: [{ configId: 'default', authStatus: 'not_connected' }],
          },
        ]);
      });
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      // CAN-4261: every Installed row has a menu with Open details; only an
      // auth-required row adds Connect to it.
      await window.getByTestId('plugins-search').fill('github');
      const authMenuTrigger = window.getByTestId(
        'customize-row-menu-mcp-local:curated-github',
      );
      await expect(authMenuTrigger).toBeVisible();
      await authMenuTrigger.click();
      await expect(
        window.getByTestId(
          'customize-row-menu-mcp-local:curated-github-connect',
        ),
      ).toBeVisible();
      await expect(
        window.getByTestId(
          'customize-row-menu-mcp-local:curated-github-details',
        ),
      ).toBeVisible();
      await authMenuTrigger.click();
      await expect(
        window.getByTestId(
          'customize-row-menu-mcp-local:curated-github-details',
        ),
      ).toHaveCount(0);

      await window.getByTestId('plugins-search').fill('Writer Toolkit');
      const plainMenuTrigger = window.getByTestId(
        'customize-row-menu-curated:writer-toolkit',
      );
      await expect(plainMenuTrigger).toBeVisible();
      await plainMenuTrigger.click();
      await expect(
        window.getByTestId('customize-row-menu-curated:writer-toolkit-details'),
      ).toBeVisible();
      await expect(
        window.getByTestId('customize-row-menu-curated:writer-toolkit-connect'),
      ).toHaveCount(0);
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('unseeded curated catalog: page renders with no curated section and search still works', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-unseeded-');

    try {
      // Only the baseline (non-curated) marketplace cache is seeded — no
      // curated-plugins tree, no curated plugins-cache.json row.
      seedPluginsCache({ userDataDir });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      // No dead Suggested placeholder when no role pick is in the catalog;
      // the rest of the marketplace remains fully functional.
      await expect(window.getByTestId('plugins-section-suggested')).toHaveCount(
        0,
      );

      // The rest of the page still renders. Browse groups marketplace content
      // into category sections; the seeded plugins carry no category, so they
      // land in the "Other" group.
      const categorySection = window.getByTestId(
        'plugins-section-category-other',
      );
      await expect(categorySection).toBeVisible();
      await expect(
        categorySection.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugins-section-marketplace'),
      ).toHaveCount(0);

      // Search still works over marketplace-only rows in one flat list.
      await window.getByTestId('plugins-search').fill('alpha');
      await expect(
        window
          .getByTestId('plugins-section-plugins-and-mcp')
          .getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugins-entry-mkt:demo/market/beta-tool'),
      ).toHaveCount(0);
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('a large section uses the page as its only vertical scroller', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-discovery-window-');

    try {
      seedManyMarketplacePlugins(userDataDir, WINDOWED_PLUGIN_COUNT);

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      const categorySection = window.getByTestId(
        'plugins-section-category-developer-tools',
      );
      await expect(
        categorySection.getByRole('heading', { level: 2 }),
      ).toHaveText('Developer tools');

      // Browse categories show at most ten cards until the user opens the
      // category from its headline.
      await expect(categorySection).toHaveAttribute('data-row-count', '10');
      await expect(categorySection).toHaveAttribute(
        'data-collapsed-count',
        String(WINDOWED_PLUGIN_COUNT - 10),
      );
      const browseCategoryHeading = categorySection.getByTestId(
        'plugins-section-heading-category-developer-tools',
      );
      await expect(browseCategoryHeading).toHaveText('Developer tools');
      await expect(browseCategoryHeading).toHaveAttribute(
        'aria-label',
        'Browse Developer tools',
      );
      await expect(
        categorySection.getByTestId(
          'plugins-section-more-category-developer-tools',
        ),
      ).toHaveCount(0);
      await browseCategoryHeading.click();
      const categoryPage = window.getByTestId('plugins-category-page');
      await expect(categoryPage).toBeVisible();
      const categorySearch = categoryPage.getByTestId(
        'plugins-category-search',
      );
      await expect(categorySearch).toBeVisible();
      const categoryResults = categoryPage.getByTestId(
        'plugins-section-category-page',
      );
      await expect(categoryResults).toHaveAttribute(
        'data-row-count',
        String(WINDOWED_PLUGIN_COUNT),
      );

      // The dedicated category page searches only within that category and
      // remains the page's sole scroll owner.
      await categorySearch.fill('windowed');
      const page = window.getByTestId('page-plugins');
      const section = categoryPage.getByTestId('plugins-section-category-page');
      await expect(section).toHaveAttribute('data-virtualized', 'false');
      await expect(section).toHaveAttribute(
        'data-row-count',
        String(WINDOWED_PLUGIN_COUNT),
      );

      const body = categoryPage.getByTestId(
        'plugins-section-body-category-page',
      );
      const scrollState = await page.evaluate((root) => {
        const candidates = [root, ...root.querySelectorAll('*')];
        const verticalScrollOwners = candidates
          .filter((node) => {
            if (!(node instanceof HTMLElement)) return false;
            const overflowY = getComputedStyle(node).overflowY;
            return (
              (overflowY === 'auto' || overflowY === 'scroll') &&
              node.scrollHeight > node.clientHeight + 1
            );
          })
          .map((node) =>
            node instanceof HTMLElement
              ? (node.dataset.testid ?? node.tagName.toLowerCase())
              : '',
          );
        const fixedOrSticky = candidates
          .filter((node) => {
            if (!(node instanceof HTMLElement)) return false;
            const style = getComputedStyle(node);
            // Transition-ready overlays stay mounted while closed, but hidden
            // elements contribute neither page layout nor a sticky/fixed
            // surface. This assertion guards the rendered discovery page.
            if (style.display === 'none' || style.visibility === 'hidden') {
              return false;
            }
            const position = style.position;
            return position === 'fixed' || position === 'sticky';
          })
          .map((node) =>
            node instanceof HTMLElement
              ? (node.dataset.testid ?? node.tagName.toLowerCase())
              : '',
          );
        const bounds = root.getBoundingClientRect();
        return {
          verticalScrollOwners,
          fixedOrSticky,
          right: bounds.right,
          viewportRight: window.innerWidth,
        };
      });
      expect(scrollState.verticalScrollOwners).toEqual(['page-plugins']);
      // The titlebar is the one pinned surface: it carries the category
      // breadcrumb, which must stay reachable however far the list scrolls.
      // Nothing else may go fixed or sticky, or the page stops being the sole
      // scroll owner in practice.
      expect(scrollState.fixedOrSticky).toEqual(['plugins-page-titlebar']);
      expect(
        Math.abs(scrollState.right - scrollState.viewportRight),
      ).toBeLessThanOrEqual(1);

      const categoryHeading = categoryPage.getByRole('heading', {
        name: 'Developer tools',
        exact: true,
      });
      await expect(categoryHeading).toBeInViewport();
      // At rest the pinned bar shows no divider: nothing has passed under it.
      const titlebar = window.getByTestId('plugins-page-titlebar');
      const hairlineOpacity = () =>
        titlebar.evaluate(
          (element) => getComputedStyle(element, '::after').opacity,
        );
      await expect.poll(hairlineOpacity).toBe('0');
      await page.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      // Scrolled: the hairline fades in.
      await expect.poll(hairlineOpacity).toBe('1');
      const finalEntryId = `mkt:demo/market/windowed-tool-${String(
        WINDOWED_PLUGIN_COUNT - 1,
      ).padStart(3, '0')}`;
      await expect(
        section.getByTestId(`plugins-entry-${finalEntryId}`),
      ).toBeVisible();
      await expect(categoryHeading).not.toBeInViewport();
      // The pinned bar carries the worktree header's bottom hairline: one
      // physical pixel (`--border-hairline`) drawn by a pseudo-element, so
      // the bar's content box (and the breadcrumb inset in it) is unchanged.
      // Never a border, never a thicker stroke.
      const titlebarHairline = await window
        .getByTestId('plugins-page-titlebar')
        .evaluate((element) => {
          const after = getComputedStyle(element, '::after');
          return {
            height: Number.parseFloat(after.height),
            position: after.position,
            borderBottom: Number.parseFloat(
              getComputedStyle(element).borderBottomWidth,
            ),
            hairline: Number.parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue(
                '--border-hairline',
              ),
            ),
          };
        });
      expect(titlebarHairline.position).toBe('absolute');
      expect(titlebarHairline.borderBottom).toBe(0);
      expect(titlebarHairline.height).toBeGreaterThan(0);
      expect(titlebarHairline.height).toBeLessThanOrEqual(1);
      expect(titlebarHairline.height).toBeCloseTo(titlebarHairline.hairline, 2);
      await expect(
        window.getByTestId('plugins-category-breadcrumb-current'),
      ).toBeInViewport();
      await expect(
        section.getByTestId(`plugins-entry-add-${finalEntryId}`),
      ).toHaveCount(0);

      await window.getByTestId('plugins-category-breadcrumb-root').click();
      const search = window.getByTestId('plugins-search');
      const searchWithScrollbar = await search.boundingBox();
      expect(searchWithScrollbar).not.toBeNull();
      // Nothing is seeded under Collections, so its empty state has no
      // scrollbar: the gutter must keep the search bar's geometry regardless.
      await window.getByTestId('plugins-type-tab-collection').click();
      await expect(section).toHaveCount(0);
      const searchWithoutScrollbar = await search.boundingBox();
      expect(searchWithoutScrollbar).not.toBeNull();
      expect(searchWithoutScrollbar.x).toBeCloseTo(searchWithScrollbar.x, 1);
      expect(searchWithoutScrollbar.width).toBeCloseTo(
        searchWithScrollbar.width,
        1,
      );
      await window.getByTestId('plugins-type-tab-all').click();
      await expect(categorySection).toBeVisible();
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('official Microsoft listings wear their product mark and credit Microsoft', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-plugins-official-attribution-');

    try {
      seedOfficialMicrosoftFamily(userDataDir);

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();

      // The command palette finds the listing by the vendor the Plugins page
      // credits, not only by the publisher the feed names.
      await window.getByTestId('sidebar-search').click();
      const palette = window.getByTestId('command-palette');
      await expect(palette).toBeVisible();
      await window.getByTestId('command-palette-input').fill('Microsoft');
      await expect(
        palette
          .getByTestId('command-palette-result')
          .filter({ hasText: 'Teams' }),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(palette).toBeHidden();

      await window.getByTestId('plugins-search').fill('outlook');

      // Every `openai-curated` row ships `logoUrl: null`, so the bundled mark
      // is the only source of artwork. `outlook-calendar` was mapped and its
      // siblings were not, leaving Outlook Email on a monogram beside a
      // correctly-marked Outlook Calendar.
      for (const name of ['outlook-calendar', 'outlook-email']) {
        const id = `mkt:openai-curated/${name}`;
        await expect(window.getByTestId(`plugins-entry-${id}`)).toBeVisible();
        const logo = window.getByTestId(`marketplace-product-logo-${id}`);
        await expect(logo).toBeVisible();
        await expect(
          window.getByTestId(`marketplace-product-logo-fallback-${id}`),
        ).toHaveCount(0);
        // The bundled mark specifically, not the google.com favicon service
        // the unmapped fallback reaches for — which carries this same testid,
        // needs the network, and returns a generic microsoft.com icon.
        await expect(logo).toHaveAttribute('src', /^data:image\/svg\+xml/);
      }

      // The attribution the user actually reads. OpenAI authored the wrapper,
      // but the product is Microsoft's, and the source line already names the
      // marketplace — so "by OpenAI" under a Microsoft mark said the wrong
      // thing twice.
      await window.getByTestId('plugins-search').fill('teams');
      const teams = window.getByTestId(
        'plugins-entry-mkt:openai-curated/teams',
      );
      await expect(teams).toBeVisible();
      await teams.click();

      const author = window.getByTestId('plugin-detail-author');
      await expect(author).toBeVisible();
      await expect(author).toHaveText('by Microsoft');
      // Beside the author, the homepage link read as "by Microsoft Website".
      await expect(
        author.locator('..').getByRole('link', { name: 'Website' }),
      ).toHaveCount(0);
      await expect(
        window
          .getByTestId('plugin-detail-links')
          .getByRole('link', { name: 'Website' }),
      ).toHaveAttribute('href', /microsoft\.com/);

      // The marketplace table credits the same vendor, and its author filter
      // is built from the same corrected value, so "Microsoft" is an option.
      await app.openPluginsTab('marketplace');
      await window.getByTestId('marketplace-row-openai-curated').click();
      const teamsRow = window.getByTestId('plugin-row-teams');
      await expect(teamsRow).toBeVisible();
      await expect(teamsRow).toContainText('Microsoft');
      await expect(teamsRow).not.toContainText('OpenAI');
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });
});

for (const kind of ['plugin', 'mcp']) {
  test(`CAN-4359 ${kind} detail submits once and reopens its standalone chat`, async () => {
    test.setTimeout(180_000);
    const fixture =
      kind === 'plugin'
        ? await openCalmPluginDetail()
        : await openCuratedStatusFixture();
    const { electronApp, window, userDataDir } = fixture;
    const subject =
      kind === 'plugin'
        ? 'CrowdStrike Falcon Foundry'
        : 'Vendor OAuth Callback';
    await registerScenario(DEFAULT_MOCK_BASE_URL, subject, {
      llm: {
        steps: [
          {
            text: 'The capability example is complete.',
            stopReason: 'end_turn',
          },
        ],
      },
    });
    try {
      const primary = window.getByTestId('detail-primary-cta');
      await expect(primary).toHaveText('Try it');
      await primary.click();
      const messages = window
        .getByTestId('page-chat')
        .getByTestId('user-message-content');
      await expect(messages).toHaveCount(1, { timeout: 60_000 });
      await expect(messages).toContainText(subject);
      const receipts = () =>
        window.evaluate(() =>
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('canopy:try-it-launch:'))
            .map(([, value]) => JSON.parse(value)),
        );
      await expect
        .poll(receipts)
        .toEqual([expect.objectContaining({ status: 'completed' })]);
      const [receipt] = await receipts();
      expect(receipt.capability.kind).toBe(kind);
      await expect(window.getByTestId('chat-stop-generation')).toBeHidden();
      await window
        .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
        .hover();
      await window
        .getByTestId(`panel-tab-close-panel-chat-${receipt.chatId}`)
        .click();
      await expect
        .poll(() =>
          window.evaluate(
            async ({ location, chatId }) =>
              (await window.api.chat.loadArchives(location)).some(
                (chat) => chat.chatId === chatId,
              ),
            { location: receipt.location, chatId: receipt.chatId },
          ),
        )
        .toBe(true);
      await window.reload();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill(subject);
      await window
        .getByTestId(
          kind === 'plugin'
            ? 'plugins-entry-mkt:demo/market/gmail'
            : 'plugins-entry-mcp-catalog:vendor-oauth-callback',
        )
        .click();
      await expect(primary).toHaveText('Try it');
      await primary.click();
      await expect(messages).toHaveCount(1);
      await expect(messages).toContainText(subject);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${receipt.chatId}`),
      ).toBeVisible();
      expect(await receipts()).toEqual([receipt]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, subject);
    }
  });
}

test('CAN-4359 uninstalled detail updates its primary on live account changes', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-detail-account-'),
  );
  seedPluginConnectionDesign(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await installPluginConnectionDesignHandlers(electronApp);
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__tryItSignedIn = false;
      ipcMain.removeHandler('settings:load-canopy-cloud-account');
      ipcMain.handle('settings:load-canopy-cloud-account', () => ({
        hasApiKey: globalThis.__tryItSignedIn,
        storageAvailable: true,
        authMode: globalThis.__tryItSignedIn ? 'api_key' : null,
        credentialSource: globalThis.__tryItSignedIn ? 'manual' : null,
        capabilities: [],
        account: globalThis.__tryItSignedIn
          ? {
              id: 'try-it-account',
              name: 'CTA tester',
              email: 'cta@example.test',
              role: 'DEVELOPER',
            }
          : null,
      }));
    });
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('alpha-tool');
    await window
      .getByTestId('plugins-entry-mkt:demo/market/alpha-tool')
      .click();
    const primary = window.getByTestId('detail-primary-cta');
    await expect(primary).toHaveText('Try it');
    for (const signedIn of [true, false]) {
      await electronApp.evaluate((_, value) => {
        globalThis.__tryItSignedIn = value;
      }, signedIn);
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
      await expect(primary).toHaveText(signedIn ? 'Install' : 'Try it');
      await expect(primary).toHaveCount(1);
    }
    await primary.click();
    const chat = window.getByTestId('page-chat');
    await expect(chat.getByTestId('user-message-content')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(chat.getByTestId('user-message-content')).toContainText(
      'Alpha Tool',
    );
    const launchCapabilities = await window.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith('canopy:try-it-launch:'))
        .map(([, value]) => JSON.parse(value).capability),
    );
    expect(launchCapabilities).toEqual([
      expect.objectContaining({ kind: 'plugin', catalogId: 'alpha-tool' }),
    ]);
    const retained = chat.getByTestId('unresolved-capability-selection');
    await expect(retained).toContainText('Alpha Tool');
    await expect(retained).toContainText('Setup required');
    // The selection is its own row above the text, never squeezed into the
    // one-line composer beside the + button.
    const box = chat.locator('[data-composer-layout]');
    await expect(box).toHaveAttribute('data-composer-layout', 'full');
    const chipBox = await retained.boundingBox();
    const editorBox = await box.getByRole('textbox').first().boundingBox();
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(editorBox.y);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const outcome of ['setup-required', 'completed', 'storage-failure']) {
  test(`CAN-4396 guest MCP Try it cancellation and account-event ${outcome}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-try-it-sign-in-'),
    );
    // A catalog-only capability: no local runtime reference can bypass the
    // account gate, and no account is silently signed in by the fixture.
    seedVendorOAuthCatalog(userDataDir, 3118, 'http://127.0.0.1:1');
    const cloud =
      outcome === 'completed'
        ? await startAccountMcpCloud({
            includeConnection: false,
            connections: [
              {
                id: 'a1111111-1111-4111-8111-111111111111',
                serverKey: 'vendor-oauth-callback',
                configId: 'default',
                displayName: 'Vendor OAuth Callback',
                status: 'CONNECTED',
                kind: 'CURATED',
                routeId: 'fixture-vendor',
                enabledTools: null,
              },
            ],
          })
        : null;
    const { electronApp } = await launchCanopy({
      userDataDir,
      ...(cloud
        ? {
            env: {
              CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
              CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
                'canopy-shared-mcp-account-connections': true,
              }),
            },
          }
        : {}),
    });
    const subject = 'Vendor OAuth Callback';
    await registerScenario(DEFAULT_MOCK_BASE_URL, subject, {
      llm: {
        steps: [
          {
            text: 'The initial guest example settled.',
            stopReason: 'end_turn',
          },
        ],
      },
    });
    try {
      await installPluginConnectionDesignHandlers(electronApp);
      await electronApp.evaluate(({ ipcMain }, completed) => {
        globalThis.__tryItGuestUpgrade = false;
        ipcMain.removeHandler('settings:load-canopy-cloud-account');
        ipcMain.handle('settings:load-canopy-cloud-account', () => ({
          read: 'ok',
          storageAvailable: true,
          hasApiKey: globalThis.__tryItGuestUpgrade,
          authMode: globalThis.__tryItGuestUpgrade ? 'api_key' : null,
          credentialSource: globalThis.__tryItGuestUpgrade ? 'manual' : null,
          capabilities: [],
          account: globalThis.__tryItGuestUpgrade
            ? {
                id: 'try-it-upgrade',
                name: 'Try it tester',
                email: 'try-it@example.test',
                role: 'DEVELOPER',
              }
            : null,
        }));
        if (!completed) {
          ipcMain.removeHandler('mcp-servers:list-account-connections');
          ipcMain.handle('mcp-servers:list-account-connections', () => []);
        }
      }, outcome === 'completed');
      const window = await electronApp.firstWindow();
      await window.reload();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await window.getByTestId('plugins-search').fill(subject);
      await window
        .getByTestId('plugins-entry-mcp-catalog:vendor-oauth-callback')
        .click();
      if (outcome === 'storage-failure')
        await window.evaluate(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith('canopy:try-it-continuation:'))
              throw new DOMException('Fixture quota', 'QuotaExceededError');
            return original.call(this, key, value);
          };
        });
      await window.getByTestId('detail-primary-cta').click();
      const messages = window
        .getByTestId('page-chat')
        .getByTestId('user-message-content');
      await expect(messages).toHaveCount(1, { timeout: 60_000 });
      const notice = window.getByTestId('try-it-sign-in-notice');
      await expect(notice).toHaveAttribute('data-state', 'sign-in');
      const readRecord = () =>
        window.evaluate(() =>
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('canopy:try-it-continuation:'))
            .map(([, raw]) => JSON.parse(raw)),
        );
      const [original] = await readRecord();
      if (outcome === 'storage-failure') {
        expect(original).toBeUndefined();
        await expect(notice).not.toContainText('Your prompt is saved');
        await notice.getByTestId('try-it-sign-in-notice-sign-in').click();
        await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
        await window
          .getByTestId('cloud-sync-modal')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await electronApp.evaluate(() => {
          globalThis.__tryItGuestUpgrade = true;
        });
        await window.evaluate(() =>
          window.dispatchEvent(new Event('canopy:cloud-account-changed')),
        );
        await expect(messages).toHaveCount(1);
        expect(await readRecord()).toEqual([]);
        return;
      }
      expect(original.prompt).toContain(subject);
      await notice.getByTestId('try-it-sign-in-notice-sign-in').click();
      const modal = window.getByTestId('cloud-sync-modal');
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(notice).toHaveAttribute('data-state', 'retry');
      expect((await readRecord())[0]).toMatchObject({
        requestId: original.requestId,
        failure: 'authentication-cancelled',
      });
      await expect(messages).toHaveCount(1);
      // Sidebar sign-in and its account notification enter the same runner.
      if (cloud)
        await window.evaluate(async () => {
          await window.api.saveCanopyCloudApiKey({
            apiKey: 'csk_can4396_continue',
          });
        });
      await electronApp.evaluate(() => {
        globalThis.__tryItGuestUpgrade = true;
      });
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
      if (outcome === 'completed') {
        await expect
          .poll(async () => (await readRecord())[0]?.status)
          .toBe('completed');
        await expect(messages).toHaveCount(2);
        expect((await readRecord())[0].receipt).toMatchObject({
          requestId: original.requestId,
          chatId: original.sourceChatId,
          accountKey: 'account:try-it-upgrade',
        });
      } else {
        await expect(notice).toHaveAttribute('data-state', 'setup-required');
        await expect(messages).toHaveCount(1);
      }
      await window.reload();
      await app.waitForShell();
      // Reload opens New task. Reopen the persisted entry before checking its
      // continuation; a missing composer here is not a lost chat or receipt.
      const savedChat = window
        .getByTestId('sidebar-section-chats-content')
        .locator(`[data-standalone-chat-id="${original.host.worktreeId}"]`);
      await expect(savedChat).toHaveCount(1);
      await savedChat.click();
      if (outcome === 'completed') await expect(notice).toHaveCount(0);
      else await expect(notice).toHaveAttribute('data-state', 'setup-required');
      await expect(messages).toHaveCount(outcome === 'completed' ? 2 : 1);
      expect((await readRecord())[0]).toMatchObject({
        requestId: original.requestId,
        status: outcome,
        destinationAccountKey: 'account:try-it-upgrade',
      });
      if (outcome === 'completed') {
        // CAN-4404: seeded durable reload recovery. The unit suite separately
        // covers a real rejected response and the first unsuccessful reread.
        const completed = (await readRecord())[0];
        const commandId = `try-it-${completed.requestId}`;
        const durableReceipt = await window.evaluate(
          ({ record, commandId }) =>
            window.canopyCore.invoke({
              kind: 'request',
              method: 'core.chat.send.receipt',
              params: {
                scope: {
                  workspaceId: record.host.projectId,
                  worktreeId: record.host.worktreeId,
                  chatId: record.sourceChatId,
                },
                commandId,
              },
            }),
          { record: completed, commandId },
        );
        expect(durableReceipt).toMatchObject({
          ok: true,
          value: {
            outcome: 'matched',
            receipt: {
              commandId,
              entityId: completed.sourceChatId,
              messageId: completed.requestId,
            },
          },
        });
        expect(['applied', 'already_applied']).toContain(
          durableReceipt.value.receipt.outcome,
        );
        // Observe the real main handler before reload: renderer startup cannot
        // dispatch early and escape the counter. Delegate unchanged to main.
        await electronApp.evaluate(({ ipcMain }) => {
          const channel = 'chat:command';
          const originalHandler = ipcMain._invokeHandlers.get(channel);
          if (!originalHandler) throw new Error('Missing chat command handler');
          globalThis.__can4404ContinuationCommands = [];
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, (event, request) => {
            if (
              request?.command?.type === 'chat.send_message' &&
              typeof request.commandId === 'string' &&
              request.commandId.startsWith('try-it-')
            )
              globalThis.__can4404ContinuationCommands.push(request);
            return originalHandler(event, request);
          });
        });
        const seedUncertain = async (accountKey) => {
          const uncertain = {
            ...completed,
            status: 'failed',
            failure: 'acceptance-uncertain',
            destinationAccountKey: accountKey,
          };
          delete uncertain.receipt;
          await window.evaluate((record) => {
            localStorage.setItem(
              `canopy:try-it-continuation:${record.sourceChatId}`,
              JSON.stringify(record),
            );
          }, uncertain);
          return uncertain;
        };
        const reopen = async () => {
          await window.reload();
          await app.waitForShell();
          await savedChat.click();
          await expect(messages).toHaveCount(2);
        };
        await seedUncertain('account:try-it-upgrade');
        await reopen();
        await expect
          .poll(async () => (await readRecord())[0]?.status)
          .toBe('completed');
        expect((await readRecord())[0]).toMatchObject({
          requestId: completed.requestId,
          receipt: {
            accountKey: 'account:try-it-upgrade',
            chatId: completed.sourceChatId,
            requestId: completed.requestId,
          },
        });
        await expect(notice).toHaveCount(0);
        expect(
          await electronApp.evaluate(
            () => globalThis.__can4404ContinuationCommands,
          ),
        ).toEqual([]);

        const differentAccount = await seedUncertain('account:someone-else');
        await reopen();
        await expect(notice).toHaveCount(0);
        expect((await readRecord())[0]).toEqual(differentAccount);
        expect(
          await electronApp.evaluate(
            () => globalThis.__can4404ContinuationCommands,
          ),
        ).toEqual([]);
        await expect(messages).toHaveCount(2);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, subject);
      await cloud?.close();
    }
  });
}

test('CAN-4396 fresh signed-out catalog uses public transport and survives an offline refresh', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-public-catalog-'),
  );
  const key = 'public-guest-catalog';
  const subject = 'Public Guest Catalog';
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
    curatedServers: [
      {
        key,
        name: subject,
        shortDescription: 'Anonymous catalog fixture',
        url: 'https://mcp.example.test',
        transport: 'http',
        oauthHints: { usePkce: true },
        categories: ['development'],
        popular: true,
        sortOrder: 0,
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
    ],
  });
  const cachePath = path.join(
    userDataDir,
    'mcp-servers',
    'curated-catalog.json',
  );
  expect(() => readFileSync(cachePath)).toThrow();
  let electronApp;
  try {
    const launched = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        // Keep the real account store credential-less after first-run consent.
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-guest-mode-enabled': false,
          'canopy-cloud-sign-in-required': false,
        }),
      },
    });
    electronApp = launched.electronApp;
    await registerScenario(DEFAULT_MOCK_BASE_URL, subject, {
      llm: {
        steps: [{ text: 'The guest example settled.', stopReason: 'end_turn' }],
      },
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Real main account store and credential resolution; no renderer account stubs.
    const account = await window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    expect(account.hasApiKey).toBe(false);
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill(subject);
    const card = window.getByTestId(`plugins-entry-mcp-catalog:${key}`);
    await expect(card).toBeVisible();
    expect(
      (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
        .hasApiKey,
    ).toBe(false);
    expect(
      cloud.catalogRequests.some(
        (request) => request.path === '/api/v1/mcp-servers/curated',
      ),
    ).toBe(true);
    expect(
      cloud.catalogRequests
        .filter((request) => request.path === '/api/v1/mcp-servers/curated')
        .every((request) => !request.authorizationPresent),
    ).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    cache.fetchedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(cachePath, JSON.stringify(cache));
    const original = readFileSync(cachePath, 'utf8');
    const publicReadsBeforeOffline = cloud.catalogRequests.filter(
      (request) => request.path === '/api/v1/mcp-servers/curated',
    ).length;
    cloud.setCatalogOffline(true);
    const refreshed = await window.evaluate(() =>
      window.mcpServers.refreshCurated(),
    );
    expect(refreshed.servers.map((entry) => entry.key)).toContain(key);
    expect(
      cloud.catalogRequests.filter(
        (request) => request.path === '/api/v1/mcp-servers/curated',
      ).length,
    ).toBeGreaterThan(publicReadsBeforeOffline);
    expect(readFileSync(cachePath, 'utf8')).toBe(original);
    await window.reload();
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill(subject);
    await expect(card).toBeVisible();
    await card.click();
    await expect(window.getByTestId('detail-primary-cta')).toHaveText('Try it');
    await window.getByTestId('detail-primary-cta').click();
    await expect(
      window.getByTestId('page-chat').getByTestId('user-message-content'),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(window.getByTestId('try-it-sign-in-notice')).toHaveAttribute(
      'data-state',
      'sign-in',
    );
    expect(
      cloud.catalogRequests
        .filter((request) => request.path === '/api/v1/mcp-servers/curated')
        .every((request) => !request.authorizationPresent),
    ).toBe(true);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, subject);
    } finally {
      await cloud.close();
    }
  }
});
