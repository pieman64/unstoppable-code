import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Tasks MCP hosts, phase 04: the desktop reports its platform to the Portal and
// shows the host ID agents use for it in the Remote Control pairing view.
//
// The shared suite-wide mock server (apps/desktop-app/tests/electron/mock-server)
// keeps every Portal session in `pending_auth` and returns no `hostCode`, like
// a server that predates host codes. This spec wraps the main process's
// global `fetch` (the same seam organization-switcher-refresh.spec.mjs uses) so
// that, on top of the real mock responses:
// - the first command poll delivers a `portal.auth.validate_code` command with
//   the desktop's own pairing code, so the session pairs through the
//   production command handler and reaches `active`;
// - later command polls report the session as active;
// - heartbeats return `hostCode` once the test switches it on.
// Every session-create and heartbeat request body is recorded so the spec can
// assert `clientPlatform`.
//
// Run: pnpm run test:electron:built portal-host-id.spec.mjs --reporter=line
const TEST_API_KEY = 'csk_portal_host_id_e2e';
const HOST_CODE = 'k3m9p2x7qa';
const HOST_ID_NOTE = 'It stays the same unless the app is reinstalled.';
// Heartbeats run every 15s; allow two intervals plus slack.
const HEARTBEAT_WAIT_MS = 40_000;

const EXPECTED_CLIENT_PLATFORM = {
  darwin: 'mac',
  win32: 'windows',
  linux: 'linux',
}[process.platform];

