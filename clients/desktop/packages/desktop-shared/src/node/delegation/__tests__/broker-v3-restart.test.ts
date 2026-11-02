import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { FileDelegationStorage } from '../storage';
import type { StoredDelegationV3 } from '../record-v3';
import { canonicalDelegationJson } from '../settlement-identity';
import { DELEGATION_REGISTRY_MAX_ENTRY_BYTES } from '../transcript-port';
import {
  baseTask,
  createBrokerHarness,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';
import { FakeRunner } from './fixtures';
import { AgentRunnerRegistry } from '../runner-registry';

/** Restart creates new port objects from the committed registry/stream state. */
class ReopenablePort extends InMemoryDelegationTranscriptPort {
  constructor() {
    super({ owns: () => true, ownsChat: () => true });
  }
  reopen(): ReopenablePort {
    const reopened = new ReopenablePort();
    for (const [key, value] of Array.from(this.streams))
      reopened.streams.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.registries))
      reopened.registries.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.answers))
      reopened.answers.set(key, { ...value, bytes: Buffer.from(value.bytes) });
    return reopened;
  }
}

const trusted = { testOnlyStreamGeneration: true };
function terminal(id: string): AgentDelegationEvent {
  return {
    delegationId: id,
    runGeneration: 1,
    sequence: 2,
    occurredAt: 200,
    event: {
      type: 'terminal',
      status: 'completed',
      finalText: 'exact answer 🌿',
    },
  };
}

