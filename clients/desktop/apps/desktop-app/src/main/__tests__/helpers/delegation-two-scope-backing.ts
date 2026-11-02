import crypto from 'node:crypto';
import { join } from 'node:path';
import {
  delegationBlockId,
  type PersistedChatMessage,
  type DelegationChildRow,
} from '@canopy/agent-transcript';
import type { AgentDelegationBrokerOptions } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import type {
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptPortResult,
  DelegationTranscriptGenerationEntry,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  createBrokerHarness,
  baseTask,
  rootParent,
  waitForLaunch,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { routeFixture } from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { format4Scope } from './chat-format4-scope';
import { scopeSource } from './chat-delta-journal-harness';

export const chatId = 'colliding-chat';
export const delegationId = '11111111-1111-4111-8111-111111111111';
export const scopes: readonly ChatScopeKey[] = [
  { projectId: 'project-a', worktreeId: 'scope-a' },
  { projectId: 'project-b', worktreeId: 'scope-b' },
];
export function label(scope: ChatScopeKey): string {
  return scope.projectId === 'project-a' ? 'A' : 'B';
}
export function directory(root: string, scope: ChatScopeKey): string {
  return join(root, scope.projectId, scope.worktreeId);
}
export function paths(
  root: string,
  scope: ChatScopeKey,
): { tabs: string; archives: string; journal: string } {
  const dir = directory(root, scope);
  return {
    tabs: join(dir, `${scope.worktreeId}.json`),
    archives: join(dir, 'archives.json'),
    journal: join(dir, 'journal.json'),
  };
}
export function parent(scope: ChatScopeKey): typeof rootParent {
  return {
    ...rootParent,
    ...scope,
    chatId,
    sessionKey: `${scope.projectId}/${scope.worktreeId}/${chatId}`,
  };
}
export function target(runGeneration: number): {
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
} {
  return { kind: 'delegation', chatId, delegationId, runGeneration };
}
function card(scope: ChatScopeKey, generation: number): PersistedChatMessage {
  const name = label(scope);
  return {
    id: `card-${generation}`,
    role: 'assistant',
    timestamp: 100 + generation,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: delegationBlockId(delegationId, generation),
        delegationId,
        runGeneration: generation,
        sequence: generation,
        parentHarnessId: 'claude',
        parentTurnId: 'turn-1',
        parentToolCallId: 'call-1',
        createdAt: 100 + generation,
        selectedModelId: 'model',
        runtimeModelId: 'model',
        targetHarnessId: 'third-harness',
        routeSnapshot: {
          selectedModelId: 'model',
          runtimeModelId: 'model',
          harnessId: 'third-harness',
          runtimeKind: 'sdk',
          runnerRegistrationId: 'runner',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'agent',
          providerType: 'openai',
          assignmentRevision: '1',
          billingAuthority: 'local',
          aiCreditsRouted: false,
          capabilities: [],
          supportedThinkingLevels: [],
          capabilitySnapshotHash: 'hash',
          capabilityGeneration: 1,
          policyRevision: '1',
        },
        description: `${name} stored task ${generation}`,
        prompt: `${name} stored prompt ${generation}`,
        executionMode: 'background',
        status: 'running',
        outputTruncated: false,
      },
    ],
  };
}

