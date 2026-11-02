import type * as CryptoModule from 'node:crypto';
import type {
  PairingTelemetryContext,
  PairingTelemetryOutcome,
} from '@canopy/desktop-instrumentation/pairing';
const mockPairingAttempts: Array<{
  context: PairingTelemetryContext;
  outcomes: PairingTelemetryOutcome[];
}> = [];
const mockStartPairingTelemetry = jest.fn(
  (context: PairingTelemetryContext) => {
    const outcomes: PairingTelemetryOutcome[] = [];
    mockPairingAttempts.push({ context, outcomes });
    return {
      end: (outcome: PairingTelemetryOutcome): void => {
        outcomes.push(outcome);
      },
    };
  },
);
// A wrapper: SWC hoists jest.mock above the mock's declaration.
jest.mock('../../lib/desktop-telemetry', () => ({
  startRemotePairingTelemetry: (
    context: PairingTelemetryContext,
  ): ReturnType<typeof mockStartPairingTelemetry> =>
    mockStartPairingTelemetry(context),
}));
const mockIsEnabled = jest.fn();
const mockLoadCanopyCloudAccount = jest.fn();
const mockCreatePortalSession = jest.fn();
const mockEndPortalSession = jest.fn();
const mockPollPortalCommands = jest.fn();
const mockSendPortalEvents = jest.fn();
const mockSendPortalHeartbeat = jest.fn();
const mockReadPortalStateStore = jest.fn();
const mockPersistPortalStopReason = jest.fn();
const mockPersistPortalEventOutbox = jest.fn<
  Promise<void>,
  [unknown[], Map<string, number>]
>();
const mockPersistCompletedPortalCommand = jest.fn();
const mockPersistPortalCommandCursor = jest.fn();
const mockClearActivePortalSession = jest.fn();
const mockReadCompletedPortalCommand = jest.fn();
const mockRecordAppDiagnostic = jest.fn();
const mockRecordSessionDiagnostic = jest.fn();
const mockClearWorktreeSummaryPortalFingerprints = jest.fn();

jest.mock('../../account-proxy/service', () => ({
  getAccountProxyStatus: jest.fn(() => Promise.resolve(null)),
  onAccountProxyInventoryChanged: jest.fn(() => jest.fn()),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  isAiCreditsChosenOverAccountProxy: jest.fn(() => false),
  subscribeAiCreditsRoutingModeChanges: jest.fn(() => jest.fn()),
}));

jest.mock('../../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    get isEnabled(): typeof mockIsEnabled {
      return mockIsEnabled;
    },
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  get loadCanopyCloudAccount(): typeof mockLoadCanopyCloudAccount {
    return mockLoadCanopyCloudAccount;
  },
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../canopy-portal-client', () => ({
  // Mirrors the real (code, message, status?) constructor so tests can mint
  // status-specific instances (409 inactive, 404 gone) for routing paths.
  CanopyPortalClientError: class CanopyPortalClientError extends Error {
    code: string;
    status: number;
    constructor(code = 'http-error', message = '', status = 500) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  assertLiveCanopyPortalSupport: jest.fn(),
  get createPortalSession(): typeof mockCreatePortalSession {
    return mockCreatePortalSession;
  },
  get endPortalSession(): typeof mockEndPortalSession {
    return mockEndPortalSession;
  },
  get pollPortalCommands(): typeof mockPollPortalCommands {
    return mockPollPortalCommands;
  },
  get sendPortalEvents(): typeof mockSendPortalEvents {
    return mockSendPortalEvents;
  },
  get sendPortalHeartbeat(): typeof mockSendPortalHeartbeat {
    return mockSendPortalHeartbeat;
  },
}));
jest.mock('../portal-state-store', () => ({
  get clearActivePortalSession(): typeof mockClearActivePortalSession {
    return mockClearActivePortalSession;
  },
  get persistCompletedPortalCommand(): typeof mockPersistCompletedPortalCommand {
    return mockPersistCompletedPortalCommand;
  },
  persistActivePortalSession: jest.fn(),
  get persistPortalCommandCursor(): typeof mockPersistPortalCommandCursor {
    return mockPersistPortalCommandCursor;
  },
  get persistPortalEventOutbox(): typeof mockPersistPortalEventOutbox {
    return mockPersistPortalEventOutbox;
  },
  get persistPortalStopReason(): typeof mockPersistPortalStopReason {
    return mockPersistPortalStopReason;
  },
  get readCompletedPortalCommand(): typeof mockReadCompletedPortalCommand {
    return mockReadCompletedPortalCommand;
  },
  get readPortalStateStore(): typeof mockReadPortalStateStore {
    return mockReadPortalStateStore;
  },
}));
jest.mock('../../services/terminal-service', () => ({
  subscribeTerminalPortalEvents: jest.fn(() => jest.fn()),
}));
const mockObservabilityListeners = new Set<(event: unknown) => void>();
const mockObservabilitySubscribe = jest.fn(
  (listener: (event: unknown) => void): (() => void) => {
    mockObservabilityListeners.add(listener);
    return (): void => {
      mockObservabilityListeners.delete(listener);
    };
  },
);
const mockGetUsageOverview = jest.fn();
jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    get recordAppDiagnostic(): typeof mockRecordAppDiagnostic {
      return mockRecordAppDiagnostic;
    },
    get recordSessionDiagnostic(): typeof mockRecordSessionDiagnostic {
      return mockRecordSessionDiagnostic;
    },
    get subscribe(): typeof mockObservabilitySubscribe {
      return mockObservabilitySubscribe;
    },
    get getUsageOverview(): typeof mockGetUsageOverview {
      return mockGetUsageOverview;
    },
  }),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  get clearWorktreeSummaryPortalFingerprints(): typeof mockClearWorktreeSummaryPortalFingerprints {
    return mockClearWorktreeSummaryPortalFingerprints;
  },
}));
jest.mock('../portal-command-handlers', () => ({
  handlePortalCommand: jest.fn(),
  executePortalStateRequest: jest.fn(),
  // The real normalizer lives in the mocked module; a shape-preserving stub
  // keeps the manager's hand-off path (which normalizes before enqueueing to
  // the lane) working without dragging in the adapters' Electron graph.
  normalizeStateRequestPayload: (payload: unknown): unknown =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { scope: 'overview', ...payload }
      : { scope: 'overview' },
}));

import {
  compactPortalEvent,
  enqueuePortalEventForTest,
  flushPortalOutboxForTest,
  getCanopyPortalState,
  getLastTargetedPortalWorktreeKeyForTest,
  getPortalEventWorktreeIdentityForTest,
  handleSnapshotLaneErrorForTest,
  PORTAL_OUTBOX_STARVATION_BOUND_MS,
  PORTAL_CONTROL_LANE_MAX_COUNT,
  removePortalEventBatchForTest,
  cancelCanopyPortalPairingCode,
  handlePortalPowerResumeForTest,
  regenerateCanopyPortalPairingCode,
  resumeCanopyPortalIfPossible,
  selectPortalEventBatchForTest,
  setCanopyPortalPowerMonitor,
  startCanopyPortal,
  stopCanopyPortal,
} from '../portal-session-manager';

function isRecordForTest(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

it('keeps a validated visual reference and heights through chat compaction', () => {
  const visual = {
    version: 1,
    visualId: 'vis_11111111-1111-4111-8111-111111111111',
    artifactId: 'artifact',
    byteLength: 0,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
    heights: [[100, 200]],
  };
  const event: PortalTestEvent = {
    type: 'portal.chat.event',
    eventId: 'event-visual',
    occurredAt: '2026-10-08T00:00:00.000Z',
    payload: {
      message: { parts: [{ kind: 'tool_result', data: { visual } }] },
    },
  };
  expect(compactPortalEvent(event)).toMatchObject(event);
});

it('keeps visual-only parts past the compacted part cap', () => {
  const visual = {
    version: 1,
    visualId: 'vis_22222222-2222-4222-8222-222222222222',
    artifactId: 'artifact',
    byteLength: 10,
    sha256: 'b'.repeat(64),
    mediaType: 'text/html',
    title: 'Late chart',
    maxHeight: 400,
  };
  const parts: unknown[] = Array.from({ length: 30 }, (_, index) => ({
    kind: 'text',
    data: { text: `part ${String(index)}` },
  }));
  parts[26] = {
    kind: 'tool_result',
    data: { toolUseId: 'tool-late', messageId: 'message-late', visual },
  };
  const event: PortalTestEvent = {
    type: 'portal.chat.event',
    eventId: 'event-late-visual',
    occurredAt: '2026-10-08T00:00:00.000Z',
    payload: { message: { parts } },
  };
  const compacted = compactPortalEvent(event).payload;
  const message = isRecordForTest(compacted) ? compacted.message : undefined;
  const compactedParts =
    isRecordForTest(message) && Array.isArray(message.parts)
      ? message.parts
      : [];
  expect(compactedParts).toContainEqual({
    kind: 'tool_result',
    data: { toolUseId: 'tool-late', messageId: 'message-late', visual },
  });
  expect(compactedParts.at(-1)).toBe('[truncated 6 items]');
});

it('sends two full visual pages in separate sub-512 KiB batches', () => {
  const data = Buffer.alloc(384_000, 97).toString('base64');
  const events: PortalTestEvent[] = [0, 1].map((index) => ({
    type: 'portal.command.completed',
    eventId: `visual-${String(index)}`,
    commandId: `command-${String(index)}`,
    occurredAt: '2026-10-08T00:00:00.000Z',
    payload: {
      commandId: `command-${String(index)}`,
      sequenceNumber: index + 1,
      generatedAt: '2026-10-08T00:00:00.000Z',
      result: {
        kind: 'inline-page',
        data,
        offset: index * 384_000,
        length: 384_000,
        byteLength: 768_000,
        sha256: 'a'.repeat(64),
      },
    },
  }));
  const first = selectPortalEventBatchForTest(events);
  const second = selectPortalEventBatchForTest(
    events.filter((event) => !first.includes(event)),
  );
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  for (const batch of [first, second])
    expect(
      Buffer.byteLength(JSON.stringify({ events: batch }), 'utf8'),
    ).toBeLessThan(524_288);
});
import type { PortalPowerMonitor } from '../portal-session-manager';
import { CanopyPortalClientError } from '../canopy-portal-client';
import {
  executePortalStateRequest,
  handlePortalCommand,
} from '../portal-command-handlers';
import { enqueuePortalEvent } from '../portal-event-bus';
import {
  createDroppedRangeMarkers,
  portalEventByteLength,
} from '../portal-outbox';
import {
  PORTAL_EVENT_BATCH_MAX_BYTES,
  PORTAL_EVENT_BATCH_MAX_COUNT,
} from '@canopy/desktop-shared/types';
import { PORTAL_CHAT_TEXT_MAX_CHARS } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { sanitizeStorableString } from '@canopy/protocol/portal';
import {
  isAgentDelegationCardData,
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import { persistedParts } from '@canopy/desktop-shared/portal/persisted-chat-projection';

const mockHandlePortalCommand = jest.mocked(handlePortalCommand);
const mockExecutePortalStateRequest = jest.mocked(executePortalStateRequest);

type PortalTestEvent = Parameters<typeof compactPortalEvent>[0];

function routedEvent(
  eventId: string,
  worktreeLocalId: string | null,
  content = '',
): Parameters<typeof compactPortalEvent>[0] {
  return {
    eventId,
    type: 'portal.chat.event',
    occurredAt: '2026-07-31T00:00:00.000Z',
    payload:
      worktreeLocalId === null
        ? { content }
        : { workspaceLocalId: 'ws', worktreeLocalId, content },
  };
}

function controlEvent(
  eventId: string,
  commandId: string,
  type:
    | 'portal.command.completed'
    | 'portal.command.failed' = 'portal.command.completed',
): Parameters<typeof compactPortalEvent>[0] {
  return {
    eventId,
    type,
    commandId,
    occurredAt: '2026-07-31T00:00:00.000Z',
    payload: { commandId, sequenceNumber: 1, generatedAt: 1 },
  };
}

function snapshotEvent(
  eventId: string,
  commandId: string,
  content = '',
): Parameters<typeof compactPortalEvent>[0] {
  return {
    eventId,
    type: 'portal.state.snapshot',
    commandId,
    occurredAt: '2026-07-31T00:00:00.000Z',
    payload: { content },
  };
}

describe('portal outbox control lane (CAN-2360)', () => {
  it('promotes a completed event past a foreign jumbo snapshot', () => {
    const events = [
      snapshotEvent('foreign-snapshot', 'cmd-a', 'x'.repeat(64)),
      controlEvent('completed-b', 'cmd-b'),
    ];
    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      )[0],
    ).toBe('completed-b');
  });

  it('holds a completed event behind its own still-queued snapshot chunks', () => {
    const events = [
      snapshotEvent('own-snap-1', 'cmd-a'),
      snapshotEvent('own-snap-2', 'cmd-a'),
      controlEvent('completed-a', 'cmd-a'),
    ];
    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      ),
    ).toEqual(['own-snap-1', 'own-snap-2', 'completed-a']);
  });

  it('promotes failed events like completed events', () => {
    const events = [
      snapshotEvent('foreign-snapshot', 'cmd-a'),
      controlEvent('failed-b', 'cmd-b', 'portal.command.failed'),
    ];
    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      )[0],
    ).toBe('failed-b');
  });

  it('promotes control events even in FIFO starvation mode', () => {
    const events = [
      snapshotEvent('old-foreign-snapshot', 'cmd-a'),
      controlEvent('completed-b', 'cmd-b'),
    ];
    const stamps = new WeakMap<
      Parameters<typeof compactPortalEvent>[0],
      number
    >();
    stamps.set(events[0], 1_000);
    expect(
      selectPortalEventBatchForTest(
        events,
        'ws\0selected',
        stamps,
        1_000 + PORTAL_OUTBOX_STARVATION_BOUND_MS,
      ).map((item) => item.eventId)[0],
    ).toBe('completed-b');
  });

  it('does not let control events act as barriers for state-bearing reordering', () => {
    const events = [
      controlEvent('completed-b', 'cmd-b'),
      routedEvent('background-1', 'other'),
      routedEvent('foreground-1', 'selected'),
    ];
    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      ),
    ).toEqual(['completed-b', 'foreground-1', 'background-1']);
  });

  it('keeps control events FIFO among themselves and round-trips removal', () => {
    const events = [
      controlEvent('completed-1', 'cmd-1'),
      snapshotEvent('foreign-snapshot', 'cmd-x'),
      controlEvent('completed-2', 'cmd-2'),
    ];
    const batch = selectPortalEventBatchForTest(events, 'ws\0selected');
    // Both controls are promoted ahead of the snapshot; the (small) snapshot
    // still fits the batch afterward via the normal FIFO tail.
    expect(batch.map((item) => item.eventId)).toEqual([
      'completed-1',
      'completed-2',
      'foreign-snapshot',
    ]);
    const remaining = removePortalEventBatchForTest(events, batch);
    expect(remaining).toEqual([]);
  });

  it('caps the control lane so a completion burst cannot starve bulk lanes', () => {
    const events = [
      ...Array.from({ length: PORTAL_CONTROL_LANE_MAX_COUNT + 10 }, (_, i) =>
        controlEvent(`completed-${i}`, `cmd-${i}`),
      ),
      routedEvent('foreground-1', 'selected'),
    ];
    const batch = selectPortalEventBatchForTest(events, 'ws\0selected');
    // Only the first PORTAL_CONTROL_LANE_MAX_COUNT completions are PROMOTED;
    // the overflow stays behind and flows through the ordinary FIFO rules, so
    // bulk events (foreground-1) still make it into the batch.
    const promoted = batch.slice(0, PORTAL_CONTROL_LANE_MAX_COUNT);
    expect(
      promoted.every((item) => item.eventId.startsWith('completed-')),
    ).toBe(true);
    expect(batch.map((item) => item.eventId)).toContain('foreground-1');
  });
});

