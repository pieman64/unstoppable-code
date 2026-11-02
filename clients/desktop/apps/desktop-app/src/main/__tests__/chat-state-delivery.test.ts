import type {
  ChatRuntimeState,
  ChatStateChange,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import { filterChatStateBodies } from '../ipc/chat-state-body-filter';
import {
  ChatStateDelivery,
  ChatStateSubscriptions,
} from '../ipc/chat-state-delivery';

interface Target {
  name: string;
}

interface Clock {
  now: number;
  timers: Array<{ due: number; callback: () => void; cancelled: boolean }>;
  advance(ms: number): void;
}

function createClock(): Clock {
  const clock: Clock = {
    now: 1_000,
    timers: [],
    advance(ms: number): void {
      const until = clock.now + ms;
      for (;;) {
        const next = clock.timers
          .filter((timer) => !timer.cancelled && timer.due <= until)
          .sort((left, right) => left.due - right.due)[0];
        if (!next) break;
        next.cancelled = true;
        clock.now = Math.max(clock.now, next.due);
        next.callback();
      }
      clock.now = until;
    },
  };
  return clock;
}

function setup(
  options: {
    maxEventsPerMessage?: number;
    transform?: (
      target: Target,
      event: ChatStateChangedEvent,
    ) => ChatStateChangedEvent;
  } = {},
): {
  clock: Clock;
  delivery: ChatStateDelivery<Target>;
  sent: Array<{ target: string; event: ChatStateChangedEvent }>;
  main: Target;
  advisor: Target;
} {
  const clock = createClock();
  const sent: Array<{ target: string; event: ChatStateChangedEvent }> = [];
  const delivery = new ChatStateDelivery<Target>({
    deliver: (target, event): void => {
      sent.push({ target: target.name, event });
    },
    setTimer: (callback, delayMs): (() => void) => {
      const timer = { due: clock.now + delayMs, callback, cancelled: false };
      clock.timers.push(timer);
      return (): void => {
        timer.cancelled = true;
      };
    },
    now: (): number => clock.now,
    tickMs: 16,
    transform: options.transform,
    ...(options.maxEventsPerMessage === undefined
      ? {}
      : { maxEventsPerMessage: options.maxEventsPerMessage }),
  });
  return {
    clock,
    delivery,
    sent,
    main: { name: 'main' },
    advisor: { name: 'advisor' },
  };
}

function runtime(
  status: ChatRuntimeState['status'],
  lastActivityAt: number,
): ChatStateChange {
  return {
    type: 'runtime.patched',
    chatId: 'chat-1',
    runtime: { status, queuedMessageIds: [], lastActivityAt },
  };
}

function upsert(text: string): ChatStateChange {
  return {
    type: 'message.upserted',
    chatId: 'chat-1',
    message: {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: 2,
    },
  };
}

function aggregateChanges(): ChatStateChange[] {
  return [
    upsert('aggregate text 1'),
    upsert('aggregate text 2'),
    upsert('aggregate final text'),
    runtime('streaming', 21),
    runtime('streaming', 22),
    {
      type: 'message.upserted',
      chatId: 'chat-1',
      message: {
        id: 'assistant-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'new aggregate row' }],
        timestamp: 3,
      },
    },
  ];
}

function event(
  scope: string,
  baseRevision: number,
  changes: ChatStateChange[],
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: `${scope}:${String(baseRevision + 1)}`,
    occurredAt: new Date(baseRevision * 1000).toISOString(),
    projectId: 'project-1',
    worktreeId: scope,
    baseRevision,
    revision: baseRevision + 1,
    changes,
  };
}

/** A provider commit: content plus an activity-only runtime patch. */
function streamed(scope: string, base: number): ChatStateChangedEvent {
  return event(scope, base, [
    upsert(`text ${String(base)}`),
    runtime('streaming', base),
  ]);
}

/** Starts a turn so later activity-only patches are known to be streamed. */
function turnStart(scope: string, base: number): ChatStateChangedEvent {
  return event(scope, base, [runtime('streaming', base)]);
}

