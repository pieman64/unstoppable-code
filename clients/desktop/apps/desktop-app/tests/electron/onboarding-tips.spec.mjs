// CAN-4904: onboarding tips. One tip component in two placements (inline at
// the top of Workflows, attached to a worktree chat's composer), one queue so
// at most one tip shows, and dismissals kept in the desktop preferences so a
// dismissed tip stays gone after a relaunch until Settings › General › Show
// tips again brings them back.
//
// Deterministic and offline: a seeded demo workspace with one worktree chat,
// no live agents. `freshOnboardingTips: true` skips the launcher's default of
// seeding every tip as dismissed.
//
// CAN-5005: the worktree tip is for a first-time worktree user, so the
// first-use fixture's only worktree chat is empty, and a chat with history
// keeps the composer clear even with every tip fresh.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedWorktreeChat,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const TAB_ID = 'onboarding-tips-chat';

const PAGE_TIP = 'workflows-onboarding-tip';
const COMPOSER_TIP = 'chat-input-onboarding-tip';

/** One worktree chat: empty for a first-time user, else with a reply. */
function seed({ withHistory = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-onboarding-tips-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: withHistory
      ? [
          {
            id: TAB_ID,
            title: 'Onboarding tips chat',
            ...(withHistory
              ? {
                  blocks: [
                    { type: 'text', text: 'Seeded reply for the tips spec.' },
                  ],
                }
              : {}),
          },
        ]
      : [],
  });
  return userDataDir;
}

function storedDismissals(userDataDir) {
  const persisted = JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  );
  return persisted.preferences?.onboardingTipsDismissed ?? {};
}

async function launch(userDataDir) {
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboardingTips: true,
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, window, app };
}

async function openWorktreeChat(app, window) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();
}

