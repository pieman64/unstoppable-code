/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import type { ResourceContextDecision } from '@canopy/desktop-shared/lib/resource-context-policy';

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({ isEnabled: jest.fn(() => true) })),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({
    decide: (): Promise<ResourceContextDecision> =>
      Promise.resolve({ allow: true }),
  })),
}));
jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual('../services/background-execution-context'),
  resolveBackgroundWorkspaceContext: () =>
    Promise.resolve('org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  backgroundExecutionContextEnabled: () => false,
  authorizeBackgroundExecution: () => Promise.resolve({ allow: true }),
}));
jest.mock('../agents/delegation/service', () => ({
  deliverManagedDelegationWatcherToChild: () => Promise.resolve(),
}));
const mockFetchGitHubPullRequest = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  ...jest.requireActual('../lib/github-pr-read-model'),
  readGitHubPullRequestForWatcher: (...args: unknown[]) =>
    mockFetchGitHubPullRequest(...args),
}));
jest.mock('../lib/github-broker/workflow-runs', () => ({
  fetchGitHubWorkflowRun: jest.fn(),
  fetchGitHubWorkflowRunJobs: jest.fn(),
  resolveGitHubWorkflowRunJob: jest.fn(),
}));

let watchersFilePath = '';
let dataDirPath = '';
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string => watchersFilePath,
  getDataDir: (): string => dataDirPath,
  getPreferencesFilePath: (): string => join(dataDirPath, 'preferences.json'),
  getWorktreeDataDir: (workspaceId: string, worktreeId: string): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'worktree-data', worktreeId),
  getWorkspaceIndexFilePath: (): string =>
    join(dataDirPath, 'workspaces', 'index.json'),
  getWorkspaceWorktreesFilePath: (workspaceId: string): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'worktrees.json'),
  getWorkspaceChatTabsFilePath: (
    workspaceId: string,
    worktreeId: string,
  ): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'chats', `${worktreeId}.json`),
  getChatTabsFilePath: (workspaceId: string, worktreeId: string): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'chats', `${worktreeId}.json`),
  getChatProjectsFilePath: (): string =>
    join(dataDirPath, 'standalone-chat', 'projects.json'),
}));
jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
  getActiveSessionInfos: jest.fn(() => []),
  getAllActiveSessionInfos: jest.fn(() => []),
}));
jest.mock('../observability', () => ({
  getObservabilityService: () => ({ recordSessionDiagnostic: jest.fn() }),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: jest.fn(() =>
    Promise.resolve({ entryId: 'entry-app-advisor', archivedInEntryId: null }),
  ),
  listWorkEntryIds: jest.fn(() => Promise.resolve([])),
  listWorkEntries: jest.fn(() =>
    Promise.resolve([
      {
        id: 'app-advisor-worktree',
        title: 'App Advisor',
        createdAt: '2026-01-01T00:00:00.000Z',
        chatCount: 0,
      },
    ]),
  ),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readProjectPluginDefaults: () => Promise.resolve({}),
  readWorkspaceConfigDetailed: jest.fn(),
  isWorkspaceWorktreeCurrent: () => Promise.resolve(true),
  getWorkspaceWorktreeCreatedAt: () =>
    Promise.resolve('2026-01-01T00:00:00.000Z'),
}));
jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
}));
jest.mock('../services/chat-service', () => ({
  projectAppAdvisorChatSummaries: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../automations/service', () => ({
  getAutomationsService: () => ({
    list: () => Promise.resolve({ activities: [], recentRuns: [] }),
    findActivityForBackgroundAuthorization: () => Promise.resolve(undefined),
    listRuns: () => Promise.resolve({ runs: [], nextCursor: null }),
  }),
}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcher,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWindowCommand,
} from '@canopy/desktop-shared/types';
import type {
  GitHubPullRequestFiredContext,
  GitHubPullRequestSnapshot,
  WatchGitHubItemsInput,
} from '@canopy/desktop-shared/types/github-watchers';
import type {
  PrMergeQueueHistory,
  PrMergeQueuePhase,
  PrMergeQueueTimelineEvent,
} from '@canopy/desktop-shared/types/github';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { getGitHubWorkflowRunObserver } from '../lib/github-workflow-run-observer';
import { getGitHubPullRequestObserver } from '../lib/github-pull-request-observer';
import { resetChatStateServiceForTests } from '../services/chat-state-service';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const UNAVAILABLE: PrMergeQueueHistory = { status: 'unavailable' };

let clock = 0;
/** Strictly increasing sample times, one minute apart. */
function nextObservedAt(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 7, 0, clock)).toISOString();
}

