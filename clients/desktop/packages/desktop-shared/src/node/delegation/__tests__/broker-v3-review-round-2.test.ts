import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { FileDelegationStorage } from '../storage';
import type { AgentDelegationBrokerOptions } from '../broker';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';

const trusted = { testOnlyStreamGeneration: true };
const resumable: Pick<AgentDelegationBrokerOptions, 'resolveRoute'> = {
  resolveRoute: () =>
    Promise.resolve({
      ok: true as const,
      value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
    }),
};

function ownedPort(): InMemoryDelegationTranscriptPort {
  return new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
}

async function settle(times = 20): Promise<void> {
  for (let index = 0; index < times; index++) await flushBroker();
}

describe('v3 broker review round 2', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'broker-v3-r2-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('folds the failure receipt admission time, but not a refused-key replay or unchanged update', async () => {
    const storage = new FileDelegationStorage(directory);
    const { broker, runner } = createBrokerHarness(
      { ...trusted, transcriptPort: ownedPort() },
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
    await settle();
    const before = await storage.loadOne(id);
    if (before?.version !== 3) throw new Error('Expected v3');
    const activity = before.readMetadata.lastActivityAt;
    const later = Date.now() + 10_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    const refused = await broker.message(
      { ...rootParent, toolCallId: 'refused-follow-up' },
      { delegationId: id, operation: 'follow_up', message: 'continue' },
    );
    expect(refused.ok).toBe(false);
    const after = await storage.loadOne(id);
    if (after?.version !== 3) throw new Error('Expected v3');
    expect(after.receipts.commandReceipts.length).toBeGreaterThan(
      before.receipts.commandReceipts.length,
    );
    const receipt =
      after.receipts.commandReceipts[after.receipts.commandReceipts.length - 1];
    expect(receipt?.admittedAt).toBe(later);
    expect(after.readMetadata.lastActivityAt).toBe(receipt?.admittedAt);
    expect(after.readMetadata.lastActivityAt).toBeGreaterThan(activity);
    jest.spyOn(Date, 'now').mockReturnValue(later + 1000);
    expect(
      await broker.message(
        { ...rootParent, toolCallId: 'refused-follow-up' },
        { delegationId: id, operation: 'follow_up', message: 'continue' },
      ),
    ).toEqual(refused);
    await broker['update'](id, (record) => record);
    const unchanged = await storage.loadOne(id);
    if (unchanged?.version !== 3) throw new Error('Expected v3');
    expect(unchanged.readMetadata.lastActivityAt).toBe(receipt?.admittedAt);
    await broker.close();
  });

  it('keeps a stop committed while a continuation awaits its generation lookup', async () => {
    const port = ownedPort();
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
      event: { type: 'started', nativeSessionId: 'native' },
    });
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 200,
      event: { type: 'terminal', status: 'completed', finalText: 'done' },
    });
    await settle();

    let entered: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generation = port.generation.bind(port);
    let armed = true;
    jest.spyOn(port, 'generation').mockImplementation(async (input) => {
      if (armed && input.runGeneration === 1) {
        armed = false;
        entered();
        await releaseGate;
      }
      return generation(input);
    });

    // The follow-up reply waits for its continuation, so start it unawaited.
    const followUp = broker.message(
      { ...rootParent, toolCallId: 'follow-up' },
      { delegationId: id, operation: 'follow_up', message: 'continue' },
    );
    await enteredGate;
    const stop = await broker.requestStop(
      { ...rootParent, toolCallId: 'stop-during-continuation' },
      id,
    );
    expect(stop.ok).toBe(true);
    const stopped = await storage.loadOne(id);
    if (stopped?.version !== 3) throw new Error('Expected v3');
    const stopReceipts = stopped.receipts.stopReceipts.length;
    expect(stopReceipts).toBeGreaterThan(0);
    release();
    await followUp;
    await settle();

    expect(runner.starts.some((start) => start.runGeneration === 2)).toBe(
      false,
    );
    const after = await storage.loadOne(id);
    if (after?.version !== 3) throw new Error('Expected v3');
    expect(after.receipts.stopReceipts).toHaveLength(stopReceipts);
    expect(after.state.runGeneration).toBe(1);
    await broker.close();
  });

  it('releases the slot when settlement notification fails and keeps the locator replayable', async () => {
    const storage = new FileDelegationStorage(directory);
    const errors: unknown[] = [];
    const onSettled = jest.fn(() =>
      Promise.reject(new Error('host notification failed')),
    );
    const { broker, runner } = createBrokerHarness(
      {
        ...trusted,
        capacity: 1,
        transcriptPort: ownedPort(),
        onSettled,
        onError: (error) => {
          errors.push(error);
        },
      },
      storage,
    );
    await broker.initialize();
    const first = await broker.spawn(rootParent, baseTask);
    if (!first.ok) throw new Error('Expected admission');
    const firstId = first.value.delegationId;
    await waitForLaunch(runner, firstId);
    const second = await broker.spawn(
      { ...rootParent, toolCallId: 'queued' },
      baseTask,
    );
    if (!second.ok) throw new Error('Expected queued admission');
    expect(second.value).toMatchObject({ phase: 'queued' });
    await runner.sink?.({
      delegationId: firstId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'terminal', status: 'completed', finalText: 'done' },
    });
    await waitForLaunch(runner, second.value.delegationId);
    expect(onSettled).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
    const settled = await storage.loadOne(firstId);
    if (settled?.version !== 3) throw new Error('Expected v3');
    expect(settled.latestResult).toMatchObject({ resultIndex: 1 });
    expect(settled.latestResult?.notified).toBeUndefined();
    expect(settled.settling).toBeUndefined();
    await broker.close();
  });
});
