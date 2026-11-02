import { CanopyOperationError } from '../../../runtime/errors';
import {
  createBranchObserver,
  type BranchCheckout,
  type BranchCheckoutListing,
  type BranchObservation,
  type BranchReadyWorktree,
  type GitHeadWatchHandle,
  type GitHeadWatchListener,
} from '../branch-observer';

interface FakeWatch {
  key: string;
  listener: GitHeadWatchListener;
  close: jest.Mock;
}

function checkout(
  worktreeId: string,
  overrides: Partial<BranchCheckout> = {},
): BranchCheckout {
  return {
    workspaceId: 'ws',
    worktreeId,
    fileRootId: 'ws',
    persistedBranchName: 'main',
    ...overrides,
  };
}

function keyOf(ref: BranchCheckout): string {
  return `${ref.workspaceId}/${ref.worktreeId}/${ref.repoId ?? 'root'}`;
}

function attachError(kind: 'internal' | 'not_found'): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    message: kind,
    retry: { kind: 'never' },
  });
}

interface MockPorts {
  listCheckouts: jest.Mock<Promise<BranchCheckoutListing<BranchCheckout>>, []>;
  listReadyWorktreeCheckouts: jest.Mock<
    Promise<BranchCheckout[]>,
    [BranchReadyWorktree]
  >;
  readStartBranch: jest.Mock<Promise<string | null>, [BranchCheckout]>;
  readBranch: jest.Mock<Promise<string | null>, [BranchCheckout]>;
  record: jest.Mock<Promise<void>, [BranchObservation]>;
  watchHead: jest.Mock<
    Promise<GitHeadWatchHandle>,
    [BranchCheckout, GitHeadWatchListener]
  >;
}

