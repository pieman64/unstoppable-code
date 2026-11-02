import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const REPLY =
  'Desktop validation is complete. Web checks failed during setup because generated clients were missing.';

/**
 * Selecting reply text paints the shared muted highlight and keeps the text's
 * own color, in light and dark. The web side is covered by
 * apps/web/tests/e2e/text-selection.spec.mjs.
 */
test('selecting reply text uses the muted highlight in light and dark', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-selection-highlight-'),
  );
  seedDemoWorkspaces({ userDataDir });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'selection-chat',
        title: 'Selection highlight',
        providerType: 'claude',
        messages: [
          {
            id: 'user-0',
            role: 'user',
            timestamp: 1_700_000_000_000,
            blocks: [{ type: 'text', text: 'Where are the checks at?' }],
          },
          {
            id: 'assistant-0',
            role: 'assistant',
            timestamp: 1_700_000_000_500,
            blocks: [{ type: 'text', text: REPLY }],
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
    await window
      .locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"][data-project-id="${WORKSPACE_ID}"]`,
      )
      .click();
    const reply = window
      .getByTestId('chat-message-list-content')
      .getByText('Web checks failed', { exact: false });
    await expect(reply).toBeVisible({ timeout: 20_000 });

    const box = await reply.boundingBox();
    expect(box).not.toBeNull();
    await window.mouse.move(box.x + 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
      steps: 8,
    });
    await window.mouse.up();
    await expect
      .poll(() => window.evaluate(() => window.getSelection()?.toString()))
      .toContain('Web checks failed');

    for (const dark of [false, true]) {
      await window.evaluate(
        (enabled) => document.documentElement.classList.toggle('dark', enabled),
        dark,
      );
      // Compare rendered sRGB bytes: Chromium may serialize the same token as
      // rgba or display-p3, and quantizes alpha to 8 bits.
      const colors = await reply.evaluate((el) => {
        const bytes = (value) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('Canvas unavailable');
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--bg-muted)';
        el.append(probe);
        const muted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const selection = getComputedStyle(el, '::selection');
        return {
          expected: bytes(muted),
          background: bytes(selection.backgroundColor),
          selectedText: bytes(selection.color),
          text: bytes(getComputedStyle(el).color),
        };
      });
      expect(colors.background).toEqual(colors.expected);
      expect(colors.selectedText).toEqual(colors.text);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
