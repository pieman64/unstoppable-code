import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// REG-3024: desktop renders the Changed files and diff states the web shows,
// from the same shared components and copy.
//
// Seed: the `ts-pnpm-vite` demo worktree (`demo-main`) gets, before launch, a
// text edit, an untracked non-image binary file (`data.bin`, NUL bytes) and an
// untracked text file over desktop's 500,000-character diff bound
// (`large.txt`). Flow: the Changed files row of the binary file reads
// "Binary" instead of line counts; opening it shows the shared binary state;
// opening the large file shows the shared cut-diff notice above the diff.
//
// The shared section notices (list cut, base unavailable, sleeping) have no
// desktop producer: desktop lists changes from local git without bounds, so
// they are covered by unit tests and the web cloud flows only.
//
// Determinism: no agents, no network; changed files and diffs come from local
// git against the seeded checkout.

const WORKTREE_BRANCH = 'demo-main';
const BINARY_FILE = 'data.bin';
const LARGE_FILE = 'large.txt';

test.describe('Changed files bounded states (REG-3024)', () => {
  test('shows binary rows, the binary state and the cut-diff notice in the shared words', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-reg3024-'),
    );
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    appendFileSync(path.join(worktreePath, 'README.md'), '\nEdited line\n');
    writeFileSync(
      path.join(worktreePath, BINARY_FILE),
      Buffer.from([0x01, 0x02, 0x00, 0x03, 0x0a, 0x00, 0x04, 0x0a]),
    );
    writeFileSync(
      path.join(worktreePath, LARGE_FILE),
      '0123456789abcdefghijklmnopqrstuvwxyzABC\n'.repeat(15_000),
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const section = window.getByTestId('changed-files-section');
      await expect(section).toBeVisible({ timeout: 30_000 });
      const rowOf = (name) =>
        section
          .getByTestId('activity-changed-file')
          .filter({ hasText: name })
          .first();

      // A binary row says so instead of counting bytes as lines.
      await expect(rowOf(BINARY_FILE)).toContainText('Binary', {
        timeout: 20_000,
      });
      // A text row still counts its lines.
      await expect(rowOf('README.md')).toContainText(/\+\d+/);
      await expect(rowOf('README.md')).not.toContainText('Binary');

      const diffPanel = window.getByTestId('file-panel-diff').last();
      await rowOf(BINARY_FILE).click();
      const binaryState = diffPanel.getByTestId('diff-viewer-notice-binary');
      await expect(binaryState).toBeVisible({ timeout: 20_000 });
      await expect(binaryState).toHaveText(
        'Binary file. There is no text diff to show.',
      );

      await rowOf(LARGE_FILE).click();
      const cutNotice = diffPanel.getByTestId('diff-viewer-notice-oversized');
      await expect(cutNotice).toBeVisible({ timeout: 30_000 });
      await expect(cutNotice).toContainText(
        'This diff is too large to show in full. Showing the beginning.',
      );
      await expect(cutNotice).toHaveAttribute('data-notice-intent', 'neutral');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
