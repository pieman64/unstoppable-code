import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson, seedCoworkWorkspace } from './seeders/index.mjs';
import { seedHomeComposerSkills } from './seeders/seedHomeComposerSkills.mjs';

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

function seedProviderPreferences(userDataDir, provider, model) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      defaultWorktreeProvider: provider,
      defaultChatProvider: provider,
      defaultWorktreeModelByProvider: {
        [provider]: { model, thinkingLevel: 'high' },
      },
      defaultChatModelByProvider: {
        [provider]: { model, thinkingLevel: 'high' },
      },
      providerModelConfigDefaults: {
        [provider]: { thinkingLevel: 'high' },
      },
    },
  });
}

async function withProviderHome(provider, model, run) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-reg-2878-home-${provider}-`),
  );
  seedProviderPreferences(userDataDir, provider, model);
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();

    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    await expect(homePage.getByTestId('home-workspace-select')).toContainText(
      WORKSPACE_NAME,
    );
    await expect(
      homePage.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', provider);

    await run(homePage);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}

test.describe('REG-2878 Home composer provider triggers', () => {
  for (const provider of ['claude', 'codex']) {
    for (const entryPoint of ['slash', 'plus']) {
      test(`${provider} new task ${entryPoint} discovers project and enabled skills and enables an available skill`, async ({}, testInfo) => {
        test.setTimeout(120_000);
        const userDataDir = mkdtempSync(
          path.join(os.tmpdir(), `canopy-home-skills-${provider}-`),
        );
        seedHomeComposerSkills(userDataDir, provider);
        const { electronApp } = await launchCanopy({ userDataDir });
        try {
          const window = await electronApp.firstWindow();
          const app = new CanopyAppDriver(window);
          await app.waitForShell();
          await window.getByTestId('sidebar-create-task').click();
          const home = window.getByTestId('page-home');
          await expect(home.getByTestId('home-workspace-select')).toContainText(
            WORKSPACE_NAME,
          );
          await expect(
            home.getByTestId('chat-model-picker-provider-icon'),
          ).toHaveAttribute('data-provider', provider);
          const editor = home.getByTestId('home-composer-editor');
          if (entryPoint === 'slash') {
            await editor.fill('/home-project-skill');
            await expect(
              window.getByTestId('home-composer-capability-home-project-skill'),
            ).toBeVisible({ timeout: 45_000 });
            await editor.fill('@home-project-skill');
            await expect(
              window.getByTestId('home-composer-capability-home-project-skill'),
            ).toHaveCount(0);
          }
          await editor.fill(
            entryPoint === 'slash' ? '/home-project-skill' : 'Keep this draft',
          );
          if (entryPoint === 'plus') {
            await home.getByTestId('home-composer-plus-button').click();
            await editor.pressSequentially('home-project-skill');
          }
          const menu = window.getByTestId('home-composer-plus-menu');
          const projectSkill = menu
            .getByRole('button')
            .filter({ hasText: 'Home composer home-project-skill' });
          await expect(projectSkill).toBeVisible({ timeout: 45_000 });
          await projectSkill.click();
          await expect(editor).toHaveText(/home-project-skill\s$/);
          if (entryPoint === 'plus') {
            await expect(editor).toHaveText(
              /Keep this draft (?:\/|\$).*home-project-skill\s$/,
            );
          }
          await expect(menu).toHaveCount(0);
          if (provider === 'claude') {
            await editor.fill('');
            if (entryPoint === 'plus')
              await home.getByTestId('home-composer-plus-button').click();
            await editor.pressSequentially(
              `${entryPoint === 'slash' ? '/' : ''}home-project-command`,
            );
            await menu
              .getByTestId('home-composer-capability-home-project-command')
              .click();
            await expect(editor).toContainText('/home-project-command');
            await expect(menu).toHaveCount(0);
          }
          await editor.fill('');
          if (entryPoint === 'plus')
            await home.getByTestId('home-composer-plus-button').click();
          await editor.pressSequentially(
            `${entryPoint === 'slash' ? '/' : ''}home-enabled-skill`,
          );
          const enabledSkill = menu
            .getByRole('button')
            .filter({ hasText: 'Home composer home-enabled-skill' });
          await expect(enabledSkill).toBeVisible();
          await enabledSkill.click();
          // A fallback resolves asynchronously. The space distinguishes the
          // completed insertion from the still-visible search query.
          await expect(editor).toHaveText(/home-enabled-skill\s$/);
          await expect(menu).toHaveCount(0);
          // A new target may spend time preparing its checkout or querying the
          // provider. Already indexed capabilities must remain usable meanwhile.
          await electronApp.evaluate(({ ipcMain }) => {
            const discover = ipcMain._invokeHandlers.get(
              'home:discover-environment',
            );
            globalThis.homeSkillsDiscoveryPending = false;
            const gate = new Promise((resolve) => {
              globalThis.releaseHomeSkillsDiscovery = resolve;
            });
            ipcMain.removeHandler('home:discover-environment');
            ipcMain.handle(
              'home:discover-environment',
              async (event, request) => {
                globalThis.homeSkillsDiscoveryPending = true;
                await gate;
                return discover(event, request);
              },
            );
          });
          await home.getByTestId('home-workspace-clear').click();
          await home.getByTestId('home-workspace-select').click();
          await window
            .getByTestId('home-workspace-option-demo-ts-pnpm-vite')
            .click();
          await expect
            .poll(() =>
              electronApp.evaluate(() => globalThis.homeSkillsDiscoveryPending),
            )
            .toBe(true);
          await editor.click();
          await editor.press('End');
          await editor.pressSequentially(' ');
          if (entryPoint === 'plus')
            await home.getByTestId('home-composer-plus-button').click();
          await editor.pressSequentially(
            `${entryPoint === 'plus' ? '' : provider === 'codex' ? '$' : '/'}home-available-skill`,
          );
          // The add menu groups an available skill under its heading; typed
          // slash search is one flat list that tags the row (CAN-5271).
          const available = (
            entryPoint === 'plus'
              ? menu.getByRole('group', { name: 'Available to enable' })
              : menu
          )
            .getByRole('button')
            .filter({ hasText: 'Home composer home-available-skill' })
            .filter({
              has: window.getByTestId('slash-command-availability-tag'),
            });
          await expect(available).toBeVisible();
          await available.click();
          await expect(menu).toHaveCount(0);
          await expect(editor).toHaveText(/home-available-skill\s$/);
          await home.getByTestId('home-composer-plus-button').click();
          await menu.getByTestId('home-plugins-button').click();
          const dialog = window
            .getByRole('dialog')
            .filter({ has: window.getByTestId('plugin-selector-scope') });
          await dialog
            .getByPlaceholder('Search by name…')
            .fill('home-available-skill');
          await expect(
            dialog.getByRole('checkbox', {
              name: 'Select home-available-skill',
            }),
          ).toBeChecked();
        } finally {
          const logPath = path.join(userDataDir, 'logs', 'main.log');
          if (existsSync(logPath)) {
            await testInfo.attach('main-log', {
              path: logPath,
              contentType: 'text/plain',
            });
          }
          await electronApp.evaluate(() =>
            globalThis.releaseHomeSkillsDiscovery?.(),
          );
          await closeCanopy(electronApp, userDataDir);
        }
      });
    }
  }

  test('opens the skills menu for $ with the Codex provider selected', async () => {
    await withProviderHome('codex', 'gpt-5.5', async (homePage) => {
      const editor = homePage.getByTestId('home-composer-editor');
      await editor.click();
      await editor.fill('$');
      await expect(
        homePage.page().getByTestId('home-composer-plus-menu'),
      ).toBeVisible();
    });
  });

  test('opens model controls from slash without submitting the draft', async () => {
    await withProviderHome('claude', 'sonnet', async (homePage) => {
      const editor = homePage.getByTestId('home-composer-editor');
      await editor.click();
      await editor.fill('Keep this draft /model');
      const menu = homePage.page().getByTestId('home-composer-plus-menu');
      await expect(menu).toBeVisible();
      await menu
        .getByRole('button')
        .filter({ hasText: 'Choose the model' })
        .click();
      await expect(editor).toContainText('Keep this draft');
      await expect(editor).not.toContainText('/model');
      await expect(homePage).toBeVisible();
      await expect(
        homePage.page().getByTestId('chat-model-menu'),
      ).toBeVisible();
    });
  });

  test('keeps $ as prose for Claude while / still opens the commands menu', async () => {
    await withProviderHome('claude', 'sonnet', async (homePage) => {
      const editor = homePage.getByTestId('home-composer-editor');
      const slashMenu = homePage.page().getByTestId('home-composer-plus-menu');
      await editor.click();
      await editor.fill('$');
      await expect(slashMenu).toHaveCount(0);

      // Slate can treat a direct replacement fill as another text insertion
      // while its previous controlled update is still settling. Use the real
      // select/delete/type interaction so this assertion exercises `/`, not
      // the accidental `$/` captured by the full-suite failure trace.
      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.press('/');
      await expect(slashMenu).toBeVisible();
    });
  });
});

test('CoWork slash action opens model selection without sending', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can1839-cowork-'));
  const { workspaceId, chatId } = seedCoworkWorkspace({
    userDataDir,
    collapsed: false,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${workspaceId}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${chatId}`).click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    const editor = panel.getByRole('textbox').first();
    await editor.click();
    await editor.fill('Keep CoWork draft /model');
    await window
      .getByTestId('chat-input-plus-menu')
      .getByRole('button')
      .filter({ hasText: 'Choose the model' })
      .click();
    await expect(window.getByTestId('chat-model-menu')).toBeVisible();
    await expect(editor).toContainText('Keep CoWork draft');
    await expect(editor).not.toContainText('/model');
    // The pointer can rest on More when the picker opens over the composer,
    // opening a nested flyout. Leave it before checking the parent Escape path.
    await window.mouse.move(0, 0);
    await expect(
      window.locator('[data-floating-menu-nested="true"]'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('chat-model-menu')).toBeHidden();
    await expect(editor).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('embedded Home routes slash model action to its own picker', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    const home = window
      .getByTestId('page-main')
      .locator('[data-testid="home-surface"][data-variant="embedded"]');
    await expect(home).toBeVisible();
    const editor = home.getByTestId('home-composer-editor');
    // The composer is read-only until Home has a project to send to, and
    // `fill` does not wait for that.
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('Embedded draft /model');
    await window
      .getByTestId('home-composer-plus-menu')
      .getByRole('button')
      .filter({ hasText: 'Choose the model' })
      .click();
    await expect(window.getByTestId('chat-model-menu')).toBeVisible();
    await expect(window.getByTestId('chat-model-menu')).toHaveCount(1);
    await expect(editor).toContainText('Embedded draft');
    await expect(editor).not.toContainText('/model');
    await window.keyboard.press('Escape');
    await expect(editor).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
