import crypto from 'node:crypto';
import { join } from 'node:path';
import {
  delegationBlockId,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type { DelegationTranscriptGenerationRegistration } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  baseTask,
  createBrokerHarness,
  waitForLaunch,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';
import { format4Scope } from './chat-format4-scope';
import { scopeSource } from './chat-delta-journal-harness';
import {
  directory,
  openBacking,
  parent,
  scopes,
  chatId,
  delegationId,
} from './delegation-two-scope-backing';

class AnchoredPort extends RepositoryDelegationTranscriptPort {
  override registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
    signal?: AbortSignal,
  ): ReturnType<RepositoryDelegationTranscriptPort['registerGeneration']> {
    return super.registerGeneration(
      {
        ...input,
        origin: { ...input.origin, anchorMessageId: 'creation-card' },
      },
      signal,
    );
  }
}

export async function integrationBacking(
  root: string,
  legacy = false,
): Promise<
  ReturnType<typeof openBacking> & {
    port: RepositoryDelegationTranscriptPort;
    harness: ReturnType<typeof createBrokerHarness>;
    scope: (typeof scopes)[number];
    row: PersistedChatMessage;
  }
> {
  const scope = scopes[0];
  if (!scope) throw new Error('Missing integration scope');
  const row: PersistedChatMessage = {
    id: 'creation-card',
    role: 'assistant',
    timestamp: 100,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: delegationBlockId(delegationId, 1),
        delegationId,
        runGeneration: 1,
        sequence: 1,
        parentHarnessId: 'claude',
        parentTurnId: 'turn-1',
        parentToolCallId: 'call-1',
        createdAt: 100,
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
        description: 'Creation description',
        prompt: 'Creation prompt',
        executionMode: 'background',
        status: 'running',
        outputTruncated: false,
        transcriptStore: legacy ? 'chat-log-v1' : 'chat-stream-v2',
      },
    ],
  };
  const { backend } = await format4Scope(
    directory(root, scope),
    scope.worktreeId,
    scopeSource([{ id: chatId, messages: [row] }]),
  );
  await backend.flush();
  backend.releaseJournal();
  await backend.disposeArtifactMaintenance();
  const backing = openBacking(root);
  const port = new AnchoredPort(backing.service, scope);
  const storage = new FileDelegationStorage(
    join(directory(root, scope), 'delegation', 'runs'),
  );
  const harness = createBrokerHarness(
    legacy ? {} : { testOnlyStreamGeneration: true, transcriptPort: port },
    storage,
  );
  await harness.broker.initialize();
  const id = jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce(delegationId);
  const spawned = await harness.broker.spawn(parent(scope), {
    ...baseTask,
    description: 'Stale record description',
    prompt: 'Stale record prompt',
  });
  id.mockRestore();
  if (!spawned.ok) throw new Error(JSON.stringify(spawned));
  await waitForLaunch(harness.runner, delegationId);
  await harness.runner.sink?.({
    delegationId,
    runGeneration: 1,
    sequence: 1,
    occurredAt: 100,
    event: { type: 'started', nativeSessionId: 'retained-native' },
  });
  const record = await storage.loadOne(delegationId);
  if (!record || (legacy ? record.version === 3 : record.version !== 3))
    throw new Error('Unexpected broker record version');
  if (!legacy) {
    const opened = await port.open({
      target: { kind: 'delegation', chatId, delegationId, runGeneration: 1 },
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  }
  return { ...backing, port, harness, scope, row };
}
