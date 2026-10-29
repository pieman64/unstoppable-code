import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { launchCanopy, closeCanopy } from '../launchCanopy.mjs';
import {
  registerScenario,
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
} from '../seeders/index.mjs';

/**
 * A membership elsewhere, so the context switcher that hosts Create a team
 * (CAN-4053) is on screen: it shows only with an organization to switch to.
 */
export const NEIGHBOUR_ORGANIZATION = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Neighbour team',
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export async function openPersonalOrganizationUpgrade({
  key,
  delivery,
  cloud = {},
  seed = seedOrgContextScoping,
  env = {},
} = {}) {
  const credential = key ?? `csk_can3706_${Date.now()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, credential, {
    cloud: {
      personalOrganizationUpgrade: true,
      organizations: [NEIGHBOUR_ORGANIZATION],
      teams: [],
      personalOrganizationId: ORG_CONTEXT_A,
      ...(delivery ? { organizationInvitationDelivery: delivery } : {}),
      ...cloud,
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3706-'));
  await seed(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...ORG_CONTEXT_ENV, ...env },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, credential, {
    expectedAccount: { personalOrganizationId: ORG_CONTEXT_A },
  });
  await window.getByTestId('sidebar-context-row').click();
  await window.getByTestId('account-create-team-row').click();
  await expect(
    window.getByTestId('invite-to-organization-team-name'),
  ).toBeVisible();
  return {
    window,
    key: credential,
    userDataDir,
    close: async () => {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, credential);
    },
  };
}

/**
 * Assert one project's outcome in the finished checklist. Clean moves have no
 * row of their own, so they are read from the projects row.
 */
export async function expectProjectOutcome(
  page,
  workspaceId,
  outcome,
  options,
) {
  if (outcome === 'moved') {
    await expect(
      page.getByTestId('invite-to-organization-projects-step'),
    ).toHaveAttribute(
      'data-moved-projects',
      new RegExp(`(^| )${workspaceId}( |$)`),
      options,
    );
    return;
  }
  await expect(
    page.getByTestId(`invite-to-organization-outcome-${workspaceId}`),
  ).toHaveAttribute('data-outcome', outcome, options);
}

/**
 * Close the finished dialog with its X. Standalone entry points finish with
 * Manage, which leaves the app, so specs that stay close it instead.
 */
export async function closeUpgradeDialog(page) {
  await page
    .getByTestId('invite-to-organization-modal')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
}
