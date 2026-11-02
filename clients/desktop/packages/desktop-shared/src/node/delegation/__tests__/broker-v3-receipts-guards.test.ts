import { createHash, randomUUID } from 'node:crypto';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import type {
  AgentDelegationBrokerOptions,
  StoredDelegationControl,
  StoredDelegationLegacy,
} from '../broker';
import type { StoredDelegationV3 } from '../record-v3';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
} from './broker-harness';
import { routeFixture } from './fixtures';

interface StreamGuardFixture {
  readonly broker: ReturnType<typeof createBrokerHarness>['broker'];
  readonly runner: ReturnType<typeof createBrokerHarness>['runner'];
  readonly port: InMemoryDelegationTranscriptPort;
  readonly storage: MemoryDelegationStorage;
  readonly id: string;
}

async function createStreamFixture(
  options: Partial<AgentDelegationBrokerOptions> = {},
): Promise<StreamGuardFixture> {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const storage = new MemoryDelegationStorage();
  const harness = createBrokerHarness(
    {
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
      ...options,
    },
    storage,
  );
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected stream admission');
  await waitForLaunch(harness.runner, spawned.value.delegationId);
  return { ...harness, port, storage, id: spawned.value.delegationId };
}

function streamRecord(fixture: StreamGuardFixture): StoredDelegationV3 {
  const record = fixture.storage.records.get(fixture.id);
  if (!record || record.version !== 3)
    throw new Error('Expected a stored v3 record');
  return record;
}

async function emitTerminal(
  fixture: StreamGuardFixture,
  runGeneration: number,
  sequence = 1,
): Promise<void> {
  const sink = fixture.runner.sinks.get(fixture.id);
  if (!sink) throw new Error('Expected the runner event sink');
  await sink({
    delegationId: fixture.id,
    runGeneration,
    sequence,
    occurredAt: Date.now(),
    event: { type: 'terminal', status: 'completed', finalText: 'finished' },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) await flushBroker();
}

async function emitStarted(fixture: StreamGuardFixture): Promise<void> {
  const sink = fixture.runner.sinks.get(fixture.id);
  if (!sink) throw new Error('Expected the runner event sink');
  await sink({
    delegationId: fixture.id,
    runGeneration: 1,
    sequence: 1,
    occurredAt: Date.now(),
    event: {
      type: 'started',
      nativeSessionId: 'receipt-guard-native-session',
    },
  });
  await flushBroker();
}

async function waitForQueuedContinuation(
  fixture: StreamGuardFixture,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fixture.broker.inspect(rootParent, fixture.id)?.phase === 'queued')
      return;
    await flushBroker();
  }
  throw new Error('Expected the continuation to remain queued');
}

async function queueContinuation(fixture: StreamGuardFixture): Promise<void> {
  await emitStarted(fixture);
  await emitTerminal(fixture, 1, 2);
  const blocker = await fixture.broker.spawn(
    { ...rootParent, toolCallId: 'receipt-guard-blocker' },
    baseTask,
  );
  if (!blocker.ok) throw new Error('Expected queued blocker admission');
  await waitForLaunch(fixture.runner, blocker.value.delegationId);
  const accepted = await fixture.broker.manage(
    { ...rootParent, toolCallId: 'receipt-guard-follow-up' },
    {
      delegationId: fixture.id,
      operation: 'follow_up',
      message: 'Keep this continuation queued.',
    },
  );
  if (!accepted.ok) throw new Error('Expected follow-up acceptance');
  await waitForQueuedContinuation(fixture);
}

