import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWatchers,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';

// End-to-end proof for GitHub pull request watchers (WatchGitHubItems with
// `{kind:"pull_request"}` items). The app reads each PR through its real
// broker/Octokit GraphQL path; the E2E build redirects api.github.com to the
// shared mock, which answers the watcher query from `github.pullRequests`
// keyed by the bearer token each test registers.
//
// The pull request observer has no E2E poll override: the first read of a
// watched PR is due 45 s ±20% after the subscription appears, and transient
// failures back off 10 s, then 20 s. Waits below are sized for that cadence.

const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'pr-watcher-chat';
const CHAT_TITLE = 'Pull request watcher chat';
const REPOSITORY = 'acme/api';
const NOW = '2026-07-20T00:00:00.000Z';
const MOCK_TERMINAL_AT = '2026-07-20T00:05:00.000Z';
const DEFAULT_HEAD_SHA = 'a'.repeat(40);
const DEFAULT_MERGE_SHA = 'c'.repeat(40);
// One observer read plus delivery: 54 s worst-case first poll and headroom.
const OBSERVATION_TIMEOUT_MS = 90_000;

// The mock keys scenarios by bearer token; each test owns its own token so
// concurrent workers never share request records.
const TOOL_TOKEN = 'ghp_e2e_pr_watcher_tool';
const GROUPED_TOKEN = 'ghp_e2e_pr_watcher_grouped';
const RESTART_TOKEN = 'ghp_e2e_pr_watcher_restart';
const TRANSIENT_TOKEN = 'ghp_e2e_pr_watcher_transient';
const QUEUE_REMOVAL_TOKEN = 'ghp_e2e_pr_watcher_queue_removal';
const QUEUE_REENTRY_TOKEN = 'ghp_e2e_pr_watcher_queue_reentry';
const QUEUE_RESTART_TOKEN = 'ghp_e2e_pr_watcher_queue_restart';
const QUEUE_UNAVAILABLE_TOKEN = 'ghp_e2e_pr_watcher_queue_unavailable';
const TOOL_MARKER = 'Canopy-CPRWATCHERTOOL';
// A recorded read precedes its interpretation; this lets a negative
// assertion see the result of the read it waited for.
const READ_SETTLE_MS = 5_000;

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-pr-watcher-'));
}

async function setGithubScenario(scenarioKey, github) {
  const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: scenarioKey, scenario: { github } }),
  });
  expect(response.ok).toBe(true);
}

async function getGithubScenario(scenarioKey) {
  const response = await fetch(
    `${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(scenarioKey)}`,
  );
  expect(response.ok).toBe(true);
  return (await response.json()).scenario.github ?? {};
}

