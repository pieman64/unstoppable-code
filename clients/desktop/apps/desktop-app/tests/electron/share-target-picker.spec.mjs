import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startRunCommentsCloudMock } from './runCommentsCloudMock.mjs';
import {
  registerShareMembership,
  seedAgentModels,
  seedAutomations,
  seedObservabilityAudit,
  seedStoredPipeline,
  seedTrackedPlans,
  seedWorktreeChat,
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';

// Every share surface renders the same scope selector and the same team /
// organization picker (`ShareScopeSelector` + `OrgTeamPicker` from
// `@canopy/ui-shared`): a search field, one row per target with an initials
// avatar, and a check-circle selection indicator. This walks the automation,
// pipeline, agent, collection, skill, plan and session (run) share dialogs and
// proves each one picks a team and an organization the same way.
//
// This spec installs account-scoped list fixtures at the two IPC handlers so
// the performance study's immutable shared mock server remains unchanged.
// Session sharing additionally requires `runs-crud-v1`, which that shared
// server does not advertise, so the plan/session test points the app at the
// per-test run mock (`runCommentsCloudMock.mjs`) that `run-comments.spec.mjs`
// uses.
//
// Team and Organization are only selectable for an account that belongs to
// an organization and a team, so each test also makes the signed-in account
// report the same membership the picker fixtures list.
//
// Testids exercised:
//   - `share-{surface}-scope`                          -> scope radiogroup
//   - `share-{surface}-{team|organization}-picker`     -> picker root
//   - `share-{surface}-{kind}-picker-option-{id}`      -> picker row
//   - `shared-target-picker-selection-indicator`       -> row check circle

const API_KEY = 'csk_share_target_picker_e2e';
const PIPELINE_ID = 'picker-code-review';
const PIPELINE_NAME = 'Picker Code Review';
const AUTOMATION_ID = 'picker-nightly-review';
const AGENT_ID = 'agent_model_picker_reviewer';
const COLLECTION_NAME = 'Picker Collection';
const DEMO_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const DEMO_WORKTREE_ID = 'demo-main';
const PLAN_ID = 'plan-picker';
const PLAN_TITLE = 'Picker plan';
const CHAT_ID = 'picker-session';
const TURN_BASE_MS = Date.parse('2026-08-11T09:00:00.000Z');

const TEAM = {
  id: '55555555-5555-4555-8555-555555555551',
  name: 'Platform',
  organization: 'Acme Robotics',
};
const ORGANIZATION = {
  id: '44444444-4444-4444-8444-444444444442',
  name: 'Globex Research',
};

const MEMBERSHIP_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const GLOBEX_ORGANIZATION = {
  id: ORGANIZATION.id,
  name: ORGANIZATION.name,
  role: 'MEMBER',
  createdAt: MEMBERSHIP_TIMESTAMP,
  updatedAt: MEMBERSHIP_TIMESTAMP,
};
/**
 * The account's membership as `/account` reports it, matching the picker
 * fixtures below: Acme Robotics (with Platform) and Globex Research (with
 * Design Systems).
 */
const SHARE_MEMBERSHIP = {
  organizations: [SHARE_MEMBERSHIP_ORGANIZATION, GLOBEX_ORGANIZATION],
  teams: [
    SHARE_MEMBERSHIP_TEAM,
    {
      id: '55555555-5555-4555-8555-555555555552',
      name: 'Design Systems',
      organization: {
        id: GLOBEX_ORGANIZATION.id,
        name: GLOBEX_ORGANIZATION.name,
        createdAt: MEMBERSHIP_TIMESTAMP,
        updatedAt: MEMBERSHIP_TIMESTAMP,
      },
      createdAt: MEMBERSHIP_TIMESTAMP,
      updatedAt: MEMBERSHIP_TIMESTAMP,
    },
  ],
};

async function installShareTargetFixtures(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const organizations = [
      {
        id: '44444444-4444-4444-8444-444444444441',
        name: 'Acme Robotics',
      },
      {
        id: '44444444-4444-4444-8444-444444444442',
        name: 'Globex Research',
      },
    ];
    const teams = [
      {
        id: '55555555-5555-4555-8555-555555555551',
        name: 'Platform',
        organization: organizations[0],
      },
      {
        id: '55555555-5555-4555-8555-555555555552',
        name: 'Design Systems',
        organization: organizations[1],
      },
    ];
    for (const [channel, targets] of [
      ['pipelines:shared-organizations-list', organizations],
      ['pipelines:shared-teams-list', teams],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, request = {}) => {
        const query = (request.q ?? '').trim().toLowerCase();
        return {
          success: true,
          data: {
            serverId: 'share-target-picker-e2e',
            data: query
              ? targets.filter((target) =>
                  target.name.toLowerCase().includes(query),
                )
              : targets,
          },
        };
      });
    }
  });
}

