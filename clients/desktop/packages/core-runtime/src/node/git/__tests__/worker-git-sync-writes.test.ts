import {
  WORKER_GIT_GRANTS,
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerGitPullStrategy,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  GIT_BRANCH_HEAD_CHANGED_MESSAGE,
  GitBranchWriteInterrupted,
} from '../branch-writes';
import type { GitSyncWritePort } from '../sync-writes';
import { WorkerGitScopeError } from '../worker-git-branch-list';
import {
  createWorkerGitSyncWriteHandlers,
  WORKER_GIT_SYNC_CALLER_REFUSED_MESSAGE,
  type WorkerGitSyncWriteHost,
} from '../worker-git-sync-writes';

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
  /** What a failed rebase pull leaves behind. */
  rebaseFails?: 'rebase' | 'autostash' | 'other';
  pullFails?: Error;
  fetchFails?: Error;
  classifyFails?: boolean;
  calls: string[];
}

function fakeCheckout(overrides: Partial<FakeCheckout> = {}): FakeCheckout {
  return { head: 'feature', calls: [], ...overrides };
}

function portFor(checkout: FakeCheckout): GitSyncWritePort {
  const call = (entry: string): void => {
    checkout.calls.push(entry);
  };
  const classify = (entry: string, answer: boolean): Promise<boolean> => {
    call(entry);
    return checkout.classifyFails
      ? Promise.reject(new Error(`${entry} failed`))
      : Promise.resolve(answer);
  };
  return {
    fetchOrigin: ({ prune }) => {
      call(prune ? 'fetch --prune origin' : 'fetch origin');
      return checkout.fetchFails
        ? Promise.reject(checkout.fetchFails)
        : Promise.resolve();
    },
    currentBranch: () => {
      call('current');
      return Promise.resolve(checkout.head);
    },
    pullFastForward: (branch) => {
      call(`pull --ff-only origin ${branch}`);
      return checkout.pullFails
        ? Promise.reject(checkout.pullFails)
        : Promise.resolve();
    },
    pullRebase: (branch) => {
      call(`pull --rebase --autostash origin ${branch}`);
      return checkout.rebaseFails
        ? Promise.reject(new Error('rebase failed'))
        : Promise.resolve();
    },
    isRebaseInProgress: () =>
      classify('rebase-state', checkout.rebaseFails === 'rebase'),
    hasAutostashEntry: () =>
      classify('stash list', checkout.rebaseFails === 'autostash'),
    hasUnmergedPaths: () =>
      classify('status', checkout.rebaseFails === 'autostash'),
  };
}

function host(
  checkout: FakeCheckout,
  overrides: Partial<WorkerGitSyncWriteHost<FakeCheckout>> = {},
): WorkerGitSyncWriteHost<FakeCheckout> & { resolved: number } {
  const recorded = {
    resolved: 0,
    authorityId: 'local-desktop',
    resolveCheckout: (): Promise<FakeCheckout> => {
      recorded.resolved += 1;
      return Promise.resolve(checkout);
    },
    port: portFor,
    ...overrides,
  };
  return recorded;
}

function dispatcher(
  gitHost: WorkerGitSyncWriteHost<FakeCheckout>,
): CanopyDispatcher<
  Record<never, never>,
  typeof WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS
> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: createWorkerGitSyncWriteHandlers(gitHost),
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

const fetch = (
  gitHost: WorkerGitSyncWriteHost<FakeCheckout>,
  prune: boolean,
  caller: CanopyCallerDescriptor = desktopUser,
  signal?: AbortSignal,
): Promise<unknown> =>
  dispatcher(gitHost).instruction(
    'worker.git.fetch',
    { scope, prune },
    { caller, ...(signal && { signal }) },
  );

const pull = (
  gitHost: WorkerGitSyncWriteHost<FakeCheckout>,
  strategy: WorkerGitPullStrategy,
  extra: { expected?: { branch: string } } = {},
  caller: CanopyCallerDescriptor = desktopUser,
): Promise<unknown> =>
  dispatcher(gitHost).instruction(
    'worker.git.pull',
    { scope, branch: 'feature', strategy, ...extra },
    { caller },
  );

