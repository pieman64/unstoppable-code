// The account proxy's switch line in a desktop chat transcript (CAN-4021).
//
// The session emits `canopy_account_proxy_switch` when the proxy moves the
// chat to another account, and the transcript reducer persists it as an
// `account_proxy_switch` block (covered by `switch-events.test.ts`, the
// session suites and `transcript-parser.test.ts`). This spec seeds that
// persisted transcript, a finished turn, and checks the chat keeps the shared
// line visible beside the final reply when the turn's activity collapses.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { accountProxySwitchChatTab } from './seeders/seedAccountProxySwitchChat.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'account-proxy-switch';

test('shows where the account proxy moved a chat to another account', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-account-proxy-switch-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [accountProxySwitchChatTab(CHAT_ID)],
    activeTabId: CHAT_ID,
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const chat = window
      .getByTestId('panel-content-chat')
      .filter({ visible: true })
      .first();
    await expect(chat).toContainText('Retries are in place');
    const line = chat.getByTestId('account-proxy-switch-line');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveText(
      'ops@example.com reached its usage limit. Continued on sam@example.com.',
    );
    // The names are blocked from session replay.
    await expect(line.locator('.ph-no-capture')).toHaveText([
      'ops@example.com',
      'sam@example.com',
    ]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