function open(
  number: number,
  queue: GitHubPullRequestSnapshot['queue'] = null,
): GitHubPullRequestSnapshot {
  return {
    state: 'open',
    url: `https://github.com/acme/api/pull/${number}`,
    title: `PR ${number}`,
    baseRefName: 'develop',
    headSha: HEAD_SHA,
    mergedAt: null,
    mergeCommitSha: null,
    closedAt: null,
    queue,
    observedAt: nextObservedAt(),
  };
}

function inQueue(
  number: number,
  entryId: string | null,
  phase: PrMergeQueuePhase = 'queued',
  position: number | null = 1,
): GitHubPullRequestSnapshot {
  return open(number, {
    entryId,
    enqueuedAt: '2026-10-07T00:00:00.000Z',
    phase,
    position,
  });
}

function merged(number: number): GitHubPullRequestSnapshot {
  return {
    ...open(number),
    state: 'merged',
    mergedAt: '2026-10-07T03:00:00.000Z',
    mergeCommitSha: MERGE_SHA,
    closedAt: '2026-10-07T03:00:00.000Z',
  };
}

function added(id: string): PrMergeQueueTimelineEvent {
  return { type: 'added', id, createdAt: '2026-10-07T00:00:00.000Z' };
}

function removed(id: string, reason: string | null): PrMergeQueueTimelineEvent {
  return {
    type: 'removed',
    id,
    createdAt: '2026-10-07T00:30:00.000Z',
    reason,
  };
}

/** A complete read whose window starts after a cursor at `count - 4` or below. */
function gapHistory(filteredCount: number): PrMergeQueueHistory {
  const firstIndex = filteredCount - 2;
  return {
    status: 'complete',
    filteredCount,
    firstIndex,
    events: [
      added(`g${firstIndex}`),
      removed(`g${firstIndex + 1}`, 'failed_checks'),
    ],
  };
}

function history(...events: PrMergeQueueTimelineEvent[]): PrMergeQueueHistory {
  return {
    status: 'complete',
    filteredCount: events.length,
    firstIndex: 0,
    events,
  };
}

function destination(chatId = 'advisor-chat'): AppAdvisorWatcherDestination {
  return {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId,
  };
}

function prInput(
  numbers: number[],
  notifyOn?: WatchGitHubItemsInput['notifyOn'],
): WatchGitHubItemsInput {
  return {
    items: numbers.map((number) => ({
      kind: 'pull_request',
      target: `acme/api#${number}`,
    })),
    ...(notifyOn ? { notifyOn } : {}),
  };
}

/** Setup reads keyed by PR number; anything unlisted is open and unqueued. */
function setupReads(
  reads: Record<
    number,
    { snapshot: GitHubPullRequestSnapshot; queueHistory: PrMergeQueueHistory }
  > = {},
): void {
  mockFetchGitHubPullRequest.mockImplementation(
    ({ number }: { number: number }) =>
      Promise.resolve(
        reads[number] ?? { snapshot: open(number), queueHistory: history() },
      ),
  );
}

async function readWatchers(): Promise<AppAdvisorWatcher[]> {
  try {
    const parsed: { watchers: AppAdvisorWatcher[] } = JSON.parse(
      await readFile(watchersFilePath, 'utf8'),
    );
    return parsed.watchers;
  } catch {
    return [];
  }
}

