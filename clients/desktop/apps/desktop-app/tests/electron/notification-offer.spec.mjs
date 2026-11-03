import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent } from './seeders/injectChatEvent.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// One-time notification offer (CAN-4005).
//
// A finished agent run delivered while the app is in the background, with
// notifications off, arms an offer that shows once the window is focused
// again. Either answer is saved so the offer never returns. Completions come
// from the real pipeline completion producer through the production
// execution-event channel; no live agent runs.
//
// Headless Electron focus is not deterministic, so each test installs a
// scoped focus shim in the main window: it owns both `document.hasFocus()`
// and the focus/blur events the banner listens to. The shim lives only as
// long as the launched renderer. Assertions are on preferences and the card,
// never on a real OS banner.

const PIPELINE_ID = 'e2e-notification-offer';

function readPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

function seedProfile(options = {}) {
  const userDataDir = seedWelcomeChecklist(options);
  const { state } = seedPipelineExecution({
    userDataDir,
    execution: { id: PIPELINE_ID, pipelineName: 'Nightly', status: 'running' },
  });
  return { userDataDir, state };
}

async function installFocusShim(window) {
  await window.evaluate(() => {
    const shimmed = window;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    shimmed.__restoreNotificationOfferFocus = () => {
      if (descriptor) Object.defineProperty(document, 'hasFocus', descriptor);
      else delete document.hasFocus;
      delete shimmed.__notificationOfferFocused;
    };
    shimmed.__notificationOfferFocused = true;
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => shimmed.__notificationOfferFocused === true,
    });
  });
}

async function setFocused(window, focused) {
  await window.evaluate((next) => {
    window.__notificationOfferFocused = next;
    window.dispatchEvent(new Event(next ? 'focus' : 'blur'));
  }, focused);
}

// Counts execution events the renderer has received. App mounts its pipeline
// completion listener before Home renders, so this later listener runs after
// the delivery gate has read focus for the same event.
async function countDeliveredExecutionEvents(window) {
  await window.evaluate(() => {
    window.__notificationOfferDelivered = 0;
    window.__restoreNotificationOfferDelivered =
      window.pipelines.onExecutionEvent(() => {
        window.__notificationOfferDelivered += 1;
      });
  });
}

// Resolve only once the renderer has handled the completion, so the focus
// state the test sets next cannot race the delivery gate's focus read.
async function completePipeline({ electronApp, window }, state) {
  const delivered = () =>
    window.evaluate(() => window.__notificationOfferDelivered);
  const before = await delivered();
  await injectPipelineExecutionEvent(electronApp, {
    state: { ...state, status: 'success' },
    type: 'execution.completed',
  });
  await expect.poll(delivered).toBe(before + 1);
}

async function closeOfferApp(electronApp, userDataDir, options) {
  for (const window of electronApp.windows()) {
    await window.evaluate(() => {
      window.__restoreNotificationOfferFocus?.();
      window.__restoreNotificationOfferDelivered?.();
    });
  }
  await electronApp.evaluate(() => {
    globalThis.__restoreOfferNative?.();
    globalThis.__restoreOfferSave?.();
  });
  await closeCanopy(electronApp, userDataDir, options);
}

async function stubNative(electronApp, denied = false) {
  await electronApp.evaluate(({ Notification, shell }, denied) => {
    const supported = Object.getOwnPropertyDescriptor(
      Notification,
      'isSupported',
    );
    const show = Object.getOwnPropertyDescriptor(
      Notification.prototype,
      'show',
    );
    const external = shell.openExternal;
    globalThis.__restoreOfferNative = () => {
      if (supported)
        Object.defineProperty(Notification, 'isSupported', supported);
      if (show) Object.defineProperty(Notification.prototype, 'show', show);
      shell.openExternal = external;
    };
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      if (denied)
        this.emit(
          'failed',
          {},
          'UNErrorDomain error 1: Notifications are not allowed for this application',
        );
    };
    globalThis.__offerSettingsOpened = 0;
    shell.openExternal = async () => {
      globalThis.__offerSettingsOpened++;
    };
  }, denied);
}

async function launch(userDataDir) {
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await expect(window.getByTestId('page-home')).toBeVisible({
    timeout: 15_000,
  });
  await installFocusShim(window);
  await countDeliveredExecutionEvents(window);
  await stubNative(launched.electronApp);
  return { ...launched, window };
}

