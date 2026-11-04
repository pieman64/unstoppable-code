// User journey demo companion: demo-private-by-default.demo-spec.ts
// Run with: pnpm run test:electron:demos:built demo-private-by-default.demo-spec.ts --reporter=line
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

// CAN-403 — Settings → Privacy telemetry sharing controls + data disclosure.
//
// Runs on the B0 baseline (no workspace / cloud-account seeding). With no
// linked Canopy Cloud account, only the `off` and `private` scopes are
// offered; `team` / `organization` scopes are gated on a linked account and
// are out of scope here. Off is the default on every plan, so this baseline
// renders stored `off` as Off and every control stays selectable.
//
// Post-link modal gap: the one-time opt-in modal in Settings fires
// on the unlinked→linked Canopy Cloud transition, which requires a seeded
// linked cloud account the harness cannot provision deterministically. That
// surface is covered manually (see plan). This spec exercises the same shared
// `TelemetrySharingIntro` + `TelemetrySharingControls` via the persistent
// Privacy tab and asserts the real on-disk persistence round-trip.

// Canonical least-invasive → most-invasive order, matching the rows the Privacy
// tab renders. `summaries` is a first-class scope, so an assertion that compares
// the whole persisted object must include it.
const DATA_TYPES = ['metadata', 'plans', 'summaries', 'transcripts'];

function expectStoredTelemetrySharing(userDataDir, expectedValue) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const stored = JSON.parse(readFileSync(preferencesPath, 'utf8'));

  expect(stored.preferences?.telemetrySharing).toEqual(
    Object.fromEntries(DATA_TYPES.map((dataType) => [dataType, expectedValue])),
  );
}

