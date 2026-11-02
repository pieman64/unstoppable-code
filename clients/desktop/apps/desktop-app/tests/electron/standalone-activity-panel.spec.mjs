import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Task 6 — standalone `activity-card` panel fill layout.
//
// Earlier tasks reworked `PanelSection` (`components/shared/panel-section/
// PanelSection.tsx`) so that under the `'frameless'` chrome — the standalone
// `activity-card` panel opened via the add-tab menu's per-section entries
// (`panel-add-menu-item-activity-card-<sectionId>`, see
// `worktree-panels-tabs.spec.mjs`) — the section's header row renders as a
// shrink-0 `frameless-section-header` and its content as a `flex-1`
// `frameless-section-body` that owns the scroll region, instead of the card
// chrome + collapse UX used in the stacked ActivityPanel. `PlansSection` /
// `PipelineRunsSection` additionally give their primary list (`plans-primary-
// list` / `pipeline-runs-primary-list`) a `flex-1` class in frameless mode so
// it fills the available height instead of the stacked view's `max-h-[...]`
// cap.
//
// This spec proves both contracts against the real panel grid:
//   1. Open the Changed Files section as its own `activity-card` panel in a
//      worktree seeded with local changes; scroll the frameless body to the
//      bottom and assert the pinned header stays visible (it must never be
//      inside the scrolling region).
//   2. Open the Pipeline Runs section as a second `activity-card` panel,
//      seeded with one persisted execution so `pipeline-runs-primary-list`
//      actually renders (the list markup is conditional on a non-empty run
//      list), and assert it carries the `flex-1` fill class.
//
// Two-phase seeding (harness primitive H4, see `diff-viewer.spec.mjs` and
// `pipeline-runs.spec.mjs`):
//   1. seedDemoWorkspaces({ apps: ['ts-pnpm-vite'] }) — workspace
//      `demo-ts-pnpm-vite`, worktree branch `demo-main`.
//   2. Dirty the checked-out worktree (README.md modification + an untracked
//      file) before launch so Changed Files has real content, and
//      seedPipelineExecution a single completed run for the same
//      workspace/worktree ids so Pipeline Runs has a non-empty primary list.
//
// Determinism: no live agents, no network, no PTY. Changed files load from a
// local `git status` against the seeded checkout; the pipeline run loads from
// a seeded `pipeline-executions/*.json` file — no live executor involved.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const MODIFIED_FILE = 'README.md';
const MODIFIED_MARKER =
  'CANOPY E2E standalone-activity-panel modification line';
const UNTRACKED_FILE = 'CANOPY_E2E_STANDALONE_ACTIVITY.txt';

