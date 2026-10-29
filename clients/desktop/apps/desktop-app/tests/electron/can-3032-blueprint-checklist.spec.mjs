import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedBlueprintCatalog,
  seedCoworkWorkspace,
  seedPluginsCache,
} from './seeders/index.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// CAN-3032 — the Getting Started checklist tailored to the active project
// template.
//
// A chat project seeded from a curated project template (CAN-2964) opens its
// empty new chat with that template's own setup leading the shared checklist:
// one "Add" row per bundled plugin this device can enable (rows for plugins
// the project already enabled are reflected as done), then the template's
// starter prompts. The general checklist follows, and projects without a
// template keep it as-is.
//
// What this spec pins:
//   - A seeded project's new chat leads with the template's plugin, under a
//     heading naming the template, mirrored in the sidebar pill.
//   - Adding the plugin enables it and advances to the starter prompts.
//   - Trying a starter prompt fills the chat composer; sending completes the
//     item durably (chat-tab sends now report like Home sends).
//   - A project whose default selections already carry the plugin starts on
//     its prompts, with the plugin counted toward progress. The prompts are
//     one step: only the first row carries the arrows, Next leaves all of
//     them, and Back returns to all of them.
//   - A plain chat project and the Home page keep the general checklist.
//   - After the template's steps, answering the role question moves on, and
//     answering it again after going Back to it moves on too.
//   - A user who already exhausted the general checklist still gets the
//     template rows in a seeded project's new chat (the context is published
//     by the chat surface, not by the slot that only mounts for a live queue).
//
// Deterministic: fresh user-data dirs; the template catalog, plugins cache,
// welcome-checklist state and chat projects are all seeded on disk. No live
// agents, no network.

const MARKETING_ID = '11111111-1111-4111-8111-111111111111';
const GIT_PLUGIN_KEY = 'builtin/app/builtin-git';
const EMPTY_SELECTIONS = { collectionIds: [], skillRefs: [], pluginRefs: [] };

function seedProfile(welcome = { fresh: true }) {
  const userDataDir = seedWelcomeChecklist(welcome);
  seedBlueprintCatalog({ userDataDir });
  // The Marketing template bundles `builtin-git` from the built-in
  // marketplace; the checklist resolves it there, not by name elsewhere.
  seedPluginsCache({
    userDataDir,
    builtInPlugins: [
      {
        name: 'builtin-git',
        displayName: 'Git',
        description: 'Commit, branch, and review changes',
      },
    ],
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'marketing-fresh',
    name: 'Marketing launch',
    providerType: 'claude',
    defaultModel: null,
    seedMessage: false,
    seededFromBlueprintExternalId: MARKETING_ID,
    defaultPluginSelections: EMPTY_SELECTIONS,
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'marketing-ready',
    name: 'Marketing ready',
    chatId: 'marketing-ready-chat',
    providerType: 'claude',
    defaultModel: null,
    seedMessage: false,
    seededFromBlueprintExternalId: MARKETING_ID,
    defaultPluginSelections: {
      ...EMPTY_SELECTIONS,
      pluginRefs: [{ marketplaceId: 'builtin/app', pluginName: 'builtin-git' }],
    },
    mergeIndex: true,
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'plain-project',
    name: 'Plain project',
    chatId: 'plain-project-chat',
    providerType: 'claude',
    defaultModel: null,
    seedMessage: false,
    mergeIndex: true,
  });
  return userDataDir;
}

async function openNewChat(window, workspaceId) {
  const header = window.getByTestId(
    `sidebar-cowork-project-${workspaceId}-header`,
  );
  await expect(header).toBeVisible({ timeout: 15_000 });
  await header.hover();
  await window
    .getByTestId(`sidebar-cowork-project-${workspaceId}-new-chat`)
    .click();
  const host = window.getByTestId('chat-onboarding-checklist-host');
  await expect(host).toBeVisible({ timeout: 15_000 });
  return host;
}

function loadPreferences(window) {
  return window.evaluate(() => window.api.loadPreferences());
}

