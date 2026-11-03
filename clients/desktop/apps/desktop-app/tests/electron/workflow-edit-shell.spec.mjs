// CAN-4072 — the Workflows edit shell across surfaces.
//
// Automations and pipelines open in one full-page shell with Definition,
// Trigger and Runs sections. The retargeted feature specs cover each
// adapter's own flows; this spec covers what crosses them:
//   1. A pipeline's Trigger section opens an automation that runs it, and
//      Back walks the two-level `returnTo` chain: automation → the pipeline's
//      Trigger section → Library, or → the Marketplace search the pipeline
//      was opened from.
//   2. A pipeline run's "Definition used" entry shows the definition the run
//      recorded, beside "Open current definition ↗".
//   3. A popped-out Automations panel opens an automation's Runs section in
//      the main window's shell and asks the main window to come forward.
//   4. Window close and app quit with unsaved edits ask in the renderer:
//      close + Discard closes the window; quit + Save saves, then quits.
//   5. History Back into a shell entry whose automation was deleted shows the
//      shell's not-found state.
//   6. Pipeline automation destinations (CAN-4550): a new workflow defaults
//      to No project and round-trips with a `scope: global` pipeline; a
//      legacy pipeline automation keeps its project and saves without a
//      `target`; a task destination whose task was removed is refused when
//      it runs.
//
// Every test leaves the shell clean (`discardWorkflowEditIfOpen`) before
// teardown so the quit prompt never holds the app open.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  deleteFromWorkflowEdit,
  discardWorkflowEditIfOpen,
  openWorkflowEditSection,
  saveWorkflowEdit,
  workflowEditTarget,
} from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  seedPanelWorktree,
  SEEDED_CHAT_TAB_ID,
} from './panelHarness.mjs';
import { expectPipelineRunPanel, showPipelineJobList } from './pipelineUi.mjs';
import {
  seedAutomations,
  seedPipelineExecution,
  seedStoredPipeline,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

const PIPELINE_ID = 'shell-trigger-pipeline';
const PIPELINE_NAME = 'Shell Trigger Pipeline';
const PIPELINE_AUTOMATION_ID = 'shell-pipeline-automation';
const PROMPT_AUTOMATION_ID = 'shell-prompt-automation';
const PROMPT_AUTOMATION_NAME = 'Shell prompt automation';

function promptAutomation(overrides = {}) {
  return {
    version: 1,
    id: PROMPT_AUTOMATION_ID,
    name: PROMPT_AUTOMATION_NAME,
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'worktree_prompt',
      workspaceId: WORKSPACE_ID,
      existingWorktreeId: WORKTREE_ID,
      prompt: 'Summarize the branch.',
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function seedDemo(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  return userDataDir;
}

function persistedActivity(userDataDir, activityId) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  return file.activities.find((activity) => activity.id === activityId);
}

/** The main BrowserWindow, found by its renderer URL. */
async function mainBrowserWindowState(electronApp, url) {
  return electronApp.evaluate(({ BrowserWindow }, mainUrl) => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() && candidate.webContents.getURL() === mainUrl,
    );
    return win ? { open: true } : { open: false };
  }, url);
}

/** Opens the seeded prompt automation from the Library and edits its name. */
async function editPromptAutomationName(window, nextName) {
  const app = new CanopyAppDriver(window);
  await app.openAutomationsPage();
  await app.openWorkflowsLibraryRow(
    app.workflowsLibraryAutomationRow(PROMPT_AUTOMATION_ID),
  );
  const shell = window.getByTestId('workflow-edit-shell');
  await expect(shell).toHaveAttribute('data-kind', 'automation');
  await shell
    .getByTestId('workflow-edit-section-definition')
    .getByTestId('automations-form-name')
    .fill(nextName);
  await expect(shell).toHaveAttribute('data-dirty', 'true');
  return shell;
}