function harness(): {
  ports: MockPorts;
  listing: BranchCheckoutListing<BranchCheckout>;
  live: Map<string, string | null>;
  watches: FakeWatch[];
  failNext: Array<CanopyOperationError | null>;
  open: (key: string) => FakeWatch[];
} {
  const live = new Map<string, string | null>();
  const watches: FakeWatch[] = [];
  const failNext: Array<CanopyOperationError | null> = [];
  const listing: BranchCheckoutListing<BranchCheckout> = {
    checkouts: [],
    pendingWorktrees: [],
    preservedWorkspaceIds: new Set(),
  };
  const read = (ref: BranchCheckout): Promise<string | null> =>
    Promise.resolve(live.get(keyOf(ref)) ?? null);
  const ports: MockPorts = {
    listCheckouts: jest.fn(() =>
      Promise.resolve({
        ...listing,
        checkouts: [...listing.checkouts],
      }),
    ),
    listReadyWorktreeCheckouts: jest.fn(
      ({ workspaceId, worktreeId }: BranchReadyWorktree) =>
        Promise.resolve([checkout(worktreeId, { workspaceId })]),
    ),
    readStartBranch: jest.fn(read),
    readBranch: jest.fn(read),
    record: jest.fn<Promise<void>, [BranchObservation]>(() =>
      Promise.resolve(),
    ),
    watchHead: jest.fn(
      (ref: BranchCheckout, listener: GitHeadWatchListener) => {
        const failure = failNext.shift();
        if (failure) return Promise.reject(failure);
        const watch: FakeWatch = {
          key: keyOf(ref),
          listener,
          close: jest.fn(),
        };
        watches.push(watch);
        return Promise.resolve({ close: watch.close });
      },
    ),
  };
  return {
    ports,
    listing,
    live,
    watches,
    failNext,
    open: (key) =>
      watches.filter(
        (watch) => watch.key === key && watch.close.mock.calls.length === 0,
      ),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createBranchObserver', () => {
  it('enrolls checkouts from the persisted listing, skipping pending worktrees', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [
      checkout('wt-1'),
      checkout('wt-2', {
        repoId: 'api',
        fileRootId: 'api',
        persistedBranchName: null,
      }),
    ];
    listing.pendingWorktrees = [{ workspaceId: 'ws', worktreeId: 'wt-3' }];
    live.set('ws/wt-1/root', 'main');
    live.set('ws/wt-2/api', 'dev');
    const observer = createBranchObserver(ports);

    await observer.sync();

    expect(watches.map((watch) => watch.key)).toEqual([
      'ws/wt-1/root',
      'ws/wt-2/api',
    ]);
    expect(observer.snapshot()).toEqual({ watching: 2, polling: 0 });
    // A repository keeps no branch of its own: it seeds from HEAD.
    expect(ports.record).not.toHaveBeenCalled();
  });

  it('starts each checkout once across syncs and git-ready', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    const ready = {
      workspaceId: 'ws',
      worktreeId: 'wt-1',
      workspaceKind: 'single-repo' as const,
      branchName: 'main',
    };

    await Promise.all([
      observer.sync(),
      observer.ensureWorktree(ready),
      observer.ensureWorktree(ready),
    ]);
    await observer.sync();
    await observer.ensureWorktree(ready);

    expect(watches).toHaveLength(1);
  });

  it('retires removed checkouts and reopens one stream when re-added', async () => {
    const { ports, listing, live, watches, open } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    listing.checkouts = [];
    await observer.sync();
    expect(watches[0]?.close).toHaveBeenCalledTimes(1);
    watches[0]?.listener.onChange();
    await jest.advanceTimersByTimeAsync(100);
    expect(ports.readBranch).not.toHaveBeenCalled();

    listing.checkouts = [checkout('wt-1')];
    await observer.sync();
    expect(open('ws/wt-1/root')).toHaveLength(1);
  });

  it('keeps preserved workspaces and worktrees git-ready started', async () => {
    const { ports, listing, live, watches } = harness();
    live.set('ws/wt-1/root', 'main');
    live.set('other/wt-9/root', 'main');
    listing.checkouts = [
      checkout('wt-1'),
      checkout('wt-9', { workspaceId: 'other' }),
    ];
    const observer = createBranchObserver(ports);
    await observer.sync();
    await observer.ensureWorktree({
      workspaceId: 'ws',
      worktreeId: 'wt-3',
      workspaceKind: 'single-repo',
      branchName: 'main',
    });

    listing.checkouts = [checkout('wt-1')];
    listing.preservedWorkspaceIds = new Set(['other']);
    listing.pendingWorktrees = [{ workspaceId: 'ws', worktreeId: 'wt-3' }];
    await observer.sync();

    expect(watches.every((watch) => watch.close.mock.calls.length === 0)).toBe(
      true,
    );
    expect(observer.snapshot().watching).toBe(3);
  });

  it('records a branch renamed while unwatched, and nothing for a detached HEAD', async () => {
    const { ports, listing, live } = harness();
    listing.checkouts = [
      checkout('wt-1', { persistedBranchName: 'old' }),
      checkout('wt-2', { persistedBranchName: 'old' }),
    ];
    live.set('ws/wt-1/root', 'renamed');
    live.set('ws/wt-2/root', 'HEAD');
    const observer = createBranchObserver(ports);

    await observer.sync();

    expect(ports.record.mock.calls).toEqual([
      [{ workspaceId: 'ws', worktreeId: 'wt-1', branchName: 'renamed' }],
    ]);
  });

  it('coalesces HEAD notifications and records the exact observation once', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [
      checkout('wt-2', { repoId: 'api', fileRootId: 'api' }),
    ];
    live.set('ws/wt-2/api', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    live.set('ws/wt-2/api', 'feature');
    watches[0]?.listener.onChange();
    watches[0]?.listener.onChange();
    await jest.advanceTimersByTimeAsync(99);
    expect(ports.readBranch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(ports.readBranch).toHaveBeenCalledTimes(1);
    expect(ports.record.mock.calls).toEqual([
      [
        {
          workspaceId: 'ws',
          worktreeId: 'wt-2',
          branchName: 'feature',
          repoId: 'api',
        },
      ],
    ]);
  });

  it('reopens an ended stream and catches up on what it missed', async () => {
    const { ports, listing, live, watches, open } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    watches[0]?.listener.onEnd({
      kind: 'resource_exhausted',
      message: 'buffer',
      retry: { kind: 'never' },
    });
    live.set('ws/wt-1/root', 'moved');
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(open('ws/wt-1/root')).toHaveLength(2);
    expect(ports.record.mock.calls).toEqual([
      [{ workspaceId: 'ws', worktreeId: 'wt-1', branchName: 'moved' }],
    ]);
  });

  it('polls a checkout whose watch cannot attach and stops once it does', async () => {
    const { ports, listing, live, failNext, open } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    failNext.push(attachError('internal'));
    const observer = createBranchObserver(ports);
    await observer.sync();
    expect(observer.snapshot()).toEqual({ watching: 0, polling: 1 });

    live.set('ws/wt-1/root', 'polled');
    await jest.advanceTimersByTimeAsync(2_000);
    expect(ports.record).toHaveBeenCalledWith({
      workspaceId: 'ws',
      worktreeId: 'wt-1',
      branchName: 'polled',
    });

    // The retry 30 s after the failure still fails, the next one attaches.
    failNext.push(attachError('internal'));
    await jest.advanceTimersByTimeAsync(28_000);
    expect(open('ws/wt-1/root')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(open('ws/wt-1/root')).toHaveLength(1);
    expect(observer.snapshot()).toEqual({ watching: 1, polling: 0 });
    const reads = ports.readBranch.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(ports.readBranch.mock.calls.length).toBe(reads);
  });

  it('stops polling once a reopen attaches after a retry stream ended at once', async () => {
    const { ports, listing, live, failNext, watches } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    failNext.push(attachError('internal'));
    const observer = createBranchObserver(ports);
    await observer.sync();
    ports.watchHead.mockImplementationOnce(
      (ref: BranchCheckout, listener: GitHeadWatchListener) => {
        listener.onEnd(null);
        const watch: FakeWatch = {
          key: keyOf(ref),
          listener,
          close: jest.fn(),
        };
        watches.push(watch);
        return Promise.resolve({ close: watch.close });
      },
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(watches).toHaveLength(2);
    expect(observer.snapshot()).toEqual({ watching: 1, polling: 0 });
  });

  it('leaves a checkout without a Git root for the next sync', async () => {
    const { ports, listing, live, failNext, open } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    failNext.push(attachError('not_found'));
    const observer = createBranchObserver(ports);

    await observer.sync();
    expect(observer.snapshot()).toEqual({ watching: 0, polling: 0 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(ports.readBranch).not.toHaveBeenCalled();

    await observer.sync();
    expect(open('ws/wt-1/root')).toHaveLength(1);
  });

  it('treats a HEAD event for a branch another writer recorded as a no-op', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    observer.noteRecorded({
      workspaceId: 'ws',
      worktreeId: 'wt-1',
      branchName: 'named',
    });
    live.set('ws/wt-1/root', 'named');
    watches[0]?.listener.onChange();
    await jest.advanceTimersByTimeAsync(100);

    expect(ports.readBranch).toHaveBeenCalledTimes(1);
    expect(ports.record).not.toHaveBeenCalled();
  });

  it('debounces lifecycle signals into one membership read', async () => {
    const { ports } = harness();
    const observer = createBranchObserver(ports);

    observer.requestSync();
    observer.requestSync();
    await jest.advanceTimersByTimeAsync(249);
    observer.requestSync();
    await jest.advanceTimersByTimeAsync(250);

    expect(ports.listCheckouts).toHaveBeenCalledTimes(1);
  });

  it('never rereads membership because of its own recording', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    live.set('ws/wt-1/root', 'feature');
    watches[0]?.listener.onChange();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(ports.record).toHaveBeenCalledTimes(1);
    expect(ports.listCheckouts).toHaveBeenCalledTimes(1);
  });

  it('closes every stream on stop, including one still attaching', async () => {
    const { ports, listing, live, watches } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    const observer = createBranchObserver(ports);
    await observer.sync();

    let release: (() => void) | undefined;
    ports.watchHead.mockImplementationOnce(
      (ref: BranchCheckout, listener: GitHeadWatchListener) =>
        new Promise((resolve) => {
          release = (): void => {
            const watch: FakeWatch = {
              key: keyOf(ref),
              listener,
              close: jest.fn(),
            };
            watches.push(watch);
            resolve({ close: watch.close });
          };
        }),
    );
    const ensured = observer.ensureWorktree({
      workspaceId: 'ws',
      worktreeId: 'wt-2',
      workspaceKind: 'single-repo',
      branchName: 'main',
    });
    await flush();
    observer.stop();
    release?.();
    await ensured;

    expect(watches).toHaveLength(2);
    expect(watches.map((watch) => watch.close.mock.calls.length)).toEqual([
      1, 1,
    ]);
    watches[0]?.listener.onChange();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(ports.readBranch).not.toHaveBeenCalled();
    expect(observer.snapshot()).toEqual({ watching: 0, polling: 0 });
  });

  it('reopens a stream that ended while its start was reading HEAD', async () => {
    const { ports, listing, live, watches, open } = harness();
    listing.checkouts = [checkout('wt-1')];
    live.set('ws/wt-1/root', 'main');
    ports.readStartBranch.mockImplementationOnce((ref) => {
      watches[0]?.listener.onEnd(null);
      return Promise.resolve(live.get(keyOf(ref)) ?? null);
    });
    const observer = createBranchObserver(ports);

    await observer.sync();
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(open('ws/wt-1/root')).toHaveLength(2);
    expect(observer.snapshot()).toEqual({ watching: 1, polling: 0 });
  });
});
