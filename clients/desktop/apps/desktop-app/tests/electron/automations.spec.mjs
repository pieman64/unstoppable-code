import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import {
  AUTOMATION_TIMER_REPLY,
  releaseAutomationTurn,
  runAutomationAndOpenNewChat,
  seedAutomationTurnTimerScenario,
} from './automationTurnTimerScenario.mjs';
import {
  closeFixture,
  createFixture,
  conversationRequests,
} from './codexPipelineRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedCoworkWorkspace,
  seedPluginsCache,
  seedPipelineExecution,
  seedWorktreeChat,
  ORG_CONTEXT_ENV,
} from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { showPipelineJobList } from './pipelineUi.mjs';

// The primary If Command output variable name matches the brand prefix used in
// the default (Canopy) brand. Kept as a local constant so the spec is
// self-documenting without importing desktop-shared source.
const IF_CMD_OUTPUT_VAR = 'CANOPY_AUTOMATION_IF_CMD_OUTPUT';

/*
 * Automations open in the Workflows edit shell (CAN-4072): Definition and
 * Trigger split the form, Runs holds the run history, and saving keeps the
 * shell open on the saved automation.
 */

/**
 * Presses a new draft's `Create automation` and returns the saved id. The
 * shell stays open, swapped in place to the saved automation.
 */
