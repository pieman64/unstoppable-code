// The redesigned cloud sign-in gate, end to end through the API-key path.
//
//   pnpm run test:electron:built cloud-sign-in-modal.spec.mjs --reporter=line
//
// Covers the two reported defects that had no regression guard:
//
//  1. Choosing "API Key" used to remove every submit affordance — the field
//     silently autosaved on a 600ms debounce. There is now an explicit Connect
//     button, and the panel validates only on submit.
//  2. Connecting used to append a success block BELOW a still-live account
//     section, so the modal grew and simultaneously showed "You're connected",
//     "Continue", and "Disconnect". Success now closes the modal and fires a
//     persistent "Sign in successful" toast instead.
//  3. A Home-composer autofocus frame could run after the modal opened and
//     steal keyboard focus from the modal's focus trap. The OAuth action must
//     retain focus after pending animation frames have run.
//
// Determinism: a fresh signed-out user-data dir and the mock server's fixed API
// key. No live network and no OAuth loopback (which cannot complete headlessly,
// hence the API-key path). Confirmed guests intentionally have no manual-key
// fallback because that path cannot merge their guest identity.

import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { injectSecureStorageFault } from './secureStorageFixture.mjs';
import { captureCloudCredentialDiagnostics } from './cloudCredentialDiagnostics.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
// The benefit row renders the raw constant (CloudAuthPanel.tsx). If the
// renderer ever adds locale formatting or singular handling, update these
// assertions alongside it.
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import {
  startCloudOAuthLoopbackFixture,
  openUnfinishedCallbackRequest,
} from './cloudOAuthLoopbackFixture.mjs';

/** The guest account-menu sign-in action is gated on `canopy-billing-enabled`. */
const BILLING_ENABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-billing-enabled': true,
  }),
};

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

async function openSidebarSignIn(window) {
  await window.getByTestId('sidebar-account-row').click();
  await window.getByTestId('sidebar-account-menu-item-sign-in-out').click();
}

const TEST_API_KEY = 'csk_sign_in_modal_e2e';
const PENDING_API_KEY = 'csk_sign_in_modal_pending_e2e';
/** Mock-server key whose single org requires every telemetry scope at org visibility. */
const ALL_LOCKED_API_KEY = 'csk_telemetry_all_locked_e2e';

async function expectPersistedCloudKey(electronApp, userDataDir) {
  const ciphertext = readFileSync(
    path.join(`${userDataDir}-secure`, 'canopy-cloud-account.enc'),
  );
  expect(ciphertext.includes(Buffer.from(TEST_API_KEY))).toBe(false);
  // Decrypt the actual disk record with native safeStorage, not the account
  // store's in-memory cache. A toast alone cannot prove a durable sign-in.
  expect(
    await electronApp.evaluate(
      ({ safeStorage }, { base64, key }) =>
        JSON.parse(safeStorage.decryptString(Buffer.from(base64, 'base64')))
          .apiKey === key,
      { base64: ciphertext.toString('base64'), key: TEST_API_KEY },
    ),
  ).toBe(true);
}

