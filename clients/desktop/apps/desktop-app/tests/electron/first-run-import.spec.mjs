import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeCanopy,
  launchCanopy,
  prepareIsolatedProviderState,
} from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';
import {
  IMPORT_FIXTURE_FOLDER_PROJECT as FOLDER_PROJECT,
  IMPORT_FIXTURE_GIT_PROJECT as GIT_PROJECT,
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';

// First-run page: a new install (no onboarding marker, no projects) lands on
// "Let's get started" instead of Home. It lists the Claude and Codex projects
// found on the computer, imports the checked ones collapsed in the sidebar,
// and lands in the Home composer. Skipping or finishing records the marker,
// so the page never returns, and an existing install never sees it.
//
// Deterministic: the harness isolates the provider stores (empty unless a
// spec seeds one), and the import fixture seeds a Claude store there. No
// live agents, no network: cloud reads go to the shared mock server.

function seedPreferences(userDataDir, onboardingCompleted) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { onboardingCompleted } }),
  );
}

// Home keeps a hidden composer mounted too; only the visible one counts.
function homeComposer(window) {
  return window.getByTestId('home-composer-editor').locator('visible=true');
}

function readOnboardingCompleted(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences.onboardingCompleted;
}

// A Claude store with no projects. Without it the copy races the app's own
// Claude CLI, which writes this file about a second after launch.
function seedEmptyClaudeStore(userDataDir) {
  prepareIsolatedProviderState(userDataDir);
  writeFileSync(
    path.join(userDataDir, 'provider-state', 'claude', '.claude.json'),
    '{}',
  );
}

function readWorkspaces(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  ).workspaces;
}

test.describe('first-run import page', () => {
  test('imports the checked projects collapsed and lands on Home', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    const fixture = seedExternalProjectImportFixture({ userDataDir });
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(page.getByTestId('auth-panel-codex')).toBeVisible();

      // Older projects start hidden and unchecked; show them all.
      const older = page.getByTestId('first-run-import-older');
      if (await older.isVisible()) await older.click();
      for (const dir of [fixture.gitApp, fixture.notes]) {
        await expect(
          page.getByTestId(
            `first-run-import-row-${externalProjectCandidateIdFor(dir)}`,
          ),
        ).toBeVisible({ timeout: 30_000 });
      }
      const selectAll = page
        .getByTestId('first-run-import-select-all')
        .getByRole('checkbox');
      if (!(await selectAll.isChecked())) await selectAll.check();
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 2 projects');
      await submit.click();

      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect(homeComposer(window)).toBeVisible();
      await expect
        .poll(() =>
          readWorkspaces(userDataDir)
            .filter((entry) =>
              [GIT_PROJECT, FOLDER_PROJECT].includes(entry.name),
            )
            .map((entry) => entry.collapsed),
        )
        .toEqual([true, true]);
      await expect
        .poll(() => readOnboardingCompleted(userDataDir))
        .toContain('first-run-import-v0');

      // The marker keeps the page away after a reload.
      await window.reload();
      await new CanopyAppDriver(window).waitForShell();
      await expect(homeComposer(window)).toBeVisible();
      await expect(page).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('says nothing was found and skips to Home', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, []);
    seedEmptyClaudeStore(userDataDir);
    const launch = await launchCanopy({ userDataDir });
    try {
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      const empty = page.getByTestId('first-run-import-empty');
      await expect(empty).toContainText(
        'No Claude or Codex projects found on this computer',
        { timeout: 30_000 },
      );
      await expect(empty).not.toContainText('on this computer.');
      await expect(
        empty.getByRole('button', { name: 'Choose a folder' }),
      ).toBeVisible();
      await expect(page.getByTestId('first-run-import-submit')).toHaveCount(0);
      const skip = page.getByTestId('first-run-import-skip');
      await expect(skip).toHaveText('Continue');
      await skip.click();
      await expect(page).toHaveCount(0);
      await expect(homeComposer(window)).toBeVisible();
      await expect
        .poll(() => readOnboardingCompleted(userDataDir))
        .toContain('first-run-import-v0');
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });

  test('welcomes a new user with no Claude or Codex', async () => {
    test.setTimeout(180_000);
    const key = 'csk_first_run_no_provider_e2e';
    // The provider probes read this key's scenario: Claude and Codex signed
    // out.
    const authKey = 'first-run-no-provider-unauthenticated';
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        dailyCreditDrip: { enabled: false, decidedAt: null, capCredits: 10 },
      },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, []);
    seedEmptyClaudeStore(userDataDir);
    const folderParent = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-folder-'),
    );
    const folderName = 'first-run-picked-folder';
    const folder = path.join(folderParent, folderName);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'README.md'), '# Picked\n');
    let launch;
    try {
      launch = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_MOCK_API_KEY: authKey,
          // The picked folder lives under the temp dir, which discovery
          // otherwise excludes.
          CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1',
        },
      });
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      // Connecting dispatches the account-changed event, so the page re-reads
      // the drip preference for this scenario's key.
      await connectMockCloudAccount(window, key);

      await expect(page).toContainText(
        /Bring your own subscription or use your .+ account\./,
      );
      for (const provider of ['claude', 'codex']) {
        const row = page.getByTestId(`auth-panel-${provider}`);
        await expect(row).toContainText('Not connected', { timeout: 30_000 });
        await expect(
          page.getByTestId(`auth-panel-${provider}-connect`),
        ).toHaveText('Connect');
      }
      await expect(
        page.locator('[class*="destructive"], [class*="warning"]'),
      ).toHaveCount(0);

      const credits = page.getByTestId('first-run-daily-credits');
      await expect(credits).toBeVisible({ timeout: 30_000 });
      const toggle = page.getByTestId('first-run-daily-credits-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
              .dailyCreditDripEnable ?? 0,
          { timeout: 30_000 },
        )
        .toBe(1);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      await launch.electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await page.getByTestId('first-run-import-choose-folder').click();
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 1 project', { timeout: 30_000 });
      await submit.click();

      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect(homeComposer(window)).toBeVisible();
      await expect
        .poll(() =>
          readWorkspaces(userDataDir).some(
            (entry) => entry.name === folderName,
          ),
        )
        .toBe(true);
    } finally {
      try {
        if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
      } finally {
        await Promise.all(
          [key, authKey].map((scenarioKey) =>
            clearScenario(DEFAULT_MOCK_BASE_URL, scenarioKey).catch(
              () => undefined,
            ),
          ),
        );
      }
    }
  });

  test('an existing install lands on Home', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, ['v1']);
    const launch = await launchCanopy({ userDataDir });
    try {
      const window = await launch.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await expect(homeComposer(window)).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByTestId('first-run-import-page')).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
});
