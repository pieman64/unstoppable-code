import type { SessionDiagnosticRecord } from '../observability/service';
import type * as ChatWaitDiagnostics from '../observability/chat-wait-diagnostics';
import {
  GENERIC_MUTATION_PHASE,
  runWithChatWaitOperation,
  startChatWaitOperation,
  withinChatWaitPhase,
} from '../observability/chat-wait-diagnostics';

/** A module graph with an unspent record budget. */
async function freshDiagnostics(): Promise<typeof ChatWaitDiagnostics> {
  let loaded: typeof ChatWaitDiagnostics | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = await import('../observability/chat-wait-diagnostics');
  });
  if (!loaded) throw new Error('chat wait diagnostics did not load');
  return loaded;
}

function phasesOf(
  records: SessionDiagnosticRecord[],
  operationId: string,
): Array<[string | undefined, string | undefined]> {
  return records
    .filter((record) => record.waitOperationId === operationId)
    .map((record) => [record.waitPhase, record.waitOutcome]);
}

/** Every admitted opening record has its terminal record and the end. */
function expectPairedTerminals(records: SessionDiagnosticRecord[]): void {
  const operationIds = new Set(records.map((record) => record.waitOperationId));
  for (const operationId of operationIds) {
    if (!operationId) continue;
    const own = records.filter(
      (record) => record.waitOperationId === operationId,
    );
    for (const opening of own.filter(
      (record) => record.waitOutcome === 'stalled',
    )) {
      const closes = own.filter(
        (record) =>
          record.waitPhase === opening.waitPhase &&
          record.waitStartedAtMs === opening.waitStartedAtMs &&
          record.waitOutcome !== 'stalled',
      );
      expect(closes).toHaveLength(1);
    }
    expect(
      own.filter((record) => record.waitPhase === 'recovery_released'),
    ).toHaveLength(
      own.filter((record) => record.waitPhase === 'recovery_acquired').length,
    );
    if (
      own.some(
        (record) =>
          record.waitOutcome === 'stalled' ||
          record.waitPhase === 'recovery_acquired',
      )
    )
      expect(own.filter((record) => record.waitPhase === 'end')).toHaveLength(
        1,
      );
  }
}

