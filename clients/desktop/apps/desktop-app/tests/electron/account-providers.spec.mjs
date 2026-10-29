import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture as createCodexFixture,
  protocolRequests,
} from './codexPipelineRuntime.mjs';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';
import { injectSecureStorageFault } from './secureStorageFixture.mjs';

// Doc 2 — Spec 12 / Doc 14: Account-tab provider coverage gaps.
//
//   - PR 722: GitHub auth panel (CLI-Managed <-> PAT toggle, PAT input,
//     sign-in terminal modal, permissions list, GH_TOKEN env-override
//     warning).
//   - PR 740: Canopy Cloud "connected" state (mock `csk_*` API key resolves to
//     the authed account; success status dot).
//   - PR 793: Canopy Cloud OAuth-mode "waiting for browser sign-in" + cancel.
//   - PR 1262: Account settings section labels and provider ordering.
//
// CAN-4421: with hosted account settings on (the launcher default), GitHub
// and Linear live on the hosted Integrations page and the Canopy Cloud
// sign-in on the hosted Account page ("On this computer" cards); the local
// Accounts page becomes "Providers" with the LLM providers only. The legacy
// Accounts order is asserted with the rollout flag off.
//
// All testids asserted here already exist in:
//   - apps/desktop-app/src/renderer/src/components/auth/ProviderAuthPanel.tsx
//   - apps/desktop-app/src/renderer/src/components/settings/AuthLoginModal.tsx
//   - apps/desktop-app/src/renderer/src/components/settings/AccountTab.tsx
//
// The Canopy Cloud mock lives in the shared suite-wide mock server
// (apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs), started by the
// Playwright `webServer` config at 127.0.0.1:4011. It accepts any `csk_`-prefixed
// Bearer key and returns the canned authed account
// (`portal-e2e@example.test`, name "Portal E2E").
//
// OAuth (793) scope: this spec leaves the build-gated external-open receiver
// unset, so `openExternalGuarded(authorizeUrl)` remains a no-op and the renderer
// stays in the deterministic pending/cancel state. The real fresh-browser
// Unstoppable sign-in, PKCE callback, token exchange, and desktop persistence
// are covered by portal/portal-desktop-oauth-login.spec.mjs.

const TEST_CLOUD_API_KEY = 'csk_account_providers_e2e';

const HOSTED_SETTINGS_OFF_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-hosted-settings': false,
  }),
};

