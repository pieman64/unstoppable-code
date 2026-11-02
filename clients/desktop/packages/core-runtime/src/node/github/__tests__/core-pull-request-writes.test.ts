/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import {
  CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CorePullRequestCreateParams,
  type CorePullRequestUpdateParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createCorePullRequestInstructionHandlers,
  createPullRequestReceipts,
  GitHubRequestError,
  isExpectedHead,
  mintPullRequestId,
  mintRepositoryId,
  parsePullRequestId,
  type CorePullRequestHandlerOptions,
  type CorePullRequestHost,
  type GitHubPullRequestRecord,
  type GitHubRepositoryRef,
  type GitHubRequestHandle,
  type PullRequestWriteReceipt,
} from '..';

const WRITER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.pullRequest.write'],
};

const RECORD = { workspaceId: 'acme', repoId: 'api' };
const ORIGIN = { owner: 'Acme', repo: 'API' };
const HEAD = 'a'.repeat(40);
const UPDATED_AT = '2026-10-31T12:00:00Z';

function record(
  number: number,
  overrides: Partial<GitHubPullRequestRecord> = {},
): GitHubPullRequestRecord {
  return {
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://github.com/Acme/API/pull/${number}`,
    state: 'open',
    draft: false,
    baseBranch: 'main',
    baseSha: null,
    headBranch: 'feature',
    headSha: HEAD,
    mergeable: 'unknown',
    reviewDecision: 'none',
    checks: [],
    reviewThreadCount: 0,
    unresolvedReviewThreadCount: 0,
    commentCount: 0,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function setup(
  overrides: Partial<GitHubRequestHandle> = {},
  handlerOptions: CorePullRequestHandlerOptions = {},
) {
  const github = {
    describe: jest.fn(unused),
    getPullRequest: jest.fn((ref: { number: number }) =>
      Promise.resolve(record(ref.number)),
    ),
    listPullRequests: jest.fn(unused),
    listRepositories: jest.fn(unused),
    getBranchHead: jest.fn(() => Promise.resolve({ sha: HEAD })),
    createPullRequest: jest.fn(() =>
      Promise.resolve({ number: 7, url: 'https://github.com/Acme/API/pull/7' }),
    ),
    findOpenPullRequest: jest.fn(() => Promise.resolve(null)),
    updatePullRequest: jest.fn((ref: { number: number }) =>
      Promise.resolve({
        number: ref.number,
        url: `https://github.com/Acme/API/pull/${ref.number}`,
      }),
    ),
    ...overrides,
  } as jest.Mocked<GitHubRequestHandle>;
  const resolveRepository = jest.fn(
    (): Promise<GitHubRepositoryRef | null> => Promise.resolve(ORIGIN),
  );
  const host: CorePullRequestHost = { github, resolveRepository };
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: {},
      instructions: CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createCorePullRequestInstructionHandlers(
        host,
        handlerOptions,
      ),
      streams: {},
    },
  });
  return { github, resolveRepository, dispatcher };
}

function repositoryId(): string {
  const id = mintRepositoryId(RECORD);
  if (id === null) throw new Error('unminted');
  return id;
}

function pullRequestId(number = 7, github = ORIGIN): string {
  const id = mintPullRequestId({ repository: RECORD, github, number });
  if (id === null) throw new Error('unminted');
  return id;
}

function createParams(
  overrides: Partial<CorePullRequestCreateParams> = {},
): CorePullRequestCreateParams {
  return {
    integrationId: 'github',
    repositoryId: repositoryId(),
    title: 'Add the thing',
    body: 'Body',
    baseBranch: 'main',
    headBranch: 'feature',
    expectedHeadSha: HEAD,
    draft: false,
    ...overrides,
  };
}

function updateParams(
  patch: Partial<CorePullRequestUpdateParams['patch']> = {},
  overrides: Partial<CorePullRequestUpdateParams> = {},
): CorePullRequestUpdateParams {
  return {
    pullRequestId: pullRequestId(),
    expectedRevision: Date.parse(UPDATED_AT),
    patch: {
      title: null,
      body: null,
      baseBranch: 'release',
      draft: null,
      ...patch,
    },
    ...overrides,
  };
}