describe('ChatStateDelivery coalescing', () => {
  it('transforms each target before holding and merging the original streamed commits', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    const transform = jest.fn(
      (target: Target, committed: ChatStateChangedEvent) =>
        filterChatStateBodies(subscriptions.interestOf(target), committed),
    );
    const { clock, delivery, sent, main, advisor } = setup({ transform });
    subscriptions.declareInterest(main, {
      focused: [
        { projectId: 'project-1', worktreeId: 'wt-a', chatId: 'chat-1' },
      ],
      warm: [],
      acceptsMessagesOmitted: true,
    });
    subscriptions.declareInterest(advisor, {
      focused: [],
      warm: [],
      acceptsMessagesOmitted: true,
    });
    const first = event('wt-a', 1, [upsert('first')]);
    delivery.publish(first, [main, advisor]);
    expect(sent[0]?.event).toBe(first);
    expect(sent[1]?.event.changes).toEqual([
      { type: 'messages.omitted', chatId: 'chat-1' },
    ]);
    const second = event('wt-a', 2, [upsert('second')]);
    const third = event('wt-a', 3, [upsert('third')]);
    delivery.publish(second, [main, advisor]);
    delivery.publish(third, [main, advisor]);
    expect(transform).toHaveBeenCalledTimes(6);
    expect(transform).toHaveBeenCalledWith(advisor, second);
    expect(sent).toHaveLength(2);
    // Interest changes do not retroactively transform the already-held run.
    subscriptions.declareInterest(
      advisor,
      subscriptions.interestOf(main) ?? { focused: [], warm: [] },
    );
    clock.advance(16);
    expect(transform).toHaveBeenCalledTimes(6);
    expect(sent[2]?.event.changes).toEqual([
      ...second.changes,
      ...third.changes,
    ]);
    expect(sent[3]?.event).toEqual({
      ...second,
      eventId: third.eventId,
      occurredAt: third.occurredAt,
      revision: third.revision,
      changes: [
        { type: 'messages.omitted', chatId: 'chat-1' },
        { type: 'messages.omitted', chatId: 'chat-1' },
      ],
    });
  });

  it('merges one scope’s streamed events from one tick into one ordered event', () => {
    const { clock, delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    expect(sent).toHaveLength(1);
    const burst = [
      streamed('wt-a', 2),
      streamed('wt-a', 3),
      streamed('wt-a', 4),
    ];
    for (const next of burst) delivery.publish(next, [main]);
    expect(sent).toHaveLength(1);

    clock.advance(16);

    expect(sent).toHaveLength(2);
    const merged = sent[1]?.event;
    expect(merged).toEqual({
      ...burst[0],
      eventId: burst[2]?.eventId,
      occurredAt: burst[2]?.occurredAt,
      baseRevision: 2,
      revision: 5,
      changes: burst.flatMap((item) => item.changes),
    });
  });

  it('sends a lone streamed event at once and unchanged after a quiet tick', () => {
    const { clock, delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    clock.advance(100);
    const lone = streamed('wt-a', 2);
    delivery.publish(lone, [main]);
    // No timer turn: an isolated commit reaches the window as promptly as it
    // did before coalescing (a busy main process can delay a timer turn).
    expect(sent.map((entry) => entry.event)).toEqual([sent[0]?.event, lone]);
    expect(sent[1]?.event).toBe(lone);
    // A follow-up inside the tick still waits for it.
    delivery.publish(streamed('wt-a', 3), [main]);
    expect(sent).toHaveLength(2);
    clock.advance(16);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.event).toMatchObject({ baseRevision: 3, revision: 4 });
  });

  it('sends lifecycle events at once, after the window’s pending content', () => {
    const { delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    delivery.publish(turnStart('wt-b', 6), [main]);
    delivery.publish(streamed('wt-b', 7), [main]);
    delivery.publish(streamed('wt-a', 2), [main]);
    delivery.publish(streamed('wt-a', 3), [main]);
    expect(sent).toHaveLength(2);
    const completed = event('wt-a', 4, [runtime('completed', 5)]);
    delivery.publish(completed, [main]);

    expect(
      sent.map(({ event: item }) => [
        item.worktreeId,
        item.baseRevision,
        item.revision,
      ]),
    ).toEqual([
      ['wt-a', 1, 2],
      ['wt-b', 6, 7],
      ['wt-b', 7, 8],
      ['wt-a', 2, 4],
      ['wt-a', 4, 5],
    ]);
    expect(sent[4]?.event).toBe(completed);
  });

  it('keeps every scope’s revisions contiguous across flush boundaries', () => {
    const { clock, delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    delivery.publish(turnStart('wt-b', 1), [main]);
    let base = 2;
    for (let tick = 0; tick < 5; tick += 1) {
      for (let index = 0; index < 3; index += 1) {
        delivery.publish(streamed('wt-a', base), [main]);
        delivery.publish(streamed('wt-b', base), [main]);
        base += 1;
      }
      clock.advance(7);
    }
    clock.advance(100);
    for (const scope of ['wt-a', 'wt-b']) {
      const revisions = sent
        .filter((entry) => entry.event.worktreeId === scope)
        .map((entry) => [entry.event.baseRevision, entry.event.revision]);
      expect(revisions[0]).toEqual([1, 2]);
      for (let index = 1; index < revisions.length; index += 1) {
        expect(revisions[index]?.[0]).toBe(revisions[index - 1]?.[1]);
      }
      expect(revisions[revisions.length - 1]?.[1]).toBe(base);
    }
    // Five ticks of three events each: fewer messages than events.
    expect(sent.length).toBeLessThan(2 + 30);
  });

  it('throttles one scope to one message per tick per window', () => {
    const { clock, delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    clock.advance(100);
    delivery.publish(streamed('wt-a', 2), [main]);
    clock.advance(0);
    expect(sent).toHaveLength(2);
    delivery.publish(streamed('wt-a', 3), [main]);
    clock.advance(10);
    delivery.publish(streamed('wt-a', 4), [main]);
    expect(sent).toHaveLength(2);
    clock.advance(6);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.event).toMatchObject({ baseRevision: 3, revision: 5 });
  });

  it('never merges across a revision gap or a duplicate', () => {
    const { clock, delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    delivery.publish(streamed('wt-a', 2), [main]);
    delivery.publish(streamed('wt-a', 5), [main]);
    delivery.publish(streamed('wt-a', 5), [main]);
    clock.advance(100);
    expect(
      sent.map(({ event: item }) => [item.baseRevision, item.revision]),
    ).toEqual([
      [1, 2],
      [2, 3],
      [5, 6],
      [5, 6],
    ]);
  });

  it('classifies a runtime patch as streamed only after its status is known', () => {
    const { delivery, sent, main } = setup();
    // No earlier runtime for this chat: sent at once.
    delivery.publish(event('wt-a', 1, [runtime('streaming', 1)]), [main]);
    expect(sent).toHaveLength(1);
    // Activity only: deferred.
    delivery.publish(event('wt-a', 2, [runtime('streaming', 2)]), [main]);
    expect(sent).toHaveLength(1);
    // A status change: flushes the pending run, then goes out on its own.
    delivery.publish(event('wt-a', 3, [runtime('idle', 3)]), [main]);
    expect(sent.map(({ event: item }) => item.revision)).toEqual([2, 3, 4]);
    // Removing the tab forgets its runtime.
    delivery.publish(
      event('wt-a', 4, [{ type: 'tab.removed', tabId: 'chat-1' }]),
      [main],
    );
    delivery.publish(event('wt-a', 5, [runtime('idle', 6)]), [main]);
    expect(sent.map(({ event: item }) => item.revision)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it('keeps transcript resets and structural changes out of merged events', () => {
    const { delivery, sent, main } = setup();
    delivery.publish(turnStart('wt-a', 1), [main]);
    delivery.publish(streamed('wt-a', 2), [main]);
    const reset = event('wt-a', 3, [
      {
        type: 'transcript.updated',
        chatId: 'chat-1',
        reset: true,
        transcript: {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: 0,
          committedByteLength: 0,
          transcriptRevision: 4,
          hasActiveSidecar: false,
          messageCount: 0,
        },
      },
    ]);
    delivery.publish(reset, [main]);
    expect(sent.map(({ event: item }) => item.revision)).toEqual([2, 3, 4]);
    expect(sent[2]?.event).toBe(reset);
  });

  it('flushes only the requested window, before its next message', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    delivery.publish(turnStart('wt-a', 1), [main, advisor]);
    delivery.publish(streamed('wt-a', 2), [main, advisor]);
    delivery.publish(streamed('wt-a', 3), [main, advisor]);
    delivery.flushTarget(main);
    expect(sent.map((entry) => [entry.target, entry.event.revision])).toEqual([
      ['main', 2],
      ['advisor', 2],
      ['main', 4],
    ]);
    clock.advance(16);
    expect(sent.map((entry) => [entry.target, entry.event.revision])).toEqual([
      ['main', 2],
      ['advisor', 2],
      ['main', 4],
      ['advisor', 4],
    ]);
  });

  it('drops a forgotten window’s pending content and flushes the rest on dispose', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    delivery.publish(turnStart('wt-a', 1), [main, advisor]);
    delivery.publish(streamed('wt-a', 2), [main, advisor]);
    delivery.forgetTarget(advisor);
    delivery.dispose();
    expect(sent.map((entry) => [entry.target, entry.event.revision])).toEqual([
      ['main', 2],
      ['advisor', 2],
      ['main', 3],
    ]);
    expect(clock.timers.every((timer) => timer.cancelled)).toBe(true);
    clock.advance(100);
    expect(sent).toHaveLength(3);
  });

  it('does not send other pending runs from inside its own send', () => {
    const clock = createClock();
    const sent: string[] = [];
    const main: Target = { name: 'main' };
    const barrier = { flushes: false };
    const delivery: ChatStateDelivery<Target> = new ChatStateDelivery<Target>({
      deliver: (target, item): void => {
        // This send's barriers release another projection's held message,
        // whose own barrier flushes this target.
        if (barrier.flushes) delivery.flushTarget(target);
        sent.push(`${item.worktreeId} r${String(item.revision)}`);
      },
      setTimer: (callback, delayMs): (() => void) => {
        const timer = { due: clock.now + delayMs, callback, cancelled: false };
        clock.timers.push(timer);
        return (): void => {
          timer.cancelled = true;
        };
      },
      now: (): number => clock.now,
      tickMs: 16,
    });
    delivery.publish(turnStart('wt-a', 0), [main]);
    delivery.publish(turnStart('wt-b', 0), [main]);
    clock.advance(2);
    delivery.publish(streamed('wt-a', 1), [main]);
    delivery.publish(streamed('wt-b', 1), [main]);
    barrier.flushes = true;
    clock.advance(16);
    expect(sent).toEqual(['wt-a r1', 'wt-b r1', 'wt-a r2', 'wt-b r2']);
  });

  it('caps the events merged into one message', () => {
    const { clock, delivery, sent, main } = setup({ maxEventsPerMessage: 2 });
    delivery.publish(turnStart('wt-a', 1), [main]);
    for (let base = 2; base < 7; base += 1) {
      delivery.publish(streamed('wt-a', base), [main]);
    }
    clock.advance(100);
    expect(
      sent.map(({ event: item }) => [item.baseRevision, item.revision]),
    ).toEqual([
      [1, 2],
      [2, 4],
      [4, 6],
      [6, 7],
    ]);
  });
});

describe('ChatStateDelivery snapshot boundaries', () => {
  function revisions(
    sent: Array<{ target: string; event: ChatStateChangedEvent }>,
  ): Array<[string, number, number]> {
    return sent.map(({ target, event: item }) => [
      target,
      item.baseRevision,
      item.revision,
    ]);
  }

  it('does not merge a scope’s events to a window while it reads that scope', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    delivery.publish(turnStart('wt-a', 1), [main, advisor]);
    delivery.publish(streamed('wt-a', 2), [main, advisor]);
    const end = delivery.beginSnapshot(advisor, 'project-1', 'wt-a');
    delivery.publish(streamed('wt-a', 3), [main, advisor]);
    delivery.publish(streamed('wt-a', 4), [main, advisor]);
    // Another scope of the same window still merges.
    delivery.publish(turnStart('wt-b', 1), [advisor]);
    delivery.publish(streamed('wt-b', 2), [advisor]);
    delivery.publish(streamed('wt-b', 3), [advisor]);
    end(undefined);
    clock.advance(16);
    expect(revisions(sent)).toEqual([
      ['main', 1, 2],
      ['advisor', 1, 2],
      ['advisor', 2, 3],
      ['advisor', 3, 4],
      // wt-b's turn start delivers what the window has pending first.
      ['advisor', 4, 5],
      ['advisor', 1, 2],
      ['main', 2, 5],
      ['advisor', 2, 4],
    ]);
    // A query that returned no snapshot leaves no boundary behind: after the
    // quiet scope's leading event, the two that follow it merge.
    delivery.publish(streamed('wt-a', 5), [advisor]);
    delivery.publish(streamed('wt-a', 6), [advisor]);
    delivery.publish(streamed('wt-a', 7), [advisor]);
    clock.advance(16);
    expect(revisions(sent).slice(8)).toEqual([
      ['advisor', 5, 6],
      ['advisor', 6, 8],
    ]);
  });

  it('never merges a window’s run across a snapshot revision it read', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    delivery.publish(turnStart('wt-a', 1), [main, advisor]);
    delivery.beginSnapshot(advisor, 'project-1', 'wt-a')(4);
    // Publication lags the read: revisions 3 and 4 arrive after the reply.
    delivery.publish(streamed('wt-a', 2), [main, advisor]);
    delivery.publish(streamed('wt-a', 3), [main, advisor]);
    delivery.publish(streamed('wt-a', 4), [main, advisor]);
    delivery.publish(streamed('wt-a', 5), [main, advisor]);
    clock.advance(16);
    expect(revisions(sent)).toEqual([
      ['main', 1, 2],
      ['advisor', 1, 2],
      ['advisor', 2, 4],
      ['main', 2, 6],
      ['advisor', 4, 6],
    ]);
    // Once the scope's events pass the boundary it is forgotten.
    delivery.publish(streamed('wt-a', 6), [advisor]);
    delivery.publish(streamed('wt-a', 7), [advisor]);
    clock.advance(16);
    expect(revisions(sent).slice(5)).toEqual([['advisor', 6, 8]]);
  });

  it('delivers an aggregate whole and keeps it separate across a snapshot boundary', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    const started = turnStart('wt-a', 1);
    delivery.publish(started, [main, advisor]);

    const finishSnapshot = delivery.beginSnapshot(advisor, 'project-1', 'wt-a');
    const changes = aggregateChanges();
    const aggregate = event('wt-a', 2, changes);
    delivery.publish(aggregate, [main, advisor]);
    finishSnapshot(3);

    const afterBoundary = streamed('wt-a', 3);
    delivery.publish(afterBoundary, [main, advisor]);
    clock.advance(16);

    const advisorEvents = sent
      .filter((entry) => entry.target === 'advisor')
      .map((entry) => entry.event);
    expect(
      advisorEvents.map(({ baseRevision, revision }) => [
        baseRevision,
        revision,
      ]),
    ).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(advisorEvents[1]).toEqual(aggregate);
    expect(advisorEvents[1]?.changes).toEqual(changes);
    expect(
      advisorEvents[1]?.changes
        .filter(
          (change) =>
            change.type === 'message.upserted' &&
            change.message.id === 'assistant-1',
        )
        .map((change) =>
          change.type === 'message.upserted' &&
          change.message.blocks[0]?.type === 'text'
            ? change.message.blocks[0].text
            : undefined,
        ),
    ).toEqual(['aggregate text 1', 'aggregate text 2', 'aggregate final text']);
    expect(advisorEvents[1]?.changes[5]).toMatchObject({
      type: 'message.upserted',
      message: { id: 'assistant-2' },
    });
  });

  it('keeps a boundary per window and per scope', () => {
    const { clock, delivery, sent, main, advisor } = setup();
    delivery.publish(turnStart('wt-a', 1), [main, advisor]);
    delivery.beginSnapshot(advisor, 'project-1', 'wt-b')(2);
    delivery.publish(streamed('wt-a', 2), [main, advisor]);
    delivery.publish(streamed('wt-a', 3), [main, advisor]);
    clock.advance(16);
    expect(revisions(sent)).toEqual([
      ['main', 1, 2],
      ['advisor', 1, 2],
      ['main', 2, 4],
      ['advisor', 2, 4],
    ]);
  });
});

describe('ChatStateSubscriptions', () => {
  it('records interest per subscriber, replaces it, and drops it on reset', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    const main = { name: 'main' };
    const advisor = { name: 'advisor' };
    const first = {
      focused: [{ projectId: 'p', worktreeId: 'w', chatId: 'a' }],
      warm: [],
    };
    const second = {
      focused: [],
      warm: [{ projectId: 'p', worktreeId: 'w', chatId: 'b' }],
    };
    subscriptions.declareInterest(main, first);
    subscriptions.declareInterest(advisor, second);
    expect(subscriptions.interestOf(main)).toEqual(first);
    expect(subscriptions.interestOf(advisor)).toEqual(second);
    subscriptions.declareInterest(main, second);
    expect(subscriptions.interestOf(main)).toEqual(second);
    subscriptions.reset(main);
    expect(subscriptions.interestOf(main)).toBeUndefined();
    expect(subscriptions.interestOf(advisor)).toEqual(second);
  });

  it('keeps scope and interest declarations independent', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    const target = { name: 'main' };
    const interest = { focused: [], warm: [] };
    subscriptions.declare(target, [{ projectId: 'p', worktreeId: 'w' }]);
    subscriptions.declareInterest(target, interest);
    expect(subscriptions.wants(target, 'p', 'other')).toBe(false);
    subscriptions.declare(target, 'all');
    expect(subscriptions.interestOf(target)).toEqual(interest);
    subscriptions.declare(target, [{ projectId: 'p', worktreeId: 'w' }]);
    subscriptions.resetInterest(target);
    expect(subscriptions.wants(target, 'p', 'other')).toBe(false);
    subscriptions.declareInterest(target, interest);
    subscriptions.resetScopes(target);
    expect(subscriptions.interestOf(target)).toEqual(interest);
  });

  it('does not change delivery when interest is recorded', () => {
    const { delivery, sent, main } = setup();
    const subscriptions = new ChatStateSubscriptions<Target>();
    subscriptions.declareInterest(main, { focused: [], warm: [] });
    const committed = event('wt-a', 1, [
      { type: 'tab.removed', tabId: 'tab-1' },
    ]);
    delivery.publish(committed, [main]);
    expect(sent).toEqual([{ target: 'main', event: committed }]);
  });

  it('delivers every scope to an undeclared window', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    expect(subscriptions.wants({ name: 'main' }, 'p', 'w')).toBe(true);
  });

  it('delivers only declared scopes, a wildcard, and resets to every scope', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    const advisor = { name: 'advisor' };
    const main = { name: 'main' };
    subscriptions.declare(advisor, [
      { projectId: 'app-advisor', worktreeId: 'entry-1' },
    ]);
    subscriptions.declare(main, 'all');
    expect(subscriptions.wants(advisor, 'app-advisor', 'entry-1')).toBe(true);
    expect(subscriptions.wants(advisor, 'project-1', 'wt-a')).toBe(false);
    expect(subscriptions.wants(advisor, 'app-advisor', 'entry-2')).toBe(false);
    expect(subscriptions.wants(main, 'project-1', 'wt-a')).toBe(true);

    subscriptions.declare(advisor, []);
    expect(subscriptions.wants(advisor, 'app-advisor', 'entry-1')).toBe(false);

    subscriptions.reset(advisor);
    expect(subscriptions.wants(advisor, 'project-1', 'wt-a')).toBe(true);
  });

  it('does not confuse scope ids that share separators', () => {
    const subscriptions = new ChatStateSubscriptions<Target>();
    const window = { name: 'main' };
    subscriptions.declare(window, [{ projectId: 'a-b', worktreeId: 'c' }]);
    expect(subscriptions.wants(window, 'a', 'b-c')).toBe(false);
    expect(subscriptions.wants(window, 'a-b', 'c')).toBe(true);
  });
});
