// @capture-keep: reusable plugins browse and management visual regression reference
// @capture-reference: docs/ui-automation.md
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedCuratedPlugins,
  seedMcpServers,
  seedPluginsCache,
  writeJson,
} from './seeders/index.mjs';

// API-2153 — Plugins Discovery Redesign + ChatGPT-style restyle
// visual-evidence captures.
//
// What changed: a pure
// presentation pass over that same IA to mirror ChatGPT's plugins page —
// centered column, pill search, a two-column ⋯-menu card grid with per-section
// explicit "Show more" controls, category-grouped browse (replacing the
// flat marketplace sampler), and the installed row rebuilt as an icon strip +
// direct settings shortcut (`PluginsInstalledRow.tsx` → `PluginsInstalledStrip`).
// See `docs/planning/2026-08-18-plugins-chatgpt-restyle/design.md` and the
// reference screenshot it names (`reference-chatgpt.png` alongside this
// report — see `report.md`). No projection/flow/IPC changes.
//
// How to run both restyle stages:
//
//   1. `after` (this tree, default): rebuild with `pnpm run build:e2e`, then
//      PLUGINS_RESTYLE_STAGE=after pnpm run test:electron:captures:built plugins-redesign.capture-spec.ts --reporter=line
//
//   2. `before` (the pre-restyle tree at `32ed28dc5d`): this repo
//      has no local modifications to stash, so the sanctioned recipe is a
//      throwaway worktree of the base commit rather than `git stash`:
//        git worktree add /tmp/plugins-restyle-before 32ed28dc5d
//        # symlink node_modules/.cache instead of a full reinstall — package.json
//        # and package-lock.json are byte-identical between the base commit and
//        # this branch (verified via `git diff 32ed28dc5d HEAD -- package.json
//        # package-lock.json`), so the same installed tree is safe to reuse.
//        ln -s "$(pwd)/node_modules" /tmp/plugins-restyle-before/node_modules
//        ln -s "$(pwd)/apps/desktop-app/node_modules" /tmp/plugins-restyle-before/apps/desktop-app/node_modules
//        ln -s "$(pwd)/apps/web/node_modules" /tmp/plugins-restyle-before/apps/web/node_modules
//        ln -s "$(pwd)/.cache" /tmp/plugins-restyle-before/.cache
//        cp apps/desktop-app/tests/electron/plugins-redesign.capture-spec.ts \
//          /tmp/plugins-restyle-before/apps/desktop-app/tests/electron/
//        (cd /tmp/plugins-restyle-before && pnpm run build:e2e)
//        (cd /tmp/plugins-restyle-before && PLUGINS_RESTYLE_STAGE=before pnpm run test:electron:captures:built plugins-redesign.capture-spec.ts --reporter=line)
//        cp /tmp/plugins-restyle-before/.playwright/plugins-redesign/*-before.png \
//          .playwright/plugins-redesign/
//        git worktree remove /tmp/plugins-restyle-before
//
// The same deterministic fixture data is used on both trees: no live agents,
// provider CLIs, filesystem scans, or network requests are involved.
//
// Captures: `landing` (redesign before/after; restyle `after` re-capture shows
// the card grid + category-grouped browse tail), `installed-strip` /
// `gear-menu` (restyle `after`-only: the settings view opened by the gear),
// `collapsed-section` (restyle `after`-only: a capped category section
// showing the explicit "Show more" button before it is
// activated), `expanded-section` (restyle `after`-only: the same capped
// category section after its expander is activated), `card-menu` (paired
// history of the card action treatment; the current after state has no
// redundant View menu), `search` (`after`-only: cross-source
// banded search, no direct `before` equivalent since the old tabs had no
// unified search), `management-marketplaces` / `management-skills` /
// `management-mcp` (old per-tab panel vs. the new "Your plugins" overlay
// section), `add-custom-menu` (`after`-only: the consolidated add dropdown;
// the old UI had no single equivalent control) and `entry-detail`
// (`after`-only: the `PluginEntryDetail` wrapper around the untouched
// `PluginDetailView`).

const STAGE =
  process.env.PLUGINS_RESTYLE_STAGE === 'before' ? 'before' : 'after';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'plugins-redesign');

const NOW = '2026-08-17T12:00:00.000Z';

