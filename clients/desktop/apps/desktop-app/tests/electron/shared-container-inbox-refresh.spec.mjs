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
  registerScenario,
  sharedContainerRecipientScenario,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
} from './seeders/index.mjs';
import {
  SHARED_CONTAINERS_CLOUD_API_KEY,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';

test.describe.configure({ mode: 'serial' });

for (const stream of ['enabled', 'disabled']) {
  test(`surfaces a mid-session invitation with the inbox stream ${stream}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-shared-container-inbox-${stream}-`),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    // Start with the code share only. The cowork share does not exist yet, the
    // same way it does not exist before the publisher invites.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      {
        ...sharedContainerRecipientScenario({ includeCowork: false }),
        sharedContainers: { stream },
      },
    );

    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...buildSharedContainerE2eEnv(userDataDir),
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

      const section = window.getByTestId('sidebar-section-shared-with-me');
      await expect(section).toBeVisible({ timeout: 60_000 });
      const pendingCount = window.getByTestId(
        'sidebar-shared-with-me-pending-count',
      );
      // One invitation to begin with: the code share nobody has accepted.
      await expect(pendingCount).toHaveText('1', { timeout: 30_000 });
      const coworkInvitation = window.getByTestId(
        `shared-container-invitation-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      );
      await expect(coworkInvitation).toHaveCount(0);

      // The publisher invites. Only the authoritative listing changes; the
      // app is not poked through IPC and the mock stream derives its signal
      // from the same authoritative scenario change.
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
        {
          ...sharedContainerRecipientScenario({ includeCowork: true }),
          sharedContainers: { stream },
        },
      );

      // Before the fix this times out: the section never re-lists.
      await expect(coworkInvitation).toBeVisible({ timeout: 45_000 });
      await expect(pendingCount).toHaveText('2', { timeout: 30_000 });
      // The count is on the header specifically so a recipient who collapsed
      // the section still sees an invitation land.
      await window.getByTestId('sidebar-section-shared-with-me-toggle').click();
      await expect(coworkInvitation).toHaveCount(0);
      await expect(pendingCount).toHaveText('2');
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
  });
}