test('a failed Not now save retries that choice without enabling notifications', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const { electronApp, window } = await launch(userDataDir);
  try {
    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toBeVisible();
    // Fail only the next authoritative answer commit, with the real IPC and
    // renderer retry path intact. Restore the builtin binding immediately.
    await electronApp.evaluate(async () => {
      const fs = process.getBuiltinModule('fs/promises');
      const { syncBuiltinESMExports } = process.getBuiltinModule('module');
      const rename = fs.rename;
      globalThis.__restoreOfferSave = () => {
        fs.rename = rename;
        syncBuiltinESMExports();
      };
      fs.rename = async (source, target) => {
        if (String(target).endsWith('/preferences.json')) {
          globalThis.__restoreOfferSave();
          throw new Error('Deterministic answer commit failure');
        }
        return rename(source, target);
      };
      syncBuiltinESMExports();
    });
    await window.getByTestId('os-notification-offer-dismiss').click();
    await expect(
      window.getByTestId('os-notification-offer-save-error'),
    ).toBeVisible();
    expect(
      readPreferences(userDataDir).osNotificationOfferAnsweredAt,
    ).toBeUndefined();
    await expect(
      window.getByTestId('os-notification-offer-enable'),
    ).toBeDisabled();
    const retry = window.getByTestId('os-notification-offer-dismiss');
    await expect(retry).toHaveText('Try again');
    await retry.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
    expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toEqual(
      expect.any(String),
    );
    expect(readPreferences(userDataDir).osNotifications.enabled).toBe(false);
  } finally {
    await electronApp.evaluate(() => globalThis.__restoreOfferSave?.());
    await closeOfferApp(electronApp, userDataDir);
  }
});

test('a late Turn on answer does not override a newer Settings disable', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const { electronApp, window } = await launch(userDataDir);
  try {
    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toBeVisible();
    // Commit the offer answer normally, but hold its IPC reply so the user
    // can make a newer Settings choice before the opt-in continuation runs.
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('preferences:save');
      if (!original) throw new Error('Missing preference save handler');
      globalThis.__restoreOfferSave = () => {
        ipcMain.removeHandler('preferences:save');
        ipcMain.handle('preferences:save', original);
        globalThis.__releaseOfferSave?.();
      };
      ipcMain.removeHandler('preferences:save');
      ipcMain.handle('preferences:save', async (event, patch) => {
        const result = await original(event, patch);
        if (
          patch.osNotificationOfferAnsweredAt &&
          Object.keys(patch).length === 1
        ) {
          await new Promise((resolve) => {
            globalThis.__releaseOfferSave = resolve;
          });
        }
        return result;
      });
    });
    await window.getByTestId('os-notification-offer-enable').click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => typeof globalThis.__releaseOfferSave),
      )
      .toBe('function');
    const app = new CanopyAppDriver(window);
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');
    await window.getByTestId('notifications-toggle-master').click();
    await expect
      .poll(() => readPreferences(userDataDir).osNotifications.enabled)
      .toBe(true);
    await window.getByTestId('notifications-toggle-master').click();
    await expect
      .poll(() => readPreferences(userDataDir).osNotifications.enabled)
      .toBe(false);
    await electronApp.evaluate(() => globalThis.__releaseOfferSave());
    // The obsolete continuation must settle without enabling or probing OS
    // delivery. A fresh completion still cannot re-arm the answered offer.
    await app.closeSettings();
    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
    expect(readPreferences(userDataDir).osNotifications.enabled).toBe(false);
  } finally {
    await closeOfferApp(electronApp, userDataDir);
  }
});

test('a background completion offers notifications on return, and Not now sticks', async () => {
  test.setTimeout(180_000);
  const { userDataDir, state } = seedProfile();
  let first = await launch(userDataDir);
  let firstClosed = false;
  try {
    const offer = first.window.getByTestId('os-notification-offer');
    await setFocused(first.window, false);
    await completePipeline(first, state);
    await completePipeline(first, state);
    // Pending while away, never shown in the background.
    await expect(offer).toHaveCount(0);

    await setFocused(first.window, true);
    await expect(offer).toHaveCount(1);
    await expect(offer).toContainText('A task finished while you were away');

    // Blur hides it without answering; refocus brings it back.
    await setFocused(first.window, false);
    await expect(offer).toHaveCount(0);
    await setFocused(first.window, true);
    await expect(offer).toBeVisible();

    await first.window.getByTestId('os-notification-offer-dismiss').click();
    await expect(offer).toHaveCount(0);
    await expect(async () => {
      const preferences = readPreferences(userDataDir);
      expect(preferences.osNotificationOfferAnsweredAt).toEqual(
        expect.any(String),
      );
      expect(preferences.osNotifications.enabled).toBe(false);
    }).toPass({ timeout: 10_000 });

    // Another completion in this session does not bring it back.
    await setFocused(first.window, false);
    await completePipeline(first, state);
    await setFocused(first.window, true);
    await expect(offer).toHaveCount(0);

    const stamp = readPreferences(userDataDir).osNotificationOfferAnsweredAt;
    const app = new CanopyAppDriver(first.window);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      first.window.getByTestId('settings-canopy-restore-checklist'),
    ).toHaveCount(0);
    await app.closeSettings();
    expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toBe(
      stamp,
    );
    await closeOfferApp(first.electronApp, userDataDir, { keepUserData: true });
    firstClosed = true;

    // Nor does a relaunch followed by another background completion.
    const second = await launch(userDataDir);
    try {
      await setFocused(second.window, false);
      await completePipeline(second, state);
      await setFocused(second.window, true);
      await expect(
        second.window.getByTestId('os-notification-offer'),
      ).toHaveCount(0);
      expect(readPreferences(userDataDir).osNotifications.enabled).toBe(false);
    } finally {
      await closeOfferApp(second.electronApp, second.userDataDir);
    }
  } finally {
    if (!firstClosed) await closeOfferApp(first.electronApp, userDataDir);
  }
});

