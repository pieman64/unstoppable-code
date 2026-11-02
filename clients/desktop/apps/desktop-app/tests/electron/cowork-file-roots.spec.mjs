import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  COWORK_FILES_BRAND,
  COWORK_FILES_ENTRY,
  COWORK_FILES_NAME,
  COWORK_FILES_WORKSPACE,
  seedCoworkFileRoots,
} from './cowork-file-roots-fixture.mjs';

test('Cowork names and separates roots in the explorer and an empty File tab', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-files-'),
  );
  seedCoworkFileRoots(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window
      .getByTestId(`sidebar-work-entry-${COWORK_FILES_ENTRY}`)
      .click();
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      COWORK_FILES_NAME,
    );
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    const explorer = window.getByTestId('files-tree-tab');
    const userRoot = explorer.locator('[data-file-tree-id="workspace:"]');
    await expect(userRoot).toContainText(COWORK_FILES_NAME);
    await expect(userRoot).toHaveAttribute('aria-expanded', 'true');
    await expect(explorer.locator('[data-path="notes"]')).toBeVisible();
    await expect(explorer.locator('[data-path="prompts"]')).toBeVisible();
    const group = explorer.getByTestId('files-tree-root-group');
    await expect(group).toContainText(COWORK_FILES_BRAND.displayName);
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await explorer.locator('[data-path="vendor-spend-cleaned.csv"]').click();
    const panel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(panel.getByTestId('file-breadcrumb-segment-root')).toHaveText(
      COWORK_FILES_NAME,
    );
    await expect(panel.getByTestId('file-viewer')).toContainText('Acme');

    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();
    await expect(window.getByTestId('file-tab-empty-state')).toBeVisible();
    const embedded = window.getByTestId('file-tab-tree');
    const embeddedRoot = embedded.locator('[data-file-tree-id="workspace:"]');
    await expect(embeddedRoot).toContainText(COWORK_FILES_NAME);
    await expect(embeddedRoot).toHaveAttribute('aria-expanded', 'true');
    const embeddedGroup = embedded.getByTestId('files-tree-root-group');
    await expect(embeddedGroup).toHaveAttribute('aria-expanded', 'false');
    await embeddedGroup.focus();
    await embeddedGroup.press('ArrowRight');
    await expect(embeddedGroup).toHaveAttribute('aria-expanded', 'true');
    const notes = embedded.locator('[data-file-tree-id="notes:"]');
    await notes.click();
    await embedded.locator('[data-file-tree-id="notes:meeting.md"]').click();
    await expect(panel.getByTestId('file-breadcrumb-segment-root')).toHaveText(
      'notes',
    );
    await expect(panel.getByTestId('file-viewer')).toContainText(
      'App-owned meeting notes',
    );
    await expect(window.getByTestId('file-error')).toHaveCount(0);
    await window
      .getByRole('tab', { name: /vendor-spend-cleaned\.csv/ })
      .click();
    await expect(panel.getByTestId('file-breadcrumb-segment-root')).toHaveText(
      COWORK_FILES_NAME,
    );
    await panel.getByTestId('file-tab-tree-toggle').click();
    const refreshedTree = window.getByTestId('file-tab-tree');
    await expect(refreshedTree).toBeVisible();
    await window.evaluate(async (projectId) => {
      await window.api.chatProject.update({
        projectId,
        name: 'Renamed Q4 / 支出 🌳',
      });
    }, COWORK_FILES_WORKSPACE);
    await refreshedTree
      .getByRole('button', { name: 'File tree actions' })
      .click();
    await window
      .getByRole('menuitem', { name: 'Refresh files', exact: true })
      .click();
    await expect(
      refreshedTree.locator('[data-file-tree-id="workspace:"]'),
    ).toContainText('Renamed Q4 / 支出 🌳');
    await expect(panel.getByTestId('file-breadcrumb-segment-root')).toHaveText(
      'Renamed Q4 / 支出 🌳',
    );
    await expect(panel.getByTestId('file-viewer')).toContainText('Acme');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
