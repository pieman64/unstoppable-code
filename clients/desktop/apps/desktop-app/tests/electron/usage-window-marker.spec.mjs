import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The small triangle under each Usage meter marks how far through its window
// a limit is, so usage left of it is on pace to last until the reset. The
// Usage redesign must keep it on every window that reports a reset time and
// a window length (Claude's 5-hour and 7-day windows here), and drop it once
// the reset has passed. The shared row renders the same marker in the Portal
// (ProviderQuotaPanel.test.tsx covers that host).

const USAGE_KEY = 'mock';

test('the Usage page marks how far through each window a limit is', async () => {
  test.setTimeout(120_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: { utilization: 30, resets_at: '+2h' },
          seven_day: { utilization: 61, resets_at: '+5d' },
        },
      },
    },
  });
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openUsagePage();

    const claude = window.getByTestId('usage-provider-card-claude');
    await expect(claude).toContainText('61%', { timeout: 30_000 });
    const markers = claude.getByTestId('usage-window-elapsed');
    // One marker under each of the two windows' meters.
    await expect(markers).toHaveCount(2);
    for (const marker of await markers.all()) {
      await expect(marker).toBeVisible();
      await expect(marker).toHaveAttribute(
        'aria-label',
        /^Window elapsed: \d+%$/,
      );
    }
    // A 5-hour window resetting in 2 hours is 60% through.
    await expect(markers.first()).toHaveAttribute(
      'aria-label',
      /^Window elapsed: (59|60|61)%$/,
    );
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
      () => undefined,
    );
    await closeCanopy(electronApp, userDataDir);
  }
});
