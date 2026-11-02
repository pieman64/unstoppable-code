// CAN-5222. Run headlessly:
// pnpm run test:electron:built can-5222-scoped-share-recovery.spec.mjs
// Only transport/provider responses are replaced; recovery uses real UI and IPC.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startCloudOAuthLoopbackFixture } from './cloudOAuthLoopbackFixture.mjs';
import { registerShareMembership } from './seeders/index.mjs';
import {
  installScopedShareFailure,
  openRecoveryShare,
  RECOVERY_SKILL_ID,
  restoreScopedShareFetch,
  setScopedShareMode,
} from './scoped-share-recovery-fixture.mjs';

const SAVED_KEY = 'csk_can5222_expired';

async function withRecovery(mode, saved, run) {
  const fixture = await startCloudOAuthLoopbackFixture();
  fixture.releaseAccount();
  fixture.releaseGuestLink();
  let launched;
  try {
    launched = await launchCanopy({ env: fixture.env });
    const { electronApp } = launched;
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    if (saved) {
      await registerShareMembership(SAVED_KEY);
      await window.evaluate(
        (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        SAVED_KEY,
      );
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
    }
    await installScopedShareFailure(electronApp, mode);
    await openRecoveryShare(electronApp);
    await run({ electronApp, window, fixture });
  } finally {
    if (launched) {
      try {
        await restoreScopedShareFetch(launched.electronApp);
      } finally {
        await closeCanopy(launched.electronApp, launched.userDataDir);
      }
    }
    await fixture.stop();
  }
}

async function completeSignIn(window, fixture) {
  await window.getByTestId('settings-account-canopy-cloud-oauth-login').click();
  const authorize = new URL(await fixture.nextExternalUrl());
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'loopback-code');
  callback.searchParams.set('state', authorize.searchParams.get('state'));
  await fetch(callback);
}

async function expectOriginalShare(window) {
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          window.__canopyNavigationTestApi.getPendingShareInstall()?.externalId,
      ),
    )
    .toBe(RECOVERY_SKILL_ID);
}

async function expectRecovered(window) {
  const landing = window.getByTestId('deep-link-share-landing');
  await expect(landing).toContainText('Recovered scoped skill');
  await expect(landing.getByTestId('deep-link-share-install')).toBeEnabled();
}

test('CAN-5222 signed-out recovery preserves the share across cancellation and sign-in', async () => {
  await withRecovery(401, false, async ({ electronApp, window, fixture }) => {
    const signIn = window.getByTestId('deep-link-share-sign-in');
    await signIn.click();
    const gate = window.getByTestId('cloud-sync-modal');
    await expect(gate).toBeVisible();
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    await expectOriginalShare(window);
    await gate.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(signIn).toBeVisible();
    await signIn.click();
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-login')
      .click();
    await fixture.nextExternalUrl();
    await window
      .getByTestId('settings-account-canopy-cloud-oauth-cancel')
      .click();
    await expectOriginalShare(window);
    await setScopedShareMode(electronApp, 'success');
    await completeSignIn(window, fixture);
    await expectRecovered(window);
  });
});

for (const [status, action] of [
  [401, 'sign-in'],
  [403, 'switch-account'],
]) {
  test(`CAN-5222 scoped ${status} opens usable account management and recovers`, async () => {
    await withRecovery(
      status,
      true,
      async ({ electronApp, window, fixture }) => {
        await window.getByTestId(`deep-link-share-${action}`).click();
        const settings = window.getByTestId('settings-overlay');
        await expect(settings).toBeVisible();
        await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(
          0,
        );
        await expectOriginalShare(window);
        await window
          .getByTestId('settings-account-canopy-cloud-mode-oauth')
          .click();
        const login = window.getByTestId(
          'settings-account-canopy-cloud-oauth-login',
        );
        await expect(login).toBeEnabled();
        await setScopedShareMode(electronApp, 'success');
        await completeSignIn(window, fixture);
        await expect
          .poll(() =>
            window.evaluate(
              async () =>
                (await window.api.loadCanopyCloudAccount()).serverApiKeyId,
            ),
          )
          .toBe('loopback-key');
        await window.keyboard.press('Escape');
        await expect(settings).toBeHidden();
        await expectRecovered(window);
      },
    );
  });
}

