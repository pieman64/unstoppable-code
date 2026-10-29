import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
} from './seeders/index.mjs';

// CAN-3926 — guest prompts under free app access.
//
// Guests still exist in free mode, but there is no trial to start: signing in
// is the whole step. The server reports free access on the guest's own
// `GET /api/v1/entitlements` read, which reaches the share dialog and the
// Remote Control modal through `useSubscriptionStatus().freeAccess`. This spec
// proves both prompts drop the trial framing while free access is on, and
// that the same guest keeps the trial copy once the server stops reporting it.
//
// The mock's guest mint always returns this key, so the free-access
// entitlements are registered against it. Electron specs run serially, and
// the scenario is cleared in `finally`.
const GUEST_API_KEY = 'csk_guest_e2e';
const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

// What the server returns for any account while free access is on: every
// capability, no plan, no trial.
const FREE_ACCESS_ENTITLEMENTS = {
  freeAccess: true,
  plan: null,
  source: 'none',
  trial: null,
  capabilities: ['data_sync_control', 'remote_control', 'teams'],
  coveringOrgs: [],
  billingManageableOrg: null,
};

const AUTOMATION_ID = 'free-access-guest-share';

function shareableAutomation() {
  return {
    version: 1,
    id: AUTOMATION_ID,
    name: 'Nightly review',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    targetRequirement: { contexts: ['worktree'] },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'free-access-workspace',
      pipelineId: 'local-code-review',
      pipelineSource: 'user',
      pipelineName: 'Code Review',
    },
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    failureCount: 0,
  };
}

async function openAutomationShare(window, app) {
  await app.openAutomationsPage();
  await app.chooseWorkflowsLibraryRowAction(
    app.workflowsLibraryAutomationRow(AUTOMATION_ID),
    'share',
  );
  const modal = window.getByTestId('share-automation-modal');
  await expect(modal).toBeVisible({ timeout: 20_000 });
  return modal;
}

test.describe('Free access guest prompts', () => {
  test('asks a guest to sign in instead of starting a trial', async () => {
    test.setTimeout(150_000);

    await registerScenario(DEFAULT_MOCK_BASE_URL, GUEST_API_KEY, {
      cloud: { entitlements: FREE_ACCESS_ENTITLEMENTS },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-free-access-guest-'),
    );
    seedAutomations({ userDataDir, activities: [shareableAutomation()] });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const guest = await window.evaluate(
        async (consent) => window.api.startCanopyGuestSession(consent),
        GUEST_CONSENT,
      );
      expect(guest.credentialSource).toBe('guest');
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });

      await test.step('share dialog says Sign in to share', async () => {
        const modal = await openAutomationShare(window, app);
        const cta = modal.getByTestId('share-automation-guest-cta');
        await expect(cta).toBeVisible({ timeout: 20_000 });
        await expect(cta).toContainText('Create a free account');
        const button = modal.getByTestId('share-automation-guest-cta-button');
        await expect(button).toHaveText('Sign in', { timeout: 20_000 });
        await expect(cta).not.toContainText('trial');

        await button.click();
        const gate = window.getByTestId('cloud-sync-modal');
        await expect(gate).toBeVisible({ timeout: 20_000 });
        await expect(gate).toContainText('Sign in to share');
        await expect(gate).not.toContainText('free trial');
        await window.keyboard.press('Escape');
        await expect(gate).toHaveCount(0);
        await window.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
      });

      await test.step('Remote Control asks the guest to sign in', async () => {
        await app.openCanopyPortal();
        const cta = window.getByTestId('canopy-portal-guest-cta');
        await expect(cta).toBeVisible({ timeout: 20_000 });
        await expect(
          window.getByTestId('canopy-portal-guest-cta-button'),
        ).toHaveText('Sign in', { timeout: 20_000 });
        await expect(
          window.getByTestId('canopy-portal-modal'),
        ).not.toContainText('free trial');
        await expect(
          window.getByTestId('canopy-portal-upgrade-cta'),
        ).toHaveCount(0);
      });

      await test.step('without free access the guest keeps the trial copy', async () => {
        // The open modal re-reads entitlements on the account-changed event,
        // so the same guest flips back to tier copy without a relaunch.
        await clearScenario(DEFAULT_MOCK_BASE_URL, GUEST_API_KEY);
        await window.evaluate((eventName) => {
          window.dispatchEvent(new Event(eventName));
        }, CLOUD_ACCOUNT_CHANGED_EVENT);
        await expect(
          window.getByTestId('canopy-portal-guest-cta-button'),
        ).toHaveText('Start free trial', { timeout: 20_000 });
      });
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, GUEST_API_KEY).catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
