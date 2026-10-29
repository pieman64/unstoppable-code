import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentDelegationError,
  AgentDelegationSnapshot,
  DelegationStopReason,
} from '@canopy/protocol/delegation';
import {
  delegationExitReason,
  type AgentDelegationBroker,
  type StoredDelegation,
} from '../broker';
import { createDelegationProjection } from '../projections';
import { FileDelegationStorage } from '../storage';
import type { DelegationParentContext } from '../types';
import type { FakeRunner } from './fixtures';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  rootParent,
  waitForLaunch,
  type BrokerHarness,
} from './broker-harness';

async function spawnId(
  broker: AgentDelegationBroker,
  caller: DelegationParentContext,
  description: string,
  allowNestedDelegation = false,
): Promise<string> {
  const result = await broker.spawn(caller, {
    ...baseTask,
    description,
    ...(allowNestedDelegation ? { allowNestedDelegation } : {}),
  });
  if (!result.ok) throw new Error(`Expected ${description} to be admitted`);
  return result.value.delegationId;
}

async function contextOf(
  harness: BrokerHarness,
  id: string,
  toolCallId: string,
): Promise<DelegationParentContext> {
  const context = harness.broker.childContext(
    await waitForLaunch(harness.runner, id),
    toolCallId,
  );
  if (!context) throw new Error(`Expected a caller context for ${id}`);
  return context;
}

/** root ── A (1) ── B (2) ── C (3) */
async function chain(harness: BrokerHarness): Promise<{
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly ctxA: DelegationParentContext;
}> {
  const a = await spawnId(harness.broker, rootParent, 'Plan the audit', true);
  await flushBroker();
  const ctxA = await contextOf(harness, a, 'a-1');
  const b = await spawnId(harness.broker, ctxA, 'Audit the parser', true);
  await flushBroker();
  const ctxB = await contextOf(harness, b, 'b-1');
  const c = await spawnId(harness.broker, ctxB, 'Check one fixture');
  await waitForLaunch(harness.runner, c);
  return { a, b, c, ctxA };
}

async function settled(
  broker: AgentDelegationBroker,
  id: string,
): Promise<AgentDelegationSnapshot> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = broker.inspect(rootParent, id);
    if (
      snapshot &&
      snapshot.status !== 'pending' &&
      snapshot.status !== 'running'
    )
      return snapshot;
    await flushBroker();
  }
  throw new Error(`Expected ${id} to settle`);
}

function terminatedByParent(message: string): AgentDelegationError {
  return { code: 'terminated_by_parent', message, retryable: false };
}

/** Makes the runner report its own terminal event when asked to stop. */
function reportOnStop(
  runner: FakeRunner,
  status: 'cancelled' | 'failed' | 'deadline_exceeded',
  error?: AgentDelegationError,
): void {
  jest.spyOn(runner, 'stop').mockImplementation(async (handle) => {
    runner.stopped.push(handle.runId);
    await runner.sinks.get(handle.runId)?.({
      delegationId: handle.runId,
      runGeneration: 1,
      sequence: 50,
      occurredAt: Date.now(),
      event: { type: 'terminal', status, ...(error ? { error } : {}) },
    });
    return { stopped: true };
  });
}

const streamEnded: AgentDelegationError = {
  code: 'runtime_error',
  message: 'The delegated SDK stream ended before completion.',
  retryable: false,
};

