import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  CanopyStreamCursor,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import { CoreChatSnapshotGetResultSchema } from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'snapshot-cursor-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

const scope = { workspaceId: 'project-1', worktreeId: 'worktree-1' };
const streamScope = { projectId: 'project-1', worktreeId: 'worktree-1' };

function chatTab(
  id: string,
  fields: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-11-05T00:00:00.000Z',
    messages: [],
    ...fields,
  };
}

function makeHarness(tabs: PersistedChatTab[] = []): {
  runtime: ReturnType<typeof createDesktopRuntime>;
  current: ChatStateSnapshot;
  getState: jest.Mock;
  emit: (baseRevision: number, revision: number) => ChatStateChangedEvent;
  read: () => Promise<{
    revision: number;
    eventsCursor?: CanopyStreamCursor;
  }>;
  open: (
    cursor?: CanopyStreamCursor,
  ) => Promise<{ frames: ChatFrame[]; close: () => void }>;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const current: ChatStateSnapshot = {
    schemaVersion: 1,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision: 0,
    tabsFile: { version: 1, activeTabId: tabs[0]?.id ?? '', tabs },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
  const getState = jest.fn(() => Promise.resolve(current));
  const port: ChatStateCommandPort = {
    getState,
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    readVisual: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn(
      (listener: (event: ChatStateChangedEvent) => void): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    ),
  };
  const runtime = createDesktopRuntime({ getChatStatePort: () => port });
  let published = 0;
  const emit = (
    baseRevision: number,
    revision: number,
  ): ChatStateChangedEvent => {
    published += 1;
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: `event-${published}`,
      occurredAt: '2026-11-05T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision,
      revision,
      changes: [{ type: 'tab.removed', tabId: `tab-${revision}` }],
    };
    Array.from(listeners).forEach((listener) => listener(event));
    return event;
  };
  const read = (): Promise<{
    revision: number;
    eventsCursor?: CanopyStreamCursor;
  }> => runtime.query('core.chat.snapshot.get', { scope }, { caller });
  const open = async (
    cursor?: CanopyStreamCursor,
  ): Promise<{ frames: ChatFrame[]; close: () => void }> => {
    const frames: ChatFrame[] = [];
    const handle = await runtime.openStream(
      'core.chat.events',
      cursor ? { scope: streamScope, cursor } : { scope: streamScope },
      { caller, onFrame: (frame) => frames.push(frame) },
    );
    return { frames, close: (): void => handle.close() };
  };
  return { runtime, current, getState, emit, read, open };
}

function revisions(frames: ChatFrame[]): number[] {
  return frames.flatMap((frame) =>
    frame.kind === 'item' ? [frame.item.revision] : [],
  );
}

function requireCursor(result: {
  eventsCursor?: CanopyStreamCursor;
}): CanopyStreamCursor {
  if (!result.eventsCursor) throw new Error('Expected an events cursor.');
  return result.eventsCursor;
}

