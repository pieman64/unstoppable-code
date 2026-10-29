import {
  bindTerminalClient,
  requireTerminalClient,
  requireTerminalClientLifetime,
  registerTerminalClientLifecycle,
} from '../terminal-client-binding';
import {
  createTerminalStore,
  useTerminalStore,
  ensureTerminalWorktreeHydrated,
  ensureTerminalExitSubscription,
  resetTerminalExitSubscriptionForTesting,
} from '../terminal-store';
import {
  useTerminalActivityStore,
  removeTerminalActivityEntries,
} from '../terminal-activity-store';
import { createFakeTerminalClient } from './fake-terminal-client';
import type {
  LoadWorktreeTerminalStateResponse,
  TerminalSession,
} from '@canopy/protocol/terminal';

const session: TerminalSession = {
  id: 'terminal',
  projectId: 'project',
  worktreeId: 'worktree',
  shell: 'zsh',
  shellBasename: 'zsh',
  cwd: '/',
  createdAt: 1,
};
const exit = {
  terminalId: session.id,
  projectId: session.projectId,
  worktreeId: session.worktreeId,
  exitCode: 3,
  signal: null,
  occurredAt: 'now',
};
const response: LoadWorktreeTerminalStateResponse = {
  drawerCollapsed: true,
  groups: [],
  activeGroupId: null,
  nextGroupOrdinal: 1,
  groupOrdinals: {},
  terminalCustomNames: {},
  groupCustomNames: {},
  terminals: [],
  liveTerminalIds: [],
};
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve: (value): void => {
      resolveValue?.(value);
    },
    reject: (error): void => {
      rejectValue?.(error);
    },
  };
}

