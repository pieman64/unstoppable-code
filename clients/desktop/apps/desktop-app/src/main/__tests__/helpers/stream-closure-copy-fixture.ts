import type {
  DelegatedAgentCallBlock,
  DelegationChildRow,
} from '@canopy/agent-transcript';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { format4Scope, reopenFormat4Scope } from './chat-format4-scope';
import { message, scopeSource } from './chat-delta-journal-harness';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { streamRegistryPaths } from '../../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../../lib/transcript-stream-paths';

export const target = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: 'delegate',
  runGeneration: 1,
};

export function card(): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    delegationId: 'delegate',
    runGeneration: 1,
    status: 'running',
    outputTruncated: false,
    agentBlockId: 'delegated-agent-delegate',
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    routeSnapshot: {
      selectedModelId: 'model',
      runtimeModelId: 'model',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'a1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'c1',
      capabilityGeneration: 1,
      policyRevision: 'p1',
    },
    selectedModelId: 'model',
    runtimeModelId: 'model',
    targetHarnessId: 'claude',
    description: 'Review',
    prompt: 'Review',
    executionMode: 'background',
    transcriptStore: 'chat-stream-v2',
  };
}

export function parent(): PersistedChatMessage {
  return { ...message('parent', ''), blocks: [card()] };
}
export function child(
  final = true,
  text = 'independent child output',
  itemRevision = 0,
): DelegationChildRow {
  return {
    id: 'agent:item',
    role: 'assistant',
    timestamp: 2,
    parentBlockId: 'delegated-agent-delegate',
    delegationSequence: 0,
    itemRevision,
    final,
    blocks: [{ type: 'text', text }],
  };
}

export async function sourceFixture(
  root: string,
  scopeId = 'source',
  open = false,
): Promise<Awaited<ReturnType<typeof format4Scope>>> {
  const fixture = await format4Scope(
    root,
    scopeId,
    scopeSource([
      { id: 'chat', messages: [parent()] },
      { id: 'plain', messages: [message('plain', 'plain')] },
    ]),
  );
  await fixture.backend.registerTranscriptStream(target);
  await fixture.backend.commitChildStream(target, 'child', [child(!open)]);
  if (!open) {
    await fixture.backend.flush();
    const bytes = await readFile(
      streamRegistryPaths(
        join(fixture.store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      ).log,
    );
    await fixture.backend.commitChildStream(target, 'settle', [], {
      key: 'settle',
      descriptorUpdate: {
        version: 1,
        target,
        expectedStreamRevision: 1,
        nextStreamRevision: 2,
        status: 'settled',
        settleReceipt: {
          mutationId: 'settle',
          scopeRevision: (await fixture.backend.revision()) + 1,
          streamRevision: 2,
          committedRowCount: 1,
          committedByteLength: bytes.length,
          committedSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
  }
  await fixture.backend.demoteFromDeltaJournal();
  return reopenFormat4Scope(root, scopeId, {
    deltaJournal: false,
    enableFormat4: false,
  });
}