test('CAN-5222 replacing an expired manual key for the same account recovers', async () => {
  await withRecovery(401, true, async ({ electronApp, window }) => {
    const before = await window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    await window.getByTestId('deep-link-share-sign-in').click();
    const settings = window.getByTestId('settings-overlay');
    await expect(settings).toBeVisible();
    await expectOriginalShare(window);
    const replacementKey = 'csk_can5222_replacement';
    await registerShareMembership(replacementKey);
    await setScopedShareMode(electronApp, 'success');
    await window
      .getByTestId('settings-account-canopy-cloud-api-key-input')
      .fill(replacementKey);
    await expect
      .poll(() => window.evaluate(() => window.api.loadCanopyCloudAccount()))
      .toMatchObject({
        credentialSource: 'manual',
        account: { id: before.account.id },
        createdAt: before.createdAt,
        updatedAt: expect.not.stringMatching(before.updatedAt),
      });
    await window.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expectRecovered(window);
  });
});

test('CAN-5222 repeated network failure stays actionable and a pending Retry cannot overlap', async () => {
  await withRecovery('network', true, async ({ electronApp, window }) => {
    const retry = window.getByTestId('deep-link-share-retry');
    await expect(retry).toBeVisible();
    await setScopedShareMode(electronApp, 'network-pending');
    await retry.click();
    await expect(retry).toHaveCount(0);
    await setScopedShareMode(electronApp, 'network');
    await expect(retry).toBeVisible();
    await setScopedShareMode(electronApp, 'pending');
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => typeof globalThis.__can5222.release === 'function',
        ),
      )
      .toBe(true);
    await setScopedShareMode(electronApp, 'success');
    await expectRecovered(window);
    expect(
      await electronApp.evaluate(() => globalThis.__can5222.publicReads),
    ).toBe(3);
  });
});

test('CAN-5222 scoped 404 is neutral and offers no recovery primary', async () => {
  await withRecovery(404, true, async ({ window }) => {
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText(
      "This share isn't available. It may no longer exist, or you may not have access.",
    );
    await expect(landing).not.toContainText(/revoked|organization/i);
    for (const action of ['sign-in', 'switch-account', 'retry', 'install']) {
      await expect(
        landing.getByTestId(`deep-link-share-${action}`),
      ).toHaveCount(0);
    }
  });
});

test('CAN-5222 failed authentication leaves the original share recoverable', async () => {
  await withRecovery(401, false, async ({ electronApp, window, fixture }) => {
    await electronApp.evaluate(() => {
      globalThis.__can5222.failAuth = true;
    });
    await window.getByTestId('deep-link-share-sign-in').click();
    await completeSignIn(window, fixture);
    await expect(
      window.getByTestId('settings-account-canopy-cloud-oauth-login'),
    ).toBeEnabled();
    await expectOriginalShare(window);
    await window
      .getByTestId('cloud-sync-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('deep-link-share-sign-in')).toBeVisible();
  });
});

test('CAN-5222 marketplace detail routes Sign in through the same recovery hook', async () => {
  await withRecovery(401, false, async ({ electronApp, window, fixture }) => {
    await expect(window.getByTestId('deep-link-share-sign-in')).toBeVisible();
    await window
      .getByTestId('deep-link-share-landing')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    const app = new CanopyAppDriver(window);
    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-skill').click();
    await window.getByTestId('plugins-search').fill('recovered-skill');
    await window
      .getByTestId(`plugins-entry-public-share:skill:${RECOVERY_SKILL_ID}`)
      .click();
    const detail = window.getByTestId('plugins-entry-detail');
    await expect(detail.getByTestId('deep-link-share-sign-in')).toBeVisible();
    await detail.getByTestId('deep-link-share-sign-in').click();
    await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
    await setScopedShareMode(electronApp, 'success');
    await completeSignIn(window, fixture);
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(detail.getByTestId('deep-link-share-install')).toBeEnabled();
    await expect(detail.getByTestId('deep-link-share-error')).toHaveCount(0);
  });
});
