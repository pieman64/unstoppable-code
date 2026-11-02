import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// CAN-4255: real renderer -> preload -> service -> isolated persistence.
// No provider installation or live MCP server is needed for these owned fixtures.
test('installed statuses persist for every item kind and uninstall preserves collection members', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4255-status-'));
  const cache = path.join(userDataDir, 'plugin-cache', 'gamma-tool');
  mkdirSync(path.join(cache, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(cache, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'gamma-tool', version: '1.0.0' }),
  );
  seedPluginsCache({
    userDataDir,
    installedPluginCachePaths: { 'gamma-tool': cache },
  });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const configId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const now = '2026-10-21T00:00:00Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id,
          name: 'Audit MCP',
          description: 'Fixture only',
          type: 'command',
          command: 'node',
          args: [],
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: configId,
            name: 'Default',
            description: '',
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
  let launch = await launchCanopy({ userDataDir });
  let collectionId;
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const seeded = await window.evaluate(async () => {
      const skill = await window.skills.saveCustomSkill({
        name: 'audit-skill',
        description: 'Isolated audit fixture',
        body: 'Review the supplied changes.',
      });
      if (!skill.success) throw new Error(skill.error);
      return window.collections.saveCollection({
        name: 'Audit collection',
        description: 'One independent member',
        skills: [{ sourceId: 'custom:app', skillName: 'audit-skill' }],
        plugins: [],
        mcpServers: [],
      });
    });
    collectionId = seeded.id;
    await app.openPluginsPage();
    await app.openPluginsTab('installed');
    const entries = [
      'mkt:demo/market/gamma-tool',
      'skill:custom:app:audit-skill',
      `mcp-local:${id}`,
      `collection:local:${collectionId}`,
    ];
    // Browse cards repeat an installed item's status control; use Installed's.
    const installed = window.getByTestId('customize-section-installed');
    for (const entry of entries) {
      const picker = installed.getByTestId(`plugins-entry-status-${entry}`);
      await expect(picker).toHaveAttribute('data-status', 'available');
      for (const status of [
        'active',
        'available',
        'disabled',
        'available',
        'disabled',
      ]) {
        await picker.click();
        await window
          .getByTestId(`plugins-entry-status-${entry}-option-${status}`)
          .click();
        await expect(picker).toHaveAttribute('data-status', status);
      }
    }
    await app.openSettings();
    await app.openSettingsSection('plugins');
    await expect(window.getByTestId('active-items-summary-counts')).toHaveText(
      'Nothing is active yet.',
    );
    await window.getByTestId('active-items-summary-manage').click();
    // Settings Manage lands on Customize Installed filtered to Active.
    const statusFilter = window.getByTestId(
      'customize-installed-status-filter',
    );
    await expect(statusFilter).toHaveAttribute('data-status', 'active');
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await expect(statusFilter).toHaveAttribute('data-status', 'any');
  } finally {
    await closeCanopy(launch.electronApp, userDataDir, { keepUserData: true });
  }
  launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const snapshot = await window.evaluate(() =>
      window.installedItems.listStatus(),
    );
    for (const kind of ['plugin', 'skill', 'mcp-config', 'collection'])
      expect(
        snapshot.items.some(
          (item) => item.target.kind === kind && item.status === 'disabled',
        ),
      ).toBe(true);
    await app.openPluginsPage();
    await app.openPluginsTab('installed');
    await window
      .getByTestId('customize-section-installed')
      .getByTestId(`customize-row-collection:local:${collectionId}`)
      .click();
    const section = window.getByTestId('plugins-entry-detail-status');
    await expect(section).toBeVisible();
    // Uninstall is the destructive row of the detail's ⋯ More menu.
    await window.getByTestId('plugins-entry-detail-status-more').click();
    await window.getByTestId('plugins-entry-detail-status-uninstall').click();
    await window
      .getByTestId('plugins-entry-detail-status-uninstall-cancel')
      .click();
    await expect(section).toBeVisible();
    // Uninstall is the destructive row of the detail's ⋯ More menu.
    await window.getByTestId('plugins-entry-detail-status-more').click();
    await window.getByTestId('plugins-entry-detail-status-uninstall').click();
    await window
      .getByTestId('plugins-entry-detail-status-uninstall-confirm')
      .click();
    await expect(
      window.getByTestId('plugins-entry-detail-status-uninstall-dialog'),
    ).toBeHidden();
    // The detail leaves once the item is gone, even though the collection
    // drops out of the inventory before the uninstall response arrives.
    await expect(section).toBeHidden();
    await expect(
      window.getByText('This item is no longer available'),
    ).toHaveCount(0);
    const actual = await window.evaluate(() =>
      window.installedItems.listStatus(),
    );
    expect(
      actual.items.some(
        (item) =>
          item.target.kind === 'collection' &&
          item.target.collectionId === collectionId,
      ),
    ).toBe(false);
    expect(
      actual.items.some(
        (item) =>
          item.target.kind === 'skill' &&
          item.target.skillName === 'audit-skill',
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(launch.electronApp, userDataDir);
  }
});
