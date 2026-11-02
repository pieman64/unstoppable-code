import type {
  ChatRuntimeState,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  canonicalTurnStateFor,
  confirmCanonicalTurn,
  type ConfirmCanonicalTurnDeps,
} from '../turn-confirmation';
import { composerTurnActivity } from '../turn-activity';

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function snapshot(
  revision: number,
  runtime?: ChatRuntimeState,
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    revision,
    tabsFile: { version: 1, tabs: [], activeTabId: 'chat-1' },
    archives: [],
    runtimeByChatId: runtime ? { 'chat-1': runtime } : {},
    queue: [],
  };
}

function deps(
  overrides: Partial<ConfirmCanonicalTurnDeps>,
): ConfirmCanonicalTurnDeps {
  return {
    getState: () => Promise.resolve(snapshot(5)),
    appliedRevision: () => 5,
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('canonicalTurnStateFor', () => {
  it.each(['starting', 'streaming', 'completing', 'awaiting_input'] as const)(
    'reads %s as active',
    (status) => {
      expect(canonicalTurnStateFor({ status, queuedMessageIds: [] })).toBe(
        'active',
      );
    },
  );

  it.each(['idle', 'queued', 'completed', 'failed', 'cancelled'] as const)(
    'reads %s as inactive',
    (status) => {
      expect(canonicalTurnStateFor({ status, queuedMessageIds: [] })).toBe(
        'inactive',
      );
    },
  );

  it('reads a missing runtime as inactive', () => {
    expect(canonicalTurnStateFor(undefined)).toBe('inactive');
  });
});

describe('confirmCanonicalTurn', () => {
  it('confirms an active turn with its id and revision', async () => {
    const result = await confirmCanonicalTurn(
      target,
      deps({
        getState: () =>
          Promise.resolve(
            snapshot(7, {
              status: 'streaming',
              queuedMessageIds: [],
              activeTurn: { userMessageId: 'user-1', startedAt: 1 },
            }),
          ),
      }),
    );
    expect(result).toEqual({
      state: 'active',
      userMessageId: 'user-1',
      revision: 7,
    });
  });

  it('reports inactive when main has no running turn', async () => {
    const result = await confirmCanonicalTurn(
      target,
      deps({
        getState: () =>
          Promise.resolve(
            snapshot(6, { status: 'completed', queuedMessageIds: [] }),
          ),
      }),
    );
    expect(result).toEqual({ state: 'inactive', revision: 6 });
  });

  it('is unknown when the read fails', async () => {
    const result = await confirmCanonicalTurn(
      target,
      deps({ getState: () => Promise.reject(new Error('ipc failed')) }),
    );
    expect(result).toEqual({ state: 'unknown' });
  });

  it('is unknown when the read times out', async () => {
    const result = await confirmCanonicalTurn(
      target,
      deps({ getState: () => new Promise(() => undefined), timeoutMs: 10 }),
    );
    expect(result).toEqual({ state: 'unknown' });
  });

  it('is unknown when the read is older than the applied revision', async () => {
    const result = await confirmCanonicalTurn(
      target,
      deps({
        getState: () =>
          Promise.resolve(
            snapshot(4, { status: 'streaming', queuedMessageIds: [] }),
          ),
        appliedRevision: () => 5,
      }),
    );
    expect(result).toEqual({ state: 'unknown' });
  });

  it('shares one read between concurrent callers of a scope', async () => {
    let resolveRead: (value: ChatStateSnapshot) => void = () => undefined;
    const getState = jest.fn(
      () =>
        new Promise<ChatStateSnapshot>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const first = confirmCanonicalTurn(target, deps({ getState }));
    const second = confirmCanonicalTurn(
      { ...target, chatId: 'chat-2' },
      deps({ getState }),
    );
    resolveRead(snapshot(5, { status: 'idle', queuedMessageIds: [] }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { state: 'inactive', revision: 5 },
      { state: 'inactive', revision: 5 },
    ]);
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('refreshes the scope when a newer read contradicts the cached runtime', async () => {
    const refresh = jest.fn();
    const cached: ChatRuntimeState = {
      status: 'streaming',
      queuedMessageIds: [],
    };
    const completed = snapshot(8, {
      status: 'completed',
      queuedMessageIds: [],
    });
    await confirmCanonicalTurn(
      target,
      deps({
        getState: () => Promise.resolve(completed),
        cachedRuntime: () => cached,
        refresh,
      }),
    );
    expect(refresh).toHaveBeenCalledWith('project-1', 'worktree-1');

    // Agreement, or a read at the applied revision, refreshes nothing.
    refresh.mockClear();
    await confirmCanonicalTurn(
      target,
      deps({
        getState: () =>
          Promise.resolve(
            snapshot(8, { status: 'streaming', queuedMessageIds: [] }),
          ),
        cachedRuntime: () => cached,
        refresh,
      }),
    );
    await confirmCanonicalTurn(
      target,
      deps({
        getState: () => Promise.resolve(completed),
        appliedRevision: () => 8,
        cachedRuntime: () => cached,
        refresh,
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('composerTurnActivity', () => {
  const lease = {
    userMessageId: 'user-1',
    kind: 'send' as const,
    issuedAt: 1_000,
    deadline: 16_000,
    state: 'pending' as const,
  };

  it('follows canonical runtime over the tab status', () => {
    expect(
      composerTurnActivity(
        { status: 'streaming' },
        { status: 'completed', queuedMessageIds: [] },
        2_000,
      ),
    ).toBe('idle');
    expect(
      composerTurnActivity(
        { status: 'idle' },
        { status: 'streaming', queuedMessageIds: [] },
        2_000,
      ),
    ).toBe('active');
  });

  it('reads a pending lease as sending until its deadline', () => {
    const runtime: ChatRuntimeState = {
      status: 'completed',
      queuedMessageIds: [],
    };
    expect(
      composerTurnActivity(
        { status: 'idle', sendingLease: lease },
        runtime,
        2_000,
      ),
    ).toBe('sending');
    expect(
      composerTurnActivity(
        { status: 'idle', sendingLease: lease },
        runtime,
        16_000,
      ),
    ).toBe('idle');
    expect(
      composerTurnActivity(
        { status: 'idle', sendingLease: { ...lease, state: 'acknowledged' } },
        runtime,
        2_000,
      ),
    ).toBe('idle');
  });

  it('falls back to the tab status when the scope has no runtime entry', () => {
    expect(
      composerTurnActivity({ status: 'streaming' }, undefined, 2_000),
    ).toBe('active');
    expect(composerTurnActivity({ status: 'idle' }, undefined, 2_000)).toBe(
      'idle',
    );
  });
});
