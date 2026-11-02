// CAN-3860: "What's new" release highlights after an app update.
//
// A local HTTP feed provides a deterministic entry. The app runs its real
// main-owned fetch and rendering paths; no production notes are read or written.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  mergeSeedPreferences,
  readPersistedPreferences,
} from './seeders/mergePreferences.mjs';

import {
  exerciseReleaseHighlightsIdle,
  seedReleaseHighlightsResume,
  startDelayedReleaseFeed,
} from './helpers/releaseHighlightsIdle.mjs';

const FIXTURE_VERSION = '99.0.0';
let E2E_WEB_ORIGIN;
let feedServer;
let feedStatus = 200;
let feedRequests = 0;
const publicFeed = {
  schemaVersion: 1,
  entries: [
    {
      version: FIXTURE_VERSION,
      releasedOn: '2026-01-01',
      headline: 'Release highlights E2E fixture for {app}.',
      highlights: [
        {
          title: 'Fixture highlight one',
          description: 'Shown only in UI automation builds.',
        },
        { title: 'Fixture highlight two' },
        {
          title: 'Fixture highlight three',
          description: '{app} keeps this entry out of production.',
        },
      ],
    },
  ],
};
const initialFeedEntries = publicFeed.entries;

test.beforeAll(async () => {
  feedServer = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname !== '/api/v1/release-notes') {
      res.writeHead(404);
      res.end();
      return;
    }
    feedRequests += 1;
    res.writeHead(feedStatus, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    const version = requestUrl.searchParams.get('version');
    res.end(
      JSON.stringify({
        ...publicFeed,
        entries: version
          ? publicFeed.entries.filter((entry) => entry.version === version)
          : publicFeed.entries,
      }),
    );
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  E2E_WEB_ORIGIN = `http://127.0.0.1:${feedServer.address().port}`;
});
test.beforeEach(() => {
  feedStatus = 200;
  feedRequests = 0;
  publicFeed.entries = initialFeedEntries;
});
test.afterAll(async () => {
  await new Promise((resolve) => feedServer.close(resolve));
});

