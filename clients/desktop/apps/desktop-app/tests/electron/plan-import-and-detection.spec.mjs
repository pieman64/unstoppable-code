import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedTrackedPlans, seedWorktreeChat } from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { buildTrackedPlan } from './seeders/trackedPlanFixtures.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  planDocumentPanel,
  planPanelId,
  stubOpenDialog,
} from './planPanelHarness.mjs';

// Plan Import + Detection — UI automation coverage for the plan import entry
// points, the import picker, and the global Plan Detection settings tab.
//
// Test 1: Settings → Plan Detection tab
//   Opens the global Plan Detection settings section, verifies the root tab
//   element is visible and both built-in inherited rows are present, then adds
//   a custom rule and confirms a custom-rule row appears and the empty state
//   disappears. B0 baseline (no seeding — settings panel is available on a
//   fresh launch).
//
// Test 2: Plans empty state and picker suggestions
//   Seeds a demo workspace with a chat tab and one detected plan file. Asserts
//   the empty Plans section explains plans and import, counts the suggestion
//   in a "found in chats" chip, and that the chip opens the picker with the
//   suggestion listed first and selected (no tabs). Hide moves it into the
//   collapsed hidden group.
//
// Test 3: A tracked file opens its plan
//   Seeds an imported plan whose source file is also a detected suggestion.
//   The card names its source file; the picker marks the row Tracked, and its
//   primary action opens the existing plan without importing a duplicate.
//
// Test 4: Browse imports a plan document and opens its Plan panel
//   Stubs the native open dialog (main's `dialog.showOpenDialog`) to return a
//   Markdown file written into the test data directory, clicks Import →
//   Browse, and asserts the modal closes and the new tracked plan opens in its
//   Plan panel titled with the document's heading (the import entry point opens
//   the Plan panel beside the worktree's chat, like the plan list does).
//
// Test 5: One-click chat notice, Enter, and the primary button
//   Seeds three plan files in the worktree and one unseen detection. The
//   Plans section loads detections on worktree select, so the chat notice
//   names the file; Track plan imports it without opening the picker and the
//   notice disappears. The picker then imports one file on Enter and another
//   through its primary button after a click only selected the row.
//
// Not automated: the chat notice appearing after a live turn. It renders once
//   the renderer's `triggerPlanDetectionScan` → `detected-plans:scan` round
//   trip completes, which is not deterministically observable through the E2E
//   harness. The Review N files picker path is covered by unit tests in:
//     apps/desktop-app/src/renderer/src/components/chat/__tests__/PlanDetectionBanner.test.tsx
//     packages/desktop-shared/src/__tests__/plan-detection-paths.test.ts
//     apps/desktop-app/src/main/__tests__/detected-plans-ipc.test.ts

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