describe('portal event priority batches', () => {
  it('selects foreground first, preserves per-key order, and never crosses an unscoped barrier', () => {
    const events = [
      routedEvent('background-1', 'other'),
      routedEvent('foreground-1', 'selected'),
      routedEvent('unscoped-1', null),
      routedEvent('background-2', 'other'),
      routedEvent('foreground-2', 'selected'),
      routedEvent('unscoped-2', null),
    ];

    // foreground-2 must NOT be promoted past unscoped-1: unscoped snapshots
    // overlap every routing key and projection is last-write-wins.
    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      ),
    ).toEqual([
      'foreground-1',
      'background-1',
      'unscoped-1',
      'background-2',
      'foreground-2',
      'unscoped-2',
    ]);
  });

  it('withholds the tail when a byte-limited pre-barrier event is unselected', () => {
    // foreground fits; the big background event hits the byte target and is
    // left unselected; the small unscoped snapshot AFTER it must not be
    // selected past it (its later delivery would let the older background
    // event overwrite the newer snapshot state).
    const bigContent = 'x'.repeat(PORTAL_EVENT_BATCH_MAX_BYTES);
    const events = [
      routedEvent('foreground-fits', 'selected'),
      routedEvent('background-too-big', 'other', bigContent),
      routedEvent('unscoped-later', null),
    ];

    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      ),
    ).toEqual(['foreground-fits']);
  });

  it('keeps an older overview snapshot ahead of a newer foreground delta', () => {
    const events = [
      routedEvent('older-overview-snapshot', null),
      routedEvent('newer-foreground-delta', 'selected'),
    ];

    expect(
      selectPortalEventBatchForTest(events, 'ws\0selected').map(
        (item) => item.eventId,
      ),
    ).toEqual(['older-overview-snapshot', 'newer-foreground-delta']);
  });

  it('falls back to plain FIFO when the oldest event reaches the starvation bound', () => {
    const events = [
      routedEvent('old-background', 'other'),
      routedEvent('foreground', 'selected'),
    ];
    const stamps = new WeakMap<
      Parameters<typeof compactPortalEvent>[0],
      number
    >();
    stamps.set(events[0], 1_000);

    expect(
      selectPortalEventBatchForTest(
        events,
        'ws\0selected',
        stamps,
        1_000 + PORTAL_OUTBOX_STARVATION_BOUND_MS,
      ).map((item) => item.eventId),
    ).toEqual(['old-background', 'foreground']);
  });

  it('applies the FIFO starvation bound to an old dropped-range marker', () => {
    const dropped = routedEvent('dropped', 'other');
    dropped.payload = {
      workspaceLocalId: 'ws',
      worktreeLocalId: 'other',
      routing: { key: 'ws:other', seq: 1 },
    };
    // A surviving same-key event above the dropped range pins the marker to
    // the queue head (seq-aware placement), where its inherited old stamp
    // must trigger the FIFO starvation fallback.
    const laterSameKey = routedEvent('later-same-key', 'other');
    laterSameKey.payload = {
      workspaceLocalId: 'ws',
      worktreeLocalId: 'other',
      routing: { key: 'ws:other', seq: 2 },
    };
    const stamps = new WeakMap<
      Parameters<typeof compactPortalEvent>[0],
      number
    >();
    stamps.set(dropped, 1_000);
    const marked = createDroppedRangeMarkers({
      kept: [laterSameKey, routedEvent('foreground', 'selected')],
      dropped: [dropped],
      reason: 'overflow',
      createEventId: () => 'old-marker',
      enqueuedAt: stamps,
      now: 2_000,
    });

    expect(marked.events.map((item) => item.eventId)).toEqual([
      'old-marker',
      'later-same-key',
      'foreground',
    ]);
    expect(
      selectPortalEventBatchForTest(
        marked.events,
        'ws\0selected',
        stamps,
        1_000 + PORTAL_OUTBOX_STARVATION_BOUND_MS,
      ).map((item) => item.eventId),
    ).toEqual(['old-marker', 'later-same-key', 'foreground']);
  });

  it('respects count and byte budgets after priority reordering', () => {
    const countEvents = Array.from(
      { length: PORTAL_EVENT_BATCH_MAX_COUNT + 10 },
      (_, index) => routedEvent(`event-${String(index)}`, 'selected'),
    );
    expect(
      selectPortalEventBatchForTest(countEvents, 'ws\0selected'),
    ).toHaveLength(PORTAL_EVENT_BATCH_MAX_COUNT);

    const byteEvents = [
      routedEvent('foreground-large-1', 'selected', 'x'.repeat(600_000)),
      routedEvent('foreground-large-2', 'selected', 'x'.repeat(600_000)),
      routedEvent('background-small', 'other', 'x'.repeat(1_000)),
    ];
    const byteBatch = selectPortalEventBatchForTest(byteEvents, 'ws\0selected');
    expect(byteBatch.map((item) => item.eventId)).toEqual([
      'foreground-large-1',
      'background-small',
    ]);
    expect(
      Buffer.byteLength(JSON.stringify({ events: byteBatch }), 'utf8'),
    ).toBeLessThan(PORTAL_EVENT_BATCH_MAX_BYTES);
  });

  it('moves a newly selected key without reordering that key', () => {
    const events = [
      routedEvent('k-1', 'key-k'),
      routedEvent('other-1', 'other'),
      routedEvent('k-2', 'key-k'),
      routedEvent('other-2', 'other'),
      routedEvent('k-3', 'key-k'),
    ];
    expect(
      selectPortalEventBatchForTest(events, 'ws\0key-k')
        .filter((item) => item.eventId.startsWith('k-'))
        .map((item) => item.eventId),
    ).toEqual(['k-1', 'k-2', 'k-3']);
  });

  it('removes a reordered batch by object identity without skipping queued events', () => {
    const events = [
      routedEvent('background-1', 'other'),
      routedEvent('foreground-1', 'selected'),
      routedEvent('background-2', 'other'),
      routedEvent('foreground-2', 'selected'),
    ];
    const batch = selectPortalEventBatchForTest(events, 'ws\0selected');
    const inFlightEnqueue = routedEvent('background-3', 'other');

    expect(
      removePortalEventBatchForTest([...events, inFlightEnqueue], batch).map(
        (item) => item.eventId,
      ),
    ).toEqual(['background-3']);
    expect(new Set(batch.map((item) => item.eventId)).size).toBe(batch.length);
  });

  it('moves ten foreground events from three FIFO batches into priority batch one', () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      routedEvent(
        `background-${String(index)}`,
        `background-${String(index % 20)}`,
      ),
    );
    for (let index = 0; index < 10; index += 1) {
      events.splice(
        20 + index * 21,
        0,
        routedEvent(`foreground-${String(index)}`, 'selected'),
      );
    }
    const oldFifoPositions = events.flatMap((item, index) =>
      item.eventId.startsWith('foreground-') ? [index + 1] : [],
    );
    const oldFifoBatchNumbers = oldFifoPositions.map((position) =>
      Math.ceil(position / PORTAL_EVENT_BATCH_MAX_COUNT),
    );
    const priorityBatch = selectPortalEventBatchForTest(events, 'ws\0selected');

    expect(oldFifoPositions).toEqual([
      21, 42, 63, 84, 105, 126, 147, 168, 189, 210,
    ]);
    expect(oldFifoBatchNumbers).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
    expect(
      priorityBatch
        .filter((item) => item.eventId.startsWith('foreground-'))
        .map((item) => item.eventId),
    ).toEqual(
      Array.from({ length: 10 }, (_, index) => `foreground-${String(index)}`),
    );
  });
});

describe('portal event worktree identity', () => {
  const envelope = (
    payload: unknown,
  ): Parameters<typeof compactPortalEvent>[0] => ({
    eventId: 'event-1',
    type: 'portal.script.event',
    occurredAt: '2026-07-31T00:00:00.000Z',
    payload,
  });

  it('reads direct payload/target identity', () => {
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({ workspaceLocalId: 'ws-1', worktreeLocalId: 'tree-1' }),
      ),
    ).toEqual({ workspaceLocalId: 'ws-1', worktreeLocalId: 'tree-1' });
  });

  it('reads composite parentLocalId from feature upsert entities', () => {
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({
          kind: 'upsert',
          entity: {
            entityType: 'script',
            localId: 'run-1',
            parentLocalId: 'ws-1:tree-2',
          },
        }),
      ),
    ).toEqual({ workspaceLocalId: 'ws-1', worktreeLocalId: 'tree-2' });
  });

  it('reads composite parentLocalId from feature removals', () => {
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({
          kind: 'remove',
          entityType: 'script',
          localId: 'run-1',
          parentLocalId: 'ws-2:tree-3',
        }),
      ),
    ).toEqual({ workspaceLocalId: 'ws-2', worktreeLocalId: 'tree-3' });
  });

  it('returns null when a payload spans multiple worktrees', () => {
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({
          entities: [
            {
              entityType: 'worktree_actions',
              localId: 'actions-1',
              parentLocalId: 'ws-1:tree-1',
            },
            {
              entityType: 'worktree_actions',
              localId: 'actions-2',
              parentLocalId: 'ws-1:tree-2',
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({
          entities: [
            {
              entityType: 'worktree_actions',
              localId: 'actions-1',
              parentLocalId: 'ws-1:tree-1',
            },
            {
              entityType: 'worktree_actions',
              localId: 'actions-2',
              parentLocalId: 'ws-1:tree-1',
            },
          ],
        }),
      ),
    ).toEqual({ workspaceLocalId: 'ws-1', worktreeLocalId: 'tree-1' });
  });

  it('returns null for bare (non-composite) parentLocalId and missing identity', () => {
    expect(
      getPortalEventWorktreeIdentityForTest(
        envelope({
          kind: 'remove',
          entityType: 'workspace',
          localId: 'ws-1',
          parentLocalId: 'ws-1',
        }),
      ),
    ).toBeNull();
    expect(getPortalEventWorktreeIdentityForTest(envelope({}))).toBeNull();
  });
});

describe('portal snapshot compaction', () => {
  it('keeps the full deep chat seed instead of re-capping it to 80 rows', () => {
    const chatMessages = Array.from({ length: 150 }, (_, index) => ({
      messageId: `message-${index}`,
      chatId: 'chat-1',
      role: 'assistant' as const,
      status: 'complete' as const,
      text: `message ${index}`,
      createdAtMs: index,
    }));

    const compacted = compactPortalEvent({
      eventId: 'event-1',
      type: 'portal.state.snapshot',
      occurredAt: '2026-07-22T00:00:00.000Z',
      payload: { scope: 'chat', chatMessages },
    });

    const payload = compacted.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('chatMessages' in payload) ||
      !Array.isArray(payload.chatMessages)
    ) {
      throw new Error('Expected compacted snapshot chat messages');
    }
    expect(payload.chatMessages).toHaveLength(150);
  });

  it("keeps an agent part's delegation card structured through outbox compaction", () => {
    const delegation = {
      delegationId: 'child-1',
      status: 'pending',
      requestedModelId: 'reviewer',
      outputTruncated: false,
      phase: 'queued',
      queue: { id: 'default', name: 'Default' },
      capabilities: {
        inherit: true,
        discovery: false,
        items: [{ kind: 'skill', name: 'code-review', source: 'inherited' }],
        skipped: [],
        omittedItems: 0,
      },
      parentHarnessId: 'claude',
      description: 'Queued review',
      prompt: 'Read the source.',
      executionMode: 'background',
    };
    expect(isAgentDelegationCardData(delegation)).toBe(true);

    const compacted = compactPortalEvent({
      eventId: 'event-delegation-card',
      type: 'portal.chat.event',
      occurredAt: '2026-10-20T00:00:00.000Z',
      payload: {
        message: {
          messageId: 'message-1',
          parts: [{ kind: 'agent', data: { delegation, subBlocks: [] } }],
        },
      },
    });

    const message: unknown = Reflect.get(Object(compacted.payload), 'message');
    const parts: unknown = Reflect.get(Object(message), 'parts');
    const part: unknown = Array.isArray(parts) ? parts.at(0) : undefined;
    const card: unknown = Reflect.get(
      Object(Reflect.get(Object(part), 'data')),
      'delegation',
    );
    // projectPortalDelegationPart may add compatibility fields such as selectedModelId.
    expect(card).toMatchObject(delegation);
    expect(isAgentDelegationCardData(card)).toBe(true);
  });

  it("keeps a real settled delegate's card valid through outbox compaction", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      kind: 'skill' as const,
      name: `skill-${index}`,
      source: 'inherited' as const,
    }));
    const transcript: AgentDelegationTranscript = {
      delegationId: 'child-done',
      runGeneration: 1,
      sequence: 4,
      parentHarnessId: 'claude',
      parentTurnId: 'user-1',
      parentToolCallId: 'call-1',
      createdAt: 1000,
      task: {
        description: 'Review the change',
        prompt: 'Read the source and report.',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'child-done',
        status: 'completed',
        requestedModelId: 'reviewer',
        routeSnapshot: {
          selectedModelId: 'reviewer',
          runtimeModelId: 'claude-sonnet',
          harnessId: 'claude',
          runtimeKind: 'claude',
          runnerRegistrationId: 'runner-1',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'catalog',
          providerType: 'claude',
          assignmentRevision: 'revision-1',
          billingAuthority: 'none',
          aiCreditsRouted: false,
          requestedThinkingLevel: 'high',
          effectiveThinkingLevel: 'high',
          selectedModelLabel: 'Reviewer',
          runtimeModelLabel: 'Sonnet',
          capabilities: [],
          supportedThinkingLevels: ['high'],
          capabilitySnapshotHash: 'capabilities-1',
          capabilityGeneration: 1,
          policyRevision: 'policy-1',
        },
        nativeSessionId: 'native-1',
        partialText: 'Working',
        finalText: 'x'.repeat(10_000),
        outputTruncated: false,
        usage: { inputTokens: 10, outputTokens: 5 },
        resultIndex: 1,
        runGeneration: 1,
        depth: 1,
        capabilities: {
          inherit: true,
          discovery: false,
          items,
          skipped: [],
          omittedItems: 0,
        },
      },
      transcript: [],
    };
    expect(isAgentDelegationTranscript(transcript)).toBe(true);
    const [message] = delegationTranscriptMessages(transcript);
    if (!message) throw new Error('Expected a delegation message');
    const parts = persistedParts(message);

    const compacted = compactPortalEvent({
      eventId: 'event-real-delegation-card',
      type: 'portal.chat.event',
      occurredAt: '2026-10-20T00:00:00.000Z',
      payload: { message: { messageId: 'message-1', parts } },
    });

    const compactedMessage: unknown = Reflect.get(
      Object(compacted.payload),
      'message',
    );
    const compactedParts: unknown = Reflect.get(
      Object(compactedMessage),
      'parts',
    );
    const part: unknown = Array.isArray(compactedParts)
      ? compactedParts.at(0)
      : undefined;
    const card: unknown = Reflect.get(
      Object(Reflect.get(Object(part), 'data')),
      'delegation',
    );
    expect(isAgentDelegationCardData(card)).toBe(true);
    // The Portal projection keeps the newest capability items and counts the rest.
    const capabilities: unknown = Reflect.get(Object(card), 'capabilities');
    expect(Reflect.get(Object(capabilities), 'items')).toEqual(items.slice(-8));
    expect(Reflect.get(Object(capabilities), 'omittedItems')).toBe(22);
    // Long text keeps the outbox's string cap.
    expect(String(Reflect.get(Object(card), 'finalText')).length).toBeLessThan(
      10_000,
    );
  });

  it('preserves long projected chat responses through outbox compaction (CAN-3146)', () => {
    const text = 'x'.repeat(PORTAL_CHAT_TEXT_MAX_CHARS);
    const compacted = compactPortalEvent({
      eventId: 'event-2',
      type: 'portal.app_advisor.event',
      occurredAt: '2026-08-26T00:00:00.000Z',
      payload: {
        chatId: 'chat-1',
        message: {
          messageId: 'message-1',
          chatId: 'chat-1',
          role: 'assistant',
          status: 'complete',
          text,
          createdAtMs: 0,
        },
      },
    });

    const payload = compacted.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('message' in payload) ||
      typeof payload.message !== 'object' ||
      payload.message === null ||
      !('text' in payload.message) ||
      typeof payload.message.text !== 'string'
    ) {
      throw new Error('Expected compacted App Advisor chat message');
    }
    expect(payload.message.text).toBe(text);
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    const maxChars = PORTAL_CHAT_TEXT_MAX_CHARS;
    const suffix = '\n\n[truncated 1 chars]';
    const sliceEnd = maxChars - suffix.length;
    const text = `${'x'.repeat(sliceEnd - 1)}😀${'y'.repeat(
      maxChars + 1 - sliceEnd - 1,
    )}`;
    expect(text).toHaveLength(maxChars + 1);

    const compacted = compactPortalEvent({
      eventId: 'event-surrogate-boundary',
      type: 'portal.chat.event',
      occurredAt: '2026-10-02T00:00:00.000Z',
      payload: { message: { content: text } },
    });
    const payload = compacted.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('message' in payload) ||
      typeof payload.message !== 'object' ||
      payload.message === null ||
      !('content' in payload.message) ||
      typeof payload.message.content !== 'string'
    ) {
      throw new Error('Expected compacted chat message content');
    }

    expect(sanitizeStorableString(payload.message.content)).toBe(
      payload.message.content,
    );
  });
});

