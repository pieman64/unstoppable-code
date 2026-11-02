// One place per item (CAN-4690, background drawer D2 and D3). A running
// delegate and a watched run are listed only in the composer's background
// drawer, never in a pinned section or a turn record; a finished run renders
// only in the box of the turn that launched it. Covered on a worktree chat
// (watched pipeline and GitHub runs), a Cowork chat and an App Advisor chat.
// The scenario is seeded on disk by seeders/agentActivityScenario.mjs.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { primeStoredPat } from './helpers/github-pat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  SCENARIO,
  launchedTurnMessages,
  seedLaunchedExecution,
  pinnedPipelineWatcher,
  seedPreferences,
  seedWatchedExecution,
  seedWorktreeScenario,
} from './seeders/agentActivityScenario.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  seedWatchers,
  writeJson,
} from './seeders/index.mjs';

// The mock keys GitHub scenarios by bearer token.
const TOKEN = 'ghp_e2e_can4690_single_section';
const NOW = '2026-07-20T00:00:00.000Z';
const SEEDED_AT = '2026-08-04T11:00:00.000Z';

async function setScenario(github) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: TOKEN, scenario: { github } }),
  });
  expect(response.ok).toBe(true);
}

async function clearScenario() {
  await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(TOKEN)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

function workflowRun(status) {
  return {
    status,
    conclusion: null,
    run_attempt: 1,
    html_url: 'https://github.com/acme/api/actions/runs/101',
    name: 'CI',
    run_number: 42,
  };
}

function snapshot(status) {
  return {
    state: { kind: 'intermediate', status },
    runAttempt: 1,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    workflowName: 'CI',
    runNumber: 42,
    observedAt: NOW,
  };
}

function workflowJob(status) {
  return {
    id: 501,
    name: 'Build macOS',
    status,
    conclusion: null,
    html_url: 'https://github.com/acme/api/actions/runs/101/job/501',
  };
}

function jobSnapshot() {
  return {
    jobId: '501',
    name: 'Build macOS',
    status: 'in_progress',
    conclusion: null,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
    observedAt: NOW,
  };
}

function githubWatcher(destination) {
  return {
    id: 'single-section-gh',
    trigger: 'github_workflow_runs_changed',
    label: 'CI workflow runs',
    target: {
      kind: 'github_workflow_runs',
      items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '101' }],
      notifyOn: {
        statuses: [],
        conclusions: [],
        jobConclusions: ['success', 'failure'],
      },
      display: {
        repositories: ['acme/api'],
        sample: [
          {
            repository: 'acme/api',
            runId: '101',
            workflowName: 'CI',
            runNumber: 42,
          },
        ],
      },
    },
    destination,
    runtimeState: {
      kind: 'github_workflow_runs',
      items: [
        {
          key: 'acme/api/101/',
          runAttempt: 1,
          last: snapshot('in_progress'),
          jobs: [jobSnapshot()],
        },
      ],
    },
  };
}

async function expectSingleSection(
  scope,
  { watchedCardIds, watchedRows, launchedCardId },
) {
  // No turn streams, so there is no pinned section.
  await expect(scope.getByTestId('agent-activity-active')).toHaveCount(0);
  // The drawer lists the live delegate and the watched runs ...
  const tray = scope.getByTestId('composer-work-drawer');
  await tray.getByTestId('composer-work-drawer-toggle').click();
  await expect(
    tray.locator('[data-tray-row="agent:managed:managed-child"]'),
  ).toBeVisible();
  for (const row of watchedRows) {
    await expect(tray.locator(`[data-tray-row="${row}"]`)).toBeVisible();
  }
  // ... and no turn record does.
  for (const id of watchedCardIds) {
    await expect(scope.getByTestId(id)).toHaveCount(0);
  }
  // The launch turn's box only.
  const completed = scope.getByTestId('agent-activity-completed');
  await expect(completed).toHaveCount(1);
  // The launch turn is the first turn, never the last, so it is collapsed.
  await completed
    .first()
    .getByRole('button', { name: 'Expand agent activity' })
    .click();
  await expect(completed.first().getByTestId(launchedCardId)).toBeVisible();
  // Inline only: the launched run has finished and no watcher targets it.
  await expect(completed.first().getByTestId(launchedCardId)).not.toContainText(
    /running/i,
  );
  await expect(scope.getByTestId(launchedCardId)).toHaveCount(1);
  return tray;
}

const WATCHED_PIPELINE_ROW = 'run:canopy:pipeline_run:execution:watched-exec';