test('settings plan-detection tab renders built-in rules and supports adding a custom rule', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();

    // Navigate to the Plan Detection section via the nav item.
    await app.openSettingsSection('plan-detection');

    // The root tab container must be visible.
    const tabRoot = window.getByTestId('settings-tab-plan-detection');
    await expect(tabRoot).toBeVisible();

    // The editor container is present inside the tab root.
    await expect(
      window.getByTestId('settings-plan-detection-editor'),
    ).toBeVisible();

    // Both built-in inherited rows render. The testid template is:
    //   `${dataTestIdPrefix}-inherited-${rule.id}`
    // Built-in rule ids (from BUILTIN_PLAN_DETECTION_RULES in
    // packages/desktop-shared/src/plan-detection.ts) are stable kebab-case:
    //   'superpowers-specs', 'superpowers-designs'.
    await expect(
      window.getByTestId('settings-plan-detection-inherited-superpowers-specs'),
    ).toBeVisible();
    await expect(
      window.getByTestId(
        'settings-plan-detection-inherited-superpowers-designs',
      ),
    ).toBeVisible();

    // The custom-rules empty state is present before adding any custom rule.
    await expect(
      window.getByTestId('settings-plan-detection-empty'),
    ).toBeVisible();

    // Add a custom rule: fill in the pattern field and click Add rule.
    const patternInput = window.getByTestId('settings-plan-detection-pattern');
    await expect(patternInput).toBeVisible();
    await patternInput.fill('docs/notes/*.md');

    // Optionally set a label so the rule is visually identifiable in the list.
    const labelInput = window.getByTestId('settings-plan-detection-label');
    await expect(labelInput).toBeVisible();
    await labelInput.fill('Notes');

    await window.getByTestId('settings-plan-detection-add').click();

    // A custom rule row appears. The testid is `settings-plan-detection-custom-<ruleId>`
    // where ruleId is generated (a UUID or random string). Match with a prefix
    // selector so we do not need to know the generated id.
    const customRow = window.locator(
      '[data-testid^="settings-plan-detection-custom-"]',
    );
    await expect(customRow).toHaveCount(1);
    await expect(customRow.first()).toContainText('docs/notes/*.md');

    // The empty state must no longer be visible after the rule was added.
    await expect(
      window.getByTestId('settings-plan-detection-empty'),
    ).toHaveCount(0);

    await app.closeSettings();
    await window.screenshot({
      path: testInfo.outputPath('settings-plan-detection.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

function seedDetectedPlans(userDataDir, entries) {
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'detected-plans',
      `${WORKTREE_ID}.json`,
    ),
    { version: 1, entries },
  );
}

function detectedEntry(id, sourceFilePath) {
  return {
    id,
    sourceRepoId: '__workspace_root__',
    sourceFilePath,
    status: 'detected',
    // Seen, so the chat notice stays out of the way of the activity panel.
    bannerSeen: true,
    detectedInChatId: 't1',
    detectedAt: '2026-10-20T10:00:00.000Z',
  };
}

test('plans empty state explains import and the picker lists chat suggestions first', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-plan-import-'),
  );

  // Seed a real git worktree (B3-lite: demo workspace, no dirty files needed).
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  // Seed an empty Claude chat tab so the worktree is ready for selection
  // without triggering any live agent activity.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  seedDetectedPlans(userDataDir, [
    detectedEntry('d1', 'docs/specs/billing-design.md'),
  ]);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount so the Plans section renders.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible({ timeout: 15_000 });
    const plansSection = window.getByTestId('activity-plans-section');
    await expect(plansSection).toBeVisible({ timeout: 15_000 });

    // With no plans, the section says where plans come from and what import
    // does, and counts the plan files agents wrote in chats.
    await expect(window.getByTestId('activity-plans-empty')).toContainText(
      'Plans your agent writes appear here. Import a Markdown plan',
    );
    const chip = window.getByTestId('activity-plans-suggestions-chip');
    await expect(chip).toHaveText('1 found in chats', { timeout: 15_000 });

    const importButton = window.getByTestId('activity-plans-import');
    await expect(importButton).toBeVisible({ timeout: 15_000 });
    await expect(importButton).toHaveAttribute('aria-label', 'Import plan');

    await window.screenshot({
      path: testInfo.outputPath('plans-empty-state.png'),
    });

    await chip.click();

    // The modal renders into a portal on document.body.
    const modal = window.getByTestId('import-plan-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    const searchInput = window.getByTestId('import-plan-input');
    await expect(searchInput).toBeFocused();
    await expect(window.getByTestId('import-plan-browse')).toBeVisible();
    await expect(window.getByTestId('import-plan-hint')).toBeVisible();

    // One list, no tabs: the chat suggestion leads and is selected.
    await expect(window.getByTestId('import-plan-tab-detected')).toHaveCount(0);
    const suggestionRow = window.getByTestId('import-plan-detected-import-d1');
    await expect(suggestionRow).toBeVisible();
    await expect(suggestionRow).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByTestId('import-plan-suggestions-group'),
    ).toContainText('From your chats');
    await expect(window.getByTestId('import-plan-primary')).toContainText(
      'Import plan',
    );

    await window.screenshot({
      path: testInfo.outputPath('import-picker-suggestions.png'),
    });

    // Hide moves the suggestion into the collapsed hidden group.
    await window.getByTestId('import-plan-detected-dismiss-d1').click();
    await expect(
      window.getByTestId('import-plan-dismissed-section'),
    ).toContainText('1 hidden');
    await expect(
      window.getByTestId('import-plan-suggestions-group'),
    ).toHaveCount(0);

    await searchInput.press('Escape');
    await expect(modal).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a file that is already a tracked plan opens it instead of importing again', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-plan-tracked-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  const trackedPath = 'docs/plans/billing-plan.md';
  seedDetectedPlans(userDataDir, [detectedEntry('d1', trackedPath)]);
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [
      {
        ...buildTrackedPlan({
          id: 'p1',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          title: 'Billing rollout plan',
          content: '# Billing rollout plan\n\nShip usage-based billing.',
          source: 'imported',
        }),
        sourceRepoId: '__workspace_root__',
        sourceFilePath: trackedPath,
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    // The imported plan's card names the file it was copied from.
    await expect(
      window.getByTestId('activity-plan-row-p1').getByTestId('plan-provenance'),
    ).toHaveText(`Imported · ${trackedPath}`, { timeout: 15_000 });

    await window.getByTestId('activity-plans-import').click();
    const modal = window.getByTestId('import-plan-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    const row = window.getByTestId('import-plan-detected-import-d1');
    await expect(row.getByTestId('import-plan-tracked-badge')).toHaveText(
      'Tracked',
    );
    const primary = window.getByTestId('import-plan-primary');
    await expect(primary).toContainText('Open plan');

    await primary.click();
    await expect(modal).toHaveCount(0, { timeout: 5_000 });
    await expect(planDocumentPanel(window, 'p1')).toBeVisible({
      timeout: 15_000,
    });
    // Opening never imports: the worktree still has its one plan.
    const plans = await window.evaluate(
      (request) => window.api.activity.plans.list(request),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(plans).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Browse imports a plan document and opens its Plan panel', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-plan-browse-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  const heading = 'Imported rollout plan';
  const planFile = path.join(userDataDir, 'imported-plan.md');
  writeFileSync(
    planFile,
    `# ${heading}\n\nShip the importer behind a flag.\n\n- Write the parser.\n`,
    'utf8',
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const importButton = window.getByTestId('activity-plans-import');
    await expect(importButton).toBeVisible({ timeout: 15_000 });
    await stubOpenDialog(electronApp, [planFile]);
    await importButton.click();
    const modal = window.getByTestId('import-plan-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await window.getByTestId('import-plan-browse').click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    // The worktree had no plans, so the import is its only tracked plan.
    let plans = [];
    await expect
      .poll(async () => {
        plans = await window.evaluate(
          (request) => window.api.activity.plans.list(request),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return plans.length;
      })
      .toBe(1);
    // The panel's tab carries the document's heading as the plan title; the
    // document below it starts after the title line.
    const planPanel = planDocumentPanel(window, plans[0].id);
    await expect(planPanel).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId(`panel-tab-${planPanelId(plans[0].id)}`),
    ).toContainText(heading);
    await expect(planPanel).toContainText('Ship the importer behind a flag.');
    await expect(planPanel).toContainText('Write the parser.');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the chat notice tracks one file in one click and the picker imports on Enter or its button', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-plan-track-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seeded.workspaces[0].worktreePath;
  mkdirSync(path.join(worktreePath, 'docs', 'plans'), { recursive: true });
  const planFiles = {
    'docs/plans/launch-plan.md': 'Launch plan',
    'docs/plans/enter-plan.md': 'Enter plan',
    'docs/plans/button-plan.md': 'Button plan',
  };
  for (const [relativePath, heading] of Object.entries(planFiles)) {
    writeFileSync(
      path.join(worktreePath, relativePath),
      `# ${heading}\n\nShip it.\n`,
      'utf8',
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  // Unseen, so the chat notice offers the file.
  seedDetectedPlans(userDataDir, [
    {
      ...detectedEntry('d1', 'docs/plans/launch-plan.md'),
      bannerSeen: false,
    },
  ]);

  const listPlans = (window) =>
    window.evaluate((request) => window.api.activity.plans.list(request), {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
    });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    // One pending file: the notice names it and imports it in place.
    const banner = window.getByTestId('plan-detection-banner');
    await expect(banner).toContainText('Track launch-plan.md as a plan?', {
      timeout: 15_000,
    });
    const track = window.getByTestId('plan-detection-banner-import');
    await expect(track).toHaveText('Track plan');
    await track.click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(window.getByTestId('import-plan-modal')).toHaveCount(0);
    let plans = [];
    await expect
      .poll(async () => {
        plans = await listPlans(window);
        return plans.length;
      })
      .toBe(1);
    expect(plans[0]).toMatchObject({
      source: 'imported',
      sourceFilePath: 'docs/plans/launch-plan.md',
    });
    await expect(planDocumentPanel(window, plans[0].id)).toBeVisible({
      timeout: 15_000,
    });

    const modal = window.getByTestId('import-plan-modal');
    const searchInput = window.getByTestId('import-plan-input');
    const importFile = async (query, trigger) => {
      // Each import opens its plan beside the chat, which collapses the
      // activity rail; reopen it to reach the Plans header.
      await expandDefaultActivityRail(window);
      await window.getByTestId('activity-plans-import').click();
      await expect(modal).toBeVisible({ timeout: 5_000 });
      await searchInput.fill(query);
      const rows = window.getByTestId('import-plan-result');
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
      await trigger();
      await expect(modal).toHaveCount(0, { timeout: 15_000 });
    };

    // Enter imports the selected row.
    await importFile('enter-plan', () => searchInput.press('Enter'));
    await expect.poll(async () => (await listPlans(window)).length).toBe(2);

    // So does the primary button; a single click on a row only selects it.
    await importFile('button-plan', async () => {
      await window.getByTestId('import-plan-result').first().click();
      await expect(modal).toBeVisible();
      await window.getByTestId('import-plan-primary').click();
    });
    plans = await listPlans(window);
    expect(plans.map((plan) => plan.sourceFilePath).sort()).toEqual([
      'docs/plans/button-plan.md',
      'docs/plans/enter-plan.md',
      'docs/plans/launch-plan.md',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