test('Turn on saves the answer and stays suppressed after completion and relaunch', async () => {
  test.setTimeout(180_000);
  const { userDataDir, state } = seedProfile();
  const first = await launch(userDataDir);
  let closed = false;
  try {
    await setFocused(first.window, false);
    await completePipeline(first, state);
    await setFocused(first.window, true);
    await first.window.getByTestId('os-notification-offer-enable').click();
    await expect(first.window.getByTestId('os-notification-offer')).toHaveCount(
      0,
    );
    await expect(async () => {
      expect(readPreferences(userDataDir)).toMatchObject({
        osNotificationOfferAnsweredAt: expect.any(String),
        osNotifications: { enabled: true },
      });
    }).toPass({ timeout: 10_000 });
    const stamp = readPreferences(userDataDir).osNotificationOfferAnsweredAt;
    await setFocused(first.window, false);
    await completePipeline(first, state);
    await setFocused(first.window, true);
    await expect(first.window.getByTestId('os-notification-offer')).toHaveCount(
      0,
    );
    await closeOfferApp(first.electronApp, userDataDir, { keepUserData: true });
    closed = true;
    const second = await launch(userDataDir);
    try {
      await setFocused(second.window, false);
      await completePipeline(second, state);
      await setFocused(second.window, true);
      await expect(
        second.window.getByTestId('os-notification-offer'),
      ).toHaveCount(0);
      expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toBe(
        stamp,
      );
    } finally {
      await closeOfferApp(second.electronApp, userDataDir);
    }
  } finally {
    if (!closed) await closeOfferApp(first.electronApp, userDataDir);
  }
});

test('a completion delivered while focused never offers', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const { electronApp, window } = await launch(userDataDir);
  try {
    await setFocused(window, true);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, false);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
  } finally {
    await closeOfferApp(electronApp, userDataDir);
  }
});

test('a pending offer does not survive a relaunch', async () => {
  test.setTimeout(180_000);
  const { userDataDir, state } = seedProfile();
  const first = await launch(userDataDir);
  await setFocused(first.window, false);
  await completePipeline(first, state);
  await closeOfferApp(first.electronApp, userDataDir, { keepUserData: true });

  const second = await launch(userDataDir);
  try {
    const offer = second.window.getByTestId('os-notification-offer');
    await setFocused(second.window, false);
    await setFocused(second.window, true);
    await expect(offer).toHaveCount(0);
    expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toBe(
      undefined,
    );
    // A new qualifying completion can arm it again.
    await setFocused(second.window, false);
    await completePipeline(second, state);
    await setFocused(second.window, true);
    await expect(offer).toBeVisible();
  } finally {
    await closeOfferApp(second.electronApp, second.userDataDir);
  }
});

for (const legacyNotifications of ['completed', 'dismissed']) {
  test(`a ${legacyNotifications} legacy checklist step suppresses the offer`, async () => {
    test.setTimeout(120_000);
    const { userDataDir, state } = seedProfile({ legacyNotifications });
    const legacyAnswer =
      readPreferences(userDataDir).homeOnboardingSuggestions.entries
        .notifications;
    const stamp = legacyAnswer.completedAt ?? legacyAnswer.dismissedAt;
    const { electronApp, window } = await launch(userDataDir);
    try {
      await setFocused(window, false);
      await completePipeline({ electronApp, window }, state);
      await setFocused(window, true);
      await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
      await window.evaluate(() =>
        window.api.savePreferences({ sidebarCollapsed: true }),
      );
      expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toBe(
        stamp,
      );
      // The independent answer survives; its retired source is no longer saved.
      await expect(
        window.getByTestId('home-onboarding-suggestion-notifications'),
      ).toHaveCount(0);
      expect(
        readPreferences(userDataDir).homeOnboardingSuggestions?.entries
          ?.notifications,
      ).toBeUndefined();
    } finally {
      await closeOfferApp(electronApp, userDataDir);
    }
  });
}