describe('who stopped a delegation', () => {
  it('records an agent stop from the root chat through the Stop Delegate tool', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const child = await spawnId(broker, rootParent, 'Review the parser');
      await flushBroker();
      const projection = createDelegationProjection('claude', 'test', broker);
      await expect(
        projection.invoke(rootParent, 'test_stop_delegate', {
          delegationId: child,
        }),
      ).resolves.toMatchObject({ ok: true });
      const snapshot = await settled(broker, child);
      expect(snapshot).toMatchObject({
        status: 'cancelled',
        stopReason: 'stopped_by_parent',
        cancelledByUser: false,
        stoppedBy: { kind: 'agent', depth: 0 },
        error: terminatedByParent('Stopped by the parent chat.'),
      });
      expect(snapshot.stoppedBy).toEqual({ kind: 'agent', depth: 0 });
      expect(
        broker.getOutput(rootParent, { delegationId: child }),
      ).toMatchObject({
        ok: true,
        value: {
          result: {
            status: 'cancelled',
            error: terminatedByParent('Stopped by the parent chat.'),
          },
        },
      });
    } finally {
      await broker.close();
    }
  });

  it('names the stopping delegate and cascades ancestor_stopped to its subtree', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const { a, b, c, ctxA } = await chain(harness);
      const stopped = await broker.stop(
        { ...ctxA, toolCallId: 'a-stop' },
        b,
        'stopped_by_parent',
      );
      expect(stopped).toMatchObject({ ok: true });
      const stoppedBy = {
        kind: 'agent',
        depth: 1,
        delegationId: a,
        description: 'Plan the audit',
      };
      expect(broker.inspect(rootParent, b)).toMatchObject({
        status: 'cancelled',
        stopReason: 'stopped_by_parent',
        cancelledByUser: false,
        stoppedBy,
        error: terminatedByParent(
          "Stopped by its parent delegate 'Plan the audit' (depth 1).",
        ),
      });
      expect(broker.inspect(rootParent, c)).toMatchObject({
        status: 'cancelled',
        stopReason: 'ancestor_stopped',
        cancelledByUser: false,
        stoppedBy,
        error: terminatedByParent(
          "Stopped because its ancestor 'Audit the parser' was stopped.",
        ),
      });
      // The stopping delegate itself keeps running.
      expect(broker.inspect(rootParent, a)?.status).toBe('pending');
      expect(broker.inspect(rootParent, a)).not.toHaveProperty('stopReason');
    } finally {
      await broker.close();
    }
  });

  it('keeps user_cancelled for a user stop and tells descendants the user stopped their ancestor', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const { a, b, c } = await chain(harness);
      expect(await broker.stop(rootParent, a)).toMatchObject({ ok: true });
      const target = broker.inspect(rootParent, a);
      expect(target).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
        cancelledByUser: true,
        stoppedBy: { kind: 'user' },
      });
      expect(target?.error).toBeUndefined();
      for (const id of [b, c])
        expect(broker.inspect(rootParent, id)).toMatchObject({
          status: 'cancelled',
          stopReason: 'ancestor_stopped',
          cancelledByUser: false,
          stoppedBy: { kind: 'user' },
          error: terminatedByParent(
            "Stopped because you stopped 'Plan the audit'.",
          ),
        });
    } finally {
      await broker.close();
    }
  });

  it('describes a cascade from the root agent by the stopped ancestor', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const { a, b } = await chain(harness);
      await broker.stop(rootParent, a, 'stopped_by_parent');
      expect(broker.inspect(rootParent, a)).toMatchObject({
        stopReason: 'stopped_by_parent',
        stoppedBy: { kind: 'agent', depth: 0 },
        error: terminatedByParent('Stopped by the parent chat.'),
      });
      expect(broker.inspect(rootParent, b)).toMatchObject({
        stopReason: 'ancestor_stopped',
        stoppedBy: { kind: 'agent', depth: 0 },
        error: terminatedByParent(
          "Stopped because its ancestor 'Plan the audit' was stopped.",
        ),
      });
    } finally {
      await broker.close();
    }
  });

  it.each([
    ['stopped_by_parent', 'cancelled'],
    ['stopped_by_parent', 'failed'],
    ['stopped_by_parent', 'deadline_exceeded'],
    ['user_cancelled', 'cancelled'],
    ['user_cancelled', 'failed'],
    ['user_cancelled', 'deadline_exceeded'],
  ] as const)(
    'settles a %s stop as cancelled when the runner reports %s with its own error first',
    async (reason: DelegationStopReason, reported) => {
      const harness = createBrokerHarness();
      const { broker, runner } = harness;
      await broker.initialize();
      try {
        const child = await spawnId(broker, rootParent, 'Review the parser');
        await flushBroker();
        reportOnStop(runner, reported, streamEnded);
        expect(await broker.stop(rootParent, child, reason)).toMatchObject({
          ok: true,
        });
        const snapshot = broker.inspect(rootParent, child);
        expect(snapshot).toMatchObject({
          status: 'cancelled',
          stopReason: reason,
        });
        if (reason === 'user_cancelled') {
          expect(snapshot?.error).toBeUndefined();
          expect(snapshot?.cancelledByUser).toBe(true);
        } else
          expect(snapshot?.error).toEqual(
            terminatedByParent('Stopped by the parent chat.'),
          );
      } finally {
        await broker.close();
      }
    },
  );

  it('still settles deadline_exceeded when the deadline itself is the stop reason and nothing attributed wins', async () => {
    const harness = createBrokerHarness();
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const child = await spawnId(broker, rootParent, 'Review the parser');
      await flushBroker();
      reportOnStop(runner, 'deadline_exceeded', streamEnded);
      expect(
        await broker.stop(rootParent, child, 'deadline_exceeded'),
      ).toMatchObject({ ok: true });
      const snapshot = broker.inspect(rootParent, child);
      expect(snapshot).toMatchObject({
        status: 'deadline_exceeded',
        stopReason: 'deadline_exceeded',
        cancelledByUser: false,
      });
      expect(snapshot).not.toHaveProperty('stoppedBy');
    } finally {
      await broker.close();
    }
  });

  it('overrides the runner error on a cascaded descendant too', async () => {
    const harness = createBrokerHarness();
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const { a, b } = await chain(harness);
      reportOnStop(runner, 'cancelled', streamEnded);
      await broker.stop(rootParent, a);
      expect(broker.inspect(rootParent, b)?.error).toEqual(
        terminatedByParent("Stopped because you stopped 'Plan the audit'."),
      );
      expect(broker.inspect(rootParent, a)?.error).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('sets the error on queued work that never started a run', async () => {
    const harness = createBrokerHarness({ capacity: 1 });
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      await spawnId(broker, rootParent, 'Holds the only slot');
      const queued = await spawnId(
        broker,
        { ...rootParent, toolCallId: 'queued' },
        'Waits for a slot',
      );
      expect(broker.inspect(rootParent, queued)?.phase).toBe('queued');
      await broker.stop(rootParent, queued, 'stopped_by_parent');
      const snapshot = await settled(broker, queued);
      expect(snapshot).toMatchObject({
        status: 'cancelled',
        stopReason: 'stopped_by_parent',
        stoppedBy: { kind: 'agent', depth: 0 },
        error: terminatedByParent('Stopped by the parent chat.'),
      });
      expect(
        runner.starts.some((request) => request.delegationId === queued),
      ).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it('leaves host lifecycle reasons unattributed', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const { a, b } = await chain(harness);
      await broker.stop(rootParent, a, 'policy_revoked');
      for (const id of [a, b]) {
        const snapshot = broker.inspect(rootParent, id);
        expect(snapshot).toMatchObject({
          status: 'cancelled',
          stopReason: 'policy_revoked',
          cancelledByUser: false,
        });
        expect(snapshot).not.toHaveProperty('stoppedBy');
        expect(snapshot?.error).toBeUndefined();
      }
    } finally {
      await broker.close();
    }
  });
});

