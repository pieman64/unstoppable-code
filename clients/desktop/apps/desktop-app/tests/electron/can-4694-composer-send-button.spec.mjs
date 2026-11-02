// CAN-4694: real host click paths for the shared composer control. Slow mock
// turns keep Stop deterministic; no terminal command is executed.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

async function expectCompact(control) {
  await expect(async () => {
    const box = await control.boundingBox();
    expect(box?.width).toBeCloseTo(32, 0);
    expect(box?.height).toBeCloseTo(32, 0);
  }).toPass();
}

for (const surface of ['chat', 'Home']) {
  test(`CAN-4694 ${surface} sends once, stops, and returns to idle`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can4694-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { uiScale: 100 },
    });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });
    const marker = `Canopy-C4694${surface.toUpperCase()}`;
    const prompt = `[${marker}] send exactly once from ${surface}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: 'A slow cancellable reply for the shared control.',
            streamMs: 120_000,
          },
        ],
      },
    });
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, viewportSize: { width: 1400, height: 900 } }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      if (surface === 'Home') {
        await window.getByTestId('sidebar-create-task').click();
        const home = window.getByTestId('page-home');
        const editor = home.getByTestId('home-composer-editor');
        const send = home.getByTestId('home-send-button');
        await expect(editor.locator('[data-slate-placeholder]')).toHaveText(
          '@ to mention, / skills and commands',
        );
        await expect(send).toHaveAccessibleName('Send message');
        // Existing chat-mode policy permits empty task creation. Do not change
        // it to satisfy the plan's contradictory blanket disabled assertion.
        await expect(send).toBeEnabled();
        await expectCompact(send);
        await send.hover();
        await expect(window.getByRole('tooltip')).toContainText('Send');
        await editor.fill(prompt);
        await home.getByTestId('home-branch-picker-button').click();
        await window
          .getByTestId('home-branch-picker-worktree-demo-main')
          .click();
        await expect(send).toBeEnabled();
        await send.click();
        await expect(home).toHaveCount(0);
      } else {
        const composer = window
          .locator('[data-chat-composer-root]:visible')
          .first();
        const shell = composer.locator('[data-composer-layout]');
        const editor = composer.getByRole('textbox');
        await expect(shell).toHaveAttribute('data-composer-layout', 'one-line');
        await editor.fill('wrap this draft '.repeat(30));
        await expect(shell).toHaveAttribute('data-composer-layout', 'full');
        await editor.fill('short');
        await expect(shell).toHaveAttribute('data-composer-layout', 'one-line');
        await composer.getByTestId('chat-input-plus-button').click();
        await expect(
          window.getByRole('dialog', { name: 'Composer actions' }),
        ).toBeVisible();
        await window.keyboard.press('Escape');
        await composer.getByRole('textbox').fill(prompt);
        const send = composer.getByRole('button', {
          name: 'Send message',
          exact: true,
        });
        await expectCompact(send);
        await send.click();
      }
      const composer = window
        .locator('[data-chat-composer-root]:visible')
        .first();
      const stop = composer.getByTestId('chat-stop-generation');
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await expectCompact(stop);
      await expect(stop).toHaveAccessibleName('Stop generation');
      await stop.click();
      await expect(stop).toHaveCount(0, { timeout: 30_000 });
      await expect(
        window.locator('[data-role="user"]').filter({ hasText: prompt }),
      ).toHaveCount(1);
      const editor = composer.getByRole('textbox');
      await editor.fill('follow-up draft');
      await expect(
        composer.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeEnabled();
      await editor.fill('!ls');
      await expect(
        composer.getByRole('button', {
          name: 'Run terminal command',
          exact: true,
        }),
      ).toBeEnabled();
      await editor.fill('');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
