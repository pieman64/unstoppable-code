// Markdown opens formatted from every ordinary entry point, and a Source or
// Formatted choice survives closing and reopening the file (CAN-4955).
//
// A fresh Markdown file opened through Cmd/Ctrl+P starts formatted. Choosing
// Source shows wrapped prose with no ambiguous-character boxes on typographic
// punctuation, and that choice wins when the file is reopened from the palette
// or from a chat link. Formatted then survives a reopen from the Files tree,
// while a never-opened file from the tree still starts formatted. An empty
// file tab assigned from the palette resolves the same way, and plain-text source
// wraps too.
//
// Determinism: the worktree, its files, and the chat transcript are seeded
// from fixtures. No live agent, no network.
//
//   pnpm run test:electron:built quick-open-markdown-preview.spec.mjs --reporter=line

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'quick-open-markdown';
const FINDINGS_FILE = 'CAN4955_FINDINGS.md';
const FRESH_FILE = 'CAN4955_FRESH.md';
const ASSIGNED_FILE = 'CAN4955_ASSIGNED.md';
const NOTES_FILE = 'CAN4955_NOTES.txt';
const PALETTE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

const LONG_PROSE = [
  'Participants described the onboarding flow as clear — though several',
  'asked for “shorter” steps and fewer interruptions between screens, and',
  'most wanted the summary to stay visible while they compared options',
  'across devices before committing to a plan WRAPEND',
].join(' ');

const FINDINGS = [
  '# Updated findings',
  '',
  '_Participants: P1–P8_',
  '',
  '## Themes',
  '',
  LONG_PROSE,
  '',
].join('\n');