describe('terminal host lifetime', () => {
  const disposers: (() => void)[] = [];
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    disposers.reverse().forEach((dispose) => dispose());
    disposers.length = 0;
    jest.useRealTimers();
  });
  function bind(
    fake = createFakeTerminalClient(),
  ): ReturnType<typeof createFakeTerminalClient> {
    disposers.push(bindTerminalClient(fake.client));
    return fake;
  }
  it('requires a host and makes initial binding inert', () => {
    expect(() => requireTerminalClient()).toThrow('bindTerminalClient');
    const fake = bind();
    expect(requireTerminalClient()).toBe(fake.client);
    expect(fake.listenerCount('terminal.exit')).toBe(0);
    expect(fake.calls.queries['terminal.list']).not.toHaveBeenCalled();
  });
  it('captures a binding token that invalidates even when the same client is rebound', () => {
    expect(requireTerminalClientLifetime).toThrow('bindTerminalClient');
    const fake = bind();
    const first = requireTerminalClientLifetime();
    expect(first.client).toBe(fake.client);
    expect(first.isCurrent()).toBe(true);
    bind(fake);
    const replacement = requireTerminalClientLifetime();
    expect(first.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
    disposers[disposers.length - 1]?.();
    expect(replacement.isCurrent()).toBe(false);
  });
  it('subscribes once, reconnects exit events and ignores obsolete disposers', () => {
    const first = bind();
    ensureTerminalExitSubscription();
    ensureTerminalExitSubscription();
    expect(first.listenerCount('terminal.exit')).toBe(1);
    const second = bind();
    expect(first.listenerCount('terminal.exit')).toBe(0);
    expect(second.listenerCount('terminal.exit')).toBe(1);
    useTerminalStore.getState().addGroupWithTerminal(session);
    disposers[0]();
    first.emit('terminal.exit', exit);
    expect(
      useTerminalStore.getState().worktrees['project/worktree'].sessions
        .terminal.live,
    ).toBe(true);
    second.emit('terminal.exit', exit);
    expect(
      useTerminalStore.getState().worktrees['project/worktree'].sessions
        .terminal.live,
    ).toBe(false);
    resetTerminalExitSubscriptionForTesting();
    expect(second.listenerCount('terminal.exit')).toBe(0);
  });
  it('resets both stores and cancels persistence and pending hydration on host change', async () => {
    const first = bind();
    const pending = deferred<LoadWorktreeTerminalStateResponse>();
    first.calls.queries['terminal.worktreeState.get'].mockReturnValue(
      pending.promise,
    );
    const hydration = ensureTerminalWorktreeHydrated('old', 'worktree');
    useTerminalStore.getState().addGroupWithTerminal(session);
    const group =
      useTerminalStore.getState().worktrees['project/worktree'].groups[0];
    useTerminalStore
      .getState()
      .setSplitSizes('project', 'worktree', group.id, [1]);
    useTerminalActivityStore.getState().handleExit(exit);
    const second = bind();
    expect(useTerminalStore.getState().worktrees).toEqual({});
    expect(useTerminalActivityStore.getState().entriesByWorktree).toEqual({});
    pending.resolve(response);
    await hydration;
    jest.runAllTimers();
    expect(useTerminalStore.getState().worktrees).toEqual({});
    expect(
      second.calls.commands['terminal.worktreeState.save'],
    ).not.toHaveBeenCalled();
    expect(
      first.calls.commands['terminal.worktreeState.save'],
    ).toHaveBeenCalledTimes(1);
  });
  it('does not let old hydration failure evict the replacement promise', async () => {
    const first = bind();
    const old = deferred<LoadWorktreeTerminalStateResponse>();
    first.calls.queries['terminal.worktreeState.get'].mockReturnValue(
      old.promise,
    );
    const oldHydration = ensureTerminalWorktreeHydrated('project', 'worktree');
    const rejected = expect(oldHydration).rejects.toThrow('old');
    const second = bind();
    const current = deferred<LoadWorktreeTerminalStateResponse>();
    second.calls.queries['terminal.worktreeState.get'].mockReturnValue(
      current.promise,
    );
    const newHydration = ensureTerminalWorktreeHydrated('project', 'worktree');
    old.reject(new Error('old'));
    await rejected;
    expect(ensureTerminalWorktreeHydrated('project', 'worktree')).toBe(
      newHydration,
    );
    current.resolve(response);
    await newHydration;
  });
  it.each(['resolve', 'reject'] as const)(
    'keeps an in-flight save on its original host when it %ss after rebinding',
    async (settlement) => {
      const first = bind();
      const pendingSave = deferred<void>();
      first.calls.commands['terminal.worktreeState.save'].mockReturnValueOnce(
        pendingSave.promise,
      );
      useTerminalStore.getState().addGroupWithTerminal(session);
      expect(
        first.calls.commands['terminal.worktreeState.save'],
      ).toHaveBeenCalledTimes(1);

      const second = bind();
      const replacementSession: TerminalSession = {
        ...session,
        id: 'replacement-terminal',
      };
      useTerminalStore.getState().addGroupWithTerminal(replacementSession);
      if (settlement === 'resolve') {
        pendingSave.resolve(undefined);
      } else {
        pendingSave.reject(new Error('Previous host disconnected'));
      }
      await jest.advanceTimersByTimeAsync(0);

      expect(
        first.calls.commands['terminal.worktreeState.save'],
      ).toHaveBeenCalledTimes(1);
      expect(
        second.calls.commands['terminal.worktreeState.save'],
      ).toHaveBeenCalledTimes(1);
      expect(
        second.calls.commands['terminal.worktreeState.save'],
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          groups: [
            expect.objectContaining({
              terminalIds: ['replacement-terminal'],
            }),
          ],
        }),
      );
      expect(
        Object.keys(
          useTerminalStore.getState().worktrees['project/worktree'].sessions,
        ),
      ).toEqual(['replacement-terminal']);
    },
  );
  it('owns acquired feeds, reconnects them and fences stale callbacks on disposal', () => {
    const first = bind();
    const received: number[] = [];
    let late: (() => void) | undefined;
    const release = registerTerminalClientLifecycle(({ client, isCurrent }) => {
      late = (): void => {
        if (isCurrent()) received.push(1);
      };
      return client.subscribe('terminal.exit', late);
    });
    const oldCallback = late;
    const second = bind();
    oldCallback?.();
    second.emit('terminal.exit', exit);
    expect(received).toEqual([1]);
    expect(first.listenerCount('terminal.exit')).toBe(0);
    disposers[1]();
    late?.();
    expect(received).toEqual([1]);
    expect(second.listenerCount('terminal.exit')).toBe(0);
    release();
    release();
  });
  it('unregisters a consumer without affecting another acquisition', () => {
    bind();
    const acquire = (): (() => void) =>
      registerTerminalClientLifecycle(({ client }) =>
        client.subscribe('terminal.exit', () => {}),
      );
    const old = acquire();
    old();
    const current = acquire();
    const second = bind();
    old();
    expect(second.listenerCount('terminal.exit')).toBe(1);
    current();
    expect(second.listenerCount('terminal.exit')).toBe(0);
  });
  it('isolates factory stores and their hydration and timers', async () => {
    const one = createFakeTerminalClient();
    const two = createFakeTerminalClient();
    const a = createTerminalStore(() => one.client);
    const b = createTerminalStore(() => two.client);
    a.store.getState().addGroupWithTerminal(session);
    expect(b.store.getState().worktrees).toEqual({});
    await b.ensureHydrated('project', 'worktree');
    expect(
      one.calls.queries['terminal.worktreeState.get'],
    ).not.toHaveBeenCalled();
    a.reset();
    b.reset();
  });
  it('clears activity entries and orphaned close markers for managed eviction', () => {
    bind();
    useTerminalActivityStore.getState().handleExit(exit);
    useTerminalActivityStore.getState().markUserInitiatedClose('terminal');
    useTerminalActivityStore.getState().markUserInitiatedClose('orphan');
    removeTerminalActivityEntries(['terminal', 'orphan']);
    expect(useTerminalActivityStore.getState().entriesByWorktree).toEqual({});
    expect(
      useTerminalActivityStore.getState().userInitiatedCloseTerminalIds.size,
    ).toBe(0);
  });
  it('finishes every cleanup and reset even if a consumer cleanup throws', () => {
    const fake = bind();
    const releaseBroken = registerTerminalClientLifecycle(() => (): void => {
      throw new Error('cleanup failed');
    });
    const releaseFeed = registerTerminalClientLifecycle(({ client }) =>
      client.subscribe('terminal.exit', () => {}),
    );
    useTerminalStore.getState().addGroupWithTerminal(session);
    expect(() => disposers[0]()).toThrow('cleanup failed');
    expect(fake.listenerCount('terminal.exit')).toBe(0);
    expect(useTerminalStore.getState().worktrees).toEqual({});
    releaseBroken();
    releaseFeed();
  });
  it('unwinds a failed binding and preserves its acquisition error when cleanup throws', () => {
    const first = bind();
    const failed = createFakeTerminalClient();
    const acquisitionError = new Error('acquisition failed');
    const snapshots: (() => boolean)[] = [];
    const releaseExit = registerTerminalClientLifecycle(
      ({ client, isCurrent }) => {
        snapshots.push(isCurrent);
        const unsubscribe = client.subscribe('terminal.exit', () => {});
        if (client === failed.client) {
          useTerminalStore.getState().addGroupWithTerminal(session);
          useTerminalActivityStore.getState().handleExit(exit);
        }
        return (): void => {
          unsubscribe();
          if (client === failed.client) throw new Error('cleanup failed');
        };
      },
    );
    const releaseRunning = registerTerminalClientLifecycle(
      ({ client, isCurrent }) => {
        snapshots.push(isCurrent);
        return client.subscribe('terminal.running-changed', () => {});
      },
    );
    const releaseFailing = registerTerminalClientLifecycle(
      ({ client, isCurrent }) => {
        snapshots.push(isCurrent);
        if (client === failed.client) throw acquisitionError;
        return (): void => {};
      },
    );
    try {
      let thrownError: unknown;
      try {
        bindTerminalClient(failed.client);
      } catch (error: unknown) {
        thrownError = error;
      }
      expect(thrownError).toBe(acquisitionError);
      disposers[0]();
      expect(() => requireTerminalClient()).toThrow('bindTerminalClient');
      expect(first.listenerCount('terminal.exit')).toBe(0);
      expect(first.listenerCount('terminal.running-changed')).toBe(0);
      expect(failed.listenerCount('terminal.exit')).toBe(0);
      expect(failed.listenerCount('terminal.running-changed')).toBe(0);
      expect(snapshots.every((isCurrent) => !isCurrent())).toBe(true);
      expect(useTerminalStore.getState().worktrees).toEqual({});
      expect(useTerminalActivityStore.getState().entriesByWorktree).toEqual({});
      const recovered = bind();
      expect(requireTerminalClient()).toBe(recovered.client);
      expect(recovered.listenerCount('terminal.exit')).toBe(1);
      expect(recovered.listenerCount('terminal.running-changed')).toBe(1);
      releaseExit();
      releaseExit();
      expect(recovered.listenerCount('terminal.exit')).toBe(0);
      expect(recovered.listenerCount('terminal.running-changed')).toBe(1);
      releaseRunning();
      expect(recovered.listenerCount('terminal.running-changed')).toBe(0);
    } finally {
      // On the RED implementation this also releases resources stranded by the
      // failed bind, so the regression does not contaminate subsequent cases.
      try {
        releaseExit();
      } catch {
        /* The cleanup failure is exercised above. */
      }
      releaseRunning();
      releaseFailing();
    }
  });
  it('removes a failed new registration and invalidates its captured lifetime', () => {
    const first = bind();
    const snapshots: (() => boolean)[] = [];
    let acquisitionCount = 0;
    const acquisitionError = new Error('new registration failed');
    const acquire = ({
      isCurrent,
    }: {
      isCurrent: () => boolean;
    }): (() => void) => {
      snapshots.push(isCurrent);
      acquisitionCount += 1;
      if (acquisitionCount === 1) throw acquisitionError;
      return (): void => {};
    };
    expect(() => registerTerminalClientLifecycle(acquire)).toThrow(
      acquisitionError,
    );
    expect(requireTerminalClient()).toBe(first.client);
    expect(snapshots.every((isCurrent) => !isCurrent())).toBe(true);
    const second = bind();
    expect(requireTerminalClient()).toBe(second.client);
    expect(acquisitionCount).toBe(1);
  });
});
