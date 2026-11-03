import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/index.mjs';

// CAN-4844: on the Customize Skills tab a custom skill has an inline Custom
// icon and wrapping creator/relative-edit metadata, and offers Edit and
// Delete… from its row menu; a skill an installed plugin bundles reads
// its parent status in a disabled control, offers Open details and the plugin,
// follows the plugin's status under the status filter, and adds a footnote.
//
// Testids exercised:
//   - `customize-row-subtitle-<id>` / `customize-row-custom-<id>`
//   - `customize-row-menu-<id>` (`-edit`, `-remove`, `-details`)
//   - `customize-row-remove-dialog` / `-confirm`
//   - `plugins-entry-status-<id>` / `customize-installed-footnote`
//   - `customize-installed-status-filter` (`-option-<status>`)

const CUSTOM_SKILL = 'review-checklist';
const CUSTOM_ID = `skill:custom:app:${CUSTOM_SKILL}`;
const PLUGIN_NAME = 'slack-tool';
const PLUGIN_DISPLAY_NAME = 'Slack Tool';
const BUNDLED_SKILL = 'summarize-channel';
const PLUGIN_ID = `mkt:demo/market/${PLUGIN_NAME}`;
const BUNDLED_ID = `plugin-skill:demo/market/${PLUGIN_NAME}:${BUNDLED_SKILL}`;

function seed(userDataDir) {
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      {
        name: PLUGIN_NAME,
        displayName: PLUGIN_DISPLAY_NAME,
        description: 'Posts to channels',
        details: {
          skills: [
            {
              name: BUNDLED_SKILL,
              description: 'Summarize a channel',
              path: `skills/${BUNDLED_SKILL}/SKILL.md`,
            },
          ],
          agents: [],
          commands: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          hasReadme: false,
        },
        cachePath: `/tmp/${PLUGIN_NAME}`,
        cachedAt: '2026-06-17T00:00:00.000Z',
      },
    ],
  });
  for (const name of [CUSTOM_SKILL, 'keep-me']) {
    const directory = path.join(userDataDir, 'skills', 'custom:app', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Deterministic CAN-4844 fixture\n---\n\n# ${name}\n`,
    );
  }
}

