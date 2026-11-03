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
const TAB_ID = 'frontmatter-preview-file';
const MARKDOWN_FILE = 'FRONTMATTER_PREVIEW.md';

test('markdown file preview renders YAML frontmatter', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-markdown-frontmatter-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const markdownPath = path.join(worktreePath, MARKDOWN_FILE);
  writeFileSync(
    markdownPath,
    [
      '---',
      'title: Frontmatter Preview',
      'draft: false',
      'tags:',
      '  - alpha',
      '  - beta',
      '---',
      '',
      '# Body Heading',
      '',
      'Markdown body content.',
      '',
      '![Remote tracking image](https://tracker.invalid/pixel.png)',
    ].join('\n'),
    'utf8',
  );

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: MARKDOWN_FILE,
        kind: 'file',
        filePath: markdownPath,
        fileViewMode: 'preview',
        description: markdownPath,
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

    // The seeded file tab renders as its own 'file-diff' panel.
    const chatPanel = window.getByTestId('panel-content-file-diff');
    await expect(chatPanel).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-panel-file-${TAB_ID}`),
    ).toBeVisible();

    // The tab is seeded in preview mode, so Formatted is the pressed view.
    await expect(
      chatPanel.getByRole('button', { name: 'Formatted', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Each frontmatter fact is labelled with its literal key.
    await expect(
      chatPanel.locator('dt').getByText('title', { exact: true }),
    ).toBeVisible();
    await expect(
      chatPanel.getByText('Frontmatter Preview', { exact: true }),
    ).toBeVisible();
    await expect(
      chatPanel.locator('dt').getByText('draft', { exact: true }),
    ).toBeVisible();
    await expect(chatPanel.getByText('No', { exact: true })).toBeVisible();
    await expect(
      chatPanel.locator('dt').getByText('tags', { exact: true }),
    ).toBeVisible();
    await expect(chatPanel.getByText('["alpha","beta"]')).toBeVisible();
    await expect(
      chatPanel.getByRole('heading', { name: 'Body Heading' }),
    ).toBeVisible();
    await expect(
      chatPanel.locator('img[src="https://tracker.invalid/pixel.png"]'),
    ).toHaveCount(0);
    await expect(chatPanel.getByText('Remote tracking image')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
