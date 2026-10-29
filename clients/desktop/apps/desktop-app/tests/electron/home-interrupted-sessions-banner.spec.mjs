import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedUsageLimitedChats, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedInterruptedSessionScopes } from './interrupted-sessions-scope-fixture.mjs';
import { seedTranscriptRecovery } from './transcript-storage-fixture.mjs';

// Home interrupted sessions Continue row (2026-09-08, relocated 2026-09-16).
// When the usage-limited registry holds any idle session — usage limit,
// authentication failure, or application stop, for any provider — the Home
// Continue list offers a dismissible row with one Resume CTA that opens the
// shared `UsageLimitResumeModal` for every interrupted session at once.
// Dismissal is session-only and keyed to the interrupted set, so a new
// interruption brings the row back. The registry is seeded JSON; no live
// agents or network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const CHATS = [
  { id: 'usage-limit-chat', title: 'Usage limit chat', provider: 'claude' },
  { id: 'shutdown-chat', title: 'Shutdown chat', provider: 'claude' },
  {
    id: 'codex-shutdown-chat',
    title: 'Codex shutdown chat',
    provider: 'codex',
  },
];

function registryEntry(chat, resumeReason) {
  return {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: chat.id,
    provider: chat.provider,
    detectedAt: Date.parse('2026-09-08T12:00:00.000Z'),
    workspaceName: WORKSPACE_NAME,
    chatTitle: chat.title,
    resumeReason,
  };
}

function seed(entries) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-interrupted-banner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: CHATS.map((chat) => ({ id: chat.id, title: chat.title })),
  });
  seedUsageLimitedChats({ userDataDir, entries });
  return userDataDir;
}

function readRegistry(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'usage-limited-chats.json'), 'utf8'),
  );
}

async function openHome(window, app) {
  await app.waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();
  await expect(window.getByTestId('page-home')).toBeVisible();
  return window.getByTestId('page-home');
}

