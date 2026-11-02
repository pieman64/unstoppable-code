import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeCanopy,
  launchCanopy,
  prepareIsolatedProviderState,
} from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';
import {
  IMPORT_FIXTURE_FOLDER_PROJECT as FOLDER_PROJECT,
  IMPORT_FIXTURE_GIT_PROJECT as GIT_PROJECT,
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';
import {
  applyImportRules,
  importedWorkspace,
  importFirstRunRuleProjects,
  openFirstRunRulesOffer,
  seedPostImportRulesFixture,
} from './postImportRules.mjs';

// First-run page: a new install (no onboarding marker, no projects) lands on
// "Let's get started" instead of Home. It lists the Claude and Codex projects
// found on the computer, imports the checked ones collapsed in the sidebar,
// and lands in the Home composer. Skipping or finishing records the marker,
// so the page never returns, and an existing install never sees it.
//
// Deterministic: the harness isolates the provider stores (empty unless a
// spec seeds one), and the import fixture seeds a Claude store there. No
// live agents, no network: cloud reads go to the shared mock server.

function seedPreferences(userDataDir, onboardingCompleted) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { onboardingCompleted } }),
  );
}

// Home keeps a hidden composer mounted too; only the visible one counts.
function homeComposer(window) {
  return window.getByTestId('home-composer-editor').locator('visible=true');
}

function readOnboardingCompleted(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences.onboardingCompleted;
}

// A Claude store with no projects. Without it the copy races the app's own
// Claude CLI, which writes this file about a second after launch.
function seedEmptyClaudeStore(userDataDir) {
  prepareIsolatedProviderState(userDataDir);
  writeFileSync(
    path.join(userDataDir, 'provider-state', 'claude', '.claude.json'),
    '{}',
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Activity this many days before `now`, so the fixture keeps its recency.
// The hour of slack keeps the transcript's last record, written 5 seconds
// later, in the same day.
function daysBefore(now, days) {
  return new Date(now - days * DAY_MS - 60 * 60 * 1000).toISOString();
}

function readWorkspaces(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  ).workspaces;
}

const DISCOVER_CHANNEL = 'external-projects:discover';
const IMPORT_CHANNEL = 'external-projects:import';

// The window's real size: Electron pages report no Playwright viewport.
function viewport(window) {
  return window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

// Fully inside the window and not covered: the hit test at the control's
// center lands on it. `toBeVisible` passes for a control below the fold.
async function expectFullyInView(window, locator) {
  const { width, height } = await viewport(window);
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const clipped = [];
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (
          /(auto|scroll|hidden|clip)/.test(style.overflowY) &&
          (rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5)
        )
          clipped.push({
            axis: 'y',
            parent: parent.getAttribute('data-testid') || parent.className,
            top: rect.top,
            bottom: rect.bottom,
            boundsTop: bounds.top,
            boundsBottom: bounds.bottom,
          });
        if (
          /(auto|scroll|hidden|clip)/.test(style.overflowX) &&
          (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)
        )
          clipped.push({
            axis: 'x',
            parent: parent.getAttribute('data-testid') || parent.className,
            left: rect.left,
            right: rect.right,
            boundsLeft: bounds.left,
            boundsRight: bounds.right,
          });
      }
      return clipped;
    }),
    'the entire control must clear its scrolling ancestors',
  ).toEqual([]);
  expect(
    await locator.evaluate((element) => {
      // A disabled button takes no pointer events; hit-test it anyway.
      const prior = element.style.pointerEvents;
      element.style.pointerEvents = 'auto';
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      element.style.pointerEvents = prior;
      return hit !== null && element.contains(hit);
    }),
  ).toBe(true);
  return box;
}

// Blank space the Projects box shows beyond its rows and footer: the list's
// height past its rows, and the drawn surface's bottom edge (the box's
// `::before` layer) past the footer's.
function projectsBoxSlack(page) {
  return page.getByTestId('first-run-import-list').evaluate((list) => {
    const box = list.parentElement;
    const surface = getComputedStyle(box, '::before');
    const surfaceBottom =
      box.getBoundingClientRect().top +
      parseFloat(surface.top) +
      parseFloat(surface.height);
    const actions = box
      .querySelector('[data-testid="first-run-import-actions"]')
      .getBoundingClientRect();
    return {
      list:
        list.getBoundingClientRect().height -
        list.firstElementChild.getBoundingClientRect().height,
      footer: surfaceBottom - actions.bottom,
    };
  });
}

async function expectProjectsBoxHugsContent(page) {
  const slack = await projectsBoxSlack(page);
  expect(slack.list).toBeLessThanOrEqual(1);
  expect(Math.abs(slack.footer)).toBeLessThanOrEqual(1);
}

function pageOverflow(page) {
  return page.evaluate((element) => ({
    vertical: element.scrollHeight - element.clientHeight,
    horizontal: element.scrollWidth - element.clientWidth,
  }));
}

