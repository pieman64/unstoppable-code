import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const FILE_NAME = 'growth-analysis.ipynb';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'notebooks',
  FILE_NAME,
);

/**
 * CAN-5012: a Jupyter notebook opens in a desktop file tab as a rendered,
 * read-only notebook (Markdown with math, a labeled code cell, stream, image
 * and error outputs), and the Source view still shows the raw JSON.
 */
test('file viewer: a Jupyter notebook renders as a notebook with a Source toggle', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-notebook-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const filePath = path.join(worktreePath, FILE_NAME);
  copyFileSync(FIXTURE, filePath);

  const tabId = 'notebook-preview';
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        // The view a new notebook tab starts in (defaultFileViewMode).
        fileViewMode: 'preview',
        description: filePath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const notebook = window.getByTestId('file-notebook-preview');
    await expect(notebook).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('file-view-toggle-formatted'),
    ).toHaveAttribute('aria-pressed', 'true');

    // Markdown cell, including `$x^2$` math rendered by KaTeX.
    const markdownCell = notebook.locator(
      '[data-testid="notebook-cell"][data-cell-type="markdown"]',
    );
    await expect(markdownCell.first()).toContainText('Growth analysis');
    await expect(markdownCell.first().locator('.katex').first()).toBeVisible({
      timeout: 15_000,
    });

    // Code cells are labeled with the notebook language and execution count.
    const codeCells = notebook.locator(
      '[data-testid="notebook-cell"][data-cell-type="code"]',
    );
    await expect(codeCells).toHaveCount(3);
    await expect(
      codeCells.first().getByTestId('notebook-code-language'),
    ).toHaveText('python');
    await expect(codeCells.first().locator('pre').first()).toContainText(
      'totals = [q ** 2 for q in quarters]',
    );

    // Outputs: stream text, a PNG display_data image, and a clean traceback.
    await expect(
      notebook.locator(
        '[data-testid="notebook-output"][data-output-type="stream"]',
      ),
    ).toContainText('Quarterly totals: [1, 4, 9]');
    const image = notebook.getByTestId('notebook-output-image');
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect
      .poll(() =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement ? element.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0);
    const error = notebook.locator(
      '[data-testid="notebook-output"][data-output-type="error"]',
    );
    await expect(error).toContainText('IndexError: list index out of range');
    const errorText = await error.textContent();
    expect(errorText).not.toContain('\u001b');
    expect(errorText).not.toContain('[0;31m');

    // Source shows the raw JSON in the editor; Formatted returns.
    await window.getByTestId('file-view-toggle-source').click();
    await expect(notebook).toHaveCount(0);
    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator('.view-lines')).toContainText('"nbformat"', {
      timeout: 20_000,
    });
    await window.getByTestId('file-view-toggle-formatted').click();
    await expect(window.getByTestId('file-notebook-preview')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
