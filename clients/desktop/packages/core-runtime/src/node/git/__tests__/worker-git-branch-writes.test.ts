import {
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  GIT_BRANCH_HEAD_CHANGED_MESSAGE,
  GitBranchWriteInterrupted,
  type GitBranchDeletePort,
  type GitBranchWritePort,
} from '../branch-writes';
import { WorkerGitScopeError } from '../worker-git-branch-list';
import {
  createWorkerGitBranchWriteHandlers,
  isWorkerGitWriteCaller,
  WORKER_GIT_WRITE_CALLER_REFUSED_MESSAGE,
  type WorkerGitBranchWriteHost,
} from '../worker-git-branch-writes';

const desktopUser: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.write],
};

/** A checkout the fake port mutates as Git would, recording every call. */
interface FakeCheckout {
  head: string;
  dirty: boolean;
  local: Set<string>;
  remote: Set<string>;
  onOrigin: Set<string>;
  occupied: string[];
  worktreeListFails?: boolean;
  calls: string[];
}

function fakeCheckout(overrides: Partial<FakeCheckout> = {}): FakeCheckout {
  return {
    head: 'task',
    dirty: false,
    local: new Set(['task', 'main', 'local-only', 'nest/leaf']),
    remote: new Set(['main', 'remote-only']),
    onOrigin: new Set(['main', 'remote-only', 'late']),
    occupied: ['main'],
    calls: [],
    ...overrides,
  };
}

function portFor(checkout: FakeCheckout): GitBranchWritePort {
  const call = (entry: string): void => {
    checkout.calls.push(entry);
  };
  return {
    hasUncommittedChanges: () => {
      call('status');
      return Promise.resolve(checkout.dirty);
    },
    readWorktreeList: () => {
      call('worktree-list');
      if (checkout.worktreeListFails)
        return Promise.reject(new Error('worktree list failed'));
      return Promise.resolve({
        output: [
          `worktree /checkout\nbranch refs/heads/${checkout.head}\n`,
          ...checkout.occupied.map(
            (branch, index) =>
              `worktree /other-${index}\nbranch refs/heads/${branch}\n`,
          ),
        ].join('\n'),
        checkoutPath: '/checkout',
      });
    },
    localBranchExists: (branch) => {
      call(`local ${branch}`);
      return Promise.resolve(checkout.local.has(branch));
    },
    remoteBranchExists: (branch) => {
      call(`remote ${branch}`);
      return Promise.resolve(checkout.remote.has(branch));
    },
    fetchRemoteBranch: (branch) => {
      call(`fetch ${branch}`);
      if (!checkout.onOrigin.has(branch))
        return Promise.reject(new Error("couldn't find remote ref"));
      checkout.remote.add(branch);
      return Promise.resolve();
    },
    isValidBranchName: (name) => {
      call(`check-ref-format ${name}`);
      return Promise.resolve(!name.includes('..'));
    },
    listLocalBranchesUnder: (name) => {
      call(`under ${name}`);
      return Promise.resolve(
        [...checkout.local]
          .filter((branch) => branch.startsWith(`${name}/`))
          .map((branch) => `refs/heads/${branch}`)
          .join('\n'),
      );
    },
    currentBranch: () => {
      call('current');
      return Promise.resolve(checkout.head);
    },
    checkout: (branch) => {
      call(`checkout ${branch}`);
      checkout.head = branch;
      return Promise.resolve();
    },
    checkoutNewBranch: (name, startPoint) => {
      call(`checkout -b ${name} ${startPoint}`);
      checkout.local.add(name);
      checkout.head = name;
      return Promise.resolve();
    },
    renameCurrentBranch: (name) => {
      call(`branch -m ${name}`);
      checkout.local.delete(checkout.head);
      checkout.local.add(name);
      checkout.head = name;
      return Promise.resolve();
    },
  };
}

/** A repository the fake delete port mutates as Git would. */
interface FakeRepository {
  tips: Map<string, string>;
  checkedOut: Map<string, string>;
  merged: Set<string>;
  listFails?: boolean;
  calls: string[];
}

