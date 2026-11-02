// CAN-4008: shared teaching surface, real preference authority and composer controls.
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const PROMPT = [
  'Please do the following:',
  '- add the migration for the new column',
  '- update the API handler to read the column',
  '- write tests for the handler and the migration',
  'Keep the changes small and make sure the existing tests keep passing.',
  'Send Close Notion Slack',
].join('\n');
const WS = 'demo-ts-pnpm-vite';
const WT = 'demo-main';
function seed(legacy) {
  const dir = seedWelcomeChecklist({ fresh: true });
  const prefsPath = path.join(dir, 'preferences.json');
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  if (legacy)
    prefs.preferences.homeOnboardingSuggestions = {
      startedAt: '2026-10-01T12:00:00.000Z',
      entries: { 'plan-mode': { completedAt: '2026-10-01T12:00:00.000Z' } },
    };
  else prefs.preferences.planModeHint = { version: 1, generation: 0 };
  writeFileSync(prefsPath, JSON.stringify(prefs));
  seedWorktreeChat({
    userDataDir: dir,
    workspaceId: WS,
    worktreeId: WT,
    providerType: 'claude',
    tabs: [{ id: 'hint-chat', title: 'Hint chat', model: 'opus[1m]' }],
  });
  return dir;
}
async function home(window) {
  await window.getByTestId('sidebar-create-task').click();
  const surface = window.getByTestId('page-home');
  await expect(surface).toBeVisible();
  return surface;
}
for (const action of ['accept', 'dismiss']) {
  test(`Home ${action} preserves draft and retires across chat and reload`, async () => {
    const launch = await launchCanopy({
      userDataDir: seed(),
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const surface = await home(window);
      const editor = surface.getByTestId('home-composer-editor');
      await editor.fill('Short task');
      await expect(surface.getByTestId('plan-mode-suggestion')).toHaveCount(0);
      await editor.fill(PROMPT);
      await expect(surface.getByTestId('plan-mode-suggestion')).toBeVisible();
      await expect(surface.locator('[data-connector-offer]')).toHaveCount(0);
      // The suggestion is the composer's tip, in its top drawer, not a banner.
      await expect(
        surface.locator(
          '[data-composer-drawer="top"] [data-testid="plan-mode-suggestion"][data-onboarding-tip-placement="composer"]',
        ),
      ).toBeVisible();
      const actionButton = surface.getByTestId(
        `plan-mode-suggestion-${action}`,
      );
      await expect(editor).toBeFocused();
      await actionButton.focus();
      await actionButton.press(action === 'accept' ? 'Enter' : 'Space');
      await expect(editor).toBeFocused();
      await expect(editor).toHaveText(PROMPT);
      if (action === 'accept')
        await expect(
          surface.getByTestId('home-plan-mode-inline-button'),
        ).toHaveAttribute('aria-pressed', 'true');
      const field = action === 'accept' ? 'triedAt' : 'dismissedAt';
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadPreferences()))
              .planModeHint?.[field],
        )
        .toBeTruthy();
      await app.openMainPage();
      await app.selectWorktree(WT);
      const panel = window
        .getByTestId('panel-content-chat')
        .filter({ visible: true })
        .first();
      await panel.locator('[contenteditable="true"]').last().fill(PROMPT);
      await expect(panel.getByTestId('plan-mode-suggestion')).toHaveCount(0);
      await window.reload();
      await app.waitForShell();
      const next = await home(window);
      await next.getByTestId('home-composer-editor').fill(PROMPT);
      await expect(next.getByTestId('plan-mode-suggestion')).toHaveCount(0);
      await expect(
        next.getByTestId('home-onboarding-suggestion-plan-mode'),
      ).toHaveCount(0);
      // Reset through the same user-facing settings flow; no direct preference patch.
      await app.openSettings();
      await window.getByTestId('settings-canopy-show-tips-again').click();
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadPreferences()))
              .planModeHint?.generation,
        )
        .toBe(1);
      await app.closeSettings();
      const resetHome = await home(window);
      await resetHome.getByTestId('home-composer-editor').fill('');
      await window.reload();
      await app.waitForShell();
      const reloaded = await home(window);
      await reloaded.getByTestId('home-composer-editor').fill(PROMPT);
      await expect(reloaded.getByTestId('plan-mode-suggestion')).toBeVisible();
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
}
test('chat acceptance enables the captured target and retires the Home hint', async () => {
  const launch = await launchCanopy({
    userDataDir: seed(),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WT);
    const panel = window
      .getByTestId('panel-content-chat')
      .filter({ visible: true })
      .first();
    const editor = panel.locator('[contenteditable="true"]').last();
    await editor.fill(PROMPT);
    await expect(panel.getByTestId('plan-mode-suggestion')).toBeVisible();
    await expect(panel.getByTestId('plan-mode-suggestion')).toHaveAttribute(
      'data-onboarding-tip-placement',
      'notice',
    );
    await expect(
      panel.locator(
        '[data-testid="chat-input-composer-drawer"] [data-testid="plan-mode-suggestion"]',
      ),
    ).toHaveCount(0);
    await panel.getByTestId('plan-mode-suggestion-accept').click();
    await expect(editor).toHaveText(PROMPT);
    await expect(
      panel.getByTestId('chat-input-plan-mode-inline-button'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .planModeHint?.triedAt,
      )
      .toBeTruthy();
    const surface = await home(window);
    await surface.getByTestId('home-composer-editor').fill(PROMPT);
    await expect(surface.getByTestId('plan-mode-suggestion')).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
test('replacing Home text preserves a pending pasted attachment', async () => {
  const launch = await launchCanopy({
    userDataDir: seed(),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    env: {
      CANOPY_E2E_ONBOARDING_SUGGESTIONS: 'hidden',
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-suggested-prompts': true,
      }),
    },
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Develop's Files guest gate now rejects signed-out pastes before import.
    // Keep this draft-preservation flow signed in so it exercises a pending import.
    const account = await window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    await launch.electronApp.evaluate(({ ipcMain }, account) => {
      const channel = 'settings:load-canopy-cloud-account';
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({
        ...account,
        read: 'ok',
        hasApiKey: true,
        authMode: 'account',
        credentialSource: 'oauth_desktop',
        account: {
          ...account.account,
          id: 'can-4008-attachment-account',
          name: 'Attachment fixture',
        },
      }));
    }, account);
    await window.reload();
    await app.waitForShell();
    const surface = await home(window);
    const prompt = surface.getByTestId('suggested-prompt-chip').first();
    await expect(prompt).toBeVisible();
    await launch.electronApp.evaluate(({ ipcMain }) => {
      for (const channel of [
        'worktree:import-attachments',
        'workspace-items:import-attachments',
      ]) {
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original)
          throw new Error(`Missing attachment handler: ${channel}`);
        ipcMain._invokeHandlers.set(channel, (event, ...args) => {
          ipcMain._invokeHandlers.set(channel, original);
          return new Promise((resolve) => {
            globalThis.__CAN4008_FINISH_ATTACHMENT__ = () =>
              resolve(original(event, ...args));
          });
        });
      }
    });
    const editor = surface.getByTestId('home-composer-editor');
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          [
            Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTq0AAAAASUVORK5CYII=',
              ),
              (character) => character.charCodeAt(0),
            ),
          ],
          'pending-image.png',
          {
            type: 'image/png',
          },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect
      .poll(() =>
        launch.electronApp.evaluate(
          () => typeof globalThis.__CAN4008_FINISH_ATTACHMENT__ === 'function',
        ),
      )
      .toBe(true);
    await prompt.click();
    await expect(editor).not.toBeEmpty();
    await launch.electronApp.evaluate(() => {
      globalThis.__CAN4008_FINISH_ATTACHMENT__?.();
      delete globalThis.__CAN4008_FINISH_ATTACHMENT__;
    });
    await expect(
      surface.getByRole('img', { name: 'pending-image.png', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('late hint activation failure preserves a newer manual Plan choice', async () => {
  const launch = await launchCanopy({
    userDataDir: seed(),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WT);
    const panel = window
      .getByTestId('panel-content-chat')
      .filter({ visible: true })
      .first();
    const editor = panel.locator('[contenteditable="true"]').last();
    await editor.fill(PROMPT);
    await expect(panel.getByTestId('plan-mode-suggestion')).toBeVisible();
    // Delay only the first real Plan IPC call. Subsequent controls use the
    // production handler so off/on choices are durably acknowledged.
    await launch.electronApp.evaluate(({ ipcMain }) => {
      const channel = 'plan:mode-toggle';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Plan handler not registered');
      ipcMain._invokeHandlers.set(channel, () => {
        ipcMain._invokeHandlers.set(channel, original);
        return new Promise((_resolve, reject) => {
          globalThis.__CAN4008_REJECT_PLAN__ = () =>
            reject(new Error('older hint activation failed'));
        });
      });
    });
    await panel.getByTestId('plan-mode-suggestion-accept').click();
    const toggle = panel.getByTestId('chat-input-plan-mode-inline-button');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveCount(0);
    await panel.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-input-plan-mode-button').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WS, worktreeId: WT },
        );
        return snapshot.tabsFile.tabs.find((tab) => tab.id === 'hint-chat')
          ?.planMode;
      })
      .toBe(true);
    await launch.electronApp.evaluate(() => {
      globalThis.__CAN4008_REJECT_PLAN__?.();
      delete globalThis.__CAN4008_REJECT_PLAN__;
    });
    // A second UI action runs after the rejected request crosses preload.
    await editor.fill(`${PROMPT} Keep my newer Plan choice.`);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toContainText('Keep my newer Plan choice.');
    const preferences = await window.evaluate(() =>
      window.api.loadPreferences(),
    );
    expect(preferences.planModeHint?.triedAt).toBeUndefined();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('legacy completed plan lesson migrates before removed checklist progress is normalized', async () => {
  const launch = await launchCanopy({
    userDataDir: seed(true),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    const surface = await home(window);
    await surface.getByTestId('home-composer-editor').fill(PROMPT);
    await expect(surface.getByTestId('plan-mode-suggestion')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .planModeHint?.triedAt,
      )
      .toBe('2026-10-01T12:00:00.000Z');
    await expect(
      surface.getByTestId('home-onboarding-suggestion-plan-mode'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
