import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-3511: LaunchDarkly failed to start during a network blip and the desktop
// never retried, so every flag stayed on its "LaunchDarkly enabled but
// unavailable" fallback until the next restart. `canopy-portal-enabled` falls
// back to false, which removes Remote Control from the sidebar for the whole
// session.
//
// Each test points the real feature-flag service at a local LaunchDarkly
// fixture (the E2E-only `CANOPY_E2E_LAUNCHDARKLY_BASE_URL` seam), fails the
// first start with HTTP 503, brings the fixture back, and checks that the
// Remote Control sidebar item returns without a restart.
// `launchCanopy` strips any inherited client-side ID, so, like
// `canopy-portal.spec.mjs`, the spec injects one into the main process env and
// starts LaunchDarkly through the production refresh path.

const RECOVERED_FLAGS = {
  'canopy-portal-enabled': true,
  'canopy-cloud-sign-in-required': false,
  'canopy-guest-mode-enabled': false,
};

async function startLaunchDarklyFixture() {
  const state = { healthy: false, evalRequests: 0 };
  const streams = new Set();
  const server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/sdk/evalx/')) {
      state.evalRequests += 1;
      if (!state.healthy) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(RECOVERED_FLAGS).map(([key, value]) => [
              key,
              { value, version: 1, variation: value ? 0 : 1 },
            ]),
          ),
        ),
      );
      return;
    }
    if (url.startsWith('/eval/')) {
      // Streaming: hold the connection open without events, so the polled
      // values above stay authoritative.
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(':\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    // Analytics and diagnostic events.
    request.resume();
    response.writeHead(202);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readFeatureFlagDiagnostics(userDataDir) {
  try {
    const directory = path.join(
      userDataDir,
      'agent-observability',
      'diagnostics',
      'app-events',
    );
    return readdirSync(directory)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .flatMap((name) =>
        readFileSync(path.join(directory, name), 'utf8').trim().split('\n'),
      )
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => String(record.kind).startsWith('feature_flags_'));
  } catch {
    return [];
  }
}

/**
 * Opens the account menu, asserts whether its portal-gated Remote Control item
 * is listed (CAN-3659: it moved there from the sidebar nav), and closes it.
 * The assertion retries while the menu is open, so a flag push that lands
 * meanwhile re-renders the menu in place.
 */
async function expectRemoteControlMenuItem(window, present, options = {}) {
  await window.getByTestId('sidebar-account-row').click();
  await expect(window.getByTestId('sidebar-account-menu')).toBeVisible();
  await expect(
    window.getByTestId('sidebar-account-menu-item-remote-control'),
  ).toHaveCount(present ? 1 : 0, options);
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('sidebar-account-menu')).toHaveCount(0);
}

/** Waits until the main process reports the portal flag on again. */
async function expectPortalFlagRecovered(window, timeout) {
  await expect
    .poll(
      async () =>
        (
          await window.evaluate(async () =>
            window.api.featureFlags.getSnapshot(),
          )
        ).values['canopy-portal-enabled'],
      { timeout },
    )
    .toBe(true);
}

/**
 * Starts LaunchDarkly against the failing fixture. The portal-gated Remote
 * Control account-menu item must be missing while flags are unavailable.
 */
async function failFirstLaunchDarklyStart(electronApp, window, fixture) {
  await expectRemoteControlMenuItem(window, true);

  await electronApp.evaluate(async (_electron, baseUrl) => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'e2e-client-side-id';
    process.env.CANOPY_E2E_LAUNCHDARKLY_BASE_URL = baseUrl;
  }, fixture.baseUrl);

  const snapshot = await window.evaluate(async () =>
    window.api.featureFlags.refreshContext(),
  );
  expect(snapshot.status).toBe('error');
  expect(snapshot.values['canopy-portal-enabled']).toBe(false);
  expect(fixture.state.evalRequests).toBe(1);

  await expectRemoteControlMenuItem(window, false);
}

test('CAN-3511: a failed LaunchDarkly start retries with backoff and restores Remote Control without a restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await startLaunchDarklyFixture();
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await failFirstLaunchDarklyStart(electronApp, window, fixture);

    // The network comes back. No user action: the first backoff retry
    // (15 s, jittered by up to 20 percent) picks up the live values.
    fixture.state.healthy = true;
    await expectPortalFlagRecovered(window, 30_000);
    // The renderer received the push, not only the main process.
    await expectRemoteControlMenuItem(window, true, { timeout: 5_000 });
    expect(fixture.state.evalRequests).toBe(2);

    await expect(
      window.evaluate(async () => window.api.featureFlags.getSnapshot()),
    ).resolves.toMatchObject({
      status: 'ready',
      values: { 'canopy-portal-enabled': true },
    });

    await expect
      .poll(() => readFeatureFlagDiagnostics(userDataDir), { timeout: 10_000 })
      .toEqual([
        expect.objectContaining({
          kind: 'feature_flags_unavailable',
          featureFlagFailedAttempts: 1,
          featureFlagValuesSource: 'unavailable_fallback',
        }),
        expect.objectContaining({
          kind: 'feature_flags_recovered',
          featureFlagFailedAttempts: 1,
          featureFlagRecoveryTrigger: 'backoff',
        }),
      ]);

    await window.screenshot({
      path: testInfo.outputPath('launchdarkly-recovered-remote-control.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});

test('CAN-3511: coming back online retries LaunchDarkly before the backoff elapses', async () => {
  const fixture = await startLaunchDarklyFixture();
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await failFirstLaunchDarklyStart(electronApp, window, fixture);

    fixture.state.healthy = true;
    await window.evaluate(() => {
      window.dispatchEvent(new Event('online'));
    });

    // Well inside the 12 s minimum backoff, so only the reconnect can do it.
    await expectPortalFlagRecovered(window, 8_000);
    await expectRemoteControlMenuItem(window, true, { timeout: 2_000 });
    expect(fixture.state.evalRequests).toBe(2);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await fixture.close();
  }
});