test('a pipeline Trigger row opens its automation, and Back walks back through the pipeline to the Library', async () => {
  const userDataDir = seedDemo('canopy-can4072-trigger-');
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo trigger',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: PIPELINE_AUTOMATION_ID,
        name: 'Nightly shell pipeline',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: WORKSPACE_ID,
          pipelineId: PIPELINE_ID,
          pipelineSource: 'user',
          pipelineName: PIPELINE_NAME,
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(PIPELINE_ID),
    );

    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    const trigger = await openWorkflowEditSection(window, 'trigger');
    const row = trigger.locator(
      `[data-testid="pipeline-trigger-automation"][data-activity-id="${PIPELINE_AUTOMATION_ID}"]`,
    );
    await expect(row).toContainText('Nightly shell pipeline');
    await row.click();

    // The automation opens in the same shell; its Back names the pipeline.
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    await expect(shell).toHaveAttribute('aria-label', 'Nightly shell pipeline');
    await expect(shell.getByTestId('workflow-edit-back')).toHaveText(
      'Workflow',
    );
    expect(await workflowEditTarget(window)).toMatchObject({
      kind: 'automation',
      activityId: PIPELINE_AUTOMATION_ID,
      returnTo: {
        kind: 'pipeline',
        pipelineId: PIPELINE_ID,
        section: 'trigger',
      },
    });

    // Back returns to the pipeline, on the Trigger section it came from.
    await backFromWorkflowEdit(window);
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(
      shell.getByTestId('workflow-edit-tab-trigger'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      shell
        .getByTestId('workflow-edit-section-trigger')
        .getByTestId('pipeline-trigger-automation'),
    ).toBeVisible();

    // Back again leaves the chain for the Library.
    await backFromWorkflowEdit(window);
    await expect(shell).toBeHidden();
    await expect(window.getByTestId('page-workflows-library')).toBeVisible();
    expect(await workflowEditTarget(window)).toBeNull();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a pipeline Trigger lists what starts it: its triggers, the hooks that run it, and its automations', async () => {
  const userDataDir = seedDemo('canopy-can4072-trigger-sources-');
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on:',
      '  dispatch: {}',
      '  plan_ready: {}',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo trigger',
      '',
    ].join('\n'),
  });
  // A project hook that runs the pipeline, and one that only runs a command.
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.hooks = {
    'pr:merged': [{ type: 'pipeline', source: 'local', id: PIPELINE_ID }],
    'pr:create': [{ type: 'command', command: 'true' }],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(PIPELINE_ID),
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    let trigger = await openWorkflowEditSection(window, 'trigger');

    const start = (kind) =>
      trigger.locator(
        `[data-testid="pipeline-trigger-start"][data-trigger="${kind}"]`,
      );
    await expect(start('manual')).toHaveAttribute('data-on', 'true');
    await expect(start('plan-approved')).toHaveAttribute('data-on', 'true');
    await expect(start('task-ready')).toHaveAttribute('data-on', 'false');
    const hooks = trigger.getByTestId('pipeline-trigger-hook');
    await expect(hooks).toHaveCount(1);
    await expect(hooks).toContainText('PR Merged');
    await expect(
      trigger.getByTestId('pipeline-trigger-automations-empty'),
    ).toHaveText('No automations run this workflow.');

    // Edit opens the declared triggers in Definition's settings.
    await trigger.getByTestId('pipeline-trigger-edit-starts').click();
    await expect(
      shell.getByTestId('workflow-edit-tab-definition'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      shell.getByTestId('pipeline-trigger-row-dispatch'),
    ).toBeVisible();

    // A hook opens its project's hook settings.
    trigger = await openWorkflowEditSection(window, 'trigger');
    await trigger.getByTestId('pipeline-trigger-hook').click();
    const settings = window.getByRole('dialog', {
      name: 'TypeScript pnpm Vite',
    });
    await expect(settings).toBeVisible();
    await expect(
      settings.getByTestId('project-settings-nav-scripts'),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      settings.getByTestId('project-settings-hook-pr:merged'),
    ).toBeVisible();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a pipeline and an automation open at the Library width, so switching never shifts the page', async () => {
  const userDataDir = seedDemo('canopy-can4072-shell-width-');
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo width',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: PROMPT_AUTOMATION_ID,
        name: PROMPT_AUTOMATION_NAME,
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          workspaceId: WORKSPACE_ID,
          prompt: 'Summarize the branch.',
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Wide enough that a full-width page would outgrow the Library's.
    await window.setViewportSize({ width: 1800, height: 1000 });
    await app.openPipelinesPage();
    const libraryWidth = await window
      .getByTestId('workflows-library-table')
      .evaluate((element) => element.getBoundingClientRect().width);
    const shell = window.getByTestId('workflow-edit-shell');
    // Where the shell sits and where its section starts, so neither the
    // width, the left edge nor the content's top moves between kinds.
    const shellGeometry = () =>
      shell.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const panel = element.querySelector('[role="tabpanel"]');
        return {
          left: box.left,
          width: box.width,
          panelTop: panel ? panel.getBoundingClientRect().top : -1,
        };
      });

    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(PIPELINE_ID),
    );
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    const pipeline = await shellGeometry();
    await backFromWorkflowEdit(window);

    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(PROMPT_AUTOMATION_ID),
    );
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    const automation = await shellGeometry();

    expect(Math.abs(pipeline.width - automation.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(pipeline.width - libraryWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(pipeline.left - automation.left)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(pipeline.panelTop - automation.panelTop),
    ).toBeLessThanOrEqual(1);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Back from a Trigger row walks automation → pipeline → the Marketplace search the pipeline was opened from', async () => {
  const userDataDir = seedDemo('canopy-can4072-trigger-marketplace-');
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo trigger',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: PIPELINE_AUTOMATION_ID,
        name: 'Nightly shell pipeline',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: WORKSPACE_ID,
          pipelineId: PIPELINE_ID,
          pipelineSource: 'user',
          pipelineName: PIPELINE_NAME,
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Load the Library once so the pipeline and automation stores hydrate.
    await app.openPipelinesPage();
    await expect(app.workflowsLibraryPipelineRow(PIPELINE_ID)).toBeVisible();

    // Open the pipeline the way a Marketplace search result does: with the
    // search to return to.
    await window.evaluate(
      ({ pipelineId }) =>
        window.__canopyNavigationTestApi.openWorkflowEdit({
          kind: 'pipeline',
          pipelineId,
          source: 'user',
          returnToMarketplace: { query: 'Shell Trigger', tab: 'pipeline' },
        }),
      { pipelineId: PIPELINE_ID },
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(shell.getByTestId('pipeline-editor-back')).toHaveText(
      'Customize',
    );

    const trigger = await openWorkflowEditSection(window, 'trigger');
    await trigger
      .locator(
        `[data-testid="pipeline-trigger-automation"][data-activity-id="${PIPELINE_AUTOMATION_ID}"]`,
      )
      .click();
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    await expect(shell.getByTestId('workflow-edit-back')).toHaveText(
      'Workflow',
    );

    // First Back: the pipeline, on its Trigger section, still returning to
    // the Marketplace.
    await backFromWorkflowEdit(window);
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(
      shell.getByTestId('workflow-edit-tab-trigger'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByTestId('pipeline-editor-back')).toHaveText(
      'Customize',
    );

    // Second Back: the Marketplace search the pipeline came from.
    await backFromWorkflowEdit(window);
    await expect(shell).toBeHidden();
    await app.expectPluginsPage();
    await expect(window.getByTestId('plugins-search')).toHaveValue(
      'Shell Trigger',
    );
    expect(await workflowEditTarget(window)).toBeNull();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a pipeline run shows the definition it recorded under "Definition used"', async () => {
  const executionId = 'can4072-definition-used';
  const userDataDir = seedDemo('canopy-can4072-definition-used-');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: executionId,
      pipelineName: 'Recorded Pipeline',
      status: 'success',
      completedAt: '2026-04-10T12:01:00.000Z',
      jobs: [
        {
          id: 'recorded-build',
          name: 'Recorded build job',
          steps: [{ id: 'compile', name: 'Compile', run: 'npm run build' }],
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    const card = window.getByTestId(`pipeline-run-card-${executionId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The card's top-left avoids its action buttons (see pipeline-runs).
    await card.click({ position: { x: 10, y: 10 } });
    const panel = await expectPipelineRunPanel(window, executionId);
    const nav = await showPipelineJobList(panel);

    await expect(
      nav.getByTestId('pipeline-details-open-definition'),
    ).toHaveText('Open current definition ↗');
    const definitionEntry = nav.getByTestId('pipeline-job-list-definition');
    await expect(definitionEntry).toHaveText(/Definition used/);
    await definitionEntry.click();
    await expect(definitionEntry).toHaveAttribute('aria-current', 'true');

    const definitionUsed = panel.getByTestId('pipeline-run-definition-used');
    await expect(definitionUsed).toBeVisible();
    await expect(definitionUsed).toContainText('Recorded build job');
    await expect(
      definitionUsed.getByTestId('pipeline-run-definition-used-not-recorded'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a popped-out Automations panel opens the Runs section in the main window', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedDemo('canopy-can4072-panel-');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
  });
  seedAutomations({ userDataDir, activities: [promptAutomation()] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  try {
    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await window.getByTestId('panel-add-menu-automations-submenu').click();
    await window.getByTestId('panel-add-menu-item-automations-full').click();
    await expect(
      window.locator('[data-testid="automations-panel"][data-variant="full"]'),
    ).toBeVisible();

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const aux = await auxWindowPromise;
    const auxPanel = aux.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    await expect(auxPanel).toBeVisible();

    // Headless windows are hidden, so OS focus is not observable; count the
    // main window's focus requests instead.
    await window.evaluate(() => {
      const original = window.focus.bind(window);
      window.__can4072FocusRequests = 0;
      window.focus = () => {
        window.__can4072FocusRequests += 1;
        original();
      };
    });

    await auxPanel
      .getByTestId(
        `automations-panel-overview-automation-${PROMPT_AUTOMATION_ID}`,
      )
      .click();
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('aria-label', PROMPT_AUTOMATION_NAME);
    await expect(shell.getByTestId('workflow-edit-tab-runs')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      shell
        .getByTestId('workflow-edit-section-runs')
        .getByTestId('automation-runs-section'),
    ).toBeVisible();
    await expect(aux.getByTestId('workflow-edit-shell')).toHaveCount(0);
    await expect
      .poll(() => window.evaluate(() => window.__can4072FocusRequests))
      .toBe(1);
    expect(await workflowEditTarget(window)).toMatchObject({
      kind: 'automation',
      activityId: PROMPT_AUTOMATION_ID,
      section: 'runs',
    });

    await backFromWorkflowEdit(window);
    await expect(shell).toBeHidden();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing the window with unsaved edits asks first, and Discard lets it close', async () => {
  const userDataDir = seedDemo('canopy-can4072-close-');
  seedAutomations({ userDataDir, activities: [promptAutomation()] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await editPromptAutomationName(window, 'Unsaved close edit');
    const mainUrl = window.url();

    // Drive the close the way the OS does: through the BrowserWindow.
    await electronApp.evaluate(({ BrowserWindow }, url) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL() === url)
        ?.close();
    }, mainUrl);

    const dialog = window.getByTestId('workflows-unsaved-dialog');
    await expect(dialog).toBeVisible();
    expect(await mainBrowserWindowState(electronApp, mainUrl)).toEqual({
      open: true,
    });
    expect(window.isClosed()).toBe(false);

    await window.getByTestId('workflows-unsaved-discard').click();
    await expect.poll(() => window.isClosed(), { timeout: 15_000 }).toBe(true);
    expect(persistedActivity(userDataDir, PROMPT_AUTOMATION_ID).name).toBe(
      PROMPT_AUTOMATION_NAME,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('quitting with unsaved edits asks first, and Save saves before the app quits', async () => {
  const userDataDir = seedDemo('canopy-can4072-quit-');
  seedAutomations({ userDataDir, activities: [promptAutomation()] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await editPromptAutomationName(window, 'Saved on quit');

    await captureDaemonDryRunEvidence(electronApp);
    const closed = electronApp.waitForEvent('close', { timeout: 60_000 });
    await electronApp.evaluate(({ app: electronAppModule }) => {
      electronAppModule.quit();
    });

    const dialog = window.getByTestId('workflows-unsaved-dialog');
    await expect(dialog).toBeVisible();
    expect(window.isClosed()).toBe(false);

    await window.getByTestId('workflows-unsaved-save').click();
    await closed;
    expect(persistedActivity(userDataDir, PROMPT_AUTOMATION_ID).name).toBe(
      'Saved on quit',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('history Back into the edit shell of a deleted automation shows not found', async () => {
  const userDataDir = seedDemo('canopy-can4072-not-found-');
  seedAutomations({ userDataDir, activities: [promptAutomation()] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const row = app.workflowsLibraryAutomationRow(PROMPT_AUTOMATION_ID);
    await app.openWorkflowsLibraryRow(row);
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('aria-label', PROMPT_AUTOMATION_NAME);

    // Delete confirms in a dialog, then leaves for the Library without
    // asking about unsaved edits.
    await deleteFromWorkflowEdit(window, 'automation-details-delete');
    await expect(shell).toBeHidden();
    await expect(row).toHaveCount(0);

    // The history entry for the shell still exists; its item does not.
    await window.getByTestId('nav-history-back').click();
    const notFound = window.getByTestId('workflow-edit-not-found');
    await expect(notFound).toBeVisible();
    await expect(notFound).toHaveAttribute('data-loading', 'false');
    await expect(notFound).toContainText('This automation no longer exists.');
    await expect(shell).toHaveCount(0);

    // Forward and Back again land on the same states.
    await window.getByTestId('nav-history-forward').click();
    await expect(notFound).toBeHidden();
    await expect(window.getByTestId('page-workflows-library')).toBeVisible();
    await window.getByTestId('nav-history-back').click();
    await expect(notFound).toBeVisible();

    await notFound.getByTestId('workflow-edit-back').click();
    await expect(notFound).toBeHidden();
    await expect(window.getByTestId('page-workflows-library')).toBeVisible();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

const GLOBAL_PIPELINE_ID = 'shell-global-pipeline';
const GLOBAL_PIPELINE_NAME = 'Shell Global Pipeline';
const TASK_MISSING_ERROR =
  'This task is no longer available. Choose another task.';

/** A stored user pipeline that can run with no project. */
function seedGlobalPipeline(userDataDir) {
  seedStoredPipeline({
    userDataDir,
    id: GLOBAL_PIPELINE_ID,
    name: GLOBAL_PIPELINE_NAME,
    yaml: [
      `name: ${GLOBAL_PIPELINE_NAME}`,
      'on: dispatch',
      'scope: global',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo global',
      '',
    ].join('\n'),
  });
}

/** A stored user pipeline that runs in a project. */
function seedProjectPipeline(userDataDir) {
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo project',
      '',
    ].join('\n'),
  });
}

function pipelineAutomation(action, overrides = {}) {
  return {
    version: 1,
    id: PIPELINE_AUTOMATION_ID,
    name: 'Nightly shell pipeline',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      pipelineId: PIPELINE_ID,
      pipelineSource: 'user',
      pipelineName: PIPELINE_NAME,
      ...action,
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

test('a new workflow defaults to No project, saves a global pipeline, and reopens as No project', async () => {
  const userDataDir = seedDemo('canopy-can4550-global-');
  seedGlobalPipeline(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    await app.startNewWorkflow('schedule');
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    const definition = shell.getByTestId('workflow-edit-section-definition');
    await expect(definition).toBeVisible();

    // An unseeded workflow starts as a pipeline with no project, owned by
    // the workflow's owner, and asks for no project.
    await expect(
      definition.getByTestId('automations-form-action-type-global'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      definition.getByTestId('automations-form-global-owner'),
    ).toContainText('Owner: Personal');
    await expect(
      definition.getByTestId('automations-form-workspace'),
    ).toHaveCount(0);
    await expect(
      definition.getByTestId('automations-form-pipeline-run-in'),
    ).toHaveCount(0);

    await definition
      .getByTestId('automations-form-name')
      .fill('Global shell report');
    const pickPipeline = definition.getByTestId('automations-form-pipeline');
    await expect(pickPipeline).toBeEnabled();
    await pickPipeline.click();
    const modal = window.getByTestId('pipeline-trigger-modal-body');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: GLOBAL_PIPELINE_NAME }).click();
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(modal).toBeHidden();
    await expect(definition).toContainText(GLOBAL_PIPELINE_NAME);

    await saveWorkflowEdit(window);
    const target = await workflowEditTarget(window);
    expect(target?.kind).toBe('automation');
    const activityId = target.activityId;
    const saved = persistedActivity(userDataDir, activityId);
    expect(saved.action).toMatchObject({
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: GLOBAL_PIPELINE_ID,
      pipelineSource: 'user',
    });
    expect(saved.action).not.toHaveProperty('workspaceId');
    expect(saved.action).not.toHaveProperty('baseWorktreeId');

    // Reopened from the Library, it is still No project with no project
    // picker and nothing to correct.
    await backFromWorkflowEdit(window);
    await expect(shell).toBeHidden();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(activityId),
    );
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    await expect(shell).toHaveAttribute('data-dirty', 'false');
    await expect(
      definition.getByTestId('automations-form-action-type-global'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      definition.getByTestId('automations-form-global-owner'),
    ).toContainText('Owner: Personal');
    await expect(definition).toContainText(GLOBAL_PIPELINE_NAME);
    await expect(
      definition.getByTestId('automations-form-workspace'),
    ).toHaveCount(0);
    await expect(shell.getByTestId('automations-form-error')).toHaveCount(0);

    // Saving an edit keeps the destination.
    await definition
      .getByTestId('automations-form-name')
      .fill('Global shell report renamed');
    await expect(shell).toHaveAttribute('data-dirty', 'true');
    await saveWorkflowEdit(window);
    await expect(shell.getByTestId('automations-form-error')).toHaveCount(0);
    const resaved = persistedActivity(userDataDir, activityId);
    expect(resaved.name).toBe('Global shell report renamed');
    expect(resaved.action).toEqual(saved.action);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a legacy pipeline automation reopens on its project and saves without gaining a target', async () => {
  const userDataDir = seedDemo('canopy-can4550-legacy-');
  seedProjectPipeline(userDataDir);
  const legacy = pipelineAutomation({ workspaceId: WORKSPACE_ID });
  seedAutomations({ userDataDir, activities: [legacy] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(PIPELINE_AUTOMATION_ID),
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    const definition = shell.getByTestId('workflow-edit-section-definition');

    // A legacy action shows its project and what it already does: a new
    // worktree each run on a code project.
    await expect(
      definition.getByTestId('automations-form-action-type-workspace'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      definition.getByTestId('automations-form-workspace'),
    ).toContainText('TypeScript pnpm Vite');
    await expect(
      definition.getByTestId('automations-form-pipeline-run-in-new_worktree'),
    ).toBeChecked();
    await expect(
      definition.getByTestId('automations-form-global-owner'),
    ).toHaveCount(0);
    await expect(definition).toContainText(PIPELINE_NAME);

    await definition
      .getByTestId('automations-form-name')
      .fill('Nightly shell pipeline renamed');
    await expect(shell).toHaveAttribute('data-dirty', 'true');
    await saveWorkflowEdit(window);
    await expect(shell.getByTestId('automations-form-error')).toHaveCount(0);

    const saved = persistedActivity(userDataDir, PIPELINE_AUTOMATION_ID);
    expect(saved.name).toBe('Nightly shell pipeline renamed');
    expect(saved.action).toEqual(legacy.action);
    expect(saved.action).not.toHaveProperty('target');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Run now refuses a task destination whose task was removed', async () => {
  const userDataDir = seedDemo('canopy-can4550-task-missing-');
  seedProjectPipeline(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      pipelineAutomation({
        workspaceId: WORKSPACE_ID,
        target: { kind: 'task', taskId: 'removed-worktree' },
      }),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(PIPELINE_AUTOMATION_ID),
      'view-runs',
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    const runs = await openWorkflowEditSection(window, 'runs');
    await expect(runs.getByTestId('workflow-edit-no-runs')).toBeVisible();

    await shell.getByTestId('automation-details-run-now').click();

    // The run is recorded as failed with the reason, and nothing ran.
    await expect
      .poll(() => {
        const file = JSON.parse(
          readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
        );
        const run = (file.recentRuns ?? []).find(
          (entry) => entry.activityId === PIPELINE_AUTOMATION_ID,
        );
        return run ? { status: run.status, error: run.error } : null;
      })
      .toEqual({ status: 'failure', error: TASK_MISSING_ERROR });
    await expect(runs.getByTestId('workflows-run-row')).toHaveCount(1);
    await expect(runs.getByTestId('workflows-run-row')).toContainText(
      TASK_MISSING_ERROR,
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
