import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { mkdirSync } from 'node:fs';
import { seedPluginsCache } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CATALOG_PLUGINS = 400;
/** Mirrors VIRTUALIZED_ROW_THRESHOLD in UnifiedTable.tsx. */
const VIRTUALIZED_ROW_THRESHOLD = 120;
/** Sorts last, so it is only reachable by searching rather than by scrolling. */
const DEEP_PLUGIN_NAME = 'zz-windowed-tool-399';

function expandPluginCatalog(cacheFilePath) {
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const marketplace = cache.marketplaces[0];
  const template = marketplace.plugins[0];
  const rows = Array.from({ length: CATALOG_PLUGINS }, (_, index) => ({
    ...template,
    name:
      index === CATALOG_PLUGINS - 1
        ? DEEP_PLUGIN_NAME
        : `zz-windowed-tool-${String(index).padStart(3, '0')}`,
    description: `Windowed plugin row ${index}`,
  }));
  marketplace.plugins.push(...rows);
  marketplace.pluginCount = marketplace.plugins.length;
  marketplace.providerStatus.claude.pluginCount = marketplace.plugins.length;
  writeFileSync(cacheFilePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return marketplace.id;
}

/**
 * Publish the same plugin from two overlapping marketplaces, the way Codex
 * subscribing to Anthropic's catalogue actually produces it.
 */
function seedOverlappingMarketplaces(cacheFilePath) {
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const template = cache.marketplaces[0].plugins[0];
  cache.marketplaces.push(
    {
      ...cache.marketplaces[0],
      id: 'claude-plugins-official',
      name: 'Claude Plugins',
      sourceType: 'github',
      sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
      plugins: [
        {
          ...template,
          name: 'slack',
          marketplaceId: 'claude-plugins-official',
          description: 'Slack MCP server',
          // Spelled out rather than inherited from the template. Collapsing is
          // coverage-aware: this copy reaches both providers and the Codex one
          // reaches only Codex, so this one covers it and the pair collapses.
          // Two copies that each reached a provider the other did not would
          // correctly stay separate, and a fixture that merely inherited
          // whatever support the template happened to carry would not say
          // which case it was testing.
          providerSupport: { claude: 'native', codex: 'native' },
        },
      ],
    },
    {
      ...cache.marketplaces[0],
      id: 'openai-curated-remote',
      name: 'Codex Curated',
      sourceType: 'codex',
      sourceUrl: 'openai-curated-remote',
      plugins: [
        {
          ...template,
          name: 'slack',
          marketplaceId: 'openai-curated-remote',
          description: 'Work with Slack',
          providerSupport: { claude: 'none', codex: 'native' },
        },
      ],
    },
  );
  writeFileSync(cacheFilePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

/** Advertise one connector, so the picker has a row to render. */
function seedConnectorCatalog(userDataDir) {
  const dir = path.join(userDataDir, 'mcp-servers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'curated-catalog.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      servers: [
        {
          key: 'gmail-gmailmcp',
          name: 'Gmail',
          shortDescription: 'Read and send mail',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          transport: 'http',
          categories: ['productivity'],
          popular: false,
          sortOrder: 0,
          updatedAt: '2026-08-31T00:00:00.000Z',
          providerConnector: { providers: ['claude', 'codex'] },
        },
      ],
    }),
  );
}

function readPersistedPluginRefs(userDataDir) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${WORKTREE_ID}.json`),
    )
  )
    return [];
  const { live: chatFile } = readChatStorageIndexes(workspaceRoot, WORKTREE_ID);
  const activeTab =
    chatFile.tabs.find((tab) => tab.id === chatFile.activeTabId) ??
    chatFile.tabs[0];
  return activeTab?.pluginSelections?.pluginRefs ?? [];
}

test('plugin picker windows a large catalog while search, scroll, and selection stay correct', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plugin-picker-windowing-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const marketplaceId = expandPluginCatalog(cacheFilePath);

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 760, height: 830 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await window.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();

    const table = dialog.getByTestId('unified-table');
    await expect
      .poll(async () =>
        Number.parseInt(
          (await table.getAttribute('data-row-count')) ?? '0',
          10,
        ),
      )
      .toBeGreaterThan(VIRTUALIZED_ROW_THRESHOLD);

    // The body windows: the logical row count exceeds the threshold, but only
    // a small slice is mounted.
    await expect(table).toHaveAttribute('data-virtualized', 'true');
    const logicalRows = Number.parseInt(
      (await table.getAttribute('data-row-count')) ?? '0',
      10,
    );
    const mountedRows = await dialog.locator('tbody tr[data-index]').count();
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(logicalRows);

    // Spacer rows give the scroller the full list height.
    const tableScroller = dialog.locator('table').locator('..');
    await expect
      .poll(() =>
        tableScroller.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    await tableScroller.hover();
    await window.mouse.wheel(0, 1200);
    await expect
      .poll(() => tableScroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    // A row far past the mounted window is still reachable through search, and
    // narrowing below the threshold returns the table to the unwindowed path.
    await dialog.getByPlaceholder('Search by name…').fill(DEEP_PLUGIN_NAME);
    await expect(table).toHaveAttribute('data-virtualized', 'false');
    const checkbox = dialog.getByRole('checkbox', {
      name: `Select ${DEEP_PLUGIN_NAME}`,
    });
    await expect(checkbox).toBeVisible();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    // Wait for React's controlled selection state, not only the checkbox's
    // immediate browser-native checked state. With a large catalog, the
    // parent selection render can finish after Playwright observes the input.
    await expect(dialog.getByTestId('unified-table-selected-count')).toHaveText(
      '1',
    );

    // Clearing the search re-expands to the full windowed list and scrolls back
    // to the top, so the first row is interactive again.
    await dialog.getByPlaceholder('Search by name…').fill('');
    await expect(table).toHaveAttribute('data-virtualized', 'true');
    await expect
      .poll(() => tableScroller.evaluate((element) => element.scrollTop))
      .toBe(0);

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => readPersistedPluginRefs(userDataDir), {
        message: 'searched-for windowed row should persist on the chat tab',
      })
      .toEqual([{ marketplaceId, pluginName: DEEP_PLUGIN_NAME }]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * The connector row in the picker a user actually opens.
 *
 * This affordance has regressed twice: it rendered checked for an account
 * nobody had linked, and its explanation rendered nowhere because the Source
 * cell is gated on a field the row left empty. Both were caught by review
 * rather than by a test, because every consumer suite mocks the hook that
 * builds these rows. This drives the real chat plugins modal instead.
 *
 * Nothing is linked in this isolated profile, so the row must be unchecked and
 * unselectable — a ticked box would claim a connection that does not exist.
 */
test('the chat plugin picker shows an unlinked connector as unchecked and explained', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-picker-connector-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { cacheFilePath: connectorCache } = seedPluginsCache({ userDataDir });
  seedOverlappingMarketplaces(connectorCache);
  seedConnectorCatalog(userDataDir);

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1100, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await window.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();

    const gmailRow = dialog
      .locator('tbody tr')
      .filter({ hasText: 'Gmail' })
      .first();
    await expect(gmailRow).toBeVisible();

    const checkbox = gmailRow.locator('input[type="checkbox"]');
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).not.toBeChecked();

    // And it says where it is managed, rather than leaving the user to wonder
    // why the row cannot be selected.
    await expect(gmailRow).toContainText(/account/i);

    // The same plugin published by two overlapping marketplaces collapses to
    // one row here, as it does on the Plugins page. Matching on the marketplace
    // id rather than the source label matters: a GitHub-backed marketplace
    // renders as `github:anthropics:...`, so an id comparison against the label
    // silently never fired and this picker kept showing both.
    const slackRows = dialog.locator('tbody tr').filter({ hasText: 'slack' });
    await expect(slackRows).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
