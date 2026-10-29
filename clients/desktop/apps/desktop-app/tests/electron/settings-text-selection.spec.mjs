import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * Settings pages are controls and their labels, not text to copy: dragging
 * across a page or triple-clicking a title selects nothing. Text the user
 * types, and values meant to be copied (paths, commands, codes), stay
 * selectable.
 */
test('settings labels are not selectable but fields and copyable values are', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');

    const page = window.getByTestId('settings-tab-git');
    const selectedText = () =>
      window.evaluate(() => window.getSelection()?.toString() ?? '');

    // Triple-clicking the title would select its whole line if it allowed
    // selection.
    await page.getByRole('heading', { level: 1, name: 'Git' }).click({
      clickCount: 3,
    });
    expect(await selectedText()).toBe('');

    // A drag from the title across the page selects nothing either.
    const titleBox = await page
      .getByRole('heading', { level: 1, name: 'Git' })
      .boundingBox();
    const sectionBox = await page
      .getByRole('heading', { name: 'Branch naming', exact: true })
      .boundingBox();
    expect(titleBox).not.toBeNull();
    expect(sectionBox).not.toBeNull();
    await window.mouse.move(titleBox.x + 2, titleBox.y + titleBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(
      sectionBox.x + sectionBox.width,
      sectionBox.y + sectionBox.height / 2,
      { steps: 8 },
    );
    await window.mouse.up();
    expect(await selectedText()).toBe('');

    // The navigation is part of the same surface.
    await window.getByTestId('settings-nav-git').click({ clickCount: 3 });
    expect(await selectedText()).toBe('');

    // Typed values stay selectable.
    const threshold = window.getByTestId('split-pr-threshold-input');
    expect(
      await threshold.evaluate((input) => getComputedStyle(input).userSelect),
    ).not.toBe('none');

    // A detected path is a value to copy.
    const executablePath = window.getByTestId('settings-git-executable-path');
    await executablePath.click({ clickCount: 3 });
    await expect.poll(selectedText).not.toBe('');

    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Because the text is not selectable, a click on a switch row's label or
 * explanation flips its switch, exactly once.
 */
test('clicking a switch row text flips the switch once', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');

    const row = window.getByTestId('settings-git-group-child-branches');
    const toggle = window.getByTestId(
      'settings-git-group-child-branches-toggle',
    );
    const initial = await toggle.getAttribute('aria-checked');
    const flipped = initial === 'true' ? 'false' : 'true';
    const savedGrouping = () =>
      window.evaluate(
        async () =>
          (await window.api.loadPreferences()).groupChildBranchesWithBase,
      );

    await row.getByText('Nest a worktree under the worktree').click();
    await expect(toggle).toHaveAttribute('aria-checked', flipped);
    await expect.poll(savedGrouping).toBe(flipped === 'true');

    // The label already names the switch: still one flip, not two.
    await row.getByText('Stack child branches', { exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', initial ?? 'false');
    await expect.poll(savedGrouping).toBe(initial === 'true');

    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
