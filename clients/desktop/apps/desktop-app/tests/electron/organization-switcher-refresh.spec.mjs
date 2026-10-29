// CAN-4553: real Settings writes must update membership without a manual probe.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  readHostedSettingsRequests,
  readHostedSettingsState,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';
import {
  defaultHostedSettingsOrganizations,
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_TIME,
  HOSTED_SETTINGS_VIEWER,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import {
  closeWorkspaceContextMenu,
  expectWorkspaceContext,
  expectWorkspaceContextListFirst,
  openWorkspaceContextMenu,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

const OWNER = HOSTED_SETTINGS_ORG_IDS.owner;
const MEMBER = HOSTED_SETTINGS_ORG_IDS.member;
const INVITED = 'a2000000-0000-4000-8000-000000000001';

async function withSettings(tag, overrides, run) {
  const key = `csk_can4553_${tag}`;
  await registerHostedSettingsScenario(key, 'hosted-settings-signed-in', {
    overrides,
  });
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
        'canopy-desktop-hosted-settings': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, key);
    await expectWorkspaceContext(window, 'personal');
    await window.evaluate(() => {
      globalThis.__can4553AccessLost = false;
      new MutationObserver(() => {
        if (
          document.querySelector('[data-testid="hosted-settings-access-lost"]')
        )
          globalThis.__can4553AccessLost = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await run({ key, window, app, electronApp });
    expect(await window.evaluate(() => globalThis.__can4553AccessLost)).toBe(
      false,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
}

async function openOrganizations(app, window) {
  await app.openSettings();
  await window.getByTestId('settings-nav-organizations-list').click();
  await expect(window.getByTestId('team-panel')).toBeVisible();
}

async function createFirst(app, window, key) {
  await openOrganizations(app, window);
  // The header action renders once organizations are listed; the empty state
  // carries its own create button instead.
  await window
    .locator(
      '[data-testid="team-panel-create"], [data-testid="team-panel-create-empty"]',
    )
    .click();
  await window.getByTestId('create-team-name-input').fill('CAN-4553 First');
  await window.getByTestId('create-team-submit').click();
  await expect(window.getByTestId('team-members-section')).toBeVisible();
  await expect(window.getByTestId('add-member-dialog')).toBeVisible();
  // The state endpoint only reads the fixture; it does not refresh the app.
  const state = await readHostedSettingsState(key);
  const created = state.organizations.find(
    (org) => org.name === 'CAN-4553 First',
  );
  expect(created).toBeTruthy();
  await window.keyboard.press('Escape');
  await app.closeSettings();
  return created.id;
}

async function expectOption(window, id, present) {
  await openWorkspaceContextMenu(window);
  await expect(window.getByTestId(`sidebar-context-option-${id}`)).toHaveCount(
    present ? 1 : 0,
    { timeout: 5_000 },
  );
  await window.keyboard.press('Escape');
}

test('first organization appears immediately, keeps the invite prompt and is selected', async () => {
  test.setTimeout(120_000);
  await withSettings(
    'create',
    {
      organizations: [defaultHostedSettingsOrganizations()[0]],
      // A newly created team has no paid subscription to charge for inviting.
      operationErrors: { 'organization.billing.summary': { status: 404 } },
    },
    async ({ app, window, key }) => {
      const id = await createFirst(app, window, key);
      await expectOption(window, id, true);
      // Creating an organization in Settings selects it in the sidebar.
      await expectWorkspaceContext(window, id);
    },
  );
});

for (const [operation, id, selected] of [
  ['delete', OWNER, OWNER],
  ['leave', MEMBER, MEMBER],
  ['leave', MEMBER, OWNER],
  ['delete', OWNER, MEMBER],
]) {
  test(`${operation} after ${id === selected ? 'selecting it' : 'selecting another organization'} falls back to Personal`, async () => {
    // Opening the organization from the Organizations list selects it, so
    // leaving or deleting it always falls back to Personal, whatever was
    // selected before Settings opened.
    test.setTimeout(120_000);
    await withSettings(
      `${operation}_${selected}`,
      {},
      async ({ app, window }) => {
        await selectWorkspaceContext(window, selected);
        await openOrganizations(app, window);
        const name = defaultHostedSettingsOrganizations().find(
          (org) => org.id === id,
        ).name;
        await window
          .getByTestId('team-panel-org')
          .filter({ hasText: name })
          .click();
        await window
          .getByTestId(
            `settings-nav-organization-${operation === 'delete' ? 'settings' : 'members'}`,
          )
          .click();
        await window.getByTestId(`team-${operation}`).click();
        await window
          .getByTestId(
            operation === 'delete'
              ? 'team-delete-confirm'
              : 'confirm-dialog-confirm',
          )
          .click();
        await expect(window.getByTestId('team-panel')).toBeVisible();
        await expect(window.getByTestId('hosted-settings-error')).toHaveCount(
          0,
        );
        await app.closeSettings();
        await expectOption(window, id, false);
        await expectWorkspaceContext(window, 'personal');
      },
    );
  });
}

test('accepting an invitation adds membership, consumes the invitation and selects it', async () => {
  test.setTimeout(120_000);
  const organization = defaultHostedSettingsOrganizations()[2];
  await withSettings(
    'accept',
    {
      incomingInvitations: [
        {
          id: 'd2000000-0000-4000-8000-000000000001',
          organization: {
            ...organization,
            id: INVITED,
            name: 'CAN-4553 Invited',
            members: organization.members.filter(
              (member) => member.id !== HOSTED_SETTINGS_VIEWER.id,
            ),
          },
          role: 'MEMBER',
          invitedByName: 'Casey',
          createdAt: HOSTED_SETTINGS_TIME,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    },
    async ({ app, window }) => {
      await openOrganizations(app, window);
      await window.getByTestId('team-invitation-accept').click();
      await expect(window.getByTestId('team-invitations')).toHaveCount(0);
      await app.closeSettings();
      await expectOption(window, INVITED, true);
      // Accepting an invitation in Settings selects the joined organization.
      await expectWorkspaceContext(window, INVITED);
    },
  );
});

test('failed account refresh preserves one confirmed create and later refresh catches up', async () => {
  test.setTimeout(120_000);
  await withSettings(
    'refresh_failure',
    {
      organizations: [defaultHostedSettingsOrganizations()[0]],
      // A newly created team has no paid subscription to charge for inviting.
      operationErrors: { 'organization.billing.summary': { status: 404 } },
    },
    async ({ app, window, key, electronApp }) => {
      // Fail only the post-write account read in main; the Settings transport
      // still reaches the mock and commits the real mutation exactly once.
      await electronApp.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          if (
            String(url).includes('/api/v1/') &&
            String(url).endsWith('/account')
          ) {
            globalThis.__can4553FailedReads =
              (globalThis.__can4553FailedReads ?? 0) + 1;
            return new Response('{}', { status: 503 });
          }
          return original(url, init);
        };
        globalThis.__can4553RestoreFetch = () => {
          globalThis.fetch = original;
        };
      });
      const id = await createFirst(app, window, key);
      expect(
        await electronApp.evaluate(() => globalThis.__can4553FailedReads),
      ).toBeGreaterThan(0);
      await expectOption(window, id, false);
      const requests = await readHostedSettingsRequests(key);
      expect(
        requests.requests.filter(
          (request) => request.operation === 'organization.create',
        ),
      ).toHaveLength(1);
      await electronApp.evaluate(() => globalThis.__can4553RestoreFetch());
      await window.evaluate(() =>
        window.api.refreshCanopyCloudEnforcedSettings(),
      );
      await expectOption(window, id, true);
      await selectWorkspaceContext(window, id);
    },
  );
});

// CAN-4554: the switcher's Create an organization opens the same create
// dialog over Settings > Organizations, from Personal and from an organization.
async function openCreateFromSwitcher(window) {
  await openWorkspaceContextMenu(window);
  const row = window.getByTestId('sidebar-context-create-organization');
  await expect(row).toHaveAttribute('role', 'menuitem');
  await row.click();
  await expect(window.getByTestId('team-panel')).toBeVisible();
  await expect(window.getByTestId('create-team-dialog')).toBeVisible();
}

test('Create an organization from the switcher lands on Members and lists the organization', async () => {
  test.setTimeout(120_000);
  await withSettings(
    'switcher_create',
    {
      organizations: [defaultHostedSettingsOrganizations()[0]],
      // A newly created team has no paid subscription to charge for inviting.
      operationErrors: { 'organization.billing.summary': { status: 404 } },
    },
    async ({ app, window, key }) => {
      await openCreateFromSwitcher(window);
      await window
        .getByTestId('create-team-name-input')
        .fill('CAN-4554 Switcher');
      await window.getByTestId('create-team-submit').click();
      await expect(window.getByTestId('team-members-section')).toBeVisible();
      await expect(window.getByTestId('add-member-dialog')).toBeVisible();
      const state = await readHostedSettingsState(key);
      const created = state.organizations.find(
        (org) => org.name === 'CAN-4554 Switcher',
      );
      expect(created).toBeTruthy();
      await window.keyboard.press('Escape');
      await app.closeSettings();
      await expectOption(window, created.id, true);
      // CAN-4553's create path selects the new organization once listed.
      await expectWorkspaceContext(window, created.id);
    },
  );
});

test('closing Create an organization leaves the list without reopening the dialog', async () => {
  test.setTimeout(120_000);
  await withSettings('switcher_cancel', {}, async ({ app, window }) => {
    await openCreateFromSwitcher(window);
    // CAN-4558: the dialog has no Cancel button; its X closes it.
    await window
      .getByTestId('create-team-dialog')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(window.getByTestId('create-team-dialog')).toHaveCount(0);
    await expect(window.getByTestId('team-panel')).toBeVisible();
    await app.closeSettings();
    await openOrganizations(app, window);
    await expect(window.getByTestId('create-team-dialog')).toHaveCount(0);
    await app.closeSettings();

    // Inside an organization, the row is there and opens the same dialog.
    await selectWorkspaceContext(window, OWNER);
    await openCreateFromSwitcher(window);
  });
});

test('the switcher lists the contexts and Create an organization before the actions', async () => {
  test.setTimeout(120_000);
  await withSettings('switcher_order', {}, async ({ window }) => {
    await openWorkspaceContextMenu(window);
    await expectWorkspaceContextListFirst(window);
    await closeWorkspaceContextMenu(window);
    await selectWorkspaceContext(window, OWNER);
    await openWorkspaceContextMenu(window);
    await expectWorkspaceContextListFirst(window);
    await closeWorkspaceContextMenu(window);
  });
});
