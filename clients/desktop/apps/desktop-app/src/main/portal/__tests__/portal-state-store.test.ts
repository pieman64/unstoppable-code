import os from 'node:os';
import path from 'node:path';
import type * as nodeFs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const mockGetPath = jest.fn();

jest.mock('electron', () => ({
  app: {
    get getPath(): typeof mockGetPath {
      return mockGetPath;
    },
  },
}));

import {
  clearActivePortalSession,
  persistActivePortalSession,
  persistCompletedPortalCommand,
  persistPortalEventOutbox,
  persistPortalViewMode,
  persistPortalCommandCursor,
  markPortalWorkspaceCreateStarted,
  readStartedPortalWorkspaceCreates,
  readPortalStateStore,
} from '../portal-state-store';
import {
  computePortalOutboxTrim,
  PORTAL_OUTBOX_MAX_BYTES,
  portalEventByteLength,
  stampPortalEventRouting,
} from '../portal-outbox';
import {
  PORTAL_COMPLETED_COMMANDS_MAX_BYTES,
  PORTAL_STATE_FILE_MAX_BYTES,
} from '../portal-state-store';
import { writeFile } from 'node:fs/promises';
import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';

describe('portal-state-store', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), 'canopy-portal-'));
    mockGetPath.mockReturnValue(userDataPath);
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
    mockGetPath.mockReset();
  });

  it('never persists visual page bytes in the outbox or completed replay', async () => {
    const page = Buffer.alloc(384_000, 97).toString('base64');
    const event: PortalEventEnvelope = {
      type: 'portal.command.completed',
      eventId: 'visual-event',
      commandId: 'visual-command',
      occurredAt: '2026-10-08T00:00:00.000Z',
      payload: {
        commandId: 'visual-command',
        sequenceNumber: 1,
        generatedAt: '2026-10-08T00:00:00.000Z',
        result: {
          kind: 'inline-page',
          data: page,
          offset: 0,
          length: 384_000,
          byteLength: 384_000,
          sha256: 'a'.repeat(64),
        },
      },
    };
    await persistPortalEventOutbox([event], new Map());
    await persistCompletedPortalCommand({
      commandId: 'visual-command',
      sequence: 1,
      events: [event],
    });
    const raw = await readFile(
      path.join(userDataPath, 'portal-state.json'),
      'utf8',
    );
    expect(raw).not.toContain(page.slice(0, 100));
    const state = await readPortalStateStore();
    expect(state.eventOutbox?.[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { retryable: true },
    });
    expect(state.completedCommands?.[0]?.events[0]).toMatchObject({
      type: 'portal.command.failed',
      eventId: 'visual-event:replay',
    });
  });

  it('restores validated session-scoped started creates after a restart', async () => {
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      JSON.stringify({
        version: 1,
        clientDeviceId: 'device-1',
        activeSession: {
          serverId: 'server-1',
          sessionId: 'session-1',
          commandCursor: 1,
          activatedAt: '2026-10-08T00:00:00.000Z',
          lastSeenAt: null,
        },
        startedWorkspaceCreates: {
          sessionId: 'session-1',
          commands: [{ commandId: 'cmd-2', sequence: 2 }],
        },
      }),
    );
    await expect(readPortalStateStore()).resolves.toMatchObject({
      startedWorkspaceCreates: {
        sessionId: 'session-1',
        commands: [{ commandId: 'cmd-2', sequence: 2 }],
      },
    });
  });

  const session = {
    serverId: 'server-1',
    sessionId: 'session-1',
    commandCursor: 0,
    activatedAt: '2026-10-08T00:00:00.000Z',
    lastSeenAt: null,
  };
  const create = {
    sessionId: 'session-1',
    commandId: 'cmd-create',
    sequence: 2,
  };

  async function restoreDiskInNewProcess(): Promise<void> {
    const raw = await readFile(
      path.join(userDataPath, 'portal-state.json'),
      'utf8',
    );
    const restoredPath = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-portal-restored-'),
    );
    await writeFile(path.join(restoredPath, 'portal-state.json'), raw);
    await rm(userDataPath, { recursive: true, force: true });
    userDataPath = restoredPath;
    mockGetPath.mockReturnValue(userDataPath);
  }

  it('durably claims once even when two deliveries race', async () => {
    await persistActivePortalSession(session);
    expect(
      await Promise.all([
        markPortalWorkspaceCreateStarted(create),
        markPortalWorkspaceCreateStarted(create),
      ]),
    ).toEqual([true, false]);
    await restoreDiskInNewProcess();
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
    await expect(
      readStartedPortalWorkspaceCreates('another-session'),
    ).resolves.toEqual([]);
  });

  it('retains the marker across completion persistence and the completion-to-cursor crash window', async () => {
    await persistActivePortalSession(session);
    await markPortalWorkspaceCreateStarted(create);
    await persistCompletedPortalCommand({
      commandId: create.commandId,
      sequence: create.sequence,
      events: [],
    });
    await restoreDiskInNewProcess();
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
    await expect(
      readStartedPortalWorkspaceCreates(session.sessionId),
    ).resolves.toEqual([
      { commandId: create.commandId, sequence: create.sequence },
    ]);
  });

  it('cleans up only acknowledged IDs atomically with the cursor and preserves outstanding creates', async () => {
    await persistActivePortalSession(session);
    await markPortalWorkspaceCreateStarted(create);
    await markPortalWorkspaceCreateStarted({
      ...create,
      commandId: 'later-create',
      sequence: 4,
    });
    await persistPortalCommandCursor({ commandCursor: 2 });
    await restoreDiskInNewProcess();
    await expect(
      readStartedPortalWorkspaceCreates(session.sessionId),
    ).resolves.toEqual([{ commandId: 'later-create', sequence: 4 }]);
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
    await persistPortalCommandCursor({ commandCursor: 1 });
    expect((await readPortalStateStore()).activeSession?.commandCursor).toBe(2);
  });

  it('does not rewind acknowledged creates on same-session reactivation, including after clearing runtime state', async () => {
    await persistActivePortalSession(session);
    await markPortalWorkspaceCreateStarted(create);
    await persistPortalCommandCursor({ commandCursor: 2 });
    await persistActivePortalSession(session);
    expect((await readPortalStateStore()).activeSession?.commandCursor).toBe(2);
    await clearActivePortalSession('app_shutdown');
    await persistActivePortalSession(session);
    expect((await readPortalStateStore()).activeSession?.commandCursor).toBe(2);
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
  });

  it('ignores an acknowledgement from an older session without deleting current markers', async () => {
    await persistActivePortalSession({ ...session, sessionId: 'new-session' });
    await markPortalWorkspaceCreateStarted({
      ...create,
      sessionId: 'new-session',
    });
    await persistPortalCommandCursor({
      sessionId: 'session-1',
      commandCursor: 100,
    });
    expect((await readPortalStateStore()).activeSession?.commandCursor).toBe(0);
    await expect(
      readStartedPortalWorkspaceCreates('new-session'),
    ).resolves.toEqual([
      { commandId: create.commandId, sequence: create.sequence },
    ]);
  });

  it('retains durable markers when cursor persistence fails', async () => {
    await persistActivePortalSession(session);
    await markPortalWorkspaceCreateStarted(create);
    const fs = jest.requireActual<typeof nodeFs>('node:fs').promises;
    const rename = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('disk failure'));
    try {
      await expect(
        persistPortalCommandCursor({ commandCursor: 2 }),
      ).rejects.toThrow('disk failure');
    } finally {
      rename.mockRestore();
    }
    await restoreDiskInNewProcess();
    expect((await readPortalStateStore()).activeSession?.commandCursor).toBe(0);
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
  });

  it('rejects marker write errors and retains a conservative in-memory claim', async () => {
    await persistActivePortalSession(session);
    const fs = jest.requireActual<typeof nodeFs>('node:fs').promises;
    const rename = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('marker failure'));
    try {
      await expect(markPortalWorkspaceCreateStarted(create)).rejects.toThrow(
        'marker failure',
      );
    } finally {
      rename.mockRestore();
    }
    // The first caller cannot invoke the clone; a later writer may persist
    // its claim, so redelivery remains conservative in this process.
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
  });

  it('preserves outstanding IDs on same-session activation and reconnect but resets for a new session', async () => {
    await persistActivePortalSession(session);
    await markPortalWorkspaceCreateStarted(create);
    await persistActivePortalSession({
      ...session,
      lastSeenAt: '2026-10-08T01:00:00.000Z',
    });
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
    await clearActivePortalSession('app_shutdown');
    await persistActivePortalSession(session);
    await expect(markPortalWorkspaceCreateStarted(create)).resolves.toBe(false);
    await persistActivePortalSession({ ...session, sessionId: 'new-session' });
    await expect(
      readStartedPortalWorkspaceCreates(session.sessionId),
    ).resolves.toEqual([]);
    await expect(
      markPortalWorkspaceCreateStarted({ ...create, sessionId: 'new-session' }),
    ).resolves.toBe(true);
    await expect(markPortalWorkspaceCreateStarted(create)).rejects.toThrow(
      'no longer active',
    );
  });

  it.each([
    undefined,
    null,
    [],
    { sessionId: 123, commands: [] },
    { sessionId: 'session-1', commands: 'invalid' },
  ])(
    'accepts legacy/malformed marker state without inventing IDs: %p',
    async (startedWorkspaceCreates) => {
      await writeFile(
        path.join(userDataPath, 'portal-state.json'),
        JSON.stringify({
          version: 1,
          clientDeviceId: 'device-1',
          startedWorkspaceCreates,
        }),
      );
      await expect(
        readStartedPortalWorkspaceCreates(session.sessionId),
      ).resolves.toEqual([]);
    },
  );

  it('validates persisted command identities and sequences and deduplicates IDs', async () => {
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      JSON.stringify({
        version: 1,
        clientDeviceId: 'device-1',
        startedWorkspaceCreates: {
          sessionId: 'session-1',
          commands: [
            null,
            {},
            { commandId: '', sequence: 1 },
            { commandId: 'negative', sequence: -1 },
            { commandId: 'fractional', sequence: 1.2 },
            { commandId: 42, sequence: 2 },
            { commandId: 'cmd-2', sequence: 2 },
            { commandId: 'cmd-2', sequence: 3 },
          ],
        },
      }),
    );
    await expect(
      readStartedPortalWorkspaceCreates(session.sessionId),
    ).resolves.toEqual([{ commandId: 'cmd-2', sequence: 2 }]);
  });

  it('preserves viewMode when clearing active runtime session state', async () => {
    await persistPortalViewMode('standalone-chats');
    await persistActivePortalSession({
      serverId: 'server-1',
      sessionId: 'session-1',
      commandCursor: 2,
      activatedAt: '2026-05-19T00:00:00.000Z',
      lastSeenAt: '2026-05-19T00:00:01.000Z',
    });

    await clearActivePortalSession('local_disconnect');

    await expect(readPortalStateStore()).resolves.toMatchObject({
      viewMode: 'standalone-chats',
      lastStopReason: 'local_disconnect',
    });
    await expect(readPortalStateStore()).resolves.not.toHaveProperty(
      'activeSession',
    );
  });

  it('clears a stale lastStopReason when a session activates (CAN-2235)', async () => {
    // A previous session's teardown reason must not survive into a healthy
    // activation: if the app then dies without a clean `app_shutdown` write,
    // resumeCanopyPortalIfPossible refuses to resume a perfectly valid
    // session and Remote Control silently never comes back.
    await clearActivePortalSession('server_disconnect');
    await expect(readPortalStateStore()).resolves.toMatchObject({
      lastStopReason: 'server_disconnect',
    });

    await persistActivePortalSession({
      serverId: 'server-1',
      sessionId: 'session-2',
      commandCursor: 0,
      activatedAt: '2026-05-19T00:00:00.000Z',
      lastSeenAt: null,
    });

    const state = await readPortalStateStore();
    expect(state.activeSession?.sessionId).toBe('session-2');
    expect(state).not.toHaveProperty('lastStopReason');
  });

  it('persists routing sequence counters atomically with the outbox', async () => {
    await persistPortalEventOutbox(
      [
        {
          type: 'portal.heartbeat',
          eventId: 'event-1',
          occurredAt: '2026-07-31T00:00:00.000Z',
          payload: {},
        },
      ],
      new Map([['workspace\0worktree', 12]]),
    );

    await expect(readPortalStateStore()).resolves.toMatchObject({
      routingSequenceCounters: { ['workspace\0worktree']: 12 },
    });
  });

  it('persists state-request command ids that still have queued events', async () => {
    await persistPortalEventOutbox(
      [
        {
          type: 'portal.state.snapshot',
          commandId: 'state-1',
          eventId: 'snapshot-1',
          occurredAt: '2026-07-31T00:00:00.000Z',
          payload: {},
        },
      ],
      new Map(),
      new Set(['state-1', 'state-already-sent']),
    );

    await expect(readPortalStateStore()).resolves.toMatchObject({
      stateRequestCommandIds: ['state-1'],
    });
  });

  it('restores cap-reserved dropped-range markers from persistence', async () => {
    const counters = new Map<string, number>();
    const events: PortalEventEnvelope[] = ['a', 'b', 'a', 'b'].map(
      (worktreeLocalId, index) =>
        stampPortalEventRouting(
          {
            type: 'portal.chat.event',
            eventId: `event-${String(index)}`,
            occurredAt: '2026-07-31T00:00:00.000Z',
            payload: { workspaceLocalId: 'ws', worktreeLocalId },
          },
          counters,
        ),
    );
    const trimmed = computePortalOutboxTrim(events, 2, null);

    await persistPortalEventOutbox(trimmed.kept, counters);
    const restored = await readPortalStateStore();

    expect(restored.eventOutbox).toHaveLength(2);
    // Bounded retention keeps the newest real event and folds the surplus
    // dropped ranges into one aggregate marker rather than filling the cap
    // with per-key markers.
    const marker = restored.eventOutbox?.find(
      (item) => String(item.type) === 'portal.events.dropped',
    );
    const survivor = restored.eventOutbox?.find(
      (item) => String(item.type) === 'portal.chat.event',
    );
    expect(marker).toBeDefined();
    expect(survivor).toBeDefined();
    expect(marker?.payload).toMatchObject({ reason: 'overflow' });
  });

  it('persists the store as compact JSON (no pretty-print indent)', async () => {
    // Pretty-printing inflates a snapshot-heavy outbox by ~30% and the whole
    // store is re-stringified on every save on the main process (CAN-2319).
    await persistPortalEventOutbox(
      [
        {
          type: 'portal.heartbeat',
          eventId: 'event-1',
          occurredAt: '2026-08-17T00:00:00.000Z',
          payload: { nested: { value: 1 } },
        },
      ],
      new Map(),
    );

    const raw = await readFile(
      path.join(userDataPath, 'portal-state.json'),
      'utf8',
    );
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw))}\n`);
    expect(JSON.parse(raw)).toMatchObject({
      eventOutbox: [{ eventId: 'event-1' }],
    });
  });

  it('byte-caps an oversized persisted eventOutbox on read, keeping newest events', async () => {
    // Upgrade path for CAN-2319: a store bloated by an older build must be
    // bounded at the read choke point, before any caller re-serializes it.
    const megabyte = 'x'.repeat(1024 * 1024);
    const events = Array.from({ length: 24 }, (_, i) => ({
      type: 'portal.state.snapshot',
      eventId: `snap-${String(i)}`,
      occurredAt: '2026-08-17T00:00:00.000Z',
      payload: { filler: megabyte },
    }));
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      JSON.stringify({
        version: 1,
        clientDeviceId: 'device-1',
        eventOutbox: events,
      }),
      'utf8',
    );

    const state = await readPortalStateStore();
    const outbox = state.eventOutbox ?? [];
    const totalBytes = outbox.reduce(
      (sum, event) => sum + portalEventByteLength(event),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(PORTAL_OUTBOX_MAX_BYTES);
    expect(outbox.length).toBeLessThan(24);
    expect(outbox[outbox.length - 1]?.eventId).toBe('snap-23');
    expect(outbox.map((event) => event.eventId)).not.toContain('snap-0');
  });

  it('byte-caps oversized persisted completedCommands on read, keeping newest entries', async () => {
    const megabyte = 'y'.repeat(1024 * 1024);
    const completedCommands = Array.from({ length: 24 }, (_, i) => ({
      commandId: `command-${String(i)}`,
      sequence: i,
      completedAt: '2026-08-17T00:00:00.000Z',
      events: [
        {
          type: 'portal.state.snapshot',
          eventId: `command-snap-${String(i)}`,
          occurredAt: '2026-08-17T00:00:00.000Z',
          payload: { filler: megabyte },
        },
      ],
    }));
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      JSON.stringify({
        version: 1,
        clientDeviceId: 'device-1',
        completedCommands,
      }),
      'utf8',
    );

    const state = await readPortalStateStore();
    const commands = state.completedCommands ?? [];
    const totalBytes = Buffer.byteLength(JSON.stringify(commands), 'utf8');
    expect(totalBytes).toBeLessThanOrEqual(PORTAL_COMPLETED_COMMANDS_MAX_BYTES);
    expect(commands.length).toBeLessThan(24);
    expect(commands[commands.length - 1]?.commandId).toBe('command-23');
    expect(commands.map((entry) => entry.commandId)).not.toContain('command-0');
  });

  it('does not re-read and re-parse the store file on every update', async () => {
    // Regression (2026-09-05 main OOM): with the outbox pinned at its 20MB
    // byte cap, every updatePortalStateStore call re-read, re-parsed, and
    // re-normalized the whole ~28MB store from disk before rewriting it —
    // ~1.7s of main-thread work per update, requested every 250ms. The store
    // has a single writer (this process), so after the initial load updates
    // must operate on cached in-memory state.
    await persistPortalViewMode('worktrees');

    const fsModule = jest.requireActual<typeof nodeFs>('node:fs');
    const readSpy = jest.spyOn(fsModule.promises, 'readFile');
    try {
      await persistPortalViewMode('standalone-chats');
      await persistPortalEventOutbox(
        [
          {
            type: 'portal.heartbeat',
            eventId: 'event-1',
            occurredAt: '2026-09-05T00:00:00.000Z',
            payload: {},
          },
        ],
        new Map(),
      );
      await persistPortalViewMode('worktrees');

      const storeReads = readSpy.mock.calls.filter(
        ([target]) =>
          typeof target === 'string' && target.endsWith('portal-state.json'),
      );
      expect(storeReads).toHaveLength(0);
    } finally {
      readSpy.mockRestore();
    }

    await expect(readPortalStateStore()).resolves.toMatchObject({
      viewMode: 'worktrees',
      eventOutbox: [{ eventId: 'event-1' }],
    });
  });

  it('coalesces a burst of updates into a bounded number of store writes', async () => {
    // Regression (2026-09-05 main OOM): updates were chained one write per
    // update, so when writes were slower than the enqueue rate the backlog
    // grew without bound and the main thread never drained. A burst landing
    // while a write is in flight must collapse into a single trailing write
    // carrying the final state, and every caller must still resolve only
    // after its update is durable.
    await persistPortalViewMode('worktrees');

    const fsModule = jest.requireActual<typeof nodeFs>('node:fs');
    const realWriteFile = fsModule.promises.writeFile.bind(fsModule.promises);
    const writeSpy = jest
      .spyOn(fsModule.promises, 'writeFile')
      .mockImplementation(async (...args: Parameters<typeof realWriteFile>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return realWriteFile(...args);
      });
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          persistPortalEventOutbox(
            [
              {
                type: 'portal.heartbeat',
                eventId: `burst-${String(index)}`,
                occurredAt: '2026-09-05T00:00:00.000Z',
                payload: {},
              },
            ],
            new Map(),
          ),
        ),
      );

      const storeWrites = writeSpy.mock.calls.filter(
        ([target]) =>
          typeof target === 'string' && target.includes('portal-state.json'),
      );
      expect(storeWrites.length).toBeLessThanOrEqual(3);
    } finally {
      writeSpy.mockRestore();
    }

    // The last update in the burst must be what landed on disk.
    const raw = await readFile(
      path.join(userDataPath, 'portal-state.json'),
      'utf8',
    );
    expect(JSON.parse(raw)).toMatchObject({
      eventOutbox: [{ eventId: 'burst-9' }],
    });
  });

  it('byte-caps completedCommands on the in-memory write path, keeping newest entries', async () => {
    // With cached in-memory state, updates no longer round-trip through the
    // read-path normalize(), so persistCompletedPortalCommand's own budget is
    // the only bound between disk loads.
    const megabyte = 'y'.repeat(1024 * 1024);
    for (let index = 0; index < 12; index += 1) {
      await persistCompletedPortalCommand({
        commandId: `command-${String(index)}`,
        sequence: index,
        events: [
          {
            type: 'portal.state.snapshot',
            eventId: `command-snap-${String(index)}`,
            occurredAt: '2026-09-05T00:00:00.000Z',
            payload: { filler: megabyte },
          },
        ],
      });
    }

    const state = await readPortalStateStore();
    const commands = state.completedCommands ?? [];
    const totalBytes = Buffer.byteLength(JSON.stringify(commands), 'utf8');
    expect(totalBytes).toBeLessThanOrEqual(PORTAL_COMPLETED_COMMANDS_MAX_BYTES);
    expect(commands.length).toBeLessThan(12);
    expect(commands[commands.length - 1]?.commandId).toBe('command-11');
    expect(commands.map((entry) => entry.commandId)).not.toContain('command-0');
  });

  it('snapshots completed command events instead of retaining the caller array', async () => {
    const events: PortalEventEnvelope[] = [
      {
        type: 'portal.command.completed',
        eventId: 'command-completed',
        occurredAt: '2026-09-05T00:00:00.000Z',
        payload: { commandId: 'command-1' },
      },
    ];

    await persistCompletedPortalCommand({
      commandId: 'command-1',
      sequence: 1,
      events,
    });
    events.push({
      type: 'portal.pipeline.event',
      eventId: 'late-pipeline-event',
      occurredAt: '2026-09-05T00:00:01.000Z',
      payload: { filler: 'late event must not mutate the receipt' },
    });

    const state = await readPortalStateStore();
    expect(state.completedCommands?.[0]?.events).toHaveLength(1);
    expect(state.completedCommands?.[0]?.events[0]?.eventId).toBe(
      'command-completed',
    );
  });

  it('byte-caps the outbox on the in-memory write path, keeping newest events', async () => {
    // Same rationale as above: the session manager trims before persisting,
    // but the store must hold its own byte bound between disk loads.
    const megabyte = 'x'.repeat(1024 * 1024);
    const events: PortalEventEnvelope[] = Array.from(
      { length: 24 },
      (_, index) => ({
        type: 'portal.state.snapshot',
        eventId: `write-snap-${String(index)}`,
        occurredAt: '2026-09-05T00:00:00.000Z',
        payload: { filler: megabyte },
      }),
    );
    await persistPortalEventOutbox(events, new Map());

    const state = await readPortalStateStore();
    const outbox = state.eventOutbox ?? [];
    const totalBytes = outbox.reduce(
      (sum, event) => sum + portalEventByteLength(event),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(PORTAL_OUTBOX_MAX_BYTES);
    expect(outbox[outbox.length - 1]?.eventId).toBe('write-snap-23');
    expect(outbox.map((event) => event.eventId)).not.toContain('write-snap-0');
  });

  it('recovers with fresh state instead of parsing a pathologically oversized store file', async () => {
    // The 289MB incident file must never reach JSON.parse: the parse itself
    // materializes the whole store in memory before normalize() can bound it.
    const filler = 'z'.repeat(PORTAL_STATE_FILE_MAX_BYTES + 1024);
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      `{"version":1,"clientDeviceId":"device-1","eventOutbox":[],"filler":"${filler}"}`,
      'utf8',
    );

    const state = await readPortalStateStore();
    expect(state.clientDeviceId).not.toBe('device-1');
    expect(state.eventOutbox ?? []).toHaveLength(0);
  });

  it('emits dropped-range resync markers when the read-path byte cap drops stamped events', async () => {
    const counters = new Map<string, number>();
    const megabyte = 'x'.repeat(1024 * 1024);
    const events = Array.from({ length: 24 }, (_, i) =>
      stampPortalEventRouting(
        {
          type: 'portal.chat.event',
          eventId: `chat-${String(i)}`,
          occurredAt: '2026-08-17T00:00:00.000Z',
          payload: {
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            filler: megabyte,
          },
        },
        counters,
      ),
    );
    await writeFile(
      path.join(userDataPath, 'portal-state.json'),
      JSON.stringify({
        version: 1,
        clientDeviceId: 'device-1',
        eventOutbox: events,
        routingSequenceCounters: Object.fromEntries(counters),
      }),
      'utf8',
    );

    const state = await readPortalStateStore();
    const outbox = state.eventOutbox ?? [];
    expect(outbox.length).toBeLessThan(24);
    // Dropped stamped events must leave a resync marker so the receiver knows
    // the lane has a gap, same contract as the live trim.
    expect(
      outbox.some((event) => String(event.type) === 'portal.events.dropped'),
    ).toBe(true);
  });
});