async function clearScenario(scenarioKey) {
  await fetch(
    `${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(scenarioKey)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

async function pullRequestRequestKeys(scenarioKey) {
  return ((await getGithubScenario(scenarioKey)).pullRequestRequests ?? []).map(
    (entry) => entry.key,
  );
}

async function waitForPullRequestReads(scenarioKey, count) {
  await expect
    .poll(async () => (await pullRequestRequestKeys(scenarioKey)).length, {
      timeout: OBSERVATION_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(count);
}

/** Wait for one read after the current count, then for its interpretation. */
async function waitForNextPullRequestRead(scenarioKey) {
  const before = (await pullRequestRequestKeys(scenarioKey)).length;
  await waitForPullRequestReads(scenarioKey, before + 1);
  await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS));
}

/** Mock `pullRequests` entry key for one PR in the test repository. */
function prKey(number) {
  return `${REPOSITORY}/${number}`;
}

function prUrl(number) {
  return `https://github.com/${REPOSITORY}/pull/${number}`;
}

/** The normalized snapshot the app stores for the mock's default open PR. */
function openSnapshot(number) {
  return {
    state: 'open',
    url: prUrl(number),
    title: `Mock pull request #${number}`,
    baseRefName: 'main',
    headSha: DEFAULT_HEAD_SHA,
    mergedAt: null,
    mergeCommitSha: null,
    closedAt: null,
    queue: null,
    observedAt: NOW,
  };
}

function destination() {
  return {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    chatTitle: CHAT_TITLE,
  };
}

/** Persisted shape WatchGitHubItems writes for open pull requests. */
function pullRequestWatcher(id, numbers) {
  return {
    id,
    trigger: 'github_pull_requests_changed',
    label: `Pull requests ${numbers.join(', ')}`,
    target: {
      kind: 'github_pull_requests',
      items: numbers.map((number) => ({
        kind: 'pull_request',
        repository: REPOSITORY,
        number,
      })),
      display: {
        repositories: [REPOSITORY],
        sample: numbers.map((number) => ({
          repository: REPOSITORY,
          number,
          title: `Mock pull request #${number}`,
        })),
      },
    },
    destination: destination(),
    runtimeState: {
      kind: 'github_pull_requests',
      items: numbers.map((number) => ({
        key: `${REPOSITORY}#${number}`,
        last: openSnapshot(number),
      })),
    },
  };
}

// Merge queue timeline fixtures. Event `index` is the 1-based filtered
// timeline position; times are already normalized ISO strings.
function queueTime(index) {
  return new Date(Date.parse(NOW) + index * 10_000).toISOString();
}

function queueAdded(number, index) {
  return {
    type: 'added',
    id: `AQE_${number}_${index}`,
    createdAt: queueTime(index),
  };
}

function queueRemoved(number, index, reason) {
  return {
    type: 'removed',
    id: `RQE_${number}_${index}`,
    createdAt: queueTime(index),
    reason,
  };
}

/** GraphQL `mergeQueueEntry` created by the `added` event at `index`. */
function queueEntry(number, index, position = 1) {
  return {
    id: `MQE_${number}_${index}`,
    enqueuedAt: queueTime(index),
    state: 'QUEUED',
    position,
  };
}

/** Mock `pullRequests` config for an open PR queued as `entry`. */
function queuedPullRequest(entry, queueTimeline) {
  return { isInMergeQueue: true, mergeQueueEntry: entry, queueTimeline };
}

/** The snapshot the app stores for {@link queuedPullRequest}. */
function queuedSnapshot(number, entry) {
  return {
    ...openSnapshot(number),
    queue: {
      entryId: entry.id,
      enqueuedAt: entry.enqueuedAt,
      phase: 'queued',
      position: entry.position,
    },
  };
}

/** A persisted watcher for one PR with a baselined timeline cursor. */
function queueWatcher(id, number, { last, queueCursor, notifyOn }) {
  const watcher = pullRequestWatcher(id, [number]);
  return {
    ...watcher,
    target: { ...watcher.target, ...(notifyOn ? { notifyOn } : {}) },
    runtimeState: {
      kind: 'github_pull_requests',
      items: [{ key: `${REPOSITORY}#${number}`, last, queueCursor }],
    },
  };
}

/** Identity fields every event for a mock PR carries. */
function eventIdentity(number) {
  return {
    repository: REPOSITORY,
    number,
    url: prUrl(number),
    baseBranch: 'main',
    headSha: DEFAULT_HEAD_SHA,
  };
}

function timelineRemovalEvent(number, removal, requeued) {
  return {
    kind: 'pull_request_queue_removed',
    ...eventIdentity(number),
    removedAt: removal.createdAt,
    reason: removal.reason,
    evidence: 'timeline',
    requeued,
  };
}

/** Wait until a delivered, non-settling event leaves the watcher idle. */
async function expectWatcherActive(userDataDir, watcherId) {
  await expect
    .poll(
      () => {
        const watcher = persistedWatcher(userDataDir, watcherId);
        return {
          status: watcher?.status,
          pending: watcher?.runtimeState?.pendingDelivery ?? null,
          queued: watcher?.runtimeState?.queuedEvents ?? [],
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ status: 'active', pending: null, queued: [] });
  return persistedWatcher(userDataDir, watcherId);
}

function seedWorkspaceAndChat(userDataDir) {
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // Live turns call tools without stopping for an approval decision.
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: CHAT_TITLE, messages: [] }],
  });
  return demo;
}

function readWatchers(userDataDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(userDataDir, 'app-advisor-watchers.json'), 'utf8'),
    ).watchers;
  } catch {
    return [];
  }
}

function persistedWatcher(userDataDir, watcherId) {
  return readWatchers(userDataDir).find((entry) => entry.id === watcherId);
}

function pullRequestWatchers(userDataDir) {
  return readWatchers(userDataDir).filter(
    (entry) => entry.trigger === 'github_pull_requests_changed',
  );
}

function runtimeItem(watcher, number) {
  return watcher?.runtimeState?.items?.find(
    (item) => item.key === `${REPOSITORY}#${number}`,
  );
}

async function launch(userDataDir, token) {
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir, env: { GH_TOKEN: token } }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { electronApp, window, app };
}

/**
 * Every watcher message main dispatched in this app process (#5144: main, not
 * the renderer, delivers fired watchers). The hidden context is the exact
 * event payload the agent sees.
 */
async function watcherSends(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__CANOPY_E2E_WATCHER_DELIVERIES__ ?? [],
  );
}

/** The JSON fired context inside the hidden `<…_watcher_event>` envelope. */
function firedContext(send) {
  const match =
    /<([a-z0-9_]+)_watcher_event>\s*([\s\S]*?)\s*<\/\1_watcher_event>/.exec(
      send?.hiddenContextText ?? '',
    );
  return match ? JSON.parse(match[2]) : null;
}