test('standalone activity-card panel pins its header while the body scrolls, and the primary list fills', async ({}, testInfo) => {
  // Phase 1: seed the demo workspace into a temp data dir.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-standalone-activity-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  // Phase 2: dirty the worktree checkout before launch so Changed Files has
  // content, and seed one persisted pipeline execution so Pipeline Runs has a
  // non-empty primary list.
  const modifiedPath = path.join(worktreePath, MODIFIED_FILE);
  const originalReadme = readFileSync(modifiedPath, 'utf8');
  expect(
    originalReadme.length,
    'seeded README.md should exist and be non-empty',
  ).toBeGreaterThan(0);
  appendFileSync(modifiedPath, `\n${MODIFIED_MARKER}\n`, 'utf8');
  writeFileSync(
    path.join(worktreePath, UNTRACKED_FILE),
    'untracked file added by the standalone-activity-panel e2e seed\n',
    'utf8',
  );

  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'e2e-standalone-activity-1',
      pipelineName: 'E2E Standalone Activity Pipeline',
    },
  });

  const memoryDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'memory',
  );
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    '# Project memory\n\n- Workspace memory fixture.\n',
  );
  mkdirSync(path.join(userDataDir, 'memory'), { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'memory', 'MEMORY.md'),
    '# User memory\n\n- Private user fixture.\n',
  );

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    // The activity panel (the stacked `activity-section` singleton) renders
    // once the worktree is selected; wait for it before touching the add-tab
    // menu, which reads the same worktree layout family.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    const activityMemory = window
      .getByTestId('panel-content-activity-section')
      .getByTestId('memory-explorer-workspace');
    await activityMemory.scrollIntoViewIfNeeded();
    // The panel lists this project's memories and those saved for every
    // project.
    await expect(activityMemory).toContainText('Workspace memory fixture.');
    await expect(activityMemory).toContainText('Private user fixture.');

    // --- Open Changed Files as a standalone activity-card panel -----------
    const addMenu = window.getByTestId('panel-add-menu');

    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(addMenu).toBeVisible();
    await window
      .getByTestId('panel-add-menu-item-activity-card-changed-files')
      .click();
    await expect(addMenu).toBeHidden();

    const changedFilesCard = window.getByTestId(
      'activity-card-section-changed-files',
    );
    await expect(changedFilesCard).toBeVisible();

    // Changed files load asynchronously on selection
    // (refreshSelectedChangedFiles → activity.getChangedFiles); poll until
    // the seeded modification is listed so the frameless body actually has
    // content to scroll.
    await expect
      .poll(async () => changedFilesCard.innerText(), {
        timeout: 20_000,
        message: 'changed-files card should list the seeded changes',
      })
      .toContain(MODIFIED_FILE);

    const changedFilesHeader = changedFilesCard.getByTestId(
      'frameless-section-header',
    );
    const changedFilesBody = changedFilesCard.getByTestId(
      'frameless-section-body',
    );
    await expect(changedFilesHeader).toBeVisible();
    await expect(changedFilesBody).toBeVisible();

    await changedFilesBody.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // The pinned header must not be part of the scrolling region.
    await expect(changedFilesHeader).toBeVisible();

    // --- Open Pipeline Runs as a second standalone activity-card panel ----
    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(addMenu).toBeVisible();
    await window
      .getByTestId('panel-add-menu-item-activity-card-pipeline-runs')
      .click();
    await expect(addMenu).toBeHidden();

    const pipelineRunsCard = window.getByTestId(
      'activity-card-section-pipeline-runs',
    );
    await expect(pipelineRunsCard).toBeVisible();
    await expect(
      pipelineRunsCard.getByTestId('frameless-section-header'),
    ).toBeVisible();

    const primaryList = pipelineRunsCard.getByTestId(
      'pipeline-runs-primary-list',
    );
    await expect(primaryList).toBeVisible({ timeout: 20_000 });
    await expect(primaryList).toHaveClass(/flex-1/);

    await window.getByTestId('panel-add-tab-group-chat').click();
    const memoryEntry = addMenu.getByTestId(
      'panel-add-menu-item-activity-card-memory',
    );
    await expect(memoryEntry).toBeVisible();
    await expect(
      addMenu
        .getByTestId('panel-add-menu-activity-group')
        .getByRole('menuitem', { name: 'Memory', exact: true }),
    ).toHaveCount(0);
    await memoryEntry.click();
    const memoryPanel = window.getByTestId('activity-card-section-memory');
    await expect(memoryPanel).toBeVisible();
    await expect(
      memoryPanel.getByTestId('workspace-memory-section'),
    ).toBeVisible();
    await expect(
      memoryPanel.getByTestId('frameless-section-body'),
    ).toBeVisible();
    const explorer = memoryPanel.getByTestId('memory-explorer-workspace');
    await expect(explorer).toContainText('Workspace memory fixture.');
    await expect(explorer).toContainText('Private user fixture.');
    await explorer
      .locator('[data-testid="memory-row"][data-scope="workspace"]')
      .getByTestId('memory-row-open')
      .click();
    await expect(explorer.getByTestId('memory-detail-facts')).toContainText(
      'Saved for',
    );
    await explorer.getByTestId('memory-detail-edit').click();
    await expect(explorer.getByTestId('memory-item-draft')).toHaveValue(
      '- Workspace memory fixture.',
    );
    await explorer
      .getByTestId('memory-item-draft')
      .fill('- Updated workspace memory.');
    await explorer.getByTestId('memory-item-save').click();
    await expect(explorer.getByTestId('memory-detail-body')).toContainText(
      'Updated workspace memory.',
    );
    await expect(activityMemory).toContainText('Updated workspace memory.');
    expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toContain(
      'Updated workspace memory.',
    );
    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(
      addMenu.getByTestId('panel-add-menu-item-activity-card-memory'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    await window.screenshot({
      path: testInfo.outputPath('standalone-activity-panel.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
