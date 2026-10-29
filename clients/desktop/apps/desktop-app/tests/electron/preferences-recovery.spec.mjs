import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

function createUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-prefs-e2e-'));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

async function waitForPersistedPreference(filePath, predicate) {
  await expect
    .poll(() => {
      if (!existsSync(filePath)) {
        return false;
      }
      try {
        return predicate(readJson(filePath));
      } catch {
        return false;
      }
    })
    .toBe(true);
}

async function quitElectronApp(electronApp) {
  const closed = electronApp.waitForEvent('close');
  await electronApp
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => undefined);
  await closed.catch(() => undefined);
}

test('backs up corrupt preferences, restores defaults, and reports recovery in the UI', async () => {
  const userDataDir = createUserDataDir();
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  writeFileSync(preferencesPath, '{not valid json', 'utf8');

  let electronApp;
  try {
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // Startup now lands on the Home composer. Recovery notifications remain
    // durable in Overview after their transient toast has expired.
    await app.openOverviewPage();
    // The recovery message renders in both the notification-card body and an
    // inner expandable span, so scope to the first match to avoid a strict-mode
    // ambiguity that surfaces under load.
    await expect(
      window
        .getByText(
          /Preferences failed to load, so defaults were restored\. A backup was created at /,
        )
        .first(),
    ).toBeVisible();

    const entries = readFileSync(preferencesPath, 'utf8');
    const restored = JSON.parse(entries);
    expect(restored.version).toBe(1);
    expect(restored.preferences.branchNamePrefixMode).toBe('github');
    expect(restored.preferences.deleteBranchOnArchive).toBe(true);

    const backupNames = readdirSync(userDataDir).filter((name) =>
      /^preferences\.backup-.+\.json$/.test(name),
    );
    expect(backupNames).toHaveLength(1);

    const backupPath = path.join(userDataDir, backupNames[0]);
    const backup = readJson(backupPath);
    expect(backup.__error.reason).toBe('parse');
    expect(backup.__error.filePath).toBe(preferencesPath);
    expect(backup.__error.backupPath).toBe(backupPath);
    expect(backup.__error.message).toContain('JSON');
    expect(backup.rawContent).toBe('{not valid json');
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    }
  }
});

test('flushes UI preference saves before app quit', async () => {
  const userDataDir = createUserDataDir();
  const preferencesPath = path.join(userDataDir, 'preferences.json');

  let electronApp;
  try {
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // The unified sidebar's hide toggle persists `sidebarCollapsed` (the
    // hidden flag) via the same debounced preferences write. Exactly one
    // `sidebar-toggle` element exists at any time.
    await window.getByTestId('sidebar-toggle').click();
    await waitForPersistedPreference(
      preferencesPath,
      (persisted) => persisted.preferences?.sidebarCollapsed === true,
    );
    await quitElectronApp(electronApp);

    expect(existsSync(preferencesPath)).toBe(true);
    const persisted = readJson(preferencesPath);
    expect(persisted.version).toBe(1);
    expect(persisted.preferences.sidebarCollapsed).toBe(true);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    }
  }
});

test('retries a transient sharing violation while saving a sidebar preference', async () => {
  const userDataDir = createUserDataDir();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await electronApp.evaluate(() => {
      const fs = process.getBuiltinModule('fs/promises');
      const rename = fs.rename;
      globalThis.__can2818RenameFailures = 0;
      fs.rename = async function (source, target) {
        if (
          String(target).endsWith('/preferences.json') &&
          globalThis.__can2818RenameFailures < 2
        ) {
          globalThis.__can2818RenameFailures += 1;
          throw Object.assign(new Error('sharing violation'), {
            code: 'EPERM',
          });
        }
        return rename(source, target);
      };
    });
    await window.getByTestId('sidebar-toggle').click();
    await waitForPersistedPreference(
      path.join(userDataDir, 'preferences.json'),
      (persisted) => persisted.preferences?.sidebarCollapsed === true,
    );
    expect(
      await electronApp.evaluate(() => globalThis.__can2818RenameFailures),
    ).toBe(2);
    expect(
      readdirSync(userDataDir).filter(
        (name) =>
          name.startsWith('.preferences.json.') && name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
