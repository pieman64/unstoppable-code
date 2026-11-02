import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { revealModelRow } from './model-selection-fixture.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

// Both personal and work access are updated together. Refresh uses the normal
// account-change event used by account/billing recovery, never a renderer store
// patch, relaunch, or page reload. Payment itself is outside this copy test.
test('CAN-5028 personal credit labels follow purchase access without relaunch', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can_5028_free_credits_e2e';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-5028-'));
  const opened = [];
  const browserHandoff = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    opened.push(JSON.parse(body).url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) =>
    browserHandoff.listen(0, '127.0.0.1', resolve),
  );
  const handoffAddress = browserHandoff.address();
  let electronApp;
  const registerAccess = (access) =>
    registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      authUsage: { scenario: 'unauthenticated' },
      cloud: {
        aiCreditsBalance: { credits: 3.2, eligible: true },
        entitlements: {
          freeAccess: true,
          plan: null,
          source: 'none',
          trial: null,
          capabilities: [],
          coveringOrgs: [],
          billingManageableOrg: null,
          modelLibrary: access,
          workModelLibrary: { owner: { kind: 'personal' }, access },
        },
      },
    });
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'codex',
      tabs: [
        {
          id: 'can-5028-chat',
          title: 'Personal credits',
          model: 'gpt-6-luna',
          aiCreditsRouting: {
            active: true,
            scope: 'session',
            activatedAt: Date.now(),
          },
        },
      ],
    });
    await registerAccess('needs_purchase');
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: key,
        CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${handoffAddress.port}/capture`,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-billing-enabled': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await connectMockCloudAccount(window, key);
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');

    const meter = window
      .getByTestId('usage-indicator')
      .filter({ visible: true });
    async function expectBalances(label) {
      await expect(meter).toHaveAccessibleName(`Usage indicator, 3.2 ${label}`);
      await meter.click();
      await expect(
        window.getByRole('region', { name: `${label} balance`, exact: true }),
      ).toBeVisible();
      await expect(
        window.getByTestId('usage-indicator-account-credit-balance'),
      ).toHaveText('3.2');
      await expect(
        window.getByRole('button', { name: 'Manage AI Credits', exact: true }),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await window.getByTestId('sidebar-account-row').click();
      await expect(
        window.getByTestId('sidebar-account-menu-item-ai-credits'),
      ).toHaveAccessibleName(`${label}, 3 available`);
      await expect(
        window.getByTestId('sidebar-account-menu-item-ai-credits-balance'),
      ).toHaveText('3');
      await window.keyboard.press('Escape');
    }
    await expectBalances('Free AI Credits');
    const picker = window
      .getByTestId('chat-model-picker')
      .filter({ visible: true });
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();
    await expect(
      window
        .getByTestId('chat-model-option-available-gpt-6-luna')
        .filter({ visible: true }),
    ).toHaveText('Available');
    await expect(
      window
        .getByTestId('chat-model-row-credits-gpt-6-luna')
        .filter({ visible: true }),
    ).toHaveCount(0);
    const locked = await revealModelRow(window, 'gpt-5.6-terra');
    await expect(locked).not.toContainText('Free AI Credits');
    await locked.click();
    await expect(window.getByTestId('model-recovery-unlock')).toBeVisible();
    await window.getByTestId('model-recovery-unlock-purchase').click();
    await expect.poll(() => opened.length).toBe(1);
    await expect(
      window.getByTestId('model-recovery-unlock-waiting'),
    ).toBeVisible();
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await window.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expectBalances('Free AI Credits');

    await registerAccess('unlocked');
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await expectBalances('AI Credits');
    await picker.click();
    await expect(
      window
        .getByTestId('chat-model-row-credits-gpt-6-luna')
        .filter({ visible: true }),
    ).toHaveText('AI Credits');
    await (await revealModelRow(window, 'gpt-5.6-terra')).click();
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
    await expect(picker).toContainText('GPT 5.6 Terra');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      try {
        await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      } finally {
        await new Promise((resolve) => browserHandoff.close(resolve));
      }
    }
  }
});
