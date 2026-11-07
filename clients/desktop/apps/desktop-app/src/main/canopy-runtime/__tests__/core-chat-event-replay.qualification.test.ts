import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import type {
  CanopyStreamCursor,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import { createChatEventReplayLog } from '../chat-event-replay-log';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

interface EmitInput {
  projectId?: string;
  worktreeId?: string;
  baseRevision: number;
  revision: number;
  eventId?: string;
}

const scopeA = { projectId: 'project-1', worktreeId: 'worktree-1' };
const scopeB = { projectId: 'project-2', worktreeId: 'worktree-2' };
const scopeC = { projectId: 'project-3', worktreeId: 'worktree-3' };

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'replay-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

const snapshotRequired = {
  kind: 'failed_precondition',
  code: 'core.chat.snapshotRequired',
  retry: { kind: 'after_refresh', resource: 'core.chat.snapshot.get' },
};
const OPEN_MESSAGE = 'Read a chat snapshot before reopening the event stream.';
const LIVE_MESSAGE =
  'The chat event stream lost its place. Read a chat snapshot.';

function makePort(): {
  port: ChatStateCommandPort;
  subscribe: jest.Mock;
  deliver: (event: ChatStateChangedEvent) => void;
  emit: (input: EmitInput) => ChatStateChangedEvent;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const subscribe = jest.fn(
    (listener: (event: ChatStateChangedEvent) => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  );
  const port: ChatStateCommandPort = {
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    readVisual: jest.fn(),
    command: jest.fn(),
    subscribe,
  };
  const deliver = (event: ChatStateChangedEvent): void => {
    Array.from(listeners).forEach((listener) => listener(event));
  };
  const emit = (input: EmitInput): ChatStateChangedEvent => {
    const projectId = input.projectId ?? scopeA.projectId;
    const worktreeId = input.worktreeId ?? scopeA.worktreeId;
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId:
        input.eventId ?? `${projectId}/${worktreeId}/event-${input.revision}`,
      occurredAt: '2026-11-05T00:00:00.000Z',
      projectId,
      worktreeId,
      baseRevision: input.baseRevision,
      revision: input.revision,
      changes: [{ type: 'tab.removed', tabId: `tab-${input.revision}` }],
    };
    deliver(event);
    return event;
  };
  return { port, subscribe, deliver, emit };
}

function makeHarness(): ReturnType<typeof makePort> & {
  runtime: ReturnType<typeof createDesktopRuntime>;
  open: (
    scope: { projectId: string; worktreeId: string },
    cursor?: CanopyStreamCursor,
  ) => Promise<{ frames: ChatFrame[]; close: () => void }>;
} {
  const harness = makePort();
  const runtime = createDesktopRuntime({
    getChatStatePort: () => harness.port,
  });
  const open = async (
    scope: { projectId: string; worktreeId: string },
    cursor?: CanopyStreamCursor,
  ): Promise<{ frames: ChatFrame[]; close: () => void }> => {
    const frames: ChatFrame[] = [];
    const handle = await runtime.openStream(
      'core.chat.events',
      cursor ? { scope, cursor } : { scope },
      { caller, onFrame: (frame) => frames.push(frame) },
    );
    return { frames, close: (): void => handle.close() };
  };
  return { ...harness, runtime, open };
}

function items(
  frames: ChatFrame[],
): Array<Extract<ChatFrame, { kind: 'item' }>> {
  return frames.flatMap((frame) => (frame.kind === 'item' ? [frame] : []));
}

function firstItem(frames: ChatFrame[]): Extract<ChatFrame, { kind: 'item' }> {
  const [item] = items(frames);
  if (!item) throw new Error('Expected a chat event item.');
  return item;
}

describe('chat event replay in the desktop core (CAN-4111)', () => {
  it('resumes a scoped stream after every client disconnected', async () => {
    const { runtime, open, emit } = makeHarness();
    const first = await open(scopeA);
    emit({ baseRevision: 0, revision: 1 });
    const cursor = firstItem(first.frames).cursor;
    first.close();
    await Promise.resolve();
    emit({ baseRevision: 1, revision: 2 });
    emit({ baseRevision: 2, revision: 3 });
    const resumed = await open(scopeA, cursor);
    expect(
      items(resumed.frames).map((frame) => ({
        revision: frame.item.revision,
        cursor: frame.cursor,
      })),
    ).toEqual([
      {
        revision: 2,
        cursor: { daemonEpoch: cursor.daemonEpoch, sequence: 2 },
      },
      {
        revision: 3,
        cursor: { daemonEpoch: cursor.daemonEpoch, sequence: 3 },
      },
    ]);
    resumed.close();
    await runtime.shutdown();
  });

  it('issues revision cursors in a per-scope epoch and subscribes once', async () => {
    const { runtime, open, emit, subscribe } = makeHarness();
    const a = await open(scopeA);
    const b = await open(scopeB);
    emit({ ...scopeA, baseRevision: 6, revision: 7 });
    emit({ ...scopeB, baseRevision: 6, revision: 7 });
    const cursorA = firstItem(a.frames).cursor;
    const cursorB = firstItem(b.frames).cursor;
    expect(cursorA.sequence).toBe(7);
    expect(cursorB.sequence).toBe(7);
    expect(cursorA.daemonEpoch).not.toBe(cursorB.daemonEpoch);
    expect(cursorA.daemonEpoch).toMatch(/^chat-.+-\d+$/);
    expect(cursorB.daemonEpoch).toMatch(/^chat-.+-\d+$/);
    expect(subscribe).toHaveBeenCalledTimes(1);
    a.close();
    b.close();
    await runtime.shutdown();
  });

  it('replays the latest retained batch for a null cursor', async () => {
    const { runtime, open, emit } = makeHarness();
    const first = await open(scopeA);
    first.close();
    await Promise.resolve();
    emit({ baseRevision: 0, revision: 1 });
    emit({ baseRevision: 1, revision: 2 });
    const fresh = await open(scopeA);
    expect(firstItem(fresh.frames).item.revision).toBe(2);
    fresh.close();
    await runtime.shutdown();
  });

  it('requires a snapshot for a foreign or ahead cursor', async () => {
    const { runtime, open, emit } = makeHarness();
    const live = await open(scopeA);
    emit({ baseRevision: 0, revision: 1 });
    emit({ baseRevision: 1, revision: 2 });
    const epoch = firstItem(live.frames).cursor.daemonEpoch;
    for (const cursor of [
      { daemonEpoch: 'foreign', sequence: 1 },
      { daemonEpoch: epoch, sequence: 3 },
    ]) {
      const stale = await open(scopeA, cursor);
      expect(stale.frames).toMatchObject([
        {
          kind: 'end',
          outcome: 'error',
          error: { ...snapshotRequired, message: OPEN_MESSAGE },
        },
      ]);
      stale.close();
    }
    live.close();
    await runtime.shutdown();
  });

  it('delivers a batch published while the stream replays', async () => {
    const { runtime, open, emit } = makeHarness();
    const first = await open(scopeA);
    emit({ baseRevision: 0, revision: 1 });
    const cursor = firstItem(first.frames).cursor;
    first.close();
    await Promise.resolve();
    emit({ baseRevision: 1, revision: 2 });
    const frames: ChatFrame[] = [];
    const handle = await runtime.openStream(
      'core.chat.events',
      { scope: scopeA, cursor },
      {
        caller,
        onFrame: (frame) => {
          frames.push(frame);
          if (frame.kind === 'item' && frame.item.revision === 2)
            emit({ baseRevision: 2, revision: 3 });
        },
      },
    );
    emit({ baseRevision: 3, revision: 4 });
    expect(frames.map((frame) => frame.kind)).toEqual(['item', 'item', 'item']);
    expect(items(frames).map((frame) => frame.item.revision)).toEqual([
      2, 3, 4,
    ]);
    handle.close();
    await runtime.shutdown();
  });

  it('keeps its place when a frame callback publishes the next batch', async () => {
    const { runtime, emit } = makeHarness();
    const frames: ChatFrame[] = [];
    const handle = await runtime.openStream(
      'core.chat.events',
      { scope: scopeA },
      {
        caller,
        onFrame: (frame) => {
          frames.push(frame);
          if (frame.kind === 'item' && frame.item.revision === 1)
            emit({ baseRevision: 1, revision: 2 });
        },
      },
    );
    emit({ baseRevision: 0, revision: 1 });
    emit({ baseRevision: 2, revision: 3 });
    expect(frames.map((frame) => frame.kind)).toEqual(['item', 'item', 'item']);
    expect(items(frames).map((frame) => frame.item.revision)).toEqual([
      1, 2, 3,
    ]);
    handle.close();
    await runtime.shutdown();
  });

  it('delivers batches in order to every stream when one publishes from its callback', async () => {
    const { runtime, emit } = makeHarness();
    const first: ChatFrame[] = [];
    const second: ChatFrame[] = [];
    const firstHandle = await runtime.openStream(
      'core.chat.events',
      { scope: scopeA },
      {
        caller,
        onFrame: (frame) => {
          first.push(frame);
          if (frame.kind === 'item' && frame.item.revision === 1)
            emit({ baseRevision: 1, revision: 2 });
        },
      },
    );
    const secondHandle = await runtime.openStream(
      'core.chat.events',
      { scope: scopeA },
      { caller, onFrame: (frame) => second.push(frame) },
    );
    emit({ baseRevision: 0, revision: 1 });
    for (const frames of [first, second])
      expect(
        frames.map((frame) =>
          frame.kind === 'item' ? frame.item.revision : frame.kind,
        ),
      ).toEqual([1, 2]);
    firstHandle.close();
    secondHandle.close();
    await runtime.shutdown();
  });

  it('delivers a repeated port event once', async () => {
    const { runtime, open, emit, deliver } = makeHarness();
    const stream = await open(scopeA);
    const event = emit({ baseRevision: 0, revision: 1 });
    deliver(event);
    deliver({ ...event });
    emit({ baseRevision: 1, revision: 2 });
    expect(items(stream.frames).map((frame) => frame.item.revision)).toEqual([
      1, 2,
    ]);
    stream.close();
    await runtime.shutdown();
  });

  it('ends a live stream at a revision gap', async () => {
    const { runtime, open, emit } = makeHarness();
    const stream = await open(scopeA);
    emit({ baseRevision: 0, revision: 1 });
    const cursor = firstItem(stream.frames).cursor;
    emit({ baseRevision: 3, revision: 4 });
    expect(stream.frames.at(-1)).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: { ...snapshotRequired, message: LIVE_MESSAGE },
    });
    const behind = await open(scopeA, cursor);
    expect(behind.frames).toMatchObject([
      { kind: 'end', error: { code: 'core.chat.snapshotRequired' } },
    ]);
    const current = await open(scopeA, { ...cursor, sequence: 4 });
    expect(current.frames).toEqual([]);
    emit({ baseRevision: 4, revision: 5 });
    expect(items(current.frames).map((frame) => frame.item.revision)).toEqual([
      5,
    ]);
    stream.close();
    behind.close();
    current.close();
    await runtime.shutdown();
  });

  it("ends live streams and refuses old cursors when a scope's revisions restart", async () => {
    const { runtime, open, emit } = makeHarness();
    const stream = await open(scopeA);
    emit({ baseRevision: 0, revision: 1 });
    emit({ baseRevision: 1, revision: 2 });
    emit({ baseRevision: 2, revision: 3 });
    const old = items(stream.frames).at(-1);
    if (!old) throw new Error('Expected a chat event item.');
    expect(old.cursor.sequence).toBe(3);
    emit({ eventId: 'restart', baseRevision: 0, revision: 1 });
    expect(stream.frames.at(-1)).toMatchObject({
      kind: 'end',
      error: { code: 'core.chat.snapshotRequired' },
    });
    const stale = await open(scopeA, old.cursor);
    expect(stale.frames).toMatchObject([
      { kind: 'end', error: { code: 'core.chat.snapshotRequired' } },
    ]);
    const fresh = await open(scopeA);
    const restarted = firstItem(fresh.frames);
    expect(restarted.item).toMatchObject({ eventId: 'restart', revision: 1 });
    expect(restarted.cursor.daemonEpoch).not.toBe(old.cursor.daemonEpoch);
    stream.close();
    stale.close();
    fresh.close();
    await runtime.shutdown();
  });

  it('bounds scope records that streams and snapshots create', () => {
    const { port, emit } = makePort();
    const log = createChatEventReplayLog(() => port, {
      limits: { perScope: 2, total: 3, scopes: 2, eventIds: 4 },
      createId: () => 'log',
    });
    expect(log.attach()).toBe(true);
    emit({ ...scopeA, baseRevision: 0, revision: 1 });
    const replayed = log.resume(scopeA, null);
    if (replayed.kind !== 'replay') throw new Error('Expected a replay.');
    log.resume(scopeB, null);
    const stopFollowing = log.follow(scopeB, {
      event: () => undefined,
      reset: () => undefined,
    });
    stopFollowing();
    log.resume(scopeC, null);
    expect(
      log.resume(scopeA, { daemonEpoch: replayed.epoch, sequence: 1 }),
    ).toEqual({ kind: 'snapshot_required', reason: 'foreign_epoch' });
    log.dispose();
  });

  it('bounds retention per scope and in total', () => {
    const { port, emit } = makePort();
    const log = createChatEventReplayLog(() => port, {
      limits: { perScope: 2, total: 3, scopes: 2, eventIds: 4 },
      createId: () => 'log',
    });
    expect(log.attach()).toBe(true);
    emit({ ...scopeA, baseRevision: 0, revision: 1 });
    emit({ ...scopeA, baseRevision: 1, revision: 2 });
    emit({ ...scopeA, baseRevision: 2, revision: 3 });
    const replayed = log.resume(scopeA, null);
    if (replayed.kind !== 'replay') throw new Error('Expected a replay.');
    const epoch = replayed.epoch;
    expect(log.resume(scopeA, { daemonEpoch: epoch, sequence: 0 })).toEqual({
      kind: 'snapshot_required',
      reason: 'expired',
    });
    const resumed = log.resume(scopeA, { daemonEpoch: epoch, sequence: 1 });
    expect(
      resumed.kind === 'replay'
        ? resumed.events.map((event) => event.revision)
        : resumed,
    ).toEqual([2, 3]);
    emit({ ...scopeB, baseRevision: 0, revision: 1 });
    emit({ ...scopeB, baseRevision: 1, revision: 2 });
    expect(log.resume(scopeA, { daemonEpoch: epoch, sequence: 1 })).toEqual({
      kind: 'snapshot_required',
      reason: 'expired',
    });
    emit({ ...scopeC, baseRevision: 0, revision: 1 });
    expect(log.resume(scopeA, { daemonEpoch: epoch, sequence: 3 })).toEqual({
      kind: 'snapshot_required',
      reason: 'foreign_epoch',
    });
    log.dispose();
  });

  it('rotates the epoch only for a snapshot below the published watermark', () => {
    const { port, emit } = makePort();
    const log = createChatEventReplayLog(() => port, {
      limits: { perScope: 2, total: 3, scopes: 2, eventIds: 4 },
      createId: () => 'log',
    });
    expect(log.attach()).toBe(true);
    emit({ ...scopeA, baseRevision: 0, revision: 1 });
    emit({ ...scopeA, baseRevision: 1, revision: 2 });
    const current = log.beginSnapshot(scopeA)(2);
    expect(current.sequence).toBe(2);
    const replayed = log.resume(scopeA, null);
    if (replayed.kind !== 'replay') throw new Error('Expected a replay.');
    expect(current.daemonEpoch).toBe(replayed.epoch);
    const rotated = log.beginSnapshot(scopeA)(1);
    expect(rotated.daemonEpoch).not.toBe(current.daemonEpoch);
    expect(log.resume(scopeA, current)).toEqual({
      kind: 'snapshot_required',
      reason: 'foreign_epoch',
    });
    const finish = log.beginSnapshot(scopeA);
    emit({ ...scopeA, baseRevision: 2, revision: 3 });
    expect(finish(2)).toEqual({
      daemonEpoch: rotated.daemonEpoch,
      sequence: 2,
    });
    log.dispose();
  });
});
