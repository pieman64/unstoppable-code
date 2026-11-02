import {
  computePortalOutboxTrim,
  createDroppedRangeMarkers,
  getPortalRoutingStamp,
  isPortalControlEvent,
  portalEventByteLength,
  preservePortalEventTimestamp,
  resolvePortalDroppedCommandEvent,
  shouldRecordPortalCoalesceDiagnostic,
  shouldRecordPortalOutboxLatency,
  splitOversizedPortalSnapshotEvent,
  stampPortalEventRouting,
  restorePortalRoutingSequenceCounters,
} from '../portal-outbox';
import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function event(
  type: PortalEventEnvelope['type'],
  eventId: string,
): PortalEventEnvelope {
  return {
    type,
    eventId,
    occurredAt: '2026-06-10T00:00:00.000Z',
    payload: {},
  };
}

describe('computePortalOutboxTrim (D3)', () => {
  it('preserves enqueue timestamps when recompaction replaces an envelope', () => {
    const original = event('portal.chat.event', 'chat-1');
    const replacement = { ...original };
    const timestamps = new WeakMap<PortalEventEnvelope, number>();
    timestamps.set(original, 1234);

    expect(
      preservePortalEventTimestamp(original, replacement, timestamps),
    ).toBe(replacement);
    expect(timestamps.get(replacement)).toBe(1234);
  });

  it('throttles the pure-coalesce diagnostic to one record per minute', () => {
    // `trimEventOutbox` runs on EVERY enqueue, and coalescing fires on most of
    // them once snapshots start superseding each other — so an unthrottled
    // record would write an app-diagnostic line per event, adding IO pressure
    // to the subsystem this work exists to relieve. Overflow drops are rare
    // and are always recorded; only the routine reclaim is throttled.
    const now = 1_788_800_000_000;
    // Never recorded in this process (`lastRecordedAt` starts at 0).
    expect(shouldRecordPortalCoalesceDiagnostic(now, 0)).toBe(true);
    expect(shouldRecordPortalCoalesceDiagnostic(now + 59_999, now)).toBe(false);
    expect(shouldRecordPortalCoalesceDiagnostic(now + 60_000, now)).toBe(true);
    // A clock that jumps backwards must not latch the diagnostic off forever.
    expect(shouldRecordPortalCoalesceDiagnostic(now - 5_000, now)).toBe(true);
  });

  it('throttles normal latency but always records batches older than two seconds', () => {
    expect(shouldRecordPortalOutboxLatency(2_000, 40_000, 20_000)).toBe(false);
    expect(shouldRecordPortalOutboxLatency(2_001, 21_000, 20_000)).toBe(true);
    expect(shouldRecordPortalOutboxLatency(100, 50_000, 20_000)).toBe(true);
  });

  it('keeps everything and reports no drops when under the cap', () => {
    const events = [
      event('portal.heartbeat', 'e1'),
      event('portal.chat.event', 'e2'),
    ];
    const result = computePortalOutboxTrim(events, 10, null);
    expect(result.kept).toEqual(events);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedChatEventCount).toBe(0);
    expect(result.droppedRangeCount).toBe(0);
  });

  it('drops the oldest events past the cap and counts them', () => {
    const events = [
      event('portal.chat.event', 'old-chat'),
      event('portal.heartbeat', 'old-hb'),
      event('portal.chat.event', 'keep-chat'),
      event('portal.heartbeat', 'keep-hb'),
    ];
    const result = computePortalOutboxTrim(events, 2, null);
    expect(result.kept.map((e) => e.eventId)).toEqual(['keep-chat', 'keep-hb']);
    expect(result.droppedCount).toBe(2);
    // A dropped chat event is a visibly lost message — surfaced separately so
    // overflow that loses transcript content is never silent.
    expect(result.droppedChatEventCount).toBe(1);
  });

  it('drops oldest background events before foreground while preserving survivor order', () => {
    const scopedEvent = (
      eventId: string,
      worktreeLocalId: string,
    ): PortalEventEnvelope => ({
      ...event('portal.chat.event', eventId),
      payload: { workspaceLocalId: 'ws-1', worktreeLocalId },
    });
    const events = [
      scopedEvent('foreground-1', 'selected'),
      scopedEvent('background-1', 'other'),
      scopedEvent('foreground-2', 'selected'),
      event('portal.heartbeat', 'unscoped'),
      scopedEvent('background-2', 'other'),
      scopedEvent('foreground-3', 'selected'),
    ];

    const result = computePortalOutboxTrim(events, 3, 'ws-1\0selected');

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'foreground-1',
      'foreground-2',
      'foreground-3',
    ]);
    expect(result.droppedCount).toBe(3);
    expect(result.droppedChatEventCount).toBe(2);
  });

  it('drops oldest foreground events only after exhausting background drops', () => {
    const events = [
      {
        ...event('portal.chat.event', 'foreground-1'),
        payload: { workspaceLocalId: 'ws', worktreeLocalId: 'selected' },
      },
      event('portal.heartbeat', 'background'),
      {
        ...event('portal.chat.event', 'foreground-2'),
        payload: { workspaceLocalId: 'ws', worktreeLocalId: 'selected' },
      },
    ];
    const result = computePortalOutboxTrim(events, 1, 'ws\0selected');
    expect(result.kept.map((item) => item.eventId)).toEqual(['foreground-2']);
  });

  it('drops command completion/failure control events last (last-resort ordering, CAN-2360)', () => {
    const controlEvent = (
      type: 'portal.command.completed' | 'portal.command.failed',
      eventId: string,
    ): PortalEventEnvelope => ({
      ...event(type, eventId),
      commandId: `cmd-${eventId}`,
      payload: { commandId: `cmd-${eventId}` },
    });
    const events = [
      controlEvent('portal.command.completed', 'oldest-completed'),
      controlEvent('portal.command.failed', 'oldest-failed'),
      ...Array.from({ length: 6 }, (_, index) =>
        event('portal.chat.event', `chat-${index}`),
      ),
    ];

    const result = computePortalOutboxTrim(events, 4, null);

    // The controls are the OLDEST events, which the plain age-ordered trim
    // would drop first — but they are ~200-byte latency-critical completion
    // signals, so bulk chat events must be sacrificed instead.
    expect(result.kept.map((item) => item.eventId)).toEqual([
      'oldest-completed',
      'oldest-failed',
      'chat-4',
      'chat-5',
    ]);
    expect(result.droppedCount).toBe(4);
  });

  it('still drops control events as a last resort when nothing else can satisfy the cap', () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      ...event('portal.command.completed', `completed-${index}`),
      commandId: `cmd-${index}`,
    }));

    // An all-control outbox above the cap must still trim (oldest first)
    // rather than violate the cap or throw — the exemption is a priority,
    // not an unbounded guarantee.
    const result = computePortalOutboxTrim(events, 2, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'completed-3',
      'completed-4',
    ]);
    expect(result.droppedCount).toBe(3);
  });
});

