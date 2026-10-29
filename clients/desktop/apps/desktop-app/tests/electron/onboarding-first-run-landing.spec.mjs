import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeAuthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { toggleHomePlanMode } from './homeComposerMenu.mjs';

test('welcome card has per-row Skip actions without left checkboxes or a card dismiss', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const card = window.getByTestId('home-onboarding-suggestions');
    await expect(card).toBeVisible();
    await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
    await expect(
      card.getByTestId('home-onboarding-suggestions-dismiss'),
    ).toHaveCount(0);
    await expect(card).not.toContainText(
      'Try something new. More suggestions appear as you go.',
    );
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await expect(card.getByRole('button', { name: /^Dismiss / })).toHaveCount(
      0,
    );
    // The forward arrow reads Next once the providers are connected (the
    // harness signs them in) and Skip otherwise; either moves on.
    const forward = card.locator(
      'button[data-checklist-navigation="true"]:not([data-testid$="-previous"])',
    );
    await expect(forward).toBeVisible();
    await forward.focus();
    await window.keyboard.press('Space');
    await expect(
      card.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toHaveCount(0);
    await expect(
      card.getByTestId('home-onboarding-suggestion-add-repo'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('a legacy card dismissal no longer hides the welcome card', async () => {
  // The card has no dismiss control any more, so the CAN-2411 card dismissal
  // must not keep it hidden — the user has no way to bring it back.
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true, legacyDismissed: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.skipFirstRunImport();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestions'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
    // The sidebar card mounts away from Home, where the full card owns it.
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('a historical retirement restores the welcome card in place of the prompt chips', async () => {
  test.setTimeout(180_000);
  // Positive control first. `toHaveCount(0)` is satisfied on its first poll
  // and never waits for something to *stop* appearing, so asserting the
  // chips are absent proves nothing on its own — it would pass identically
  // on a build that still rendered them, just more slowly. Every install
  // starts the onboarding module now, so this launch holds it back through
  // the harness env; that both proves the harness renders the chips at all
  // and measures how long they take.
  const control = await launchCanopy({
    freshOnboardingChecklist: true,
    env: { CANOPY_E2E_ONBOARDING_SUGGESTIONS: 'hidden' },
  });
  let chipLatencyMs = 0;
  try {
    const window = await control.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const startedAt = Date.now();
    await expect(window.getByTestId('suggested-prompt-chips')).toBeVisible();
    chipLatencyMs = Date.now() - startedAt;
    // Asserted only once the chips are up, so the page is demonstrably
    // settled — `toHaveCount(0)` is satisfied on its first poll and would
    // prove nothing before that.
    await expect(window.getByTestId('home-onboarding-suggestions')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(control.electronApp, control.userDataDir);
  }

  // A retirement written by the removed whole-module callback must not keep
  // the card hidden either.
  const retired = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true, retired: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await retired.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestions'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
    // The sidebar card mounts away from Home, where the full card owns it.
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toBeVisible();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestions'),
    ).toBeVisible();
    // Restoring the card also takes the suggested-prompt chips away:
    // `HomeSurface` passes `null` to `useSuggestedPrompts` while the module
    // is visible, and retirement used to be the way back to them. Wait well
    // past the control's measured latency so the absence is a settled state,
    // with a ceiling so a slow control host cannot blow the test budget.
    await window.waitForTimeout(
      Math.min(Math.max(chipLatencyMs * 4, 5000), 30_000),
    );
    await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
  } finally {
    await closeCanopy(retired.electronApp, retired.userDataDir);
  }
});

test('Home and sidebar advance the same focused suggestion queue', async () => {
  const userDataDir = seedWelcomeChecklist({ fresh: true });
  const launch = await launchCanopy({
    userDataDir,
    freshOnboardingChecklist: true,
    // The examples preview only queues behind a connected tool, so pin GitHub
    // as signed in instead of reading the host's own `gh` login.
    env: { GH_EXECUTABLE: writeAuthenticatedGhFixture(userDataDir) },
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const card = window.getByTestId('home-onboarding-suggestions');
    const rows = card.locator(':scope > ul > li');
    await expect(rows).toHaveCount(1);
    // AI providers lead; the roles question is the category row on the
    // tools step rather than a step of its own.
    await expect(rows.nth(0)).toHaveAttribute(
      'data-testid',
      'home-onboarding-suggestion-agent-connections',
    );
    // Home steps the queue first; the sidebar card mounts away from Home.
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    await app.homeChecklistForward('agent-connections').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(app.homeChecklistRow('add-repo')).toBeVisible();
    await app.homeChecklistForward('add-repo').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-add-repo'),
    ).toHaveCount(0);
    await expect(app.homeChecklistRow('github')).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveAttribute('aria-label', /^Step 3 of \d+$/);
    // A category pick on the tools step saves at once and keeps the step.
    const tools = window.getByTestId('home-onboarding-suggestion-github');
    await tools
      .getByTestId('home-onboarding-category-software-engineer')
      .click();
    await expect(
      tools.getByTestId('home-onboarding-category-software-engineer'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(tools).toBeVisible();
    await window.getByTestId('sidebar-nav-plugins').click();
    await expect(card).toHaveCount(0);
    // The sidebar picks up the step Home left off on, as one action with no
    // counter or arrows.
    await expect(sidebar).toHaveAttribute('data-entry-id', 'github');
    await expect(
      sidebar.getByTestId('sidebar-onboarding-progress'),
    ).toHaveCount(0);
    // Queue ownership survives navigation; stepping the queue stays on Home.
    await window.getByTestId('sidebar-create-task').click();
    await app.homeChecklistForward('github').click();
    // The gh fixture reports GitHub as connected, so the examples preview
    // follows.
    await expect(app.homeChecklistRow('plugin-examples-preview')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await window.reload();
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(app.homeChecklistRow('plugin-examples-preview')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-suggestion-github'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('a plan-mode prompt stages a draft and completes only after an accepted send', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntry: 'plan-mode',
      roles: ['other'],
    }),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const editor = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await window
      .getByTestId('page-home')
      .getByTestId('home-onboarding-suggestion-cta-prompt')
      .click();
    await expect(editor).toContainText('Help me plan a project');
    await expect(app.homeChecklistRow('plan-mode')).toBeVisible();
    await window
      .getByTestId('page-home')
      .getByTestId('home-branch-picker-button')
      .click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await editor.press('Enter');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.entries['plan-mode']?.completedAt,
      )
      .toBeTruthy();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-plan-mode'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the plan lesson preserves the draft and completes after sending in plan mode', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ pendingEntry: 'plan-mode' }),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const editor = home.getByTestId('home-composer-editor');
    const draft = 'Add a searchable activity history to the project.';
    await editor.fill(draft);
    await home
      .getByTestId('home-onboarding-suggestion-cta-create-plan')
      .click();
    await expect(editor).toHaveText(draft);
    // The highlight points at +, where Plan mode lives; picking it there
    // turns Plan mode on and retires the highlight.
    await expect(window.getByTestId('home-plan-mode-highlight')).toBeVisible();
    await toggleHomePlanMode(window, home);
    // Plan shows its tile beside +; + itself only lights for Pipeline.
    await expect(
      home.getByTestId('home-plan-mode-inline-button'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      home.getByTestId('home-composer-plus-button'),
    ).not.toHaveAttribute('data-active', 'true');
    await expect(window.getByTestId('home-plan-mode-highlight')).toHaveCount(0);
    await expect(
      home.getByTestId('home-onboarding-suggestion-plan-mode'),
    ).toBeVisible();
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await editor.press('Enter');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.entries['plan-mode']?.completedAt,
      )
      .toBeTruthy();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-plan-mode'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the local role reset clears the welcome answer without resetting other activities', async () => {
  const launch = await launchCanopy({ userDataDir: seedWelcomeChecklist() });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-github'),
    ).toHaveCount(0);
    // The Settings reset clears the saved roles and reopens only the tools
    // step, whose category row asks the question again.
    await window.evaluate(async () => {
      const prefs = await window.api.loadPreferences();
      const entries = { ...prefs.homeOnboardingSuggestions?.entries };
      delete entries.github;
      await window.api.savePreferences({
        profileRole: null,
        profileRoles: [],
        homeOnboardingSuggestions: {
          ...prefs.homeOnboardingSuggestions,
          entries,
        },
      });
    });
    await window.reload();
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const tools = window.getByTestId('home-onboarding-suggestion-github');
    await expect(tools).toHaveAttribute('data-status', 'pending');
    await expect(
      tools.getByTestId('home-onboarding-suggestion-dismiss-github'),
    ).toBeVisible();
    await expect(
      tools
        .getByTestId('home-onboarding-categorys')
        .locator('[aria-pressed="true"]'),
    ).toHaveCount(0);
    const saved = await window.evaluate(() => window.api.loadPreferences());
    expect(saved.profileRole).toBeUndefined();
    expect(saved.profileRoles).toEqual([]);
    expect(
      saved.homeOnboardingSuggestions.entries['plan-mode'].completedAt,
    ).toBeTruthy();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the category row stays one scrolling line and the tools step keeps its Skip arrow', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await app.homeChecklistForward('agent-connections').click();
    await app.homeChecklistForward('add-repo').click();
    const row = window.getByTestId('home-onboarding-suggestion-github');
    const tiles = row.getByTestId('home-onboarding-categorys');
    await expect(tiles).toBeVisible();
    await window.setViewportSize({ width: 960, height: 1000 });
    await expect(row).not.toContainText('Select all that apply.');
    const layout = await tiles.evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll('button'));
      return {
        rowCount: new Set(
          buttons.map((button) =>
            Math.round(button.getBoundingClientRect().top),
          ),
        ).size,
        overflowX: getComputedStyle(element).overflowX,
      };
    });
    // One compact row; a narrow host scrolls it rather than clipping tiles.
    expect(layout.rowCount).toBe(1);
    expect(layout.overflowX).toBe('auto');
    // Picking a category saves it and leaves the forward arrow a Skip: only
    // two connected tools earn a Next on this step.
    const skip = row.getByTestId('home-onboarding-suggestion-dismiss-github');
    await expect(skip).toBeVisible();
    await tiles
      .getByTestId('home-onboarding-category-software-engineer')
      .click();
    await expect(
      tiles.getByTestId('home-onboarding-category-software-engineer'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(skip).toBeVisible();
    await expect(row.locator('button', { hasText: 'Next' })).toHaveCount(0);
    await skip.click();
    await expect(row).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('Home and sidebar checklist actions stay readable on hover in every theme and color mode', async () => {
  test.setTimeout(180_000);
  const launch = await launchCanopy({
    // A prompt row: the nontechnical plan lesson with a project to target.
    userDataDir: seedWelcomeChecklist({
      pendingEntry: 'plan-mode',
      roles: ['other'],
    }),
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    await window.getByTestId('settings-theme-select').click();
    const themes = await window
      .locator('[data-testid^="theme-swatch-"]')
      .evaluateAll((elements) =>
        elements.map((el) => el.dataset.testid.replace('theme-swatch-', '')),
      );
    expect(themes).toContain('default');
    expect(themes.length).toBeGreaterThanOrEqual(8);
    await window.keyboard.press('Escape');
    await app.closeSettings();
    // The sidebar card mounts away from Home, where the full card owns it, so
    // each action is measured on the page that shows it.
    const surfaces = [
      {
        open: () => window.getByTestId('sidebar-create-task').click(),
        action: window
          .getByTestId('page-home')
          .getByTestId('home-onboarding-suggestion-cta-prompt'),
      },
      {
        open: () => app.openPluginsPage(),
        action: window.getByTestId('sidebar-onboarding-suggestion-title'),
      },
    ];
    for (const { open, action } of surfaces) {
      await open();
      await expect(action).toBeVisible();
      for (const theme of themes) {
        for (const mode of ['light', 'dark']) {
          // The companion sidebar theme spec pins this shortcut to applyTheme().
          await window.evaluate(
            ({ theme, mode }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.classList.toggle(
                'dark',
                mode === 'dark',
              );
            },
            { theme, mode },
          );
          const box = await action.boundingBox();
          await window.mouse.move(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await expect
            .poll(
              async () =>
                action.evaluate((element) => {
                  const canvas = document.createElement('canvas');
                  canvas.width = canvas.height = 1;
                  const context = canvas.getContext('2d', {
                    willReadFrequently: true,
                  });
                  if (!context)
                    throw new Error('No canvas color conversion available');
                  const luminance = (layers) => {
                    context.clearRect(0, 0, 1, 1);
                    for (const css of layers) {
                      context.fillStyle = css;
                      context.fillRect(0, 0, 1, 1);
                    }
                    const bytes = context.getImageData(0, 0, 1, 1).data;
                    if (bytes[3] !== 255)
                      throw new Error('Expected opaque checklist colors');
                    const channels = Array.from(bytes)
                      .slice(0, 3)
                      .map((byte) => {
                        const value = byte / 255;
                        return value <= 0.04045
                          ? value / 12.92
                          : ((value + 0.055) / 1.055) ** 2.4;
                      });
                    return (
                      channels[0] * 0.2126 +
                      channels[1] * 0.7152 +
                      channels[2] * 0.0722
                    );
                  };
                  const style = getComputedStyle(element);
                  // Composite tinted surfaces over their ancestors so the check
                  // measures the rendered colors, including the hover fill.
                  const backgrounds = [];
                  let backgroundElement = element;
                  while (backgroundElement) {
                    backgrounds.unshift(
                      getComputedStyle(backgroundElement).backgroundColor,
                    );
                    backgroundElement = backgroundElement.parentElement;
                  }
                  const foreground = luminance([...backgrounds, style.color]);
                  const background = luminance(backgrounds);
                  return (
                    (Math.max(foreground, background) + 0.05) /
                    (Math.min(foreground, background) + 0.05)
                  );
                }),
              {
                message: `Tour hover contrast in ${theme}/${mode}: ${await action.getAttribute('data-testid')}`,
              },
            )
            .toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the agent connection lesson is available after a first chat without a duplicate subscription upsell', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntry: 'agent-connections',
      startedChat: true,
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-suggestion-connect-claude'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-suggestion-connect-codex'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-subscription-prompt'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-credits-remaining'),
    ).toHaveCount(0);
    const step = window.getByTestId(
      'home-onboarding-suggestion-agent-connections',
    );
    await expect(step.locator('h2')).toContainText('Add your AI providers');
    const subtitle = window.getByTestId(
      'home-onboarding-agent-connections-subtitle',
    );
    await expect(subtitle).toHaveText(
      /^Bring your own subscription or use your .+ account\.$/,
    );
    await expect(subtitle).not.toContainText('Codex fork');
    // The sidebar card mounts away from Home, where the full card owns it.
    await new CanopyAppDriver(window).openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-suggestion-title'),
    ).toHaveText('Connect AI providers');
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('advanced examples require a completed checklist and fill the draft without sending', async () => {
  const launch = await launchCanopy({ userDataDir: seedWelcomeChecklist() });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    const prompt = window
      .locator(
        '[data-testid^="home-onboarding-advanced-prompt-"]:not([data-testid*="-dismiss-"])',
      )
      .first();
    const label = await prompt.getAttribute('aria-label');
    expect(label.length).toBeGreaterThan(10);
    await prompt.click();
    await expect(
      window.getByTestId('page-home').getByTestId('home-composer-editor'),
    ).toHaveText(label);
    await expect(window.getByTestId('page-home')).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('suggested prompt chips appear only after the getting-started queue is exhausted', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ exhausted: true }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(
      window.getByTestId('home-onboarding-active-suggestions'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toHaveCount(0);
    await expect(window.getByTestId('home-onboarding-suggestions')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('suggested-prompt-chips')).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('dismissing the last activity removes it immediately and persists across relaunch', async () => {
  test.setTimeout(180_000);
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ pendingEntry: 'github' }),
  });
  let firstClosed = false;
  try {
    const window = await launch.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(
      window.getByTestId('home-onboarding-suggestion-github'),
    ).toHaveAttribute('data-status', 'pending');
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeHidden();
    await window
      .getByTestId('home-onboarding-suggestion-dismiss-github')
      .click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-github'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('home-onboarding-suggestion-github')
        .getByRole('button'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-onboarding-cleared-github'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    await expect(async () => {
      const prefs = JSON.parse(
        readFileSync(path.join(launch.userDataDir, 'preferences.json'), 'utf8'),
      ).preferences;
      expect(
        prefs.homeOnboardingSuggestions.entries.github.dismissedAt,
      ).toEqual(expect.any(String));
    }).toPass({ timeout: 10_000 });
    await closeCanopy(launch.electronApp, launch.userDataDir, {
      keepUserData: true,
    });
    firstClosed = true;
    const second = await launchCanopy({ userDataDir: launch.userDataDir });
    try {
      const window2 = await second.electronApp.firstWindow();
      await new CanopyAppDriver(window2).waitForShell();
      await expect(
        window2.getByTestId('home-onboarding-checklist-progress'),
      ).toHaveCount(0);
      await expect(
        window2.getByTestId('home-onboarding-suggestion-github'),
      ).toHaveCount(0);
      await expect(
        window2.getByTestId('home-onboarding-advanced-prompts'),
      ).toBeVisible();
    } finally {
      await closeCanopy(second.electronApp, second.userDataDir);
    }
  } finally {
    if (!firstClosed) await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('welcome queue removes resolved activities immediately and across relaunch', async () => {
  test.setTimeout(180_000);
  const first = await launchCanopy({ freshOnboarding: true });
  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.acceptLegalConsent();
    await app.waitForShell();
    await app.skipFirstRunImport();
    const providers = window.getByTestId(
      'home-onboarding-suggestion-agent-connections',
    );
    await expect(providers).toBeVisible({ timeout: 30_000 });
    await providers
      .locator(
        'button[data-checklist-navigation="true"]:not([data-testid$="-previous"])',
      )
      .click();
    await expect(providers).toHaveCount(0);
    await window.getByTestId('sidebar-nav-plugins').click();
    await window.getByTestId('sidebar-create-task').click();
    await expect(providers).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeHidden();
    await expect(async () => {
      const prefs = JSON.parse(
        readFileSync(path.join(first.userDataDir, 'preferences.json'), 'utf8'),
      ).preferences;
      const entry =
        prefs.homeOnboardingSuggestions.entries['agent-connections'];
      expect(entry.completedAt ?? entry.dismissedAt).toBeTruthy();
    }).toPass();
  } finally {
    await closeCanopy(first.electronApp, first.userDataDir, {
      keepUserData: true,
    });
  }
  const second = await launchCanopy({ userDataDir: first.userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-suggestion-add-repo'),
    ).toBeVisible();
  } finally {
    await closeCanopy(second.electronApp, second.userDataDir);
  }
});

// First run lands on the Home composer with the persistent checklist below it.
// Completed and dismissed activities leave the visible queue.
// Provider steps use the harness auth fixtures; no live agent sends are needed.

test('fresh user reaches Home with the onboarding suggestions module after the first-run page', async () => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  // The examples preview only queues behind a connected tool, so pin GitHub
  // as signed in instead of reading the host's own `gh` login.
  const env = { GH_EXECUTABLE: writeAuthenticatedGhFixture(userDataDir) };
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboarding: true,
    env,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    // Fresh launch shows the blocking first-run legal gate before the shell.
    await app.acceptLegalConsent();
    await app.waitForShell();
    await app.skipFirstRunImport();

    await expect(
      window.getByTestId('home-onboarding-subscription-prompt'),
    ).toBeHidden();
    await expect(
      window.getByTestId('home-onboarding-credits-remaining'),
    ).toBeHidden();
    // After the first-run page, the surface is the Home composer.
    await expect(window.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    const module = window.getByTestId('home-onboarding-suggestions');
    await expect(module).toBeVisible({ timeout: 15_000 });

    // Fresh users see one focused step, starting with the AI providers.
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.locator('li[data-testid^="home-onboarding-suggestion-"]'),
    ).toHaveCount(1);
    // Notifications are offered after a background completion (CAN-4005),
    // never as a Getting started step, even with notifications off.
    await expect(
      window.getByTestId('home-onboarding-suggestion-notifications'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-suggestions-explore-plugins'),
    ).toHaveCount(0);
    // The providers step's forward arrow (Next once the harness has signed
    // the providers in, Skip otherwise) carries no label text, and moving
    // on reaches the single project step.
    const providersCard = window.getByTestId(
      'home-onboarding-suggestion-agent-connections',
    );
    const providersForward = providersCard.locator(
      'button[data-checklist-navigation="true"]:not([data-testid$="-previous"])',
    );
    await expect(providersForward).toBeVisible();
    await expect(providersForward).toHaveText('');
    await expect(
      providersCard.locator('button', { hasText: 'Next' }),
    ).toHaveCount(0);
    await providersForward.click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toHaveCount(0);
    await expect(
      window.locator('li[data-testid^="home-onboarding-suggestion-"]'),
    ).toHaveCount(1);

    // The add-repo CTA opens the Add project dialog directly; Escape closes
    // it without side effects.
    await window.getByTestId('home-onboarding-suggestion-cta-add-repo').click();
    const addProject = window.getByTestId('add-workspace-modal');
    await expect(addProject).toBeVisible({ timeout: 5000 });
    await window.keyboard.press('Escape');
    await expect(addProject).toBeHidden();

    await window
      .getByTestId('home-onboarding-suggestion-dismiss-add-repo')
      .click();
    const githubRow = window.getByTestId('home-onboarding-suggestion-github');
    await expect(githubRow).toHaveAttribute('data-step', 'connect-tools');
    // The tools step asks for categories above its tiles: multi-select, and
    // every pick saves the profile roles at once.
    await githubRow
      .getByTestId('home-onboarding-category-software-engineer')
      .click();
    await githubRow.getByTestId('home-onboarding-category-designer').click();
    await expect(async () => {
      const persisted = JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      expect(persisted.preferences.profileRoles).toEqual([
        'software-engineer',
        'designer',
      ]);
      expect(persisted.preferences.profileRole).toBe('software-engineer');
    }).toPass({ timeout: 10_000 });
    await expect(
      window.getByTestId('home-onboarding-tool-recommendations'),
    ).toBeVisible();
    await window
      .getByTestId('home-onboarding-suggestion-dismiss-github')
      .click();
    await expect(githubRow).toHaveCount(0);
    // The gh fixture reports GitHub as connected, so the examples preview
    // follows.
    await expect(
      window.getByTestId('home-onboarding-suggestion-plugin-examples-preview'),
    ).toBeVisible();
    await expect(async () => {
      const persisted = JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      expect(
        typeof persisted.preferences.homeOnboardingSuggestions.entries.github
          .dismissedAt,
      ).toBe('string');
    }).toPass({ timeout: 10_000 });

    // The module stays available; only individual suggestions can be dismissed.
    await expect(
      window.getByTestId('home-onboarding-suggestions-dismiss'),
    ).toHaveCount(0);
    await expect(module).toBeVisible();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.retiredAt,
      )
      .toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch preserves individual dismissals and keeps the next suggestion visible.
  const second = await launchCanopy({ userDataDir, env });
  try {
    const window2 = await second.electronApp.firstWindow();
    const app2 = new CanopyAppDriver(window2);
    await app2.waitForShell();
    await expect(window2.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window2.getByTestId('home-onboarding-suggestions'),
    ).toBeVisible({ timeout: 5000 });
  } finally {
    await closeCanopy(second.electronApp, second.userDataDir);
  }
});

test('Home does not advertise plugin recommendations absent from the bundled catalog', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntries: [
        'plugin:universal:google',
        'plugin:universal:slack',
        'plugin:universal:notion',
        'plugin:universal:datadog',
      ],
      enabledPlugins: ['gmail'],
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    for (const name of ['google', 'slack', 'notion', 'datadog'])
      await expect(
        window.getByTestId(
          `home-onboarding-suggestion-plugin:universal:${name}`,
        ),
      ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