test.describe('Account providers (Spec 12, PRs 722/740/793)', () => {
  test('CAN-3220 GitHub PAT read Retry refreshes permissions and connection listeners', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pat-read-retry-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        GH_EXECUTABLE: writeUnauthenticatedGhFixture(userDataDir),
      },
    });
    let restore;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      expect(
        await window.evaluate(() =>
          window.api.saveGitHubPat('ghp_read_retry_e2e'),
        ),
      ).toEqual({ success: true });
      restore = await injectSecureStorageFault(electronApp, 'probe-failed');
      // Observe the production notification without replacing bridge methods.
      await window.evaluate(() => {
        document.documentElement.dataset.githubConnectionEvents = '0';
        window.addEventListener('canopy:github-connection-changed', () => {
          document.documentElement.dataset.githubConnectionEvents = String(
            Number(document.documentElement.dataset.githubConnectionEvents) + 1,
          );
        });
      });
      if (process.platform === 'linux') {
        // A blank same-origin frame shares the compositor but has no React or
        // credential listeners. Both must receive frames while the native
        // automation window stays hidden, before the first normal click.
        const frames = await window.evaluate(async () => {
          const iframe = document.createElement('iframe');
          iframe.style.cssText =
            'position:fixed;width:1px;height:1px;top:0;left:0;opacity:0.01;pointer-events:none;border:0';
          await new Promise((resolve) => {
            iframe.onload = resolve;
            document.body.append(iframe);
          });
          const sample = (view) =>
            new Promise((resolve) => {
              let count = 0;
              const start = view.performance.now();
              const timer = view.setTimeout(
                () =>
                  resolve({ count, elapsed: view.performance.now() - start }),
                1000,
              );
              const tick = () => {
                count += 1;
                if (count === 2) {
                  view.clearTimeout(timer);
                  resolve({ count, elapsed: view.performance.now() - start });
                } else view.requestAnimationFrame(tick);
              };
              view.requestAnimationFrame(tick);
            });
          try {
            return await Promise.all([
              sample(window),
              sample(iframe.contentWindow),
            ]);
          } finally {
            iframe.remove();
          }
        });
        await test.info().attach('linux-compositor-frames', {
          body: Buffer.from(JSON.stringify(frames)),
          contentType: 'application/json',
        });
        expect(frames.map((sample) => sample.count)).toEqual([2, 2]);
        const nativeWindow = await electronApp.browserWindow(window);
        expect(await nativeWindow.evaluate((win) => win.isVisible())).toBe(
          false,
        );
      }
      await app.openSettings();
      await app.openAccountSettingsPage('integrations');
      const panel = window.getByTestId('auth-panel-github');
      await expect(panel.getByTestId('secure-storage-notice')).toBeVisible();
      await panel
        .getByRole('button', { name: 'Personal access token', exact: true })
        .click();
      await expect(panel).not.toContainText('Checking GitHub permissions');
      const permissions = panel.getByTestId('settings-github-permissions-list');
      await expect(permissions).toHaveCount(0);
      await expect(window.locator('html')).toHaveAttribute(
        'data-github-connection-events',
        '0',
      );
      await restore();
      await panel.getByTestId('secure-storage-retry').click();
      await expect(
        panel.getByTestId('auth-panel-github-pat-input'),
      ).toHaveValue('ghp_read_retry_e2e');
      await expect(panel.getByTestId('secure-storage-notice')).toHaveCount(0);
      await expect(permissions).toBeVisible();
      await expect(
        permissions.getByText('Granted', { exact: true }),
      ).toHaveCount(3);
      await expect(window.locator('html')).toHaveAttribute(
        'data-github-connection-events',
        '1',
      );
    } finally {
      try {
        await restore?.();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });

  test('CAN-3220 Linear read Retry refreshes the still-mounted Home picker', async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    let restore;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // Establish a real encrypted credential, then fail its native read.
      expect(
        await window.evaluate(() =>
          window.api.saveLinearToken('lin_api_retry_e2e'),
        ),
      ).toEqual({ success: true });
      restore = await injectSecureStorageFault(electronApp, 'probe-failed');
      await window.reload();
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      const picker = home.getByTestId('home-branch-picker-button');
      await picker.click();
      await window.getByTestId('home-branch-picker-tab-issues').click();
      await expect(
        window.getByTestId('home-branch-picker-issues-connect'),
      ).toBeVisible();
      await window.getByTestId('home-branch-picker-issues-connect').click();
      // The connect row opens the hosted Integrations page's Linear card.
      await app.expectAccountSettingsPage('integrations');
      const account = window.getByTestId(
        'account-device-settings-integrations',
      );
      const linearSection = window.getByTestId('account-device-card-linear');
      await expect(
        linearSection.getByTestId('secure-storage-notice'),
      ).toBeVisible();
      await restore();
      await linearSection.getByTestId('secure-storage-retry').click();
      await expect(
        linearSection.getByTestId('secure-storage-notice'),
      ).toHaveCount(0);
      await expect(
        account.getByTestId('settings-linear-token-input'),
      ).toHaveValue('lin_api_retry_e2e');
      await app.closeSettings();
      // Do not reload or navigate away: Home's mount-time token was empty.
      await picker.click();
      await window.getByTestId('home-branch-picker-tab-issues').click();
      await expect(
        window.getByTestId('home-branch-picker-issues-connect'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('home-branch-picker-search'),
      ).toHaveAttribute('placeholder', 'Search Linear issues…');
      await expect(
        window.getByText('Search Linear by id or title…', { exact: true }),
      ).toBeVisible();
    } finally {
      try {
        await restore?.();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });

  // ── PR 1262: Account settings provider sections and ordering ─────────────
  // The legacy Accounts page (hosted account settings off).
  test('1262: Account settings groups cloud, LLM, version control, and project management panels in order', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-account-order-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: HOSTED_SETTINGS_OFF_ENV,
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');

      const accountTab = win.getByTestId('settings-tab-account');
      await expect(accountTab).toBeVisible();
      await expect(
        win.getByTestId('settings-account-canopy-cloud-section'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(win.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(win.getByTestId('auth-panel-codex')).toBeVisible();
      await expect(win.getByTestId('auth-panel-github')).toBeVisible();
      await expect(win.getByTestId('settings-linear-token-input')).toBeVisible({
        timeout: 20_000,
      });

      // The page is a stack of sections (`SettingsPage` > sections); each
      // section is its heading row, when it has one, over one group box whose
      // direct children are the provider rows. Every row is accounted for, so
      // a stray row or a wrapper around rows still fails the order.
      const accountStackOrder = await accountTab.evaluate((root) => {
        const identify = (row) => {
          const has = (selector) =>
            row.matches(selector) || row.querySelector(selector) !== null;
          if (has('[data-testid="settings-account-canopy-cloud-section"]')) {
            return 'cloud-account';
          }
          for (const provider of ['claude', 'codex', 'github']) {
            if (has(`[data-testid="auth-panel-${provider}"]`)) {
              return provider;
            }
          }
          if (has('[data-testid="settings-linear-token-input"]')) {
            return 'linear';
          }
          return (row.textContent ?? '').replace(/\s+/g, ' ').trim();
        };
        const sections = Array.from(
          root.querySelectorAll(':scope > div > section'),
        );
        return sections.flatMap((section) =>
          Array.from(section.children).flatMap((child) => {
            const header = child.querySelector(
              '[data-testid^="account-section-header-"]',
            );
            if (header) {
              return [(header.textContent ?? '').replace(/\s+/g, ' ').trim()];
            }
            return Array.from(child.children).map(identify);
          }),
        );
      });

      expect(accountStackOrder).toEqual([
        'cloud-account',
        'LLM provider',
        'claude',
        'codex',
        'Version control',
        'github',
        'Project management',
        'linear',
      ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-4421: with hosted account settings on, the same section is Providers:
  // the LLM providers only, with no cloud, GitHub or Linear rows.
  test('Providers lists only the LLM providers when hosted account settings are on', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-providers-order-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');
      const providers = win.getByTestId('settings-tab-account');
      await expect(
        providers.getByRole('heading', { name: 'Providers', exact: true }),
      ).toBeVisible();
      await expect(providers.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(providers.getByTestId('auth-panel-codex')).toBeVisible();
      const headers = await providers
        .locator('[data-testid^="account-section-header-"]')
        .allTextContents();
      expect(headers.map((text) => text.trim())).toEqual(['LLM provider']);
      for (const testId of [
        'settings-account-canopy-cloud-section',
        'auth-panel-github',
        'settings-linear-token-input',
        'settings-daily-credit-drip',
      ]) {
        await expect(providers.getByTestId(testId)).toHaveCount(0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // ── PR 722: GitHub auth panel (no env override) ──────────────────────────
  test('722: GitHub panel toggles CLI-Managed <-> PAT, opens the login terminal modal, and renders permissions for a stored PAT', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-gh-panel-'),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      },
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openAccountSettingsPage('integrations');

      const githubPanel = win.getByTestId('auth-panel-github');
      await expect(githubPanel).toBeVisible();
      await expect(githubPanel).toContainText('GitHub');
      // CAN-4457: the panel's GitHub mark is the official Octicon.
      await expect(
        githubPanel.locator('svg[data-glyph="mark-github"]').first(),
      ).toBeVisible();

      // The mode toggle initializes once the stored-PAT load resolves. With no
      // stored PAT the panel defaults to CLI-Managed (OAuth) mode, so the PAT
      // input is absent and the connect button is present.
      const patInput = win.getByTestId('auth-panel-github-pat-input');
      const cliManagedButton = githubPanel.getByRole('button', {
        name: 'CLI Managed',
      });
      const patButton = githubPanel.getByRole('button', {
        name: 'Personal Access Token',
      });
      await expect(cliManagedButton).toBeVisible();
      await expect(patButton).toBeVisible();

      // Toggle CLI-Managed -> PAT: the PAT input appears.
      await patButton.click();
      await expect(patInput).toBeVisible();

      // Enter a classic-style PAT so the (mock-backed) permissions probe has a
      // token to read scopes from. `ghp_`-prefixed tokens are treated as
      // classic tokens, so the permissions list renders from the mock
      // `/user` `x-oauth-scopes` header.
      await patInput.fill('ghp_e2e_account_providers_token');

      // The permissions list resolves once the debounced PAT save lands and the
      // probe hits the mocked GitHub API (CANOPY_GITHUB_API_BASE_URL → 4011).
      const permissionsList = win.getByTestId(
        'settings-github-permissions-list',
      );
      await expect(permissionsList).toBeVisible({ timeout: 20_000 });
      await expect(githubPanel).not.toContainText(
        'Unable to verify GitHub permissions',
      );
      await expect(githubPanel).not.toContainText('Missing');
      await expect(
        permissionsList.getByText('repo', { exact: true }),
      ).toBeVisible();
      await expect(
        permissionsList.getByText('read:org', { exact: true }),
      ).toBeVisible();
      await expect(
        permissionsList.getByText('workflow', { exact: true }),
      ).toBeVisible();
      await expect(
        permissionsList.getByText('Granted', { exact: true }),
      ).toHaveCount(3);

      // Toggle back PAT -> CLI-Managed: the PAT input disappears and the
      // connect button (auth-panel-github-connect) is shown.
      await cliManagedButton.click();
      await expect(patInput).toHaveCount(0);

      const connectButton = win.getByTestId('auth-panel-github-connect');
      await expect(connectButton).toBeVisible();
      // Deliberately no text assertion here. This button's label reads
      // `ghStatus?.authenticated`, which comes from `checkGitHubCliStatus()`
      // running the real `gh auth status` against the host's own
      // ~/.config/gh/hosts.yml with Canopy's PAT injection stripped -- the
      // stored PAT does NOT decide it. On a machine (or CI runner) with no
      // `gh auth login`, this button reads "Sign in", not "Change account",
      // so asserting either arm here is host-dependent. The canonical label is
      // pinned deterministically by the `GH_EXECUTABLE`-backed test below.

      // Open the GitHub sign-in terminal modal and assert its structure
      // (terminal host, status footer, and a way to cancel/close).
      await connectButton.click();
      const loginModal = win.getByTestId('auth-login-modal');
      await expect(loginModal).toBeVisible();
      await expect(win.getByTestId('auth-login-terminal')).toBeVisible();
      await expect(win.getByTestId('auth-login-status')).toBeVisible();

      // Modal surfaces intentionally share the semantic modal tier. Verify
      // the nested login dialog actually receives pointer targeting instead
      // of coupling this behavior test to distinct numeric z-index values.
      expect(
        await loginModal.evaluate((dialog) => {
          const rect = dialog.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit !== null && dialog.contains(hit);
        }),
      ).toBe(true);

      // The "Other account snapshots" footer toggle is claude/codex-only and
      // gated on at least one retained snapshot; GitHub has none, so it must
      // not render in the GitHub login modal.
      await expect(win.getByTestId('auth-login-snapshots-toggle')).toHaveCount(
        0,
      );

      // The modal closes via the DialogModal shell. The `auth-login-cancel`
      // button only appears in the terminal "login-failed" view; while the
      // terminal is running we dismiss via the DialogModal close (X) button,
      // which routes through the same onClose handler the cancel button uses.
      // Escape is intentionally NOT used here: the login terminal focuses
      // xterm on mount, and when `gh auth login` is interactively prompting
      // (the CI case) xterm consumes the Escape keypress before the
      // settings overlay's document-level Escape handler can see it.
      await win
        .getByRole('dialog', { name: 'Sign in to GitHub' })
        .getByRole('button', { name: 'Close' })
        .click();
      await expect(loginModal).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // ── PR 722: GitHub env-override (GH_TOKEN) warning ───────────────────────
  test('722: GitHub panel surfaces the env-override warning when GH_TOKEN masks the credential store', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-gh-envoverride-'),
    );
    const ghFixturePath = path.join(userDataDir, 'gh-fixture');
    writeFileSync(
      ghFixturePath,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' \'{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"e2e-user","tokenSource":"GH_TOKEN","gitProtocol":"https"}]}}\'',
      ].join('\n'),
      'utf8',
    );
    chmodSync(ghFixturePath, 0o755);

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        GH_EXECUTABLE: ghFixturePath,
        GH_TOKEN: 'ghp_e2e_env_override_masking_token',
      },
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openAccountSettingsPage('integrations');

      const githubPanel = win.getByTestId('auth-panel-github');
      await expect(githubPanel).toBeVisible();

      // The panel defaults to CLI-Managed (OAuth) mode (no stored PAT). In that
      // mode an active GH_TOKEN env source renders the env-override warning and
      // hides the sign-in button.
      await expect(
        win.getByTestId('provider-auth-env-override-warning'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        win.getByTestId('provider-auth-env-override-warning'),
      ).toContainText('GH_TOKEN');
      // Sign in / Change account is suppressed while an env var masks the
      // store.
      await expect(win.getByTestId('auth-panel-github-connect')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // ── Canonical auth CTA copy: the unauthenticated arm ────────────────────
  //
  // `ProviderAuthPanel` renders `authenticated ? 'Change account' : <label>`.
  // The authenticated arm is asserted in the 722 test above; this covers the
  // other arm, which is the one an earlier migration left reading "Login".
  // Host `gh` state would otherwise decide which arm renders, so this pins it
  // with a GH_EXECUTABLE fixture that reports an empty credential store.
  //
  // The same fixture fails `gh auth login`, which drives the login modal into
  // its "login did not complete" view — the third surface whose retry button
  // carries the label, selected structurally via `auth-login-submit`.
  test('renders the canonical sign-in label on the unauthenticated provider panel and the failed-login retry', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-signin-label-'),
    );
    const ghFixturePath = writeUnauthenticatedGhFixture(userDataDir);

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        GH_EXECUTABLE: ghFixturePath,
        // GH_TOKEN/GITHUB_TOKEN are deliberately NOT listed. launchCanopy's
        // buildElectronEnv deletes them only when the spec does not supply
        // them, so passing '' would opt out of that scrub and leave them
        // present-but-empty instead of unset.
      },
    });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openAccountSettingsPage('integrations');

      const githubPanel = win.getByTestId('auth-panel-github');
      await expect(githubPanel).toBeVisible();

      // Unauthenticated arm of the label ternary. Exact text, so "Login",
      // "Log in", "Sign In", and a bare "Sign-in" all fail here.
      const connectButton = win.getByTestId('auth-panel-github-connect');
      await expect(connectButton).toBeVisible({ timeout: 20_000 });
      await expect(connectButton).toHaveText('Sign in');

      // The failed-login retry carries the same label.
      await connectButton.click();
      await expect(win.getByTestId('auth-login-modal')).toBeVisible();
      const retryButton = win.getByTestId('auth-login-submit');
      await expect(retryButton).toBeVisible({ timeout: 30_000 });
      await expect(retryButton).toHaveText('Sign in');
      await expect(win.getByTestId('auth-login-cancel')).toBeVisible();

      await win.getByTestId('auth-login-cancel').click();
      await expect(win.getByTestId('auth-login-modal')).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // ── CAN-3701: what carried over under a connected provider ────────────
  test('3701: a signed-in Claude row says what carried over from Claude Code', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-carryover-'),
    );
    // The harness relocates CLAUDE_CONFIG_DIR under provider-state; a skill
    // there is what a Claude chat reads natively.
    const skill = path.join(
      userDataDir,
      'provider-state',
      'claude',
      'skills',
      'review',
    );
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      path.join(skill, 'SKILL.md'),
      '---\nname: review\ndescription: Review\n---\nReview.\n',
    );
    const fixture = createCodexFixture('provider-carryover');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      // Auth probes and the native Codex process are fixtures. The app still
      // reads Claude skills from disk and discovers Codex items over its RPC.
      await electronApp.evaluate(({ ipcMain }) => {
        for (const channel of [
          'settings:claude-auth-status',
          'settings:codex-auth-status',
        ]) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => ({
            authenticated: true,
            accountLabel: 'fixture@example.test',
            detail: null,
            error: null,
          }));
        }
      });
      const win = await electronApp.firstWindow();
      await win.reload();
      const app = new CanopyAppDriver(win);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('account');
      const note = win.getByTestId('provider-carryover-claude');
      await expect(note).toBeVisible({ timeout: 20_000 });
      await expect(note).toHaveText('1 skill ready');
      // The Codex fixture reports no skills or plugins, so the row explains
      // what will carry over without depending on a locally installed CLI.
      await expect(win.getByTestId('provider-carryover-codex')).toHaveText(
        'Skills and plugins you add to Codex are ready in your Codex chats.',
      );
      const requests = protocolRequests(fixture.logPath);
      expect(requests.map(({ method }) => method)).toEqual(
        expect.arrayContaining(['skills/list', 'plugin/list']),
      );
      await test.info().attach('codex-carryover-protocol', {
        body: JSON.stringify(requests, null, 2),
        contentType: 'application/json',
      });
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  // ── PR 740: Canopy Cloud connected state (mock csk_* API key) ────────────
  test('740: saving a mock csk_* API key shows the Canopy Cloud section connected with a success status dot', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-cloud-connected-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });

      // Save a mock API key directly. The cloud mock returns the authed account
      // for any `csk_`-prefixed key, so the saved credential resolves to
      // account metadata (manual / api_key credential source).
      await connectMockCloudAccount(win, TEST_CLOUD_API_KEY, {
        expectedAccount: {
          account: { email: 'portal-e2e@example.test' },
        },
      });

      await app.openSettings();
      await app.openAccountSettingsPage('account');

      const cloudSection = win.getByTestId(
        'settings-account-canopy-cloud-section',
      );
      await expect(cloudSection).toBeVisible();

      // A manual/legacy saved key initializes the section in API-key mode and
      // renders the connected account state.
      await expect(
        win.getByTestId('settings-account-canopy-cloud-api-key'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(cloudSection).toContainText(
        'Signed in as Portal E2E (portal-e2e@example.test)',
      );

      // The success (green) status dot is present once connected.
      const statusDot = win.getByTestId(
        'settings-account-canopy-cloud-status-dot',
      );
      await expect(statusDot).toBeVisible();
      await expect(statusDot).toHaveClass(/bg-success/);

      // The Settings→Account UD AI-Credits card was removed with the native
      // billing cutover (CAN-1557), so no AI-Credits sub-panel renders here.
      await expect(
        win.getByTestId('settings-account-ai-credits-card'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // ── PR 793: Canopy Cloud OAuth-mode waiting + cancel flow ────────────────
  test('793: Canopy Cloud OAuth mode shows the waiting-for-browser state and cancel clears it', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-cloud-oauth-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const win = await electronApp.firstWindow();
      const app = new CanopyAppDriver(win);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openAccountSettingsPage('account');

      const cloudSection = win.getByTestId(
        'settings-account-canopy-cloud-section',
      );
      await expect(cloudSection).toBeVisible();

      // OAuth is the default for a new user, and the segmented mode toggle is
      // gone — the pane itself renders once the (no-credential) account load
      // resolves, with the manual key demoted to a link inside it.
      const oauthPane = win.getByTestId('settings-account-canopy-cloud-oauth');
      await expect(oauthPane).toBeVisible({ timeout: 20_000 });
      await expect(
        win.getByTestId('settings-account-canopy-cloud-mode-api-key'),
      ).toBeVisible();

      // Start the OAuth login. `openExternalGuarded` no-ops under E2E and the
      // loopback callback never fires, so the renderer stays in the pending
      // "Waiting for browser sign-in…" state with a Cancel control.
      await win
        .getByTestId('settings-account-canopy-cloud-oauth-login')
        .click();

      const cancelButton = win.getByTestId(
        'settings-account-canopy-cloud-oauth-cancel',
      );
      await expect(cancelButton).toBeVisible({ timeout: 20_000 });
      await expect(cancelButton).toBeFocused();
      await expect(oauthPane).toContainText('Waiting for browser sign-in');

      // Cancel clears the pending state: the cancel button disappears and the
      // pane returns to the idle "Sign in" prompt.
      await cancelButton.click();
      await expect(cancelButton).toHaveCount(0);
      await expect(oauthPane).not.toContainText('Waiting for browser sign-in');
      const loginButton = win.getByTestId(
        'settings-account-canopy-cloud-oauth-login',
      );
      await expect(loginButton).toBeVisible();
      await expect(loginButton).toHaveText('Sign in');
      await expect(loginButton).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
