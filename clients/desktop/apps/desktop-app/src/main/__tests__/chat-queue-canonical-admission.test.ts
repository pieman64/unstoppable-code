import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnBackground,
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import { ChatQueueService } from '../services/chat-queue-service';
import {
  ChatDispatchAuthorizationRegistry,
  type AuthorizedChatDispatch,
  type ChatDispatchOutcome,
} from '../services/chat-dispatch-authorization';
import {
  createChatTurnOwnershipSource,
  shouldHoldChatWake,
  type ChatTurnStateSource,
} from '../services/chat-turn-ownership';
import type { TurnLifecycleOwnership } from '../services/chat-turn-phase';
import type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
} from '../services/chat-turn-state-handoff';

const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
const idleBackground: ChatTurnBackground = {
  native: [],
  managed: { live: 0, queued: 0 },
};

function state(
  options: { current?: ChatTurnRecord; background?: ChatTurnBackground } = {},
): PersistedChatTurnState {
  const background = options.background ?? idleBackground;
  return {
    ...serializeChatTurnState(initialChatTurnState()),
    phase: options.current
      ? 'foreground'
      : background.managed.live > 0 || background.native.length > 0
        ? 'background'
        : 'idle',
    ...(options.current ? { current: options.current } : {}),
    background,
  };
}

function turn(id: string, userMessageId: string): ChatTurnRecord {
  return {
    id,
    origin: 'user',
    userMessageId,
    inputIds: [userMessageId],
    startedAtMs: 1,
    pauses: [],
  };
}

function lifecycle(
  transition: TurnLifecycleOwnership['transition'],
  record: ChatTurnRecord,
  generation: number,
): TurnLifecycleOwnership {
  return {
    turnId: record.id,
    generation,
    transition,
    inputIds: record.inputIds ?? [],
  };
}

function request(userMessageId: string): ChatSendMessageRequest {
  return { ...scope, userMessageId, text: userMessageId };
}

type Outcome = (
  authorization: AuthorizedChatDispatch,
) => ChatDispatchOutcome | undefined;

function harness(
  loadCommitted?: () => Promise<PersistedChatTurnState>,
  outcomes: Outcome[] = [],
): {
  service: ChatQueueService;
  ownership: ReturnType<typeof createChatTurnOwnershipSource>;
  dispatched: string[];
  authorizations: Array<AuthorizedChatDispatch | undefined>;
  change(
    next: Omit<ChatTurnStateChange, 'scope' | 'effects' | 'cause'> & {
      lifecycle?: readonly TurnLifecycleOwnership[];
    },
  ): void;
  commit(next: Omit<ChatTurnStateCommit, 'scope'>): void;
} {
  let current: PersistedChatTurnState | undefined = state();
  const changes = new Set<(change: ChatTurnStateChange) => void>();
  const commits = new Set<(commit: ChatTurnStateCommit) => void>();
  const source: ChatTurnStateSource = {
    getTurnState: () => current,
    onTurnStateChange: (listener) => {
      changes.add(listener);
      return (): void => void changes.delete(listener);
    },
    onTurnStateCommitted: (listener) => {
      commits.add(listener);
      return (): void => void commits.delete(listener);
    },
  };
  const ownership = createChatTurnOwnershipSource();
  ownership.bind(
    source,
    loadCommitted ??
      ((): Promise<PersistedChatTurnState> => Promise.resolve(state())),
  );
  const dispatched: string[] = [];
  const authorizations: Array<AuthorizedChatDispatch | undefined> = [];
  let id = 0;
  const service = new ChatQueueService({
    ownership,
    authorization: new ChatDispatchAuthorizationRegistry(ownership),
    dispatch: (
      sent,
      _origin,
      _fromQueue,
      authorization,
    ): Promise<ChatDispatchOutcome | undefined> => {
      dispatched.push(sent.userMessageId);
      authorizations.push(authorization);
      const outcome = outcomes.shift();
      return Promise.resolve(
        outcome && authorization ? outcome(authorization) : undefined,
      );
    },
    cancel: (): Promise<void> => Promise.resolve(),
    settleCancelledTurn: (): Promise<void> => Promise.resolve(),
    // The provider reports idle throughout: canonical ownership decides.
    hasActiveProviderTurn: (): boolean => false,
    hasPendingProviderContinuation: (): boolean => false,
    persistRuntime: (): void => undefined,
    broadcast: (): void => undefined,
    createId: (): string => `row-${(id += 1)}`,
    now: (): number => 1_000,
    schedule: (callback, delayMs): ReturnType<typeof setTimeout> =>
      setTimeout(callback, delayMs),
  });
  return {
    service,
    ownership,
    dispatched,
    authorizations,
    change: (next): void => {
      current = next.state;
      for (const listener of Array.from(changes))
        listener({ scope, effects: [], cause: 'lifecycle', ...next });
    },
    commit: (next): void => {
      current = next.state;
      for (const listener of Array.from(commits)) listener({ scope, ...next });
    },
  };
}