describe('isPortalControlEvent', () => {
  it('matches only command completion/failure events', () => {
    expect(isPortalControlEvent(event('portal.command.completed', 'e1'))).toBe(
      true,
    );
    expect(isPortalControlEvent(event('portal.command.failed', 'e2'))).toBe(
      true,
    );
    expect(isPortalControlEvent(event('portal.chat.event', 'e3'))).toBe(false);
    expect(isPortalControlEvent(event('portal.state.snapshot', 'e4'))).toBe(
      false,
    );
  });
});

describe('portal routing sequences and dropped ranges', () => {
  function scopedEvent(
    eventId: string,
    worktreeLocalId: string,
  ): PortalEventEnvelope {
    return {
      ...event('portal.chat.event', eventId),
      payload: { workspaceLocalId: 'ws', worktreeLocalId },
    };
  }

  function coworkEvent(
    eventId: string,
    workEntryId: string,
    chatId = 'chat-1',
  ): PortalEventEnvelope {
    return {
      ...event('portal.chat.event', eventId),
      payload: {
        scope: 'standalone',
        projectLocalId: 'cowork-ws',
        projectId: 'cowork-ws',
        workEntryId,
        chatId,
        message: {},
      },
    };
  }

  it('stamps independent monotonic sequences without mutating caller payloads', () => {
    const counters = new Map<string, number>();
    const first = scopedEvent('a1', 'a');
    const originalPayload = first.payload;
    const stamped = [
      stampPortalEventRouting(first, counters),
      stampPortalEventRouting(scopedEvent('b1', 'b'), counters),
      stampPortalEventRouting(scopedEvent('a2', 'a'), counters),
    ];
    expect(stamped.map(getPortalRoutingStamp)).toEqual([
      { key: 'ws:a', seq: 1 },
      { key: 'ws:b', seq: 1 },
      { key: 'ws:a', seq: 2 },
    ]);
    expect(first.payload).toBe(originalPayload);
    expect(first.payload).not.toHaveProperty('routing');
    expect(
      stampPortalEventRouting(event('portal.heartbeat', 'u'), counters),
    ).toEqual(event('portal.heartbeat', 'u'));
  });

  it('stamps cowork chats by workspace and Work Entry', () => {
    const counters = new Map<string, number>();
    const stamped = [
      stampPortalEventRouting(coworkEvent('a1', 'entry-a'), counters),
      stampPortalEventRouting(coworkEvent('b1', 'entry-b'), counters),
      stampPortalEventRouting(coworkEvent('a2', 'entry-a'), counters),
    ];

    expect(stamped.map(getPortalRoutingStamp)).toEqual([
      { key: 'cowork-ws:entry-a', seq: 1 },
      { key: 'cowork-ws:entry-b', seq: 1 },
      { key: 'cowork-ws:entry-a', seq: 2 },
    ]);
    expect(counters.get('cowork-ws\0entry-a')).toBe(2);
    expect(counters.get('cowork-ws\0entry-b')).toBe(1);
  });

  it('keeps cowork repair identity and affected chats on dropped-range markers', () => {
    const counters = new Map<string, number>();
    const dropped = [
      stampPortalEventRouting(coworkEvent('a1', 'entry-a', 'chat-a'), counters),
      stampPortalEventRouting(coworkEvent('a2', 'entry-a', 'chat-b'), counters),
    ];

    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped,
      reason: 'overflow',
      createEventId: () => 'cowork-marker',
    });

    expect(marked.markerCount).toBe(1);
    expect(marked.events[0]?.payload).toMatchObject({
      projectLocalId: 'cowork-ws',
      projectId: 'cowork-ws',
      workEntryId: 'entry-a',
      standaloneChatLocalIds: ['chat-a', 'chat-b'],
      routing: { key: 'cowork-ws:entry-a' },
      fromSeq: 1,
      toSeq: 2,
    });
  });

  it('keeps cowork repair identities when ranges collapse into an aggregate marker', () => {
    const counters = new Map<string, number>();
    const dropped = [
      stampPortalEventRouting(coworkEvent('a1', 'entry-a', 'chat-a'), counters),
      stampPortalEventRouting(coworkEvent('b1', 'entry-b', 'chat-b'), counters),
    ];

    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped,
      reason: 'overflow',
      createEventId: () => 'cowork-aggregate',
      maxEvents: 1,
    });

    expect(marked.events).toHaveLength(1);
    expect(marked.events[0]?.payload).toMatchObject({
      aggregate: true,
      keys: ['cowork-ws:entry-a', 'cowork-ws:entry-b'],
      coworkLanes: [
        {
          key: 'cowork-ws:entry-a',
          projectLocalId: 'cowork-ws',
          workEntryId: 'entry-a',
          standaloneChatLocalIds: ['chat-a'],
        },
        {
          key: 'cowork-ws:entry-b',
          projectLocalId: 'cowork-ws',
          workEntryId: 'entry-b',
          standaloneChatLocalIds: ['chat-b'],
        },
      ],
    });
  });

  it('merges inherited and fresh cowork chats for the same aggregate lane', () => {
    const inherited: PortalEventEnvelope = {
      ...event('portal.heartbeat', 'inherited-aggregate'),
      payload: {
        aggregate: true,
        keys: ['cowork-ws:entry-a'],
        coworkLanes: [
          {
            key: 'cowork-ws:entry-a',
            projectLocalId: 'cowork-ws',
            workEntryId: 'entry-a',
            standaloneChatLocalIds: ['chat-a'],
            truncatedStandaloneChatCount: 2,
          },
        ],
        truncatedKeyCount: 0,
        reason: 'overflow',
      },
    };
    Reflect.set(inherited, 'type', 'portal.events.dropped');
    const fresh = stampPortalEventRouting(
      coworkEvent('fresh', 'entry-a', 'chat-b'),
      new Map(),
    );

    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped: [inherited, fresh],
      reason: 'overflow',
      createEventId: () => 'replacement-aggregate',
      maxEvents: 1,
    });

    expect(marked.events[0]?.payload).toMatchObject({
      coworkLanes: [
        {
          key: 'cowork-ws:entry-a',
          standaloneChatLocalIds: ['chat-a', 'chat-b'],
          truncatedStandaloneChatCount: 2,
        },
      ],
    });
  });

  it('preserves the original stamp on replayed events and floors the counter', () => {
    const counters = new Map<string, number>();
    const original = stampPortalEventRouting(scopedEvent('a1', 'a'), counters);
    expect(getPortalRoutingStamp(original)).toEqual({ key: 'ws:a', seq: 1 });

    // Completed-command replay re-enqueues the SAME already-stamped event
    // (server dedupes by eventId): restamping would burn a seq that never
    // reaches the browser, creating a permanent false gap.
    const replayCounters = new Map<string, number>();
    const replayed = stampPortalEventRouting(original, replayCounters);
    expect(replayed).toBe(original);
    expect(getPortalRoutingStamp(replayed)).toEqual({ key: 'ws:a', seq: 1 });
    expect(replayCounters.get('ws\0a')).toBe(1);

    const next = stampPortalEventRouting(
      scopedEvent('a2', 'a'),
      replayCounters,
    );
    expect(getPortalRoutingStamp(next)).toEqual({ key: 'ws:a', seq: 2 });
  });

  it('restores counter floors from persisted counters and stamped outbox events', () => {
    const stamped = stampPortalEventRouting(
      scopedEvent('a1', 'a'),
      new Map([['ws\0a', 6]]),
    );
    const counters = restorePortalRoutingSequenceCounters(
      { ['ws\0a']: 4, ['ws\0b']: 9 },
      [stamped],
    );
    expect(counters.get('ws\0a')).toBe(7);
    expect(counters.get('ws\0b')).toBe(9);
  });

  it('aggregates dropped keys when individual markers would fill the cap', () => {
    const counters = new Map<string, number>();
    const events = ['a1', 'b1', 'a2', 'b2'].map((eventId) =>
      stampPortalEventRouting(
        scopedEvent(eventId, eventId.startsWith('a') ? 'a' : 'b'),
        counters,
      ),
    );
    const result = computePortalOutboxTrim(events, 2, null);
    expect(result.droppedRangeCount).toBe(1);
    const aggregate = result.kept.find(
      (event) => String(event.type) === 'portal.events.dropped',
    );
    expect(aggregate).toBeDefined();
    const payload = aggregate?.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('Expected an aggregate marker payload');
    }
    expect('aggregate' in payload && payload.aggregate).toBe(true);
    expect('reason' in payload && payload.reason).toBe('overflow');
    const keys = 'keys' in payload ? payload.keys : undefined;
    expect(keys).toEqual(expect.arrayContaining(['ws:a', 'ws:b']));
  });

  it('inherits a dropped aggregate marker into the next trim aggregate', () => {
    const counters = new Map<string, number>();
    const firstEvents = ['a1', 'b1', 'a2', 'b2'].map((eventId) =>
      stampPortalEventRouting(
        scopedEvent(eventId, eventId.startsWith('a') ? 'a' : 'b'),
        counters,
      ),
    );
    const first = computePortalOutboxTrim(firstEvents, 2, null);
    expect(first.droppedRangeCount).toBeGreaterThan(0);

    // Fill the queue past cap again so the NEXT trim drops the aggregate
    // marker produced by the first trim: its keys must survive into the
    // replacement aggregate, or the resync signal is silently lost.
    const secondEvents = [
      ...first.kept,
      ...['c1', 'd1', 'c2', 'd2'].map((eventId) =>
        stampPortalEventRouting(
          scopedEvent(eventId, eventId.startsWith('c') ? 'c' : 'd'),
          counters,
        ),
      ),
    ];
    const second = computePortalOutboxTrim(secondEvents, 2, null);
    const aggregate = second.kept.find(
      (event) => String(event.type) === 'portal.events.dropped',
    );
    expect(aggregate).toBeDefined();
    const payload2 = aggregate?.payload;
    if (
      typeof payload2 !== 'object' ||
      payload2 === null ||
      Array.isArray(payload2)
    ) {
      throw new Error('Expected an aggregate marker payload');
    }
    const keys2 = 'keys' in payload2 ? payload2.keys : undefined;
    expect(keys2).toEqual(expect.arrayContaining(['ws:a', 'ws:b']));
  });

  it('re-emits an aggregate when ONLY an aggregate marker is dropped', () => {
    const counters = new Map<string, number>();
    const firstEvents = ['a1', 'b1', 'a2', 'b2'].map((eventId) =>
      stampPortalEventRouting(
        scopedEvent(eventId, eventId.startsWith('a') ? 'a' : 'b'),
        counters,
      ),
    );
    const first = computePortalOutboxTrim(firstEvents, 2, null);
    const firstAggregate = first.kept.find(
      (event) => String(event.type) === 'portal.events.dropped',
    );
    if (!firstAggregate) throw new Error('Expected a first aggregate marker');

    const marked = createDroppedRangeMarkers({
      kept: first.kept.filter((event) => event !== firstAggregate),
      dropped: [firstAggregate],
      reason: 'overflow',
      createEventId: () => 'reissued-aggregate',
    });
    const reissued = marked.events.find(
      (event) => String(event.type) === 'portal.events.dropped',
    );
    expect(reissued).toBeDefined();
    const payload = reissued?.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('Expected reissued aggregate payload');
    }
    const keys = 'keys' in payload ? payload.keys : undefined;
    expect(keys).toEqual(expect.arrayContaining(['ws:a', 'ws:b']));
  });

  it('reserves final queue capacity for markers at the exact cap', () => {
    const counters = new Map<string, number>();
    const events = ['a1', 'b1', 'a2', 'b2'].map((eventId) =>
      stampPortalEventRouting(
        scopedEvent(eventId, eventId.startsWith('a') ? 'a' : 'b'),
        counters,
      ),
    );

    const result = computePortalOutboxTrim(events, 2, null);
    const restored: unknown = JSON.parse(JSON.stringify(result.kept));

    expect(result.kept.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(restored)).toContain('portal.events.dropped');
  });

  it('bounds markers when every event at the full cap has a distinct key', () => {
    const maxEvents = 500;
    const events = Array.from({ length: maxEvents + 1 }, (_, index) =>
      stampPortalEventRouting(
        scopedEvent(`event-${String(index)}`, `key-${String(index)}`),
        new Map<string, number>(),
      ),
    );

    const result = computePortalOutboxTrim(events, maxEvents, null);
    const aggregateMarker = result.kept.find((item) => {
      const payload = recordOf(item.payload);
      return payload?.aggregate === true;
    });
    const aggregatePayload = recordOf(aggregateMarker?.payload);

    expect(result.kept.length).toBeLessThanOrEqual(maxEvents);
    expect(aggregateMarker?.type).toBe('portal.events.dropped');
    expect(aggregatePayload).toMatchObject({
      aggregate: true,
      reason: 'overflow',
      truncatedKeyCount: 0,
    });
    expect(aggregatePayload?.keys).toEqual(['ws:key-0', 'ws:key-1']);
  });

  it('bounds aggregate marker keys and reports the truncated count', () => {
    const events = Array.from({ length: 102 }, (_, index) =>
      stampPortalEventRouting(
        scopedEvent(`event-${String(index)}`, `key-${String(index)}`),
        new Map<string, number>(),
      ),
    );

    const result = computePortalOutboxTrim(events, 1, null);
    const marker = result.kept[0];
    const markerPayload = recordOf(marker?.payload);

    expect(result.kept).toHaveLength(1);
    expect(marker?.type).toBe('portal.events.dropped');
    expect(markerPayload?.keys).toHaveLength(100);
    expect(markerPayload?.truncatedKeyCount).toBe(2);
  });

  it('places a marker between lower and higher surviving sequences for its key', () => {
    const counters = new Map<string, number>();
    const sequenced = Array.from({ length: 8 }, (_, index) =>
      stampPortalEventRouting(
        scopedEvent(`a${String(index + 1)}`, 'a'),
        counters,
      ),
    );
    const marked = createDroppedRangeMarkers({
      kept: sequenced.filter((_, index) => [2, 3, 7].includes(index)),
      dropped: sequenced.slice(4, 7),
      reason: 'overflow',
      createEventId: () => 'marker',
    });

    expect(marked.events.map((item) => item.eventId)).toEqual([
      'a3',
      'a4',
      'marker',
      'a8',
    ]);
  });

  it('gives a marker the oldest enqueue time in its dropped range', () => {
    const counters = new Map<string, number>();
    const dropped = [
      stampPortalEventRouting(scopedEvent('a1', 'a'), counters),
      stampPortalEventRouting(scopedEvent('a2', 'a'), counters),
    ];
    const timestamps = new WeakMap<PortalEventEnvelope, number>();
    timestamps.set(dropped[0], 1_000);
    timestamps.set(dropped[1], 2_000);

    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped,
      reason: 'overflow',
      createEventId: () => 'marker',
      enqueuedAt: timestamps,
      now: 3_000,
    });

    expect(timestamps.get(marked.events[0])).toBe(1_000);
  });

  it('merges a trimmed marker into its replacement instead of losing its range', () => {
    const survivor = stampPortalEventRouting(
      scopedEvent('a3', 'a'),
      new Map([['ws\0a', 2]]),
    );
    const existingMarker: PortalEventEnvelope = {
      ...scopedEvent('marker', 'a'),
      payload: {
        workspaceLocalId: 'ws',
        worktreeLocalId: 'a',
        routing: { key: 'ws:a' },
        fromSeq: 1,
        toSeq: 2,
        reason: 'overflow',
      },
    };
    Reflect.set(existingMarker, 'type', 'portal.events.dropped');
    const marked = createDroppedRangeMarkers({
      kept: [survivor],
      dropped: [existingMarker],
      reason: 'overflow',
      createEventId: () => 'replacement-marker',
    });
    expect(marked.events[0]?.payload).toMatchObject({ fromSeq: 1, toSeq: 2 });
    expect(marked.events[1]).toBe(survivor);
  });

  it('emits an oversized marker and preserves routing on snapshot split parts', () => {
    const dropped = stampPortalEventRouting(
      scopedEvent('too-big', 'a'),
      new Map(),
    );
    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped: [dropped],
      reason: 'oversized',
      createEventId: () => 'oversized-marker',
    });
    expect(marked.events[0]?.payload).toMatchObject({
      fromSeq: 1,
      toSeq: 1,
      reason: 'oversized',
    });

    const routedSnapshot = stampPortalEventRouting(
      snapshotEvent(
        Array.from({ length: 12 }, (_, index) =>
          entityOfSize(`routed-${index}`, 2_000),
        ),
      ),
      new Map(),
    );
    const split = splitOversizedPortalSnapshotEvent(routedSnapshot, 8_000);
    expect(split).not.toBeNull();
    expect(
      split?.events.every((part) => getPortalRoutingStamp(part)?.seq === 1),
    ).toBe(true);
    expect(split?.droppedEntityCount).toBe(0);
  });
});

