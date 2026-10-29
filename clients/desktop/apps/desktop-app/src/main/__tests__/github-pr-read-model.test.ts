/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
const execute = jest.fn();
jest.mock('../lib/github-broker', () => {
  const errors = jest.requireActual('../lib/github-broker/errors');
  return {
    getGitHubBroker: () => ({
      execute,
      getCredentialGeneration: (): number => 0,
    }),
    GitHubBrokerError: errors.GitHubBrokerError,
    GitHubBrokerCredentialResetError: errors.GitHubBrokerCredentialResetError,
    isGitHubBrokerError: errors.isGitHubBrokerError,
  };
});
jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(() => Promise.resolve('git@github.com:acme/api.git')),
}));

import {
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
} from '../lib/github-broker/errors';
import {
  getGitHubPullRequestStatus,
  invalidateGitHubPullRequest,
  normalizeGitHubPullRequestStatus,
  readGitHubPullRequestForWatcher,
  resetGitHubPullRequestReadModel,
  seedGitHubPullRequestStatus,
  type GitHubPullRequestStatusView,
} from '../lib/github-pr-read-model';
import { resolvePullRequestForRepo } from '../lib/github-pr-resolver';
import { emitPullRequestSwept } from '../lib/github-pr-sweep';
import { createGitHubReferencePreviewReader } from '../lib/github-reference-preview';

const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const REF = { owner: 'acme', repo: 'api', number: 12 };

interface Answer {
  pr?: Record<string, unknown>;
  body?: unknown;
  gate?: Promise<void>;
}

interface RecordedRequest {
  options: {
    priority: string;
    signal?: AbortSignal;
    operation: string;
    idempotency: string;
    resource?: string;
    caller?: string;
  };
  query: string;
  variables: Record<string, unknown>;
}

let answers: Answer[] = [];
let requests: RecordedRequest[] = [];

function check(name: string, conclusion: string | null, status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PR_node',
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    closedAt: null,
    url: 'https://github.com/acme/api/pull/12',
    title: '  Add   the thing ',
    isDraft: false,
    baseRefName: 'develop',
    headRefName: 'feature/thing',
    headRefOid: HEAD_SHA,
    headRepository: { nameWithOwner: 'acme/api' },
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    mergeCommit: null,
    isInMergeQueue: false,
    mergeQueueEntry: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: {
                totalCount: 2,
                nodes: [
                  check('build', 'SUCCESS'),
                  {
                    __typename: 'StatusContext',
                    context: 'ci',
                    state: 'SUCCESS',
                  },
                ],
              },
            },
          },
        },
      ],
    },
    queueEvents: {
      filteredCount: 0,
      pageInfo: { hasPreviousPage: false, startCursor: null },
      nodes: [],
    },
    ...overrides,
  };
}

function rollup(state: string, nodes: unknown[], totalCount = nodes.length) {
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: { state, contexts: { totalCount, nodes } },
        },
      },
    ],
  };
}

const MERGED = {
  state: 'MERGED',
  merged: true,
  mergedAt: '2026-10-13T11:00:00Z',
  closedAt: '2026-10-13T11:00:00Z',
  mergeCommit: { oid: MERGE_SHA },
};

function answer(next: Answer = {}): void {
  answers.push(next);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortable(signal: AbortSignal | undefined, gate: Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new GitHubBrokerError('cancelled', 'cancelled')),
      { once: true },
    );
    void gate.then(resolve);
  });
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function advance(ms: number): void {
  jest.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  answers = [];
  requests = [];
  resetGitHubPullRequestReadModel();
  execute.mockReset();
  execute.mockImplementation(
    async (
      request: (
        octokit: unknown,
        headers: Record<string, string>,
      ) => Promise<{ data: unknown }>,
      options: RecordedRequest['options'],
    ) => {
      const next = answers.shift() ?? {};
      const octokit = {
        request: async (
          _route: string,
          params: { query: string; variables: Record<string, unknown> },
        ) => {
          requests.push({ options, ...params });
          if (next.gate) await abortable(options.signal, next.gate);
          return {
            status: 200,
            headers: {},
            data: next.body ?? {
              data: {
                repository: {
                  pullRequest: pullRequest({
                    url: `https://github.com/acme/api/pull/${String(params.variables.number)}`,
                    ...next.pr,
                  }),
                },
              },
            },
          };
        },
      };
      const raw = await request(octokit, {});
      return {
        kind: 'read',
        data: raw.data,
        changed: true,
        status: 200,
        rateLimit: {},
      };
    },
  );
});