describe('worker.git fetch and pull callers (CAN-4108 Q8)', () => {
  it.each(['worker.git.fetch', 'worker.git.pull'] as const)(
    'refuses %s for a relay or Portal caller holding the grant before resolving',
    async (name) => {
      for (const caller of [
        { ...desktopUser, principalId: 'local-desktop-renderer:main' },
        { ...desktopUser, interfaceKind: 'portal' },
      ] satisfies CanopyCallerDescriptor[]) {
        const checkout = fakeCheckout();
        const gitHost = host(checkout);
        const error = await rejection(
          name === 'worker.git.fetch'
            ? fetch(gitHost, true, caller)
            : pull(gitHost, 'rebase', {}, caller),
        );
        expect(error).toMatchObject({
          payload: {
            kind: 'permission_denied',
            code: `${name}.callerRefused`,
            message: WORKER_GIT_SYNC_CALLER_REFUSED_MESSAGE,
            retry: { kind: 'never' },
          },
        });
        expect(gitHost.resolved).toBe(0);
        expect(checkout.calls).toEqual([]);
      }
    },
  );

  it('admits a paired controller through the desktop IPC bridge and the core', async () => {
    for (const caller of [
      { ...desktopUser, principalId: 'remote-device:device-1' },
      { ...desktopUser, principalId: 'core', interfaceKind: 'daemon' },
    ] satisfies CanopyCallerDescriptor[]) {
      const checkout = fakeCheckout();
      await expect(fetch(host(checkout), false, caller)).resolves.toEqual({
        remote: 'origin',
        pruned: false,
      });
      expect(checkout.calls).toEqual(['fetch origin']);
    }
  });

  it('denies a caller without worker.git.write before the handler', async () => {
    const gitHost = host(fakeCheckout());
    await expect(
      fetch(gitHost, true, {
        ...desktopUser,
        grants: [WORKER_GIT_GRANTS.read],
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(gitHost.resolved).toBe(0);
  });

  it('refuses another authority or target before resolving', async () => {
    const gitHost = host(fakeCheckout());
    await expect(
      dispatcher(gitHost).instruction(
        'worker.git.pull',
        {
          scope: { ...scope, targetId: 'elsewhere' },
          branch: 'feature',
          strategy: 'rebase',
        },
        { caller: desktopUser },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(gitHost.resolved).toBe(0);
  });

  it('maps host scope refusals to each family’s codes, keeping the host cause', async () => {
    const hostCause = new Error('Invalid repoId: bad');
    await expect(
      fetch(
        host(fakeCheckout(), {
          resolveCheckout: () =>
            Promise.reject(
              new WorkerGitScopeError('invalid', hostCause.message, hostCause),
            ),
        }),
        true,
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.git.fetch.invalidScope',
        retry: { kind: 'never' },
      },
      runtimeCause: hostCause,
    });
    await expect(
      pull(
        host(fakeCheckout(), {
          resolveCheckout: () =>
            Promise.reject(
              new WorkerGitScopeError('unsupported', 'Chat scope'),
            ),
        }),
        'rebase',
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.pull.scopeUnsupported',
      },
    });
  });

  // The published pages list these exact directives per code.
  it.each(['worker.git.fetch', 'worker.git.pull'] as const)(
    'never directs a retry of a scope %s refuses',
    async (name) => {
      const gitHost = host(fakeCheckout(), {
        resolveCheckout: () =>
          Promise.reject(new WorkerGitScopeError('unsupported', 'Chat scope')),
      });
      const error = await rejection(
        name === 'worker.git.fetch'
          ? fetch(gitHost, true)
          : pull(gitHost, 'fast-forward'),
      );
      expect(error).toBeInstanceOf(CanopyOperationError);
      expect(error).toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: `${name}.scopeUnsupported`,
          retry: { kind: 'never' },
        },
      });
    },
  );
});

