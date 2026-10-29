import { mkdtempSync, rmSync } from 'node:fs';
import {
  createFixture as createCodexFixture,
  protocolRequests,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import {
  seedAutomationTargetPipeline,
  seedAutomationTargetProjects,
} from './automationTargetFixtures.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  registerShareMembership,
  seedAutomations,
} from './seeders/index.mjs';

const SHAREABLE_ID = 'shareable-nightly-review';
const SESSION_ID = 'portable-session-prompt';
const RESUME_ID = 'execution-resume';
const UNRESOLVED_INVOCATION_ID = 'prompt-invalid-skill';
const FULL_ACCESS_ID = 'full-access-inbox-sweep';
const FULL_ACCESS_NAME = 'Full access inbox sweep';
// Tailwind `max-w-lg` (32rem at the 16px root), the width SharePipelineModal
// uses. Kept as a number so a drift in either modal fails loudly here.
const PIPELINE_SHARE_MODAL_MAX_WIDTH_PX = 512;
const SECRET_INPUT_VALUE = 'ghp_secretTicketToken';
const SECRET_IF_COMMAND = 'curl -H "Authorization: Bearer sk-SECRET"';
const SECRET_WORKSPACE_ID = 'demo-ts-pnpm-vite';
// The description is one field shared by every scope, so its placeholder must
// never name an audience. Pinned here because the regression is invisible to
// type checking: scope-specific copy reads fine until a public share shows it.
const DESCRIPTION_PLACEHOLDER =
  'Describe what this automation does (optional).';
// There is no Private audience; `private` is only the storage value behind a
// public share.
const SHARE_SCOPES = ['Team', 'Organization', 'Public'];

function seedAutomationShareFixtures(userDataDir) {
  seedAutomationTargetProjects(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: 'cowork-session-share',
        name: 'Cowork session summary',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'seeded-cowork',
          worktreeId: 'home',
          chatId: 'seeded-cowork-chat',
          prompt: 'Summarize today.',
          planMode: true,
        },
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: SHAREABLE_ID,
        name: 'Nightly review pipeline',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: SECRET_WORKSPACE_ID,
          pipelineId: 'local-code-review',
          pipelineSource: 'user',
          pipelineName: 'Code Review',
          inputs: { ticket: SECRET_INPUT_VALUE, branch: 'develop' },
          modelAliasPreferences: {
            reviewer: { mode: 'inline', base: 'sonnet' },
          },
        },
        ifCommand: SECRET_IF_COMMAND,
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: SESSION_ID,
        name: 'Resume worktree chat',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2027-01-01T09:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          worktreeId: 'wt-private-5678',
          chatId: 'chat-1',
          prompt: 'Continue where we left off.',
        },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: UNRESOLVED_INVOCATION_ID,
        name: 'Automation naming a missing skill',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        // No `pluginSelections` at all, and the only dependency signal is the
        // prompt itself — the shape that used to share clean with no warning.
        action: {
          type: 'worktree_session_prompt',
          workspaceId: SECRET_WORKSPACE_ID,
          worktreeId: 'wt-private-5678',
          chatId: 'chat-2',
          prompt: 'Say hello with /invalid-skill name',
        },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: FULL_ACCESS_ID,
        name: FULL_ACCESS_NAME,
        enabled: true,
        schedule: { kind: 'cron', expression: '0 7 * * *', timezone: 'local' },
        // The approval mode is the only chat setting on the action: the shape
        // that used to block sharing with no way to clear it in the editor.
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'cowork-private-1',
          prompt: 'Sweep the inbox and file what you find.',
          approvalMode: 'full-access',
        },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
      {
        version: 1,
        id: RESUME_ID,
        name: 'Resume pipeline execution',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2027-01-01T10:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'pipeline_execution_resume',
          executionId: 'execution-private-1',
          statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
          provider: 'claude',
          purpose: 'usage_limit_resume',
          pipelineName: 'Release',
        },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  seedAutomationTargetPipeline(userDataDir, 'local-code-review');
}

