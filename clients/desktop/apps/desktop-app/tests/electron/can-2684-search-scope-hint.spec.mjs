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
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