function mcpConfig(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    enabled: true,
    envVars: {},
    extraArgs: [],
    extraHeaders: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const EMPTY_PLUGIN_DETAILS = {
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

/**
 * Restyle-only fixture (API-2153 task 3): a second `demo/catalog` marketplace
 * with two categories so browse mode's category-grouped tail
 * (`PluginsPage.tsx` `groupByCategory`) has something to group and cap.
 *
 * 10 "Productivity" plugins clear `CATEGORY_SECTION_LIMIT = 6`
 * (`PluginsPage.tsx`), producing a `plugins-section-more-category-productivity`
 * expander with an explicit "Show more" button (collapsedCount 4). 3 "Design"
 * plugins stay uncapped, so browse shows
 * more than one category section without an expander on every one of them.
 *
 * None of these carry `globalInstallStatus`, so every entry is `available`
 * (`marketplacePluginState()` in `unifiedPluginEntries.ts`) and therefore
 * lands in the category-grouped browse tail, not the installed strip.
 *
 * Layered on top of `seedPluginsCache()` by reading back and appending to the
 * `plugins-cache.json` it just wrote — the same merge approach
 * `seedCuratedPlugins()` uses for its own marketplace row — so both fixtures
 * coexist in one capture run.
 */
function seedCategorySampler(userDataDir: string): void {
  const cacheFilePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));

  function catalogPlugin(
    name: string,
    displayName: string,
    description: string,
    category: string,
  ) {
    return {
      name,
      displayName,
      description,
      sourcePath: `plugins/${name}`,
      marketplaceId: 'demo/catalog',
      category,
      details: EMPTY_PLUGIN_DETAILS,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    };
  }

  const productivityPlugins = [
    [
      'calendar-plus',
      'Calendar Plus',
      'Smart scheduling suggestions for busy calendars.',
    ],
    ['doc-sync', 'Doc Sync', 'Keep documents in sync across your project.'],
    [
      'focus-timer',
      'Focus Timer',
      'Pomodoro-style focus sessions with break reminders.',
    ],
    [
      'habit-tracker',
      'Habit Tracker',
      'Daily habit tracking with streaks and reminders.',
    ],
    [
      'inbox-zero',
      'Inbox Zero',
      'Triage and archive email straight from chat.',
    ],
    [
      'meeting-notes',
      'Meeting Notes',
      'Auto-summarize meetings into shareable notes.',
    ],
    ['note-taker', 'Note Taker', 'Capture and organize notes automatically.'],
    [
      'quick-capture',
      'Quick Capture',
      'Jot down ideas and turn them into tasks.',
    ],
    ['task-board', 'Task Board', 'Kanban-style task tracking for your team.'],
    [
      'time-tracker',
      'Time Tracker',
      'Track billable hours without leaving your editor.',
    ],
  ].map(([name, displayName, description]) =>
    catalogPlugin(name, displayName, description, 'Productivity'),
  );

  const designPlugins = [
    ['icon-kit', 'Icon Kit', 'Search and drop in icons from a shared library.'],
    [
      'mockup-builder',
      'Mockup Builder',
      'Sketch quick UI mockups without leaving chat.',
    ],
    [
      'palette-studio',
      'Palette Studio',
      'Build and share color palettes for your brand.',
    ],
  ].map(([name, displayName, description]) =>
    catalogPlugin(name, displayName, description, 'Design'),
  );

  const plugins = [...productivityPlugins, ...designPlugins];
  cache.marketplaces.push({
    id: 'demo/catalog',
    name: 'Demo Catalog',
    description: 'Seeded category catalog',
    sourceType: 'github',
    // Not github.com — see the note in `seeders/seedPluginsCache.mjs`. These
    // captures must stay byte-stable, and a real owner avatar would make them
    // depend on the network and on that account's current image.
    sourceUrl: 'https://github.invalid/demo/catalog',
    installLocation: '/tmp/demo-catalog',
    lastUpdated: NOW,
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: plugins.length,
        lastCheckedAt: NOW,
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: NOW,
      },
    },
    validProviders: ['claude'],
  });
  writeJson(cacheFilePath, cache);
}

/**
 * Deterministic fixture set shared by both stages: the `demo/market`
 * marketplace (two plugins needing install, one installed, one inline —
 * `seedPluginsCache`), the two-plugin curated catalog with one
 * `recommended: true` entry (`seedCuratedPlugins`), and one standalone MCP
 * server so the MCP management section has a populated row. The category
 * sampler is present in both stages so the pre-restyle marketplace section and
 * the restyled category sections are directly comparable.
 */
function seedFixtures(userDataDir: string): void {
  seedPluginsCache({ userDataDir });
  seedCuratedPlugins({ userDataDir });
  seedCategorySampler(userDataDir);
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'demo-linear',
          name: 'Linear',
          description: 'Track issues and projects.',
          type: 'http',
          url: 'https://linear.example.test/mcp',
          httpAuthHandler: 'provider',
          createdAt: NOW,
          updatedAt: NOW,
        },
        configs: [mcpConfig('default', 'Default')],
      },
    ],
  });
}