/** Deadline-based so parallel suites on a loaded machine do not time out. */
async function waitFor(predicate: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

async function waitForStatus(status: AppAdvisorWatcher['status']) {
  expect(
    await waitFor(async () => (await readWatchers())[0]?.status === status),
  ).toBe(true);
}

function sentMessages(): Extract<
  AppAdvisorWindowCommand,
  { type: 'send_watcher_message' }
>[] {
  return sendAppAdvisorWindowCommand.mock.calls.flatMap(([command]) =>
    command.type === 'send_watcher_message' ? [command] : [],
  );
}

function firedContext(
  hiddenContextText: string | undefined,
): GitHubPullRequestFiredContext {
  const match = /_watcher_event>\n(.*)\n<\//.exec(hiddenContextText ?? '');
  if (!match) throw new Error('Missing watcher event payload.');
  return JSON.parse(match[1]);
}

function runtimeItems(watcher: AppAdvisorWatcher) {
  if (watcher.runtimeState?.kind !== 'github_pull_requests') {
    throw new Error('Not a pull request watcher.');
  }
  return watcher.runtimeState.items;
}

const sendAppAdvisorWindowCommand = jest.fn<void, [AppAdvisorWindowCommand]>();

function configureService(): void {
  getAppAdvisorWatcherService().configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    ensureAppAdvisorWindow: () =>
      Promise.resolve({ open: true, focused: false }),
    sendAppAdvisorWindowCommand,
    sendChatWindowCommand: () => true,
  });
  getGitHubWorkflowRunObserver().stop();
  getGitHubPullRequestObserver().stop();
}

async function watch(
  numbers: number[],
  notifyOn?: WatchGitHubItemsInput['notifyOn'],
): Promise<string> {
  const result = await getAppAdvisorWatcherService().watchGitHubItems(
    prInput(numbers, notifyOn),
    destination(),
  );
  if (!result.ok || result.status !== 'created') throw new Error('setup');
  return result.watcherId;
}

/** Apply one observation and wait for any delivery it starts to settle. */
async function observe(
  watcherId: string,
  reads: Array<{
    number: number;
    snapshot: GitHubPullRequestSnapshot;
    queueHistory: PrMergeQueueHistory;
  }>,
): Promise<void> {
  await getAppAdvisorWatcherService().applyGitHubPullRequestObservation({
    observations: reads.map((read) => ({
      kind: 'snapshot',
      subscriberIds: [watcherId],
      repository: 'acme/api',
      ...read,
    })),
  });
  expect(
    await waitFor(async () => (await readWatchers())[0]?.status !== 'firing'),
  ).toBe(true);
}

function eventsOf(index: number) {
  return firedContext(sentMessages()[index]?.hiddenContextText).events;
}