/**
 * CAN-2651 shared harness: bring the manager up on a live session whose poll
 * loop can be staged per test, then park on a poll that only settles on abort.
 */
const STALE_SESSION_ID = 'session-stale';

function staleSessionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: STALE_SESSION_ID,
    status: 'active',
    connectionStatus: 'active',
    activatedAt: '2026-07-15T00:00:00.000Z',
    lastSeenAt: '2026-07-15T00:00:01.000Z',
    endedAt: null,
    ...overrides,
  };
}

async function primeActiveSession(
  stagePolls: ((poll: jest.Mock) => void) | undefined = undefined,
  sessionId = STALE_SESSION_ID,
): Promise<void> {
  mockIsEnabled.mockImplementation(
    (key: string) => key === 'canopy-portal-enabled',
  );
  mockLoadCanopyCloudAccount.mockResolvedValue({
    apiKey: 'test-key',
    capabilities: ['portal-v1'],
  });
  mockCreatePortalSession.mockResolvedValue({
    sessionId,
    status: 'pending_auth',
    pendingExpiresAt: '2099-01-01T00:00:00.000Z',
    commandCursor: 0,
  });
  mockPollPortalCommands.mockReset();
  stagePolls?.(mockPollPortalCommands);
  mockPollPortalCommands.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  await startCanopyPortal();
}

const pumpAsync = async (times = 6): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('additional device pairing on a live session (CAN-2981)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      eventOutbox: [],
    });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistCompletedPortalCommand.mockResolvedValue(undefined);
    mockPersistPortalCommandCursor.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockReadCompletedPortalCommand.mockResolvedValue(null);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
    await stopCanopyPortal();
  });

  afterEach(async () => {
    // Stopping clears the re-armed code's expiry timer so it cannot keep the
    // test process alive.
    await stopCanopyPortal();
  });

  function validateCodeCommand(id: string): Record<string, unknown> {
    return {
      id,
      sequence: 1,
      type: 'portal.auth.validate_code',
      status: 'pending',
      payload: { code: '000000', attemptExternalId: `attempt-${id}` },
      createdAt: '2026-07-15T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  }

  async function activateViaFirstDevice(): Promise<{
    markAuthenticated: () => void;
  }> {
    mockPairingAttempts.length = 0;
    await primeActiveSession((poll) => {
      poll.mockResolvedValueOnce({
        session: {
          id: 'session-1',
          status: 'pending_auth',
          connectionStatus: 'pending',
          activatedAt: null,
          lastSeenAt: '2026-07-15T00:00:01.000Z',
          endedAt: null,
        },
        commands: [validateCodeCommand('command-first-device')],
        nextCursor: 1,
      });
    });
    await pumpAsync(12);
    // The beforeEach stop above may have ended a previous test's session;
    // only calls made after this point belong to the scenario under test.
    mockEndPortalSession.mockClear();
    mockCreatePortalSession.mockClear();
    expect(mockHandlePortalCommand).toHaveBeenCalledTimes(1);
    const context = jest.mocked(handlePortalCommand).mock.calls[0]?.[1];
    if (!context) {
      throw new Error('Expected a handler context with markAuthenticated');
    }
    return context;
  }

  it('re-arms a fresh code on the active session without ending it', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    const active = getCanopyPortalState();
    expect(active.status).toBe('active');
    expect(active.pairingCode).toBeNull();

    const { state } = regenerateCanopyPortalPairingCode();

    expect(mockPairingAttempts).toEqual([
      {
        context: {
          pairing_kind: 'phone_code',
          pairing_entry: 'portal_modal',
          peer_platform: 'unknown',
          is_additional_device: false,
        },
        outcomes: ['approved'],
      },
      {
        context: {
          pairing_kind: 'phone_code',
          pairing_entry: 'portal_modal',
          peer_platform: 'unknown',
          is_additional_device: true,
        },
        outcomes: [],
      },
    ]);
    expect(state.status).toBe('active');
    expect(state.sessionId).toBe(active.sessionId);
    expect(state.activatedAt).toBe(active.activatedAt);
    expect(state.pairingCode).toMatch(/^\d{6}$/);
    expect(state.pairingCodeExpiresAt).not.toBeNull();
    // The live session is never torn down or replaced to mint a new code.
    expect(mockEndPortalSession).not.toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it('keeps the session active and its activation time when a second device redeems the code', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    const firstActivation = getCanopyPortalState().activatedAt;
    regenerateCanopyPortalPairingCode();

    // The desktop compares the second device's code against the re-armed one
    // and calls markAuthenticated again; that must clear the code, not
    // restart the session.
    markAuthenticated();

    const state = getCanopyPortalState();
    expect(state.status).toBe('active');
    expect(state.pairingCode).toBeNull();
    expect(state.pairingCodeExpiresAt).toBeNull();
    expect(state.activatedAt).toBe(firstActivation);
    expect(mockEndPortalSession).not.toHaveBeenCalled();
  });

  it('expires a re-armed code after its TTL without touching the session', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { state: armed } = regenerateCanopyPortalPairingCode();
      expect(armed.pairingCode).toMatch(/^\d{6}$/);

      jest.advanceTimersByTime(10 * 60 * 1000);

      const state = getCanopyPortalState();
      expect(state.pairingCode).toBeNull();
      expect(state.pairingCodeExpiresAt).toBeNull();
      expect(state.status).toBe('active');
      expect(state.sessionId).toBe(armed.sessionId);
      expect(mockPairingAttempts[1]?.outcomes).toEqual(['expired']);
      expect(mockEndPortalSession).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a re-armed code without touching the session, so a later redemption is refused', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    const { state: armed } = regenerateCanopyPortalPairingCode();

    const { state } = cancelCanopyPortalPairingCode();

    expect(state.status).toBe('active');
    expect(state.sessionId).toBe(armed.sessionId);
    expect(state.activatedAt).toBe(armed.activatedAt);
    expect(state.pairingCode).toBeNull();
    expect(state.pairingCodeExpiresAt).toBeNull();
    expect(mockEndPortalSession).not.toHaveBeenCalled();
    expect(mockPairingAttempts[1]?.outcomes).toEqual(['cancelled']);
    // Cancelling with nothing armed is a no-op, not an error.
    expect(cancelCanopyPortalPairingCode().state.pairingCode).toBeNull();
  });

  it('cancels the unredeemed attempt before replacement, and stop ends only the latest one', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    markAuthenticated();
    expect(mockPairingAttempts[0]?.outcomes).toEqual(['approved']);
    regenerateCanopyPortalPairingCode();
    regenerateCanopyPortalPairingCode();
    expect(mockPairingAttempts[1]?.outcomes).toEqual(['cancelled']);
    // This callback validated the original code. It cannot approve its replacement.
    markAuthenticated();
    expect(mockPairingAttempts[2]?.outcomes).toEqual([]);
    await stopCanopyPortal();
    expect(mockPairingAttempts[2]?.outcomes).toEqual(['cancelled']);
  });

  it('records authentication that consumes each specifically armed code and ignores reconnect callbacks', async () => {
    mockPairingAttempts.length = 0;
    mockHandlePortalCommand
      .mockImplementationOnce(
        (
          _command: unknown,
          context: { markAuthenticated(): void },
        ): Promise<void> => {
          context.markAuthenticated();
          regenerateCanopyPortalPairingCode();
          return Promise.resolve();
        },
      )
      .mockImplementationOnce(
        (
          _command: unknown,
          context: { markAuthenticated(): void },
        ): Promise<void> => {
          context.markAuthenticated();
          context.markAuthenticated();
          return Promise.resolve();
        },
      );
    await primeActiveSession((poll) =>
      poll.mockResolvedValueOnce({
        session: staleSessionRow({ id: 'session-1' }),
        commands: [
          validateCodeCommand('first'),
          { ...validateCodeCommand('second'), sequence: 2 },
        ],
        nextCursor: 2,
      }),
    );
    await pumpAsync(12);
    expect(mockPairingAttempts.map((attempt) => attempt.outcomes)).toEqual([
      ['approved'],
      ['approved'],
    ]);
    expect(
      mockPairingAttempts.map(
        (attempt) => attempt.context.is_additional_device,
      ),
    ).toEqual([false, true]);
    expect(getCanopyPortalState().pairingCode).toBeNull();
    expect(JSON.stringify(mockPairingAttempts)).not.toMatch(
      /pairing_code|deviceId|sessionId/,
    );
  });

  it('records expiry while pending and preserves start errors when the recorder throws', async () => {
    mockPairingAttempts.length = 0;
    await primeActiveSession();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      // The initial timer was armed with real timers. Repeated start allocates
      // its replacement under the fake clock and cancels the original attempt.
      await startCanopyPortal();
      jest.advanceTimersByTime(10 * 60 * 1000);
      await pumpAsync(12);
      expect(mockPairingAttempts.map((attempt) => attempt.outcomes)).toEqual([
        ['cancelled'],
        ['expired'],
      ]);
    } finally {
      jest.useRealTimers();
    }
    mockStartPairingTelemetry.mockImplementationOnce(() => {
      throw new Error('telemetry');
    });
    mockCreatePortalSession.mockRejectedValueOnce(
      new Error('server unavailable'),
    );
    await expect(startCanopyPortal()).rejects.toThrow('server unavailable');
  });

  it('ignores a stale expiry callback even when a replacement randomly reuses the same code', async () => {
    const { markAuthenticated } = await activateViaFirstDevice();
    markAuthenticated();
    const crypto = jest.requireActual<typeof CryptoModule>('node:crypto');
    const random = jest
      .spyOn(crypto, 'randomInt')
      .mockImplementation(() => 123456);
    const timers = jest.spyOn(globalThis, 'setTimeout');
    try {
      regenerateCanopyPortalPairingCode();
      const firstTimer = timers.mock.calls.find(
        (call) => call[1] === 10 * 60 * 1000,
      );
      if (!firstTimer) throw new Error('No pairing expiry timer');
      regenerateCanopyPortalPairingCode();
      firstTimer[0]();
      expect(getCanopyPortalState().pairingCode).toBe('123456');
      expect(mockPairingAttempts.map((attempt) => attempt.outcomes)).toEqual([
        ['approved'],
        ['cancelled'],
        [],
      ]);
    } finally {
      random.mockRestore();
      timers.mockRestore();
    }
  });

  it('rejects re-arming a code unless the session is active', () => {
    expect(() => regenerateCanopyPortalPairingCode()).toThrow(
      /connected|active/i,
    );
  });
});

describe('QR code pairing (CAN-2938)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      eventOutbox: [],
    });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistCompletedPortalCommand.mockResolvedValue(undefined);
    mockPersistPortalCommandCursor.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockReadCompletedPortalCommand.mockResolvedValue(null);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
    await stopCanopyPortal();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await stopCanopyPortal();
  });

  it('names this machine the same way it registers with the server', async () => {
    await primeActiveSession();

    const state = getCanopyPortalState();
    expect(typeof state.machineName).toBe('string');
    expect(state.machineName).not.toBe('');
    expect(mockCreatePortalSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: state.machineName }),
    );
  });

  it('shows the name it registered even if the host is renamed mid-run', async () => {
    const os: { hostname: () => string } = jest.requireActual('node:os');
    const hostname = jest.spyOn(os, 'hostname');
    try {
      hostname.mockReturnValue('Renamed Mac');
      await primeActiveSession();

      expect(getCanopyPortalState().machineName).toBe('Renamed Mac');
      expect(mockCreatePortalSession).toHaveBeenCalledWith(
        expect.objectContaining({ clientName: 'Renamed Mac' }),
      );
    } finally {
      hostname.mockRestore();
    }
  });

  it('keeps the machine name across stop, so the next pairing can show it', async () => {
    await primeActiveSession();
    const name = getCanopyPortalState().machineName;

    await stopCanopyPortal();

    expect(getCanopyPortalState().status).toBe('disabled');
    expect(getCanopyPortalState().machineName).toBe(name);
  });

  it('says the code expired when nobody scanned it in time, and clears that on retry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await primeActiveSession();
    const pending = getCanopyPortalState();
    expect(pending.status).toBe('pending_auth');
    expect(pending.pairingCode).toMatch(/^\d{6}$/);

    jest.advanceTimersByTime(10 * 60 * 1000);
    await pumpAsync(12);

    const expired = getCanopyPortalState();
    expect(expired.status).toBe('disabled');
    expect(expired.pairingCode).toBeNull();
    expect(expired.error).toMatch(/expired/i);
    expect(expired.lastErrorAt).not.toBeNull();

    await primeActiveSession();
    const retried = getCanopyPortalState();
    expect(retried.status).toBe('pending_auth');
    expect(retried.error).toBeNull();
    expect(retried.pairingCode).toMatch(/^\d{6}$/);
  });

  it('does not report expiry when the user stops pairing on purpose', async () => {
    await primeActiveSession();

    await stopCanopyPortal();

    expect(getCanopyPortalState().error).toBeNull();
  });
});