test('an already enabled profile is suppressed for good, even after turning them off', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const file = path.join(userDataDir, 'preferences.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.preferences.osNotifications = { enabled: true };
  writeFileSync(file, JSON.stringify(saved));
  const { electronApp, window } = await launch(userDataDir);
  try {
    // Loading the renderer persists the suppression.
    await expect(async () => {
      expect(
        readPreferences(userDataDir).osNotificationOfferAnsweredAt,
      ).toEqual(expect.any(String));
    }).toPass({ timeout: 10_000 });

    const app = new CanopyAppDriver(window);
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');
    await window.getByTestId('notifications-toggle-master').click();
    await expect(async () => {
      expect(readPreferences(userDataDir).osNotifications.enabled).toBe(false);
    }).toPass({ timeout: 10_000 });
    await app.closeSettings();

    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
  } finally {
    await closeOfferApp(electronApp, userDataDir);
  }
});

for (const background of [true, false]) {
  test(`a real ${background ? 'background' : 'focused'} chat completion obeys the offer gate`, async () => {
    test.setTimeout(120_000);
    const { userDataDir } = seedProfile();
    const projectId = 'demo-ts-pnpm-vite';
    const worktreeId = 'demo-main';
    const chatId = 'notification-offer-chat';
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: projectId,
      worktreeId,
      providerType: 'codex',
      tabs: [{ id: chatId, title: 'Finished work', messages: [] }],
    });
    const { electronApp, window } = await launch(userDataDir);
    try {
      const app = new CanopyAppDriver(window);
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      // Completion uses the direct OS path for the active chat, so this also
      // covers the producer that is independent of in-app toast visibility.
      await setFocused(window, !background);
      await injectChatEvent(electronApp, {
        projectId,
        worktreeId,
        chatId,
        data: { type: 'result', is_error: false, result: 'Done' },
      });
      await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
      await setFocused(window, false);
      await setFocused(window, true);
      if (background)
        await expect(window.getByTestId('os-notification-offer')).toBeVisible();
      else
        await expect(window.getByTestId('os-notification-offer')).toHaveCount(
          0,
        );
    } finally {
      await closeOfferApp(electronApp, userDataDir);
    }
  });
}

test('explicit Settings enable and disable permanently answer a fresh profile', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const { electronApp, window } = await launch(userDataDir);
  try {
    const app = new CanopyAppDriver(window);
    await app.openSettings();
    await app.openAccountSettingsPage('notifications');
    const toggle = window.getByTestId('notifications-toggle-master');
    await toggle.click();
    await expect(async () => {
      expect(readPreferences(userDataDir).osNotifications.enabled).toBe(true);
      expect(
        readPreferences(userDataDir).osNotificationOfferAnsweredAt,
      ).toEqual(expect.any(String));
    }).toPass();
    const stamp = readPreferences(userDataDir).osNotificationOfferAnsweredAt;
    await toggle.click();
    await expect(async () => {
      expect(readPreferences(userDataDir).osNotifications.enabled).toBe(false);
    }).toPass();
    await app.closeSettings();
    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
    expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toBe(
      stamp,
    );
  } finally {
    await closeOfferApp(electronApp, userDataDir);
  }
});

test('OS denial keeps the answer and offers system settings exactly once', async () => {
  test.setTimeout(120_000);
  const { userDataDir, state } = seedProfile();
  const { electronApp, window } = await launch(userDataDir);
  try {
    await electronApp.evaluate(() => globalThis.__restoreOfferNative());
    await stubNative(electronApp, true);
    await setFocused(window, false);
    await completePipeline({ electronApp, window }, state);
    await setFocused(window, true);
    await window.getByTestId('os-notification-offer-enable').click();
    const settings = window.getByRole('button', {
      name: 'Open settings',
      exact: true,
    });
    await expect(settings).toHaveCount(1);
    expect(readPreferences(userDataDir).osNotificationOfferAnsweredAt).toEqual(
      expect.any(String),
    );
    await settings.click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__offerSettingsOpened))
      .toBe(1);
    await expect(window.getByTestId('os-notification-offer')).toHaveCount(0);
  } finally {
    await closeOfferApp(electronApp, userDataDir);
  }
});