interface SplitTestPayload {
  scope?: unknown;
  target?: unknown;
  entities?: Array<{ localId: string }>;
}

function payloadOf(part: PortalEventEnvelope): SplitTestPayload {
  return part.payload as SplitTestPayload;
}

function entityOfSize(localId: string, bytes: number): Record<string, unknown> {
  return {
    entityType: 'chat_summary',
    localId,
    parentLocalId: 'wt-1',
    payload: { title: localId, blob: 'x'.repeat(bytes) },
  };
}

function snapshotEvent(
  entities: Array<Record<string, unknown>>,
): PortalEventEnvelope {
  return {
    type: 'portal.state.snapshot',
    eventId: 'snap-1',
    occurredAt: '2026-06-11T00:00:00.000Z',
    payload: {
      scope: 'worktree',
      target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      generatedAt: '2026-06-11T00:00:00.000Z',
      entities,
    },
  } as unknown as PortalEventEnvelope;
}

describe('splitOversizedPortalSnapshotEvent', () => {
  it('returns null for oversized non-snapshot events (unsplittable)', () => {
    expect(
      splitOversizedPortalSnapshotEvent(event('portal.chat.event', 'e1'), 10),
    ).toBeNull();
  });

  it('splits a too-large snapshot into a snapshot head plus delta chunks under the cap', () => {
    const entities = Array.from({ length: 12 }, (_, i) =>
      entityOfSize(`entity-${i}`, 2_000),
    );
    const original = snapshotEvent(entities);
    const maxBytes = 8_000;
    expect(portalEventByteLength(original)).toBeGreaterThan(maxBytes);

    const split = splitOversizedPortalSnapshotEvent(original, maxBytes);
    expect(split).not.toBeNull();
    const parts = split?.events ?? [];
    expect(split?.droppedEntityCount).toBe(0);
    expect(parts.length).toBeGreaterThan(1);

    // Replace semantics live in the head: it stays a snapshot with the same
    // scope/target; the rest are upsert-only deltas so they cannot wipe the
    // head's entities.
    expect(parts[0].type).toBe('portal.state.snapshot');
    for (const part of parts.slice(1)) {
      expect(part.type).toBe('portal.state.delta');
    }

    // Every part fits, every entity survives exactly once, ids stay unique
    // and deterministic (so server-side idempotency still dedupes retries).
    const seenIds = new Set<string>();
    const seenEntities: string[] = [];
    for (const part of parts) {
      expect(portalEventByteLength(part)).toBeLessThanOrEqual(maxBytes);
      expect(seenIds.has(part.eventId)).toBe(false);
      seenIds.add(part.eventId);
      const payload = payloadOf(part);
      expect(payload.scope).toBe('worktree');
      expect(payload.target).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      });
      for (const entity of payload.entities ?? []) {
        seenEntities.push(entity.localId);
      }
    }
    expect(seenEntities.sort()).toEqual(
      entities.map((e) => String(e.localId)).sort(),
    );
  });

  it('drops only the single entity that cannot fit on its own', () => {
    const giant = entityOfSize('giant', 50_000);
    const small = entityOfSize('small', 1_000);
    const routedSnapshot = stampPortalEventRouting(
      snapshotEvent([giant, small]),
      new Map(),
    );
    const split = splitOversizedPortalSnapshotEvent(routedSnapshot, 8_000);
    expect(split).not.toBeNull();
    const survivors = (split?.events ?? []).flatMap((part) =>
      (payloadOf(part).entities ?? []).map((e) => e.localId),
    );
    expect(survivors).toEqual(['small']);
    expect(split?.droppedEntityCount).toBe(1);
    expect(split?.droppedEntityMarker?.payload).toMatchObject({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      routing: { key: 'ws-1:wt-1' },
      fromSeq: 1,
      toSeq: 1,
      reason: 'oversized',
      droppedEntityCount: 1,
      droppedEntityIds: [JSON.stringify(['chat_summary', 'wt-1', 'giant'])],
    });
  });

  it('returns a full-refresh marker when an unscoped snapshot omits an entity', () => {
    const original: PortalEventEnvelope = {
      ...snapshotEvent([
        entityOfSize('giant', 50_000),
        entityOfSize('small', 1_000),
      ]),
      payload: {
        scope: 'overview',
        entities: [entityOfSize('giant', 50_000), entityOfSize('small', 1_000)],
      },
    };

    const split = splitOversizedPortalSnapshotEvent(original, 8_000);

    expect(split?.droppedEntityCount).toBe(1);
    expect(split?.droppedEntityMarker?.type).toBe('portal.events.dropped');
    expect(split?.droppedEntityMarker?.payload).toMatchObject({
      aggregate: true,
      keys: [],
      truncatedKeyCount: 1,
      reason: 'oversized',
      droppedEntityCount: 1,
    });
  });

  it('preserves an unscoped omission signal when its marker is trimmed again', () => {
    const original: PortalEventEnvelope = {
      ...snapshotEvent([
        entityOfSize('giant', 50_000),
        entityOfSize('small', 1_000),
      ]),
      payload: {
        scope: 'overview',
        entities: [entityOfSize('giant', 50_000), entityOfSize('small', 1_000)],
      },
    };
    const split = splitOversizedPortalSnapshotEvent(original, 8_000);
    const omissionMarker = split?.droppedEntityMarker;
    expect(omissionMarker).not.toBeNull();

    const retrimmed = createDroppedRangeMarkers({
      kept: [],
      dropped: omissionMarker ? [omissionMarker] : [],
      reason: 'overflow',
      createEventId: () => 'replacement-omission-marker',
      maxEvents: 1,
    });

    expect(retrimmed.markerCount).toBe(1);
    expect(retrimmed.events).toHaveLength(1);
    expect(retrimmed.events[0]?.payload).toMatchObject({
      aggregate: true,
      keys: [],
      truncatedKeyCount: 1,
      reason: 'overflow',
    });
  });

  it('returns the original event untouched when it already fits', () => {
    const original = snapshotEvent([entityOfSize('only', 500)]);
    const split = splitOversizedPortalSnapshotEvent(original, 1_000_000);
    expect(split).toEqual({
      events: [original],
      droppedEntityCount: 0,
      droppedEntityMarker: null,
    });
  });
});