describe('worker.git.fetch', () => {
  it('fetches origin, pruning on request', async () => {
    const checkout = fakeCheckout();
    await expect(fetch(host(checkout), true)).resolves.toEqual({
      remote: 'origin',
      pruned: true,
    });
    expect(checkout.calls).toEqual(['fetch --prune origin']);
  });

  it("fails as internal with Git's error as the runtime cause", async () => {
    const gitError = new Error("fatal: 'origin' does not appear to be a git repository"); // prettier-ignore
    const error = await rejection(
      fetch(host(fakeCheckout({ fetchFails: gitError })), true),
    );
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({
      payload: { kind: 'internal' },
      runtimeCause: gitError,
    });
  });

  it('answers unavailable, not a Git failure, when the host is interrupted', async () => {
    const checkout = fakeCheckout();
    const port = portFor(checkout);
    await expect(
      fetch(
        host(checkout, {
          port: () => ({
            ...port,
            fetchOrigin: (): Promise<void> =>
              Promise.reject(
                new GitBranchWriteInterrupted(
                  'unavailable',
                  'The Git host stopped.',
                ),
              ),
          }),
        }),
        true,
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        message: 'The Git host stopped.',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
  });

  it('completes a started fetch when the caller aborts (no kill on cancel)', async () => {
    const checkout = fakeCheckout();
    const port = portFor(checkout);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished: Promise<void> | undefined;
    const controller = new AbortController();
    const call = fetch(
      host(checkout, {
        port: () => ({
          ...port,
          fetchOrigin: (options): Promise<void> => {
            markStarted();
            finished = released.then(() => port.fetchOrigin(options));
            return finished;
          },
        }),
      }),
      true,
      desktopUser,
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    release();
    await finished;
    expect(checkout.calls).toEqual(['fetch --prune origin']);
  });
});

describe('worker.git.pull', () => {
  it('fast-forwards or rebases, as the strategy says', async () => {
    const forward = fakeCheckout();
    await expect(pull(host(forward), 'fast-forward')).resolves.toEqual({
      outcome: 'pulled',
    });
    expect(forward.calls).toEqual(['pull --ff-only origin feature']);
    const rebase = fakeCheckout();
    await expect(pull(host(rebase), 'rebase')).resolves.toEqual({
      outcome: 'pulled',
    });
    expect(rebase.calls).toEqual(['pull --rebase --autostash origin feature']);
  });

  it('answers a rebase left in progress as a typed conflict outcome', async () => {
    const checkout = fakeCheckout({ rebaseFails: 'rebase' });
    await expect(pull(host(checkout), 'rebase')).resolves.toEqual({
      outcome: 'conflict',
      conflict: 'rebase',
    });
    expect(checkout.calls).toEqual([
      'pull --rebase --autostash origin feature',
      'rebase-state',
    ]);
  });

  it('answers an unmerged autostash as a typed conflict outcome', async () => {
    const checkout = fakeCheckout({ rebaseFails: 'autostash' });
    await expect(pull(host(checkout), 'rebase')).resolves.toEqual({
      outcome: 'conflict',
      conflict: 'autostash',
    });
    expect(checkout.calls.slice(1).sort()).toEqual([
      'rebase-state',
      'stash list',
      'status',
    ]);
  });

  it("fails as internal with Git's error when the rebase failure is unclassified or unreadable", async () => {
    for (const overrides of [
      { rebaseFails: 'other' as const },
      { rebaseFails: 'rebase' as const, classifyFails: true },
    ]) {
      const error = await rejection(
        pull(host(fakeCheckout(overrides)), 'rebase'),
      );
      expect(error).toMatchObject({ payload: { kind: 'internal' } });
      expect(String(Reflect.get(Object(error), 'runtimeCause'))).toBe(
        'Error: rebase failed',
      );
    }
  });

  it('never classifies a failed fast-forward', async () => {
    const gitError = new Error('fatal: Not possible to fast-forward');
    const checkout = fakeCheckout({ pullFails: gitError });
    await expect(pull(host(checkout), 'fast-forward')).rejects.toMatchObject({
      payload: { kind: 'internal' },
      runtimeCause: gitError,
    });
    expect(checkout.calls).toEqual(['pull --ff-only origin feature']);
  });

  it('refuses a changed head right before the pull, running nothing', async () => {
    const checkout = fakeCheckout({ head: 'elsewhere' });
    await expect(
      pull(host(checkout), 'rebase', { expected: { branch: 'feature' } }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.git.pull.headChanged',
        message: GIT_BRANCH_HEAD_CHANGED_MESSAGE,
        retry: { kind: 'after_refresh' },
      },
    });
    expect(checkout.calls).toEqual(['current']);
    const same = fakeCheckout();
    await expect(
      pull(host(same), 'fast-forward', { expected: { branch: 'feature' } }),
    ).resolves.toEqual({ outcome: 'pulled' });
    expect(same.calls).toEqual(['current', 'pull --ff-only origin feature']);
  });

  it('stops as unavailable when the conflict reads are interrupted', async () => {
    const checkout = fakeCheckout({ rebaseFails: 'rebase' });
    const port = portFor(checkout);
    await expect(
      pull(
        host(checkout, {
          port: () => ({
            ...port,
            isRebaseInProgress: (): Promise<boolean> =>
              Promise.reject(
                new GitBranchWriteInterrupted('unavailable', 'Git is unavailable.'), // prettier-ignore
              ),
          }),
        }),
        'rebase',
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      },
    });
  });
});
