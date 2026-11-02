import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import {
  seedRepoRulesFixture,
  ENABLED_RULE,
  DISABLED_RULE,
  CHANGED_RULE,
} from './seeders/seedRepoRulesFixture.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { seedExternalProjectImportFixture } from './seeders/seedExternalProjectImportFixture.mjs';
import { externalProjectCandidateIdFor } from './seeders/seedExternalProjectImportFixture.mjs';
import {
  applyImportRules,
  importedWorkspace,
  importFirstRunRuleProjects,
  seedPostImportRulesFixture,
} from './postImportRules.mjs';

for (const ending of ['apply', 'skip', 'resume', 'all-skipped']) {
  test(`CAN-4980 multi-project offer resolves through ${ending}`, async () => {
    test.setTimeout(240_000);
    const userDataDir = seedWelcomeChecklist();
    const prefsPath = path.join(userDataDir, 'preferences.json');
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    prefs.preferences.onboardingCompleted = [];
    prefs.preferences.homeOnboardingSuggestions.entries['daily-credits'] = {
      completedAt: '2026-10-25T00:00:00.000Z',
    };
    writeFileSync(prefsPath, JSON.stringify(prefs));
    const fixture = seedPostImportRulesFixture(userDataDir, 'side-quest', {
      sideQuestRules: true,
    });
    const launch = await launchCanopy({
      userDataDir,
      env: fixture.env,
      freshOnboardingChecklist: true,
    });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const home = await importFirstRunRuleProjects(window, fixture);
      const payments = importedWorkspace(userDataDir, 'payments-service');
      const side = importedWorkspace(userDataDir, 'side-quest');
      const policy = (workspace) =>
        path.join(userDataDir, 'workspaces', workspace.id, 'repo-rules.json');
      await window
        .getByTestId('toast-card')
        .filter({ hasText: '2 new projects have Cursor rules' })
        .getByTestId('toast-action')
        .click();
      const modal = window.getByTestId('repo-rules-modal');
      if (ending === 'all-skipped') {
        // Exercise native keyboard activation and accessible project naming.
        await modal
          .getByRole('button', { name: 'Skip payments-service', exact: true })
          .focus();
        await window.keyboard.press('Enter');
        await expect(
          modal.getByTestId(`repo-rules-decision-${payments.id}`),
        ).toHaveText('Skipped');
      } else {
        await modal.getByTestId(`repo-rules-choose-${payments.id}`).click();
        await modal.getByTestId('repo-rules-apply').click();
        await expect(modal.getByTestId('repo-rules-choose')).toBeVisible();
        await expect(
          modal.getByTestId(`repo-rules-decision-${payments.id}`),
        ).toHaveText('Rules on');
        // The result toast follows the synchronous decision/completion gate.
        await expect(
          window
            .getByTestId('toast-card')
            .filter({ hasText: 'Cursor rules on' }),
        ).toBeVisible();
        expect(JSON.parse(readFileSync(policy(payments), 'utf8')).enabled).toBe(
          true,
        );
        expect(existsSync(policy(side))).toBe(false);
        // The first accepted import save retargets the untouched composer.
        await expect(home.getByTestId('home-workspace-select')).toContainText(
          'payments-service',
        );
      }
      if (ending === 'resume') {
        await window.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
        await app.openSettings();
        await app.openSettingsSection('canopy');
        await window
          .getByTestId('settings-canopy-import-editor-setup-open')
          .click();
        await expect(
          modal.getByTestId(`repo-rules-decision-${payments.id}`),
        ).toHaveText('Rules on');
        await expect(
          modal.getByTestId(`repo-rules-skip-${side.id}`),
        ).toBeVisible();
      }
      if (ending === 'apply') {
        await modal.getByTestId(`repo-rules-choose-${side.id}`).click();
        await modal.getByTestId('repo-rules-apply').click();
      } else {
        await modal.getByTestId(`repo-rules-skip-${side.id}`).click();
      }
      await expect(modal).toHaveCount(0);
      if (ending === 'resume') await app.closeSettings();
      if (ending === 'apply')
        expect(JSON.parse(readFileSync(policy(side), 'utf8')).enabled).toBe(
          true,
        );
      else expect(existsSync(policy(side))).toBe(false);
      if (ending === 'all-skipped')
        expect(existsSync(policy(payments))).toBe(false);
      else
        await expect(home.getByTestId('home-workspace-select')).toContainText(
          'payments-service',
        );
    } finally {
      await closeCanopy(launch.electronApp, userDataDir);
      fixture.cleanup();
    }
  });
}