test('lists watched pipeline and GitHub runs only in the drawer of a worktree chat', async () => {
  test.setTimeout(240_000);
  const { projectId, worktreeId, chatId, chatTitle } = SCENARIO;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-single-section-worktree-'),
  );
  await primeStoredPat(userDataDir, TOKEN);
  seedWorktreeScenario({
    userDataDir,
    watchers: [githubWatcher({ projectId, worktreeId, chatId, chatTitle })],
  });
  await setScenario({
    workflowRuns: { 'acme/api/101': workflowRun('in_progress') },
    workflowRunJobs: {
      'acme/api/101/1': { jobs: [workflowJob('in_progress')] },
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { GH_TOKEN: TOKEN },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    // The watcher store has hydrated.
    await expect(
      window.getByTestId(`chat-input-watchers-${chatId}`),
    ).toBeVisible();
    const panel = window.getByTestId('panel-content-chat');
    const tray = await expectSingleSection(panel, {
      watchedCardIds: [
        'pipeline-run-card-watched-exec',
        'github-workflow-run-card-101',
      ],
      watchedRows: [WATCHED_PIPELINE_ROW],
      launchedCardId: 'pipeline-run-card-launched-exec',
    });

    // The GitHub run has no Stop; its inspector names its repository and
    // running job, offers its watcher and opens it on GitHub.
    const githubRow = tray.locator(
      '[data-tray-row^="run:canopy:github_workflow_run:"]',
    );
    await expect(githubRow).toContainText('CI #42');
    await expect(
      githubRow.locator('[data-execution-action-button]'),
    ).toHaveCount(0);
    await githubRow.getByTestId('background-tray-row-toggle').click();
    const inspector = tray.getByTestId('background-tray-inspector');
    await expect(inspector).toContainText('acme/api · Build macOS running');
    await expect(
      inspector.getByTestId('background-tray-run-watchers-101'),
    ).toBeVisible();
    await expect(
      githubRow.getByTestId('background-tray-row-open'),
    ).toHaveAccessibleName('Open on GitHub');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario();
  }
});

test('lists a watched pipeline run only in the drawer of a Cowork chat', async () => {
  test.setTimeout(240_000);
  const COWORK_ID = 'single-section-cowork';
  const ENTRY_ID = 'single-section-entry';
  const CHAT_ID = 'cowork-single-section';
  const CHAT_TITLE = 'Cowork single section';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-single-section-cowork-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);

  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const collectionKey = Array.isArray(index.items) ? 'items' : 'workspaces';
  index[collectionKey].push({
    id: COWORK_ID,
    name: 'Single Section Cowork',
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: false,
    order: index[collectionKey].length,
    cowork: { createdAt: SEEDED_AT, archiveRetentionDays: null },
  });
  writeJson(indexPath, index);
  const workspaceDir = path.join(workspacesRoot, COWORK_ID);
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: SEEDED_AT,
      defaultModel: 'claude-sonnet-4-6',
      searchIndexingEnabled: false,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, createdAt: SEEDED_AT }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: CHAT_TITLE,
        createdAt: SEEDED_AT,
        kind: 'chat',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        messages: launchedTurnMessages(
          'cowork-launched-exec',
          SCENARIO.projectId,
          SCENARIO.worktreeId,
        ),
      },
    ],
  });
  seedWatchedExecution(userDataDir);
  seedLaunchedExecution(userDataDir, 'cowork-launched-exec');
  seedWatchers({
    userDataDir,
    watchers: [
      pinnedPipelineWatcher({
        id: 'cowork-single-section-watcher',
        destination: {
          projectId: COWORK_ID,
          worktreeId: ENTRY_ID,
          chatId: CHAT_ID,
          chatTitle: CHAT_TITLE,
        },
      }),
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_ID}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(
      window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
    ).toBeVisible();
    await expectSingleSection(panel, {
      watchedCardIds: ['pipeline-run-card-watched-exec'],
      watchedRows: [WATCHED_PIPELINE_ROW],
      launchedCardId: 'pipeline-run-card-cowork-launched-exec',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('lists a watched pipeline run only in the drawer of an App Advisor chat', async () => {
  test.setTimeout(240_000);
  const ENTRY_ID = 'advisor-single-section-entry';
  const CHAT_ID = 'advisor-single-section';
  const CHAT_TITLE = 'Advisor single section';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-single-section-advisor-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  const workspaceDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, createdAt: SEEDED_AT, title: CHAT_TITLE }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: CHAT_TITLE,
        createdAt: SEEDED_AT,
        providerType: 'claude',
        model: 'sonnet',
        messages: launchedTurnMessages(
          'advisor-launched-exec',
          SCENARIO.projectId,
          SCENARIO.worktreeId,
        ),
      },
    ],
  });
  seedWatchedExecution(userDataDir);
  seedLaunchedExecution(userDataDir, 'advisor-launched-exec');
  seedWatchers({
    userDataDir,
    watchers: [
      pinnedPipelineWatcher({
        id: 'advisor-single-section-watcher',
        destination: {
          projectId: 'app-advisor',
          worktreeId: ENTRY_ID,
          chatId: CHAT_ID,
          chatTitle: CHAT_TITLE,
        },
      }),
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const input = advisor.getByTestId(`chat-input-watchers-${CHAT_ID}`);
    await input.waitFor({ timeout: 10_000 }).catch(() => undefined);
    if (!(await input.isVisible().catch(() => false))) {
      await advisor.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
      await input.waitFor();
    }
    // The Advisor window renders its chat outside the panel registry, so it
    // has no `panel-content-chat` wrapper; the window is the scope.
    await expectSingleSection(advisor, {
      watchedCardIds: ['pipeline-run-card-watched-exec'],
      watchedRows: [WATCHED_PIPELINE_ROW],
      launchedCardId: 'pipeline-run-card-advisor-launched-exec',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
