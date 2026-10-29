import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';

// CAN-3661: a page that is switched off is absent from every navigation
// choice, and a programmatic request for it lands on New task instead.
//
// Workers is the page under test because its gate is a client feature flag the
// launch harness can override. Its row also needs a terminal worker mode
// (`workers-visibility.ts`), so every launch seeds one: the flag is then the
// only thing that hides it. The dev reference pages are forced on in E2E
// builds, so their denial is covered by unit tests, not here. The App Advisor
// refusal and the live "switched off while open" redirect are covered by the
// dispatcher and page-host unit tests.
//
// `__canopyNavigationTestApi.navigate` calls the navigation store the way
// programmatic openers do. It is not an OS deep link: no OS link targets a
// gated page.

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

const WORKERS_DISABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-claude-tui-workers': false,
  }),
};

/**
 * Launch with a terminal worker mode, so the Workers row's flag gate is the
 * one under test. The migration marker keeps the one-time reset to Canopy
 * mode from undoing the seed, as in `workers-page.spec.mjs`.
 */
async function launchWithWorkersMode(options = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3661-workers-'),
  );
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { canopyBackgroundProcessesMode: 'terminal' },
  });
  writeJson(path.join(userDataDir, 'migrations.json'), {
    version: 1,
    claude_worker_modes_canopy: true,
  });
  return launchCanopy({ ...options, userDataDir });
}

async function openPalette(window) {
  await window.keyboard.press(PALETTE_SHORTCUT);
  await expect(window.getByTestId('command-palette')).toBeVisible();
  await expect(window.getByTestId('command-palette-input')).toBeVisible();
}

async function requestPage(window, page) {
  return window.evaluate(
    (requested) => window.__canopyNavigationTestApi.navigate(requested),
    page,
  );
}

async function broadcastWorkersGate(electronApp, window, enabled) {
  const snapshot = await window.evaluate(() =>
    window.api.featureFlags.getSnapshot(),
  );
  await electronApp.evaluate(
    ({ BrowserWindow }, update) => {
      for (const host of BrowserWindow.getAllWindows()) {
        host.webContents.send('feature-flags:snapshot-changed', update);
      }
    },
    {
      ...snapshot,
      values: {
        ...snapshot.values,
        'canopy-desktop-claude-tui-workers': enabled,
      },
    },
  );
}

