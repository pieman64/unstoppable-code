import type { AgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import type { DelegationParentContext } from '../types';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '../broker';
import { AgentRunnerRegistry } from '../runner-registry';
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

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

it('follows a running child to a new native session after a mid-run reload', async () => {
  const storage = new MemoryStorage();
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const onError = jest.fn();
  const broker = new AgentDelegationBroker({
    storage,
    registry,
    cwd: '/test/worktree',
    asyncAdmission: true,
    onError,
    resolveRoute: (): ReturnType<
      AgentDelegationBrokerOptions['resolveRoute']
    > => Promise.resolve({ ok: true, value: routeFixture() }),
    authorize: (): ReturnType<AgentDelegationBrokerOptions['authorize']> =>
      Promise.resolve({ ok: true, value: undefined }),
  });
  await broker.initialize();
  try {
    const spawned = await broker.spawn(parent, task);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await flush();
    const sink = runner.sinks.get(id);
    if (!sink) throw new Error('Expected a started run');
    await sink({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 10,
      event: { type: 'started', nativeSessionId: 'native-first' },
    });
    await sink({
      delegationId: id,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 20,
      event: { type: 'started', nativeSessionId: 'native-reloaded' },
    });
    await flush();

    const stored = storage.records.get(id);
    expect(stored?.state).toMatchObject({
      status: 'running',
      startedAt: 10,
      nativeSessionId: 'native-reloaded',
    });
    expect(stored?.launch).toMatchObject({
      phase: 'identified',
      nativeSessionId: 'native-reloaded',
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await broker.close();
  }
});