test('Markdown opens formatted and remembers the chosen view across entry points', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-quick-open-markdown-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  writeFileSync(path.join(worktreePath, FINDINGS_FILE), FINDINGS, 'utf8');
  writeFileSync(
    path.join(worktreePath, FRESH_FILE),
    '# Fresh document\n\nNever opened before.\n',
    'utf8',
  );
  writeFileSync(
    path.join(worktreePath, ASSIGNED_FILE),
    '# Assigned document\n\nPicked into an empty tab.\n',
    'utf8',
  );
  writeFileSync(path.join(worktreePath, NOTES_FILE), `${LONG_PROSE}\n`, 'utf8');

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Findings',
        blocks: [
          {
            type: 'text',
            text: `See [Findings](${FINDINGS_FILE}). Also review ${FINDINGS_FILE}.`,
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1100, height: 800 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatTab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
    const fileTab = (filename) =>
      window
        .locator('[data-testid^="panel-tab-panel-file-"]')
        .filter({ hasText: filename });
    const viewerFor = (filename) =>
      window.locator('[data-testid="file-viewer"]:visible').filter({
        has: window
          .getByTestId('file-breadcrumb-segment-file')
          .filter({ hasText: filename }),
      });
    const formattedIn = (filename) =>
      viewerFor(filename).getByTestId('file-view-toggle-formatted');
    const sourceIn = (filename) =>
      viewerFor(filename).getByTestId('file-view-toggle-source');

    const openFromPalette = async (filename) => {
      await window.keyboard.press(`${PALETTE_MODIFIER}+p`);
      await expect(window.getByTestId('file-search-palette')).toBeVisible();
      await window.getByTestId('file-search-palette-input').fill(filename);
      await window
        .getByTestId('file-search-palette-result')
        .filter({ hasText: filename })
        .first()
        .click();
      await expect(viewerFor(filename)).toBeVisible({ timeout: 20_000 });
    };
    const closeFile = async (filename) => {
      const tab = fileTab(filename);
      await expect(tab).toHaveCount(1);
      const tabTestId = await tab.getAttribute('data-testid');
      const panelId = tabTestId?.replace(/^panel-tab-/, '');
      await window
        .getByTestId(`panel-tab-close-${panelId}`)
        // The active-tab reveal overlay can win hit-testing over this button.
        .click({ force: true });
      await expect(tab).toHaveCount(0);
      // The tab strip hides pending closes optimistically. Reopening tests a
      // completed close, so wait for the public canonical read as well.
      const tabId = panelId?.replace(/^panel-file-/, '');
      if (!tabId) throw new Error('Expected file tab identity');
      await expect
        .poll(() =>
          window.evaluate(
            async ({ tabId, ...scope }) => {
              const snapshot = await window.api.chat.getState(scope);
              return snapshot.tabsFile.tabs.some(
                (candidate) => candidate.id === tabId,
              );
            },
            { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, tabId },
          ),
        )
        .toBe(false);
    };
    const openFromTree = async (originFilename, filename) => {
      const panel = window
        .locator('[data-testid="panel-content-file-diff"]:visible')
        .filter({ has: viewerFor(originFilename) });
      await panel.getByTestId('file-tab-tree-toggle').click();
      const row = panel
        .getByTestId('file-tab-tree')
        .locator(`[data-testid="files-tree-row"][data-path="${filename}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();
      await expect(viewerFor(filename)).toBeVisible({ timeout: 20_000 });
    };
    const expectWrappedSource = async (filename) => {
      const editor = viewerFor(filename).getByTestId('monaco-file-editor');
      await expect(editor).toBeVisible({ timeout: 20_000 });
      const tail = editor.locator('.view-line', { hasText: 'WRAPEND' });
      await expect(tail).toBeVisible();
      // Wrapped: the end of the long line reflows into view instead of
      // clipping past the right edge, and the line spans several rows.
      const [editorBox, tailBox] = await Promise.all([
        editor.boundingBox(),
        tail.locator('span', { hasText: 'WRAPEND' }).last().boundingBox(),
      ]);
      expect(editorBox, 'editor bounding box').not.toBeNull();
      expect(tailBox, 'wrapped tail bounding box').not.toBeNull();
      expect(tailBox.x + tailBox.width).toBeLessThanOrEqual(
        editorBox.x + editorBox.width,
      );
      await expect(
        editor.locator('.view-line', { hasText: 'Participants described' }),
      ).toBeVisible();
      await expect(
        editor.locator('.view-line', { hasText: 'Participants described' }),
      ).not.toContainText('WRAPEND');
      // Typographic punctuation is not boxed as ambiguous.
      await expect(editor.locator('.unicode-highlight')).toHaveCount(0);
    };

    // 1. A fresh file from the palette starts formatted.
    await openFromPalette(FINDINGS_FILE);
    await expect(formattedIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(formattedIn(FINDINGS_FILE)).toHaveText('Formatted');
    const header = viewerFor(FINDINGS_FILE).getByTestId('file-viewer-header');
    expect(
      await header.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(
      viewerFor(FINDINGS_FILE).getByRole('heading', {
        name: 'Updated findings',
      }),
    ).toBeVisible();

    // 2. Source shows wrapped prose without punctuation warnings.
    await sourceIn(FINDINGS_FILE).click();
    await expect(sourceIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      viewerFor(FINDINGS_FILE).getByTestId('monaco-file-editor'),
    ).toContainText('_Participants: P1–P8_', { timeout: 20_000 });
    await expectWrappedSource(FINDINGS_FILE);

    // 3. Close and reopen from the palette: Source is remembered.
    await closeFile(FINDINGS_FILE);
    await openFromPalette(FINDINGS_FILE);
    await expect(sourceIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 4. A chat link and an inline file mention keep the open file's view;
    // both defer to the remembered Source after a completed close too.
    await chatTab.click();
    const link = window
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Findings' });
    await link.click();
    await expect(sourceIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await closeFile(FINDINGS_FILE);
    await chatTab.click();
    const mention = window.getByRole('button', {
      name: `Open ${FINDINGS_FILE}`,
      exact: true,
    });
    await expect(mention).toBeVisible();
    await mention.click();
    await expect(sourceIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await closeFile(FINDINGS_FILE);
    await chatTab.click();
    await link.click();
    await expect(viewerFor(FINDINGS_FILE)).toBeVisible({ timeout: 20_000 });
    await expect(sourceIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 5. Formatted survives a reopen from the Files tree.
    await formattedIn(FINDINGS_FILE).click();
    await expect(formattedIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await openFromPalette(NOTES_FILE);
    await closeFile(FINDINGS_FILE);
    await openFromTree(NOTES_FILE, FINDINGS_FILE);
    await expect(formattedIn(FINDINGS_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 6. A never-opened file from the tree starts formatted on its own.
    await openFromTree(FINDINGS_FILE, FRESH_FILE);
    await expect(formattedIn(FRESH_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 7. Cmd/Ctrl+P assigns into the active empty file tab instead of creating
    // another tab, exercising the palette's separate assignFileTab branch.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();
    const emptyState = window.getByTestId('file-tab-empty-state');
    await expect(emptyState).toBeVisible();
    const emptyTab = window.locator(
      '[data-testid^="panel-tab-panel-file-"][data-active="true"]',
    );
    const fileTabCount = await window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .count();
    const emptyTabId = await emptyTab.getAttribute('data-testid');
    await openFromPalette(ASSIGNED_FILE);
    await expect(emptyState).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="panel-tab-panel-file-"]'),
    ).toHaveCount(fileTabCount);
    expect(await fileTab(ASSIGNED_FILE).getAttribute('data-testid')).toBe(
      emptyTabId,
    );
    await expect(formattedIn(ASSIGNED_FILE)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Plain text has no rendered view, and its source wraps like prose.
    await openFromPalette(NOTES_FILE);
    await expect(
      viewerFor(NOTES_FILE).getByTestId('file-view-toggle'),
    ).toHaveCount(0);
    await expectWrappedSource(NOTES_FILE);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
