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
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'math-languages',
);

const CASES = [
  {
    fileName: 'ramsey.tex',
    language: 'latex',
    marker: 'Ramsey numbers',
  },
  {
    fileName: 'references.bib',
    language: 'bibtex',
    marker: 'greenwood1955',
  },
  {
    fileName: 'Gauss.lean',
    language: 'lean',
    marker: 'two_mul_sum_range',
  },
];

/** Distinct Monaco token classes (`mtk<n>`) in the editor's rendered lines. */
async function renderedTokenClasses(editor) {
  return editor.locator('.view-lines').evaluate((viewLines) => {
    const classes = new Set();
    for (const span of viewLines.querySelectorAll('span[class*="mtk"]')) {
      for (const name of span.classList) {
        if (/^mtk\d+$/.test(name)) classes.add(name);
      }
    }
    return [...classes].sort();
  });
}

/**
 * CAN-5012: LaTeX, BibTeX and Lean files open in a desktop file tab with a
 * registered Monaco language, so the rendered lines carry several token
 * classes instead of a single plain-text class.
 */
for (const fixture of CASES) {
  test(`file viewer: ${fixture.fileName} opens as ${fixture.language} with syntax highlighting`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-file-viewer-math-${fixture.language}-`),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();

    const filePath = path.join(worktreePath, fixture.fileName);
    copyFileSync(path.join(FIXTURE_DIR, fixture.fileName), filePath);

    const tabId = `math-language-${fixture.language}`;
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          title: fixture.fileName,
          kind: 'file',
          filePath,
          fileViewMode: 'raw',
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

      const editor = window.getByTestId('monaco-file-editor');
      await expect(editor).toBeVisible({ timeout: 20_000 });
      await expect(editor.locator('.view-lines')).toContainText(
        fixture.marker,
        { timeout: 20_000 },
      );

      // Monaco stamps the model's language id on the editor's container.
      await expect(editor.locator('[data-mode-id]').first()).toHaveAttribute(
        'data-mode-id',
        fixture.language,
      );

      // Plain text renders with one token class; a grammar yields several.
      await expect
        .poll(async () => (await renderedTokenClasses(editor)).length, {
          timeout: 10_000,
        })
        .toBeGreaterThan(2);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
