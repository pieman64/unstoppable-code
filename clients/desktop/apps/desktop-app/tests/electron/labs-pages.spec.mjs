import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setAllLabsFeatures as setEarlyAccess } from './helpers/earlyAccess.mjs';
import { writeJson } from './seeders/index.mjs';

/**
 * Labs page experiments and More customization (CAN-3678, CAN-4402), and
 * the Labs and Dev sidebar markers (CAN-3679).
 *
 * Overview, Kanban, Agents, Statistics and Audit Trail are Labs experiments,
 * off by default and independent of Early access. Their rows sit in main nav
 * and render only while switched on. E2E builds pin them `on`; this spec sets
 * them back to the production `offered` rollout. More holds only
 * the E2E-only Dev pages entry, so the empty-More state is
 * covered by unit tests instead.
 */

const PAGES = [
  { key: 'overview', experiment: 'overview-page' },
  { key: 'kanban', experiment: 'kanban-page' },
  { key: 'statistics', experiment: 'statistics-page' },
  { key: 'audit', experiment: 'audit-trail-page' },
];

const PRODUCTION_FLAGS_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-labs-overview-page': 'offered',
    'canopy-desktop-labs-kanban-page': 'offered',
    'canopy-desktop-labs-statistics-page': 'offered',
    'canopy-desktop-labs-audit-trail-page': 'offered',
  }),
};

const STATISTICS_OFF_MESSAGE =
  'The Statistics page is switched off. Turn it on in Settings → Labs.';