function fakeRepository(): FakeRepository {
  return {
    tips: new Map([
      ['main', 'a'.repeat(40)],
      ['merged', 'a'.repeat(40)],
      ['unmerged', 'b'.repeat(40)],
      ['held', 'a'.repeat(40)],
    ]),
    checkedOut: new Map([
      ['main', '/repo'],
      ['held', '/linked'],
    ]),
    merged: new Set(['main', 'merged', 'held']),
    calls: [],
  };
}

function deletePortFor(repository: FakeRepository): GitBranchDeletePort {
  const call = (entry: string): void => {
    repository.calls.push(entry);
  };
  return {
    listCheckedOutBranches: () => {
      call('worktree-list');
      if (repository.listFails)
        return Promise.reject(new Error('worktree list failed'));
      return Promise.resolve(new Map(repository.checkedOut));
    },
    deleteBranch: (branch, force) => {
      call(`branch ${force ? '-D' : '-d'} ${branch}`);
      if (!repository.tips.has(branch))
        return Promise.reject(new Error(`error: branch '${branch}' not found`));
      if (!force && !repository.merged.has(branch))
        return Promise.reject(new Error('error: not fully merged'));
      repository.tips.delete(branch);
      return Promise.resolve();
    },
    deleteBranchRef: (branch, tip) => {
      call(`update-ref -d refs/heads/${branch} ${tip}`);
      if (repository.tips.get(branch) !== tip)
        return Promise.reject(new Error('fatal: cannot lock ref'));
      repository.tips.delete(branch);
      return Promise.resolve();
    },
  };
}

type FakeHost = WorkerGitBranchWriteHost<FakeCheckout, FakeRepository>;

function host(
  checkout: FakeCheckout,
  overrides: Partial<FakeHost> = {},
  repository: FakeRepository = fakeRepository(),
): FakeHost & { resolved: number } {
  const recorded = {
    resolved: 0,
    authorityId: 'local-desktop',
    resolveCheckout: (): Promise<FakeCheckout> => {
      recorded.resolved += 1;
      return Promise.resolve(checkout);
    },
    port: portFor,
    resolveRepository: (): Promise<FakeRepository> => {
      recorded.resolved += 1;
      return Promise.resolve(repository);
    },
    deletePort: deletePortFor,
    ...overrides,
  };
  return recorded;
}

const INSTRUCTIONS = {
  ...WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
};

function dispatcher(
  gitHost: FakeHost,
): CanopyDispatcher<Record<never, never>, typeof INSTRUCTIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createWorkerGitBranchWriteHandlers(gitHost),
      streams: {},
    },
  });
}

const scope = { workspaceId: 'ws', worktreeId: 'wt' };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

type CallerIdentity = Pick<
  CanopyCallerDescriptor,
  'principalId' | 'interfaceKind'
>;

