import type { AgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import {
  MAX_MANAGED_DELEGATION_CONCURRENCY,
  normalizeManagedDelegationMaxConcurrent,
} from '@canopy/protocol/delegation/discovery';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { createDelegationAdmissionController } from '@canopy/desktop-shared/node/delegation/queue-admission';
import { AgentRunnerRegistry } from '@canopy/desktop-shared/node/delegation/runner-registry';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation/types';
import {
  FakeRunner,
  routeFixture,
} from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';

/**
 * Application-level admission as composed by the delegation service: one
 * controller shared by every worktree broker, buckets per root chat with the
 * live "Maximum concurrent subagents" limit, and the 64-run host cap.
 */

class MemoryStorage implements DelegationStorage {
  readonly records = new Map<string, StoredDelegation>();
  load(): Promise<readonly StoredDelegation[]> {
    return Promise.resolve(structuredClone(Array.from(this.records.values())));
  }
  commit(record: StoredDelegation): Promise<void> {
    this.records.set(record.state.delegationId, structuredClone(record));
    return Promise.resolve();
  }
}

const task: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Review the supplied task',
  prompt: 'Read src/index.ts and identify missing error handling.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

function rootParent(
  worktreeId: string,
  chatId: string,
): DelegationParentContext {
  return {
    harnessId: 'claude',
    projectId: 'project',
    worktreeId,
    chatId,
    sessionKey: `project/${worktreeId}/${chatId}`,
    turnId: 'turn',
    toolCallId: 'call',
    runtimeGeneration: 1,
    depth: 0,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createHost(limit: () => number): {
  brokerFor: (worktreeId: string) => {
    broker: AgentDelegationBroker;
    runner: FakeRunner;
  };
  refresh: () => void;
  close: () => Promise<void>;
} {
  const admission = createDelegationAdmissionController({
    limitForBucket: (): number =>
      normalizeManagedDelegationMaxConcurrent(limit()),
    hostCapacity: (): number => MAX_MANAGED_DELEGATION_CONCURRENCY,
  });
  const brokers = new Map<
    string,
    { broker: AgentDelegationBroker; runner: FakeRunner }
  >();
  return {
    refresh: (): void => admission.refresh(),
    brokerFor: (
      worktreeId,
    ): { broker: AgentDelegationBroker; runner: FakeRunner } => {
      const existing = brokers.get(worktreeId);
      if (existing) return existing;
      const runner = new FakeRunner('local-sdk');
      const registry = new AgentRunnerRegistry();
      registry.register({
        apiVersion: 1,
        registrationId: 'third-local',
        adapter: runner,
      });
      const broker = new AgentDelegationBroker({
        asyncAdmission: true,
        storage: new MemoryStorage(),
        registry,
        cwd: `/test/${worktreeId}`,
        admission,
        resolveRoute: (): ReturnType<
          AgentDelegationBrokerOptions['resolveRoute']
        > => Promise.resolve({ ok: true, value: routeFixture() }),
        authorize: (): ReturnType<AgentDelegationBrokerOptions['authorize']> =>
          Promise.resolve({ ok: true, value: undefined }),
      });
      const created = { broker, runner };
      brokers.set(worktreeId, created);
      return created;
    },
    close: async (): Promise<void> => {
      await Promise.all(
        Array.from(brokers.values(), ({ broker }) => broker.close()),
      );
    },
  };
}

async function spawnMany(
  broker: AgentDelegationBroker,
  parent: DelegationParentContext,
  count: number,
  prefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await broker.spawn(
      { ...parent, toolCallId: `${prefix}-${String(index)}` },
      task,
    );
    if (!result.ok) throw new Error(result.error.message);
    ids.push(result.value.delegationId);
  }
  return ids;
}

describe('application delegation admission', () => {
  it('enforces the 64-run host cap across root chats and worktrees, then starts the waiter', async () => {
    const host = createHost(() => MAX_MANAGED_DELEGATION_CONCURRENCY);
    const first = host.brokerFor('worktree-a');
    const second = host.brokerFor('worktree-b');
    await first.broker.initialize();
    await second.broker.initialize();
    try {
      const chatA = rootParent('worktree-a', 'chat-a');
      const chatB = rootParent('worktree-b', 'chat-b');
      const chatC = rootParent('worktree-b', 'chat-c');
      const runningA = await spawnMany(first.broker, chatA, 40, 'a');
      await spawnMany(second.broker, chatB, 24, 'b');
      await flush();
      expect(first.runner.starts).toHaveLength(40);
      expect(second.runner.starts).toHaveLength(24);

      const waiting = await second.broker.spawn(
        { ...chatC, toolCallId: 'c-0' },
        task,
      );
      if (!waiting.ok) throw new Error('Expected queued admission');
      expect(waiting.value).toMatchObject({
        status: 'pending',
        phase: 'queued',
        queue: { id: 'default', position: 1, waitingFor: 'app' },
      });
      await flush();
      expect(second.runner.starts).toHaveLength(24);

      const rejected = await second.broker.spawn(
        { ...chatC, toolCallId: 'c-reject' },
        { ...task, ifBusy: 'reject' },
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });

      const freed = runningA[0];
      if (!freed) throw new Error('Expected a running delegation');
      await first.runner.sinks.get(freed)?.({
        delegationId: freed,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'terminal', status: 'completed' },
      });
      await flush();
      expect(second.runner.starts).toHaveLength(25);
      expect(
        second.broker.inspect(chatC, waiting.value.delegationId)?.phase,
      ).toBe('starting');
    } finally {
      await host.close();
    }
  });

  it('queues beyond the per-chat limit and grants more at once when the limit rises', async () => {
    let limit = 5;
    const host = createHost(() => limit);
    const { broker, runner } = host.brokerFor('worktree');
    await broker.initialize();
    try {
      const chat = rootParent('worktree', 'chat');
      const ids = await spawnMany(broker, chat, 7, 'spawn');
      await flush();
      expect(runner.starts).toHaveLength(5);
      expect(
        ids.slice(5).map((id) => broker.inspect(chat, id)?.queue?.position),
      ).toEqual([1, 2]);

      limit = 64;
      // updateManagedDelegationMaxConcurrent refreshes the shared controller.
      host.refresh();
      await flush();
      expect(runner.starts).toHaveLength(7);
      expect(ids.map((id) => broker.inspect(chat, id)?.phase)).not.toContain(
        'queued',
      );
    } finally {
      await host.close();
    }
  });
});