async function launch(options = {}) {
  const launched = await launchCanopy({
    ...options,
    env: PRODUCTION_FLAGS_ENV,
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { ...launched, window, app };
}

async function setPageExperiment(window, experimentId, enabled) {
  await window.evaluate((choice) => window.api.experiments.setChoice(choice), {
    experimentId,
    enabled,
  });
}

test('a fresh profile hides the Labs pages and removes Environments from More', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launch();
  try {
    for (const { key } of PAGES) {
      await expect(window.getByTestId(`sidebar-nav-${key}`)).toHaveCount(0);
    }
    await window.getByTestId('sidebar-more').click();
    const items = window
      .getByTestId('sidebar-more-menu')
      .locator('[data-testid^="sidebar-more-item-"]');
    await expect
      .poll(() =>
        items.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-testid')),
        ),
      )
      .toEqual(['sidebar-more-item-dev-pages', 'sidebar-more-item-customize']);
    // Dev pages is marked as a development page; Customize is not (CAN-3679).
    const devMarker = window
      .getByTestId('sidebar-more-item-dev-pages')
      .getByTestId('sidebar-entry-marker-dev');
    await expect(devMarker).toHaveAccessibleName('Dev');
    await expect(window.getByTestId('sidebar-more-item-dev-pages')).toHaveText(
      'Dev pages',
    );
    await devMarker.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'Dev only. Not shown in shipped builds.',
    );
    await expect(
      window
        .getByTestId('sidebar-more-item-customize')
        .locator('[data-testid^="sidebar-entry-marker-"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('switches each page on from Settings without Early access, and off again silently', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await expect(
      window.getByTestId('experimental-features-toggle'),
    ).toHaveCount(0);
    const pagesSection = window.getByTestId('settings-labs-pages');
    await expect(pagesSection).toBeVisible();
    for (const { experiment } of PAGES) {
      const toggle = pagesSection.getByTestId(
        `labs-experiment-toggle-${experiment}`,
      );
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
    }
    await app.closeSettings();

    // The rows appear at the end of the main nav, in layout order.
    const mainNavKeys = await window
      .getByTestId('sidebar-main-nav')
      .locator('[data-testid^="sidebar-nav-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-testid')),
      );
    const labsKeys = PAGES.map(({ key }) => `sidebar-nav-${key}`).filter(
      (testId) => mainNavKeys.includes(testId),
    );
    expect(labsKeys).toEqual(PAGES.map(({ key }) => `sidebar-nav-${key}`));
    // Each Labs row carries the Labs marker; shipped rows carry none
    // (CAN-3679).
    for (const { key } of PAGES) {
      await expect(
        window
          .getByTestId(`sidebar-nav-${key}`)
          .getByTestId('sidebar-entry-marker-labs'),
      ).toHaveAccessibleName('Labs');
    }
    // The marker is a glyph: the visible label is the page name alone, and
    // the marker joins the row's accessible name as a separate word.
    await expect(window.getByTestId('sidebar-nav-kanban')).toHaveText('Kanban');
    await expect(window.getByTestId('sidebar-nav-kanban')).toHaveAccessibleName(
      'Kanban Labs',
    );
    await window
      .getByTestId('sidebar-nav-kanban')
      .getByTestId('sidebar-entry-marker-labs')
      .hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'Labs experiment. Turn it off in Settings → Labs.',
    );
    await window.mouse.move(0, 0);
    for (const key of ['plugins', 'workflows']) {
      await expect(window.getByTestId(`sidebar-nav-${key}`)).toBeVisible();
      await expect(
        window
          .getByTestId(`sidebar-nav-${key}`)
          .locator('[data-testid^="sidebar-entry-marker-"]'),
      ).toHaveCount(0);
    }

    // Switching a page off while it is open lands on New task, no toast.
    await window.getByTestId('sidebar-nav-statistics').click();
    await expect(window.getByTestId('page-statistics')).toBeVisible();
    await setPageExperiment(window, 'statistics-page', false);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(window.getByTestId('sidebar-nav-statistics')).toHaveCount(0);
    await expect(window.getByText(STATISTICS_OFF_MESSAGE)).toHaveCount(0);

    // A page choice survives Early access going on and off.
    await setEarlyAccess(window, true);
    await setEarlyAccess(window, false);
    await expect(window.getByTestId('sidebar-nav-kanban')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a refused page explains itself and opens Settings → Labs', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    await window.keyboard.press('ControlOrMeta+9');
    await expect(window.getByTestId('page-home')).toBeVisible();
    const message = window.getByText(STATISTICS_OFF_MESSAGE);
    await expect(message).toHaveCount(1);
    // Pressing again keeps one toast.
    await window.keyboard.press('ControlOrMeta+9');
    await expect(message).toHaveCount(1);

    await window.getByRole('button', { name: 'Open Labs' }).click();
    await app.expectSettingsSection('experiments');
    await expect(message).toHaveCount(0);
    await app.closeSettings();

    // A programmatic request for Overview is refused the same way.
    await window.evaluate(() =>
      window.__canopyNavigationTestApi.navigate('overview'),
    );
    await expect(
      window.getByText(
        'The Overview page is switched off. Turn it on in Settings → Labs.',
      ),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Customize sidebar opens from a main-nav right-click and from Settings → Display', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    const modal = window.getByTestId('customize-sidebar-modal');
    await window.getByTestId('sidebar-nav-plugins').click({ button: 'right' });
    await window.getByTestId('sidebar-nav-context-customize').click();
    await expect(modal).toBeVisible();
    await window.getByTestId('customize-sidebar-cancel').click();
    await expect(modal).toBeHidden();

    await app.openSettings();
    await app.openSettingsSection('display');
    await window.getByTestId('settings-customize-sidebar').click();
    await expect(modal).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('migrates a pre-upgrade layout: More keys move to main nav, Environments and Agents are removed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-labs-pages-e2e-'),
  );
  // The previous default layout: everything after Remote Control in More.
  // Agents was retired into Customize › Agents (CAN-4266), so its stored
  // key is dropped along with Environments.
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      sidebarNavLayout: {
        order: [
          'app-advisor',
          'workflows',
          'plugins',
          'feed',
          'remote-control',
          'overview',
          'kanban',
          'environments',
          'agents',
          'statistics',
          'audit',
          'workers',
        ],
        moreStartIndex: 5,
      },
    },
  });
  const { electronApp, window } = await launch({ userDataDir });
  try {
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await window.api.loadPreferences()).sidebarNavLayout,
        ),
      )
      .toEqual({
        order: [
          'app-advisor',
          'workflows',
          'plugins',
          'feed',
          'remote-control',
          'overview',
          'kanban',
          'statistics',
          'audit',
          'workers',
        ],
        moreStartIndex: 10,
      });
    await window.getByTestId('sidebar-more').click();
    await expect(
      window.getByTestId('sidebar-more-item-environments'),
    ).toHaveCount(0);
    await expect(window.getByTestId('sidebar-more-item-overview')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
