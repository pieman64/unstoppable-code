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

async function openReview(window, app, workspaceId) {
  if (!(await window.getByTestId('settings-overlay').isVisible()))
    await app.openSettings();
  await app.openSettingsSection('canopy');
  await window.getByTestId('settings-canopy-import-editor-setup-open').click();
  await expect(window.getByTestId('repo-rules-choose')).toBeVisible();
  await window.getByTestId(`repo-rules-choose-${workspaceId}`).click();
  await expect(window.getByTestId('repo-rules-consent')).toBeVisible();
  await expect(
    window.getByTestId('repo-rules-consent').locator('h3 .ph-mask'),
  ).toBeVisible();
}

test('onboarding cancellation, workspace targeting, Project Settings status and Advisor navigation', async () => {
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
    const entry = window.getByTestId(
      'home-onboarding-suggestion-cta-import-editor-setup',
    );
    await expect(entry).toBeVisible();
    await entry.click();
    await window
      .getByTestId(`repo-rules-choose-${fixture.workspaceId}`)
      .click();
    await expect(window.getByTestId('repo-rules-consent')).toContainText(
      'Chats Section Code',
    );
    await window
      .getByTestId('repo-rules-consent')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    expect(existsSync(fixture.policyPath)).toBe(false);
    const preferences = await window.evaluate(() =>
      window.api.loadPreferences(),
    );
    expect(
      preferences.homeOnboardingSuggestions.entries['import-editor-setup']
        ?.completedAt,
    ).toBeFalsy();
    await expect(entry).toBeVisible();
    await entry.click();
    await window
      .getByTestId(`repo-rules-choose-${fixture.workspaceId}`)
      .click();
    await window.getByTestId('repo-rules-scan').click();
    await expect(window.getByTestId('repo-rules-review-step')).toBeVisible();
    await window.getByTestId('repo-rules-apply').click();
    await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.entries['import-editor-setup']
            ?.completedAt,
      )
      .toBeTruthy();
    expect(JSON.parse(readFileSync(fixture.policyPath, 'utf8')).enabled).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(userDataDir, 'workspaces/cowork-research/repo-rules.json'),
      ),
    ).toBe(false);

    await app.openMainPage();
    await app.workspaceHeaderLabel('Chats Section Code').hover();
    await app.workspaceSettingsButton('Chats Section Code').click();
    await expect(
      window.getByTestId('project-settings-repo-rules-status'),
    ).toContainText('On.');
    await window.getByTestId('project-settings-repo-rules-review').click();
    await expect(window.getByTestId('repo-rules-consent')).toContainText(
      'Chats Section Code',
    );
    await window
      .getByTestId('repo-rules-consent')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
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
    await expect(window.getByTestId('repo-rules-consent')).toContainText(
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
    await expect(window.getByTestId('repo-rules-consent')).toContainText(
      'can2439-git-app',
    );
    await expect(window.getByTestId('repo-rules-choose')).toHaveCount(0);
    await window.getByTestId('repo-rules-scan').click();
    await expect(window.getByTestId('repo-rules-review-step')).toBeVisible();
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
  test(`${provider}: consent, preview, selections, restart, live new sessions, resume and opt-out`, async () => {
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
      await window
        .getByTestId('repo-rules-consent')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      expect(existsSync(fixture.policyPath)).toBe(false);
      await openReview(window, app, fixture.workspaceId);
      await window.getByTestId('repo-rules-scan').focus();
      await window.keyboard.press('Enter');
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
      await window
        .getByTestId('repo-rules-consent')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
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
    await offer.getByTestId('toast-action').click();
    // The offer opens the usual consent step for that project; nothing is
    // read or turned on until the member scans and applies.
    await expect(window.getByTestId('repo-rules-consent')).toContainText(
      'rules-demo',
    );
    await window.getByTestId('repo-rules-scan').click();
    await expect(window.getByTestId('repo-rules-review-step')).toContainText(
      '.cursor/rules/always.mdc',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});
