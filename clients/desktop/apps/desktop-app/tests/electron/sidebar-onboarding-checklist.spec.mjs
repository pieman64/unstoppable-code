import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedNativeClaudeStore } from './seeders/seedNativeClaudeStore.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedTranscriptRecovery } from './transcript-storage-fixture.mjs';

// The sidebar card is absent while Home shows the full card, so specs that
// step the queue on Home use Home's arrows. The forward arrow reads Skip
// until the step's own action is ready and Next after (providers signed in,
// two tools connected), and Next carries its own test id, so it is located
// by role inside the row rather than by the Skip id.
function homeNext(app, entryId) {
  return app
    .homeChecklistRow(entryId)
    .locator(
      'button[data-checklist-navigation="true"]:not([data-testid$="-previous"])',
    );
}

test('backfills chat-started progress from migrated JSONL history', async () => {
  const { userDataDir } = await seedTranscriptRecovery();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    const state = await window.evaluate(() =>
      window.api.onboardingChecklist.getState(),
    );
    expect(state.items).toContainEqual({ id: 'start-chat', complete: true });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3972: Home's full card owns the queue, so the sidebar card steps aside
// there and shows the same step on every other page.
test('the sidebar card hides on Home and stays in step with it elsewhere', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    const homeProgress = window.getByTestId(
      'home-onboarding-checklist-progress',
    );
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    // Provider probes can still add steps here, so only the step is fixed.
    await expect(homeProgress).toHaveText(/^1\/\d+$/);

    // Off Home the sidebar offers the same step as one action, with no
    // counter or arrows; stepping the queue stays on Home.
    await app.openPluginsPage();
    await expect(sidebar).toHaveAttribute('data-entry-id', 'agent-connections');
    await expect(
      sidebar.getByTestId('sidebar-onboarding-progress'),
    ).toHaveCount(0);
    await expect(
      sidebar.locator('[data-testid^="sidebar-onboarding-suggestion-dismiss"]'),
    ).toHaveCount(0);

    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    const advanced = await app.advanceHomeChecklist();
    expect(advanced).toBe('agent-connections');
    await expect(homeProgress).toHaveText(/^2\/\d+$/);
    const next = await app.currentHomeChecklistEntry();

    await app.openPluginsPage();
    await expect(sidebar).toHaveAttribute('data-entry-id', next);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// An empty chat's full card owns the queue while that chat is on screen.
// Every count-0 check follows a positive check on the chat card so it cannot
// pass on a sidebar that has not rendered yet.
test('the sidebar card hides while an empty chat shows the checklist', async () => {
  const userDataDir = seedWelcomeChecklist({ fresh: true });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    const host = window.getByTestId('chat-onboarding-checklist-host');
    await app.selectWorktree('demo-main', { expandDefaultActivityRail: false });
    await expect(
      host.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    // Off the chat page the hidden chat must not keep the card away.
    await app.openPluginsPage();
    await expect(sidebar).toHaveAttribute('data-entry-id', 'agent-connections');
    await app.selectWorktree('demo-main', { expandDefaultActivityRail: false });
    await expect(host).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    // Typing takes the center card away, so the footer card returns.
    const composer = window
      .locator('[data-slate-editor="true"]:visible')
      .first();
    await composer.pressSequentially('hello');
    await expect(host).toHaveCount(0);
    await expect(sidebar).toHaveAttribute('data-entry-id', 'agent-connections');
    // Clearing the composer brings the center card back and hides the footer card again.
    // Slate can drop a select-all issued while it re-renders for the typed
    // text; retry until the selection covers the draft before deleting it.
    await expect(async () => {
      await composer.press('ControlOrMeta+A');
      await window.waitForTimeout(200);
      expect(
        await composer.evaluate(() => document.getSelection()?.isCollapsed),
      ).toBe(false);
    }).toPass();
    await composer.press('Backspace');
    await expect(host).toBeVisible();
    await expect(sidebar).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-2666: the sidebar is a one-step view of Home's dynamic queue.
// Fixtures are isolated; provider state uses the normal harness mocks.
test('nontechnical roles share the tools and teaching steps without adding a code project', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true, roles: ['designer'] }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    for (const entryId of [
      'agent-connections',
      // The tools step stays for its category row.
      'github',
      'plan-mode',
      'focus-shortcut',
    ]) {
      await expect(app.homeChecklistRow(entryId)).toBeVisible();
      await expect(
        window.getByTestId('home-onboarding-suggestion-add-repo'),
      ).toHaveCount(0);
      await homeNext(app, entryId).click();
      await expect(app.homeChecklistRow(entryId)).toHaveCount(0);
    }
    // Only the examples remain, and they carry no step counter.
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveCount(0);
    const examples = window.getByTestId('home-onboarding-advanced-prompts');
    await expect(examples).toBeVisible();
    for (let index = 0; index < 10 && (await examples.isVisible()); index++) {
      const skip = examples
        .locator('[data-testid^="home-onboarding-advanced-prompt-dismiss-"]')
        .first();
      const id = await skip.getAttribute('data-testid');
      await skip.click();
      await expect(window.getByTestId(id)).toHaveCount(0);
    }
    await expect(examples).toHaveCount(0);
    await expect(window.getByTestId('suggested-prompt-chips')).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-profile-role-edit').click();
    await window
      .getByTestId('settings-profile-role-option-software-engineer')
      .click();
    await window.getByTestId('settings-profile-role-save').click();
    await app.closeSettings();
    await expect(app.homeChecklistRow('add-repo')).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The roles question lives on the tools step: one row of category tiles above
// the tool tiles, saved on every pick, re-ranking the tools in place.
test('picking categories on the tools step re-ranks the tools in place and saves them', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
  });
  const prefsPath = path.join(launch.userDataDir, 'preferences.json');
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // AI providers lead the checklist and there is no roles step.
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    await homeNext(app, 'agent-connections').click();
    await expect(app.homeChecklistRow('add-repo')).toBeVisible();
    await homeNext(app, 'add-repo').click();

    const tools = app.homeChecklistRow('github');
    await expect(tools).toBeVisible();
    const categories = tools.getByTestId('home-onboarding-categorys');
    await expect(categories).toBeVisible();
    await expect(categories.getByRole('button')).toHaveCount(5);
    await expect(tools.getByText('Pick a category')).toBeVisible();
    // One line, above the tool tiles.
    const rows = await categories
      .getByRole('button')
      .evaluateAll(
        (tiles) => new Set(tiles.map((tile) => tile.offsetTop)).size,
      );
    expect(rows).toBe(1);
    await expect(
      tools.getByTestId('home-onboarding-tool-linear'),
    ).toBeVisible();
    // GitHub is offered when a push or pull request first needs it (CAN-4006).
    await expect(tools.getByTestId('home-onboarding-tool-github')).toHaveCount(
      0,
    );

    const designer = tools.getByTestId('home-onboarding-category-designer');
    await designer.click();
    await expect(designer).toHaveAttribute('aria-pressed', 'true');
    await expect(tools.getByTestId('home-onboarding-tool-linear')).toHaveCount(
      0,
    );
    await expect(tools).toBeVisible();
    await expect(async () => {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences;
      expect(saved.profileRoles).toEqual(['designer']);
    }).toPass();

    await tools
      .getByTestId('home-onboarding-category-software-engineer')
      .click();
    await expect(
      tools.getByTestId('home-onboarding-tool-linear'),
    ).toBeVisible();
    await designer.click();
    await expect(designer).toHaveAttribute('aria-pressed', 'false');
    await expect(async () => {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences;
      expect(saved.profileRoles).toEqual(['software-engineer']);
    }).toPass();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// A project already added stays numbered after choosing a nontechnical
// category, even though that category does not require project setup.
test('a nontechnical category keeps a done project step in the progress count', async () => {
  const userDataDir = seedWelcomeChecklist({ fresh: true });
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    const homeProgress = window.getByTestId(
      'home-onboarding-checklist-progress',
    );
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    await homeNext(app, 'agent-connections').click();
    await expect(app.homeChecklistRow('github')).toBeVisible();
    const before = await homeProgress.textContent();
    await window.getByTestId('home-onboarding-category-designer').click();
    await expect(app.homeChecklistRow('github')).toBeVisible();
    await expect(homeProgress).toHaveText(before ?? '');
    // The sidebar card shows the same step off Home.
    await app.openPluginsPage();
    await expect(sidebar).toHaveAttribute('data-entry-id', 'github');
    await window.getByTestId('sidebar-create-task').click();
    await homeNext(app, 'github').click();
    const step = Number((before ?? '').split('/')[0]);
    await expect(homeProgress).toHaveText(new RegExp(`^${step + 1}/\\d+$`));
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The sidebar card offers one action button. A pointer click anywhere on the
// card runs it, but only the button highlights on hover.
test('the whole sidebar card runs its action while only the button highlights', async () => {
  const userDataDir = seedWelcomeChecklist({ pendingEntry: 'import-projects' });
  const externalRoot = seedNativeClaudeStore(userDataDir, {
    prefix: 'canopy-sidebar-tile-',
  });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The sidebar card is absent while Home shows the full card.
    await app.openPluginsPage();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    const heading = sidebar.getByTestId('sidebar-onboarding-suggestion-title');
    const front = sidebar.getByTestId('sidebar-onboarding-suggestion-row');
    const cta = sidebar.getByTestId('sidebar-onboarding-suggestion-cta');
    await expect(sidebar).toHaveAttribute('data-entry-id', 'import-projects');
    await expect(heading).toHaveText('Import projects');
    await expect(cta).toHaveText('Import');
    await expect(
      sidebar.getByTestId('sidebar-onboarding-progress'),
    ).toHaveCount(0);
    await expect(
      sidebar.locator('[data-testid^="sidebar-onboarding-suggestion-dismiss"]'),
    ).toHaveCount(0);

    const surface = (element) => {
      const style = getComputedStyle(element);
      return `${style.backgroundColor} ${style.backgroundImage}`;
    };
    await window.mouse.move(0, 0);
    const card = await front.evaluate(surface);
    const button = await cta.evaluate(surface);
    await front.hover({ position: { x: 8, y: 8 } });
    await heading.hover();
    expect(await front.evaluate(surface)).toBe(card);
    expect(await cta.evaluate(surface)).toBe(button);
    await cta.hover();
    await expect.poll(() => cta.evaluate(surface)).not.toBe(button);

    const modal = window.getByTestId('import-projects-modal');
    for (const activate of [
      () => front.click({ position: { x: 8, y: 8 } }),
      () => heading.click(),
      () => cta.click(),
      async () => {
        await cta.focus();
        await cta.press('Enter');
      },
    ]) {
      await activate();
      await expect(modal).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
    }
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('Skip on the sidebar card brings the next step forward and Home follows', async () => {
  const userDataDir = seedWelcomeChecklist({
    pendingEntries: ['import-projects', 'plan-mode', 'linear', 'github'],
  });
  const externalRoot = seedNativeClaudeStore(userDataDir, {
    prefix: 'canopy-sidebar-stack-',
  });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    await expect(sidebar).toHaveAttribute('data-entry-id', 'import-projects');
    // The steps still to come peek out behind the front card, at most two.
    const upcoming = Number(await sidebar.getAttribute('data-upcoming'));
    expect(upcoming).toBeGreaterThan(0);
    await expect(
      sidebar.getByTestId('sidebar-onboarding-stack-card'),
    ).toHaveCount(Math.min(upcoming, 2));
    await expect(
      sidebar.getByTestId('sidebar-onboarding-suggestion-description'),
    ).toHaveText('Bring your chats and projects from Claude and Codex.');

    await sidebar.getByTestId('sidebar-onboarding-skip').click();
    await expect(sidebar).not.toHaveAttribute(
      'data-entry-id',
      'import-projects',
    );
    await expect(sidebar).toHaveAttribute(
      'data-upcoming',
      String(upcoming - 1),
    );
    // The skipped card leaves; only the new front card keeps its controls.
    await expect(
      sidebar.getByTestId('sidebar-onboarding-leaving-card'),
    ).toHaveCount(0);
    await expect(
      sidebar.getByTestId('sidebar-onboarding-suggestion-cta'),
    ).toHaveCount(1);
    const prefs = await window.evaluate(() => window.api.loadPreferences());
    expect(
      prefs.homeOnboardingSuggestions.entries['import-projects'].dismissedAt,
    ).toEqual(expect.any(String));

    // Home's full card is on the same step.
    const entry = await sidebar.getAttribute('data-entry-id');
    await window.getByTestId('sidebar-create-task').click();
    await expect.poll(() => app.currentHomeChecklistEntry()).toBe(entry);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('a historical retirement restores the checklist and Settings can reset its progress', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntry: 'add-repo',
      retired: true,
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expect(app.homeChecklistRow('add-repo')).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-canopy-restore-checklist').click();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.entries,
      )
      .toEqual({});
    await app.closeSettings();
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    const prefs = await window.evaluate(() => window.api.loadPreferences());
    expect(prefs.homeOnboardingSuggestions.retiredAt).toBeUndefined();
    expect(prefs.profileRoles).toEqual(['software-engineer']);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('advanced examples leave the sidebar and role changes remove project readiness', async () => {
  const userDataDir = seedWelcomeChecklist();
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await launch.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:github-cli-status');
      ipcMain.handle('settings:github-cli-status', () => ({
        authenticated: true,
        username: 'onboarding-fixture',
        error: null,
        tokenSource: 'gh',
        envOverride: false,
        envOverrideName: null,
        hasCredentialStoreLogin: true,
      }));
    });
    await window.reload();
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    // Home hides the sidebar card anyway, so check it from Plugins.
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.locator('[data-testid^="home-onboarding-readiness-"]'),
    ).toBeVisible();
    // Readiness fixes are numbered after the last setup step, so Next moves
    // the counter by one until the examples take over (which have none).
    // The seeded plain Vite repo has setup and launch scripts but no hooks
    // and no AGENTS.md, so exactly two fixes follow the done setup steps:
    // the first reads done + 1 of done + 2, and Next shows done + 2.
    const progress = window.getByTestId('home-onboarding-checklist-progress');
    await expect(progress).toHaveText(/^\d+\/\d+$/);
    const readCounter = async () => {
      const [shown, total] = ((await progress.textContent()) ?? '')
        .split('/')
        .map(Number);
      return { shown, total };
    };
    await expect
      .poll(async () => {
        const { shown, total } = await readCounter();
        return total - shown;
      })
      .toBe(1);
    const { total } = await readCounter();
    await window
      .locator(
        '[data-testid^="home-onboarding-suggestion-dismiss-advanced:readiness:"]:not([data-testid$="-previous"])',
      )
      .first()
      .click();
    await expect(progress).toHaveText(`${total}/${total}`);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-profile-role-edit').click();
    await window.getByTestId('settings-profile-role-option-designer').click();
    await window
      .getByTestId('settings-profile-role-option-software-engineer')
      .click();
    await window.getByTestId('settings-profile-role-save').click();
    await app.closeSettings();
    await expect(
      window.locator('[data-testid^="home-onboarding-readiness-"]'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The current design uses a full-panel action with navigation in the header.
// Keep its longest title readable at narrow widths and enlarged UI scales.
for (const [label, preferences] of [
  ['default width', {}],
  ['minimum width', { sidebarWidth: 220 }],
  ['150% scale', { sidebarWidth: 220, uiScale: 150 }],
]) {
  test(`the sidebar import target stays readable and clickable at ${label}`, async () => {
    const userDataDir = seedWelcomeChecklist({
      pendingEntry: 'import-projects',
    });
    const file = path.join(userDataDir, 'preferences.json');
    const seeded = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(seeded.preferences, preferences);
    writeFileSync(file, JSON.stringify(seeded));
    const externalRoot = seedNativeClaudeStore(userDataDir, {
      prefix: 'canopy-sidebar-layout-',
    });
    const launch = await launchCanopy({ userDataDir });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // The sidebar card is absent while Home shows the full card.
      await app.openPluginsPage();
      const sidebar = window.getByTestId('sidebar-onboarding-checklist');
      await expect(sidebar).toHaveAttribute('data-entry-id', 'import-projects');
      const title = window.getByTestId('sidebar-onboarding-suggestion-title');
      const geometry = await title.evaluate((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      }));
      expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.height + 1);
      const action = window.getByTestId('sidebar-onboarding-suggestion-cta');
      const [panelBox, actionBox] = await Promise.all([
        sidebar.boundingBox(),
        action.boundingBox(),
      ]);
      // The button sits inside the card's padding.
      expect(actionBox.x).toBeGreaterThan(panelBox.x);
      expect(actionBox.y).toBeGreaterThan(panelBox.y);
      expect(actionBox.x + actionBox.width).toBeLessThan(
        panelBox.x + panelBox.width,
      );
      await action.click();
      await expect(window.getByTestId('import-projects-modal')).toBeVisible();
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
}

test('an install that finished the wizard and already has a code project still gets the checklist', async () => {
  // Every install gets the checklist. The default harness launch is exactly
  // an existing user: the wizard-completed marker is seeded, the module has
  // never started, and the demo workspace is a real code project.
  const launch = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    freshOnboardingChecklist: true,
  });
  const prefsPath = path.join(launch.userDataDir, 'preferences.json');
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestions'),
    ).toBeVisible();
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    // The start is durable, so the next launch reads it back instead of
    // seeding again.
    await expect(async () => {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences
        .homeOnboardingSuggestions;
      expect(typeof saved?.startedAt).toBe('string');
    }).toPass();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the Settings reset clears dismissed and completed suggestions', async () => {
  // Everything but GitHub is done and GitHub was dismissed, so the queue has
  // moved on to advanced prompts. Restoring clears the saved checklist state
  // and returns to the first setup step on both surfaces.
  const userDataDir = seedWelcomeChecklist({ dismissedEntry: 'github' });
  const prefsPath = path.join(userDataDir, 'preferences.json');
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-canopy-restore-checklist').click();
    await app.closeSettings();
    await expect(async () => {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences
        .homeOnboardingSuggestions;
      // A row with nothing left to remember is dropped on write, so the
      // restored entry may be absent rather than empty.
      expect(saved.entries.github?.dismissedAt).toBeUndefined();
      expect(saved.entries).toEqual({});
    }).toPass();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveAttribute('data-entry-id', 'agent-connections');
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The import entry resolves when the user decides, not only when a project
// lands: Skip for now in the modal is a decision. Before, only a successful
// import (or an empty scan) completed the entry, so a user who looked and
// passed kept being asked on every visit.
test('skipping the import modal completes the Getting started entry', async () => {
  const userDataDir = seedWelcomeChecklist({ pendingEntry: 'import-projects' });
  const prefsPath = path.join(userDataDir, 'preferences.json');
  const externalRoot = seedNativeClaudeStore(userDataDir, {
    prefix: 'canopy-sidebar-skip-',
  });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The sidebar card is absent while Home shows the full card.
    await app.openPluginsPage();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    await expect(sidebar).toHaveAttribute('data-entry-id', 'import-projects');
    await window.getByTestId('sidebar-onboarding-suggestion-cta').click();
    const modal = window.getByTestId('import-projects-modal');
    await expect(modal).toBeVisible();
    // The scan must have finished: Skip for now is only offered once the
    // user can see what they are passing on.
    await expect(modal.getByTestId('import-projects-choose')).toBeVisible({
      timeout: 30_000,
    });
    await modal.getByTestId('import-projects-skip').click();
    await expect(modal).toHaveCount(0);

    // Durable first: the DOM below can only be trusted once this landed.
    await expect(async () => {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences
        .homeOnboardingSuggestions;
      expect(saved.entries['import-projects'].completedAt).toBeTruthy();
    }).toPass();
    await expect(
      window.getByTestId('home-onboarding-suggestion-import-projects'),
    ).toHaveCount(0);
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-import-projects'),
    ).toHaveCount(0);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The dev-only forced replay (`canopy.dev.forceHomeOnboarding`) runs the
// checklist from an in-memory seed while this install dismissed the import
// entry weeks ago on disk. Skip for now then wrote nothing (the persisted
// decision stands) and, before the fix, told the mounted checklist nothing
// either, so the replayed entry stayed pending after every exit. Disk is
// asserted unchanged so the replay's isolation is kept. The preload reports
// `devInfo.isDev` only under NODE_ENV=development, which the harness does
// not set, so this launch passes it through the launcher's `env` option.
// The preload reads the variable at runtime (the E2E main bundle inlines its
// own checks at build time), so the launch adds the dev indicator, its
// `git rev-parse` for the branch label, and the DEV banner in the sidebar
// footer, and changes nothing else; `CANOPY_ENV=development` is already set
// on every launch, so data-dir resolution is unaffected.
test('the forced-fresh replay completes the import entry it offered', async () => {
  const userDataDir = seedWelcomeChecklist({ pendingEntry: 'import-projects' });
  const prefsPath = path.join(userDataDir, 'preferences.json');
  // The seeder knows only the curated ids it lists; the import entry is
  // offered by provider presence, so its dismissal is written here.
  const seeded = JSON.parse(readFileSync(prefsPath, 'utf8'));
  seeded.preferences.homeOnboardingSuggestions.entries['import-projects'] = {
    dismissedAt: '2026-09-12T13:01:43.823Z',
  };
  writeFileSync(prefsPath, JSON.stringify(seeded, null, 2));
  const externalRoot = seedNativeClaudeStore(userDataDir, {
    prefix: 'canopy-sidebar-replay-',
  });
  const launch = await launchCanopy({
    userDataDir,
    env: { NODE_ENV: 'development' },
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expect(
      window.getByTestId('home-onboarding-advanced-prompts'),
    ).toBeVisible();
    // Home hides the sidebar card anyway, so check it from Plugins.
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveCount(0);

    await window.evaluate(() => {
      window.localStorage.setItem('canopy.dev.forceHomeOnboarding', '1');
    });
    await window.reload();
    await app.waitForShell();
    // Step past the first entry on Home; the sidebar card has no arrows.
    await window.getByTestId('sidebar-create-task').click();
    await expect(app.homeChecklistRow('agent-connections')).toBeVisible();
    await homeNext(app, 'agent-connections').click();
    // The sidebar card is absent while Home shows the full card.
    await app.openPluginsPage();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    await expect(sidebar).toHaveAttribute('data-entry-id', 'import-projects');
    await window.getByTestId('sidebar-onboarding-suggestion-cta').click();
    const modal = window.getByTestId('import-projects-modal');
    await expect(modal.getByTestId('import-projects-choose')).toBeVisible({
      timeout: 30_000,
    });
    await modal.getByTestId('import-projects-skip').click();
    await expect(modal).toHaveCount(0);

    await expect(
      window.getByTestId('home-onboarding-suggestion-import-projects'),
    ).toHaveCount(0);
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-onboarding-suggestion-import-projects'),
    ).toHaveCount(0);
    // The replay stays in memory: the persisted dismissal is untouched.
    const saved = JSON.parse(readFileSync(prefsPath, 'utf8')).preferences
      .homeOnboardingSuggestions;
    expect(saved.entries['import-projects'].dismissedAt).toBeTruthy();
    expect(saved.entries['import-projects'].completedAt).toBeUndefined();
    // The replay flag lives in this launch's isolated user data dir, which
    // `closeCanopy` removes, so nothing needs switching back off.
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

// The counter numbers done steps first and remaining steps after, so it reads
// "done + 1" and a Skip moves it by exactly one. The already-completed
// examples preview is in the list as a done step from first paint (its
// connected tool only resolves once the catalog settles), so the total does
// not move either. The plan-mode lesson is not counted: this fixture has no
// repository. The retired notifications (CAN-4005) and automation (CAN-4009)
// steps are not counted either, so the two pending steps start at 5/6.
test('the step counter never skips a number when later steps are already done', async () => {
  const userDataDir = seedWelcomeChecklist({
    pendingEntries: ['github', 'focus-shortcut'],
  });
  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const sidebar = window.getByTestId('sidebar-onboarding-checklist');
    const homeProgress = window.getByTestId(
      'home-onboarding-checklist-progress',
    );

    await expect(app.homeChecklistRow('github')).toBeVisible();
    await expect(homeProgress).toHaveText('5/6');

    await app.homeChecklistForward('github').click();
    await expect(app.homeChecklistRow('focus-shortcut')).toBeVisible();
    await expect(homeProgress).toHaveText('6/6');

    // The sidebar card shows the same step off Home.
    await app.openPluginsPage();
    await expect(sidebar).toHaveAttribute('data-entry-id', 'focus-shortcut');

    // Back on Home walks the steps in list order: the plan lesson (uncounted
    // here), then the done examples preview, then the tools step, which
    // reviews at its list position.
    await window.getByTestId('sidebar-create-task').click();
    for (const [from, to] of [
      ['focus-shortcut', 'plan-mode'],
      ['plan-mode', 'plugin-examples-preview'],
      ['plugin-examples-preview', 'github'],
    ]) {
      await app.homeChecklistBack(from).click();
      await expect(app.homeChecklistRow(to)).toBeVisible();
    }
    await expect(homeProgress).toHaveText('3/6');
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
