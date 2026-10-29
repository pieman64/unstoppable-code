import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
  writeJson,
} from './seeders/index.mjs';

// Doc 2 Spec 5 (usage half) follow-up — retained per-account usage snapshots
// (Tasks 1-4) add a collapsible "Other account snapshots" section to
// each provider card on the Usage page. This spec exercises that section end
// to end: it seeds a retained snapshot for a DIFFERENT Codex account than the
// one the mock auth/usage surface reports as active, then verifies the
// section toggles open and the single-account branch renders that account's
// usage distinctly from the active account's usage.
//
// Codex-only, same determinism rationale as `provider-usage-live.spec.mjs`:
// the Codex usage path is fully mocked (account + ratelimits), so it's
// deterministic across machines/CI. The Claude usage path depends on a real
// `claude auth status` shell-out and is not asserted here.

const OTHER_RESETS_AT = '2099-01-01T00:00:00.000Z'; // genuinely future → passes the live prune + renderer filter
const OTHER_ACCOUNT_KEY = 'codex:previous@example.com:pro';

/**
 * Resolve the provider usage card `<article>` by its provider heading text
 * (`Codex` / `Claude`). `ProviderUsageCards.tsx` renders one `<article>` per
 * provider with an `<h2>` carrying the provider label.
 */
function providerCard(window, providerLabel) {
  return window
    .locator('article')
    .filter({ has: window.getByRole('heading', { name: providerLabel }) });
}

test('Codex card shows a retained other-account snapshot distinct from the active account', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));

  // Pre-seed the retained "other" Codex account snapshot BEFORE launch so the
  // startup observability snapshot load picks it up.
  writeJson(path.join(userDataDir, 'agent-observability', 'snapshot.json'), {
    version: 1,
    historicalMode: 'forward-only',
    retentionDays: 7,
    recentEntries: [],
    usage: {
      updatedAt: new Date().toISOString(),
      providers: [],
      accountSnapshots: [
        {
          provider: 'codex',
          accountKey: OTHER_ACCOUNT_KEY,
          accountEmail: 'previous@example.com',
          accountLabel: 'previous@example.com',
          subscriptionLabel: 'pro',
          rateLimits: [
            {
              limitId: 'codex',
              limitName: 'codex',
              primary: {
                usedPercent: 55,
                resetsAt: OTHER_RESETS_AT,
                windowDurationMins: 300,
              },
            },
          ],
          capturedAt: '2026-07-08T00:00:00.000Z',
        },
      ],
    },
  });

  // Register the ACTIVE Codex account scenario (a different email,
  // tester@example.com, so the seeded snapshot above is a non-active "other").
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'mock', {
    authUsage: { scenario: 'authed-low-usage' },
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.openUsagePage();

    const codexCard = providerCard(window, 'Codex');
    await expect(codexCard).toBeVisible({ timeout: 30_000 });

    await codexCard
      .getByRole('button', { name: 'Refresh Codex usage' })
      .click();

    // Confirm the active account is tester@example.com (not the seeded
    // "other" account) by waiting for the low-usage scenario's primary
    // percentage to land.
    await expect
      .poll(async () => (await codexCard.innerText()).replace(/\s+/g, ' '), {
        timeout: 30_000,
      })
      .toContain('Usage: 10.0%');

    const toggle = codexCard.getByTestId(
      'other-account-snapshots-toggle-codex',
    );
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    await expect(codexCard).toContainText(
      'Usage snapshots collected from recently used accounts where reset windows are still relevant.',
    );

    const accountLabel = codexCard.getByTestId('other-account-single-codex');
    await expect(accountLabel).toContainText('Pro');
    await expect(accountLabel).toContainText('previous@example.com');

    // The single-account branch renders the OTHER account's meter/text,
    // distinct from the active 10.0%, without a picker interaction.
    await expect(codexCard).toContainText('Usage: 55.0%');

    await window.screenshot({
      path: testInfo.outputPath('usage-other-account-snapshots.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, 'mock').catch(() => undefined);
  }
});
