import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { primeStoredPat, saveGitHubPat } from './helpers/github-pat.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  seedWatchers,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { injectChatEvent } from './seeders/injectChatEvent.mjs';

// End-to-end proof for the durable GitHub workflow-run observer. The app uses
// its real broker/Octokit path; only api.github.com is redirected by the E2E
// build to the shared credential-keyed REST mock.

const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;
const TOKEN = 'ghp_e2e_workflow_watcher';
const MOCK_SCENARIO_KEY = '__github-rest-fallback__';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'workflow-watcher-chat';
const WATCHER_ID = 'workflow-watcher';
const NOW = '2026-07-20T00:00:00.000Z';

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-workflow-watcher-'));
}

async function setScenario(github, scenarioKey = MOCK_SCENARIO_KEY) {
  const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: scenarioKey, scenario: { github } }),
  });
  expect(response.ok).toBe(true);
}

async function getGithubScenario(scenarioKey = MOCK_SCENARIO_KEY) {
  const response = await fetch(
    `${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(scenarioKey)}`,
  );
  expect(response.ok).toBe(true);
  return (await response.json()).scenario.github ?? {};
}

async function clearScenario(scenarioKey = MOCK_SCENARIO_KEY) {
  await fetch(
    `${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(scenarioKey)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

function workflowRun(status, conclusion = null, etag = undefined) {
  return {
    status,
    conclusion,
    run_attempt: 1,
    html_url: 'https://github.com/acme/api/actions/runs/101',
    name: 'CI',
    run_number: 42,
    ...(etag ? { responseHeaders: { etag } } : {}),
  };
}

function snapshot(status = 'queued') {
  return {
    state: { kind: 'intermediate', status },
    runAttempt: 1,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    workflowName: 'CI',
    runNumber: 42,
    observedAt: NOW,
  };
}

function workflowJob(status, conclusion = null, job = {}) {
  const id = job.id ?? 501;
  return {
    id,
    name: job.name ?? 'Build macOS',
    status,
    conclusion,
    html_url: `https://github.com/acme/api/actions/runs/101/job/${id}`,
    ...(job.created_at ? { created_at: job.created_at } : {}),
    ...(job.completed_at ? { completed_at: job.completed_at } : {}),
  };
}

function jobSnapshot(status = 'in_progress', conclusion = null, job = {}) {
  const jobId = job.jobId ?? '501';
  return {
    jobId,
    name: job.name ?? 'Build macOS',
    status,
    conclusion,
    htmlUrl: `https://github.com/acme/api/actions/runs/101/job/${jobId}`,
    observedAt: NOW,
  };
}

const TEST_JOB = { id: 502, jobId: '502', name: 'Test' };
// The mock keys scenarios by bearer token, so this test authenticates with a
// token of its own: the shared fallback key is written by every other spec
// (and worktree) that runs against the same mock server.
const ACTIVITY_TOKEN = 'ghp_e2e_workflow_activity_card';
const RUN_ONLY_TOKEN = 'ghp_e2e_workflow_run_only_progress';
const DEFINITION_TOKEN = 'ghp_e2e_workflow_definition_graph';
const CARRY_BUDGET_TOKEN = 'ghp_e2e_workflow_carry_budget';
const PENDING_DELIVERY_TOKEN = 'ghp_e2e_workflow_pending_delivery';
const DEFINITION_SHA = 'd'.repeat(40);
const LONG_DEFINITION_JOB_NAME = `Long ${'x'.repeat(170)}`;
// A four-stage workflow with static, expanded, and dynamic matrix jobs.
const DEFINITION_YAML = `
name: CI
on: [push]
jobs:
  build:
    name: Build macOS
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    name: Test (\${{ strategy.job-index }}/\${{ strategy.job-total }} shard \${{ matrix.shard }})
    needs: build
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: echo test
  dynamic:
    name: Dynamic
    needs: test
    strategy:
      matrix: \${{ fromJSON(vars.MATRIX) }}
    steps:
      - run: echo dynamic
  wildcard:
    name: \${{ matrix.label }}
    needs: test
    strategy:
      matrix: \${{ fromJSON(vars.MATRIX) }}
    steps:
      - run: echo wildcard
  nested:
    name: PR
    needs: build
    uses: ./.github/workflows/lint.yml
  optional:
    name: Optional-\${{ inputs.suffix }}
    needs: nested
    steps:
      - run: echo optional
  long-name:
    name: ${LONG_DEFINITION_JOB_NAME}
    needs: optional
    steps:
      - run: echo long
  deploy:
    name: Deploy
    needs: [dynamic, wildcard]
    steps:
      - run: echo deploy
`;
const NESTED_REUSABLE_YAML = `
name: Lint
on:
  workflow_call:
jobs:
  lint:
    name: Lint
    uses: ./.github/workflows/eslint.yml
`;

/**
 * Local receiver standing in for the host browser. The E2E build never calls
 * `shell.openExternal`; it posts the target to this capture endpoint instead.
 */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
const ACTIVITY_WATCHER_ID = 'workflow-activity-watcher';
const ACTIVITY_TURN_ID = 'workflow-activity-turn';
const ACTIVITY_TURN_AT = Date.parse('2026-07-20T00:01:00.000Z');

/**
 * An in-flight user turn (paused, never completed) so the chat docks its
 * Agent activity section and carries the watched run onto that turn — the
 * same flow the pipeline-run card proves in chat-agent-activity-cards.
 */
async function injectActiveTurn(electronApp) {
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    data: {
      type: 'claude_terminal_transcript_sync',
      importedEventCount: 2,
      messages: [
        {
          id: ACTIVITY_TURN_ID,
          role: 'user',
          blocks: [{ type: 'text', text: 'Watch the CI run for me.' }],
          timestamp: ACTIVITY_TURN_AT,
        },
        {
          id: `${ACTIVITY_TURN_ID}-timer`,
          role: 'system',
          blocks: [
            {
              type: 'turn_timer',
              startedAt: ACTIVITY_TURN_AT,
              pausedAt: ACTIVITY_TURN_AT + 1_000,
              completedAt: null,
            },
          ],
          timestamp: ACTIVITY_TURN_AT + 1_000,
        },
      ],
    },
  });
}

function destination() {
  return {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    chatTitle: 'Workflow watcher chat',
  };
}