describe('portal session manager feature flag gates', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      eventOutbox: [],
    });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistCompletedPortalCommand.mockResolvedValue(undefined);
    mockPersistPortalCommandCursor.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockReadCompletedPortalCommand.mockResolvedValue(null);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
    await stopCanopyPortal();
    mockClearWorktreeSummaryPortalFingerprints.mockClear();
  });

  it('does not acknowledge a slow clone into a replacement session after it finishes', async () => {
    let finishClone: (() => void) | undefined;
    mockHandlePortalCommand.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClone = resolve;
        }),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      connectionStatus: 'active',
    });
    try {
      await primeActiveSession(
        (poll) =>
          poll.mockResolvedValueOnce({
            session: {
              id: 'session-1',
              status: 'active',
              connectionStatus: 'active',
              activatedAt: '2026-07-15T00:00:00.000Z',
              lastSeenAt: '2026-07-15T00:00:01.000Z',
              endedAt: null,
            },
            commands: [
              {
                id: 'slow-clone',
                sequence: 4,
                type: 'portal.workspace.create',
                status: 'pending',
                payload: {
                  kind: 'remote-clone',
                  remoteUrl: 'https://host/repo.git',
                },
                createdAt: '2026-07-15T00:00:00.000Z',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            ],
            nextCursor: 4,
          }),
        'session-1',
      );
      await pumpAsync();
      if (!finishClone) throw new Error('clone did not start');
      const readContext = jest.mocked(handlePortalCommand).mock.calls[0]?.[1];
      expect(readContext?.canReadTranscripts).toBe(readContext?.canReadAssets);
      expect(readContext?.canReadTranscripts?.()).toBe(false);
      readContext?.markAuthenticated();
      expect(readContext?.canReadTranscripts?.()).toBe(true);
      await stopCanopyPortal();
      expect(readContext?.canReadTranscripts?.()).toBe(false);
      await primeActiveSession(undefined, 'session-2');
      expect(readContext?.canReadTranscripts?.()).toBe(false);
      mockPersistPortalCommandCursor.mockClear();
      mockPersistCompletedPortalCommand.mockClear();
      finishClone();
      await pumpAsync();
      expect(mockPersistPortalCommandCursor).not.toHaveBeenCalled();
      expect(mockPersistCompletedPortalCommand).not.toHaveBeenCalled();
    } finally {
      await stopCanopyPortal();
    }
  });

  it('clears summary fingerprints when the portal session stops', async () => {
    await stopCanopyPortal();

    expect(mockClearWorktreeSummaryPortalFingerprints).toHaveBeenCalledTimes(1);
  });

  it('announces the batched scope capabilities on session creation', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-caps',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );

    await startCanopyPortal();

    expect(mockCreatePortalSession).toHaveBeenCalledTimes(1);
    const createCalls = JSON.stringify(mockCreatePortalSession.mock.calls);
    expect(createCalls).toContain('"portal-v1":true');
    expect(createCalls).toContain('"transcript_reads_v1":true');
    expect(createCalls).toContain('"worktree_actions_scope":true');
    // CAN-1990: browsers gate the sidebar chat-search hydration on this.
    expect(createCalls).toContain('"worktree_chat_summaries_scope":true');
    // CAN-390: browsers gate sidebar Activity on the strict inventory.
    expect(createCalls).toContain('"sidebar_activity_inventory":true');
    expect(createCalls).toContain('"foreground_worktree_chat":true');
    // Plugins-section phase B: browsers gate mutation controls on this so
    // older desktops never receive commands they cannot execute.
    expect(createCalls).toContain('"plugin_mutations":true');
    expect(createCalls).toContain('"curated_pipeline_import":true');
    expect(createCalls).toContain('"chat_mark_read":true');
    expect(createCalls).toContain('"chat_set_unread":true');
    // Mobile attachment support gates the attach control on this so older
    // desktops never receive refs they would drop.
    expect(createCalls).toContain('"chat_attachments":true');
    expect(createCalls).toContain('"chat_visuals":true');
    // Clients create standalone chats and enable standalone attachments only
    // on this, never on `chat_attachments`, which older desktops also announce.
    expect(createCalls).toContain('"standalone_chat_create":true');
    // Web creates a remote Code New Task chat with its settings on create_tab
    // only on this; older desktops get the settings on a chatless first send.
    expect(createCalls).toContain('"chat_create_tab_settings":true');
    expect(createCalls).toContain('"command_origin":true');
    expect(createCalls).toContain('"chat_cancel_turn":true');
    expect(createCalls).toContain('"worktree_retention":true');
    expect(createCalls).toContain('"sidebar_item_groups":true');
    expect(createCalls).toContain('"queue_edit_lock_ownership":true');
    // CAN-3174: mobile gates the pipeline Run action on this.
    expect(createCalls).toContain('"pipeline_dispatch":true');
    // CAN-3619: mobile shows inline Agent activity only when pipeline_run
    // entities carry desktop-attributed chat turn links.
    expect(createCalls).toContain('"pipeline_run_chat_links":true');
    // CAN-3923: remote composers list and resolve the desktop's invocable
    // inventory only when the host announces all three commands.
    expect(createCalls).toContain('"invocable_inventory":true');
    // CAN-3719: mobile offers Chat follow-up only on desktops that project
    // saved-output availability and handle its prepare command.
    expect(createCalls).toContain('"pipeline_chat_follow_up":true');
    // CAN-3717: mobile reads complete step output and the saved report only
    // from desktops that handle `portal.pipeline.content.read`.
    expect(createCalls).toContain('"pipeline_content":true');

    await stopCanopyPortal();
  });

  it('disables selected Portal capabilities only in E2E builds', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    const previousDisabledCapabilities =
      process.env.CANOPY_E2E_PORTAL_DISABLE_CAPABILITIES;
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    process.env.CANOPY_E2E_PORTAL_DISABLE_CAPABILITIES =
      'command_origin, chat_cancel_turn';
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-caps-disabled',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );

    try {
      await startCanopyPortal();
      const createCalls = JSON.stringify(mockCreatePortalSession.mock.calls);
      expect(createCalls).toContain('"portal-v1":true');
      expect(createCalls).not.toContain('"command_origin"');
      expect(createCalls).not.toContain('"chat_cancel_turn"');
    } finally {
      await stopCanopyPortal();
      if (previousDescriptor) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', previousDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      }
      if (previousDisabledCapabilities === undefined) {
        delete process.env.CANOPY_E2E_PORTAL_DISABLE_CAPABILITIES;
      } else {
        process.env.CANOPY_E2E_PORTAL_DISABLE_CAPABILITIES =
          previousDisabledCapabilities;
      }
    }
  });

  it('announces provider usage and publishes its deltas only while a session is live (CAN-3635)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-usage',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      connectionStatus: 'active',
    });
    const usage = {
      updatedAt: '2026-10-04T17:05:00.000Z',
      providers: [
        {
          provider: 'claude',
          authState: 'unauthenticated',
          hasRemainingLimits: false,
        },
        {
          provider: 'codex',
          authState: 'authenticated',
          hasRemainingLimits: true,
          accountEmail: 'codex-user@example.com',
          subscriptionLabel: 'ChatGPT Pro',
          lastUpdatedAt: '2026-10-04T17:04:00.000Z',
          rateLimits: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary: { usedPercent: 23, windowDurationMins: 300 },
            },
          ],
        },
      ],
    };
    mockObservabilitySubscribe.mockClear();

    await startCanopyPortal();

    expect(JSON.stringify(mockCreatePortalSession.mock.calls)).toContain(
      '"provider_usage":true',
    );
    expect(mockObservabilitySubscribe).toHaveBeenCalledTimes(1);
    expect(mockObservabilityListeners.size).toBe(1);

    for (const listener of Array.from(mockObservabilityListeners)) {
      listener({ type: 'entries', entries: [] });
      listener({ type: 'usage', usage });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flushPortalOutboxForTest();
    const sent = JSON.stringify(mockSendPortalEvents.mock.calls);
    expect(sent).toContain('"type":"portal.state.delta"');
    expect(sent).toContain('"entityType":"provider_usage"');
    expect(sent).toContain('"label":"5-hour window"');

    const staleListeners = Array.from(mockObservabilityListeners);
    await stopCanopyPortal();
    expect(mockObservabilityListeners.size).toBe(0);
    mockSendPortalEvents.mockClear();
    for (const listener of staleListeners) {
      listener({ type: 'usage', usage });
    }
    await flushPortalOutboxForTest();
    expect(mockSendPortalEvents).not.toHaveBeenCalled();

    await startCanopyPortal();
    expect(mockObservabilitySubscribe).toHaveBeenCalledTimes(2);
    expect(mockObservabilityListeners.size).toBe(1);
    await stopCanopyPortal();
    expect(mockObservabilityListeners.size).toBe(0);
  });

  it('continues routing sequences after graceful shutdown and resume', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    mockSendPortalEvents.mockRejectedValue(new Error('offline'));

    await startCanopyPortal();
    enqueuePortalEvent(routedEvent('before-shutdown', 'tree'));
    await stopCanopyPortal('app_shutdown');
    const persistedCalls = mockPersistPortalEventOutbox.mock.calls;
    const persistedCall = persistedCalls[persistedCalls.length - 1];
    if (!persistedCall) throw new Error('Expected persisted portal outbox');
    const persistedEvents = persistedCall[0];
    const persistedCounters = persistedCall[1];
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      activeSession: {
        serverId: 'canopy-cloud',
        sessionId: 'session-1',
        commandCursor: 0,
        activatedAt: '2026-07-31T00:00:00.000Z',
        lastSeenAt: null,
      },
      lastStopReason: 'app_shutdown',
      eventOutbox: persistedEvents,
      routingSequenceCounters: Object.fromEntries(persistedCounters),
    });
    mockSendPortalEvents.mockResolvedValue({
      accepted: 2,
      duplicates: 0,
      connectionStatus: 'active',
    });

    await resumeCanopyPortalIfPossible();
    await pumpAsync();
    const heartbeatCalls = JSON.stringify(mockSendPortalHeartbeat.mock.calls);
    expect(heartbeatCalls).toContain('"sessionId":"session-1"');
    expect(heartbeatCalls).toContain('"chat_attachments":true');
    expect(heartbeatCalls).toContain('"chat_visuals":true');
    enqueuePortalEvent(routedEvent('after-resume', 'tree'));
    await flushPortalOutboxForTest();

    const sent = JSON.stringify(mockSendPortalEvents.mock.calls);
    expect(sent).toContain('"seq":1');
    expect(sent).toContain('"seq":2');
  });

  describe('unstorable string sanitization (CAN-3535)', () => {
    // NUL plus a lone high surrogate, followed by a valid pair that must
    // survive. PostgreSQL rejects the first two in JSONB/TEXT, which poisoned
    // the head batch and made the outbox retry it forever.
    const POISON_CHUNK = 'before\u0000after \ud83d ok 😀';
    const SANITIZED_CHUNK = 'beforeafter � ok 😀';

    function terminalOutputEvent(
      eventId: string,
      chunk: string,
    ): PortalTestEvent {
      return {
        eventId,
        type: 'portal.terminal.output',
        occurredAt: '2026-07-31T00:00:00.000Z',
        payload: { terminalLocalId: 'term-1', chunk },
      };
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    }

    /** Payloads of every event handed to `sendPortalEvents`, in send order. */
    function sentPayloads(): Record<string, unknown>[] {
      const calls: unknown[] = mockSendPortalEvents.mock.calls;
      const payloads: Record<string, unknown>[] = [];
      for (const call of calls) {
        const args: unknown = Array.isArray(call) ? call[0] : undefined;
        if (!isRecord(args) || !isRecord(args.request)) continue;
        const events: unknown = args.request.events;
        if (!Array.isArray(events)) continue;
        const sentEvents: unknown[] = events;
        for (const event of sentEvents) {
          if (isRecord(event) && isRecord(event.payload)) {
            payloads.push(event.payload);
          }
        }
      }
      return payloads;
    }

    function sentChunks(): unknown[] {
      return sentPayloads().map((payload) => payload.chunk);
    }

    beforeEach(() => {
      mockSendPortalEvents.mockReset();
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
    });

    afterEach(async () => {
      await stopCanopyPortal();
    });

    it('sanitizes NUL and lone surrogates when an event is enqueued', async () => {
      await primeActiveSession();

      await enqueuePortalEventForTest(
        terminalOutputEvent('poison-enqueue', POISON_CHUNK),
      );
      await flushPortalOutboxForTest();

      expect(sentChunks()).toEqual([SANITIZED_CHUNK]);
    });

    it('sanitizes a persisted poison outbox when the session is restored', async () => {
      mockIsEnabled.mockReturnValue(true);
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockPollPortalCommands.mockReset();
      mockPollPortalCommands.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      );
      mockReadPortalStateStore.mockResolvedValue({
        clientDeviceId: 'device-1',
        activeSession: {
          serverId: 'canopy-cloud',
          sessionId: 'session-poisoned',
          commandCursor: 0,
          activatedAt: '2026-07-31T00:00:00.000Z',
          lastSeenAt: null,
        },
        lastStopReason: 'app_shutdown',
        eventOutbox: [terminalOutputEvent('poison-restore', POISON_CHUNK)],
      });

      await resumeCanopyPortalIfPossible();
      await pumpAsync();
      await flushPortalOutboxForTest();

      expect(sentChunks()).toEqual([SANITIZED_CHUNK]);
    });

    it('keeps clean payload subtrees by reference so the fast path does not clone', async () => {
      await primeActiveSession();
      const cleanSubtree = { lines: ['plain output', 'emoji 😀'] };
      const cleanEvent: PortalTestEvent = {
        eventId: 'clean-enqueue',
        type: 'portal.terminal.output',
        occurredAt: '2026-07-31T00:00:00.000Z',
        payload: { terminalLocalId: 'term-1', chunk: 'ok', meta: cleanSubtree },
      };

      await enqueuePortalEventForTest(cleanEvent);
      await flushPortalOutboxForTest();

      const payloads = sentPayloads();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.meta).toBe(cleanSubtree);
    });
  });

  it('drops an oversized event without looping when its raw marker key is oversized', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-oversized',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands.mockImplementation(
      () => new Promise(() => undefined),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      connectionStatus: 'active',
    });

    await startCanopyPortal();
    const oversizedEvent = routedEvent(
      'oversized-event',
      'x'.repeat(PORTAL_EVENT_BATCH_MAX_BYTES),
      'y'.repeat(PORTAL_EVENT_BATCH_MAX_BYTES),
    );
    expect(portalEventByteLength(oversizedEvent)).toBeGreaterThan(
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    await enqueuePortalEventForTest(oversizedEvent);
    await flushPortalOutboxForTest();

    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'portal_oversized_event_dropped',
        droppedRangeCount: 1,
      }),
    );
    expect(mockSendPortalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          events: [expect.objectContaining({ type: 'portal.events.dropped' })],
        },
      }),
    );
  });

  it('rejects start before side effects when Portal is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);

    await expect(startCanopyPortal()).rejects.toThrow(
      'Remote Control is not available.',
    );

    expect(mockLoadCanopyCloudAccount).not.toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it('uses neutral cloud-account copy when Portal starts without a connected account', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(null);

    await expect(startCanopyPortal()).rejects.toThrow(
      'Connect Canopy Cloud in Settings before enabling remote control.',
    );

    expect(mockLoadCanopyCloudAccount).toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it('does not resume when Portal is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);

    await resumeCanopyPortalIfPossible();

    expect(mockReadPortalStateStore).not.toHaveBeenCalled();
  });

  it('does not claim a resumed connection for an orphaned shutdown state (CAN-2803)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockReadPortalStateStore.mockResolvedValue({
      clientDeviceId: 'device-1',
      lastStopReason: 'app_shutdown',
      eventOutbox: [],
    });

    await resumeCanopyPortalIfPossible();

    expect(getCanopyPortalState()).toMatchObject({
      status: 'disabled',
      connectionStatus: 'inactive',
      sessionId: null,
    });
    expect(mockLoadCanopyCloudAccount).not.toHaveBeenCalled();
    expect(mockPollPortalCommands).not.toHaveBeenCalled();
    expect(mockSendPortalHeartbeat).not.toHaveBeenCalled();
  });

  it('allows stop when Portal is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);

    await expect(stopCanopyPortal()).resolves.toMatchObject({
      state: { status: 'disabled' },
    });

    expect(mockPersistPortalStopReason).toHaveBeenCalledWith(
      'local_disconnect',
    );
  });

  it('aborts a stalled poll and records a diagnostic', async () => {
    jest.useFakeTimers();
    try {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      let pollAborted = false;
      mockPollPortalCommands.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                pollAborted = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      );

      await startCanopyPortal();
      await Promise.resolve();
      await Promise.resolve();
      const expectedDiagnosticTimestamp = new Date(
        Date.now() + 6 * 60_000,
      ).toISOString();
      await jest.advanceTimersByTimeAsync(6 * 60_000);

      expect(pollAborted).toBe(true);
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith({
        version: 1,
        timestamp: expectedDiagnosticTimestamp,
        kind: 'portal_channel_stalled',
      });
    } finally {
      await stopCanopyPortal();
      jest.useRealTimers();
    }
  });

  it('records a stall diagnostic when no transport request is in flight (processing-phase wedge)', async () => {
    // Regression pin for the detection guard: the long-poll branch nulls
    // pollAbortController BEFORE applyPollResponse runs, so a wedge inside
    // command processing must still trip the failsafe. Under the earlier
    // `!pollAbortController` guard this scenario was invisible.
    jest.useFakeTimers();
    try {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockReadCompletedPortalCommand.mockResolvedValue(null);
      mockSendPortalEvents.mockResolvedValue({
        accepted: 0,
        duplicates: 0,
        connectionStatus: 'active',
      });
      // The poll RESOLVES (nulling pollAbortController in pollLoop), then the
      // dispatched command hangs forever inside applyPollResponse.
      // Once-only so the never-resolving hang cannot leak into later tests
      // (clearAllMocks clears call data but not implementations).
      mockHandlePortalCommand.mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      mockPollPortalCommands.mockResolvedValueOnce({
        session: {
          id: 'session-1',
          status: 'active',
          connectionStatus: 'active',
          activatedAt: '2026-07-15T00:00:00.000Z',
          lastSeenAt: '2026-07-15T00:00:01.000Z',
          endedAt: null,
        },
        commands: [
          {
            id: 'command-stuck-1',
            sequence: 1,
            type: 'portal.state.request',
            status: 'pending',
            payload: {},
            createdAt: '2026-07-15T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 1,
      });

      await startCanopyPortal();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockHandlePortalCommand).toHaveBeenCalledTimes(1);
      const expectedDiagnosticTimestamp = new Date(
        Date.now() + 6 * 60_000,
      ).toISOString();
      await jest.advanceTimersByTimeAsync(6 * 60_000);

      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith({
        version: 1,
        timestamp: expectedDiagnosticTimestamp,
        kind: 'portal_channel_stalled',
      });
    } finally {
      await stopCanopyPortal();
      jest.useRealTimers();
    }
  });

  it.each([
    ['expired', 'portal.worktree.create'],
    ['expired', 'portal.chat.answer_question'],
    ['expired', 'portal.chat.dismiss_question'],
    ['expired', 'portal.pipeline.resume'],
    ['expired', 'portal.pipeline.retry'],
    ['expired', 'portal.pipeline.rerun'],
    ['failed', 'portal.chat.answer_question'],
  ] as const)(
    'emits a terminal failure before advancing a %s %s command',
    async (commandStatus, commandType) => {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockPollPortalCommands
        .mockResolvedValueOnce({
          session: {
            id: 'session-1',
            status: 'active',
            connectionStatus: 'active',
            activatedAt: '2026-07-15T00:00:00.000Z',
            lastSeenAt: '2026-07-15T00:00:01.000Z',
            endedAt: null,
          },
          commands: [
            {
              id: 'command-1',
              sequence: 1,
              type: commandType,
              status: commandStatus,
              payload: {},
              createdAt: '2026-07-15T00:00:00.000Z',
              expiresAt: '2026-07-15T00:00:01.000Z',
            },
          ],
          nextCursor: 1,
        })
        .mockImplementation(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            }),
        );
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });

      await startCanopyPortal();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockSendPortalEvents).toHaveBeenCalledWith({
        sessionId: 'session-1',
        request: {
          events: [
            expect.objectContaining({
              type: 'portal.command.failed',
              commandId: 'command-1',
            }),
          ],
        },
      });
      expect(JSON.stringify(mockSendPortalEvents.mock.calls)).toContain(
        '"payload":{"commandId":"command-1","sequenceNumber":1',
      );
      expect(JSON.stringify(mockSendPortalEvents.mock.calls)).toContain(
        '"retryable":false',
      );
      expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
        commandCursor: 1,
        lastSeenAt: '2026-07-15T00:00:01.000Z',
      });
      expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith({
        commandId: 'command-1',
        sequence: 1,
        events: [
          expect.objectContaining({
            type: 'portal.command.failed',
            commandId: 'command-1',
          }),
        ],
      });
      expect(
        mockPersistCompletedPortalCommand.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockPersistPortalCommandCursor.mock.invocationCallOrder[0],
      );
      expect(mockSendPortalEvents.mock.invocationCallOrder[0]).toBeLessThan(
        mockPersistPortalCommandCursor.mock.invocationCallOrder[0],
      );

      await stopCanopyPortal();
    },
  );

  it.each([
    'portal.pipeline.resume',
    'portal.pipeline.cancel',
    'portal.personal_organization.projects.convert',
  ] as const)(
    'keeps the durable cursor behind detached %s until its terminal event is recorded',
    async (detachedCommandType) => {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockPollPortalCommands
        .mockResolvedValueOnce({
          session: {
            id: 'session-1',
            status: 'active',
            connectionStatus: 'active',
            activatedAt: '2026-07-15T00:00:00.000Z',
            lastSeenAt: '2026-07-15T00:00:01.000Z',
            endedAt: null,
          },
          commands: [
            {
              id: 'detached-command',
              sequence: 1,
              type: detachedCommandType,
              status: 'pending',
              target: {
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              },
              payload: { executionId: 'exec-1' },
              createdAt: '2026-07-15T00:00:00.000Z',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            {
              id: 'chat-command',
              sequence: 2,
              type: 'portal.chat.send',
              status: 'pending',
              payload: {},
              createdAt: '2026-07-15T00:00:00.000Z',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
          nextCursor: 2,
        })
        .mockImplementation(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                {
                  once: true,
                },
              );
            }),
        );
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
      let completeDetached:
        | ((event: Parameters<typeof compactPortalEvent>[0]) => void)
        | undefined;
      mockHandlePortalCommand.mockImplementation(
        (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          if (command.id === 'detached-command') {
            completeDetached = context.enqueueEvent;
            return Promise.resolve();
          }
          context.enqueueEvent(controlEvent('chat-completed', command.id));
          return Promise.resolve();
        },
      );

      try {
        await startCanopyPortal();
        await pumpAsync();

        expect(mockHandlePortalCommand).toHaveBeenCalledTimes(2);
        expect(mockPersistCompletedPortalCommand).not.toHaveBeenCalledWith({
          commandId: 'detached-command',
          sequence: 1,
          events: [],
        });
        expect(mockPersistPortalCommandCursor).not.toHaveBeenCalledWith(
          expect.objectContaining({ commandCursor: 2 }),
        );

        completeDetached?.(
          controlEvent('detached-completed', 'detached-command'),
        );
        await pumpAsync();

        expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith({
          commandId: 'detached-command',
          sequence: 1,
          events: [
            expect.objectContaining({
              eventId: 'detached-completed',
              type: 'portal.command.completed',
            }),
          ],
        });
        expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
          commandCursor: 2,
          lastSeenAt: '2026-07-15T00:00:01.000Z',
        });

        completeDetached?.(
          routedEvent('late-detached-update', 'wt-1', 'late output'),
        );
        await pumpAsync();
        expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith({
          commandId: 'detached-command',
          sequence: 1,
          events: [
            expect.objectContaining({
              eventId: 'detached-completed',
              type: 'portal.command.completed',
            }),
          ],
        });
      } finally {
        mockHandlePortalCommand.mockReset();
        await stopCanopyPortal();
      }
    },
  );

  it('replays a durable completion before advancing an expired task command', async () => {
    mockIsEnabled.mockImplementation(
      (key: string) => key === 'canopy-portal-enabled',
    );
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    mockPollPortalCommands
      .mockResolvedValueOnce({
        session: {
          id: 'session-1',
          status: 'active',
          connectionStatus: 'active',
          activatedAt: '2026-07-15T00:00:00.000Z',
          lastSeenAt: '2026-07-15T00:00:01.000Z',
          endedAt: null,
        },
        commands: [
          {
            id: 'command-1',
            sequence: 1,
            type: 'portal.worktree.create',
            status: 'expired',
            payload: {},
            createdAt: '2026-07-15T00:00:00.000Z',
            expiresAt: '2026-07-15T00:00:01.000Z',
          },
        ],
        nextCursor: 1,
      })
      .mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      );
    mockReadCompletedPortalCommand.mockResolvedValue({
      commandId: 'command-1',
      sequence: 1,
      completedAt: '2026-07-15T00:00:01.000Z',
      events: [
        {
          type: 'portal.command.completed',
          commandId: 'command-1',
          eventId: 'event-1',
          clientEventId: 'event-1',
          occurredAt: '2026-07-15T00:00:01.000Z',
          payload: {
            commandId: 'command-1',
            sequenceNumber: 1,
            result: { ok: true, worktreeId: 'worktree-1' },
            generatedAt: '2026-07-15T00:00:01.000Z',
          },
        },
      ],
    });
    mockSendPortalEvents.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      connectionStatus: 'active',
    });

    await startCanopyPortal();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSendPortalEvents).toHaveBeenCalledWith({
      sessionId: 'session-1',
      request: {
        events: [
          expect.objectContaining({
            type: 'portal.command.completed',
            commandId: 'command-1',
          }),
        ],
      },
    });
    expect(JSON.stringify(mockSendPortalEvents.mock.calls)).not.toContain(
      'portal.command.failed',
    );
    expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
      commandCursor: 1,
      lastSeenAt: '2026-07-15T00:00:01.000Z',
    });
    expect(mockSendPortalEvents.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistPortalCommandCursor.mock.invocationCallOrder[0],
    );

    await stopCanopyPortal();
  });

  it('replays a completed command with its original routing sequence and continues monotonically', async () => {
    mockIsEnabled.mockImplementation(
      (key: string) => key === 'canopy-portal-enabled',
    );
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'test-key',
      capabilities: ['portal-v1'],
    });
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2099-01-01T00:00:00.000Z',
      commandCursor: 0,
    });
    const command = {
      id: 'command-1',
      sequence: 1,
      type: 'portal.chat.send',
      status: 'pending',
      payload: {},
      createdAt: '2026-07-15T00:00:00.000Z',
      expiresAt: '2026-07-15T00:01:00.000Z',
    };
    const response = {
      session: {
        id: 'session-1',
        status: 'active',
        connectionStatus: 'active',
        activatedAt: '2026-07-15T00:00:00.000Z',
        lastSeenAt: '2026-07-15T00:00:01.000Z',
        endedAt: null,
      },
      commands: [command],
      nextCursor: 1,
    };
    const persistedCompletions: Array<{
      commandId: string;
      sequence: number;
      events: Parameters<typeof compactPortalEvent>[0][];
    }> = [];
    mockPersistCompletedPortalCommand.mockImplementation(
      (input: {
        commandId: string;
        sequence: number;
        events: Parameters<typeof compactPortalEvent>[0][];
      }): Promise<void> => {
        persistedCompletions.push(input);
        return Promise.resolve();
      },
    );
    mockHandlePortalCommand.mockImplementationOnce(
      (
        _command: unknown,
        context: {
          enqueueEvent: (
            event: Parameters<typeof compactPortalEvent>[0],
          ) => void;
        },
      ): Promise<void> => {
        context.enqueueEvent(routedEvent('completed-event', 'tree'));
        return Promise.resolve();
      },
    );
    mockPollPortalCommands.mockResolvedValueOnce(response).mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    mockSendPortalEvents.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      connectionStatus: 'active',
    });

    await startCanopyPortal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await stopCanopyPortal();

    const persistedCompletion = persistedCompletions[0];
    if (!persistedCompletion) {
      throw new Error('Expected a persisted completed command');
    }
    expect(persistedCompletion.events[0]?.payload).toEqual(
      expect.objectContaining({ routing: { key: 'ws:tree', seq: 1 } }),
    );

    mockSendPortalEvents.mockClear();
    mockReadCompletedPortalCommand.mockResolvedValue(persistedCompletion);
    mockPollPortalCommands
      .mockReset()
      .mockResolvedValueOnce(response)
      .mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              {
                once: true,
              },
            );
          }),
      );

    await startCanopyPortal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    enqueuePortalEvent(routedEvent('new-event', 'tree'));
    await flushPortalOutboxForTest();

    const stampedPayload = (seq: number): unknown =>
      expect.objectContaining({ routing: { key: 'ws:tree', seq } });
    expect(mockSendPortalEvents).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      request: {
        events: [
          expect.objectContaining({
            eventId: 'completed-event',
            payload: stampedPayload(1),
          }),
        ],
      },
    });
    expect(mockSendPortalEvents).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      request: {
        events: [
          expect.objectContaining({
            eventId: 'new-event',
            payload: stampedPayload(2),
          }),
        ],
      },
    });

    await stopCanopyPortal();
  });

  it('labels the upload-latency diagnostic for control-only batches (CAN-2360)', async () => {
    jest.useFakeTimers();
    try {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-control-only',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockPollPortalCommands.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          }),
      );
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
      const uploadLatencyCalls = (): string[] =>
        mockRecordSessionDiagnostic.mock.calls
          .map((call) => JSON.stringify(call))
          .filter((call) => call.includes('portal_outbox_upload_latency'));

      await startCanopyPortal();
      // Open the diagnostic throttle window regardless of what earlier tests
      // recorded, so the samples below cannot hide behind it.
      await jest.advanceTimersByTimeAsync(40_000);

      await enqueuePortalEventForTest(
        controlEvent('lone-completion', 'cmd-lone'),
      );
      // A control-only batch IS recorded (it is the direct verification
      // signal for the CAN-2360 control-lane promotion) but carries a
      // distinguishing label so latency dashboards can split it from bulk
      // upload pressure.
      expect(uploadLatencyCalls()).toHaveLength(1);
      expect(uploadLatencyCalls()[0]).toContain(
        '"portalOutboxControlOnly":true',
      );

      await jest.advanceTimersByTimeAsync(40_000);
      await enqueuePortalEventForTest(routedEvent('bulk-event', 'tree'));
      expect(uploadLatencyCalls()).toHaveLength(2);
      expect(uploadLatencyCalls()[1]).toContain(
        '"portalOutboxControlOnly":false',
      );
    } finally {
      await stopCanopyPortal();
      jest.useRealTimers();
    }
  });

  describe('async snapshot lane hand-off (CAN-2360)', () => {
    const sessionRow = {
      id: 'session-1',
      status: 'active',
      connectionStatus: 'active',
      activatedAt: '2026-07-15T00:00:00.000Z',
      lastSeenAt: '2026-07-15T00:00:01.000Z',
      endedAt: null,
    };

    function pollCommand(
      id: string,
      sequence: number,
      type: 'portal.state.request' | 'portal.chat.send',
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id,
        sequence,
        type,
        status: 'pending',
        payload: {},
        createdAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    function primeSession(commands: Record<string, unknown>[]): void {
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockPollPortalCommands
        .mockResolvedValueOnce({
          session: sessionRow,
          commands,
          nextCursor: commands.length,
        })
        .mockImplementation(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            }),
        );
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
    }

    const pump = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it('receives the next foreground command batch while an unrelated upload is pending', async () => {
      mockIsEnabled.mockImplementation((key: string) =>
        ['canopy-portal-enabled', 'canopy-portal-async-snapshots'].includes(
          key,
        ),
      );
      const command = (
        id: string,
        sequence: number,
        scope: string,
      ): Record<string, unknown> =>
        pollCommand(id, sequence, 'portal.state.request', {
          payload: {
            scope,
            target: { workspaceLocalId: 'ws', worktreeLocalId: id },
          },
        });
      primeSession([command('background', 1, 'scripts')]);
      mockPollPortalCommands.mockResolvedValueOnce({
        session: sessionRow,
        commands: [command('foreground', 2, 'chat')],
        nextCursor: 2,
      });
      let releaseUpload: () => void = () => undefined;
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      mockSendPortalEvents.mockImplementationOnce(async () => {
        await uploadGate;
        return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
      });
      mockExecutePortalStateRequest.mockImplementation(
        (
          input: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          context.enqueueEvent(snapshotEvent(`snapshot-${input.id}`, input.id));
          context.enqueueEvent(controlEvent(`completed-${input.id}`, input.id));
          return Promise.resolve();
        },
      );
      try {
        await startCanopyPortal();
        await pump();
        expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
        expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(2);
        expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith(
          expect.objectContaining({ commandId: 'foreground' }),
        );
      } finally {
        releaseUpload();
        await pump();
        await stopCanopyPortal();
      }
    });

    it('does not hand off malformed-origin state requests to the async snapshot lane', async () => {
      mockIsEnabled.mockImplementation((key: string) =>
        ['canopy-portal-enabled', 'canopy-portal-async-snapshots'].includes(
          key,
        ),
      );
      primeSession([
        pollCommand('bad-origin-state', 1, 'portal.state.request', {
          origin: null,
          payload: { scope: 'chat' },
        }),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        expect(mockExecutePortalStateRequest).not.toHaveBeenCalled();
        expect(mockHandlePortalCommand).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'bad-origin-state' }),
          expect.anything(),
        );
      } finally {
        await stopCanopyPortal();
      }
    });

    it.each(['catalog', 'replay'])(
      'serves a selected read after %s completion while a background upload is held',
      async (kind) => {
        mockIsEnabled.mockImplementation((key: string) =>
          ['canopy-portal-enabled', 'canopy-portal-async-snapshots'].includes(
            key,
          ),
        );
        const command = (
          id: string,
          sequence: number,
          scope: string,
        ): ReturnType<typeof pollCommand> =>
          pollCommand(id, sequence, 'portal.state.request', {
            payload: {
              scope,
              target: { workspaceLocalId: 'ws', worktreeLocalId: id },
            },
          });
        primeSession([command('background', 1, 'scripts')]);
        mockPollPortalCommands.mockResolvedValueOnce({
          session: sessionRow,
          commands: [
            pollCommand('catalog', 2, 'portal.chat.send', {
              type: 'portal.chat.list_plugin_catalog',
            }),
            command('foreground', 3, 'chat'),
          ],
          nextCursor: 3,
        });
        if (kind === 'replay') {
          mockReadCompletedPortalCommand.mockImplementation(
            (id: string): Promise<unknown> =>
              Promise.resolve(
                id === 'catalog'
                  ? {
                      commandId: id,
                      sequence: 2,
                      events: [controlEvent('catalog-completed', id)],
                    }
                  : null,
              ),
          );
        }
        mockHandlePortalCommand.mockImplementation(
          (
            input: { id: string },
            context: {
              enqueueEvent: (event: PortalTestEvent) => void;
            },
          ): Promise<void> => {
            context.enqueueEvent(controlEvent('catalog-completed', input.id));
            return Promise.resolve();
          },
        );
        mockExecutePortalStateRequest.mockImplementation(
          (
            input: { id: string },
            context: {
              enqueueEvent: (event: PortalTestEvent) => void;
            },
          ): Promise<void> => {
            context.enqueueEvent(
              snapshotEvent(`snapshot-${input.id}`, input.id),
            );
            context.enqueueEvent(
              controlEvent(`completed-${input.id}`, input.id),
            );
            return Promise.resolve();
          },
        );
        let releaseUpload: () => void = () => undefined;
        const uploadGate = new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        mockSendPortalEvents.mockImplementationOnce(async () => {
          await uploadGate;
          return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
        });
        try {
          await startCanopyPortal();
          await pump();
          expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
          expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(2);
          expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith(
            expect.objectContaining({ commandId: 'foreground' }),
          );
          expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
            commandCursor: 3,
            lastSeenAt: sessionRow.lastSeenAt,
          });
          if (kind === 'catalog') {
            expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith(
              expect.objectContaining({ commandId: 'catalog' }),
            );
          }
          expect(JSON.stringify(mockSendPortalEvents.mock.calls)).not.toContain(
            'snapshot-foreground',
          );
        } finally {
          releaseUpload();
          await pump();
          await stopCanopyPortal();
          mockHandlePortalCommand.mockReset();
          mockExecutePortalStateRequest.mockReset();
        }
      },
    );

    describe('keyed command outbox durability (F6)', () => {
      let previousScheduler: string | undefined;

      beforeEach(() => {
        previousScheduler = process.env.CANOPY_PORTAL_SNAPSHOT_SCHEDULER;
        process.env.CANOPY_PORTAL_SNAPSHOT_SCHEDULER = 'keyed';
        // Freeze the 250ms debounce, heartbeat and retry timers, not the
        // microtask/setImmediate work needed to reach the persistence fence.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      });

      afterEach(async () => {
        await stopCanopyPortal();
        // A failed local save leaves pollLoop on its existing backoff timer.
        // Let that old loop observe pollAbort before restoring real timers.
        jest.advanceTimersByTime(1_000);
        await pumpAsync();
        jest.useRealTimers();
        if (previousScheduler === undefined) {
          delete process.env.CANOPY_PORTAL_SNAPSHOT_SCHEDULER;
        } else {
          process.env.CANOPY_PORTAL_SNAPSHOT_SCHEDULER = previousScheduler;
        }
        mockHandlePortalCommand.mockReset();
        mockExecutePortalStateRequest.mockReset();
        mockReadCompletedPortalCommand.mockReset().mockResolvedValue(null);
        mockPersistPortalEventOutbox.mockReset().mockResolvedValue(undefined);
        mockPersistPortalCommandCursor.mockReset().mockResolvedValue(undefined);
        mockPersistCompletedPortalCommand
          .mockReset()
          .mockResolvedValue(undefined);
      });

      function primeDurabilityCommands(
        kind: string,
        includeSelected = true,
      ): void {
        mockIsEnabled.mockImplementation((key: string) =>
          ['canopy-portal-enabled', 'canopy-portal-async-snapshots'].includes(
            key,
          ),
        );
        const catalog = pollCommand('catalog', 1, 'portal.chat.send', {
          type: 'portal.chat.list_plugin_catalog',
        });
        const selected = pollCommand('selected', 2, 'portal.state.request', {
          payload: {
            scope: 'chat',
            target: { workspaceLocalId: 'ws', worktreeLocalId: 'selected' },
          },
        });
        primeSession(includeSelected ? [catalog, selected] : [catalog]);
        mockReadCompletedPortalCommand.mockImplementation(
          (id: string): Promise<unknown> =>
            Promise.resolve(
              kind === 'replay' && id === 'catalog'
                ? {
                    commandId: id,
                    sequence: 1,
                    completedAt: '2026-07-15T00:00:01.000Z',
                    events: [controlEvent('catalog-completed', id)],
                  }
                : null,
            ),
        );
        mockHandlePortalCommand.mockImplementation(
          (
            input: { id: string },
            context: { enqueueEvent: (event: PortalTestEvent) => void },
          ): Promise<void> => {
            context.enqueueEvent(controlEvent('catalog-completed', input.id));
            return Promise.resolve();
          },
        );
        mockExecutePortalStateRequest.mockImplementation(
          (
            input: { id: string },
            context: { enqueueEvent: (event: PortalTestEvent) => void },
          ): Promise<void> => {
            context.enqueueEvent(
              snapshotEvent(`snapshot-${input.id}`, input.id),
            );
            context.enqueueEvent(
              controlEvent(`completed-${input.id}`, input.id),
            );
            return Promise.resolve();
          },
        );
      }

      function containsCatalogCompletion(events: unknown[]): boolean {
        return events.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'eventId' in event &&
            event.eventId === 'catalog-completed',
        );
      }

      it.each(['catalog', 'replay'])(
        'fences the %s cursor on local disk, then releases selected work without waiting for network',
        async (kind) => {
          primeDurabilityCommands(kind);
          let releaseDisk: () => void = () => undefined;
          const diskGate = new Promise<void>((resolve) => {
            releaseDisk = resolve;
          });
          let releaseUpload: () => void = () => undefined;
          const uploadGate = new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          let durableOutbox: unknown[] = [];
          mockPersistPortalEventOutbox.mockImplementation(async (events) => {
            if (containsCatalogCompletion(events)) await diskGate;
            durableOutbox = events.slice();
          });
          mockSendPortalEvents.mockImplementationOnce(async () => {
            await uploadGate;
            return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
          });
          try {
            await startCanopyPortal();
            await pumpAsync();
            expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
            expect(mockReadCompletedPortalCommand).toHaveBeenCalledWith(
              'catalog',
            );
            // RED: the unfixed helper advances to 1/2 without any local save.
            expect(mockPersistPortalCommandCursor).not.toHaveBeenCalled();
            expect(mockExecutePortalStateRequest).not.toHaveBeenCalled();
            expect(containsCatalogCompletion(durableOutbox)).toBe(false);

            releaseDisk();
            await pumpAsync();
            expect(containsCatalogCompletion(durableOutbox)).toBe(true);
            expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
              commandCursor: 2,
              lastSeenAt: sessionRow.lastSeenAt,
            });
            expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);
            // Upload is STILL held: local durability must not reinstate the
            // old network head-of-line block for the selected read.
            expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
          } finally {
            releaseDisk();
            releaseUpload();
            await pumpAsync();
          }
        },
      );

      it.each(['catalog', 'replay'])(
        'does not advance the %s cursor when local outbox persistence fails',
        async (kind) => {
          primeDurabilityCommands(kind);
          mockPersistPortalEventOutbox.mockImplementation((events) => {
            if (containsCatalogCompletion(events)) {
              return Promise.reject(new Error('local outbox disk failure'));
            }
            return Promise.resolve();
          });
          let releaseUpload: () => void = () => undefined;
          const uploadGate = new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          mockSendPortalEvents.mockImplementationOnce(async () => {
            await uploadGate;
            return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
          });
          try {
            await startCanopyPortal();
            await pumpAsync();
            expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
            expect(mockPersistPortalCommandCursor).not.toHaveBeenCalled();
            expect(mockExecutePortalStateRequest).not.toHaveBeenCalled();
            expect(getCanopyPortalState().error).toBe(
              'local outbox disk failure',
            );
          } finally {
            mockPersistPortalEventOutbox.mockResolvedValue(undefined);
            releaseUpload();
            await pumpAsync();
          }
        },
      );

      it.each(['flag-off', 'serial'])(
        'preserves the existing network-awaited %s fallback',
        async (mode) => {
          primeDurabilityCommands('catalog', false);
          if (mode === 'flag-off') {
            mockIsEnabled.mockImplementation(
              (key: string) => key === 'canopy-portal-enabled',
            );
          } else {
            process.env.CANOPY_PORTAL_SNAPSHOT_SCHEDULER = 'serial';
          }
          let releaseUpload: () => void = () => undefined;
          const uploadGate = new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          mockHandlePortalCommand.mockImplementation(
            (
              input: { id: string },
              context: { enqueueEvent: (event: PortalTestEvent) => void },
            ): Promise<void> => {
              // Fail only after startup's empty-queue persistence has settled.
              mockPersistPortalEventOutbox.mockRejectedValue(
                new Error('fallback local disk failure'),
              );
              context.enqueueEvent(controlEvent('catalog-completed', input.id));
              return Promise.resolve();
            },
          );
          mockSendPortalEvents.mockImplementationOnce(async () => {
            await uploadGate;
            return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
          });
          try {
            await startCanopyPortal();
            await pumpAsync();
            expect(mockSendPortalEvents).toHaveBeenCalledTimes(1);
            expect(mockPersistPortalCommandCursor).not.toHaveBeenCalled();
            releaseUpload();
            await pumpAsync();
            // Pin the existing fallback semantics, including its swallowed
            // post-upload local save error. F6 changes keyed mode only.
            expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
              sessionId: sessionRow.id,
              commandCursor: 1,
              lastSeenAt: sessionRow.lastSeenAt,
            });
          } finally {
            mockPersistPortalEventOutbox.mockResolvedValue(undefined);
            releaseUpload();
            await pumpAsync();
          }
        },
      );

      it.each(['catalog', 'replay'])(
        'restores the %s terminal event from the crash image captured at cursor commit',
        async (kind) => {
          primeDurabilityCommands(kind, false);
          let durableOutbox: unknown[] = [];
          let durableCounters = new Map<string, number>();
          const durableCompletions: unknown[] =
            kind === 'replay'
              ? [
                  {
                    commandId: 'catalog',
                    sequence: 1,
                    events: [controlEvent('catalog-completed', 'catalog')],
                  },
                ]
              : [];
          // Model only the real store's independent fields, not an imaginary
          // implicit outbox save inside persistCompletedPortalCommand.
          mockPersistPortalEventOutbox.mockImplementation(
            (events, counters) => {
              durableOutbox = events.slice();
              durableCounters = new Map(counters);
              return Promise.resolve();
            },
          );
          mockPersistCompletedPortalCommand.mockImplementation(
            (input: unknown) => {
              durableCompletions.push(input);
              return Promise.resolve();
            },
          );
          const crashImages: Array<{
            clientDeviceId: string;
            activeSession: {
              serverId: string;
              sessionId: string;
              commandCursor: number;
              activatedAt: string;
              lastSeenAt: string | null;
            };
            eventOutbox: unknown[];
            routingSequenceCounters: Record<string, number>;
            completedCommands: unknown[];
          }> = [];
          mockPersistPortalCommandCursor.mockImplementation(
            (input: { commandCursor: number }) => {
              if (input.commandCursor !== 1 || crashImages.length > 0) {
                return Promise.resolve();
              }
              // No app_shutdown hook before this image: graceful shutdown would
              // persist the queue and mask the crash-ordering regression.
              crashImages.push({
                clientDeviceId: 'device-1',
                activeSession: {
                  serverId: 'canopy-cloud',
                  sessionId: 'session-1',
                  commandCursor: 1,
                  activatedAt: sessionRow.activatedAt,
                  lastSeenAt: sessionRow.lastSeenAt,
                },
                eventOutbox: durableOutbox.slice(),
                routingSequenceCounters: Object.fromEntries(durableCounters),
                completedCommands: durableCompletions.slice(),
              });
              return Promise.resolve();
            },
          );
          let releaseUpload: () => void = () => undefined;
          const uploadGate = new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          mockSendPortalEvents.mockImplementationOnce(async () => {
            await uploadGate;
            return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
          });
          try {
            await startCanopyPortal();
            await pumpAsync();
            const crashImage = crashImages[0];
            if (!crashImage) {
              throw new Error('Expected a cursor commit crash image');
            }
            expect(crashImage.completedCommands).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ commandId: 'catalog' }),
              ]),
            );
            // Stop solely to clean up the old test instance; NEVER use its
            // shutdown-produced outbox for the restart below.
            releaseUpload();
            await pumpAsync();
            await stopCanopyPortal();
            mockReadPortalStateStore.mockResolvedValue(crashImage);
            mockPollPortalCommands.mockReset().mockImplementation(
              ({ signal }: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                  signal.addEventListener(
                    'abort',
                    () => reject(new Error('aborted')),
                    { once: true },
                  );
                }),
            );
            mockSendPortalEvents.mockReset().mockResolvedValue({
              accepted: 1,
              duplicates: 0,
              connectionStatus: 'active',
            });
            mockReadCompletedPortalCommand.mockClear();
            await resumeCanopyPortalIfPossible();
            await pumpAsync();
            expect(mockPollPortalCommands).toHaveBeenCalledWith(
              expect.objectContaining({ afterSeq: 1 }),
            );
            // Resume does not replay completedCommands; only the durable
            // outbox can supply the event after the cursor has passed it.
            expect(mockReadCompletedPortalCommand).not.toHaveBeenCalled();
            expect(JSON.stringify(mockSendPortalEvents.mock.calls)).toContain(
              'catalog-completed',
            );
          } finally {
            releaseUpload();
            await pumpAsync();
          }
        },
      );
    });

    it('handles a state.request and a chat.send strictly serially when the flag is off (regression pin)', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) => key === 'canopy-portal-enabled',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockHandlePortalCommand.mockImplementation(
        async (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          if (command.id === 'cmd-state') {
            context.enqueueEvent(
              snapshotEvent('snapshot-event-1', 'cmd-state'),
            );
            await buildGate;
            context.enqueueEvent(
              controlEvent('completion-event-1', 'cmd-state'),
            );
            return;
          }
          context.enqueueEvent(controlEvent('chat-completion-2', 'cmd-chat'));
        },
      );
      primeSession([
        pollCommand('cmd-state', 1, 'portal.state.request'),
        pollCommand('cmd-chat', 2, 'portal.chat.send'),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        // The serial loop is still blocked inside the snapshot build; the
        // chat.send behind it has not started and nothing went to the lane.
        expect(mockHandlePortalCommand).toHaveBeenCalledTimes(1);
        expect(mockExecutePortalStateRequest).not.toHaveBeenCalled();

        releaseBuild();
        await pump();

        expect(mockHandlePortalCommand).toHaveBeenCalledTimes(2);
        const sent = JSON.stringify(mockSendPortalEvents.mock.calls);
        expect(sent.indexOf('snapshot-event-1')).toBeGreaterThanOrEqual(0);
        expect(sent.indexOf('snapshot-event-1')).toBeLessThan(
          sent.indexOf('completion-event-1'),
        );
        expect(sent.indexOf('completion-event-1')).toBeLessThan(
          sent.indexOf('chat-completion-2'),
        );
      } finally {
        releaseBuild();
        mockHandlePortalCommand.mockReset();
        await stopCanopyPortal();
      }
    });

    it('lets a chat.send complete while a slow snapshot build is pending, then delivers snapshot before completion', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        async (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          await buildGate;
          context.enqueueEvent(snapshotEvent('snapshot-event-1', command.id));
          context.enqueueEvent(controlEvent('completion-event-1', command.id));
        },
      );
      mockHandlePortalCommand.mockImplementationOnce(
        (
          _command: unknown,
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          context.enqueueEvent(controlEvent('chat-completion-2', 'cmd-chat'));
          return Promise.resolve();
        },
      );
      primeSession([
        pollCommand('cmd-state', 1, 'portal.state.request'),
        pollCommand('cmd-chat', 2, 'portal.chat.send'),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        // The chat.send completed while the snapshot build is still pending —
        // the exact head-of-line blocking CAN-2360 removes.
        expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);
        expect(mockHandlePortalCommand).toHaveBeenCalledTimes(1);
        const sentWhilePending = JSON.stringify(
          mockSendPortalEvents.mock.calls,
        );
        expect(sentWhilePending).toContain('chat-completion-2');
        expect(sentWhilePending).not.toContain('snapshot-event-1');

        releaseBuild();
        await pump();

        const sent = JSON.stringify(mockSendPortalEvents.mock.calls);
        expect(sent.indexOf('chat-completion-2')).toBeLessThan(
          sent.indexOf('snapshot-event-1'),
        );
        expect(sent.indexOf('snapshot-event-1')).toBeLessThan(
          sent.indexOf('completion-event-1'),
        );
        expect(mockPersistCompletedPortalCommand).toHaveBeenCalledWith({
          commandId: 'cmd-state',
          sequence: 1,
          events: [
            expect.objectContaining({ eventId: 'snapshot-event-1' }),
            expect.objectContaining({ eventId: 'completion-event-1' }),
          ],
        });
      } finally {
        releaseBuild();
        await stopCanopyPortal();
      }
    });

    it('keeps two chat.sends ordered relative to each other while a snapshot builds', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        async (): Promise<void> => {
          await buildGate;
        },
      );
      mockHandlePortalCommand.mockImplementation(
        (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          context.enqueueEvent(
            controlEvent(`completion-${command.id}`, command.id),
          );
          return Promise.resolve();
        },
      );
      primeSession([
        pollCommand('cmd-state', 1, 'portal.state.request'),
        pollCommand('cmd-chat-a', 2, 'portal.chat.send'),
        pollCommand('cmd-chat-b', 3, 'portal.chat.send'),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);
        const sent = JSON.stringify(mockSendPortalEvents.mock.calls);
        expect(sent.indexOf('completion-cmd-chat-a')).toBeGreaterThanOrEqual(0);
        expect(sent.indexOf('completion-cmd-chat-a')).toBeLessThan(
          sent.indexOf('completion-cmd-chat-b'),
        );
      } finally {
        releaseBuild();
        mockHandlePortalCommand.mockReset();
        await stopCanopyPortal();
      }
    });

    it('advances the cursor past a handed-off state.request and replays completed ones without re-building', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        async (): Promise<void> => {
          await buildGate;
        },
      );
      mockReadCompletedPortalCommand.mockImplementation(
        (commandId: string): Promise<unknown> =>
          Promise.resolve(
            commandId === 'cmd-replayed'
              ? {
                  commandId: 'cmd-replayed',
                  sequence: 2,
                  completedAt: '2026-07-15T00:00:01.000Z',
                  events: [
                    {
                      type: 'portal.command.completed',
                      commandId: 'cmd-replayed',
                      eventId: 'replayed-completion',
                      clientEventId: 'replayed-completion',
                      occurredAt: '2026-07-15T00:00:01.000Z',
                      payload: { commandId: 'cmd-replayed' },
                    },
                  ],
                }
              : null,
          ),
      );
      primeSession([
        pollCommand('cmd-live', 1, 'portal.state.request'),
        pollCommand('cmd-replayed', 2, 'portal.state.request'),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        // The build for cmd-live is still pending, yet its cursor is already
        // persisted: a crash mid-build leaves the command DELIVERED on the
        // server and swept EXPIRED, the same surface as today.
        expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
          commandCursor: 1,
          lastSeenAt: '2026-07-15T00:00:01.000Z',
        });
        expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
          commandCursor: 2,
          lastSeenAt: '2026-07-15T00:00:01.000Z',
        });

        // The already-completed request replayed from the durable record —
        // it must not be re-built on the lane.
        expect(JSON.stringify(mockSendPortalEvents.mock.calls)).toContain(
          'replayed-completion',
        );
        expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);
        expect(
          JSON.stringify(mockExecutePortalStateRequest.mock.calls),
        ).toContain('cmd-live');
      } finally {
        releaseBuild();
        await stopCanopyPortal();
      }
    });

    it('records the newest state.request target at hand-off (newest-target-wins)', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementation(
        (): Promise<void> => buildGate,
      );
      primeSession([
        pollCommand('cmd-target-a', 1, 'portal.state.request', {
          payload: {
            scope: 'worktree',
            target: { workspaceLocalId: 'ws', worktreeLocalId: 'tree-a' },
          },
        }),
        pollCommand('cmd-target-b', 2, 'portal.state.request', {
          payload: {
            scope: 'worktree',
            target: { workspaceLocalId: 'ws', worktreeLocalId: 'tree-b' },
          },
        }),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        // Both requests are handed off while the first build is still
        // queued; the SECOND target already drives foreground batch
        // selection because it reflects what the user is looking at now.
        expect(getLastTargetedPortalWorktreeKeyForTest()).toBe('ws\0tree-b');
      } finally {
        releaseBuild();
        mockExecutePortalStateRequest.mockReset();
        await stopCanopyPortal();
      }
    });

    it('fails a trimmed state request as retryable and records it as dropped, not posted', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseUpload: () => void = () => undefined;
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      mockSendPortalEvents.mockImplementationOnce(async () => {
        await uploadGate;
        return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          // The first upload carries an unrelated event, so this group is
          // queued rather than in flight when the trim runs.
          context.enqueueEvent(routedEvent('trimmed-head-blocker', null));
          context.enqueueEvent(snapshotEvent('trimmed-head', command.id));
          for (let index = 0; index < 500; index += 1) {
            context.enqueueEvent(routedEvent(`filler-${index}`, null));
          }
          context.enqueueEvent(controlEvent('trimmed-done', command.id));
          return Promise.resolve();
        },
      );
      primeSession([pollCommand('cmd-trimmed', 1, 'portal.state.request')]);
      const stages = (): unknown[] =>
        mockRecordSessionDiagnostic.mock.calls
          .map(
            ([record]: [
              { portalCommandId?: string; portalSnapshotStage?: string },
            ]) => record,
          )
          .filter((record) => record.portalCommandId === 'cmd-trimmed')
          .map((record) => record.portalSnapshotStage);

      try {
        await startCanopyPortal();
        await pump();
        releaseUpload();
        for (let round = 0; round < 10; round += 1) await pump();

        const sent = mockSendPortalEvents.mock.calls.flatMap(
          ([input]: [
            {
              request: {
                events: Array<{
                  type: string;
                  commandId?: string;
                  payload: unknown;
                }>;
              };
            },
          ]) => input.request.events,
        );
        const terminals = sent.filter(
          (event) =>
            event.commandId === 'cmd-trimmed' &&
            event.type.startsWith('portal.command.'),
        );
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({
          type: 'portal.command.failed',
          payload: { retryable: true },
        });
        expect(stages()).toContain('snapshot_event_dropped');
        expect(stages()).not.toContain('snapshot_event_posted');
        expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'portal_outbox_overflow_trimmed',
            trimReason: 'count',
            droppedCommandGroupCount: 1,
          }),
        );
      } finally {
        releaseUpload();
        await stopCanopyPortal();
      }
    });

    it.each([
      {
        name: 'a late chunk and completion follow the drop',
        fillerCount: 500,
        lateChunk: true,
      },
      {
        name: 'the completion itself triggers the drop',
        fillerCount: 499,
        lateChunk: false,
      },
    ])(
      'persists only the retryable failure as the receipt when $name',
      async ({ fillerCount, lateChunk }) => {
        mockIsEnabled.mockImplementation(
          (key: string) =>
            key === 'canopy-portal-enabled' ||
            key === 'canopy-portal-async-snapshots',
        );
        let releaseUpload: () => void = () => undefined;
        const uploadGate = new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        mockSendPortalEvents.mockImplementationOnce(async () => {
          await uploadGate;
          return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
        });
        mockExecutePortalStateRequest.mockImplementationOnce(
          (
            command: { id: string },
            context: {
              enqueueEvent: (
                event: Parameters<typeof compactPortalEvent>[0],
              ) => void;
            },
          ): Promise<void> => {
            // The first upload carries an unrelated event, so this group is
            // queued rather than in flight when the trim runs.
            context.enqueueEvent(routedEvent('receipt-head-blocker', null));
            context.enqueueEvent(snapshotEvent('receipt-head', command.id));
            for (let index = 0; index < fillerCount; index += 1) {
              context.enqueueEvent(
                routedEvent(`receipt-filler-${index}`, null),
              );
            }
            if (lateChunk) {
              context.enqueueEvent({
                ...snapshotEvent('receipt-head:chunk-1', command.id),
                type: 'portal.state.delta',
              });
            }
            context.enqueueEvent(controlEvent('receipt-done', command.id));
            return Promise.resolve();
          },
        );
        primeSession([pollCommand('cmd-receipt', 1, 'portal.state.request')]);

        try {
          await startCanopyPortal();
          await pump();
          releaseUpload();
          for (let round = 0; round < 10; round += 1) await pump();

          const receipts = mockPersistCompletedPortalCommand.mock.calls
            .map(
              ([input]: [
                { commandId: string; events: Array<{ type: string }> },
              ]) => input,
            )
            .filter((input) => input.commandId === 'cmd-receipt');
          expect(receipts.length).toBeGreaterThan(0);
          for (const receipt of receipts) {
            expect(receipt.events.map((event) => event.type)).toEqual([
              'portal.command.failed',
            ]);
          }
        } finally {
          releaseUpload();
          await stopCanopyPortal();
        }
      },
    );

    it('fails a state request whose unsent chunk is trimmed while its head uploads', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseUpload: () => void = () => undefined;
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      mockSendPortalEvents.mockImplementationOnce(async () => {
        await uploadGate;
        return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          // The head alone is selected for the held upload.
          context.enqueueEvent(snapshotEvent('split-head', command.id));
          context.enqueueEvent({
            ...snapshotEvent('split-head:chunk-1', command.id),
            type: 'portal.state.delta',
          });
          for (let index = 0; index < 498; index += 1) {
            context.enqueueEvent(routedEvent(`split-filler-${index}`, null));
          }
          // The 501st event overflows; the unsent chunk is the oldest
          // droppable event.
          context.enqueueEvent(controlEvent('split-done', command.id));
          return Promise.resolve();
        },
      );
      primeSession([pollCommand('cmd-split', 1, 'portal.state.request')]);

      try {
        await startCanopyPortal();
        await pump();
        releaseUpload();
        for (let round = 0; round < 10; round += 1) await pump();

        const sent = mockSendPortalEvents.mock.calls
          .flatMap(
            ([input]: [
              {
                request: {
                  events: Array<{
                    type: string;
                    commandId?: string;
                    payload: unknown;
                  }>;
                };
              },
            ]) => input.request.events,
          )
          .filter((event) => event.commandId === 'cmd-split');
        expect(sent.map((event) => event.type)).toEqual([
          'portal.state.snapshot',
          'portal.command.failed',
        ]);
        expect(sent[1]).toMatchObject({ payload: { retryable: true } });
        const receipts = mockPersistCompletedPortalCommand.mock.calls
          .map(
            ([input]: [
              { commandId: string; events: Array<{ type: string }> },
            ]) => input,
          )
          .filter((input) => input.commandId === 'cmd-split');
        expect(receipts.length).toBeGreaterThan(0);
        for (const receipt of receipts) {
          expect(receipt.events.map((event) => event.type)).toEqual([
            'portal.command.failed',
          ]);
        }
        const stages = mockRecordSessionDiagnostic.mock.calls
          .map(
            ([record]: [
              { portalCommandId?: string; portalSnapshotStage?: string },
            ]) => record,
          )
          .filter((record) => record.portalCommandId === 'cmd-split')
          .map((record) => record.portalSnapshotStage);
        expect(stages).toContain('snapshot_event_dropped');
        expect(stages).not.toContain('snapshot_event_posted');
      } finally {
        releaseUpload();
        await stopCanopyPortal();
      }
    });

    it.each([
      { outcome: 'succeeds', uploadSucceeds: true },
      { outcome: 'fails', uploadSucceeds: false },
    ])(
      'protects an in-flight state request group from overflow while its upload $outcome',
      async ({ uploadSucceeds }) => {
        mockIsEnabled.mockImplementation(
          (key: string) =>
            key === 'canopy-portal-enabled' ||
            key === 'canopy-portal-async-snapshots',
        );
        let settleUpload: () => void = () => undefined;
        const uploadGate = new Promise<void>((resolve, reject) => {
          settleUpload = uploadSucceeds
            ? resolve
            : (): void => reject(new Error('offline'));
        });
        uploadGate.catch(() => undefined);
        mockSendPortalEvents.mockImplementationOnce(async () => {
          await uploadGate;
          return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
        });
        mockExecutePortalStateRequest.mockImplementationOnce(
          (
            command: { id: string },
            context: {
              enqueueEvent: (
                event: Parameters<typeof compactPortalEvent>[0],
              ) => void;
            },
          ): Promise<void> => {
            // The snapshot is selected for the first, still pending, upload.
            context.enqueueEvent(snapshotEvent('in-flight-head', command.id));
            for (let index = 0; index < 499; index += 1) {
              context.enqueueEvent(
                routedEvent(`in-flight-filler-${index}`, null),
              );
            }
            // The 501st event overflows the outbox.
            context.enqueueEvent(controlEvent('in-flight-done', command.id));
            return Promise.resolve();
          },
        );
        primeSession([pollCommand('cmd-in-flight', 1, 'portal.state.request')]);
        // The network stays down after a failed upload, so retries fail too.
        if (!uploadSucceeds) {
          mockSendPortalEvents.mockRejectedValue(new Error('offline'));
        }
        const failedReceipts = (): unknown[] =>
          mockPersistCompletedPortalCommand.mock.calls
            .map(
              ([input]: [
                { commandId: string; events: Array<{ type: string }> },
              ]) => input,
            )
            .filter(
              (input) =>
                input.commandId === 'cmd-in-flight' &&
                input.events.some(
                  (event) => event.type === 'portal.command.failed',
                ),
            );
        const sentEvents = (): Array<{
          type: string;
          commandId?: string;
          payload: unknown;
        }> =>
          mockSendPortalEvents.mock.calls.flatMap(
            ([input]: [
              {
                request: {
                  events: Array<{
                    type: string;
                    commandId?: string;
                    payload: unknown;
                  }>;
                };
              },
            ]) => input.request.events,
          );

        try {
          await startCanopyPortal();
          await pump();
          expect(failedReceipts()).toEqual([]);
          settleUpload();
          for (let round = 0; round < 10; round += 1) await pump();

          if (uploadSucceeds) {
            const sent = sentEvents();
            expect(
              sent
                .filter((event) => event.commandId === 'cmd-in-flight')
                .map((event) => event.type),
            ).toEqual(['portal.state.snapshot', 'portal.command.completed']);
            expect(
              sent.some((event) => event.type === 'portal.events.dropped'),
            ).toBe(false);
            const persistedOutbox =
              mockPersistPortalEventOutbox.mock.calls.at(-1)?.[0] ?? [];
            expect(
              JSON.stringify(persistedOutbox).includes('portal.command.failed'),
            ).toBe(false);
            expect(failedReceipts()).toEqual([]);
            const stages = mockRecordSessionDiagnostic.mock.calls
              .map(
                ([record]: [
                  { portalCommandId?: string; portalSnapshotStage?: string },
                ]) => record,
              )
              .filter((record) => record.portalCommandId === 'cmd-in-flight')
              .map((record) => record.portalSnapshotStage);
            expect(stages).toContain('snapshot_event_posted');
            expect(stages).not.toContain('snapshot_event_dropped');
          } else {
            await enqueuePortalEventForTest(routedEvent('after-failure', null));
            expect(failedReceipts()).toHaveLength(1);
          }
        } finally {
          settleUpload();
          await stopCanopyPortal();
        }
      },
    );

    it.each([
      { path: 'snapshot lane', asyncSnapshots: true },
      { path: 'serial loop', asyncSnapshots: false },
    ])(
      'records a snapshot trimmed during its own enqueue as dropped on the $path',
      async ({ asyncSnapshots }) => {
        mockIsEnabled.mockImplementation(
          (key: string) =>
            key === 'canopy-portal-enabled' ||
            (asyncSnapshots && key === 'canopy-portal-async-snapshots'),
        );
        let releaseUpload: () => void = () => undefined;
        const uploadGate = new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        mockSendPortalEvents.mockImplementationOnce(async () => {
          await uploadGate;
          return { accepted: 1, duplicates: 0, connectionStatus: 'active' };
        });
        const build = (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          // The held first upload carries the blocker; the outbox then fills
          // with control events, which trim keeps longer than a background
          // snapshot, so the snapshot is the event its own enqueue drops.
          context.enqueueEvent(routedEvent('own-enqueue-blocker', null));
          for (let index = 0; index < 499; index += 1) {
            context.enqueueEvent(
              controlEvent(`own-enqueue-control-${index}`, `other-${index}`),
            );
          }
          context.enqueueEvent(snapshotEvent('own-enqueue-head', command.id));
          context.enqueueEvent(controlEvent('own-enqueue-done', command.id));
          return Promise.resolve();
        };
        if (asyncSnapshots) {
          mockExecutePortalStateRequest.mockImplementationOnce(build);
        } else {
          mockHandlePortalCommand.mockImplementationOnce(build);
        }
        primeSession([
          pollCommand('cmd-own-enqueue', 1, 'portal.state.request'),
        ]);
        const records = (): Array<{
          portalCommandId?: string;
          portalSnapshotStage?: string;
          portalSnapshotDropReason?: string;
          portalSnapshotDroppedEventTypes?: string[];
          portalSnapshotDroppedChunkCount?: number;
        }> =>
          mockRecordSessionDiagnostic.mock.calls
            .map(
              ([record]: [
                {
                  portalCommandId?: string;
                  portalSnapshotStage?: string;
                },
              ]) => record,
            )
            .filter((record) => record.portalCommandId === 'cmd-own-enqueue');

        try {
          await startCanopyPortal();
          await pump();
          releaseUpload();
          for (let round = 0; round < 10; round += 1) await pump();

          expect(
            records().find(
              (record) =>
                record.portalSnapshotStage === 'snapshot_event_dropped',
            ),
          ).toMatchObject({
            portalSnapshotDropReason: 'count',
            portalSnapshotDroppedEventTypes: ['portal.state.snapshot'],
            portalSnapshotDroppedChunkCount: 0,
          });
        } finally {
          releaseUpload();
          mockHandlePortalCommand.mockReset();
          await stopCanopyPortal();
        }
      },
    );

    it('discards a handed-off build when the portal stops before it finishes', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        async (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          await buildGate;
          context.enqueueEvent(snapshotEvent('late-snapshot', command.id));
        },
      );
      primeSession([pollCommand('cmd-late', 1, 'portal.state.request')]);

      await startCanopyPortal();
      await pump();
      expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);

      await stopCanopyPortal();
      releaseBuild();
      await pump();

      // The stop's epoch reset orphans the in-flight build: its late events
      // never reach the outbox and no completion record is persisted.
      expect(mockPersistCompletedPortalCommand).not.toHaveBeenCalled();
      expect(JSON.stringify(mockSendPortalEvents.mock.calls)).not.toContain(
        'late-snapshot',
      );
    });

    it('discards a handed-off build when the server reports the session inactive', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      let releaseBuild: () => void = () => undefined;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      mockExecutePortalStateRequest.mockImplementationOnce(
        async (
          command: { id: string },
          context: {
            enqueueEvent: (
              event: Parameters<typeof compactPortalEvent>[0],
            ) => void;
          },
        ): Promise<void> => {
          await buildGate;
          context.enqueueEvent(snapshotEvent('late-snapshot', command.id));
        },
      );
      mockLoadCanopyCloudAccount.mockResolvedValue({
        apiKey: 'test-key',
        capabilities: ['portal-v1'],
      });
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'session-1',
        status: 'pending_auth',
        pendingExpiresAt: '2099-01-01T00:00:00.000Z',
        commandCursor: 0,
      });
      mockPollPortalCommands
        .mockResolvedValueOnce({
          session: sessionRow,
          commands: [pollCommand('cmd-late', 1, 'portal.state.request')],
          nextCursor: 1,
        })
        .mockRejectedValueOnce(
          new CanopyPortalClientError(
            'http-error',
            'Portal session is inactive.',
            409,
          ),
        )
        .mockImplementation(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            }),
        );
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
      // CAN-2651: a 409 is probed with a heartbeat before teardown, so the
      // terminal case this test exercises needs the probe to agree.
      mockSendPortalHeartbeat.mockResolvedValue({
        ok: true,
        status: 'inactive',
      });

      try {
        await startCanopyPortal();
        await pump();
        await pump();

        expect(mockExecutePortalStateRequest).toHaveBeenCalledTimes(1);
        expect(mockClearActivePortalSession).toHaveBeenCalledWith(
          'server_disconnect',
        );

        releaseBuild();
        await pump();

        expect(mockPersistCompletedPortalCommand).not.toHaveBeenCalled();
        expect(JSON.stringify(mockSendPortalEvents.mock.calls)).not.toContain(
          'late-snapshot',
        );
      } finally {
        releaseBuild();
        await stopCanopyPortal();
      }
    });

    it('sends the expired failure instead of handing off an expired state.request', async () => {
      mockIsEnabled.mockImplementation(
        (key: string) =>
          key === 'canopy-portal-enabled' ||
          key === 'canopy-portal-async-snapshots',
      );
      primeSession([
        pollCommand('cmd-expired', 1, 'portal.state.request', {
          status: 'expired',
          expiresAt: '2026-07-15T00:00:01.000Z',
        }),
      ]);

      try {
        await startCanopyPortal();
        await pump();

        // The expired/failed branch stays in the serial loop and wins over
        // the hand-off: the browser gets the terminal failure and the lane
        // never builds.
        expect(mockExecutePortalStateRequest).not.toHaveBeenCalled();
        expect(mockSendPortalEvents).toHaveBeenCalledWith({
          sessionId: 'session-1',
          request: {
            events: [
              expect.objectContaining({
                type: 'portal.command.failed',
                commandId: 'cmd-expired',
              }),
            ],
          },
        });
        expect(mockPersistPortalCommandCursor).toHaveBeenCalledWith({
          commandCursor: 1,
          lastSeenAt: '2026-07-15T00:00:01.000Z',
        });
      } finally {
        await stopCanopyPortal();
      }
    });
  });

  describe('snapshot lane error routing (CAN-2360)', () => {
    it('marks flush-phase network errors without tearing the session down', () => {
      handleSnapshotLaneErrorForTest(new Error('offline'), 'flush');

      expect(getCanopyPortalState().error).toBe('offline');
      // No teardown: the beforeEach stop is the only session-clear recorded.
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith('replaced');
    });

    it('transitions inactive on a flush-phase inactive-session error the heartbeat confirms', async () => {
      // CAN-2651: a 409 is now probed rather than trusted. A heartbeat that
      // also reports `inactive` is the terminal case.
      mockSendPortalHeartbeat.mockResolvedValue({
        ok: true,
        status: 'inactive',
      });
      await primeActiveSession();

      handleSnapshotLaneErrorForTest(
        new CanopyPortalClientError(
          'http-error',
          'Portal session is inactive.',
          409,
        ),
        'flush',
      );
      await pumpAsync();

      expect(mockClearActivePortalSession).toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(getCanopyPortalState().status).toBe('inactive');
    });

    it('keeps the session on a flush-phase 409 the heartbeat revives (CAN-2651)', async () => {
      mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
      await primeActiveSession();

      try {
        handleSnapshotLaneErrorForTest(
          new CanopyPortalClientError(
            'http-error',
            'Portal session is inactive.',
            409,
          ),
          'flush',
        );
        await pumpAsync();

        expect(mockSendPortalHeartbeat).toHaveBeenCalled();
        expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
          'server_disconnect',
        );
        expect(getCanopyPortalState().status).not.toBe('inactive');
        expect(getCanopyPortalState().sessionId).toBe('session-stale');
      } finally {
        await stopCanopyPortal();
      }
    });

    it('stops the portal on a flush-phase 404', async () => {
      handleSnapshotLaneErrorForTest(
        new CanopyPortalClientError('http-error', 'Session gone.', 404),
        'flush',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockClearActivePortalSession).toHaveBeenCalledWith('replaced');
      expect(mockPersistPortalStopReason).toHaveBeenCalledWith('replaced');
    });

    it('treats execute/persist phases as advisory (failure event already synthesized)', () => {
      handleSnapshotLaneErrorForTest(new Error('disk full'), 'persist');
      handleSnapshotLaneErrorForTest(new Error('boom'), 'execute');

      expect(getCanopyPortalState().error).toBeNull();
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith('replaced');
    });
  });

  describe('stale-vs-ended session handling (CAN-2651)', () => {
    afterEach(async () => {
      setCanopyPortalPowerMonitor(null);
      await stopCanopyPortal();
    });

    it('keeps a stale-but-revivable poll response alive and heartbeats it', async () => {
      // The minute sweep flips a session whose heartbeat lapsed past 90s to
      // INACTIVE while leaving it revivable. The desktop used to read
      // `status: 'inactive'` alone and call stopCanopyPortal('replaced'),
      // which also POSTs `end` — finishing the job the sweep started and
      // landing on the silent `disabled` state.
      mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
      await primeActiveSession((poll) => {
        poll.mockResolvedValueOnce({
          session: staleSessionRow({
            status: 'inactive',
            connectionStatus: 'reconnecting',
          }),
          commands: [],
          nextCursor: 0,
        });
      });
      await pumpAsync();

      expect(mockSendPortalHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: STALE_SESSION_ID }),
      );
      expect(mockEndPortalSession).not.toHaveBeenCalled();
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(getCanopyPortalState().sessionId).toBe(STALE_SESSION_ID);
      expect(getCanopyPortalState().status).not.toBe('disabled');
    });

    it('tears down through the inactive transition when the connection has ended', async () => {
      await primeActiveSession((poll) => {
        poll.mockResolvedValueOnce({
          session: staleSessionRow({
            status: 'inactive',
            connectionStatus: 'ended',
            endedAt: '2026-07-15T00:05:00.000Z',
          }),
          commands: [],
          nextCursor: 0,
        });
      });
      await pumpAsync();

      // `inactive` (Disconnected + Reconnect), not the silent `disabled` the
      // stopCanopyPortal('replaced') path produced.
      expect(getCanopyPortalState().status).toBe('inactive');
      expect(mockClearActivePortalSession).toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(mockEndPortalSession).not.toHaveBeenCalled();
    });

    it('recovers from a poll 409 when the heartbeat reports the session live', async () => {
      mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
      await primeActiveSession((poll) => {
        poll.mockRejectedValueOnce(
          new CanopyPortalClientError(
            'http-error',
            'Portal session is inactive.',
            409,
          ),
        );
      });
      await pumpAsync();

      expect(mockSendPortalHeartbeat).toHaveBeenCalled();
      expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
        'server_disconnect',
      );
      expect(getCanopyPortalState().sessionId).toBe(STALE_SESSION_ID);
      expect(getCanopyPortalState().status).not.toBe('inactive');
    });

    it('tears down on a poll 409 the heartbeat confirms is terminal', async () => {
      mockSendPortalHeartbeat.mockResolvedValue({
        ok: true,
        status: 'inactive',
      });
      await primeActiveSession((poll) => {
        poll.mockRejectedValueOnce(
          new CanopyPortalClientError(
            'http-error',
            'Portal session is inactive.',
            409,
          ),
        );
      });
      await pumpAsync();

      expect(getCanopyPortalState().status).toBe('inactive');
      expect(mockClearActivePortalSession).toHaveBeenCalledWith(
        'server_disconnect',
      );
    });

    it('ignores a terminal probe that finishes after a replacement session starts', async () => {
      let resolveFirstHeartbeat:
        | ((value: { ok: true; status: 'inactive' }) => void)
        | undefined;
      mockSendPortalHeartbeat.mockImplementationOnce(
        () =>
          new Promise<{ ok: true; status: 'inactive' }>((resolve) => {
            resolveFirstHeartbeat = resolve;
          }),
      );

      try {
        await primeActiveSession((poll) => {
          poll.mockRejectedValueOnce(
            new CanopyPortalClientError(
              'http-error',
              'Portal session is inactive.',
              409,
            ),
          );
        }, 'session-a');
        await pumpAsync();
        expect(mockSendPortalHeartbeat).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-a' }),
        );

        await stopCanopyPortal();
        mockClearActivePortalSession.mockClear();
        mockSendPortalHeartbeat.mockResolvedValue({
          ok: true,
          status: 'active',
        });
        await primeActiveSession(undefined, 'session-b');

        resolveFirstHeartbeat?.({ ok: true, status: 'inactive' });
        await pumpAsync();

        expect(getCanopyPortalState().sessionId).toBe('session-b');
        expect(getCanopyPortalState().status).not.toBe('inactive');
        expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
          'server_disconnect',
        );
      } finally {
        resolveFirstHeartbeat?.({ ok: true, status: 'inactive' });
        await stopCanopyPortal();
      }
    });

    it('probes and keeps the session when a scheduled heartbeat 409 is revivable', async () => {
      jest.useFakeTimers();
      mockSendPortalHeartbeat
        .mockRejectedValueOnce(
          new CanopyPortalClientError(
            'http-error',
            'Portal session is inactive.',
            409,
          ),
        )
        .mockResolvedValue({ ok: true, status: 'active' });

      try {
        await primeActiveSession();

        await jest.advanceTimersByTimeAsync(15_000);

        expect(mockSendPortalHeartbeat).toHaveBeenCalledTimes(2);
        expect(mockClearActivePortalSession).not.toHaveBeenCalledWith(
          'server_disconnect',
        );
        expect(getCanopyPortalState().sessionId).toBe(STALE_SESSION_ID);
      } finally {
        await stopCanopyPortal();
        jest.useRealTimers();
      }
    });
  });

  describe('power-resume wake recovery (CAN-2651)', () => {
    let resumeListeners: Array<() => void>;
    let powerMonitor: PortalPowerMonitor;

    beforeEach(() => {
      resumeListeners = [];
      powerMonitor = {
        on: (_event, listener): void => {
          resumeListeners.push(listener);
        },
        removeListener: (_event, listener): void => {
          resumeListeners = resumeListeners.filter(
            (candidate) => candidate !== listener,
          );
        },
      };
    });

    afterEach(async () => {
      setCanopyPortalPowerMonitor(null);
      await stopCanopyPortal();
    });

    it('subscribes to resume for the life of the session and releases it on stop', async () => {
      setCanopyPortalPowerMonitor(powerMonitor);
      await primeActiveSession();

      expect(resumeListeners).toHaveLength(1);

      await stopCanopyPortal();

      expect(resumeListeners).toHaveLength(0);
    });

    it('heartbeats immediately on resume so the sleep gap cannot reap the session', async () => {
      // heartbeatTimer is a setTimeout chain and the long-poll await both
      // freeze across sleep, so a >90s suspend crosses the server's reap
      // threshold with nothing in flight to notice.
      mockSendPortalHeartbeat.mockResolvedValue({ ok: true, status: 'active' });
      setCanopyPortalPowerMonitor(powerMonitor);
      await primeActiveSession();
      mockSendPortalHeartbeat.mockClear();

      resumeListeners[0]?.();
      await pumpAsync();

      expect(mockSendPortalHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: STALE_SESSION_ID }),
      );
      expect(getCanopyPortalState().sessionId).toBe(STALE_SESSION_ID);
    });

    it('tears down on resume when the server reports the session gone', async () => {
      mockSendPortalHeartbeat.mockResolvedValue({
        ok: true,
        status: 'inactive',
      });
      setCanopyPortalPowerMonitor(powerMonitor);
      await primeActiveSession();

      await handlePortalPowerResumeForTest();

      expect(getCanopyPortalState().status).toBe('inactive');
      expect(mockClearActivePortalSession).toHaveBeenCalledWith(
        'server_disconnect',
      );
    });
  });
});
