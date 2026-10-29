import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { defaultHostedSettingsOrganizations } from './mock-server/routes/hosted-settings-fixtures.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_B_WORKSPACE,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
  PERSONAL_CONTEXT_WORKSPACE,
  registerScenario,
  seedOrgContextScoping,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { HOSTED_SETTINGS_ORG_IDS } from './seeders/hostedSettingsCloud.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// CAN-3463: AI Credits spill only onto the pool of the organization that OWNS
// the work. The two-org fixture seeds a Personal project, an Acme (Org A)
// project, and an "Empty organization" (Org B) project. The mock honors the
// `x-canopy-work-owner` header on `/api/v1/ai-credits/balance`: only Acme has a
// funded pool, the personal wallet is empty, and Org B's pool is capable but
// has no headroom. Before this change every chat read "Covered by Acme".

const WORKTREE = 'feature';
const PERSONAL_WORKTREE = `personal-${WORKTREE}`;
const ACME_WORKTREE = `acme-${WORKTREE}`;
const BETA_WORKTREE = `beta-acme-${WORKTREE}`;
const ORG_B_NAME = 'Empty organization';

const ROUTING = {
  active: true,
  scope: 'session',
  activatedAt: Date.parse('2026-09-01T12:00:00.000Z'),
};

function cloudScenario({ ownerOrganizationIds = [] } = {}) {
  return {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS.map((organization) => ({
        ...organization,
        role: ownerOrganizationIds.includes(organization.id)
          ? 'OWNER'
          : organization.role,
      })),
      aiCreditsBalance: { credits: 0, eligible: false },
      aiCreditsOrgPools: { [ORG_CONTEXT_A]: 'Acme' },
      orgSpendableById: {
        [ORG_CONTEXT_A]: 'funded',
        [ORG_CONTEXT_B]: 'empty',
      },
    },
  };
}

/**
 * Hosted Settings for the in-app Billing open: the fixture's owned team
 * becomes Org B, so its page loads and names the organization it belongs to.
 */
function hostedSettingsForOrgB() {
  return {
    organizations: defaultHostedSettingsOrganizations()
      .filter(
        (org) => org.isPersonal || org.id === HOSTED_SETTINGS_ORG_IDS.owner,
      )
      .map((org) =>
        org.isPersonal
          ? org
          : { ...org, id: ORG_CONTEXT_B, name: ORG_B_NAME, projects: [] },
      ),
  };
}

/**
 * @param {string} userDataDir
 * @param {{ providerType: 'codex' | 'claude', model?: string }} chat
 */
function seedFixture(userDataDir, { providerType, model }) {
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [PERSONAL_WORKTREE],
    organizationB: true,
    organizationWorktreeIds: [ACME_WORKTREE],
  });
  for (const [workspaceId, worktreeId, chatId] of [
    [PERSONAL_CONTEXT_WORKSPACE, PERSONAL_WORKTREE, 'personal-credits-chat'],
    [ORG_CONTEXT_WORKSPACE, ACME_WORKTREE, 'acme-credits-chat'],
    [ORG_CONTEXT_B_WORKSPACE, BETA_WORKTREE, 'beta-credits-chat'],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId,
      providerType,
      tabs: [
        {
          id: chatId,
          title: 'AI Credits owner scope',
          ...(model ? { model } : {}),
          ...(providerType === 'codex' ? { aiCreditsRouting: ROUTING } : {}),
        },
      ],
    });
  }
}

async function launch({
  cloudKey,
  authKey,
  providerType,
  model,
  prefix,
  scenario = cloudScenario(),
  flags = {},
}) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, scenario);
  if (authKey) {
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
  }
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedFixture(userDataDir, { providerType, model });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        ...JSON.parse(ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
        ...flags,
      }),
      ...(authKey ? { CANOPY_MOCK_API_KEY: authKey } : {}),
    },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, cloudKey);
  return { electronApp, userDataDir, window, app };
}

async function close(fixture, keys) {
  try {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  } finally {
    for (const key of keys) {
      await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
    }
  }
}

/** The hosted Settings page, account pages in their frame. */
function hostedPage(window, pageKey) {
  return window.locator(
    `[data-testid="hosted-settings-content"][data-hosted-settings-page="${pageKey}"], ` +
      `[data-testid="hosted-settings-frame"][data-hosted-settings-page="${pageKey}"]`,
  );
}

async function mints(cloudKey, path) {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    cloudKey,
  );
  return activity[`authLinkMint:${path}`] ?? 0;
}

/** Org B owns the chat and the viewer is its OWNER; its pool is empty. */
async function clickAutoNoCredits(fixture) {
  const { window } = fixture;
  await openChat(fixture, ORG_CONTEXT_B, BETA_WORKTREE);

  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await picker.click();
  const auto = window.getByTestId('chat-model-option-auto');
  // Auto's remedy is its tooltip once the account's credits have loaded.
  await auto.hover();
  await expect(window.getByRole('tooltip')).toContainText(
    'Add AI Credits to use this',
    { timeout: 30_000 },
  );
  await auto.click();
}

async function openChat(fixture, context, worktreeId) {
  await selectWorkspaceContext(fixture.window, context);
  await fixture.app.openMainPage();
  await fixture.app.selectWorktree(worktreeId);
  await expect(fixture.window.getByTestId('panel-content-chat')).toBeVisible();
}

