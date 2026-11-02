import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  markWorkspaceOrganizationOwned,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'ai-credits-org-funded-banner-chat';
// This key makes the shared cloud mock at 127.0.0.1:4011 return an empty
// personal wallet plus an eligible org credit pool from
// `/api/v1/ai-credits/balance` (see mock-server/routes/cloud.mjs). That is the
// exact state that used to render a green "you're using AI Credits" banner with
// a "0 credits" chip beside it while the session billed fine to the org.
const TEST_CLOUD_API_KEY = 'csk_org_funded_credits_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// The org the mock names as `Acme E2E`. CAN-3463: an org pool covers only work
// that org owns, so the demo workspace is made Acme-owned.
const ORG_FUNDED_ID = '66666666-6666-4666-8666-666666666666';

test('an org-pool-funded session names the covering org instead of showing 0 credits', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ai-credits-org-funded-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  markWorkspaceOrganizationOwned(userDataDir, WORKSPACE_ID, ORG_FUNDED_ID);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'AI Credits Org Funded Banner',
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: Date.parse('2026-04-10T12:00:00.000Z'),
        },
      },
    ],
  });

  // No usage read confirms restored allowance, which would end the seeded
  // session routing before its card shows (CAN-4272).
  const usageKey = 'ai-credits-org-funded-unauthenticated';
  await registerScenario(DEFAULT_MOCK_BASE_URL, usageKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: usageKey },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    // Connect the mock cloud account so the shared billing resolver sees an
    // AI-Credits-capable account and renders the banner at all.
    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate((eventName) => {
      window.dispatchEvent(new Event(eventName));
    }, CLOUD_ACCOUNT_CHANGED_EVENT);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    const routingBanner = window.getByTestId('chat-input-ai-credits-active');
    await expect(routingBanner).toBeVisible({ timeout: 30_000 });

    // The payer is named…
    await expect(
      window.getByTestId('chat-input-ai-credits-covered-by'),
    ).toHaveText('Covered by Acme E2E', { timeout: 30_000 });

    // …and the personal-wallet number is absent entirely, rather than reported
    // as the session's balance.
    await expect(
      window.getByTestId('chat-input-ai-credits-balance'),
    ).toHaveCount(0);
    await expect(routingBanner).not.toContainText(/0 credits/);
  } finally {
    try {
      await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
    }
  }
});
