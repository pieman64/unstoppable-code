/**
 * Durable UI coverage for the share-propagation fix.
 *
 * The bug: a recipient's "Shared with me" section was only ever re-listed on an
 * organization fingerprint change, a replica purge, a failed dismiss, a
 * transient-HTTP backoff rung, or a manual Retry. For a signed-in user in a
 * stable organization none of those fire, so an invitation that arrived while
 * the app was running stayed invisible until restart.
 *
 * This spec reproduces that at the UI level: the authoritative listing gains a
 * share mid-session and NOTHING in the app is told — no `ipcMain` poke, no
 * broadcast, no user gesture, which is precisely the point. The row and the
 * header's pending count must appear on their own.
 *
 * CAN-4783: the recipient works in Personal, where an organization's
 * invitations are never listed. The context switcher points at them instead:
 * the attention dot on its trigger and on the organization's menu row, with
 * the pending count in both accessible names. The cue follows the same
 * listing, so it must also appear, grow, and clear on its own.
 *
 * It runs once with the mock `shared-with-me/stream` enabled to pin the SSE
 * accelerator and once with that route returning 404 to pin the heartbeat
 * guarantee. `CANOPY_E2E_SHARED_CONTAINER_INBOX_*` collapse the fallback
 * cadence to seconds. Deterministic: no live provider, git host, decrypt, or
 * agent.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  sharedContainerRecipientScenario,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
} from './seeders/index.mjs';
import {
  SHARED_CONTAINERS_CLOUD_API_KEY,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import {
  acceptSharedContainerInvitation,
  removeSharedContainerInvitation,
} from './sharedContainerRecipientActions.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeWorkspaceContextMenu,
  expectWorkspaceContext,
  openWorkspaceContextMenu,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

test.describe.configure({ mode: 'serial' });

const ORGANIZATION = SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID;
const ORGANIZATION_NAME = 'Recipient E2E Organization';
const FLAGS_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-shared-containers': true,
    'canopy-shared-org-projects-enabled': true,
  }),
};

function pendingShares(count) {
  return `${count} pending ${count === 1 ? 'share' : 'shares'}`;
}

/** The switcher's accessible name in Personal with `count` shares waiting. */
function personalTriggerLabel(count) {
  return count === 0
    ? 'Workspace context: Personal'
    : `Workspace context: Personal, ${pendingShares(count)} in ${ORGANIZATION_NAME}`;
}

function registerRecipientScenario(stream, options) {
  return registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...sharedContainerRecipientScenario(options),
      sharedContainers: { stream },
    },
  );
}

/**
 * Launches the recipient on the scenario `options` describe, connects the
 * account, and waits for Personal with the organization listed. Runs `body`
 * with the window, then closes the app and clears the scenario.
 */
