import { mkdtempSync } from 'node:fs';
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

export async function withResumeQueue(verify, count = 17, mode = 'complete') {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-resume-queue-'),
  );
  const projectId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  const chatIds = Array.from(
    { length: count },
    (_, index) => `resume-queue-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    tabs: chatIds.map((id, index) => ({
      id,
      title: `Interrupted task ${index + 1}`,
      model: 'gpt-6-sol',
    })),
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
