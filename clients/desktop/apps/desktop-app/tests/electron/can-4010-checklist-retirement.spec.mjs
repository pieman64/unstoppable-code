import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

test('legacy checklist data cannot restore Home, sidebar or Settings UI after restart', async () => {
  test.setTimeout(300_000);
  const userDataDir = seedWelcomeChecklist({ fresh: true, startedChat: true });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'retirement-chat', title: 'Retirement', model: 'sonnet' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CAN4010', {
    llm: {
      steps: [{ text: 'Legacy data stayed retired', stopReason: 'end_turn' }],
    },
  });
  const legacyPath = path.join(userDataDir, 'onboarding-checklist.json');
  const legacy = readFileSync(legacyPath, 'utf8');
  const legacyModifiedAt = statSync(legacyPath).mtimeMs;
  for (const restart of [false, true]) {
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const composer = window
        .getByTestId('home-composer-editor')
        .locator('visible=true');
      await expect(composer).toBeVisible();
      await expect(
        window.getByTestId('home-onboarding-suggestions'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('sidebar-onboarding-checklist'),
      ).toHaveCount(0);
      expect(
        await window.evaluate(() => 'onboardingChecklist' in window.api),
      ).toBe(false);
      await composer.fill('Keep this draft');
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await expect(
        window.getByTestId('settings-profile-role-edit'),
      ).toBeVisible();
      await expect(
        window.getByTestId('settings-canopy-restore-checklist'),
      ).toHaveCount(0);
      await app.closeSettings();
      await expect(composer).toContainText('Keep this draft');
      if (!restart) {
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        const panel = window.getByTestId('panel-content-chat');
        await expect(panel).toBeVisible();
        const chatComposer = window.getByRole('textbox').first();
        await chatComposer.fill('[Canopy-CAN4010] Check retirement');
        await window.getByRole('button', { name: 'Send message' }).click();
        await expect(
          panel.getByText('Legacy data stayed retired').first(),
        ).toBeVisible({ timeout: 90_000 });
      }
      expect(readFileSync(legacyPath, 'utf8')).toBe(legacy);
      expect(statSync(legacyPath).mtimeMs).toBe(legacyModifiedAt);
    } finally {
      await closeCanopy(electronApp, userDataDir, { keepUserData: !restart });
    }
  }
});
