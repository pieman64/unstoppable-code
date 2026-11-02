import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// CAN-4840: the Customize row names its source, shows the kind only on All,
// and removes an item from its ⋯ menu through the real renderer -> preload ->
// installed-items service, with the same fixtures as installed-items-status.
test('Customize rows name their source and remove an item from the row menu', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4840-rows-'));
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
  const serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const now = '2026-10-21T00:00:00Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: serverId,
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
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const collection = await window.evaluate(async () => {
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
    const skillId = 'skill:custom:app:audit-skill';
    const collectionId = `collection:local:${collection.id}`;
    await app.openPluginsPage();
    await app.openPluginsTab('installed');
    const installed = window.getByTestId('customize-section-installed');
    await expect(
      installed.getByTestId(`customize-row-${skillId}`),
    ).toBeVisible();
    await expect(
      installed.getByTestId(`customize-row-subtitle-${skillId}`),
      // CAN-4844: the approved custom skill subtitle shows its updated age.
    ).toHaveText(/^Updated\s\d+[smhd] ago$/);

    // The kind chip names the kind only where the tab does not.
    await window.getByTestId('plugins-type-tab-all').click();
    await expect(
      installed.getByTestId(`customize-row-type-${skillId}`),
    ).toBeVisible();
    await app.openPluginsTab('skills');
    await expect(
      installed.getByTestId(`customize-row-${skillId}`),
    ).toBeVisible();
    await expect(
      installed.getByTestId(`customize-row-type-${skillId}`),
    ).toHaveCount(0);

    await app.openPluginsTab('installed');
    const expectRemoval = async (entryId, label) => {
      const menu = installed.getByTestId(`customize-row-menu-${entryId}`);
      await menu.click();
      await expect(
        window.getByTestId(`customize-row-menu-${entryId}-remove`),
      ).toHaveText(label);
      await window.keyboard.press('Escape');
    };
    await expectRemoval(skillId, 'Delete…');
    await expectRemoval(`mcp-local:${serverId}`, 'Remove…');
    await expectRemoval('mkt:demo/market/gamma-tool', 'Uninstall…');

    const collectionRow = installed.getByTestId(
      `customize-row-${collectionId}`,
    );
    await installed.getByTestId(`customize-row-menu-${collectionId}`).click();
    await window
      .getByTestId(`customize-row-menu-${collectionId}-remove`)
      .click();
    const dialog = window.getByTestId('customize-row-remove-dialog');
    await expect(dialog).toContainText('Delete Audit Collection?');
    await window.getByTestId('customize-row-remove-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(collectionRow).toBeVisible();

    await installed.getByTestId(`customize-row-menu-${collectionId}`).click();
    await expect(
      window.getByTestId(`customize-row-menu-${collectionId}-remove`),
    ).toHaveText('Delete…');
    await window
      .getByTestId(`customize-row-menu-${collectionId}-remove`)
      .click();
    await window.getByTestId('customize-row-remove-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(collectionRow).toHaveCount(0);
    const actual = await window.evaluate(() =>
      window.installedItems.listStatus(),
    );
    expect(
      actual.items.some(
        (item) =>
          item.target.kind === 'collection' &&
          item.target.collectionId === collection.id,
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
    await closeCanopy(electronApp, userDataDir);
  }
});
