// Settings controls render the ink their classes name.
//
// `shadcn/no-unknown-classes` found classes in Settings that generated no
// CSS: the Terminal tab's buttons hovered with `hover:bg-hover` (no such
// role, so no fill ever appeared) and the global focus shortcut's validation
// message wore `fg-danger` (no such role, so it inherited the paragraph's
// ink). This spec walks both surfaces the way a user reaches them and reads
// the computed colors back, so a class that compiles to nothing fails here
// rather than rendering unstyled.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * The computed value a class resolves to, read from a probe element that
 * carries only that class, so the expectation follows the theme rather than
 * pinning a color literal.
 */
async function probeColor(window, className, property) {
  return window.evaluate(
    ({ className, property }) => {
      const probe = document.createElement('span');
      probe.className = className;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { className, property },
  );
}

async function computed(locator, property) {
  return locator.evaluate(
    (el, property) => getComputedStyle(el).getPropertyValue(property),
    property,
  );
}

test.describe('settings inks', () => {
  test('the Terminal tab buttons fill on hover and the shortcut validation reads in the destructive ink', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-inks-'));
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; }',
      });

      // Settings → Terminal: Add preset is the shared secondary Button, whose
      // hover lays the house `--bg-subtle` overlay over its resting surface.
      await app.openSettings();
      await app.openSettingsSection('terminal');
      const addPreset = window.getByTestId('terminal-preset-add');
      await expect(addPreset).toBeVisible({ timeout: 30_000 });
      await window.mouse.move(0, 0);
      expect(await computed(addPreset, 'background-image')).toBe('none');
      await addPreset.hover();
      await expect
        .poll(() => computed(addPreset, 'background-image'))
        .toMatch(/^linear-gradient\(/);

      // The preset editor's Cancel is the ghost Button: the house hover fill.
      const hoverFill = await probeColor(
        window,
        'bg-secondary',
        'background-color',
      );
      await addPreset.click();
      const editor = window.getByTestId('terminal-preset-editor');
      await expect(editor).toBeVisible();
      const cancel = editor.getByRole('button', {
        name: 'Cancel',
        exact: true,
      });
      await window.mouse.move(0, 0);
      expect(await computed(cancel, 'background-color')).not.toBe(hoverFill);
      await cancel.hover();
      await expect
        .poll(() => computed(cancel, 'background-color'))
        .toBe(hoverFill);
      await window.mouse.move(0, 0);
      await cancel.click();
      await expect(editor).toBeHidden();

      // Settings → Shortcuts: a chord the app already uses shows the
      // validation message in the destructive ink, not the inherited one.
      await app.openSettingsSection('shortcuts');
      const toggle = window.getByTestId('global-focus-shortcut-toggle');
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
      }
      await window.getByTestId('global-focus-shortcut-change').click();
      const recorder = window.getByTestId('global-focus-shortcut-recorder');
      await expect(recorder).toBeVisible();
      await recorder.press('ControlOrMeta+k');
      const validation = window.getByTestId('global-focus-shortcut-validation');
      await expect(validation).toBeVisible();
      const destructive = await probeColor(window, 'fg-destructive', 'color');
      const inherited = await computed(validation.locator('xpath=..'), 'color');
      expect(destructive).not.toBe(inherited);
      expect(await computed(validation, 'color')).toBe(destructive);
      await window.getByTestId('global-focus-shortcut-cancel').click();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
