import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CLAUDE_SLACK_ENTRY,
  CODEX_SLACK_ENTRY,
  SLACK_BUNDLED_SERVER_ID,
  SLACK_CATALOG_ENTRY,
  STANDALONE_SERVER_ID,
  seedSlackPluginEntity,
} from './fixtures/slackPluginEntityFixture.mjs';

// CAN-3653: plugins are the Customize entity. Searching "slack" used to list
// the Claude plugin, the installed Codex plugin, the curated Slack MCP card
// (offering Add) and the server the Codex plugin had installed, four rows
// that read alike. Now each plugin is listed once with its source, the
// bundled server and its claimed catalog card stay out of Browse, the
// Installed plugin keeps server management, and the two plugin pages link
// each other.
//
// Deterministic: everything is seeded on disk by the shared fixture; no
// network, no live agents. Assertions use test ids, not "Slack" text counts,
// because skills and labels also carry the word.

const bundledRow = `customize-row-mcp-local:${SLACK_BUNDLED_SERVER_ID}`;
const bundledCard = `plugins-entry-mcp-local:${SLACK_BUNDLED_SERVER_ID}`;

test('Customize excludes the claimed Slack catalog card and manages servers from the Installed plugin', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-3653-'));
  seedSlackPluginEntity({ userDataDir });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();

    const installed = window.getByTestId('customize-section-installed');
    const browse = window.getByTestId('customize-section-browse');
    const search = window.getByTestId('plugins-search');
    await search.fill('slack');

    // All: the available Claude plugin in Browse with its source and Add.
    await expect(
      browse.getByTestId(`plugins-entry-${CLAUDE_SLACK_ENTRY}`),
    ).toBeVisible();
    await expect(
      browse.getByTestId(`plugins-card-source-${CLAUDE_SLACK_ENTRY}`),
    ).toHaveText('Claude · slackapi');
    await expect(
      browse.getByTestId(`plugins-entry-add-${CLAUDE_SLACK_ENTRY}`),
    ).toBeVisible();
    // The installed Codex plugin is an Installed row naming its catalog.
    await expect(
      installed.getByTestId(`customize-row-${CODEX_SLACK_ENTRY}`),
    ).toBeVisible();
    await expect(
      installed.getByTestId(`customize-row-source-${CODEX_SLACK_ENTRY}`),
    ).toHaveText('Codex official');
    // CAN-5050: catalog metadata must not compete with the name and inline
    // type, even in a narrow All tab. Exercise the shared Installed/Browse UI.
    await window.setViewportSize({ width: 760, height: 900 });
    for (const [titleId, metaId, sourceId] of [
      [
        `customize-row-name-line-${CODEX_SLACK_ENTRY}`,
        `customize-row-subtitle-${CODEX_SLACK_ENTRY}`,
        `customize-row-source-${CODEX_SLACK_ENTRY}`,
      ],
      [
        `plugins-card-title-${CLAUDE_SLACK_ENTRY}`,
        `plugins-card-meta-${CLAUDE_SLACK_ENTRY}`,
        `plugins-card-source-${CLAUDE_SLACK_ENTRY}`,
      ],
    ]) {
      const title = window.getByTestId(titleId);
      await expect(title.getByTestId(sourceId)).toHaveCount(0);
      await expect(
        window.getByTestId(metaId).getByTestId(sourceId),
      ).toBeVisible();
      await expect(title).toContainText('Plugin');
      const geometry = await title.evaluate((line) => {
        const name = line.firstElementChild;
        const type = line.querySelector('[data-testid*="-type-"]');
        if (!name || !type) throw new Error('Missing plugin name or type');
        return {
          nameFits: name.scrollWidth <= name.clientWidth,
          inline:
            Math.abs(
              name.getBoundingClientRect().y - type.getBoundingClientRect().y,
            ) < 5,
        };
      });
      expect(geometry).toEqual({ nameFits: true, inline: true });
    }
    await window.setViewportSize({ width: 1400, height: 900 });
    // The server the Codex plugin brought is listed as that plugin.
    await expect(window.getByTestId(bundledRow)).toHaveCount(0);
    await expect(window.getByTestId(bundledCard)).toHaveCount(0);
    // Explicit installedVia provenance keeps the claimed catalog out of Browse.
    await expect(
      browse.getByTestId(`plugins-entry-${SLACK_CATALOG_ENTRY}`),
    ).toHaveCount(0);

    // Plugins: both plugins, no MCP catalog card.
    await window.getByTestId('plugins-type-tab-plugin').click();
    await expect(window.getByTestId('plugins-type-tab-plugin')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      browse.getByTestId(`plugins-entry-${CLAUDE_SLACK_ENTRY}`),
    ).toBeVisible();
    await expect(
      installed.getByTestId(`customize-row-${CODEX_SLACK_ENTRY}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`plugins-entry-${SLACK_CATALOG_ENTRY}`),
    ).toHaveCount(0);

    // MCP servers, unfiltered: Installed holds only the standalone server;
    // Browse excludes the catalog card claimed by the installed plugin.
    await search.fill('');
    await window.getByTestId('plugins-type-tab-app').click();
    await expect(window.getByTestId('plugins-type-tab-app')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      installed.getByTestId(`customize-row-mcp-local:${STANDALONE_SERVER_ID}`),
    ).toBeVisible();
    await expect(
      installed.locator('[data-testid^="customize-row-mcp-local:"]'),
    ).toHaveCount(1);
    await expect(window.getByTestId(bundledRow)).toHaveCount(0);
    await expect(window.getByTestId(bundledCard)).toHaveCount(0);
    await expect(
      browse.getByTestId(`plugins-entry-${SLACK_CATALOG_ENTRY}`),
    ).toHaveCount(0);

    // The Installed owner opens its detail, which keeps the bundled server
    // and links the distinct Claude package; that page links back.
    await window.getByTestId('plugins-type-tab-plugin').click();
    await search.fill('slack');
    await installed.getByTestId(`customize-row-${CODEX_SLACK_ENTRY}`).click();
    const detailPage = window.getByTestId('plugins-entry-detail-page');
    await expect(detailPage).toBeVisible();
    const toClaude = detailPage.getByTestId(
      `plugin-detail-also-available-${CLAUDE_SLACK_ENTRY}`,
    );
    await expect(toClaude).toBeVisible();
    await expect(
      detailPage.getByTestId('plugin-detail-also-available'),
    ).toHaveText('Also available from Claude · slackapi');
    // The MCP servers section is always visible (CAN-4842).
    const serverSettings = detailPage.getByTestId(
      'plugin-detail-mcp-server-settings-slack',
    );
    await expect(serverSettings).toContainText('Open server settings');

    // The Claude copy opens on its full plugin page, which links back.
    await toClaude.click();
    const toCodex = detailPage.getByTestId(
      `plugin-detail-also-available-${CODEX_SLACK_ENTRY}`,
    );
    await expect(toCodex).toBeVisible();
    await expect(toCodex).toHaveText('Codex official');
    await toCodex.click();
    await expect(toClaude).toBeVisible();

    // The Codex page's bundled server opens the hidden row's own page.
    await serverSettings.getByRole('button').click();
    await expect(
      detailPage.getByTestId('plugins-entry-detail-status'),
    ).toBeVisible();
    await expect(toClaude).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