test.describe('home interrupted sessions banner', () => {
  test('excludes retained sessions for archived or deleted work and workspaces', async () => {
    const { userDataDir, scopes } = seedInterruptedSessionScopes();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      for (const scope of scopes) {
        const row = modal.getByTestId(
          `usage-limit-resume-chat-${scope.chatId}`,
        );
        if (scope.live) await expect(row).toBeChecked();
        else await expect(row).toHaveCount(0);
      }
      await expect(modal).toContainText('live-pipeline');
      await expect(modal).toContainText('local-pipeline');
      await expect(modal).toContainText('legacy-standalone-pipeline');
      await expect(modal).not.toContainText('archived-pipeline');
      await expect(modal).not.toContainText('deleted-entry-pipeline');
      await expect(modal).not.toContainText('deleted-workspace-pipeline');
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 6 sessions',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('resumes a migrated standalone chat from its owning Work Entry', async () => {
    const { userDataDir } = seedInterruptedSessionScopes();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      const chat = modal.getByTestId(
        'usage-limit-resume-chat-migrated-legacy-chat',
      );
      await expect(chat).toBeChecked();
      for (const checkbox of await modal
        .locator('input[type="checkbox"]')
        .all()) {
        await checkbox.uncheck();
      }
      await chat.check();
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 1 session',
      );
      await modal.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden();
      await expect
        .poll(() =>
          readRegistry(userDataDir).entries.map((entry) => entry.chatId),
        )
        .not.toContain('migrated-legacy-chat');
      await expect(window.getByTestId('resume-queue-modal')).toContainText(
        'Resumed',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('discovers an interrupted JSONL chat on Home before opening its worktree', async () => {
    const { userDataDir } = await seedTranscriptRecovery({
      interrupted: true,
      interruptedScopeId: WORKTREE_ID,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      const banner = home.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible();
      await banner.getByTestId('home-interrupted-sessions-resume').click();
      await expect(
        window.getByTestId('usage-limit-resume-modal'),
      ).toContainText('Application stopped');
      expect(readRegistry(userDataDir).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chatId: 'long',
            resumeReason: 'app_shutdown',
          }),
        ]),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('recovers a retained JSONL scope without offering its removed worktree', async () => {
    const { userDataDir } = await seedTranscriptRecovery({ interrupted: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await expect
        .poll(() => readRegistry(userDataDir).entries)
        .toContainEqual(
          expect.objectContaining({
            chatId: 'long',
            worktreeId: 'startup-recovery',
            resumeReason: 'app_shutdown',
          }),
        );
      expect(
        await window.evaluate(() =>
          window.api.listUsageLimitedIdleSessions({}),
        ),
      ).toEqual([]);
      await expect(
        home.getByTestId('home-interrupted-sessions-banner'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('covers usage-limit and application-stop interrupts and opens the shared resume modal', async () => {
    // Two queued resumes, paced 10 seconds apart, after launch.
    test.setTimeout(120_000);
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);

      const banner = homePage.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 2 interrupted sessions');

      await banner.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByText(
          'Resume chats and pipelines interrupted by an application stop, a usage limit, or an authentication issue.',
        ),
      ).toBeVisible();
      await expect(modal).toContainText(CHATS[0].title);
      await expect(modal).toContainText(CHATS[1].title);
      await expect(modal).toContainText('Application stopped');
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).toBeChecked();
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toBeChecked();

      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden({ timeout: 20_000 });

      // The resume queue starts sessions 10 seconds apart, so the second one
      // leaves the registry well after the dialog closes. Wait for the queue
      // to drain; its last settled resume refetches the banner away.
      await expect
        .poll(() => readRegistry(userDataDir).entries, { timeout: 60_000 })
        .toEqual([]);
      await expect(banner).toBeHidden({ timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('preserves pending choices and mounted rows through background workspace refreshes', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();
      await checkbox.focus();
      const originalRow = await checkbox.elementHandle();
      for (let refresh = 0; refresh < 3; refresh++) {
        await window.evaluate(() => {
          window.__canopyProjectsTestApi.holdNextLoadAfterRead();
          window.__canopyProjectsTestApi.loadProjects();
        });
        await window.evaluate(() =>
          window.__canopyProjectsTestApi.waitForHeldLoad(),
        );
        await window.evaluate(() =>
          window.__canopyProjectsTestApi.releaseHeldLoad(),
        );
        await expect(checkbox).not.toBeChecked();
        await expect(checkbox).toBeFocused();
        expect(await originalRow.evaluate((row) => row.isConnected)).toBe(true);
        await expect(
          modal.getByTestId('usage-limit-resume-confirm'),
        ).toHaveText('Resume 1 session');
      }
      await modal.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden();
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue.locator('li')).toHaveCount(1);
      await expect(queue).toContainText(CHATS[1].title);
      // Closing the selection dialog acknowledges enqueueing; dispatch and
      // registry cleanup complete asynchronously in the resume queue.
      await expect
        .poll(() =>
          readRegistry(userDataDir).entries.map((entry) => entry.chatId),
        )
        .toEqual([CHATS[0].id]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the loaded list and choices when a background refresh fails', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();

      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__failedResumeRefreshes = 0;
        ipcMain.removeHandler('usage-limited-sessions:list');
        ipcMain.handle('usage-limited-sessions:list', () => {
          globalThis.__failedResumeRefreshes += 1;
          throw new Error('Injected background refresh failure');
        });
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__failedResumeRefreshes),
        )
        .toBe(1);
      await window.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );

      await expect(modal).not.toContainText(
        'Couldn’t load interrupted sessions.',
      );
      await expect(checkbox).not.toBeChecked();
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 1 session',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('refreshes session additions and removals without clearing valid choices', async () => {
    const initial = [
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ];
    const userDataDir = seed(initial);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();
      await checkbox.focus();
      const originalRow = await checkbox.elementHandle();
      const newEntry = registryEntry(CHATS[2], 'app_shutdown');
      seedUsageLimitedChats({ userDataDir, entries: [...initial, newEntry] });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      const newCheckbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[2].id}`,
      );
      await expect(newCheckbox).toBeVisible();
      await expect(newCheckbox).not.toBeChecked();
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toBeFocused();
      expect(await originalRow.evaluate((row) => row.isConnected)).toBe(true);
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 1 session',
      );
      seedUsageLimitedChats({ userDataDir, entries: [initial[0], newEntry] });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toHaveCount(0);
      await expect(
        modal.getByTestId('usage-limit-resume-confirm'),
      ).toBeDisabled();
      await expect(checkbox).not.toBeChecked();
      await modal.getByTestId('usage-limit-resume-cancel').click();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('dismisses until the interrupted set changes, across providers', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[2], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);

      const banner = homePage.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 2 interrupted sessions');

      await banner.getByTestId('home-interrupted-sessions-dismiss').click();
      await expect(banner).toBeHidden();

      // Leaving and returning to Home does not resurrect a dismissed banner
      // for the same interrupted set.
      await app.openMainPage();
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await window.waitForTimeout(1_000);
      await expect(banner).toBeHidden();

      // A new interruption changes the set: the banner returns on the next
      // refresh (window focus is one of the refresh triggers).
      seedUsageLimitedChats({
        userDataDir,
        entries: [
          registryEntry(CHATS[0], 'usage_limit'),
          registryEntry(CHATS[2], 'app_shutdown'),
          registryEntry(CHATS[1], 'authentication'),
        ],
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 3 interrupted sessions');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not render when nothing is interrupted', async () => {
    const userDataDir = seed([]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);
      await expect(homePage.getByTestId('home-composer')).toBeVisible();
      await window.waitForTimeout(1_500);
      await expect(
        homePage.getByTestId('home-interrupted-sessions-banner'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
