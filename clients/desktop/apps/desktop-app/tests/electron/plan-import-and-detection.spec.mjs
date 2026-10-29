import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  planDocumentPanel,
  planPanelId,
  stubOpenDialog,
} from './planPanelHarness.mjs';

// Plan Import + Detection — UI automation coverage for the plan import button,
// the Detected tab in the import modal, and the global Plan Detection settings
// tab.
//
// Test 1: Settings → Plan Detection tab
//   Opens the global Plan Detection settings section, verifies the root tab
//   element is visible and both built-in inherited rows are present, then adds
//   a custom rule and confirms a custom-rule row appears and the empty state
//   disappears. B0 baseline (no seeding — settings panel is available on a
//   fresh launch).
//
// Test 2: Plans activity section Import button presence + Detected tab renders
//   Seeds a demo workspace with a Claude chat tab, selects the worktree,
//   expands the activity panel, and asserts `activity-plans-import` is visible
//   inside the Plans section. Clicks Import and confirms the modal opens on the
//   Search tab by default, then clicks `import-plan-tab-detected` and asserts
//   the Detected tab content renders (empty state is acceptable — no detected
//   plans are seeded for this test).
//
// Test 3: Browse imports a plan document and opens its Plan panel
//   Stubs the native open dialog (main's `dialog.showOpenDialog`) to return a
//   Markdown file written into the test data directory, clicks Import →
//   Browse, and asserts the modal closes and the new tracked plan opens in its
//   Plan panel titled with the document's heading (the import entry point opens
//   the Plan panel beside the worktree's chat, like the plan list does).
//
// Not automated: Import modal opens on Detected tab when opened via the banner
//   Seeding a chat tab whose active turn contains a `tool_use` block referencing
//   a plan-rule-matching path AND asserting the `plan-detection-banner` renders
//   would require the renderer to run `triggerPlanDetectionScan` on load and for
//   the IPC scan to complete synchronously before the assertion. That execution
//   path is reliable in unit tests but not deterministically observable through
//   the E2E harness in the time budget available. Banner-trigger behaviour and
//   the `initialTab: 'detected'` modal open path are therefore covered by unit
//   tests in:
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

test('plans activity section shows import button and Detected tab renders', async ({}, testInfo) => {
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

  // Note: the plan-detection banner (`plan-detection-banner`) appears above the
  // chat input when a completed assistant turn contains tool_use args or text
  // that match a plan-detection rule. Asserting the banner here would require
  // the renderer's `triggerPlanDetectionScan` → IPC `detected-plans:scan` round
  // trip to complete within the test budget, which is not reliably achievable
  // without live agent involvement. That trigger path is covered by:
  //   packages/desktop-shared/src/__tests__/plan-detection-paths.test.ts
  //   apps/desktop-app/src/main/__tests__/detected-plans-ipc.test.ts
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Select the seeded worktree.
    await app.selectWorktree(WORKTREE_BRANCH);

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount so the Plans section renders.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible({ timeout: 15_000 });

    // The Plans section must render inside the activity panel.
    const plansSection = window.getByTestId('activity-plans-section');
    await expect(plansSection).toBeVisible({ timeout: 15_000 });

    // The Import button must be visible inside the Plans section header.
    // It renders whenever a worktree is selected (see PlansSection.tsx:
    // `importAction` is defined when `selectedWorktree` is truthy).
    const importButton = window.getByTestId('activity-plans-import');
    await expect(importButton).toBeVisible({ timeout: 15_000 });
    await expect(importButton).toBeEnabled();

    // Click the Import button — the in-app import modal should appear.
    await importButton.click();

    // The modal renders into a portal on document.body.
    const modal = window.getByTestId('import-plan-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The Search tab is active by default: hint block and search input visible.
    await expect(window.getByTestId('import-plan-hint')).toBeVisible();
    const searchInput = window.getByTestId('import-plan-input');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused();

    // The Browse button (native OS picker; test 3 drives it through a stubbed
    // dialog) must be present.
    await expect(window.getByTestId('import-plan-browse')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('import-modal-search-tab.png'),
    });

    // Switch to the Detected tab and assert it renders.
    // Empty state is acceptable — no detected plans are seeded for this test;
    // the important thing is the tab button exists and the tab panel renders
    // without an error.
    const detectedTabButton = window.getByTestId('import-plan-tab-detected');
    await expect(detectedTabButton).toBeVisible();
    await detectedTabButton.click();

    // After clicking Detected, the search input must no longer be visible
    // (the tab has switched). The tab button itself remains visible.
    await expect(searchInput).toBeHidden();
    await expect(detectedTabButton).toBeVisible();

    // The Detected tab renders its content panel. With no seeded detections
    // the empty-state message is shown.
    await expect(modal).toContainText('No plan files detected');

    await window.screenshot({
      path: testInfo.outputPath('import-modal-detected-tab.png'),
    });
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
