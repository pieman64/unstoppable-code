import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function getWindowViewportSize(window) {
  return window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

test('launches the built Electron shell', async ({}, testInfo) => {
  const { require: tsRequire } = await import('tsx/cjs/api');
  const gates = tsRequire(
    '../../src/main/lib/w5-recovery-gates.ts',
    import.meta.url,
  );
  const { isW5DaemonFlipCompiled } = tsRequire(
    '../../src/main/lib/w5-flip-gate.ts',
    import.meta.url,
  );
  expect(gates.isW5RecoveryEntryEnabled()).toBe(true);
  expect(isW5DaemonFlipCompiled()).toBe(false);
  expect(gates.isW5RecoveryAvailable()).toBe(false);
  const { electronApp, userDataDir } = await launchCanopy();
  const secureDir = `${userDataDir}-secure`;
  mkdirSync(secureDir, { recursive: true });

  try {
    const isPackaged = await electronApp.evaluate(({ app }) => app.isPackaged);
    expect(isPackaged).toBe(false);
    const mainWindowVisible = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()),
    );
    expect(mainWindowVisible).toBe(false);

    if (process.platform === 'linux') {
      const evidence = await electronApp.evaluate(({ app, safeStorage }) => {
        const available = safeStorage.isEncryptionAvailable();
        const synthetic = 'canopy-linux-synthetic-smoke';
        return {
          schemaVersion: 1,
          electron: process.versions.electron,
          platform: process.platform,
          architecture: process.arch,
          uid: process.getuid(),
          euid: process.geteuid(),
          gid: process.getgid(),
          home: process.env.HOME,
          config: process.env.XDG_CONFIG_HOME,
          data: process.env.XDG_DATA_HOME,
          cache: process.env.XDG_CACHE_HOME,
          state: process.env.XDG_STATE_HOME,
          runtime: process.env.XDG_RUNTIME_DIR,
          sessionRoot: process.env.CANOPY_LINUX_UI_SESSION_ROOT,
          profile: app.commandLine.getSwitchValue('user-data-dir'),
          display: process.env.DISPLAY,
          hasSessionBus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
          passwordStore: app.commandLine.getSwitchValue('password-store'),
          noSandbox: app.commandLine.hasSwitch('no-sandbox'),
          backend: safeStorage.getSelectedStorageBackend(),
          available,
          roundTrip:
            available &&
            safeStorage.decryptString(safeStorage.encryptString(synthetic)) ===
              synthetic,
        };
      });
      await testInfo.attach('linux-launch.json', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      expect(evidence.platform).toBe('linux');
      if (process.env.CANOPY_LINUX_UI_HARNESS_ACCEPTANCE === '1')
        expect(evidence.architecture).toBe('x64');
      expect(evidence.uid).toBeGreaterThan(0);
      expect(evidence.euid).toBeGreaterThan(0);
      for (const [key, directory] of Object.entries({
        home: 'home',
        config: 'config',
        data: 'data',
        cache: 'cache',
        state: 'state',
        runtime: 'runtime',
      }))
        expect(evidence[key]).toBe(path.join(evidence.sessionRoot, directory));
      expect(evidence.profile).toBe(path.join(userDataDir, 'electron-profile'));
      expect(evidence.display).toMatch(/^:/);
      expect(evidence.hasSessionBus).toBe(true);
      expect(evidence.passwordStore).toBe('gnome-libsecret');
      expect(evidence.noSandbox).toBe(false);
      expect(evidence.backend).toBe('gnome_libsecret');
      expect(evidence.available).toBe(true);
      expect(evidence.roundTrip).toBe(true);
    }

    const window = await electronApp.firstWindow();
    // Electron 45 can expose the window before its first commit (blank URL).
    await expect
      .poll(() => window.url(), { timeout: 30_000 })
      .not.toMatch(/^(about:blank)?$/);
    await window.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => getWindowViewportSize(window))
      .toEqual({
        width: 1400,
        height: 900,
      });
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
    // Exercise w5-recovery:status and w5-recovery:prepare through the real
    // preload/main boundary. Exposure is compiled on after registration;
    // actual legacy W5 ownership must still hide entry and prevent intent.
    const recovery = await window.evaluate(async () => ({
      status: await window.api.w5Recovery.getStatus(),
      prepared: await window.api.w5Recovery.prepare(),
    }));
    const hiddenRecovery = { state: 'hidden', canRecover: false, entries: [] };
    expect(recovery).toEqual({
      status: hiddenRecovery,
      prepared: hiddenRecovery,
    });
    // getCanopyDataDir projects the harness-owned CANOPY_DATA_DIR here.
    expect(
      existsSync(path.join(userDataDir, 'runtime/w5-recovery-request.json')),
    ).toBe(false);
    // Main startup has called startCloudProjectBinding. Signed out,
    // cloud-projects:find-link and cloud-projects:link fail closed through
    // the real preload/main boundary without a Cloud request, and an invalid
    // workspace ID is refused before the binding reaches its transport.
    await electronApp.evaluate(() => {
      const original = globalThis.fetch;
      const requests = [];
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/v1/projects')) requests.push(url);
        return original(input, init);
      };
      globalThis.__cloudProjectRequests = requests;
      globalThis.__restoreCloudProjectFetch = () => {
        globalThis.fetch = original;
      };
    });
    const cloudProjectRequests = () =>
      electronApp.evaluate(() => globalThis.__cloudProjectRequests.length);
    try {
      const invalid = await window.evaluate(() =>
        window.api.cloudProjects.findLink('../workspace').then(
          () => 'resolved',
          () => 'rejected',
        ),
      );
      expect(invalid).toBe('rejected');
      expect(await cloudProjectRequests()).toBe(0);
      const signedOut = await window.evaluate(async () => ({
        found: await window.api.cloudProjects.findLink('workspace-1'),
        linked: await window.api.cloudProjects.link({
          workspaceId: 'workspace-1',
          target: { kind: 'new' },
        }),
      }));
      expect(signedOut).toEqual({
        found: { status: 'unavailable', reason: 'signed-out' },
        linked: { ok: false, code: 'unavailable' },
      });
      expect(await cloudProjectRequests()).toBe(0);
    } finally {
      await electronApp.evaluate(() => globalThis.__restoreCloudProjectFetch());
    }
    // A fresh launch (no lastActiveContext MRU, no legacy last-selected
    // worktree) lands on the standalone Home page — the chat-centric surface
    // that replaced the old welcome empty state.
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    const homeDragRegion = homePage.getByTestId('home-titlebar-drag-region');
    if (process.platform === 'linux') {
      await expect(homeDragRegion).toHaveCount(0);
    } else {
      await expect(homeDragRegion).toBeVisible();
      await expect(homeDragRegion).toHaveCSS('-webkit-app-region', 'drag');
    }
    // Scope to page-home: the always-mounted (hidden) MainPage hosts a
    // second embedded HomeSurface.
    await expect(homePage.getByTestId('home-composer')).toBeVisible();
    // The heading is picked at random from a 50-phrase pool per mount
    // (see homeHeadings.ts) — assert the stable testid + non-empty text
    // rather than a specific phrase. Scope to page-home: the always-mounted
    // (hidden) MainPage hosts a second embedded HomeSurface heading.
    const heading = homePage.getByTestId('home-heading');
    await expect(heading).toBeVisible();
    await expect(heading).not.toHaveText('');
    // Hidden BrowserWindows still render and support visual evidence.
    await window.screenshot({ path: testInfo.outputPath('app-launch.png') });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
  expect(existsSync(userDataDir)).toBe(false);
  expect(existsSync(secureDir)).toBe(false);
});

test('can skip applying the default viewport size', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-viewport-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          windowBounds: { x: 100, y: 100, width: 900, height: 600 },
          windowMaximized: false,
          windowFullScreen: false,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: null,
  });

  try {
    const window = await electronApp.firstWindow();
    // Electron 45 can expose the window before its first commit (blank URL).
    await expect
      .poll(() => window.url(), { timeout: 30_000 })
      .not.toMatch(/^(about:blank)?$/);
    await window.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => getWindowViewportSize(window))
      .not.toEqual({
        width: 1400,
        height: 900,
      });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rejects invalid viewport size options', async () => {
  await expect(launchCanopy({ viewportSize: {} })).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
  await expect(
    launchCanopy({ viewportSize: { width: '100%', height: 900 } }),
  ).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
  await expect(launchCanopy({ viewportSize: false })).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
});
