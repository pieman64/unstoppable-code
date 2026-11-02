import {
  delegationBlockId,
  type DelegatedAgentCallBlock,
} from '@canopy/agent-transcript';
import {
  initClaudeModels,
  initCodexModels,
  type ChatStateChange,
  type ChatStateChangedEvent,
  type ChatStateSnapshot,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CardStateV2 } from '@canopy/protocol/canopy-core';
import {
  applyCanonicalChanges,
  type CanonicalScopeProjection,
} from '../canonical-changes';
import { fromPersistedTab } from '../persisted-tabs';
import { RevisionedChatSync } from '../revisioned-sync';

const projectId = 'delegation-card-state-s3-project';
const worktreeId = 'delegation-card-state-s3-worktree';
const ctx = { projectId, worktreeId };

function card(
  delegationId: string,
  overrides: Partial<DelegatedAgentCallBlock> = {},
): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: delegationBlockId(delegationId, 1),
    delegationId,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'codex',
    parentTurnId: 'turn',
    parentToolCallId: 'call',
    createdAt: 100,
    status: 'pending',
    outputTruncated: false,
    selectedModelId: 'model',
    runtimeModelId: '',
    targetHarnessId: '',
    description: 'Delegated task',
    prompt: 'Creation prompt',
    executionMode: 'background',
    transcriptStore: 'chat-stream-v2',
    ...overrides,
  };
}

function persistedTab(blocks: DelegatedAgentCallBlock[]): PersistedChatTab {
  const messages: PersistedChatMessage[] = blocks.map((block, index) => ({
    id: `row-${String(index)}`,
    role: 'assistant',
    timestamp: 100 + index,
    blocks: [block],
  }));
  return {
    id: 'chat',
    title: 'Chat',
    messages,
    createdAt: '2026-10-19T00:00:00.000Z',
    model: 'codex-mini-latest',
  };
}

function projectionOf(tab: PersistedChatTab): CanonicalScopeProjection {
  return {
    chatState: { tabs: [fromPersistedTab(tab)], activeTabId: tab.id },
    archives: [],
    runtimeByChatId: {},
    pendingQuestions: {},
  };
}

const completed: CardStateV2 = {
  version: 2,
  cardRevision: 2,
  status: 'running',
  outputTruncated: false,
  canonical: { status: 'completed', resultIndex: 1, finalText: 'Done' },
};

function update(
  delegationId: string,
  runGeneration = 1,
): Extract<ChatStateChange, { type: 'delegation.card_state_updated' }> {
  return {
    type: 'delegation.card_state_updated',
    chatId: 'chat',
    delegationId,
    runGeneration,
    cardRevision: 2,
    streamRevision: 3,
    cardState: completed,
  };
}

function firstBlocks(projection: CanonicalScopeProjection): unknown[] {
  return (projection.chatState.tabs[0]?.messages ?? []).map(
    (row) => row.blocks[0],
  );
}

describe('12a S3 renderer card-state reception', () => {
  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });

  it('applies the canonical block to the matching loaded stream card', () => {
    const projection = projectionOf(persistedTab([card('d')]));
    const next = applyCanonicalChanges(projection, [update('d')], ctx);
    expect(firstBlocks(next)[0]).toMatchObject({
      delegationId: 'd',
      status: 'completed',
      resultIndex: 1,
      finalText: 'Done',
      prompt: 'Creation prompt',
    });
  });

  it('leaves legacy cards, other generations and unloaded cards untouched', () => {
    const tab = persistedTab([
      card('legacy', { transcriptStore: 'chat-log-v1' }),
      card('other-generation', {
        runGeneration: 2,
        agentBlockId: delegationBlockId('other-generation', 2),
      }),
    ]);
    const projection = projectionOf(tab);
    const next = applyCanonicalChanges(
      projection,
      [update('legacy'), update('other-generation'), update('not-loaded')],
      ctx,
    );
    expect(firstBlocks(next)).toEqual(firstBlocks(projection));
    expect(next.chatState.tabs[0]?.messages).toHaveLength(2);
    expect(next.chatState.tabs[0]?.messages).toBe(
      projection.chatState.tabs[0]?.messages,
    );
  });

  it('ignores an older event after a newer merged snapshot is installed', async () => {
    const merged = persistedTab([
      card('d', { status: 'completed', resultIndex: 1, finalText: 'Done' }),
    ]);
    let projection = projectionOf(merged);
    const state: ChatStateSnapshot = {
      schemaVersion: 1,
      projectId,
      worktreeId,
      revision: 5,
      tabsFile: { version: 1, tabs: [merged], activeTabId: merged.id },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };
    const sync = new RevisionedChatSync(
      { getState: (): Promise<ChatStateSnapshot> => Promise.resolve(state) },
      {
        installSnapshot: (): void => undefined,
        applyCommittedEvent: (event): void => {
          projection = applyCanonicalChanges(projection, event.changes, ctx);
        },
        onStatusChanged: (): void => undefined,
      },
    );
    await sync.hydrate(projectId, worktreeId);
    const older: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'chat:revision-4',
      occurredAt: '2026-10-19T00:00:00.000Z',
      projectId,
      worktreeId,
      baseRevision: 3,
      revision: 4,
      changes: [
        {
          ...update('d'),
          cardState: {
            version: 2,
            cardRevision: 1,
            status: 'running',
            outputTruncated: false,
          },
        },
      ],
    };
    sync.handleEvent(older);
    expect(firstBlocks(projection)[0]).toMatchObject({
      status: 'completed',
      finalText: 'Done',
    });
    expect(sync.getStatus(projectId, worktreeId)).toEqual({
      phase: 'live',
      revision: 5,
    });
  });
});
