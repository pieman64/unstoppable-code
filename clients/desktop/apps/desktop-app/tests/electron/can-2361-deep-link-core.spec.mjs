// CAN-2361 PR1 — share deep-link routing core.
//
// Emits macOS-style `open-url` events into the running main process (the OS
// registration itself is install-time and cannot be exercised in CI) and
// asserts that exactly one validated payload reaches the renderer's
// navigation store, while malformed/hostile URLs — including a stray mobile
// OAuth callback on the reserved `auth` host — are dropped silently.
//
// Deterministic: no network, no seeded workspaces; the deep-link pipeline is
// self-contained (parse → buffer until startup unlock → IPC push).
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit(
      'open-url',
      {
        preventDefault: () => {},
      },
      targetUrl,
    );
  }, url);
}

async function readPendingShareDeepLink(window) {
  return window.evaluate(
    () => window.__canopyNavigationTestApi?.getPendingShareInstall() ?? null,
  );
}

test('valid share deep link lands in the navigation store; hostile URLs are dropped', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible();

    // The E2E build resolves the canopy brand, so the expected scheme is the
    // canopy internalName. Hostile/malformed URLs first: none may produce a
    // payload.
    for (const url of [
      `canopy://auth?code=super-secret&state=x`,
      `canopy://share/skills/not-a-uuid`,
      `canopy://share/skills/${UUID}/extra`,
      `canopy://SHARE/skills/${UUID}`,
      `canopy://share/skills/../pipelines/${UUID}`,
      `https://share/skills/${UUID}`,
      `other-scheme://share/skills/${UUID}`,
    ]) {
      await emitOpenUrl(electronApp, url);
    }
    // Give the (synchronous) pipeline a beat, then confirm nothing landed.
    await window.waitForTimeout(250);
    expect(await readPendingShareDeepLink(window)).toBeNull();

    // A valid pipeline link is parsed, delivered post-unlock, and parked.
    await emitOpenUrl(electronApp, `canopy://share/pipelines/${UUID}`);
    await expect
      .poll(() => readPendingShareDeepLink(window))
      .toEqual({ entity: 'pipeline', externalId: UUID, intent: 'install' });

    // A newer link replaces the parked one (last wins).
    await emitOpenUrl(electronApp, `canopy://share/skills/${UUID}`);
    await expect
      .poll(() => readPendingShareDeepLink(window))
      .toEqual({ entity: 'skill', externalId: UUID, intent: 'install' });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Remote Control deep link focuses the app and opens its modal', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible();

    await emitOpenUrl(electronApp, 'canopy://remote-control');
    await expect(window.getByTestId('canopy-portal-modal')).toBeVisible();
    await expect(window.getByTestId('canopy-portal-modal')).toContainText(
      'Remote Control',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The web portal's Personal project list links here so a user can turn on
// "Show my Personal projects on the web" (CAN-2963).
test('Privacy settings deep link focuses the app and opens Settings → Privacy', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible();

    await emitOpenUrl(electronApp, 'canopy://settings/privacy');
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3383 uses the OS delivery path, authoritative cloud membership, the real
// confirmation and main writer. Cancellation and merely receiving links save
// nothing; a second link waits for the first review to close.
test('CAN-3383: live and cold-start links confirm, queue, cancel and update open Privacy settings', async () => {
  test.setTimeout(120_000);
  const { connectMockCloudAccount, registerScenario, DEFAULT_MOCK_BASE_URL } =
    await import('./seeders/index.mjs');
  const { CanopyAppDriver } = await import('./canopyApp.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const apiKey = 'csk_can3383_links_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: [
        {
          id: org,
          name: 'Acme Link Review',
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        },
      ],
      enforcedSettings: [],
    },
  });
  let { electronApp, userDataDir } = await launchCanopy();
  const stored = () =>
    JSON.parse(readFileSync(join(userDataDir, 'preferences.json'), 'utf8'))
      .preferences;
  const link = (feature) =>
    `canopy://settings/privacy?feature=${feature}&org=${org}`;
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ telemetrySharingPromptSeen: true }),
    );
    await connectMockCloudAccount(window, apiKey);
    await window.evaluate(() =>
      window.api.savePreferences({
        telemetrySharing: {
          metadata: 'private',
          plans: 'private',
          summaries: 'organization',
          transcripts: 'organization',
        },
      }),
    );
    const before = stored().telemetrySharing;
    await app.openSettings();
    await app.openSettingsSection('privacy');
    await emitOpenUrl(electronApp, link('leaderboards'));
    await expect(window.getByTestId('data-sharing-opt-in-sheet')).toBeVisible();
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-summary'),
    ).toContainText(
      'Your existing settings also start sharing work recaps and chats.',
    );
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-summary'),
    ).toContainText('now and later');
    expect(stored().telemetrySharing).toEqual(before);
    await emitOpenUrl(electronApp, link('leaderboards'));
    await emitOpenUrl(electronApp, link('organization-memory'));
    await window.getByTestId('data-sharing-opt-in-sheet-cancel').click();
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-summary'),
    ).toContainText('Shares your work stats and chats');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('data-sharing-opt-in-sheet')).toHaveCount(
      0,
    );
    expect(stored().telemetrySharing).toEqual(before);
    // Escape closes only the sheet opened above Settings. Privacy stays open,
    // so this confirmation verifies its mounted controls receive the writer
    // broadcast.
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
    await emitOpenUrl(electronApp, link('leaderboards'));
    await window.getByTestId('data-sharing-opt-in-sheet-share').click();
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-saved'),
    ).toBeVisible();
    await window.getByTestId('data-sharing-opt-in-sheet-done').click();
    await expect
      .poll(() => stored().telemetrySharing)
      .toEqual({ ...before, metadata: 'organization', plans: 'organization' });
    await expect(
      window.getByTestId('telemetry-sharing-metadata-organization'),
    ).toHaveAttribute('aria-pressed', 'true');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      applicationArgs: [link('leaderboards')],
    }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expect(
      window.getByTestId('data-sharing-opt-in-sheet-shared'),
    ).toBeVisible();
    await window.getByTestId('data-sharing-opt-in-sheet-done').click();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const prohibited of ['metadata', 'plans']) {
  test(`CAN-3383: ${prohibited} prohibition is disclosed before confirmation`, async () => {
    test.setTimeout(90_000);
    const { connectMockCloudAccount, registerScenario, DEFAULT_MOCK_BASE_URL } =
      await import('./seeders/index.mjs');
    const { CanopyAppDriver } = await import('./canopyApp.mjs');
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const apiKey = `csk_can3383_${prohibited}_policy`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: [
          {
            id: org,
            name: 'Policy Review',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        ],
        enforcedSettings: [
          {
            organizationId: org,
            organizationName: 'Policy Review',
            policies: [
              {
                kind: 'telemetry-sync',
                scopes: {},
                prohibitedScopes: { [prohibited]: true },
              },
            ],
          },
        ],
      },
    });
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.evaluate(() =>
        window.api.savePreferences({ telemetrySharingPromptSeen: true }),
      );
      await connectMockCloudAccount(window, apiKey);
      await window.evaluate(() =>
        window.api.savePreferences({
          telemetrySharing: {
            metadata: 'private',
            plans: 'private',
            summaries: 'private',
            transcripts: 'private',
          },
        }),
      );
      await emitOpenUrl(
        electronApp,
        `canopy://settings/privacy?feature=leaderboards&org=${org}`,
      );
      if (prohibited === 'metadata') {
        await expect(
          window.getByTestId('data-sharing-opt-in-sheet-managed'),
        ).toContainText('Policy Review manages this sharing.');
        await expect(
          window.getByTestId('data-sharing-opt-in-sheet-share'),
        ).toHaveCount(0);
        await window.getByTestId('data-sharing-opt-in-sheet-done').click();
      } else {
        await expect(
          window.getByTestId('data-sharing-opt-in-sheet-summary'),
        ).toContainText("Policy Review doesn't allow sharing your plans here.");
        await window.getByTestId('data-sharing-opt-in-sheet-share').click();
        await expect(
          window.getByTestId('data-sharing-opt-in-sheet-saved'),
        ).toBeVisible();
      }
      const sharing = await window.evaluate(
        async () => (await window.api.loadPreferences()).telemetrySharing,
      );
      expect(sharing).toEqual({
        metadata: prohibited === 'metadata' ? 'private' : 'organization',
        plans: 'private',
        summaries: 'private',
        transcripts: 'private',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