async function installPortalFetchWrapper(electronApp) {
  await electronApp.evaluate(() => {
    const recorder = {
      createBodies: [],
      heartbeatBodies: [],
      pairingCode: null,
      authDelivered: false,
      hostCode: null,
    };
    globalThis.__portalHostIdE2E = recorder;
    const original = globalThis.fetch;

    const urlOf = (input) =>
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? input);
    const parseBody = (init) => {
      if (typeof init?.body !== 'string') return null;
      try {
        return JSON.parse(init.body);
      } catch {
        return null;
      }
    };
    const json = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const activeSession = (id) => {
      const now = new Date().toISOString();
      return {
        id,
        status: 'active',
        connectionStatus: 'active',
        activatedAt: now,
        lastSeenAt: now,
        endedAt: null,
      };
    };
    const waitForPairingCode = async () => {
      const deadline = Date.now() + 20_000;
      while (recorder.pairingCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return recorder.pairingCode;
    };

    globalThis.fetch = async (input, init) => {
      const url = new URL(urlOf(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'POST' || !url.pathname.includes('/portal/sessions')) {
        return original(input, init);
      }

      if (url.pathname.endsWith('/portal/sessions')) {
        recorder.createBodies.push(parseBody(init));
        return original(input, init);
      }

      const heartbeat = /\/portal\/sessions\/([^/]+)\/heartbeat$/.exec(
        url.pathname,
      );
      if (heartbeat) {
        recorder.heartbeatBodies.push(parseBody(init));
        const response = await original(input, init);
        if (!response.ok || recorder.hostCode === null) return response;
        const body = await response.json();
        return json({ ...body, hostCode: recorder.hostCode });
      }

      const commands = /\/portal\/sessions\/([^/]+)\/commands$/.exec(
        url.pathname,
      );
      if (commands) {
        const sessionId = decodeURIComponent(commands[1]);
        if (!recorder.authDelivered) {
          const code = await waitForPairingCode();
          if (code !== null) {
            recorder.authDelivered = true;
            const now = new Date().toISOString();
            return json({
              session: activeSession(sessionId),
              commands: [
                {
                  id: 'portal-host-id-e2e-auth',
                  sequence: 1,
                  type: 'portal.auth.validate_code',
                  payload: {
                    code,
                    attemptExternalId: 'portal-host-id-e2e-attempt',
                  },
                  createdAt: now,
                  expiresAt: null,
                },
              ],
              nextCursor: 1,
            });
          }
          return original(input, init);
        }
        // Keep the mock's long-poll pacing, but report the paired session.
        const response = await original(input, init);
        if (!response.ok) return response;
        const body = await response.json();
        return json({
          ...body,
          session: activeSession(sessionId),
          nextCursor: Math.max(Number(body.nextCursor) || 0, 1),
        });
      }

      return original(input, init);
    };
  });
}

function readRecorder(electronApp) {
  return electronApp.evaluate(() => {
    const recorder = globalThis.__portalHostIdE2E;
    return {
      createBodies: recorder.createBodies,
      heartbeatBodies: recorder.heartbeatBodies,
    };
  });
}

test('reports the platform and shows the host ID for agents once a heartbeat returns it', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);

    await installPortalFetchWrapper(electronApp);

    const started = await window.evaluate(async () => {
      try {
        const { state } = await window.api.canopyPortal.start();
        return { ok: true, pairingCode: state.pairingCode };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    if (!started.ok) {
      throw new Error(started.error);
    }
    expect(started.pairingCode).toMatch(/^\d{6}$/);
    await electronApp.evaluate((_electron, code) => {
      globalThis.__portalHostIdE2E.pairingCode = code;
    }, started.pairingCode);

    // Session create carries the platform.
    const afterCreate = await readRecorder(electronApp);
    expect(afterCreate.createBodies).toHaveLength(1);
    if (EXPECTED_CLIENT_PLATFORM) {
      expect(afterCreate.createBodies[0].clientPlatform).toBe(
        EXPECTED_CLIENT_PLATFORM,
      );
    } else {
      expect(afterCreate.createBodies[0]).not.toHaveProperty('clientPlatform');
    }

    await app.openCanopyPortal();
    await expect(window.getByTestId('canopy-portal-active')).toBeVisible({
      timeout: 30_000,
    });

    // A heartbeat without a code (an older server) leaves the row hidden.
    await expect
      .poll(
        async () => (await readRecorder(electronApp)).heartbeatBodies.length,
        { timeout: HEARTBEAT_WAIT_MS },
      )
      .toBeGreaterThan(0);
    const beforeCode = await window.evaluate(() =>
      window.api.canopyPortal.getState(),
    );
    expect(beforeCode.status).toBe('active');
    expect(beforeCode.hostCode).toBeNull();
    await expect(window.getByTestId('portal-host-id')).toHaveCount(0);

    // Every heartbeat carries the platform.
    const { heartbeatBodies } = await readRecorder(electronApp);
    for (const body of heartbeatBodies) {
      if (EXPECTED_CLIENT_PLATFORM) {
        expect(body.clientPlatform).toBe(EXPECTED_CLIENT_PLATFORM);
      } else {
        expect(body).not.toHaveProperty('clientPlatform');
      }
    }

    // The server now returns the host code: the next heartbeat surfaces it.
    await electronApp.evaluate((_electron, hostCode) => {
      globalThis.__portalHostIdE2E.hostCode = hostCode;
    }, HOST_CODE);

    const row = window.getByTestId('portal-host-id');
    await expect(row).toBeVisible({ timeout: HEARTBEAT_WAIT_MS });
    await expect(row).toContainText('Host ID for agents');
    await expect(window.getByTestId('portal-host-id-value')).toHaveText(
      HOST_CODE,
    );
    await expect(row).toContainText(HOST_ID_NOTE);
    // Read-only: no copy or other action in the row.
    await expect(row.getByRole('button')).toHaveCount(0);
    const withCode = await window.evaluate(() =>
      window.api.canopyPortal.getState(),
    );
    expect(withCode.hostCode).toBe(HOST_CODE);

    await window.getByTestId('canopy-portal-modal').screenshot({
      path: testInfo.outputPath('portal-host-id-row.png'),
    });

    // Disabling ends the session and clears the code.
    await window.getByTestId('canopy-portal-disable').click();
    await expect(window.getByTestId('canopy-portal-disabled')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByTestId('portal-host-id')).toHaveCount(0);
    const stopped = await window.evaluate(() =>
      window.api.canopyPortal.getState(),
    );
    expect(stopped.hostCode).toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