describe('GitHub pull request merge queue watchers', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    clock = 0;
    resetChatStateServiceForTests();
    registerWorkspaceTypes(new Map());
    dataDirPath = await mkdtemp(join(tmpdir(), 'canopy-pr-queue-test-'));
    watchersFilePath = join(dataDirPath, 'app-advisor-watchers.json');
    setupReads();
    sendAppAdvisorWindowCommand.mockImplementation((command) => {
      if (command.type !== 'send_watcher_message') return;
      queueMicrotask(() => {
        getAppAdvisorWatcherService().acknowledgeWatcherMessageDelivery(
          command.watcherId,
          command.deliveryId,
          { ok: true },
        );
      });
    });
    configureService();
  });

  afterEach(async () => {
    getAppAdvisorWatcherService().shutdown();
    await getAppAdvisorWatcherService().drain();
    await rm(dataDirPath, { recursive: true, force: true });
  });

  describe('registration', () => {
    it('persists a non-default selection and returns the armed events', async () => {
      const result = await getAppAdvisorWatcherService().watchGitHubItems(
        prInput([12], { queue: { entered: true, phases: ['unmergeable'] } }),
        destination(),
      );

      expect(result).toMatchObject({
        ok: true,
        status: 'created',
        events: [
          'pull_request_merged',
          'pull_request_closed',
          'pull_request_queue_removed',
          'pull_request_queue_history_incomplete',
          'pull_request_queue_entered',
          'pull_request_queue_phase_changed',
        ],
      });
      const [watcher] = await readWatchers();
      expect(watcher.target).toMatchObject({
        notifyOn: { queueEntered: true, queuePhases: ['unmergeable'] },
      });
    });

    it('omits the default selection and baselines the timeline cursor', async () => {
      setupReads({
        12: {
          snapshot: inQueue(12, 'MQE_1'),
          queueHistory: history(added('a1')),
        },
        13: { snapshot: open(13), queueHistory: UNAVAILABLE },
      });
      await watch([12, 13], { queue: { entered: false, phases: [] } });

      const [watcher] = await readWatchers();
      expect(watcher.target).not.toHaveProperty('notifyOn');
      const [first, second] = runtimeItems(watcher);
      expect(first.queueCursor).toEqual({ count: 1, lastEventId: 'a1' });
      // An unreadable setup timeline leaves the cursor for the first read.
      expect(second).not.toHaveProperty('queueCursor');
      expect(
        await getAppAdvisorWatcherService().listGitHubPullRequestSubscriptions(),
      ).toEqual([
        expect.objectContaining({
          number: 12,
          queueCursor: { count: 1, lastEventId: 'a1' },
        }),
        expect.not.objectContaining({ queueCursor: expect.anything() }),
      ]);
    });

    it('dedupes only requests with the same selection', async () => {
      const service = getAppAdvisorWatcherService();
      const plain = await service.watchGitHubItems(
        prInput([12]),
        destination(),
      );
      const entered = await service.watchGitHubItems(
        prInput([12], { queue: { entered: true } }),
        destination(),
      );
      const enteredAgain = await service.watchGitHubItems(
        prInput([12], { queue: { entered: true } }),
        destination(),
      );
      const plainAgain = await service.watchGitHubItems(
        prInput([12], { queue: {} }),
        destination(),
      );

      if (!plain.ok || !entered.ok) throw new Error('setup');
      expect(entered).toMatchObject({ status: 'created' });
      expect(enteredAgain).toMatchObject({
        status: 'deduped',
        watcherId: entered.watcherId,
        events: expect.arrayContaining(['pull_request_queue_entered']),
      });
      expect(plainAgain).toMatchObject({
        status: 'deduped',
        watcherId: plain.watcherId,
      });
      expect(await readWatchers()).toHaveLength(2);
    });
  });

  it('wakes on a removal without settling, then consumes on the merge', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12]);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: open(12),
        queueHistory: history(added('a1'), removed('r1', 'failed_checks')),
      },
    ]);

    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].text).toBe(
      [
        'GitHub pull request watcher update:',
        '- acme/api#12 was removed from the merge queue (failed_checks): https://github.com/acme/api/pull/12',
        '1 of 1 pull requests still open.',
      ].join('\n'),
    );
    expect(eventsOf(0)).toEqual([
      {
        kind: 'pull_request_queue_removed',
        repository: 'acme/api',
        number: 12,
        url: 'https://github.com/acme/api/pull/12',
        baseBranch: 'develop',
        headSha: HEAD_SHA,
        removedAt: '2026-10-07T00:30:00.000Z',
        reason: 'failed_checks',
        evidence: 'timeline',
        requeued: false,
      },
    ]);
    const [afterRemoval] = await readWatchers();
    expect(runtimeItems(afterRemoval)[0]).not.toHaveProperty('settledAt');
    expect(
      await getAppAdvisorWatcherService().listGitHubPullRequestSubscriptions(),
    ).toEqual([
      expect.objectContaining({
        number: 12,
        queueCursor: { count: 2, lastEventId: 'r1' },
      }),
    ]);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: merged(12),
        queueHistory: history(added('a1'), removed('r1', 'failed_checks')),
      },
    ]);
    await waitForStatus('fired');
    expect(sentMessages()).toHaveLength(2);
    expect(eventsOf(1)).toEqual([
      expect.objectContaining({ kind: 'pull_request_merged', number: 12 }),
    ]);
  });

  it('reports only the merge when GitHub records a merged removal first', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1', 'mergeable'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12]);
    const removedAsMerged = history(added('a1'), removed('r1', 'MERGED'));

    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: removedAsMerged },
    ]);
    expect(sentMessages()).toHaveLength(0);
    const [held] = await readWatchers();
    expect(held.status).toBe('active');
    expect(runtimeItems(held)[0].queuePendingExit).toMatchObject({
      heldFor: 'merged_reason',
      entryId: 'MQE_1',
      samples: 0,
    });

    await observe(watcherId, [
      { number: 12, snapshot: merged(12), queueHistory: removedAsMerged },
    ]);
    await waitForStatus('fired');
    expect(sentMessages()).toHaveLength(1);
    expect(eventsOf(0)).toEqual([
      expect.objectContaining({ kind: 'pull_request_merged' }),
    ]);
  });

  describe('re-entry between samples', () => {
    it('reports a removal and re-entry recorded only in the timeline', async () => {
      setupReads({
        12: {
          snapshot: inQueue(12, null),
          queueHistory: history(added('a1')),
        },
      });
      const watcherId = await watch([12], { queue: { entered: true } });

      await observe(watcherId, [
        {
          number: 12,
          snapshot: inQueue(12, null, 'awaiting_checks'),
          queueHistory: history(
            added('a1'),
            removed('r1', 'failed_checks'),
            added('a2'),
          ),
        },
      ]);

      await waitForStatus('active');
      expect(sentMessages()[0].text).toBe(
        [
          'GitHub pull request watcher update:',
          '- acme/api#12 was removed from the merge queue (failed_checks) and re-queued: https://github.com/acme/api/pull/12',
          '- acme/api#12 re-entered the merge queue (awaiting checks): https://github.com/acme/api/pull/12',
          '1 of 1 pull requests still open.',
        ].join('\n'),
      );
      expect(eventsOf(0)).toEqual([
        expect.objectContaining({
          kind: 'pull_request_queue_removed',
          evidence: 'timeline',
          requeued: true,
        }),
        expect.objectContaining({
          kind: 'pull_request_queue_entered',
          phase: 'awaiting_checks',
          reentry: true,
        }),
      ]);
    });

    it('reports a re-entry proven only by a new entry id', async () => {
      setupReads({
        12: {
          snapshot: inQueue(12, 'MQE_1'),
          queueHistory: history(added('a1')),
        },
      });
      const watcherId = await watch([12]);

      await observe(watcherId, [
        {
          number: 12,
          snapshot: inQueue(12, 'MQE_2'),
          queueHistory: history(added('a1')),
        },
      ]);

      await waitForStatus('active');
      expect(eventsOf(0)).toEqual([
        expect.objectContaining({
          kind: 'pull_request_queue_removed',
          evidence: 'entry_changed',
          reason: null,
          removedAt: null,
          requeued: true,
        }),
      ]);
      expect(sentMessages()[0].text).toContain(
        '- acme/api#12 was removed from the merge queue and re-queued: ',
      );
    });

    it('counts several removal cycles between samples in one event', async () => {
      setupReads({
        12: {
          snapshot: inQueue(12, 'MQE_1'),
          queueHistory: history(added('a1')),
        },
      });
      const watcherId = await watch([12]);

      await observe(watcherId, [
        {
          number: 12,
          snapshot: open(12),
          queueHistory: history(
            added('a1'),
            removed('r1', 'failed_checks'),
            added('a2'),
            removed('r2', 'dequeued'),
          ),
        },
      ]);

      await waitForStatus('active');
      expect(eventsOf(0)).toEqual([
        expect.objectContaining({ reason: 'dequeued', removals: 2 }),
      ]);
      expect(sentMessages()[0].text).toContain(
        '- acme/api#12 was removed from the merge queue 2 times (dequeued): ',
      );
    });
  });

  it('wakes only on selected phases and never on unknown', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1', 'queued'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12], { queue: { phases: ['unmergeable'] } });
    const timeline = history(added('a1'));

    await observe(watcherId, [
      {
        number: 12,
        snapshot: inQueue(12, 'MQE_1', 'awaiting_checks'),
        queueHistory: timeline,
      },
    ]);
    expect(sentMessages()).toHaveLength(0);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: inQueue(12, 'MQE_1', 'unmergeable'),
        queueHistory: timeline,
      },
    ]);
    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].text).toContain(
      '- acme/api#12 merge queue entry moved from awaiting checks to unmergeable: ',
    );
    expect(eventsOf(0)).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_phase_changed',
        previousPhase: 'awaiting_checks',
        phase: 'unmergeable',
        position: 1,
      }),
    ]);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: inQueue(12, 'MQE_1', 'unknown'),
        queueHistory: timeline,
      },
    ]);
    expect(sentMessages()).toHaveLength(1);
  });

  it('wakes on entry only when entry is selected', async () => {
    const plainId = await watch([12]);
    const enteredId = await watch([13], { queue: { entered: true } });
    const timeline = history(added('a1'));

    await observe(plainId, [
      { number: 12, snapshot: inQueue(12, 'MQE_1'), queueHistory: timeline },
    ]);
    expect(sentMessages()).toHaveLength(0);

    await getAppAdvisorWatcherService().applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [enteredId],
          repository: 'acme/api',
          number: 13,
          snapshot: inQueue(13, 'MQE_2', 'queued', 3),
          queueHistory: timeline,
        },
      ],
    });
    expect(
      await waitFor(async () =>
        (await readWatchers()).every((watcher) => watcher.status === 'active'),
      ),
    ).toBe(true);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].text).toContain(
      '- acme/api#13 entered the merge queue (queued): ',
    );
    expect(firedContext(sentMessages()[0].hiddenContextText).events).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_entered',
        number: 13,
        enqueuedAt: '2026-10-07T00:00:00.000Z',
        position: 3,
        reentry: false,
      }),
    ]);
  });

  it('records a position-only change without waking', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1', 'queued', 4),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12], {
      queue: { entered: true, phases: 'any' },
    });

    const moved = inQueue(12, 'MQE_1', 'queued', 2);
    await observe(watcherId, [
      { number: 12, snapshot: moved, queueHistory: history(added('a1')) },
    ]);

    expect(sentMessages()).toHaveLength(0);
    const [watcher] = await readWatchers();
    expect(runtimeItems(watcher)[0].last).toEqual(moved);
  });

  it('consumes a grouped watcher only after every terminal event', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12, 13]);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: open(12),
        queueHistory: history(added('a1'), removed('r1', 'failed_checks')),
      },
      { number: 13, snapshot: merged(13), queueHistory: history() },
    ]);

    await waitForStatus('active');
    expect(eventsOf(0)).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_removed',
        number: 12,
      }),
      expect.objectContaining({ kind: 'pull_request_merged', number: 13 }),
    ]);
    expect(firedContext(sentMessages()[0].hiddenContextText).progress).toEqual({
      total: 2,
      settled: 1,
      active: 1,
    });

    await observe(watcherId, [
      {
        number: 12,
        snapshot: merged(12),
        queueHistory: history(added('a1'), removed('r1', 'failed_checks')),
      },
    ]);
    await waitForStatus('fired');
    expect(sentMessages()).toHaveLength(2);
    expect(eventsOf(1)).toEqual([
      expect.objectContaining({ kind: 'pull_request_merged', number: 12 }),
    ]);
  });

  it('resumes from the persisted cursor after a restart without re-reporting', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1'),
        queueHistory: history(added('a1')),
      },
    });
    const service = getAppAdvisorWatcherService();
    const watcherId = await watch([12]);
    const afterRemoval = history(added('a1'), removed('r1', 'failed_checks'));
    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: afterRemoval },
    ]);
    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(1);

    service.shutdown();
    await service.drain();
    configureService();

    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([
      expect.objectContaining({
        queueCursor: { count: 2, lastEventId: 'r1' },
      }),
    ]);
    // The shared read was served from the earliest cursor of all subscribers;
    // events this watcher already interpreted are skipped.
    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: afterRemoval },
    ]);
    expect(sentMessages()).toHaveLength(1);

    await observe(watcherId, [
      {
        number: 12,
        snapshot: open(12),
        queueHistory: history(
          added('a1'),
          removed('r1', 'failed_checks'),
          added('a2'),
          removed('r2', 'conflict'),
        ),
      },
    ]);
    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(2);
    expect(eventsOf(1)).toEqual([
      expect.objectContaining({ reason: 'conflict', requeued: false }),
    ]);
    expect(eventsOf(1)[0]).not.toHaveProperty('removals');
  });

  it('reports a history gap once and again only after recovery', async () => {
    setupReads({
      12: {
        snapshot: open(12),
        queueHistory: history(added('a1'), removed('r1', 'failed_checks')),
      },
    });
    const watcherId = await watch([12]);
    const baselineObservedAt = runtimeItems((await readWatchers())[0])[0].last
      .observedAt;

    // The newest page no longer reaches the stored cursor: a lost window.
    const gapRead = open(12);
    await observe(watcherId, [
      { number: 12, snapshot: gapRead, queueHistory: gapHistory(8) },
    ]);
    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(1);
    expect(eventsOf(0)).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_history_incomplete',
        since: baselineObservedAt,
        observedAt: gapRead.observedAt,
      }),
    ]);
    expect(sentMessages()[0].text).toContain(
      `- acme/api#12 merge queue history since ${baselineObservedAt} could not be read; queue changes in that window may be missing: `,
    );
    const [gapped] = await readWatchers();
    expect(runtimeItems(gapped)[0]).toMatchObject({
      queueHistoryGapSince: baselineObservedAt,
      queueCursor: { count: 8, lastEventId: 'g7' },
    });

    // An unreadable timeline is transient and reports nothing on its own.
    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: UNAVAILABLE },
    ]);
    expect(sentMessages()).toHaveLength(1);

    // A continuous read recovers and clears the marker durably.
    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: gapHistory(8) },
    ]);
    expect(sentMessages()).toHaveLength(1);
    const [recovered] = await readWatchers();
    expect(runtimeItems(recovered)[0]).not.toHaveProperty(
      'queueHistoryGapSince',
    );

    await observe(watcherId, [
      { number: 12, snapshot: open(12), queueHistory: gapHistory(20) },
    ]);
    await waitForStatus('active');
    expect(sentMessages()).toHaveLength(2);
    expect(eventsOf(1)).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_history_incomplete',
      }),
    ]);
  });

  it('never infers a removal from unavailable history', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12]);

    // The same entry in both samples proves continuity: nothing to report.
    await observe(watcherId, [
      { number: 12, snapshot: inQueue(12, 'MQE_1'), queueHistory: UNAVAILABLE },
    ]);
    expect(sentMessages()).toHaveLength(0);
    const [watcher] = await readWatchers();
    expect(runtimeItems(watcher)[0]).toMatchObject({
      queueCursor: { count: 1, lastEventId: 'a1' },
    });
    expect(runtimeItems(watcher)[0]).not.toHaveProperty('queuePendingExit');
  });

  it('baselines a legacy row on its first read and then reports removals', async () => {
    setupReads({
      12: { snapshot: inQueue(12, 'MQE_1'), queueHistory: UNAVAILABLE },
    });
    const watcherId = await watch([12]);
    const [legacy] = await readWatchers();
    expect(legacy.target).not.toHaveProperty('notifyOn');
    expect(runtimeItems(legacy)[0]).not.toHaveProperty('queueCursor');
    const legacyLast = runtimeItems(legacy)[0].last;

    // Same snapshot, readable timeline: the cursor alone is written.
    await observe(watcherId, [
      {
        number: 12,
        snapshot: { ...legacyLast, observedAt: nextObservedAt() },
        queueHistory: history(
          added('a1'),
          removed('r0', 'failed_checks'),
          added('a2'),
        ),
      },
    ]);
    expect(sentMessages()).toHaveLength(0);
    const [baselined] = await readWatchers();
    expect(runtimeItems(baselined)[0].queueCursor).toEqual({
      count: 3,
      lastEventId: 'a2',
    });

    await observe(watcherId, [
      {
        number: 12,
        snapshot: open(12),
        queueHistory: history(
          added('a1'),
          removed('r0', 'failed_checks'),
          added('a2'),
          removed('r1', 'conflict'),
        ),
      },
    ]);
    await waitForStatus('active');
    expect(eventsOf(0)).toEqual([
      expect.objectContaining({
        kind: 'pull_request_queue_removed',
        reason: 'conflict',
      }),
    ]);
  });

  it('drops a malformed persisted queue field instead of the watcher', async () => {
    setupReads({
      12: {
        snapshot: inQueue(12, 'MQE_1'),
        queueHistory: history(added('a1')),
      },
    });
    const watcherId = await watch([12]);
    const file: { watchers: AppAdvisorWatcher[] } = JSON.parse(
      await readFile(watchersFilePath, 'utf8'),
    );
    const [item] = runtimeItems(file.watchers[0]);
    Object.assign(item, {
      queueCursor: { count: -1, lastEventId: 'a1' },
      queuePendingExit: { heldFor: 'later' },
      queueHistoryGapSince: 7,
    });
    await writeFile(watchersFilePath, JSON.stringify(file));

    expect(
      await getAppAdvisorWatcherService().listGitHubPullRequestSubscriptions(),
    ).toEqual([
      {
        watcherId,
        repository: 'acme/api',
        number: 12,
        last: item.last,
      },
    ]);
  });
});