/** Writer-only host projection adds the stored parent anchor; all operations use the real port. */
class AnchoredRepositoryPort extends RepositoryDelegationTranscriptPort {
  override registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationEntry>
  > {
    return super.registerGeneration(
      {
        ...input,
        origin: {
          ...input.origin,
          anchorMessageId: `card-${input.runGeneration}`,
        },
      },
      signal,
    );
  }
}
export function openBacking(root: string): {
  service: ChatStateService;
  repository: ChatStateV2Repository;
} {
  const repository = new ChatStateV2Repository({
    resolvePaths: (scope): ReturnType<typeof paths> => paths(root, scope),
    enableFormat4: true,
    delegationReadMetadata: readMetadataOfRecord,
  });
  return {
    repository,
    service: new ChatStateService({ repository, recordDiagnostic: jest.fn() }),
  };
}
function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
export async function seedBacking(
  root: string,
  beforeSettle?: (scope: ChatScopeKey) => Promise<void>,
): Promise<void> {
  for (const scope of scopes) {
    const name = label(scope);
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(name === 'A' ? 100_000 : 200_000);
    const { backend } = await format4Scope(
      directory(root, scope),
      scope.worktreeId,
      scopeSource([{ id: chatId, messages: [card(scope, 3), card(scope, 4)] }]),
    );
    await backend.flush();
    backend.releaseJournal();
    await backend.disposeArtifactMaintenance();
    const backing = openBacking(root);
    const storage = new FileDelegationStorage(
      join(directory(root, scope), 'delegation', 'runs'),
    );
    const resumable: Pick<AgentDelegationBrokerOptions, 'resolveRoute'> = {
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    };
    const legacy = createBrokerHarness(resumable, storage);
    await legacy.broker.initialize();
    const id = jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(delegationId);
    const spawned = await legacy.broker.spawn(parent(scope), {
      ...baseTask,
      description: `${name} stale record task`,
      prompt: `${name} stale record prompt`,
    });
    id.mockRestore();
    if (!spawned.ok || spawned.value.delegationId !== delegationId)
      throw new Error('Legacy admission failed');
    await waitForLaunch(legacy.runner, delegationId);
    await legacy.runner.sink?.({
      delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'retained-native' },
    });
    await legacy.runner.sink?.({
      delegationId,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 200,
      event: {
        type: 'terminal',
        status: 'completed',
        finalText: `${name} frozen legacy answer`,
      },
    });
    await legacy.broker.close();
    const frozen = await storage.loadOne(delegationId);
    if (!frozen || frozen.version === 3)
      throw new Error('Expected legacy record');
    const port = new AnchoredRepositoryPort(backing.service, scope);
    // Seed two valid retained v2 index histories before the trusted v3 admission.
    // The colliding legacy generation is 2 in both; B also retains generation 1's result.
    const originalResult = frozen.results?.[0];
    if (!originalResult) throw new Error('Expected indexed legacy result');
    if (!frozen.launch) throw new Error('Expected legacy launch');
    const lastLegacy = {
      ...originalResult,
      runGeneration: 2,
      resultIndex: name === 'A' ? 1 : 2,
    };
    await storage.commit({
      ...frozen,
      launch: { ...frozen.launch, runGeneration: 2 },
      state: { ...frozen.state, runGeneration: 2 },
      results: name === 'A' ? [lastLegacy] : [originalResult, lastLegacy],
    });
    const current = createBrokerHarness(
      { ...resumable, testOnlyStreamGeneration: true, transcriptPort: port },
      storage,
    );
    await current.broker.initialize();
    let prefix: string | undefined;
    for (const generation of [3, 4]) {
      const admitted = await current.broker.manage(
        { ...parent(scope), toolCallId: `resume-${generation}` },
        {
          delegationId,
          operation: 'resume',
          message: `continue ${generation}`,
        },
      );
      if (!admitted.ok) throw new Error(JSON.stringify(admitted));
      for (
        let attempt = 0;
        attempt < 200 &&
        !current.runner.starts.some(
          (entry) => entry.runGeneration === generation,
        );
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      if (
        !current.runner.starts.some(
          (entry) => entry.runGeneration === generation,
        )
      )
        throw new Error('Continuation did not launch');
      if (generation === 3) await beforeSettle?.(scope);
      if (generation === 4) {
        value(await port.open({ target: target(4) }));
        const rows: DelegationChildRow[] = [1, 2, 3].map((sequence) => ({
          id: `${delegationBlockId(delegationId, 4)}:row-${sequence}`,
          role: 'assistant',
          timestamp: (name === 'A' ? 1000 : 2000) + sequence,
          parentBlockId: delegationBlockId(delegationId, 4),
          delegationSequence: sequence,
          delegationSegment: 'segment',
          blocks: [{ type: 'text', text: `${name} answer ${sequence}` }],
          itemRevision: 0,
          final: true,
        }));
        value(
          await port.appendChanges({
            target: target(4),
            mutationKey: 'cold-rows',
            changes: rows.map((row) => ({ row })),
          }),
        );
      }
      await current.runner.sink?.({
        delegationId,
        runGeneration: generation,
        sequence: 1,
        occurredAt: (name === 'A' ? 10000 : 20000) + generation,
        event: {
          type: 'terminal',
          status: name === 'A' ? 'completed' : 'failed',
          ...(generation === 4
            ? { finalText: `${name} canonical answer` }
            : {}),
        },
      });
      if (generation === 3) {
        const promoted = await storage.loadOne(delegationId);
        if (promoted?.version !== 3)
          throw new Error('Expected promoted record');
        prefix = JSON.stringify(promoted.legacyPrefix);
        expect(prefix).toContain(`${name} frozen legacy answer`);
      }
    }
    await current.broker.close();
    const record = await storage.loadOne(delegationId);
    if (record?.version !== 3)
      throw new Error('Trusted broker did not persist v3');
    expect(JSON.stringify(record.legacyPrefix)).toEqual(prefix);
    expect(record.readMetadata.current.store).toBe('stream');
    await backing.service.drain();
    clock.mockRestore();
  }
}

/** A default broker, with no trusted seam and no transcript port, remains legacy. */
export async function seedLegacyOnly(
  root: string,
  scope: ChatScopeKey,
): Promise<number[]> {
  const { backend } = await format4Scope(
    directory(root, scope),
    scope.worktreeId,
    scopeSource([{ id: chatId, messages: [] }]),
  );
  await backend.flush();
  backend.releaseJournal();
  await backend.disposeArtifactMaintenance();
  const storage = new FileDelegationStorage(
    join(directory(root, scope), 'delegation', 'runs'),
  );
  const commits: number[] = [];
  const commit = storage.commit.bind(storage);
  jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
    if ('version' in record) commits.push(record.version);
    await commit(record);
  });
  const { broker, runner } = createBrokerHarness({}, storage);
  try {
    await broker.initialize();
    const spawned = await broker.spawn(parent(scope), baseTask);
    if (!spawned.ok) throw new Error('Default broker admission failed');
    await waitForLaunch(runner, spawned.value.delegationId);
    await runner.sink?.({
      delegationId: spawned.value.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: {
        type: 'terminal',
        status: 'completed',
        finalText: 'default legacy answer',
      },
    });
  } finally {
    await broker.close();
  }
  expect(
    (await storage.load()).every(
      (record) => record.version === 1 || record.version === 2,
    ),
  ).toBe(true);
  return commits;
}