function seedShareFixtures(userDataDir) {
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: AUTOMATION_ID,
        name: 'Nightly picker review',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'ws-picker',
          pipelineId: PIPELINE_ID,
          pipelineSource: 'user',
          pipelineName: PIPELINE_NAME,
          inputs: {},
        },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  seedAgentModels(userDataDir, [
    {
      id: AGENT_ID,
      name: 'Picker Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review shared changes carefully.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  ]);
}

/** Seeds a tracked plan and a completed, recently audited chat turn. */
function seedPlanAndSessionFixtures(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const planCreatedAt = '2026-06-11T12:00:00.000Z';
  const planContent = `# ${PLAN_TITLE}\n\n- Share through the standard picker.`;
  seedTrackedPlans({
    userDataDir,
    workspaceId: DEMO_WORKSPACE_ID,
    worktreeId: DEMO_WORKTREE_ID,
    plans: [
      {
        id: PLAN_ID,
        projectId: DEMO_WORKSPACE_ID,
        worktreeId: DEMO_WORKTREE_ID,
        source: 'claude',
        title: PLAN_TITLE,
        content: planContent,
        reviewStatus: 'pending',
        createdAt: planCreatedAt,
        updatedAt: planCreatedAt,
        latestRevisionNumber: 1,
        revisions: [
          {
            revisionNumber: 1,
            content: planContent,
            source: 'claude',
            reviewStatus: 'pending',
            createdAt: planCreatedAt,
          },
        ],
        linkedExecutionIds: [],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: DEMO_WORKSPACE_ID,
    worktreeId: DEMO_WORKTREE_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Picker session',
        providerType: 'claude',
        messages: [
          {
            id: 'turn-1-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Please review this run.' }],
            timestamp: TURN_BASE_MS,
          },
          {
            id: 'turn-1-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Seeded picker transcript.' }],
            timestamp: TURN_BASE_MS + 5_000,
          },
          {
            id: 'turn-1-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: TURN_BASE_MS,
                completedAt: TURN_BASE_MS + 90_000,
              },
            ],
            timestamp: TURN_BASE_MS + 6_000,
          },
        ],
      },
    ],
  });
  // Session sharing is built from recorded activity, so the session needs a
  // recent audit entry or the dialog shows the aged-out explanation instead
  // of the scope selector.
  const nowMs = Date.now();
  seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: 'share-picker-audit-1',
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'claude',
        label: 'Seeded shareable turn',
        startedAt: new Date(nowMs - 15 * 60_000).toISOString(),
        completedAt: new Date(nowMs - 14 * 60_000).toISOString(),
        durationMs: 60_000,
        model: 'claude-sonnet-4-6',
        tokens: {
          input: 1200,
          output: 300,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: {},
        projectId: DEMO_WORKSPACE_ID,
        worktreeId: DEMO_WORKTREE_ID,
        chatId: CHAT_ID,
        hasTranscript: false,
      },
    ],
  });
}

/**
 * Picks a target on one scope and asserts the standardized picker chrome: the
 * search field, the row's initials avatar and secondary label, and the check
 * indicator filling on selection.
 */
async function pickTarget(modal, prefix, { scopeLabel, kind, target }) {
  const scope = modal.getByTestId(`${prefix}-scope`);
  const radio = scope.getByRole('radio', { name: scopeLabel, exact: true });
  await expect(radio).toBeEnabled();
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');

  const picker = modal.getByTestId(`${prefix}-${kind}-picker`);
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('searchbox')).toHaveAttribute(
    'placeholder',
    kind === 'team' ? 'Search teams…' : 'Search organizations…',
  );

  const row = picker.getByTestId(
    `${prefix}-${kind}-picker-option-${target.id}`,
  );
  await expect(row).toBeVisible();
  await expect(row).toContainText(target.name);
  if (target.organization) {
    await expect(row).toContainText(target.organization);
  }
  // The initials avatar is decorative and sits before the name.
  await expect(row.locator('span[aria-hidden="true"]').first()).toHaveText(
    /^[A-Z0-9]{1,2}$/i,
  );

  const indicator = row.getByTestId('shared-target-picker-selection-indicator');
  await expect(indicator).toHaveAttribute('data-selected', 'false');
  await row.click();
  await expect(indicator).toHaveAttribute('data-selected', 'true');
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