async function createAutomationFromDraft(window) {
  await window.getByTestId('automations-form-submit').click();
  let target = null;
  await expect
    .poll(
      async () => {
        target = await workflowEditTarget(window);
        return target?.kind ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe('automation');
  await expect(window.getByTestId('workflow-edit-shell')).toHaveAttribute(
    'data-dirty',
    'false',
  );
  return target.activityId;
}

/**
 * Presses Back to the list, answering Discard when the shell asks about
 * unsaved edits (a draft that was touched, say).
 */
async function leaveWorkflowEdit(window) {
  const shell = window.getByTestId('workflow-edit-shell');
  const dialog = window.getByTestId('workflows-unsaved-dialog');
  await window.getByTestId('workflow-edit-back').click();
  await expect
    .poll(async () => (await dialog.isVisible()) || (await shell.count()) === 0)
    .toBe(true);
  if (await dialog.isVisible()) {
    await window.getByTestId('workflows-unsaved-discard').click();
  }
  await expect(shell).toHaveCount(0);
}

test('strict background authorization allows an automation with a local custom skill', async () => {
  test.setTimeout(120_000);
  const scenario = seedAutomationTurnTimerScenario();
  const skillDir = path.join(
    scenario.userDataDir,
    'skills',
    'custom:app',
    'automation-check',
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: automation-check\ndescription: Deterministic automation check\n---\nUse the fixture response.\n',
  );
  const file = path.join(scenario.userDataDir, 'automations.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.activities[0].executionContext = 'personal';
  state.activities[0].action.pluginSelections = {
    collectionIds: [],
    pluginRefs: [],
    skillRefs: [{ sourceId: 'custom:app', skillName: 'automation-check' }],
  };
  writeFileSync(file, JSON.stringify(state));
  Object.assign(scenario.fixture.env, ORG_CONTEXT_ENV);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir: scenario.userDataDir,
      env: scenario.fixture.env,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app
      .workflowsLibraryAutomationRow('automation-new-chat-timer')
      .getByTestId('workflows-library-run')
      .click();
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(file, 'utf8')).activities[0].lastResult
            ?.status,
        { timeout: 30_000 },
      )
      .toBe('success');
    await expect
      .poll(
        () =>
          conversationRequests(scenario.fixture.logPath).filter(
            (request) => request.method === 'turn/start',
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    releaseAutomationTurn(scenario.fixture);
  } finally {
    releaseAutomationTurn(scenario.fixture);
    if (electronApp)
      await closeFixture(
        electronApp,
        scenario.userDataDir,
        scenario.fixture.runtimeDir,
      );
  }
});

test('Run now into a new Codex worktree chat preserves its timer after a late chat start', async () => {
  test.setTimeout(120_000);
  const scenario = seedAutomationTurnTimerScenario();
  let electronApp;
  try {
    const opened = await runAutomationAndOpenNewChat({
      ...scenario,
      delayHookNotification: true,
    });
    electronApp = opened.electronApp;
    const { panel } = opened;
    expect(opened.timerVisibleAfterHook).toBe(true);

    // The fake Codex server has emitted turn/started but cannot finish until
    // the release file is written below. This is a provider-originated new
    // chat, so the timer must appear without a composer optimistic message.
    const timer = panel.getByTestId('turn-timer');
    await expect(timer).toHaveAttribute('data-state', 'live', {
      timeout: 10_000,
    });
    await expect(timer.getByTestId('turn-timer-label')).toContainText(
      'Working',
    );

    releaseAutomationTurn(scenario.fixture);
    await expect(
      panel.getByText(AUTOMATION_TIMER_REPLY, { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(timer).toHaveAttribute('data-state', 'completed', {
      timeout: 30_000,
    });
    await expect(timer.getByTestId('turn-timer-label')).toHaveText(
      /Completed in \d+:\d{2}/,
    );
    await expect(timer).toHaveCount(1);
  } finally {
    releaseAutomationTurn(scenario.fixture);
    if (electronApp)
      await closeFixture(
        electronApp,
        scenario.userDataDir,
        scenario.fixture.runtimeDir,
      );
  }
});

test('Run now into a new Codex worktree chat shows and completes its turn timer', async () => {
  test.setTimeout(120_000);
  const scenario = seedAutomationTurnTimerScenario();
  let electronApp;
  try {
    const opened = await runAutomationAndOpenNewChat(scenario);
    electronApp = opened.electronApp;
    const { panel } = opened;
    await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
      'data-state',
      'live',
    );
    releaseAutomationTurn(scenario.fixture);
    await expect(
      panel.getByText(AUTOMATION_TIMER_REPLY, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
      'data-state',
      'completed',
    );
    await expect(panel.getByTestId('turn-timer-label')).toHaveText(
      /Completed in \d+:\d{2}/,
    );
    await expect(panel.getByTestId('turn-timer')).toHaveCount(1);
  } finally {
    releaseAutomationTurn(scenario.fixture);
    if (electronApp)
      await closeFixture(
        electronApp,
        scenario.userDataDir,
        scenario.fixture.runtimeDir,
      );
  }
});

// Doc 2 Spec 8 (Automations page: PR 747), non-live parts only.
//
// Covers the navigation + CRUD surface of scheduled automations in Workflows ›
// Library (CAN-3981), driven entirely through the form UI: tab presence,
// App-Advisor activity creation, the row's on/off switch, empty-prompt
// validation, and the cron-assistant input open/close. The natural-language cron *generation* is
// SDK-backed (live), so it is intentionally only opened/closed here, never
// submitted. The 832 scheduled-session-prompt chat flow is a later spec.
//
// The app build is E2E-gated, so the automations scheduler never starts
// (`AutomationsService.start()` early-returns under `isE2eBuild()`); creating an
// activity through the IPC-backed form still persists and lists normally.

test('automations page: tabs, App Advisor activity CRUD, and validation', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openAutomationsPage();

    // Workflows tabs are present, with Library open (CAN-3981). The retired
    // Shared tab is gone.
    await expect(
      window.getByTestId('workflows-tab-workflows-library'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByTestId('workflows-tab-workflows')).toBeVisible();
    await expect(
      window.getByTestId('workflows-tab-workflows-schedule'),
    ).toBeVisible();
    await expect(window.getByTestId('automations-tab-shared')).toHaveCount(0);

    // --- Retired Shared tab (CAN-1581 browse surface) ---------------------
    // App Advisor's `navigation.go_to_page` with tab 'shared' and the
    // `canopy:automations-open-tab` event still arrive; they now land on
    // Marketplace › Automations filtered to "Shared by me". The harness has
    // no cloud account, so that filter lists nothing.
    await window.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('canopy:automations-open-tab', {
          detail: { tab: 'shared' },
        }),
      );
    });
    await app.expectPluginsPage();
    await expect(
      window.getByTestId('plugins-type-tab-workflow'),
    ).toHaveAttribute('aria-selected', 'true');
    // No owned shares: the section stays hidden; the focus intent is spent.
    await expect(
      window.getByTestId('customize-section-shared-by-me'),
    ).toHaveCount(0);
    await app.openAutomationsPage();

    // There are no activities yet. The Library still lists the built-in
    // pipelines, so it has no automation rows rather than an empty state.
    const automationRows = window.locator(
      '[data-testid="workflows-library-row"][data-row-kind="automation"]',
    );
    await expect(automationRows).toHaveCount(0);

    // --- Empty-prompt validation -----------------------------------------
    // Open a draft from New workflow › On a schedule and submit with no
    // prompt: the error shows in Definition and nothing is created.
    await app.startNewWorkflow('schedule');
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    const definition = window.getByTestId('workflow-edit-section-definition');
    await expect(definition).toBeVisible();

    // Default action type is App Advisor prompt; the prompt starts empty.
    await definition
      .getByTestId('automations-form-name')
      .fill('Validation activity');
    await window.getByTestId('automations-form-submit').click();
    await expect(
      definition.getByTestId('automations-form-error'),
    ).toContainText('Enter a prompt');
    // Still a draft: nothing was created.
    expect((await workflowEditTarget(window))?.kind).toBe('automation-draft');

    // --- Create a valid App Advisor activity -----------------------------
    // The default cron (`0 9 * * *`) is prefilled in Trigger; fill the
    // prompt and submit.
    await definition
      .getByTestId('automations-form-prompt')
      .fill('Summarize my open worktrees each morning.');
    // Sanity-check the prefilled cron is present.
    const trigger = await openWorkflowEditSection(window, 'trigger');
    await expect(trigger.getByTestId('automations-form-cron')).toHaveValue(
      '0 9 * * *',
    );
    const activityId = await createAutomationFromDraft(window);
    expect(activityId.length).toBeGreaterThan(0);

    // Back on the Library, the new activity row appears.
    await backFromWorkflowEdit(window);
    await expect(automationRows).toHaveCount(1);
    await expect(automationRows).toContainText('Validation activity');
    await expect(automationRows).toHaveAttribute(
      'data-row-key',
      `automation:${activityId}`,
    );
    const activityRow = app.workflowsLibraryAutomationRow(activityId);

    // --- Enable / disable toggle -----------------------------------------
    // The row's switch defaults to on; it turns the automation off and back
    // on.
    const toggle = activityRow.getByTestId('workflows-library-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // The per-row Run control is present, and Edit and Delete are in the
    // row's More menu.
    await expect(
      activityRow.getByTestId('workflows-library-run'),
    ).toBeVisible();
    await activityRow.getByTestId('workflows-library-menu').click();
    await expect(
      window.getByTestId('workflows-library-menu-item-edit'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workflows-library-menu-item-delete'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(
      window.getByTestId('workflows-library-menu-item-edit'),
    ).toBeHidden();

    // --- Workspace action category: gated follow-up config ---------------
    // Open a new draft and switch the two-option action selector to
    // Workspace: only the unified workspace select shows. The follow-up
    // config (Chat | Pipeline pill and prompt) stays hidden until a
    // workspace is selected. This launch seeds no workspaces, so the picker
    // has nothing to select and the gated controls remain hidden.
    await app.startNewWorkflow('schedule');
    await expect(definition).toBeVisible();

    await window.getByTestId('automations-form-action-type-workspace').click();
    await expect(
      window.getByTestId('automations-form-workspace'),
    ).toBeVisible();
    await expect(
      window.getByTestId('automations-form-workspace-action-mode'),
    ).toBeHidden();
    await expect(window.getByTestId('automations-form-prompt')).toBeHidden();
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeHidden();

    // Switching back to App Advisor restores the prompt-only layout.
    await window
      .getByTestId('automations-form-action-type-app_advisor')
      .click();
    await expect(window.getByTestId('automations-form-prompt')).toBeVisible();
    await expect(window.getByTestId('automations-form-workspace')).toBeHidden();
    await leaveWorkflowEdit(window);

    // --- Cron assistant input opens/closes only (no SDK generation) ------
    // Open a draft via the always-present New workflow menu; the cron
    // assistant is in Trigger.
    await app.startNewWorkflow('schedule');
    const cronTrigger = await openWorkflowEditSection(window, 'trigger');

    const cronAssistant = cronTrigger.getByTestId(
      'automations-form-cron-assistant',
    );
    await expect(cronAssistant).toBeVisible();
    await cronAssistant.click();
    await expect(
      cronTrigger.getByTestId('automations-form-cron-natural-language'),
    ).toBeVisible();
    // Toggle it back closed without ever triggering generation.
    await cronAssistant.click();
    await expect(
      cronTrigger.getByTestId('automations-form-cron-natural-language'),
    ).toBeHidden();

    await leaveWorkflowEdit(window);

    await window.screenshot({
      path: testInfo.outputPath('automations-validation.png'),
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations form: If Command section — collapsed by default, expands on toggle, insert-variable control reflects state', async ({}, testInfo) => {
  // Seeded-state spec — no live agent required. Tests UI structure/toggle/
  // insert-variable-disabled state only; NL generation (which calls a provider)
  // is intentionally not exercised here.

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openAutomationsPage();

    // Open a draft via the always-present New workflow menu ("On a
    // schedule"). The If Command is part of the trigger, so it lives in the
    // Trigger section, apart from Definition's action selector.
    await app.startNewWorkflow('schedule');
    const definition = window.getByTestId('workflow-edit-section-definition');
    await expect(definition).toBeVisible();
    await expect(
      definition.getByTestId('automations-form-action-type'),
    ).toBeVisible();
    await expect(
      definition.getByTestId('automations-form-if-command-section'),
    ).toHaveCount(0);

    const trigger = await openWorkflowEditSection(window, 'trigger');

    // ── If Command section is VISIBLE (the section header is always rendered) ──
    const ifCommandSection = trigger.getByTestId(
      'automations-form-if-command-section',
    );
    await expect(ifCommandSection).toBeVisible();
    await expect(
      trigger.getByTestId('automations-form-action-type'),
    ).toHaveCount(0);

    // The toggle button is visible and labelled "If Command (optional)".
    const ifCommandToggle = trigger.getByTestId(
      'automations-form-if-command-toggle',
    );
    await expect(ifCommandToggle).toBeVisible();
    await expect(ifCommandToggle).toContainText('If command');

    // ── The textarea is HIDDEN before the toggle is clicked ──
    const ifCommandTextarea = trigger.getByTestId(
      'automations-form-if-command',
    );
    await expect(ifCommandTextarea).toBeHidden();

    // ── Expand the section by clicking the toggle ──
    await ifCommandToggle.click();

    // Textarea is now visible.
    await expect(ifCommandTextarea).toBeVisible();

    // The App-Advisor-generate button is visible inside the expanded section.
    const ifCommandAssistant = trigger.getByTestId(
      'automations-form-if-command-assistant',
    );
    await expect(ifCommandAssistant).toBeVisible();

    // The prompt's Add menu (in Definition) carries variable insertion. The
    // command-output variable is unavailable until an If Command has been
    // entered.
    await openWorkflowEditSection(window, 'definition');
    const promptAddButton = definition.getByTestId(
      'automations-form-prompt-plus-button',
    );
    const promptAddMenu = window.getByTestId(
      'automations-form-prompt-plus-menu',
    );
    await promptAddButton.click();
    const varMenuItem = promptAddMenu.getByRole('button', {
      name: new RegExp(IF_CMD_OUTPUT_VAR),
    });
    await expect(varMenuItem).toBeVisible();
    await expect(varMenuItem).toBeDisabled();
    await promptAddButton.click();
    await expect(promptAddMenu).toBeHidden();

    // ── Type a command and verify the variable becomes ENABLED ──
    // Trigger kept its expanded state while hidden.
    await openWorkflowEditSection(window, 'trigger');
    await expect(ifCommandTextarea).toBeVisible();
    await ifCommandTextarea.fill('test -f ~/ready-to-run.txt');

    await openWorkflowEditSection(window, 'definition');
    await promptAddButton.click();
    await expect(promptAddMenu).toBeVisible();
    await expect(varMenuItem).toBeEnabled();
    await promptAddButton.click();
    await expect(promptAddMenu).toBeHidden();

    // ── NL-generate assistant opens/closes (no submission) ──
    await openWorkflowEditSection(window, 'trigger');
    await ifCommandAssistant.click();
    await expect(
      trigger.getByTestId('automations-form-if-command-natural-language'),
    ).toBeVisible();
    // Toggle it back without triggering generation.
    await ifCommandAssistant.click();
    await expect(
      trigger.getByTestId('automations-form-if-command-natural-language'),
    ).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('automations-if-command.png'),
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// REG-2830 — `worktree_prompt` existingWorktreeId in the Automations editor.
//
// An automation targeting an EXISTING worktree (agent-authored via
// automation.create) must display sanely and survive editing:
//  1. the editor shows the read-only "Existing worktree" block instead of the
//     Base-worktree selector,
//  2. toggling Chat → Pipeline restores the Base-worktree selector (the
//     existing-worktree target is a worktree_prompt-only concept),
//  3. saving without touching the target preserves existingWorktreeId
//     verbatim (no silent rewrite to a fresh-worktree prompt),
//  4. switching the workspace clears the workspace-scoped existingWorktreeId
//     so the form can never save a target that is guaranteed to fail at
//     dispatch.
//
// Deterministic: both workspaces and their worktrees are seeded from the
// demo-apps fixtures against local git repos, and the automation is seeded
// directly into automations.json — no live agents, no network, and the E2E
// build never starts the automations scheduler.

// Row "View runs" → the edit shell's Runs section → Definition handoff;
// opening the row itself goes straight to Definition (CAN-3981, CAN-4072).
// Seeded like REG-2830: one automation with a recorded run, no live agents,
// scheduler never starts.
test('automations page: View runs opens the Runs section and the row opens Definition', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automations-view-'),
  );
  const activityId = 'view-mode-activity';
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: 'Morning digest',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        nextRunAt: '2000-01-01T00:00:00.000Z',
        action: { type: 'app_advisor_prompt', prompt: 'Summarize the day.' },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
    recentRuns: [
      {
        id: 'view-mode-run',
        activityId,
        activityName: 'Morning digest',
        scheduledFor: '2026-08-29T09:00:00.000Z',
        manual: false,
        status: 'success',
        startedAt: '2026-08-29T09:00:00.000Z',
        completedAt: '2026-08-29T09:00:05.000Z',
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    const activityRow = app.workflowsLibraryAutomationRow(activityId);
    // The Library's Next run shows a month and day with no year, as
    // `Jun 1, 3:00 PM` (the one-time trigger text reads `Jun 1 at 3:00 PM`).
    // It is its own column, or `Next: …` under the trigger when the table is
    // narrow, so match it anywhere in the row. The day depends on the time
    // zone. The stale 2000-01-01 `nextRunAt` must not be what is shown.
    await expect(activityRow).toContainText(/Jun [12], \d/);
    await expect(activityRow).not.toContainText(/(Jan 1|Dec 31), \d/);

    // The row's "View runs" opens the shell on Runs (Definition is not
    // mounted) with only the run history, listed as a pipeline's runs are.
    await app.chooseWorkflowsLibraryRowAction(activityRow, 'view-runs');
    const runsSection = window.getByTestId('workflow-edit-section-runs');
    await expect(runsSection).toBeVisible();
    await expect(window.getByTestId('workflow-edit-tab-runs')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(window.getByTestId('automations-form-body')).toHaveCount(0);
    expect(await workflowEditTarget(window)).toMatchObject({
      kind: 'automation',
      activityId,
      section: 'runs',
    });
    await expect(
      runsSection.getByTestId('automation-details-next-run'),
    ).toHaveCount(0);
    await expect(
      runsSection.locator('[data-run-key="automation-run:view-mode-run"]'),
    ).toBeVisible();

    // The Definition tab swaps to the edit form in place.
    const definition = await openWorkflowEditSection(window, 'definition');
    await expect(definition.getByTestId('automations-form-name')).toHaveValue(
      'Morning digest',
    );
    await expect(runsSection).toBeHidden();
    await backFromWorkflowEdit(window);

    // Opening the row opens Definition directly.
    await app.openWorkflowsLibraryRow(activityRow);
    await expect(
      window.getByTestId('workflow-edit-tab-definition'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByTestId('workflow-edit-section-definition'),
    ).toBeVisible();
    await expect(window.getByTestId('workflow-edit-section-runs')).toHaveCount(
      0,
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// The Library sort menu (CAN-3981; it replaced the CAN-3588 sortable Triggered
// list headers). Seeded so results do not depend on the wall clock and every
// expected order is a distinct permutation: the two enabled one-time rows run
// in 2099/2098, the disabled row has no next run, and one row has never run.
test('automations page: the Library sort menu orders rows and keeps the choice across navigation', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automations-sort-'),
  );
  const base = {
    version: 1,
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the day.' },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
  seedAutomations({
    userDataDir,
    activities: [
      {
        ...base,
        id: 'sort-bravo',
        name: 'Bravo',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        failureCount: 0,
        lastResult: {
          status: 'skipped',
          completedAt: '2026-08-29T09:00:05.000Z',
        },
      },
      {
        ...base,
        id: 'sort-alpha',
        name: 'alpha',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        failureCount: 1,
        lastResult: {
          status: 'failure',
          completedAt: '2026-08-27T09:00:05.000Z',
        },
      },
      {
        ...base,
        id: 'sort-charlie',
        name: 'Charlie',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2098-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        failureCount: 0,
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    // Pipelines share the table, so the order is read off the automation rows.
    const expectRowOrder = async (expected) => {
      await expect
        .poll(async () =>
          window
            .locator(
              '[data-testid="workflows-library-row"][data-row-kind="automation"]',
            )
            .evaluateAll((rows) =>
              rows.map((row) =>
                (row.getAttribute('data-row-key') ?? '').replace(
                  'automation:',
                  '',
                ),
              ),
            ),
        )
        .toEqual(expected);
    };
    const chooseSort = async (value) => {
      await window.getByTestId('workflows-library-sort').click();
      // Recently run is the menu's default entry.
      await window
        .getByTestId(
          value === 'recently-run'
            ? 'workflows-library-sort-any'
            : `workflows-library-sort-option-${value}`,
        )
        .click();
    };

    // Recently run is the default: the newest last run first, never-run last.
    // The far-future one-time triggers really render a next run (otherwise
    // the sort assertions below would fail for a confusing reason).
    await expectRowOrder(['sort-bravo', 'sort-alpha', 'sort-charlie']);
    await expect(app.workflowsLibraryAutomationRow('sort-bravo')).toContainText(
      '2099',
    );
    await expect(
      app.workflowsLibraryAutomationRow('sort-charlie'),
    ).toContainText('2098');
    await expect(
      app
        .workflowsLibraryAutomationRow('sort-alpha')
        .getByTestId('workflows-library-next-run'),
    ).toHaveText('—');

    // Name (case-insensitive: `alpha` before `Bravo`).
    await chooseSort('name');
    await expectRowOrder(['sort-alpha', 'sort-bravo', 'sort-charlie']);

    // Leaving and returning keeps the sort.
    await app.openMainPage();
    await app.openAutomationsPage();
    await expectRowOrder(['sort-alpha', 'sort-bravo', 'sort-charlie']);

    // Next run: soonest first, and the row with no next run stays last.
    await chooseSort('next-run');
    await expectRowOrder(['sort-charlie', 'sort-bravo', 'sort-alpha']);

    // Back to the default order.
    await chooseSort('recently-run');
    await expectRowOrder(['sort-bravo', 'sort-alpha', 'sort-charlie']);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations page: a rejected delete keeps the edit shell open with the error', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automations-delete-rejected-'),
  );
  const activityId = 'delete-rejected-activity';
  const activity = {
    version: 1,
    id: activityId,
    name: 'Stale task',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2099-06-01T15:00:00.000Z',
      timezone: 'local',
    },
    action: { type: 'app_advisor_prompt', prompt: 'Stay visible.' },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    failureCount: 0,
  };
  seedAutomations({
    userDataDir,
    activities: [activity],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(activityId),
      'view-runs',
    );
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(
      window.getByTestId('workflow-edit-section-runs'),
    ).toBeVisible();
    const targetBefore = await workflowEditTarget(window);
    // A delete the main process rejects. Deleting the automation for real
    // elsewhere would instead swap the shell to its not-found state as the
    // store follows the change, so reject it at the IPC boundary.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('automations:delete');
      ipcMain.handle('automations:delete', () => ({
        ok: false,
        error: 'Activity not found.',
      }));
    });
    await deleteFromWorkflowEdit(window, 'automation-details-delete');

    // The shell stays on the automation, and the confirmation stays open
    // with the error so the user can retry or cancel.
    await expect(
      window
        .getByTestId('workflow-edit-delete-dialog')
        .getByTestId('confirm-dialog-error'),
    ).toContainText('Activity not found.');
    await expect(
      window.getByTestId('automation-details-delete-confirm'),
    ).toBeEnabled();
    await expect(shell).toBeVisible();
    expect(await workflowEditTarget(window)).toEqual(targetBefore);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('workflow-edit-delete-dialog')).toHaveCount(
      0,
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations page: durable history pages and opens chat turns and pipeline executions', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-run-history-'),
  );
  const workspaceId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const activityId = 'history-activity';
  const chatId = 'history-chat';
  const userMessageId = 'history-user-message';
  const executionId = 'history-pipeline-execution';
  const appAdvisorChatId = 'history-app-advisor-chat';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: chatId,
        title: 'History destination',
        messages: [
          {
            id: userMessageId,
            role: 'user',
            blocks: [{ type: 'text', text: 'Inspect this exact turn.' }],
            timestamp: Date.parse('2026-09-11T11:59:00.000Z'),
          },
          {
            id: 'history-assistant-message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'This is the linked answer.' }],
            timestamp: Date.parse('2026-09-11T11:59:01.000Z'),
          },
        ],
      },
    ],
    activeTabId: chatId,
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId,
    worktreeId,
    execution: {
      id: executionId,
      pipelineName: 'History pipeline',
      status: 'success',
      startedAt: '2026-09-11T12:00:00.000Z',
      completedAt: '2026-09-11T12:00:05.000Z',
    },
  });
  const run = (id, startedAt, overrides = {}) => ({
    id,
    activityId,
    activityName: 'Durable history',
    scheduledFor: startedAt,
    manual: false,
    trigger: 'scheduled',
    executionLocation: 'local',
    status: 'success',
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 5_000).toISOString(),
    durationMs: 5_000,
    target: { workspaceId, worktreeId },
    ...overrides,
  });
  const pipelineRun = run('history-pipeline-run', '2026-09-11T12:00:00.000Z', {
    trigger: 'manual',
    manual: true,
    ifCommandOutput: 'preflight passed',
    result: {
      projectId: workspaceId,
      worktreeId,
      pipelineExecutionId: executionId,
    },
  });
  const chatRun = run('history-chat-run', '2026-09-11T11:59:00.000Z', {
    target: { workspaceId, worktreeId, chatId },
    result: { projectId: workspaceId, worktreeId, chatId, userMessageId },
  });
  const appAdvisorRun = run(
    'history-app-advisor-run',
    '2026-09-11T12:01:00.000Z',
    {
      target: { workspaceId: 'app-advisor' },
      result: {
        appAdvisorChatId,
        userMessageId: 'history-app-advisor-message',
      },
    },
  );
  const archivedRuns = [appAdvisorRun, pipelineRun, chatRun];
  for (let index = 0; index < 73; index += 1) {
    archivedRuns.push(
      run(
        `history-filler-${index}`,
        new Date(
          Date.parse('2026-09-11T11:58:00.000Z') - index * 60_000,
        ).toISOString(),
      ),
    );
  }
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: 'Durable history',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId,
          worktreeId,
          chatId,
          prompt: 'Inspect this exact turn.',
        },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
    recentRuns: [appAdvisorRun, pipelineRun, chatRun],
    archivedRunsByActivity: { [activityId]: archivedRuns },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(activityId),
      'view-runs',
    );
    let runs = window.getByTestId('automation-runs-section');
    const runRow = (runId) =>
      runs.locator(`[data-run-key="automation-run:${runId}"]`);
    // Opening reads the automation's own archive past the hot window, one
    // page at a time, into the shared runs list.
    const runRows = runs.getByTestId('workflows-run-row');
    await expect(runRows).toHaveCount(50);
    await expect(runRow('history-app-advisor-run')).toBeVisible();
    await expect(runRow('history-pipeline-run')).toBeVisible();
    await runs.getByTestId('workflows-runs-load-more').click();
    await expect(runs.getByTestId('workflows-runs-load-more')).toHaveCount(0);
    await expect(runRows).toHaveCount(76);

    // A chat run opens the exact turn it sent.
    await runRow('history-chat-run').getByTestId('workflows-run-name').click();
    await expect(
      window.locator(
        `[data-chat-sticky-section="${userMessageId}"][data-chat-turn-focus="true"]`,
      ),
    ).toBeVisible();

    // A pipeline run opens the execution it started.
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(activityId),
      'view-runs',
    );
    runs = window.getByTestId('automation-runs-section');
    await runRow('history-pipeline-run')
      .getByTestId('workflows-run-name')
      .click();
    await showPipelineJobList(window);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

const REG2830_PRIMARY_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const REG2830_SECONDARY_WORKSPACE_ID = 'demo-ts-yarn-cli';
const REG2830_WORKTREE_ID = 'demo-main';
const REG2830_ACTIVITY_ID = 'reg-2830-existing-worktree';

function readReg2830AutomationAction(userDataDir) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  const activity = file.activities.find(
    (entry) => entry.id === REG2830_ACTIVITY_ID,
  );
  if (!activity) {
    throw new Error('seeded activity missing from automations.json');
  }
  return activity.action;
}

test('automations editor: existing-worktree prompt displays, round-trips, and resets on project change', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-2830-'));
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-yarn-cli'],
  });
  const secondaryWorkspace = demoSeed.workspaces.find(
    (workspace) => workspace.id === REG2830_SECONDARY_WORKSPACE_ID,
  );
  expect(secondaryWorkspace, 'secondary demo project seeded').toBeTruthy();

  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: REG2830_ACTIVITY_ID,
        name: 'Existing worktree handoff',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: REG2830_PRIMARY_WORKSPACE_ID,
          existingWorktreeId: REG2830_WORKTREE_ID,
          prompt: 'Implement leg 2 in place.',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    // --- 1. Read view: a new chat on an existing worktree is the "Existing
    // chat" mode with the worktree picked and "New chat" selected; the Base
    // selector (a provisioning source) is hidden.
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(REG2830_ACTIVITY_ID),
    );
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await expect(
      window.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('automations-form-chat-target-worktree'),
    ).not.toContainText('Select a');
    await expect(
      window.getByTestId('automations-form-chat-target-chat'),
    ).toContainText('New chat');
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeHidden();

    // --- 2. Pipeline mode restores the Base selector (REG-2830 review
    // finding: the guard must be scoped to chat prompts).
    await window
      .getByTestId('automations-form-workspace-action-mode-pipeline')
      .click();
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeVisible();
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toBeHidden();
    await backFromWorkflowEdit(window, { discard: true });

    // --- 3. Saving without touching the target preserves it. A saved
    // automation only saves once it has changes, so edit just the name.
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(REG2830_ACTIVITY_ID),
    );
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await window
      .getByTestId('automations-form-name')
      .fill('Existing worktree handoff (renamed)');
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    const savedAction = readReg2830AutomationAction(userDataDir);
    expect(savedAction.type).toBe('worktree_prompt');
    expect(savedAction.existingWorktreeId).toBe(REG2830_WORKTREE_ID);
    expect(savedAction.workspaceId).toBe(REG2830_PRIMARY_WORKSPACE_ID);
    expect(savedAction.baseWorktreeId).toBeUndefined();

    // --- 4. Switching the workspace clears the workspace-scoped target
    // (REG-2830 review finding: a stale id would fail every dispatch). Save
    // stays blocked until a worktree of the new project is chosen.
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(REG2830_ACTIVITY_ID),
    );
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await window.getByTestId('automations-form-workspace').click();
    // Regex name: the option's accessible name concatenates label, subtitle,
    // and badge text, so an exact-string match would miss.
    await window
      .getByRole('option', {
        name: new RegExp(
          secondaryWorkspace.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'i',
        ),
      })
      .click();
    await expect(
      window.getByTestId('automations-form-chat-target-worktree'),
    ).toContainText('Select a');
    await expect(window.getByTestId('automations-form-submit')).toBeDisabled();
    await expect(
      window.getByTestId('automations-form-chat-target-error'),
    ).toHaveText('Pick a destination for this automation.');

    await window.getByTestId('automations-form-run-in-new_chat').click();
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeVisible();
    await saveWorkflowEdit(window);
    const retargetedAction = readReg2830AutomationAction(userDataDir);
    expect(retargetedAction.workspaceId).toBe(REG2830_SECONDARY_WORKSPACE_ID);
    expect(retargetedAction.existingWorktreeId).toBeUndefined();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations editor: missing prompt reference uses the shared Notice', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-prompt-notice-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const activityId = 'missing-prompt-reference';
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: 'Missing file review',
        enabled: false,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: REG2830_PRIMARY_WORKSPACE_ID,
          prompt: 'Read missing.txt',
          promptReferences: [
            {
              kind: 'file',
              textStart: 5,
              displayText: 'missing.txt',
              root: { kind: 'workspace' },
              relativePath: 'missing.txt',
            },
          ],
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow(activityId),
    );
    await expect(
      window
        .getByTestId('workflow-edit-section-definition')
        .locator('[data-notice-intent="destructive"]'),
    ).toContainText('Resolve or remove missing file references');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations run: catalog-only plugin pill fails before chat dispatch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stale-plugin-prompt-'),
  );
  seedPluginsCache({ userDataDir });
  const activityId = 'stale-plugin-prompt';
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: 'Unavailable plugin review',
        enabled: false,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'alpha-tool',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 0,
              displayText: 'alpha-tool',
              plugin: {
                kind: 'installed',
                marketplaceId: 'demo/market',
                pluginName: 'alpha-tool',
              },
            },
          ],
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const activityRow = app.workflowsLibraryAutomationRow(activityId);
    await activityRow.getByTestId('workflows-library-run').click();
    await expect(
      activityRow.getByTestId('workflows-library-last-run'),
    ).toContainText('Failed');
    await app.chooseWorkflowsLibraryRowAction(activityRow, 'view-runs');
    await expect(
      window.getByTestId('workflow-edit-section-runs'),
    ).toContainText('Referenced plugin is unavailable');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations run: terminal chat rejects scheduled permission overrides', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-terminal-automation-settings-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'terminal-chat',
        title: 'Terminal chat',
        kind: 'chat',
        providerType: 'claude',
        interfaceMode: 'auto',
        approvalMode: 'ask',
        messages: [],
      },
    ],
    activeTabId: 'terminal-chat',
  });
  const activityId = 'terminal-settings-override';
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: activityId,
        name: 'Terminal permission check',
        enabled: false,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          chatId: 'terminal-chat',
          prompt: 'Continue',
          approvalMode: 'full-access',
          purpose: 'scheduled_send',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const activityRow = app.workflowsLibraryAutomationRow(activityId);
    await activityRow.getByTestId('workflows-library-run').click();
    await expect(
      activityRow.getByTestId('workflows-library-last-run'),
    ).toContainText('Failed');
    await app.chooseWorkflowsLibraryRowAction(activityRow, 'view-runs');
    await expect(
      window.getByTestId('workflow-edit-section-runs'),
    ).toContainText(
      'Scheduled terminal chat settings differ from the live chat',
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// ---------------------------------------------------------------------------
// CAN-2937 — the "Run in" selector: new chat each run vs. existing chat.
//
// Deterministic: the workspace + worktree come from the demo-apps fixtures
// against local git repos, the destination chat is seeded on disk, and the
// automation is seeded into automations.json. Nothing here dispatches a run,
// so no agent or network is involved; the assertions read the persisted
// action back out of automations.json.
const CAN2937_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const CAN2937_WORKTREE_ID = 'demo-main';
const CAN2937_ACTIVITY_ID = 'can-2937-run-in';
const CAN2937_CHAT_ID = 'can-2937-destination-chat';
const CAN2937_CHAT_TITLE = 'Release follow-up';

function readCan2937Action(userDataDir) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  const activity = file.activities.find(
    (entry) => entry.id === CAN2937_ACTIVITY_ID,
  );
  if (!activity) {
    throw new Error('seeded activity missing from automations.json');
  }
  return activity.action;
}