async function settle(): Promise<void> {
  await jest.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe('canonical queue admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds an accepted, unstarted dispatch until its durable settle, whatever the provider reports', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.dispatched).toEqual(['A1']);

    // The provider dequeued A1 and now waits: admission stays closed.
    queue.service.reconcileSessionActivity();
    await queue.service.submit(request('A2'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual(['A1']);
    expect(shouldHoldChatWake(queue.ownership.getSnapshot(scope))).toBe(true);

    const t1 = turn('T1', 'A1');
    queue.change({
      state: state({ current: t1 }),
      generation: 1,
      lifecycle: [lifecycle('start', t1, 1)],
    });
    queue.commit({
      state: state({ current: t1 }),
      generation: 1,
      lifecycle: [lifecycle('start', t1, 1)],
    });
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);

    // The end is received and the raw terminal arrives, but nothing is
    // durable yet: the slow commit keeps admission closed and the wake held.
    queue.change({
      state: state(),
      generation: 2,
      lifecycle: [lifecycle('end', t1, 2)],
    });
    queue.service.onTurnTerminal(scope, 'complete', 'A1');
    await settle();
    expect(queue.dispatched).toEqual(['A1']);
    expect(shouldHoldChatWake(queue.ownership.getSnapshot(scope))).toBe(true);

    queue.commit({
      state: {
        ...state(),
        lastEnded: { ...t1, endedAtMs: 2, outcome: 'completed', durationMs: 1 },
      },
      generation: 2,
      lifecycle: [lifecycle('end', t1, 2)],
      effects: [{ type: 'turn.ended', turnId: 'T1', outcome: 'completed' }],
    });
    await settle();
    expect(queue.dispatched).toEqual(['A1', 'A2']);
  });

  it('holds a send behind an autonomous turn from receipt until its durable end', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    const wake: ChatTurnRecord = {
      id: 'W',
      origin: 'autonomous',
      startedAtMs: 1,
      pauses: [],
    };
    queue.change({
      state: state({ current: wake }),
      generation: 1,
      lifecycle: [lifecycle('start', wake, 1)],
    });
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);

    queue.change({
      state: state(),
      generation: 2,
      lifecycle: [lifecycle('end', wake, 2)],
    });
    await settle();
    expect(queue.dispatched).toEqual([]);
    queue.commit({
      state: {
        ...state(),
        lastEnded: {
          ...wake,
          endedAtMs: 2,
          outcome: 'completed',
          durationMs: 1,
        },
      },
      generation: 2,
      lifecycle: [lifecycle('start', wake, 1), lifecycle('end', wake, 2)],
      effects: [{ type: 'turn.ended', turnId: 'W', outcome: 'completed' }],
    });
    await settle();
    expect(queue.dispatched).toEqual(['A1']);
  });

  it('keeps isTurnActive on host runtime so restart can settle a hydrated orphan', async () => {
    const orphan = turn('T0', 'A0');
    const queue = harness(() => Promise.resolve(state({ current: orphan })));
    await queue.ownership.hydrate(scope);

    // No provider session and no queue gate own T0: restart reconciliation
    // must see an idle host so it settles the orphan instead of skipping it.
    expect(queue.service.isTurnActive(scope)).toBe(false);
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);
    // The gate the send adopted from canonical evidence is not host liveness.
    expect(queue.service.isTurnActive(scope)).toBe(false);
  });

  it('lets background work alone admit a send', async () => {
    const queue = harness(() =>
      Promise.resolve(
        state({ background: { native: [], managed: { live: 1, queued: 0 } } }),
      ),
    );
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.dispatched).toEqual(['A1']);
  });

  it('waits for a Stop owner, then drains when it releases', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    const stop = Symbol('stop');
    const owner = queue.ownership.registerStopOwner(scope, { token: stop });
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);

    queue.ownership.removeStopOwner(scope, stop, owner.operationEpoch);
    await settle();
    expect(queue.dispatched).toEqual(['A1']);
  });

  it('learns unknown ownership before a first send instead of queueing it', async () => {
    const queue = harness();
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.dispatched).toEqual(['A1']);
  });

  it('keeps admission closed when the ownership read fails', async () => {
    const queue = harness(() => Promise.reject(new Error('read failed')));
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);
  });

  it('releases an unstarted dispatch on an untagged Stop terminal', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    queue.service.onTurnTerminal(scope, 'cancelled');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    await queue.service.submit(request('A2'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual(['A1', 'A2']);
  });
});

