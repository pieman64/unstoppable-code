import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  seedStoredPipeline,
  seedTrackedPlans,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { planDocumentPanel } from './planPanelHarness.mjs';
import { expectPipelineRunPanel } from './pipelineUi.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

const WORKSPACE_ID = 'context-personal';
const WORKTREE_ID = 'linked-main';
const UNLINKED_WORKSPACE_ID = 'context-unlinked';
const PLAN_ID = 'linked-plan';
const CATALOG_PROJECT_ID = '33333333-3333-4333-8333-333333333334';
const CUSTOM_PIPELINE_NAME = "Aaron's Custom Method";
const SHARED_PIPELINE_NAME = "Aaron's Organization Method";
const REPLAY_PIPELINE_NAME = 'Organization Shared Replay';
const NOW = '2026-09-26T12:00:00.000Z';

const catalogProject = {
  id: CATALOG_PROJECT_ID,
  organizationId: ORG_CONTEXT_A,
  name: 'Linked catalog project',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'linked-project',
    providerRepoId: 'linked-project',
    defaultBranch: 'main',
    verification: 'VERIFIED',
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
};

const sharedPipeline = {
  id: 'aaaaaaaa-2962-4000-8000-000000000099',
  name: SHARED_PIPELINE_NAME,
  description: 'Organization plan-ready pipeline',
  icon: '',
  version: '1',
  triggerTypes: ['plan_ready'],
  scopes: ['worktree'],
  createdBy: { id: 'account-e2e', name: 'Portal E2E' },
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  createdAt: NOW,
  updatedAt: NOW,
  canUpdate: false,
  canDelete: false,
  distributionMode: 'definition_only',
  rawPipeline: [
    `name: ${SHARED_PIPELINE_NAME}`,
    'on: plan_ready',
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo organization-linked',
    '',
  ].join('\n'),
};

function seedUnlinkedPersonalWorkspace(userDataDir) {
  const repoPath = path.join(userDataDir, 'repos', UNLINKED_WORKSPACE_ID);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), 'Unlinked repository\n');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Canopy Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'initial',
    ],
  ]) {
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  }
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    UNLINKED_WORKSPACE_ID,
  );
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: UNLINKED_WORKSPACE_ID,
    name: 'Unlinked Personal repository',
    type: 'single-repo',
    color: '#7C9B6D',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeJson(indexPath, index);
}

function trackedPlan() {
  return {
    id: PLAN_ID,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Linked organization execution plan',
    content: '# Linked organization execution plan\n\nRun both methods.',
    reviewStatus: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Linked organization execution plan\n\nRun both methods.',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: NOW,
      },
    ],
    linkedExecutionIds: [],
  };
}

async function runPlanPipeline(window, source, pipelineName) {
  // The plan list row opens the plan's Plan panel (and reveals it once open).
  // After the first run, the card contains a linked-execution action in its
  // center. Click the title area so the second pass opens the plan itself.
  await window
    .getByTestId(`activity-plan-row-${PLAN_ID}`)
    .click({ position: { x: 10, y: 10 } });
  const planPanel = planDocumentPanel(window, PLAN_ID);
  await expect(planPanel).toBeVisible();
  await planPanel.getByTestId('plan-panel-execute').click();
  await planPanel.getByTestId('plan-panel-execute-pipeline').click();

  const pipelineModal = window.getByTestId('pipeline-trigger-modal');
  const body = pipelineModal.getByTestId('pipeline-trigger-modal-body');
  await expect(body).toBeVisible();
  await body.getByRole('button', { name: source, exact: true }).click();
  const row = body.getByRole('button', { name: new RegExp(pipelineName) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const run = pipelineModal.getByTestId('pipeline-trigger-modal-run');
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();

  await expect(pipelineModal).toHaveCount(0, { timeout: 30_000 });
  await expect(window.getByText(/Workflow unavailable/)).toHaveCount(0);
  // Starting the run keeps the Plan panel open and brings up the worktree's
  // activity panel, where the new run's card appears.
  await expect(planPanel).toBeVisible();
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  const runCard = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: pipelineName })
    .first();
  await expect(runCard).toBeVisible({ timeout: 30_000 });
  return runCard;
}

