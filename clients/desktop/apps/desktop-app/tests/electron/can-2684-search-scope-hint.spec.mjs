/**
 * CAN-2684 — guards the sidebar Search palette's scope copy and persistent
 * mode hint when switching between all results and commands-only queries.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('Search explains its scope and keeps the mode hint current', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2684-search-scope-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-search').click();

    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await expect(
      window.getByRole('dialog', { name: 'Search', exact: true }),
    ).toBeVisible();
    const input = palette.getByTestId('command-palette-input');
    const hint = palette.getByTestId('command-palette-mode-hint');
    await expect(input).toHaveAttribute(
      'placeholder',
      'Search chats, workspaces, plugins, settings, and more',
    );
    await expect(hint).toHaveText('Type > for commands');
    await expect(hint).toHaveAttribute('data-mode', 'all');

    await input.fill('>');
    await expect(hint).toHaveText('Commands only');
    await expect(hint).toHaveAttribute('data-mode', 'commands');

    await input.fill('demo');
    await expect(hint).toHaveText('Type > for commands');
    await expect(hint).toHaveAttribute('data-mode', 'all');

    // The header is the shared lg search field: its nested button clears the
    // query and keeps the hint, and a search with no results hands off to
    // the shared empty state.
    await expect(
      palette
        .locator('[data-search-field="lg"]')
        .getByTestId('command-palette-input'),
    ).toBeVisible();
    await palette.getByTestId('command-palette-clear').click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(hint).toHaveText('Type > for commands');
    await input.fill('zzqxv-no-such-thing');
    const empty = palette.getByTestId('command-palette-empty');
    await expect(empty).toContainText('Nothing matches your search.');
    await empty.getByTestId('command-palette-empty-clear').click();
    await expect(input).toHaveValue('');
    await expect(empty).toHaveCount(0);

    // Escape still closes the palette at once, whatever the query.
    await input.fill('demo');
    await window.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
