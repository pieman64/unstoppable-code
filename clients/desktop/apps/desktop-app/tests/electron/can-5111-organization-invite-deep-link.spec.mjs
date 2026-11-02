// CAN-5111: the web invite lander's "Open in app" sends
// `<scheme>://settings/organization`. The link carries no invite code; the
// Organizations list finds the invitation by the account's verified emails,
// and Accept there joins the organization as it does from Settings.
//
// Emits macOS-style `open-url` events into main, the same OS delivery path as
// can-2361-deep-link-core.spec.mjs.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerHostedSettingsScenario,
} from './seeders/index.mjs';
import {
  defaultHostedSettingsOrganizations,
  HOSTED_SETTINGS_TIME,
  HOSTED_SETTINGS_VIEWER,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import { hostedPage } from './hostedSettingsLocators.mjs';
import {
  expectWorkspaceContext,
  openWorkspaceContextMenu,
} from './workspaceContextMenu.mjs';

const INVITED = 'a5111000-0000-4000-8000-000000000001';
const INVITED_NAME = 'CAN-5111 Invited';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

function invitation() {
  const organization = defaultHostedSettingsOrganizations()[2];
  return {
    id: 'd5111000-0000-4000-8000-000000000001',
    organization: {
      ...organization,
      id: INVITED,
      name: INVITED_NAME,
      members: organization.members.filter(
        (member) => member.id !== HOSTED_SETTINGS_VIEWER.id,
      ),
    },
    role: 'MEMBER',
    invitedByName: 'Casey',
    createdAt: HOSTED_SETTINGS_TIME,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

test('Organizations deep link opens Settings with the invitation, and Accept joins it', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can5111_open_in_app';
  await registerHostedSettingsScenario(key, 'hosted-settings-signed-in', {
    overrides: { incomingInvitations: [invitation()] },
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
    await expect(window.getByTestId('team-panel')).toHaveCount(0);

    // Malformed variants, including one that tries to carry the invite code,
    // open nothing.
    for (const url of [
      'canopy://settings/organization?code=abc123',
      'canopy://settings/organization/',
      'canopy://settings/organizations',
      'canopy://SETTINGS/organization',
    ]) {
      await emitOpenUrl(electronApp, url);
    }
    await window.waitForTimeout(250);
    await expect(window.getByTestId('team-panel')).toHaveCount(0);

    await emitOpenUrl(electronApp, 'canopy://settings/organization');
    await expect(window.getByTestId('team-panel')).toBeVisible();
    const row = hostedPage(window, 'organizations/list')
      .getByTestId('team-invitation-row')
      .filter({ hasText: INVITED_NAME });
    await expect(row).toBeVisible();

    await row.getByTestId('team-invitation-accept').click();
    await expect(window.getByTestId('team-invitations')).toHaveCount(0);
    await app.closeSettings();
    await openWorkspaceContextMenu(window);
    await expect(
      window.getByTestId(`sidebar-context-option-${INVITED}`),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    // Accepting in Settings switches into the joined organization (CAN-3672).
    await expectWorkspaceContext(window, INVITED);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

// "Open in app" usually launches the app: the link arrives on the command
// line and waits in main's startup buffer for the renderer.
test('Organizations deep link that launches the app opens Settings with the invitation', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can5111_cold_start';
  await registerHostedSettingsScenario(key, 'hosted-settings-signed-in', {
    overrides: { incomingInvitations: [invitation()] },
  });
  const externalOpen = await startExternalOpenCapture();
  const env = {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-shared-org-projects-enabled': true,
      'canopy-desktop-hosted-settings': true,
    }),
    ...externalOpen.env,
  };
  let { electronApp, userDataDir } = await launchCanopy({ env });
  try {
    let window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connectMockCloudAccount(window, key);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });

    ({ electronApp } = await launchCanopy({
      env,
      userDataDir,
      applicationArgs: ['canopy://settings/organization'],
    }));
    window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(window.getByTestId('team-panel')).toBeVisible();
    await expect(
      hostedPage(window, 'organizations/list')
        .getByTestId('team-invitation-row')
        .filter({ hasText: INVITED_NAME }),
    ).toBeVisible();
    // Opened in the app, not bounced to the signed-in web list.
    expect(externalOpen.opened).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    await externalOpen.close();
  }
});