describe('chat snapshot resume cursor (CAN-4111)', () => {
  it("hands out a cursor that resumes right after the snapshot's revision", async () => {
    const { runtime, current, emit, read, open } = makeHarness();
    const epoch = requireCursor(await read()).daemonEpoch;
    for (let revision = 1; revision <= 5; revision += 1)
      emit(revision - 1, revision);
    current.revision = 5;
    const cursor = requireCursor(await read());
    expect(cursor).toEqual({ daemonEpoch: epoch, sequence: 5 });
    emit(5, 6);
    const stream = await open(cursor);
    expect(revisions(stream.frames)).toEqual([6]);
    emit(6, 7);
    expect(revisions(stream.frames)).toEqual([6, 7]);
    stream.close();
    await runtime.shutdown();
  });

  it('accepts a snapshot cursor ahead of publication', async () => {
    const { runtime, current, emit, read, open } = makeHarness();
    const epoch = requireCursor(await read()).daemonEpoch;
    for (let revision = 1; revision <= 5; revision += 1)
      emit(revision - 1, revision);
    current.revision = 6;
    const cursor = requireCursor(await read());
    expect(cursor).toEqual({ daemonEpoch: epoch, sequence: 6 });
    const stream = await open(cursor);
    expect(stream.frames).toEqual([]);
    emit(5, 6);
    expect(stream.frames).toEqual([]);
    emit(6, 7);
    expect(revisions(stream.frames)).toEqual([7]);
    stream.close();
    await runtime.shutdown();
  });

  it('rotates the scope epoch when the snapshot revision went backwards', async () => {
    const { runtime, current, emit, read, open } = makeHarness();
    await read();
    for (let revision = 1; revision <= 3; revision += 1)
      emit(revision - 1, revision);
    const latest = await open();
    const item = latest.frames[0];
    if (item?.kind !== 'item') throw new Error('Expected a chat event item.');
    latest.close();
    const stream = await open(item.cursor);
    current.revision = 1;
    const cursor = requireCursor(await read());
    expect(cursor.daemonEpoch).not.toBe(item.cursor.daemonEpoch);
    expect(stream.frames.at(-1)).toMatchObject({
      kind: 'end',
      error: { code: 'core.chat.snapshotRequired' },
    });
    const resumed = await open(cursor);
    emit(1, 2);
    expect(resumed.frames).toMatchObject([
      { kind: 'item', item: { baseRevision: 1, revision: 2 } },
    ]);
    stream.close();
    resumed.close();
    await runtime.shutdown();
  });

  it('requires a fresh snapshot when the scope restarts during the read', async () => {
    const { runtime, current, getState, emit, read, open } = makeHarness();
    await read();
    for (let revision = 1; revision <= 3; revision += 1)
      emit(revision - 1, revision);
    let release = (): void => undefined;
    getState.mockImplementationOnce(
      () =>
        new Promise<ChatStateSnapshot>((resolve) => {
          release = (): void => resolve({ ...current, revision: 1 });
        }),
    );
    const pending = read();
    await new Promise(setImmediate);
    expect(getState).toHaveBeenCalledTimes(2);
    emit(0, 1);
    emit(1, 2);
    release();
    const stream = await open(requireCursor(await pending));
    expect(
      revisions(stream.frames).includes(2) ||
        stream.frames.some(
          (frame) =>
            frame.kind === 'end' &&
            frame.error?.code === 'core.chat.snapshotRequired',
        ),
    ).toBe(true);
    stream.close();
    await runtime.shutdown();
  });

  it.each([
    [
      'a restart rotates a scope first seen during the read',
      [
        [2, 3],
        [0, 1],
        [1, 2],
      ],
      3,
    ],
    ['the first batch seen during the read is a restart', [[0, 1]], 7],
    ['a restart reaches the snapshot revision during the read', [[0, 1]], 1],
    [
      'a restart passes the snapshot revision during the read',
      [
        [0, 1],
        [1, 2],
      ],
      1,
    ],
  ])(
    'requires a fresh snapshot when %s',
    async (_name, published, snapshotRevision) => {
      const { runtime, current, getState, emit, read, open } = makeHarness();
      let release = (): void => undefined;
      getState.mockImplementationOnce(
        () =>
          new Promise<ChatStateSnapshot>((resolve) => {
            release = (): void =>
              resolve({ ...current, revision: snapshotRevision });
          }),
      );
      const pending = read();
      await new Promise(setImmediate);
      expect(getState).toHaveBeenCalledTimes(1);
      for (const [baseRevision, revision] of published)
        emit(baseRevision, revision);
      release();
      const stream = await open(requireCursor(await pending));
      expect(stream.frames).toMatchObject([
        { kind: 'end', error: { code: 'core.chat.snapshotRequired' } },
      ]);
      stream.close();
      await runtime.shutdown();
    },
  );

  it('requires a fresh snapshot when a scope known only from a snapshot publishes during the read', async () => {
    const { runtime, current, getState, emit, read, open } = makeHarness();
    await read();
    let release = (): void => undefined;
    getState.mockImplementationOnce(
      () =>
        new Promise<ChatStateSnapshot>((resolve) => {
          release = (): void => resolve({ ...current, revision: 0 });
        }),
    );
    const pending = read();
    await new Promise(setImmediate);
    expect(getState).toHaveBeenCalledTimes(2);
    emit(0, 1);
    release();
    const stream = await open(requireCursor(await pending));
    expect(stream.frames).toMatchObject([
      { kind: 'end', error: { code: 'core.chat.snapshotRequired' } },
    ]);
    stream.close();
    await runtime.shutdown();
  });

  it('resumes after a quiet scope restarts between snapshots', async () => {
    const { runtime, current, emit, read, open } = makeHarness();
    current.revision = 7;
    const before = requireCursor(await read());
    current.revision = 0;
    const cursor = requireCursor(await read());
    expect(cursor.daemonEpoch).not.toBe(before.daemonEpoch);
    const stream = await open(cursor);
    expect(stream.frames).toEqual([]);
    emit(0, 1);
    expect(revisions(stream.frames)).toEqual([1]);
    stream.close();
    await runtime.shutdown();
  });

  it("projects each chat tab's transcript revision", async () => {
    const { runtime } = makeHarness([
      chatTab('chat-1', {
        transcript: { transcriptRevision: 12 },
      } as unknown as Partial<PersistedChatTab>),
      chatTab('file-1', { kind: 'file' }),
    ]);
    const result = await runtime.query(
      'core.chat.snapshot.get',
      { scope },
      { caller },
    );
    expect(result.tabs.items[0]?.transcriptRevision).toBe(12);
    expect(result.tabs.items[1]).not.toHaveProperty('transcriptRevision');
    expect(() => CoreChatSnapshotGetResultSchema.parse(result)).not.toThrow();
    await runtime.shutdown();
  });

  it('keeps legacy snapshot callers on the raw snapshot', async () => {
    const { runtime, current } = makeHarness([chatTab('chat-1')]);
    const { legacyResult } = await runtime.queryChatStateForLegacyIpc(
      { scope },
      { caller },
    );
    expect(legacyResult).toBe(current);
    await runtime.shutdown();
  });
});