test('updates an open customization modal and sidebar when Workers availability changes', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchWithWorkersMode();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-customize').click();
    const modal = window.getByTestId('customize-sidebar-modal');
    const workersRow = modal.getByTestId('customize-sidebar-row-workers');
    await expect(workersRow).toBeVisible();

    await broadcastWorkersGate(electronApp, window, false);
    await expect(modal).toBeVisible();
    await expect(workersRow).toHaveCount(0);
    await broadcastWorkersGate(electronApp, window, true);
    await expect(workersRow).toBeVisible();
    await modal.getByTestId('customize-sidebar-cancel').click();

    // Workers is a main-nav row in the default layout (CAN-3678).
    const workersEntry = window.getByTestId('sidebar-nav-workers');
    await expect(workersEntry).toBeVisible();
    await broadcastWorkersGate(electronApp, window, false);
    await expect(workersEntry).toHaveCount(0);
    await broadcastWorkersGate(electronApp, window, true);
    await expect(workersEntry).toBeVisible();

    expect(await requestPage(window, 'workers')).toBe(true);
    await expect(window.getByTestId('page-workers')).toBeVisible();
    await broadcastWorkersGate(electronApp, window, false);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(window.getByTestId('page-workers')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('leaves a switched-off Workers page out of navigation and falls back to New task', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchWithWorkersMode({
    env: WORKERS_DISABLED_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Sidebar: neither the main nav nor the More menu offers Workers.
    await expect(window.getByTestId('sidebar-nav-workers')).toHaveCount(0);
    await window.getByTestId('sidebar-more').click();
    const moreMenu = window.getByTestId('sidebar-more-menu');
    await expect(moreMenu).toBeVisible();
    await expect(
      moreMenu.getByTestId('sidebar-more-item-customize'),
    ).toBeVisible();
    await expect(moreMenu.getByTestId('sidebar-more-item-workers')).toHaveCount(
      0,
    );

    // Customize sidebar: no Workers row to reorder.
    await moreMenu.getByTestId('sidebar-more-item-customize').click();
    const customize = window.getByTestId('customize-sidebar-modal');
    await expect(customize).toBeVisible();
    await expect(
      customize.getByTestId('customize-sidebar-row-overview'),
    ).toBeVisible();
    await expect(
      customize.getByTestId('customize-sidebar-row-workers'),
    ).toHaveCount(0);
    await customize.getByTestId('customize-sidebar-cancel').click();
    await expect(customize).toBeHidden();

    // Command palette: no "Open Workers", while other page commands remain.
    await openPalette(window);
    await window.getByTestId('command-palette-input').fill('Open Statistics');
    await expect(
      window.getByRole('option', { name: 'Open Statistics' }),
    ).toBeVisible();
    await window.getByTestId('command-palette-input').fill('Open Workers');
    await expect(
      window.getByRole('option', { name: 'Open Statistics' }),
    ).toHaveCount(0);
    await expect(
      window.getByRole('option', { name: 'Open Workers' }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('command-palette')).toBeHidden();

    // Programmatic request: start somewhere else so the fallback is visible.
    await app.openStatisticsPage();
    expect(await requestPage(window, 'workers')).toBe(true);
    await expect
      .poll(() =>
        window.evaluate(() => window.__canopyNavigationTestApi.activePage()),
      )
      .toBe('home');
    await expect(
      window.getByTestId('page-home').getByTestId('home-surface'),
    ).toBeVisible();
    await expect(window.getByTestId('page-workers')).toHaveCount(0);

    // The probe validates its input: an unknown page is not a request.
    expect(await requestPage(window, 'not-a-page')).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('offers and opens Workers when the page is switched on', async () => {
  test.setTimeout(120_000);
  // No override: the harness default keeps Workers on.
  const { electronApp, userDataDir } = await launchWithWorkersMode();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Sidebar entry opens the page.
    await window.getByTestId('sidebar-nav-workers').click();
    await expect(window.getByTestId('page-workers')).toBeVisible();

    // So does a programmatic request, from another page.
    await app.openStatisticsPage();
    expect(await requestPage(window, 'workers')).toBe(true);
    await expect(window.getByTestId('page-workers')).toBeVisible();
    expect(
      await window.evaluate(() =>
        window.__canopyNavigationTestApi.activePage(),
      ),
    ).toBe('workers');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('preserves a Workers reorder saved while its page is switched off', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchWithWorkersMode();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-customize').click();
    const modal = window.getByTestId('customize-sidebar-modal');
    const workersRow = modal.getByTestId('customize-sidebar-row-workers');
    const divider = modal.getByTestId('customize-sidebar-more-divider');
    await expect(workersRow).toBeVisible();
    const source = await workersRow.boundingBox();
    const target = await divider.boundingBox();
    if (!source || !target) {
      throw new Error('Expected Workers and More divider drag geometry.');
    }
    await window.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await window.mouse.down();
    await window.waitForTimeout(100);
    await window.mouse.move(source.x + source.width / 2, source.y + 15, {
      steps: 10,
    });
    await window.waitForTimeout(100);
    // Workers starts in main nav (CAN-3678); drag it below the divider into
    // More.
    await window.mouse.move(
      target.x + target.width / 2,
      target.y + target.height + 5,
      { steps: 20 },
    );
    await window.waitForTimeout(150);
    await window.mouse.up();
    // Let the drag sensor release its temporary click suppression before Save.
    await window.waitForTimeout(300);
    // Prove the draft edit succeeded before changing its visibility.
    await expect
      .poll(async () => {
        const order = await modal
          .locator(
            '[data-testid="customize-sidebar-more-divider"], [data-testid^="customize-sidebar-row-"]:not([data-testid$="-handle"])',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-testid')),
          );
        return (
          order.indexOf('customize-sidebar-row-workers') >
          order.indexOf('customize-sidebar-more-divider')
        );
      })
      .toBe(true);
    await broadcastWorkersGate(electronApp, window, false);
    await expect(workersRow).toHaveCount(0);
    await modal.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();
    await expect(window.getByTestId('sidebar-nav-workers')).toHaveCount(0);
    await broadcastWorkersGate(electronApp, window, true);
    await expect(window.getByTestId('sidebar-nav-workers')).toHaveCount(0);
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-item-workers')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