test('saves an existing unpinned shared-pipeline automation from the editor', async () => {
  const apiKey = 'csk_unpinned_authoring';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      sharedPipelines: [
        {
          id: 'shared-dual',
          name: 'Shared Dual Trigger Pipeline',
          description: 'Authoring regression fixture',
          icon: '',
          version: '1',
          triggerTypes: ['dispatch'],
          shareScope: 'private',
          createdBy: { id: 'account-e2e', name: 'Portal E2E' },
          createdAt: '2026-10-06T00:00:00.000Z',
          updatedAt: '2026-10-06T00:00:00.000Z',
          canUpdate: true,
          canDelete: true,
          rawPipeline:
            'name: Shared\non: dispatch\nscope: directory\njobs: {}\n',
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-shared-pipeline-authoring-e2e-'),
  );
  seedAutomationTargetProjects(userDataDir);
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: 'unpinned-shared-pipeline',
        name: 'Unpinned shared pipeline',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'seeded-cowork',
          pipelineId: 'shared:canopy-cloud:shared-dual',
          pipelineSource: 'shared',
          pipelineName: 'Shared Dual Trigger Pipeline',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'shared-dual',
          },
        },
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      apiKey,
    );
    await app.openAutomationsPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow('unpinned-shared-pipeline'),
    );
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await window
      .getByTestId('automations-form-name')
      .fill('Edited shared pipeline');
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    const snapshot = await window.evaluate(() => window.api.automations.list());
    expect(
      snapshot.activities.find(
        (entry) => entry.id === 'unpinned-shared-pipeline',
      ),
    ).toMatchObject({ name: 'Edited shared pipeline', enabled: false });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('CAN-3734: explicitly resets a narrowed pipeline requirement when changing to App Advisor', async () => {
  const apiKey = 'csk_can3734_publish_reset';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-declaration-reset-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const initial = {
    version: 1,
    id: 'narrowed-local',
    name: 'Narrowed local pipeline',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    targetRequirement: { contexts: ['worktree'] },
    action: {
      type: 'worktree_pipeline',
      workspaceId: SECRET_WORKSPACE_ID,
      pipelineId: 'local-code-review',
      pipelineSource: 'user',
      pipelineName: 'Code Review',
    },
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    failureCount: 0,
  };
  seedAutomations({ userDataDir, activities: [initial] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow('narrowed-local'),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();
    await expect(modal.getByTestId('share-automation-consent')).toHaveCount(0);
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal).toBeHidden();
    const published = await window.evaluate(async () => {
      const { activities } = await window.api.automations.list();
      const local = activities.find((entry) => entry.id === 'narrowed-local');
      return window.api.automations.getShared(local.remote.remoteId);
    });
    expect(published.automation.targetRequirement).toEqual({
      contexts: ['worktree'],
    });
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryAutomationRow('narrowed-local'),
    );
    await window
      .getByTestId('automations-form-action-type-app_advisor')
      .click();
    await window.getByTestId('automations-form-prompt').fill('Review today.');
    await expect(
      window.getByTestId('automations-form-target-reset'),
    ).toBeVisible();
    await window.getByTestId('automations-form-target-reset').click();
    await window.getByTestId('automations-form-prompt').fill('Review today.');
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    const snapshot = await window.evaluate(() => window.api.automations.list());
    const saved = snapshot.activities.find((entry) => entry.id === initial.id);
    expect(saved?.action.type).toBe('app_advisor_prompt');
    expect(saved?.targetRequirement).toBeUndefined();
    expect(saved?.targetRequirementCleared).toBe(true);
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow('narrowed-local'),
      'share',
    );
    await expect(window.getByTestId('share-automation-blockers')).toHaveCount(
      0,
    );
    await expect(modal.getByTestId('share-automation-consent')).toHaveCount(0);
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal).toBeHidden();
    const republished = await window.evaluate(
      (id) => window.api.automations.getShared(id),
      published.id,
    );
    expect(republished.automation.action.type).toBe('app_advisor_prompt');
    expect(republished.automation).not.toHaveProperty('targetRequirement');
    expect(republished.automation).not.toHaveProperty(
      'targetRequirementCleared',
    );
    expect(republished.id).toBe(published.id);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('shares downgraded automations and hides Share for execution resumes', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-share-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_automation_share_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await app.openAutomationsPage();

    // Share is an item of the row's More menu in Workflows › Library.
    const shareableRow = app.workflowsLibraryAutomationRow(SHAREABLE_ID);
    await expect(shareableRow).toBeVisible();
    await app.chooseWorkflowsLibraryRowAction(shareableRow, 'share');
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();

    // CAN-3959: a run-condition command that may hold a secret starts off;
    // the author reviews it under More details and opts in to share it.
    const advancedToggle = modal.getByTestId(
      'share-automation-advanced-toggle',
    );
    await expect(advancedToggle).toHaveText(
      'More details · May contain a secret, kept private',
    );
    // Where it runs and what stays private sit under More details. This
    // pipeline copies no files, so there is no Included files section at all.
    for (const id of [
      // A pipeline that runs in both contexts offers narrowing in place of
      // the Runs in line.
      'share-automation-target-narrowing',
      'share-automation-notices',
    ]) {
      await expect(modal.getByTestId(id)).toHaveCount(0);
    }
    await advancedToggle.click();
    const details = modal.getByTestId('share-automation-advanced-body');
    for (const id of [
      'share-automation-target-narrowing',
      'share-automation-notices',
    ]) {
      await expect(details.getByTestId(id)).toBeVisible();
    }
    await expect(
      modal.getByTestId('share-automation-dependencies'),
    ).toHaveCount(0);
    await expect(modal).not.toContainText('Included files');
    const runCondition = modal.getByTestId('share-automation-run-condition');
    await expect(
      runCondition.getByTestId('share-automation-run-condition-command'),
    ).toHaveText(SECRET_IF_COMMAND);
    await expect(
      runCondition.getByTestId('share-automation-run-condition-secret-off'),
    ).toHaveText("The command may contain a secret, so it's off by default.");
    await runCondition
      .getByTestId('share-automation-include-run-condition')
      .check();
    await expect(
      runCondition.getByTestId('share-automation-run-condition-warnings'),
    ).toContainText('The command may contain a secret.');
    // The shared document sits below the checkbox in the same disclosure.
    const preview = window.getByTestId('share-automation-preview');
    const includedPreviewText = await preview.innerText();
    expect(includedPreviewText).toContain('"version": 4');
    expect(includedPreviewText).toContain('"runCondition"');
    expect(includedPreviewText).toContain('sk-SECRET');
    await expect(
      window.getByTestId('share-automation-notices'),
    ).not.toContainText('run-condition command');

    // Unchecking restores the strip: no command, and the notice says so.
    await runCondition
      .getByTestId('share-automation-include-run-condition')
      .uncheck();
    await expect(
      runCondition.getByTestId('share-automation-run-condition-warnings'),
    ).toHaveCount(0);
    const notices = window.getByTestId('share-automation-notices');
    await expect(notices).toContainText('run-condition command');
    await expect(notices).toContainText('input values');
    await expect(notices).toContainText('model preferences');
    await expect(notices).toContainText('project and worktree bindings');
    await expect(notices).toContainText(
      'pipeline definition travels with this automation',
    );
    await expect(notices).not.toContainText('only exists on this machine');
    await expect(preview).not.toContainText('"version": 4');
    const previewText = await preview.innerText();
    expect(previewText).toContain('"inputKeys"');
    expect(previewText).toContain('"hasRunCondition": true');
    for (const secret of [
      SECRET_INPUT_VALUE,
      SECRET_IF_COMMAND,
      SECRET_WORKSPACE_ID,
      'sk-SECRET',
      'modelAliasPreferences',
    ]) {
      expect(previewText).not.toContain(secret);
    }

    await expect(modal.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
    await app.chooseWorkflowsLibraryRowAction(shareableRow, 'share');
    await expect(modal).toBeVisible();
    // Escape dismisses the share dialog now that there is no footer Cancel.
    await window.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(SESSION_ID),
      'share',
    );
    await expect(modal).toBeVisible();
    await expect(window.getByTestId('share-automation-blocked')).toHaveCount(0);
    await window.getByTestId('share-automation-advanced-toggle').click();
    await expect(window.getByTestId('share-automation-notices')).toContainText(
      'original chat and its history stay on this machine',
    );
    const sessionPreview = window.getByTestId('share-automation-preview');
    await expect(sessionPreview).toContainText('worktree_prompt');
    await expect(sessionPreview).not.toContainText('chat-1');
    await window
      .getByTestId('share-automation-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    // The resume row's More menu lists its other items but no Share.
    await app
      .workflowsLibraryAutomationRow(RESUME_ID)
      .getByTestId('workflows-library-menu')
      .click();
    await expect(
      window.getByTestId('workflows-library-menu-item-edit'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workflows-library-menu-item-share'),
    ).toHaveCount(0);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// An approval mode cannot travel: a share must never hand a recipient an
// automation that runs with full access without them choosing that. It is
// dropped from the shared copy and named in the notices, not refused.
test('shares an automation that pins an approval mode and leaves the mode behind', async () => {
  const apiKey = 'csk_share_approval_mode_e2e';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-share-approval-mode-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(FULL_ACCESS_ID),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();

    await modal.getByTestId('share-automation-advanced-toggle').click();
    const preview = modal.getByTestId('share-automation-preview');
    await expect(preview).toBeVisible();
    await expect(modal.getByTestId('share-automation-blockers')).toHaveCount(0);
    await expect(modal.getByTestId('share-automation-notices')).toContainText(
      'The approval mode stays on this machine',
    );
    await expect(preview).toContainText('standalone_prompt');
    await expect(preview).not.toContainText('full-access');
    await expect(preview).not.toContainText('approvalMode');

    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal).toHaveCount(0);

    // The share is a snapshot: the publisher keeps the mode they chose.
    const local = await window.evaluate(async (id) => {
      const snapshot = await window.api.automations.list();
      return snapshot.activities.find((activity) => activity.id === id);
    }, FULL_ACCESS_ID);
    expect(local?.action).toMatchObject({ approvalMode: 'full-access' });
    expect(local?.remote).toBeTruthy();

    // What the server stored is what a recipient installs from.
    const shared = await window.evaluate(async (remoteId) => {
      const detail = await window.api.automations.getShared(remoteId);
      return detail.automation;
    }, local.remote.remoteId);
    expect(shared.action).toEqual({
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Sweep the inbox and file what you find.',
      plugins: [],
    });

    // The publisher finds their share under Marketplace › Automations ›
    // "Shared by me", which replaced the Automations Shared tab (CAN-3980).
    // Marketplace cards title-case names.
    await app.openSharedByMeAutomations();
    await expect(
      window
        .getByTestId('customize-section-shared-by-me')
        .getByTestId(
          `customize-row-automation:shared:${local.remote.remoteId}`,
        ),
    ).toContainText(new RegExp(FULL_ACCESS_NAME, 'i'));
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// The seeded profile has no installed skills or plugins, so `/invalid-skill`
// cannot resolve against the invocable inventory and the analyzer's verdict is
// deterministic without any network or agent activity.
test('reports an unresolvable prompt dependency before an automation is shared', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-share-deps-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_automation_dependency_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await app.openAutomationsPage();

    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(UNRESOLVED_INVOCATION_ID),
      'share',
    );
    const shareModal = window.getByTestId('share-automation-modal');
    await expect(shareModal).toBeVisible();

    // Standardized on SharePipelineModal's width: both dialogs host the same
    // capability package dependency review. Measured rather than asserted from
    // the class name, since a `max-w-*` utility can be overridden in the
    // cascade without the class disappearing.
    expect(
      await shareModal.evaluate(
        (element) => getComputedStyle(element).maxWidth,
      ),
    ).toBe(`${PIPELINE_SHARE_MODAL_MAX_WIDTH_PX}px`);

    const problems = window.getByTestId('share-automation-dependency-problems');
    await expect(problems).toBeVisible();
    await expect(problems).toHaveAttribute('data-problem-count', '1');
    await expect(problems).toContainText('/invalid-skill');

    // Dismissing re-runs the main-process analysis rather than editing the
    // list locally, so the share becomes publishable only once main agrees.
    await window
      .getByTestId(
        'share-automation-dependency-problems-dismiss-unresolved-invocation-invalid-skill',
      )
      .click();
    await expect(problems).toHaveAttribute('data-problem-count', '0');
    await expect(problems).toHaveAttribute('data-dismissed-count', '1');

    await window
      .getByTestId('share-automation-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('share-automation-modal')).toBeHidden();

    // Dismissals are persisted by automation scope, not only for the lifetime
    // of one modal instance.
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(UNRESOLVED_INVOCATION_ID),
      'share',
    );
    const reopenedProblems = window.getByTestId(
      'share-automation-dependency-problems',
    );
    await expect(reopenedProblems).toHaveAttribute('data-problem-count', '0');
    await expect(reopenedProblems).toHaveAttribute('data-dismissed-count', '1');
    await window
      .getByTestId('share-automation-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('uses one audience-neutral description placeholder for every share scope', async () => {
  // Team and Organization are only selectable for a member of one.
  await registerShareMembership('csk_share_description_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-share-description-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // An authenticated account is what reveals the scope selector; without it
    // the dialog stops at the account-state notice and no scope is selectable.
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_share_description_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(SHAREABLE_ID),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();

    const description = modal.getByTestId('share-automation-description');
    const scopes = modal.getByTestId('share-automation-scope');
    await expect(scopes.getByRole('radio')).toHaveCount(SHARE_SCOPES.length);
    await expect(scopes.getByRole('radio', { name: 'Private' })).toHaveCount(0);
    for (const label of SHARE_SCOPES) {
      const option = scopes.getByRole('radio', { name: label });
      await expect(option).toBeEnabled();
      await option.click();
      await expect(option).toHaveAttribute('aria-checked', 'true');
      await expect(description).toHaveAttribute(
        'placeholder',
        DESCRIPTION_PLACEHOLDER,
      );
    }

    await window
      .getByTestId('share-automation-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(modal).toBeHidden();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// A share description is authored in a plain textarea, so paragraphs and a
// numbered list arrive as newline-separated Markdown. The Shared tab preview
// must render that structure, and the compact row must show clean text.
const MARKDOWN_DESCRIPTION = [
  'Reviews every open branch overnight.',
  'Posts findings to the team.',
  '',
  '1. Checks out the branch',
  '2. Runs the **review** pipeline',
  '3. Posts a summary',
].join('\n');

test('renders a Markdown share description in Marketplace Shared by me', async () => {
  const apiKey = 'csk_share_markdown_description_e2e';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-share-markdown-e2e-'),
  );
  seedAutomationShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(SHAREABLE_ID),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();
    await expect(
      modal.getByTestId('share-automation-description-hint'),
    ).toHaveCount(0);
    await modal
      .getByTestId('share-automation-description')
      .fill(MARKDOWN_DESCRIPTION);
    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal).toHaveCount(0);

    const remoteId = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((activity) => activity.id === id)?.remote
        ?.remoteId;
    }, SHAREABLE_ID);
    expect(remoteId).toBeTruthy();
    // CAN-3980: the share lists under Marketplace › Automations › "Shared by
    // me", where its card subtitle is the description as plain text.
    await app.openSharedByMeAutomations();
    const card = window
      .getByTestId('customize-section-shared-by-me')
      .getByTestId(`customize-row-automation:shared:${remoteId}`);
    const subtitle = card;
    await expect(subtitle).toContainText(
      'Reviews every open branch overnight.',
    );
    await expect(subtitle).not.toContainText('**');

    await card.click();
    const description = window
      .getByTestId('shared-automation-preview')
      .getByTestId('share-description');
    await expect(description.locator('p').first()).toContainText(
      'Reviews every open branch overnight.',
    );
    await expect(description.locator('p br')).toHaveCount(1);
    await expect(description.locator('ol > li')).toHaveText([
      'Checks out the branch',
      'Runs the review pipeline',
      'Posts a summary',
    ]);
    await expect(description.locator('strong')).toHaveText('review');
    await expect(description).not.toContainText('**');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3734: Cowork session publishes a Cowork action and installs only into Cowork', async () => {
  const apiKey = 'csk_can3734_cowork_share';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3734-cowork-share-'),
  );
  seedAutomationShareFixtures(userDataDir);
  seedPreferences(userDataDir);
  const codexFixture = createCodexFixture('normal', 'Project summary complete');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: codexFixture.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow('cowork-session-share'),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await modal.getByTestId('share-automation-advanced-toggle').click();
    await expect(modal.getByTestId('share-automation-preview')).toBeVisible();
    await expect(modal.getByTestId('share-automation-notices')).toContainText(
      /plan mode/i,
    );
    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();
    await expect(modal.getByTestId('share-automation-consent')).toHaveCount(0);
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal).toBeHidden();
    const detail = await window.evaluate(async () => {
      const { activities } = await window.api.automations.list();
      const publisher = activities.find((a) => a.id === 'cowork-session-share');
      return window.api.automations.getShared(publisher.remote.remoteId);
    });
    expect(detail.automation.action).toMatchObject({
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
    });
    expect(detail.automation.version).toBe(1);
    expect(detail.automation.action.planMode).toBeUndefined();
    // The install-fixture seam is always mounted (CAN-3980), so the wizard
    // opens without first visiting a Shared surface.
    await window.evaluate(
      (d) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: {
              id: d.id,
              contentHash: d.contentHash,
              document: d.automation,
            },
          }),
        ),
      detail,
    );
    const picker = window.getByTestId('install-automation-cowork-project');
    await expect(picker.locator('option[value="seeded-cowork"]')).toHaveCount(
      1,
    );
    await expect(
      picker.locator('option[value="demo-ts-pnpm-vite"]'),
    ).toHaveCount(0);
    await picker.selectOption('seeded-cowork');
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();
    const installed = await window.evaluate(async () => {
      const { activities } = await window.api.automations.list();
      return activities.find((a) => a.installedFrom);
    });
    expect(installed.action).toMatchObject({
      type: 'standalone_prompt',
      chatProjectId: 'seeded-cowork',
    });
    const run = await window.evaluate(
      (id) => window.api.automations.runNow({ id }),
      installed.id,
    );
    expect(run).toMatchObject({ ok: true, run: { status: 'success' } });
    await expect
      .poll(
        () =>
          protocolRequests(codexFixture.logPath).find(
            (r) => r.method === 'thread/start',
          ),
        { timeout: 60_000 },
      )
      .toBeTruthy();
    const start = protocolRequests(codexFixture.logPath).find(
      (r) => r.method === 'thread/start',
    );
    expect(start.params.cwd).toContain('/workspaces/seeded-cowork/home');
    await window.evaluate(() =>
      window.api.deleteWorkspace({ workspaceId: 'seeded-cowork' }),
    );
    const staleRun = await window.evaluate(
      (id) => window.api.automations.runNow({ id }),
      installed.id,
    );
    expect(staleRun).toMatchObject({ ok: true, run: { status: 'failure' } });
    await window.evaluate(
      (d) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: {
              id: d.id,
              contentHash: d.contentHash,
              document: d.automation,
            },
          }),
        ),
      detail,
    );
    // Personal still has the default Chats project; the removed binding must
    // be refused even though its stale row was visible when the dialog opened.
    await picker.selectOption('seeded-cowork');
    await window.getByTestId('install-automation-submit').click();
    await expect(window.getByTestId('install-automation-error')).toBeVisible();
    await expect(picker).toHaveValue('');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    rmSync(codexFixture.runtimeDir, { recursive: true, force: true });
  }
});