describe('computePortalOutboxTrim byte budget (CAN-2319)', () => {
  // Each event targets a DISTINCT worktree so none supersedes another: these
  // cases exercise the byte budget, not snapshot coalescing (which now runs
  // unconditionally and would otherwise collapse same-key filler snapshots
  // before the budget is ever consulted).
  function sizedEvent(
    eventId: string,
    payloadBytes: number,
  ): PortalEventEnvelope {
    return {
      type: 'portal.state.snapshot',
      eventId,
      occurredAt: '2026-08-17T00:00:00.000Z',
      payload: {
        scope: 'worktree',
        target: { workspaceLocalId: 'ws-1', worktreeLocalId: `wt-${eventId}` },
        filler: 'x'.repeat(payloadBytes),
      },
    };
  }

  function totalBytes(events: PortalEventEnvelope[]): number {
    return events.reduce((sum, e) => sum + portalEventByteLength(e), 0);
  }

  it('keeps everything when under both the count cap and the byte budget', () => {
    const events = [sizedEvent('s1', 1_000), sizedEvent('s2', 1_000)];
    const result = computePortalOutboxTrim(
      events,
      500,
      null,
      undefined,
      undefined,
      {
        maxBytes: 1_000_000,
      },
    );
    expect(result.kept).toEqual(events);
    expect(result.droppedCount).toBe(0);
  });

  it('drops oldest events past the byte budget even when the count cap is not reached', () => {
    const events = [
      sizedEvent('old-1', 100_000),
      sizedEvent('old-2', 100_000),
      sizedEvent('new-1', 100_000),
    ];
    const result = computePortalOutboxTrim(
      events,
      500,
      null,
      undefined,
      undefined,
      {
        maxBytes: 250_000,
      },
    );
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.kept.map((e) => e.eventId)).toContain('new-1');
    expect(result.kept.map((e) => e.eventId)).not.toContain('old-1');
    expect(totalBytes(result.kept)).toBeLessThanOrEqual(250_000);
  });

  it('bounds a stale-session snapshot pileup to the byte budget instead of the count cap', () => {
    // Regression shape from CAN-2319: 453 near-identical ~752KB snapshots sat
    // under the 500-entry cap while totalling ~294MB on disk.
    const events = Array.from({ length: 40 }, (_, i) =>
      sizedEvent(`snap-${String(i)}`, 50_000),
    );
    const result = computePortalOutboxTrim(
      events,
      500,
      null,
      undefined,
      undefined,
      {
        maxBytes: 500_000,
      },
    );
    expect(totalBytes(result.kept)).toBeLessThanOrEqual(500_000);
    // Newest snapshots survive; the stale backlog is what gets dropped.
    expect(result.kept.map((e) => e.eventId)).toContain('snap-39');
    expect(result.kept.map((e) => e.eventId)).not.toContain('snap-0');
  });

  it('drops background before foreground and emits range markers on a byte-only trim', () => {
    const counters = new Map<string, number>();
    const stamped = (
      worktreeLocalId: string,
      eventId: string,
      payloadBytes: number,
    ): PortalEventEnvelope =>
      stampPortalEventRouting(
        {
          type: 'portal.chat.event',
          eventId,
          occurredAt: '2026-08-17T00:00:00.000Z',
          payload: {
            workspaceLocalId: 'ws',
            worktreeLocalId,
            filler: 'x'.repeat(payloadBytes),
          },
        },
        counters,
      );
    const events = [
      stamped('bg', 'bg-1', 100_000),
      stamped('fg', 'fg-1', 100_000),
      stamped('bg', 'bg-2', 100_000),
      stamped('fg', 'fg-2', 100_000),
    ];
    const result = computePortalOutboxTrim(
      events,
      500,
      'ws\u0000fg',
      undefined,
      undefined,
      { maxBytes: 250_000 },
    );
    const keptIds = result.kept.map((e) => e.eventId);
    // Background lane is sacrificed first even though bg-2 is newer than fg-1.
    expect(keptIds).not.toContain('bg-1');
    expect(keptIds).toContain('fg-2');
    expect(result.droppedChatEventCount).toBeGreaterThan(0);
    // Dropped stamped events must leave resync markers, same as the count trim.
    expect(result.droppedRangeCount).toBeGreaterThan(0);
    expect(
      result.kept.some((e) => String(e.type) === 'portal.events.dropped'),
    ).toBe(true);
  });

  it('ignores the byte budget when it is not provided', () => {
    const events = [sizedEvent('s1', 100_000), sizedEvent('s2', 100_000)];
    const result = computePortalOutboxTrim(events, 500, null);
    expect(result.kept).toEqual(events);
    expect(result.droppedCount).toBe(0);
  });
});

