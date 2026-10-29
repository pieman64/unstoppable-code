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
let mockBackgroundExecutionEnabled = false;
let mockDeliveryAuthorization: ResourceContextDecision = { allow: true };
jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual('../services/background-execution-context'),
  resolveBackgroundWorkspaceContext: () =>
    Promise.resolve('org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  backgroundExecutionContextEnabled: () => mockBackgroundExecutionEnabled,
  authorizeBackgroundExecution: () =>
    Promise.resolve(mockDeliveryAuthorization),
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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AppAdvisorWatcher,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWindowCommand,
  type ChatWindowCommand,
} from '@canopy/desktop-shared/types';
import type {
  GitHubPullRequestFiredContext,
  GitHubPullRequestSnapshot,
  WatchGitHubItemsInput,
} from '@canopy/desktop-shared/types/github-watchers';
import type { PrMergeQueueHistory } from '@canopy/desktop-shared/types/github';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { getGitHubWorkflowRunObserver } from '../lib/github-workflow-run-observer';
import { getGitHubPullRequestObserver } from '../lib/github-pull-request-observer';
import { GitHubBrokerError } from '../lib/github-broker';
import { resetChatStateServiceForTests } from '../services/chat-state-service';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const HEAD_SHA = 'a'.repeat(40);
const NO_QUEUE_HISTORY: PrMergeQueueHistory = {
  status: 'complete',
  filteredCount: 0,
  firstIndex: 0,
  events: [],
};
const MERGE_SHA = 'b'.repeat(40);