test.describe('Onboarding tips', () => {
  test('a rejected first creation does not count as experience before a successful empty retry', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-onboarding-create-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp, window, app } = await launch(userDataDir);
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('chat:command');
        const gate = {
          original,
          attempts: [],
          rejected: false,
          release: undefined,
        };
        globalThis.__onboardingCreateRetry = gate;
        ipcMain.removeHandler('chat:command');
        ipcMain.handle('chat:command', async (event, request) => {
          if (
            request.projectId === 'demo-ts-pnpm-vite' &&
            request.command.type === 'chat.create_tab'
          ) {
            gate.attempts.push(request.command.tabId);
            if (request.command.tabId === gate.attempts[0]) {
              if (gate.attempts.length === 1)
                await new Promise((resolve) => {
                  gate.release = resolve;
                });
              gate.rejected = true;
              return {
                commandId: request.commandId,
                revision: request.expectedRevision,
                outcome: 'rejected',
                reason: 'First creation refused by onboarding fixture',
              };
            }
          }
          return original(event, request);
        });
      });
      await app.openMainPage();
      await app.workspaceHeaderLabel('TypeScript pnpm Vite').hover();
      await window
        .getByRole('button', {
          name: 'Create worktree for TypeScript pnpm Vite',
        })
        .click();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__onboardingCreateRetry.attempts.length,
          ),
        )
        .toBe(1);
      await app.openWorkflowsTab('runs');
      await app.openMainPage();
      await electronApp.evaluate(() =>
        globalThis.__onboardingCreateRetry.release(),
      );
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__onboardingCreateRetry.rejected,
          ),
        )
        .toBe(true);
      // Replace the rejected empty starter using the existing add action.
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window.getByTestId('panel-add-menu-item-new-chat').click();
      await app.openWorkflowsTab('runs');
      await app.openMainPage();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => new Set(globalThis.__onboardingCreateRetry.attempts).size,
          ),
        )
        .toBe(2);
      await expect(window.getByTestId(COMPOSER_TIP)).toBeVisible();
      const ids = await electronApp.evaluate(
        () => globalThis.__onboardingCreateRetry.attempts,
      );
      expect(new Set(ids).size).toBe(2);
      expect(storedDismissals(userDataDir)['worktree-chat']).toBeUndefined();
    } finally {
      await electronApp
        .evaluate(({ ipcMain }) => {
          const gate = globalThis.__onboardingCreateRetry;
          gate?.release?.();
          if (gate?.original) {
            ipcMain.removeHandler('chat:command');
            ipcMain.handle('chat:command', gate.original);
          }
        })
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a rejected Home first send preserves the tip while its failed echo stays recoverable', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-onboarding-refused-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp, window, app } = await launch(userDataDir);
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('chat:model-change');
        const gate = { original, started: false, reject: undefined };
        globalThis.__onboardingRejectedSend = gate;
        ipcMain.removeHandler('chat:model-change');
        ipcMain.handle('chat:model-change', async () => {
          gate.started = true;
          return new Promise((_resolve, reject) => {
            gate.reject = () =>
              reject(new Error('Model selection refused by fixture'));
          });
        });
      });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await home
        .getByTestId('home-composer-editor')
        .fill('Unaccepted first turn');
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__onboardingRejectedSend.started,
          ),
        )
        .toBe(true);
      const panel = window.getByTestId('panel-content-chat');
      const echo = panel
        .getByText('Unaccepted first turn', { exact: true })
        .first();
      await expect(echo).toBeVisible();
      const tip = window.getByTestId(COMPOSER_TIP);
      await expect(tip).toBeVisible();
      await electronApp.evaluate(() =>
        globalThis.__onboardingRejectedSend.reject(),
      );
      // The refused first send stays on screen as a failed echo with its
      // recovery notice (CAN-5021); it is not an accepted turn, so the tip
      // stays.
      await expect(
        window.getByTestId('first-send-failed-notice'),
      ).toBeVisible();
      await expect(echo).toBeVisible();
      await expect(tip).toBeVisible();
      await app.openWorkflowsTab('runs');
      await app.openMainPage();
      await expect(panel).toBeVisible();
      await expect(tip).toBeVisible();
      expect(storedDismissals(userDataDir)['worktree-chat']).toBeUndefined();
    } finally {
      await electronApp
        .evaluate(({ ipcMain }) => {
          const gate = globalThis.__onboardingRejectedSend;
          gate?.reject?.();
          if (gate?.original) {
            ipcMain.removeHandler('chat:model-change');
            ipcMain.handle('chat:model-change', gate.original);
          }
        })
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('creating a blank work area from Home preserves first-use eligibility', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-onboarding-home-first-use-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const { electronApp, window } = await launch(userDataDir);
    try {
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
      await expect(window.getByTestId(COMPOSER_TIP)).toBeVisible();
      expect(storedDismissals(userDataDir)['worktree-chat']).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the first accepted worktree send removes the tip and keeps it absent on return', async () => {
    test.setTimeout(180_000);
    const marker = 'Canopy-C5005FIRSTSEND';
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          { text: 'First worktree turn accepted.', stopReason: 'end_turn' },
        ],
      },
    });
    const userDataDir = seed();
    const { electronApp, window, app } = await launch(userDataDir);
    try {
      await openWorktreeChat(app, window);
      await expect(window.getByTestId(COMPOSER_TIP)).toBeVisible();
      await window
        .getByRole('textbox')
        .first()
        .fill(`[${marker}] Send the first turn.`);
      await window
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        window
          .getByTestId('panel-content-chat')
          .getByText('First worktree turn accepted.', { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(window.getByTestId(COMPOSER_TIP)).toHaveCount(0);
      await app.openWorkflowsTab('runs');
      await openWorktreeChat(app, window);
      await expect(window.getByTestId(COMPOSER_TIP)).toHaveCount(0);
      expect(storedDismissals(userDataDir)['worktree-chat']).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
    }
  });

  test('one tip at a time, chosen on arrival, and dismissals persist until Show tips again', async () => {
    test.setTimeout(180_000);
    const userDataDir = seed();
    let { electronApp, window, app } = await launch(userDataDir);
    try {
      // A worktree chat shows its composer tip. Leaving it undismissed for
      // another page must not hold the queue: the main page stays mounted,
      // hidden, behind Workflows.
      await openWorktreeChat(app, window);
      await expect(window.getByTestId(COMPOSER_TIP)).toBeVisible();

      // First visit to Workflows: one inline tip with a visible close button.
      await app.openWorkflowsTab('runs');
      const pageTip = window.getByTestId(PAGE_TIP);
      await expect(pageTip).toBeVisible();
      await expect(pageTip).toHaveAttribute('role', 'note');
      await expect(pageTip).toContainText('Repeat work with workflows');
      await expect(window.getByTestId(`${PAGE_TIP}-dismiss`)).toBeVisible();
      await expect(window.getByTestId(`${PAGE_TIP}-dismiss`)).toHaveAttribute(
        'aria-label',
        'Dismiss tip',
      );

      // Schedule has its own tip, but the Workflows tip still applies here
      // and only one shows.
      await app.openWorkflowsTab('schedule');
      await expect(window.getByTestId(PAGE_TIP)).toHaveCount(1);
      await expect(window.getByTestId(PAGE_TIP)).toContainText(
        'Repeat work with workflows',
      );

      // Got it: the tip goes, and the Schedule tip waits for the next visit.
      await window.getByTestId(`${PAGE_TIP}-got-it`).click();
      await expect(window.getByTestId(PAGE_TIP)).toHaveCount(0);
      await expect
        .poll(() => Object.keys(storedDismissals(userDataDir)))
        .toEqual(['workflows']);

      // The worktree chat tip is attached to the composer and names the
      // worktree; the close button dismisses it.
      await openWorktreeChat(app, window);
      const composerTip = window.getByTestId(COMPOSER_TIP);
      await expect(composerTip).toBeVisible();
      await expect(composerTip).toHaveAttribute(
        'data-onboarding-tip-placement',
        'notice',
      );
      await expect(composerTip).toContainText('This chat has its own copy of');
      await expect(composerTip).toContainText(
        `Changes stay in ${WORKTREE_BRANCH} until you commit or open a pull request.`,
      );
      await window.getByTestId(`${COMPOSER_TIP}-dismiss`).click();
      await expect(window.getByTestId(COMPOSER_TIP)).toHaveCount(0);

      // Next visit to Schedule: now its tip shows, and acting on it opens
      // the Library and dismisses it.
      await app.openWorkflowsTab('schedule');
      await expect(window.getByTestId(PAGE_TIP)).toContainText(
        'Schedules live on workflows',
      );
      await window.getByTestId(`${PAGE_TIP}-action`).click();
      await expect(
        window.getByTestId('workflows-tab-workflows-library'),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(window.getByTestId(PAGE_TIP)).toHaveCount(0);
      await expect
        .poll(() => Object.keys(storedDismissals(userDataDir)).sort())
        .toEqual(['workflows', 'workflows-schedule', 'worktree-chat']);

      // A relaunch keeps every dismissed tip gone.
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      ({ electronApp, window, app } = await launch(userDataDir));
      await app.openWorkflowsTab('schedule');
      await expect(window.getByTestId('page-workflows-schedule')).toBeVisible();
      await expect(window.getByTestId(PAGE_TIP)).toHaveCount(0);
      await openWorktreeChat(app, window);
      await expect(window.getByTestId(COMPOSER_TIP)).toHaveCount(0);

      // Settings › General › Show tips again brings them back on the next
      // arrival.
      await app.openSettings();
      await app.openSettingsSection('canopy');
      const showAgain = window.getByTestId('settings-canopy-show-tips-again');
      await expect(showAgain).toBeVisible();
      await showAgain.click();
      await expect(window.getByTestId('settings-canopy-tips')).toHaveCount(0);
      await expect.poll(() => storedDismissals(userDataDir)).toEqual({});
      await app.closeSettings();
      await app.openWorkflowsTab('runs');
      await expect(window.getByTestId(PAGE_TIP)).toContainText(
        'Repeat work with workflows',
      );

      // A tip dismissed in this session comes back too.
      await window.getByTestId(`${PAGE_TIP}-got-it`).click();
      await expect(window.getByTestId(PAGE_TIP)).toHaveCount(0);
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-show-tips-again').click();
      await expect(window.getByTestId('settings-canopy-tips')).toHaveCount(0);
      await app.closeSettings();
      await app.openWorkflowsTab('schedule');
      await expect(window.getByTestId(PAGE_TIP)).toContainText(
        'Repeat work with workflows',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a worktree chat with history keeps the composer clear', async () => {
    test.setTimeout(120_000);
    const userDataDir = seed({ withHistory: true });
    const { electronApp, window, app } = await launch(userDataDir);
    try {
      await openWorktreeChat(app, window);
      await expect(window.getByTestId('chat-input-plus-button')).toBeVisible();
      // The Workflows tip proves the tips loaded and nothing holds the queue;
      // back on the chat, its own loaded history keeps the tip away.
      await app.openWorkflowsTab('runs');
      await expect(window.getByTestId(PAGE_TIP)).toContainText(
        'Repeat work with workflows',
      );
      await openWorktreeChat(app, window);
      await expect(window.getByTestId(COMPOSER_TIP)).toHaveCount(0);
      // History is not a dismissal: nothing is written for the worktree tip.
      expect(storedDismissals(userDataDir)['worktree-chat']).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