for (const protection of [
  'empty',
  'draft',
  'explicit',
  'cancel',
  'failed-save',
]) {
  test(`CAN-4674 import-results Apply preserves ${protection} composer policy`, async () => {
    test.setTimeout(180_000);
    const userDataDir = seedWelcomeChecklist();
    const imported = seedPostImportRulesFixture(userDataDir);
    const launch = await launchCanopy({ userDataDir, env: imported.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (protection === 'draft') {
        await window.getByTestId('sidebar-create-task').click();
        await window
          .getByTestId('page-home')
          .getByTestId('home-composer-editor')
          .fill('Keep this side-quest draft');
      }
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-import-projects-open').click();
      const modal = window.getByTestId('import-projects-modal');
      await expect(modal.getByTestId('import-projects-list')).toBeVisible();
      const all = modal.getByTestId('import-projects-select-all');
      await all.uncheck();
      for (const project of imported.extraProjects) {
        await modal
          .getByTestId(
            `import-projects-row-checkbox-${externalProjectCandidateIdFor(project.dir)}`,
          )
          .check();
      }
      await modal.getByTestId('import-projects-submit').click();
      await expect(modal.getByTestId('import-projects-results')).toBeVisible({
        timeout: 120_000,
      });
      const side = importedWorkspace(userDataDir, 'side-quest');
      const payments = importedWorkspace(userDataDir, 'payments-service');
      // Settings import opens its first selected project as an inherited
      // target. The newer side-quest is first in the recency-sorted list.
      const home = window.getByTestId('page-home');
      const offer = modal.getByTestId(
        `import-projects-cursor-rules-review-${payments.id}`,
      );
      await expect(offer).toBeVisible();
      // Dismiss Settings without discarding the results modal, so Home's
      // composer remains the destination whose state the review will read.
      await offer.click();
      await expect(window.getByTestId('repo-rules-review-step')).toContainText(
        'payments-service',
      );
      if (protection === 'explicit') {
        // The global review overlays Home. Dispatch the real picker events
        // beneath it to model a concurrent explicit choice; never patch stores.
        await home.getByTestId('home-workspace-select').dispatchEvent('click');
        await window
          .getByTestId(`home-workspace-option-${side.id}`)
          .dispatchEvent('click');
      }
      if (protection === 'cancel') {
        await window
          .getByTestId('repo-rules-review-step')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      } else if (protection === 'failed-save') {
        await expect(
          window.getByTestId('repo-rules-review-step'),
        ).toBeVisible();
        writeFileSync(
          path.join(imported.extraProjects[1].dir, '.cursorrules'),
          'Changed after scan\n',
        );
        await window.getByTestId('repo-rules-apply').click();
        await expect(
          window.getByTestId('repo-rules-review-step').getByRole('alert'),
        ).toBeVisible();
        await window
          .getByTestId('repo-rules-review-step')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      } else {
        await applyImportRules(window);
      }
      if (await window.getByTestId('settings-overlay').isVisible())
        await app.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      await expect(home.getByTestId('home-workspace-select')).toContainText(
        protection === 'empty' ? 'payments-service' : 'side-quest',
      );
      if (protection === 'draft')
        await expect(home.getByTestId('home-composer-editor')).toContainText(
          'Keep this side-quest draft',
        );
      if (protection === 'explicit')
        await expect(
          home
            .getByTestId('home-composer-editor')
            .locator('[data-slate-string]'),
        ).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, userDataDir);
      imported.cleanup();
    }
  });
}