async function fillCompletedCommandWindow(
  fixture: StreamGuardFixture,
): Promise<void> {
  for (let index = 0; index < 64; index += 1) {
    const reply = await fixture.broker.manage(
      { ...rootParent, toolCallId: `receipt-guard-refusal-${index}` },
      {
        delegationId: fixture.id,
        operation: 'apply',
      },
    );
    expect(reply.ok).toBe(false);
  }
  expect(streamRecord(fixture).receipts.commandReceipts).toHaveLength(64);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function completedLegacySeed(): Promise<StoredDelegationLegacy> {
  const storage = new MemoryDelegationStorage();
  const resolveRoute: AgentDelegationBrokerOptions['resolveRoute'] = () =>
    Promise.resolve({
      ok: true,
      value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
    });
  const harness = createBrokerHarness({ resolveRoute }, storage);
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected legacy admission');
  const id = spawned.value.delegationId;
  await waitForLaunch(harness.runner, id);
  const sink = harness.runner.sinks.get(id);
  if (!sink) throw new Error('Expected the legacy runner event sink');
  await sink({
    delegationId: id,
    runGeneration: 1,
    sequence: 1,
    occurredAt: 1,
    event: { type: 'started', nativeSessionId: 'legacy-seed-native-session' },
  });
  await sink({
    delegationId: id,
    runGeneration: 1,
    sequence: 2,
    occurredAt: 2,
    event: { type: 'terminal', status: 'completed', finalText: 'first' },
  });
  const followUp = await harness.broker.manage(
    { ...rootParent, toolCallId: 'legacy-seed-follow-up' },
    { delegationId: id, operation: 'follow_up', message: 'One more run.' },
  );
  if (!followUp.ok) throw new Error('Expected legacy follow-up');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      harness.runner.starts.some(
        (start) => start.delegationId === id && start.runGeneration === 2,
      )
    )
      break;
    await flushBroker();
  }
  if (
    !harness.runner.starts.some(
      (start) => start.delegationId === id && start.runGeneration === 2,
    )
  )
    throw new Error('Expected the retained legacy follow-up run');
  await sink({
    delegationId: id,
    runGeneration: 2,
    sequence: 1,
    occurredAt: 2,
    event: {
      type: 'started',
      nativeSessionId: 'legacy-follow-up-native-session',
    },
  });
  await sink({
    delegationId: id,
    runGeneration: 2,
    sequence: 2,
    occurredAt: 3,
    event: { type: 'terminal', status: 'completed', finalText: 'second' },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) await flushBroker();
  const record = storage.records.get(id);
  if (!record || record.version === 3)
    throw new Error('Expected a retained legacy record');
  await harness.broker.close();
  return record;
}

function legacyHarness(
  record: StoredDelegationLegacy,
  options: Partial<AgentDelegationBrokerOptions> = {},
): ReturnType<typeof createBrokerHarness> {
  const storage = new MemoryDelegationStorage();
  storage.records.set(record.state.delegationId, record);
  return createBrokerHarness(options, storage);
}

function legacyControls(
  count: number,
): NonNullable<StoredDelegationLegacy['controls']> {
  const controls: StoredDelegationControl[] = [];
  for (let index = 0; index < count; index += 1) {
    controls.push({
      operationId: randomUUID(),
      key: sha256(`legacy-control-${index}`),
      requestHash: sha256(`legacy-control-hash-${index}`),
      operation: 'interrupt',
      status: 'completed',
    });
  }
  return controls;
}

function legacyStops(
  count: number,
): NonNullable<StoredDelegationLegacy['stopRequests']> {
  const requests: Array<
    NonNullable<StoredDelegationLegacy['stopRequests']>[number]
  > = [];
  for (let index = 0; index < count; index += 1) {
    requests.push({
      operationId: randomUUID(),
      key: sha256(`legacy-stop-${index}`),
      runGeneration: 1,
      status: 'completed',
    });
  }
  return requests;
}