function options(
  idempotencyKey = 'key-1',
  extra: { caller?: CanopyCallerDescriptor; signal?: AbortSignal } = {},
) {
  return { caller: WRITER, metadata: { idempotencyKey }, ...extra };
}

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('resolved');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('isExpectedHead', () => {
  it.each([
    [HEAD, HEAD, true],
    [HEAD, 'A'.repeat(40), true],
    [HEAD, 'AAAAAAA', true],
    [HEAD, 'b'.repeat(7), false],
    [HEAD, 'a'.repeat(39), true],
    ['a'.repeat(64), 'a'.repeat(40), false],
    ['a'.repeat(64), 'a'.repeat(64), true],
  ])('%s against %s is %s', (actual, expected, result) => {
    expect(isExpectedHead(actual, expected)).toBe(result);
  });
});

describe('core.pullRequest.create', () => {
  it('reads the head, creates without a signal and returns the projection read after it', async () => {
    const f = setup();

    const result = await f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );

    expect(result).toMatchObject({
      pullRequestId: pullRequestId(7),
      integrationId: 'github',
      repositoryId: repositoryId(),
      number: 7,
      revision: Date.parse(UPDATED_AT),
    });
    expect(f.resolveRepository).toHaveBeenCalledWith(RECORD, 'write');
    expect(f.github.getBranchHead).toHaveBeenCalledWith(ORIGIN, 'feature', {
      signal: expect.any(AbortSignal),
    });
    expect(f.github.createPullRequest.mock.calls).toEqual([
      [
        ORIGIN,
        {
          headBranch: 'feature',
          baseBranch: 'main',
          title: 'Add the thing',
          body: 'Body',
          draft: false,
        },
      ],
    ]);
    expect(f.github.getPullRequest).toHaveBeenCalledWith(
      { ...ORIGIN, number: 7 },
      { refresh: true, signal: expect.any(AbortSignal) },
    );
  });

  it.each<[string, Partial<CorePullRequestCreateParams>, string, string]>([
    [
      'another integration',
      { integrationId: 'gitlab' },
      'capability_unavailable',
      'core.pullRequest.integrationUnavailable',
    ],
    [
      'an id the host did not mint',
      { repositoryId: 'ghrepo1.e30' },
      'invalid_argument',
      'core.pullRequest.invalidId',
    ],
    [
      'a blank head branch',
      { headBranch: '  ' },
      'invalid_argument',
      'core.pullRequest.create.invalidBranch',
    ],
    [
      'an empty base branch',
      { baseBranch: '' },
      'invalid_argument',
      'core.pullRequest.create.invalidBranch',
    ],
  ])('refuses %s before GitHub', async (_label, change, kind, code) => {
    const f = setup();
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(change),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({ kind, code });
    expect(f.resolveRepository).not.toHaveBeenCalled();
    expect(f.github.createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a repository the host does not grant write access to', async () => {
    const f = setup();
    f.resolveRepository.mockResolvedValue(null);

    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.pullRequest.repositoryUnavailable',
    });
    expect(f.github.getBranchHead).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<GitHubRequestHandle>, string, string]>([
    [
      'a head GitHub does not have',
      { getBranchHead: () => Promise.resolve(null) },
      'failed_precondition',
      'core.pullRequest.create.headMissing',
    ],
    [
      'a head at another commit',
      { getBranchHead: () => Promise.resolve({ sha: 'b'.repeat(40) }) },
      'conflict',
      'core.pullRequest.create.headMismatch',
    ],
  ])('refuses %s without creating', async (_label, handle, kind, code) => {
    const f = setup(handle);
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({ kind, code });
    expect(f.github.createPullRequest).not.toHaveBeenCalled();
  });

  it("adopts GitHub's open pull request for the head branch", async () => {
    const cause = new Error('A pull request already exists');
    const f = setup({
      createPullRequest: () =>
        Promise.reject(
          new GitHubRequestError('duplicate', 'exists', { cause }),
        ),
      findOpenPullRequest: jest.fn(() =>
        Promise.resolve({
          number: 12,
          url: 'https://github.com/Acme/API/pull/12',
        }),
      ),
    });

    await expect(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    ).resolves.toMatchObject({ number: 12, pullRequestId: pullRequestId(12) });
    expect(f.github.findOpenPullRequest).toHaveBeenCalledWith(
      ORIGIN,
      'feature',
      {},
    );
  });

  it('reports a duplicate it cannot adopt, keeping the host error', async () => {
    const cause = new Error('A pull request already exists');
    const f = setup({
      createPullRequest: () =>
        Promise.reject(
          new GitHubRequestError('duplicate', 'exists', { cause }),
        ),
    });
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    expect(error.payload.kind).toBe('already_exists');
    expect(error.runtimeCause).toBe(cause);
  });

  it.each<[string, GitHubRequestError, Record<string, unknown>]>([
    [
      'a refused base',
      new GitHubRequestError('base_rejected', 'base', { cause: 'host' }),
      {
        kind: 'failed_precondition',
        code: 'core.pullRequest.create.baseRejected',
      },
    ],
    [
      'no credential',
      new GitHubRequestError('not_authenticated', 'none', { cause: 'host' }),
      {
        kind: 'failed_precondition',
        code: 'core.pullRequest.notAuthenticated',
      },
    ],
    [
      'a rate limit',
      new GitHubRequestError('rate_limited', 'slow', {
        cause: 'host',
        retryAfterMs: 1500,
      }),
      {
        kind: 'resource_exhausted',
        retry: { kind: 'same_idempotency_key', delayMs: 1500 },
      },
    ],
    [
      'a timeout',
      new GitHubRequestError('timeout', 'slow', { cause: 'host' }),
      {
        kind: 'deadline_exceeded',
        retry: { kind: 'same_idempotency_key' },
      },
    ],
  ])('maps %s, keeping the host error', async (_label, rejection, payload) => {
    const f = setup({ createPullRequest: () => Promise.reject(rejection) });
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    expect(error.payload).toMatchObject(payload);
    expect(error.runtimeCause).toBe('host');
  });

  it('reports a failed read after the create, and a same-key retry reads again without creating', async () => {
    const readFailure = new Error('socket hang up');
    const f = setup();
    f.github.getPullRequest.mockRejectedValueOnce(readFailure);

    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'unavailable',
      code: 'core.pullRequest.projectionUnavailable',
      retry: { kind: 'same_idempotency_key' },
    });
    expect(error.runtimeCause).toBe(readFailure);

    await expect(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    ).resolves.toMatchObject({ number: 7 });
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
    expect(f.github.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('refuses the key with other params, and keys receipts by principal', async () => {
    const f = setup();
    await f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );

    const reused = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams({ title: 'Another title' }),
        options(),
      ),
    );
    expect(reused.payload).toMatchObject({
      kind: 'conflict',
      code: 'core.pullRequest.idempotencyKeyReused',
    });
    await f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options('key-1', {
        caller: { ...WRITER, principalId: 'remote-device:controller-1' },
      }),
    );
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(2);
  });

  it.each<[string, GitHubRepositoryRef | null]>([
    ['its origin names another repository', { owner: 'acme', repo: 'web' }],
    ['the repository is gone or read-only', null],
  ])(
    'refuses a same-key retry once %s, reading nothing',
    async (_label, now) => {
      const f = setup();
      await f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      );
      f.resolveRepository.mockResolvedValue(now);

      const error = await failure(
        f.dispatcher.instruction(
          'core.pullRequest.create',
          createParams(),
          options(),
        ),
      );
      expect(error.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.pullRequest.repositoryUnavailable',
      });
      expect(f.resolveRepository).toHaveBeenLastCalledWith(RECORD, 'write');
      expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
      expect(f.github.getPullRequest).toHaveBeenCalledTimes(1);
    },
  );

  it('answers a same-key retry once the origin names the repository again', async () => {
    const f = setup();
    await f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    f.resolveRepository.mockResolvedValueOnce({ owner: 'acme', repo: 'web' });
    await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );

    await expect(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    ).resolves.toMatchObject({ number: 7 });
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses a call that joined an in-flight create once the origin moved', async () => {
    const created = deferred<{ number: number; url: string }>();
    const receipts = createPullRequestReceipts<PullRequestWriteReceipt>();
    const run = jest.spyOn(receipts, 'run');
    const f = setup(
      { createPullRequest: jest.fn(() => created.promise) },
      { receipts },
    );

    const first = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    while (f.github.createPullRequest.mock.calls.length === 0)
      await new Promise((settle) => setImmediate(settle));
    const joined = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    // The second call reaches the receipt while the create is still pending.
    while (run.mock.calls.length < 2)
      await new Promise((settle) => setImmediate(settle));
    f.resolveRepository.mockResolvedValue({ owner: 'acme', repo: 'web' });
    created.resolve({ number: 7, url: 'https://github.com/Acme/API/pull/7' });

    // The writer already resolved the repository before it created.
    await expect(first).resolves.toMatchObject({ number: 7 });
    expect((await failure(joined)).payload.code).toBe(
      'core.pullRequest.repositoryUnavailable',
    );
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('sends one create for concurrent calls with one key', async () => {
    const created = deferred<{ number: number; url: string }>();
    const f = setup({ createPullRequest: jest.fn(() => created.promise) });

    const first = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    const second = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    created.resolve({ number: 7, url: 'https://github.com/Acme/API/pull/7' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ number: 7 }),
      expect.objectContaining({ number: 7 }),
    ]);
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('retries a create that failed before landing under the same key', async () => {
    const f = setup();
    f.github.createPullRequest.mockRejectedValueOnce(
      new GitHubRequestError('unavailable', 'down'),
    );

    await failure(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    );
    await f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options(),
    );
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(2);
  });

  it('requires the write grant and an idempotency key', async () => {
    const f = setup();
    await expect(
      f.dispatcher.instruction('core.pullRequest.create', createParams(), {
        caller: { ...WRITER, grants: ['core.pullRequest.read'] },
        metadata: { idempotencyKey: 'key-1' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      f.dispatcher.instruction('core.pullRequest.create', createParams(), {
        caller: WRITER,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(f.resolveRepository).not.toHaveBeenCalled();
  });

  it('sends no create once the caller cancelled during the head read', async () => {
    const head = deferred<{ sha: string }>();
    const f = setup({ getBranchHead: jest.fn(() => head.promise) });
    const controller = new AbortController();

    const call = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options('key-1', { signal: controller.signal }),
    );
    await new Promise((settle) => setImmediate(settle));
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    head.resolve({ sha: HEAD });
    await new Promise((settle) => setImmediate(settle));

    expect(f.github.createPullRequest).not.toHaveBeenCalled();
  });

  it('lets a sent create land when the caller cancels, and keeps its receipt', async () => {
    const created = deferred<{ number: number; url: string }>();
    const f = setup({ createPullRequest: jest.fn(() => created.promise) });
    const controller = new AbortController();

    const call = f.dispatcher.instruction(
      'core.pullRequest.create',
      createParams(),
      options('key-1', { signal: controller.signal }),
    );
    while (f.github.createPullRequest.mock.calls.length === 0)
      await new Promise((settle) => setImmediate(settle));
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    created.resolve({ number: 7, url: 'https://github.com/Acme/API/pull/7' });

    await expect(
      f.dispatcher.instruction(
        'core.pullRequest.create',
        createParams(),
        options(),
      ),
    ).resolves.toMatchObject({ number: 7 });
    expect(f.github.createPullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('core.pullRequest.update', () => {
  it('compares a fresh read, then sends only the non-null members', async () => {
    const f = setup();

    await expect(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams({ title: 'Renamed' }),
        options(),
      ),
    ).resolves.toMatchObject({ pullRequestId: pullRequestId(), number: 7 });
    expect(f.resolveRepository).toHaveBeenCalledWith(RECORD, 'write');
    expect(f.github.updatePullRequest.mock.calls).toEqual([
      [
        { ...ORIGIN, number: 7 },
        { title: 'Renamed', baseBranch: 'release' },
      ],
    ]);
    expect(f.github.getPullRequest.mock.calls).toEqual([
      [
        { ...ORIGIN, number: 7 },
        { refresh: true, signal: expect.any(AbortSignal) },
      ],
      [
        { ...ORIGIN, number: 7 },
        { refresh: true, signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it.each<[string, Partial<CorePullRequestUpdateParams['patch']>]>([
    ['an empty patch', { baseBranch: null }],
    ['a blank title', { title: '  ' }],
    ['a blank base', { baseBranch: ' ' }],
    ['HEAD as the base', { baseBranch: ' HEAD ' }],
  ])('refuses %s before GitHub', async (_label, patch) => {
    const f = setup();
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams(patch),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'invalid_argument',
      code: 'core.pullRequest.update.invalidPatch',
    });
    expect(f.resolveRepository).not.toHaveBeenCalled();
  });

  it('refuses a draft change on this host before GitHub', async () => {
    const f = setup();
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams({ baseBranch: null, draft: true }),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'capability_unavailable',
      code: 'core.pullRequest.update.draftUnsupported',
    });
    expect(f.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a stale revision without updating', async () => {
    const f = setup();
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams({}, { expectedRevision: 1 }),
        options(),
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'conflict',
      code: 'core.pullRequest.update.revisionConflict',
    });
    expect(f.github.updatePullRequest).not.toHaveBeenCalled();
  });

  it('refuses an id whose origin now names another repository', async () => {
    const f = setup();
    f.resolveRepository.mockResolvedValue({ owner: 'acme', repo: 'web' });
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams(),
        options(),
      ),
    );
    expect(error.payload.code).toBe('core.pullRequest.repositoryUnavailable');
    expect(f.github.getPullRequest).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<GitHubRequestHandle>, string]>([
    [
      'an absent pull request',
      {
        getPullRequest: () =>
          Promise.reject(new GitHubRequestError('not_found', 'gone')),
      },
      'core.pullRequest.notFound',
    ],
    [
      'a refused base',
      {
        updatePullRequest: () =>
          Promise.reject(new GitHubRequestError('base_rejected', 'base')),
      },
      'core.pullRequest.update.baseRejected',
    ],
  ])('maps %s', async (_label, handle, code) => {
    const f = setup(handle);
    const error = await failure(
      f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams(),
        options(),
      ),
    );
    expect(error.payload.code).toBe(code);
  });

  it('answers a same-key retry without updating again', async () => {
    const f = setup();
    await f.dispatcher.instruction(
      'core.pullRequest.update',
      updateParams(),
      options(),
    );
    await f.dispatcher.instruction(
      'core.pullRequest.update',
      updateParams(),
      options(),
    );
    expect(f.github.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(parsePullRequestId(pullRequestId())).not.toBeNull();
  });

  it.each<[string, GitHubRepositoryRef | null]>([
    ['its origin names another repository', { owner: 'acme', repo: 'web' }],
    ['the repository is gone or read-only', null],
  ])(
    'refuses a same-key retry once %s, reading nothing',
    async (_label, now) => {
      const f = setup();
      await f.dispatcher.instruction(
        'core.pullRequest.update',
        updateParams(),
        options(),
      );
      f.resolveRepository.mockResolvedValue(now);

      const error = await failure(
        f.dispatcher.instruction(
          'core.pullRequest.update',
          updateParams(),
          options(),
        ),
      );
      expect(error.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.pullRequest.repositoryUnavailable',
      });
      expect(f.resolveRepository).toHaveBeenLastCalledWith(RECORD, 'write');
      expect(f.github.updatePullRequest).toHaveBeenCalledTimes(1);
      // The revision read and the projection read of the first call only.
      expect(f.github.getPullRequest).toHaveBeenCalledTimes(2);
    },
  );

  it('refuses a call that joined an in-flight update once the origin moved', async () => {
    const updated = deferred<{ number: number; url: string }>();
    const receipts = createPullRequestReceipts<PullRequestWriteReceipt>();
    const run = jest.spyOn(receipts, 'run');
    const f = setup(
      { updatePullRequest: jest.fn(() => updated.promise) },
      { receipts },
    );

    const first = f.dispatcher.instruction(
      'core.pullRequest.update',
      updateParams(),
      options(),
    );
    while (f.github.updatePullRequest.mock.calls.length === 0)
      await new Promise((settle) => setImmediate(settle));
    const joined = f.dispatcher.instruction(
      'core.pullRequest.update',
      updateParams(),
      options(),
    );
    while (run.mock.calls.length < 2)
      await new Promise((settle) => setImmediate(settle));
    f.resolveRepository.mockResolvedValue({ owner: 'acme', repo: 'web' });
    updated.resolve({ number: 7, url: 'https://github.com/Acme/API/pull/7' });

    await expect(first).resolves.toMatchObject({ number: 7 });
    expect((await failure(joined)).payload.code).toBe(
      'core.pullRequest.repositoryUnavailable',
    );
    expect(f.github.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(f.github.getPullRequest).toHaveBeenCalledTimes(2);
  });
});

describe('pull request receipts', () => {
  it('keeps at most the limit of settled receipts, dropping the oldest', async () => {
    const receipts = createPullRequestReceipts<number>(2);
    const write = jest.fn((value: number) => Promise.resolve(value));
    const key = (idempotencyKey: string) => ({
      principalId: 'p',
      operation: 'op',
      idempotencyKey,
    });
    for (const [index, id] of ['a', 'b', 'c'].entries())
      await receipts.run(key(id), 'same', () => write(index));
    // `a` was dropped: it writes again; `c` is still held.
    await expect(receipts.run(key('a'), 'same', () => write(9))).resolves.toBe(
      9,
    );
    await expect(receipts.run(key('c'), 'same', () => write(9))).resolves.toBe(
      2,
    );
    expect(write).toHaveBeenCalledTimes(4);
  });
});