const AUDIENCE_LABELS = {
  team: 'Team',
  organization: 'Organization',
  public: 'Public',
};

/**
 * The cross-modal contract: every resource renders the one share dialog, so
 * the heading, the offered audiences (in the fixed order), and the canonical
 * control ids are identical apart from the prefix.
 */
async function expectStandardShell(modal, prefix, { noun, offered }) {
  await expect(
    modal.getByRole('heading', { name: `Share ${noun}`, exact: true }),
  ).toBeVisible();
  const scope = modal.getByTestId(`${prefix}-scope`);
  await expect(scope).toBeVisible({ timeout: 30_000 });
  await expect(scope.getByRole('radio')).toHaveText(
    offered.map((audience) => AUDIENCE_LABELS[audience]),
  );
  for (const audience of offered) {
    await expect(modal.getByTestId(`${prefix}-scope-${audience}`)).toHaveCount(
      1,
    );
  }
  // No share dialog offers a Private audience.
  await expect(modal.getByTestId(`${prefix}-scope-private`)).toHaveCount(0);
  await expect(modal.getByTestId(`${prefix}-cancel`)).toHaveCount(0);
  await expect(
    modal.getByRole('button', { name: 'Close', exact: true }),
  ).toBeVisible();
  await expect(modal.getByTestId(`${prefix}-submit`)).toBeVisible();
  await expect(modal.getByTestId(`${prefix}-confirm`)).toHaveCount(0);
}

const ALL_AUDIENCES = ['team', 'organization', 'public'];
const SCOPED_AUDIENCES = ['team', 'organization'];

async function expectStandardPickers(modal, prefix) {
  await pickTarget(modal, prefix, {
    scopeLabel: 'Organization',
    kind: 'organization',
    target: ORGANIZATION,
  });
  await pickTarget(modal, prefix, {
    scopeLabel: 'Team',
    kind: 'team',
    target: TEAM,
  });
}

