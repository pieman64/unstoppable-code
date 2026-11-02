import type { GitHubPreviewTarget } from '@canopy/protocol/reference-previews';
import type * as Fs from 'node:fs/promises';
import { sep } from 'node:path';
import {
  findTrackedPrSnapshot,
  resetPrPreviewIndexForTests,
} from '../lib/github-pr-hook-state';
import { GitHubBrokerError } from '../lib/github-broker/errors';
import { getWorktreeDataDir } from '../lib/paths';
import {
  createGitHubReferencePreviewReader,
  PULL_FACTS_TIMEOUT_MS,
  type GitHubReferencePreviewDeps,
} from '../lib/github-reference-preview';

const ANY_STRING: unknown = expect.any(String);
const ANY_SIGNAL: unknown = expect.any(AbortSignal);
const TOKEN = 'ghp_preview_token';

const ISSUE = {
  number: 1234,
  title: 'Hydrate references in transcripts',
  body: '## Goal\n\nShow **compact** cards. ![shot](https://x/y.png) See [docs](https://d).',
  html_url: 'https://github.com/Acme/Widgets/issues/1234',
  state: 'open',
  user: { login: 'rowan' },
  updated_at: '2026-10-01T12:00:00Z',
};

const PULL = {
  ...ISSUE,
  html_url: 'https://github.com/Acme/Widgets/pull/1234',
  draft: false,
  pull_request: {
    url: 'https://api.github.com/repos/Acme/Widgets/pulls/1234',
    merged_at: null,
  },
};

const REPOSITORY = {
  full_name: 'Acme/Widgets',
  html_url: 'https://github.com/Acme/Widgets',
  description: 'Widgets   for\neveryone',
  private: true,
  archived: false,
  updated_at: '2026-09-30T08:00:00Z',
};

const ITEM: GitHubPreviewTarget = {
  kind: 'item',
  owner: 'acme',
  repository: 'widgets',
  number: 1234,
};
const REPO: GitHubPreviewTarget = {
  kind: 'repository',
  owner: 'acme',
  repository: 'widgets',
};

function reader(
  overrides: Partial<GitHubReferencePreviewDeps> = {},
): ReturnType<typeof createGitHubReferencePreviewReader> {
  return createGitHubReferencePreviewReader({
    resolveToken: () => Promise.resolve(TOKEN),
    resolveAccountId: () => Promise.resolve('account-1'),
    requestItem: () => Promise.resolve(ISSUE),
    readPullState: () => Promise.reject(new Error('unexpected pull read')),
    requestRepository: () => Promise.resolve(REPOSITORY),
    resolveOriginRepository: () => Promise.resolve('acme/widgets'),
    isCoworkProject: () => false,
    now: () => 1_000,
    ...overrides,
  });
}

function brokerError(
  code: ConstructorParameters<typeof GitHubBrokerError>[0],
  status?: number,
  headers: Record<string, string> = {},
): GitHubBrokerError {
  return new GitHubBrokerError(code, 'GitHub request failed.', {
    ...(status !== undefined ? { status } : {}),
    cause: { status, response: { status, headers } },
  });
}