for (const scenario of [
  { fault: 'unavailable', state: 'unavailable', linuxOnly: false },
  { fault: 'locked', state: 'locked', linuxOnly: true },
  { fault: 'encrypt-failed', state: 'failed', linuxOnly: false },
]) {
  test(`CAN-3220 cloud ${scenario.fault} refuses discarded credentials and preserves the entered key`, async () => {
    test.skip(
      scenario.linuxOnly && process.platform !== 'linux',
      'Backend selection and lock inference are Linux native API contracts.',
    );
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy({
      env: BILLING_ENABLED_ENV,
    });
    let restore;
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await openSidebarSignIn(window);
      const modal = window.getByTestId('cloud-sync-modal');
      await modal
        .getByTestId('settings-account-canopy-cloud-mode-api-key')
        .click();
      const input = modal.getByTestId(
        'settings-account-canopy-cloud-api-key-input',
      );
      await input.fill(TEST_API_KEY);
      restore = await injectSecureStorageFault(electronApp, scenario.fault);
      await modal
        .getByTestId('settings-account-canopy-cloud-api-key-submit')
        .click();

      await expect(modal).toContainText(
        scenario.state === 'locked'
          ? 'Secure storage is locked or temporarily unavailable.'
          : scenario.state === 'failed'
            ? 'Couldn’t access secure storage.'
            : 'Secure storage is unavailable.',
      );
      const notice = modal.getByTestId('secure-storage-notice');
      await expect(notice).toHaveAttribute(
        'data-storage-state',
        scenario.state,
      );
      await expect(modal).toBeVisible();
      await expect(input).toHaveValue(TEST_API_KEY);
      await expect(window.getByTestId('toast-meta-title')).toHaveCount(0);
      expect(
        existsSync(
          path.join(`${userDataDir}-secure`, 'canopy-cloud-account.enc'),
        ),
      ).toBe(false);
      const retry = modal.getByTestId('secure-storage-retry');
      await expect(retry).toHaveText('Try again');

      await restore();
      await retry.click();
      await expect(modal).toHaveCount(0, { timeout: 30_000 });
      await expect(window.getByTestId('toast-meta-title').first()).toHaveText(
        'Sign in successful',
      );
      await expectPersistedCloudKey(electronApp, userDataDir);
    } finally {
      try {
        await restore?.();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });
}

test('CAN-3220 pending key survives an inconclusive account-changed read before Retry', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });
  let diagnostics;
  let restore;
  try {
    diagnostics = await captureCloudCredentialDiagnostics(
      electronApp,
      testInfo,
    );
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await openSidebarSignIn(window);
    const modal = window.getByTestId('cloud-sync-modal');
    await modal
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    const input = modal.getByTestId(
      'settings-account-canopy-cloud-api-key-input',
    );
    await input.fill(TEST_API_KEY);
    restore = await injectSecureStorageFault(electronApp, 'encrypt-failed');
    await modal
      .getByTestId('settings-account-canopy-cloud-api-key-submit')
      .click();
    await expect(modal.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'failed',
    );
    await expect(input).toHaveValue(TEST_API_KEY);
    // A different mounted account consumer may refresh while this write is
    // still waiting for storage. An inconclusive read cannot cancel that intent.
    await restore();
    restore = await injectSecureStorageFault(electronApp, 'probe-failed');
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await expect(modal.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'unavailable',
    );
    await restore();
    await modal.getByTestId('secure-storage-retry').click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByTestId('toast-meta-title').first()).toHaveText(
      'Sign in successful',
    );
    await expectPersistedCloudKey(electronApp, userDataDir);
  } finally {
    try {
      await restore?.();
    } finally {
      await diagnostics?.finish();
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('CAN-3220 read-only Retry refreshes the mounted sidebar without announcing a sign-in', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Seed a real encrypted credential before the failed startup read.
    // The user will recover that saved account without signing in again.
    const saved = await window.evaluate(
      (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      TEST_API_KEY,
    );
    expect(saved.status.authenticated).toBe(true);
    expect(saved.account.hasApiKey).toBe(true);
    const accountName = saved.account.account?.name;
    expect(accountName).toEqual(expect.stringMatching(/\S/));
    await expectPersistedCloudKey(electronApp, userDataDir);

    restore = await injectSecureStorageFault(electronApp, 'unavailable');
    // Mount the sidebar under an inconclusive first read so it has no cached
    // identity to retain. There must be no reload after the user presses Retry.
    await window.reload();
    await app.waitForShell();
    expect(
      (await window.evaluate(() => window.api.loadCanopyCloudAccount())).read,
    ).toBe('unavailable');
    const sidebarAccount = window.getByTestId('sidebar-account-row');
    await expect(sidebarAccount).toContainText('Sign in');
    await expect(sidebarAccount).not.toContainText(accountName);
    await app.openSettings();
    await app.openAccountSettingsPage('account');
    const section = window.getByTestId('settings-account-canopy-cloud-section');
    await expect(section.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'unavailable',
    );
    await expect(window.getByTestId('toast-meta-title')).toHaveCount(0);

    await restore();
    await section.getByTestId('secure-storage-retry').click();

    // No synthetic account-changed event: Retry itself must notify the sidebar
    // that was already mounted while the Settings account card stays open.
    await expect(section.getByTestId('secure-storage-notice')).toHaveCount(0);
    await app.closeSettings();
    await expect(sidebarAccount).toBeVisible();
    await expect(sidebarAccount).toContainText(accountName);
    await expect(window.getByTestId('toast-meta-title')).toHaveCount(0);
    await expectPersistedCloudKey(electronApp, userDataDir);
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('CAN-3220 storage loss during a pending Settings save releases validation and Retry saves the draft', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });
  let restore;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openAccountSettingsPage('account');
    const section = window.getByTestId('settings-account-canopy-cloud-section');
    await section
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    const input = section.getByTestId(
      'settings-account-canopy-cloud-api-key-input',
    );
    await window.clock.install();
    await window.clock.pauseAt(new Date(Date.now() + 1_000));
    restore = await injectSecureStorageFault(electronApp, 'unavailable');
    await input.fill(TEST_API_KEY);
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await expect(section.getByTestId('secure-storage-notice')).toBeVisible();
    // Freeze the debounce until the read failure has reached the editor.
    await expect(section.getByTestId('secure-storage-notice')).toHaveAttribute(
      'data-storage-state',
      'unavailable',
    );
    await window.clock.runFor(600);
    await expect(
      section.getByTestId('settings-account-canopy-cloud-api-key'),
    ).not.toContainText('Validating');
    await expect(input).toHaveValue(TEST_API_KEY);
    await restore();
    await section.getByTestId('secure-storage-retry').click();
    await window.clock.resume();
    // Retry completes asynchronously; an enabled editor alone does not prove
    // the credential write has committed. Wait for the actual encrypted record.
    await expect
      .poll(() =>
        existsSync(
          path.join(`${userDataDir}-secure`, 'canopy-cloud-account.enc'),
        ),
      )
      .toBe(true);
    await expect(input).toBeEnabled();
    await expect(section.getByTestId('secure-storage-notice')).toHaveCount(0);
    await expectPersistedCloudKey(electronApp, userDataDir);
  } finally {
    try {
      await restore?.();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

for (const [title, expireMountedDebounce] of [
  [
    'CAN-3220 Settings unmount saves newer key B after in-flight key A settles',
    false,
  ],
  [
    'CAN-3220 Settings queues a mounted newer key B behind in-flight key A',
    true,
  ],
]) {
  test(title, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const keyA = 'csk_unmount_order_a_e2e';
    const keyB = 'csk_unmount_order_b_e2e';
    const accountRequests = [];
    let diagnostics;
    let released = false;
    let releaseA;
    const barrier = new Promise((resolve) => {
      releaseA = () => {
        released = true;
        resolve();
      };
    });
    let releaseB;
    const newerBarrier = new Promise((resolve) => {
      releaseB = resolve;
    });
    // Delay only the real validation HTTP response. IPC, renderer handlers and
    // native encryption stay untouched, including the unmount cleanup writer.
    const proxy = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        const authorization = request.headers.authorization;
        diagnostics?.mark('proxy-request', {
          path: pathname,
          candidate:
            authorization === `Bearer ${keyA}`
              ? 'A'
              : authorization === `Bearer ${keyB}`
                ? 'B'
                : 'other',
        });
        if (pathname.endsWith('/account')) {
          if (authorization === `Bearer ${keyA}`) {
            accountRequests.push({ key: 'A', afterRelease: released });
            await barrier;
          } else if (authorization === `Bearer ${keyB}`) {
            accountRequests.push({ key: 'B', afterRelease: released });
            if (expireMountedDebounce) await newerBarrier;
          }
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(
          new URL(request.url, DEFAULT_MOCK_BASE_URL),
          {
            method: request.method,
            headers: {
              ...(authorization ? { Authorization: authorization } : {}),
              'Content-Type': 'application/json',
            },
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          },
        );
        diagnostics?.mark('proxy-response', {
          path: pathname,
          status: upstream.status,
        });
        response.writeHead(upstream.status, {
          'Content-Type': 'application/json',
        });
        response.end(await upstream.text());
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    let electronApp;
    let userDataDir;
    try {
      ({ electronApp, userDataDir } = await launchCanopy({
        env: {
          ...BILLING_ENABLED_ENV,
          CANOPY_E2E_CLOUD_BASE_URL: `http://127.0.0.1:${proxy.address().port}`,
        },
      }));
      diagnostics = await captureCloudCredentialDiagnostics(
        electronApp,
        testInfo,
      );
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openAccountSettingsPage('account');
      const section = window.getByTestId(
        'settings-account-canopy-cloud-section',
      );
      await section
        .getByTestId('settings-account-canopy-cloud-mode-api-key')
        .click();
      const input = section.getByTestId(
        'settings-account-canopy-cloud-api-key-input',
      );
      await input.fill(keyA);
      await expect
        .poll(() => accountRequests.some(({ key }) => key === 'A'))
        .toBe(true);
      await expect(input).toBeEnabled();
      if (expireMountedDebounce) await window.clock.install();
      await input.fill(keyB);
      await expect(input).toHaveValue(keyB);
      if (expireMountedDebounce) await window.clock.runFor(600);
      await app.closeSettings();
      await expect(section).toHaveCount(0);
      expect(accountRequests.filter(({ key }) => key === 'B')).toEqual([]);
      diagnostics.mark('release-a');
      releaseA();
      if (expireMountedDebounce) {
        await window.clock.resume();
        // Keep B's HTTP response held until the real A ciphertext is durable.
        // Concurrent submissions capture the same expected-account snapshot;
        // B would then lose the main-process compare-and-swap after A commits.
        await expect
          .poll(async () => {
            const filename = path.join(
              `${userDataDir}-secure`,
              'canopy-cloud-account.enc',
            );
            if (!existsSync(filename)) return false;
            return electronApp.evaluate(
              ({ safeStorage }, base64) =>
                JSON.parse(
                  safeStorage.decryptString(Buffer.from(base64, 'base64')),
                ).apiKey === 'csk_unmount_order_a_e2e',
              readFileSync(filename).toString('base64'),
            );
          })
          .toBe(true);
        releaseB();
      }
      await expect
        .poll(() => accountRequests.some(({ key }) => key === 'B'))
        .toBe(true);
      expect(accountRequests.find(({ key }) => key === 'A').afterRelease).toBe(
        false,
      );
      expect(
        accountRequests
          .filter(({ key }) => key === 'B')
          .every(({ afterRelease }) => afterRelease),
      ).toBe(true);
      const filename = path.join(
        `${userDataDir}-secure`,
        'canopy-cloud-account.enc',
      );
      await expect
        .poll(async () => {
          if (!existsSync(filename)) return false;
          const ciphertext = readFileSync(filename);
          return electronApp.evaluate(
            ({ safeStorage }, { base64, expectedKey }) =>
              JSON.parse(
                safeStorage.decryptString(Buffer.from(base64, 'base64')),
              ).apiKey === expectedKey,
            { base64: ciphertext.toString('base64'), expectedKey: keyB },
          );
        })
        .toBe(true);
      const ciphertext = readFileSync(filename);
      expect(ciphertext.includes(Buffer.from(keyA))).toBe(false);
      expect(ciphertext.includes(Buffer.from(keyB))).toBe(false);
      // Reopen through the ordinary UI: the unmounted A completion must not have
      // reverted the user's newer draft or supplied a false connected snapshot.
      await app.openSettings();
      await app.openAccountSettingsPage('account');
      await expect(input).toHaveValue(keyB);
    } finally {
      releaseA();
      releaseB();
      try {
        if (electronApp) {
          await diagnostics?.finish();
          await closeCanopy(electronApp, userDataDir);
        }
      } finally {
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      }
    }
  });
}

test('cancels browser sign-in while the guest link is still being prepared', async () => {
  const fixture = await startCloudOAuthLoopbackFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    await window.reload();
    await app.waitForShell();
    await openSidebarSignIn(window);
    const login = window.getByTestId(
      'settings-account-canopy-cloud-oauth-login',
    );
    await login.click();
    await expect.poll(() => fixture.guestLinkRequests()).toBe(1);
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-cancel')
      .click();
    await expect(login).toBeEnabled();
    expect(
      (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
        .credentialSource,
    ).toBe('guest');
  } finally {
    fixture.releaseGuestLink();
    fixture.releaseAccount();
    await closeCanopy(electronApp, userDataDir);
    await fixture.stop();
  }
});

test('cancels browser sign-in despite an unfinished callback request and allows retry', async () => {
  const fixture = await startCloudOAuthLoopbackFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: fixture.env });
  let socket;
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await openSidebarSignIn(window);
    const login = window.getByTestId(
      'settings-account-canopy-cloud-oauth-login',
    );
    await login.click();
    const authorize = new URL(await fixture.nextExternalUrl());
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    socket = await openUnfinishedCallbackRequest(callback);
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-cancel')
      .click();
    await expect(login).toBeEnabled();
    expect(
      (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
        .hasApiKey,
    ).toBe(false);
    await login.click();
    expect(await fixture.nextExternalUrl()).not.toBe(authorize.toString());
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-cancel')
      .click();
    await expect(login).toBeEnabled();
  } finally {
    socket?.destroy();
    fixture.releaseAccount();
    await closeCanopy(electronApp, userDataDir);
    await fixture.stop();
  }
});

test('completes browser sign-in without waiting for a second account probe or unfinished requests', async () => {
  const fixture = await startCloudOAuthLoopbackFixture();
  const { electronApp, userDataDir } = await launchCanopy({ env: fixture.env });
  let socket;
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await openSidebarSignIn(window);
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-login')
      .click();
    const authorize = new URL(await fixture.nextExternalUrl());
    const callback = new URL(authorize.searchParams.get('redirect_uri'));
    socket = await openUnfinishedCallbackRequest(callback);
    callback.searchParams.set('code', 'loopback-code');
    callback.searchParams.set('state', authorize.searchParams.get('state'));
    expect(await (await fetch(callback)).text()).toContain('Desktop connected');
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(window.getByTestId('telemetry-optin-modal')).toHaveCount(0);
    await expect(window.getByTestId('toast-meta-title').first()).toHaveText(
      'Sign in successful',
    );
    expect(callback.pathname).toBe('/desktop-connect');
  } finally {
    socket?.destroy();
    fixture.releaseAccount();
    await closeCanopy(electronApp, userDataDir);
    await fixture.stop();
  }
});

test('CAN-3220 saved cloud sign-in persists an encrypted credential and closes with a success toast', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const toastStatus = window.getByTestId('toast-live-region');
    await expect(toastStatus).toHaveAttribute('aria-live', 'polite');

    // --- Signed-out account action opens the shared gate -----------------
    await openSidebarSignIn(window);

    const modal = window.getByTestId('cloud-sync-modal');
    await expect(modal).toBeVisible();

    // --- One primary action, benefits as rows, API key as an escape hatch --
    const oauthCta = window.getByTestId(
      'settings-account-canopy-cloud-oauth-login',
    );
    await expect(oauthCta).toBeVisible();
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await expect(oauthCta).toBeFocused();
    await expect(modal).toContainText('Keep your work synced to your account');
    await expect(modal).not.toContainText(
      "Keep the work you've done as a guest",
    );
    await expect(modal).toContainText(
      'Opens your browser. Takes about ten seconds.',
    );
    // The segmented OAuth | API Key control is gone.
    await expect(
      window.getByTestId('settings-account-canopy-cloud-mode-toggle'),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('cloud-sign-in-modal-oauth.png'),
    });

    // Browser OAuth is a single explicit operation. Ambient dismissal would
    // orphan the gated action while the main process can still commit the
    // credential, so Escape/backdrop/X all disappear until Cancel settles.
    await oauthCta.click();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-oauth-cancel'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-cancel')
      .click();
    await expect(oauthCta).toHaveText(/Sign in with/);
    await expect(oauthCta).toBeFocused();

    // --- "Use an API key instead" swaps the panel -------------------------
    await window
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();

    const keyInput = window.getByTestId(
      'settings-account-canopy-cloud-api-key-input',
    );
    await expect(keyInput).toBeVisible();
    await expect(oauthCta).toHaveCount(0);
    await expect(
      window.getByTestId('settings-account-canopy-cloud-mode-oauth'),
    ).toBeVisible();

    // Regression guard for defect 1: the API-key panel has a real submit.
    const submit = window.getByTestId(
      'settings-account-canopy-cloud-api-key-submit',
    );
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();

    await keyInput.fill(TEST_API_KEY);
    await expect(submit).toBeEnabled();

    await window.screenshot({
      path: testInfo.outputPath('cloud-sign-in-modal-api-key.png'),
    });

    await submit.click();

    // Signing in shows no activity-sharing prompt; the conversion gate closes
    // straight into its persistent success toast.
    // --- Regression guard for defect 2: success closes, it does not grow ---
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByTestId('cloud-sync-modal-success')).toHaveCount(0);
    await expect(window.getByTestId('telemetry-optin-modal')).toHaveCount(0);

    const toast = window.getByTestId('toast-card').first();
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(toastStatus).toHaveAttribute('aria-live', 'polite');
    const toastTitle = window.getByTestId('toast-meta-title').first();
    await expect(toastTitle).toHaveText('Sign in successful');
    await expect(toast).toContainText("You're all set.");
    // The daily free AI Credits are opt-in, so sign-in alone readies none.
    await expect(toast).not.toContainText('credits');

    await window.screenshot({
      path: testInfo.outputPath('cloud-sign-in-modal-toast.png'),
    });

    // The account really is connected, not just optimistically closed.
    const account = await window.evaluate(async () =>
      window.api.loadCanopyCloudAccount(),
    );
    expect(account.hasApiKey).toBe(true);
    expect(account.credentialSource).not.toBe('guest');
    await expectPersistedCloudKey(electronApp, userDataDir);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps the cloud sign-in modal mounted while API-key validation is pending', async () => {
  test.setTimeout(120_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, PENDING_API_KEY, {
    cloud: { accountDelayMs: 5_000 },
  });

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await openSidebarSignIn(window);
    const modal = window.getByTestId('cloud-sync-modal');
    await expect(modal).toBeVisible();
    await window
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-input')
      .fill(PENDING_API_KEY);
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-submit')
      .click();

    const submit = window.getByTestId(
      'settings-account-canopy-cloud-api-key-submit',
    );
    await expect(submit).toHaveText('Connecting…');
    await expect(submit).toBeFocused();
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await expect(modal.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(modal).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('returns keyboard focus to the API-key field after validation fails', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await openSidebarSignIn(window);
    await window
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    const input = window.getByTestId(
      'settings-account-canopy-cloud-api-key-input',
    );
    await input.fill('invalid-key');
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-submit')
      .click();

    await expect(window.getByTestId('cloud-auth-panel-error')).toBeVisible({
      timeout: 30_000,
    });
    await expect(input).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a confirmed guest gets merge-safe OAuth presentation without an API-key fallback', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const guest = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(guest.credentialSource).toBe('guest');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    await openSidebarSignIn(window);
    const modal = window.getByTestId('cloud-sync-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Keep the work you've done as a guest");
    // With no dialog subheading, the panel's lead is the supporting line.
    await expect(modal).toContainText(
      "Free account, no card, nothing you've built gets left behind.",
    );
    await expect(
      window.getByTestId('settings-account-canopy-cloud-mode-api-key'),
    ).toHaveCount(0);

    await modal.screenshot({
      path: testInfo.outputPath('cloud-sign-in-modal-guest-safe.png'),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a guest minted while the API-key panel is open replaces it with the merge-safe OAuth presentation', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await openSidebarSignIn(window);
    const modal = window.getByTestId('cloud-sync-modal');
    await expect(modal).toBeVisible();
    await window
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key-input'),
    ).toBeVisible();

    const guest = await window.evaluate(async (consent) => {
      const next = await window.api.startCanopyGuestSession(consent);
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      return next;
    }, GUEST_CONSENT);
    expect(guest.credentialSource).toBe('guest');

    await expect(modal).toContainText("Keep the work you've done as a guest");
    await expect(
      window.getByTestId('settings-account-canopy-cloud-api-key-input'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('settings-account-canopy-cloud-mode-api-key'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The guest presentation must sell what an account KEEPS giving, never state a
// perk as one the guest already has without signing in. The daily free AI
// Credits are opt-in, so neither presentation lists them as a benefit at all.
test('never promises daily free credits as a sign-in benefit', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const modal = window.getByTestId('cloud-sync-modal');
    const credits = window.getByTestId('cloud-auth-benefit-daily-credits');

    // --- Signed out, never a guest ---------------------------------------
    // Exactly ONE supporting line under the title. The dialog subheading and
    // the panel's generic lead fill the same role, and now that the lead sits
    // tight under the title the two stack into what reads as a doubled
    // paragraph. This path used to carry the subheading "Sign in to get your
    // free AI credits." and suppress the lead; it now does the reverse,
    // because that subheading stacked under a title that also opens "Sign in
    // to get" while promising something different. The generic lead supports
    // any title instead of restating one, so it is the line that survives.
    await openSidebarSignIn(window);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Free account, no card');
    await expect(modal).not.toContainText(
      'Sign in to get your free AI credits',
    );
    await expect(
      window.getByTestId('cloud-auth-benefit-keep-work'),
    ).toBeVisible();
    await expect(credits).toHaveCount(0);
    await expect(modal).not.toContainText('free AI credits every day');
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).toHaveCount(0);

    // --- Confirmed guest --------------------------------------------------
    const guest = await window.evaluate(async (consent) => {
      const next = await window.api.startCanopyGuestSession(consent);
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      return next;
    }, GUEST_CONSENT);
    expect(guest.credentialSource).toBe('guest');

    await openSidebarSignIn(window);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Keep the work you've done as a guest");

    // No credits row; the "already available" subheading is gone and no
    // generic subheading takes its place.
    await expect(credits).toHaveCount(0);
    await expect(modal).not.toContainText('free AI credits every day');
    await expect(modal).not.toContainText('already available');
    await expect(modal).not.toContainText(
      'Sign in to get your free AI credits',
    );
    await expect(modal).not.toContainText(
      'Connect your account to access team features',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Vertical rhythm of the sign-in pitch. The lead line used to sit 24px below
// the title and 20px above the benefit list — near enough to equidistant that
// it read as belonging to neither. It is the title's supporting line, so it now
// sits tight under the title with a full group break before the benefit rows.
// Asserted as relationships rather than magic pixel counts so a change to the
// spacing scale does not have to be mirrored here.
test('attaches the sign-in lead to the title, with a clear break before the benefits', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Measured on the guest presentation: it carries no header subheading, so
    // the gap under the header is the raw title-to-lead distance the report was
    // about.
    await window.evaluate(async (consent) => {
      await window.api.startCanopyGuestSession(consent);
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    }, GUEST_CONSENT);

    await openSidebarSignIn(window);
    await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
    await expect(
      window.getByTestId('cloud-auth-benefit-share-team'),
    ).toBeVisible();

    const gaps = await window.evaluate(() => {
      const modal = document.querySelector('[data-testid="cloud-sync-modal"]');
      const oauth = modal?.querySelector(
        '[data-testid="settings-account-canopy-cloud-oauth"]',
      );
      // The guest presentation has no subheading, so the <h2> is the last
      // thing in the header and this is the whitespace band under the title.
      const title = modal?.querySelector('h2');
      const lead = oauth?.querySelector('p');
      const list = oauth?.querySelector('ul');
      const rows = list ? Array.from(list.querySelectorAll('li')) : [];
      const cta = modal?.querySelector(
        '[data-testid="settings-account-canopy-cloud-oauth-login"]',
      );
      const gap = (a, b) =>
        a && b
          ? Math.round(
              b.getBoundingClientRect().top - a.getBoundingClientRect().bottom,
            )
          : null;
      return {
        titleToLead: gap(title, lead),
        leadToList: gap(lead, list),
        rowToRow: gap(rows[0], rows[1]),
        listToCta: gap(list, cta),
      };
    });

    for (const [name, value] of Object.entries(gaps)) {
      expect(value, `${name} should be measurable`).not.toBeNull();
    }

    // The lead belongs to the title, so it sits nearer the title than the list
    // by a margin wide enough to read as attachment. Merely "less than" is what
    // the reported layout already satisfied at 24px vs 20px, near enough to
    // equidistant that the line appeared to float between the two.
    expect(gaps.titleToLead * 2).toBeLessThanOrEqual(gaps.leadToList);
    // The break before the list is a real group boundary, not just another
    // row-sized step.
    expect(gaps.leadToList).toBeGreaterThan(gaps.rowToRow);
    // Both group boundaries (pitch -> benefits, benefits -> action) are equal,
    // so the action block is never separated by less than the benefits are.
    expect(gaps.listToCta).toBe(gaps.leadToList);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3459: an organization's rules govern only that organization's work, and
// a fresh sign-in lands in Personal. Signing in with an account whose org
// requires every scope shows no activity-sharing prompt, and the org's
// requirement is never written into the member's own preference.
test('signs in without an activity-sharing prompt when an org manages every scope', async () => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy({
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await openSidebarSignIn(window);
    await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
    await window
      .getByTestId('settings-account-canopy-cloud-mode-api-key')
      .click();
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-input')
      .fill(ALL_LOCKED_API_KEY);
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-submit')
      .click();

    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(window.getByTestId('telemetry-optin-modal')).toHaveCount(0);
    const account = await window.evaluate(async () =>
      window.api.loadCanopyCloudAccount(),
    );
    expect(account.hasApiKey).toBe(true);
    const preferences = await window.evaluate(async () =>
      window.api.loadPreferences(),
    );
    for (const dataType of ['metadata', 'plans', 'summaries', 'transcripts']) {
      expect(preferences.telemetrySharing[dataType]).not.toBe('organization');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
