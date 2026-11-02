import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The Settings component sweep of the desktop pages: every action and list
// lives in a settings group as rows of the shared row height, page searches
// are the shared page search field, and choices use the shared marks.

/** Height of an element in CSS pixels. */
async function heightOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element is not rendered');
  return box.height;
}

test('desktop Settings pages keep their actions and lists in settings rows', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();

    await test.step('Environments: header actions keep their roles and the search fills its row', async () => {
      await app.openSettingsSection('environment');
      const page = window.getByTestId('settings-tab-environment');
      for (const testId of [
        'environments-new-environment',
        'environments-open-global-defaults',
      ]) {
        const action = page.getByTestId(testId);
        await expect(action).toBeVisible();
        await expect(action).toHaveClass(/rounded-full/);
        expect(await heightOf(action)).toBeCloseTo(28, 0);
      }
      // New environment keeps its accent role; Global runtime defaults is
      // secondary.
      await expect(
        page.getByTestId('environments-new-environment'),
      ).toHaveClass(/bg-accent/);
      await expect(
        page.getByTestId('environments-open-global-defaults'),
      ).not.toHaveClass(/bg-accent/);

      // The Global runtime defaults dialog: full-width dropdowns in form
      // fields, and Done in the footer.
      await page.getByTestId('environments-open-global-defaults').click();
      const defaults = window.getByTestId('environments-global-defaults-modal');
      await expect(defaults).toBeVisible();
      const fields = window.getByTestId('environments-global-runtimes');
      const fieldsBox = await fields.boundingBox();
      const runtime = window.getByTestId('environments-global-runtime-canopy');
      const runtimeBox = await runtime.boundingBox();
      expect(runtimeBox.width).toBeGreaterThan(fieldsBox.width - 48);
      // The last field draws whole, focus ring included: the body keeps
      // room under it above the footer.
      const last = window.getByTestId('environments-global-runtime-pipeline');
      await last.focus();
      const [lastBox, bodyBox] = await Promise.all([
        last.boundingBox(),
        fields.evaluate((node) => {
          const body = node.closest('.overflow-y-auto');
          const rect = (body ?? node).getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        }),
      ]);
      expect(lastBox.y + lastBox.height + 4).toBeLessThanOrEqual(
        bodyBox.y + bodyBox.height + 0.5,
      );
      await expect(
        defaults
          .locator('[data-dialog-footer]')
          .getByTestId('environments-global-defaults-close'),
      ).toBeVisible();
      await window.getByTestId('environments-global-defaults-close').click();
      await expect(defaults).toBeHidden();

      // The shared search field fills the list's width.
      const field = page.locator('[data-search-field]').first();
      await expect(field).toBeVisible();
      const list = page.getByTestId('environments-list');
      const [fieldBox, listBox] = await Promise.all([
        field.boundingBox(),
        list.boundingBox(),
      ]);
      expect(fieldBox.width).toBeCloseTo(listBox.width, 0);

      const row = page.getByTestId('environments-list-row-default-overall');
      expect(await heightOf(row)).toBeGreaterThanOrEqual(64);
      await expect(row).not.toHaveClass(/accent/);
      await expect(row.locator('[data-badge-tone]')).toHaveText('Default');

      await row.click();
      const usage = window.getByTestId('environment-usage-list');
      await expect(usage).toBeVisible();
      // Name and Inherits from share the 208px Settings field width.
      const [nameBox, parentBox] = await Promise.all([
        window.getByTestId('environments-name-input').boundingBox(),
        window.getByTestId('environments-parent-select').boundingBox(),
      ]);
      expect(nameBox.width).toBeCloseTo(208, 0);
      expect(parentBox.width).toBeCloseTo(208, 0);
      expect(nameBox.x).toBeCloseTo(parentBox.x, 0);
      // The variable editor sits in the shared settings group card; its
      // encryption status is the section description, outside the card.
      const variables = window.getByTestId('environments-variables-group');
      await expect(
        window.getByTestId('environment-editor-encryption-status'),
      ).toBeVisible();
      await expect(
        variables.getByTestId('environment-editor-encryption-status'),
      ).toHaveCount(0);
      await expect(
        variables.getByTestId('environments-variable-editor'),
      ).toBeVisible();
      await window.getByTestId('environment-editor-add-row').click();
      const secret = window
        .locator('input[data-testid^="environment-editor-secret-"]')
        .last();
      await expect(secret).not.toHaveClass(/accent/);
      await secret.check();
      await expect(secret).toBeChecked();
      await expect(secret).toHaveClass(/bg-fg-primary/);
      // The save bar spans the Settings card, its Save on the content column.
      const bar = window.getByTestId('environments-save-bar');
      await expect(bar.getByTestId('environments-unsaved')).toBeVisible();
      const [barBox, cardBox, groupBox, saveBox] = await Promise.all([
        bar.boundingBox(),
        window.getByTestId('settings-content').boundingBox(),
        variables.boundingBox(),
        window.getByTestId('environments-save').boundingBox(),
      ]);
      expect(barBox.x).toBeCloseTo(cardBox.x, 0);
      expect(barBox.width).toBeCloseTo(cardBox.width, 0);
      expect(barBox.y + barBox.height).toBeCloseTo(
        cardBox.y + cardBox.height,
        0,
      );
      expect(saveBox.x + saveBox.width).toBeCloseTo(
        groupBox.x + groupBox.width,
        0,
      );
      await expect(bar).toHaveClass(/bg-secondary/);
    });

    await test.step('Codex: the default speed is a settings group', async () => {
      await app.openSettingsSection('codex');
      const speed = window.getByTestId('settings-codex-fast-mode-default');
      await expect(speed).toBeVisible();
      await expect(speed.getByRole('radio')).toHaveCount(3);
      for (const radio of await speed.getByRole('radio').all()) {
        await expect(radio).not.toHaveClass(/accent/);
      }
      const refresh = window.getByTestId('settings-codex-speed-refresh');
      await expect(refresh).toHaveClass(/rounded-full/);
      await expect(refresh).toHaveText('Check again');
    });

    await test.step('Display: theme dots read each theme’s own accent token', async () => {
      await app.openSettingsSection('display');
      await window.getByTestId('settings-theme-select').click();
      const lime = window.getByTestId('theme-color-dot-lime');
      await expect(lime).toHaveAttribute('data-theme', 'lime');
      await expect(lime).toHaveClass(/bg-accent/);
      await expect(lime).not.toHaveAttribute('style', /background/);
      const [limeColor, oceanColor] = await Promise.all(
        ['lime', 'ocean'].map((name) =>
          window
            .getByTestId(`theme-color-dot-${name}`)
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ),
      );
      expect(limeColor).not.toBe(oceanColor);
      await window.keyboard.press('Escape');
      await expect(
        window.getByTestId('chat-enrichment-how-it-works'),
      ).toBeVisible();
    });

    await test.step('General: the role editor keeps its actions in the footer', async () => {
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-profile-role-edit').click();
      const modal = window.getByTestId('settings-profile-role-modal');
      await expect(modal).toBeVisible();
      const footer = modal.locator('[data-dialog-footer]');
      await expect(
        footer.getByTestId('settings-profile-role-save'),
      ).toBeVisible();
      await expect(
        footer.getByTestId('settings-profile-role-cancel'),
      ).toBeVisible();
      const [title, save] = await Promise.all([
        modal.getByRole('heading').first().boundingBox(),
        footer.getByTestId('settings-profile-role-save').boundingBox(),
      ]);
      expect(save.y).toBeGreaterThan(title.y + title.height);
      await footer.getByTestId('settings-profile-role-cancel').click();
      await expect(modal).toBeHidden();
    });

    await test.step('Plugins: the active items summary is a row with a capsule', async () => {
      await app.openSettingsSection('plugins');
      const manage = window.getByTestId('active-items-summary-manage');
      await expect(manage).toHaveText('Open Customize');
      expect(await heightOf(manage)).toBeCloseTo(28, 0);
      await expect(manage).toHaveClass(/rounded-full/);
    });

    await test.step('Privacy: the data protections are one settings notice', async () => {
      await app.openSettingsSection('privacy');
      const protection = window.getByTestId('telemetry-disclosure-protection');
      await expect(protection).toBeVisible();
      await expect(protection).toHaveAttribute('data-notice-shape', 'settings');
      await expect(
        window.getByTestId('telemetry-disclosure').locator('h3, ul'),
      ).toHaveCount(0);
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