test('every share dialog picks teams and organizations with the same picker', async () => {
  await registerShareMembership(API_KEY, SHARE_MEMBERSHIP);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'share-target-picker-e2e-'),
  );
  seedShareFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      API_KEY,
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Share picker account did not connect',
    ).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await installShareTargetFixtures(electronApp);

    // Automation: also proves search narrows the list through the shared
    // debounced loader.
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(AUTOMATION_ID),
      'share',
    );
    const automationModal = window.getByTestId('share-automation-modal');
    await expect(automationModal).toBeVisible();
    await expectStandardShell(automationModal, 'share-automation', {
      noun: 'automation',
      offered: ALL_AUDIENCES,
    });
    await expectStandardPickers(automationModal, 'share-automation');
    await automationModal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Organization', exact: true })
      .click();
    const orgPicker = automationModal.getByTestId(
      'share-automation-organization-picker',
    );
    await expect(orgPicker.locator('li')).toHaveCount(2);
    await orgPicker.getByRole('searchbox').fill('acme');
    await expect(orgPicker.locator('li')).toHaveCount(1);
    await expect(orgPicker.locator('li')).toContainText('Acme Robotics');
    await automationModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(automationModal).toBeHidden();

    // Pipeline (formerly a boxed, avatar-less private copy).
    await app.openPipelinesPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryPipelineRow(PIPELINE_ID),
      'share',
    );
    const pipelineModal = window.getByTestId('share-pipeline-modal');
    await expect(pipelineModal).toBeVisible();
    await expectStandardShell(pipelineModal, 'share-pipeline', {
      noun: 'pipeline',
      offered: ALL_AUDIENCES,
    });
    await expectStandardPickers(pipelineModal, 'share-pipeline');
    await pipelineModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(pipelineModal).toBeHidden();

    // Agent. Runs before the Plugins-page surfaces: the Plugins page replaces
    // the sidebar, so the Agents entry is not reachable from there.
    await app.openMarketplaceAgents();
    await app.openLocalAgentShare(AGENT_ID);
    const agentModal = window.getByTestId('share-agent-modal');
    await expect(agentModal).toBeVisible();
    await expectStandardShell(agentModal, 'share-agent', {
      noun: 'agent',
      offered: ALL_AUDIENCES,
    });
    await expectStandardPickers(agentModal, 'share-agent');
    await agentModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(agentModal).toBeHidden();

    // Collection (formerly a boxed, avatar-less private copy). Collections
    // are created through the UI, as `collections-actions-icons.spec.mjs`
    // does, so the row's Share action opens the real modal.
    await app.openPluginsPage();
    await app.openPluginsTab('collections');
    await app.expectPluginsTab('collections');
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeVisible();
    await window.getByPlaceholder('My collection').fill(COLLECTION_NAME);
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#collection-modal-title')).toBeHidden({
      timeout: 5000,
    });
    await window
      .getByRole('button', { name: 'Share collection' })
      .first()
      .click();
    const collectionModal = window.getByTestId('share-collection-modal');
    await expect(collectionModal).toBeVisible();
    await expectStandardShell(collectionModal, 'share-collection', {
      noun: 'collection',
      offered: ALL_AUDIENCES,
    });
    await expectStandardPickers(collectionModal, 'share-collection');
    await collectionModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(collectionModal).toBeHidden();

    // Skill (the ui-app ShareResourceDialog shared with the web portal).
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');
    await window
      .locator('[data-testid^="skill-share-builtin"]')
      .first()
      .click();
    const skillModal = window.getByTestId('share-skill-modal');
    await expect(skillModal).toBeVisible();
    await expectStandardShell(skillModal, 'share-skill', {
      noun: 'skill',
      offered: ALL_AUDIENCES,
    });
    await expectStandardPickers(skillModal, 'share-skill');
    await skillModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(skillModal).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('plan and session share dialogs pick teams and organizations with the same picker', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'share-target-picker-plan-run-e2e-'),
  );
  seedPlanAndSessionFixtures(userDataDir);
  const cloud = await startRunCommentsCloudMock(SHARE_MEMBERSHIP);
  let electronApp;

  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      API_KEY,
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Share picker account did not connect',
    ).toMatchObject({ authenticated: true });
    expect(saveResult.account.capabilities).toEqual(
      expect.arrayContaining([
        'plans-crud-v1',
        'runs-crud-v1',
        'teams-v1',
        'organizations-v1',
      ]),
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await installShareTargetFixtures(electronApp);

    await app.selectWorktree(DEMO_WORKTREE_ID);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible({ timeout: 30_000 });

    // Plan: the activity card's Share action.
    await expect(
      window.getByTestId(`activity-plan-row-${PLAN_ID}`),
    ).toContainText(PLAN_TITLE, { timeout: 30_000 });
    await window.getByTestId(`activity-plan-${PLAN_ID}-share`).click();
    const planModal = window.getByTestId('share-plan-modal');
    await expect(planModal).toBeVisible();
    await expect(planModal.getByTestId('share-plan-scope')).toBeVisible({
      timeout: 30_000,
    });
    await expectStandardShell(planModal, 'share-plan', {
      noun: 'plan',
      offered: SCOPED_AUDIENCES,
    });
    await expectStandardPickers(planModal, 'share-plan');
    await expect(planModal.getByTestId('share-plan-submit')).toBeEnabled();
    await planModal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(planModal).toBeHidden();

    // Session: the completed turn's Share control.
    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 30_000,
    });
    const shareControl = window.getByTestId('turn-share-session');
    await expect(shareControl).toHaveAttribute('data-shared', 'false', {
      timeout: 30_000,
    });
    await shareControl.click();
    const runModal = window.getByTestId('share-run-modal');
    await expect(runModal).toBeVisible({ timeout: 30_000 });
    await expect(runModal.getByTestId('share-run-scope')).toBeVisible({
      timeout: 30_000,
    });
    await expect(runModal.getByTestId('share-run-unavailable')).toHaveCount(0);
    await expect(runModal.getByTestId('share-run-upgrade')).toHaveCount(0);
    await expectStandardShell(runModal, 'share-run', {
      noun: 'session',
      offered: SCOPED_AUDIENCES,
    });
    await expectStandardPickers(runModal, 'share-run');
    await expect(runModal.getByTestId('share-run-submit')).toBeEnabled();
    await runModal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(runModal).toBeHidden();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
