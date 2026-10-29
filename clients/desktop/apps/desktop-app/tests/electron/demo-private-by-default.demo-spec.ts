// @capture-keep: user journey demo for private-by-default activity sharing on the Free plan
// @capture-reference: apps/desktop-app/tests/electron/privacy-settings.spec.mjs
/**
 * User journey demo: a brand-new Free user signs in and finds every activity
 * sharing scope Off, with nothing to buy to keep it that way.
 *
 *   1. A fresh, signed-out install opens the sign-in modal from the account
 *      menu and connects with an API key (browser OAuth cannot complete
 *      headlessly).
 *   2. Signing in shows no sharing prompt; every row stays Off.
 *   3. The sidebar shows the Free plan.
 *   4. Settings → Privacy shows every row Off and selectable, with no upgrade
 *      prompt, and nothing has been uploaded.
 *   5. Sharing is still the member's choice: picking "Just me" for one row
 *      saves only that row.
 *
 * Writes to `.playwright/demo-private-by-default/`:
 *
 *   private-by-default-<mode>.webm
 *   private-by-default-<mode>.timeline.json
 *   private-by-default-<mode>-steps/*.jpg
 *
 * Run from the repo root (the second line records dark mode):
 *
 *   pnpm run test:electron:demos:built demo-private-by-default.demo-spec.ts --reporter=line
 *   pnpm run test:electron:demos:built demo-private-by-default.demo-spec.ts --reporter=line --dark-mode
 *
 * Determinism: a fresh signed-out user-data dir and a dedicated mock cloud key
 * whose entitlements resolve to the Free plan with no capabilities. The mock
 * records telemetry ingest so the demo also asserts nothing was uploaded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDemo } from './demo/demoDirector.mjs';
import { DEMO_VIEWPORT } from './demo/demoLaunch.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const demoDir = path.join(repoRoot, '.playwright', 'demo-private-by-default');

const API_KEY = 'csk_private_by_default_demo';
const DATA_TYPES = ['metadata', 'plans', 'summaries', 'transcripts'];

const FREE_SCENARIO = {
  cloud: {
    recordTelemetryIngest: true,
    entitlements: {
      plan: { key: 'free', displayName: 'Free' },
      source: 'none',
      trial: null,
      capabilities: [],
      coveringOrgs: [],
      billingManageableOrg: null,
    },
  },
};

/** The signed-out account-menu sign-in action is gated on billing. */
const BILLING_ENABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-billing-enabled': true,
  }),
};

function readTelemetrySharing(userDataDir: string): Record<string, string> {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences.telemetrySharing;
}

async function telemetryIngestCount(): Promise<number> {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    API_KEY,
  );
  return Object.entries(activity as Record<string, number>)
    .filter(([name]) => name.startsWith('telemetryIngest'))
    .reduce((total, [, count]) => total + count, 0);
}

test('demo: a new Free user is private by default', async () => {
  test.setTimeout(300_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, API_KEY, FREE_SCENARIO);
  const { electronApp, userDataDir } = await launchCanopy({
    viewportSize: DEMO_VIEWPORT,
    env: BILLING_ENABLED_ENV,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await expect(window.getByTestId('page-home')).toBeVisible();

    const demo = await startDemo(window, {
      dir: demoDir,
      name: 'private-by-default',
      seed: 11,
      record: process.env.CANOPY_DEMO_RECORD !== '0',
    });
    try {
      await demo.beat('short');
      await demo.caption('A new user signs in for the first time');
      await demo.click(window.getByTestId('sidebar-account-row'));
      await demo.click(
        window.getByTestId('sidebar-account-menu-item-sign-in-out'),
      );
      const signInModal = window.getByTestId('cloud-sync-modal');
      await demo.waitFor(signInModal, { hold: 'short' });
      await demo.step('Sign-in modal');

      await demo.click(
        window.getByTestId('settings-account-canopy-cloud-mode-api-key'),
      );
      await demo.type(
        window.getByTestId('settings-account-canopy-cloud-api-key-input'),
        API_KEY,
      );
      await demo.click(
        window.getByTestId('settings-account-canopy-cloud-api-key-submit'),
      );

      // Signing in asks nothing about sharing: everything starts Off.
      await demo.caption('Signing in asks nothing about sharing');
      await demo.waitFor(
        window
          .getByTestId('toast-meta-title')
          .filter({ hasText: 'Sign in successful' }),
        { hold: 'short' },
      );
      await expect(signInModal).toHaveCount(0);

      await demo.caption('Signed in');
      // The account row shows the name; the email and plan are in the
      // account menu header (CAN-3659).
      const accountIdentity = window.getByTestId('sidebar-account-identity');
      await demo.waitFor(accountIdentity, { hold: 'tiny' });
      await demo.hover(accountIdentity, { dwell: 'read' });
      await demo.click(window.getByTestId('sidebar-account-row'), {
        after: 'tiny',
      });
      await demo.waitFor(
        window
          .getByTestId('sidebar-account-menu-subscription-header')
          .filter({ hasText: 'Free' }),
        { hold: 'short' },
      );
      await demo.step('Free plan');
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('sidebar-account-menu')).toHaveCount(0);
      // The success toast is persistent; close it so it does not cover the
      // Privacy rows below.
      const toast = window
        .getByTestId('toast-card')
        .filter({ hasText: 'Sign in successful' });
      await demo.click(toast.getByRole('button', { name: 'Dismiss' }), {
        after: 'tiny',
      });
      await expect(toast).toHaveCount(0);

      // Settings → Privacy: the persistent controls agree with the prompt.
      await demo.caption('Privacy settings show the same defaults');
      await demo.click(window.getByTestId('sidebar-account-action-settings'));
      await demo.waitFor(window.getByTestId('settings-overlay'));
      await demo.click(window.getByTestId('settings-nav-privacy'));
      await app.expectSettingsSection('privacy');
      for (const dataType of DATA_TYPES) {
        const off = window.getByTestId(`telemetry-sharing-${dataType}-off`);
        await expect(off).toHaveAttribute('aria-pressed', 'true');
        await expect(off).not.toHaveAttribute('aria-disabled', 'true');
      }
      await expect(window.getByTestId('telemetry-subscribe-cta')).toHaveCount(
        0,
      );
      await demo.hover(window.getByTestId('telemetry-sharing-row-plans'), {
        dwell: 'short',
      });
      await demo.hover(
        window.getByTestId('telemetry-sharing-row-transcripts'),
        { dwell: 'read' },
      );
      await demo.step('Privacy tab, all Off');

      await demo.caption('No upgrade needed, and nothing has been uploaded');
      expect(await telemetryIngestCount()).toBe(0);
      expect(readTelemetrySharing(userDataDir)).toEqual(
        Object.fromEntries(DATA_TYPES.map((dataType) => [dataType, 'off'])),
      );
      await demo.beat('read');

      // Sharing stays the member's own choice.
      await demo.caption('Turn on only what you want, when you want');
      await demo.click(
        window.getByTestId('telemetry-sharing-metadata-private'),
      );
      await expect(
        window.getByTestId('telemetry-sharing-metadata-private'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() => readTelemetrySharing(userDataDir))
        .toEqual({
          metadata: 'private',
          plans: 'off',
          summaries: 'off',
          transcripts: 'off',
        });
      await demo.beat('result');
      await demo.step('Work stats set to Just me');
    } finally {
      const result = await demo.finish();
      if (result) {
        console.log(
          `[demo] ${path.relative(repoRoot, result.videoPath)} ` +
            `(${(result.durationMs / 1000).toFixed(1)}s, ${result.frameCount} frames)`,
        );
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, API_KEY);
  }
});
