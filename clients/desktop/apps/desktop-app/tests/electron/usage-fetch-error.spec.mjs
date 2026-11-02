import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Usage fetch-error UX: when a provider's usage/rate-limit fetch fails, the
// Usage page must render a classified, friendly notice (with a retry action
// and a collapsed raw-detail disclosure) instead of dumping the raw
// provider/transport error string in red (the pre-change behavior for e.g.
// `failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/
// wham/usage failed: 404 Not Found; content-type=; body=`).
//
// Failure injection uses the WP-MOCK-AUTHUSAGE scenario knobs
// (`claude.usageHttpStatus`, `codex.ratelimitsHttpStatus` in
// mock-server/routes/authUsage.mjs): the auth/account endpoints stay healthy
// while only the usage fetches fail, mirroring the real-world failure mode.
// See provider-usage-live.spec.mjs for how the app reaches this mock surface
// under the build-gated E2E seams.

const USAGE_KEY = 'mock';

const FAILING_SCENARIO = {
  authUsage: {
    claude: {
      auth: {
        loggedIn: true,
        email: 'tester@example.com',
        authMethod: 'oauth',
        subscriptionType: 'max',
      },
      // 500 → classified as a transient `service` failure (retry offered).
      usageHttpStatus: 500,
    },
    codex: {
      account: {
        type: 'chatgpt',
        email: 'tester@example.com',
        planType: 'plus',
      },
      // 404 → classified `unsupported` (no usage data for this account).
      ratelimitsHttpStatus: 404,
    },
  },
};

const UNAUTHENTICATED_CODEX_SCENARIO = {
  authUsage: {
    claude: { auth: { loggedIn: false } },
    codex: {
      account: null,
      // A signed-out production app-server rejects this request. Keeping the
      // forced failure here proves the renderer never sees that avoidable
      // error because observability must stop after account/read confirms the
      // user is signed out.
      ratelimitsHttpStatus: 401,
    },
  },
};

/** A provider's usage group (`claude` / `codex`). */
function providerCard(window, provider) {
  return window.getByTestId(`usage-provider-card-${provider}`);
}

/** The Usage page's one refresh control, in its heading. */
function pageRefreshButton(window) {
  return window.getByTestId('page-usage').getByTestId('usage-refresh');
}

function claudeUsageScenario({
  fiveHour = 42,
  sevenDay = 61,
  usageHttpStatus,
  usageRetryAfterSeconds,
} = {}) {
  return {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: { utilization: fiveHour, resets_at: '+2h' },
          seven_day: { utilization: sevenDay, resets_at: '+5d' },
        },
        ...(usageHttpStatus !== undefined ? { usageHttpStatus } : {}),
        ...(usageRetryAfterSeconds !== undefined
          ? { usageRetryAfterSeconds }
          : {}),
      },
    },
  };
}

