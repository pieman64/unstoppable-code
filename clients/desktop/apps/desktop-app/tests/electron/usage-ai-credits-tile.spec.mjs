import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readBrandAppName } from './helpers/brand-app-name.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// AI Credits usage tile (CAN — "Add AI Credits tile to the Usage page").
//
// The Usage page stacks provider cards vertically and appends a self-contained
// AI Credits tile last (`AiCreditsUsageCard.tsx`). The tile self-hides unless a
// UD account resolves for the connected cloud account, so we first connect the
// mock cloud account (any `csk_`-prefixed key resolves via the shared cloud mock
// at 127.0.0.1:4011, which also serves the AI-credits subscription/balance:
// `Pro` subscription + 1,234 credits — see mock-server/routes/cloud.mjs), then
// open the Usage page and assert the tile renders with the shared paygo-vs-
// subscription chip and the remaining balance.

const TEST_CLOUD_API_KEY = 'csk_usage_ai_credits_tile_e2e';
// Empty personal wallet covered by an org credit pool — the state that used to
// render a bare "0 credits" while the org was paying.
const ORG_FUNDED_CLOUD_API_KEY = 'csk_org_funded_credits_e2e';
const ORG_FUNDED_ID = '66666666-6666-4666-8666-666666666666';

/** The org-funded account, as a member with a switchable Acme E2E context. */
function orgFundedScenario() {
  return {
    cloud: {
      organizations: [
        {
          id: ORG_FUNDED_ID,
          name: 'Acme E2E',
          role: 'MEMBER',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  };
}

test.describe('Usage page AI Credits tile', () => {
  test('renders the AI Credits tile last with the plan chip and balance once the cloud account is connected', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-usage-ai-credits-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_UD_OAUTH_ENV: 'production',
      },
    });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });

      // Connect the mock cloud account so `loadCanopyCloudAiCredits()` resolves a
      // native balance (otherwise the tile self-hides). Since native billing
      // (CAN-1557) the tile no longer gates on the AI Credits routing mode.
      await connectMockCloudAccount(win, TEST_CLOUD_API_KEY);

      await app.openUsagePage();

      const usagePage = win.getByTestId('page-usage');
      await expect(usagePage).toBeVisible({ timeout: 30_000 });

      const creditsTile = win.getByTestId('usage-card-ai-credits');
      await expect(creditsTile).toBeVisible({ timeout: 30_000 });

      // Group heading: the brand app name and its plan, as a provider group
      // names the provider and its plan (`<brand> · Pro`). The title is
      // checked against the built brand's display name (see helpers/brand-app-name.mjs),
      // which stays brand-agnostic without degrading to a non-empty check.
      const brandAppName = readBrandAppName();
      const creditsHeading = creditsTile.locator('h2').first();

      // Plan: the native entitlements grant maps to the `Pro` plan (from
      // `/api/v1/entitlements` via `useSubscriptionStatus`).
      await expect(
        win.getByTestId('usage-card-ai-credits-plan-chip'),
      ).toHaveText('Pro');
      await expect(creditsHeading).toHaveText(`${brandAppName} · Pro`);

      // Remaining balance figure (1,234 credits from the cloud mock).
      await expect(win.getByTestId('usage-card-ai-credits-balance')).toHaveText(
        '1,234 credits',
      );

      // The native Usage UI no longer opens these legacy storefront URLs.
      // Verify the retained compatibility payload across the real preload/IPC
      // boundary without replacing today's native billing action.
      const storefrontState = await win.evaluate(() =>
        window.api.loadCanopyCloudAiCredits(),
      );
      expect(storefrontState.connected).toBe(true);
      expect(storefrontState.purchaseUrl).toBe(
        'https://unstoppabledomains.com/account/ai-credits?purchase=1',
      );
      expect(storefrontState.manageUrl).toBe(
        'https://unstoppabledomains.com/account/ai-credits',
      );

      // A subsequent failed balance read keeps the same connected account's
      // last-known amount visible beside the actionable error notice.
      await registerScenario(DEFAULT_MOCK_BASE_URL, TEST_CLOUD_API_KEY, {
        cloud: { aiCreditsBalanceHttpStatus: 503 },
      });
      // The Usage page's one refresh control (in its heading) reads AI
      // Credits again along with every provider.
      await usagePage.getByTestId('usage-refresh').click();
      await expect(win.getByTestId('usage-card-ai-credits-error')).toBeVisible({
        timeout: 30_000,
      });
      await expect(win.getByTestId('usage-card-ai-credits-balance')).toHaveText(
        '1,234 credits',
      );
      // The UD billing copy was replaced with native brand copy (CAN-1557).
      await expect(creditsTile).not.toContainText('Unstoppable Domains');

      // The tile is the LAST usage group in the vertical stack.
      const cards = usagePage.locator('section[aria-labelledby]');
      await expect(cards.last()).toHaveAttribute(
        'data-testid',
        'usage-card-ai-credits',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, TEST_CLOUD_API_KEY).catch(
        () => undefined,
      );
    }
  });

  test('shows the covering organization and demotes the personal zero when an org pool funds the account', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-usage-ai-credits-org-'),
    );
    // CAN-3463: the tile follows the selected context, and an org pool covers
    // only that org's work, so the account needs a switchable Acme E2E context.
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      ORG_FUNDED_CLOUD_API_KEY,
      orgFundedScenario(),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-org-projects-enabled': true,
        }),
      },
    });

    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });

      // This key makes the cloud mock serve an empty personal wallet plus an
      // eligible org credit pool (see mock-server/routes/cloud.mjs).
      await connectMockCloudAccount(win, ORG_FUNDED_CLOUD_API_KEY);
      await selectWorkspaceContext(win, ORG_FUNDED_ID);

      await app.openUsagePage();
      await expect(win.getByTestId('page-usage')).toBeVisible({
        timeout: 30_000,
      });

      const creditsTile = win.getByTestId('usage-card-ai-credits');
      await expect(creditsTile).toBeVisible({ timeout: 30_000 });

      // The headline names the payer instead of reporting the personal wallet…
      await expect(win.getByTestId('usage-card-ai-credits-balance')).toHaveText(
        'Covered by Acme E2E',
        { timeout: 30_000 },
      );
      // …and the zero stays, labelled as the thing it actually describes. The
      // Usage page is an itemized view, so unlike the chat banner it keeps both.
      await expect(
        win.getByTestId('usage-card-ai-credits-personal-balance'),
      ).toHaveText('Personal balance: 0 credits');
      await expect(creditsTile).not.toContainText('Remaining: 0 credits');

      await registerScenario(DEFAULT_MOCK_BASE_URL, ORG_FUNDED_CLOUD_API_KEY, {
        cloud: {
          ...orgFundedScenario().cloud,
          aiCreditsBalanceHttpStatus: 503,
        },
      });
      await win.getByTestId('page-usage').getByTestId('usage-refresh').click();
      await expect(win.getByTestId('usage-card-ai-credits-error')).toBeVisible({
        timeout: 30_000,
      });
      await expect(win.getByTestId('usage-card-ai-credits-balance')).toHaveText(
        'Covered by Acme E2E',
      );
      await expect(
        win.getByTestId('usage-card-ai-credits-personal-balance'),
      ).toHaveText('Personal balance: 0 credits');
      await expect(creditsTile).not.toContainText('Remaining: 0 credits');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        ORG_FUNDED_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  });
});