describe('P11 v3 restart boundaries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'broker-v3-restart-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('retains a broker-only registration after conflict and repairs it before any dispatch', async () => {
    const storage = new FileDelegationStorage(directory);
    const port = new ReopenablePort();
    const register = jest.spyOn(port, 'registerGeneration').mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: 'registration conflicts',
        retryable: false,
      },
    });
    const first = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      storage,
    );
    await first.broker.initialize();
    expect((await first.broker.spawn(rootParent, baseTask)).ok).toBe(false);
    expect(first.runner.starts).toHaveLength(0);
    const records = await storage.load();
    expect(records).toHaveLength(1);
    const before = records[0];
    if (before?.version !== 3) throw new Error('Expected v3');
    const reopenedPort = port.reopen();
    register.mockRestore();
    await first.broker.close();
    await storage.commit(before);
    const recovered = createBrokerHarness(
      { transcriptPort: reopenedPort },
      new FileDelegationStorage(directory),
    );
    await recovered.broker.initialize();
    expect(recovered.runner.starts).toHaveLength(0);
    const after = await storage.loadOne(before.state.delegationId);
    expect(after?.version === 3 && after.latestResult?.status).toBe(
      'cancelled',
    );
    await recovered.broker.close();
  });

  it('does not invent a broker record or launch from a registry-only registration', async () => {
    const port = new ReopenablePort();
    await port.registerGeneration({
      chatId: rootParent.chatId,
      delegationId: 'orphan',
      runGeneration: 1,
      createdAt: 100,
      origin: { kind: 'launch' },
      executionMode: 'background',
      store: 'stream',
    });
    const storage = new FileDelegationStorage(directory);
    const recovered = createBrokerHarness(
      { transcriptPort: port.reopen() },
      storage,
    );
    await recovered.broker.initialize();
    expect(await storage.load()).toEqual([]);
    expect(recovered.runner.starts).toHaveLength(0);
    expect(recovered.runner.stopped).toHaveLength(0);
    await recovered.broker.close();
  });

  it('resolves an accepted stop on a running generation at restart with consistent attribution', async () => {
    const port = new ReopenablePort();
    const storage = new FileDelegationStorage(directory);
    let captured: () => void = () => undefined;
    const captureGate = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const original = storage.commit.bind(storage);
    let armed = false;
    let snapshot: StoredDelegationV3 | undefined;
    let snapshotPort: ReopenablePort | undefined;
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      await original(record);
      if (
        armed &&
        'version' in record &&
        record.version === 3 &&
        record.receipts.activeStop &&
        record.state.status === 'running'
      ) {
        armed = false;
        snapshot = structuredClone(record);
        snapshotPort = port.reopen();
        captured();
      }
    });
    const first = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      storage,
    );
    await first.broker.initialize();
    const spawned = await first.broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(first.runner, id);
    await first.runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'native' },
    });
    armed = true;
    await first.broker.requestStop(
      { ...rootParent, toolCallId: 'accepted-stop' },
      id,
    );
    await captureGate;
    await first.broker.close();
    if (!snapshot || !snapshotPort) throw new Error('Expected a snapshot');
    await original(snapshot);
    const recovered = createBrokerHarness(
      { transcriptPort: snapshotPort },
      new FileDelegationStorage(directory),
    );
    await recovered.broker.initialize();
    expect(recovered.runner.starts).toHaveLength(0);
    expect(recovered.runner.stopped).toHaveLength(0);
    const after = await new FileDelegationStorage(directory).loadOne(id);
    if (after?.version !== 3) throw new Error('Expected v3');
    expect(after.state).toMatchObject({
      status: 'cancelled',
      stopReason: 'shutdown',
      cancelledByUser: false,
    });
    expect(after.state.stoppedBy).toBeUndefined();
    expect(after.receipts.activeStop).toBeUndefined();
    expect(after.receipts.stopFence?.status).toBe('completed');
    await recovered.broker.close();
  });

  it('repairs the atomic terminal-plus-intent stop crash without runner calls', async () => {
    const port = new ReopenablePort();
    const storage = new FileDelegationStorage(directory);
    let crashed: () => void = () => undefined;
    const crashGate = new Promise<void>((resolve) => {
      crashed = resolve;
    });
    const original = storage.commit.bind(storage);
    let armed = false;
    let crashRecord: StoredDelegationV3 | undefined;
    let crashPort: ReopenablePort | undefined;
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      await original(record);
      if (
        armed &&
        'version' in record &&
        record.version === 3 &&
        record.settling &&
        record.receipts.activeStop
      ) {
        armed = false;
        crashRecord = structuredClone(record);
        crashPort = port.reopen();
        crashed();
        throw new Error('power loss after terminal commit');
      }
    });
    const first = createBrokerHarness(
      { ...trusted, transcriptPort: port, onError: () => crashed() },
      storage,
    );
    await first.broker.initialize();
    const spawned = await first.broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(first.runner, id);
    armed = true;
    await first.broker.requestStop(
      { ...rootParent, toolCallId: 'crash-stop' },
      id,
    );
    await crashGate;
    await first.broker.close();
    if (!crashRecord || !crashPort) throw new Error('Expected crash snapshot');
    await original(crashRecord);
    const before = await new FileDelegationStorage(directory).loadOne(id);
    if (before?.version !== 3) throw new Error('Expected v3');
    expect(before.settling).toBeDefined();
    expect(before.state.status).toBe('cancelled');
    expect(before.latestResult).toBeUndefined();
    const reopenedPort = crashPort;
    const recovered = createBrokerHarness(
      { transcriptPort: reopenedPort },
      new FileDelegationStorage(directory),
    );
    await recovered.broker.initialize();
    expect(recovered.runner.starts).toHaveLength(0);
    expect(recovered.runner.stopped).toHaveLength(0);
    const after = await new FileDelegationStorage(directory).loadOne(id);
    if (after?.version !== 3) throw new Error('Expected v3');
    expect(after.settling).toBeUndefined();
    expect(after.latestResult).toMatchObject({
      resultIndex: 1,
      status: 'cancelled',
      settledAt: before.settling?.outcome.finishedAt,
    });
    expect(after.receipts.activeStop).toBeUndefined();
    expect(after.receipts.stopFence?.status).toBe('completed');
    const results = await reopenedPort.resultsPage({
      chatId: rootParent.chatId,
      delegationId: id,
      limit: 100,
    });
    expect(results.ok && results.value.results).toHaveLength(1);
    await recovered.broker.close();
  });

  it.each(['reportFailure', 'unconfirmed-stop'] as const)(
    'settles the %s terminal route and preserves its first intent on reopen',
    async (route) => {
      const port = new ReopenablePort();
      const storage = new FileDelegationStorage(directory);
      const runner = new FakeRunner('local-sdk');
      const registry = new AgentRunnerRegistry();
      let stopCalls = 0;
      registry.register({
        apiVersion: 1,
        registrationId: 'third-local',
        adapter: {
          harnessId: runner.harnessId,
          adapterVersion: runner.adapterVersion,
          runtimeKind: runner.runtimeKind,
          canRun: runner.canRun.bind(runner),
          start: (request, sink) => runner.start(request, sink),
          close: runner.close.bind(runner),
          stop: () =>
            Promise.resolve(
              ++stopCalls > 1
                ? { stopped: true }
                : {
                    stopped: false,
                    error: {
                      code: 'launch_uncertain',
                      message: 'Stop is not yet confirmed.',
                      retryable: false,
                    },
                  },
            ),
        },
      });
      let failed: () => void = () => undefined;
      const failure = new Promise<void>((resolve) => {
        failed = resolve;
      });
      if (route === 'reportFailure') {
        jest
          .spyOn(runner, 'start')
          .mockRejectedValue(new Error('launch failed'));
        jest.spyOn(port, 'settle').mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'settlement offline',
            retryable: true,
          },
        });
      }
      const first = createBrokerHarness(
        { ...trusted, transcriptPort: port, registry, onError: () => failed() },
        storage,
      );
      await first.broker.initialize();
      const spawned = await first.broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error(JSON.stringify(spawned));
      const id = spawned.value.delegationId;
      if (route === 'reportFailure') await failure;
      else {
        await waitForLaunch(runner, id);
        expect((await first.broker.stop(rootParent, id)).ok).toBe(false);
      }
      const before = await storage.loadOne(id);
      if (before?.version !== 3) throw new Error('Expected v3');
      if (route === 'reportFailure')
        expect(before.settling?.outcome.status).toBe('failed');
      else expect(before.latestResult?.status).toBe('interrupted');
      const reopenedPort = port.reopen();
      await first.broker.close();
      await storage.commit(before);
      const recovered = createBrokerHarness(
        { transcriptPort: reopenedPort },
        new FileDelegationStorage(directory),
      );
      await recovered.broker.initialize();
      expect(recovered.runner.starts).toHaveLength(0);
      expect(recovered.runner.stopped).toHaveLength(0);
      const after = await new FileDelegationStorage(directory).loadOne(id);
      if (after?.version !== 3) throw new Error('Expected v3');
      expect(after.latestResult?.status).toBe(
        route === 'reportFailure' ? 'failed' : 'interrupted',
      );
      expect(after.latestResult?.settledAt).toBe(
        before.settling?.outcome.finishedAt ?? before.latestResult?.settledAt,
      );
      await recovered.broker.close();
    },
  );

  it.each(['intent', 'open', 'settle', 'locator', 'notify'] as const)(
    'reopens both stores after a crash at %s',
    async (stage) => {
      const port = new ReopenablePort();
      const storage = new FileDelegationStorage(directory);
      let armed = false;
      let crashed = false;
      const originalCommit = storage.commit.bind(storage);
      jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
        await originalCommit(record);
        if (
          armed &&
          !crashed &&
          'version' in record &&
          record.version === 3 &&
          ((stage === 'intent' && record.settling) ||
            (stage === 'locator' && record.latestResult && !record.settling))
        ) {
          crashed = true;
          throw new Error('power loss');
        }
      });
      const open = port.open.bind(port);
      jest.spyOn(port, 'open').mockImplementation(async (input) => {
        const result = await open(input);
        if (armed && !crashed && stage === 'open') {
          crashed = true;
          throw new Error('power loss');
        }
        return result;
      });
      const settle = port.settle.bind(port);
      jest.spyOn(port, 'settle').mockImplementation(async (input) => {
        const result = await settle(input);
        if (armed && !crashed && stage === 'settle') {
          crashed = true;
          throw new Error('power loss');
        }
        return result;
      });
      const { broker, runner } = createBrokerHarness(
        {
          ...trusted,
          transcriptPort: port,
          onSettled: () => {
            if (armed && !crashed && stage === 'notify') {
              crashed = true;
              throw new Error('power loss');
            }
            return Promise.resolve();
          },
        },
        storage,
      );
      await broker.initialize();
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected v3 admission');
      const id = spawned.value.delegationId;
      await waitForLaunch(runner, id);
      armed = true;
      const delivered = runner.sink?.(terminal(id));
      // A failed notification leaves a durable, unmarked locator for restart
      // replay and lets terminal cleanup run; earlier stages stay pending.
      if (stage === 'notify') await expect(delivered).resolves.toBeUndefined();
      else await expect(delivered).rejects.toThrow('Settlement pending');
      expect(crashed).toBe(true);
      const before = await new FileDelegationStorage(directory).loadOne(id);
      const reopenedPort = port.reopen();
      const notices: unknown[] = [];
      const recovered = createBrokerHarness(
        {
          transcriptPort: reopenedPort,
          onSettled: (_parent, _id, result) => {
            notices.push(result);
            return Promise.resolve();
          },
        },
        new FileDelegationStorage(directory),
      );
      await recovered.broker.initialize();
      expect(recovered.runner.starts).toHaveLength(0);
      const after = await new FileDelegationStorage(directory).loadOne(id);
      if (before?.version !== 3 || after?.version !== 3)
        throw new Error('Expected persisted v3');
      expect(after.settling).toBeUndefined();
      expect(after.latestResult).toMatchObject({
        resultIndex: 1,
        runGeneration: 1,
        status: 'completed',
        notified: true,
      });
      expect(after.latestResult?.settledAt).toBe(
        before.settling?.outcome.finishedAt ?? before.latestResult?.settledAt,
      );
      const results = await reopenedPort.resultsPage({
        chatId: rootParent.chatId,
        delegationId: id,
        limit: 100,
      });
      expect(results.ok && results.value.results).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toHaveProperty('finalText');
      await recovered.broker.close();
    },
  );

  it.each([
    'record-only',
    'registry-only',
    'locator-missing',
    'wrong-key',
    'index-conflict',
    'lookup-error',
  ] as const)(
    'reconciles the P11 %s boundary after reopening',
    async (stage) => {
      const port = new ReopenablePort();
      const storage = new FileDelegationStorage(directory);
      const first = createBrokerHarness(
        { ...trusted, transcriptPort: port },
        storage,
      );
      await first.broker.initialize();
      const spawned = await first.broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected admission');
      const id = spawned.value.delegationId;
      await waitForLaunch(first.runner, id);
      const running = await storage.loadOne(id);
      if (running?.version !== 3) throw new Error('Expected v3');
      if (stage === 'wrong-key') {
        const settle = port.settle.bind(port);
        jest
          .spyOn(port, 'settle')
          .mockImplementation((input) =>
            settle({ ...input, settlementKey: 'wrong-key' }),
          );
        await expect(first.runner.sink?.(terminal(id))).rejects.toThrow();
      } else if (stage !== 'record-only')
        await first.runner.sink?.(terminal(id));
      const terminalRecord = await storage.loadOne(id);
      const reopenedPort =
        stage === 'record-only' || stage === 'locator-missing'
          ? new ReopenablePort()
          : port.reopen();
      await first.broker.close();
      if (
        stage === 'record-only' ||
        stage === 'registry-only' ||
        stage === 'wrong-key'
      )
        await storage.commit(running);
      else {
        if (terminalRecord?.version !== 3 || !terminalRecord.latestResult)
          throw new Error('Expected locator');
        await storage.commit(
          stage === 'index-conflict'
            ? {
                ...terminalRecord,
                latestResult: {
                  ...terminalRecord.latestResult,
                  resultIndex: 2,
                },
              }
            : terminalRecord,
        );
      }
      const readAnswer = jest.spyOn(reopenedPort, 'resultAnswerRange');
      const register = jest.spyOn(reopenedPort, 'registerGeneration');
      const open = jest.spyOn(reopenedPort, 'open');
      if (stage === 'lookup-error')
        jest.spyOn(reopenedPort, 'resultBySettlementKey').mockResolvedValue({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'offline',
            retryable: true,
          },
        });
      const recovered = createBrokerHarness(
        { transcriptPort: reopenedPort },
        new FileDelegationStorage(directory),
      );
      if (
        stage === 'locator-missing' ||
        stage === 'wrong-key' ||
        stage === 'index-conflict' ||
        stage === 'lookup-error'
      ) {
        await expect(recovered.broker.initialize()).rejects.toThrow();
        if (stage === 'lookup-error') {
          expect(register).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
        }
      } else {
        await recovered.broker.initialize();
        const result = await reopenedPort.resultsPage({
          chatId: rootParent.chatId,
          delegationId: id,
          limit: 100,
        });
        expect(result.ok && result.value.results).toHaveLength(1);
        const record = await new FileDelegationStorage(directory).loadOne(id);
        expect(record?.version === 3 && record.latestResult?.status).toBe(
          stage === 'record-only' ? 'interrupted' : 'completed',
        );
      }
      expect(recovered.runner.starts).toHaveLength(0);
      expect(recovered.runner.stopped).toHaveLength(0);
      expect(readAnswer).not.toHaveBeenCalled();
      await recovered.broker.close();
    },
  );

  it('returns pending output without registry I/O', async () => {
    const port = new ReopenablePort();
    const read = jest.spyOn(port, 'result');
    const body = jest.spyOn(port, 'resultAnswerRange');
    const { broker, runner } = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      new FileDelegationStorage(directory),
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    await waitForLaunch(runner, spawned.value.delegationId);
    expect(
      await broker.getOutput(rootParent, {
        delegationId: spawned.value.delegationId,
      }),
    ).toMatchObject({
      ok: true,
      value: { result: null, latestResultIndex: null },
    });
    expect(read).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    await broker.close();
  });

  it('keeps fixed metadata at N and 2N, bounds full windows and counts every write', async () => {
    const port = new ReopenablePort();
    const storage = new FileDelegationStorage(directory);
    const commits: Array<{ generation: number; stage: string }> = [];
    const commit = storage.commit.bind(storage);
    let previous: StoredDelegationV3 | undefined;
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      await commit(record);
      if (!('version' in record) || record.version !== 3) return;
      const prior = previous;
      const stage =
        prior?.state.runGeneration !== record.state.runGeneration
          ? 'admission'
          : record.settling && !prior.settling
            ? 'intent'
            : record.latestResult?.resultIndex !==
                prior.latestResult?.resultIndex
              ? 'locator'
              : record.latestResult?.notified && !prior.latestResult?.notified
                ? 'markNotified'
                : record.receipts.commandReceipts.length !==
                    prior.receipts.commandReceipts.length
                  ? 'command-ack'
                  : record.control?.status !== prior.control?.status
                    ? 'command-final'
                    : canonicalDelegationJson(record.launch) !==
                        canonicalDelegationJson(prior.launch)
                      ? 'launch-journal'
                      : 'lifecycle';
      commits.push({ generation: record.state.runGeneration, stage });
      previous = structuredClone(record);
    });
    const errors: unknown[] = [];
    const { broker, runner } = createBrokerHarness(
      {
        ...trusted,
        transcriptPort: port,
        onError: (error) => {
          errors.push(error);
        },
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({
              capabilities: ['read', 'progress', 'resume'],
            }),
          }),
      },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    const metadataBytes: number[] = [];
    const fullBytes: number[] = [];
    const rowTime = Date.now() + 1_000_000;
    for (let generation = 1; generation <= 65; generation++) {
      for (
        let attempt = 0;
        attempt < 200 &&
        !runner.starts.some((start) => start.runGeneration === generation);
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(
        runner.starts.some((start) => start.runGeneration === generation),
      ).toBe(true);
      const sink = runner.sinks.get(id);
      if (!sink) throw new Error('Expected sink');
      await sink({
        delegationId: id,
        runGeneration: generation,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'started', nativeSessionId: 'retained-native' },
      });
      await port.open({
        target: {
          kind: 'delegation',
          chatId: rootParent.chatId,
          delegationId: id,
          runGeneration: generation,
        },
      });
      await port.appendChanges({
        target: {
          kind: 'delegation',
          chatId: rootParent.chatId,
          delegationId: id,
          runGeneration: generation,
        },
        mutationKey: `row-${generation}`,
        changes: [
          {
            row: {
              id: 'open-row',
              itemRevision: 0,
              final: false,
              timestamp: rowTime,
              role: 'assistant',
              delegationSegment: 'segment',
              parentBlockId: 'card',
              blocks: [{ type: 'text', text: 'open' }],
            },
          },
        ],
      });
      await sink({
        delegationId: id,
        runGeneration: generation,
        sequence: 2,
        occurredAt: 200,
        event: { type: 'terminal', status: 'completed', finalText: 'answer' },
      });
      const record = await storage.loadOne(id);
      if (record?.version !== 3) throw new Error('Expected v3');
      expect(record).not.toHaveProperty('history');
      expect(record).not.toHaveProperty('results');
      expect(record.readMetadata.lastActivityAt).toBe(rowTime);
      if (generation === 20 || generation === 40 || generation === 65) {
        const fixed = Buffer.byteLength(
          canonicalDelegationJson({
            ...record,
            receipts: {
              ...record.receipts,
              commandReceipts: [],
              stopReceipts: [],
            },
          }),
        );
        const full = Buffer.byteLength(canonicalDelegationJson(record));
        metadataBytes.push(fixed);
        fullBytes.push(full);
        expect(record.receipts.commandReceipts.length).toBeLessThanOrEqual(64);
        expect(record.receipts.stopReceipts.length).toBeLessThanOrEqual(64);
        expect(full).toBeLessThanOrEqual(
          fixed + 128 * (DELEGATION_REGISTRY_MAX_ENTRY_BYTES + 1),
        );
        if (generation === 65)
          expect(record.receipts.commandReceipts).toHaveLength(64);
      }
      if (generation === 20 || generation === 40)
        expect(
          broker
            .continuationCandidates(rootParent)
            .map((candidate) => candidate.delegationId),
        ).toContain(id);
      if (generation < 65) {
        const reply =
          generation === 30
            ? await broker.deliverHostMessage(
                id,
                'continue',
                '00000000-0000-4000-8000-000000000030',
              )
            : await broker.message(
                {
                  ...rootParent,
                  toolCallId: `follow-${String(generation).padStart(2, '0')}`,
                },
                {
                  delegationId: id,
                  operation: 'follow_up',
                  message: 'continue',
                },
              );
        expect(reply.ok).toBe(true);
      }
    }
    expect(errors).toEqual([]);
    expect(metadataBytes[1]).toBe(metadataBytes[0]);
    const stages = (generation: number): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const entry of commits.filter(
        (entry) => entry.generation === generation,
      ))
        counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
      return counts;
    };
    expect(stages(40)).toEqual(stages(20));
    expect(stages(20)).toMatchObject({
      admission: 1,
      intent: 1,
      locator: 1,
      markNotified: 1,
    });
    const beforeRollover = commits.length;
    const receiptAppends = jest.spyOn(port, 'appendReceipt');
    expect(
      await broker.message(
        { ...rootParent, toolCallId: 'full-window' },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      ),
    ).toMatchObject({ ok: true });
    expect(commits.length).toBeGreaterThan(beforeRollover);
    expect(
      receiptAppends.mock.calls.filter(
        ([entry]) => entry.receiptKind === 'command',
      ),
    ).toHaveLength(1);
    process.stdout.write(
      `S1 work ${JSON.stringify({ metadataBytes, fullBytes, stages20: stages(20), stages40: stages(40) })}\n`,
    );
    const results = await port.resultsPage({
      chatId: rootParent.chatId,
      delegationId: id,
      limit: 100,
    });
    expect(results.ok && results.value.results).toHaveLength(65);
    const descriptor = await port.open({
      target: {
        kind: 'delegation',
        chatId: rootParent.chatId,
        delegationId: id,
        runGeneration: 40,
      },
    });
    if (!descriptor.ok) throw new Error('Expected stream');
    const rows = await port.page({
      target: descriptor.value.target,
      streamRevision: descriptor.value.streamRevision,
    });
    expect(rows.ok && rows.value.rows[0]?.final).toBe(true);
    await broker.close();
    const reopened = createBrokerHarness(
      { transcriptPort: port.reopen() },
      new FileDelegationStorage(directory),
    );
    await reopened.broker.initialize();
    const record = await storage.loadOne(id);
    expect(record?.version === 3 && record.readMetadata.lastActivityAt).toBe(
      rowTime,
    );
    await reopened.broker.close();
  }, 60_000);
});