describe('dispatch outcomes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const attempt = (
    authorization: AuthorizedChatDispatch,
  ): Pick<ChatDispatchOutcome, 'dispatchOwner' | 'operationEpoch'> => ({
    dispatchOwner: authorization.dispatchOwner,
    operationEpoch: authorization.operationEpoch,
  });

  it('passes the admission capability and keeps D after acceptance', async () => {
    const queue = harness(undefined, [
      (authorization): ChatDispatchOutcome => ({
        ...attempt(authorization),
        kind: 'accepted',
      }),
    ]);
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.authorizations[0]).toMatchObject({
      userMessageId: 'A1',
      kind: 'ordinary',
    });
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toHaveLength(1);
  });

  it('retires D after a committed refusal', async () => {
    const queue = harness(undefined, [
      (authorization): ChatDispatchOutcome => ({
        ...attempt(authorization),
        kind: 'refused',
        reason: 'policy',
      }),
    ]);
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    await queue.service.submit(request('A2'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual(['A1', 'A2']);
  });

  it('hands a parked prompt back to the head of the queue', async () => {
    const queue = harness(undefined, [
      (authorization): ChatDispatchOutcome => ({
        ...attempt(authorization),
        kind: 'parked',
        blockedByTurnId: 'T0',
        receiptGeneration: 1,
        promptCommitted: false,
      }),
    ]);
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    await settle();
    expect(queue.dispatched).toEqual(['A1', 'A1']);
  });
});