test.describe('usage fetch-error UX', () => {
  test('a Claude 429 keeps the last numbers and holds retry until Retry-After passes', async () => {
    test.setTimeout(120_000);

    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      USAGE_KEY,
      claudeUsageScenario(),
    );

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openUsagePage();

      const claudeCard = providerCard(window, 'claude');
      await expect(claudeCard).toBeVisible({ timeout: 30_000 });
      await expect(claudeCard).toContainText('42%', {
        timeout: 30_000,
      });
      await expect(claudeCard).toContainText('61%');

      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        USAGE_KEY,
        claudeUsageScenario({
          usageHttpStatus: 429,
          usageRetryAfterSeconds: 600,
        }),
      );
      await pageRefreshButton(window).click();

      const notice = window.getByTestId('usage-provider-claude-error');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText(/limiting usage checks/i);
      await expect(claudeCard).toContainText('42%');
      await expect(claudeCard).toContainText('61%');
      await expect(
        window.getByTestId('usage-provider-claude-error-retry'),
      ).toBeDisabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('Claude retry recovers once Retry-After passes', async () => {
    test.setTimeout(120_000);

    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      USAGE_KEY,
      claudeUsageScenario(),
    );

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openUsagePage();

      const claudeCard = providerCard(window, 'claude');
      await expect(claudeCard).toBeVisible({ timeout: 30_000 });
      await expect(claudeCard).toContainText('42%', {
        timeout: 30_000,
      });

      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        USAGE_KEY,
        claudeUsageScenario({
          usageHttpStatus: 429,
          usageRetryAfterSeconds: 10,
        }),
      );
      await pageRefreshButton(window).click();

      const notice = window.getByTestId('usage-provider-claude-error');
      const retry = window.getByTestId('usage-provider-claude-error-retry');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(retry).toBeDisabled();
      await expect(retry).toBeEnabled({ timeout: 30_000 });

      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        USAGE_KEY,
        claudeUsageScenario({ fiveHour: 55 }),
      );
      await retry.click();

      await expect(notice).toBeHidden({ timeout: 30_000 });
      await expect(claudeCard).toContainText('55%', {
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('a cold-start Claude 429 does not invent stale usage numbers', async () => {
    test.setTimeout(120_000);

    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      USAGE_KEY,
      claudeUsageScenario({
        usageHttpStatus: 429,
        usageRetryAfterSeconds: 600,
      }),
    );

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openUsagePage();

      const claudeCard = providerCard(window, 'claude');
      const notice = window.getByTestId('usage-provider-claude-error');
      await expect(claudeCard).toBeVisible({ timeout: 30_000 });
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText(/limiting usage checks/i);
      await expect(notice).not.toContainText(/last numbers/i);
      await expect(await claudeCard.innerText()).not.toMatch(
        /\b\d+(?:\.\d+)?%/,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('a signed-out Codex account stays actionable and does not fetch unavailable rate limits', async () => {
    test.setTimeout(120_000);

    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      USAGE_KEY,
      UNAUTHENTICATED_CODEX_SCENARIO,
    );

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openUsagePage();

      const codexCard = providerCard(window, 'codex');
      await expect(codexCard).toBeVisible({ timeout: 30_000 });
      await expect(
        codexCard.getByTestId('usage-provider-codex-account'),
      ).toContainText('Sign in to see usage', { timeout: 30_000 });
      await expect(
        window.getByTestId('usage-provider-codex-error'),
      ).toHaveCount(0);

      const signIn = window.getByTestId('usage-provider-codex-connect');
      await expect(signIn).toHaveText('Sign in');
      await expect(signIn).toBeEnabled();
      await signIn.click();

      const loginDialog = window.getByRole('dialog', {
        name: 'Sign in to Codex',
      });
      await expect(loginDialog).toBeVisible();
      await expect(window.getByTestId('auth-login-modal')).toBeVisible();
      await expect(window.getByTestId('auth-login-cancel')).toBeVisible();
      await window.getByTestId('auth-login-cancel').click();
      await expect(loginDialog).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('opening Usage refreshes every provider in the background without a click', async () => {
    test.setTimeout(120_000);

    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, FAILING_SCENARIO);

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // The first visit sees the failing fetches.
      await app.openUsagePage();
      const claudeNotice = window.getByTestId('usage-provider-claude-error');
      const codexNotice = window.getByTestId('usage-provider-codex-error');
      await expect(claudeNotice).toBeVisible({ timeout: 30_000 });
      await expect(codexNotice).toBeVisible({ timeout: 30_000 });

      // Usage recovers while the user is elsewhere in the app.
      await app.openAuditPage();
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: { scenario: 'authed-near-limit' },
      });

      // Reopening Usage fetches fresh numbers for every provider with no
      // refresh or retry click, and the page never blanks while it does.
      await app.openUsagePage();
      const claudeCard = providerCard(window, 'claude');
      const codexCard = providerCard(window, 'codex');
      await expect(claudeCard).toBeVisible();
      await expect(codexCard).toBeVisible();

      await expect(claudeNotice).toBeHidden({ timeout: 30_000 });
      await expect(codexNotice).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(async () => (await claudeCard.innerText()).replace(/\s+/g, ' '), {
          timeout: 30_000,
        })
        .toContain('92%');
      await expect(window.getByTestId('page-usage')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });

  test('failed usage fetches render friendly notices with raw detail behind a toggle, and retry recovers', async ({}, testInfo) => {
    test.setTimeout(120_000);

    await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, FAILING_SCENARIO);

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openUsagePage();

      // ── Codex: endpoint 404 → `unsupported` notice ─────────────────────
      const codexCard = providerCard(window, 'codex');
      await expect(codexCard).toBeVisible({ timeout: 30_000 });

      const codexNotice = window.getByTestId('usage-provider-codex-error');
      await expect(codexNotice).toBeVisible({ timeout: 30_000 });
      await expect(codexNotice).toContainText(
        "Usage not available. This Codex account doesn't expose usage details.",
      );

      // The raw transport message stays out of the rendered card…
      const codexText = await codexCard.innerText();
      expect(codexText).not.toContain('Mock control plane');
      // …and the redundant no-live-data placeholder is suppressed while the
      // notice explains the gap.
      expect(codexText).not.toContain(
        'No live remaining-limit data is available',
      );

      // Retry is withheld for `unsupported` (retrying cannot help), but the
      // raw detail stays reachable for diagnostics.
      await expect(
        window.getByTestId('usage-provider-codex-error-retry'),
      ).toHaveCount(0);
      const codexDetailsToggle = window.getByTestId(
        'usage-provider-codex-error-details-toggle',
      );
      await expect(codexDetailsToggle).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      // The raw error is unmounted while collapsed, so the toggle names no
      // element until there is one to name.
      await expect(codexDetailsToggle).not.toHaveAttribute(
        'aria-controls',
        /.*/,
      );
      await codexDetailsToggle.click();
      await expect(codexDetailsToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(codexDetailsToggle).toHaveAttribute(
        'aria-controls',
        'usage-provider-codex-error-details',
      );
      const codexDetails = window.getByTestId(
        'usage-provider-codex-error-details',
      );
      await expect(codexDetails).toHaveAttribute(
        'id',
        'usage-provider-codex-error-details',
      );
      await expect(codexDetails).toContainText('responded 404');

      // ── Claude: endpoint 500 → transient `service` notice with retry ───
      const claudeCard = providerCard(window, 'claude');
      await expect(claudeCard).toBeVisible();

      const claudeNotice = window.getByTestId('usage-provider-claude-error');
      await expect(claudeNotice).toBeVisible({ timeout: 30_000 });
      await expect(claudeNotice).toContainText(
        'Claude usage request failed (HTTP 500).',
      );

      await window.screenshot({
        path: testInfo.outputPath('usage-fetch-error-notices.png'),
      });

      // ── Recovery: heal the scenario, retry from the notice ─────────────
      await registerScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY, {
        authUsage: { scenario: 'authed-near-limit' },
      });

      await window.getByTestId('usage-provider-claude-error-retry').click();

      await expect(claudeNotice).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(async () => (await claudeCard.innerText()).replace(/\s+/g, ' '), {
          timeout: 30_000,
        })
        .toContain('92%');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, USAGE_KEY).catch(
        () => undefined,
      );
    }
  });
});
