/**
 * Delta-journal diagnostics are scope-specific session events.
 *
 * A scope whose journal holds a record from a newer journal version is
 * refused: the repository records a content-free
 * `delta_journal_newer_format` storage diagnostic. A journal
 * ending in invalid incomplete bytes records `delta_journal_torn_tail_dropped`
 * when recovery drops them. `ChatStateService` turns every
 * one into a `chat_storage_diagnostic` session record keyed by the scope,
 * with no chat id or content, and nothing goes to the global app-events
 * stream.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELTA_JOURNAL_FILE_NAME,
  FRAME_HEADER_BYTES,
} from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalDiagnostic,
} from '../lib/chat-delta-journal/writer';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { setChatTabsRequiredDurabilityObserver } from '../lib/chat-tabs';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  ChatStateService,
  storageSessionDiagnostic,
} from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { createV2Scope, message } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
  streaming,
  text,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  eventually,
  gateJournalSyncs,
} from './helpers/chat-delta-journal-sync-gate';

const mockAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, jest.Mock> => ({
    recordSessionDiagnostic: mockAppDiagnostic,
    recordAppDiagnostic: mockAppDiagnostic,
    observeSteeringInput: jest.fn(),
  }),
}));

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

describe('delta journal diagnostics', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-diagnostics-'));
  });

  afterEach(async () => {
    setChatTabsRequiredDurabilityObserver(null);
    jest.useRealTimers();
    jest.restoreAllMocks();
    await drainOpenRepositories();
    mockAppDiagnostic.mockReset();

    await rm(root, { recursive: true, force: true });
  });

  /** Append a valid frame whose record is from a newer journal version. */
  async function appendNewerRecord(journalPath: string): Promise<void> {
    const journal = await readDeltaJournal(
      join(root, 'chat-storage-v2', 'scope'),
      'scope',
    );
    const payload = Buffer.from(
      JSON.stringify({
        type: 'commit',
        v: 2,
        prev: journal.lastDigest,
        fromRevision: journal.lastRevision,
        toRevision: journal.lastRevision + 1,
      }),
      'utf8',
    );
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.write('CDJ1', 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    createHash('sha256').update(payload).digest().copy(header, 8);
    await appendFile(journalPath, Buffer.concat([header, payload]));
  }

  /** A version 3 scope with one record after its checkpoint. */
  async function journaledScope(): Promise<string> {
    const store = await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'secret prompt text', 'user')] },
    ]);
    await promoteToDeltaJournal(store);
    const writer = await ChatDeltaJournalWriter.open(store);
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: 0,
      next: {
        live: { ...current.live, revision: 1 },
        archive: { ...current.archive, revision: 1 },
        recovery: { ...current.recovery, mutationIds: ['a'] },
      },
      writes: [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [message('a', 'secret reply text')],
        },
      ],
      mutationIds: ['a'],
    });
    return join(store.directory, DELTA_JOURNAL_FILE_NAME);
  }

  function repository(): ChatStateV2Repository {
    return drainAfterTest(
      new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(root, 'chats', 'scope.json'),
          archives: join(root, 'chat-archives', 'scope.json'),
          journal: join(root, 'chat-journals', 'scope.jsonl'),
        }),
      }),
    );
  }

  /** Captures materialization retries so none runs after the test ends. */
  function heldRetries(): {
    retries: Array<() => void>;
    schedule: (callback: () => void) => ReturnType<typeof setTimeout>;
  } {
    const retries: Array<() => void> = [];
    return {
      retries,
      schedule: (callback): ReturnType<typeof setTimeout> => {
        retries.push(callback);
        const handle = setTimeout(() => undefined, 0);
        clearTimeout(handle);
        return handle;
      },
    };
  }

  it('attributes a durable commit waiting for required materialization before subscriber publication', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'SECRET-TRANSCRIPT', 'user')] },
    ]);
    const records: SessionDiagnosticRecord[] = [];
    const store = repository();
    const service = new ChatStateService({
      repository: store,
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    let published = 0;
    service.subscribe(() => {
      published += 1;
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let materializationEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      materializationEntered = resolve;
    });
    setChatTabsRequiredDurabilityObserver(() => {
      materializationEntered();
      return held;
    });
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    try {
      const transaction = store.transact(
        SCOPE,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'automation' },
      );
      await entered;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(published).toBe(0);
      const stalled = records.find(
        (record) =>
          record.kind === 'chat_wait_phase' &&
          record.waitOperation === 'chat_state.publish_commit' &&
          record.waitPhase === 'required_materialization' &&
          record.waitOutcome === 'stalled',
      );
      expect(stalled).toMatchObject({
        waitScope: SCOPE,
        waitElapsedMs: 1_000,
      });
      expect(typeof stalled?.waitOperationId).toBe('string');
      expect(typeof stalled?.waitStartedAtMs).toBe('number');
      expect(JSON.stringify(records)).not.toContain('SECRET-TRANSCRIPT');
      release();
      await transaction;
      expect(published).toBe(1);
      const completed = records.find(
        (record) =>
          record.kind === 'chat_wait_phase' &&
          record.waitOperationId === stalled?.waitOperationId &&
          record.waitPhase === 'end',
      );
      expect(completed?.waitOutcome).toBe('completed');
      expect(
        typeof completed?.waitPhaseDurationsMs?.required_materialization,
      ).toBe('number');
      expect(
        typeof completed?.waitPhaseDurationsMs?.subscriber_publication,
      ).toBe('number');
    } finally {
      release();
      setChatTabsRequiredDurabilityObserver(null);
      jest.useRealTimers();
      await service.drain();
    }
  });

  it('attributes a commit held at required durability, and the commit queued behind it, before publication', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'SECRET-TRANSCRIPT', 'user')] },
    ]);
    const records: SessionDiagnosticRecord[] = [];
    const store = repository();
    const service = new ChatStateService({
      repository: store,
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    let published = 0;
    service.subscribe(() => {
      published += 1;
    });
    const stream = (
      id: string,
      mutations: ChatCoreMutation[],
    ): Promise<unknown> =>
      store.transact(SCOPE, mutations, {
        source: 'provider',
        mutationId: id,
        chatIds: ['chat'],
      });
    const publishWaits = (): SessionDiagnosticRecord[] =>
      records.filter(
        (record) =>
          record.kind === 'chat_wait_phase' &&
          record.waitOperation === 'chat_state.publish_commit',
      );
    const syncs = gateJournalSyncs();
    try {
      // A turn in progress keeps the later rows journaled, so each commit's
      // publication waits for its group-committed batch.
      await stream('turn-start', [
        streaming('chat', 'p1'),
        upsert('chat', text('p1', 'go', 'user')),
      ]);
      records.length = 0;
      published = 0;
      syncs.hold();
      const first = stream('a', [
        upsert('chat', text('row-a', 'SECRET-TRANSCRIPT a')),
      ]);
      const second = stream('b', [
        upsert('chat', text('row-b', 'SECRET-TRANSCRIPT b')),
      ]);
      const stalled = (phase: string): SessionDiagnosticRecord | undefined =>
        publishWaits().find(
          (record) =>
            record.waitPhase === phase && record.waitOutcome === 'stalled',
        );
      await eventually(
        () =>
          stalled('required_durability') !== undefined &&
          stalled('queue_wait') !== undefined,
        'a held durability stall and the publication queued behind it',
      );
      expect(published).toBe(0);
      const durability = stalled('required_durability');
      const queued = stalled('queue_wait');
      expect(durability).toMatchObject({
        waitScope: SCOPE,
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        waitQueueDepth: 0,
      });
      // Real timers: the 1s stall timer can fire just before 1s of the
      // monotonic clock has elapsed.
      const stallMs = 990;
      expect(durability?.waitElapsedMs).toBeGreaterThanOrEqual(stallMs);
      // The queued commit names the publication it waits behind.
      expect(queued).toMatchObject({
        waitScope: SCOPE,
        waitQueueDepth: 1,
        waitQueueOwnerOperationId: durability?.waitOperationId,
        waitQueueOwnerOperation: 'chat_state.publish_commit',
      });
      expect(queued?.waitOperationId).not.toBe(durability?.waitOperationId);
      expect(queued?.waitElapsedMs).toBeGreaterThanOrEqual(stallMs);

      syncs.release();
      await Promise.all([first, second]);
      expect(published).toBe(2);
      const ended = (
        operationId: string | undefined,
      ): SessionDiagnosticRecord | undefined =>
        publishWaits().find(
          (record) =>
            record.waitOperationId === operationId &&
            record.waitPhase === 'end',
        );
      const held = ended(durability?.waitOperationId);
      const behind = ended(queued?.waitOperationId);
      expect(held?.waitOutcome).toBe('completed');
      expect(behind?.waitOutcome).toBe('completed');
      // Queue wait and the durability phase are reported separately, then the
      // publication stages that follow them.
      for (const durations of [
        held?.waitPhaseDurationsMs,
        behind?.waitPhaseDurationsMs,
      ])
        for (const phase of [
          'queue_wait',
          'required_durability',
          'required_materialization',
          'subscriber_publication',
        ])
          expect(typeof durations?.[phase]).toBe('number');
      expect(
        held?.waitPhaseDurationsMs?.required_durability,
      ).toBeGreaterThanOrEqual(stallMs);
      expect(behind?.waitPhaseDurationsMs?.queue_wait).toBeGreaterThanOrEqual(
        stallMs,
      );
      expect(JSON.stringify(records)).not.toContain('SECRET-TRANSCRIPT');
    } finally {
      syncs.release();
      await service.drain();
    }
  });

  it('records a commit whose durable batch fails as a failed publication', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'secret', 'user')] },
    ]);
    const records: SessionDiagnosticRecord[] = [];
    const store = repository();
    const service = new ChatStateService({
      repository: store,
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    let published = 0;
    service.subscribe(() => {
      published += 1;
    });
    const syncs = gateJournalSyncs();
    try {
      await store.transact(
        SCOPE,
        [streaming('chat', 'p1'), upsert('chat', text('p1', 'go', 'user'))],
        { source: 'provider', mutationId: 'turn-start', chatIds: ['chat'] },
      );
      records.length = 0;
      published = 0;
      syncs.failSync(1, new Error('disk unavailable'));
      await expect(
        store.transact(SCOPE, [upsert('chat', text('row-a', 'streamed a'))], {
          source: 'provider',
          mutationId: 'a',
          chatIds: ['chat'],
        }),
      ).rejects.toThrow();
      await eventually(
        () =>
          records.some(
            (record) =>
              record.waitOperation === 'chat_state.publish_commit' &&
              record.waitPhase === 'end',
          ),
        'the failed publication is recorded',
      );
      expect(published).toBe(0);
      const failed = records.find(
        (record) =>
          record.waitOperation === 'chat_state.publish_commit' &&
          record.waitPhase === 'end',
      );
      expect(failed).toMatchObject({ waitOutcome: 'failed', waitScope: SCOPE });
      expect(typeof failed?.waitPhaseDurationsMs?.required_durability).toBe(
        'number',
      );
    } finally {
      syncs.release();
      await service.drain();
    }
  });

  it('does not report required materialization as completed when its retry is pending', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'secret', 'user')] },
    ]);
    const records: SessionDiagnosticRecord[] = [];
    let resolvePublication = (): void => undefined;
    const publicationRecorded = new Promise<void>((resolve) => {
      resolvePublication = resolve;
    });
    const store = repository();
    const { retries, schedule } = heldRetries();
    const service = new ChatStateService({
      repository: store,
      schedule,
      recordDiagnostic: (record): void => {
        records.push(record);
        if (
          record.waitOperation === 'chat_state.publish_commit' &&
          record.waitPhase === 'end'
        )
          resolvePublication();
      },
    });
    let published = 0;
    service.subscribe(() => {
      published += 1;
    });
    setChatTabsRequiredDurabilityObserver(() =>
      Promise.reject(new Error('materialization unavailable')),
    );
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    try {
      await store.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat' }], {
        source: 'automation',
      });
      await publicationRecorded;
      expect(published).toBe(1);
      expect(retries).toHaveLength(1);
      expect(
        records.find(
          (record) =>
            record.waitOperation === 'chat_state.publish_commit' &&
            record.waitPhase === 'end',
        )?.waitOutcome,
      ).toBe('failed');
    } finally {
      setChatTabsRequiredDurabilityObserver(null);
      jest.useRealTimers();
      await service.drain();
    }
  });

  it('closes a stalled required materialization as failed when it rejects', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'secret', 'user')] },
    ]);
    const records: SessionDiagnosticRecord[] = [];
    const store = repository();
    const { retries, schedule } = heldRetries();
    const service = new ChatStateService({
      repository: store,
      schedule,
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    let reject: (error: Error) => void = () => undefined;
    let materializationEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      materializationEntered = resolve;
    });
    setChatTabsRequiredDurabilityObserver(() => {
      materializationEntered();
      return new Promise<void>((_resolve, rejectWrite) => {
        reject = rejectWrite;
      });
    });
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    try {
      const transaction = store.transact(
        SCOPE,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'automation' },
      );
      await entered;
      await jest.advanceTimersByTimeAsync(1_000);
      reject(new Error('materialization unavailable'));
      await transaction;
      expect(retries).toHaveLength(1);
      const materialization = records.filter(
        (record) =>
          record.waitOperation === 'chat_state.publish_commit' &&
          record.waitPhase === 'required_materialization',
      );
      expect(materialization.map((record) => record.waitOutcome)).toEqual([
        'stalled',
        'failed',
      ]);
      expect(
        records.find(
          (record) =>
            record.waitOperation === 'chat_state.publish_commit' &&
            record.waitPhase === 'end',
        )?.waitOutcome,
      ).toBe('failed');
    } finally {
      setChatTabsRequiredDurabilityObserver(null);
      jest.useRealTimers();
      await service.drain();
    }
  });

  it('records the refusal of a newer journal version once per load attempt', async () => {
    const journal = await journaledScope();
    await appendNewerRecord(journal);
    const target = repository();
    await expect(target.getState(SCOPE)).rejects.toThrow('newer');
    await expect(target.getRevision(SCOPE)).rejects.toThrow('newer');
    // The sticky load error itself names the cause.
    const [loadError] = target.getDiagnostics(SCOPE);
    expect(loadError?.kind).toBe('unrecoverable_journal');
    expect(loadError?.message).toContain('newer');
    expect(target.getStorageDiagnostics(SCOPE)).toEqual([
      expect.objectContaining({
        kind: 'delta_journal_newer_format',
        storageAuthority: 'v2',
        ...SCOPE,
        // The journal's newer record is unreadable, so no summary.
        journalBytes: 0,
      }),
    ]);
  });

  it('records an unacknowledged journal tail with its size', async () => {
    const journal = await journaledScope();
    const verified = (await stat(journal)).size;
    await appendFile(journal, Buffer.from('CDJ1 torn'));
    const target = repository();
    // Recovery drops the unacknowledged tail and keeps journal authority.
    await target.getState(SCOPE);
    expect(target.getStorageDiagnostics(SCOPE)).toEqual([
      expect.objectContaining({
        kind: 'delta_journal_torn_tail_dropped',
        ...SCOPE,
        journalBytes: verified,
        recordBytes: 9,
        recordCount: 1,
        journalTailReason: 'incomplete',
      }),
    ]);
    // An incomplete tail is truncated, never quarantined.
    expect(
      target
        .getStorageDiagnostics(SCOPE)
        .some((diagnostic) => 'journalQuarantineFile' in diagnostic),
    ).toBe(false);
  });

  it('records the refusal when the journal itself is missing', async () => {
    const journal = await journaledScope();
    await rm(journal);
    const target = repository();
    await expect(target.getState(SCOPE)).rejects.toThrow(
      'Delta journal is missing',
    );
    expect(target.getDiagnostics(SCOPE)[0]?.kind).toBe('unrecoverable_journal');
  });

  it('becomes content-free session events, never global app events', async () => {
    const journal = await journaledScope();
    // A complete header without a frame: a checksum mismatch.
    await appendFile(journal, Buffer.alloc(64));
    const records: SessionDiagnosticRecord[] = [];
    const target = new ChatStateService({
      repository: repository(),
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    await target.getState(SCOPE);
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'chat_storage_diagnostic',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: '',
        chatStorageKind: 'delta_journal_torn_tail_dropped',
        chatStorageRecordBytes: 64,
        chatStorageRecordCount: 1,
        chatStorageJournalTailReason: 'checksum_mismatch',
        chatStorageJournalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
      }),
    ]);
    const text = JSON.stringify(records);
    for (const secret of ['secret', '"chat"', 'm0'])
      expect(text).not.toContain(secret);
    expect(mockAppDiagnostic).not.toHaveBeenCalled();
    await target.drain();
  });

  it("forwards the writer's quarantine file name, and only its base name", async () => {
    const journal = await journaledScope();
    const garbled = Buffer.alloc(64, 0x41);
    await appendFile(journal, garbled);
    const diagnostics: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(new ChatStorageV2(root, 'scope'), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(diagnostics).toHaveLength(1);
    const record = storageSessionDiagnostic({
      ...diagnostics[0],
      ...SCOPE,
      occurredAt: '2026-10-01T00:00:00.000Z',
      storageAuthority: 'v2',
    });
    expect(record).toEqual(
      expect.objectContaining({
        kind: 'chat_storage_diagnostic',
        chatId: '',
        chatStorageKind: 'delta_journal_torn_tail_dropped',
        chatStorageRecordBytes: 64,
        chatStorageJournalTailReason: 'checksum_mismatch',
        chatStorageJournalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
      }),
    );
    expect(JSON.stringify(record)).not.toContain(root);
  });

  it('forwards the category of an artifact maintenance failure', () => {
    expect(
      storageSessionDiagnostic({
        kind: 'artifact_maintenance_failed',
        ...SCOPE,
        occurredAt: '2026-10-01T00:00:00.000Z',
        storageAuthority: 'v2',
        journalBytes: 0,
        maintenanceReason: 'invalid_sidecar',
      }),
    ).toEqual(
      expect.objectContaining({
        chatStorageKind: 'artifact_maintenance_failed',
        chatStorageMaintenanceReason: 'invalid_sidecar',
      }),
    );
  });
});