function seedCan2937(userDataDir, action) {
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: CAN2937_ACTIVITY_ID,
        name: 'Run-in round trip',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

test('automations editor: creates a code automation in New chat each run mode', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2937-create-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    await app.startNewWorkflow('schedule');
    await window.getByTestId('automations-form-name').fill('Fresh code chat');
    await window.getByTestId('automations-form-action-type-workspace').click();
    await window.getByTestId('automations-form-workspace').click();
    await window.getByRole('option').first().click();
    await expect(
      window.getByTestId('automations-form-run-in-new_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await window
      .getByTestId('automations-form-prompt')
      .fill('Summarize what changed.');
    await createAutomationFromDraft(window);
    await backFromWorkflowEdit(window);

    const row = window.locator(
      '[data-testid="workflows-library-row"][data-row-kind="automation"]',
    );
    await expect(row).toHaveCount(1);

    const persisted = JSON.parse(
      readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
    ).activities[0];
    expect(persisted.action).toMatchObject({
      type: 'worktree_prompt',
      workspaceId: CAN2937_WORKSPACE_ID,
      prompt: 'Summarize what changed.',
    });
    expect(persisted.schedule).toMatchObject({
      kind: 'cron',
      expression: '0 9 * * *',
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations editor: Run in switches between a new chat each run and a specific existing chat', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-2937-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: CAN2937_WORKSPACE_ID,
    worktreeId: CAN2937_WORKTREE_ID,
    // Seed the shape real chats actually have: `title` stays the literal
    // 'New Chat' a chat is created with, and the generated summary lands on
    // `description`. Every chat list must render `description` first, so
    // selecting and displaying this destination by its summary is the
    // end-to-end guard against the picker showing 'New Chat' for every chat.
    tabs: [
      {
        id: CAN2937_CHAT_ID,
        title: 'New Chat',
        description: CAN2937_CHAT_TITLE,
        messages: [],
      },
    ],
    activeTabId: CAN2937_CHAT_ID,
  });
  seedCan2937(userDataDir, {
    type: 'worktree_prompt',
    workspaceId: CAN2937_WORKSPACE_ID,
    prompt: 'Summarize what changed.',
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    // --- 1. A worktree prompt runs in a new chat each run, and the form's
    // base-worktree field is the new-chat affordance.
    const activityRow = app.workflowsLibraryAutomationRow(CAN2937_ACTIVITY_ID);
    await app.openWorkflowsLibraryRow(activityRow);
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await expect(
      window.getByTestId('automations-form-run-in-new_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeVisible();
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toBeHidden();

    // --- 2. Switch to Existing chat and pick the seeded destination. The
    // trigger and prompt must survive the flip untouched.
    await window.getByTestId('automations-form-run-in-existing_chat').click();
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toBeVisible();
    await expect(
      window.getByTestId('automations-form-base-worktree'),
    ).toBeHidden();

    await window.getByTestId('automations-form-chat-target-worktree').click();
    // The fixture seeds exactly one worktree, and the option renders its
    // friendly display title rather than the `demo-main` branch name, so
    // select by position instead of by branch.
    await window.getByRole('option').first().click();
    await window.getByTestId('automations-form-chat-target-chat').click();
    await window
      .getByRole('option', { name: new RegExp(CAN2937_CHAT_TITLE, 'i') })
      .click();

    await expect(
      window.getByTestId('automations-form-chat-target-unavailable'),
    ).toBeHidden();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);

    const existingAction = readCan2937Action(userDataDir);
    expect(existingAction.type).toBe('worktree_session_prompt');
    expect(existingAction.workspaceId).toBe(CAN2937_WORKSPACE_ID);
    expect(existingAction.worktreeId).toBe(CAN2937_WORKTREE_ID);
    expect(existingAction.chatId).toBe(CAN2937_CHAT_ID);
    expect(existingAction.prompt).toBe('Summarize what changed.');

    // --- 3. Reopening shows the persisted mode and the chat it continues.
    await app.openWorkflowsLibraryRow(activityRow);
    await expect(
      window.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('automations-form-chat-target-chat'),
    ).toContainText(new RegExp(CAN2937_CHAT_TITLE, 'i'));
    // The trigger survived the flip: Trigger still holds the schedule and
    // the If Command.
    const trigger = await openWorkflowEditSection(window, 'trigger');
    await expect(
      trigger.getByTestId('automations-form-schedule-kind'),
    ).toBeVisible();
    await expect(
      trigger.getByTestId('automations-form-if-command-section'),
    ).toBeVisible();

    // --- 4. Switching back to New chat each run drops the destination and
    // restores the fresh-worktree wire type.
    const definition = await openWorkflowEditSection(window, 'definition');
    await definition.getByTestId('automations-form-run-in-new_chat').click();
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toBeHidden();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);

    const backToNewAction = readCan2937Action(userDataDir);
    expect(backToNewAction.type).toBe('worktree_prompt');
    expect(backToNewAction.workspaceId).toBe(CAN2937_WORKSPACE_ID);
    expect(backToNewAction.chatId).toBeUndefined();
    expect(backToNewAction.prompt).toBe('Summarize what changed.');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations editor: Existing chat defaults to a new chat in the picked worktree', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-existing-new-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: CAN2937_WORKSPACE_ID,
    worktreeId: CAN2937_WORKTREE_ID,
    tabs: [
      {
        id: CAN2937_CHAT_ID,
        title: 'New Chat',
        description: CAN2937_CHAT_TITLE,
        messages: [],
      },
    ],
    activeTabId: CAN2937_CHAT_ID,
  });
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    await app.startNewWorkflow('schedule');
    await window.getByTestId('automations-form-name').fill('Same worktree');
    await window.getByTestId('automations-form-action-type-workspace').click();
    await window.getByTestId('automations-form-workspace').click();
    await window.getByRole('option').first().click();
    await window.getByTestId('automations-form-run-in-existing_chat').click();

    // Nothing is picked yet: Save is blocked on the destination.
    await expect(window.getByTestId('automations-form-submit')).toBeDisabled();

    // Picking only the worktree is enough: the chat defaults to "New chat".
    await window.getByTestId('automations-form-chat-target-worktree').click();
    await window.getByRole('option').first().click();
    await expect(
      window.getByTestId('automations-form-chat-target-chat'),
    ).toContainText('New chat');
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toContainText('Each run starts a new chat in this worktree.');
    await expect(window.getByTestId('automations-form-open-chat')).toHaveCount(
      0,
    );
    await window
      .getByTestId('automations-form-prompt')
      .fill('Summarize what changed.');
    await expect(window.getByTestId('automations-form-submit')).toBeEnabled();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);

    const readAction = () =>
      JSON.parse(
        readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
      ).activities[0];
    const created = readAction();
    expect(created.action).toEqual({
      type: 'worktree_prompt',
      workspaceId: CAN2937_WORKSPACE_ID,
      existingWorktreeId: CAN2937_WORKTREE_ID,
      prompt: 'Summarize what changed.',
    });

    // Reopening restores the destination; picking the seeded chat switches
    // to continuing it, and "New chat" switches back.
    const createdRow = app.workflowsLibraryAutomationRow(created.id);
    await app.openWorkflowsLibraryRow(createdRow);
    await expect(
      window.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('automations-form-chat-target-chat'),
    ).toContainText('New chat');
    await window.getByTestId('automations-form-chat-target-chat').click();
    await window
      .getByRole('option', { name: new RegExp(CAN2937_CHAT_TITLE, 'i') })
      .click();
    await expect(
      window.getByTestId('automations-form-open-chat'),
    ).toBeVisible();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    expect(readAction().action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: CAN2937_WORKSPACE_ID,
      worktreeId: CAN2937_WORKTREE_ID,
      chatId: CAN2937_CHAT_ID,
    });

    await app.openWorkflowsLibraryRow(createdRow);
    await window.getByTestId('automations-form-chat-target-chat').click();
    await window.getByRole('option', { name: /^New chat/ }).click();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    expect(readAction().action).toEqual({
      type: 'worktree_prompt',
      workspaceId: CAN2937_WORKSPACE_ID,
      existingWorktreeId: CAN2937_WORKTREE_ID,
      prompt: 'Summarize what changed.',
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

const APP_ADVISOR_ENTRY_ID = 'automation-advisor-entry';
const APP_ADVISOR_ENTRY_TITLE = 'Release prep';
const APP_ADVISOR_CHAT_ID = 'automation-advisor-chat';
const APP_ADVISOR_CHAT_TITLE = 'Release checklist';

function seedAppAdvisorWorkEntry(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: APP_ADVISOR_ENTRY_ID,
        createdAt: '2026-09-01T12:00:00.000Z',
        title: APP_ADVISOR_ENTRY_TITLE,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', `${APP_ADVISOR_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: APP_ADVISOR_CHAT_ID,
    tabs: [
      {
        id: APP_ADVISOR_CHAT_ID,
        title: APP_ADVISOR_CHAT_TITLE,
        createdAt: '2026-09-01T12:00:00.000Z',
        providerType: 'claude',
        model: 'sonnet',
        messages: [],
      },
    ],
  });
}

test('targeted App Advisor automation preserves an existing empty chat and its model', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-targeted-chat-preservation-'),
  );
  const fixture = createFixture('completed', 'Automation completed.');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAppAdvisorWorkEntry(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: 'advisor-existing-entry-run',
        name: 'Advisor existing entry run',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          workEntryId: APP_ADVISOR_ENTRY_ID,
          prompt: 'Review the existing entry.',
          model: 'gpt-6-sol',
        },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await advisor
      .getByTestId(`app-advisor-nav-entry-${APP_ADVISOR_ENTRY_ID}`)
      .click();
    await expect(
      advisor.getByTestId(`panel-tab-panel-chat-${APP_ADVISOR_CHAT_ID}`),
    ).toBeVisible();

    await app.openAutomationsPage();
    await app
      .workflowsLibraryAutomationRow('advisor-existing-entry-run')
      .getByTestId('workflows-library-run')
      .click();
    await expect
      .poll(
        () =>
          conversationRequests(fixture.logPath).some(
            (request) =>
              request.method === 'turn/start' &&
              JSON.stringify(request.params).includes(
                'Review the existing entry.',
              ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(
      advisor.getByTestId(`panel-tab-panel-chat-${APP_ADVISOR_CHAT_ID}`),
    ).toBeVisible();
    await expect(
      advisor.locator('[data-testid^="panel-tab-panel-chat-"]'),
    ).toHaveCount(2);
    const tabs = readChatStorageTabs(
      path.join(userDataDir, 'app-workspaces', 'app-advisor'),
      APP_ADVISOR_ENTRY_ID,
    ).tabs;
    expect(tabs.find((tab) => tab.id === APP_ADVISOR_CHAT_ID)).toMatchObject({
      model: 'sonnet',
      providerType: 'claude',
    });
  } finally {
    if (electronApp) {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  }
});

test('automations editor: App Advisor Existing chat reuses a Work Entry with a new or specific chat', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-app-advisor-existing-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAppAdvisorWorkEntry(userDataDir);
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    await app.startNewWorkflow('schedule');
    await window.getByTestId('automations-form-name').fill('Advisor follow-up');
    await window
      .getByTestId('automations-form-action-type-app_advisor')
      .click();
    await expect(
      window.getByTestId('automations-form-run-in-new_chat'),
    ).toHaveAttribute('aria-checked', 'true');

    await window.getByTestId('automations-form-run-in-existing_chat').click();
    await expect(window.getByTestId('automations-form-submit')).toBeDisabled();
    await window.getByTestId('automations-form-chat-target-worktree').click();
    await window
      .getByRole('option', { name: new RegExp(APP_ADVISOR_ENTRY_TITLE) })
      .click();
    await expect(
      window.getByTestId('automations-form-chat-target-chat'),
    ).toContainText('New chat');
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toContainText('Each run starts a new chat in this work entry.');
    await window
      .getByTestId('automations-form-prompt')
      .fill('Check the release checklist.');
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);

    const readActivity = () =>
      JSON.parse(
        readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
      ).activities[0];
    const created = readActivity();
    expect(created.action).toEqual({
      type: 'app_advisor_prompt',
      workEntryId: APP_ADVISOR_ENTRY_ID,
      prompt: 'Check the release checklist.',
    });

    const createdRow = app.workflowsLibraryAutomationRow(created.id);

    // Pick a specific App Advisor chat: the automation now continues it.
    await app.openWorkflowsLibraryRow(createdRow);
    await expect(
      window.getByTestId('automations-form-action-type-app_advisor'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.getByTestId('automations-form-chat-target-chat').click();
    await window
      .getByRole('option', { name: new RegExp(APP_ADVISOR_CHAT_TITLE) })
      .click();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    expect(readActivity().action).toMatchObject({
      type: 'worktree_session_prompt',
      workspaceId: 'app-advisor',
      worktreeId: APP_ADVISOR_ENTRY_ID,
      chatId: APP_ADVISOR_CHAT_ID,
      prompt: 'Check the release checklist.',
    });

    // The continued App Advisor chat stays editable, and New chat each run
    // returns to a fresh Work Entry per run.
    await app.openWorkflowsLibraryRow(createdRow);
    await expect(
      window.getByTestId('automations-form-action-type-app_advisor'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.getByTestId('automations-form-run-in-new_chat').click();
    await expect(
      window.getByTestId('automations-form-chat-target'),
    ).toBeHidden();
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    expect(readActivity().action).toEqual({
      type: 'app_advisor_prompt',
      prompt: 'Check the release checklist.',
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations editor: an unsupported existing-chat destination explains itself and blocks save', async () => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2937-stale-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // The worktree and target chat exist, but Cursor chats are unsupported for
  // unattended automation dispatch. A second supported chat allows repair.
  seedWorktreeChat({
    userDataDir,
    workspaceId: CAN2937_WORKSPACE_ID,
    worktreeId: CAN2937_WORKTREE_ID,
    tabs: [
      {
        id: 'cursor-chat',
        title: 'Cursor chat',
        providerType: 'cursor',
        messages: [],
      },
      { id: 'some-other-chat', title: 'Still here', messages: [] },
    ],
    activeTabId: 'cursor-chat',
  });
  seedCan2937(userDataDir, {
    type: 'worktree_session_prompt',
    workspaceId: CAN2937_WORKSPACE_ID,
    worktreeId: CAN2937_WORKTREE_ID,
    chatId: 'cursor-chat',
    prompt: 'Keep going.',
    workspaceName: 'Demo',
    worktreeName: CAN2937_WORKTREE_ID,
    chatTitle: 'Cursor chat',
    attachmentPaths: ['/tmp/context.txt'],
    purpose: 'scheduled_send',
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();

    // Run now stays off rather than implying the next run will land
    // somewhere.
    const activityRow = app.workflowsLibraryAutomationRow(CAN2937_ACTIVITY_ID);
    await app.chooseWorkflowsLibraryRowAction(activityRow, 'view-runs');
    await expect(
      window.getByTestId('automation-details-run-now'),
    ).toBeDisabled();
    await backFromWorkflowEdit(window);

    // The form explains it and refuses to save until another chat is picked.
    await app.openWorkflowsLibraryRow(activityRow);
    await expect(
      window.getByTestId('automations-form-chat-target-unavailable'),
    ).toBeVisible();
    await expect(window.getByTestId('automations-form-submit')).toBeDisabled();
    await expect(
      window.getByTestId('automations-form-workspace-action-mode-pipeline'),
    ).toBeDisabled();
    await expect(window.getByTestId('automations-form-name')).toHaveAttribute(
      'readonly',
    );
    await expect(window.getByTestId('automations-form-prompt')).toHaveAttribute(
      'contenteditable',
      'false',
    );

    await window.getByTestId('automations-form-chat-target-chat').click();
    await window.getByRole('option', { name: /Still here/i }).click();
    await expect(
      window.getByTestId('automations-form-chat-target-unavailable'),
    ).toBeHidden();
    await expect(window.getByTestId('automations-form-submit')).toBeEnabled();

    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    expect(readCan2937Action(userDataDir).chatId).toBe('some-other-chat');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// ---------------------------------------------------------------------------
// Automation-initiated chat start. Every surface a prompt automation can
// start a chat on — a new Code worktree, a Cowork Work Entry, and an App
// Advisor Work Entry — shows the automation banner (automation name + launch
// time, like hook-initiated chats), keeps it after the renderer reloads from
// the canonical transcript, and holds only the automation's own chat: never an
// empty starter "New Chat" beside it. An automation into an existing worktree
// adds its chat without removing the chats already there.
//
// Deterministic: the fake Codex app-server answers every turn with a fixed
// reply, the workspaces are local demo fixtures, and each automation is
// scheduled far in the future and started with Run now.
const AUTOMATION_START_REPLY = 'Automation start fixture completed.';
const AUTOMATION_START_MODEL = 'gpt-6-sol';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

/** The rendered `automation_info` banner for `automationName`. */
function automationStartBanner(scope, automationName) {
  return scope.getByText(
    new RegExp(
      `Chat initiated by automation ${escapeRegExp(automationName)} at \\d`,
    ),
  );
}

function visibleChatTabs(scope) {
  return scope.locator('[data-testid^="panel-tab-panel-chat-"]:visible');
}

function seedPromptAutomation(userDataDir, { id, name, action }) {
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id,
        name,
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: { model: AUTOMATION_START_MODEL, ...action },
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

/** Run now, then wait for the durable run record and return its result. */
async function runAutomationNow(window, userDataDir, activityId) {
  await new CanopyAppDriver(window)
    .workflowsLibraryAutomationRow(activityId)
    .getByTestId('workflows-library-run')
    .click();
  let run;
  await expect
    .poll(
      () => {
        run = JSON.parse(
          readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
        ).recentRuns?.find((entry) => entry.activityId === activityId);
        return run?.status;
      },
      { timeout: 60_000 },
    )
    .toBe('success');
  return run.result;
}

/** Canonical (main-owned) chat tabs for a scope, read through the app API. */
async function canonicalChatTabs(window, projectId, worktreeId) {
  const file = await window.evaluate(
    async (target) => {
      const metadata = await window.api.chat.loadTabs(target);
      return {
        ...metadata,
        tabs: await Promise.all(
          metadata.tabs.map(async (tab) => {
            if (tab.kind === 'file') return tab;
            const transcript = await window.api.chat.getTranscriptPage({
              ...target,
              chatId: tab.id,
            });
            return { ...tab, messages: transcript.messages };
          }),
        ),
      };
    },
    { projectId, worktreeId },
  );
  return file.tabs.filter((tab) => (tab.kind ?? 'chat') === 'chat');
}

function persistedAutomationBanners(tab, automationName) {
  return (tab?.messages ?? []).filter((message) =>
    message.blocks?.some(
      (block) =>
        block.type === 'automation_info' &&
        block.activityName === automationName,
    ),
  );
}

async function expectSingleAutomationChat({
  window,
  scope,
  projectId,
  worktreeId,
  chatId,
  automationName,
  prompt,
  fixture,
}) {
  await scope.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  releaseAutomationTurn(fixture);
  const panel = scope
    .getByTestId('panel-content-chat')
    .filter({ hasText: prompt });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(prompt, { exact: true })).toBeVisible();
  // Launch provenance and tab ownership are available before the provider
  // finishes; response rendering is covered by the turn-timer scenarios.
  await expect(automationStartBanner(panel, automationName)).toHaveCount(1);
  await expect(automationStartBanner(panel, automationName)).toBeVisible();
  // Only the automation's own chat: no empty starter tab beside it.
  await expect(visibleChatTabs(scope)).toHaveCount(1);
  await expect(
    scope.getByTestId(`panel-tab-panel-chat-${chatId}`),
  ).toBeVisible();
  // Renderer-driven sends (App Advisor quick prompts) render optimistically
  // before main commits the tab and then its messages, so wait for both.
  await expect
    .poll(
      async () => {
        const tabs = await canonicalChatTabs(window, projectId, worktreeId);
        return {
          chatIds: tabs.map((tab) => tab.id),
          banners: persistedAutomationBanners(tabs[0], automationName).length,
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ chatIds: [chatId], banners: 1 });
}

async function waitForAppAdvisorPage(electronApp) {
  let advisor;
  await expect
    .poll(
      () => {
        advisor = electronApp
          .windows()
          .find((page) => page.url().includes('surface=app-advisor'));
        return advisor !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await advisor.waitForLoadState('domcontentloaded');
  await expect(
    advisor.getByTestId('app-advisor-workspace-surface'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    advisor.getByTestId('app-advisor-workspace-loading'),
  ).toHaveCount(0, { timeout: 30_000 });
  return advisor;
}

test('Run now into a new Code worktree starts one chat with the automation banner, kept after reload', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-start-code-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const activityId = 'automation-start-code';
  const automationName = 'Nightly code review';
  const prompt = 'AUTOMATION_START_CODE review the latest changes.';
  seedPromptAutomation(userDataDir, {
    id: activityId,
    name: automationName,
    action: {
      type: 'worktree_prompt',
      workspaceId: 'demo-ts-pnpm-vite',
      baseWorktreeId: 'demo-main',
      prompt,
    },
  });
  const fixture = createFixture('staged', AUTOMATION_START_REPLY);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const result = await runAutomationNow(window, userDataDir, activityId);
    expect(result).toMatchObject({ projectId: 'demo-ts-pnpm-vite' });
    expect(result.worktreeId).not.toBe('demo-main');

    await app.openMainPage();
    await app.selectWorktree(result.worktreeId);
    const expected = {
      window,
      scope: window.getByTestId('page-main'),
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: result.worktreeId,
      chatId: result.chatId,
      automationName,
      prompt,
      fixture,
    };
    await expectSingleAutomationChat(expected);

    // A reload rebuilds the renderer from canonical state only.
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(result.worktreeId);
    await expectSingleAutomationChat(expected);
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('Run now into an existing Code worktree adds a banner chat and keeps the chats already there', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-start-existing-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [
      {
        id: 'existing-review',
        title: 'Existing review',
        kind: 'chat',
        messages: [
          {
            id: 'existing-review-user',
            role: 'user',
            timestamp: Date.parse('2026-09-20T12:00:00.000Z'),
            blocks: [{ type: 'text', text: 'EXISTING_CHAT keep this chat.' }],
          },
          {
            id: 'existing-review-assistant',
            role: 'assistant',
            timestamp: Date.parse('2026-09-20T12:00:05.000Z'),
            blocks: [{ type: 'text', text: 'Existing chat reply.' }],
          },
        ],
      },
    ],
    activeTabId: 'existing-review',
  });
  const activityId = 'automation-start-existing';
  const automationName = 'Existing worktree follow-up';
  const prompt = 'AUTOMATION_START_EXISTING continue in place.';
  seedPromptAutomation(userDataDir, {
    id: activityId,
    name: automationName,
    action: {
      type: 'worktree_prompt',
      workspaceId: 'demo-ts-pnpm-vite',
      existingWorktreeId: 'demo-main',
      prompt,
    },
  });
  const fixture = createFixture('staged', AUTOMATION_START_REPLY);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const result = await runAutomationNow(window, userDataDir, activityId);
    expect(result).toMatchObject({
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
    });
    expect(result.chatId).not.toBe('existing-review');

    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const main = window.getByTestId('page-main');
    await expect(
      main.getByTestId('panel-tab-panel-chat-existing-review'),
    ).toBeVisible();
    await main.getByTestId(`panel-tab-panel-chat-${result.chatId}`).click();
    releaseAutomationTurn(fixture);
    const panel = main
      .getByTestId('panel-content-chat')
      .filter({ hasText: prompt });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(automationStartBanner(panel, automationName)).toBeVisible();

    const tabs = await canonicalChatTabs(
      window,
      'demo-ts-pnpm-vite',
      'demo-main',
    );
    const existing = tabs.find((tab) => tab.id === 'existing-review');
    expect(existing?.messages.map((message) => message.id)).toEqual([
      'existing-review-user',
      'existing-review-assistant',
    ]);
    expect(persistedAutomationBanners(existing, automationName)).toHaveLength(
      0,
    );
    const started = tabs.find((tab) => tab.id === result.chatId);
    expect(persistedAutomationBanners(started, automationName)).toHaveLength(1);
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('Run now into Cowork opens one Work Entry chat with the automation banner, kept after reload', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-start-cowork-'),
  );
  const workspaceId = 'automation-start-cowork';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Automation Cowork',
    collapsed: false,
  });
  mkdirSync(path.join(userDataDir, 'workspaces', workspaceId, 'home'), {
    recursive: true,
  });
  const activityId = 'automation-start-cowork';
  const automationName = 'Morning digest';
  const prompt = 'AUTOMATION_START_COWORK summarize this morning.';
  seedPromptAutomation(userDataDir, {
    id: activityId,
    name: automationName,
    action: { type: 'standalone_prompt', chatProjectId: workspaceId, prompt },
  });
  const fixture = createFixture('staged', AUTOMATION_START_REPLY);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const result = await runAutomationNow(window, userDataDir, activityId);
    expect(result).toMatchObject({ projectId: workspaceId });
    // A new Cowork chat gets its own Work Entry keyed by the chat id.
    const entryId = result.standaloneChatId;

    const openEntry = async () => {
      await app.openChatPage();
      await window.getByTestId(`sidebar-work-entry-${entryId}`).click();
    };
    const expected = {
      window,
      scope: window.getByTestId('page-chat'),
      projectId: workspaceId,
      worktreeId: entryId,
      chatId: result.standaloneChatId,
      automationName,
      prompt,
      fixture,
    };
    await openEntry();
    await expectSingleAutomationChat(expected);

    await window.reload();
    await app.waitForShell();
    await openEntry();
    await expectSingleAutomationChat(expected);
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('Run now into App Advisor opens one Work Entry chat with the automation banner, kept after reload', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-start-advisor-'),
  );
  const activityId = 'automation-start-advisor';
  const automationName = 'Advisor weekly check';
  const prompt = 'AUTOMATION_START_ADVISOR check this week.';
  seedPromptAutomation(userDataDir, {
    id: activityId,
    name: automationName,
    action: { type: 'app_advisor_prompt', prompt },
  });
  const fixture = createFixture('staged', AUTOMATION_START_REPLY);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: fixture.env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const result = await runAutomationNow(window, userDataDir, activityId);
    // The quick prompt creates the Work Entry under the chat's own id.
    const entryId = result.appAdvisorChatId;
    expect(entryId).toBeTruthy();

    const advisor = await waitForAppAdvisorPage(electronApp);
    const expected = {
      window,
      scope: advisor,
      projectId: 'app-advisor',
      worktreeId: entryId,
      chatId: result.appAdvisorChatId,
      automationName,
      prompt,
      fixture,
    };
    await expect(
      advisor.getByTestId(`app-advisor-nav-entry-${entryId}`),
    ).toBeVisible({ timeout: 30_000 });
    await expectSingleAutomationChat(expected);

    // Reloading the App Advisor window rebuilds it from canonical state.
    await advisor.reload();
    const reloaded = await waitForAppAdvisorPage(electronApp);
    await reloaded.getByTestId(`app-advisor-nav-entry-${entryId}`).click();
    await expectSingleAutomationChat({ ...expected, scope: reloaded });
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});
