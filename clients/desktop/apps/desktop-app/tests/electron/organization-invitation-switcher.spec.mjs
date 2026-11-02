// CAN-3672: real shared switcher -> hosted settings -> membership/Projects.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openOrganizationsList } from './hostedSettingsLocators.mjs';
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
  HOSTED_SETTINGS_VIEWER,
  HOSTED_SETTINGS_TIME,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import {
  expectWorkspaceContextListFirst,
  openWorkspaceContextMenu,
} from './workspaceContextMenu.mjs';

const ORG = 'a3672000-0000-4000-8000-000000000001';
const INVITE = 'd3672000-0000-4000-8000-000000000001';
const NAME = 'CAN-3672 Invitation with a deliberately long organization name';

async function withInvitation(
  tag,
  { error, enforced = false, hosted = true, signedIn = true } = {},
  run,
) {
  const key = `csk_can3672_${tag}`;
  const organization = defaultHostedSettingsOrganizations()[2];
  await registerHostedSettingsScenario(key, 'hosted-settings-signed-in', {
    overrides: {
      incomingInvitations: [
        {
          id: INVITE,
          organization: {
            ...organization,
            id: ORG,
            name: NAME,
            members: organization.members.filter(
              (member) => member.id !== HOSTED_SETTINGS_VIEWER.id,
            ),
            config: {
              ...organization.config,
              ...(enforced
                ? {
                    enforceMemberDataSharing: true,
                    enforcedSync: {
                      ...organization.config.enforcedSync,
                      transcripts: false,
                    },
                  }
                : {}),
            },
          },
          enforcedSettings: enforced
            ? [{ organizationId: ORG, organizationName: NAME, policies: [] }]
            : [],
          role: 'MEMBER',
          invitedByName: 'Casey',
          createdAt: HOSTED_SETTINGS_TIME,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
      ...(error
        ? { operationErrors: { 'organization.invitations.respond': error } }
        : {}),
    },
  });
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
        'canopy-desktop-hosted-settings': hosted,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    if (signedIn) await connectMockCloudAccount(window, key);
    await run({ window, app, key });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
}

test.beforeEach(() => test.setTimeout(120_000));

test('Settings acceptance clears the switcher invitation without a reload', async () => {
  await withInvitation('settings_accept', {}, async ({ window, app }) => {
    await expect(window.getByTestId('sidebar-context-row')).toHaveAttribute(
      'aria-label',
      /1 pending invitation$/,
    );
    await app.openSettings();
    await openOrganizationsList(window);
    await window.getByTestId('team-invitation-accept').click();
    await expect(window.getByTestId('team-invitations')).toHaveCount(0);
    await app.closeSettings();
    await expect(
      window.getByTestId('sidebar-context-attention-dot'),
    ).toHaveCount(0);
    await openWorkspaceContextMenu(window);
    await expect(
      window.getByTestId(`sidebar-context-invitation-${INVITE}`),
    ).toHaveCount(0);
  });
});

test('an external decline clears on same-account refresh without changed memberships', async () => {
  await withInvitation('external_decline', {}, async ({ window, key }) => {
    await expect(window.getByTestId('sidebar-context-row')).toHaveAttribute(
      'aria-label',
      /1 pending invitation$/,
    );
    const before = (
      await window.evaluate(() => window.api.workspaceContext.get())
    ).organizations;
    const result = await window.evaluate(async (inviteId) => {
      const account = await window.api.loadCanopyCloudAccount();
      return window.api.accountOrganizationSettings.write({
        accountId: account.account.id,
        operation: 'organization.invitations.respond',
        input: { inviteId, action: 'decline' },
      });
    }, INVITE);
    expect(result.ok).toBe(true);
    expect(
      (await readHostedSettingsState(key)).incomingInvitations,
    ).toHaveLength(0);
    await window.evaluate(async () => {
      await window.api.refreshCanopyCloudEnforcedSettings();
      window.dispatchEvent(
        new CustomEvent('canopy:cloud-account-changed', {
          detail: { reason: 'same-account-refresh' },
        }),
      );
    });
    await expect(
      window.getByTestId('sidebar-context-attention-dot'),
    ).toHaveCount(0);
    expect(
      (await window.evaluate(() => window.api.workspaceContext.get()))
        .organizations,
    ).toEqual(before);
  });
});

test('cue, role, group placement and keyboard accept select the external id and open Projects once', async () => {
  await withInvitation('accept', {}, async ({ window, key }) => {
    const trigger = window.getByTestId('sidebar-context-row');
    await expect(trigger).toHaveAttribute(
      'aria-label',
      /1 pending invitation$/,
    );
    await openWorkspaceContextMenu(window);
    await expectWorkspaceContextListFirst(window);
    await expect(
      window.getByTestId(`sidebar-context-invitation-${INVITE}`),
    ).toContainText('Member');
    await window
      .getByTestId(`sidebar-context-invitation-accept-${INVITE}`)
      .focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('team-projects-section')).toBeVisible();
    await expect(window.getByTestId('hosted-settings-access-lost')).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await window.api.workspaceContext.get()).context,
        ),
      )
      .toEqual({ kind: 'organization', organizationId: ORG });
    await expect(
      window.getByTestId('sidebar-context-attention-dot'),
    ).toHaveCount(0);
    const { requests } = await readHostedSettingsRequests(key);
    expect(
      requests.filter(
        (request) => request.operation === 'organization.invitations.respond',
      ),
    ).toHaveLength(1);
    const state = await readHostedSettingsState(key);
    expect(state.incomingInvitations).toHaveLength(0);
    expect(state.organizations.filter((org) => org.id === ORG)).toHaveLength(1);
  });
});

