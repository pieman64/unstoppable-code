import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

// Doc 2 — Spec 12: provider account / auth surface (PRs 722 / 740 / 793).
//
// This file exercises the build-gated AUTH mock (no chat turn, no live agent).
// Under an E2E build (`if (__CANOPY_E2E__)`), the desktop app redirects its
// Claude auth-status probe at the shared mock server's control plane:
//
//   - `checkClaudeAuthStatus` (apps/desktop-app/src/main/ipc/settings.ts) fetches
//     `GET /__mock/claude/auth` with `Authorization: Bearer <CANOPY_MOCK_API_KEY>`.
//     `launchCanopy.mjs` sets `CANOPY_MOCK_API_KEY=mock`, so the auth scenario
//     KEY the app sends is the literal string `mock`.
//
// The Settings → Accounts Claude row
// (apps/desktop-app/src/renderer/.../auth/ProviderAuthPanel.tsx) renders the
// resolved `AgentProviderAuthStatus` from `getClaudeAuthStatus`. When
// `loggedIn: true`, the row's status line leads with the email
// (`accountLabel`) and plan beside a green status dot (PR #5101 dropped the
// "Signed in as" prefix). When `loggedIn: false` it shows
// the not-authenticated error copy.
//
// Mock scenario shape (routes/authUsage.mjs): a scenario registered under key
// `mock` with `{ authUsage: { scenario: 'authed-low-usage' } }` (a named entry
// in that route's SCENARIO_LIBRARY) yields `claude.auth.loggedIn = true` and
// `claude.auth.email = 'tester@example.com'`. The `unauthenticated` named
// scenario yields `claude.auth.loggedIn = false`.
//
// Codex uses the same build-gated control plane. In an E2E build, its Account
// panel must resolve `/__mock/codex/account` and must never fall through to a
// real app-server or CLI auth probe. Requiring the scenario email on the Account
// tab proves the UI is driven by the mock account rather than host credentials.

const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;
// The app sends `Bearer ${CANOPY_MOCK_API_KEY ?? 'mock'}` for both the Claude
// auth probe and the Codex usage probe; launchCanopy.mjs sets it to `mock`.
const SCENARIO_KEY = 'mock';

async function registerScenario(key, scenario) {
  // The shared mock server is started by Playwright's `webServer` block and its
  // `/healthz` URL is reachable before tests run; a small retry absorbs any
  // brief cold-start window so registration never races the server boot.
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, scenario }),
      });
      if (!response.ok) {
        throw new Error(
          `Mock scenario register responded ${response.status}: ${await response.text()}`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Failed to register mock scenario after retries: ${String(lastError)}`,
  );
}

async function clearScenario(key) {
  await fetch(`${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

test.describe('Account auth surface (Spec 12, PRs 722/740/793)', () => {
  test('authed scenario: Claude and Codex panels use mock identities; Canopy Cloud section renders', async () => {
    await registerScenario(SCENARIO_KEY, {
      authUsage: { scenario: 'authed-low-usage' },
    });

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-auth-authed-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');

      // ---- Claude auth panel — authenticated via /__mock/claude/auth. ----
      const claudePanel = win.getByTestId('auth-panel-claude');
      await expect(claudePanel).toBeVisible();

      // The status hook resolves asynchronously, so poll the authenticated
      // status line: `accountLabel` is the mock email.
      await expect
        .poll(
          async () =>
            (await claudePanel.textContent())?.includes('tester@example.com') ??
            false,
          { timeout: 20_000 },
        )
        .toBe(true);
      // The green (success) status dot is present once authenticated.
      await expect(
        claudePanel.locator('span.bg-success').first(),
      ).toBeVisible();
      // No not-authenticated destructive copy in this state.
      await expect(claudePanel.locator('.fg-destructive')).toHaveCount(0);

      // ---- Codex authentication panel — build-gated mocked account. ----
      const codexPanel = win.getByTestId('auth-panel-codex');
      await expect(codexPanel).toBeVisible();
      await expect(
        codexPanel.locator('[data-settings-row-label]'),
      ).toContainText('Codex');
      await expect
        .poll(
          async () =>
            (await codexPanel.textContent())?.includes('tester@example.com') ??
            false,
          { timeout: 20_000 },
        )
        .toBe(true);
      await expect(codexPanel.locator('span.bg-success').first()).toBeVisible();

      // ---- Canopy Cloud section structure (cloud mock already wired). ----
      // CAN-4421: the cloud sign-in is the hosted Account page's device card.
      await app.openAccountSettingsPage('account');
      const cloudSection = win.getByTestId(
        'settings-account-canopy-cloud-section',
      );
      await expect(cloudSection).toBeVisible();
      // The OAuth pane (and its "Use an API key instead" link, which replaced
      // the segmented toggle) renders once the (not-connected) account load
      // resolves.
      await expect(
        win.getByTestId('settings-account-canopy-cloud-oauth'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        win.getByTestId('settings-account-canopy-cloud-status-dot'),
      ).toBeVisible();

      // ---- Usage page: Codex account authenticated via /__mock/codex/account. ----
      await app.closeSettings();
      await app.openUsagePage();

      // The Codex provider card surfaces `authState: 'authenticated'` and the
      // `Account: <email>` line sourced from the mock GetAccountResponse
      // (`account: { type: 'chatgpt', email: 'tester@example.com' }`).
      await expect
        .poll(
          async () => {
            const usageRoot = win.getByTestId('page-usage');
            const text = (await usageRoot.textContent()) ?? '';
            return (
              text.includes('authenticated') &&
              text.includes('tester@example.com')
            );
          },
          { timeout: 25_000 },
        )
        .toBe(true);
      // Claude provider card is also authenticated from the same scenario.
      await expect(win.getByTestId('page-usage')).toContainText('Claude');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(SCENARIO_KEY);
    }
  });

  test('unauthenticated scenario: Claude and Codex panels show the not-authenticated state', async () => {
    await registerScenario(SCENARIO_KEY, {
      authUsage: { scenario: 'unauthenticated' },
    });

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-auth-unauth-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');

      const claudePanel = win.getByTestId('auth-panel-claude');
      await expect(claudePanel).toBeVisible();

      // `loggedIn: false` → buildClaudeAuthStatusFromPayload sets
      // `error: 'Claude is not authenticated.'`. The panel renders that
      // destructive copy and never shows the authenticated line.
      await expect
        .poll(
          async () =>
            (await claudePanel.textContent())?.includes(
              'Claude is not authenticated.',
            ) ?? false,
          { timeout: 20_000 },
        )
        .toBe(true);
      await expect(claudePanel).not.toContainText('tester@example.com');
      // The destructive status dot is present; no success dot in this state.
      await expect(
        claudePanel.locator('span.bg-destructive').first(),
      ).toBeVisible();
      await expect(claudePanel.locator('span.bg-success')).toHaveCount(0);

      const codexPanel = win.getByTestId('auth-panel-codex');
      await expect(codexPanel).toBeVisible();
      await expect
        .poll(
          async () =>
            (await codexPanel.textContent())?.includes(
              'Codex is not authenticated.',
            ) ?? false,
          { timeout: 20_000 },
        )
        .toBe(true);
      await expect(codexPanel).not.toContainText('tester@example.com');
      await expect(
        codexPanel.locator('span.bg-destructive').first(),
      ).toBeVisible();
      await expect(codexPanel.locator('span.bg-success')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(SCENARIO_KEY);
    }
  });
});