describe('direct dispatch admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('installs D with a capability for a host dispatch and holds sends behind it', async () => {
    const queue = harness();
    const admission = await queue.service.admitDirectDispatch(scope, 'H1');
    expect(admission?.authorization).toMatchObject({
      userMessageId: 'H1',
      kind: 'ordinary',
    });
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([
      expect.objectContaining({
        userMessageId: 'H1',
        reason: 'awaiting-start',
      }),
    ]);
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);

    admission?.release();
    admission?.release();
    await settle();
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toHaveLength(1);
    expect(queue.dispatched).toEqual(['A1']);
  });

  it('refuses while another dispatch owns admission', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    await expect(
      queue.service.admitDirectDispatch(scope, 'H1'),
    ).resolves.toBeUndefined();
  });

  it('holds admission for a continuation, which does not queue behind its own hold', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    queue.service.holdDirectDispatch(scope, 'reload-1');
    queue.service.holdDirectDispatch(scope, 'reload-1');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toHaveLength(1);
    await queue.service.submit(request('A1'), 'desktop');
    await settle();
    expect(queue.dispatched).toEqual([]);

    const admission = await queue.service.admitDirectDispatch(
      scope,
      'R1',
      'reload-1',
    );
    expect(admission?.authorization).toMatchObject({ userMessageId: 'R1' });
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([
      expect.objectContaining({ userMessageId: 'R1' }),
    ]);
  });

  it('holds again after a Stop released the previous hold', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    queue.service.holdDirectDispatch(scope, 'reload-1');
    queue.service.onTurnTerminal(scope, 'cancelled');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    queue.service.holdDirectDispatch(scope, 'reload-1');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toHaveLength(1);
    queue.service.releaseDirectDispatchHold(scope, 'reload-1');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
  });

  it('keeps D for a started run and releases it for a run that did not start', async () => {
    const queue = harness();
    const seen: Array<AuthorizedChatDispatch | undefined> = [];
    await queue.service.runDirectDispatch(scope, 'H1', (authorization) => {
      seen.push(authorization);
      return Promise.resolve(false);
    });
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    await expect(
      queue.service.runDirectDispatch(scope, 'H2', () =>
        Promise.reject(new Error('launch failed')),
      ),
    ).rejects.toThrow('launch failed');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
    await queue.service.runDirectDispatch(scope, 'H3', (authorization) => {
      seen.push(authorization);
      return Promise.resolve(true);
    });
    expect(seen.map((authorization) => authorization?.userMessageId)).toEqual([
      'H1',
      'H3',
    ]);
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([
      expect.objectContaining({ userMessageId: 'H3' }),
    ]);
    await expect(
      queue.service.runDirectDispatch(scope, 'H4', () => Promise.resolve(true)),
    ).rejects.toThrow('Another turn owns this chat.');
  });

  it('admits a held continuation once the end of its predecessor commits', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    const t1 = turn('T1', 'A1');
    queue.change({
      state: state({ current: t1 }),
      generation: 1,
      lifecycle: [lifecycle('start', t1, 1)],
    });
    queue.commit({
      state: state({ current: t1 }),
      generation: 1,
      lifecycle: [lifecycle('start', t1, 1)],
    });
    queue.service.holdDirectDispatch(scope, 'reload-1');
    const admitted = queue.service.admitDirectDispatchWhenAllowed(
      scope,
      'A1',
      new AbortController().signal,
      'reload-1',
    );
    // The end is received; its commit lags, so the continuation waits.
    queue.change({
      state: state(),
      generation: 2,
      lifecycle: [lifecycle('end', t1, 2)],
    });
    await Promise.resolve();
    queue.commit({
      state: state(),
      generation: 2,
      lifecycle: [lifecycle('end', t1, 2)],
    });
    await expect(admitted).resolves.toMatchObject({
      authorization: { userMessageId: 'A1' },
    });
  });

  it('stops waiting for admission when its signal aborts', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    await queue.service.submit(request('A1'), 'desktop');
    const abort = new AbortController();
    const admitted = queue.service.admitDirectDispatchWhenAllowed(
      scope,
      'R1',
      abort.signal,
    );
    abort.abort();
    await expect(admitted).resolves.toBeUndefined();
  });

  it('keeps an ordinary send blocked while a reload holds admission', async () => {
    const queue = harness();
    await queue.ownership.hydrate(scope);
    queue.service.holdDirectDispatch(scope, 'reload-1');
    await expect(
      queue.service.admitDirectDispatch(scope, 'portal-send'),
    ).resolves.toBeUndefined();
    await expect(
      queue.service.admitDirectDispatch(scope, 'other', 'reload-2'),
    ).resolves.toBeUndefined();
    await expect(
      queue.service.admitDirectDispatch(scope, 'R1', 'reload-1'),
    ).resolves.toMatchObject({ authorization: { userMessageId: 'R1' } });
  });

  it('backs off while the chat ownership cannot be read, and stops on abort', async () => {
    let reads = 0;
    const queue = harness(() => {
      reads += 1;
      return Promise.reject(new Error('read failed'));
    });
    queue.service.holdDirectDispatch(scope, 'reload-1');
    const abort = new AbortController();
    const admitted = queue.service.admitDirectDispatchWhenAllowed(
      scope,
      'R1',
      abort.signal,
      'reload-1',
    );
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(reads).toBeLessThanOrEqual(2);
    abort.abort();
    await expect(admitted).resolves.toBeUndefined();
  });

  it('releases a direct dispatch at its own terminal', async () => {
    const queue = harness();
    await queue.service.admitDirectDispatch(scope, 'H1');
    queue.service.onTurnTerminal(scope, 'error', 'H1');
    expect(queue.ownership.getSnapshot(scope).dispatchOwners).toEqual([]);
  });
});