test('custom and plugin-bundled skill rows on the Customize Skills tab', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-4844-skills-'),
  );
  seed(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-skill').click();
    const installed = window.getByTestId('customize-section-installed');
    await expect(installed).toBeVisible();

    // ------------------------------------------------------------------
    // Custom skill: avatar badge, creator and edited tooltip, Edit, Delete…
    // ------------------------------------------------------------------
    await expect(
      installed.getByTestId(`customize-row-subtitle-${CUSTOM_ID}`),
    ).toHaveText('You');
    await expect(
      installed.getByTestId(`customize-row-custom-${CUSTOM_ID}`),
    ).toHaveAttribute('aria-label', 'Custom skill');
    const nameLine = installed.getByTestId(
      `customize-row-name-line-${CUSTOM_ID}`,
    );
    await expect(
      nameLine.getByTestId(`customize-row-custom-${CUSTOM_ID}`),
    ).toHaveCount(0);
    const creator = installed.getByTestId(`customize-row-creator-${CUSTOM_ID}`);
    await expect(creator).toHaveCount(0);
    const edited = installed.getByTestId(`customize-row-source-${CUSTOM_ID}`);
    await edited.hover();
    await expect(window.getByRole('tooltip')).toContainText('2026');
    const badge = installed.getByTestId(`customize-row-custom-${CUSTOM_ID}`);
    const badgeGeometry = await badge.evaluate((element) => {
      const glyph = element.querySelector('svg');
      const overlay = element.parentElement.parentElement;
      const style = getComputedStyle(element);
      const glyphStyle = getComputedStyle(glyph);
      const overlayStyle = getComputedStyle(overlay);
      return {
        width: style.width,
        height: style.height,
        glyphWidth: glyphStyle.width,
        bottom: overlayStyle.bottom,
        right: overlayStyle.right,
        wrapperOverflow: getComputedStyle(overlay.parentElement).overflow,
      };
    });
    expect(badgeGeometry).toEqual({
      width: '16px',
      height: '16px',
      glyphWidth: '12px',
      bottom: '-4px',
      right: '-4px',
      wrapperOverflow: 'visible',
    });

    await expect(
      installed.getByTestId(`customize-row-version-${CUSTOM_ID}`),
    ).toHaveCount(0);

    const rowMenu = installed.getByTestId(`customize-row-menu-${CUSTOM_ID}`);
    await rowMenu.click();
    const edit = window.getByTestId(`customize-row-menu-${CUSTOM_ID}-edit`);
    await expect(edit).toHaveText('Edit');
    await expect(edit).not.toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveJSProperty('disabled', false);
    await edit.click();
    await expect(window.getByTestId('skill-editor-page')).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-edit'),
    ).toHaveAttribute('aria-current', 'page');
    await window.getByTestId('skill-editor-cancel').click();
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await window.getByTestId('plugins-type-tab-skill').click();
    await expect(installed).toBeVisible();

    const remove = window.getByTestId(`customize-row-menu-${CUSTOM_ID}-remove`);
    // The status read must land before the row offers removal.
    await expect(async () => {
      await rowMenu.click();
      await expect(remove).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(remove).toHaveText('Delete…');
    await remove.click();
    const dialog = window.getByTestId('customize-row-remove-dialog');
    await expect(dialog).toContainText('Delete Review Checklist?');
    await window.getByTestId('customize-row-remove-confirm').click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect(
      installed.getByTestId(`customize-row-${CUSTOM_ID}`),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      installed.getByTestId('customize-row-skill:custom:app:keep-me'),
    ).toBeVisible();

    // ------------------------------------------------------------------
    // Bundled skill: inherited status, footnote, two-item menu, Open details
    // ------------------------------------------------------------------
    const footnote = window.getByTestId('customize-installed-footnote');
    const inheritedStatus = installed.getByTestId(
      `plugins-entry-status-${BUNDLED_ID}`,
    );
    await expect(inheritedStatus).toHaveAttribute(
      'data-status',
      /^(active|available|disabled)$/,
    );
    await expect(inheritedStatus).toHaveAttribute('aria-disabled', 'true');
    await expect(inheritedStatus.locator('svg')).toHaveCount(0);
    await inheritedStatus.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      `Set by the ${PLUGIN_DISPLAY_NAME} plugin. Change it on the plugin.`,
    );
    await expect(footnote).toHaveText(
      "A skill that comes with a plugin follows that plugin's status.",
    );
    await installed.getByTestId(`customize-row-menu-${BUNDLED_ID}`).click();
    const surface = window.getByTestId(
      `customize-row-menu-${BUNDLED_ID}-surface`,
    );
    await expect(
      surface.locator(`[data-testid^="customize-row-menu-${BUNDLED_ID}-"]`),
    ).toHaveText(['Open details', `Open the ${PLUGIN_DISPLAY_NAME} plugin`]);
    await window
      .getByTestId(`customize-row-menu-${BUNDLED_ID}-details`)
      .click();
    const detail = window.getByTestId('plugins-entry-detail-page');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('plugin-detail-host')).toBeVisible();
    await expect(detail).toContainText(PLUGIN_DISPLAY_NAME);
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await window.getByTestId('plugins-type-tab-skill').click();

    // Search by the plugin's name finds its bundled skill.
    await window.getByTestId('plugins-search').fill(PLUGIN_DISPLAY_NAME);
    await expect(
      installed.getByTestId(`customize-row-${BUNDLED_ID}`),
    ).toBeVisible();
    await expect(footnote).toBeVisible();
    await window.getByTestId('plugins-search-clear').click();

    // ------------------------------------------------------------------
    // Status filter: the bundled skill follows its plugin's status
    // ------------------------------------------------------------------
    const readPluginStatus = async () => {
      const snapshot = await window.evaluate(() =>
        window.installedItems.listStatus(),
      );
      return (
        snapshot.items.find(
          (item) =>
            item.target.kind === 'plugin' &&
            item.target.pluginName === PLUGIN_NAME,
        )?.status ?? null
      );
    };
    await expect.poll(readPluginStatus, { timeout: 30_000 }).not.toBeNull();
    const pluginStatus = await readPluginStatus();
    await expect(inheritedStatus).toHaveAttribute('data-status', pluginStatus);
    const otherStatus = pluginStatus === 'disabled' ? 'active' : 'disabled';
    const statusFilter = window.getByTestId(
      'customize-installed-status-filter',
    );
    const bundledRow = installed.getByTestId(`customize-row-${BUNDLED_ID}`);
    await statusFilter.click();
    await window
      .getByTestId(`customize-installed-status-filter-option-${otherStatus}`)
      .click();
    await expect(bundledRow).toHaveCount(0);
    await expect(footnote).toHaveCount(0);
    await statusFilter.click();
    await window
      .getByTestId(`customize-installed-status-filter-option-${pluginStatus}`)
      .click();
    await expect(bundledRow).toBeVisible();
    await expect(footnote).toBeVisible();
    await statusFilter.click();
    await window
      .getByTestId('customize-installed-status-filter-option-any')
      .click();
    await expect(bundledRow).toBeVisible();
    // The plugin entry the skill follows is listed on the Plugins tab.
    await window.getByTestId('plugins-type-tab-plugin').click();
    await expect(
      installed.getByTestId(`customize-row-${PLUGIN_ID}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
