import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { setAllLabsFeatures as setEarlyAccess } from './helpers/earlyAccess.mjs';
import { withLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

// Coverage for the "Customize sidebar" drag-and-drop reorder modal, opened
// from the sidebar's More menu (sidebar-more -> sidebar-more-item-customize).
//
// Keyboard note: `CustomizeSidebarModal.tsx` registers both `PointerSensor` and
// `KeyboardSensor` with `sortableKeyboardCoordinates`. This spec still drives
// the reorder with real mouse pointer gestures to cover the pointer-drag path.
test('drags Plugins below the More divider and moves it into More on save', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: withLabsPagesOffered(),
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await window.getByTestId('sidebar-more').click();
    const moreMenu = window.getByTestId('sidebar-more-menu');
    await expect(moreMenu).toBeVisible();
    const customizeDivider = moreMenu.getByTestId(
      'sidebar-more-customize-divider',
    );
    const customizeItem = moreMenu.getByTestId('sidebar-more-item-customize');
    await expect(customizeDivider).toBeVisible();
    await expect(customizeDivider).toHaveAttribute('role', 'separator');
    const sectionItems = moreMenu.getByTestId(
      /^sidebar-more-item-(?!customize$)/,
    );
    await expect(sectionItems).not.toHaveCount(0);
    // The menu's experiment-only entries can finish mounting after the
    // divider. Wait for every element used by the geometry assertion to be
    // laid out before reading its bounding box.
    await expect(sectionItems.last()).toBeVisible();
    await expect(customizeItem).toBeVisible();
    const previousItemBox = await sectionItems.last().boundingBox();
    const customizeDividerBox = await customizeDivider.boundingBox();
    const customizeItemBox = await customizeItem.boundingBox();
    if (
      previousItemBox === null ||
      customizeDividerBox === null ||
      customizeItemBox === null
    ) {
      throw new Error(
        'Expected bounding boxes for More menu items and divider.',
      );
    }
    expect(customizeDividerBox.y).toBeGreaterThanOrEqual(
      previousItemBox.y + previousItemBox.height - 1,
    );
    expect(
      customizeDividerBox.y + customizeDividerBox.height,
    ).toBeLessThanOrEqual(customizeItemBox.y + 1);
    await customizeItem.click();

    const modal = window.getByTestId('customize-sidebar-modal');
    await expect(modal).toBeVisible();
    await expect(window.getByTestId(DIVIDER)).toBeVisible();
    await expect(
      window.getByTestId('customize-sidebar-row-plugins'),
    ).toBeVisible();

    // The More menu starts empty: every default key sits in main nav
    // (CAN-3678, CAN-4269; see packages/protocol/src/sidebar/index.ts), so the
    // editor shows its empty-More hint below the divider.
    const before = await editorOrder(modal);
    const dividerIndexBefore = before.indexOf('|');
    expect(dividerIndexBefore).toBe(before.length - 1);
    expect(before.indexOf('plugins')).toBeGreaterThanOrEqual(0);
    expect(before.indexOf('plugins')).toBeLessThan(dividerIndexBefore);
    const emptyMore = window.getByTestId('customize-sidebar-more-empty');
    await expect(emptyMore).toBeVisible();

    // Dropping `plugins` onto the divider moves it to the divider's slot,
    // which shifts the divider up one slot, per `arrayMove` in
    // `CustomizeSidebarModal.tsx`.
    await dragRowOnto(window, 'plugins', '|');

    // `plugins` takes the divider's old slot and is now the only More entry.
    await expect
      .poll(async () => (await editorOrder(modal)).slice(-2))
      .toEqual(['|', 'plugins']);
    const after = await editorOrder(modal);
    expect(after.indexOf('plugins')).toBe(dividerIndexBefore);
    await expect(emptyMore).toHaveCount(0);

    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();

    // Demoted: no longer a main-nav button, now in the More menu.
    await expect(window.getByTestId('sidebar-nav-plugins')).toHaveCount(0);
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    await expect(window.getByTestId('sidebar-more-item-plugins')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cancel discards a reorder without persisting it', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: withLabsPagesOffered(),
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const defaults = await readLayout(window);

    const modal = await openCustomize(window);
    await dragRowOnto(window, 'plugins', '|');
    await expect
      .poll(async () => (await editorOrder(modal)).slice(-2))
      .toEqual(['|', 'plugins']);

    await window.getByTestId('customize-sidebar-cancel').click();
    await expect(modal).toBeHidden();

    // Layout is untouched: `plugins` stays in main nav, not the More menu.
    expect(await readLayout(window)).toEqual(defaults);
    await expect(window.getByTestId('sidebar-nav-plugins')).toBeVisible();
    await window.getByTestId('sidebar-more').click();
    await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
    await expect(window.getByTestId('sidebar-more-item-plugins')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3963: under Early access, App Advisor is an ordinary row. The sidebar and
// the editor follow the stored layout exactly as they do with Early access off.
// Remote Control is never listed on desktop (CAN-3659).

const DIVIDER = 'customize-sidebar-more-divider';

/** Launches with Early access seeded on, in a data dir the test owns. */
async function launchWithEarlyAccess({ userDataDir, env } = {}) {
  const dir =
    userDataDir ??
    mkdtempSync(path.join(os.tmpdir(), 'canopy-customize-sidebar-'));
  if (userDataDir === undefined) seedEarlyAccess({ userDataDir: dir });
  const { electronApp } = await launchCanopy({
    userDataDir: dir,
    ...(env ? { env } : {}),
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await expect
    .poll(() =>
      window.evaluate(
        async () =>
          (await window.api.experiments.getSnapshot()).earlyAccessEnabled,
      ),
    )
    .toBe(true);
  return { electronApp, userDataDir: dir, window, app };
}

async function openCustomize(window) {
  await window.getByTestId('sidebar-more').click();
  await window.getByTestId('sidebar-more-item-customize').click();
  const modal = window.getByTestId('customize-sidebar-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** Row keys in editor order, with the More divider as `|`. */
function editorOrder(modal) {
  return modal
    .locator(
      `[data-testid^="customize-sidebar-row-"]:not([data-testid$="-handle"]), [data-testid="${DIVIDER}"]`,
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getAttribute('data-testid') ?? '';
        return id === 'customize-sidebar-more-divider'
          ? '|'
          : id.replace('customize-sidebar-row-', '');
      }),
    );
}

function readLayout(window) {
  return window.evaluate(
    async () => (await window.api.loadPreferences()).sidebarNavLayout,
  );
}

/**
 * The stored layout once a Save replaced `previous`. Save does not wait for
 * the durable preferences write, and `loadPreferences` serves the prior
 * layout until it commits.
 */
async function readSavedLayout(window, previous) {
  await expect.poll(() => readLayout(window)).not.toEqual(previous);
  return readLayout(window);
}

/**
 * The customizable keys the sidebar shows, per region, in order. Only keys of
 * the stored layout count: utility rows such as Customize sidebar are not
 * part of the comparison.
 */
async function readRegions(window) {
  const layout = await readLayout(window);
  const known = new Set(layout.order);
  const keys = (prefix) =>
    window
      .locator(`[data-testid^="${prefix}"]`)
      .evaluateAll(
        (nodes, p) =>
          nodes.map((node) =>
            (node.getAttribute('data-testid') ?? '').slice(p.length),
          ),
        prefix,
      );
  const mainNav = (await keys('sidebar-nav-')).filter((key) => known.has(key));
  await window.getByTestId('sidebar-more').click();
  await expect(window.getByTestId('sidebar-more-menu')).toBeVisible();
  const more = (await keys('sidebar-more-item-')).filter((key) =>
    known.has(key),
  );
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('sidebar-more-menu')).toHaveCount(0);
  return { mainNav, more };
}

/** The stored layout's regions, limited to keys the sidebar shows. */
function expectedRegions(layout, shown) {
  const visible = new Set([...shown.mainNav, ...shown.more]);
  return {
    mainNav: layout.order
      .slice(0, layout.moreStartIndex)
      .filter((key) => visible.has(key)),
    more: layout.order
      .slice(layout.moreStartIndex)
      .filter((key) => visible.has(key)),
  };
}

/**
 * Drops `sourceKey`'s row onto `targetKey`'s row (`|` for the More divider)
 * with a real pointer drag.
 */
async function dragRowOnto(window, sourceKey, targetKey) {
  const source = await window
    .getByTestId(`customize-sidebar-row-${sourceKey}`)
    .boundingBox();
  const target = await window
    .getByTestId(
      targetKey === '|' ? DIVIDER : `customize-sidebar-row-${targetKey}`,
    )
    .boundingBox();
  if (!source || !target) throw new Error('Expected drag row bounding boxes.');
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height / 2;
  await window.mouse.move(sourceX, sourceY);
  await window.mouse.down();
  await window.waitForTimeout(100);
  await window.mouse.move(sourceX, sourceY + 15, { steps: 10 });
  await window.waitForTimeout(100);
  await window.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2 + 2,
    { steps: 20 },
  );
  await window.waitForTimeout(150);
  await window.mouse.up();
  await window.waitForTimeout(300);
}

/** Moves `key`'s row one slot with dnd-kit's keyboard sensor. */
async function keyboardMoveRow(window, modal, key, arrow) {
  const handle = modal.locator('[aria-roledescription="sortable"]', {
    has: window.getByTestId(`customize-sidebar-row-${key}`),
  });
  await handle.focus();
  await expect(handle).toBeFocused();
  await window.keyboard.press('Space');
  await window.waitForTimeout(150);
  await window.keyboard.press(arrow);
  await window.waitForTimeout(150);
  await window.keyboard.press('Space');
  await window.waitForTimeout(300);
}

/** Waits for App Advisor's surface in any window or embedded page. */
async function expectAdvisorOpen(electronApp) {
  await expect
    .poll(
      async () => {
        for (const page of electronApp.windows()) {
          if (!page.url().includes('app-advisor')) continue;
          const count = await page
            .getByTestId('app-advisor-workspace-surface')
            .count()
            .catch(() => 0);
          if (count > 0) return true;
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('early access: App Advisor moves into More by pointer, opens there, and both items keep their places through toggles and restart', async () => {
  test.setTimeout(180_000);
  let launched = await launchWithEarlyAccess({ env: withLabsPagesOffered() });
  const { userDataDir } = launched;
  try {
    let { window, electronApp } = launched;
    await expect(window.getByTestId('sidebar-nav-app-advisor')).toBeVisible();
    const defaults = await readLayout(window);

    const modal = await openCustomize(window);
    const before = await editorOrder(modal);
    expect(before).not.toContain('remote-control');
    for (const key of ['app-advisor', 'workflows', 'plugins']) {
      expect(before.indexOf(key)).toBeGreaterThanOrEqual(0);
      expect(before.indexOf(key)).toBeLessThan(before.indexOf('|'));
    }
    expect(before).not.toContain('automations');
    expect(before).not.toContain('pipelines');
    // The More menu starts empty (CAN-3678).
    expect(before.at(-1)).toBe('|');

    await dragRowOnto(window, 'app-advisor', '|');
    await expect
      .poll(async () => {
        const order = await editorOrder(modal);
        return order.slice(order.indexOf('|') + 1);
      })
      .toEqual(['app-advisor']);
    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();

    await expect(window.getByTestId('sidebar-nav-app-advisor')).toHaveCount(0);
    const advisorLayout = await readSavedLayout(window, defaults);
    const advisorRegions = await readRegions(window);
    expect(advisorRegions).toEqual(
      expectedRegions(advisorLayout, advisorRegions),
    );
    expect(advisorRegions.more).toEqual(['app-advisor']);
    expect(advisorRegions.mainNav).toContain('plugins');

    // Save both customized placements before toggling or restarting. This
    // checks Marketplace's More placement survives too, rather than only
    // checking it in the default Sidebar region after the relaunch.
    const pluginsModal = await openCustomize(window);
    await keyboardMoveRow(window, pluginsModal, 'plugins', 'ArrowDown');
    await expect
      .poll(async () => {
        const order = await editorOrder(pluginsModal);
        return order.slice(order.indexOf('|') + 1);
      })
      .toEqual(['plugins', 'app-advisor']);
    await window.getByTestId('customize-sidebar-save').click();
    await expect(pluginsModal).toBeHidden();
    const saved = await readSavedLayout(window, advisorLayout);
    const regions = await readRegions(window);
    expect(regions).toEqual(expectedRegions(saved, regions));
    expect(regions.more).toEqual(['plugins', 'app-advisor']);
    await expect(window.getByTestId('sidebar-nav-plugins')).toHaveCount(0);

    // App Advisor opens from its new place in More.
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-app-advisor').click();
    await expectAdvisorOpen(electronApp);

    // Early access off and back on leaves the saved regions alone.
    expect(await setEarlyAccess(window, false)).toBe(false);
    await expect(window.getByTestId('sidebar-nav-app-advisor')).toHaveCount(0);
    expect(await readRegions(window)).toEqual(regions);
    expect(await setEarlyAccess(window, true)).toBe(true);
    await expect(window.getByTestId('sidebar-nav-app-advisor')).toHaveCount(0);
    expect(await readRegions(window)).toEqual(regions);

    // So does a restart on the same data dir.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    launched = await launchWithEarlyAccess({
      userDataDir,
      env: withLabsPagesOffered(),
    });
    ({ window, electronApp } = launched);
    expect(await readLayout(window)).toEqual(saved);
    expect(await readRegions(window)).toEqual(regions);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    }).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('early access: Marketplace moves into More and back by keyboard and opens from both', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await launchWithEarlyAccess(
    { env: withLabsPagesOffered() },
  );
  try {
    const sidebarRow = window.getByTestId('sidebar-nav-plugins');
    await expect(sidebarRow).toBeVisible();
    const defaults = await readLayout(window);
    await app.openPluginsPage();

    let modal = await openCustomize(window);
    const before = await editorOrder(modal);
    // Marketplace is the last Sidebar row, so one step down crosses the
    // divider into More.
    expect(before[before.indexOf('|') - 1]).toBe('plugins');
    await keyboardMoveRow(window, modal, 'plugins', 'ArrowDown');
    await expect
      .poll(async () => {
        const order = await editorOrder(modal);
        return order.indexOf('plugins') > order.indexOf('|');
      })
      .toBe(true);
    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();

    await expect(sidebarRow).toHaveCount(0);
    const saved = await readSavedLayout(window, defaults);
    const regions = await readRegions(window);
    expect(regions).toEqual(expectedRegions(saved, regions));
    expect(regions.more).toContain('plugins');

    // From More it opens the same page.
    await app.openMainPage();
    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-plugins').click();
    await app.expectPluginsPage();

    // And back up into the Sidebar.
    modal = await openCustomize(window);
    const moved = await editorOrder(modal);
    expect(moved[moved.indexOf('|') + 1]).toBe('plugins');
    await keyboardMoveRow(window, modal, 'plugins', 'ArrowUp');
    await expect
      .poll(async () => {
        const order = await editorOrder(modal);
        return order.indexOf('plugins') < order.indexOf('|');
      })
      .toBe(true);
    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();
    await expect(sidebarRow).toBeVisible();
    const backLayout = await readSavedLayout(window, saved);
    const back = await readRegions(window);
    expect(back).toEqual(expectedRegions(backLayout, back));
    expect(back.more).not.toContain('plugins');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('early access: Cancel discards edits, Reset then Cancel keeps the saved layout, Reset then Save restores the default', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithEarlyAccess({
    env: withLabsPagesOffered(),
  });
  try {
    const defaults = await readLayout(window);

    let modal = await openCustomize(window);
    await keyboardMoveRow(window, modal, 'plugins', 'ArrowUp');
    await window.getByTestId('customize-sidebar-cancel').click();
    await expect(modal).toBeHidden();
    expect(await readLayout(window)).toEqual(defaults);
    await expect(window.getByTestId('sidebar-nav-overview')).toHaveCount(0);
    await expect(window.getByTestId('sidebar-nav-plugins')).toBeVisible();

    modal = await openCustomize(window);
    await dragRowOnto(window, 'app-advisor', '|');
    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();
    const custom = await readSavedLayout(window, defaults);
    await expect(window.getByTestId('sidebar-nav-app-advisor')).toHaveCount(0);

    modal = await openCustomize(window);
    await window.getByTestId('customize-sidebar-reset').click();
    await window.getByTestId('customize-sidebar-cancel').click();
    await expect(modal).toBeHidden();
    expect(await readLayout(window)).toEqual(custom);

    modal = await openCustomize(window);
    await window.getByTestId('customize-sidebar-reset').click();
    await window.getByTestId('customize-sidebar-save').click();
    await expect(modal).toBeHidden();
    await expect.poll(() => readLayout(window)).toEqual(defaults);
    await expect(window.getByTestId('sidebar-nav-app-advisor')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