describe('App Advisor routing lane (CAN-2569)', () => {
  function appAdvisorChatEvent(eventId: string): PortalEventEnvelope {
    return {
      ...event('portal.app_advisor.event', eventId),
      payload: {
        chatId: 'advisor-chat',
        message: { messageId: eventId, chatId: 'advisor-chat' },
      },
    };
  }

  function appAdvisorStateEvent(
    type: 'portal.state.delta' | 'portal.state.snapshot',
    eventId: string,
  ): PortalEventEnvelope {
    return {
      ...event(type, eventId),
      payload: { scope: 'app_advisor', entities: [] },
    };
  }

  function worktreeEvent(
    eventId: string,
    worktreeLocalId: string,
  ): PortalEventEnvelope {
    return {
      ...event('portal.chat.event', eventId),
      payload: { workspaceLocalId: 'ws', worktreeLocalId },
    };
  }

  it('stamps chat events and app_advisor-scoped state envelopes onto one shared lane', () => {
    const counters = new Map<string, number>();
    const stamped = [
      stampPortalEventRouting(appAdvisorChatEvent('adv-1'), counters),
      stampPortalEventRouting(
        appAdvisorStateEvent('portal.state.delta', 'adv-2'),
        counters,
      ),
      stampPortalEventRouting(worktreeEvent('a1', 'a'), counters),
      stampPortalEventRouting(
        appAdvisorStateEvent('portal.state.snapshot', 'adv-3'),
        counters,
      ),
    ];
    expect(stamped.map(getPortalRoutingStamp)).toEqual([
      { key: 'app-advisor', seq: 1 },
      { key: 'app-advisor', seq: 2 },
      { key: 'ws:a', seq: 1 },
      { key: 'app-advisor', seq: 3 },
    ]);
    // Deltas for other scopes still have no lane and stay unstamped.
    const otherScope = stampPortalEventRouting(
      {
        ...event('portal.state.delta', 'other'),
        payload: { scope: 'overview' },
      },
      counters,
    );
    expect(getPortalRoutingStamp(otherScope)).toBeNull();
  });

  it('restores the app-advisor counter floor from persisted counters and stamped events', () => {
    const stamped = stampPortalEventRouting(
      appAdvisorChatEvent('adv-1'),
      new Map([['app-advisor', 6]]),
    );
    const counters = restorePortalRoutingSequenceCounters(
      { ['app-advisor']: 4 },
      [stamped],
    );
    expect(counters.get('app-advisor')).toBe(7);
  });

  it('emits a routed gap marker without project fields when app-advisor events overflow', () => {
    const counters = new Map<string, number>();
    const advisorEvents = ['adv-1', 'adv-2'].map((eventId) =>
      stampPortalEventRouting(appAdvisorChatEvent(eventId), counters),
    );
    const foreground = stampPortalEventRouting(
      worktreeEvent('fg-1', 'selected'),
      counters,
    );

    // App Advisor events carry no worktree identity, so they sort into the
    // background drop bucket first — the lane's whole point is that the drop
    // now produces a resync marker instead of silent staleness.
    const result = computePortalOutboxTrim(
      [...advisorEvents, foreground],
      2,
      'ws\u0000selected',
    );

    expect(result.droppedCount).toBe(2);
    expect(result.droppedRangeCount).toBe(1);
    expect(result.kept.map((e) => e.eventId)).toContain('fg-1');
    const marker = result.kept.find(
      (e) => String(e.type) === 'portal.events.dropped',
    );
    expect(marker?.payload).toMatchObject({
      routing: { key: 'app-advisor' },
      fromSeq: 1,
      toSeq: 2,
      reason: 'overflow',
    });
    expect(marker?.payload).not.toHaveProperty('workspaceLocalId');
    expect(marker?.payload).not.toHaveProperty('worktreeLocalId');
  });

  it('recovers an app-advisor marker range when the marker itself is trimmed', () => {
    const survivor = stampPortalEventRouting(
      appAdvisorChatEvent('adv-3'),
      new Map([['app-advisor', 2]]),
    );
    const existingMarker: PortalEventEnvelope = {
      ...event('portal.heartbeat', 'marker'),
      payload: {
        routing: { key: 'app-advisor' },
        fromSeq: 1,
        toSeq: 2,
        reason: 'overflow',
      },
    };
    Reflect.set(existingMarker, 'type', 'portal.events.dropped');
    const marked = createDroppedRangeMarkers({
      kept: [survivor],
      dropped: [existingMarker],
      reason: 'overflow',
      createEventId: () => 'replacement-marker',
    });
    expect(marked.events[0]?.payload).toMatchObject({
      routing: { key: 'app-advisor' },
      fromSeq: 1,
      toSeq: 2,
    });
    expect(marked.events[1]).toBe(survivor);
  });
});