describe('worker.git write caller allowlist (CAN-4108 Q8)', () => {
  it.each<[string, CallerIdentity]>([
    ['the trusted core', { principalId: 'core', interfaceKind: 'daemon' }],
    ['the desktop core', { principalId: 'core', interfaceKind: 'desktop' }],
    [
      'the local desktop user',
      { principalId: 'local-desktop-user', interfaceKind: 'desktop' },
    ],
    [
      'a paired controller through the desktop IPC bridge',
      { principalId: 'remote-device:device-1', interfaceKind: 'desktop' },
    ],
  ])('admits %s', (_name, caller) => {
    expect(isWorkerGitWriteCaller(caller)).toBe(true);
  });

  it.each<[string, CallerIdentity]>([
    [
      'a renderer relay surface',
      { principalId: 'local-desktop-renderer:main', interfaceKind: 'desktop' },
    ],
    [
      'a Portal session',
      { principalId: 'local-desktop-user', interfaceKind: 'portal' },
    ],
    [
      'a daemon interface connection',
      { principalId: 'local-user', interfaceKind: 'daemon' },
    ],
    [
      'a remote device outside the desktop bridge',
      { principalId: 'remote-device:device-1', interfaceKind: 'portal' },
    ],
  ])('refuses %s', (_name, caller) => {
    expect(isWorkerGitWriteCaller(caller)).toBe(false);
  });

  it.each([
    'worker.git.checkout',
    'worker.git.branch.create',
    'worker.git.branch.rename',
    'worker.git.branch.delete',
  ] as const)(
    'refuses %s for a relay caller holding the grant before resolving or running Git',
    async (name) => {
      const checkout = fakeCheckout();
      const repository = fakeRepository();
      const gitHost = host(checkout, {}, repository);
      const relay: CanopyCallerDescriptor = {
        ...desktopUser,
        principalId: 'local-desktop-renderer:main',
      };
      const calls = dispatcher(gitHost);
      const error = await rejection(
        name === 'worker.git.checkout'
          ? calls.instruction(
              name,
              { scope, branch: 'local-only' },
              { caller: relay },
            )
          : name === 'worker.git.branch.create'
            ? calls.instruction(
                name,
                {
                  scope,
                  name: 'new',
                  startPoint: { branch: 'main', remote: false },
                },
                { caller: relay },
              )
            : name === 'worker.git.branch.rename'
              ? calls.instruction(
                  name,
                  { scope, name: 'renamed' },
                  { caller: relay },
                )
              : calls.instruction(
                  name,
                  {
                    scope: { workspaceId: 'ws' },
                    branch: 'merged',
                    deletion: { kind: 'force' },
                  },
                  { caller: relay },
                ),
      );
      expect(error).toMatchObject({
        payload: {
          kind: 'permission_denied',
          code:
            name === 'worker.git.checkout'
              ? 'worker.git.checkout.callerRefused'
              : 'worker.git.branch.callerRefused',
          message: WORKER_GIT_WRITE_CALLER_REFUSED_MESSAGE,
        },
      });
      expect(gitHost.resolved).toBe(0);
      expect(checkout.calls).toEqual([]);
      expect(repository.calls).toEqual([]);
    },
  );

  it('denies a caller without worker.git.write before the handler', async () => {
    const checkout = fakeCheckout();
    const gitHost = host(checkout);
    await expect(
      dispatcher(gitHost).instruction(
        'worker.git.checkout',
        { scope, branch: 'local-only' },
        { caller: { ...desktopUser, grants: [WORKER_GIT_GRANTS.read] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(gitHost.resolved).toBe(0);
  });
});

describe('worker.git.checkout', () => {
  const checkout = (
    gitHost: FakeHost,
    params: { branch: string; expected?: { branch: string } },
  ): Promise<unknown> =>
    dispatcher(gitHost).instruction(
      'worker.git.checkout',
      { scope, ...params },
      { caller: desktopUser },
    );

  it('checks out a local branch', async () => {
    const state = fakeCheckout();
    await expect(
      checkout(host(state), { branch: 'local-only' }),
    ).resolves.toEqual({ branch: 'local-only' });
    expect(state.calls).toEqual([
      'status',
      'worktree-list',
      'local local-only',
      'checkout local-only',
    ]);
  });

  it("tracks origin's branch, fetching it first when the checkout has no ref", async () => {
    const tracked = fakeCheckout();
    await checkout(host(tracked), { branch: 'remote-only' });
    expect(tracked.calls.slice(-2)).toEqual([
      'remote remote-only',
      'checkout -b remote-only origin/remote-only',
    ]);
    const fetched = fakeCheckout();
    await checkout(host(fetched), { branch: 'late' });
    expect(fetched.calls.slice(-4)).toEqual([
      'remote late',
      'fetch late',
      'remote late',
      'checkout -b late origin/late',
    ]);
  });

  it.each([
    [
      'uncommitted changes',
      { dirty: true },
      'local-only',
      'failed_precondition',
      'worker.git.checkout.uncommittedChanges',
      'Cannot switch branches with uncommitted changes',
    ],
    [
      'a branch another worktree holds',
      {},
      'main',
      'failed_precondition',
      'worker.git.checkout.branchOccupied',
      'Branch "main" is already checked out in another worktree',
    ],
    [
      'a branch neither the checkout nor origin has',
      {},
      'missing',
      'not_found',
      'worker.git.checkout.branchNotFound',
      'Branch "missing" was not found',
    ],
  ])(
    'refuses %s with the desktop message as the runtime cause',
    async (_name, overrides, branch, kind, code, message) => {
      const state = fakeCheckout(overrides);
      const error = await rejection(checkout(host(state), { branch }));
      expect(error).toBeInstanceOf(CanopyOperationError);
      expect(error).toMatchObject({
        payload: { kind, code, message, retry: { kind: 'after_refresh' } },
      });
      const cause =
        error instanceof CanopyOperationError ? error.runtimeCause : null;
      expect(cause).toBeInstanceOf(Error);
      expect(String(cause)).toBe(`Error: ${message}`);
      expect(state.calls.some((entry) => entry.startsWith('checkout'))).toBe(
        false,
      );
    },
  );

  it('treats an unreadable worktree list as no occupied branch', async () => {
    const state = fakeCheckout({ worktreeListFails: true });
    await expect(checkout(host(state), { branch: 'main' })).resolves.toEqual({
      branch: 'main',
    });
  });

  it.each([
    ['cancelled', 'cancelled', { kind: 'never' }],
    [
      'unavailable',
      'unavailable',
      { kind: 'after_refresh', resource: 'worker.git.branch.list' },
    ],
  ] as const)(
    'stops before any effect when the worktree list is interrupted (%s)',
    async (reason, kind, retry) => {
      const state = fakeCheckout();
      const port = portFor(state);
      const hostCause = new Error('host');
      await expect(
        checkout(
          host(state, {
            port: () => ({
              ...port,
              readWorktreeList: (): Promise<{
                output: string;
                checkoutPath: string;
              }> =>
                Promise.reject(
                  new GitBranchWriteInterrupted(
                    reason,
                    'Interrupted.',
                    hostCause,
                  ),
                ),
            }),
          }),
          { branch: 'main' },
        ),
      ).rejects.toMatchObject({ payload: { kind, retry } });
      expect(state.calls).toEqual(['status']);
      expect(state.head).toBe('task');
    },
  );

  it('stops instead of reporting a missing branch when the fetch is interrupted', async () => {
    const state = fakeCheckout();
    const port = portFor(state);
    const error = await rejection(
      checkout(
        host(state, {
          port: () => ({
            ...port,
            fetchRemoteBranch: (): Promise<void> =>
              Promise.reject(
                new GitBranchWriteInterrupted(
                  'unavailable',
                  'The Git host stopped.',
                ),
              ),
          }),
        }),
        { branch: 'late' },
      ),
    );
    expect(error).toMatchObject({
      payload: {
        kind: 'unavailable',
        message: 'The Git host stopped.',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
    expect(state.calls.some((entry) => entry.startsWith('checkout'))).toBe(
      false,
    );
  });

  it('refuses a changed head right before the effect', async () => {
    const state = fakeCheckout({ head: 'elsewhere' });
    await expect(
      checkout(host(state), {
        branch: 'local-only',
        expected: { branch: 'task' },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.git.checkout.headChanged',
        message: GIT_BRANCH_HEAD_CHANGED_MESSAGE,
        retry: { kind: 'after_refresh' },
      },
    });
    expect(state.calls.slice(-2)).toEqual(['local local-only', 'current']);
  });

  it('checks the expected head after the fetch, before tracking', async () => {
    const state = fakeCheckout();
    await checkout(host(state), {
      branch: 'late',
      expected: { branch: 'task' },
    });
    expect(state.calls.slice(-3)).toEqual([
      'remote late',
      'current',
      'checkout -b late origin/late',
    ]);
  });

  it('refuses a scope another authority or target serves before resolving', async () => {
    const gitHost = host(fakeCheckout());
    await expect(
      dispatcher(gitHost).instruction(
        'worker.git.checkout',
        { scope: { ...scope, targetId: 'elsewhere' }, branch: 'main' },
        { caller: desktopUser },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(gitHost.resolved).toBe(0);
  });

  it('maps host scope refusals to the scope codes, keeping the host cause', async () => {
    const hostCause = new Error('Invalid workspaceId: bad');
    const invalid = await rejection(
      checkout(
        host(fakeCheckout(), {
          resolveCheckout: () =>
            Promise.reject(
              new WorkerGitScopeError('invalid', hostCause.message, hostCause),
            ),
        }),
        { branch: 'main' },
      ),
    );
    expect(invalid).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.git.checkout.invalidScope',
      },
      runtimeCause: hostCause,
    });
    await expect(
      checkout(
        host(fakeCheckout(), {
          resolveCheckout: () =>
            Promise.reject(
              new WorkerGitScopeError('unsupported', 'App-managed chat scope'),
            ),
        }),
        { branch: 'main' },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.checkout.scopeUnsupported',
        retry: { kind: 'never' },
      },
    });
  });

  it('completes a started checkout when the caller aborts (no kill on cancel)', async () => {
    const state = fakeCheckout();
    const port = portFor(state);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished: Promise<void>[] = [];
    const gitHost = host(state, {
      port: () => ({
        ...port,
        checkout: (branch: string): Promise<void> => {
          markStarted();
          const effect = released.then(() => port.checkout(branch));
          finished.push(effect);
          return effect;
        },
      }),
    });
    const controller = new AbortController();
    const call = dispatcher(gitHost).instruction(
      'worker.git.checkout',
      { scope, branch: 'local-only' },
      { caller: desktopUser, signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    release();
    await Promise.all(finished);
    expect(state.head).toBe('local-only');
  });
});

describe('worker.git.branch.create', () => {
  const create = (
    gitHost: FakeHost,
    params: {
      name: string;
      startPoint: { branch: string; remote: boolean };
      expected?: { branch: string };
    },
  ): Promise<unknown> =>
    dispatcher(gitHost).instruction(
      'worker.git.branch.create',
      { scope, ...params },
      { caller: desktopUser },
    );

  it('creates a trimmed branch at the local or origin start point', async () => {
    const local = fakeCheckout();
    await expect(
      create(host(local), {
        name: '  fresh  ',
        startPoint: { branch: ' main ', remote: false },
      }),
    ).resolves.toEqual({ branch: 'fresh' });
    expect(local.calls.at(-1)).toBe('checkout -b fresh main');
    const remote = fakeCheckout();
    await create(host(remote), {
      name: 'fresh',
      startPoint: { branch: 'main', remote: true },
    });
    expect(remote.calls.at(-1)).toBe('checkout -b fresh origin/main');
  });

  it('takes the first free suffix for a taken or shadowed name', async () => {
    const taken = fakeCheckout();
    await expect(
      create(host(taken), {
        name: 'local-only',
        startPoint: { branch: 'main', remote: false },
      }),
    ).resolves.toEqual({ branch: 'local-only-2' });
    const nested = fakeCheckout();
    await expect(
      create(host(nested), {
        name: 'nest',
        startPoint: { branch: 'main', remote: false },
      }),
    ).resolves.toEqual({ branch: 'nest-2' });
  });

  it.each([
    [{ name: '   ', branch: 'main' }, 'Invalid new branch name'],
    [{ name: '-x', branch: 'main' }, 'Invalid new branch name'],
    [{ name: 'ok', branch: ' ' }, 'Invalid base branch'],
    [{ name: 'ok', branch: '-x' }, 'Invalid base branch'],
  ])(
    'refuses %o before resolving the checkout',
    async ({ name, branch }, message) => {
      const state = fakeCheckout();
      const gitHost = host(state);
      await expect(
        create(gitHost, { name, startPoint: { branch, remote: false } }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          message,
          retry: { kind: 'never' },
        },
      });
      expect(gitHost.resolved).toBe(0);
      expect(state.calls).toEqual([]);
    },
  );

  it('refuses a name Git rejects and a dirty checkout without an effect', async () => {
    const invalid = fakeCheckout();
    await expect(
      create(host(invalid), {
        name: 'bad..name',
        startPoint: { branch: 'main', remote: false },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.git.branch.invalidName',
        message: 'Invalid branch name: "bad..name"',
        retry: { kind: 'never' },
      },
    });
    const dirty = fakeCheckout({ dirty: true });
    await expect(
      create(host(dirty), {
        name: 'fresh',
        startPoint: { branch: 'main', remote: false },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.uncommittedChanges',
        message: 'Cannot create a branch with uncommitted changes',
        retry: { kind: 'after_refresh' },
      },
    });
    for (const state of [invalid, dirty])
      expect(state.calls.some((entry) => entry.startsWith('checkout'))).toBe(
        false,
      );
  });

  it('refuses a changed head after choosing the name, before the effect', async () => {
    const state = fakeCheckout({ head: 'elsewhere' });
    await expect(
      create(host(state), {
        name: 'fresh',
        startPoint: { branch: 'main', remote: false },
        expected: { branch: 'task' },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.git.branch.headChanged',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
    expect(state.calls.at(-1)).toBe('current');
    expect(state.local.has('fresh')).toBe(false);
  });

  it('lets an unclassified Git failure reach the caller as its runtime cause', async () => {
    const state = fakeCheckout();
    const gitError = new Error("fatal: 'nowhere' is not a commit");
    const port = portFor(state);
    const error = await rejection(
      create(
        host(state, {
          port: (): GitBranchWritePort => ({
            ...port,
            checkoutNewBranch: () => Promise.reject(gitError),
          }),
        }),
        { name: 'fresh', startPoint: { branch: 'nowhere', remote: false } },
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'internal' },
      runtimeCause: gitError,
    });
  });
});

describe('worker.git.branch.rename', () => {
  const rename = (
    gitHost: FakeHost,
    params: { name: string; expected?: { branch: string } },
  ): Promise<unknown> =>
    dispatcher(gitHost).instruction(
      'worker.git.branch.rename',
      { scope, ...params },
      { caller: desktopUser },
    );

  it('checks the name, then renames the current branch', async () => {
    const state = fakeCheckout();
    await expect(rename(host(state), { name: 'renamed' })).resolves.toEqual({
      branch: 'renamed',
    });
    expect(state.calls).toEqual([
      'check-ref-format renamed',
      'local renamed',
      'under renamed',
      'branch -m renamed',
    ]);
    expect(state.head).toBe('renamed');
    expect(state.local.has('task')).toBe(false);
  });

  it('renames a dirty checkout: uncommitted changes do not block it', async () => {
    const state = fakeCheckout({ dirty: true });
    await expect(rename(host(state), { name: 'renamed' })).resolves.toEqual({
      branch: 'renamed',
    });
    expect(state.calls).not.toContain('status');
  });

  it.each([
    [
      'a name Git rejects',
      'bad..name',
      'invalid_argument',
      'worker.git.branch.invalidName',
      'Invalid branch name: "bad..name"',
      { kind: 'never' },
    ],
    [
      'a name a local branch has',
      'local-only',
      'conflict',
      'worker.git.branch.nameUnavailable',
      'Branch name "local-only" is already in use',
      { kind: 'after_refresh', resource: 'worker.git.branch.list' },
    ],
    [
      'a name a nested branch shadows',
      'nest',
      'conflict',
      'worker.git.branch.nameUnavailable',
      'Branch name "nest" is already in use',
      { kind: 'after_refresh', resource: 'worker.git.branch.list' },
    ],
    [
      'a name under an existing branch',
      'main/child',
      'conflict',
      'worker.git.branch.nameUnavailable',
      'Branch name "main/child" is already in use',
      { kind: 'after_refresh', resource: 'worker.git.branch.list' },
    ],
    [
      'the name the branch already has',
      'task',
      'conflict',
      'worker.git.branch.nameUnavailable',
      'Branch name "task" is already in use',
      { kind: 'after_refresh', resource: 'worker.git.branch.list' },
    ],
  ])(
    'refuses %s with the desktop message, without an effect',
    async (_label, name, kind, code, message, retry) => {
      const state = fakeCheckout();
      const error = await rejection(rename(host(state), { name }));
      expect(error).toMatchObject({ payload: { kind, code, message, retry } });
      const cause =
        error instanceof CanopyOperationError ? error.runtimeCause : null;
      expect(String(cause)).toBe(`Error: ${message}`);
      expect(state.calls.some((entry) => entry.startsWith('branch'))).toBe(
        false,
      );
      expect(state.head).toBe('task');
    },
  );

  it('refuses a changed head after the name checks, before the effect', async () => {
    const state = fakeCheckout({ head: 'elsewhere' });
    await expect(
      rename(host(state), { name: 'renamed', expected: { branch: 'task' } }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.git.branch.headChanged',
        message: GIT_BRANCH_HEAD_CHANGED_MESSAGE,
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
    expect(state.calls.at(-1)).toBe('current');
    expect(state.head).toBe('elsewhere');
    const matching = fakeCheckout();
    await rename(host(matching), {
      name: 'renamed',
      expected: { branch: 'task' },
    });
    expect(matching.calls.slice(-2)).toEqual(['current', 'branch -m renamed']);
  });

  it('maps host scope refusals to the branch scope codes', async () => {
    await expect(
      rename(
        host(fakeCheckout(), {
          resolveCheckout: () =>
            Promise.reject(new WorkerGitScopeError('unsupported', 'chat')),
        }),
        { name: 'renamed' },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.scopeUnsupported',
        retry: { kind: 'never' },
      },
    });
  });

  it('answers an interrupted host as unavailable, retried after a refresh', async () => {
    const state = fakeCheckout();
    const port = portFor(state);
    await expect(
      rename(
        host(state, {
          port: (): GitBranchWritePort => ({
            ...port,
            renameCurrentBranch: () =>
              Promise.reject(
                new GitBranchWriteInterrupted(
                  'unavailable',
                  'The Git host stopped.',
                ),
              ),
          }),
        }),
        { name: 'renamed' },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
    expect(state.head).toBe('task');
  });

  it("lets Git's failure of the rename reach the caller as its runtime cause", async () => {
    const state = fakeCheckout();
    const gitError = new Error(
      'fatal: cannot rename the current branch while not on any',
    );
    const port = portFor(state);
    const error = await rejection(
      rename(
        host(state, {
          port: (): GitBranchWritePort => ({
            ...port,
            renameCurrentBranch: () => Promise.reject(gitError),
          }),
        }),
        { name: 'renamed' },
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'internal' },
      runtimeCause: gitError,
    });
  });

  it('completes a started rename when the caller aborts (no kill on cancel)', async () => {
    const state = fakeCheckout();
    const port = portFor(state);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished: Promise<void>[] = [];
    const controller = new AbortController();
    const call = dispatcher(
      host(state, {
        port: () => ({
          ...port,
          renameCurrentBranch: (name: string): Promise<void> => {
            markStarted();
            const effect = released.then(() => port.renameCurrentBranch(name));
            finished.push(effect);
            return effect;
          },
        }),
      }),
    ).instruction(
      'worker.git.branch.rename',
      { scope, name: 'renamed' },
      { caller: desktopUser, signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    release();
    await Promise.all(finished);
    expect(state.head).toBe('renamed');
  });
});

describe('worker.git.branch.delete', () => {
  const repoScope = { workspaceId: 'ws' };
  const remove = (
    gitHost: FakeHost,
    branch: string,
    deletion:
      | { kind: 'merged' }
      | { kind: 'force' }
      | { kind: 'tip'; tip: string },
  ): Promise<unknown> =>
    dispatcher(gitHost).instruction(
      'worker.git.branch.delete',
      { scope: repoScope, branch, deletion },
      { caller: desktopUser },
    );

  it('runs branch -d for merged and branch -D for force', async () => {
    const repository = fakeRepository();
    const gitHost = host(fakeCheckout(), {}, repository);
    await expect(
      remove(gitHost, 'merged', { kind: 'merged' }),
    ).resolves.toEqual({ branch: 'merged' });
    await expect(
      remove(gitHost, 'unmerged', { kind: 'force' }),
    ).resolves.toEqual({ branch: 'unmerged' });
    expect(repository.calls).toEqual([
      'branch -d merged',
      'branch -D unmerged',
    ]);
  });

  it("leaves Git's refusals untyped, with Git's error as the runtime cause", async () => {
    const repository = fakeRepository();
    const error = await rejection(
      remove(host(fakeCheckout(), {}, repository), 'unmerged', {
        kind: 'merged',
      }),
    );
    expect(error).toMatchObject({ payload: { kind: 'internal' } });
    const cause =
      error instanceof CanopyOperationError ? error.runtimeCause : null;
    expect(String(cause)).toBe('Error: error: not fully merged');
    expect(repository.tips.has('unmerged')).toBe(true);
  });

  it('deletes a branch still at its tip, and leaves a moved one', async () => {
    const repository = fakeRepository();
    const gitHost = host(fakeCheckout(), {}, repository);
    await expect(
      remove(gitHost, 'unmerged', { kind: 'tip', tip: 'b'.repeat(40) }),
    ).resolves.toEqual({ branch: 'unmerged' });
    expect(repository.calls).toEqual([
      'worktree-list',
      `update-ref -d refs/heads/unmerged ${'b'.repeat(40)}`,
    ]);
    await expect(
      remove(gitHost, 'merged', { kind: 'tip', tip: 'c'.repeat(40) }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(repository.tips.has('merged')).toBe(true);
  });

  it.each(['held', 'main'])(
    'refuses %s while a worktree has it checked out, with no path in the payload',
    async (branch) => {
      const repository = fakeRepository();
      const error = await rejection(
        remove(host(fakeCheckout(), {}, repository), branch, {
          kind: 'tip',
          tip: 'a'.repeat(40),
        }),
      );
      expect(error).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.git.branch.checkedOut',
          message: `Branch "${branch}" is checked out in a worktree.`,
          retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
        },
      });
      const cause =
        error instanceof CanopyOperationError ? error.runtimeCause : null;
      expect(String(cause)).toBe(
        `Error: Cannot delete branch "${branch}" because it is checked out at ${repository.checkedOut.get(branch) ?? ''}`,
      );
      expect(repository.calls).toEqual(['worktree-list']);
    },
  );

  it('fails before the effect when the worktree listing fails', async () => {
    const repository = { ...fakeRepository(), listFails: true };
    await expect(
      remove(host(fakeCheckout(), {}, repository), 'merged', {
        kind: 'tip',
        tip: 'a'.repeat(40),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(repository.calls).toEqual(['worktree-list']);
    expect(repository.tips.has('merged')).toBe(true);
  });

  it('answers an interrupted worktree listing as unavailable, retried after a refresh', async () => {
    const repository = fakeRepository();
    const port = deletePortFor(repository);
    await expect(
      remove(
        host(fakeCheckout(), {
          deletePort: (): GitBranchDeletePort => ({
            ...port,
            listCheckedOutBranches: () =>
              Promise.reject(
                new GitBranchWriteInterrupted(
                  'unavailable',
                  'The Git host stopped.',
                ),
              ),
          }),
        }),
        'merged',
        { kind: 'tip', tip: 'a'.repeat(40) },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
    expect(repository.tips.has('merged')).toBe(true);
  });

  it.each(['', '-D', 'bad\0name'])(
    'refuses the name %j before resolving the repository',
    async (branch) => {
      const repository = fakeRepository();
      const gitHost = host(fakeCheckout(), {}, repository);
      await expect(
        remove(gitHost, branch, { kind: 'force' }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.git.branch.invalidName',
        },
      });
      expect(gitHost.resolved).toBe(0);
      expect(repository.calls).toEqual([]);
    },
  );

  it('maps host scope refusals to the branch scope codes', async () => {
    await expect(
      remove(
        host(fakeCheckout(), {
          resolveRepository: () =>
            Promise.reject(
              new WorkerGitScopeError('invalid', 'Invalid repoId'),
            ),
        }),
        'merged',
        { kind: 'merged' },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.git.branch.invalidScope',
        retry: { kind: 'never' },
      },
    });
    await expect(
      remove(
        host(fakeCheckout(), {
          resolveRepository: () =>
            Promise.reject(new WorkerGitScopeError('unsupported', 'Cowork')),
        }),
        'merged',
        { kind: 'merged' },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.scopeUnsupported',
        retry: { kind: 'never' },
      },
    });
  });

  it('refuses another authority before resolving', async () => {
    const gitHost = host(fakeCheckout());
    await expect(
      dispatcher(gitHost).instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'ws', authorityId: 'elsewhere' },
          branch: 'merged',
          deletion: { kind: 'merged' },
        },
        { caller: desktopUser },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(gitHost.resolved).toBe(0);
  });
});
