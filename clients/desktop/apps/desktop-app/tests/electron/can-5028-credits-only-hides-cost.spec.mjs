// CAN-5028: an account that bills every turn to AI Credits (no Claude or
// Codex sign-in, credits eligible) sees no USD in the composer popover or the
// Activity rail. The cost fixture is seeded so there is a real figure to hide;
// `cost-usage-popover` and `cost-entry-points` are the signed-in controls.

import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedCostInsights,
} from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

/** Routes the seeded chat to AI Credits, as a credits-only account's chat is. */
function routeChatToAiCredits(userDataDir, chatId) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'chats',
    `${WORKTREE_ID}.json`,
  );
  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  writeJson(filePath, {
    ...file,
    tabs: file.tabs.map((tab) =>
      tab.id === chatId
        ? {
            ...tab,
            aiCreditsRouting: {
              active: true,
              scope: 'session',
              activatedAt: Date.now(),
            },
          }
        : tab,
    ),
  });
}

async function launchCreditsOnly({ key, mode }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-5028-cost-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const cost = seedCostInsights({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    earlyAccess: true,
  });
  routeChatToAiCredits(userDataDir, cost.ids.twoModelChat);
  if (mode !== null) {
    const worktreeDataDir = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktree-data',
      WORKTREE_ID,
    );
    mkdirSync(worktreeDataDir, { recursive: true });
    writeJson(path.join(worktreeDataDir, 'panel-layout-mode.json'), {
      version: 1,
      mode,
    });
  }
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    authUsage: { scenario: 'unauthenticated' },
    cloud: {
      aiCreditsBalance: { credits: 3.2, eligible: true },
      // Signed in, Labs choices are the account's; keep the seeded Early
      // access so the Activity card shows as it does for the local account.
      experiments: { choices: { 'early-access': true } },
    },
  });
  const launched = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_MOCK_API_KEY: key,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-billing-enabled': true,
      }),
    },
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, key);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const chat = window
    .getByTestId('panel-content-chat')
    .filter({ visible: true })
    .first();
  await expect(chat).toBeVisible();
  const meter = chat.getByTestId('usage-indicator');
  // The balance on the meter shows the credits read has settled and the chat
  // bills to AI Credits, so an absent Cost below is not unsettled facts.
  await expect(meter).toHaveAccessibleName(/AI Credits/, { timeout: 30_000 });
  return { launched, userDataDir, window, meter, cost };
}

async function close({ launched, userDataDir }, key) {
  try {
    await closeCanopy(launched.electronApp, userDataDir);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
}

test('a credits-only account sees no Cost in the composer popover or the Activity rail section', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can_5028_credits_only_stack_e2e';
  const run = await launchCreditsOnly({ key, mode: null });
  try {
    const { window, meter } = run;
    // The rail is rendered: its Summary section is up, its Cost section is not.
    await expect(
      window
        .getByTestId('panel-content-activity-section')
        .getByTestId('activity-summary-section'),
    ).toBeVisible();
    await expect(window.getByTestId('activity-section-cost')).toHaveCount(0);

    await meter.click();
    const popover = window.getByTestId('usage-indicator-popover');
    await expect(popover).toBeVisible();
    await expect(
      window.getByTestId('usage-indicator-account-credit-balance'),
    ).toHaveText('3.2');
    await expect(popover.getByTestId('usage-indicator-cost')).toHaveCount(0);
    await expect(
      popover.getByTestId('usage-indicator-see-details'),
    ).toHaveCount(0);
    await expect(popover).not.toContainText('$');
  } finally {
    await close(run, key);
  }
});

test('a credits-only account sees no Cost row on the Activity card', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can_5028_credits_only_card_e2e';
  const run = await launchCreditsOnly({ key, mode: 'minimal' });
  try {
    const { window, cost } = run;
    const toggle = window.getByTestId('worktree-activity-card-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const card = window.getByTestId('activity-card');
    await expect(card).toBeVisible();
    // The card shows its Cost row only once a cost read lands, so first let
    // one land: the Cost panel stays reachable from the command palette.
    await window.keyboard.press(PALETTE_SHORTCUT);
    await window.getByTestId('command-palette-input').fill('Open Cost panel');
    await window.getByRole('option', { name: 'Open Cost panel' }).click();
    await expect(window.getByTestId('cost-scope-view')).toContainText(
      cost.expected.scopeTotal,
    );
    await expect(card).toBeVisible();
    await expect(
      card.locator('[data-testid^="activity-card-row-"]').first(),
    ).toBeVisible();
    await expect(card.getByTestId('activity-card-row-cost')).toHaveCount(0);
  } finally {
    await close(run, key);
  }
});