function activeWatcher(overrides = {}) {
  return {
    id: WATCHER_ID,
    trigger: 'github_workflow_runs_changed',
    label: 'CI workflow runs',
    target: {
      kind: 'github_workflow_runs',
      items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '101' }],
      notifyOn: {
        statuses: ['waiting'],
        conclusions: ['success', 'failure'],
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
    destination: destination(),
    runtimeState: {
      kind: 'github_workflow_runs',
      items: [
        {
          key: 'acme/api/101',
          runAttempt: 1,
          last: snapshot(),
        },
      ],
    },
    ...overrides,
  };
}

function watcherForRun(id, runId) {
  return activeWatcher({
    id,
    label: `Workflow run ${runId}`,
    target: {
      ...activeWatcher().target,
      items: [
        { kind: 'workflow_run', repository: 'acme/api', runId: String(runId) },
      ],
      display: {
        repositories: ['acme/api'],
        sample: [{ repository: 'acme/api', runId: String(runId) }],
      },
    },
    runtimeState: {
      kind: 'github_workflow_runs',
      items: [
        {
          key: `acme/api/${runId}`,
          runAttempt: 1,
          last: {
            ...snapshot(),
            htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
            runNumber: Number(runId),
          },
        },
      ],
    },
  });
}

function seedWorkspaceAndChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Workflow watcher chat', messages: [] }],
  });
}

function seedAppAdvisorChat(userDataDir, chatId) {
  writeJson(
    path.join(
      userDataDir,
      'app-workspaces',
      'app-advisor',
      'chats',
      'global.json',
    ),
    {
      version: 1,
      activeTabId: chatId,
      tabs: [
        {
          id: chatId,
          title: 'Watcher replay recipient',
          createdAt: NOW,
          messages: [],
        },
      ],
    },
  );
}

function readWatchers(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'app-advisor-watchers.json'), 'utf8'),
  ).watchers;
}

function persistedWatcher(userDataDir, watcherId = WATCHER_ID) {
  return readWatchers(userDataDir).find((entry) => entry.id === watcherId);
}

function persistedChatText(userDataDir) {
  return JSON.stringify(
    readChatStorageTabs(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
    ),
  );
}

async function waitForRequestCount(count, scenarioKey = MOCK_SCENARIO_KEY) {
  await expect
    .poll(
      async () =>
        (await getGithubScenario(scenarioKey)).workflowRunRequests?.length ?? 0,
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

/**
 * The watched run's row in the composer's background drawer, with its
 * inspector open: a live run is listed there, not in Agent activity
 * (background drawer D2). The inspector holds the run's full job bar, its
 * watcher and Open on GitHub.
 */
async function openRunRow(panel, { name = 'CI #42', timeout = 30_000 } = {}) {
  const tray = await openBackgroundDrawer(panel, { timeout });
  const row = tray.locator('[data-tray-row^="run:"]').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout });
  const toggle = row.getByTestId('background-tray-row-toggle');
  if ((await toggle.getAttribute('aria-expanded', { timeout })) !== 'true') {
    await toggle.click({ timeout });
  }
  const inspector = row.getByTestId('background-tray-inspector');
  await expect(inspector).toBeVisible({ timeout });
  return { row, inspector };
}

/**
 * Waits for a job's dot in the run's inspector. The renderer lists only
 * active watchers, so while a watcher delivers an event, or retires, its run
 * briefly leaves the drawer and the inspector closes (CAN-4690); each try
 * reopens it.
 */
async function expectRunJob(panel, jobId, label, timeout = 15_000) {
  await expect(async () => {
    const { inspector } = await openRunRow(panel, { timeout: 2_000 });
    await expect(inspector.locator(`[data-job-id="${jobId}"]`)).toHaveAttribute(
      'aria-label',
      label,
      { timeout: 2_000 },
    );
  }).toPass({ timeout });
}

