import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  markWorkspaceOrganizationOwned,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'org-lapsed-chat';
const AUTH_KEY = 'org-lapsed-unauthenticated';
const LAPSED_CLOUD_API_KEY = 'csk_org_lapsed_e2e';
const RESTORED_CLOUD_API_KEY = 'csk_org_restored_e2e';
const OTHER_LAPSED_CLOUD_API_KEY = 'csk_org_lapsed_other_e2e';
const LAPSED_ORG_NAME = 'Acme E2E';
const HEALTHY_ORG_NAME = 'Globex E2E';
// CAN-3463: only the org that owns the chat can pay for it, so only its lapse
// is named. The chat's workspace is owned by the lapsing org (Acme E2E).
const LAPSED_ORG_ID = '44444444-4444-4444-8444-444444444444';

function readCloudAccountChangedEventName() {
  const source = readFileSync(
    path.resolve('packages/desktop-shared/src/constants/canopy-cloud.ts'),
    'utf8',
  );
  const match = source.match(
    /CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT\s*=\s*'([^']+)'/,
  );
  if (!match) {
    throw new Error(
      'Could not resolve CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT from the shared constant',
    );
  }
  return match[1];
}

const CLOUD_ACCOUNT_CHANGED_EVENT = readCloudAccountChangedEventName();

function seedOrgLapsedChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  markWorkspaceOrganizationOwned(userDataDir, WORKSPACE_ID, LAPSED_ORG_ID);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Organization billing state',
        model: 'opus[1m]',
      },
    ],
  });
}

async function connectCloudKey(window, apiKey) {
  const saveResult = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(
    saveResult.status,
    saveResult.status.error ?? `Mock account ${apiKey} did not connect`,
  ).toMatchObject({ authenticated: true });
}

async function dispatchCloudAccountChanged(window) {
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
}

async function launchOrgLapsedFixture(initialCloudKey) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'org-lapsed-e2e-'));
  seedOrgLapsedChat(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const launched = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: AUTH_KEY },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectCloudKey(window, initialCloudKey);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    return { ...launched, app, window };
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir).catch(() => undefined);
    await clearScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY).catch(() => undefined);
    throw error;
  }
}

async function closeOrgLapsedFixture(launched) {
  try {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY).catch(() => undefined);
  }
}

test('names only the lapsed organization and lets the user dismiss the notice', async () => {
  test.setTimeout(180_000);
  const launched = await launchOrgLapsedFixture(LAPSED_CLOUD_API_KEY);
  try {
    const banner = launched.window.getByTestId('chat-input-org-lapsed-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(`${LAPSED_ORG_NAME} has no active plan`);
    await expect(banner).toContainText(
      'contact your org admin to restore your team.',
    );
    await expect(banner).not.toContainText(HEALTHY_ORG_NAME);

    await launched.window.getByTestId('chat-input-org-lapsed-dismiss').click();
    await expect(banner).toHaveCount(0);
  } finally {
    await closeOrgLapsedFixture(launched);
  }
});

test('tracks healthy, lapsed, dismissed, and restored organizations without remounting', async () => {
  test.setTimeout(240_000);
  const launched = await launchOrgLapsedFixture(RESTORED_CLOUD_API_KEY);
  try {
    const { window } = launched;
    const panel = window.getByTestId('panel-content-chat');
    const banner = window.getByTestId('chat-input-org-lapsed-banner');
    await window.waitForTimeout(1_500);
    await expect(banner).toHaveCount(0);

    await connectCloudKey(window, LAPSED_CLOUD_API_KEY);
    await window.waitForTimeout(2_000);
    await expect(banner).toHaveCount(0);

    await dispatchCloudAccountChanged(window);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(`${LAPSED_ORG_NAME} has no active plan`);
    await expect(banner).not.toContainText(HEALTHY_ORG_NAME);

    await window.getByTestId('chat-input-org-lapsed-dismiss').click();
    await expect(banner).toHaveCount(0);

    // Globex lapses, but Globex does not own this chat: its pool could never
    // pay for it, so nothing is announced (CAN-3463).
    await connectCloudKey(window, OTHER_LAPSED_CLOUD_API_KEY);
    await dispatchCloudAccountChanged(window);
    await window.waitForTimeout(2_000);
    await expect(banner).toHaveCount(0);

    await connectCloudKey(window, RESTORED_CLOUD_API_KEY);
    await dispatchCloudAccountChanged(window);
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(panel).toBeVisible();
  } finally {
    await closeOrgLapsedFixture(launched);
  }
});