function snapshot(
  number: number,
  overrides: Partial<GitHubPullRequestSnapshot> = {},
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
    queue: null,
    observedAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

function merged(number: number): GitHubPullRequestSnapshot {
  return snapshot(number, {
    state: 'merged',
    mergedAt: '2026-10-07T00:01:00.000Z',
    mergeCommitSha: MERGE_SHA,
    closedAt: '2026-10-07T00:01:00.000Z',
    observedAt: '2026-10-07T00:01:05.000Z',
  });
}

function closed(number: number): GitHubPullRequestSnapshot {
  return snapshot(number, {
    state: 'closed',
    closedAt: '2026-10-07T00:02:00.000Z',
    observedAt: '2026-10-07T00:02:05.000Z',
  });
}

function destination(chatId = 'advisor-chat'): AppAdvisorWatcherDestination {
  return {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId,
  };
}

function prInput(...numbers: number[]): WatchGitHubItemsInput {
  return {
    items: numbers.map((number) => ({
      kind: 'pull_request',
      target: `acme/api#${number}`,
    })),
  };
}

/** Baselines keyed by PR number; anything unlisted is open. */
function baselines(
  states: Record<number, GitHubPullRequestSnapshot | Error> = {},
): void {
  mockFetchGitHubPullRequest.mockImplementation(
    ({ number }: { number: number }) => {
      const value = states[number] ?? snapshot(number);
      return value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve({ snapshot: value, queueHistory: NO_QUEUE_HISTORY });
    },
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

/**
 * Waits up to 10s so parallel suites on a loaded machine do not time out;
 * the tick cap still ends the loop when `Date` is faked.
 */
async function waitFor(predicate: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (let tick = 0; tick < 100_000 && Date.now() < deadline; tick += 1) {
    if (await predicate()) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return predicate();
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

describe('GitHub pull request watchers', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBackgroundExecutionEnabled = false;
    mockDeliveryAuthorization = { allow: true };
    resetChatStateServiceForTests();
    registerWorkspaceTypes(new Map());
    dataDirPath = await mkdtemp(join(tmpdir(), 'canopy-pr-watchers-test-'));
    watchersFilePath = join(dataDirPath, 'app-advisor-watchers.json');
    baselines();
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
    jest.useRealTimers();
    getAppAdvisorWatcherService().shutdown();
    await getAppAdvisorWatcherService().drain();
    await rm(dataDirPath, { recursive: true, force: true });
  });

  it('reads every baseline before persisting and watches open pull requests', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
      { toolUseId: 'tool-1' },
    );

    expect(result).toEqual({
      ok: true,
      status: 'created',
      watcherId: expect.any(String),
      itemCount: 2,
      events: [
        'pull_request_merged',
        'pull_request_closed',
        'pull_request_queue_removed',
        'pull_request_queue_history_incomplete',
      ],
      items: [
        {
          index: 0,
          repository: 'acme/api',
          number: 12,
          url: 'https://github.com/acme/api/pull/12',
          outcome: 'watching',
        },
        {
          index: 1,
          repository: 'acme/api',
          number: 13,
          url: 'https://github.com/acme/api/pull/13',
          outcome: 'watching',
        },
      ],
    });
    expect(mockFetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(mockFetchGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'interactive' }),
    );
    const [watcher] = await readWatchers();
    expect(watcher).toMatchObject({
      trigger: 'github_pull_requests_changed',
      status: 'active',
      label: 'GitHub pull requests',
      target: {
        kind: 'github_pull_requests',
        items: [
          { kind: 'pull_request', repository: 'acme/api', number: 12 },
          { kind: 'pull_request', repository: 'acme/api', number: 13 },
        ],
        display: {
          repositories: ['acme/api'],
          sample: [
            { repository: 'acme/api', number: 12, title: 'PR 12' },
            { repository: 'acme/api', number: 13, title: 'PR 13' },
          ],
        },
      },
      runtimeState: {
        kind: 'github_pull_requests',
        items: [
          { key: 'acme/api#12', last: snapshot(12) },
          { key: 'acme/api#13', last: snapshot(13) },
        ],
      },
    });
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([
      expect.objectContaining({ watcherId: watcher.id, number: 12 }),
      expect.objectContaining({ watcherId: watcher.id, number: 13 }),
    ]);
    const [summary] = await service.list(destination());
    expect(summary).not.toHaveProperty('runtimeState');
    expect(sentMessages()).toHaveLength(0);
  });

  it.each([
    [
      'merged',
      merged(12),
      {
        outcome: 'merged',
        mergedAt: '2026-10-07T00:01:00.000Z',
        mergeCommitSha: MERGE_SHA,
        baseBranch: 'develop',
      },
    ],
    [
      'closed',
      closed(12),
      { outcome: 'closed', closedAt: '2026-10-07T00:02:00.000Z' },
    ],
  ])(
    'reports an already %s pull request without creating a watcher',
    async (_state, baseline, outcome) => {
      baselines({ 12: baseline });
      const result = await getAppAdvisorWatcherService().watchGitHubItems(
        prInput(12),
        destination(),
      );

      expect(result).toEqual({
        ok: true,
        status: 'not_created',
        itemCount: 0,
        events: [],
        items: [
          {
            index: 0,
            repository: 'acme/api',
            number: 12,
            url: 'https://github.com/acme/api/pull/12',
            ...outcome,
          },
        ],
      });
      expect(await readWatchers()).toEqual([]);
    },
  );

  it('watches only the open items of a mixed group and reports outcomes in request order', async () => {
    baselines({ 12: merged(12), 14: closed(14) });
    const result = await getAppAdvisorWatcherService().watchGitHubItems(
      prInput(12, 13, 14),
      destination(),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'created',
      itemCount: 1,
      items: [
        { index: 0, number: 12, outcome: 'merged' },
        { index: 1, number: 13, outcome: 'watching' },
        { index: 2, number: 14, outcome: 'closed' },
      ],
    });
    const [watcher] = await readWatchers();
    expect(watcher.target).toMatchObject({
      items: [{ repository: 'acme/api', number: 13 }],
    });
  });

  it('dedupes the same open set for the same destination', async () => {
    const service = getAppAdvisorWatcherService();
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    const second = await service.watchGitHubItems(
      prInput(13, 12),
      destination(),
    );
    const otherChat = await service.watchGitHubItems(
      prInput(12, 13),
      destination('other-chat'),
    );

    if (!first.ok || first.status !== 'created') throw new Error('setup');
    expect(second).toMatchObject({
      ok: true,
      status: 'deduped',
      watcherId: first.watcherId,
      itemCount: 2,
      items: [
        { index: 0, number: 13, outcome: 'watching' },
        { index: 1, number: 12, outcome: 'watching' },
      ],
    });
    expect(otherChat).toMatchObject({ ok: true, status: 'created' });
    expect(await readWatchers()).toHaveLength(2);
  });

  it('dedupes a retried request to the existing watcher after some items settled', async () => {
    const service = getAppAdvisorWatcherService();
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!first.ok || first.status !== 'created') throw new Error('setup');

    baselines({ 12: merged(12) });
    const retry = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );

    expect(retry).toMatchObject({
      ok: true,
      status: 'deduped',
      watcherId: first.watcherId,
      items: [
        { index: 0, number: 12, outcome: 'merged' },
        { index: 1, number: 13, outcome: 'watching' },
      ],
    });
    expect(await readWatchers()).toHaveLength(1);
  });

  it('dedupes a retried request to the existing watcher after every item settled', async () => {
    const service = getAppAdvisorWatcherService();
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!first.ok || first.status !== 'created') throw new Error('setup');

    baselines({ 12: merged(12), 13: merged(13) });
    const retry = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );

    expect(retry).toMatchObject({
      ok: true,
      status: 'deduped',
      watcherId: first.watcherId,
    });
    expect(await readWatchers()).toHaveLength(1);
  });

  it('serializes overlapping registrations so a settling item cannot produce two watchers', async () => {
    const service = getAppAdvisorWatcherService();
    let readsOf12 = 0;
    mockFetchGitHubPullRequest.mockImplementation(
      ({ number }: { number: number }) => {
        if (number === 12) readsOf12 += 1;
        // The second registration's baseline sees #12 already merged.
        const value =
          number === 12 && readsOf12 > 1 ? merged(12) : snapshot(number);
        return Promise.resolve({
          snapshot: value,
          queueHistory: NO_QUEUE_HISTORY,
        });
      },
    );

    const [first, second] = await Promise.all([
      service.watchGitHubItems(prInput(12, 13), destination()),
      service.watchGitHubItems(prInput(12, 13), destination()),
    ]);

    if (!first.ok || first.status !== 'created') throw new Error('setup');
    expect(second).toMatchObject({
      ok: true,
      status: 'deduped',
      watcherId: first.watcherId,
    });
    expect(await readWatchers()).toHaveLength(1);
  });

  it('does not dedupe to a covering watcher that was deleted', async () => {
    const service = getAppAdvisorWatcherService();
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!first.ok || first.status !== 'created') throw new Error('setup');
    await expect(service.deleteWatcher(first.watcherId)).resolves.toBe(true);

    const retry = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );

    expect(retry).toMatchObject({ ok: true, status: 'created' });
    if (!retry.ok || retry.status !== 'created') throw new Error('retry');
    expect(retry.watcherId).not.toBe(first.watcherId);
  });

  it('watches a reopened pull request instead of deduping to the watcher that settled it', async () => {
    const service = getAppAdvisorWatcherService();
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!first.ok || first.status !== 'created') throw new Error('setup');
    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [first.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: closed(12),
        },
      ],
    });
    expect(
      await waitFor(async () => (await readWatchers())[0]?.status === 'active'),
    ).toBe(true);
    expect(sentMessages()).toHaveLength(1);

    // #12 was reopened; the baseline reads it open again.
    baselines();
    const retry = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );

    expect(retry).toMatchObject({ ok: true, status: 'created' });
    if (!retry.ok || retry.status !== 'created') throw new Error('retry');
    expect(retry.watcherId).not.toBe(first.watcherId);
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ watcherId: retry.watcherId, number: 12 }),
      ]),
    );
  });

  it('does not consume a reopened pull request request with a pending close delivery', async () => {
    const service = getAppAdvisorWatcherService();
    const held: Extract<
      AppAdvisorWindowCommand,
      { type: 'send_watcher_message' }
    >[] = [];
    sendAppAdvisorWindowCommand.mockImplementation((command) => {
      if (command.type === 'send_watcher_message') held.push(command);
    });
    const first = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!first.ok || first.status !== 'created') throw new Error('setup');
    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [first.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: closed(12),
        },
      ],
    });
    expect(await waitFor(() => Promise.resolve(held.length === 1))).toBe(true);
    expect((await readWatchers())[0]?.status).toBe('firing');

    baselines();
    const retry = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );

    for (const command of held) {
      service.acknowledgeWatcherMessageDelivery(
        command.watcherId,
        command.deliveryId,
        { ok: true },
      );
    }
    expect(retry).toMatchObject({ ok: true, status: 'created' });
    if (!retry.ok || retry.status !== 'created') throw new Error('retry');
    expect(retry.watcherId).not.toBe(first.watcherId);
  });

  it.each([
    [
      new GitHubBrokerError('not_found', 'missing'),
      'not_found_or_inaccessible',
    ],
    [
      new GitHubBrokerError('permission_denied', 'forbidden'),
      'not_found_or_inaccessible',
    ],
    [
      new GitHubBrokerError('not_authenticated', 'no token'),
      'not_authenticated',
    ],
    [
      new GitHubBrokerError('server_error', 'GraphQL errors', {
        retriable: true,
      }),
      'github_unavailable',
    ],
  ])(
    'maps a baseline failure to %s without persisting anything',
    async (error, code) => {
      baselines({ 13: error });
      const result = await getAppAdvisorWatcherService().watchGitHubItems(
        prInput(12, 13),
        destination(),
      );

      expect(result).toMatchObject({ ok: false, code, itemIndex: 1 });
      expect(await readWatchers()).toEqual([]);
    },
  );

  it('delivers a merge that happened between the baseline and registration on the first observation', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(prInput(12), destination());
    if (!result.ok || result.status !== 'created') throw new Error('setup');

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: merged(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });

    const [message] = sentMessages();
    expect(message.text).toBe(
      [
        'GitHub pull request watcher update:',
        `- acme/api#12 merged into develop as ${MERGE_SHA.slice(0, 12)}: https://github.com/acme/api/pull/12`,
      ].join('\n'),
    );
    const context = firedContext(message.hiddenContextText);
    expect(context).toMatchObject({
      watcherId: result.watcherId,
      trigger: 'github_pull_requests_changed',
      events: [
        {
          kind: 'pull_request_merged',
          repository: 'acme/api',
          number: 12,
          url: 'https://github.com/acme/api/pull/12',
          baseBranch: 'develop',
          headSha: HEAD_SHA,
          mergedAt: '2026-10-07T00:01:00.000Z',
          mergeCommitSha: MERGE_SHA,
        },
      ],
      progress: { total: 1, settled: 1, active: 0 },
    });
    expect(message.hiddenContextText).not.toContain('"destination"');
    expect(message.hiddenContextText).not.toContain('PR 12');
    expect(
      await waitFor(async () => (await readWatchers())[0]?.status === 'fired'),
    ).toBe(true);
    const [watcher] = await readWatchers();
    expect(watcher.runtimeState).toMatchObject({
      items: [{ key: 'acme/api#12', settledAs: 'merged' }],
    });
    expect(watcher.runtimeState).not.toHaveProperty('pendingDelivery');
  });

  it('consumes a grouped watcher only after every item has been delivered', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!result.ok || result.status !== 'created') throw new Error('setup');
    const observe = (
      number: number,
      value: GitHubPullRequestSnapshot,
    ): Promise<void> =>
      service.applyGitHubPullRequestObservation({
        observations: [
          {
            kind: 'snapshot',
            subscriberIds: [result.watcherId],
            repository: 'acme/api',
            number,
            snapshot: value,
            queueHistory: NO_QUEUE_HISTORY,
          },
        ],
      });

    await observe(12, merged(12));
    expect(
      await waitFor(async () => (await readWatchers())[0]?.status === 'active'),
    ).toBe(true);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].text).toContain(
      '1 of 2 pull requests still open.',
    );
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([
      expect.objectContaining({ number: 13 }),
    ]);

    // A repeat read of the settled item is ignored.
    await observe(12, merged(12));
    expect(sentMessages()).toHaveLength(1);

    await observe(13, closed(13));
    expect(
      await waitFor(async () => (await readWatchers())[0]?.status === 'fired'),
    ).toBe(true);
    const messages = sentMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].text).toBe(
      [
        'GitHub pull request watcher update:',
        '- acme/api#13 was closed without merging: https://github.com/acme/api/pull/13',
      ].join('\n'),
    );
    expect(firedContext(messages[1].hiddenContextText)).toMatchObject({
      events: [{ kind: 'pull_request_closed', number: 13 }],
      progress: { total: 2, settled: 2, active: 0 },
    });
    expect(messages[0].deliveryId).not.toBe(messages[1].deliveryId);
  });

  it('records non-terminal changes, including queue state, without firing', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(prInput(12), destination());
    if (!result.ok || result.status !== 'created') throw new Error('setup');
    const queued = snapshot(12, {
      queue: {
        entryId: 'MQE_1',
        enqueuedAt: '2026-10-07T00:00:30.000Z',
        phase: 'awaiting_checks',
        position: 1,
      },
      observedAt: '2026-10-07T00:00:45.000Z',
    });

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: queued,
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });

    const [watcher] = await readWatchers();
    expect(watcher.status).toBe('active');
    expect(watcher.runtimeState).toMatchObject({
      items: [{ key: 'acme/api#12', last: queued }],
    });
    expect(watcher.runtimeState).not.toHaveProperty('pendingDelivery');
    expect(sentMessages()).toHaveLength(0);
    // The persisted queue state survives the load guards for the next diff.
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([
      expect.objectContaining({ number: 12, last: queued }),
    ]);
  });

  it('shows agents when a rate-limited watcher resumes and clears it on the next read', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(prInput(12), destination());
    if (!result.ok || result.status !== 'created') throw new Error('setup');
    const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'rate_limited',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          retryAt,
        },
      ],
    });

    const [paused] = await readWatchers();
    expect(paused.status).toBe('active');
    expect(paused.runtimeState).toMatchObject({ rateLimitedUntil: retryAt });
    expect(sentMessages()).toHaveLength(0);
    const search = await service.search({}, destination());
    expect(search.activeWatchers).toEqual([
      expect.objectContaining({
        id: result.watcherId,
        status: 'active',
        rateLimitedUntil: retryAt,
      }),
    ]);
    expect(await service.list()).toEqual([
      expect.objectContaining({
        id: result.watcherId,
        githubRateLimitedUntil: retryAt,
      }),
    ]);

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: snapshot(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });

    const [resumed] = await readWatchers();
    expect(resumed.runtimeState).not.toHaveProperty('rateLimitedUntil');
    const after = await service.search({}, destination());
    expect(after.activeWatchers[0]).not.toHaveProperty('rateLimitedUntil');
  });

  it('fails the watcher as a source failure without delivering an event', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(prInput(12), destination());
    if (!result.ok || result.status !== 'created') throw new Error('setup');

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'source_failure',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
        },
      ],
    });

    const [watcher] = await readWatchers();
    expect(watcher).toMatchObject({
      status: 'delivery_failed',
      failureKind: 'source',
      deliveryError: 'GitHub pull request is no longer accessible.',
    });
    expect(sentMessages()).toHaveLength(0);
  });

  it('delivers a sibling merge from the same cycle before failing on an inaccessible pull request', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!result.ok || result.status !== 'created') throw new Error('setup');

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: merged(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
        {
          kind: 'source_failure',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 13,
        },
      ],
    });

    expect(
      await waitFor(
        async () => (await readWatchers())[0]?.status === 'delivery_failed',
      ),
    ).toBe(true);
    const messages = sentMessages();
    expect(messages).toHaveLength(1);
    expect(firedContext(messages[0].hiddenContextText)).toMatchObject({
      events: [{ kind: 'pull_request_merged', number: 12 }],
    });
    expect((await readWatchers())[0]).toMatchObject({
      failureKind: 'source',
      deliveryError: 'GitHub pull request is no longer accessible.',
    });
  });

  it('fails a grouped watcher instead of dropping an event whose delivery is no longer authorized', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!result.ok || result.status !== 'created') throw new Error('setup');
    mockBackgroundExecutionEnabled = true;
    mockDeliveryAuthorization = { allow: false, reason: 'revoked' };

    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: merged(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });

    expect(
      await waitFor(
        async () => (await readWatchers())[0]?.status === 'delivery_failed',
      ),
    ).toBe(true);
    expect(sentMessages()).toHaveLength(0);
    // The settled merge is not silently dropped while a sibling is watched.
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([]);
  });

  it('never delivers a read that was in flight when the watcher was deleted', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(prInput(12), destination());
    if (!result.ok || result.status !== 'created') throw new Error('setup');

    let resolveRead: (value: {
      snapshot: GitHubPullRequestSnapshot;
    }) => void = () => undefined;
    let readSignal: AbortSignal | undefined;
    mockFetchGitHubPullRequest.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) => {
        readSignal = signal;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    );
    const observer = getGitHubPullRequestObserver();
    observer.start();
    await observer.rescan();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(readSignal).toBeDefined();

    await expect(service.deleteWatcher(result.watcherId)).resolves.toBe(true);
    expect(readSignal?.aborted).toBe(true);
    resolveRead({ snapshot: merged(12) });
    await jest.advanceTimersByTimeAsync(60_000);

    // A late application for the deleted watcher is a no-op too.
    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: merged(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });
    expect(sentMessages()).toHaveLength(0);
    expect(await readWatchers()).toEqual([]);
  });

  describe('in cowork chats', () => {
    function cowork(chatId: string): AppAdvisorWatcherDestination {
      return { projectId: 'cowork-1', worktreeId: 'entry-1', chatId };
    }
    const sendChatWindowCommand = jest.fn<boolean, [ChatWindowCommand]>();

    beforeEach(() => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      sendChatWindowCommand.mockReset();
      sendChatWindowCommand.mockImplementation((command) => {
        queueMicrotask(() => {
          getAppAdvisorWatcherService().acknowledgeWatcherMessageDelivery(
            command.watcherId,
            command.deliveryId,
            { ok: true },
          );
        });
        return true;
      });
      getAppAdvisorWatcherService().configure({
        getMainWindow: () => null,
        getAppAdvisorWindow: () => null,
        ensureAppAdvisorWindow: () =>
          Promise.resolve({ open: true, focused: false }),
        sendAppAdvisorWindowCommand,
        sendChatWindowCommand,
      });
    });

    it('creates, dedupes, lists, and deletes watchers per cowork chat', async () => {
      const service = getAppAdvisorWatcherService();
      const first = await service.watchGitHubItems(prInput(12), cowork('a'), {
        toolUseId: 'tool-a',
      });
      const retry = await service.watchGitHubItems(prInput(12), cowork('a'), {
        toolUseId: 'tool-a2',
      });
      const otherChat = await service.watchGitHubItems(
        prInput(12),
        cowork('b'),
        { toolUseId: 'tool-b' },
      );
      if (!first.ok || first.status !== 'created') throw new Error('setup');
      if (!otherChat.ok || otherChat.status !== 'created')
        throw new Error('setup');

      expect(retry).toMatchObject({
        status: 'deduped',
        watcherId: first.watcherId,
      });
      expect(
        (await readWatchers()).find((watcher) => watcher.id === first.watcherId)
          ?.destination,
      ).toMatchObject(cowork('a'));
      expect(
        (await service.list(cowork('a'))).map((watcher) => watcher.id),
      ).toEqual([first.watcherId]);
      await expect(
        service.deleteAgentWatchers(
          { watcherIds: [first.watcherId] },
          cowork('b'),
        ),
      ).resolves.toMatchObject({
        results: [{ watcherId: first.watcherId, status: 'not_found' }],
      });
      await expect(
        service.deleteAgentWatchers(
          { watcherIds: [first.watcherId] },
          cowork('a'),
        ),
      ).resolves.toMatchObject({
        results: [{ watcherId: first.watcherId, status: 'deleted' }],
      });
      expect((await readWatchers()).map((watcher) => watcher.id)).toEqual([
        otherChat.watcherId,
      ]);
    });

    it('delivers a merge only to the cowork chat that created the watcher', async () => {
      const service = getAppAdvisorWatcherService();
      const watched = await service.watchGitHubItems(prInput(12), cowork('a'));
      await service.watchGitHubItems(prInput(13), cowork('b'));
      if (!watched.ok || watched.status !== 'created') throw new Error('setup');

      await service.applyGitHubPullRequestObservation({
        observations: [
          {
            kind: 'snapshot',
            subscriberIds: [watched.watcherId],
            repository: 'acme/api',
            number: 12,
            snapshot: merged(12),
            queueHistory: NO_QUEUE_HISTORY,
          },
        ],
      });

      expect(
        await waitFor(
          async () =>
            (await readWatchers()).find(
              (watcher) => watcher.id === watched.watcherId,
            )?.status === 'fired',
        ),
      ).toBe(true);
      expect(sendChatWindowCommand).toHaveBeenCalledTimes(1);
      expect(sendChatWindowCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'send_watcher_message',
          ...cowork('a'),
          watcherId: watched.watcherId,
        }),
      );
      expect(sentMessages()).toHaveLength(0);
    });

    it('rejects a legacy sentinel-keyed cowork chat before reading GitHub', async () => {
      const result = await getAppAdvisorWatcherService().watchGitHubItems(
        prInput(12),
        {
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-1',
          chatId: 'a',
        },
      );

      expect(result).toEqual({
        ok: false,
        code: 'invalid_input',
        message:
          'Watcher destinations must use a real project id, not the standalone sentinel.',
      });
      expect(mockFetchGitHubPullRequest).not.toHaveBeenCalled();
      expect(await readWatchers()).toEqual([]);
    });
  });

  it('resumes observing persisted pull request watchers after a restart', async () => {
    const service = getAppAdvisorWatcherService();
    const result = await service.watchGitHubItems(
      prInput(12, 13),
      destination(),
    );
    if (!result.ok || result.status !== 'created') throw new Error('setup');
    await service.applyGitHubPullRequestObservation({
      observations: [
        {
          kind: 'snapshot',
          subscriberIds: [result.watcherId],
          repository: 'acme/api',
          number: 12,
          snapshot: merged(12),
          queueHistory: NO_QUEUE_HISTORY,
        },
      ],
    });
    expect(
      await waitFor(async () => (await readWatchers())[0]?.status === 'active'),
    ).toBe(true);

    service.shutdown();
    await service.drain();
    configureService();

    expect(await service.list(destination())).toEqual([
      expect.objectContaining({
        id: result.watcherId,
        trigger: 'github_pull_requests_changed',
        status: 'active',
      }),
    ]);
    expect(await service.listGitHubPullRequestSubscriptions()).toEqual([
      {
        watcherId: result.watcherId,
        repository: 'acme/api',
        number: 13,
        last: snapshot(13),
        queueCursor: { count: 0, lastEventId: null },
      },
    ]);
  });
});