async function captureAs(
  locator: Locator,
  name: string,
  stage: 'before' | 'after',
  testInfo: TestInfo,
): Promise<void> {
  const filePath = path.join(captureDir, `${name}-${stage}.png`);
  await locator.screenshot({ path: filePath, animations: 'disabled' });
  await testInfo.attach(`${name}-${stage}`, {
    path: filePath,
    contentType: 'image/png',
  });
}

async function capture(
  locator: Locator,
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  await captureAs(locator, name, STAGE, testInfo);
}

test('captures the Plugins page redesign surfaces', async ({}, testInfo) => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plugins-redesign-'),
  );
  seedFixtures(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    const page = window.getByTestId('page-plugins');

    if (STAGE === 'after') {
      // --- Browse (landing): the restyled card grid — pill search, installed
      // strip, category-grouped browse tail (Other / Productivity / Design,
      // Productivity capped with an explicit "Show more" button). ---
      // Writer Toolkit is recommended but not a role pick, so it stays in its
      // category rather than leading a Suggested section.
      await expect(
        window.getByTestId('plugins-entry-curated:writer-toolkit'),
      ).toContainText('Writer Toolkit');
      const productivitySection = window.getByTestId(
        'plugins-section-category-productivity',
      );
      await expect(productivitySection).toBeVisible();
      const productivityHeading = window.getByTestId(
        'plugins-section-heading-category-productivity',
      );
      await expect(productivityHeading).toHaveAttribute(
        'aria-label',
        'Browse Productivity',
      );
      await capture(page, 'landing', testInfo);

      // --- Installed strip: "Installed" label + gear + icon tiles, matching
      // the reference screenshot's bare icon row (`report.md` side-by-side).
      const installedStrip = window.getByTestId('plugins-installed-strip');
      await expect(installedStrip).toBeVisible();
      // `plugins-installed-strip` is the tile row; its parent also holds the
      // "Installed" label + gear header row, so capture the parent for the
      // full strip (see `PluginsInstalledRow.tsx`).
      await capture(
        installedStrip.locator('xpath=..'),
        'installed-strip',
        testInfo,
      );

      // --- Installed heading opens Installed settings directly. The view carries
      // the shared sidebar navigation for every management section. ---
      await window.getByTestId('plugins-installed-row').click();
      await expect(
        window.getByTestId('plugins-management-section-installed'),
      ).toBeVisible();
      await expect(window.getByTestId('plugins-management-back')).toBeVisible();
      await capture(page, 'gear-menu', testInfo);
      await window.getByTestId('plugins-management-back').click();
      await expect(window.getByTestId('plugins-management-view')).toBeHidden();

      // --- Available cards no longer carry a redundant View menu. Clicking
      // the card itself remains the primary path to details; ⋯ is reserved
      // for genuine secondary actions such as Connect. ---
      await expect(
        window.getByTestId('plugins-entry-menu-mkt:demo/market/alpha-tool'),
      ).toHaveCount(0);
      await capture(page, 'card-menu', testInfo);

      // --- Category preview: the Productivity band before navigating into
      // its complete category page. ---
      await productivitySection.scrollIntoViewIfNeeded();
      // Park the pointer clear of the heading first so hover paint cannot make
      // the evidence byte-dependent on the preceding interaction.
      await window.mouse.move(0, 0);
      await capture(productivitySection, 'collapsed-section', testInfo);

      // --- Complete category: the heading opens the current category page
      // with every Productivity entry and an explicit Marketplace breadcrumb.
      await productivityHeading.click();
      const categoryPage = window.getByTestId('plugins-category-page');
      await expect(categoryPage).toBeVisible();
      await expect(
        categoryPage.getByTestId('plugins-entry-mkt:demo/catalog/task-board'),
      ).toBeVisible();
      await capture(categoryPage, 'expanded-section', testInfo);
      await window.getByTestId('plugins-category-breadcrumb-root').click();
      await expect(productivitySection).toBeVisible();

      // --- Search: one flat result list across curated + marketplace content. ---
      await window.getByTestId('plugins-search').fill('tool');
      const searchResults = window.getByTestId(
        'plugins-section-search-results',
      );
      await expect(searchResults).toBeVisible();
      await expect(
        searchResults.getByTestId('plugins-entry-mkt:demo/market/alpha-tool'),
      ).toBeVisible();
      await capture(page, 'search', testInfo);
      await window.getByTestId('plugins-search').fill('');

      // --- Management view: marketplaces / skills / mcp sections. ---
      await window.getByTestId('plugins-installed-row').click();
      const managementView = window.getByTestId('plugins-management-view');
      await expect(managementView).toBeVisible();

      await window.getByTestId('plugins-management-nav-marketplaces').click();
      await expect(
        window.getByTestId('marketplace-row-demo/market'),
      ).toBeVisible();
      await capture(managementView, 'management-marketplaces', testInfo);

      await window.getByTestId('plugins-management-nav-skills').click();
      await expect(
        window.getByTestId('plugins-management-section-skills'),
      ).toBeVisible();
      await capture(managementView, 'management-skills', testInfo);

      await window.getByTestId('plugins-management-nav-mcp').click();
      await expect(
        managementView.locator('tr', { hasText: 'Linear' }),
      ).toBeVisible();
      await capture(managementView, 'management-mcp', testInfo);

      await window.getByTestId('plugins-management-back').click();
      await expect(managementView).toBeHidden();

      // --- Add-custom dropdown open. ---
      await window.getByTestId('plugins-add-custom-menu').click();
      await expect(
        window.getByTestId('plugins-add-custom-marketplace'),
      ).toBeVisible();
      await capture(page, 'add-custom-menu', testInfo);
      // No Escape handler on this dropdown (repo-wide convention) — close it
      // with an outside click on the page heading before continuing.
      await window.getByRole('heading', { name: 'Customize' }).click();
      await expect(
        window.getByTestId('plugins-add-custom-marketplace'),
      ).toBeHidden();

      // --- Entry detail open: PluginEntryDetail wrapping PluginDetailView. ---
      await window.getByTestId('plugins-entry-curated:writer-toolkit').click();
      const detail = window.getByTestId('plugins-entry-detail');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('Writer Toolkit');
      await capture(detail, 'entry-detail', testInfo);
    } else {
      // --- BEFORE stage: the unified discovery UI immediately before the
      // ChatGPT-style restyle (`32ed28dc5d`). ---
      const recommendedSection = window.getByTestId(
        'plugins-section-recommended',
      );
      const marketplaceSection = window.getByTestId(
        'plugins-section-marketplace',
      );
      await expect(recommendedSection).toBeVisible();
      await expect(marketplaceSection).toBeVisible();
      await capture(page, 'landing', testInfo);

      // The old text summary + inline quick links are the direct predecessor
      // of both the icon strip and gear menu.
      const installedRow = window.getByTestId('plugins-installed-row');
      await expect(installedRow).toBeVisible();
      await capture(installedRow, 'installed-strip', testInfo);
      await capture(installedRow, 'gear-menu', testInfo);

      // The old marketplace section had neither category caps nor an
      // expander. Capture it for both filenames so the paired report shows the
      // absence of those two restyled states rather than calling them
      // unverified after-only artifacts.
      await capture(marketplaceSection, 'collapsed-section', testInfo);
      await capture(marketplaceSection, 'expanded-section', testInfo);

      // Cards exposed an inline View action before the overflow menu existed.
      await expect(
        marketplaceSection.getByTestId(
          'plugins-action-mkt:demo/market/alpha-tool',
        ),
      ).toBeVisible();
      await capture(marketplaceSection, 'card-menu', testInfo);

      await window.getByTestId('plugins-search').fill('tool');
      await expect(marketplaceSection).toBeVisible();
      await capture(page, 'search', testInfo);
      await window.getByTestId('plugins-search').fill('');

      await window.getByTestId('plugins-installed-row').click();
      const managementView = window.getByTestId('plugins-management-view');
      await expect(managementView).toBeVisible();
      await window.getByTestId('plugins-management-nav-marketplaces').click();
      await capture(page, 'management-marketplaces', testInfo);

      await window.getByTestId('plugins-management-nav-skills').click();
      await capture(managementView, 'management-skills', testInfo);

      await window.getByTestId('plugins-management-nav-mcp').click();
      await expect(
        managementView.locator('tr', { hasText: 'Linear' }),
      ).toBeVisible();
      await capture(managementView, 'management-mcp', testInfo);
      await window.getByTestId('plugins-management-back').click();

      await window.getByTestId('plugins-add-custom-menu').click();
      await expect(
        window.getByTestId('plugins-add-custom-marketplace'),
      ).toBeVisible();
      await capture(page, 'add-custom-menu', testInfo);
      await window.getByRole('heading', { name: 'Customize' }).click();

      await window.getByTestId('plugins-entry-curated:writer-toolkit').click();
      const detail = window.getByTestId('plugins-entry-detail');
      await expect(detail).toBeVisible();
      await capture(detail, 'entry-detail', testInfo);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
