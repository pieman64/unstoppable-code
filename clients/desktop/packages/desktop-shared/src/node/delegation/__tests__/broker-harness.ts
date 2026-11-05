import type {
  AgentDelegationEvent,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '../broker';
import { isTerminalDelegationSummary } from '../terminal-summary';
import { AgentRunnerRegistry } from '../runner-registry';
import type { AgentRunRequest, DelegationParentContext } from '../types';
import { FakeRunner, routeFixture } from './fixtures';

/** The root chat's own agent (depth 0). */
export const rootParent: DelegationParentContext = {
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

export const baseTask: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Review the supplied task',
  prompt: 'Read src/index.ts and identify missing error handling.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

export class MemoryDelegationStorage implements DelegationStorage {
  readonly records = new Map<string, StoredDelegation>();

  loadReadOnly(): Promise<{
    readonly records: readonly StoredDelegation[];
    readonly missing: boolean;
  }> {
    return Promise.resolve({
      records: structuredClone(Array.from(this.records.values())),
      missing: false,
    });
  }

  load(): Promise<readonly StoredDelegation[]> {
    return Promise.resolve(structuredClone(Array.from(this.records.values())));
  }

  loadOne(delegationId: string): Promise<StoredDelegation | undefined> {
    const record = this.records.get(delegationId);
    return Promise.resolve(
      record === undefined ? undefined : structuredClone(record),
    );
  }

  commit(record: StoredDelegation): Promise<void> {
    if (isTerminalDelegationSummary(record))
      return Promise.reject(
        new Error('Terminal delegation summaries cannot be committed'),
      );
    const copy = structuredClone(record);
    this.records.set(copy.state.delegationId, copy);
    return Promise.resolve();
  }
}

export interface BrokerHarness {
  readonly broker: AgentDelegationBroker;
  readonly runner: FakeRunner;
  readonly storage: DelegationStorage;
}

export function createBrokerHarness(
  options: Partial<AgentDelegationBrokerOptions> = {},
  storage: DelegationStorage = new MemoryDelegationStorage(),
): BrokerHarness {
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
    capacity: 8,
    maxDepthForParent: (): number => 5,
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

export async function flushBroker(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The launch request the fake runner received for one delegation. */
export function startOf(runner: FakeRunner, id: string): AgentRunRequest {
  const request = runner.starts.find(
    (candidate) => candidate.delegationId === id,
  );
  if (!request) throw new Error(`Expected a launch for ${id}`);
  return request;
}

/** Waits for a launch that durable (file-backed) storage may delay. */
export async function waitForLaunch(
  runner: FakeRunner,
  id: string,
): Promise<AgentRunRequest> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const request = runner.starts.find(
      (candidate) => candidate.delegationId === id,
    );
    if (request) return request;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return startOf(runner, id);
}

/** Sends one runner event for the delegation's first run generation. */
export async function emit(
  runner: FakeRunner,
  id: string,
  sequence: number,
  event: AgentDelegationEvent['event'],
): Promise<void> {
  const sink = runner.sinks.get(id);
  if (!sink) throw new Error(`Expected a runner sink for ${id}`);
  await sink({
    delegationId: id,
    runGeneration: 1,
    sequence,
    occurredAt: Date.now(),
    event,
  });
}