test('only the chat an org owns reads as covered by that org', async () => {
  test.setTimeout(180_000);
  const cloudKey = 'csk_can3463_owner_scope_banner';
  const fixture = await launch({
    cloudKey,
    providerType: 'codex',
    prefix: 'canopy-can3463-banner-',
  });
  try {
    const { window } = fixture;
    const coveredBy = window.getByTestId('chat-input-ai-credits-covered-by');

    await openChat(fixture, ORG_CONTEXT_A, ACME_WORKTREE);
    await expect(
      window.getByTestId('chat-input-ai-credits-active'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(coveredBy).toHaveText('Covered by Acme', { timeout: 30_000 });

    // Org B owns this chat and its pool is empty: Acme's pool must not be
    // named, even though Acme is funded and the user belongs to both.
    await openChat(fixture, ORG_CONTEXT_B, BETA_WORKTREE);
    await window.waitForTimeout(2_000);
    await expect(coveredBy).toHaveCount(0);

    // Personal work is funded only by the personal wallet.
    await openChat(fixture, 'personal', PERSONAL_WORKTREE);
    await window.waitForTimeout(2_000);
    await expect(coveredBy).toHaveCount(0);
  } finally {
    await close(fixture, [cloudKey]);
  }
});

test('the Auto no-credits action opens the work owner billing page inside Settings', async () => {
  test.setTimeout(180_000);
  const cloudKey = 'csk_can3463_owner_scope_auto_billing';
  const fixture = await launch({
    cloudKey,
    providerType: 'codex',
    prefix: 'canopy-can3463-auto-billing-',
    scenario: {
      ...cloudScenario({ ownerOrganizationIds: [ORG_CONTEXT_B] }),
      hostedSettings: hostedSettingsForOrgB(),
    },
  });
  try {
    const { window } = fixture;
    await clickAutoNoCredits(fixture);

    // CAN-4691: hosted settings are on, so Billing opens inside Settings for
    // the OWNER org (Org B), never Acme, and no auth link is minted.
    const overlay = window.getByTestId('settings-overlay');
    await expect(hostedPage(overlay, 'organization/settings')).toBeVisible({
      timeout: 20_000,
    });
    await expect(overlay).toContainText(ORG_B_NAME);
    expect(
      await mints(
        cloudKey,
        `/organization/${ORG_CONTEXT_B}/settings?tab=billing`,
      ),
    ).toBe(0);
    expect(
      await mints(
        cloudKey,
        `/organization/${ORG_CONTEXT_A}/settings?tab=billing`,
      ),
    ).toBe(0);
  } finally {
    await close(fixture, [cloudKey]);
  }
});

test('the Auto no-credits action hands off to the signed-in web page when hosted settings are off', async () => {
  test.setTimeout(180_000);
  const cloudKey = 'csk_can4691_owner_scope_auto_billing_web';
  const fixture = await launch({
    cloudKey,
    providerType: 'codex',
    prefix: 'canopy-can4691-auto-billing-web-',
    scenario: cloudScenario({ ownerOrganizationIds: [ORG_CONTEXT_B] }),
    flags: { 'canopy-desktop-hosted-settings': false },
  });
  try {
    const { window } = fixture;
    await clickAutoNoCredits(fixture);

    const ownerPath = `/organization/${ORG_CONTEXT_B}/settings?tab=billing`;
    await expect.poll(() => mints(cloudKey, ownerPath)).toBe(1);
    // The overlay stays mounted while closed; it must not have opened.
    await expect(
      window.locator('[data-testid="settings-overlay"][data-open="true"]'),
    ).toHaveCount(0);
  } finally {
    await close(fixture, [cloudKey]);
  }
});

test('the recovery modal names the org that owns the chat', async () => {
  test.setTimeout(180_000);
  const cloudKey = 'csk_can3463_owner_scope_recovery';
  const authKey = 'can-3463-owner-scope-unauthenticated';
  const fixture = await launch({
    cloudKey,
    authKey,
    providerType: 'claude',
    model: 'opus[1m]',
    prefix: 'canopy-can3463-recovery-',
  });
  try {
    const { window } = fixture;
    await openChat(fixture, ORG_CONTEXT_B, BETA_WORKTREE);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toContainText('Opus');
    await picker.click();
    await window.getByTestId('chat-model-option-sonnet').click();

    await expect(window.getByTestId('model-recovery-modal')).toBeVisible();
    await expect(
      window.getByTestId('model-recovery-contact-admin-org'),
    ).toContainText(
      `${ORG_B_NAME}'s AI Credits balance can't cover this model right now.`,
    );
    await expect(window.getByTestId('model-recovery-modal')).not.toContainText(
      'Acme',
    );
    await expect(window.getByTestId('model-recovery-get-credits')).toHaveCount(
      0,
    );
  } finally {
    await close(fixture, [cloudKey, authKey]);
  }
});

test('the Usage card follows the selected context', async () => {
  test.setTimeout(180_000);
  const cloudKey = 'csk_can3463_owner_scope_usage';
  const fixture = await launch({
    cloudKey,
    providerType: 'codex',
    prefix: 'canopy-can3463-usage-',
  });
  try {
    const { window, app } = fixture;
    const balance = window.getByTestId('usage-card-ai-credits-balance');

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openUsagePage();
    await expect(window.getByTestId('usage-card-ai-credits')).toBeVisible({
      timeout: 30_000,
    });
    await expect(balance).toHaveText('Covered by Acme', { timeout: 30_000 });

    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(balance).not.toContainText('Covered by', { timeout: 30_000 });

    await selectWorkspaceContext(window, 'personal');
    await expect(balance).not.toContainText('Covered by', { timeout: 30_000 });
  } finally {
    await close(fixture, [cloudKey]);
  }
});
