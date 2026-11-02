import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Keyboard hints (design review, 22 Oct): every hint reads its keys from one
// registry, sidebar rows trail plain glyphs, and key caps are filled
// capsules with no border, one cap per key.
const MAC = process.platform === 'darwin';

test('sidebar rows trail their shortcut and settings draw borderless caps', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // New task and Search name their keys as plain trailing glyphs, outside
    // the rows' accessible names.
    const newTask = window.getByTestId('sidebar-create-task');
    await expect(newTask.getByTestId('sidebar-row-shortcut')).toHaveText(
      MAC ? '⌘N' : 'Ctrl N',
    );
    await expect(newTask).toHaveAccessibleName('New task');
    const search = window.getByTestId('sidebar-search');
    await expect(search.getByTestId('sidebar-row-shortcut')).toHaveText(
      MAC ? '⌘K' : 'Ctrl K',
    );
    await expect(search.locator('kbd')).toHaveCount(0);

    // The hints stay hidden until their row is hovered or focused, without
    // resizing the row.
    const newTaskHint = newTask.getByTestId('sidebar-row-shortcut');
    const restBox = await newTask.boundingBox();
    await window.mouse.move(0, 0);
    await expect(newTaskHint).toHaveCSS('opacity', '0');
    await newTask.hover();
    await expect(newTaskHint).toHaveCSS('opacity', '1');
    expect(await newTask.boundingBox()).toEqual(restBox);
    await window.mouse.move(0, 0);
    await expect(newTaskHint).toHaveCSS('opacity', '0');

    // Settings › Keyboard shortcuts: one cap per key, filled, no border.
    await window.keyboard.press('ControlOrMeta+Shift+k');
    const tab = window.getByTestId('settings-tab-shortcuts');
    await expect(tab).toBeVisible();
    const paletteRow = tab.getByTestId('shortcut-row-open-command-palette');
    const caps = paletteRow.locator('kbd');
    await expect(caps).toHaveText(MAC ? ['⌘', 'K'] : ['Ctrl', 'K']);
    const style = await caps.first().evaluate((cap) => {
      const computed = getComputedStyle(cap);
      return {
        border: computed.borderTopWidth,
        background: computed.backgroundColor,
        height: computed.height,
      };
    });
    expect(style.border).toBe('0px');
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.height).toBe('18px');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