/** Local receiver standing in for the host's default browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // The assertion reports a missing URL.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function upgradedProfile() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-release-highlights-'),
  );
  mergeSeedPreferences(userDataDir, {
    onboardingCompleted: ['v1'],
    legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
    legalConsentTosVersion: '2026-07-06',
    releaseHighlightsLastSeenVersion: '98.0.0',
  });
  return userDataDir;
}

function launchEnv(extra = {}) {
  return {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-shared-release-notes-enabled': true,
    }),
    CANOPY_E2E_APP_VERSION: FIXTURE_VERSION,
    CANOPY_E2E_CLOUD_BASE_URL: E2E_WEB_ORIGIN,
    ...extra,
  };
}

async function expectPersistedVersion(userDataDir, version) {
  await expect
    .poll(
      () =>
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
      { timeout: 15_000 },
    )
    .toBe(version);
}

async function expectAutomaticSettled(window) {
  await expect(window.getByTestId('release-highlights-host')).toHaveAttribute(
    'data-status',
    /^(settled|cancelled|presented)$/,
  );
}

test.describe('release highlights', () => {
  test('automatic notes hold both composer and Workflows tips after closing', async () => {
    test.setTimeout(120_000);
    const userDataDir = upgradedProfile();
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      tabs: [],
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      freshOnboardingTips: true,
      env: launchEnv(),
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 60_000 });
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
      await window
        .getByTestId('release-highlights-dialog')
        .getByRole('button', { name: 'Got it' })
        .click();
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(window.getByTestId('chat-input-plus-button')).toBeVisible();
      await expect(window.getByTestId('chat-input-onboarding-tip')).toHaveCount(
        0,
      );
      await app.openWorkflowsTab('runs');
      await expect(window.getByTestId('page-workflows-runs')).toBeVisible();
      await expect(window.getByTestId('workflows-onboarding-tip')).toHaveCount(
        0,
      );

      // Creating a blank work area succeeds without accepting a user turn.
      // Its Home completion must preserve the automatic notice hold.
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await home.getByTestId('home-composer-editor').fill('   ');
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      await expect(window.getByTestId('chat-input-plus-button')).toBeVisible();
      await app.openWorkflowsTab('runs');
      await expect(window.getByTestId('page-workflows-runs')).toBeVisible();
      await expect(window.getByTestId('workflows-onboarding-tip')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a rollout cycle does not repeat dismissed notes', async () => {
    const userDataDir = upgradedProfile();
    let launched;
    try {
      launched = await launchCanopy({ userDataDir, env: launchEnv() });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 60_000 });
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
      await window.getByTestId('release-highlights-got-it').click();
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);
      const snapshot = await window.evaluate(() =>
        window.api.featureFlags.getSnapshot(),
      );
      // Simulate the main-owned SDK change event through the real preload/store
      // subscription. Static E2E main flags keep the local HTTP feed available.
      const publishRollout = async (enabled) => {
        await launched.electronApp.evaluate(
          ({ BrowserWindow }, next) => {
            for (const target of BrowserWindow.getAllWindows()) {
              target.webContents.send('feature-flags:snapshot-changed', next);
            }
          },
          {
            ...snapshot,
            values: {
              ...snapshot.values,
              'canopy-shared-release-notes-enabled': enabled,
            },
          },
        );
      };
      await app.openSettings();
      await expect(
        window.getByTestId('settings-canopy-whats-new'),
      ).toBeVisible();
      await publishRollout(false);
      await expect(window.getByTestId('settings-canopy-whats-new')).toHaveCount(
        0,
      );
      await publishRollout(true);
      await expect(
        window.getByTestId('settings-canopy-whats-new'),
      ).toBeVisible();
      await app.closeSettings();
      await expectAutomaticSettled(window);
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);
    } finally {
      if (launched) await closeCanopy(launched.electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('disabled rollout hides notes and leaves the seen version untouched', async () => {
    const userDataDir = upgradedProfile();
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: launchEnv({
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-shared-release-notes-enabled': false,
          }),
        }),
      });
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 60_000 });
      await app.openSettings();
      await expect(window.getByTestId('settings-overlay')).toBeVisible();
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('settings-canopy-whats-new')).toHaveCount(
        0,
      );
      expect(feedRequests).toBe(0);
      expect(
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
      ).toBe('98.0.0');
    } finally {
      if (launched) await closeCanopy(launched.electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  for (const lastSeen of ['98.0.0', FIXTURE_VERSION]) {
    test(`exact patch notes published after first launch are shown once (seen ${lastSeen})`, async () => {
      test.setTimeout(240_000);
      const userDataDir = upgradedProfile();
      mergeSeedPreferences(userDataDir, {
        releaseHighlightsLastSeenVersion: lastSeen,
      });
      const env = launchEnv({ CANOPY_E2E_APP_VERSION: '99.0.1' });
      let launched;
      try {
        launched = await launchCanopy({ userDataDir, env });
        let window = await launched.electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
        await expectAutomaticSettled(window);
        await expect(
          window.getByTestId('release-highlights-dialog'),
        ).toHaveCount(0);
        await expectPersistedVersion(userDataDir, lastSeen);
        await closeCanopy(launched.electronApp, userDataDir, {
          keepUserData: true,
        });
        launched = undefined;
        publicFeed.entries = [
          {
            ...initialFeedEntries[0],
            version: '99.0.1',
            headline: 'Patch notes published after the first launch.',
          },
          ...initialFeedEntries,
        ];
        launched = await launchCanopy({ userDataDir, env });
        window = await launched.electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
        await expect(
          window.getByTestId('release-highlights-dialog'),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          window.getByTestId('release-highlights-dialog'),
        ).toContainText('Version 99.0.1');
        await expectPersistedVersion(userDataDir, '99.0.1');
        await window.getByTestId('release-highlights-got-it').click();
        await closeCanopy(launched.electronApp, userDataDir, {
          keepUserData: true,
        });
        launched = undefined;
        launched = await launchCanopy({ userDataDir, env });
        window = await launched.electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
        await expectAutomaticSettled(window);
        await expect(
          window.getByTestId('release-highlights-dialog'),
        ).toHaveCount(0);
        await expectPersistedVersion(userDataDir, '99.0.1');
      } finally {
        if (launched) await closeCanopy(launched.electronApp, userDataDir);
        else rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }

  test('a first launch shows matching notes after startup gates', async () => {
    test.setTimeout(180_000);
    const userDataDir = upgradedProfile();
    mergeSeedPreferences(userDataDir, {
      onboardingCompleted: [],
      releaseHighlightsLastSeenVersion: null,
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: launchEnv(),
    });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('an upgrade shows once, records before dismissal, and opens full notes', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const userDataDir = upgradedProfile();
    let launched;
    try {
      launched = await launchCanopy({
        userDataDir,
        env: launchEnv({ CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: capture.url }),
      });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });

      const dialog = window.getByTestId('release-highlights-dialog');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toContainText(`Version ${FIXTURE_VERSION}`);
      await expect(dialog).toContainText('Fixture highlight one');
      // The public changelog uses reading-sized highlights; the update dialog
      // retains its compact default and its existing full-notes destination.
      await expect(
        dialog
          .getByTestId('release-highlights-list')
          .locator('li > span')
          .first(),
      ).toHaveCSS('font-size', '14px');
      await expect(
        window.getByRole('dialog', { name: /^What's new in / }),
      ).toBeVisible();
      // Recorded on presentation, before any dismissal.
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);

      await window.getByTestId('release-highlights-full-notes').click();
      // The fixture is published (a stable build presents only published
      // entries), so it links to its anchor on the configured origin.
      await expect
        .poll(() => capture.opened, { timeout: 15_000 })
        .toEqual([`${E2E_WEB_ORIGIN}/changelog?version=99.0.0#v99-0-0`]);
      await expect(dialog).toBeVisible();

      await window.getByTestId('release-highlights-got-it').click();
      await expect(dialog).toBeHidden();

      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir, env: launchEnv() });
      const relaunched = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(relaunched);
      await app.waitForShell({ timeout: 60_000 });
      // Interacting with the shell gives the one-IPC decision time to settle
      // before the negative assertion.
      await app.openSettings();
      await expectAutomaticSettled(relaunched);
      await expect(
        relaunched.getByTestId('release-highlights-dialog'),
      ).toHaveCount(0);
      expect(
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
      ).toBe(FIXTURE_VERSION);
    } finally {
      try {
        if (launched) await closeCanopy(launched.electronApp, userDataDir);
        else rmSync(userDataDir, { recursive: true, force: true });
      } finally {
        await capture.close();
      }
    }
  });

  test('quitting without dismissing stays quiet; Settings reopens and Escape closes', async () => {
    test.setTimeout(180_000);
    const userDataDir = upgradedProfile();
    let launched = await launchCanopy({ userDataDir, env: launchEnv() });
    try {
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
      await expect(window.getByTestId('release-highlights-dialog')).toBeVisible(
        { timeout: 30_000 },
      );
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);

      // Quit with the dialog still open.
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir, env: launchEnv() });
      const relaunched = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(relaunched);
      await app.waitForShell({ timeout: 60_000 });
      await app.openSettings();
      await expectAutomaticSettled(relaunched);
      const dialog = relaunched.getByTestId('release-highlights-dialog');
      await expect(dialog).toHaveCount(0);

      const view = relaunched.getByTestId('settings-canopy-whats-new');
      await expect(view).toBeVisible({ timeout: 10_000 });
      await view.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Version ${FIXTURE_VERSION}`);

      await relaunched.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // Escape closed only the dialog: Settings stays open and focus returns
      // to the control that opened it.
      await expect(relaunched.getByTestId('settings-overlay')).toBeVisible();
      await expect(view).toBeFocused();
      expect(
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
      ).toBe(FIXTURE_VERSION);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('keeps actions reachable and traps keyboard focus in a narrow short window', async () => {
    const userDataDir = upgradedProfile();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: launchEnv(),
    });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
      await window.setViewportSize({ width: 480, height: 280 });
      const scroller = window
        .getByTestId('release-highlights-list')
        .locator('..');
      expect(
        await scroller.evaluate(
          (node) => node.scrollHeight > node.clientHeight,
        ),
      ).toBe(true);
      const gotIt = window.getByTestId('release-highlights-got-it');
      await expect(gotIt).toBeInViewport();
      await expect(gotIt).toBeFocused();
      await window.keyboard.press('Tab');
      await expect(
        window.getByRole('button', { name: 'Close', exact: true }),
      ).toBeFocused();
      await window.keyboard.press('Shift+Tab');
      await expect(gotIt).toBeFocused();
      await gotIt.click();
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a failed feed leaves history unchanged and the next launch shows published notes', async () => {
    test.setTimeout(180_000);
    feedStatus = 503;
    const userDataDir = upgradedProfile();
    let launched = await launchCanopy({ userDataDir, env: launchEnv() });
    try {
      let window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
      await expectAutomaticSettled(window);
      expect(feedRequests).toBe(1);
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
      expect(
        readPersistedPreferences(userDataDir).releaseHighlightsLastSeenVersion,
      ).toBe('98.0.0');
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      feedStatus = 200;
      launched = await launchCanopy({ userDataDir, env: launchEnv() });
      window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });

  test('a fresh install shows exact notes once the shell is ready', async () => {
    test.setTimeout(180_000);
    const { electronApp, userDataDir } = await launchCanopy({
      freshOnboarding: true,
      env: launchEnv(),
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      // Clears the blocking legal gate; the onboarding wizard no longer
      // auto-launches (CAN-2411), so the shell is next.
      await app.waitForShell({ timeout: 60_000 });
      await expect(window.getByTestId('onboarding-modal')).toBeHidden();
      await expectPersistedVersion(userDataDir, FIXTURE_VERSION);
      await expectAutomaticSettled(window);
      await expect(
        window.getByTestId('release-highlights-dialog'),
      ).toBeVisible();
      await window.getByTestId('release-highlights-got-it').click();
      await app.openSettings();
      await expect(window.getByTestId('release-highlights-dialog')).toHaveCount(
        0,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// CAN-5006: a late response must not interrupt Continue or its resumed draft.
test('delayed notes wait through Continue, typing and Home autofocus until idle blur', async () => {
  test.setTimeout(180_000);
  const userDataDir = seedReleaseHighlightsResume();
  const feed = await startDelayedReleaseFeed();
  let launched;
  try {
    launched = await launchCanopy({
      userDataDir,
      env: feed.env,
      ...(process.env.CAN5006_BASELINE_ROOT
        ? { rootPath: process.env.CAN5006_BASELINE_ROOT }
        : {}),
    });
    const window = await launched.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 60_000 });
    await exerciseReleaseHighlightsIdle(window, userDataDir, feed);
  } finally {
    feed.release();
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    await feed.close();
  }
});