test('decline cancel restores focus; confirmed decline consumes without membership or context change', async () => {
  await withInvitation('decline', {}, async ({ window, key }) => {
    await openWorkspaceContextMenu(window);
    await window
      .getByTestId(`sidebar-context-invitation-decline-${INVITE}`)
      .click();
    await window
      .getByTestId('sidebar-context-decline-invitation-cancel')
      .click();
    await expect(window.getByTestId('sidebar-context-row')).toBeFocused();
    expect(
      (await readHostedSettingsRequests(key)).requests.filter(
        (r) => r.operation === 'organization.invitations.respond',
      ),
    ).toHaveLength(0);
    await openWorkspaceContextMenu(window);
    await window
      .getByTestId(`sidebar-context-invitation-decline-${INVITE}`)
      .click();
    await window
      .getByTestId('sidebar-context-decline-invitation-confirm')
      .click();
    await expect(
      window.getByTestId('sidebar-context-decline-invitation'),
    ).toHaveCount(0);
    await expect(window.getByTestId('sidebar-context-row')).toBeFocused();
    await expect(
      window.getByTestId('sidebar-context-attention-dot'),
    ).toHaveCount(0);
    const state = await readHostedSettingsState(key);
    expect(state.incomingInvitations).toHaveLength(0);
    expect(state.organizations.some((org) => org.id === ORG)).toBe(false);
    expect(
      (await window.evaluate(() => window.api.workspaceContext.get())).context,
    ).toEqual({ kind: 'personal' });
  });
});

test('enforced invitation reviews consent without sending a response', async () => {
  await withInvitation(
    'consent',
    { enforced: true },
    async ({ window, key }) => {
      await openWorkspaceContextMenu(window);
      await window
        .getByTestId(`sidebar-context-invitation-review-${INVITE}`)
        .click();
      await expect(window.getByTestId('team-panel')).toBeVisible();
      await expect(window.getByTestId('team-invitation-accept')).toBeVisible();
      expect(
        (await readHostedSettingsRequests(key)).requests.filter(
          (r) => r.operation === 'organization.invitations.respond',
        ),
      ).toHaveLength(0);
    },
  );
});

for (const status of [404, 500]) {
  test(`${status} response stays actionable and never navigates`, async () => {
    await withInvitation(
      `error_${status}`,
      { error: { status } },
      async ({ window, key }) => {
        await openWorkspaceContextMenu(window);
        await window
          .getByTestId(`sidebar-context-invitation-accept-${INVITE}`)
          .click();
        await expect(
          window.getByTestId('sidebar-context-invitations-error'),
        ).toBeVisible();
        await expect(window.getByTestId('team-projects-section')).toHaveCount(
          0,
        );
        expect(
          (await readHostedSettingsRequests(key)).requests.filter(
            (r) => r.operation === 'organization.invitations.respond',
          ),
        ).toHaveLength(1);
        if (status === 404)
          await expect(
            window.getByTestId(`sidebar-context-invitation-${INVITE}`),
          ).toHaveCount(0);
        else
          await expect(
            window.getByTestId(`sidebar-context-invitation-accept-${INVITE}`),
          ).toBeEnabled();
      },
    );
  });
}

for (const options of [{ hosted: false }, { signedIn: false }]) {
  test(`unavailable invitation access makes no reads: ${JSON.stringify(options)}`, async () => {
    await withInvitation(
      options.hosted === false ? 'disabled' : 'signedout',
      options,
      async ({ window, key }) => {
        await expect(
          window.getByTestId('sidebar-context-invitations'),
        ).toHaveCount(0);
        expect(
          (await readHostedSettingsRequests(key)).requests.filter(
            (r) => r.operation === 'organization.invitations.incoming',
          ),
        ).toHaveLength(0);
      },
    );
  });
}