afterEach(() => {
  jest.useRealTimers();
});

describe('normalizeGitHubPullRequestStatus', () => {
  it('maps one read to the shared view and the watcher read', () => {
    const { view, watcher } = normalizeGitHubPullRequestStatus(
      {
        data: {
          repository: {
            pullRequest: pullRequest({
              isDraft: true,
              mergeable: 'CONFLICTING',
              reviewDecision: 'CHANGES_REQUESTED',
              isInMergeQueue: true,
              mergeQueueEntry: {
                id: 'MQE_1',
                enqueuedAt: '2026-10-13T11:59:00Z',
                state: 'QUEUED',
                position: 3,
              },
              commits: rollup(
                'FAILURE',
                [
                  check('build', 'SUCCESS'),
                  check('lint', 'FAILURE'),
                  check('lint', 'TIMED_OUT'),
                  check('e2e', null, 'IN_PROGRESS'),
                  {
                    __typename: 'StatusContext',
                    context: 'deploy',
                    state: 'ERROR',
                  },
                  {
                    __typename: 'StatusContext',
                    context: 'cla',
                    state: 'PENDING',
                  },
                  check('docs', 'SKIPPED'),
                ],
                120,
              ),
            }),
          },
        },
      },
      REF,
      '2026-10-13T12:00:00.000Z',
    );
    expect(view).toEqual({
      ref: REF,
      url: 'https://github.com/acme/api/pull/12',
      title: 'Add the thing',
      state: 'open',
      isDraft: true,
      headBranch: 'feature/thing',
      baseBranch: 'develop',
      headSha: HEAD_SHA,
      headRepository: 'acme/api',
      mergeable: 'conflicting',
      reviewDecision: 'changes_requested',
      checks: {
        state: 'failure',
        total: 120,
        passed: 2,
        failed: 3,
        pending: 2,
        failedNames: ['lint', 'deploy'],
        available: true,
      },
      mergeQueue: { inQueue: true, position: 3 },
      fetchedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(watcher.snapshot).toMatchObject({
      state: 'open',
      headSha: HEAD_SHA,
      queue: { entryId: 'MQE_1', position: 3 },
      observedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(watcher.queueTimeline).toEqual({
      filteredCount: 0,
      startCursor: null,
      events: [],
    });
  });

  it('falls back to neutral view fields the response omits', () => {
    const pr = pullRequest();
    for (const field of [
      'isDraft',
      'headRefName',
      'headRepository',
      'mergeable',
      'reviewDecision',
      'commits',
    ]) {
      delete pr[field as keyof typeof pr];
    }
    const { view } = normalizeGitHubPullRequestStatus(
      { data: { repository: { pullRequest: pr } } },
      REF,
    );
    expect(view).toMatchObject({
      isDraft: false,
      headBranch: '',
      headRepository: null,
      mergeable: 'unknown',
      reviewDecision: null,
      checks: { state: 'none', total: 0, available: true },
    });
  });

  it('keeps the read when only the checks were withheld', () => {
    const { view } = normalizeGitHubPullRequestStatus(
      {
        data: {
          repository: { pullRequest: pullRequest({ commits: null }) },
        },
        errors: [
          {
            type: 'FORBIDDEN',
            path: ['repository', 'pullRequest', 'commits'],
            message: 'Resource not accessible by personal access token',
          },
        ],
      },
      REF,
    );
    expect(view.checks).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failedNames: [],
      available: false,
    });
    expect(view.state).toBe('open');
  });

  it('classifies lifecycle failures exactly like the watcher read', () => {
    const thrownBy = (body: unknown): unknown => {
      try {
        normalizeGitHubPullRequestStatus(body, REF);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(
      thrownBy({
        data: { repository: { pullRequest: pullRequest() } },
        errors: [{ type: 'SOMETHING', path: ['repository', 'pullRequest'] }],
      }),
    ).toMatchObject({ code: 'server_error' });
    expect(
      thrownBy({
        data: { repository: { pullRequest: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }],
      }),
    ).toMatchObject({ code: 'not_found' });
  });
});

describe('getGitHubPullRequestStatus', () => {
  it('reads once through the broker as a safe GraphQL read and caches the view', async () => {
    const first = await getGitHubPullRequestStatus(REF);
    advance(59_000);
    const second = await getGitHubPullRequestStatus({
      owner: 'ACME',
      repo: 'Api',
      number: 12,
    });
    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[0].options).toMatchObject({
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      resource: 'graphql',
    });
    expect(requests[0].query).toContain('statusCheckRollup');
    expect(requests[0].variables).toEqual({
      owner: 'acme',
      name: 'api',
      number: 12,
    });
  });

  it.each([
    [
      'open with pending checks',
      { commits: rollup('PENDING', [check('build', null, 'QUEUED')]) },
      15_000,
    ],
    ['open', {}, 60_000],
    ['closed', { state: 'CLOSED', closedAt: '2026-10-13T11:00:00Z' }, 60_000],
    [
      'closed with pending checks',
      {
        state: 'CLOSED',
        closedAt: '2026-10-13T11:00:00Z',
        commits: rollup('PENDING', []),
      },
      60_000,
    ],
    ['merged', MERGED, 600_000],
  ])('keeps a %s pull request fresh for its TTL', async (_label, pr, ttl) => {
    answer({ pr });
    await getGitHubPullRequestStatus(REF);
    advance(ttl);
    await getGitHubPullRequestStatus(REF);
    expect(execute).toHaveBeenCalledTimes(1);
    advance(1);
    await getGitHubPullRequestStatus(REF);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('honors a tighter caller max age but never extends the TTL', async () => {
    await getGitHubPullRequestStatus(REF);
    advance(5_001);
    await getGitHubPullRequestStatus(REF, { maxAgeMs: 5_000 });
    expect(execute).toHaveBeenCalledTimes(2);
    advance(60_001);
    await getGitHubPullRequestStatus(REF, { maxAgeMs: 3_600_000 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('passes the caller priority to the broker', async () => {
    await getGitHubPullRequestStatus(REF, { priority: 'background' });
    await getGitHubPullRequestStatus(
      { ...REF, number: 13 },
      { priority: 'watcher' },
    );
    expect(requests.map(({ options }) => options.priority)).toEqual([
      'background',
      'watcher',
    ]);
  });

  it('labels the read for the broker spend summary', async () => {
    await getGitHubPullRequestStatus(REF, { caller: 'agent-pr-status' });
    await readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 13,
      priority: 'watcher',
      caller: 'pr-observer',
    });
    expect(requests.map(({ options }) => options.caller)).toEqual([
      'agent-pr-status',
      'pr-observer',
    ]);
  });

  it('shares one in-flight read while each caller keeps its own abort', async () => {
    const gate = deferred();
    answer({ gate: gate.promise });
    const leaving = new AbortController();
    const first = getGitHubPullRequestStatus(REF, { signal: leaving.signal });
    const second = getGitHubPullRequestStatus(REF);
    const third = getGitHubPullRequestStatus(REF, { maxAgeMs: 0 });
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);

    leaving.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests[0].options.signal?.aborted).toBe(false);

    gate.resolve();
    const [secondView, thirdView] = await Promise.all([second, third]);
    expect(secondView).toBe(thirdView);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared read once every caller left and starts afresh', async () => {
    answer({ gate: new Promise<void>(() => undefined) });
    const one = new AbortController();
    const two = new AbortController();
    const first = getGitHubPullRequestStatus(REF, { signal: one.signal });
    const second = getGitHubPullRequestStatus(REF, { signal: two.signal });
    await flush();
    one.abort();
    two.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests[0].options.signal?.aborted).toBe(true);

    await getGitHubPullRequestStatus(REF);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects an already aborted caller without a request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getGitHubPullRequestStatus(REF, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('upgrades a lower-priority in-flight read instead of waiting behind it', async () => {
    const gate = deferred();
    answer({ gate: gate.promise });
    const background = getGitHubPullRequestStatus(REF, {
      priority: 'background',
    });
    await flush();
    const interactive = getGitHubPullRequestStatus(REF);
    const watcher = getGitHubPullRequestStatus(REF, { priority: 'watcher' });
    await flush();
    expect(requests.map(({ options }) => options.priority)).toEqual([
      'background',
      'interactive',
    ]);
    await Promise.all([interactive, watcher]);
    gate.resolve();
    await background;
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    answer({
      body: {
        data: { repository: { pullRequest: null } },
        errors: [{ type: 'NOT_FOUND' }],
      },
    });
    await expect(getGitHubPullRequestStatus(REF)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(getGitHubPullRequestStatus(REF)).resolves.toMatchObject({
      state: 'open',
    });
  });

  it('rejects malformed references without a request', async () => {
    await expect(
      getGitHubPullRequestStatus({ owner: 'acme', repo: '../x', number: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      getGitHubPullRequestStatus({ ...REF, number: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('credential changes', () => {
  it('forgets every view on reset and keeps an older in-flight read out', async () => {
    await getGitHubPullRequestStatus(REF);
    const gate = deferred();
    answer({ gate: gate.promise, pr: { title: 'old credential' } });
    const other = getGitHubPullRequestStatus({ ...REF, number: 13 });
    await flush();
    resetGitHubPullRequestReadModel();
    gate.resolve();
    await other;

    answer({ pr: { title: 'new credential' } });
    expect((await getGitHubPullRequestStatus(REF)).title).toBe(
      'new credential',
    );
    answer({ pr: { title: 'new credential' } });
    expect(
      (await getGitHubPullRequestStatus({ ...REF, number: 13 })).title,
    ).toBe('new credential');
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'credential reset',
      new GitHubBrokerCredentialResetError('credential_reset'),
    ],
    [
      'missing authentication',
      new GitHubBrokerError('not_authenticated', 'no token'),
    ],
  ])('forgets every view after a %s failure', async (_label, error) => {
    await getGitHubPullRequestStatus(REF);
    execute.mockRejectedValueOnce(error);
    await expect(
      getGitHubPullRequestStatus({ ...REF, number: 13 }),
    ).rejects.toBe(error);
    await getGitHubPullRequestStatus(REF);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe('seedGitHubPullRequestStatus', () => {
  function view(
    overrides: Partial<GitHubPullRequestStatusView> = {},
  ): GitHubPullRequestStatusView {
    return {
      ref: REF,
      url: 'https://github.com/acme/api/pull/12',
      title: 'Seeded',
      state: 'open',
      isDraft: false,
      headBranch: 'feature/thing',
      baseBranch: 'develop',
      headSha: HEAD_SHA,
      headRepository: 'acme/api',
      mergeable: 'mergeable',
      reviewDecision: null,
      checks: {
        state: 'success',
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        failedNames: [],
        available: true,
      },
      mergeQueue: { inQueue: false, position: null },
      fetchedAt: new Date(NOW).toISOString(),
      ...overrides,
    };
  }

  it('answers from a seeded view until its TTL passes', async () => {
    seedGitHubPullRequestStatus(view());
    advance(60_000);
    expect((await getGitHubPullRequestStatus(REF)).title).toBe('Seeded');
    expect(execute).not.toHaveBeenCalled();
    advance(1);
    expect((await getGitHubPullRequestStatus(REF)).title).toBe('Add the thing');
  });

  it('ignores a seed older than the cached view', async () => {
    await getGitHubPullRequestStatus(REF);
    seedGitHubPullRequestStatus(
      view({ fetchedAt: new Date(NOW - 1_000).toISOString() }),
    );
    expect((await getGitHubPullRequestStatus(REF)).title).toBe('Add the thing');
    advance(1_000);
    seedGitHubPullRequestStatus(view({ fetchedAt: new Date().toISOString() }));
    expect((await getGitHubPullRequestStatus(REF)).title).toBe('Seeded');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never serves a seed to a watcher, which needs lifecycle times', async () => {
    seedGitHubPullRequestStatus(view());
    await readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 12,
      priority: 'watcher',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateGitHubPullRequest', () => {
  it('drops the cached view', async () => {
    await getGitHubPullRequestStatus(REF);
    invalidateGitHubPullRequest({ owner: 'Acme', repo: 'API', number: 12 });
    await getGitHubPullRequestStatus(REF);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps a read that started before a mutation from answering later callers', async () => {
    const gate = deferred();
    answer({ gate: gate.promise, pr: { title: 'before merge' } });
    const before = getGitHubPullRequestStatus(REF);
    await flush();
    invalidateGitHubPullRequest(REF);
    answer({ pr: MERGED });
    const after = getGitHubPullRequestStatus(REF);
    gate.resolve();
    expect((await before).title).toBe('before merge');
    expect((await after).state).toBe('merged');
    expect((await getGitHubPullRequestStatus(REF)).state).toBe('merged');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('PR status sweeps', () => {
  const SWEPT = { owner: 'acme', repo: 'api', number: 41 };
  const swept = (status: string, remarks = 'r1') =>
    emitPullRequestSwept({ ...SWEPT, fingerprint: { status, remarks } });

  it('drop a cached view only when the fingerprint moved', async () => {
    await getGitHubPullRequestStatus(SWEPT);
    swept('s1');
    swept('s1');
    await getGitHubPullRequestStatus(SWEPT);
    expect(execute).toHaveBeenCalledTimes(1);

    swept('s2');
    await getGitHubPullRequestStatus(SWEPT);
    expect(execute).toHaveBeenCalledTimes(2);

    swept('s2', 'r2');
    await getGitHubPullRequestStatus(SWEPT);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe('readGitHubPullRequestForWatcher', () => {
  it('shares one read with status callers and returns the newest timeline page', async () => {
    const gate = deferred();
    answer({ gate: gate.promise });
    const status = getGitHubPullRequestStatus(REF, { priority: 'watcher' });
    const watcher = readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 12,
      priority: 'watcher',
    });
    await flush();
    gate.resolve();
    const [view, read] = await Promise.all([status, watcher]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(read.snapshot.headSha).toBe(view.headSha);
    expect(read.queueHistory).toEqual({
      status: 'complete',
      filteredCount: 0,
      firstIndex: 0,
      events: [],
    });
  });

  it('reuses a cached read only within its max age', async () => {
    await getGitHubPullRequestStatus(REF);
    advance(10_000);
    await readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 12,
      priority: 'watcher',
      maxAgeMs: 10_000,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    advance(15_001);
    await readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 12,
      priority: 'watcher',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('pages older history through the watcher reader when the cursor predates the newest page', async () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      __typename: 'AddedToMergeQueueEvent',
      id: `ATMQE_${index}`,
      createdAt: new Date(NOW - (12 - index) * 60_000).toISOString(),
    }));
    const newest = {
      filteredCount: 12,
      pageInfo: { hasPreviousPage: true, startCursor: 'cursor:2' },
      nodes: events.slice(2),
    };
    answer({ pr: { queueEvents: newest } });
    await getGitHubPullRequestStatus(REF);
    answer({ pr: { queueEvents: newest } });
    answer({
      body: {
        data: {
          repository: {
            pullRequest: {
              queueEvents: {
                filteredCount: 2,
                pageInfo: { hasPreviousPage: false, startCursor: 'cursor:0' },
                nodes: events.slice(0, 2),
              },
            },
          },
        },
      },
    });
    const read = await readGitHubPullRequestForWatcher({
      repository: 'acme/api',
      number: 12,
      priority: 'watcher',
      queueHistoryFrom: 1,
    });
    expect(read.queueHistory).toMatchObject({
      status: 'complete',
      firstIndex: 0,
      filteredCount: 12,
    });
    expect(requests).toHaveLength(3);
    expect(requests[2].variables).toMatchObject({ before: 'cursor:2' });
  });
});

describe('consumers share the read model', () => {
  it('serves concurrent agent, watcher, resolver and preview asks with one GitHub read', async () => {
    const gate = deferred();
    answer({ gate: gate.promise });
    const preview = createGitHubReferencePreviewReader({
      resolveToken: () => Promise.resolve('token'),
      resolveAccountId: () => Promise.resolve('account'),
      requestItem: () =>
        Promise.resolve({
          title: 'Add the thing',
          html_url: 'https://github.com/acme/api/pull/12',
          updated_at: '2026-10-13T11:00:00Z',
          state: 'open',
          pull_request: {},
        }),
      readPullState: async (item) => {
        const view = await getGitHubPullRequestStatus({
          owner: item.owner,
          repo: item.repository,
          number: item.number,
        });
        return { merged: view.state === 'merged', draft: view.isDraft };
      },
      requestRepository: () => Promise.reject(new Error('unexpected')),
      resolveOriginRepository: () => Promise.resolve(null),
      isCoworkProject: () => false,
      now: () => NOW,
    });
    const asks = Promise.all([
      getGitHubPullRequestStatus(REF, { priority: 'interactive' }),
      readGitHubPullRequestForWatcher({
        repository: 'acme/api',
        number: 12,
        priority: 'interactive',
      }),
      resolvePullRequestForRepo('/repo', '#12'),
      preview.read({
        kind: 'item',
        owner: 'acme',
        repository: 'api',
        number: 12,
      }),
    ]);
    await flush();
    await flush();
    gate.resolve();
    const [, , resolved, previewed] = await asks;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      number: 12,
      title: 'Add the thing',
      headRefName: 'feature/thing',
      baseRefName: 'develop',
      url: 'https://github.com/acme/api/pull/12',
    });
    expect(previewed).toMatchObject({
      status: 'ok',
      preview: { itemType: 'pull', state: 'open', draft: false },
    });
  });
});