test('CAN-403: privacy telemetry sharing defaults to Off, allows private sharing, and persists across relaunch', async ({}, testInfo) => {
  let { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await app.expectSettingsSection('privacy');

    // Disclosure surface renders the data-protection panel.
    await expect(
      window.getByTestId('telemetry-disclosure-protection'),
    ).toBeVisible();

    // CAN-3561: sent messages are counted whatever the scopes below are set
    // to, and the disclosure says so before any sharing control.
    await expect(
      window.getByTestId('telemetry-disclosure-basic-usage'),
    ).toHaveText(/^.+ always counts how many messages you send\.$/);

    // Activity sharing section surfaces the last-sync status line (CAN-402 bridge).
    await expect(
      window.getByTestId('settings-cloud-sync-status'),
    ).toBeVisible();

    // Stored `off` is the default on every plan and shows as selectable Off.
    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).not.toHaveAttribute('aria-disabled', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-private`),
      ).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(window.getByTestId('telemetry-subscribe-cta')).toHaveCount(0);
    await expect(
      window.getByTestId('telemetry-sharing-bulk-off'),
    ).not.toHaveAttribute('aria-disabled', 'true');

    // Persist a single data type as private via its per-type selector.
    await window.getByTestId('telemetry-sharing-transcripts-private').click();
    await expect(
      window.getByTestId('telemetry-sharing-transcripts-private'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByTestId('telemetry-sharing-transcripts-off'),
    ).toHaveAttribute('aria-pressed', 'false');

    // Bulk "All private" persists every data type as private.
    await window.getByTestId('telemetry-sharing-bulk-private').click();
    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-private`),
      ).toHaveAttribute('aria-pressed', 'true');
    }

    // Sharing is now on, but this baseline has no linked cloud account, so
    // nothing can upload. The status line must say so rather than reporting a
    // healthy sync: main defers a credential-less flush WITHOUT recording an
    // upload error, so before the connectivity merge a previously-synced user
    // kept seeing a green "Synced <time> ago · N pending" while the Cloud Sync
    // account card directly above showed disconnected.
    const syncStatus = window.getByTestId('settings-cloud-sync-status');
    await expect(syncStatus).toHaveText(/Sign in to sync/);
    await expect(syncStatus).not.toHaveText(/Synced/);

    await window.screenshot({
      path: testInfo.outputPath('settings-privacy.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  expectStoredTelemetrySharing(userDataDir, 'private');

  // Relaunch against the same userDataDir and confirm the bulk "All private"
  // selection restores from the raw value persisted to disk.
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await app.expectSettingsSection('privacy');

    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-private`),
      ).toHaveAttribute('aria-pressed', 'true');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-4421: with hosted account settings on (the launcher default), the
// Personal catalog choice is the hosted Public profile page's "Personal
// projects on the web" card; without them it stays in Settings → Privacy.
const ORG_PROJECTS_FLAGS = { 'canopy-shared-org-projects-enabled': true };
const CATALOG_PLACEMENTS = [
  {
    name: 'hosted Public profile',
    flags: ORG_PROJECTS_FLAGS,
    open: (app) => app.openAccountSettingsPage('profile'),
  },
  {
    name: 'Privacy without hosted account settings',
    flags: { ...ORG_PROJECTS_FLAGS, 'canopy-desktop-hosted-settings': false },
    open: (app) => app.openSettingsSection('privacy'),
  },
];

for (const placement of CATALOG_PLACEMENTS) {
  test(`CAN-2963: Personal catalog requires opt-in and discloses the exact metadata (${placement.name})`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify(placement.flags),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await placement.open(app);
      const section = window.getByTestId('personal-catalog-settings');
      const toggle = section.getByRole('switch', {
        name: 'Show my Personal projects on the web',
      });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(
        section.getByTestId('personal-catalog-disclosure'),
      ).toContainText(
        'Project ID, scrubbed name, kind, repository layout, local location, repository host, repository owner, repository name, device ID, installation generation, local project ID, and a request to restore the list when you turn sharing on again.',
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect
        .poll(
          () =>
            JSON.parse(
              readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
            ).preferences.personalWorkspaceCatalogSync,
        )
        .toBe('off');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

// The Personal catalog choice is a user-level setting. It lives only in
// Settings (the hosted Public profile page, CAN-4421) as a standard switch
// row, never as a card on Home or in an empty chat, even for a signed-in account.
test('CAN-2963: Personal catalog is a Settings choice, not a Home offer', async () => {
  test.setTimeout(90_000);
  const apiKey = 'csk_can2963_privacy_only';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify(ORG_PROJECTS_FLAGS),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();

    await app.openSettings();
    // Privacy no longer carries it.
    await app.openSettingsSection('privacy');
    await expect(
      window
        .getByTestId('settings-tab-privacy')
        .getByTestId('personal-catalog-settings'),
    ).toHaveCount(0);
    await app.openAccountSettingsPage('profile');
    const section = window
      .getByTestId('account-device-settings-profile')
      .getByTestId('personal-catalog-settings');
    await expect(
      section.getByRole('heading', { name: 'On this computer' }),
    ).toBeVisible();
    await expect(
      section.getByRole('switch', {
        name: 'Show my Personal projects on the web',
      }),
    ).toHaveAttribute('aria-checked', 'false');
    // Its description points at the Public profile card above, not at itself.
    await expect(section).toContainText('Public profile card above');
    // The full payload list stays one click away instead of always open.
    const disclosure = section.getByTestId('personal-catalog-disclosure');
    const disclosureToggle = disclosure.getByTestId(
      'personal-catalog-disclosure-toggle',
    );
    await expect(disclosureToggle).toHaveAttribute('aria-expanded', 'false');
    await disclosureToggle.click();
    await expect(disclosureToggle).toHaveAttribute('aria-expanded', 'true');

    await app.closeSettings();
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
    await expect(window.getByTestId('home-onboarding-suggestions')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('personal-catalog-offer')).toHaveCount(0);
    await expect(
      window.getByText('Show my Personal projects on the web'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Private by default on every plan: a fresh free account (no
// `data_sync_control`) shows every row Off and selectable, uploads nothing, and
// plan changes in either direction never rewrite stored sharing or raise a
// Privacy toast.
const PRIVATE_BY_DEFAULT_KEY = 'csk_private_by_default_e2e';
const PAID_ENTITLEMENTS = {
  plan: { key: 'pro', displayName: 'Pro' },
  source: 'subscription',
  trial: null,
  capabilities: ['data_sync_control'],
  coveringOrgs: [],
  billingManageableOrg: null,
};
// No `cloud.entitlements` → the mock answers 404, which main resolves as a
// definitive free account (no `data_sync_control`). Both scenarios record
// telemetry ingest so the spec can prove nothing was uploaded.
const FREE_SCENARIO = { cloud: { recordTelemetryIngest: true } };
const PAID_SCENARIO = {
  cloud: { recordTelemetryIngest: true, entitlements: PAID_ENTITLEMENTS },
};

function readStoredPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

async function reprobeEntitlements(window) {
  // The same account-changed signal a window focus or return-from-billing
  // fires; the Privacy tab and subscription status both re-read entitlements.
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });
}

async function entitlementsReadCount(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return activity.entitlementsRead ?? 0;
}

/** Re-read entitlements and wait until the mock has served the new answer. */
async function reprobeEntitlementsAndSettle(window, key) {
  const before = await entitlementsReadCount(key);
  await reprobeEntitlements(window);
  await expect
    .poll(() => entitlementsReadCount(key), { timeout: 15_000 })
    .toBeGreaterThan(before);
}

async function telemetryIngestCount(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return Object.entries(activity)
    .filter(([name]) => name.startsWith('telemetryIngest'))
    .reduce((total, [, count]) => total + count, 0);
}

test('private by default: a free account starts Off and plan changes never rewrite sharing', async () => {
  test.setTimeout(120_000);
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    PRIVATE_BY_DEFAULT_KEY,
    FREE_SCENARIO,
  );
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, PRIVATE_BY_DEFAULT_KEY);

    // 1. A fresh free account: every row Off, all selectable, no Upgrade prompt.
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await app.expectSettingsSection('privacy');
    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).not.toHaveAttribute('aria-disabled', 'true');
    }
    await expect(window.getByTestId('telemetry-subscribe-cta')).toHaveCount(0);
    expect(await telemetryIngestCount(PRIVATE_BY_DEFAULT_KEY)).toBe(0);

    // 2. A deliberate Just me choice for work stats persists.
    await window.getByTestId('telemetry-sharing-metadata-private').click();
    await expect(
      window.getByTestId('telemetry-sharing-metadata-private'),
    ).toHaveAttribute('aria-pressed', 'true');
    const chosen = {
      metadata: 'private',
      plans: 'off',
      summaries: 'off',
      transcripts: 'off',
    };
    await expect
      .poll(() => readStoredPreferences(userDataDir).telemetrySharing)
      .toEqual(chosen);

    // 3. Upgrading to a paid plan and lapsing back leave every stored choice
    //    alone, write no tier marker, and raise no Privacy toast.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      PRIVATE_BY_DEFAULT_KEY,
      PAID_SCENARIO,
    );
    await reprobeEntitlementsAndSettle(window, PRIVATE_BY_DEFAULT_KEY);
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      PRIVATE_BY_DEFAULT_KEY,
      FREE_SCENARIO,
    );
    await reprobeEntitlementsAndSettle(window, PRIVATE_BY_DEFAULT_KEY);
    await expect(
      window.getByTestId('telemetry-sharing-metadata-private'),
    ).toHaveAttribute('aria-pressed', 'true');
    const stored = readStoredPreferences(userDataDir);
    expect(stored.telemetrySharing).toEqual(chosen);
    expect(stored).not.toHaveProperty('telemetrySharingTier');
    // Scoped to toast cards: the Cloud sync status line may legitimately read
    // "Privacy enabled" when every row is Off.
    const toasts = window.getByTestId('toast-card');
    await expect(toasts.filter({ hasText: 'Your plan ended' })).toHaveCount(0);
    await expect(toasts.filter({ hasText: 'Privacy enabled' })).toHaveCount(0);
    for (const dataType of ['plans', 'summaries', 'transcripts']) {
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-off`),
      ).not.toHaveAttribute('aria-disabled', 'true');
    }
    await expect(window.getByTestId('telemetry-subscribe-cta')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3459: an organization's data-sharing rules apply only to that
// organization's work. Settings shows the SELECTED organization's locks and
// nothing in Personal, and the locks are display only: they are never written
// into the saved preference.
const LOCKED_ORG_KEY = 'csk_telemetry_all_locked_e2e';
// Mirrors `TELEMETRY_ALL_LOCKED_ORG_ID` in `mock-server/routes/cloud.mjs`.
const LOCKED_ORG_ID = 'e2e1a0c4-7d3b-4c2a-9f10-0000000c3459';
const LOCKED_ORG_NAME = 'Locked Org E2E';

test('CAN-3459: privacy locks follow the selected organization and are never saved', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
      }),
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // Skip the one-time opt-in: this spec is about the persistent tab.
    await window.evaluate(async () => {
      await window.api.savePreferences({ telemetrySharingPromptSeen: true });
    });
    await connectMockCloudAccount(window, LOCKED_ORG_KEY);

    // 1. Personal: the org requires every scope, but no org governs Personal
    //    work, so nothing is locked and Organization explains when it applies.
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await app.expectSettingsSection('privacy');
    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-row-${dataType}`),
      ).not.toHaveAttribute('data-locked', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-organization`),
      ).toBeEnabled();
    }
    await expect(
      window.getByTestId('telemetry-sharing-bulk-private'),
    ).toBeVisible();
    await window.getByTestId('telemetry-sharing-plans-organization').hover();
    await expect(
      window.locator('[role="tooltip"]', {
        hasText:
          'Applies when you work in an organization. Personal work stays private.',
      }),
    ).toBeVisible({ timeout: 10_000 });
    await app.closeSettings();

    // 2. Select the organization: its policy locks every row at Organization
    //    and the tooltip names it.
    await selectWorkspaceContext(window, LOCKED_ORG_ID);
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await app.expectSettingsSection('privacy');
    for (const dataType of DATA_TYPES) {
      await expect(
        window.getByTestId(`telemetry-sharing-row-${dataType}`),
      ).toHaveAttribute('data-locked', 'true');
      await expect(
        window.getByTestId(`telemetry-sharing-${dataType}-organization`),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(
      window.getByTestId('telemetry-sharing-bulk-private'),
    ).toHaveCount(0);
    await window.getByTestId('telemetry-sharing-plans-organization').hover();
    const lockTooltip = window.locator('[role="tooltip"]', {
      hasText: `Managed by ${LOCKED_ORG_NAME}. Contact an admin to change.`,
    });
    await expect(lockTooltip).toBeVisible({ timeout: 10_000 });
    await expect(lockTooltip).toContainText(
      `Uploaded and visible to everyone in ${LOCKED_ORG_NAME}.`,
    );

    // 3. The lock is display only: the saved preference still holds the
    //    member's own choice, with no scope pinned to Organization.
    const stored = readStoredPreferences(userDataDir).telemetrySharing;
    for (const dataType of DATA_TYPES) {
      expect(stored?.[dataType]).not.toBe('organization');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3383: exercise the real preference writer and then simulate its explicit
// saved-but-unapplied result. A persisted refresh must retain recovery controls.
const OPT_IN_MEMORY_ORG = '33333333-3333-4333-8333-333333333333';
async function prepareFeatureSharing(window) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'csk_memory_owner_e2e', {
    cloud: { enforcedSettings: [] },
  });
  await window.evaluate(async () => {
    await window.api.savePreferences({
      telemetrySharingPromptSeen: true,
      telemetrySharing: {
        metadata: 'private',
        plans: 'private',
        summaries: 'private',
        transcripts: 'private',
      },
    });
  });
  await connectMockCloudAccount(window, 'csk_memory_owner_e2e');
}

test('CAN-3383: memory sharing keeps committed application failures retryable', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await prepareFeatureSharing(window);
    await app.openSettings();
    await app.openSettingsSection('memory');
    const hint = window.getByTestId('data-sharing-opt-in-organization-memory');
    await expect(hint).toBeVisible();
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'telemetry-sharing:enable-for-feature';
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function')
        throw new Error('Missing opt-in handler');
      let calls = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const result = await original(event, request);
        calls += 1;
        return calls === 1 && result.status === 'saved'
          ? { ...result, status: 'saved-application-failed' }
          : result;
      });
    });
    await window
      .getByTestId('data-sharing-opt-in-organization-memory-enable')
      .click();
    await expect
      .poll(() => readStoredPreferences(userDataDir).telemetrySharing)
      .toEqual({
        metadata: 'organization',
        plans: 'private',
        summaries: 'private',
        transcripts: 'organization',
      });
    await expect(hint).toContainText(
      "Sharing settings saved, but couldn't apply them yet.",
    );
    await window
      .getByTestId('data-sharing-opt-in-organization-memory-enable')
      .click();
    await expect(hint).toHaveAttribute('data-opt-in-state', 'enabled');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3383: a passive memory dismissal survives relaunch', async () => {
  test.setTimeout(120_000);
  let { electronApp, userDataDir } = await launchCanopy();
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await prepareFeatureSharing(window);
    await app.openSettings();
    await app.openSettingsSection('memory');
    await window
      .getByTestId('data-sharing-opt-in-organization-memory-dismiss')
      .click();
    await expect
      .poll(
        () =>
          readStoredPreferences(userDataDir).dataSharingOptInHints?.[
            'organization-memory'
          ]?.dismissedAt,
      )
      .toBeTruthy();
    await expect(
      window.getByTestId('data-sharing-opt-in-organization-memory'),
    ).toHaveCount(0);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('memory');
    await expect(window.getByTestId('org-memory-enabled-toggle')).toBeVisible();
    await expect(
      window.getByTestId('data-sharing-opt-in-organization-memory'),
    ).toHaveCount(0);
    await electronApp.evaluate(
      ({ app }, org) =>
        app.emit(
          'open-url',
          { preventDefault() {} },
          `canopy://settings/privacy?feature=organization-memory&org=${org}`,
        ),
      OPT_IN_MEMORY_ORG,
    );
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-share'),
    ).toBeVisible();
    await window.getByTestId('data-sharing-opt-in-sheet-cancel').click();
    expect(readStoredPreferences(userDataDir).telemetrySharing.metadata).toBe(
      'private',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
