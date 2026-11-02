import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { FileDelegationStorage } from '../storage';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';
import type { AgentDelegationBrokerOptions } from '../broker';

const trusted = { testOnlyStreamGeneration: true };
const resumable: Pick<AgentDelegationBrokerOptions, 'resolveRoute'> = {
  resolveRoute: () =>
    Promise.resolve({
      ok: true as const,
      value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
    }),
};

describe('v3 receipts and immutable prefix policy', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'broker-v3-policy-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('coalesces concurrent stop admissions into one active operation', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, ...resumable, transcriptPort: port },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    const replies = await Promise.allSettled([
      broker.requestStop({ ...rootParent, toolCallId: 'concurrent-A' }, id),
      broker.requestStop({ ...rootParent, toolCallId: 'concurrent-B' }, id),
    ]);
    expect(replies.map((reply) => reply.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    await broker.close();
    const record = await storage.loadOne(id);
    if (record?.version !== 3) throw new Error('Expected v3');
    expect(record.receipts.stopReceipts).toHaveLength(2);
    expect(
      new Set(record.receipts.stopReceipts.map((entry) => entry.operationId))
        .size,
    ).toBe(1);
    expect(runner.stopped).toHaveLength(1);
  });

  it('rolls stop aliases at 64, replays before admission and keeps accepted-stop fences on refused resume', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, ...resumable, transcriptPort: port },
      storage,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(runner, 'stop').mockImplementation(async (handle) => {
      runner.stopped.push(handle.runId);
      await gate;
      return { stopped: true };
    });
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    try {
      for (let index = 0; index < 64; index++)
        expect(
          (
            await broker.requestStop(
              { ...rootParent, toolCallId: `alias-${index}` },
              id,
            )
          ).ok,
        ).toBe(true);
      const before = await storage.loadOne(id);
      if (before?.version !== 3) throw new Error('Expected v3');
      expect(before.receipts.stopReceipts).toHaveLength(64);
      expect(
        new Set(before.receipts.stopReceipts.map((entry) => entry.operationId))
          .size,
      ).toBe(1);
      const commit = jest.spyOn(storage, 'commit');
      commit.mockClear();
      expect(
        await broker.requestStop({ ...rootParent, toolCallId: 'alias-0' }, id),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'accepted' } },
      });
      expect(
        await broker.requestStop(
          { ...rootParent, toolCallId: 'alias-full' },
          id,
        ),
      ).toMatchObject({ ok: true });
      expect(commit).toHaveBeenCalledTimes(1);
      const rolled = await storage.loadOne(id);
      if (rolled?.version !== 3) throw new Error('Expected v3');
      expect(rolled.receipts.stopReceipts).toHaveLength(64);
      expect(rolled.receipts.stopReceipts).not.toEqual(
        before.receipts.stopReceipts,
      );
      expect(
        await port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'stop',
          key: before.receipts.stopReceipts[0].key,
        }),
      ).toMatchObject({ ok: true, value: before.receipts.stopReceipts[0] });
      expect(
        await broker.manage(
          { ...rootParent, toolCallId: 'accepted-resume' },
          { delegationId: id, operation: 'resume', message: 'continue' },
        ),
      ).toMatchObject({ ok: false });
      const after = await storage.loadOne(id);
      if (after?.version !== 3) throw new Error('Expected v3');
      expect(after.receipts.stopFence).toEqual(before.receipts.stopFence);
      expect(after.receipts.commandReceipts[0].reply.ack.ok).toBe(false);
      expect(runner.starts).toHaveLength(1);
    } finally {
      release();
      await broker.close();
    }
    expect(runner.stopped).toHaveLength(1);
  }, 30_000);

  it('repairs a durable pending stop before admitting resume and clearing its fence', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    let reportFailure: () => void = () => undefined;
    const errorGate = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const { broker, runner } = createBrokerHarness(
      {
        ...trusted,
        ...resumable,
        transcriptPort: port,
        onError: () => reportFailure(),
      },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'retained-native' },
    });
    const append = jest.spyOn(port, 'appendReceipt').mockResolvedValue({
      ok: false,
      error: { code: 'storage_failure', message: 'offline', retryable: true },
    });
    await broker.requestStop({ ...rootParent, toolCallId: 'pending-stop' }, id);
    await errorGate;
    const pending = await storage.loadOne(id);
    if (pending?.version !== 3) throw new Error('Expected v3');
    expect(pending.receipts.activeStop?.pendingTerminalOutcome).toBeDefined();
    await expect(
      broker.manage(
        { ...rootParent, toolCallId: 'still-pending-resume' },
        { delegationId: id, operation: 'resume', message: 'continue' },
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      broker.requestStop(
        { ...rootParent, toolCallId: 'still-pending-stop' },
        id,
      ),
    ).resolves.toMatchObject({ ok: false });
    const blocked = await storage.loadOne(id);
    if (blocked?.version !== 3) throw new Error('Expected v3');
    expect(blocked.receipts.stopFence).toEqual(pending.receipts.stopFence);
    expect(blocked.receipts.stopReceipts).toHaveLength(1);
    append.mockRestore();
    await expect(
      broker.manage(
        { ...rootParent, toolCallId: 'pending-resume' },
        { delegationId: id, operation: 'resume', message: 'continue' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const resumed = await storage.loadOne(id);
    if (resumed?.version !== 3) throw new Error('Expected v3');
    expect(resumed.receipts.activeStop).toBeUndefined();
    expect(resumed.receipts.stopFence).toBeUndefined();
    await broker.close();
  });

  it('refuses resume when a stop wins the serialized admission race', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, ...resumable, transcriptPort: port },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'retained-native' },
    });
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 200,
      event: { type: 'terminal', status: 'completed' },
    });
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = storage.commit.bind(storage);
    let held = false;
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      if (
        !held &&
        'version' in record &&
        record.version === 3 &&
        record.receipts.activeStop
      ) {
        held = true;
        entered();
        await releaseGate;
      }
      await original(record);
    });
    const stopping = broker.requestStop(
      { ...rootParent, toolCallId: 'racing-stop' },
      id,
    );
    await enteredGate;
    const resuming = broker.manage(
      { ...rootParent, toolCallId: 'racing-resume' },
      { delegationId: id, operation: 'resume', message: 'continue' },
    );
    release();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    await expect(resuming).resolves.toMatchObject({ ok: false });
    expect(runner.starts).toHaveLength(1);
    await broker.close();
    const record = await storage.loadOne(id);
    if (record?.version !== 3) throw new Error('Expected v3');
    expect(record.receipts.stopFence).toBeDefined();
  });

  it('fits admitted failures, replays them, and rolls a full window', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'terminal', status: 'completed' },
    });
    let first: unknown;
    for (let index = 0; index < 64; index++) {
      const reply = await broker.message(
        { ...rootParent, toolCallId: `refusal-${index}` },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      );
      expect(reply.ok).toBe(false);
      if (index === 0) first = reply;
    }
    const before = await storage.loadOne(id);
    if (before?.version !== 3) throw new Error('Expected v3');
    expect(before.receipts.commandReceipts).toHaveLength(64);
    expect(before.receipts.commandReceipts[0].reply.ack.ok).toBe(false);
    expect(
      await broker.message(
        { ...rootParent, toolCallId: 'refusal-0' },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      ),
    ).toEqual(first);
    const commit = jest.spyOn(storage, 'commit');
    commit.mockClear();
    expect(
      await broker.message(
        { ...rootParent, toolCallId: 'capacity' },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      ),
    ).toEqual(first);
    expect(commit).toHaveBeenCalledTimes(1);
    const rolled = await storage.loadOne(id);
    if (rolled?.version !== 3) throw new Error('Expected v3');
    expect(rolled.receipts.commandReceipts).toHaveLength(64);
    expect(
      await port.receipt({
        chatId: rootParent.chatId,
        receiptKind: 'command',
        key: before.receipts.commandReceipts[0].key,
      }),
    ).toMatchObject({ ok: true, value: before.receipts.commandReceipts[0] });
    await broker.close();
  }, 30_000);

  it('serializes the final command-window slot with one rollover and writes nothing for foreign or malformed probes', async () => {
    const storage = new MemoryDelegationStorage();
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const { broker, runner } = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'terminal', status: 'completed' },
    });
    const commit = jest.spyOn(storage, 'commit');
    expect(
      (
        await broker.message(
          { ...rootParent, chatId: 'foreign' },
          { delegationId: id, operation: 'follow_up', message: 'continue' },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await broker.manage(
          { ...rootParent, toolCallId: 'malformed' },
          {
            delegationId: id,
            operation: 'follow_up',
            message: 'continue',
            extra: true,
          },
        )
      ).ok,
    ).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    for (let index = 0; index < 63; index++)
      await broker.message(
        { ...rootParent, toolCallId: `failure-${index}` },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      );
    const appends = jest.spyOn(port, 'appendReceipt');
    const commitsBeforeRace = commit.mock.calls.length;
    const replies = await Promise.allSettled(
      ['last-A', 'last-B'].map((toolCallId) =>
        broker.message(
          { ...rootParent, toolCallId },
          { delegationId: id, operation: 'follow_up', message: 'continue' },
        ),
      ),
    );
    expect(replies.map((reply) => reply.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      replies.filter(
        (reply) =>
          reply.status === 'fulfilled' &&
          !reply.value.ok &&
          reply.value.error.code === 'capacity_exceeded',
      ),
    ).toHaveLength(0);
    expect(commit.mock.calls.length - commitsBeforeRace).toBe(2);
    expect(appends).toHaveBeenCalledTimes(1);
    const record = storage.records.get(id);
    expect(
      record?.version === 3 && record.receipts.commandReceipts,
    ).toHaveLength(64);
    await broker.close();
  });

  it('promotes only at continuation and keeps legacy keys and bytes in the frozen prefix', async () => {
    const storage = new FileDelegationStorage(directory);
    const legacy = createBrokerHarness(resumable, storage);
    await legacy.broker.initialize();
    const spawned = await legacy.broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(legacy.runner, id);
    await legacy.runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'retained-native' },
    });
    await legacy.runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 200,
      event: {
        type: 'terminal',
        status: 'completed',
        finalText: 'legacy answer',
      },
    });
    const legacyStopParent = { ...rootParent, toolCallId: 'legacy-stop' };
    expect((await legacy.broker.requestStop(legacyStopParent, id)).ok).toBe(
      true,
    );
    await legacy.broker.close();
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const current = createBrokerHarness(
      { ...trusted, ...resumable, transcriptPort: port },
      new FileDelegationStorage(directory),
    );
    await current.broker.initialize();
    const parent = { ...rootParent, toolCallId: 'mixed-command' };
    const input = {
      delegationId: id,
      operation: 'resume',
      message: 'continue',
    };
    const continuation = await current.broker.manage(parent, input);
    if (!continuation.ok) throw new Error(JSON.stringify(continuation));
    for (
      let attempt = 0;
      attempt < 200 &&
      !current.runner.starts.some((start) => start.runGeneration === 2);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(
      current.runner.starts.some((start) => start.runGeneration === 2),
    ).toBe(true);
    const promoted = await storage.loadOne(id);
    if (promoted?.version !== 3) throw new Error('Expected promotion');
    const prefix = JSON.stringify(promoted.legacyPrefix);
    expect(promoted.receipts.commandReceipts).toHaveLength(0);
    expect(
      current.broker.inspect(rootParent, id)?.stopRequested,
    ).toBeUndefined();
    const registry = jest.spyOn(port, 'result');
    const generations = jest.spyOn(port, 'resultByGeneration');
    expect(
      await current.broker.getOutput(rootParent, {
        delegationId: id,
        resultIndex: 1,
      }),
    ).toMatchObject({
      ok: true,
      value: { result: { finalText: 'legacy answer' } },
    });
    expect(
      await current.broker.watchTargetStates([
        { delegationId: id, runGeneration: 1 },
      ]),
    ).toMatchObject([
      { runGeneration: 1, status: 'completed', resultIndex: 1 },
    ]);
    expect(registry).not.toHaveBeenCalled();
    expect(generations).not.toHaveBeenCalled();
    registry.mockRestore();
    generations.mockRestore();
    const second = await current.broker.spawn(
      { ...rootParent, toolCallId: 'mixed-other' },
      baseTask,
    );
    if (!second.ok) throw new Error('Expected second admission');
    expect(
      (
        await current.broker.manage(parent, {
          ...input,
          delegationId: second.value.delegationId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await current.broker.requestStop(
          legacyStopParent,
          second.value.delegationId,
        )
      ).ok,
    ).toBe(false);
    const beforeReplay = current.broker.inspect(rootParent, id)?.stopRequested;
    expect((await current.broker.requestStop(legacyStopParent, id)).ok).toBe(
      true,
    );
    expect(current.broker.inspect(rootParent, id)?.stopRequested).toEqual(
      beforeReplay,
    );
    expect(
      (await current.broker.manage(parent, { ...input, message: 'changed' }))
        .ok,
    ).toBe(false);
    await current.runner.sink?.({
      delegationId: id,
      runGeneration: 2,
      sequence: 1,
      occurredAt: 300,
      event: {
        type: 'terminal',
        status: 'completed',
        finalText: 'stream answer',
      },
    });
    const settled = await storage.loadOne(id);
    if (settled?.version !== 3) throw new Error('Expected v3');
    expect(settled.latestResult?.resultIndex).toBe(2);
    expect(JSON.stringify(settled.legacyPrefix)).toBe(prefix);
    const append = jest.spyOn(port, 'appendReceipt').mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'offline outcome',
        retryable: true,
      },
    });
    const streamStop = await current.broker.requestStop(
      { ...rootParent, toolCallId: 'mixed-stream-stop' },
      id,
    );
    expect(streamStop).toMatchObject({
      ok: true,
      value: { stopRequested: { status: 'accepted' } },
    });
    await current.broker.close();
    const pendingStop = await storage.loadOne(id);
    if (pendingStop?.version !== 3) throw new Error('Expected v3');
    expect(
      pendingStop.receipts.activeStop?.pendingTerminalOutcome,
    ).toBeDefined();
    const currentPolicy = current.broker.inspect(rootParent, id)?.stopRequested;
    expect(currentPolicy?.status).toBe('completed');
    append.mockRestore();
    const reopened = createBrokerHarness(
      { transcriptPort: port },
      new FileDelegationStorage(directory),
    );
    await reopened.broker.initialize();
    const clearedStop = await storage.loadOne(id);
    expect(
      clearedStop?.version === 3 && clearedStop.receipts.activeStop,
    ).toBeUndefined();
    expect(reopened.broker.inspect(rootParent, id)?.stopRequested).toEqual(
      currentPolicy,
    );
    await reopened.broker.requestStop(legacyStopParent, id);
    expect(reopened.broker.inspect(rootParent, id)?.stopRequested).toEqual(
      currentPolicy,
    );
    expect(
      (
        await reopened.broker.manage(parent, {
          ...input,
          delegationId: second.value.delegationId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await reopened.broker.requestStop(
          legacyStopParent,
          second.value.delegationId,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await reopened.broker.manage(parent, {
          ...input,
          message: 'changed again',
        })
      ).ok,
    ).toBe(false);
    const reloaded = await storage.loadOne(id);
    expect(
      reloaded?.version === 3 && JSON.stringify(reloaded.legacyPrefix),
    ).toBe(prefix);
    await reopened.broker.close();
  }, 30_000);

  it('replays retired stop A after resume and B without changing the current fence', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    const errors: unknown[] = [];
    let cleared: () => void = () => undefined;
    const clearGate = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    const original = storage.commit.bind(storage);
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      await original(record);
      if (
        'version' in record &&
        record.version === 3 &&
        record.receipts.stopReceipts.length > 0 &&
        !record.receipts.activeStop
      )
        cleared();
    });
    const { broker, runner } = createBrokerHarness(
      {
        ...trusted,
        ...resumable,
        transcriptPort: port,
        onError: (error) => {
          errors.push(error);
        },
      },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'retained-native' },
    });
    const parentA = { ...rootParent, toolCallId: 'stop-A' };
    const first = await broker.requestStop(parentA, id);
    expect(first.ok).toBe(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        clearGate,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(
      errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([]);
    const stopped = await storage.loadOne(id);
    if (stopped?.version !== 3) throw new Error('Expected v3');
    expect(errors).toEqual([]);
    expect(stopped.receipts.activeStop).toBeUndefined();
    expect(stopped.receipts.stopFence?.status).toBe('completed');
    const resume = await broker.manage(
      { ...rootParent, toolCallId: 'resume' },
      { delegationId: id, operation: 'resume', message: 'continue' },
    );
    if (!resume.ok)
      throw new Error(
        JSON.stringify({
          resume,
          errors: errors.map((error) =>
            error instanceof Error ? error.message : String(error),
          ),
        }),
      );
    for (
      let attempt = 0;
      attempt < 200 &&
      !runner.starts.some((start) => start.runGeneration === 2);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(runner.starts.some((start) => start.runGeneration === 2)).toBe(true);
    expect(broker.inspect(rootParent, id)?.stopRequested).toBeUndefined();
    const next = await broker.requestStop(
      { ...rootParent, toolCallId: 'stop-B' },
      id,
    );
    expect(next.ok).toBe(true);
    const before = broker.inspect(rootParent, id)?.stopRequested;
    const replay = await broker.requestStop(parentA, id);
    expect(replay).toMatchObject({
      ok: true,
      value: {
        stopRequested: {
          operationId: stopped.receipts.stopFence?.operationId,
          status: 'completed',
        },
      },
    });
    expect(broker.inspect(rootParent, id)?.stopRequested?.operationId).toBe(
      before?.operationId,
    );
    expect(errors).toEqual([]);
    await broker.close();
  }, 30_000);
});