test.describe('CAN-3032 project template checklist', () => {
  test('a seeded project leads with its template plugin, then its starter prompts, and a sent prompt completes', async () => {
    test.setTimeout(180_000);
    const userDataDir = seedProfile();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const host = await openNewChat(window, 'marketing-fresh');
      const pluginRow = host.getByTestId(
        'home-onboarding-suggestion-blueprint:marketing-fresh:plugin:builtin-git',
      );
      await expect(pluginRow).toBeVisible({ timeout: 15_000 });
      await expect(pluginRow.locator('h2')).toContainText(
        'Get started with Marketing',
      );
      // The general checklist waits behind the template's own setup.
      await expect(
        host.getByTestId('home-onboarding-suggestion-agent-connections'),
      ).toHaveCount(0);
      // The chat's full card owns the queue, so the footer card stays away.
      const sidebar = window.getByTestId('sidebar-onboarding-checklist');
      await expect(sidebar).toHaveCount(0);

      await host
        .getByTestId(
          `home-onboarding-suggestion-cta-plugin-add-${GIT_PLUGIN_KEY}`,
        )
        .click();
      await expect
        .poll(
          async () =>
            (await loadPreferences(window)).globalPluginSelections?.pluginRefs,
        )
        .toContainEqual({
          marketplaceId: 'builtin/app',
          pluginName: 'builtin-git',
        });
      const promptRow = host.getByTestId(
        'home-onboarding-suggestion-blueprint:marketing-fresh:prompt:ws-1',
      );
      await expect(promptRow).toBeVisible();
      await expect(pluginRow).toHaveCount(0);
      await expect(sidebar).toHaveCount(0);

      await promptRow
        .getByTestId('home-onboarding-suggestion-cta-prompt')
        .click();
      const editor = window
        .locator('[data-slate-editor="true"]:visible')
        .first();
      await expect(editor).toContainText('Draft a launch announcement');
      await editor.press('Enter');
      await expect
        .poll(
          async () =>
            (await loadPreferences(window)).homeOnboardingSuggestions
              ?.entries?.['blueprint:marketing-fresh:prompt:ws-1']?.completedAt,
          { timeout: 20_000 },
        )
        .toBeTruthy();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a finished general checklist still yields the template rows in a seeded project', async () => {
    test.setTimeout(180_000);
    // Every general and advanced item resolved: Home shows no checklist.
    const userDataDir = seedProfile({ exhausted: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await expect(
        window.getByTestId('home-onboarding-suggestions'),
      ).toHaveCount(0);

      const host = await openNewChat(window, 'marketing-fresh');
      await expect(
        host.getByTestId(
          'home-onboarding-suggestion-blueprint:marketing-fresh:plugin:builtin-git',
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an already-enabled template plugin counts as done, and projects without a template keep the general checklist', async () => {
    test.setTimeout(180_000);
    const userDataDir = seedProfile();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const ready = await openNewChat(window, 'marketing-ready');
      await expect(
        ready.getByTestId(
          'home-onboarding-suggestion-blueprint:marketing-ready:prompt:ws-1',
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        ready.getByTestId(
          'home-onboarding-suggestion-blueprint:marketing-ready:plugin:builtin-git',
        ),
      ).toHaveCount(0);
      // The enabled plugin is step 1, already done: the prompt is step 2.
      await expect(
        ready.getByTestId('home-onboarding-checklist-progress'),
      ).toHaveText(/^2\//);
      // The prompts are one step: the second shares the window without
      // arrows of its own, Next leaves both, and Back returns to both.
      const firstPrompt = ready.getByTestId(
        'home-onboarding-suggestion-blueprint:marketing-ready:prompt:ws-1',
      );
      const nextPrompt = ready.getByTestId(
        'home-onboarding-suggestion-blueprint:marketing-ready:prompt:ws-2',
      );
      await expect(nextPrompt).toBeVisible();
      await expect(
        nextPrompt.locator('[data-checklist-navigation]'),
      ).toHaveCount(0);
      // The step's arrow is named for everything it skips.
      const stepSkip = ready.getByTestId(
        'home-onboarding-suggestion-dismiss-blueprint:marketing-ready:prompt:ws-1',
      );
      await expect(stepSkip).toHaveAttribute(
        'aria-label',
        'Skip Marketing prompts',
      );
      await stepSkip.click();
      await expect(firstPrompt).toHaveCount(0);
      await expect(nextPrompt).toHaveCount(0);
      await expect(
        ready.getByTestId('home-onboarding-checklist-progress'),
      ).toHaveText(/^3\//);
      await ready.locator('[data-testid$="-previous"]').first().click();
      await expect(firstPrompt).toBeVisible();
      await expect(nextPrompt).toBeVisible();
      await expect(
        ready.getByTestId('home-onboarding-checklist-progress'),
      ).toHaveText(/^2\//);

      const plain = await openNewChat(window, 'plain-project');
      await expect(
        plain.getByTestId('home-onboarding-suggestion-agent-connections'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        plain.locator('[data-testid^="home-onboarding-suggestion-blueprint:"]'),
      ).toHaveCount(0);

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      await expect(
        home.getByTestId('home-onboarding-suggestion-agent-connections'),
      ).toBeVisible();
      await expect(
        home.locator('[data-testid^="home-onboarding-suggestion-blueprint:"]'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