describe('chat wait diagnostics', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps queue wait, phase duration and inventory reads separate', () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'watcher.setup',
      scope: { projectId: 'project-1', chatId: 'chat-1' },
      queueDepth: 2,
      recordEnd: true,
      record: (record) => records.push(record),
    });
    wait.phase('queue_wait');
    jest.advanceTimersByTime(1_200);
    wait.phase('authorization');
    wait.noteProjectInventoryCall();
    wait.noteProjectInventoryCall();
    jest.advanceTimersByTime(1_500);
    wait.finish('completed');

    expect(records).toContainEqual(
      expect.objectContaining({
        waitOperation: 'watcher.setup',
        waitPhase: 'queue_wait',
        waitOutcome: 'stalled',
        waitElapsedMs: 1_000,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        waitOperation: 'watcher.setup',
        waitPhase: 'authorization',
        waitOutcome: 'stalled',
        waitElapsedMs: 1_000,
      }),
    );
    expect(records.at(-1)).toMatchObject({
      waitPhase: 'end',
      waitProjectInventoryCalls: 2,
      waitPhaseDurationsMs: {
        queue_wait: 1_200,
        authorization: 1_500,
      },
    });
  });

  it('names a late-found owner only for an unowned operation', () => {
    const records: SessionDiagnosticRecord[] = [];
    const start = (scope: {
      chatId?: string;
    }): ChatWaitDiagnostics.ChatWaitOperation =>
      startChatWaitOperation({
        name: 'watcher.mark_delivered',
        scope,
        queueDepth: 1,
        recordEnd: true,
        record: (record) => records.push(record),
      });
    const unowned = start({});
    unowned.phase('queue_wait');
    unowned.attributeOwner({ chatId: 'owner-chat' });
    // A later lookup never replaces the owner it found.
    unowned.attributeOwner({ chatId: 'other-chat' });
    jest.advanceTimersByTime(1_000);
    unowned.finish('completed');
    const owned = start({ chatId: 'known-chat' });
    owned.attributeOwner({ chatId: 'other-chat' });
    owned.finish('completed');

    expect(records.map((record) => [record.waitPhase, record.chatId])).toEqual([
      // The queue wait stays open: attribution never closes a phase.
      ['queue_wait', 'owner-chat'],
      ['queue_wait', 'owner-chat'],
      ['end', 'owner-chat'],
      ['end', 'known-chat'],
    ]);
    expect(records[0]).toMatchObject({ waitOutcome: 'stalled' });
  });

  it('names an Orchestrator bot task in the top-level IDs that worktree purges match', () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'watcher.canonical_terminal',
      scope: { botId: 'app_advisor', taskId: 'bot-task', chatId: 'bot-chat' },
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase('storage');
    jest.advanceTimersByTime(1_000);

    expect(records).toEqual([
      expect.objectContaining({
        waitPhase: 'storage',
        waitOutcome: 'stalled',
        projectId: 'app-advisor',
        worktreeId: 'bot-task',
        chatId: 'bot-chat',
        sessionKey: 'app_advisor/bot-task/bot-chat',
      }),
    ]);
    wait.finish('completed');
  });

  it('caps diagnostic records for a burst of watcher mutations', () => {
    const records: SessionDiagnosticRecord[] = [];
    for (let index = 0; index < 600; index += 1) {
      const wait = startChatWaitOperation({
        name: 'watcher.update',
        scope: {},
        queueDepth: 0,
        bounded: true,
        recordEnd: true,
        record: (record) => records.push(record),
      });
      wait.finish('completed');
    }
    const held = startChatWaitOperation({
      name: 'watcher.held',
      scope: {},
      queueDepth: 1,
      bounded: true,
      record: (record) => records.push(record),
    });
    held.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    expect(records).toContainEqual(
      expect.objectContaining({
        waitOperation: 'watcher.held',
        waitPhase: 'queue_wait',
        waitOutcome: 'stalled',
      }),
    );
    held.finish('released');
    expect(records.length).toBeLessThanOrEqual(512);
  });

  it('closes and ends an admitted stall after routine records run out', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    for (let index = 0; index < 400; index += 1) {
      diagnostics
        .startChatWaitOperation({
          name: 'watcher.update',
          scope: {},
          queueDepth: 0,
          bounded: true,
          recordEnd: true,
          record,
        })
        .finish('completed');
    }
    const routineRecords = records.length;
    expect(routineRecords).toBeLessThan(400);

    const wait = diagnostics.startChatWaitOperation({
      name: 'watcher.mark_delivered',
      scope: {},
      queueDepth: 0,
      bounded: true,
      recordEnd: true,
      record,
    });
    wait.phase(diagnostics.GENERIC_MUTATION_PHASE);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = diagnostics.runWithChatWaitOperation(wait, () =>
      diagnostics.withinChatWaitPhase('storage_read', () => held),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    release();
    await read;
    wait.finish('completed');

    expect(phasesOf(records, wait.id)).toEqual([
      ['storage_read', 'stalled'],
      ['storage_read', 'completed'],
      ['end', 'completed'],
    ]);
    expect(records).toHaveLength(routineRecords + 3);
  });

  it('admits concurrent stalls only with room for their terminal records', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    const waits = Array.from({ length: 200 }, () =>
      diagnostics.startChatWaitOperation({
        name: 'watcher.update',
        scope: {},
        queueDepth: 0,
        bounded: true,
        record,
      }),
    );
    for (const wait of waits) wait.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    for (const wait of waits) wait.phase('storage');
    jest.advanceTimersByTime(1_000);
    const stalled = records.filter(
      (entry) => entry.waitOutcome === 'stalled',
    ).length;
    expect(stalled).toBeGreaterThan(0);
    for (const wait of waits) wait.finish('completed');

    expectPairedTerminals(records);
    expect(records.length).toBeLessThanOrEqual(512);
    // Each admitted stall is charged with at least its own close.
    expect(stalled).toBeLessThanOrEqual(64);
  });

  it('keeps every window within the cap when reserved terminals land late', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    const start = (): ChatWaitDiagnostics.ChatWaitOperation =>
      diagnostics.startChatWaitOperation({
        name: 'watcher.update',
        scope: {},
        queueDepth: 0,
        bounded: true,
        record,
      });
    const earlier = Array.from({ length: 60 }, start);
    for (const wait of earlier) wait.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    const earlierStalls = records.length;
    expect(earlierStalls).toBeGreaterThan(0);

    jest.advanceTimersByTime(60_000);
    const windowStart = records.length;
    const later = Array.from({ length: 60 }, start);
    for (const wait of later) wait.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    for (const wait of [...earlier, ...later]) wait.finish('completed');

    expectPairedTerminals(records);
    const windowRecords = records.slice(windowStart);
    expect(windowRecords.length).toBeLessThanOrEqual(512);
    // Each operation has one phase, so an operation with a stall emits only
    // paired records. The earlier stalls' closes and ends land in this window
    // on their earlier reservation and still count against its allowance.
    const stalledIds = new Set(
      records
        .filter((entry) => entry.waitOutcome === 'stalled')
        .map((entry) => entry.waitOperationId),
    );
    expect(
      windowRecords.filter((entry) => stalledIds.has(entry.waitOperationId))
        .length,
    ).toBeLessThanOrEqual(128);
    expect(
      windowRecords.filter((entry) => entry.waitOutcome === 'stalled').length,
    ).toBeGreaterThan(0);
  });

  it('frees the reservations of finished operations for later windows', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    const start = (): ChatWaitDiagnostics.ChatWaitOperation =>
      diagnostics.startChatWaitOperation({
        name: 'watcher.update',
        scope: {},
        queueDepth: 0,
        bounded: true,
        record,
      });
    const recovered = start();
    recovered.phase('queue_wait');
    recovered.claim();
    jest.advanceTimersByTime(1_000);
    recovered.finish('released');
    expect(phasesOf(records, recovered.id)).toEqual([
      ['recovery_acquired', 'completed'],
      ['queue_wait', 'stalled'],
      ['queue_wait', 'released'],
      ['recovery_released', 'released'],
      ['end', 'released'],
    ]);

    const admittedPerWindow: number[] = [];
    for (let window = 0; window < 3; window += 1) {
      const windowStart = records.length;
      const waits = Array.from({ length: 50 }, start);
      for (const wait of waits) wait.phase('queue_wait');
      jest.advanceTimersByTime(1_000);
      for (const wait of waits) wait.finish('completed');
      admittedPerWindow.push(
        records
          .slice(windowStart)
          .filter((entry) => entry.waitOutcome === 'stalled').length,
      );
      jest.advanceTimersByTime(60_000);
    }
    expectPairedTerminals(records);
    // A stall costs 3 paired records; the recovered operation spent 5 of the
    // first window's 128, and nothing stays reserved once operations finish.
    expect(admittedPerWindow).toEqual([41, 42, 42]);
  });

  it('pairs an admitted recovery claim with its release and end', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    for (let index = 0; index < 400; index += 1) {
      diagnostics
        .startChatWaitOperation({
          name: 'watcher.update',
          scope: {},
          queueDepth: 0,
          bounded: true,
          recordEnd: true,
          record,
        })
        .finish('completed');
    }
    const wait = diagnostics.startChatWaitOperation({
      name: 'chat_queue.recover',
      scope: {},
      queueDepth: 0,
      bounded: true,
      stallTimer: false,
      record,
    });
    wait.claim();
    wait.finish('released');
    expect(phasesOf(records, wait.id)).toEqual([
      ['recovery_acquired', 'completed'],
      ['recovery_released', 'released'],
      ['end', 'released'],
    ]);
  });

  it('never records the release of a recovery claim it refused', async () => {
    const diagnostics = await freshDiagnostics();
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    const held = Array.from({ length: 64 }, () =>
      diagnostics.startChatWaitOperation({
        name: 'watcher.update',
        scope: {},
        queueDepth: 0,
        bounded: true,
        record,
      }),
    );
    for (const wait of held) wait.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    // 42 stalls reserve 126 of the 128 paired records; a claim needs 3.
    expect(
      records.filter((entry) => entry.waitOutcome === 'stalled'),
    ).toHaveLength(42);

    const wait = diagnostics.startChatWaitOperation({
      name: 'chat_queue.recover',
      scope: {},
      queueDepth: 0,
      bounded: true,
      stallTimer: false,
      record,
    });
    wait.claim();
    wait.finish('released');
    expect(phasesOf(records, wait.id)).toEqual([['end', 'released']]);

    for (const heldWait of held) heldWait.finish('completed');
    expectPairedTerminals(records);
  });

  it('names the queue owner only while the operation waits in that queue', () => {
    const records: SessionDiagnosticRecord[] = [];
    const holder = { id: 'chat-wait-holder', name: 'watcher.holder' };
    const wait = startChatWaitOperation({
      name: 'watcher.delete_watcher',
      scope: {},
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase('storage');
    wait.enterQueue(1, () => holder);
    jest.advanceTimersByTime(1_000);
    wait.phase('storage');
    wait.phase('queue_wait');
    jest.advanceTimersByTime(1_000);
    wait.finish('completed');

    const queueRecords = records.filter(
      (record) => record.waitPhase === 'queue_wait',
    );
    expect(queueRecords.map((record) => record.waitQueueDepth)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(queueRecords.slice(0, 2)).toEqual([
      expect.objectContaining({
        waitOutcome: 'stalled',
        waitQueueOwnerOperationId: 'chat-wait-holder',
        waitQueueOwnerOperation: 'watcher.holder',
      }),
      expect.objectContaining({
        waitOutcome: 'completed',
        waitQueueOwnerOperationId: 'chat-wait-holder',
      }),
    ]);
    for (const record of queueRecords.slice(2))
      expect(record).not.toHaveProperty('waitQueueOwnerOperationId');
  });

  it('records the end of a fast failure but not of a fast completion', () => {
    const records: SessionDiagnosticRecord[] = [];
    const record = (entry: SessionDiagnosticRecord): number =>
      records.push(entry);
    startChatWaitOperation({
      name: 'chat_state.publish_commit',
      scope: {},
      queueDepth: 0,
      record,
    }).finish('completed');
    expect(records).toEqual([]);
    const failed = startChatWaitOperation({
      name: 'chat_state.publish_commit',
      scope: {},
      queueDepth: 0,
      record,
    });
    failed.phase('required_materialization');
    failed.finish('failed');
    expect(records).toEqual([
      expect.objectContaining({
        waitOperationId: failed.id,
        waitPhase: 'end',
        waitOutcome: 'failed',
      }),
    ]);
    expect(records[0]?.waitPhaseDurationsMs).toHaveProperty(
      'required_materialization',
      0,
    );
  });

  it('closes only the failed phase as failed', () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'chat_state.publish_commit',
      scope: {},
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase('required_materialization');
    jest.advanceTimersByTime(1_200);
    wait.failPhase();
    wait.phase('subscriber_publication');
    jest.advanceTimersByTime(1_200);
    wait.finish('completed');
    expect(
      records
        .filter((record) => record.waitOutcome !== 'stalled')
        .map((record) => [record.waitPhase, record.waitOutcome]),
    ).toEqual([
      ['required_materialization', 'failed'],
      ['subscriber_publication', 'completed'],
      ['end', 'completed'],
    ]);
  });

  it('attributes a dependency await only inside the generic mutation phase', async () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'watcher.mark_delivered',
      scope: {},
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase(GENERIC_MUTATION_PHASE);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = runWithChatWaitOperation(wait, () =>
      withinChatWaitPhase('storage_read', () => held),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(records).toEqual([
      expect.objectContaining({
        waitPhase: 'storage_read',
        waitOutcome: 'stalled',
        waitElapsedMs: 1_000,
      }),
    ]);
    release();
    await read;
    expect(wait.currentPhase).toBe(GENERIC_MUTATION_PHASE);
    wait.phase('authorization');
    await runWithChatWaitOperation(wait, () =>
      withinChatWaitPhase('persistence', () => Promise.resolve()),
    );
    expect(wait.currentPhase).toBe('authorization');
    await expect(
      withinChatWaitPhase('persistence', () => Promise.resolve('outside')),
    ).resolves.toBe('outside');
    wait.finish('completed');
    expect(records.at(-1)?.waitPhaseDurationsMs).toEqual({
      start: 0,
      mutation: 0,
      storage_read: 1_000,
      authorization: 0,
    });
  });

  it('closes a rejected dependency await as failed', async () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'watcher.mark_delivered',
      scope: {},
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase(GENERIC_MUTATION_PHASE);
    let reject: (error: Error) => void = () => undefined;
    const held = new Promise<void>((_resolve, rejectHeld) => {
      reject = rejectHeld;
    });
    const read = runWithChatWaitOperation(wait, () =>
      withinChatWaitPhase('storage_read', () => held),
    );
    const settled = read.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1_100);
    const failure = new Error('read failed');
    reject(failure);
    await expect(settled).resolves.toBe(failure);
    expect(wait.currentPhase).toBe(GENERIC_MUTATION_PHASE);
    // The caller handled the rejection; the failure stays with storage_read.
    jest.advanceTimersByTime(1_200);
    wait.finish('completed');

    expect(
      records.map((record) => [record.waitPhase, record.waitOutcome]),
    ).toEqual([
      ['storage_read', 'stalled'],
      ['storage_read', 'failed'],
      ['mutation', 'stalled'],
      ['mutation', 'completed'],
      ['end', 'completed'],
    ]);
  });

  it('keeps a rejected await failure out of a phase the body renamed', async () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'watcher.mark_delivered',
      scope: {},
      queueDepth: 0,
      record: (record) => records.push(record),
    });
    wait.phase(GENERIC_MUTATION_PHASE);
    const read = runWithChatWaitOperation(wait, () =>
      withinChatWaitPhase('storage_read', () => {
        wait.phase('authorization');
        return Promise.reject(new Error('denied'));
      }),
    );
    await expect(read).rejects.toThrow('denied');
    expect(wait.currentPhase).toBe('authorization');
    jest.advanceTimersByTime(1_200);
    wait.finish('completed');
    expect(
      records
        .filter((record) => record.waitOutcome !== 'stalled')
        .map((record) => [record.waitPhase, record.waitOutcome]),
    ).toEqual([
      ['authorization', 'completed'],
      ['end', 'completed'],
    ]);
  });

  it('reports the awaited phase at recovery acquisition and release', () => {
    const records: SessionDiagnosticRecord[] = [];
    const wait = startChatWaitOperation({
      name: 'chat_queue.recover',
      scope: { projectId: 'project-1', chatId: 'chat-1' },
      queueDepth: 0,
      ownerTokenId: 'owner-1',
      record: (record) => records.push(record),
    });
    wait.phase('queue_persistence');
    jest.advanceTimersByTime(10_000);
    wait.claim();
    wait.phase('provider_events');
    jest.advanceTimersByTime(500);
    wait.finish('released');

    expect(records).toContainEqual(
      expect.objectContaining({
        waitPhase: 'recovery_acquired',
        waitAwaitingPhase: 'queue_persistence',
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        waitPhase: 'recovery_released',
        waitAwaitingPhase: 'provider_events',
        waitRecoveryElapsedMs: 500,
      }),
    );
    expect(records.find((record) => record.waitPhase === 'end')).toMatchObject({
      waitElapsedMs: 10_500,
    });
  });
});
