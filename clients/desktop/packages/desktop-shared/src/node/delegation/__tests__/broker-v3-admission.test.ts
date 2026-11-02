import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { DelegationApplyError } from '../broker';
import { routeFixture } from './fixtures';
import { FileDelegationStorage } from '../storage';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
} from './broker-harness';

describe('trusted dormant v3 admission', () => {
  it('launches a queued v3 generation in its prepared isolated workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-isolated-'));
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      {
        capacity: 1,
        testOnlyStreamGeneration: true,
        transcriptPort: new InMemoryDelegationTranscriptPort({
          owns: (): boolean => true,
          ownsChat: (): boolean => true,
        }),
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({ capabilities: ['read', 'worktree'] }),
          }),
        prepareWorkspace: () =>
          Promise.resolve({
            cwd: '/isolated/v3-child',
            baseCwd: '/isolated/base',
            revision: 'a'.repeat(40),
          }),
      },
      storage,
    );
    try {
      await broker.initialize();
      const first = await broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected admission');
      await waitForLaunch(runner, first.value.delegationId);
      const queued = await broker.spawn(
        { ...rootParent, toolCallId: 'queued-isolated' },
        { ...baseTask, isolation: 'worktree' },
      );
      if (!queued.ok) throw new Error('Expected queued admission');
      expect(queued.value).toMatchObject({ phase: 'queued' });
      const id = queued.value.delegationId;
      await runner.sink?.({
        delegationId: first.value.delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'terminal', status: 'completed', finalText: 'done' },
      });
      await waitForLaunch(runner, id);
      expect(
        runner.starts.find((start) => start.delegationId === id)?.cwd,
      ).toBe('/isolated/v3-child');
      const record = await storage.loadOne(id);
      if (record?.version !== 3) throw new Error('Expected a v3 record');
      expect(record).toMatchObject({
        executionCwd: '/isolated/v3-child',
        isolationBaseCwd: '/isolated/base',
        isolationRevision: 'a'.repeat(40),
      });
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains legacy failed apply transitions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-legacy-apply-'));
    const storage = new FileDelegationStorage(directory);
    const errors: string[] = [];
    const { broker, runner } = createBrokerHarness(
      {
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({
              capabilities: ['read', 'write', 'worktree', 'resume'],
            }),
          }),
        prepareWorkspace: () =>
          Promise.resolve({ cwd: '/isolated', revision: 'a'.repeat(40) }),
        manageWorkspace: () =>
          Promise.reject(
            new DelegationApplyError(
              'Not applied',
              { reason: 'unavailable', issues: [], guidance: 'Retry' },
              [
                {
                  path: 'src/a.ts',
                  parent: 'a'.repeat(64),
                  delegate: 'b'.repeat(64),
                },
              ],
            ),
          ),
      },
      storage,
    );
    try {
      await broker.initialize();
      const spawned = await broker.spawn(rootParent, {
        ...baseTask,
        isolation: 'worktree',
        permissions: { writePaths: ['src'] },
      });
      if (!spawned.ok) throw new Error('Expected admission');
      const id = spawned.value.delegationId;
      await waitForLaunch(runner, id);
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'started', nativeSessionId: 'native' },
      });
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: { type: 'terminal', status: 'completed', finalText: 'ready' },
      });
      const result = await broker.manage(
        { ...rootParent, toolCallId: 'apply' },
        { delegationId: id, operation: 'apply' },
      );
      expect(result.ok).toBe(true);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (broker.inspect(rootParent, id)?.control?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect({
        control: broker.inspect(rootParent, id)?.control,
        errors,
      }).toMatchObject({ control: { status: 'failed' }, errors: [] });
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('settles through the runner port and serves the exact answer after reopen', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'v3-record-'));
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    const trusted = { testOnlyStreamGeneration: true };
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, transcriptPort: port },
      storage,
    );
    const errors: string[] = [];
    const unsafeTerminalWrites: unknown[] = [];
    const original = storage.commit.bind(storage);
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      if (
        'version' in record &&
        record.version === 3 &&
        record.state.status === 'completed' &&
        !record.settling &&
        record.latestResult?.runGeneration !== record.state.runGeneration
      )
        unsafeTerminalWrites.push(record.state);
      try {
        await original(record);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        );
        throw error;
      }
    });
    try {
      await broker.initialize();
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error(JSON.stringify(errors));
      const id = spawned.value.delegationId;
      await waitForLaunch(runner, id);
      const answer = '🌿\uD800' + 'x'.repeat(8000);
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 200,
        event: { type: 'terminal', status: 'completed', finalText: answer },
      });
      await flushBroker();
      expect(unsafeTerminalWrites).toEqual([]);
      const record = await new FileDelegationStorage(directory).loadOne(id);
      expect(record?.version).toBe(3);
      expect(record).not.toHaveProperty('results');
      expect(record).not.toHaveProperty('history');
      expect(record?.state.finalText?.length).toBeLessThanOrEqual(4096);
      expect(
        await broker.getOutput(rootParent, { delegationId: id }),
      ).toMatchObject({
        ok: true,
        value: { latestResultIndex: 1, result: { finalText: answer } },
      });
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('persists stream selection and registration before dispatch', async () => {
    const storage = new MemoryDelegationStorage();
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    // Only test fixture builders provide this option. Spread permits this red
    // against the old broker without a compile-only missing-option failure.
    const trusted = { testOnlyStreamGeneration: true };
    const { broker, runner } = createBrokerHarness(
      {
        ...trusted,
        transcriptPort: port,
      },
      storage,
    );
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    const launch = await waitForLaunch(runner, id);
    expect(storage.records.get(id)?.version).toBe(3);
    expect(launch.transcriptStream).toEqual({
      target: {
        kind: 'delegation',
        chatId: rootParent.chatId,
        delegationId: id,
        runGeneration: 1,
      },
    });
    const registration = await port.generation({
      chatId: rootParent.chatId,
      delegationId: id,
      runGeneration: 1,
    });
    expect(registration.ok).toBe(true);
    const listed = await port.generationsPage({
      chatId: rootParent.chatId,
      delegationId: id,
      limit: 100,
    });
    expect(listed.ok && listed.value.generations).toHaveLength(1);
    await broker.close();
  });

  it('keeps production admission on the legacy codec', async () => {
    const storage = new MemoryDelegationStorage();
    const { broker, runner } = createBrokerHarness({}, storage);
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const launch = await waitForLaunch(runner, spawned.value.delegationId);
    expect(storage.records.get(spawned.value.delegationId)?.version).toBe(2);
    expect(launch.transcriptStream).toBeUndefined();
    await broker.close();
  });
});
