// CAN-4633: a real startup prewarm must not consume a grant before PostHog
// capture is ready. Uses the existing cloud and LaunchDarkly loopback seams.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startPostHogCapture } from './posthogCapture.mjs';
import {
  connectMockCloudAccount,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';

async function startStartupFixture() {
  const state = {
    cold: false,
    balanceReads: 0,
    grantedBeforeFlags: false,
    flagsReady: false,
    flagRequests: 0,
  };
  const pendingFlags = new Set();
  const streams = new Set();
  let releaseTimer;
  const flags = {
    'canopy-cloud-sign-in-required': false,
    'canopy-guest-mode-enabled': false,
    'canopy-desktop-posthog-capture-enabled': true,
    'canopy-desktop-posthog-session-replay-sample-rate': 100,
  };
  function sendFlags(response) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(flags).map(([key, value]) => [
            key,
            { value, version: 1 },
          ]),
        ),
      ),
    );
  }
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? '/';
    if (url.startsWith('/sdk/evalx/')) {
      state.flagRequests += 1;
      if (!state.flagsReady) pendingFlags.add(response);
      else sendFlags(response);
      return;
    }
    if (url.startsWith('/eval/')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    if (url.startsWith('/events/') || url.startsWith('/events/bulk')) {
      request.resume();
      response.writeHead(202).end();
      return;
    }
    if (state.cold && url.split('?')[0] === '/api/v1/ai-credits/balance') {
      state.balanceReads += 1;
      const first = state.balanceReads === 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          credits: 10,
          eligible: true,
          dailyDripOutcome: first ? 'granted' : 'already_granted',
          ...(first ? { dailyDripGrantedCredits: 10 } : {}),
        }),
      );
      if (first) {
        state.grantedBeforeFlags = true;
        // Give the balance response and its deferred recording a full turn
        // before completing flag initialization. This controls only transport.
        releaseTimer = setTimeout(() => {
          state.flagsReady = true;
          for (const pending of pendingFlags) sendFlags(pending);
          pendingFlags.clear();
        }, 1500);
      }
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${DEFAULT_MOCK_BASE_URL}${url}`, {
        method: request.method,
        headers: {
          ...request.headers,
          host: new URL(DEFAULT_MOCK_BASE_URL).host,
        },
        ...(!['GET', 'HEAD'].includes(request.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      response.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      clearTimeout(releaseTimer);
      for (const response of [...streams, ...pendingFlags]) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('PostHog preserves a startup daily grant until the first capture snapshot', async () => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.CANOPY_POSTHOG_STUB_URL,
    'Requires the opt-in local PostHog build',
  );
  const apiKey = 'csk_posthog_startup_grant_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const fixture = await startStartupFixture();
  const collector = await startPostHogCapture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-grant-startup-'));
  const env = {
    CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl,
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-desktop-posthog-capture-enabled': true,
    }),
  };
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env,
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    }));
    const seedWindow = await electronApp.firstWindow();
    await new CanopyAppDriver(seedWindow).waitForShell();
    await connectMockCloudAccount(seedWindow, apiKey);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    collector.events.length = 0;
    fixture.state.cold = true;

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...env,
        LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: 'e2e-startup-grant',
        CANOPY_E2E_LAUNCHDARKLY_BASE_URL: fixture.baseUrl,
      },
      electronArgs: ['--disable-blink-features=AutomationControlled'],
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    expect(
      await electronApp.evaluate(
        () => process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID,
      ),
    ).toBe('e2e-startup-grant');
    expect(fixture.state.flagRequests).toBeGreaterThan(0);
    expect(fixture.state.grantedBeforeFlags).toBe(true);
    const grants = () =>
      collector.events.filter(
        (event) => event.event === 'billing:daily_credit_grant_update',
      );
    await expect.poll(() => grants().length).toBe(1);
    expect(grants()[0].properties).toMatchObject({
      grant_status: 'granted',
      grant_amount: 10,
      grant_source: 'balance_read',
    });
    await app.openUsagePage();
    const balance = await window.evaluate(() =>
      window.api.loadCanopyCloudAiCredits(),
    );
    expect(balance.balance.dailyDripOutcome).toBe('already_granted');
    await closeCanopy(electronApp, userDataDir);
    electronApp = undefined;
    expect(grants()).toHaveLength(1);
    expect(collector.parseErrors).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await collector.shutdown();
    await fixture.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
