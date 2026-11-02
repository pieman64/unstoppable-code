import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedSlashSearch,
  verifySlashSearch,
  SEARCH_WORKTREE,
} from './fixtures/can5271-slash-search.mjs';

test('CAN-5271 desktop identity ranking, caps, Show all and invocation', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5271-desktop-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedSlashSearch(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SEARCH_WORKTREE);
    const composer = page
      .getByTestId('panel-content-chat')
      .getByRole('textbox');
    const menu = page.getByTestId('chat-input-plus-menu');
    await verifySlashSearch({
      composer,
      menu,
      options: menu.locator('[data-action-row]:not([data-show-all-row])'),
      showAll: page.getByTestId('chat-input-show-all'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
