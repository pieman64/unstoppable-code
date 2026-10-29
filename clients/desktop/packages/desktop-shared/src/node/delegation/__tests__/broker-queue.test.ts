import type {
  AgentDelegationEvent,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import type { DelegationParentContext } from '../types';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '../broker';
import { AgentRunnerRegistry } from '../runner-registry';
import { createDelegationAdmissionController } from '../queue-admission';
import { createDelegationProjection } from '../projections';
import { FakeRunner, routeFixture } from './fixtures';

const parent: DelegationParentContext = {
  harnessId: 'claude',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  runtimeGeneration: 1,
  depth: 0,
};

const task: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Review the supplied task',
  prompt: 'Read src/index.ts and identify missing error handling.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

const resumableRoute = (): ReturnType<
  AgentDelegationBrokerOptions['resolveRoute']
> =>
  Promise.resolve({
    ok: true,
    value: routeFixture({ capabilities: ['read', 'write', 'resume'] }),
  });

class MemoryStorage implements DelegationStorage {
  readonly records = new Map<string, StoredDelegation>();
  readonly commits: StoredDelegation[] = [];
  load(): Promise<readonly StoredDelegation[]> {
    return Promise.resolve(structuredClone(Array.from(this.records.values())));
  }
  commit(record: StoredDelegation): Promise<void> {
    const copy = structuredClone(record);
    this.records.set(copy.state.delegationId, copy);
    this.commits.push(copy);
    return Promise.resolve();
  }
}

/** Fails the next commit once, as a full disk or a removed record would. */
class FailingOnceStorage extends MemoryStorage {
  failNextCommit = false;
  override commit(record: StoredDelegation): Promise<void> {
    if (!this.failNextCommit) return super.commit(record);
    this.failNextCommit = false;
    return Promise.reject(new Error('The storage commit failed.'));
  }
}

/**
 * Holds the first commit that grants one record's queued admission, leaving
 * the in-memory record queued until the test releases it.
 */
class GrantGateStorage extends MemoryStorage {
  private target?: string;
  private releaseGrant?: () => void;
  private reportHeld?: () => void;
  held: Promise<void> = Promise.resolve();

  holdGrantOf(delegationId: string): void {
    this.target = delegationId;
    this.held = new Promise((resolve) => {
      this.reportHeld = resolve;
    });
  }

  release(): void {
    this.releaseGrant?.();
  }

  override commit(record: StoredDelegation): Promise<void> {
    if (
      this.target !== record.state.delegationId ||
      record.admission?.state !== 'granted'
    )
      return super.commit(record);
    this.target = undefined;
    const gate = new Promise<void>((resolve) => {
      this.releaseGrant = resolve;
    });
    this.reportHeld?.();
    return gate.then(() => super.commit(record));
  }
}

function setup(
  storage = new MemoryStorage(),
  options: Partial<AgentDelegationBrokerOptions> = {},
): {
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  storage: MemoryStorage;
} {
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const broker = new AgentDelegationBroker({
    storage,
    registry,
    cwd: '/test/worktree',
    capacity: 2,
    resolveRoute: (): Promise<{
      ok: true;
      value: ReturnType<typeof routeFixture>;
    }> => Promise.resolve({ ok: true, value: routeFixture() }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
    ...options,
  });
  return { broker, runner, storage };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function startedEvent(
  delegationId: string,
  runGeneration: number,
  sequence: number,
  occurredAt: number,
  nativeSessionId: string,
): AgentDelegationEvent {
  return {
    delegationId,
    runGeneration,
    sequence,
    occurredAt,
    event: { type: 'started', nativeSessionId },
  };
}

function terminalEvent(
  delegationId: string,
  runGeneration: number,
  sequence: number,
  occurredAt: number,
): AgentDelegationEvent {
  return {
    delegationId,
    runGeneration,
    sequence,
    occurredAt,
    event: { type: 'terminal', status: 'completed' },
  };
}

describe('delegation broker queued admission', () => {
  it('queues an over-limit spawn and starts queued work in FIFO order as slots free', async () => {
    const { broker, runner } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected first admission');
      await flush();
      expect(runner.starts).toHaveLength(1);

      const second = await broker.spawn(
        { ...parent, toolCallId: 'second' },
        task,
      );
      const third = await broker.spawn(
        { ...parent, toolCallId: 'third' },
        task,
      );
      if (!second.ok || !third.ok) throw new Error('Expected queued admission');
      expect(second.value).toMatchObject({
        status: 'pending',
        phase: 'queued',
      });
      expect(second.value.queue).toMatchObject({
        id: 'default',
        name: 'Default',
        position: 1,
        waitingFor: 'queue',
      });
      expect(third.value.queue).toMatchObject({
        position: 2,
        waitingFor: 'queue',
      });
      await flush();
      expect(runner.starts).toHaveLength(1);

      await runner.sink?.(terminalEvent(first.value.delegationId, 1, 1, 1));
      await flush();
      expect(runner.starts).toHaveLength(2);
      expect(runner.starts[1]?.delegationId).toBe(second.value.delegationId);
      expect(broker.inspect(parent, second.value.delegationId)).toMatchObject({
        phase: 'starting',
      });
      expect(broker.inspect(parent, third.value.delegationId)).toMatchObject({
        phase: 'queued',
      });
      expect(
        broker.inspect(parent, third.value.delegationId)?.queue,
      ).toMatchObject({ position: 1 });

      await runner.sink?.(terminalEvent(second.value.delegationId, 1, 1, 2));
      await flush();
      expect(runner.starts).toHaveLength(3);
      expect(runner.starts[2]?.delegationId).toBe(third.value.delegationId);
    } finally {
      await broker.close();
    }
  });

  it('applies a host cap across two root chats and grants the oldest eligible waiter first', async () => {
    const shared = createDelegationAdmissionController({
      limitForBucket: (): number => 5,
      hostCapacity: (): number => 1,
    });
    const { broker, runner } = setup(new MemoryStorage(), {
      admission: shared,
    });
    await broker.initialize();
    try {
      const chatA = { ...parent, chatId: 'chat-a' };
      const chatB = { ...parent, chatId: 'chat-b', toolCallId: 'call-b' };
      const first = await broker.spawn(chatA, task);
      if (!first.ok) throw new Error('Expected admission for the first chat');
      await flush();
      expect(runner.starts).toHaveLength(1);

      const second = await broker.spawn(chatB, task);
      if (!second.ok) throw new Error('Expected queued admission');
      expect(second.value.phase).toBe('queued');
      expect(second.value.queue).toMatchObject({ waitingFor: 'app' });

      await runner.sink?.(terminalEvent(first.value.delegationId, 1, 1, 1));
      await flush();
      expect(runner.starts).toHaveLength(2);
      expect(runner.starts[1]?.delegationId).toBe(second.value.delegationId);
    } finally {
      await broker.close();
    }
  });

  it('shares a host cap across two brokers for different worktrees through one controller', async () => {
    const shared = createDelegationAdmissionController({
      limitForBucket: (): number => 5,
      hostCapacity: (): number => 1,
    });
    const a = setup(new MemoryStorage(), { admission: shared });
    const b = setup(new MemoryStorage(), { admission: shared });
    await a.broker.initialize();
    await b.broker.initialize();
    try {
      const parentA = { ...parent, worktreeId: 'worktree-a' };
      const parentB = { ...parent, worktreeId: 'worktree-b' };
      const first = await a.broker.spawn(parentA, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      expect(a.runner.starts).toHaveLength(1);

      const second = await b.broker.spawn(parentB, task);
      if (!second.ok) throw new Error('Expected queued admission');
      expect(second.value.phase).toBe('queued');
      expect(b.runner.starts).toHaveLength(0);

      await a.runner.sink?.(terminalEvent(first.value.delegationId, 1, 1, 1));
      await flush();
      expect(b.runner.starts).toHaveLength(1);
    } finally {
      await a.broker.close();
      await b.broker.close();
    }
  });

  it('rejects a spawn at the limit with ifBusy reject and commits no record', async () => {
    const { broker } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      expect(
        await broker.spawn(
          { ...parent, toolCallId: 'rejected' },
          { ...task, ifBusy: 'reject' },
        ),
      ).toMatchObject({ ok: false, error: { code: 'capacity_exceeded' } });
      expect(broker.list(parent)).toHaveLength(1);
    } finally {
      await broker.close();
    }
  });

  it('rejects an idle follow_up with ifBusy reject at the limit without persisting a control', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const idleChild = await broker.spawn(parent, task);
      if (!idleChild.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(idleChild.value.delegationId, 1, 1, 1, 'native-idle'),
      );
      await runner.sink?.(terminalEvent(idleChild.value.delegationId, 1, 2, 2));
      await flush();

      const busy = await broker.spawn({ ...parent, toolCallId: 'busy' }, task);
      if (!busy.ok)
        throw new Error('Expected admission for the occupying child');
      await flush();
      expect(runner.starts).toHaveLength(2);

      const result = await broker.message(parent, {
        delegationId: idleChild.value.delegationId,
        operation: 'follow_up',
        message: 'Keep going.',
        if_busy: 'reject',
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });
      const afterReject = broker.inspect(parent, idleChild.value.delegationId);
      expect(afterReject?.control).toBeUndefined();
      expect(afterReject?.runGeneration).toBe(1);
    } finally {
      await broker.close();
    }
  });

  it('honors if_busy through the Message Delegate tool, which the broker parses again', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const idleChild = await broker.spawn(parent, task);
      if (!idleChild.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(idleChild.value.delegationId, 1, 1, 1, 'native-idle'),
      );
      await runner.sink?.(terminalEvent(idleChild.value.delegationId, 1, 2, 2));
      await flush();
      const busy = await broker.spawn({ ...parent, toolCallId: 'busy' }, task);
      if (!busy.ok)
        throw new Error('Expected admission for the occupying child');
      await flush();

      // The tool parses its input and hands the normalized request to the
      // broker, which parses it again; if_busy must survive both.
      const projection = createDelegationProjection('claude', 'test', broker);
      const result = await projection.invoke(parent, 'test_message_delegate', {
        delegationId: idleChild.value.delegationId,
        operation: 'follow_up',
        message: 'Keep going.',
        if_busy: 'reject',
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });
    } finally {
      await broker.close();
    }
  });

  it('stops queued work without a native call and starts the next waiter', async () => {
    const { broker, runner } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      const queued = await broker.spawn(
        { ...parent, toolCallId: 'queued' },
        task,
      );
      const behind = await broker.spawn(
        { ...parent, toolCallId: 'behind' },
        task,
      );
      if (!queued.ok || !behind.ok)
        throw new Error('Expected queued admission');
      expect(queued.value.phase).toBe('queued');

      const stopped = await broker.requestStop(
        parent,
        queued.value.delegationId,
      );
      expect(stopped.ok).toBe(true);
      await flush();
      expect(broker.inspect(parent, queued.value.delegationId)).toMatchObject({
        status: 'cancelled',
        stopReason: 'user_cancelled',
        cancelledByUser: true,
      });
      expect(
        runner.starts.some(
          (request) => request.delegationId === queued.value.delegationId,
        ),
      ).toBe(false);
      expect(runner.stopped).toEqual([]);
      expect(
        broker.inspect(parent, behind.value.delegationId)?.queue,
      ).toMatchObject({ position: 1 });

      await runner.sink?.(terminalEvent(first.value.delegationId, 1, 1, 1));
      await flush();
      expect(
        runner.starts.some(
          (request) => request.delegationId === behind.value.delegationId,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('interrupts queued work as interrupted rather than cancelled', async () => {
    const { broker } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      const queued = await broker.spawn(
        { ...parent, toolCallId: 'queued' },
        task,
      );
      if (!queued.ok) throw new Error('Expected queued admission');

      const result = await broker.manage(parent, {
        delegationId: queued.value.delegationId,
        operation: 'interrupt',
      });
      expect(result.ok).toBe(true);
      await flush();
      expect(broker.inspect(parent, queued.value.delegationId)).toMatchObject({
        status: 'interrupted',
      });
      expect(
        broker.inspect(parent, queued.value.delegationId)?.stopReason,
      ).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('cancels queued work with parent_cancelled when its owner closes', async () => {
    const { broker } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    const first = await broker.spawn(parent, task);
    if (!first.ok) throw new Error('Expected admission');
    await flush();
    const queued = await broker.spawn(
      { ...parent, toolCallId: 'queued' },
      task,
    );
    if (!queued.ok) throw new Error('Expected queued admission');
    await broker.closeOwner(parent, 'parent_cancelled');
    expect(broker.inspect(parent, queued.value.delegationId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'parent_cancelled',
    });
    await broker.close();
  });

  it('includes a queued nested descendant when stopping a subtree', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      maxDepthForParent: (): number => 3,
    });
    await broker.initialize();
    try {
      const rootSpawn = await broker.spawn(parent, {
        ...task,
        allowNestedDelegation: true,
      });
      if (!rootSpawn.ok) throw new Error('Expected root admission');
      await flush();
      const child = broker.childContext(runner.starts[0], 'nested-call');
      if (!child) throw new Error('Expected child context');
      const nestedQueued = await broker.spawn(child, task);
      if (!nestedQueued.ok) throw new Error('Expected queued nested admission');
      expect(nestedQueued.value.phase).toBe('queued');

      const stopped = await broker.stop(parent, rootSpawn.value.delegationId);
      expect(stopped.ok).toBe(true);
      expect(
        broker.inspect(parent, nestedQueued.value.delegationId),
      ).toMatchObject({ status: 'cancelled' });
      expect(
        runner.starts.some(
          (request) => request.delegationId === nestedQueued.value.delegationId,
        ),
      ).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it.each([
    ['its owner closes', 'parent_cancelled'],
    ['the broker shuts down', 'shutdown'],
  ] as const)(
    'cancels a queued continuation rather than failing it when %s',
    async (_event, stopReason) => {
      const { broker, runner } = setup(new MemoryStorage(), {
        capacity: 1,
        asyncAdmission: true,
        resolveRoute: resumableRoute,
      });
      await broker.initialize();
      const target = await broker.spawn(parent, task);
      if (!target.ok) throw new Error('Expected admission');
      const targetId = target.value.delegationId;
      await flush();
      await runner.sink?.(startedEvent(targetId, 1, 1, 1, 'native-target'));
      await runner.sink?.(terminalEvent(targetId, 1, 2, 2));
      await flush();
      const blocker = await broker.spawn(
        { ...parent, toolCallId: 'blocker' },
        task,
      );
      if (!blocker.ok) throw new Error('Expected admission');
      await flush();
      const delivered = await broker.deliverHostMessage(
        targetId,
        'Continue.',
        'attempt-1',
      );
      expect(delivered.ok).toBe(true);
      await flush();
      expect(broker.inspect(parent, targetId)).toMatchObject({
        runGeneration: 2,
        phase: 'queued',
      });

      if (stopReason === 'shutdown') await broker.close();
      else await broker.closeOwner(parent, stopReason);
      await flush();
      expect(broker.inspect(parent, targetId)).toMatchObject({
        runGeneration: 2,
        status: 'cancelled',
        stopReason,
      });
      if (stopReason !== 'shutdown') await broker.close();
    },
  );

  it('durably cancels queued work on close with shutdown as the reason', async () => {
    const { broker } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    const first = await broker.spawn(parent, task);
    if (!first.ok) throw new Error('Expected admission');
    await flush();
    const queued = await broker.spawn(
      { ...parent, toolCallId: 'queued' },
      task,
    );
    if (!queued.ok) throw new Error('Expected queued admission');
    await broker.close();
    expect(broker.inspect(parent, queued.value.delegationId)).toMatchObject({
      status: 'cancelled',
      stopReason: 'shutdown',
    });
  });

  it('settles a crash-recovered queued record as cancelled/shutdown instead of interrupted/launch_uncertain', async () => {
    const storage = new MemoryStorage();
    const first = setup(storage, { capacity: 1 });
    await first.broker.initialize();
    const initial = await first.broker.spawn(parent, task);
    if (!initial.ok) throw new Error('Expected admission');
    await flush();
    const queuedSpawn = await first.broker.spawn(
      { ...parent, toolCallId: 'queued' },
      task,
    );
    if (!queuedSpawn.ok) throw new Error('Expected queued admission');
    // Simulate a crash: snapshot storage before any graceful shutdown runs.
    const crashed = new MemoryStorage();
    for (const [id, record] of Array.from(storage.records))
      crashed.records.set(id, structuredClone(record));
    await first.broker.close();

    const restored = setup(crashed, { capacity: 1 });
    await restored.broker.initialize();
    const recovered = restored.broker.inspect(
      parent,
      queuedSpawn.value.delegationId,
    );
    expect(recovered).toMatchObject({
      status: 'cancelled',
      stopReason: 'shutdown',
      cancelledByUser: false,
    });
    expect(recovered?.error).toBeUndefined();
    await restored.broker.close();
  });

  it('lets a queued nested child survive its parent moving to a new run generation', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      maxDepthForParent: (): number => 3,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const rootSpawn = await broker.spawn(parent, {
        ...task,
        allowNestedDelegation: true,
      });
      if (!rootSpawn.ok) throw new Error('Expected root admission');
      await flush();
      await runner.sink?.(
        startedEvent(rootSpawn.value.delegationId, 1, 1, 1, 'native-root'),
      );
      const child = broker.childContext(runner.starts[0], 'nested-call');
      if (!child) throw new Error('Expected child context');

      const nestedQueued = await broker.spawn(child, task);
      if (!nestedQueued.ok) throw new Error('Expected queued nested admission');
      expect(nestedQueued.value.phase).toBe('queued');

      // Accepted while the root is still running: this inherits root's
      // slot by handoff at run end instead of releasing it to the general
      // queue, so the nested child (queued earlier) is not the one that
      // grabs it when generation 1 ends.
      const followUp = await broker.manage(
        { ...parent, turnId: 'follow-turn', toolCallId: 'follow' },
        {
          delegationId: rootSpawn.value.delegationId,
          operation: 'follow_up',
          message: 'Continue.',
        },
      );
      expect(followUp).toMatchObject({
        ok: true,
        value: { control: { status: 'accepted' } },
      });

      await runner.sink?.(terminalEvent(rootSpawn.value.delegationId, 1, 2, 2));
      await flush();
      expect(
        broker.inspect(parent, rootSpawn.value.delegationId),
      ).toMatchObject({ runGeneration: 2 });
      expect(
        broker.inspect(parent, nestedQueued.value.delegationId),
      ).toMatchObject({ phase: 'queued' });

      await runner.sink?.(terminalEvent(rootSpawn.value.delegationId, 2, 1, 3));
      await flush();
      expect(
        broker.inspect(parent, nestedQueued.value.delegationId),
      ).toMatchObject({ phase: 'starting' });
      expect(
        runner.starts.some(
          (request) => request.delegationId === nestedQueued.value.delegationId,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('fails a queued nested child at grant time when its ancestor narrows its write grant', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      maxDepthForParent: (): number => 3,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const rootSpawn = await broker.spawn(parent, {
        ...task,
        allowNestedDelegation: true,
        permissions: { writePaths: ['a.txt', 'b.txt'] },
      });
      if (!rootSpawn.ok) throw new Error('Expected root admission');
      await flush();
      await runner.sink?.(
        startedEvent(rootSpawn.value.delegationId, 1, 1, 1, 'native-root'),
      );
      const child = broker.childContext(runner.starts[0], 'nested-call');
      if (!child) throw new Error('Expected child context');

      const nestedQueued = await broker.spawn(child, {
        ...task,
        permissions: { writePaths: ['a.txt'] },
      });
      if (!nestedQueued.ok) throw new Error('Expected queued nested admission');
      expect(nestedQueued.value.phase).toBe('queued');

      // Accepted while the ancestor is still running: no fresh ticket yet.
      const followUp = await broker.manage(
        { ...parent, turnId: 'follow-turn', toolCallId: 'narrow' },
        {
          delegationId: rootSpawn.value.delegationId,
          operation: 'follow_up',
          message: 'Narrow the grant.',
          permissions: { writePaths: ['b.txt'] },
        },
      );
      expect(followUp).toMatchObject({
        ok: true,
        value: { control: { status: 'accepted' } },
      });
      expect(
        broker.inspect(parent, nestedQueued.value.delegationId)?.queue,
      ).toMatchObject({ position: 1 });

      await runner.sink?.(terminalEvent(rootSpawn.value.delegationId, 1, 2, 2));
      await flush();
      expect(
        broker.inspect(parent, rootSpawn.value.delegationId),
      ).toMatchObject({ runGeneration: 2 });
      expect(
        broker.inspect(parent, nestedQueued.value.delegationId),
      ).toMatchObject({ phase: 'queued' });

      await runner.sink?.(terminalEvent(rootSpawn.value.delegationId, 2, 1, 3));
      await flush();

      expect(
        broker.inspect(parent, nestedQueued.value.delegationId),
      ).toMatchObject({
        status: 'failed',
        error: { code: 'policy_blocked' },
      });
    } finally {
      await broker.close();
    }
  });

  it('reports the new generation and phase from an idle follow-up, capturable by a later watch', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(first.value.delegationId, 1, 1, 1, 'native-1'),
      );
      await runner.sink?.(terminalEvent(first.value.delegationId, 1, 2, 2));
      await flush();

      const blocker = await broker.spawn(
        { ...parent, toolCallId: 'blocker' },
        task,
      );
      if (!blocker.ok) throw new Error('Expected admission');
      await flush();

      const followUp = await broker.message(parent, {
        delegationId: first.value.delegationId,
        operation: 'follow_up',
        message: 'Keep going.',
      });
      if (!followUp.ok) throw new Error('Expected materialized continuation');
      expect(followUp.value.runGeneration).toBe(2);
      expect(followUp.value.phase).toBe('queued');

      const watched = broker.watchTargetStates([
        { delegationId: first.value.delegationId, runGeneration: 2 },
      ]);
      expect(watched).toEqual([
        expect.objectContaining({
          delegationId: first.value.delegationId,
          runGeneration: 2,
          status: 'pending',
        }),
      ]);
    } finally {
      await broker.close();
    }
  });

  it('lets a follow-up accepted while running inherit the slot at run end ahead of other waiters', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(first.value.delegationId, 1, 1, 1, 'native-first'),
      );

      const followUp = await broker.message(parent, {
        delegationId: first.value.delegationId,
        operation: 'follow_up',
        message: 'Keep going.',
      });
      expect(followUp).toMatchObject({
        ok: true,
        value: { control: { status: 'accepted' } },
      });

      const other = await broker.spawn(
        { ...parent, toolCallId: 'other' },
        task,
      );
      if (!other.ok) throw new Error('Expected queued admission');
      expect(other.value.phase).toBe('queued');

      await runner.sink?.(terminalEvent(first.value.delegationId, 1, 2, 2));
      await flush();

      expect(broker.inspect(parent, first.value.delegationId)).toMatchObject({
        runGeneration: 2,
        phase: 'starting',
      });
      expect(broker.inspect(parent, other.value.delegationId)).toMatchObject({
        phase: 'queued',
      });
      expect(
        runner.starts.some(
          (request) =>
            request.delegationId === first.value.delegationId &&
            request.runGeneration === 2,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('queues a follow-up by its acceptance time when the limit drops before the run ends', async () => {
    let capacity = 2;
    const { broker, runner } = setup(new MemoryStorage(), {
      asyncAdmission: true,
      capacityForParent: (): number => capacity,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      const second = await broker.spawn(
        { ...parent, toolCallId: 'second' },
        task,
      );
      if (!first.ok || !second.ok) throw new Error('Expected admission');
      await flush();
      await runner.sinks.get(first.value.delegationId)?.(
        startedEvent(first.value.delegationId, 1, 1, 1, 'native-first'),
      );

      const followUp = await broker.message(parent, {
        delegationId: first.value.delegationId,
        operation: 'follow_up',
        message: 'Keep going.',
      });
      expect(followUp).toMatchObject({
        ok: true,
        value: { control: { status: 'accepted' } },
      });

      capacity = 1;
      await runner.sinks.get(first.value.delegationId)?.(
        terminalEvent(first.value.delegationId, 1, 2, 2),
      );
      await flush();

      expect(broker.inspect(parent, first.value.delegationId)).toMatchObject({
        runGeneration: 2,
        phase: 'queued',
      });
      expect(runner.stopped).toEqual([]);
    } finally {
      await broker.close();
    }
  });

  it('queues a host continuation to an idle target and resolves the wait without launching', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const target = await broker.spawn(parent, task);
      if (!target.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(target.value.delegationId, 1, 1, 1, 'native-target'),
      );
      await runner.sink?.(terminalEvent(target.value.delegationId, 1, 2, 2));
      await flush();

      const blocker = await broker.spawn(
        { ...parent, toolCallId: 'blocker' },
        task,
      );
      if (!blocker.ok) throw new Error('Expected admission');
      await flush();

      const delivered = await broker.deliverHostMessage(
        target.value.delegationId,
        'Wake up.',
        'attempt-1',
      );
      expect(delivered).toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });

      let waited = false;
      const wait = broker
        .waitHostMessage(target.value.delegationId, 'attempt-1')
        .then(() => {
          waited = true;
        });
      await flush();
      expect(waited).toBe(true);
      expect(broker.inspect(parent, target.value.delegationId)).toMatchObject({
        runGeneration: 2,
        phase: 'queued',
      });
      expect(
        runner.starts.some(
          (request) =>
            request.delegationId === target.value.delegationId &&
            request.runGeneration === 2,
        ),
      ).toBe(false);

      await wait;
    } finally {
      await broker.close();
    }
  });

  it('releases the admission slot an idle host delivery reserved when its control cannot be persisted', async () => {
    const storage = new FailingOnceStorage();
    const { broker, runner } = setup(storage, {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const target = await broker.spawn(parent, task);
      if (!target.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(target.value.delegationId, 1, 1, 1, 'native-target'),
      );
      await runner.sink?.(terminalEvent(target.value.delegationId, 1, 2, 2));
      await flush();

      storage.failNextCommit = true;
      await expect(
        broker.deliverHostMessage(
          target.value.delegationId,
          'Wake up.',
          'attempt-1',
        ),
      ).rejects.toThrow('The storage commit failed.');

      // With the slot released, new work starts at once instead of queuing
      // behind a slot nothing holds.
      const next = await broker.spawn({ ...parent, toolCallId: 'next' }, task);
      if (!next.ok) throw new Error('Expected admission');
      await flush();
      expect(broker.inspect(parent, next.value.delegationId)?.phase).not.toBe(
        'queued',
      );
      expect(
        runner.starts.some(
          (request) => request.delegationId === next.value.delegationId,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('coalesces a second host message into a still-queued continuation and resolves both waits with one launch', async () => {
    const { broker, runner } = setup(new MemoryStorage(), {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const target = await broker.spawn(parent, task);
      if (!target.ok) throw new Error('Expected admission');
      await flush();
      await runner.sink?.(
        startedEvent(target.value.delegationId, 1, 1, 1, 'native-target'),
      );
      await runner.sink?.(terminalEvent(target.value.delegationId, 1, 2, 2));
      await flush();

      const blocker = await broker.spawn(
        { ...parent, toolCallId: 'blocker' },
        task,
      );
      if (!blocker.ok) throw new Error('Expected admission');
      await flush();

      const firstMessage = await broker.deliverHostMessage(
        target.value.delegationId,
        'First part.',
        'attempt-1',
      );
      expect(firstMessage.ok).toBe(true);
      const secondMessage = await broker.deliverHostMessage(
        target.value.delegationId,
        'Second part.',
        'attempt-2',
      );
      expect(secondMessage.ok).toBe(true);

      const waits = Promise.all([
        broker.waitHostMessage(target.value.delegationId, 'attempt-1'),
        broker.waitHostMessage(target.value.delegationId, 'attempt-2'),
      ]);
      await flush();
      await waits;
      expect(broker.inspect(parent, target.value.delegationId)).toMatchObject({
        runGeneration: 2,
        phase: 'queued',
      });

      await broker.requestStop(parent, blocker.value.delegationId);
      await flush();

      const launches = runner.starts.filter(
        (request) =>
          request.delegationId === target.value.delegationId &&
          request.runGeneration === 2,
      );
      expect(launches).toHaveLength(1);
      const launched = launches[0];
      if (!launched)
        throw new Error('Expected the coalesced continuation to launch');
      expect(launched.task.prompt).toContain('First part.');
      expect(launched.task.prompt).toContain('Second part.');
    } finally {
      await broker.close();
    }
  });

  it('still delivers a host message that tried to coalesce while the queued continuation was being granted', async () => {
    const storage = new GrantGateStorage();
    const { broker, runner } = setup(storage, {
      capacity: 1,
      asyncAdmission: true,
      resolveRoute: resumableRoute,
    });
    await broker.initialize();
    try {
      const target = await broker.spawn(parent, task);
      if (!target.ok) throw new Error('Expected admission');
      const targetId = target.value.delegationId;
      await flush();
      await runner.sink?.(startedEvent(targetId, 1, 1, 1, 'native-target'));
      await runner.sink?.(terminalEvent(targetId, 1, 2, 2));
      await flush();

      const blocker = await broker.spawn(
        { ...parent, toolCallId: 'blocker' },
        task,
      );
      if (!blocker.ok) throw new Error('Expected admission');
      await flush();

      const first = await broker.deliverHostMessage(
        targetId,
        'First part.',
        'attempt-1',
      );
      expect(first.ok).toBe(true);
      await flush();
      expect(broker.inspect(parent, targetId)?.phase).toBe('queued');

      // Free the slot, but hold the grant's commit: the record still reads as
      // queued, so the next message decides to fold into this generation.
      storage.holdGrantOf(targetId);
      await broker.requestStop(parent, blocker.value.delegationId);
      await storage.held;
      const second = broker.deliverHostMessage(
        targetId,
        'Second part.',
        'attempt-2',
      );
      await flush();
      storage.release();
      await expect(second).resolves.toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });
      await flush();

      // Generation 2 launched from the prompt it read at grant time. Finish
      // it; the late message must still reach the delegate.
      await runner.sinks.get(targetId)?.(
        startedEvent(targetId, 2, 1, 3, 'native-target'),
      );
      await runner.sinks.get(targetId)?.(terminalEvent(targetId, 2, 2, 4));
      await flush();
      await broker.waitHostMessage(targetId, 'attempt-2');
      await flush();
      const delivered = [
        ...runner.starts
          .filter((request) => request.delegationId === targetId)
          .map((request) => request.task.prompt),
        ...runner.steeringRequests.map(({ request }) => request.message),
      ];
      expect(delivered.some((text) => text.includes('Second part.'))).toBe(
        true,
      );
    } finally {
      await broker.close();
    }
  });

  it('keeps live queue fields out of transcripts but includes them in inspect, list and getOutput', async () => {
    const { broker } = setup(new MemoryStorage(), { capacity: 1 });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      const queued = await broker.spawn(
        { ...parent, toolCallId: 'queued' },
        task,
      );
      if (!queued.ok) throw new Error('Expected queued admission');
      expect(queued.value.queue).toMatchObject({
        position: 1,
        waitingFor: 'queue',
        running: 1,
        waiting: 1,
        limit: 1,
      });

      const inspected = broker.inspect(parent, queued.value.delegationId);
      expect(inspected?.queue).toMatchObject({
        position: 1,
        waitingFor: 'queue',
      });
      const listed = broker
        .list(parent)
        .find((entry) => entry.delegationId === queued.value.delegationId);
      expect(listed?.queue).toMatchObject({ position: 1, waitingFor: 'queue' });
      const output = broker.getOutput(parent, {
        delegationId: queued.value.delegationId,
      });
      expect(output).toMatchObject({
        ok: true,
        value: {
          currentPhase: 'queued',
          queue: { position: 1, waitingFor: 'queue' },
        },
      });

      const transcripts = await broker.transcripts(parent);
      const queuedTranscript = transcripts.find(
        (entry) => entry.delegationId === queued.value.delegationId,
      );
      expect(queuedTranscript?.snapshot.phase).toBe('queued');
      expect(queuedTranscript?.snapshot.queue).toEqual({
        id: 'default',
        name: 'Default',
      });
      expect(queuedTranscript?.snapshot.queue).not.toHaveProperty('position');
      expect(queuedTranscript?.snapshot.queue).not.toHaveProperty('waitingFor');
      expect(queuedTranscript?.snapshot.queue).not.toHaveProperty('running');
      expect(queuedTranscript?.snapshot.queue).not.toHaveProperty('waiting');
      expect(queuedTranscript?.snapshot.queue).not.toHaveProperty('limit');
    } finally {
      await broker.close();
    }
  });

  it('excludes queued work from activeCount and reports queued counts through onActivity', async () => {
    const activity: Array<{ count: number; queued: number }> = [];
    const { broker } = setup(new MemoryStorage(), {
      capacity: 1,
      onActivity: (_parentContext, count, queued): void => {
        activity.push({ count, queued });
      },
    });
    await broker.initialize();
    try {
      const first = await broker.spawn(parent, task);
      if (!first.ok) throw new Error('Expected admission');
      await flush();
      expect(broker.activeCount(parent)).toBe(1);
      expect(broker.queuedCount(parent)).toBe(0);

      const queued = await broker.spawn(
        { ...parent, toolCallId: 'queued' },
        task,
      );
      if (!queued.ok) throw new Error('Expected queued admission');
      expect(broker.activeCount(parent)).toBe(1);
      expect(broker.queuedCount(parent)).toBe(1);
      const last = activity[activity.length - 1];
      expect(last).toEqual({ count: 1, queued: 1 });

      await broker.requestStop(parent, first.value.delegationId);
      await flush();
      expect(broker.activeCount(parent)).toBe(1);
      expect(broker.queuedCount(parent)).toBe(0);
    } finally {
      await broker.close();
    }
  });
});