test('an organization can run Custom and Organization pipelines against its linked Personal project', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can2962_linked_pipeline_run';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject] },
      sharedPipelines: [sharedPipeline],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2962-'));
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: [WORKTREE_ID],
  });
  seedUnlinkedPersonalWorkspace(userDataDir);
  const linkedRepoPath = path.join(userDataDir, 'repos', WORKSPACE_ID);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/linked-project.git'],
    { cwd: linkedRepoPath, stdio: 'pipe' },
  );
  // The org link only needs the origin URL. Starting a run looks up the
  // remote default branch (`git ls-remote`, 30 s timeout), so point this repo
  // at a refused local proxy: the lookup fails at once and falls back to the
  // local `main`, instead of waiting on github.com from the runner.
  execFileSync('git', ['config', 'http.proxy', 'http://127.0.0.1:9'], {
    cwd: linkedRepoPath,
    stdio: 'pipe',
  });
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [trackedPlan()],
  });
  seedStoredPipeline({
    userDataDir,
    id: 'aaron-custom-method',
    name: CUSTOM_PIPELINE_NAME,
    yaml: [
      `name: ${CUSTOM_PIPELINE_NAME}`,
      'on: plan_ready',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo custom-linked',
      '',
    ].join('\n'),
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);

    const linked = window.getByTestId(`sidebar-project-header-${WORKSPACE_ID}`);
    await expect(linked).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId(`sidebar-project-header-${UNLINKED_WORKSPACE_ID}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(
        `sidebar-org-project-placeholder-${CATALOG_PROJECT_ID}`,
      ),
    ).toHaveCount(0);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId(`activity-plan-row-${PLAN_ID}`),
    ).toBeVisible({ timeout: 30_000 });

    await runPlanPipeline(window, 'Custom', CUSTOM_PIPELINE_NAME);

    // A run started from the Plan panel lands in the Activity panel's
    // Pipeline runs section, so a section the user collapsed earlier opens
    // again rather than hiding the new run.
    const runsSection = window.getByTestId('activity-section-pipeline-runs');
    const runsTitle = runsSection.locator('[data-panel-section-title-row]');
    await runsTitle.click();
    await expect(runsTitle).toHaveAttribute('aria-expanded', 'false');

    const sharedRunCard = await runPlanPipeline(
      window,
      'Shared',
      SHARED_PIPELINE_NAME,
    );
    await expect(runsTitle).toHaveAttribute('aria-expanded', 'true');

    // The run opens in its own panel, which links back to its plan: View Plan
    // reveals the one open Plan panel instead of opening another, and the
    // run's panel stays open beside it.
    const executionId = (
      await sharedRunCard.getAttribute('data-testid')
    ).replace('pipeline-run-card-', '');
    await sharedRunCard.click({ position: { x: 10, y: 10 } });
    const runPanel = await expectPipelineRunPanel(window, executionId);
    await runPanel.getByTestId(`pipeline-detail-plan-${executionId}`).click();
    await expect(planDocumentPanel(window, PLAN_ID)).toBeVisible();
    await expect(
      window.locator('[data-testid="panel-content-plan"]'),
    ).toHaveCount(1);
    await expect(runPanel).toHaveCount(1);

    const executionsDir = path.join(userDataDir, 'pipeline-executions');
    await expect
      .poll(() => {
        const states = readdirSync(executionsDir)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) =>
            JSON.parse(readFileSync(path.join(executionsDir, entry), 'utf8')),
          )
          .filter((state) =>
            [CUSTOM_PIPELINE_NAME, SHARED_PIPELINE_NAME].includes(
              state.pipeline_snapshot?.name,
            ),
          );
        return states.map((state) => ({
          name: state.pipeline_snapshot.name,
          executionContext: state.execution_context,
        }));
      })
      .toEqual(
        expect.arrayContaining([
          {
            name: CUSTOM_PIPELINE_NAME,
            executionContext: `org:${ORG_CONTEXT_A}`,
          },
          {
            name: SHARED_PIPELINE_NAME,
            executionContext: `org:${ORG_CONTEXT_A}`,
          },
        ]),
      );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a paused organization shared run resumes under strict resource context', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_shared_replay_strict_context';
  const replayPipeline = {
    ...sharedPipeline,
    id: 'aaaaaaaa-2962-4000-8000-000000000100',
    name: REPLAY_PIPELINE_NAME,
    rawPipeline: [
      `name: ${REPLAY_PIPELINE_NAME}`,
      'on: plan_ready',
      'jobs:',
      '  gate:',
      '    steps:',
      '      - id: pause_once',
      '        run: |',
      '          if [ ! -f .e2e-shared-replay-once ]; then',
      '            touch .e2e-shared-replay-once',
      '            echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
      '          fi',
      '',
    ].join('\n'),
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject] },
      sharedPipelines: [replayPipeline],
      extraCapabilities: ['resource-context-v1'],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-replay-'),
  );
  seedOrgContextScoping(userDataDir, { personalWorktreeIds: [WORKTREE_ID] });
  const linkedRepoPath = path.join(userDataDir, 'repos', WORKSPACE_ID);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/linked-project.git'],
    { cwd: linkedRepoPath, stdio: 'pipe' },
  );
  execFileSync('git', ['config', 'http.proxy', 'http://127.0.0.1:9'], {
    cwd: linkedRepoPath,
    stdio: 'pipe',
  });
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [trackedPlan()],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId(`activity-plan-row-${PLAN_ID}`),
    ).toBeVisible({ timeout: 30_000 });
    const card = await runPlanPipeline(window, 'Shared', REPLAY_PIPELINE_NAME);
    const executionId = (await card.getAttribute('data-testid')).replace(
      'pipeline-run-card-',
      '',
    );
    const persisted = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'pipeline-executions', `${executionId}.json`),
        'utf8',
      ),
    );
    expect(persisted).toMatchObject({
      pipeline_id: `shared:canopy-cloud:${replayPipeline.id}`,
      pipeline_preference_locator: {
        type: 'shared',
        value: `canopy-cloud:${replayPipeline.id}`,
      },
      shared_pipeline_source: {
        serverId: 'canopy-cloud',
        remoteId: replayPipeline.id,
      },
      execution_context: `org:${ORG_CONTEXT_A}`,
    });
    await card.click({ position: { x: 10, y: 10 } });
    const pausePanel = window.getByTestId('pause-input-panel');
    const resume = pausePanel.getByTestId('pause-input-resume');
    await expect(resume).toBeEnabled({ timeout: 30_000 });
    await resume.click();
    await expect(card).toContainText('success', { timeout: 30_000 });
    await expect(
      window.getByText(
        "Couldn't confirm where something this uses came from, so it didn't run.",
      ),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
