import type {
  GitHubPullRequestRef,
  GitHubPullRequestStatusView,
} from '../lib/github-pr-read-model';

const mockGetGitHubPullRequestStatus = jest.fn<
  Promise<GitHubPullRequestStatusView>,
  [
    GitHubPullRequestRef,
    { priority?: string; signal?: AbortSignal; maxAgeMs?: number }?,
  ]
>();

jest.mock('../lib/github-pr-read-model', () => ({
  getGitHubPullRequestStatus: (
    ...args: Parameters<typeof mockGetGitHubPullRequestStatus>
  ): Promise<GitHubPullRequestStatusView> =>
    mockGetGitHubPullRequestStatus(...args),
}));

import {
  executeGetGitHubPullRequestStatus,
  type GetGitHubPullRequestStatusResult,
} from '../canopy-tools/github-pull-request-status';
import { GitHubBrokerError } from '../lib/github-broker/errors';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');

function statusView(
  overrides: Partial<GitHubPullRequestStatusView> = {},
): GitHubPullRequestStatusView {
  return {
    ref: { owner: 'acme', repo: 'api', number: 7 },
    url: 'https://github.com/acme/api/pull/7',
    title: 'Add the thing',
    state: 'open',
    isDraft: false,
    headBranch: 'feature/thing',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    mergeable: 'mergeable',
    reviewDecision: 'review_required',
    checks: {
      state: 'failure',
      total: 4,
      passed: 2,
      failed: 1,
      pending: 1,
      failedNames: ['unit'],
    },
    mergeQueue: { inQueue: false, position: null },
    fetchedAt: '2026-10-13T11:59:50.000Z',
    ...overrides,
  };
}

function parse(text: string): unknown {
  return JSON.parse(text);
}

async function run(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<GetGitHubPullRequestStatusResult> {
  return executeGetGitHubPullRequestStatus(rawArgs, {
    now: () => NOW,
    ...(signal ? { signal } : {}),
  });
}

beforeEach(() => {
  mockGetGitHubPullRequestStatus.mockReset();
});

describe('GetGitHubPullRequestStatus arguments', () => {
  it.each([
    ['https://github.com/acme/api/pull/7', 'acme', 'api', 7],
    ['https://github.com/acme/api/pull/7/files', 'acme', 'api', 7],
    ['https://www.github.com/Acme/API/pull/12', 'acme', 'api', 12],
    ['acme/api#7', 'acme', 'api', 7],
  ])(
    'reads %s as one interactive read-model request',
    async (pullRequest, owner, repo, number) => {
      mockGetGitHubPullRequestStatus.mockResolvedValue(statusView());
      const controller = new AbortController();
      const result = await run({ pullRequest }, controller.signal);
      expect(result.isError).toBeUndefined();
      expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledTimes(1);
      expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledWith(
        { owner, repo, number },
        {
          priority: 'interactive',
          caller: 'agent-pr-status',
          signal: controller.signal,
        },
      );
    },
  );

  it.each([
    [{}],
    [{ pullRequest: '' }],
    [{ pullRequest: 7 }],
    [{ pullRequest: 'acme/api#7', repository: 'acme/api' }],
    ['acme/api#7'],
  ])('rejects malformed input %p without reading GitHub', async (rawArgs) => {
    const result = await run(rawArgs);
    expect(result.isError).toBe(true);
    expect(parse(result.text)).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(mockGetGitHubPullRequestStatus).not.toHaveBeenCalled();
  });

  it.each([
    [
      'https://gitlab.com/acme/api/-/merge_requests/7',
      'Only GitHub.com pull request references are supported.',
    ],
    [
      'https://github.example.com/acme/api/pull/7',
      'Only GitHub.com pull request references are supported.',
    ],
    ['acme/api', 'Use a GitHub pull request URL'],
    ['https://github.com/acme/api/issues/7', 'Use a GitHub pull request URL'],
    [' acme/api#7', 'Use a GitHub pull request URL'],
  ])(
    'rejects %s with the WatchGitHubItems reference rules',
    async (pullRequest, message) => {
      const result = await run({ pullRequest });
      expect(result.isError).toBe(true);
      const payload = parse(result.text);
      expect(payload).toMatchObject({ ok: false, code: 'invalid_reference' });
      expect(JSON.stringify(payload)).toContain(message);
      expect(mockGetGitHubPullRequestStatus).not.toHaveBeenCalled();
    },
  );
});

describe('GetGitHubPullRequestStatus result', () => {
  it('returns the cached status with the repository and number flattened', async () => {
    mockGetGitHubPullRequestStatus.mockResolvedValue(statusView());
    const result = await run({ pullRequest: 'acme/api#7' });
    expect(result.isError).toBeUndefined();
    expect(parse(result.text)).toEqual({
      ok: true,
      pullRequest: {
        repository: 'acme/api',
        number: 7,
        url: 'https://github.com/acme/api/pull/7',
        title: 'Add the thing',
        state: 'open',
        isDraft: false,
        headBranch: 'feature/thing',
        baseBranch: 'main',
        headSha: 'a'.repeat(40),
        mergeable: 'mergeable',
        reviewDecision: 'review_required',
        checks: {
          state: 'failure',
          total: 4,
          passed: 2,
          failed: 1,
          pending: 1,
          failedNames: ['unit'],
        },
        mergeQueue: { inQueue: false, position: null },
        fetchedAt: '2026-10-13T11:59:50.000Z',
      },
    });
  });

  it('tells the agent when paused GitHub reads resume', async () => {
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new GitHubBrokerError('rate_limited', 'GitHub reads are paused.', {
        retriable: true,
        retryAt: NOW + 90_500,
        resource: 'graphql',
      }),
    );
    const result = await run({ pullRequest: 'acme/api#7' });
    expect(result.isError).toBe(true);
    const payload = parse(result.text);
    expect(payload).toMatchObject({
      ok: false,
      code: 'rate_limited',
      retryAt: '2026-10-13T12:01:30.500Z',
      retryAfterSeconds: 91,
    });
    const text = JSON.stringify(payload);
    expect(text).toContain('until 2026-10-13T12:01:30.500Z');
    expect(text).toContain('WatchGitHubItems');
    expect(text).toContain('Do not retry before then');
  });

  it('reports a rate limit without a resume time when the broker has none', async () => {
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new GitHubBrokerError('rate_limited', 'Rate limited.', {
        retriable: true,
      }),
    );
    const result = await run({ pullRequest: 'acme/api#7' });
    const payload = parse(result.text);
    expect(payload).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(payload).not.toHaveProperty('retryAt');
    expect(JSON.stringify(payload)).toContain('Try again in a few minutes');
  });

  it.each([
    ['not_found', 'acme/api#7 was not found'],
    ['permission_denied', 'is not allowed to read acme/api#7'],
    ['not_authenticated', 'Ask the user to reconnect GitHub'],
  ] as const)('maps the broker %s error', async (code, message) => {
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new GitHubBrokerError(code, 'GitHub said no.'),
    );
    const result = await run({ pullRequest: 'acme/api#7' });
    expect(result.isError).toBe(true);
    const payload = parse(result.text);
    expect(payload).toMatchObject({ ok: false, code });
    expect(JSON.stringify(payload)).toContain(message);
  });

  it('reports other failures as unavailable with their message', async () => {
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new Error('github-pr-read-model not integrated'),
    );
    const result = await run({ pullRequest: 'acme/api#7' });
    expect(result.isError).toBe(true);
    expect(parse(result.text)).toEqual({
      ok: false,
      code: 'unavailable',
      message:
        'Could not read acme/api#7 from GitHub: github-pr-read-model not integrated',
    });
  });
});