function deferred(): { readonly promise: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

describe('trusted dormant v3 receipt guards', () => {
  it('admits a direct host message by rolling over a full stream receipt window', async () => {
    const fixture = await createStreamFixture({ capacity: 1 });
    try {
      await emitTerminal(fixture, 1);
      await fillCompletedCommandWindow(fixture);
      const before = streamRecord(fixture);
      const evictee = before.receipts.commandReceipts[0];
      if (!evictee) throw new Error('Expected a retained command receipt');
      const attemptId = randomUUID();

      expect(
        await fixture.broker.deliverHostMessage(
          fixture.id,
          'Direct host message at a full window.',
          attemptId,
        ),
      ).toMatchObject({
        ok: true,
        value: { attemptId, status: 'accepted' },
      });
      for (let attempt = 0; attempt < 10; attempt += 1) await flushBroker();

      const after = streamRecord(fixture);
      expect(after.receipts.commandReceipts).toHaveLength(64);
      expect(
        after.receipts.commandReceipts.some(
          (entry) => entry.key === sha256(`host:request-steering:${attemptId}`),
        ),
      ).toBe(true);
      expect(
        await fixture.port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'command',
          key: evictee.key,
        }),
      ).toMatchObject({ ok: true, value: { key: evictee.key } });
    } finally {
      await fixture.broker.close();
    }
  });

  it('coalesces a queued host message and rolls over its full stream window', async () => {
    const fixture = await createStreamFixture({ capacity: 1 });
    try {
      await queueContinuation(fixture);
      const accepted = await fixture.broker.manage(
        {
          ...rootParent,
          toolCallId: 'receipt-guard-competing-control-accepted',
        },
        {
          delegationId: fixture.id,
          operation: 'follow_up',
          message: 'The queued continuation may accept this first follow-up.',
        },
      );
      expect(accepted.ok).toBe(true);
      const priorControl = streamRecord(fixture).control;
      if (!priorControl) throw new Error('Expected the accepted continuation');
      const busy = await fixture.broker.manage(
        { ...rootParent, toolCallId: 'receipt-guard-competing-control' },
        {
          delegationId: fixture.id,
          operation: 'follow_up',
          message: 'This must remain busy.',
        },
      );
      expect(busy.ok).toBe(false);
      expect(streamRecord(fixture).control?.operationId).toBe(
        priorControl.operationId,
      );

      let attempt = 0;
      while (
        streamRecord(fixture).receipts.commandReceipts.length < 64 &&
        attempt < 64
      ) {
        const busyReply = await fixture.broker.manage(
          {
            ...rootParent,
            toolCallId: `receipt-guard-queued-busy-${attempt}`,
          },
          {
            delegationId: fixture.id,
            operation: 'follow_up',
            message: 'A competing continuation.',
          },
        );
        expect(busyReply.ok).toBe(false);
        attempt += 1;
      }
      expect(streamRecord(fixture).receipts.commandReceipts).toHaveLength(64);
      const evictee = streamRecord(fixture).receipts.commandReceipts[0];
      if (!evictee) throw new Error('Expected a retained command receipt');
      const attemptId = randomUUID();
      expect(
        await fixture.broker.deliverHostMessage(
          fixture.id,
          'Coalesced host message at a full window.',
          attemptId,
        ),
      ).toMatchObject({
        ok: true,
        value: { attemptId, status: 'accepted' },
      });

      const after = streamRecord(fixture);
      expect(after.control?.operationId).toBe(priorControl.operationId);
      expect(after.task.prompt).toContain(
        'Coalesced host message at a full window.',
      );
      expect(after.receipts.commandReceipts).toHaveLength(64);
      expect(
        after.receipts.commandReceipts.some(
          (entry) => entry.key === sha256(`host:request-steering:${attemptId}`),
        ),
      ).toBe(true);
      expect(
        await fixture.port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'command',
          key: evictee.key,
        }),
      ).toMatchObject({ ok: true, value: { key: evictee.key } });
    } finally {
      await fixture.broker.close();
    }
  });

  it('keeps the 32768-character bound for queued stream host coalescing', async () => {
    const fixture = await createStreamFixture({ capacity: 1 });
    try {
      await queueContinuation(fixture);
      const accepted = await fixture.broker.manage(
        { ...rootParent, toolCallId: 'receipt-guard-32768-control' },
        {
          delegationId: fixture.id,
          operation: 'follow_up',
          message: 'Keep the accepted control active during the bound check.',
        },
      );
      expect(accepted.ok).toBe(true);
      const before = streamRecord(fixture);
      if (!before.control)
        throw new Error('Expected the accepted host control');
      const attemptId = randomUUID();
      const result = await fixture.broker.deliverHostMessage(
        fixture.id,
        'x'.repeat(32768),
        attemptId,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });
      expect(streamRecord(fixture).task.prompt).toBe(before.task.prompt);
      expect(streamRecord(fixture).control?.operationId).toBe(
        before.control?.operationId,
      );
    } finally {
      await fixture.broker.close();
    }
  });

  it('does not coalesce a direct host message unless the continuation is queued', async () => {
    const fixture = await createStreamFixture();
    try {
      const originalPrompt = streamRecord(fixture).task.prompt;
      const attemptId = randomUUID();
      expect(
        await fixture.broker.deliverHostMessage(
          fixture.id,
          'Steer the running generation.',
          attemptId,
        ),
      ).toMatchObject({ ok: true, value: { attemptId, status: 'accepted' } });
      for (let attempt = 0; attempt < 10; attempt += 1) await flushBroker();
      expect(streamRecord(fixture).task.prompt).toBe(originalPrompt);
      expect(fixture.runner.steeringRequests).toHaveLength(1);
    } finally {
      await fixture.broker.close();
    }
  });

  it('keeps host missing-target rejection distinct from receipt rollover', async () => {
    const fixture = await createStreamFixture();
    try {
      const lookup = jest.spyOn(fixture.port, 'receipt');
      const commit = jest.spyOn(fixture.storage, 'commit');
      expect(
        await fixture.broker.deliverHostMessage(
          'missing-host-target',
          'No retained target.',
          randomUUID(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });
      expect(lookup).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    } finally {
      await fixture.broker.close();
    }
  });

  it('keeps the active-stop fence ahead of a stream resume', async () => {
    const fixture = await createStreamFixture({
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    });
    const stopGate = deferred();
    jest.spyOn(fixture.runner, 'stop').mockImplementation(async (handle) => {
      fixture.runner.stopped.push(handle.runId);
      await stopGate.promise;
      return { stopped: true };
    });
    try {
      await fixture.runner.sinks.get(fixture.id)?.({
        delegationId: fixture.id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'started', nativeSessionId: 'active-stop-native' },
      });
      await fixture.broker.requestStop(
        { ...rootParent, toolCallId: 'receipt-guard-active-stop' },
        fixture.id,
      );
      const before = streamRecord(fixture);
      expect(before.receipts.activeStop).toBeDefined();
      expect(
        await fixture.broker.manage(
          { ...rootParent, toolCallId: 'receipt-guard-resume-during-stop' },
          {
            delegationId: fixture.id,
            operation: 'resume',
            message: 'Resume must wait for the active stop.',
          },
        ),
      ).toMatchObject({ ok: false });
      expect(streamRecord(fixture).receipts.activeStop).toEqual(
        before.receipts.activeStop,
      );
    } finally {
      stopGate.release();
      await fixture.broker.close();
    }
  });

  it('keeps legacy history, control, and retained-stop limits', async () => {
    const seed = await completedLegacySeed();
    const firstHistory = seed.history?.[0];
    if (!firstHistory) throw new Error('Expected a legacy history entry');
    const fullHistory: NonNullable<StoredDelegationLegacy['history']> =
      Array.from({ length: 16 }, () => firstHistory);

    const historyBroker = legacyHarness({ ...seed, history: fullHistory });
    await historyBroker.broker.initialize();
    expect(
      await historyBroker.broker.deliverHostMessage(
        seed.state.delegationId,
        'Host message after retained history is full.',
        randomUUID(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'capacity_exceeded' },
    });
    await historyBroker.broker.close();

    const controlsBroker = legacyHarness({
      ...seed,
      history: [],
      controls: legacyControls(64),
    });
    await controlsBroker.broker.initialize();
    expect(
      await controlsBroker.broker.deliverHostMessage(
        seed.state.delegationId,
        'Host message after retained controls are full.',
        randomUUID(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'capacity_exceeded' },
    });
    await controlsBroker.broker.close();

    const resumeBroker = legacyHarness({
      ...seed,
      stopRequested: {
        operationId: randomUUID(),
        key: sha256('legacy-active-stop'),
        runGeneration: seed.state.runGeneration,
        status: 'accepted',
      },
      stopRequests: legacyStops(64),
    });
    await resumeBroker.broker.initialize();
    expect(
      await resumeBroker.broker.manage(
        { ...rootParent, toolCallId: 'legacy-resume-at-stop-cap' },
        {
          delegationId: seed.state.delegationId,
          operation: 'resume',
          message: 'Retained legacy stops stay bounded.',
        },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'capacity_exceeded' },
    });
    await resumeBroker.broker.close();

    const stopBroker = legacyHarness({
      ...seed,
      stopRequests: legacyStops(64),
    });
    await stopBroker.broker.initialize();
    expect(
      await stopBroker.broker.requestStop(
        { ...rootParent, toolCallId: 'legacy-stop-at-cap' },
        seed.state.delegationId,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'capacity_exceeded' },
    });
    await stopBroker.broker.close();
  });

  it('keeps scheduling, concurrency, and queue-full rejection', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new MemoryDelegationStorage();
    const harness = createBrokerHarness(
      {
        capacity: 1,
        testOnlyStreamGeneration: true,
        transcriptPort: port,
      },
      storage,
    );
    await harness.broker.initialize();
    try {
      const first = await harness.broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected the first scheduled run');
      await waitForLaunch(harness.runner, first.value.delegationId);
      for (let index = 0; index < 128; index += 1) {
        const queued = await harness.broker.spawn(
          { ...rootParent, toolCallId: `receipt-guard-queued-${index}` },
          baseTask,
        );
        expect(queued.ok).toBe(true);
      }
      const rejected = await harness.broker.spawn(
        { ...rootParent, toolCallId: 'receipt-guard-queue-overflow' },
        baseTask,
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The Default queue is full.',
        },
      });
      expect(harness.runner.starts).toHaveLength(1);
    } finally {
      await harness.broker.close();
    }
  });

  it('enforces the default 512 lifetime bound over records and new-identity reservations', async () => {
    const sourceStorage = new MemoryDelegationStorage();
    const source = createBrokerHarness({}, sourceStorage);
    await source.broker.initialize();
    const sourceSpawn = await source.broker.spawn(rootParent, baseTask);
    if (!sourceSpawn.ok) throw new Error('Expected a source record');
    await waitForLaunch(source.runner, sourceSpawn.value.delegationId);
    await source.runner.sinks.get(sourceSpawn.value.delegationId)?.({
      delegationId: sourceSpawn.value.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 1,
      event: { type: 'terminal', status: 'completed', finalText: 'seed' },
    });
    const sourceRecord = sourceStorage.records.get(
      sourceSpawn.value.delegationId,
    );
    if (!sourceRecord || sourceRecord.version === 3)
      throw new Error('Expected a legacy seed record');
    await source.broker.close();

    const recordsStorage = new MemoryDelegationStorage();
    for (let index = 0; index < 512; index += 1) {
      const id = randomUUID();
      recordsStorage.records.set(id, {
        ...sourceRecord,
        callKey: `${sourceRecord.callKey}:${index}`,
        state: { ...sourceRecord.state, delegationId: id },
      });
    }
    const recordsBroker = createBrokerHarness({}, recordsStorage);
    await recordsBroker.broker.initialize();
    expect(
      await recordsBroker.broker.spawn(rootParent, baseTask),
    ).toMatchObject({
      ok: false,
      error: { code: 'lifetime_limit_reached', retryable: false },
    });
    await recordsBroker.broker.close();

    const pendingStorage = new MemoryDelegationStorage();
    for (let index = 0; index < 511; index += 1) {
      const id = randomUUID();
      pendingStorage.records.set(id, {
        ...sourceRecord,
        callKey: `${sourceRecord.callKey}:pending:${index}`,
        state: { ...sourceRecord.state, delegationId: id },
      });
    }
    let routeEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      routeEntered = resolve;
    });
    const routeGate = deferred();
    const resolveRoute: AgentDelegationBrokerOptions['resolveRoute'] =
      async () => {
        routeEntered();
        await routeGate.promise;
        return {
          ok: true,
          value: routeFixture(),
        };
      };
    const pendingBroker = createBrokerHarness({ resolveRoute }, pendingStorage);
    await pendingBroker.broker.initialize();
    const pending = pendingBroker.broker.spawn(
      { ...rootParent, toolCallId: 'receipt-guard-pending-first' },
      baseTask,
    );
    await entered;
    expect(
      await pendingBroker.broker.spawn(
        { ...rootParent, toolCallId: 'receipt-guard-pending-second' },
        baseTask,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'lifetime_limit_reached', retryable: false },
    });
    routeGate.release();
    expect((await pending).ok).toBe(true);
    await pendingBroker.broker.close();
  });
});
