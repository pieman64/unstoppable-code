// A new guest's Home composer must default to a model the guest may run.
//
//   pnpm exec playwright test guest-default-model.spec.mjs --reporter=line
//
// A first launch with no provider CLI signed in rides the AI Credits lane. Its
// primary candidate is DeepSeek; when that does not route, the signed-in
// fallback is GPT 5.5, which the LLM proxy refuses for guests. A guest must be
// seeded with an allowlisted model instead (DeepSeek V4 Pro, then GPT 6 Luna,
// GPT 5.6 Luna or Haiku 5.5, whichever routes first), so the very first send
// does not fail.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';

// The app's default mock scenario key; scoping the signed-out provider state to
// it keeps the shared guest-mint route intact.
const AUTH_KEY = 'mock';
const GUEST_ALLOWED_LABELS =
  /GPT 6 Luna|GPT 5\.6 Luna|DeepSeek V4 Pro|Haiku 5\.5/;
const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

test('seeds a new guest with a model the guest may run', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-guest-default-model-'),
  );
  // Provider CLIs signed out, so the default rides the AI Credits lane.
  await registerScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      // A host API credential is a real native lane even when mock probes say signed out.
      OPENAI_API_KEY: '',
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-guest-mode-enabled': true,
        'canopy-billing-enabled': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

    // A device-scoped guest credential, then the broadcast the renderer's
    // guest flag listens on, exactly as a first-launch guest mint does.
    const account = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(account.credentialSource).toBe('guest');
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    const home = window.getByTestId('page-home');
    await expect(home.getByTestId('home-composer-editor')).toBeVisible({
      timeout: 30_000,
    });
    const picker = home
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    // The seed settles once the auth probes and credits read land.
    await expect(picker).toHaveText(GUEST_ALLOWED_LABELS, { timeout: 30_000 });
    await expect(picker).not.toContainText('GPT 5.5');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, AUTH_KEY).catch(() => {});
  }
});