async function completedRun(panel) {
  const turnBox = panel.getByTestId('agent-activity-completed');
  const toggle = turnBox.getByRole('button', {
    name: /^(Expand|Collapse) agent activity$/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click();
  const card = turnBox.getByTestId('github-workflow-run-card-101');
  await expect(card).toHaveAttribute('data-run-status', 'success', {
    timeout: 30_000,
  });
  return card;
}

async function expectCompletedJob(panel, jobId, label) {
  const row = await completedRun(panel);
  await expect(row.locator(`[data-job-id="${jobId}"]`)).toHaveAttribute(
    'aria-label',
    label,
  );
}

test.describe('GitHub workflow-run watchers against the REST mock', () => {
  test.afterEach(async () => {
    await Promise.all([
      clearScenario(),
      clearScenario(TOKEN),
      clearScenario(ACTIVITY_TOKEN),
      clearScenario(RUN_ONLY_TOKEN),
      clearScenario(DEFINITION_TOKEN),
      clearScenario(CARRY_BUDGET_TOKEN),
      clearScenario(PENDING_DELIVERY_TOKEN),
    ]);
  });

  test('observes transitions, reuses an ETag snapshot, settles, and renders both watcher surfaces', async () => {
    test.setTimeout(180_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({ userDataDir, watchers: [activeWatcher()] });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': workflowRun('in_progress', null, '"in-progress"'),
        },
      },
      TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      // The chat Watching modal displays the same bounded workflow-run summary.
      const watchingButton = window.getByTestId(
        `chat-input-watchers-${CHAT_ID}`,
      );
      await expect(watchingButton).toBeVisible();
      // The watchers chip sits beside + like Plan: one watcher is the glyph
      // alone.
      await expect(watchingButton).toHaveText('');
      await expect(watchingButton).toHaveAttribute(
        'aria-label',
        'Manage chat watchers',
      );
      const composerBox = window
        .locator('[data-chat-composer-root]:visible [data-composer-layout]')
        .first();
      const [plusRect, chipRect] = await Promise.all([
        composerBox.getByTestId('chat-input-plus-button').boundingBox(),
        watchingButton.boundingBox(),
      ]);
      expect(chipRect.x).toBeGreaterThan(plusRect.x + plusRect.width);
      expect(Math.abs(chipRect.y - plusRect.y)).toBeLessThan(1);
      await watchingButton.click();
      const watcherModal = window.getByTestId('watcher-management-modal');
      await expect(watcherModal).toContainText('1 workflow run in acme/api');
      await watcherModal.getByRole('button', { name: 'Close' }).click();

      // Workflows › Runs renders the same watcher and subscriber destination.
      await app.openWatchersPage();
      const row = app.workflowsWatcherRunRow(WATCHER_ID);
      await expect(row).toContainText('CI workflow runs');
      await expect(row).toContainText('Workflow watcher chat');

      // queued -> in_progress is observed but not selected for delivery.
      await expect
        .poll(
          () =>
            persistedWatcher(userDataDir)?.runtimeState?.items?.[0]?.last?.state
              ?.status,
          { timeout: 30_000 },
        )
        .toBe('in_progress');

      // A second unchanged poll sends If-None-Match and the mock returns 304;
      // the cached snapshot is reused without a false transition.
      await waitForRequestCount(2, TOKEN);
      const requests = (await getGithubScenario(TOKEN)).workflowRunRequests;
      expect(requests).toHaveLength(2);
      expect(requests[1].ifNoneMatch).toBe('"in-progress"');
      expect(persistedWatcher(userDataDir).status).toBe('active');
      expect(
        persistedWatcher(userDataDir).runtimeState.pendingDelivery,
      ).toBeUndefined();

      // waiting is selected and delivered, but the watcher remains active.
      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('waiting', null, '"waiting"'),
          },
        },
        TOKEN,
      );
      await expect
        .poll(() => persistedWatcher(userDataDir)?.status, {
          timeout: 45_000,
        })
        .toBe('active');
      await expect
        .poll(
          () =>
            persistedWatcher(userDataDir)?.runtimeState?.items?.[0]?.last?.state
              ?.status,
          { timeout: 45_000 },
        )
        .toBe('waiting');

      // The selected terminal transition is delivered and consumes the group.
      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('completed', 'success', '"success"'),
          },
        },
        TOKEN,
      );
      await expect
        .poll(() => persistedWatcher(userDataDir)?.status, {
          timeout: 45_000,
        })
        .toBe('fired');
      // A fired watcher stays in the Runs feed as a Fired row, no longer
      // watching.
      await expect(row).toHaveAttribute('data-run-status', 'fired');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('restarts from an active baseline without a false event', async () => {
    test.setTimeout(120_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101',
                runAttempt: 1,
                last: snapshot('in_progress'),
              },
            ],
          },
        }),
      ],
    });
    await setScenario(
      { workflowRuns: { 'acme/api/101': workflowRun('in_progress') } },
      TOKEN,
    );

    const first = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    await waitForRequestCount(1, TOKEN);
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });

    await setScenario(
      { workflowRuns: { 'acme/api/101': workflowRun('in_progress') } },
      TOKEN,
    );
    const second = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    try {
      await waitForRequestCount(1, TOKEN);
      expect(persistedWatcher(userDataDir).status).toBe('active');
      expect(
        persistedWatcher(userDataDir).runtimeState.pendingDelivery,
      ).toBeUndefined();
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  });

  test('observes a future completed job and keeps the grouped watcher active', async () => {
    test.setTimeout(120_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: 'workflow-job-watcher',
          label: 'CI job progress',
          target: {
            ...activeWatcher().target,
            notifyOn: {
              statuses: [],
              conclusions: [],
              jobConclusions: ['success'],
            },
          },
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
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': workflowRun('in_progress'),
        },
        workflowRunJobs: {
          'acme/api/101/1': {
            jobs: [workflowJob('completed', 'success')],
            responseHeaders: { etag: '"jobs-completed"' },
          },
        },
      },
      TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const watchingButton = window.getByTestId(
        `chat-input-watchers-${CHAT_ID}`,
      );
      await watchingButton.click();
      await expect(
        window.getByTestId('watcher-management-modal'),
      ).toContainText('Jobs completed: success');
      await window
        .getByTestId('watcher-management-modal')
        .getByRole('button', { name: 'Close' })
        .click();

      await expect
        .poll(
          () =>
            persistedWatcher(userDataDir, 'workflow-job-watcher')?.runtimeState
              ?.items?.[0]?.jobs?.[0]?.conclusion,
          { timeout: 45_000 },
        )
        .toBe('success');
      await expect
        .poll(() => persistedChatText(userDataDir), { timeout: 45_000 })
        .toContain('a job completed with success');
      await expect
        .poll(
          () => persistedWatcher(userDataDir, 'workflow-job-watcher')?.status,
          { timeout: 45_000 },
        )
        .toBe('active');
      expect(
        (await getGithubScenario(TOKEN)).workflowRunJobRequests?.[0],
      ).toMatchObject({ key: 'acme/api/101/1', page: 1, perPage: 100 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('replays a pending delivery before polling and preserves its event id', async () => {
    test.setTimeout(90_000);
    const userDataDir = makeUserDataDir();
    const replayChatId = 'workflow-replay-chat';
    seedAppAdvisorChat(userDataDir, replayChatId);
    const terminalObservedAt = '2026-07-20T00:00:05.000Z';
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: 'workflow-replay',
          status: 'firing',
          destination: {
            projectId: 'app-advisor',
            worktreeId: 'global',
            chatId: replayChatId,
            chatTitle: 'Watcher replay recipient',
          },
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101',
                runAttempt: 1,
                last: {
                  state: { kind: 'terminal', conclusion: 'failure' },
                  runAttempt: 1,
                  htmlUrl: 'https://github.com/acme/api/actions/runs/101',
                  workflowName: 'CI',
                  runNumber: 42,
                  observedAt: terminalObservedAt,
                },
                settledAt: terminalObservedAt,
              },
            ],
            pendingDelivery: {
              eventId: 'stable-e2e-event-id',
              observedAt: terminalObservedAt,
              transitions: [
                {
                  repository: 'acme/api',
                  runId: '101',
                  workflowName: 'CI',
                  runNumber: 42,
                  runAttempt: 1,
                  previous: {
                    kind: 'intermediate',
                    status: 'in_progress',
                  },
                  current: { kind: 'terminal', conclusion: 'failure' },
                  url: 'https://github.com/acme/api/actions/runs/101',
                },
              ],
              consumeAfterDelivery: true,
              attempts: 1,
              nextAttemptAt: NOW,
            },
          },
        }),
      ],
    });
    await setScenario({ workflowRuns: {} });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    try {
      await expect
        .poll(() => persistedWatcher(userDataDir, 'workflow-replay')?.status, {
          timeout: 45_000,
        })
        .toBe('fired');
      const replayed = persistedWatcher(userDataDir, 'workflow-replay');
      expect(replayed.runtimeState.pendingDelivery).toBeUndefined();
      expect(
        (await getGithubScenario()).workflowRunRequests ?? [],
      ).toHaveLength(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('coalesces duplicate subscriptions and classifies REST failures without a second queue', async () => {
    test.setTimeout(150_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, TOKEN);
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({
      userDataDir,
      watchers: [
        watcherForRun('shared-resource-one', 201),
        watcherForRun('shared-resource-two', 201),
        watcherForRun('permission-failure', 202),
        watcherForRun('private-not-found', 203),
        watcherForRun('server-failure', 204),
        watcherForRun('secondary-limit', 205),
      ],
    });
    await setScenario({
      workflowRuns: {
        // Keep the shared success resource out of a second observer cycle while
        // the error fixtures exercise their own retry paths below. This makes
        // the assertion measure initial-fetch coalescing rather than timing
        // against the normal 8–12 second unchanged-resource cadence.
        'acme/api/201': {
          ...workflowRun('in_progress'),
          responseHeaders: { 'x-poll-interval': '60' },
        },
        'acme/api/202': {
          ...workflowRun('queued'),
          responseStatus: 403,
          message: 'Resource not accessible by personal access token',
        },
        'acme/api/203': {
          ...workflowRun('queued'),
          responseStatus: 404,
          message: 'Not Found',
        },
        'acme/api/204': {
          ...workflowRun('queued'),
          responseStatus: 500,
          message: 'Server Error',
        },
        'acme/api/205': {
          ...workflowRun('queued'),
          responseStatus: 403,
          responseHeaders: { 'retry-after': '1' },
          message: 'You have exceeded a secondary rate limit',
        },
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await expect
        .poll(
          async () => {
            const keys = (await getGithubScenario()).workflowRunRequests?.map(
              (entry) => entry.key,
            );
            return new Set(keys ?? []).size;
          },
          { timeout: 45_000 },
        )
        .toBe(5);
      const firstCycleRequests = (await getGithubScenario())
        .workflowRunRequests;
      expect(
        firstCycleRequests.filter((entry) => entry.key === 'acme/api/201'),
      ).toHaveLength(1);

      await expect
        .poll(
          () => persistedWatcher(userDataDir, 'permission-failure')?.status,
          {
            timeout: 30_000,
          },
        )
        .toBe('delivery_failed');
      await expect
        .poll(
          () => persistedWatcher(userDataDir, 'private-not-found')?.status,
          {
            timeout: 30_000,
          },
        )
        .toBe('delivery_failed');
      expect(
        persistedWatcher(userDataDir, 'permission-failure').failureKind,
      ).toBe('source');
      expect(
        persistedWatcher(userDataDir, 'private-not-found').failureKind,
      ).toBe('source');
      expect(persistedWatcher(userDataDir, 'server-failure').status).toBe(
        'active',
      );
      expect(persistedWatcher(userDataDir, 'secondary-limit').status).toBe(
        'active',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('deleting while a REST request is in flight suppresses the late result', async () => {
    test.setTimeout(120_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({ userDataDir, watchers: [activeWatcher()] });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': {
            ...workflowRun('completed', 'failure'),
            responseDelayMs: 10_000,
          },
        },
      },
      TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openWatchersPage();
      await waitForRequestCount(1, TOKEN);

      const row = app.workflowsWatcherRunRow(WATCHER_ID);
      await row.getByTestId('workflows-run-action-cancel').click();
      await expect(
        window.getByTestId('workflows-runs-cancel-watcher'),
      ).toBeVisible();
      await window.getByTestId('confirm-dialog-confirm').click();
      await expect(row).toHaveCount(0);

      await new Promise((resolve) => setTimeout(resolve, 11_000));
      expect(persistedWatcher(userDataDir)).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('recovers job progress when opening a chat completed in the background', async () => {
    test.setTimeout(180_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    // No carry was ever materialized by a foreground activity section.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Workflow watcher chat',
          messages: [
            {
              id: ACTIVITY_TURN_ID,
              role: 'user',
              timestamp: ACTIVITY_TURN_AT,
              blocks: [{ type: 'text', text: 'Watch the CI run for me.' }],
            },
            {
              id: 'background-final',
              role: 'assistant',
              timestamp: ACTIVITY_TURN_AT + 1000,
              blocks: [
                { type: 'text', text: 'The completion watcher is set.' },
              ],
            },
            {
              id: 'background-timer',
              role: 'system',
              timestamp: ACTIVITY_TURN_AT + 2000,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: ACTIVITY_TURN_AT,
                  completedAt: ACTIVITY_TURN_AT + 2000,
                },
              ],
            },
            {
              id: 'background-trailing-user',
              role: 'user',
              timestamp: ACTIVITY_TURN_AT + 3000,
              blocks: [
                {
                  type: 'text',
                  text: 'Keep this queued follow-up staged.',
                },
              ],
            },
          ],
        },
      ],
    });
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101/',
                runAttempt: 1,
                last: snapshot('in_progress'),
                jobs: [jobSnapshot(), jobSnapshot('queued', null, TEST_JOB)],
              },
            ],
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
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(
        panel.getByText('The completion watcher is set.'),
      ).toBeVisible();
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();
      // The live run is the drawer's; the transcript records its carry.
      const { row, inspector } = await openRunRow(panel);
      await expect(row).toHaveCount(1);
      await expect(
        panel.getByTestId('github-workflow-run-card-101'),
      ).toHaveCount(0);
      await expect(inspector.locator('[data-job-id="501"]')).toHaveAttribute(
        'aria-label',
        'Build macOS: running',
      );
      await expect(inspector.locator('[data-job-id="502"]')).toHaveAttribute(
        'aria-label',
        'Test: pending',
      );
      await expect
        .poll(() =>
          readChatStorageTabs(
            path.join(userDataDir, 'workspaces', WORKSPACE_ID),
            WORKTREE_ID,
          )
            .tabs.find((tab) => tab.id === CHAT_ID)
            ?.agentArtifactCarryByTurn?.[ACTIVITY_TURN_ID]?.some(
              (receipt) => receipt.runId === '101',
            ),
        )
        .toBe(true);
      await app.openSettings();
      await app.closeSettings();
      await expect(row).toBeVisible();
      await expect(row).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the chat rendering when the fire history is newer than the active watcher list', async () => {
    test.setTimeout(180_000);
    const userDataDir = makeUserDataDir();
    seedWorkspaceAndChat(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Workflow watcher chat',
          messages: [
            {
              id: ACTIVITY_TURN_ID,
              role: 'user',
              timestamp: ACTIVITY_TURN_AT,
              blocks: [{ type: 'text', text: 'Watch the CI run for me.' }],
            },
            {
              id: 'history-final',
              role: 'assistant',
              timestamp: ACTIVITY_TURN_AT + 1000,
              blocks: [
                { type: 'text', text: 'The completion watcher is set.' },
              ],
            },
            {
              id: 'history-timer',
              role: 'system',
              timestamp: ACTIVITY_TURN_AT + 2000,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: ACTIVITY_TURN_AT,
                  completedAt: ACTIVITY_TURN_AT + 2000,
                },
              ],
            },
          ],
        },
      ],
    });
    const historyTrigger = 'workflow-history-trigger';
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
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
        }),
        {
          ...watcherForRun(historyTrigger, 202),
          destination: { ...destination(), chatId: 'another-chat' },
        },
      ],
    });
    // The fire history is read separately from the active watcher list, so it
    // can hold a newer snapshot of a watcher the active list still shows (for
    // example, another Canopy instance sharing the watcher file fired it).
    // Answer the history read with that newer snapshot.
    const observedAt = '2026-07-20T00:05:00.000Z';
    const firing = {
      id: ACTIVITY_WATCHER_ID,
      trigger: 'github_workflow_runs_changed',
      status: 'firing',
      label: 'CI workflow runs',
      target: activeWatcher().target,
      destination: destination(),
      createdAt: NOW,
      githubProgress: {
        runs: [
          {
            repository: 'acme/api',
            runId: '101',
            runAttempt: 1,
            workflowName: 'CI',
            runNumber: 42,
            htmlUrl: 'https://github.com/acme/api/actions/runs/101',
            state: { kind: 'terminal', conclusion: 'success' },
            observedAt,
            jobs: [{ ...jobSnapshot('completed', 'success'), observedAt }],
          },
        ],
      },
    };
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      // Hold the newer history back until the drawer has seen the run live.
      // Otherwise which arrives first is a race: a run the drawer saw live is
      // held there until dismissed, and one it never saw goes to its turn
      // (background drawer D3).
      await electronApp.evaluate(({ ipcMain }, history) => {
        const channel = 'app-advisor:watchers-completed-list';
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () =>
          globalThis.__e2eReleaseWatcherHistory === true ? [history] : [],
        );
      }, firing);
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(
        panel.getByText('The completion watcher is set.'),
      ).toBeVisible();
      await expectRunJob(panel, '501', 'Build macOS: running');
      await electronApp.evaluate(() => {
        globalThis.__e2eReleaseWatcherHistory = true;
      });
      // Any watcher change re-reads the history.
      await window.evaluate(
        (watcherId) => window.api.appAdvisor.deleteWatcher(watcherId),
        historyTrigger,
      );

      // The newer terminal history moves the run to completed work.
      await expectCompletedJob(panel, '501', 'Build macOS: success');
      const card = panel.getByTestId('github-workflow-run-card-101');
      await expect(card).toHaveCount(1);
      await expect
        .poll(
          () =>
            readChatStorageTabs(
              path.join(userDataDir, 'workspaces', WORKSPACE_ID),
              WORKTREE_ID,
            ).tabs.find((tab) => tab.id === CHAT_ID)
              ?.agentArtifactCarryByTurn?.[ACTIVITY_TURN_ID]?.[0]?.observedAt,
        )
        .toBe(observedAt);
      await expect(window.getByText(/hit a renderer error/)).toHaveCount(0);
      await expectCompletedJob(panel, '501', 'Build macOS: success');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('lists the watched run in the drawer while it runs, then keeps its completed record in chat', async () => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, ACTIVITY_TOKEN);
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
          label: 'CI job progress',
          target: {
            ...activeWatcher().target,
            notifyOn: {
              statuses: [],
              conclusions: [],
              jobConclusions: ['success', 'failure'],
            },
          },
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101/',
                runAttempt: 1,
                last: snapshot('in_progress'),
                jobs: [jobSnapshot(), jobSnapshot('queued', null, TEST_JOB)],
              },
            ],
          },
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': workflowRun('in_progress', null, '"in-progress"'),
        },
        workflowRunJobs: {
          'acme/api/101/1': {
            jobs: [
              workflowJob('in_progress'),
              workflowJob('queued', null, TEST_JOB),
            ],
          },
        },
      },
      ACTIVITY_TOKEN,
    );

    const externalOpen = await startExternalOpenCapture();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        GH_TOKEN: ACTIVITY_TOKEN,
        CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      // Wait for the watcher store to hydrate before the turn arrives so the
      // carry is computed from the seeded watcher.
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();
      await injectActiveTurn(electronApp);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByText('Watch the CI run for me.')).toBeVisible();
      // No Agent activity card while the run is live: it is the drawer's.
      await expect(
        panel.getByTestId('github-workflow-run-card-101'),
      ).toHaveCount(0);
      const { row, inspector } = await openRunRow(panel);
      await expect(
        inspector.getByTestId('background-tray-run-watchers-101'),
      ).toHaveText('Manage watching');
      await expect(inspector).toContainText('acme/api');
      // A GitHub run has no Stop (D1b).
      await expect(
        row.getByTestId(/^background-tray-run-.+-stop$/),
      ).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Open on GitHub', exact: true }),
      ).toBeVisible();
      await expectRunJob(panel, '501', 'Build macOS: running');
      await expectRunJob(panel, '502', 'Test: pending');
      await expect(
        inspector.getByTestId('background-tray-run-watchers-101'),
      ).toBeVisible();

      // The watcher's own poll observes the build job completing; the row
      // follows that broadcast rather than issuing a request of its own.
      const requestsBefore =
        (await getGithubScenario(ACTIVITY_TOKEN)).workflowRunJobRequests
          ?.length ?? 0;
      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('in_progress', null, '"in-progress"'),
          },
          workflowRunJobs: {
            'acme/api/101/1': {
              jobs: [
                workflowJob('completed', 'success'),
                workflowJob('in_progress', null, TEST_JOB),
              ],
            },
          },
        },
        ACTIVITY_TOKEN,
      );
      // The observer's transient backoff can reach 60s; allow a full cycle.
      await expectRunJob(panel, '501', 'Build macOS: success', 90_000);
      await expectRunJob(panel, '502', 'Test: running');
      const jobRequests = (await getGithubScenario(ACTIVITY_TOKEN))
        .workflowRunJobRequests;
      // Every jobs read is the observer's paged attempt read; nothing else
      // touched the jobs endpoint on behalf of the row.
      expect(
        jobRequests
          .slice(requestsBefore)
          .every((request) => request.key === 'acme/api/101/1'),
      ).toBe(true);

      // The run completes: the grouped watcher settles and retires, and the
      // row keeps the terminal state from the completed watcher summary.
      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('completed', 'success', '"success"'),
          },
          workflowRunJobs: {
            'acme/api/101/1': {
              jobs: [
                workflowJob('completed', 'success'),
                workflowJob('completed', 'success', TEST_JOB),
              ],
            },
          },
        },
        ACTIVITY_TOKEN,
      );
      await expect
        .poll(
          () => persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID)?.status,
          {
            timeout: 90_000,
          },
        )
        .toBe('fired');
      // With no active work left the drawer hides; the completed record remains in chat.
      await expect(panel.getByTestId('composer-work-drawer')).toHaveCount(0);
      await expect(
        panel.getByTestId('background-tray-run-watchers-101'),
      ).toHaveCount(0);
      const turnBox = panel.getByTestId('agent-activity-completed');
      const activityToggle = turnBox.getByRole('button', {
        name: /^(Expand|Collapse) agent activity$/,
      });
      await expect(activityToggle).toBeVisible();
      if ((await activityToggle.getAttribute('aria-expanded')) === 'false') {
        await activityToggle.click();
      }
      await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
      const finishedCard = turnBox.getByTestId('github-workflow-run-card-101');
      await expect(finishedCard).toBeVisible();
      await expect(
        panel.getByTestId('github-workflow-run-card-101'),
      ).toHaveCount(1);
      await expect(finishedCard.locator('[role="button"] button')).toHaveCount(
        0,
      );
      await expect(finishedCard).toHaveAttribute('data-run-status', 'success', {
        timeout: 30_000,
      });
      const finishedTestDot = finishedCard.locator('[data-job-id="502"]');
      await expect(finishedTestDot).toHaveAttribute(
        'aria-label',
        'Test: success',
      );
      await expect(
        panel.getByTestId('github-workflow-run-watchers-101'),
      ).toHaveCount(0);
      // The final snapshot is carried on the turn itself (persisted by main),
      // so it survives the watcher's eventual pruning.
      const carriedRun = () =>
        JSON.parse(persistedChatText(userDataDir))
          .tabs.find((tab) => tab.id === CHAT_ID)
          ?.agentArtifactCarryByTurn?.[ACTIVITY_TURN_ID]?.find(
            (receipt) => receipt.kind === 'github_workflow_run',
          );
      await expect
        .poll(() => carriedRun()?.state, { timeout: 30_000 })
        .toEqual({ kind: 'terminal', conclusion: 'success' });
      expect(carriedRun()).toMatchObject({
        repository: 'acme/api',
        runId: '101',
        jobs: [
          expect.objectContaining({ jobId: '501', conclusion: 'success' }),
          expect.objectContaining({ jobId: '502', conclusion: 'success' }),
        ],
      });

      // Clicking a job dot or the card opens GitHub's own page externally
      // when app links leave the built-in browser. They open in it by default
      // (covered in browser-chrome.spec.mjs), so this flow turns that off.
      await window.evaluate(() =>
        window.api.savePreferences({ openAppLinksInBuiltInBrowser: false }),
      );
      await finishedTestDot.click();
      await expect
        .poll(() => externalOpen.opened)
        .toEqual(['https://github.com/acme/api/actions/runs/101/job/502']);
      await finishedCard
        .getByRole('button', { name: 'Open CI #42 on GitHub' })
        .click();
      await expect
        .poll(() => externalOpen.opened)
        .toEqual([
          'https://github.com/acme/api/actions/runs/101/job/502',
          'https://github.com/acme/api/actions/runs/101',
        ]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await externalOpen.close();
    }
  });

  test('shows the final run state while the watcher delivery is still pending', async () => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, PENDING_DELIVERY_TOKEN);
    seedWorkspaceAndChat(userDataDir);
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
          target: {
            ...activeWatcher().target,
            notifyOn: { statuses: [], conclusions: ['success', 'failure'] },
          },
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
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': workflowRun('in_progress', null, '"in-progress"'),
        },
        workflowRunJobs: {
          'acme/api/101/1': { jobs: [workflowJob('in_progress')] },
        },
      },
      PENDING_DELIVERY_TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: PENDING_DELIVERY_TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();
      await injectActiveTurn(electronApp);

      const panel = window.getByTestId('panel-content-chat');
      const { row } = await openRunRow(panel);
      await expect(row).not.toContainText('Succeeded');

      // The destination chat never finishes accepting the watcher message,
      // like a busy session, so the watcher stays firing. Main dispatches
      // watcher messages itself, so hold them in main, not over IPC.
      await electronApp.evaluate((_, chatId) => {
        globalThis.__CANOPY_E2E_WATCHER_DELIVERY_HOLD__ = {
          chatId,
          released: new Promise(() => {}),
        };
      }, CHAT_ID);

      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('completed', 'success', '"success"'),
          },
          workflowRunJobs: {
            'acme/api/101/1': {
              jobs: [workflowJob('completed', 'success')],
            },
          },
        },
        PENDING_DELIVERY_TOKEN,
      );
      // The observer's transient backoff can reach 60s; allow a full cycle.
      await expect
        .poll(
          () => persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID)?.status,
          { timeout: 90_000 },
        )
        .toBe('firing');
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expectCompletedJob(panel, '501', 'Build macOS: success');
      expect(persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID)?.status).toBe(
        'firing',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('bounds repeated full-job carry and restores the newest run card after relaunch', async () => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, CARRY_BUDGET_TOKEN);
    seedWorkspaceAndChat(userDataDir);
    const largeJobs = Array.from({ length: 500 }, (_, index) => ({
      id: 10_000 + index,
      jobId: String(10_000 + index),
      name: `${String(index).padStart(3, '0')}-${'n'.repeat(196)}`,
    }));
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: 'workflow-carry-budget-watcher',
          label: 'Large CI job progress',
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101/',
                runAttempt: 1,
                last: snapshot('in_progress'),
                jobs: largeJobs.map((job) =>
                  jobSnapshot('in_progress', null, job),
                ),
              },
            ],
          },
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': {
            ...workflowRun('in_progress'),
            responseDelayMs: 30_000,
          },
        },
      },
      CARRY_BUDGET_TOKEN,
    );

    const firstLaunch = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: CARRY_BUDGET_TOKEN },
    });
    try {
      const window = await firstLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();

      for (let index = 1; index <= 6; index += 1) {
        const turnId = `large-carry-turn-${index}`;
        const timestamp = ACTIVITY_TURN_AT + index * 10_000;
        await injectChatEvent(firstLaunch.electronApp, {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          data: {
            type: 'claude_terminal_transcript_sync',
            importedEventCount: 2,
            messages: [
              {
                id: turnId,
                role: 'user',
                blocks: [
                  { type: 'text', text: `Continue large watch ${index}` },
                ],
                timestamp,
              },
              {
                id: `${turnId}-timer`,
                role: 'system',
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: timestamp,
                    ...(index === 6
                      ? { pausedAt: timestamp + 1_000, completedAt: null }
                      : { completedAt: timestamp + 1_000 }),
                  },
                ],
                timestamp: timestamp + 1_000,
              },
            ],
          },
        });
        await expect(
          window.getByText(`Continue large watch ${index}`),
        ).toBeVisible();
      }

      await expect
        .poll(() => {
          const persisted = JSON.parse(persistedChatText(userDataDir));
          const carry = persisted.tabs.find(
            (tab) => tab.id === CHAT_ID,
          )?.agentArtifactCarryByTurn;
          return {
            bytes: carry ? Buffer.byteLength(JSON.stringify(carry), 'utf8') : 0,
            newestJobs: carry?.['large-carry-turn-6']?.[0]?.jobs?.length,
          };
        })
        .toEqual({ bytes: expect.any(Number), newestJobs: 500 });
      const persisted = JSON.parse(persistedChatText(userDataDir));
      const carry = persisted.tabs.find(
        (tab) => tab.id === CHAT_ID,
      )?.agentArtifactCarryByTurn;
      expect(
        Buffer.byteLength(JSON.stringify(carry), 'utf8'),
      ).toBeLessThanOrEqual(512 * 1024);
    } finally {
      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const relaunch = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: CARRY_BUDGET_TOKEN },
    });
    try {
      const window = await relaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      // The newest run is still live, so it is the drawer's again.
      const { row } = await openRunRow(
        window.getByTestId('panel-content-chat'),
      );
      await expect(row).not.toContainText('Succeeded');
    } finally {
      await closeCanopy(relaunch.electronApp, userDataDir);
    }
  });

  test('follows job progress for a run-only watcher that never asked for job events', async () => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, RUN_ONLY_TOKEN);
    seedWorkspaceAndChat(userDataDir);
    // The persisted shape an agent's `notifyOn.run` watcher leaves behind: run
    // cursors only, no job baseline, no job conclusions selected.
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
          label: 'CI run status',
          target: {
            ...activeWatcher().target,
            notifyOn: { statuses: [], conclusions: ['success', 'failure'] },
          },
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101/',
                runAttempt: 1,
                last: snapshot('in_progress'),
              },
            ],
          },
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': workflowRun('in_progress', null, '"in-progress"'),
        },
        workflowRunJobs: {
          'acme/api/101/1': {
            // GitHub only creates a job once its `needs` are met, so the test
            // job's created_at after the build's completed_at is the DAG.
            jobs: [
              workflowJob('completed', 'success', {
                created_at: '2026-07-20T00:00:00Z',
                completed_at: '2026-07-20T00:01:00Z',
              }),
              workflowJob('in_progress', null, {
                ...TEST_JOB,
                created_at: '2026-07-20T00:01:00Z',
              }),
            ],
          },
        },
      },
      RUN_ONLY_TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: RUN_ONLY_TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();
      await injectActiveTurn(electronApp);

      const panel = window.getByTestId('panel-content-chat');
      const { row, inspector: card } = await openRunRow(panel);
      await expect(row).not.toContainText('Succeeded');

      // The watcher's own poll reads the jobs even though no job event was
      // selected, so the row grows one dot per job in GitHub's order.
      // The observer's transient backoff can reach 60s; allow a full cycle.
      await expectRunJob(panel, '501', 'Build macOS: success', 90_000);
      await expectRunJob(panel, '502', 'Test: running');
      // The dots group into tiers inferred from when GitHub created each job:
      // the test job appeared only after the build completed.
      const tiers = card.getByTestId('dag-progress-tier');
      await expect(tiers).toHaveCount(2);
      await expect(tiers.nth(0).locator('[data-job-id]')).toHaveAttribute(
        'data-job-id',
        '501',
      );
      await expect(tiers.nth(1).locator('[data-job-id]')).toHaveAttribute(
        'data-job-id',
        '502',
      );

      // Progress never turns into a delivery: the completed build job was not
      // selected, so the watcher is still quietly active with its cursors.
      const watcher = persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID);
      expect(watcher?.status).toBe('active');
      expect(watcher?.runtimeState?.items?.[0]?.jobs).toEqual([
        expect.objectContaining({ jobId: '501', conclusion: 'success' }),
        expect.objectContaining({ jobId: '502', status: 'in_progress' }),
      ]);
      expect(watcher?.runtimeState?.queuedEvents ?? []).toEqual([]);
      expect(watcher?.runtimeState?.pendingDelivery).toBeUndefined();

      // A terminal run must not retire a run-only watcher until its final jobs
      // snapshot is available. A transient jobs failure keeps the in-progress
      // row and durable watcher alive for the observer's retry.
      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('completed', 'success', '"success"'),
          },
          workflowRunJobs: {
            'acme/api/101/1': { responseStatus: 500, jobs: [] },
          },
        },
        RUN_ONLY_TOKEN,
      );
      await expect
        .poll(
          async () =>
            (await getGithubScenario(RUN_ONLY_TOKEN)).workflowRunJobRequests
              ?.length ?? 0,
          { timeout: 90_000 },
        )
        .toBeGreaterThan(1);
      expect(persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID)?.status).toBe(
        'active',
      );
      await expect(row).not.toContainText('Succeeded');

      await setScenario(
        {
          workflowRuns: {
            'acme/api/101': workflowRun('completed', 'success', '"success"'),
          },
          workflowRunJobs: {
            'acme/api/101/1': {
              jobs: [
                workflowJob('completed', 'success'),
                workflowJob('completed', 'success', TEST_JOB),
              ],
            },
          },
        },
        RUN_ONLY_TOKEN,
      );
      await expect
        .poll(
          () => persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID)?.status,
          { timeout: 90_000 },
        )
        .toBe('fired');
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expectCompletedJob(panel, '502', 'Test: success');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('lays the card out from the workflow definition with pending dots for jobs GitHub has not created', async () => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    await primeStoredPat(userDataDir, DEFINITION_TOKEN);
    seedWorkspaceAndChat(userDataDir);
    // A watcher persisted before definitions were captured: run cursors only.
    seedWatchers({
      userDataDir,
      watchers: [
        activeWatcher({
          id: ACTIVITY_WATCHER_ID,
          label: 'CI run status',
          target: {
            ...activeWatcher().target,
            notifyOn: { statuses: [], conclusions: ['success', 'failure'] },
          },
          runtimeState: {
            kind: 'github_workflow_runs',
            items: [
              {
                key: 'acme/api/101/',
                runAttempt: 1,
                last: snapshot('in_progress'),
              },
            ],
          },
        }),
      ],
    });
    await setScenario(
      {
        workflowRuns: {
          'acme/api/101': {
            ...workflowRun('in_progress', null, '"in-progress"'),
            path: '.github/workflows/ci.yml@main',
            head_sha: DEFINITION_SHA,
            referenced_workflows: [],
          },
        },
        repositoryContents: {
          [`acme/api/.github/workflows/ci.yml@${DEFINITION_SHA}`]: {
            content: DEFINITION_YAML,
          },
          [`acme/api/.github/workflows/lint.yml@${DEFINITION_SHA}`]: {
            content: NESTED_REUSABLE_YAML,
          },
        },
        // GitHub has created one test shard, a constant-name dynamic matrix,
        // nested/optional/long-name jobs, and deploy. The expression-only
        // dynamic job is not safely identifiable and remains a placeholder.
        workflowRunJobs: {
          'acme/api/101/1': {
            jobs: [
              workflowJob('completed', 'success'),
              workflowJob('in_progress', null, {
                id: 502,
                name: 'Test (0/2 shard 1)',
              }),
              workflowJob('completed', 'success', {
                id: 503,
                name: 'Dynamic (canopy)',
              }),
              workflowJob('queued', null, { id: 504, name: 'Deploy' }),
              workflowJob('completed', 'success', {
                id: 505,
                name: 'PR / Lint / ESLint',
              }),
              workflowJob('completed', 'success', {
                id: 506,
                name: 'Optional-',
              }),
              workflowJob('completed', 'success', {
                id: 507,
                name: LONG_DEFINITION_JOB_NAME,
              }),
            ],
          },
        },
      },
      DEFINITION_TOKEN,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { GH_TOKEN: DEFINITION_TOKEN },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(
        window.getByTestId(`chat-input-watchers-${CHAT_ID}`),
      ).toBeVisible();
      await injectActiveTurn(electronApp);

      const panel = window.getByTestId('panel-content-chat');
      const { inspector: card } = await openRunRow(panel);

      // The observer reads the pinned workflow file on its first poll and the
      // row lays out all declared work in four tiers, with the jobs
      // GitHub has not created yet as pending placeholders.
      const tiers = card.getByTestId('dag-progress-tier');
      await expect(tiers).toHaveCount(4, { timeout: 90_000 });
      await expect(tiers.nth(0).locator('[data-job-id]')).toHaveAttribute(
        'aria-label',
        'Build macOS: success',
      );
      await expect(tiers.nth(1).locator('[data-job-id]')).toHaveCount(3);
      await expect(card.locator('[data-job-id="502"]')).toHaveAttribute(
        'aria-label',
        'Test (0/2 shard 1): running',
      );
      await expect(
        card.locator('[data-job-id="definition:test:1"]'),
      ).toHaveAttribute('aria-label', 'Test (1/2 shard 2): pending');
      await expect(card.locator('[data-job-id="503"]')).toHaveAttribute(
        'aria-label',
        'Dynamic (canopy): success',
      );
      await expect(
        card.locator('[data-job-id="definition:wildcard"]'),
      ).toHaveAttribute('aria-label', '${{ matrix.label }}: pending');
      await expect(card.locator('[data-job-id="504"]')).toHaveAttribute(
        'aria-label',
        'Deploy: pending',
      );
      await expect(card.locator('[data-job-id="505"]')).toHaveAttribute(
        'aria-label',
        'PR / Lint / ESLint: success',
      );
      await expect(card.locator('[data-job-id="506"]')).toHaveAttribute(
        'aria-label',
        'Optional-: success',
      );
      await expect(card.locator('[data-job-id="507"]')).toHaveAttribute(
        'aria-label',
        `${LONG_DEFINITION_JOB_NAME}: success`,
      );
      await expect(
        card.locator('[data-job-id="definition:dynamic"]'),
      ).toHaveCount(0);
      await expect(
        card.locator('[data-job-id="definition:deploy:0"]'),
      ).toHaveCount(0);

      // The definition was read once, at the run's commit, and persisted
      // with the watcher so a restart never re-reads it.
      const scenario = await getGithubScenario(DEFINITION_TOKEN);
      expect(scenario.contentsRequests.map((request) => request.key)).toEqual([
        `acme/api/.github/workflows/ci.yml@${DEFINITION_SHA}`,
        `acme/api/.github/workflows/lint.yml@${DEFINITION_SHA}`,
      ]);
      const watcher = persistedWatcher(userDataDir, ACTIVITY_WATCHER_ID);
      expect(watcher?.runtimeState?.items?.[0]?.definition).toMatchObject({
        sha: DEFINITION_SHA,
        jobs: [
          expect.objectContaining({ id: 'build' }),
          expect.objectContaining({
            id: 'test',
            names: ['Test (0/2 shard 1)', 'Test (1/2 shard 2)'],
          }),
          expect.objectContaining({ id: 'dynamic', dynamic: true }),
          expect.objectContaining({ id: 'wildcard', dynamic: true }),
          expect.objectContaining({
            id: 'nested/lint',
            template: 'PR / Lint',
            dynamic: true,
          }),
          expect.objectContaining({ id: 'optional' }),
          expect.objectContaining({ id: 'long-name' }),
          expect.objectContaining({
            id: 'deploy',
            needs: ['dynamic', 'wildcard'],
          }),
        ],
      });
      expect(watcher?.runtimeState?.items?.[0]?.last?.definitionSource).toEqual(
        {
          path: '.github/workflows/ci.yml',
          sha: DEFINITION_SHA,
          referenced: [],
        },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
