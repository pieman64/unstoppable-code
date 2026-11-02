import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnBackground,
  ChatTurnEffect,
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  createTurnOwnershipRecord,
  type TurnOwnershipRecord,
} from '../chat-turn-phase';
import {
  createChatTurnOwnershipSource,
  shouldHoldChatWake,
  type ChatTurnOwnershipSource,
  type ChatTurnStateSource,
} from '../chat-turn-ownership';
import type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
  ChatTurnStateScope,
} from '../chat-turn-state-handoff';
import type { TurnLifecycleOwnership } from '../chat-turn-phase';

const scope: ChatTurnStateScope = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};

const idleBackground: ChatTurnBackground = {
  native: [],
  managed: { live: 0, queued: 0 },
};

function stateWith(
  options: {
    current?: ChatTurnRecord;
    background?: ChatTurnBackground;
  } = {},
): PersistedChatTurnState {
  const background = options.background ?? idleBackground;
  return {
    ...serializeChatTurnState(initialChatTurnState()),
    phase:
      options.current !== undefined
        ? 'foreground'
        : background.native.length > 0 ||
            background.managed.live > 0 ||
            background.managed.queued > 0
          ? 'background'
          : 'idle',
    ...(options.current === undefined ? {} : { current: options.current }),
    background,
  };
}

function turn(id: string): ChatTurnRecord {
  return {
    id,
    origin: 'user',
    userMessageId: `${id}-message`,
    inputIds: [`${id}-message`, `${id}-follow-up`],
    startedAtMs: 1,
    pauses: [],
  };
}

type ChangeWithLifecycle = ChatTurnStateChange & {
  readonly lifecycle?: readonly TurnLifecycleOwnership[];
};

type CommitWithLifecycle = ChatTurnStateCommit & {
  readonly lifecycle?: readonly TurnLifecycleOwnership[];
  readonly effects?: readonly ChatTurnEffect[];
};

function lifecycle(
  transition: TurnLifecycleOwnership['transition'],
  id: string,
  generation: number,
): TurnLifecycleOwnership {
  return {
    turnId: id,
    generation,
    transition,
    inputIds: [`${id}-message`, `${id}-follow-up`],
  };
}

interface FakeStateSource extends ChatTurnStateSource {
  emitChange(change: ChangeWithLifecycle): void;
  emitCommit(commit: CommitWithLifecycle): void;
  setTurnState(state: PersistedChatTurnState | undefined): void;
  listenerCount(): number;
}

function createStateSource(
  initialState?: PersistedChatTurnState,
): FakeStateSource {
  let currentState = initialState;
  const changes = new Set<(change: ChatTurnStateChange) => void>();
  const commits = new Set<(commit: ChatTurnStateCommit) => void>();
  return {
    getTurnState: () => currentState,
    onTurnStateChange: (listener) => {
      changes.add(listener);
      return (): void => {
        changes.delete(listener);
      };
    },
    onTurnStateCommitted: (listener) => {
      commits.add(listener);
      return (): void => {
        commits.delete(listener);
      };
    },
    emitChange: (change): void => {
      currentState = change.state;
      for (const listener of Array.from(changes)) listener(change);
    },
    emitCommit: (commit): void => {
      currentState = commit.state;
      for (const listener of Array.from(commits)) listener(commit);
    },
    setTurnState: (state): void => {
      currentState = state;
    },
    listenerCount: () => changes.size + commits.size,
  };
}

function bind(
  ownership: ChatTurnOwnershipSource,
  source: FakeStateSource,
  loadCommitted: () => Promise<PersistedChatTurnState> = () =>
    Promise.resolve(stateWith()),
): () => void {
  return ownership.bind(source, () => loadCommitted());
}

function idleChange(generation: number): ChangeWithLifecycle {
  return {
    scope,
    state: stateWith(),
    effects: [],
    generation,
    cause: 'lifecycle',
  };
}