function deferred(): {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

describe('createGitHubReferencePreviewReader', () => {
  it('reaches the broker fallback while a cold tracked-snapshot read remains held', async () => {
    const fs = jest.requireActual<typeof Fs>('node:fs/promises');
    let release: (value: Buffer<ArrayBuffer>) => void = (): void => undefined;
    const held = new Promise<Buffer<ArrayBuffer>>((resolve) => {
      release = resolve;
    });
    const realReadFile = fs.readFile;
    const probeDir = `${getWorktreeDataDir('round5-probe', 'held')}${sep}`;
    const isProbeRead = (path: unknown): boolean =>
      typeof path === 'string' && path.startsWith(probeDir);
    // Core modules are shared by every suite in the Jest worker, so other
    // suites' in-flight reads pass through and go uncounted.
    const read = jest
      .spyOn(fs, 'readFile')
      .mockImplementation((path, options) =>
        isProbeRead(path) ? held : realReadFile(path, options),
      );
    const probeReads = (): number =>
      read.mock.calls.filter(([path]) => isProbeRead(path)).length;
    resetPrPreviewIndexForTests();
    jest.useFakeTimers();
    const requestItem = jest.fn(() => Promise.resolve(ISSUE));
    const github = reader({
      requestItem,
      readTrackedPull: async (target, scope) => {
        const snapshot = await findTrackedPrSnapshot(target, scope, [
          {
            projectId: 'round5-probe',
            worktreeId: 'held',
            repoStorageKey: 'project-root',
          },
        ]);
        return snapshot
          ? {
              scope,
              capturedAt: Date.parse(snapshot.capturedAt),
              title: snapshot.pr.title,
              body: snapshot.pr.body,
              url: snapshot.pr.htmlUrl,
              state: snapshot.pr.state,
              author: snapshot.pr.author?.login ?? null,
              updatedAt: snapshot.pr.updatedAt,
            }
          : null;
      },
    });
    const pending = github.read(ITEM);
    try {
      await jest.advanceTimersByTimeAsync(1001);
      expect(requestItem).toHaveBeenCalledTimes(1);
      expect(await pending).toMatchObject({
        status: 'ok',
        preview: { title: ISSUE.title },
      });
      expect(probeReads()).toBe(1);
    } finally {
      release(Buffer.from('null'));
      await pending;
      await jest.advanceTimersByTimeAsync(0);
      resetPrPreviewIndexForTests();
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each([
    ['open', 'open', false],
    ['closed', 'closed', false],
    ['merged', 'merged', false],
    ['draft', 'open', true],
  ] as const)(
    'projects tracked %s PR state',
    async (state, expected, draft) => {
      const requestItem = jest.fn();
      const github = reader({
        now: () => 1_000_000,
        requestItem,
        readTrackedPull: (_target, scope) =>
          Promise.resolve({
            scope,
            capturedAt: 999_000,
            title: 'Tracked',
            body: '',
            url: 'https://github.com/acme/widgets/pull/1234',
            state,
            author: null,
            updatedAt: '2026-10-01T12:00:00Z',
          }),
      });
      expect(await github.read(ITEM)).toMatchObject({
        status: 'ok',
        preview: { state: expected, draft },
      });
      expect(requestItem).not.toHaveBeenCalled();
    },
  );

  it('uses a fresh scoped tracked PR without entering the provider read path', async () => {
    const requestItem = jest.fn(() => Promise.resolve(PULL));
    const github = reader({
      now: () => 1_000_000,
      requestItem,
      readTrackedPull: (_target, scope) =>
        Promise.resolve({
          scope,
          capturedAt: 999_000,
          title: 'Tracked **pull**',
          body: '## Body with [link](https://example.com)',
          url: 'https://github.com/acme/widgets/pull/1234',
          state: 'draft',
          author: 'rowan',
          updatedAt: '2026-10-01T12:00:00Z',
        }),
    });
    const result = await github.read(ITEM);
    expect(result).toMatchObject({
      status: 'ok',
      fetchedAt: 999_000,
      preview: {
        itemType: 'pull',
        title: 'Tracked **pull**',
        description: 'Body with link',
        state: 'open',
        draft: true,
        author: 'rowan',
      },
    });
    expect(requestItem).not.toHaveBeenCalled();
  });

  it.each([
    'feat: support `snake_case` keys (#123)',
    '__init__ and Map<K, V>',
    '  spaced   title\nwith *literal* text  ',
  ])(
    'preserves the same bounded literal title from tracked and network facts: %s',
    async (title) => {
      const tracked = reader({
        now: () => 1_000_000,
        readTrackedPull: (_target, scope) =>
          Promise.resolve({
            scope,
            capturedAt: 999_000,
            title,
            body: '',
            url: 'https://github.com/acme/widgets/pull/1234',
            state: 'open',
            author: 'rowan',
            updatedAt: '2026-10-01T12:00:00Z',
          }),
      });
      const network = reader({
        requestItem: () => Promise.resolve({ ...PULL, title }),
      });
      const trackedResult = await tracked.read(ITEM);
      const networkResult = await network.read(ITEM);
      expect(trackedResult.status).toBe('ok');
      expect(networkResult.status).toBe('ok');
      if (
        trackedResult.status !== 'ok' ||
        networkResult.status !== 'ok' ||
        trackedResult.preview.kind !== 'item' ||
        networkResult.preview.kind !== 'item'
      )
        throw new Error('Expected previews');
      expect(trackedResult.preview.title).toBe(networkResult.preview.title);
      expect(trackedResult.preview.title).toBe(
        title.replace(/\s+/g, ' ').trim(),
      );
    },
  );

  it('does not use stale tracked facts as a fresh preview', async () => {
    const requestItem = jest.fn(() => Promise.resolve(PULL));
    const github = reader({
      now: () => 1_000_000,
      requestItem,
      readTrackedPull: (_target, scope) =>
        Promise.resolve({
          scope,
          capturedAt: 600_000,
          title: 'Old title',
          body: '',
          url: 'https://github.com/acme/widgets/pull/1234',
          state: 'open',
          author: 'rowan',
          updatedAt: '2026-10-01T12:00:00Z',
        }),
    });
    expect((await github.read(ITEM)).status).toBe('ok');
    expect(requestItem).toHaveBeenCalledTimes(1);
  });

  it('reads an issue with the same pinned credential that scopes it', async () => {
    const requestItem = jest.fn(() => Promise.resolve(ISSUE));
    const resolveToken = jest.fn(() => Promise.resolve(TOKEN));
    const github = reader({ requestItem, resolveToken });
    const result = await github.read(ITEM);
    expect(resolveToken).toHaveBeenCalledTimes(2);
    expect(requestItem).toHaveBeenCalledWith(TOKEN, {
      owner: 'acme',
      repository: 'widgets',
      number: 1234,
    });
    expect(result).toEqual({
      status: 'ok',
      scope: (await github.readScope()).scope,
      preview: {
        kind: 'item',
        owner: 'acme',
        repository: 'widgets',
        number: 1234,
        itemType: 'issue',
        title: 'Hydrate references in transcripts',
        url: ISSUE.html_url,
        description: 'Goal Show compact cards. See docs.',
        state: 'open',
        draft: false,
        author: 'rowan',
        authorAvatarUrl: null,
        updatedAt: ISSUE.updated_at,
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('scopes by Canopy account and credential without calling GitHub', async () => {
    const requestItem = jest.fn();
    const requestRepository = jest.fn();
    const first = await reader({ requestItem, requestRepository }).readScope();
    expect(first.scope).toEqual(ANY_STRING);
    expect(first.scope).toHaveLength(24);
    expect(JSON.stringify(first)).not.toContain(TOKEN);
    expect((await reader().readScope()).scope).toBe(first.scope);
    expect(
      (
        await reader({
          resolveAccountId: () => Promise.resolve('account-2'),
        }).readScope()
      ).scope,
    ).not.toBe(first.scope);
    expect(
      (
        await reader({
          resolveToken: () => Promise.resolve('other'),
        }).readScope()
      ).scope,
    ).not.toBe(first.scope);
    expect(requestItem).not.toHaveBeenCalled();
    expect(requestRepository).not.toHaveBeenCalled();
  });

  it('reports a missing connection without a request', async () => {
    const requestItem = jest.fn();
    const missing = reader({
      resolveToken: () => Promise.resolve(' '),
      requestItem,
    });
    expect(await missing.readScope()).toEqual({ scope: null });
    expect(await missing.read(ITEM)).toEqual({ status: 'disconnected' });
    expect(
      await reader({
        resolveToken: () => Promise.reject(new Error('keychain locked')),
        requestItem,
      }).read(ITEM),
    ).toEqual({ status: 'disconnected' });
    expect(requestItem).not.toHaveBeenCalled();
  });

  it('keeps identical numbers in different repositories apart', async () => {
    const requestItem = jest.fn(
      (_token: string, target: { owner: string; repository: string }) =>
        Promise.resolve({
          ...ISSUE,
          title: `Item in ${target.owner}/${target.repository}`,
          html_url: `https://github.com/${target.owner}/${target.repository}/issues/1234`,
        }),
    );
    const github = reader({ requestItem });
    const [first, second] = await Promise.all([
      github.read(ITEM),
      github.read({ ...ITEM, repository: 'gadgets' }),
    ]);
    expect(requestItem).toHaveBeenCalledTimes(2);
    expect(first.status === 'ok' && first.preview.repository).toBe('widgets');
    expect(second.status === 'ok' && second.preview.repository).toBe('gadgets');
    expect(first.status === 'ok' && first.preview.kind === 'item').toBe(true);
    expect(
      first.status === 'ok' &&
        first.preview.kind === 'item' &&
        first.preview.title,
    ).toBe('Item in acme/widgets');
    expect(
      second.status === 'ok' &&
        second.preview.kind === 'item' &&
        second.preview.title,
    ).toBe('Item in acme/gadgets');
  });

  it('coalesces identical concurrent reads into one request', async () => {
    const pending = deferred();
    const requestItem = jest.fn(() => pending.promise);
    const github = reader({ requestItem });
    const first = github.read(ITEM);
    const second = github.read({ ...ITEM });
    await flush();
    pending.resolve(ISSUE);
    expect((await first).status).toBe('ok');
    expect(await second).toEqual(await first);
    expect(requestItem).toHaveBeenCalledTimes(1);
    // Settled reads are not cached here; a later read asks again.
    await github.read(ITEM);
    expect(requestItem).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...PULL }, 'open', false],
    [{ ...PULL, draft: true }, 'open', true],
    [{ ...PULL, state: 'closed' }, 'closed', false],
    [
      {
        ...PULL,
        state: 'closed',
        pull_request: {
          ...PULL.pull_request,
          merged_at: '2026-10-02T00:00:00Z',
        },
      },
      'merged',
      false,
    ],
  ])('classifies pull request %#', async (data, state, draft) => {
    const readPullState = jest.fn();
    const result = await reader({
      requestItem: () => Promise.resolve(data),
      readPullState,
    }).read(ITEM);
    expect(result).toMatchObject({
      status: 'ok',
      preview: { kind: 'item', itemType: 'pull', state, draft },
    });
    expect(readPullState).not.toHaveBeenCalled();
  });

  it('classifies a closed issue and never marks an issue as a draft', async () => {
    expect(
      await reader({
        requestItem: () =>
          Promise.resolve({ ...ISSUE, state: 'closed', draft: true }),
      }).read(ITEM),
    ).toMatchObject({
      status: 'ok',
      preview: { itemType: 'issue', state: 'closed', draft: false },
    });
  });

  it('reads the pull request state once only when its draft or merge state is missing', async () => {
    const readPullState = jest.fn(() =>
      Promise.resolve({ draft: true, merged: false }),
    );
    const result = await reader({
      requestItem: () =>
        Promise.resolve({ ...PULL, draft: undefined, pull_request: {} }),
      readPullState,
    }).read(ITEM);
    expect(readPullState).toHaveBeenCalledTimes(1);
    expect(readPullState).toHaveBeenCalledWith({
      owner: 'acme',
      repository: 'widgets',
      number: 1234,
    });
    expect(result).toMatchObject({
      status: 'ok',
      preview: { itemType: 'pull', state: 'open', draft: true },
    });
    expect(
      (
        await reader({
          requestItem: () =>
            Promise.resolve({ ...PULL, draft: undefined, pull_request: {} }),
          readPullState: () => Promise.resolve(null),
        }).read(ITEM)
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await reader({
          requestItem: () =>
            Promise.resolve({ ...PULL, draft: undefined, pull_request: {} }),
          readPullState: () => Promise.reject(brokerError('not_found', 404)),
        }).read(ITEM)
      ).status,
    ).toBe('unavailable');
  });

  const PULL_FACTS = {
    additions: 2674,
    deletions: 963,
    changedFiles: 42,
    mergeable: 'conflicting',
    checks: 'failing',
    reviewDecision: null,
    inMergeQueue: false,
  } as const;
  const AVATAR = 'https://avatars.githubusercontent.com/u/42?v=4';

  it('adds the pull request size, readiness and author avatar', async () => {
    const readPullFacts = jest.fn(() => Promise.resolve(PULL_FACTS));
    const result = await reader({
      requestItem: () =>
        Promise.resolve({
          ...PULL,
          user: { login: 'rowan', avatar_url: AVATAR },
        }),
      readPullFacts,
    }).read(ITEM);
    expect(readPullFacts).toHaveBeenCalledWith(
      TOKEN,
      { owner: 'acme', repository: 'widgets', number: 1234 },
      { signal: ANY_SIGNAL },
    );
    expect(result).toMatchObject({
      status: 'ok',
      preview: { itemType: 'pull', authorAvatarUrl: AVATAR, pull: PULL_FACTS },
    });
  });

  it('adds the pull request facts to a fresh tracked PR', async () => {
    const result = await reader({
      now: () => 1_000_000,
      readTrackedPull: (_target, scope) =>
        Promise.resolve({
          scope,
          capturedAt: 999_000,
          title: 'Tracked pull',
          body: '',
          url: 'https://github.com/acme/widgets/pull/1234',
          state: 'open',
          author: 'rowan',
          updatedAt: '2026-10-01T12:00:00Z',
        }),
      readPullFacts: () => Promise.resolve(PULL_FACTS),
    }).read(ITEM);
    expect(result).toMatchObject({
      status: 'ok',
      preview: { title: 'Tracked pull', pull: PULL_FACTS },
    });
  });

  it('keeps the preview without facts when they cannot be read or are malformed', async () => {
    const reads: (() => Promise<unknown>)[] = [
      (): Promise<unknown> => Promise.reject(brokerError('rate_limited', 429)),
      (): Promise<unknown> => Promise.resolve(null),
      (): Promise<unknown> => Promise.resolve({ ...PULL_FACTS, additions: -1 }),
    ];
    for (const readPullFacts of reads) {
      const result = await reader({
        requestItem: () => Promise.resolve(PULL),
        readPullFacts,
      }).read(ITEM);
      expect(result).toMatchObject({
        status: 'ok',
        preview: { itemType: 'pull' },
      });
      if (result.status !== 'ok' || result.preview.kind !== 'item')
        throw new Error('Expected an item preview');
      expect(result.preview.pull).toBeUndefined();
    }
  });

  it('returns the preview without facts when their reads are held, and cancels them', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const readPullFacts = jest.fn(
        (
          _token: string,
          _item: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          signal = options?.signal;
          return new Promise<unknown>(() => undefined);
        },
      );
      const pending = reader({
        now: () => 1_000_000,
        readTrackedPull: (_target, scope) =>
          Promise.resolve({
            scope,
            capturedAt: 999_000,
            title: 'Tracked pull',
            body: '',
            url: 'https://github.com/acme/widgets/pull/1234',
            state: 'open',
            author: 'rowan',
            updatedAt: '2026-10-01T12:00:00Z',
          }),
        readPullFacts,
      }).read(ITEM);
      await jest.advanceTimersByTimeAsync(PULL_FACTS_TIMEOUT_MS);
      const result = await pending;
      expect(result).toMatchObject({
        status: 'ok',
        preview: { title: 'Tracked pull' },
      });
      if (result.status !== 'ok' || result.preview.kind !== 'item')
        throw new Error('Expected an item preview');
      expect(result.preview.pull).toBeUndefined();
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the facts reads once the preview is settled, even after an early failure', async () => {
    let signal: AbortSignal | undefined;
    const result = await reader({
      requestItem: () => Promise.resolve(PULL),
      readPullFacts: (
        _token: string,
        _item: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<unknown> => {
        signal = options?.signal;
        return Promise.reject(brokerError('rate_limited', 429));
      },
    }).read(ITEM);
    expect(result).toMatchObject({
      status: 'ok',
      preview: { itemType: 'pull' },
    });
    expect(signal?.aborted).toBe(true);
  });

  it('never reads pull request facts for an issue, and drops a non-GitHub avatar', async () => {
    const readPullFacts = jest.fn(() => Promise.resolve(PULL_FACTS));
    const result = await reader({
      requestItem: () =>
        Promise.resolve({
          ...ISSUE,
          user: { login: 'rowan', avatar_url: 'https://evil.example/a.png' },
        }),
      readPullFacts,
    }).read(ITEM);
    expect(readPullFacts).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      preview: { itemType: 'issue', authorAvatarUrl: null },
    });
    if (result.status !== 'ok' || result.preview.kind !== 'item')
      throw new Error('Expected an item preview');
    expect(result.preview.pull).toBeUndefined();
  });

  it('reads a repository preview', async () => {
    const requestRepository = jest.fn(() => Promise.resolve(REPOSITORY));
    const result = await reader({ requestRepository }).read(REPO);
    expect(requestRepository).toHaveBeenCalledWith(TOKEN, {
      owner: 'acme',
      repository: 'widgets',
    });
    expect(result).toEqual({
      status: 'ok',
      scope: ANY_STRING,
      preview: {
        kind: 'repository',
        owner: 'acme',
        repository: 'widgets',
        fullName: 'Acme/Widgets',
        url: REPOSITORY.html_url,
        description: 'Widgets for everyone',
        private: true,
        archived: false,
        updatedAt: REPOSITORY.updated_at,
      },
    });
  });

  it.each([
    [
      brokerError('not_found', 404),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      brokerError('permission_denied', 403),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      brokerError('rate_limited', 429, { 'retry-after': '30' }),
      { status: 'rate-limited', retryAfterMs: 30_000 },
    ],
    [
      brokerError('rate_limited', 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '61',
      }),
      { status: 'rate-limited', retryAfterMs: 60_000 },
    ],
    [
      brokerError('rate_limited', 403),
      { status: 'rate-limited', retryAfterMs: null },
    ],
    [
      // Held back by the broker before reaching GitHub: no response headers.
      new GitHubBrokerError('rate_limited', 'Reserved.', {
        retriable: true,
        retryAt: 46_000,
      }),
      { status: 'rate-limited', retryAfterMs: 45_000 },
    ],
    [brokerError('network'), { status: 'failed' }],
    [brokerError('timeout'), { status: 'failed' }],
    [brokerError('server_error', 502), { status: 'failed' }],
    [brokerError('invalid_response', 200), { status: 'failed' }],
    [brokerError('credential_reset'), { status: 'failed' }],
    [brokerError('cancelled'), { status: 'failed' }],
    [new Error('socket hang up'), { status: 'failed' }],
    [
      Object.assign(new Error('Gone'), { status: 410 }),
      { status: 'unavailable', scope: ANY_STRING },
    ],
  ])('maps GitHub failure %#', async (error, expected) => {
    expect(
      await reader({ requestItem: () => Promise.reject(error) }).read(ITEM),
    ).toEqual(expected);
    expect(
      await reader({
        requestRepository: () => Promise.reject(error),
      }).read(REPO),
    ).toEqual(expected);
  });

  it('maps a non-Error rejection to failed', async () => {
    expect(
      await reader({
        requestItem: jest.fn().mockRejectedValue('not an error'),
      }).read(ITEM),
    ).toEqual({ status: 'failed' });
  });

  it('stops calling GitHub with a rejected credential until it changes or the window passes', async () => {
    let now = 1_000;
    let token = TOKEN;
    const requestItem = jest.fn(
      (): Promise<unknown> =>
        Promise.reject(brokerError('not_authenticated', 401)),
    );
    const requestRepository = jest.fn(() => Promise.resolve(REPOSITORY));
    const github = reader({
      requestItem,
      requestRepository,
      resolveToken: () => Promise.resolve(token),
      now: () => now,
    });
    expect(await github.read(ITEM)).toEqual({ status: 'disconnected' });
    // Every window learns when the host will try the credential again.
    expect(await github.readScope()).toEqual({
      scope: null,
      retryAfterMs: 5 * 60 * 1000,
    });
    expect(await github.read(REPO)).toEqual({ status: 'disconnected' });
    expect(await github.read({ ...ITEM, number: 7 })).toEqual({
      status: 'disconnected',
    });
    expect(requestItem).toHaveBeenCalledTimes(1);
    expect(requestRepository).not.toHaveBeenCalled();

    token = 'ghp_rotated';
    expect((await github.read(REPO)).status).toBe('ok');
    token = TOKEN;
    now += 5 * 60 * 1000 - 1;
    expect(await github.readScope()).toEqual({ scope: null, retryAfterMs: 1 });
    now += 1;
    expect((await github.readScope()).scope).toEqual(ANY_STRING);
    expect((await github.read(REPO)).status).toBe('ok');
  });

  it.each([
    [
      'a non-GitHub URL',
      { html_url: 'https://evil.example/acme/widgets/issues/1234' },
    ],
    ['an http URL', { html_url: 'http://github.com/acme/widgets/issues/1234' }],
    [
      'a look-alike host',
      { html_url: 'https://github.com.evil.example/acme/widgets/issues/1' },
    ],
    [
      'credentials in the URL',
      { html_url: 'https://user@github.com/acme/widgets/issues/1' },
    ],
    [
      'an oversized URL',
      {
        html_url: `https://github.com/acme/widgets/issues/1?${'a'.repeat(2_048)}`,
      },
    ],
    ['a missing title', { title: undefined }],
    ['a blank title', { title: '   ' }],
    ['an unknown state', { state: 'locked' }],
    ['a missing update time', { updated_at: undefined }],
  ])('treats an item with %s as unavailable', async (_label, patch) => {
    expect(
      await reader({
        requestItem: () => Promise.resolve({ ...ISSUE, ...patch }),
      }).read(ITEM),
    ).toEqual({ status: 'unavailable', scope: ANY_STRING });
  });

  it('treats a malformed repository or payload as unavailable', async () => {
    for (const data of [
      null,
      'nope',
      { ...REPOSITORY, html_url: 'https://gitlab.com/acme/widgets' },
      { ...REPOSITORY, full_name: undefined },
      { ...REPOSITORY, private: 'yes' },
      { ...REPOSITORY, updated_at: 'not a date' },
    ]) {
      expect(
        await reader({
          requestRepository: () => Promise.resolve(data),
        }).read(REPO),
      ).toEqual({ status: 'unavailable', scope: ANY_STRING });
    }
    expect(
      (await reader({ requestItem: () => Promise.resolve(null) }).read(ITEM))
        .status,
    ).toBe('unavailable');
    expect(
      (
        await reader({
          requestItem: () =>
            Promise.resolve({ ...ISSUE, updated_at: 'yesterday-ish' }),
        }).read(ITEM)
      ).status,
    ).toBe('unavailable');
  });

  it('bounds the title, description, and author', async () => {
    const result = await reader({
      requestItem: () =>
        Promise.resolve({
          ...ISSUE,
          title: '😀'.repeat(600),
          body: 'word '.repeat(2_000),
          user: { login: 'x'.repeat(500) },
        }),
    }).read(ITEM);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.preview.kind !== 'item') {
      throw new Error('expected an item preview');
    }
    expect(Array.from(result.preview.title)).toHaveLength(512);
    expect(result.preview.title.endsWith('😀…')).toBe(true);
    expect(
      Array.from(result.preview.description ?? '').length,
    ).toBeLessThanOrEqual(280);
    expect(result.preview.description?.endsWith('…')).toBe(true);
    expect((result.preview.author ?? '').length).toBeLessThanOrEqual(200);
  });

  it('fences a pending read to the credential it started with', async () => {
    const pendingA = deferred();
    let token = 'ghp_credential_a';
    const requestItem = jest.fn((requestToken: string) =>
      requestToken === 'ghp_credential_a'
        ? pendingA.promise
        : Promise.resolve({ ...ISSUE, title: 'Read with B' }),
    );
    const github = reader({
      requestItem,
      resolveToken: () => Promise.resolve(token),
    });
    const scopeA = (await github.readScope()).scope;
    const readA = github.read(ITEM);
    await flush();

    token = 'ghp_credential_b';
    const scopeB = (await github.readScope()).scope;
    expect(scopeB).not.toBe(scopeA);
    const readB = await github.read(ITEM);
    expect(requestItem).toHaveBeenCalledTimes(2);
    expect(
      requestItem.mock.calls.map(([requestToken]) => requestToken),
    ).toEqual(['ghp_credential_a', 'ghp_credential_b']);
    expect(readB).toMatchObject({
      status: 'ok',
      scope: scopeB,
      preview: { title: 'Read with B' },
    });

    // A second B read while A is still pending must not join A's request.
    const readB2 = github.read(ITEM);
    await flush();
    expect(requestItem).toHaveBeenCalledTimes(3);

    pendingA.resolve({ ...ISSUE, title: 'Read with A' });
    expect(await readA).toEqual({ status: 'disconnected' });
    expect(await readB2).toMatchObject({
      scope: scopeB,
      preview: { title: 'Read with B' },
    });
  });

  it('treats an unreadable Canopy account as unknown: no scope and no provider read', async () => {
    const requestItem = jest.fn();
    const requestRepository = jest.fn();
    const readTrackedPull = jest.fn();
    const github = reader({
      resolveAccountId: () => Promise.reject(new Error('keychain locked')),
      requestItem,
      requestRepository,
      readTrackedPull,
    });
    // A rejected scope read keeps the renderer's saved previews; a null
    // scope or a disconnected read would disown them.
    await expect(github.readScope()).rejects.toThrow();
    expect(await github.read(ITEM)).toEqual({ status: 'failed' });
    expect(await github.read(REPO)).toEqual({ status: 'failed' });
    expect(requestItem).not.toHaveBeenCalled();
    expect(requestRepository).not.toHaveBeenCalled();
    expect(readTrackedPull).not.toHaveBeenCalled();
  });

  it('settles a pending read as failed when the account turns unreadable, then recovers the same scope', async () => {
    const pending = deferred();
    let accountId = (): Promise<string> => Promise.resolve('account-1');
    const github = reader({
      resolveAccountId: () => accountId(),
      requestItem: () => pending.promise,
    });
    const scope = (await github.readScope()).scope;
    const read = github.read(ITEM);
    await flush();

    accountId = (): Promise<string> =>
      Promise.reject(new Error('decrypt failed'));
    pending.resolve(ISSUE);
    expect(await read).toEqual({ status: 'failed' });

    accountId = (): Promise<string> => Promise.resolve('account-1');
    expect((await github.readScope()).scope).toBe(scope);
    expect(await github.read(ITEM)).toMatchObject({ status: 'ok', scope });
  });

  it('still disconnects a pending read when the account is confirmed signed out', async () => {
    const pending = deferred();
    let accountId = 'account-1';
    const github = reader({
      resolveAccountId: () => Promise.resolve(accountId),
      requestItem: () => pending.promise,
    });
    const read = github.read(ITEM);
    await flush();
    // The signed-out identity is authoritative, unlike an unreadable account.
    accountId = '';
    pending.resolve(ISSUE);
    expect(await read).toEqual({ status: 'disconnected' });
  });
});

describe('readOrigin', () => {
  it('never resolves a repository for a cowork chat or project', async () => {
    const resolveOriginRepository = jest.fn(() =>
      Promise.resolve('acme/widgets'),
    );
    expect(
      await reader({ resolveOriginRepository }).readOrigin({
        kind: 'cowork',
      }),
    ).toEqual({ repository: null });
    expect(
      await reader({
        resolveOriginRepository,
        isCoworkProject: (projectId) => projectId === 'cowork-project',
      }).readOrigin({
        kind: 'worktree',
        projectId: 'cowork-project',
        worktreeId: 'w1',
      }),
    ).toEqual({ repository: null });
    expect(resolveOriginRepository).not.toHaveBeenCalled();
  });

  it.each([
    ['..', 'w1'],
    ['p1', '../other'],
    ['p1', 'w1/../../x'],
    ['p1', '/abs'],
    ['P1', 'w1'],
    ['p1', 'w 1'],
  ])(
    'never resolves a path for unsafe ids %s / %s',
    async (projectId, worktreeId) => {
      const resolveOriginRepository = jest.fn(() =>
        Promise.resolve('acme/widgets'),
      );
      expect(
        await reader({ resolveOriginRepository }).readOrigin({
          kind: 'worktree',
          projectId,
          worktreeId,
        }),
      ).toEqual({ repository: null });
      expect(resolveOriginRepository).not.toHaveBeenCalled();
    },
  );

  it('resolves the strict single-repository origin', async () => {
    const resolveOriginRepository = jest.fn(() =>
      Promise.resolve('acme/widgets'),
    );
    expect(
      await reader({ resolveOriginRepository }).readOrigin({
        kind: 'worktree',
        projectId: 'p1',
        worktreeId: 'w1',
      }),
    ).toEqual({ repository: { owner: 'acme', repository: 'widgets' } });
    expect(resolveOriginRepository).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'w1',
    });
  });

  it.each([[null], ['not a repo'], ['Acme/Widgets'], ['acme/widgets/extra']])(
    'resolves no repository for %j',
    async (repository) => {
      expect(
        await reader({
          resolveOriginRepository: () => Promise.resolve(repository),
        }).readOrigin({ kind: 'worktree', projectId: 'p1', worktreeId: 'w1' }),
      ).toEqual({ repository: null });
    },
  );

  it('rejects an operational git failure instead of confirming a missing origin', async () => {
    await expect(
      reader({
        resolveOriginRepository: () => Promise.reject(new Error('git')),
      }).readOrigin({ kind: 'worktree', projectId: 'p1', worktreeId: 'w1' }),
    ).rejects.toThrow('git');
  });

  it('rejects a registry failure instead of confirming a missing origin', async () => {
    await expect(
      reader({
        isCoworkProject: () => {
          throw new Error('registry');
        },
      }).readOrigin({ kind: 'worktree', projectId: 'p1', worktreeId: 'w1' }),
    ).rejects.toThrow('registry');
  });
});
