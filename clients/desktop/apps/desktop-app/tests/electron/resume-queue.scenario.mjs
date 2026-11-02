import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  createFixture,
  closeFixture,
  seedPreferences,
  conversationRequests,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedUsageLimitedChats, seedWorktreeChat } from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

export async function withResumeQueue(
  verify,
  count = 17,
  mode = 'complete',
  {
    startupOffer = false,
    messages = [],
    beforeResume,
    welcomeChecklist = false,
    chatTitle,
    otherActiveChat = false,
  } = {},
) {
  const userDataDir = welcomeChecklist
    ? seedWelcomeChecklist()
    : mkdtempSync(path.join(os.tmpdir(), 'canopy-resume-queue-'));
  const projectId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const welcomePreferences = welcomeChecklist
    ? JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      ).preferences
    : {};
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  if (welcomeChecklist) {
    const preferencesPath = path.join(userDataDir, 'preferences.json');
    const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    preferences.preferences = {
      ...preferences.preferences,
      ...welcomePreferences,
    };
    // Complete the demo repository's readiness steps too, so the normal
    // window contains several interchangeable examples and can prove trim.
    for (const repo of ['app', 'ts-pnpm-vite']) {
      for (const code of [
        'configure-scripts',
        'configure-hooks',
        'configure-agent-instructions',
      ]) {
        preferences.preferences.homeOnboardingSuggestions.entries[
          `advanced:readiness:${projectId}:${repo}:${code}`
        ] = { completedAt: '2026-09-01T12:00:00.000Z' };
      }
    }
    writeFileSync(preferencesPath, JSON.stringify(preferences));
  }
  if (startupOffer) {
    const preferencesPath = path.join(userDataDir, 'preferences.json');
    const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    preferences.preferences.lastActiveContext = {
      kind: 'worktree',
      workspaceId: projectId,
      worktreeId,
    };
    writeFileSync(preferencesPath, JSON.stringify(preferences));
  }
  const chatIds = Array.from(
    { length: count },
    (_, index) => `resume-queue-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    activeTabId: otherActiveChat ? 'other-active-chat' : chatIds[0],
    tabs: [
      ...chatIds.map((id, index) => ({
        id,
        title: chatTitle ?? `Interrupted task ${index + 1}`,
        model: 'gpt-6-sol',
        messages,
      })),
      ...(otherActiveChat
        ? [{ id: 'other-active-chat', title: 'Different active chat' }]
        : []),
    ],
  });
  seedUsageLimitedChats({
    userDataDir,
    entries: chatIds.map((chatId) => ({
      projectId,
      worktreeId,
      chatId,
      provider: 'codex',
      resumeReason: 'app_shutdown',
      detectedAt: 1790070000000,
      workspaceName: 'TypeScript pnpm Vite',
      chatTitle: chatId,
    })),
  });
  const fixture = createFixture(mode);
  let electronApp;
  let killAbruptly;
  const start = async () => {
    ({ electronApp, killAbruptly } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    return { window, app };
  };
  try {
    const initial = await start();
    await initial.window.getByTestId('sidebar-create-task').click();
    await beforeResume?.({ ...initial, userDataDir, chatIds });
    await initial.window
      .getByTestId('home-interrupted-sessions-resume')
      .click();
    await expect(
      initial.window.getByTestId('usage-limit-resume-modal'),
    ).toBeVisible();
    await verify({
      ...initial,
      userDataDir,
      chatIds,
      fixture,
      starts: () =>
        conversationRequests(fixture.logPath).filter(
          (request) => request.method === 'turn/start',
        ),
      restart: async (crash = false) => {
        if (crash) {
          await killAbruptly();
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        } else
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = undefined;
        return start();
      },
    });
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
}
