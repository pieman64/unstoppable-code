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

function listPreferencesBackups(userDataDir) {
  return readdirSync(userDataDir).filter((name) =>
    /^preferences\.backup-.+\.json$/.test(name),
  );
}

test('backs up corrupt preferences, restores the last-good copy, and reports recovery in the UI', async () => {
  const userDataDir = createUserDataDir();
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const lastGoodPath = path.join(userDataDir, 'preferences.last-good.json');
  writeFileSync(preferencesPath, '{not valid json', 'utf8');
  // The harness skips its consent seed for an unparseable primary, so the
  // last-good copy carries it. Non-default branch settings prove the source.
  writeFileSync(
    lastGoodPath,
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        initializedCuratedPluginDefaults: [],
        legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
        legalConsentTosVersion: '2026-07-06',
        mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
        branchNamePrefixMode: 'custom',
        branchNameCustomPrefix: 'restored/',
        deleteBranchOnArchive: false,
      },
    }),
    'utf8',
  );
  // CAN-5154: no generation record and none in the files, so this is a
  // profile saved only before the record existed, and last-good is restored.

  let electronApp;
  try {
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    const backupNames = listPreferencesBackups(userDataDir);
    expect(backupNames).toHaveLength(1);
    const backupPath = path.join(userDataDir, backupNames[0]);
    const backup = readJson(backupPath);
    expect(backup.__error.reason).toBe('parse');
    expect(backup.__error.filePath).toBe(preferencesPath);
    expect(backup.__error.backupPath).toBe(backupPath);
    expect(backup.__error.restoredFromPath).toBe(lastGoodPath);
    expect(backup.__error.message).toContain('JSON');
    expect(backup.rawContent).toBe('{not valid json');

    // Later startup saves refresh last-good, so compare values, not bytes.
    for (const filePath of [preferencesPath, lastGoodPath]) {
      const persisted = readJson(filePath);
      expect(persisted.version).toBe(1);
      expect(persisted.preferences).toMatchObject({
        branchNamePrefixMode: 'custom',
        branchNameCustomPrefix: 'restored/',
        deleteBranchOnArchive: false,
      });
    }

    // The toast previews only the message start, which names the restore
    // source; the backup's __error above pins the paths the message reports.
    await expect(
      window
        .getByText(
          /^Preferences failed to load, so the last saved preferences were restored from /,
        )
        .first(),
    ).toBeVisible();
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    }
  }
});

test('restores nothing when the generation record shows last-good is stale', async () => {
  const userDataDir = createUserDataDir();
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const lastGoodPath = path.join(userDataDir, 'preferences.last-good.json');
  const generationPath = path.join(userDataDir, 'preferences.generation.json');
  writeFileSync(preferencesPath, '{not valid json', 'utf8');
  writeFileSync(
    lastGoodPath,
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        initializedCuratedPluginDefaults: [],
        legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
        legalConsentTosVersion: '2026-07-06',
        mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
      },
    }),
    'utf8',
  );
  // A later save (generation 1) committed; its last-good refresh did not.
  writeFileSync(
    generationPath,
    JSON.stringify({ version: 1, generation: 1 }),
    'utf8',
  );
  const files = [preferencesPath, lastGoodPath, generationPath];
  const before = files.map((filePath) => readFileSync(filePath, 'utf8'));

  let electronApp;
  try {
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    // Writes are refused, yet the app stays usable (Git detection included).
    await new CanopyAppDriver(window).waitForShell();
    // Saves stay refused, acknowledged notice or not.
    expect(
      await window.evaluate(() =>
        window.api.savePreferences({ sidebarCollapsed: true }).then(
          () => 'saved',
          () => 'refused',
        ),
      ),
    ).toBe('refused');

    expect(files.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(
      before,
    );
    expect(listPreferencesBackups(userDataDir)).toEqual([]);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    }
  }
});

test('refuses preference writes and preserves corrupt preferences without a last-good copy', async () => {
  const userDataDir = createUserDataDir();
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const lastGoodPath = path.join(userDataDir, 'preferences.last-good.json');
  writeFileSync(preferencesPath, '{not valid json', 'utf8');

  let electronApp;
  try {
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();

    // The defaults fallback has no consent, and accepting it is a write.
    await expect(window.getByTestId('legal-consent-gate')).toBeVisible({
      timeout: 30_000,
    });
    await window.getByTestId('legal-consent-checkbox').check();
    await window.getByTestId('legal-consent-accept').click();
    await expect(window.getByTestId('legal-consent-error')).toBeVisible();

    expect(readFileSync(preferencesPath, 'utf8')).toBe('{not valid json');
    expect(existsSync(lastGoodPath)).toBe(false);
    expect(listPreferencesBackups(userDataDir)).toEqual([]);
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