async function waitForSends(electronApp, count) {
  await expect
    .poll(async () => (await watcherSends(electronApp)).length, {
      timeout: OBSERVATION_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(count);
  return watcherSends(electronApp);
}

/** Every WatchGitHubItems result in the chat transcript, in call order. */
function readWatchToolResults(userDataDir) {
  let raw;
  try {
    raw = readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'chat-storage-v2',
        WORKTREE_ID,
        'transcripts',
        `${CHAT_ID}.jsonl`,
      ),
      'utf8',
    );
  } catch {
    return [];
  }
  const blocks = raw
    .trim()
    .split('\n')
    .flatMap((line) => JSON.parse(line).blocks ?? []);
  const callIds = blocks
    .filter(
      (block) =>
        block.type === 'tool_use' &&
        String(block.toolName).includes('WatchGitHubItems'),
    )
    .map((block) => block.toolUseId);
  return callIds
    .map((id) =>
      blocks.find(
        (block) => block.type === 'tool_result' && block.toolUseId === id,
      ),
    )
    .filter(Boolean);
}

function toolResultPayload(result) {
  const output = Array.isArray(result.output)
    ? result.output
        .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('')
    : result.output;
  return typeof output === 'string' ? JSON.parse(output) : output;
}

async function sendMessage(window, text) {
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  const composer = panel.getByRole('textbox').last();
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(panel.getByText(text).first()).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function attachDiagnostics(testInfo, userDataDir) {
  for (const relative of ['app-advisor-watchers.json', 'logs/main.log']) {
    try {
      await testInfo.attach(relative.replaceAll('/', '-'), {
        body: readFileSync(path.join(userDataDir, relative)),
        contentType: 'text/plain',
      });
    } catch {
      /* Missing diagnostics do not replace the assertion. */
    }
  }
}

test.describe('GitHub pull request watchers against the GraphQL mock', () => {
  test.afterEach(async () => {
    await Promise.all([
      clearScenario(TOOL_TOKEN),
      clearScenario(GROUPED_TOKEN),
      clearScenario(RESTART_TOKEN),
      clearScenario(TRANSIENT_TOKEN),
      clearScenario(QUEUE_REMOVAL_TOKEN),
      clearScenario(QUEUE_REENTRY_TOKEN),
      clearScenario(QUEUE_RESTART_TOKEN),
      clearScenario(QUEUE_UNAVAILABLE_TOKEN),
      clearScenario(TOOL_MARKER),
    ]);
  });

  test('WatchGitHubItems reports per-item outcomes, watches only the open PR, and wakes the chat on merge', async ({}, testInfo) => {
    test.setTimeout(240_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const headSha = '1'.repeat(40);
    const mergeSha = '2'.repeat(40);
    const openSeven = { baseRefName: 'develop', headRefOid: headSha };
    await setGithubScenario(TOOL_TOKEN, {
      pullRequests: {
        [prKey(7)]: openSeven,
        [prKey(8)]: { state: 'MERGED' },
        [prKey(9)]: { state: 'CLOSED' },
      },
    });
    // Two calls in one turn: an open + merged pair, then an all-terminal pair.
    await registerScenario(MOCK_BASE_URL, TOOL_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                id: 'watch-open-and-merged',
                name: 'mcp__canopy__WatchGitHubItems',
                input: {
                  items: [
                    { kind: 'pull_request', repository: REPOSITORY, number: 7 },
                    { kind: 'pull_request', repository: REPOSITORY, number: 8 },
                  ],
                  followUpInstruction: 'Report the merge.',
                },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                id: 'watch-all-terminal',
                name: 'mcp__canopy__WatchGitHubItems',
                input: {
                  items: [
                    { kind: 'pull_request', target: `${REPOSITORY}#8` },
                    { kind: 'pull_request', target: `${REPOSITORY}#9` },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: 'Watching the open pull request', stopReason: 'end_turn' },
          { text: 'Pull request merge acknowledged', stopReason: 'end_turn' },
        ],
      },
    });

    let electronApp;
    try {
      let window;
      ({ electronApp, window } = await launch(userDataDir, TOOL_TOKEN));
      const panel = await sendMessage(
        window,
        `[${TOOL_MARKER}] Tell me when these pull requests land.`,
      );
      await expect(
        panel.getByText('Watching the open pull request').first(),
      ).toBeVisible({ timeout: 90_000 });
      // Turn blocks are committed when the turn settles.
      await expect
        .poll(() => readWatchToolResults(userDataDir).length, {
          timeout: 30_000,
        })
        .toBe(2);
      const [created, notCreated] = readWatchToolResults(userDataDir);
      expect(created.isError).not.toBe(true);
      const createdPayload = toolResultPayload(created);
      expect(createdPayload).toMatchObject({
        ok: true,
        status: 'created',
        itemCount: 1,
        events: [
          'pull_request_merged',
          'pull_request_closed',
          'pull_request_queue_removed',
          'pull_request_queue_history_incomplete',
        ],
      });
      expect(createdPayload.items).toEqual([
        {
          index: 0,
          repository: REPOSITORY,
          number: 7,
          url: prUrl(7),
          outcome: 'watching',
        },
        {
          index: 1,
          repository: REPOSITORY,
          number: 8,
          url: prUrl(8),
          outcome: 'merged',
          mergedAt: MOCK_TERMINAL_AT,
          mergeCommitSha: DEFAULT_MERGE_SHA,
          baseBranch: 'main',
        },
      ]);

      expect(notCreated.isError).not.toBe(true);
      expect(toolResultPayload(notCreated)).toEqual({
        ok: true,
        status: 'not_created',
        itemCount: 0,
        events: [],
        items: [
          {
            index: 0,
            repository: REPOSITORY,
            number: 8,
            url: prUrl(8),
            outcome: 'merged',
            mergedAt: MOCK_TERMINAL_AT,
            mergeCommitSha: DEFAULT_MERGE_SHA,
            baseBranch: 'main',
          },
          {
            index: 1,
            repository: REPOSITORY,
            number: 9,
            url: prUrl(9),
            outcome: 'closed',
            closedAt: MOCK_TERMINAL_AT,
          },
        ],
      });

      // Exactly one watcher, for the open PR only, with its setup baseline.
      const [watcher] = pullRequestWatchers(userDataDir);
      expect(pullRequestWatchers(userDataDir)).toHaveLength(1);
      expect(watcher).toMatchObject({
        status: 'active',
        destination: { chatId: CHAT_ID },
        target: {
          kind: 'github_pull_requests',
          items: [{ kind: 'pull_request', repository: REPOSITORY, number: 7 }],
        },
      });
      expect(watcher.runtimeState.items).toEqual([
        {
          key: `${REPOSITORY}#7`,
          last: expect.objectContaining({
            state: 'open',
            headSha,
            baseRefName: 'develop',
          }),
          queueCursor: { count: 0, lastEventId: null },
        },
      ]);
      // Setup read each pull request once, in order, before any poll. Both
      // calls reported #8 above, but the second call's setup reused the read
      // model's cached read instead of fetching #8 again.
      const requestKeys = await pullRequestRequestKeys(TOOL_TOKEN);
      expect(requestKeys.slice(0, 3)).toEqual([prKey(7), prKey(8), prKey(9)]);
      expect(requestKeys.filter((key) => key === prKey(8))).toHaveLength(1);

      // The composer's background drawer lists the watched pull request,
      // from its watcher's last snapshot (D1b); the settled ones are not.
      const drawerRow = (await openBackgroundDrawer(panel)).getByTestId(
        `background-tray-run-github-pr:${REPOSITORY}#7`,
      );
      await expect(drawerRow).toContainText('#7');
      await expect(drawerRow).toContainText('Open');
      await expect(
        panel.getByTestId(`background-tray-run-github-pr:${REPOSITORY}#8`),
      ).toHaveCount(0);

      await setGithubScenario(TOOL_TOKEN, {
        pullRequests: {
          [prKey(7)]: {
            ...openSeven,
            state: 'MERGED',
            mergeCommit: { oid: mergeSha },
          },
        },
      });
      const [send] = await waitForSends(electronApp, 1);
      expect(send.chatId).toBe(CHAT_ID);
      expect(send.text).toContain(
        `${REPOSITORY}#7 merged into develop as ${mergeSha.slice(0, 12)}: ${prUrl(7)}`,
      );
      const context = firedContext(send);
      expect(context).toMatchObject({
        watcherId: watcher.id,
        trigger: 'github_pull_requests_changed',
        progress: { total: 1, settled: 1, active: 0 },
        followUpInstruction: 'Report the merge.',
      });
      // Bounded: identity, base branch, head SHA, merge facts — nothing else.
      expect(context.events).toEqual([
        {
          kind: 'pull_request_merged',
          repository: REPOSITORY,
          number: 7,
          url: prUrl(7),
          baseBranch: 'develop',
          headSha,
          mergedAt: MOCK_TERMINAL_AT,
          mergeCommitSha: mergeSha,
        },
      ]);

      await expect
        .poll(() => persistedWatcher(userDataDir, watcher.id)?.status, {
          timeout: 30_000,
        })
        .toBe('fired');
      // Merged, it stays in the drawer until dismissed.
      await expect(drawerRow).toContainText('Merged', { timeout: 30_000 });
      await drawerRow
        .getByTestId(`background-tray-run-github-pr:${REPOSITORY}#7-dismiss`)
        .click();
      await expect(drawerRow).toHaveCount(0);
      await expect(panel.getByTestId('watcher-fired-title')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(
        panel.getByText('Pull request merge acknowledged').first(),
      ).toBeVisible({ timeout: 90_000 });
      expect(await watcherSends(electronApp)).toHaveLength(1);
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('a grouped watcher settles each pull request on its own and is consumed after both deliver', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-grouped-watcher';
    seedWatchers({
      userDataDir,
      watchers: [pullRequestWatcher(watcherId, [11, 12])],
    });
    await setGithubScenario(GROUPED_TOKEN, {
      pullRequests: {
        [prKey(11)]: { state: 'MERGED' },
        [prKey(12)]: {},
      },
    });

    let electronApp;
    try {
      let window;
      ({ electronApp, window } = await launch(userDataDir, GROUPED_TOKEN));
      const watchingButton = window.getByTestId(
        `chat-input-watchers-${CHAT_ID}`,
      );
      await expect(watchingButton).toBeVisible();
      await watchingButton.click();
      const watcherModal = window.getByTestId('watcher-management-modal');
      await expect(watcherModal).toContainText('2 pull requests');
      await watcherModal.getByRole('button', { name: 'Close' }).click();

      // #11 merged: one event, the group stays active for #12.
      const [mergedSend] = await waitForSends(electronApp, 1);
      expect(mergedSend.text).toContain(
        `${REPOSITORY}#11 merged into main as ${DEFAULT_MERGE_SHA.slice(0, 12)}`,
      );
      expect(mergedSend.text).toContain('1 of 2 pull requests still open.');
      const mergedContext = firedContext(mergedSend);
      expect(mergedContext.progress).toEqual({
        total: 2,
        settled: 1,
        active: 1,
      });
      expect(mergedContext.events).toEqual([
        {
          kind: 'pull_request_merged',
          repository: REPOSITORY,
          number: 11,
          url: prUrl(11),
          baseBranch: 'main',
          headSha: DEFAULT_HEAD_SHA,
          mergedAt: MOCK_TERMINAL_AT,
          mergeCommitSha: DEFAULT_MERGE_SHA,
        },
      ]);
      await expect
        .poll(
          () => {
            const watcher = persistedWatcher(userDataDir, watcherId);
            return {
              status: watcher?.status,
              pending: watcher?.runtimeState?.pendingDelivery ?? null,
              merged: runtimeItem(watcher, 11)?.settledAs ?? null,
              open: runtimeItem(watcher, 12)?.settledAt ?? null,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({
          status: 'active',
          pending: null,
          merged: 'merged',
          open: null,
        });

      // #12 closes without merging: the second event consumes the group.
      await setGithubScenario(GROUPED_TOKEN, {
        pullRequests: {
          [prKey(11)]: { state: 'MERGED' },
          [prKey(12)]: { state: 'CLOSED' },
        },
      });
      const sends = await waitForSends(electronApp, 2);
      expect(sends).toHaveLength(2);
      expect(sends[1].text).toContain(
        `${REPOSITORY}#12 was closed without merging: ${prUrl(12)}`,
      );
      expect(sends[1].text).not.toContain('still open');
      const closedContext = firedContext(sends[1]);
      expect(closedContext.progress).toEqual({
        total: 2,
        settled: 2,
        active: 0,
      });
      expect(closedContext.events).toEqual([
        {
          kind: 'pull_request_closed',
          repository: REPOSITORY,
          number: 12,
          url: prUrl(12),
          baseBranch: 'main',
          headSha: DEFAULT_HEAD_SHA,
          closedAt: MOCK_TERMINAL_AT,
        },
      ]);
      expect(closedContext.eventId).not.toBe(mergedContext.eventId);
      await expect
        .poll(() => persistedWatcher(userDataDir, watcherId)?.status, {
          timeout: 30_000,
        })
        .toBe('fired');
      expect(
        runtimeItem(persistedWatcher(userDataDir, watcherId), 12)?.settledAs,
      ).toBe('closed');
      // The settled #11 was never read again after its event.
      const keys = await pullRequestRequestKeys(GROUPED_TOKEN);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key === prKey(12))).toBe(true);
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('a watcher survives relaunch without a false event and still fires', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-restart-watcher';
    seedWatchers({
      userDataDir,
      watchers: [pullRequestWatcher(watcherId, [21])],
    });
    await setGithubScenario(RESTART_TOKEN, {
      pullRequests: { [prKey(21)]: {} },
    });

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, RESTART_TOKEN));
      // The open read matches the persisted baseline: nothing is delivered.
      await waitForPullRequestReads(RESTART_TOKEN, 1);
      expect(await watcherSends(electronApp)).toEqual([]);
      const before = persistedWatcher(userDataDir, watcherId);
      expect(before.status).toBe('active');
      expect(before.runtimeState.pendingDelivery).toBeUndefined();
      expect(runtimeItem(before, 21)).toMatchObject({
        last: { state: 'open' },
      });
      expect(runtimeItem(before, 21).settledAt).toBeUndefined();
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;

      await setGithubScenario(RESTART_TOKEN, {
        pullRequests: { [prKey(21)]: { state: 'MERGED' } },
      });
      ({ electronApp } = await launch(userDataDir, RESTART_TOKEN));
      const [send] = await waitForSends(electronApp, 1);
      expect(firedContext(send).events).toEqual([
        expect.objectContaining({
          kind: 'pull_request_merged',
          number: 21,
          mergeCommitSha: DEFAULT_MERGE_SHA,
        }),
      ]);
      await expect
        .poll(() => persistedWatcher(userDataDir, watcherId)?.status, {
          timeout: 30_000,
        })
        .toBe('fired');
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('GraphQL errors and partial reads never deliver a merge', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-transient-watcher';
    seedWatchers({
      userDataDir,
      watchers: [pullRequestWatcher(watcherId, [31])],
    });
    // Partial data: GitHub reports a merge alongside a GraphQL error.
    await setGithubScenario(TRANSIENT_TOKEN, {
      pullRequests: {
        [prKey(31)]: {
          state: 'MERGED',
          errors: [
            {
              type: 'SERVICE_UNAVAILABLE',
              message: 'Something went wrong while executing your query.',
            },
          ],
        },
      },
    });

    const expectStillWatching = async () => {
      expect(await watcherSends(electronApp)).toEqual([]);
      const watcher = persistedWatcher(userDataDir, watcherId);
      expect(watcher.status).toBe('active');
      expect(watcher.runtimeState.pendingDelivery).toBeUndefined();
      expect(watcher.runtimeState.queuedEvents ?? []).toEqual([]);
      expect(runtimeItem(watcher, 31)).toEqual({
        key: `${REPOSITORY}#31`,
        last: openSnapshot(31),
      });
    };

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, TRANSIENT_TOKEN));
      await waitForPullRequestReads(TRANSIENT_TOKEN, 1);
      await expectStillWatching();

      // A merge read missing the non-null `merged` flag is a partial read.
      await setGithubScenario(TRANSIENT_TOKEN, {
        pullRequests: { [prKey(31)]: { state: 'MERGED', omit: ['merged'] } },
      });
      await waitForPullRequestReads(TRANSIENT_TOKEN, 1);
      await expectStillWatching();

      // The observer kept retrying: a clean read delivers exactly once.
      await setGithubScenario(TRANSIENT_TOKEN, {
        pullRequests: { [prKey(31)]: { state: 'MERGED' } },
      });
      const sends = await waitForSends(electronApp, 1);
      expect(sends).toHaveLength(1);
      expect(firedContext(sends[0]).events).toEqual([
        expect.objectContaining({ kind: 'pull_request_merged', number: 31 }),
      ]);
      await expect
        .poll(() => persistedWatcher(userDataDir, watcherId)?.status, {
          timeout: 30_000,
        })
        .toBe('fired');
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('a merge queue removal wakes the chat with its reason; a later merge settles the watcher without reporting the merged-reason removal', async ({}, testInfo) => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-queue-removal-watcher';
    const number = 41;
    const entry = queueEntry(number, 1);
    const enqueued = queueAdded(number, 1);
    const failed = queueRemoved(number, 2, 'failed_checks');
    seedWatchers({
      userDataDir,
      watchers: [
        queueWatcher(watcherId, number, {
          last: queuedSnapshot(number, entry),
          queueCursor: { count: 1, lastEventId: enqueued.id },
        }),
      ],
    });
    // GitHub dropped the entry for failing checks before the first read.
    await setGithubScenario(QUEUE_REMOVAL_TOKEN, {
      pullRequests: { [prKey(number)]: { queueTimeline: [enqueued, failed] } },
    });

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, QUEUE_REMOVAL_TOKEN));
      const [removedSend] = await waitForSends(electronApp, 1);
      expect(removedSend.chatId).toBe(CHAT_ID);
      expect(removedSend.text).toContain(
        `${REPOSITORY}#${number} was removed from the merge queue (failed_checks): ${prUrl(number)}`,
      );
      expect(removedSend.text).toContain('1 of 1 pull requests still open.');
      const removedContext = firedContext(removedSend);
      expect(removedContext).toMatchObject({
        watcherId,
        trigger: 'github_pull_requests_changed',
        progress: { total: 1, settled: 0, active: 1 },
      });
      expect(removedContext.events).toEqual([
        timelineRemovalEvent(number, failed, false),
      ]);

      // A queue event never settles the item; the cursor passed the removal.
      const removedItem = runtimeItem(
        await expectWatcherActive(userDataDir, watcherId),
        number,
      );
      expect(removedItem.settledAt).toBeUndefined();
      expect(removedItem.last.queue).toBeNull();
      expect(removedItem.queueCursor).toEqual({
        count: 2,
        lastEventId: failed.id,
      });
      expect(removedItem.queuePendingExit).toBeUndefined();

      // Re-queued, then removed with reason `merged` while still open: GitHub
      // records that removal just before the merge, so it is held, not sent.
      const mergedRemoval = queueRemoved(number, 4, 'merged');
      const mergeTimeline = [
        enqueued,
        failed,
        queueAdded(number, 3),
        mergedRemoval,
      ];
      await setGithubScenario(QUEUE_REMOVAL_TOKEN, {
        pullRequests: { [prKey(number)]: { queueTimeline: mergeTimeline } },
      });
      await expect
        .poll(
          () =>
            runtimeItem(persistedWatcher(userDataDir, watcherId), number)
              ?.queuePendingExit ?? null,
          { timeout: OBSERVATION_TIMEOUT_MS },
        )
        .toMatchObject({
          heldFor: 'merged_reason',
          reason: 'merged',
          removedAt: mergedRemoval.createdAt,
          samples: 0,
        });
      expect(await watcherSends(electronApp)).toHaveLength(1);

      // The merge arrives before the hold releases: only the merge is sent.
      await setGithubScenario(QUEUE_REMOVAL_TOKEN, {
        pullRequests: {
          [prKey(number)]: { state: 'MERGED', queueTimeline: mergeTimeline },
        },
      });
      const sends = await waitForSends(electronApp, 2);
      expect(sends).toHaveLength(2);
      expect(sends[1].text).toContain(
        `${REPOSITORY}#${number} merged into main as ${DEFAULT_MERGE_SHA.slice(0, 12)}: ${prUrl(number)}`,
      );
      expect(sends[1].text).not.toContain('merge queue');
      const mergedContext = firedContext(sends[1]);
      expect(mergedContext.eventId).not.toBe(removedContext.eventId);
      expect(mergedContext.progress).toEqual({
        total: 1,
        settled: 1,
        active: 0,
      });
      expect(mergedContext.events).toEqual([
        {
          kind: 'pull_request_merged',
          ...eventIdentity(number),
          mergedAt: MOCK_TERMINAL_AT,
          mergeCommitSha: DEFAULT_MERGE_SHA,
        },
      ]);
      await expect
        .poll(() => persistedWatcher(userDataDir, watcherId)?.status, {
          timeout: 30_000,
        })
        .toBe('fired');
      const settledItem = runtimeItem(
        persistedWatcher(userDataDir, watcherId),
        number,
      );
      expect(settledItem.settledAs).toBe('merged');
      expect(settledItem.queuePendingExit).toBeUndefined();
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('a removal and re-entry between samples reports one re-queued removal and the selected re-entry', async ({}, testInfo) => {
    test.setTimeout(240_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-queue-reentry-watcher';
    const number = 42;
    const enqueued = queueAdded(number, 1);
    const failed = queueRemoved(number, 2, 'failed_checks');
    const requeued = queueAdded(number, 3);
    const newEntry = queueEntry(number, 3, 2);
    seedWatchers({
      userDataDir,
      watchers: [
        queueWatcher(watcherId, number, {
          last: queuedSnapshot(number, queueEntry(number, 1)),
          queueCursor: { count: 1, lastEventId: enqueued.id },
          notifyOn: { queueEntered: true, queuePhases: [] },
        }),
      ],
    });
    // Still queued at the next read, but as a new entry after a removal.
    await setGithubScenario(QUEUE_REENTRY_TOKEN, {
      pullRequests: {
        [prKey(number)]: queuedPullRequest(newEntry, [
          enqueued,
          failed,
          requeued,
        ]),
      },
    });

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, QUEUE_REENTRY_TOKEN));
      const [send] = await waitForSends(electronApp, 1);
      expect(send.text).toContain(
        `${REPOSITORY}#${number} was removed from the merge queue (failed_checks) and re-queued: ${prUrl(number)}`,
      );
      expect(send.text).toContain(
        `${REPOSITORY}#${number} re-entered the merge queue (queued): ${prUrl(number)}`,
      );
      const context = firedContext(send);
      expect(context.progress).toEqual({ total: 1, settled: 0, active: 1 });
      expect(context.events).toEqual([
        timelineRemovalEvent(number, failed, true),
        {
          kind: 'pull_request_queue_entered',
          ...eventIdentity(number),
          enqueuedAt: newEntry.enqueuedAt,
          phase: 'queued',
          position: 2,
          reentry: true,
        },
      ]);

      const item = runtimeItem(
        await expectWatcherActive(userDataDir, watcherId),
        number,
      );
      expect(item.settledAt).toBeUndefined();
      expect(item.last.queue).toEqual(queuedSnapshot(number, newEntry).queue);
      expect(item.queueCursor).toEqual({ count: 3, lastEventId: requeued.id });
      expect(item.queuePendingExit).toBeUndefined();
      expect(await watcherSends(electronApp)).toHaveLength(1);
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('a relaunch mid-queue resumes from the persisted cursor and reports a later removal once', async ({}, testInfo) => {
    test.setTimeout(360_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-queue-restart-watcher';
    const number = 43;
    // An earlier removal and re-entry the persisted cursor already covers.
    const requeued = queueAdded(number, 3);
    const history = [
      queueAdded(number, 1),
      queueRemoved(number, 2, 'failed_checks'),
      requeued,
    ];
    const entry = queueEntry(number, 3);
    const cursor = { count: 3, lastEventId: requeued.id };
    seedWatchers({
      userDataDir,
      watchers: [
        queueWatcher(watcherId, number, {
          last: queuedSnapshot(number, entry),
          queueCursor: cursor,
        }),
      ],
    });
    await setGithubScenario(QUEUE_RESTART_TOKEN, {
      pullRequests: { [prKey(number)]: queuedPullRequest(entry, history) },
    });

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, QUEUE_RESTART_TOKEN));
      await waitForNextPullRequestRead(QUEUE_RESTART_TOKEN);
      expect(await watcherSends(electronApp)).toEqual([]);
      const before = persistedWatcher(userDataDir, watcherId);
      expect(before.status).toBe('active');
      expect(runtimeItem(before, number)).toEqual({
        key: `${REPOSITORY}#${number}`,
        last: queuedSnapshot(number, entry),
        queueCursor: cursor,
      });
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;

      const conflict = queueRemoved(number, 4, 'merge_conflict');
      await setGithubScenario(QUEUE_RESTART_TOKEN, {
        pullRequests: {
          [prKey(number)]: { queueTimeline: [...history, conflict] },
        },
      });
      ({ electronApp } = await launch(userDataDir, QUEUE_RESTART_TOKEN));
      const [send] = await waitForSends(electronApp, 1);
      // Only the removal after the cursor; no `removals` count for the
      // earlier one.
      expect(firedContext(send).events).toEqual([
        timelineRemovalEvent(number, conflict, false),
      ]);
      const item = runtimeItem(
        await expectWatcherActive(userDataDir, watcherId),
        number,
      );
      expect(item.queueCursor).toEqual({
        count: 4,
        lastEventId: conflict.id,
      });

      // The next read finds nothing new: the removal is not reported again.
      await waitForNextPullRequestRead(QUEUE_RESTART_TOKEN);
      expect(await watcherSends(electronApp)).toHaveLength(1);
      expect(persistedWatcher(userDataDir, watcherId).status).toBe('active');
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });

  test('an unreadable merge queue timeline never reports a removal while the pull request stays queued', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const userDataDir = makeUserDataDir();
    const demo = seedWorkspaceAndChat(userDataDir);
    const watcherId = 'pr-queue-unavailable-watcher';
    const number = 44;
    const enqueued = queueAdded(number, 1);
    const entry = queueEntry(number, 1);
    const cursor = { count: 1, lastEventId: enqueued.id };
    seedWatchers({
      userDataDir,
      watchers: [
        queueWatcher(watcherId, number, {
          last: queuedSnapshot(number, entry),
          queueCursor: cursor,
        }),
      ],
    });
    // The lifecycle read succeeds; only the timeline field fails.
    await setGithubScenario(QUEUE_UNAVAILABLE_TOKEN, {
      pullRequests: {
        [prKey(number)]: {
          ...queuedPullRequest(entry, [enqueued]),
          queueTimelineErrors: [
            {
              type: 'SERVICE_UNAVAILABLE',
              path: ['repository', 'pullRequest', 'queueEvents'],
              message: 'Something went wrong while executing your query.',
            },
          ],
        },
      },
    });

    let electronApp;
    try {
      ({ electronApp } = await launch(userDataDir, QUEUE_UNAVAILABLE_TOKEN));
      await waitForNextPullRequestRead(QUEUE_UNAVAILABLE_TOKEN);
      expect(await watcherSends(electronApp)).toEqual([]);
      const watcher = persistedWatcher(userDataDir, watcherId);
      expect(watcher.status).toBe('active');
      expect(watcher.runtimeState.pendingDelivery).toBeUndefined();
      expect(watcher.runtimeState.queuedEvents ?? []).toEqual([]);
      // Same entry on both samples: no removal, hold, or history gap, and
      // the cursor is kept for the next readable timeline.
      expect(runtimeItem(watcher, number)).toEqual({
        key: `${REPOSITORY}#${number}`,
        last: queuedSnapshot(number, entry),
        queueCursor: cursor,
      });

      // The timeline reads again: only the removal after the kept cursor.
      const failed = queueRemoved(number, 2, 'failed_checks');
      await setGithubScenario(QUEUE_UNAVAILABLE_TOKEN, {
        pullRequests: {
          [prKey(number)]: { queueTimeline: [enqueued, failed] },
        },
      });
      const [send] = await waitForSends(electronApp, 1);
      expect(firedContext(send).events).toEqual([
        timelineRemovalEvent(number, failed, false),
      ]);
    } catch (error) {
      await attachDiagnostics(testInfo, userDataDir);
      throw error;
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
});