describe('computePortalOutboxTrim superseded snapshot coalescing', () => {
  // Unsolicited push snapshot (no `commandId`): the shape that actually
  // piles up. Command-correlated snapshots are covered by their own case
  // below and are deliberately never coalesced.
  const snapshot = (
    eventId: string,
    scope: string,
    target?: Record<string, string>,
  ): PortalEventEnvelope => ({
    ...event('portal.state.snapshot', eventId),
    payload: {
      scope,
      ...(target ? { target } : {}),
      generatedAt: '2026-06-10T00:00:00.000Z',
      entities: [],
    },
  });
  const backgroundChat = (eventId: string): PortalEventEnvelope => ({
    ...event('portal.chat.event', eventId),
    payload: { workspaceLocalId: 'ws-1', worktreeLocalId: 'other' },
  });

  it('reclaims a superseded same-target snapshot instead of a chat event', () => {
    // A browser that keeps re-requesting the overview leaves a pile of
    // overview snapshots in the outbox; only the newest one has value. The
    // old age-ordered trim sacrificed the (older) chat event instead.
    const events = [
      backgroundChat('chat-1'),
      snapshot('overview-old', 'overview'),
      snapshot('overview-new', 'overview'),
    ];

    const result = computePortalOutboxTrim(events, 2, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'chat-1',
      'overview-new',
    ]);
    // Coalescing alone brings the queue under the cap, so nothing is dropped
    // and no gap marker is emitted — the browser is never prompted to request
    // yet another snapshot to recover state it did not lose.
    expect(result.coalescedSnapshotCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedChatEventCount).toBe(0);
    expect(result.droppedRangeCount).toBe(0);
  });

  it('drops every superseded snapshot in a pileup before background chat events', () => {
    const events = [
      backgroundChat('chat-1'),
      snapshot('wt-old', 'worktree', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
      backgroundChat('chat-2'),
      snapshot('wt-mid', 'worktree', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
      snapshot('wt-new', 'worktree', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
    ];

    const result = computePortalOutboxTrim(events, 3, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'chat-1',
      'chat-2',
      'wt-new',
    ]);
    expect(result.droppedChatEventCount).toBe(0);
  });

  it('does not treat snapshots for different targets as superseding each other', () => {
    const events = [
      snapshot('wt-1', 'worktree', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
      snapshot('wt-2', 'worktree', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
      }),
      backgroundChat('chat-1'),
    ];

    const result = computePortalOutboxTrim(events, 2, null);

    // Nothing is superseded, so the ordinary oldest-background rule applies.
    // The dropped unrouted snapshot leaves a refresh-all marker, which takes
    // the last slot.
    expect(result.coalescedSnapshotCount).toBe(0);
    expect(result.kept.map((item) => item.eventId)).toEqual([
      'chat-1',
      expect.stringMatching(/^portal-drop-overflow-/),
    ]);
  });

  it('coalesces superseded snapshots even when the outbox is under both caps', () => {
    // A real user's outbox was observed pinned at 20,965,524 bytes — 6KB under
    // the 20MiB budget — holding 240 redundant `overview` snapshots behind a
    // stale session. Nothing ever reclaimed it because the trim only ran on
    // overflow, so the queue stayed full of waste and every genuinely new
    // event arrived already at the cap. A superseded snapshot is redundant at
    // ANY queue size, so coalescing runs unconditionally.
    const events = [
      snapshot('overview-old', 'overview'),
      snapshot('overview-new', 'overview'),
      backgroundChat('chat-1'),
    ];

    const result = computePortalOutboxTrim(events, 500, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'overview-new',
      'chat-1',
    ]);
    // Coalescing is not loss: the newer snapshot replaces the older wholesale,
    // so it is reported apart from the overflow drop counters.
    expect(result.coalescedSnapshotCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedChatEventCount).toBe(0);
    expect(result.droppedRangeCount).toBe(0);
  });

  it('keeps superseded routed snapshots while still coalescing unrouted overview snapshots', (): void => {
    const routedSnapshot = (
      eventId: string,
      seq: number,
    ): PortalEventEnvelope => ({
      ...event('portal.state.snapshot', eventId),
      payload: {
        scope: 'worktree',
        target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        routing: { key: 'ws-1\0wt-1', seq },
        entities: [],
      },
    });
    const routed = [routedSnapshot('old', 2), routedSnapshot('new', 3)];
    const result = computePortalOutboxTrim(routed, 10, null);

    expect(result.coalescedSnapshotCount).toBe(0);
    expect(result.kept).toEqual(routed);

    const overview = [
      snapshot('old-overview', 'overview'),
      snapshot('new-overview', 'overview'),
    ];
    const overviewResult = computePortalOutboxTrim(overview, 10, null);
    expect(overviewResult.coalescedSnapshotCount).toBe(1);
    expect(overviewResult.kept).toEqual([overview[1]]);
  });

  it('never coalesces a snapshot the browser is awaiting by commandId', () => {
    // The browser settles a repair only when it receives BOTH the snapshot
    // and the terminal control event for the SAME commandId
    // (`maybeSettleRepairCommand`). Coalescing a command-correlated snapshot
    // while its completion event stays queued would strand that repair until
    // it times out and reissues — adding outbox pressure instead of relieving
    // it. Observed pileups are unsolicited pushes (0 of 235 snapshots in a
    // real outbox carried a commandId), so excluding these costs nothing.
    const correlated = (
      eventId: string,
      commandId: string,
    ): PortalEventEnvelope => ({
      ...snapshot(eventId, 'overview'),
      commandId,
    });
    const events = [
      correlated('snap-awaited', 'cmd-1'),
      correlated('snap-newer', 'cmd-2'),
      backgroundChat('chat-1'),
    ];

    const result = computePortalOutboxTrim(events, 500, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'snap-awaited',
      'snap-newer',
      'chat-1',
    ]);
    expect(result.coalescedSnapshotCount).toBe(0);
  });

  it('never treats a snapshot carrying chat messages as superseded', () => {
    // Entities are replaced wholesale by a newer snapshot, but `chatMessages`
    // are upsert-only and each snapshot carries a bounded tail. An older
    // transcript-bearing snapshot can hold rows that have since aged out of
    // the newer one's window, and it is the only delivery for them, so it is
    // never shed ahead of ordinary background events.
    const withTranscript = (eventId: string): PortalEventEnvelope => ({
      ...snapshot(eventId, 'chat', { chatLocalId: 'chat-1' }),
      payload: {
        scope: 'chat',
        target: { chatLocalId: 'chat-1' },
        entities: [],
        chatMessages: [{ messageId: `m-${eventId}`, chatId: 'chat-1' }],
      },
    });
    // The chat event is the OLDEST here, so the plain age-ordered background
    // rule sheds it and keeps both snapshots. The superseded lane would
    // instead shed `chat-snap-old` and keep the chat event — that difference
    // is what this pins.
    const events = [
      backgroundChat('chat-1'),
      withTranscript('chat-snap-old'),
      withTranscript('chat-snap-new'),
    ];

    const result = computePortalOutboxTrim(events, 2, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'chat-snap-old',
      'chat-snap-new',
    ]);
    expect(result.droppedChatEventCount).toBe(1);
  });

  it('drops superseded snapshots first when only the byte budget overflows', () => {
    const bulky = (eventId: string, scope: string): PortalEventEnvelope => ({
      ...snapshot(eventId, scope),
      payload: {
        scope,
        generatedAt: '2026-06-10T00:00:00.000Z',
        entities: [
          { entityType: 'workspace', localId: 'x', payload: 'y'.repeat(600) },
        ],
      },
    });
    const events = [
      backgroundChat('chat-1'),
      bulky('overview-old', 'overview'),
      bulky('overview-new', 'overview'),
    ];
    const total = events.reduce(
      (sum, item) => sum + portalEventByteLength(item),
      0,
    );

    const result = computePortalOutboxTrim(
      events,
      10,
      null,
      undefined,
      undefined,
      {
        maxBytes: total - 100,
      },
    );

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'chat-1',
      'overview-new',
    ]);
    expect(result.droppedChatEventCount).toBe(0);
  });
});