describe('ChatTurnOwnershipAggregate', () => {
  it('accepts a recreated handoff incarnation whose generations restarted, and drops an older one', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source, () => Promise.resolve(stateWith()));
    await ownership.hydrate(scope);
    const running = stateWith({ current: turn('evicted-turn') });
    source.emitChange({ ...idleChange(9), state: running, incarnation: 1 });
    source.emitCommit({ scope, state: running, generation: 9, incarnation: 1 });

    // Eviction recreated the handoff entry, so its generations restarted.
    source.emitChange({ ...idleChange(1), incarnation: 2 });
    source.emitCommit({
      scope,
      state: stateWith(),
      generation: 1,
      incarnation: 2,
    });
    expect(
      ownership.getSnapshot(scope).committed?.state.current,
    ).toBeUndefined();
    expect(ownership.getSnapshot(scope).receipt?.state.current).toBeUndefined();

    source.emitCommit({
      scope,
      state: running,
      generation: 12,
      incarnation: 1,
    });
    expect(
      ownership.getSnapshot(scope).committed?.state.current,
    ).toBeUndefined();
  });

  it('starts unknown, subscribes before hydrate, and keeps receipt state that races the read', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    let resolveLoad: ((state: PersistedChatTurnState) => void) | undefined;
    bind(
      ownership,
      source,
      () => new Promise((resolve) => (resolveLoad = resolve)),
    );

    expect(ownership.getSnapshot(scope).knowledge).toBe('unknown');
    const hydration = ownership.hydrate(scope);
    expect(ownership.getSnapshot(scope).knowledge).toBe('loading');

    const running = stateWith({ current: turn('receipt-turn') });
    source.emitChange({
      ...idleChange(3),
      state: running,
      lifecycle: [lifecycle('start', 'receipt-turn', 3)],
    });
    resolveLoad?.(stateWith());
    await hydration;

    const snapshot = ownership.getSnapshot(scope);
    expect(snapshot.knowledge).toBe('known');
    expect(snapshot.receipt).toEqual({ generation: 3, state: running });
    expect(snapshot.committed).toEqual({ generation: 0, state: stateWith() });
    expect(snapshot.unacknowledgedLifecycle).toEqual([
      lifecycle('start', 'receipt-turn', 3),
    ]);
    expect(shouldHoldChatWake(snapshot)).toBe(true);
  });

  it('leaves a failed hydration unknown instead of certifying idle', async () => {
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, createStateSource(), () =>
      Promise.reject(new Error('read failed')),
    );

    await expect(ownership.hydrate(scope)).rejects.toThrow('read failed');
    expect(ownership.getSnapshot(scope).knowledge).toBe('unknown');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('holds for receipt and committed foreground independently', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source, () => Promise.resolve(stateWith()));
    await ownership.hydrate(scope);

    const receiptRunning = stateWith({ current: turn('receipt-only') });
    source.emitChange({ ...idleChange(1), state: receiptRunning });
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);

    source.emitCommit({
      scope,
      state: stateWith({ current: turn('committed-only') }),
      generation: 1,
    });
    source.emitChange({ ...idleChange(2), state: stateWith() });
    expect(ownership.getSnapshot(scope).receipt?.state.current).toBeUndefined();
    expect(ownership.getSnapshot(scope).committed?.state.current?.id).toBe(
      'committed-only',
    );
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
  });

  it('retains coalesced root starts and ends until their committed lifecycle prefix arrives', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source, () => Promise.resolve(stateWith()));
    await ownership.hydrate(scope);
    const transitions = [
      lifecycle('start', 'coalesced-turn', 1),
      lifecycle('binding', 'coalesced-turn', 1),
      lifecycle('end', 'coalesced-turn', 1),
    ];

    source.emitChange({
      ...idleChange(1),
      lifecycle: transitions,
    });
    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toEqual(
      transitions,
    );
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);

    source.emitCommit({
      scope,
      state: stateWith(),
      generation: 1,
      lifecycle: transitions,
      effects: [
        {
          type: 'timer.open',
          timerId: 'coalesced-turn:timer',
          turnId: 'coalesced-turn',
          atMs: 1,
        },
        { type: 'turn.ended', turnId: 'coalesced-turn', outcome: 'completed' },
      ],
    });
    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toEqual([]);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('does not wake for queued host input, but holds for dispatch, stop, and removal ownership', async () => {
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, createStateSource(stateWith()), () =>
      Promise.resolve(stateWith()),
    );
    await ownership.hydrate(scope);

    ownership.setHostQueuedInputCount(scope, 4);
    expect(ownership.getSnapshot(scope).hostQueuedInputCount).toBe(4);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);

    const dispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('dispatch'),
      userMessageId: 'message',
    });
    expect(dispatch.reason).toBe('awaiting-start');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    expect(
      ownership.removeDispatchOwner(
        scope,
        dispatch.token,
        dispatch.operationEpoch + 1,
      ),
    ).toBe(false);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    expect(
      ownership.removeDispatchOwner(
        scope,
        dispatch.token,
        dispatch.operationEpoch,
      ),
    ).toBe(true);

    const stop = ownership.registerStopOwner(scope, {
      token: Symbol('stop'),
    });
    expect(stop.reason).toBe('awaiting-commit');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    expect(
      ownership.removeStopOwner(scope, stop.token, stop.operationEpoch),
    ).toBe(true);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);

    ownership.setRemovalAwaitingSettle(scope, true);
    expect(ownership.getSnapshot(scope).removalAwaitingSettle).toBe(true);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    ownership.setRemovalAwaitingSettle(scope, false);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('binds a dispatch owner to its turn and fences continuation replacement with token and epochs', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source, () => Promise.resolve(stateWith()));
    await ownership.hydrate(scope);

    const first = ownership.registerDispatchOwner(scope, {
      token: Symbol('first'),
      userMessageId: 'first-message',
    });
    const bound = ownership.bindDispatchOwner(
      scope,
      first.token,
      first.operationEpoch,
      'first-turn',
    );
    expect(bound).toMatchObject({
      kind: 'dispatch',
      token: first.token,
      turnId: 'first-turn',
      userMessageId: 'first-message',
      reason: 'awaiting-commit',
    });

    const beforeReplacement = ownership.getSnapshot(scope);
    const serviceEpoch = beforeReplacement.serviceEpoch;
    const nextToken = Symbol('continuation');
    const replacementRecord: TurnOwnershipRecord = createTurnOwnershipRecord({
      kind: 'dispatch',
      token: nextToken,
      userMessageId: 'next-message',
      operationEpoch: beforeReplacement.operationEpoch + 1,
    });
    expect(
      ownership.replaceOwner(
        scope,
        first.token,
        bound?.operationEpoch ?? -1,
        replacementRecord,
      ),
    ).toBe(true);
    expect(ownership.getSnapshot(scope).dispatchOwners[0]).toMatchObject({
      kind: 'dispatch',
      token: nextToken,
      userMessageId: 'next-message',
      reason: 'awaiting-start',
      operationEpoch: replacementRecord.operationEpoch,
    });
    expect(
      ownership.removeDispatchOwner(
        scope,
        first.token,
        bound?.operationEpoch ?? -1,
      ),
    ).toBe(false);
    const replacement = ownership.getSnapshot(scope).dispatchOwners[0];
    expect(replacement?.token).toBe(nextToken);
    expect(
      ownership.replaceDispatchOwner(
        scope,
        { token: nextToken, operationEpoch: replacement?.operationEpoch ?? -1 },
        { token: Symbol('stale') },
        Symbol('wrong-service'),
      ),
    ).toBeUndefined();

    const stop = ownership.registerStopOwner(scope, { token: Symbol('stop') });
    expect(
      ownership.replaceDispatchOwner(
        scope,
        { token: nextToken, operationEpoch: replacement?.operationEpoch ?? -1 },
        { token: Symbol('blocked') },
        serviceEpoch,
      ),
    ).toBeUndefined();
    ownership.removeStopOwner(scope, stop.token, stop.operationEpoch);

    source.emitChange({
      ...idleChange(2),
      state: stateWith({ current: turn('other-turn') }),
    });
    expect(
      ownership.replaceDispatchOwner(
        scope,
        { token: nextToken, operationEpoch: replacement?.operationEpoch ?? -1 },
        { token: Symbol('foreground-blocked') },
        serviceEpoch,
      ),
    ).toBeUndefined();
  });

  it('ignores stale persisted background until fresh, then retains live work while reconciling', async () => {
    const staleBackground: ChatTurnBackground = {
      native: [{ id: 'persisted-task', taskType: 'persistent-server' }],
      managed: { live: 0, queued: 0 },
    };
    const ownership = createChatTurnOwnershipSource();
    bind(
      ownership,
      createStateSource(stateWith({ background: staleBackground })),
      () => Promise.resolve(stateWith({ background: staleBackground })),
    );
    await ownership.hydrate(scope);

    ownership.markBackgroundReconciling(scope);
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe(
      'reconciling',
    );
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);

    ownership.markBackgroundFresh(scope);
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe('fresh');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);

    ownership.markBackgroundReconciling(scope);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    ownership.publishBackgroundFresh(scope, idleBackground);
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe('fresh');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('rotates service epochs without dropping host ownership or accepting old callbacks', async () => {
    const ownership = createChatTurnOwnershipSource();
    const firstSource = createStateSource(stateWith());
    const disposeFirst = bind(ownership, firstSource, () =>
      Promise.resolve(stateWith()),
    );
    await ownership.hydrate(scope);
    const owner = ownership.registerDispatchOwner(scope, {
      token: Symbol('survives-replacement'),
    });
    const firstEpoch = ownership.getSnapshot(scope).serviceEpoch;
    const secondSource = createStateSource(stateWith());
    bind(ownership, secondSource, () => Promise.resolve(stateWith()));
    const secondEpoch = ownership.getSnapshot(scope).serviceEpoch;

    expect(secondEpoch).not.toBe(firstEpoch);
    expect(ownership.getSnapshot(scope).dispatchOwners[0]?.token).toBe(
      owner.token,
    );
    expect(
      ownership.getSnapshot(scope).dispatchOwners[0]?.operationEpoch,
    ).toBeGreaterThan(owner.operationEpoch);
    expect(ownership.getSnapshot(scope).operationEpoch).toBeGreaterThan(
      owner.operationEpoch,
    );
    expect(firstSource.listenerCount()).toBe(0);

    firstSource.emitChange({
      ...idleChange(99),
      state: stateWith({ current: turn('stale-callback') }),
    });
    expect(ownership.getSnapshot(scope).receipt?.state.current).toBeUndefined();
    disposeFirst();
    expect(ownership.getSnapshot(scope).serviceEpoch).toBe(secondEpoch);

    await ownership.hydrate(scope);
    expect(ownership.getSnapshot(scope).knowledge).toBe('known');
    expect(ownership.getSnapshot(scope).dispatchOwners[0]?.token).toBe(
      owner.token,
    );
  });

  it('resets only one scope and disposes subscriptions idempotently', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    const disposeBinding = bind(ownership, source, () =>
      Promise.resolve(stateWith()),
    );
    await ownership.hydrate(scope);
    const otherScope: ChatTurnStateScope = {
      ...scope,
      chatId: 'other-chat',
    };
    await ownership.hydrate(otherScope);
    const first = ownership.registerDispatchOwner(scope, {
      token: Symbol('first-scope'),
    });
    const other = ownership.registerDispatchOwner(otherScope, {
      token: Symbol('other-scope'),
    });

    ownership.resetScope(scope);
    expect(ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    expect(ownership.getSnapshot(scope).knowledge).toBe('unknown');
    const resetOperationEpoch = ownership.getSnapshot(scope).operationEpoch;
    expect(ownership.getSnapshot(otherScope).dispatchOwners).toContainEqual(
      other,
    );
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
    const reRegistered = ownership.registerDispatchOwner(scope, {
      token: Symbol('after-reset'),
    });
    expect(reRegistered.operationEpoch).toBeGreaterThan(resetOperationEpoch);

    disposeBinding();
    disposeBinding();
    expect(source.listenerCount()).toBe(0);
    expect(ownership.getSnapshot(otherScope).dispatchOwners[0]?.token).toBe(
      other.token,
    );
    expect(
      ownership.getSnapshot(otherScope).dispatchOwners[0]?.operationEpoch,
    ).toBeGreaterThan(other.operationEpoch);
    expect(first.operationEpoch).toBeGreaterThan(0);

    ownership.dispose();
    expect(ownership.getSnapshot(otherScope).dispatchOwners).toEqual([]);
  });

  it('atomically replaces an exact stop owner with a fresh dispatch owner', async () => {
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, createStateSource(stateWith()));
    await ownership.hydrate(scope);
    const stop = ownership.registerStopOwner(scope, {
      token: Symbol('stop-resume'),
    });
    const snapshot = ownership.getSnapshot(scope);
    const dispatchToken = Symbol('resumed-dispatch');
    const replacement = createTurnOwnershipRecord({
      kind: 'dispatch',
      token: dispatchToken,
      userMessageId: 'resumed-message',
      operationEpoch: snapshot.operationEpoch + 1,
    });

    expect(
      ownership.replaceOwner(
        scope,
        stop.token,
        stop.operationEpoch,
        replacement,
      ),
    ).toBe(true);
    expect(ownership.getSnapshot(scope).stopOwners).toEqual([]);
    expect(ownership.getSnapshot(scope).dispatchOwners).toEqual([replacement]);
    expect(
      ownership.removeStopOwner(scope, stop.token, stop.operationEpoch),
    ).toBe(false);
  });

  it('keeps operation epochs stable for same-attempt observer updates', async () => {
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, createStateSource(stateWith()));
    await ownership.hydrate(scope);
    const dispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('same-attempt'),
      userMessageId: 'attempt-message',
    });
    const attemptEpoch = dispatch.operationEpoch;

    expect(
      ownership.bindDispatchOwner(
        scope,
        dispatch.token,
        dispatch.operationEpoch,
        'attempt-turn',
      )?.operationEpoch,
    ).toBe(attemptEpoch);
    ownership.setHostQueuedInputCount(scope, 3);
    ownership.setRemovalAwaitingSettle(scope, true);
    ownership.markBackgroundReconciling(scope);
    ownership.publishBackgroundFresh(scope, idleBackground);
    ownership.setRemovalAwaitingSettle(scope, false);

    expect(ownership.getSnapshot(scope).operationEpoch).toBe(attemptEpoch);
    expect(
      ownership.removeDispatchOwner(
        scope,
        dispatch.token,
        dispatch.operationEpoch,
      ),
    ).toBe(true);
    expect(ownership.getSnapshot(scope).operationEpoch).toBe(attemptEpoch);

    const nextAttempt = ownership.registerDispatchOwner(scope, {
      token: dispatch.token,
    });
    expect(nextAttempt.operationEpoch).toBeGreaterThan(attemptEpoch);
    expect(
      ownership.removeDispatchOwner(
        scope,
        dispatch.token,
        dispatch.operationEpoch,
      ),
    ).toBe(false);
  });

  it('retains known foreground power through service replacement until fresh hydration', async () => {
    const ownership = createChatTurnOwnershipSource();
    const firstSource = createStateSource(stateWith());
    bind(ownership, firstSource);
    await ownership.hydrate(scope);
    const running = stateWith({ current: turn('surviving-foreground') });
    firstSource.emitChange({ ...idleChange(1), state: running });
    firstSource.emitCommit({ scope, state: running, generation: 1 });
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);

    const nextSource = createStateSource(stateWith());
    bind(ownership, nextSource);
    const replacementSnapshot = ownership.getSnapshot(scope);
    expect(replacementSnapshot.knowledge).toBe('unknown');
    expect(replacementSnapshot.receipt?.state.current?.id).toBe(
      'surviving-foreground',
    );
    expect(replacementSnapshot.committed?.state.current?.id).toBe(
      'surviving-foreground',
    );
    expect(shouldHoldChatWake(replacementSnapshot)).toBe(true);

    await ownership.hydrate(scope);
    expect(ownership.getSnapshot(scope).receipt?.state.current).toBeUndefined();
    expect(
      ownership.getSnapshot(scope).committed?.state.current,
    ).toBeUndefined();
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('does not release a dispatch owner when a different turn reuses its input id', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source);
    await ownership.hydrate(scope);
    const dispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('old-turn-dispatch'),
      userMessageId: 'reused-input',
    });
    ownership.bindDispatchOwner(
      scope,
      dispatch.token,
      dispatch.operationEpoch,
      'old-turn',
    );

    source.emitCommit({
      scope,
      state: stateWith({
        current: {
          ...turn('new-turn'),
          inputIds: ['reused-input'],
        },
      }),
      generation: 4,
      lifecycle: [
        {
          turnId: 'new-turn',
          generation: 4,
          transition: 'start',
          inputIds: ['reused-input'],
        },
      ],
    });

    expect(ownership.getSnapshot(scope).dispatchOwners).toEqual([
      expect.objectContaining({
        token: dispatch.token,
        turnId: 'old-turn',
        operationEpoch: dispatch.operationEpoch,
      }),
    ]);
  });

  it('infers a same-turn binding receipt and binds dispatches for every input id', async () => {
    const initialCurrent: ChatTurnRecord = {
      ...turn('binding-turn'),
      inputIds: ['root-message'],
    };
    const source = createStateSource(stateWith({ current: initialCurrent }));
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, source, () =>
      Promise.resolve(stateWith({ current: initialCurrent })),
    );
    await ownership.hydrate(scope);
    const rootDispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('root-input'),
      userMessageId: 'root-message',
    });
    const followupDispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('followup-input'),
      userMessageId: 'followup-message',
    });
    const expandedCurrent: ChatTurnRecord = {
      ...initialCurrent,
      inputIds: ['root-message', 'followup-message'],
    };

    source.emitChange({
      ...idleChange(2),
      state: stateWith({ current: expandedCurrent }),
    });

    const snapshot = ownership.getSnapshot(scope);
    expect(snapshot.unacknowledgedLifecycle).toContainEqual({
      turnId: 'binding-turn',
      generation: 2,
      transition: 'binding',
      inputIds: ['root-message', 'followup-message', 'binding-turn-message'],
    });
    expect(snapshot.dispatchOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: rootDispatch.token,
          turnId: 'binding-turn',
          reason: 'awaiting-commit',
          operationEpoch: rootDispatch.operationEpoch,
        }),
        expect.objectContaining({
          token: followupDispatch.token,
          turnId: 'binding-turn',
          reason: 'awaiting-commit',
          operationEpoch: followupDispatch.operationEpoch,
        }),
      ]),
    );
  });

  it('uses fresh canonical backgrounds, retains known work during reconciliation, and trusts lifecycle updates', async () => {
    const liveBackground: ChatTurnBackground = {
      native: [],
      managed: { live: 1, queued: 0 },
    };
    const source = createStateSource(stateWith());
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, source);
    await ownership.hydrate(scope);
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe(
      'reconciling',
    );
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);

    source.emitChange({
      ...idleChange(1),
      state: stateWith({ background: liveBackground }),
    });
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe('fresh');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);

    ownership.markBackgroundReconciling(scope);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    source.emitCommit({ scope, state: stateWith(), generation: 2 });
    expect(ownership.getSnapshot(scope).backgroundFreshness).toBe('fresh');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);

    ownership.publishBackgroundFresh(scope, liveBackground);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(true);
    ownership.publishBackgroundFresh(scope, idleBackground);
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });

  it('fails hydration closed for malformed persisted state', async () => {
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, createStateSource(), () =>
      Promise.resolve(JSON.parse('{"phase":"idle"}')),
    );

    await expect(ownership.hydrate(scope)).rejects.toThrow();
    expect(ownership.getSnapshot(scope).knowledge).toBe('unknown');
    expect(ownership.getSnapshot(scope).committed).toBeUndefined();
    expect(ownership.getSnapshot(scope).receipt).toBeUndefined();
  });

  it('does not overwrite a newer commit with a racing hydrate and fences hydration after reset', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    let resolveFirstLoad: ((state: PersistedChatTurnState) => void) | undefined;
    bind(
      ownership,
      source,
      () =>
        new Promise((resolve) => {
          resolveFirstLoad = resolve;
        }),
    );
    const hydration = ownership.hydrate(scope);
    const newerState = stateWith({ current: turn('newer-commit') });
    source.emitCommit({ scope, state: newerState, generation: 9 });
    resolveFirstLoad?.(stateWith());
    await hydration;
    expect(ownership.getSnapshot(scope).committed).toEqual({
      generation: 9,
      state: newerState,
    });
    expect(ownership.getSnapshot(scope).receipt).toEqual({
      generation: 9,
      state: newerState,
    });

    let resolveStaleLoad: ((state: PersistedChatTurnState) => void) | undefined;
    bind(
      ownership,
      source,
      () =>
        new Promise((resolve) => {
          resolveStaleLoad = resolve;
        }),
    );
    const staleHydration = ownership.hydrate(scope);
    ownership.resetScope(scope);
    resolveStaleLoad?.(newerState);
    await staleHydration;
    expect(ownership.getSnapshot(scope).knowledge).toBe('unknown');
    expect(ownership.getSnapshot(scope).receipt).toBeUndefined();
    expect(ownership.getSnapshot(scope).committed).toBeUndefined();
  });

  it('acknowledges coalesced lifecycle by identity when the commit prefix has richer inputs', async () => {
    const ownership = createChatTurnOwnershipSource();
    const source = createStateSource(stateWith());
    bind(ownership, source);
    await ownership.hydrate(scope);
    const effects: ChatTurnEffect[] = [
      {
        type: 'timer.open',
        timerId: 'coalesced-prefix:timer',
        turnId: 'coalesced-prefix',
        atMs: 10,
      },
      {
        type: 'turn.ended',
        turnId: 'coalesced-prefix',
        outcome: 'completed',
      },
    ];
    source.emitChange({ ...idleChange(5), effects });
    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toEqual([
      {
        turnId: 'coalesced-prefix',
        generation: 5,
        transition: 'start',
        inputIds: [],
      },
      {
        turnId: 'coalesced-prefix',
        generation: 5,
        transition: 'end',
        inputIds: [],
      },
    ]);

    source.emitCommit({
      scope,
      state: stateWith(),
      generation: 5,
      lifecycle: [
        lifecycle('start', 'coalesced-prefix', 5),
        lifecycle('end', 'coalesced-prefix', 5),
      ],
    });

    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toEqual([]);
  });

  it('does not let an equal-generation new service prefix acknowledge old lifecycle without hydration', async () => {
    const ownership = createChatTurnOwnershipSource();
    const firstSource = createStateSource(stateWith());
    bind(ownership, firstSource);
    await ownership.hydrate(scope);
    firstSource.emitChange({
      ...idleChange(1),
      lifecycle: [lifecycle('start', 'old-service-turn', 1)],
    });
    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toHaveLength(
      1,
    );

    const nextSource = createStateSource(stateWith());
    bind(ownership, nextSource);
    nextSource.emitCommit({
      scope,
      state: stateWith(),
      generation: 1,
      lifecycle: [lifecycle('start', 'old-service-turn', 1)],
    });

    expect(ownership.getSnapshot(scope).unacknowledgedLifecycle).toHaveLength(
      1,
    );
  });
});

describe('cold background notification freshness', () => {
  it('does not turn a disk hydration notification into live background proof', async () => {
    const stale = stateWith({
      background: {
        native: [{ id: 'stale-server' }],
        managed: { live: 0, queued: 0 },
      },
    });
    const source = createStateSource(stale);
    const ownership = createChatTurnOwnershipSource();
    bind(ownership, source, () => Promise.resolve(stale));
    source.emitChange({
      scope,
      state: stale,
      effects: [],
      generation: 0,
      cause: 'hydrate',
    });
    await ownership.hydrate(scope);
    expect(ownership.getSnapshot(scope).backgroundFreshness).not.toBe('fresh');
    expect(shouldHoldChatWake(ownership.getSnapshot(scope))).toBe(false);
  });
});