// Answers the next discovery only when the spec releases it, with the
// response the real handler gave, so the spec sees the scan running.
async function holdDiscovery(electronApp, response) {
  await electronApp.evaluate(
    ({ ipcMain }, { channel, held }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(
        channel,
        () =>
          new Promise((resolve) => {
            globalThis.__can4679ReleaseDiscovery = () => resolve(held);
          }),
      );
    },
    { channel: DISCOVER_CHANNEL, held: response },
  );
}

async function releaseDiscovery(electronApp) {
  await expect
    .poll(() =>
      electronApp.evaluate(
        () => typeof globalThis.__can4679ReleaseDiscovery === 'function',
      ),
    )
    .toBe(true);
  await electronApp.evaluate(() => globalThis.__can4679ReleaseDiscovery());
}

test.describe('first-run import page', () => {
  test('CAN-4921 account replacement drops a pending credits choice', async () => {
    test.setTimeout(120_000);
    const oldKey = `csk_can4921_old_${Date.now()}`;
    const newKey = `csk_can4921_new_${Date.now()}`;
    const authKey = `can4921-unauthenticated-${Date.now()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    for (const key of [oldKey, newKey]) {
      await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        cloud: {
          aiCreditsBalance: { credits: 0, eligible: true },
          dailyCreditDrip: {
            enabled: false,
            decidedAt: null,
            capCredits: 10,
            saveDelayMs: key === oldKey ? 15_000 : 0,
          },
        },
      });
    }
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4921-account-'));
    seedPreferences(userDataDir, []);
    seedEmptyClaudeStore(userDataDir);
    let launch;
    try {
      launch = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_MOCK_API_KEY: authKey,
        },
      });
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await connectMockCloudAccount(window, oldKey);
      const toggle = page.getByTestId('first-run-daily-credits-toggle');
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeDisabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, oldKey)).activity
              .dailyCreditDripEnable ?? 0,
        )
        .toBe(1);
      await connectMockCloudAccount(window, newKey);
      await expect(toggle).toBeEnabled();
      // Assert before the old account's delayed save can settle.
      await expect(toggle).toHaveAttribute('aria-checked', 'false', {
        timeout: 1000,
      });
      await expect(
        page.getByTestId('first-run-daily-credits-confirmation'),
      ).toHaveCount(0);
      await toggle.click();
      await expect(
        page.getByTestId('first-run-daily-credits-confirmation'),
      ).toHaveText('10 free AI Credits added · refills daily');
    } finally {
      if (launch) await closeCanopy(launch.electronApp, userDataDir);
      for (const key of [oldKey, newKey, authKey]) {
        await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      }
    }
  });

  test('CAN-4674 successful Apply targets payments-service and sends the task there', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4674-first-run-'),
    );
    const fixture = seedPostImportRulesFixture(userDataDir);
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const home = await importFirstRunRuleProjects(window, fixture);
      expect(
        readWorkspaces(userDataDir).filter((entry) =>
          ['side-quest', 'payments-service'].includes(entry.name),
        ),
      ).toHaveLength(2);
      await openFirstRunRulesOffer(window);
      await applyImportRules(window);
      // Keep this regression independent of the new hint. On unchanged code
      // it reaches a successful save and fails here on side-quest.
      await expect(home.getByTestId('home-workspace-select')).toContainText(
        'payments-service',
      );
      const payments = importedWorkspace(userDataDir, 'payments-service');
      const readTasks = () =>
        JSON.parse(
          readFileSync(
            path.join(userDataDir, 'workspaces', payments.id, 'worktrees.json'),
            'utf8',
          ),
        ).worktrees;
      const before = readTasks().map((entry) => entry.id);
      await home
        .getByTestId('home-composer-editor')
        .fill('Add a payments health check');
      await home.getByTestId('home-send-button').click();
      await expect(
        window
          .getByTestId('panel-content-chat')
          .getByText('Add a payments health check')
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          () =>
            readTasks().filter((entry) => !before.includes(entry.id)).length,
          { timeout: 30_000 },
        )
        .toBe(1);
    } finally {
      await closeCanopy(launch.electronApp, userDataDir);
      fixture.cleanup();
    }
  });

  for (const last of ['apply', 'skip']) {
    test(`CAN-4980 a two-project rules offer keeps the second project after the first Apply, then ${last}`, async () => {
      test.setTimeout(240_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'can4980-first-run-'),
      );
      const fixture = seedPostImportRulesFixture(userDataDir, 'side-quest', {
        sideQuestRules: true,
      });
      seedPreferences(userDataDir, []);
      const launch = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });
      try {
        const window = await launch.electronApp.firstWindow();
        await importFirstRunRuleProjects(window, fixture);
        const payments = importedWorkspace(userDataDir, 'payments-service');
        const sideQuest = importedWorkspace(userDataDir, 'side-quest');
        const policy = (workspace) =>
          path.join(userDataDir, 'workspaces', workspace.id, 'repo-rules.json');
        const checklistProgress = async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions?.entries?.['import-editor-setup'];

        const offer = window
          .getByTestId('toast-card')
          .filter({ hasText: '2 new projects have Cursor rules' });
        await expect(offer).toBeVisible({ timeout: 30_000 });
        await offer.getByTestId('toast-action').click();
        const modal = window.getByTestId('repo-rules-modal');
        await modal.getByTestId(`repo-rules-choose-${payments.id}`).click();
        await expect(modal.getByTestId('repo-rules-review-step')).toContainText(
          'payments-service',
        );
        await modal.getByTestId('repo-rules-apply').click();

        // The first save returns to the chooser instead of closing.
        await expect(modal.getByTestId('repo-rules-choose')).toBeVisible();
        await expect(
          modal.getByTestId(`repo-rules-decision-${payments.id}`),
        ).toHaveText('Rules on');
        await expect(
          modal.getByTestId(`repo-rules-skip-${sideQuest.id}`),
        ).toBeVisible();
        // The save handler has settled once its result toast shows.
        await expect(
          window
            .getByTestId('toast-card')
            .filter({ hasText: 'Cursor rules on' }),
        ).toBeVisible();
        expect(JSON.parse(readFileSync(policy(payments), 'utf8')).enabled).toBe(
          true,
        );
        expect(existsSync(policy(sideQuest))).toBe(false);
        expect(await checklistProgress()).toBeUndefined();

        if (last === 'apply') {
          // Closing isn't a decision, and a save of the other offered
          // project from Settings resolves the offer.
          await window.keyboard.press('Escape');
          await expect(modal).toHaveCount(0);
          expect(await checklistProgress()).toBeUndefined();
          const app = new CanopyAppDriver(window);
          await app.openSettings();
          await app.openSettingsSection('canopy');
          await window
            .getByTestId('settings-canopy-import-editor-setup-open')
            .click();
          await modal.getByTestId(`repo-rules-choose-${sideQuest.id}`).click();
          await expect(
            modal.getByTestId('repo-rules-review-step'),
          ).toContainText('side-quest');
          await modal.getByTestId('repo-rules-apply').click();
        } else {
          await modal.getByTestId(`repo-rules-skip-${sideQuest.id}`).click();
        }
        await expect(modal).toHaveCount(0);
        // Rules decisions persist without recreating retired checklist progress.
        expect(await checklistProgress()).toBeUndefined();
        if (last === 'apply')
          expect(
            JSON.parse(readFileSync(policy(sideQuest), 'utf8')).enabled,
          ).toBe(true);
        else expect(existsSync(policy(sideQuest))).toBe(false);
      } finally {
        await closeCanopy(launch.electronApp, userDataDir);
        fixture.cleanup();
      }
    });
  }

  test('CAN-4674 recency hint opens the picker by keyboard and Escape preserves the target', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4674-hint-'));
    const fixture = seedPostImportRulesFixture(userDataDir);
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const home = await importFirstRunRuleProjects(window, fixture);
      const hint = home.getByTestId('home-workspace-reason');
      await expect(hint).toContainText('Most recent');
      const action = hint.getByRole('button', {
        name: 'Switch project',
        exact: true,
      });
      await action.focus();
      await action.press('Enter');
      const payments = importedWorkspace(userDataDir, 'payments-service');
      const option = window.getByTestId(`home-workspace-option-${payments.id}`);
      await expect(option).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(option).toHaveCount(0);
      await expect(home.getByTestId('home-workspace-select')).toContainText(
        'side-quest',
      );
      await expect(hint).toBeVisible();
      await openFirstRunRulesOffer(window);
      await applyImportRules(window);
      await expect(home.getByTestId('home-workspace-select')).toContainText(
        'payments-service',
      );
      await expect(hint).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, userDataDir);
      fixture.cleanup();
    }
  });

  test('imports the checked projects collapsed and lands on Home', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    // Both projects are recent, so they show checked without the toggle.
    const now = Date.now();
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      activityTimestamps: {
        gitApp: daysBefore(now, 1),
        notes: daysBefore(now, 2),
      },
    });
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('auth-panel-claude')).toBeVisible();
      await expect(page.getByTestId('auth-panel-codex')).toBeVisible();

      for (const dir of [fixture.gitApp, fixture.notes]) {
        await expect(
          page.getByTestId(
            `first-run-import-row-${externalProjectCandidateIdFor(dir)}`,
          ),
        ).toBeVisible({ timeout: 30_000 });
      }
      const selectAll = page
        .getByTestId('first-run-import-select-all')
        .getByRole('checkbox');
      if (!(await selectAll.isChecked())) await selectAll.check();
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 2 projects');
      await submit.click();

      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect(homeComposer(window)).toBeVisible();
      await expect
        .poll(() =>
          readWorkspaces(userDataDir)
            .filter((entry) =>
              [GIT_PROJECT, FOLDER_PROJECT].includes(entry.name),
            )
            .map((entry) => entry.collapsed),
        )
        .toEqual([true, true]);
      await expect
        .poll(() => readOnboardingCompleted(userDataDir))
        .toContain('first-run-import-v0');

      // The marker keeps the page away after a reload.
      await window.reload();
      await new CanopyAppDriver(window).waitForShell();
      await expect(homeComposer(window)).toBeVisible();
      await expect(page).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('CAN-4712 lists every project unchecked when all are older than 90 days', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4712-first-run-'),
    );
    const now = Date.now();
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      activityTimestamps: {
        gitApp: daysBefore(now, 105),
        notes: daysBefore(now, 130),
      },
      extraGitProjects: [
        { name: 'can4712-dotfiles', lastActivityAt: daysBefore(now, 150) },
      ],
    });
    const [dotfiles] = fixture.extraProjects;
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      const rows = [fixture.gitApp, fixture.notes, dotfiles.dir].map((dir) =>
        page.getByTestId(
          `first-run-import-row-${externalProjectCandidateIdFor(dir)}`,
        ),
      );
      for (const row of rows) {
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByRole('checkbox')).not.toBeChecked();
      }
      await expect(page.getByTestId('first-run-import-older')).toHaveCount(0);
      await expect(page.getByTestId('first-run-import-projects')).toContainText(
        'Found 3 Claude projects · last used 3–5 months ago',
      );
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Select a project to import');
      await expect(submit).toBeDisabled();

      await rows[0].getByRole('checkbox').check();
      await expect(submit).toHaveText('Import 1 project');
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect
        .poll(() => readWorkspaces(userDataDir).map((entry) => entry.name))
        .toContain(GIT_PROJECT);
      expect(
        readWorkspaces(userDataDir).filter((entry) =>
          [FOLDER_PROJECT, 'can4712-dotfiles'].includes(entry.name),
        ),
      ).toHaveLength(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('CAN-4679 keeps Import and Skip in view through the scan, expansion and resizing', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4679-mixed-'));
    const now = Date.now();
    // Two recent projects and enough older ones that the expanded list
    // must scroll at 1280x800.
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      activityTimestamps: {
        gitApp: daysBefore(now, 1),
        notes: daysBefore(now, 2),
      },
      extraGitProjects: Array.from({ length: 10 }, (_, index) => ({
        name: `can4679-older-${index + 1}`,
        lastActivityAt: daysBefore(now, 100 + index * 10),
      })),
    });
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const { electronApp } = launch;
      const window = await electronApp.firstWindow();
      await window.setViewportSize({ width: 1280, height: 800 });
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      const rowFor = (dir) =>
        page.getByTestId(
          `first-run-import-row-${externalProjectCandidateIdFor(dir)}`,
        );
      await expect(rowFor(fixture.gitApp)).toBeVisible({ timeout: 30_000 });

      // Scan transition: hold a real scan's answer, reload, and release it.
      const response = await window.evaluate(() =>
        window.api.externalProjects.discover({}),
      );
      await holdDiscovery(electronApp, response);
      await window.reload();
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('first-run-import-projects-loading'),
      ).toBeAttached();
      await expect(page.getByTestId('first-run-import-submit')).toHaveCount(0);
      const skip = page.getByTestId('first-run-import-skip');
      const scanning = await expectFullyInView(window, skip);
      await skip.focus();
      await releaseDiscovery(electronApp);
      await expect(rowFor(fixture.gitApp)).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('first-run-import-projects-loading'),
      ).toHaveCount(0);
      // The box hugs its rows, so Skip moves down with the found rows but
      // keeps focus and stays in view.
      const found = await expectFullyInView(window, skip);
      await expect(skip).toBeFocused();
      expect(found.y).toBeGreaterThanOrEqual(scanning.y - 1);

      // Mixed result: both actions in view, the page does not scroll, Skip
      // comes before the primary action, and the box ends at its footer.
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 2 projects');
      await expect(submit).toBeEnabled();
      const submitBox = await expectFullyInView(window, submit);
      expect(submitBox.x).toBeGreaterThan(found.x);
      expect((await pageOverflow(page)).vertical).toBeLessThanOrEqual(1);
      await expectProjectsBoxHugsContent(page);
      // A taller window leaves room under the box rather than stretching it.
      await window.setViewportSize({ width: 1280, height: 1100 });
      await expect
        .poll(async () => (await projectsBoxSlack(page)).list)
        .toBeLessThanOrEqual(1);
      await expectProjectsBoxHugsContent(page);
      await window.setViewportSize({ width: 1280, height: 800 });

      // Expanded: every row is listed, the list scrolls on its own, and its
      // last row clears the footer.
      await page.getByTestId('first-run-import-older').click();
      await expect(page.getByTestId('first-run-import-older')).toBeFocused();
      for (const dir of fixture.extraProjects.map((project) => project.dir))
        await expect(rowFor(dir)).toBeAttached();
      await expect(submit).toHaveText('Import 2 projects');
      await expectFullyInView(window, skip);
      await expectFullyInView(window, submit);
      expect((await pageOverflow(page)).vertical).toBeLessThanOrEqual(1);
      const list = page.getByTestId('first-run-import-list');
      expect(
        await list.evaluate((el) => el.scrollHeight - el.clientHeight),
      ).toBeGreaterThan(0);
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const lastRow = rowFor(fixture.extraProjects.at(-1).dir);
      const lastBox = await lastRow.boundingBox();
      const listBox = await list.boundingBox();
      const actionsBox = await page
        .getByTestId('first-run-import-actions')
        .boundingBox();
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(
        listBox.y + listBox.height + 0.5,
      );
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(actionsBox.y);
      await expectFullyInView(window, lastRow.getByRole('checkbox'));

      // Resize: the footer and the list follow the window's height.
      await window.setViewportSize({ width: 1280, height: 1000 });
      await expect
        .poll(async () => (await list.boundingBox()).height - listBox.height)
        .toBeGreaterThan(198);
      const tallActions = await page
        .getByTestId('first-run-import-actions')
        .boundingBox();
      const tallList = await list.boundingBox();
      expect(Math.abs(tallActions.y - actionsBox.y - 200)).toBeLessThanOrEqual(
        2,
      );
      expect(
        Math.abs(tallList.height - listBox.height - 200),
      ).toBeLessThanOrEqual(2);
      await window.setViewportSize({ width: 1280, height: 800 });
      await expect
        .poll(async () =>
          Math.abs((await list.boundingBox()).height - listBox.height),
        )
        .toBeLessThanOrEqual(2);

      // Short window and zoom: everything stays reachable by scrolling the
      // page, with no sideways overflow.
      for (const { width, height, zoom } of [
        { width: 800, height: 500, zoom: 1 },
        { width: 1280, height: 800, zoom: 1.25 },
      ]) {
        await window.setViewportSize({ width, height });
        await window.evaluate((value) => {
          document.documentElement.style.zoom = String(value);
        }, zoom);
        expect((await pageOverflow(page)).horizontal).toBeLessThanOrEqual(1);
        for (const control of [skip, submit]) {
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport({ ratio: 1 });
        }
        await submit.focus();
        await expect(submit).toBeFocused();
      }
      await window.evaluate(() => {
        document.documentElement.style.zoom = '';
      });
      await window.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate((el) => {
        el.scrollTop = 0;
      });

      await expectFullyInView(window, submit);
      await submit.click();
      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect
        .poll(() =>
          readWorkspaces(userDataDir)
            .map((entry) => entry.name)
            .filter((name) => [GIT_PROJECT, FOLDER_PROJECT].includes(name))
            .sort(),
        )
        .toEqual([FOLDER_PROJECT, GIT_PROJECT].sort());
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('CAN-4679 five candidates support keyboard navigation through short and zoomed layouts', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4679-keys-'));
    const now = Date.now();
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      activityTimestamps: {
        gitApp: daysBefore(now, 1),
        notes: daysBefore(now, 2),
      },
      extraGitProjects: Array.from({ length: 3 }, (_, index) => ({
        name: `can4679-keyboard-${index}`,
        lastActivityAt: daysBefore(now, 100 + index * 10),
      })),
    });
    seedPreferences(userDataDir, []);
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const browserWindow = await launch.electronApp.browserWindow(window);
      await window.setViewportSize({ width: 1280, height: 800 });
      const page = window.getByTestId('first-run-import-page');
      const submit = page.getByTestId('first-run-import-submit');
      const skip = page.getByTestId('first-run-import-skip');
      await expect(submit).toHaveText('Import 2 projects', { timeout: 30_000 });
      await page.getByTestId('first-run-import-older').click();
      const list = page.getByTestId('first-run-import-list');
      const checkboxes = list.getByRole('checkbox');
      await expect(checkboxes).toHaveCount(6); // Select all and five projects.
      await expectFullyInView(window, skip);
      await expectFullyInView(window, submit);
      expect((await pageOverflow(page)).vertical).toBeLessThanOrEqual(1);
      // Select all and every row keep the same trailing edge, including
      // on a classic-scrollbar host when the list overflows.
      const edges = await checkboxes.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().right),
      );
      expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);

      for (const { width, height, zoom } of [
        { width: 800, height: 500, zoom: 1 },
        { width: 1280, height: 800, zoom: 1.25 },
        { width: 900, height: 1000, zoom: 2 },
      ]) {
        await window.setViewportSize({ width, height });
        // Match Settings' UI scale: Chromium zoom changes the layout
        // viewport. CSS zoom doubles w-screen instead and scrolls the
        // entire app sideways, which is not the product's zoom behavior.
        await browserWindow.evaluate((nativeWindow, value) => {
          nativeWindow.webContents.setZoomFactor(value);
        }, zoom);
        expect((await pageOverflow(page)).horizontal).toBeLessThanOrEqual(1);
        expect((await pageOverflow(list)).horizontal).toBeLessThanOrEqual(1);
        // Establish the starting point once, then use real Tab navigation.
        // Browser focus scrolling must reveal every subsequent control.
        await checkboxes.first().focus();
        const controls = [
          ...Array.from({ length: 5 }, (_, index) => checkboxes.nth(index + 1)),
          page.getByTestId('first-run-import-older'),
          skip,
          submit,
        ];
        for (const control of controls) {
          await window.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expectFullyInView(window, control);
          expect(
            await control.evaluate((element) =>
              element.matches(':focus-visible'),
            ),
          ).toBe(true);
          expect(
            await control.evaluate((element) => {
              const style = getComputedStyle(element);
              return (
                style.boxShadow !== 'none' ||
                (style.outlineStyle !== 'none' &&
                  parseFloat(style.outlineWidth) > 0)
              );
            }),
          ).toBe(true);
        }
        if ((await pageOverflow(page)).vertical > 1) {
          expect(
            await page.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
        }
      }
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('CAN-4679 keeps the actions in view with credits and only older projects', async () => {
    test.setTimeout(240_000);
    const key = `csk_can4679_credits_${Date.now()}`;
    const authKey = `can4679-unauthenticated-${Date.now()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        aiCreditsBalance: { credits: 0, eligible: true },
        dailyCreditDrip: { enabled: false, decidedAt: null, capCredits: 10 },
      },
    });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4679-older-'));
    const now = Date.now();
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      activityTimestamps: {
        gitApp: daysBefore(now, 105),
        notes: daysBefore(now, 130),
      },
      extraGitProjects: [
        { name: 'can4679-dotfiles', lastActivityAt: daysBefore(now, 150) },
      ],
    });
    seedPreferences(userDataDir, []);
    let launch;
    try {
      launch = await launchCanopy({
        userDataDir,
        env: {
          ...fixture.env,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_MOCK_API_KEY: authKey,
        },
      });
      const { electronApp } = launch;
      const window = await electronApp.firstWindow();
      await window.setViewportSize({ width: 1280, height: 800 });
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await connectMockCloudAccount(window, key);
      await expect(page.getByTestId('first-run-daily-credits')).toBeVisible({
        timeout: 30_000,
      });
      for (const provider of ['claude', 'codex'])
        await expect(page.getByTestId(`auth-panel-${provider}`)).toBeVisible();
      const rows = [
        fixture.gitApp,
        fixture.notes,
        fixture.extraProjects[0].dir,
      ].map((dir) =>
        page.getByTestId(
          `first-run-import-row-${externalProjectCandidateIdFor(dir)}`,
        ),
      );
      for (const row of rows)
        await expect(row).toBeAttached({ timeout: 30_000 });

      // The tallest reported state, with nothing selected.
      const submit = page.getByTestId('first-run-import-submit');
      const skip = page.getByTestId('first-run-import-skip');
      await expect(submit).toHaveText('Select a project to import');
      await expect(submit).toBeDisabled();
      await expectFullyInView(window, submit);
      await expectFullyInView(window, skip);
      expect((await pageOverflow(page)).vertical).toBeLessThanOrEqual(1);

      // A long failure wraps by the actions, which stay reachable.
      const candidateId = externalProjectCandidateIdFor(fixture.gitApp);
      await electronApp.evaluate(
        ({ ipcMain }, { channel, failed }) => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => ({ results: [failed] }));
        },
        {
          channel: IMPORT_CHANNEL,
          failed: {
            candidateId,
            displayName: `a-project-with-a-very-long-name-${'x'.repeat(160)}`,
            rootPath: fixture.gitApp,
            status: 'failed',
            chatsImported: 0,
            chatsReadOnly: 0,
            chatsSkipped: 0,
            retryable: true,
            message: 'Folder is gone',
          },
        },
      );
      await rows[0].getByRole('checkbox').check();
      await expect(submit).toHaveText('Import 1 project');
      await submit.click();
      const actions = page.getByTestId('first-run-import-actions');
      await expect(actions).toContainText("Couldn't import a-project-with", {
        timeout: 30_000,
      });
      await expect(submit).toBeEnabled();
      await expect(rows[0].getByRole('checkbox')).toBeChecked();
      expect((await pageOverflow(page)).horizontal).toBeLessThanOrEqual(1);
      for (const control of [skip, submit]) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      await window.setViewportSize({ width: 800, height: 500 });
      expect((await pageOverflow(page)).horizontal).toBeLessThanOrEqual(1);
      for (const control of [skip, submit]) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
      }
    } finally {
      try {
        if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
      } finally {
        fixture.cleanup();
        await Promise.all(
          [key, authKey].map((scenarioKey) =>
            clearScenario(DEFAULT_MOCK_BASE_URL, scenarioKey).catch(
              () => undefined,
            ),
          ),
        );
      }
    }
  });

  for (const key of ['Enter', 'Space']) {
    test(`CAN-5290 leads an empty scan with Choose a folder and ${key} continues to Home without a project`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-first-run-'),
      );
      seedPreferences(userDataDir, []);
      seedEmptyClaudeStore(userDataDir);
      const launch = await launchCanopy({ userDataDir });
      try {
        const window = await launch.electronApp.firstWindow();
        await window.setViewportSize({ width: 1280, height: 800 });
        const page = window.getByTestId('first-run-import-page');
        const empty = page.getByTestId('first-run-import-empty');
        await expect(empty).toContainText('Add a project', { timeout: 30_000 });
        await expect(empty).toContainText('Add the folder you want to work in');
        const choose = empty.getByRole('button', { name: 'Choose a folder' });
        await expect(choose).toBeVisible();
        await expect(choose).toHaveClass(/bg-accent/);
        await expect(page.getByTestId('first-run-import-submit')).toHaveCount(
          0,
        );
        const skip = page.getByTestId('first-run-import-skip');
        await expect(skip).toHaveText('Continue without a project');
        await expect(skip).toHaveClass(/bg-transparent/);
        await expect(skip).not.toHaveClass(/bg-accent/);
        await expect(skip).toBeInViewport({ ratio: 1 });
        // One row and the footer: the box ends at them, with no blank space.
        await expectProjectsBoxHugsContent(page);
        // The two empty-state actions remain adjacent in keyboard order.
        await choose.focus();
        await window.keyboard.press('Tab');
        await expect(skip).toBeFocused();
        await expect(skip).toHaveCSS('outline-style', 'solid');
        await expect(skip).not.toHaveCSS('outline-width', '0px');
        await window.keyboard.press('Shift+Tab');
        await expect(choose).toBeFocused();
        await expect(choose).toHaveCSS('outline-style', 'solid');
        await window.keyboard.press('Tab');
        expect(readOnboardingCompleted(userDataDir)).not.toContain(
          'first-run-import-v0',
        );
        await window.keyboard.press(key);
        await expect(page).toHaveCount(0);
        await expect(homeComposer(window)).toBeVisible();
        await expect
          .poll(() => readOnboardingCompleted(userDataDir))
          .toContain('first-run-import-v0');
      } finally {
        await closeCanopy(launch.electronApp, launch.userDataDir);
      }
    });
  }

  // The reported guest journey: neither provider store exists at all.
  test('CAN-5290 a guest with no provider stores chooses a folder without finishing onboarding', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, []);
    const folderParent = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-folder-'),
    );
    const folderName = 'first-run-guest-folder';
    const folder = path.join(folderParent, folderName);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'README.md'), '# Guest\n');
    const launch = await launchCanopy({
      userDataDir,
      // The picked folder lives under the temp dir, which discovery
      // otherwise excludes.
      env: { CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1' },
    });
    try {
      const window = await launch.electronApp.firstWindow();
      await window.setViewportSize({ width: 1280, height: 800 });
      const page = window.getByTestId('first-run-import-page');
      const empty = page.getByTestId('first-run-import-empty');
      await expect(empty).toContainText('Add a project', { timeout: 30_000 });
      const choose = page.getByTestId('first-run-import-choose-folder');
      await expect(choose).toHaveClass(/bg-accent/);
      const skip = page.getByTestId('first-run-import-skip');
      await expect(skip).toHaveText('Continue without a project');

      // Canceling the picker leaves the empty state as it was.
      await launch.electronApp.evaluate(({ dialog }) => {
        globalThis.__can5290FolderPicks = 0;
        dialog.showOpenDialog = async () => {
          globalThis.__can5290FolderPicks += 1;
          return { canceled: true, filePaths: [] };
        };
      });
      await skip.focus();
      await window.keyboard.press('Shift+Tab');
      await expect(choose).toBeFocused();
      await expect(choose).toHaveCSS('outline-style', 'solid');
      await expect(choose).not.toHaveCSS('outline-width', '0px');
      for (const [index, key] of ['Enter', 'Space'].entries()) {
        await window.keyboard.press(key);
        // Await the real picker call so a no-op key cannot pass as a cancel.
        await expect
          .poll(() =>
            launch.electronApp.evaluate(() => globalThis.__can5290FolderPicks),
          )
          .toBe(index + 1);
        await expect(empty).toBeVisible();
        await expect(skip).toHaveText('Continue without a project');
        expect(readOnboardingCompleted(userDataDir)).not.toContain(
          'first-run-import-v0',
        );
        await expect(choose).toBeFocused();
      }

      await launch.electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await window.keyboard.press('Space');
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 1 project', { timeout: 30_000 });
      await expect(page.getByTestId('first-run-import-list')).toContainText(
        folderName,
      );
      await expect(empty).toHaveCount(0);
      await expect(skip).toHaveText('Skip for now');
      await expect(page).toBeVisible();
      expect(readOnboardingCompleted(userDataDir)).not.toContain(
        'first-run-import-v0',
      );
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });

  test('welcomes a new user with no Claude or Codex', async () => {
    test.setTimeout(180_000);
    const key = 'csk_first_run_no_provider_e2e';
    // The provider probes read this key's scenario: Claude and Codex signed
    // out.
    const authKey = 'first-run-no-provider-unauthenticated';
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        aiCreditsBalance: { credits: 3, eligible: true },
        dailyCreditDrip: {
          enabled: false,
          decidedAt: null,
          capCredits: 10,
          saveDelayMs: 800,
        },
      },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, []);
    seedEmptyClaudeStore(userDataDir);
    const folderParent = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-folder-'),
    );
    const folderName = 'first-run-picked-folder';
    const folder = path.join(folderParent, folderName);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'README.md'), '# Picked\n');
    let launch;
    try {
      launch = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_MOCK_API_KEY: authKey,
          // The picked folder lives under the temp dir, which discovery
          // otherwise excludes.
          CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1',
        },
      });
      const window = await launch.electronApp.firstWindow();
      const page = window.getByTestId('first-run-import-page');
      await expect(page).toBeVisible({ timeout: 30_000 });
      // Connecting dispatches the account-changed event, so the page re-reads
      // the drip preference for this scenario's key.
      await connectMockCloudAccount(window, key);

      await expect(page).toContainText(
        'Use free AI Credits, or connect a subscription you already have.',
      );
      for (const provider of ['claude', 'codex']) {
        const row = page.getByTestId(`auth-panel-${provider}`);
        await expect(row).toContainText('Not connected', { timeout: 30_000 });
        await expect(
          page.getByTestId(`auth-panel-${provider}-connect`),
        ).toHaveText('Connect');
      }
      await expect(
        page.locator('[class*="destructive"], [class*="warning"]'),
      ).toHaveCount(0);

      const credits = page.getByTestId('first-run-daily-credits');
      await expect(credits).toBeVisible({ timeout: 30_000 });
      const toggle = page.getByTestId('first-run-daily-credits-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAccessibleName('Free daily AI Credits');
      await expect(toggle).toHaveAccessibleDescription(
        'No card needed · 10 AI Credits every day',
      );
      // Compare real layout before/during/after saves at the supported window
      // floor and text scale as well as the normal width. Each iteration has
      // a deferred save; DOM counts cannot stand in for these browser boxes.
      for (const { width, scale } of [
        { width: 1280, scale: 1 },
        { width: 900, scale: 1 },
        { width: 900, scale: 2 },
      ]) {
        await window.setViewportSize({ width, height: 1000 });
        await window.evaluate((zoom) => {
          document.documentElement.style.zoom = String(zoom);
        }, scale);
        const description = page.getByTestId(
          'first-run-daily-credits-description',
        );
        const next = page.getByTestId('first-run-import-skip');
        const before = await next.boundingBox();
        expect(before).not.toBeNull();
        // Clicking the visible label must activate the associated switch.
        await credits
          .locator('label')
          .filter({ hasText: 'Free daily AI Credits' })
          .click();
        await expect(toggle).toBeDisabled();
        const during = await next.boundingBox();
        expect(during?.y).toBeCloseTo(before.y, 1);
        await expect(description).toHaveAttribute(
          'data-state',
          scale === 1 && width === 1280 ? 'granted' : 'enabled',
        );
        await expect(toggle).toBeEnabled();
        const after = await next.boundingBox();
        expect(after?.y).toBeCloseTo(before.y, 1);
        await expect(
          page.getByTestId('first-run-daily-credits-confirmation'),
        ).toHaveText(
          scale === 1 && width === 1280
            ? '7 free AI Credits added · refills daily'
            : 'Free daily AI Credits enabled.',
        );
        if (scale !== 2) {
          await toggle.click();
          await expect(toggle).toBeEnabled();
          await expect(toggle).toHaveAttribute('aria-checked', 'false');
        }
      }
      await window.evaluate(() => {
        document.documentElement.style.zoom = '';
      });
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
              .dailyCreditDripEnable ?? 0,
          { timeout: 30_000 },
        )
        .toBe(3);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      await launch.electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await page.getByTestId('first-run-import-choose-folder').click();
      const submit = page.getByTestId('first-run-import-submit');
      await expect(submit).toHaveText('Import 1 project', { timeout: 30_000 });
      await submit.click();

      await expect(page).toHaveCount(0, { timeout: 120_000 });
      await expect(homeComposer(window)).toBeVisible();
      await expect
        .poll(() =>
          readWorkspaces(userDataDir).some(
            (entry) => entry.name === folderName,
          ),
        )
        .toBe(true);
    } finally {
      try {
        if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
      } finally {
        await Promise.all(
          [key, authKey].map((scenarioKey) =>
            clearScenario(DEFAULT_MOCK_BASE_URL, scenarioKey).catch(
              () => undefined,
            ),
          ),
        );
      }
    }
  });

  test('an existing install lands on Home', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-first-run-'),
    );
    seedPreferences(userDataDir, ['v1']);
    const launch = await launchCanopy({ userDataDir });
    try {
      const window = await launch.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await expect(homeComposer(window)).toBeVisible({
        timeout: 30_000,
      });
      await expect(window.getByTestId('first-run-import-page')).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
});