describe('persisted stop attribution', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'delegation-stop-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips reasons, stoppedBy, the error and each result’s exit reason', async () => {
    const storage = new FileDelegationStorage(path.join(directory, 'runs'));
    const harness = createBrokerHarness({}, storage);
    await harness.broker.initialize();
    const { a, b, c, ctxA } = await chain(harness);
    await harness.broker.stop(ctxA, b, 'stopped_by_parent');
    await harness.broker.close();

    const records = await new FileDelegationStorage(
      path.join(directory, 'runs'),
    ).load();
    const byId = (id: string): StoredDelegation => {
      const record = records.find(
        (candidate) => candidate.state.delegationId === id,
      );
      if (!record) throw new Error(`Expected a persisted record for ${id}`);
      return record;
    };
    const stoppedBy = {
      kind: 'agent',
      depth: 1,
      delegationId: a,
      description: 'Plan the audit',
    };
    expect(byId(b).state).toMatchObject({
      stopReason: 'stopped_by_parent',
      cancelledByUser: false,
      stoppedBy,
      error: { code: 'terminated_by_parent' },
    });
    expect(byId(c).state).toMatchObject({
      stopReason: 'ancestor_stopped',
      stoppedBy,
    });
    expect(byId(b).results?.[0]).toMatchObject({
      status: 'cancelled',
      stopReason: 'stopped_by_parent',
      error: { code: 'terminated_by_parent' },
    });
    expect(delegationExitReason(byId(b), 1)).toBe('stopped_by_parent');
    expect(delegationExitReason(byId(c), 1)).toBe('ancestor_stopped');

    const restored = createBrokerHarness(
      {},
      new FileDelegationStorage(path.join(directory, 'runs')),
    );
    await restored.broker.initialize();
    try {
      expect(restored.broker.inspect(rootParent, c)).toMatchObject({
        stopReason: 'ancestor_stopped',
        stoppedBy,
        error: terminatedByParent(
          "Stopped because its ancestor 'Audit the parser' was stopped.",
        ),
      });
      const output = restored.broker.getOutput(rootParent, { delegationId: b });
      // The retained exit reason stays private to the host.
      expect(output.ok && output.value.result).not.toHaveProperty('stopReason');
    } finally {
      await restored.broker.close();
    }
  });

  it('still reads records written before stop attribution existed', async () => {
    const storage = new FileDelegationStorage(path.join(directory, 'runs'));
    const harness = createBrokerHarness({}, storage);
    await harness.broker.initialize();
    const child = await spawnId(harness.broker, rootParent, 'Legacy child');
    await flushBroker();
    await harness.broker.stop(rootParent, child, 'parent_cancelled');
    await harness.broker.close();
    const [record] = await storage.load();
    if (!record) throw new Error('Expected a persisted record');
    const { stoppedBy: _stoppedBy, ...legacyState } = record.state;
    void _stoppedBy;
    const legacy: StoredDelegation = {
      ...record,
      state: legacyState,
      results: record.results?.map(({ stopReason: _reason, ...result }) => {
        void _reason;
        return result;
      }),
    };
    await storage.commit(legacy);
    const [loaded] = await storage.load();
    expect(loaded?.state.stopReason).toBe('parent_cancelled');
    expect(loaded?.results?.[0]).not.toHaveProperty('stopReason');
    // The exit reason falls back to the current generation's state.
    if (!loaded) throw new Error('Expected the legacy record to load');
    expect(delegationExitReason(loaded, 1)).toBe('parent_cancelled');
    expect(delegationExitReason(loaded, 2)).toBeUndefined();
  });

  it('rejects a stoppedBy that does not match its stop reason', async () => {
    const storage = new FileDelegationStorage(path.join(directory, 'runs'));
    const harness = createBrokerHarness({}, storage);
    await harness.broker.initialize();
    await spawnId(harness.broker, rootParent, 'Stopped child');
    await flushBroker();
    await harness.broker.close();
    const [record] = await storage.load();
    if (!record) throw new Error('Expected a persisted record');
    expect(record.state.stopReason).toBe('shutdown');
    for (const state of [
      // Attribution without a stop reason.
      {
        ...record.state,
        stopReason: undefined,
        cancelledByUser: undefined,
        stoppedBy: { kind: 'user' as const },
      },
      // A host lifecycle stop is never attributed.
      { ...record.state, stoppedBy: { kind: 'user' as const } },
      // An agent stop is never a user cancellation.
      {
        ...record.state,
        stopReason: 'stopped_by_parent' as const,
        stoppedBy: { kind: 'user' as const },
      },
      // Depths stay within the delegation bound.
      {
        ...record.state,
        stopReason: 'stopped_by_parent' as const,
        stoppedBy: { kind: 'agent' as const, depth: 12 },
      },
    ])
      await expect(storage.commit({ ...record, state })).rejects.toThrow();
    await expect(
      storage.commit({
        ...record,
        state: {
          ...record.state,
          stopReason: 'ancestor_stopped',
          stoppedBy: { kind: 'user' },
          error: {
            code: 'terminated_by_parent',
            message: "Stopped because you stopped 'Plan the audit'.",
            retryable: false,
          },
        },
      }),
    ).resolves.toBeUndefined();
  });
});