describe('computePortalOutboxTrim command delivery groups (CAN-3961)', () => {
  function stateEvent(
    type: 'portal.state.snapshot' | 'portal.state.delta',
    eventId: string,
    commandId?: string,
  ): PortalEventEnvelope {
    return {
      type,
      eventId,
      ...(commandId ? { commandId } : {}),
      occurredAt: '2026-10-09T00:00:00.000Z',
      payload: { scope: 'overview', entities: [], filler: 'x'.repeat(2_000) },
    };
  }

  function completed(commandId: string): PortalEventEnvelope {
    return {
      type: 'portal.command.completed',
      commandId,
      eventId: `done-${commandId}`,
      occurredAt: '2026-10-09T00:00:00.000Z',
      payload: {
        commandId,
        sequenceNumber: 7,
        generatedAt: '2026-10-09T00:00:00.000Z',
      },
    };
  }

  it('drops every part of a command snapshot and fails its completion as retryable', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'head', 'cmd-1'),
      stateEvent('portal.state.delta', 'head:chunk-1', 'cmd-1'),
      stateEvent('portal.state.delta', 'head:chunk-2', 'cmd-1'),
      completed('cmd-1'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const result = computePortalOutboxTrim(events, 5, null, undefined, 0, {
      stateRequestCommandIds: new Set(['cmd-1']),
    });

    expect(
      result.kept.filter((item) => item.type.startsWith('portal.state.')),
    ).toEqual([]);
    expect(
      result.kept.some((item) => item.type === 'portal.command.completed'),
    ).toBe(false);
    expect(
      result.kept.find((item) => item.type === 'portal.command.failed'),
    ).toMatchObject({
      commandId: 'cmd-1',
      payload: {
        commandId: 'cmd-1',
        sequenceNumber: 7,
        retryable: true,
        error: { code: 'execution_failed' },
      },
    });
    expect(result.droppedCommandGroups).toMatchObject([
      {
        commandId: 'cmd-1',
        eventCount: 3,
        chunkCount: 2,
        eventTypes: { 'portal.state.snapshot': 1, 'portal.state.delta': 2 },
        failureQueued: true,
        failureEvent: { type: 'portal.command.failed' },
      },
    ]);
    expect(result.trimReason).toBe('count');
  });

  it('reports a dropped snapshot group whose completion is not queued yet', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'head', 'cmd-1'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const result = computePortalOutboxTrim(events, 3, null, undefined, 0, {
      maxBytes: portalEventByteLength(events[1]) * 2 + 400,
      stateRequestCommandIds: new Set(['cmd-1']),
    });

    expect(result.droppedCommandGroups).toEqual([
      expect.objectContaining({ commandId: 'cmd-1', failureQueued: false }),
    ]);
    expect(result.trimReason).toBe('bytes');
  });

  it('emits a refresh-all marker when an unrouted overview snapshot is dropped', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'overview-push'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const result = computePortalOutboxTrim(events, 3, null, undefined, 0, {
      maxBytes: portalEventByteLength(events[1]) * 2 + 400,
    });

    expect(result.kept.map((item) => item.eventId)).toEqual(
      expect.arrayContaining(['chat-1', 'chat-2']),
    );
    expect(
      result.kept.find((item) => String(item.type) === 'portal.events.dropped')
        ?.payload,
    ).toMatchObject({ aggregate: true, truncatedKeyCount: 1 });
  });

  it('drops an uncorrelated split head and its chunks together', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'push'),
      stateEvent('portal.state.delta', 'push:chunk-1'),
      stateEvent('portal.state.delta', 'push:chunk-2'),
      event('portal.chat.event', 'chat-1'),
    ];

    const result = computePortalOutboxTrim(events, 3, null);

    expect(
      result.kept.filter((item) => item.type.startsWith('portal.state.')),
    ).toEqual([]);
    expect(result.droppedCount).toBe(3);
  });

  it('drops other groups before an in-flight command group and never fails it', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'head', 'cmd-1'),
      completed('cmd-1'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const preferOthers = computePortalOutboxTrim(
      events,
      3,
      null,
      undefined,
      0,
      {
        stateRequestCommandIds: new Set(['cmd-1']),
        inFlightEvents: new Set([events[0]]),
      },
    );
    expect(preferOthers.kept.map((item) => item.eventId)).toEqual([
      'head',
      'done-cmd-1',
      'chat-2',
    ]);

    const hardCap = computePortalOutboxTrim(events, 1, null, undefined, 0, {
      stateRequestCommandIds: new Set(['cmd-1']),
      inFlightEvents: new Set([events[0]]),
    });
    expect(hardCap.kept).toHaveLength(1);
    expect(
      hardCap.kept.some((item) => item.type === 'portal.command.failed'),
    ).toBe(false);
    expect(hardCap.droppedCommandGroups).toEqual([]);
  });

  it('fails a command whose unsent chunk is trimmed while its head is in flight', () => {
    const events = [
      stateEvent('portal.state.snapshot', 'head', 'cmd-1'),
      stateEvent('portal.state.delta', 'head:chunk-1', 'cmd-1'),
      event('portal.chat.event', 'chat-1'),
      completed('cmd-1'),
    ];

    const result = computePortalOutboxTrim(events, 3, null, undefined, 0, {
      stateRequestCommandIds: new Set(['cmd-1']),
      inFlightEvents: new Set([events[0]]),
    });

    // The head stays (it may already be on the server); the failure follows
    // it, and the dropped unrouted chunk leaves a refresh-all marker.
    expect(result.kept.map((item) => String(item.type))).toEqual([
      'portal.state.snapshot',
      'portal.command.failed',
      'portal.events.dropped',
    ]);
    expect(
      result.kept.some((item) => item.type === 'portal.command.completed'),
    ).toBe(false);
    expect(result.droppedCommandGroups).toMatchObject([
      { commandId: 'cmd-1', chunkCount: 1, failureQueued: true },
    ]);
  });

  it('keeps the real completion of a mutating command whose correlated delta is dropped', () => {
    const events = [
      stateEvent('portal.state.delta', 'pr-delta', 'pr-create-1'),
      completed('pr-create-1'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const result = computePortalOutboxTrim(events, 3, null, undefined, 0, {
      stateRequestCommandIds: new Set(['cmd-other']),
    });

    expect(result.kept.map((item) => item.eventId)).toContain(
      'done-pr-create-1',
    );
    expect(
      result.kept.some((item) => item.type === 'portal.command.failed'),
    ).toBe(false);
    expect(result.droppedCommandGroups).toEqual([]);
  });

  it('keeps a mutating command completion when its events are dropped', () => {
    const events = [
      { ...event('portal.chat.event', 'sent'), commandId: 'send-1' },
      completed('send-1'),
      event('portal.chat.event', 'chat-1'),
      event('portal.chat.event', 'chat-2'),
    ];

    const result = computePortalOutboxTrim(events, 3, null);

    expect(result.kept.map((item) => item.eventId)).toEqual([
      'done-send-1',
      'chat-1',
      'chat-2',
    ]);
    expect(result.droppedCommandGroups).toEqual([]);
  });
});

describe('resolvePortalDroppedCommandEvent (CAN-3961)', () => {
  it('discards late parts and fails the late completion of a dropped command once', () => {
    const pending = new Set(['cmd-1']);
    const lateChunk: PortalEventEnvelope = {
      ...event('portal.state.delta', 'head:chunk-3'),
      commandId: 'cmd-1',
    };
    const lateCompletion: PortalEventEnvelope = {
      ...event('portal.command.completed', 'done-cmd-1'),
      commandId: 'cmd-1',
      payload: { commandId: 'cmd-1', sequenceNumber: 3 },
    };

    expect(resolvePortalDroppedCommandEvent(lateChunk, pending)).toBeNull();
    expect(
      resolvePortalDroppedCommandEvent(lateCompletion, pending),
    ).toMatchObject({
      type: 'portal.command.failed',
      commandId: 'cmd-1',
      payload: { commandId: 'cmd-1', sequenceNumber: 3, retryable: true },
    });
    expect(pending.has('cmd-1')).toBe(false);
    const unrelated = event('portal.chat.event', 'chat');
    expect(resolvePortalDroppedCommandEvent(unrelated, pending)).toBe(
      unrelated,
    );
  });
});
