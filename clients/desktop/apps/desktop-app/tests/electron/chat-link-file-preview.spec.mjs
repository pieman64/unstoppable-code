// Links in chat and file previews open previewable files rendered.
//
// Clicking a Markdown link in a chat transcript opens the file in a new file
// tab. Markdown opens in Preview and CSV opens as a Table; a file type with no
// rendered view still opens as source. An HTML page linked from chat opens in
// the in-app browser beside the chat, while one linked from a file preview
// keeps the sandboxed HTML preview. Reopening a file that is already
// open must keep whatever mode the user last chose there.
//
// Determinism: the worktree, its files, and the chat transcript are seeded from
// fixtures. No live agent, no network.
//
//   pnpm run test:electron:built chat-link-file-preview.spec.mjs --reporter=line

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
const CHAT_ID = 'chat-link-preview';
const MARKDOWN_FILE = 'LINK_REPORT.md';
const CSV_FILE = 'LINK_ROWS.csv';
const LARGE_CSV_FILE = 'LINK_LARGE_ROWS.csv';
const CODE_FILE = 'LINK_MODULE.ts';
const HTML_FILE = 'LINK_PAGE.html';
const INDEX_FILE = 'LINK_INDEX.md';

for (const origin of ['chat', 'file preview']) {
  test(`${origin} links open previewable files rendered and respect an already-open tab`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-link-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();

    writeFileSync(
      path.join(worktreePath, MARKDOWN_FILE),
      ['# Linked Report', '', 'Rendered body text.'].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(worktreePath, CSV_FILE),
      ['region,total', 'north,12', 'south,8'].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(worktreePath, LARGE_CSV_FILE),
      Array.from({ length: 10_001 }, (_, index) => `${index},value`).join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(worktreePath, CODE_FILE),
      'export const linked = 1;\n',
      'utf8',
    );

    const linkText = [
      `- [Report](${MARKDOWN_FILE})`,
      `- [Rows](${CSV_FILE})`,
      `- [Large rows](${LARGE_CSV_FILE})`,
      `- [Module](${CODE_FILE})`,
      `- [Page](${HTML_FILE})`,
    ].join('\n');
    writeFileSync(
      path.join(worktreePath, INDEX_FILE),
      `# File links\n\n${linkText}\n`,
    );
    writeFileSync(
      path.join(worktreePath, HTML_FILE),
      '<!doctype html><html><body><h1>Linked page</h1></body></html>',
    );

    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: CHAT_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Linked files',
          blocks: [
            {
              type: 'text',
              text: origin === 'chat' ? linkText : `[Index](${INDEX_FILE})`,
            },
          ],
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

      let originTab = window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`);
      let links = window.getByTestId('chat-local-file-link');
      if (origin === 'file preview') {
        await links.filter({ hasText: 'Index' }).click();
        await expect(
          window.getByRole('heading', { name: 'File links' }),
        ).toBeVisible();
        originTab = window
          .locator('[data-testid^="panel-tab-panel-file-"]')
          .filter({ hasText: INDEX_FILE });
        links = window
          .locator('[data-testid="file-viewer"]:visible')
          .filter({
            has: window
              .getByTestId('file-breadcrumb-segment-file')
              .filter({ hasText: INDEX_FILE }),
          })
          .getByTestId('file-markdown-preview')
          .getByRole('button');
      }
      await expect(links.filter({ hasText: 'Report' })).toBeVisible({
        timeout: 20_000,
      });

      // --- Markdown opens rendered ---
      await links.filter({ hasText: 'Report' }).click();
      const viewerFor = (filename) =>
        window.locator('[data-testid="file-viewer"]:visible').filter({
          has: window
            .getByTestId('file-breadcrumb-segment-file')
            .filter({ hasText: filename }),
        });
      const viewer = viewerFor(MARKDOWN_FILE);
      await expect(viewer).toBeVisible({ timeout: 20_000 });
      // The origin preview can remain visible in another panel group.
      // Match the target filename so its origin cannot satisfy assertions.
      const formatted = viewer.getByTestId('file-view-toggle-formatted');
      const source = viewer.getByTestId('file-view-toggle-source');
      await expect(formatted).toHaveAttribute('aria-pressed', 'true');
      await expect(formatted).toHaveText('Formatted');
      await expect(
        window.getByRole('heading', { name: 'Linked Report' }),
      ).toBeVisible();

      // --- A user switch back to source survives reopening the same link ---
      await source.click();
      await expect(source).toHaveAttribute('aria-pressed', 'true');
      await originTab.click();
      await links.filter({ hasText: 'Report' }).click();
      await expect(source).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.locator('[data-testid^="panel-tab-panel-file-"]'),
      ).toHaveCount(origin === 'chat' ? 1 : 2);

      // --- HTML opens rendered ---
      await originTab.click();
      await links.filter({ hasText: /^Page$/ }).click();
      if (origin === 'chat') {
        // A page linked from chat opens in the in-app browser beside it.
        const browser = window.locator(
          '[data-testid="panel-content-browser"]:visible',
        );
        await expect(browser).toHaveCount(1, { timeout: 20_000 });
        await expect(browser.getByTestId('browser-url-input')).toHaveValue(
          new RegExp(`/${HTML_FILE.replace('.', '\\.')}$`),
          { timeout: 20_000 },
        );
        await expect(
          window.getByTestId(`panel-content-chat`).filter({
            has: window.getByTestId('chat-local-file-link'),
          }),
        ).toBeVisible();
        await expect(viewerFor(HTML_FILE)).toHaveCount(0);
      } else {
        await expect(
          viewerFor(HTML_FILE).getByTestId('file-view-toggle-formatted'),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(
          viewerFor(HTML_FILE)
            .frameLocator('[data-testid="html-file-preview-frame"]')
            .getByRole('heading', { name: 'Linked page' }),
        ).toBeVisible();
      }

      // --- CSV opens as a table ---
      await originTab.click();
      await links.filter({ hasText: /^Rows$/ }).click();
      const tableSegment = viewerFor(CSV_FILE).getByTestId(
        'file-view-toggle-formatted',
      );
      await expect(tableSegment).toHaveAttribute('aria-pressed', 'true');
      await expect(tableSegment).toHaveText('Table');

      // --- An oversized CSV falls back to raw instead of mounting a huge table ---
      await originTab.click();
      await links.filter({ hasText: 'Large rows' }).click();
      await expect(
        viewerFor(LARGE_CSV_FILE).getByText(
          /CSV table limit exceeded.*Showing raw text/,
        ),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        viewerFor(LARGE_CSV_FILE).getByTestId('file-viewer-csv-raw-scroll'),
      ).toBeVisible();
      await expect(
        viewerFor(LARGE_CSV_FILE).getByTestId('file-viewer-csv-table-scroll'),
      ).toHaveCount(0);

      // --- A file type with no rendered view still opens as source ---
      await originTab.click();
      await links.filter({ hasText: 'Module' }).click();
      await expect(
        window
          .locator(
            `[data-testid="panel-content-file-diff"]:visible >> text=export const linked`,
          )
          .first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect(viewerFor(CODE_FILE)).toBeVisible();
      await expect(
        viewerFor(CODE_FILE).getByTestId('file-view-toggle'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
