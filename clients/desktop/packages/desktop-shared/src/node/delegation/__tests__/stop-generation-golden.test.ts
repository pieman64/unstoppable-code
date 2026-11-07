import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { AgentDelegationBroker, StoredDelegation } from '../broker';
import type { DelegationStopReceipt, NativeRunHandle } from '../types';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
} from './broker-harness';
import { type FakeRunner, routeFixture } from './fixtures';

interface Harness {
  readonly broker: AgentDelegationBroker;
  readonly runner: FakeRunner;
  readonly id: string;
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await flushBroker();
}

async function send(
  harness: Harness,
  runGeneration: number,
  sequence: number,
  event: AgentDelegationEvent['event'],
): Promise<void> {
  const sink = harness.runner.sinks.get(harness.id);
  if (!sink) throw new Error(`Missing event sink for ${harness.id}`);
  await sink({
    delegationId: harness.id,
    runGeneration,
    sequence,
    occurredAt: sequence,
    event,
  });
}

/** Memory storage that can hold the first commit of one run generation. */
class GatedStorage extends MemoryDelegationStorage {
  heldGeneration: number | undefined;
  private release: (() => void) | undefined;
  private held: Promise<void> | undefined;

  override async commit(record: StoredDelegation): Promise<void> {
    if (record.state.runGeneration === this.heldGeneration) {
      this.heldGeneration = undefined;
      this.held = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      await this.held;
    }
    return super.commit(record);
  }

  isHolding(): boolean {
    return this.release !== undefined;
  }

  releaseHeld(): void {
    this.release?.();
    this.release = undefined;
  }
}

/** A resumable delegation whose first generation has started. */
async function startedDelegation(
  storage: MemoryDelegationStorage = new MemoryDelegationStorage(),
): Promise<Harness> {
  const { broker, runner } = createBrokerHarness(
    {
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
  if (!spawned.ok) throw new Error('Expected the delegation to be admitted');
  await flushBroker();
  const harness = { broker, runner, id: spawned.value.delegationId };
  await send(harness, 1, 1, { type: 'started', nativeSessionId: 'native-1' });
  return harness;
}

async function followUp(harness: Harness): Promise<void> {
  const accepted = await harness.broker.message(
    { ...rootParent, turnId: 'turn-2', toolCallId: 'follow-up' },
    { delegationId: harness.id, operation: 'follow_up', message: 'Again.' },
  );
  if (!accepted.ok) throw new Error('Expected the follow-up to be accepted');
  await settle();
}

function launchedGenerations(harness: Harness): number[] {
  return harness.runner.starts
    .filter((request) => request.delegationId === harness.id)
    .map((request) => request.runGeneration);
}

describe('generation-bound broker stops (CAN-5867)', () => {
  it('a continuation that starts while the native stop is pending keeps running', async () => {
    const harness = await startedDelegation();
    let releaseStop = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const nativeStop = harness.runner.stop.bind(harness.runner);
    harness.runner.stop = async (
      handle: NativeRunHandle,
    ): Promise<DelegationStopReceipt> => {
      await held;
      return nativeStop(handle);
    };

    const stopping = harness.broker.stop(
      rootParent,
      harness.id,
      'user_cancelled',
      { expectedRunGeneration: 1 },
    );
    await settle();
    // Generation 1 finishes on its own and a follow-up starts generation 2
    // while the stop still waits on the native stop.
    await send(harness, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'First answer.',
    });
    await settle();
    await followUp(harness);
    expect(launchedGenerations(harness)).toEqual([1, 2]);

    releaseStop();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    await settle();

    expect(harness.broker.inspect(rootParent, harness.id)).toMatchObject({
      runGeneration: 2,
    });
    expect(harness.broker.inspect(rootParent, harness.id)?.status).not.toBe(
      'cancelled',
    );
    expect(harness.runner.stopped).toHaveLength(1);
  });

  it('an unconfirmed native stop leaves a continuation that started meanwhile running', async () => {
    const harness = await startedDelegation();
    let releaseStop = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    harness.runner.stop = async (): Promise<DelegationStopReceipt> => {
      await held;
      return {
        stopped: false,
        error: {
          code: 'runtime_error',
          message: 'The native stop was not confirmed.',
          retryable: false,
        },
      };
    };

    const stopping = harness.broker.stop(
      rootParent,
      harness.id,
      'user_cancelled',
      { expectedRunGeneration: 1 },
    );
    await settle();
    await send(harness, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'First answer.',
    });
    await settle();
    await followUp(harness);

    releaseStop();
    await expect(stopping).resolves.toMatchObject({ ok: false });
    await settle();

    const current = harness.broker.inspect(rootParent, harness.id);
    expect(current).toMatchObject({ runGeneration: 2 });
    expect(current?.status).not.toBe('interrupted');
    expect(current?.status).not.toBe('cancelled');
  });

  it('an unconfirmed native stop leaves a continuation whose write is still queued', async () => {
    const storage = new GatedStorage();
    const harness = await startedDelegation(storage);
    let releaseStop = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    harness.runner.stop = async (): Promise<DelegationStopReceipt> => {
      await held;
      return {
        stopped: false,
        error: {
          code: 'runtime_error',
          message: 'The native stop was not confirmed.',
          retryable: false,
        },
      };
    };

    const stopping = harness.broker.stop(
      rootParent,
      harness.id,
      'user_cancelled',
      { expectedRunGeneration: 1 },
    );
    await settle();
    await send(harness, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'First answer.',
    });
    await settle();
    // Generation 2's first write waits in the queue, so the record still
    // reads generation 1 when the native stop fails.
    storage.heldGeneration = 2;
    const following = harness.broker.message(
      { ...rootParent, turnId: 'turn-2', toolCallId: 'follow-up' },
      { delegationId: harness.id, operation: 'follow_up', message: 'Again.' },
    );
    for (let attempt = 0; attempt < 50 && !storage.isHolding(); attempt += 1)
      await flushBroker();
    expect(storage.isHolding()).toBe(true);

    releaseStop();
    await settle();
    storage.releaseHeld();
    await expect(stopping).resolves.toMatchObject({ ok: false });
    await expect(following).resolves.toMatchObject({ ok: true });
    await settle();

    const current = harness.broker.inspect(rootParent, harness.id);
    expect(current).toMatchObject({ runGeneration: 2 });
    expect(current?.status).not.toBe('interrupted');
  });

  it('a stop for a generation the delegation has left changes nothing', async () => {
    const harness = await startedDelegation();
    await send(harness, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'First answer.',
    });
    await settle();
    await followUp(harness);

    await expect(
      harness.broker.stop(rootParent, harness.id, 'user_cancelled', {
        expectedRunGeneration: 1,
      }),
    ).resolves.toMatchObject({ ok: true, value: { runGeneration: 2 } });
    await settle();

    expect(harness.broker.inspect(rootParent, harness.id)?.status).not.toBe(
      'cancelled',
    );
    expect(harness.runner.stopped).toEqual([]);
  });

  it('a stop without an expected generation stops the current generation', async () => {
    const harness = await startedDelegation();
    await send(harness, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'First answer.',
    });
    await settle();
    await followUp(harness);
    await send(harness, 2, 1, { type: 'started', nativeSessionId: 'native-1' });

    await expect(
      harness.broker.stop(rootParent, harness.id, 'user_cancelled'),
    ).resolves.toMatchObject({
      ok: true,
      value: { runGeneration: 2, status: 'cancelled' },
    });
    expect(harness.runner.stopped).toEqual([harness.id]);
  });
});
