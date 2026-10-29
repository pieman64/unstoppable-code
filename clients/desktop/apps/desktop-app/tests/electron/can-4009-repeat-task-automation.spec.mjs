import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedCoworkWorkspace, writeJson } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const HISTORY_STORAGE_KEY = 'canopy:repeat-task-history:v1';
const OFFER_TITLE = 'Turn this into an automation?';
const OFFER_MESSAGE =
  "You've run a similar task before. Make it an automation to run it on a schedule.";
const FIRST_TASK =
  'Summarize open support tickets from Monday and draft a status report';
const SIMILAR_TASK =
  'Summarize open support tickets from Tuesday 10/14 and draft a status report';
const DISSIMILAR_TASK = 'Refactor the billing webhook retry logic';
const EXPECTED_SIMILAR_TASK_NAME =
  'Summarize open support tickets from Tuesday 10/14 and draft…';

function seedInAppNotificationsOff(userDataDir) {
  // The offer is its own card, not a notification: it shows with in-app
  // notifications off.
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { inAppNotifications: { enabled: false } },
  });
}

async function readLoadedSuggestionsSetting(window) {
  return window.evaluate(() =>
    window.api
      .loadPreferences()
      .then(
        (preferences) => preferences.repeatTaskAutomationSuggestionsEnabled,
      ),
  );
}

async function sendHomeTask(window, prompt) {
  await window.getByTestId('sidebar-create-task').click();
  const home = window.getByTestId('page-home');
  await expect(home.getByTestId('home-workspace-select')).toContainText(
    'Seeded Cowork',
  );

  const editor = home.getByTestId('home-composer-editor');
  await editor.fill(prompt);
  await expect(editor).toHaveText(prompt);
  await home.getByTestId('home-send-button').click();
  await expect(home).toHaveCount(0);
  await expect(window.locator('[data-role="user"]').last()).toHaveText(prompt, {
    timeout: 60_000,
  });
}

async function historyEntryCount(window) {
  return window.evaluate((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.length : -1;
    } catch {
      return -1;
    }
  }, HISTORY_STORAGE_KEY);
}

async function waitForHistoryEntryCount(window, expected) {
  await expect
    .poll(() => historyEntryCount(window), { timeout: 15_000 })
    .toBe(expected);
}

function offerCard(window) {
  return window.getByTestId('repeat-task-automation-offer');
}

async function expectNoOffer(window) {
  await expect(offerCard(window)).toHaveCount(0);
}

async function installAutomationCreateCounter(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__can4009AutomationCreateCount = 0;
    ipcMain.removeHandler('automations:create');
    ipcMain.handle('automations:create', () => {
      globalThis.__can4009AutomationCreateCount += 1;
      return {
        ok: false,
        error: 'Unexpected automation creation in CAN-4009 test',
      };
    });
  });
}

test.describe('CAN-4009 repeat-task automation offer', () => {
  test('offers a prefilled automation draft for a similar Home task without saving it', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4009-repeat-task-offer-'),
    );
    seedCoworkWorkspace({ userDataDir });
    seedInAppNotificationsOff(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await installAutomationCreateCounter(electronApp);

      await sendHomeTask(window, FIRST_TASK);
      await waitForHistoryEntryCount(window, 1);
      await expectNoOffer(window);

      await sendHomeTask(window, SIMILAR_TASK);
      const card = offerCard(window);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText(OFFER_TITLE);
      await expect(card).toContainText(OFFER_MESSAGE);
      await expect(window.getByTestId('toast-meta-title')).toHaveCount(0);
      await window.getByTestId('repeat-task-automation-offer-create').click();
      await expectNoOffer(window);

      const shell = window.getByTestId('workflow-edit-shell');
      await expect(shell).toHaveAttribute('data-kind', 'automation');
      const definition = window.getByTestId('workflow-edit-section-definition');
      await expect(definition).toBeVisible();
      await expect(definition.getByTestId('automations-form-name')).toHaveValue(
        EXPECTED_SIMILAR_TASK_NAME,
      );
      await expect(
        definition.getByTestId('automations-form-prompt'),
      ).toContainText(SIMILAR_TASK);
      await expect(
        definition.getByTestId('automations-form-workspace'),
      ).toContainText('Seeded Cowork');
      expect(
        await electronApp.evaluate(
          () => globalThis.__can4009AutomationCreateCount,
        ),
      ).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not offer an automation for a dissimilar second Home task', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4009-repeat-task-dissimilar-'),
    );
    seedCoworkWorkspace({ userDataDir });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

      await sendHomeTask(window, FIRST_TASK);
      await waitForHistoryEntryCount(window, 1);
      await expectNoOffer(window);

      await sendHomeTask(window, DISSIMILAR_TASK);
      await waitForHistoryEntryCount(window, 2);
      await window.waitForTimeout(750);
      await expectNoOffer(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Not now resolves the task so its next repeat does not offer again', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4009-repeat-task-not-now-'),
    );
    seedCoworkWorkspace({ userDataDir });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });

      await sendHomeTask(window, FIRST_TASK);
      await waitForHistoryEntryCount(window, 1);
      await sendHomeTask(window, SIMILAR_TASK);
      await expect(offerCard(window)).toBeVisible({ timeout: 15_000 });
      await window.getByTestId('repeat-task-automation-offer-dismiss').click();
      await expectNoOffer(window);
      await expect(window.getByTestId('workflow-edit-shell')).toHaveCount(0);

      await sendHomeTask(window, FIRST_TASK);
      await window.waitForTimeout(750);
      await expectNoOffer(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('turning the setting off forgets recorded tasks and stops recording', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4009-repeat-task-setting-'),
    );
    seedCoworkWorkspace({ userDataDir });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await sendHomeTask(window, FIRST_TASK);
      await waitForHistoryEntryCount(window, 1);

      await app.openSettings();
      await app.openSettingsSection('canopy');
      const row = window.getByTestId('settings-repeat-task-suggestions');
      await expect(row).toContainText('Suggest automations for repeated tasks');
      const toggle = window.getByTestId(
        'settings-repeat-task-suggestions-toggle',
      );
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      await expect.poll(() => readLoadedSuggestionsSetting(window)).toBe(false);
      await waitForHistoryEntryCount(window, null);
      await app.closeSettings();

      await sendHomeTask(window, FIRST_TASK);
      await sendHomeTask(window, SIMILAR_TASK);
      await window.waitForTimeout(750);
      await expectNoOffer(window);
      expect(await historyEntryCount(window)).toBeNull();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