async function openReview(window, app, workspaceId) {
  if (!(await window.getByTestId('settings-overlay').isVisible()))
    await app.openSettings();
  await app.openSettingsSection('canopy');
  await window.getByTestId('settings-canopy-import-editor-setup-open').click();
  await expect(window.getByTestId('repo-rules-choose')).toBeVisible();
  await window.getByTestId(`repo-rules-choose-${workspaceId}`).click();
  // Choosing a project scans it right away and opens on the review.
  await expect(window.getByTestId('repo-rules-review-step')).toBeVisible();
  await expect(
    window.getByTestId('repo-rules-review-step').locator('h3 .ph-mask'),
  ).toBeVisible();
}

async function cancelReview(window) {
  await window
    .getByTestId('repo-rules-review-step')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
}

test('Settings cancellation, workspace targeting, Project Settings status and Advisor navigation', async () => {
  const userDataDir = seedWelcomeChecklist({
    pendingEntry: 'import-editor-setup',
  });
  const fixture = seedRepoRulesFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    const entry = window.getByTestId(
      'settings-canopy-import-editor-setup-open',
    );
    await entry.click();
    await window
      .getByTestId(`repo-rules-choose-${fixture.workspaceId}`)
      .click();
    const review = window.getByTestId('repo-rules-review-step');
    await expect(review).toContainText('Chats Section Code');
    await expect(window.getByTestId('repo-rules-reassurance')).toHaveText(
      /reads \.cursor\/rules and \.cursorrules in Chats Section Code\. Nothing in the repository changes\.$/,
    );
    await expect(review).toContainText(
      'Applies to new chats. Open chats keep their current rules.',
    );
    const howRulesWork = window.getByTestId('repo-rules-how-rules-work-toggle');
    await expect(howRulesWork).toHaveAttribute('aria-expanded', 'false');
    const precedenceCaveat = review.getByText(
      'AGENTS.md and CLAUDE.md win when they conflict.',
      { exact: true },
    );
    await expect(precedenceCaveat).toBeHidden();
    await howRulesWork.focus();
    await window.keyboard.press('Enter');
    await expect(howRulesWork).toHaveAttribute('aria-expanded', 'true');
    await expect(
      window.getByTestId('repo-rules-how-rules-work-body'),
    ).toContainText('AGENTS.md and CLAUDE.md win when they conflict.');
    await expect(precedenceCaveat).toBeVisible();
    expect(existsSync(fixture.policyPath)).toBe(false);
    await cancelReview(window);
    expect(existsSync(fixture.policyPath)).toBe(false);
    await expect(entry).toBeVisible();
    await entry.click();
    await window
      .getByTestId(`repo-rules-choose-${fixture.workspaceId}`)
      .click();
    await expect(window.getByTestId('repo-rules-review-step')).toBeVisible();
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    expect(JSON.parse(readFileSync(fixture.policyPath, 'utf8')).enabled).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(userDataDir, 'workspaces/cowork-research/repo-rules.json'),
      ),
    ).toBe(false);

    await app.closeSettings();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Chats Section Code').hover();
    await app.workspaceSettingsButton('Chats Section Code').click();
    await expect(
      window.getByTestId('project-settings-repo-rules-status'),
    ).toContainText('On.');
    await window.getByTestId('project-settings-repo-rules-review').click();
    await expect(window.getByTestId('repo-rules-review-step')).toContainText(
      'Chats Section Code',
    );
    await expect(window.getByTestId('repo-rules-apply')).toHaveText('Save');
    await cancelReview(window);
    await window.getByTestId('project-settings-repo-rules-turn-off').click();
    await expect(
      window.getByTestId('project-settings-repo-rules-status'),
    ).toContainText('Off.');
    await window.keyboard.press('Escape');

    await electronApp.evaluate(({ BrowserWindow }, workspaceId) => {
      const main = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!main) throw new Error('Main window missing');
      main.webContents.send('app-advisor:tool-request', {
        kind: 'dispatch_action',
        requestId: 'rules-advisor-navigation',
        action: { type: 'navigation.open_editor_setup', workspaceId },
      });
    }, fixture.workspaceId);
    await expect(window.getByTestId('repo-rules-review-step')).toContainText(
      'Chats Section Code',
    );
    await expect(window.getByTestId('repo-rules-status-enabled')).toHaveCount(
      0,
    );
    expect(JSON.parse(readFileSync(fixture.policyPath, 'utf8')).enabled).toBe(
      false,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('import results review only the imported code workspace and cancel without policy writes', async () => {
  test.setTimeout(180_000);
  const userDataDir = seedWelcomeChecklist();
  const existing = seedRepoRulesFixture(userDataDir);
  const imported = seedExternalProjectImportFixture({ userDataDir });
  writeFileSync(
    path.join(imported.gitApp, '.cursorrules'),
    'IMPORTED_RULE_ONLY',
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: imported.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-canopy-import-projects-open').click();
    const modal = window.getByTestId('import-projects-modal');
    await expect(modal.getByTestId('import-projects-list')).toBeVisible();
    await modal.getByTestId('import-projects-submit').click();
    await expect(modal.getByTestId('import-projects-results')).toBeVisible({
      timeout: 120_000,
    });
    const offer = modal.locator(
      '[data-testid^="import-projects-cursor-rules-review-"]',
    );
    await expect(offer).toHaveCount(1);
    const targetId = (await offer.getAttribute('data-testid')).replace(
      'import-projects-cursor-rules-review-',
      '',
    );
    const policyPath = path.join(
      userDataDir,
      'workspaces',
      targetId,
      'repo-rules.json',
    );
    expect(targetId).not.toBe(existing.workspaceId);
    await offer.click();
    await expect(window.getByTestId('repo-rules-review-step')).toContainText(
      'can2439-git-app',
    );
    await expect(window.getByTestId('repo-rules-choose')).toHaveCount(0);
    await window.getByTestId('repo-rules-preview-toggle').click();
    await expect(window.getByTestId('repo-rules-preview')).toHaveText(
      'IMPORTED_RULE_ONLY',
    );
    await window
      .getByTestId('repo-rules-review-step')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    expect(existsSync(policyPath)).toBe(false);
    expect(existsSync(existing.policyPath)).toBe(false);
    expect(
      readFileSync(path.join(imported.gitApp, '.cursorrules'), 'utf8'),
    ).toBe('IMPORTED_RULE_ONLY');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    imported.cleanup();
  }
});

test('saving the review confirms the result with a toast, even with in-app notifications off', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-rules-toast-'));
  // The confirmation follows the user's own save, so it shows even when
  // in-app notifications are off.
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { inAppNotifications: { enabled: false } },
    }),
  );
  const fixture = seedRepoRulesFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const results = window
      .getByTestId('toast-card')
      .filter({ hasText: /Cursor rules (on|off)/ });
    const expectOneResult = async (texts) => {
      await expect(results).toHaveCount(1);
      for (const text of texts) await expect(results).toContainText(text);
      await results.getByTestId('toast-dismiss').click();
      await expect(results).toHaveCount(0);
    };
    // Cancelling is not a result.
    await openReview(window, app, fixture.workspaceId);
    await window
      .getByTestId('repo-rules-review-step')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    await expect(results).toHaveCount(0);

    // A failed save stays inline; the retry confirms once.
    await openReview(window, app, fixture.workspaceId);
    await expect(window.getByTestId('repo-rules-apply')).toHaveText(
      'Turn on 2 rules',
    );
    // The review scans the project's root checkout; changing a rule there
    // invalidates the review, so this save fails.
    writeFileSync(path.join(fixture.root, '.cursorrules'), CHANGED_RULE);
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-review-step')).toContainText(
      'Cursor rules changed since this review.',
    );
    await expect(window.getByTestId('repo-rules-modal')).toBeVisible();
    await expect(results).toHaveCount(0);
    await window.getByTestId('repo-rules-rescan').click();
    await expect(window.getByTestId('repo-rules-apply')).toHaveText(
      'Turn on 2 rules',
    );
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    await expectOneResult([
      'Chats Section Code',
      'Cursor rules on',
      '2 rules apply to new chats.',
    ]);

    // Turning rules off from the review confirms the off result.
    await openReview(window, app, fixture.workspaceId);
    await window.getByTestId('repo-rules-turn-off').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    await expectOneResult([
      'Chats Section Code',
      'Cursor rules off',
      "New chats won't use this project's Cursor rules.",
    ]);

    // One selected rule reads in the singular.
    await openReview(window, app, fixture.workspaceId);
    await window
      .getByTestId('repo-rules-rule')
      .filter({ hasText: /disabled\.mdc/i })
      .getByTestId('repo-rules-rule-toggle')
      .click();
    await expect(window.getByTestId('repo-rules-apply')).toHaveText(
      'Turn on 1 rule',
    );
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    await expectOneResult([
      'Chats Section Code',
      'Cursor rules on',
      '1 rule applies to new chats.',
    ]);

    // The Project Settings card keeps its inline feedback, without a toast.
    if (await window.getByTestId('settings-overlay').isVisible())
      await app.closeSettings();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Chats Section Code').hover();
    await app.workspaceSettingsButton('Chats Section Code').click();
    await window.getByTestId('project-settings-repo-rules-turn-off').click();
    await expect(
      window.getByTestId('project-settings-repo-rules-status'),
    ).toContainText('Off.');
    await expect(results).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function send(window, chatId, marker) {
  await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
  const completedBefore = await panel
    .getByText('RULE CONTRACT OK', { exact: true })
    .count();
  await panel
    .getByRole('textbox')
    .first()
    .fill(`[${marker}] verify instructions`);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(() => panel.getByText('RULE CONTRACT OK', { exact: true }).count(), {
      timeout: 60_000,
    })
    .toBeGreaterThan(completedBefore);
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: review, preview, selections, restart, live new sessions, resume and opt-out`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), `canopy-rules-${provider}-`),
    );
    const fixture = seedRepoRulesFixture(userDataDir, provider);
    const marker = `Canopy-CRULES-${provider}`;
    const gate = async (requiredSystemText, forbiddenSystemText) =>
      registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: {
          requiredSystemText,
          forbiddenSystemText,
          steps: [{ text: 'RULE CONTRACT OK', stopReason: 'end_turn' }],
        },
      });
    let launch = await launchCanopy({ userDataDir });
    try {
      let window = await launch.electronApp.firstWindow();
      let app = new CanopyAppDriver(window);
      await app.waitForShell();
      await openReview(window, app, fixture.workspaceId);
      expect(existsSync(fixture.policyPath)).toBe(false);
      await cancelReview(window);
      expect(existsSync(fixture.policyPath)).toBe(false);
      await openReview(window, app, fixture.workspaceId);
      const review = window.getByTestId('repo-rules-review-step');
      await expect(review).toBeVisible();
      await expect(review.locator('h3 .ph-mask')).toBeVisible();
      const enabled = review
        .getByTestId('repo-rules-rule')
        .filter({ hasText: '.cursorrules' });
      await enabled.getByTestId('repo-rules-preview-toggle').click();
      await expect(enabled.getByTestId('repo-rules-preview')).toHaveText(
        ENABLED_RULE,
      );
      const disabled = review
        .getByTestId('repo-rules-rule')
        .filter({ hasText: /disabled\.mdc/i });
      await disabled.getByTestId('repo-rules-rule-toggle').focus();
      await window.keyboard.press('Space');
      await expect(
        disabled.getByTestId('repo-rules-rule-toggle'),
      ).toHaveAttribute('aria-checked', 'false');
      await window.getByTestId('repo-rules-apply').click();
      await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
      expect(JSON.parse(readFileSync(fixture.policyPath, 'utf8')).enabled).toBe(
        true,
      );
      for (const source of fixture.sourceBytes)
        expect(readFileSync(source.file)).toEqual(source.bytes);
      expect(readFileSync(fixture.indexPath)).toEqual(fixture.indexBytes);
      await closeCanopy(launch.electronApp, userDataDir, {
        keepUserData: true,
      });
      launch = await launchCanopy({ userDataDir });
      window = await launch.electronApp.firstWindow();
      app = new CanopyAppDriver(window);
      await app.waitForShell();
      await openReview(window, app, fixture.workspaceId);
      await expect(
        window.getByTestId('repo-rules-status-enabled'),
      ).toBeVisible();
      await cancelReview(window);
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree(fixture.worktreeId);
      await gate([ENABLED_RULE], [DISABLED_RULE]);
      await send(window, 'rules-first', marker);
      writeFileSync(path.join(fixture.checkout, '.cursorrules'), CHANGED_RULE);
      await gate([ENABLED_RULE], [DISABLED_RULE, CHANGED_RULE]);
      await send(window, 'rules-first', marker);
      await gate([CHANGED_RULE], [DISABLED_RULE, ENABLED_RULE]);
      await send(window, 'rules-changed', marker);
      await openReview(window, app, fixture.workspaceId);
      await window.getByTestId('repo-rules-turn-off').click();
      await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree(fixture.worktreeId);
      await gate([], [ENABLED_RULE, CHANGED_RULE, DISABLED_RULE]);
      await send(window, 'rules-disabled', marker);
      expect(JSON.parse(readFileSync(fixture.policyPath, 'utf8')).enabled).toBe(
        false,
      );
      expect(readFileSync(fixture.indexPath)).toEqual(fixture.indexBytes);
    } finally {
      await closeCanopy(launch.electronApp, userDataDir);
    }
  });
}

test('Add project offers the Cursor rules review for a repository with rules', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedWelcomeChecklist();
  const folderRoot = mkdtempSync(path.join(tmpdir(), 'canopy-rules-add-'));
  const withRules = path.join(folderRoot, 'rules-demo');
  const withoutRules = path.join(folderRoot, 'plain-demo');
  for (const folder of [withRules, withoutRules]) {
    mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q', folder]);
  }
  mkdirSync(path.join(withRules, '.cursor/rules'), { recursive: true });
  writeFileSync(
    path.join(withRules, '.cursor/rules/always.mdc'),
    '---\nalwaysApply: true\n---\nADD_PROJECT_RULE\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();

    async function addFolder(folder) {
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      await window.getByTestId('add-workspace-mode-existing').click();
      await electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await window.getByTestId('add-workspace-choose-folder').click();
      await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    }

    // A repository without rules is added quietly. Its offer check is
    // asynchronous, so the single toast asserted below is the proof.
    await addFolder(withoutRules);
    await addFolder(withRules);
    const offer = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Cursor rules found' });
    await expect(offer).toBeVisible();
    await expect(offer).toHaveCount(1);
    await expect(offer).toContainText('rules-demo');
    await expect(offer).toContainText(
      'Review them to use them in new chats. The repository stays unchanged.',
    );
    // A single-project offer takes two clicks: the toast opens straight on
    // the scanned review, and nothing turns on until the member applies. An
    // offer naming several projects still asks which one to review first.
    await offer.getByTestId('toast-action').click();
    const review = window.getByTestId('repo-rules-review-step');
    await expect(review).toContainText('rules-demo');
    await expect(review).toContainText('.cursor/rules/always.mdc');
    await expect(window.getByTestId('repo-rules-apply')).toHaveText(
      'Turn on 1 rule',
    );
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});