async function withRecipient(stream, options, body) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-shared-container-inbox-${stream}-`),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await registerRecipientScenario(stream, options);

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...buildSharedContainerE2eEnv(userDataDir, FLAGS_ENV),
        // Keep the enabled case's poll far outside its assertion window so
        // only SSE can make it pass. Collapse the disabled case to seconds
        // so it proves the fallback without making the suite wait minutes.
        CANOPY_E2E_SHARED_CONTAINER_INBOX_INTERVAL_MS:
          stream === 'enabled' ? '120000' : '3000',
        CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_MIN_EMIT_INTERVAL_MS: '1000',
      },
    }));
    const window = await electronApp.firstWindow();
    await connectSharedContainersAccount(window);
    // The switcher renders once the account and organizations have loaded;
    // listing the organization is that load barrier, not the label alone.
    await expect(window.getByTestId('sidebar-context-row')).toBeVisible({
      timeout: 60_000,
    });
    await openWorkspaceContextMenu(window);
    await expect(
      window.getByTestId(`sidebar-context-option-${ORGANIZATION}`),
    ).toBeVisible({ timeout: 30_000 });
    await closeWorkspaceContextMenu(window);
    await expectWorkspaceContext(window, 'personal');
    await body(window);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
}

/**
 * Asserts the Personal switcher's cue for `count` shares waiting in the
 * organization, polling within `timeout`: the trigger dot and name, then the
 * organization row's dot and name in the open menu.
 */
async function expectPersonalShareCue(window, count, timeout = 30_000) {
  const trigger = window.getByTestId('sidebar-context-row');
  await expect(trigger).toHaveAttribute(
    'aria-label',
    personalTriggerLabel(count),
    { timeout },
  );
  const dot = window.getByTestId('sidebar-context-attention-dot');
  await expect(dot).toHaveCount(count === 0 ? 0 : 1);
  await openWorkspaceContextMenu(window);
  const row = window.getByTestId(`sidebar-context-option-${ORGANIZATION}`);
  const rowDot = window.getByTestId(`sidebar-context-activity-${ORGANIZATION}`);
  if (count === 0) {
    await expect(row).not.toHaveAttribute('aria-label', /pending share/);
    await expect(rowDot).toHaveCount(0);
  } else {
    await expect(row).toHaveAttribute(
      'aria-label',
      `${ORGANIZATION_NAME}, ${pendingShares(count)}`,
    );
    await expect(rowDot).toBeVisible();
  }
  // The count is accessible only: the row shows the name alone.
  await expect(row).toHaveText(ORGANIZATION_NAME);
  await closeWorkspaceContextMenu(window);
}

/** Personal never lists the organization's invitations (CAN-2954). */
async function expectPersonalListsNoInvitations(window) {
  await expect(
    window.getByTestId('sidebar-section-shared-with-me'),
  ).toHaveCount(0);
  await expect(
    window.getByTestId('sidebar-shared-with-me-pending-count'),
  ).toHaveCount(0);
  for (const id of [
    SHARED_CONTAINER_RECIPIENT_CODE_ID,
    SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  ]) {
    await expect(
      window.getByTestId(`shared-container-invitation-${id}`),
    ).toHaveCount(0);
  }
}

for (const stream of ['enabled', 'disabled']) {
  test(`surfaces a mid-session invitation with the inbox stream ${stream}`, async () => {
    test.setTimeout(180_000);
    // Start with the code share only. The cowork share does not exist yet, the
    // same way it does not exist before the publisher invites.
    await withRecipient(stream, { includeCowork: false }, async (window) => {
      // One invitation to begin with: the code share nobody has accepted. It
      // is the organization's, so Personal points at it without listing it.
      await expectPersonalShareCue(window, 1, 60_000);
      await expectPersonalListsNoInvitations(window);

      const section = window.getByTestId('sidebar-section-shared-with-me');
      const pendingCount = window.getByTestId(
        'sidebar-shared-with-me-pending-count',
      );
      const coworkInvitation = window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      );
      // Inside the organization its invitations are on screen, so the cue
      // goes quiet; nothing is accepted by looking.
      await selectWorkspaceContext(window, ORGANIZATION);
      await expect(section).toBeVisible({ timeout: 30_000 });
      await expect(pendingCount).toHaveText('1', { timeout: 30_000 });
      await expect(coworkInvitation).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-context-attention-dot'),
      ).toHaveCount(0);
      await selectWorkspaceContext(window, 'personal');
      await expectPersonalShareCue(window, 1);

      // The publisher invites. Only the authoritative listing changes; the
      // app is not poked through IPC and the mock stream derives its signal
      // from the same authoritative scenario change.
      await registerRecipientScenario(stream, { includeCowork: true });

      // Before the fix this times out: nothing re-lists, and before CAN-4783
      // Personal shows no sign of either invitation.
      await expectPersonalShareCue(window, 2, 45_000);
      await expectPersonalListsNoInvitations(window);

      await selectWorkspaceContext(window, ORGANIZATION);
      await expect(coworkInvitation).toBeVisible({ timeout: 30_000 });
      await expect(pendingCount).toHaveText('2', { timeout: 30_000 });
      // The count is on the header specifically so a recipient who collapsed
      // the section still sees an invitation land.
      await window.getByTestId('sidebar-section-shared-with-me-toggle').click();
      await expect(coworkInvitation).toHaveCount(0);
      await expect(pendingCount).toHaveText('2');
    });
  });

  test(`points at a first invitation that arrives mid-session with the inbox stream ${stream}`, async () => {
    test.setTimeout(120_000);
    // No share at all: no Shared with me section and no cue anywhere.
    await withRecipient(
      stream,
      { includeCode: false, includeCowork: false },
      async (window) => {
        // A quiet switcher alone also passes before the initial inbox request.
        // Observe the real listing while the fixture is still empty, so the
        // invitation below must arrive through a later refresh. Reading mock
        // activity neither starts a listing nor changes renderer state.
        await expect
          .poll(
            async () => {
              const { activity } = await getScenarioActivity(
                DEFAULT_MOCK_BASE_URL,
                SHARED_CONTAINERS_CLOUD_API_KEY,
              );
              return activity.sharedContainersListOrganizationWithMe ?? 0;
            },
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0);
        await expectPersonalShareCue(window, 0);
        await expect(
          window.getByTestId('sidebar-section-shared-with-me'),
        ).toHaveCount(0);

        await registerRecipientScenario(stream, {
          includeCode: false,
          includeCowork: true,
        });

        await expectPersonalShareCue(window, 1, 45_000);
        await expectPersonalListsNoInvitations(window);
      },
    );
  });
}

test('clears the cue as invitations are accepted and removed', async () => {
  test.setTimeout(180_000);
  await withRecipient('disabled', {}, async (window) => {
    await expectPersonalShareCue(window, 2, 60_000);

    await selectWorkspaceContext(window, ORGANIZATION);
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    await selectWorkspaceContext(window, 'personal');
    // Accepting resolves one invitation; the other still waits.
    await expectPersonalShareCue(window, 1);

    await selectWorkspaceContext(window, ORGANIZATION);
    await removeSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await selectWorkspaceContext(window, 'personal');
    // Removing the last one clears the cue.
    await expectPersonalShareCue(window, 0);
  });
});

test('clears the cue when the owner revokes the last invitation', async () => {
  test.setTimeout(120_000);
  await withRecipient('disabled', { includeCowork: false }, async (window) => {
    await expectPersonalShareCue(window, 1, 60_000);
    // The owner revokes: the next listing no longer carries the share.
    await registerRecipientScenario('disabled', {
      includeCode: false,
      includeCowork: false,
    });
    await expectPersonalShareCue(window, 0, 45_000);
  });
});
