import {
  delegationBlockId,
  type DelegatedAgentCallBlock,
} from '@canopy/agent-transcript';
import {
  initClaudeModels,
  initCodexModels,
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

const projectId = 'delegation-card-state-renderer-project';
const worktreeId = 'delegation-card-state-renderer-worktree';

function card(delegationId: string): DelegatedAgentCallBlock {
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
    requestedModelId: 'requested-model',
    selectedModelId: 'requested-model',
    runtimeModelId: '',
    targetHarnessId: '',
    description: 'Delegated task',
    prompt: 'Creation prompt',
    executionMode: 'background',
    transcriptStore: 'chat-stream-v2',
  };
}

function message(id: string, delegationId: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 100,
    blocks: [card(delegationId)],
  };
}

function tab(): PersistedChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [
      message('loaded-row', 'loaded-card'),
      message('other-row', 'other-card'),
    ],
    createdAt: '2026-10-19T00:00:00.000Z',
    model: 'codex-mini-latest',
  };
}

function snapshot(value: PersistedChatTab): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision: 1,
    tabsFile: { version: 1, tabs: [value], activeTabId: value.id },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

describe('12a A0 renderer card-state event', () => {
  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });

  it('E7 applies a revisioned card-state event to the loaded card only', async () => {
    const persisted = tab();
    let projection: CanonicalScopeProjection = {
      chatState: {
        tabs: [fromPersistedTab(persisted)],
        activeTabId: persisted.id,
      },
      archives: [],
      runtimeByChatId: {},
      pendingQuestions: {},
    };
    const sync = new RevisionedChatSync(
      {
        getState: (): Promise<ChatStateSnapshot> =>
          Promise.resolve(snapshot(persisted)),
      },
      {
        installSnapshot: (): void => undefined,
        applyCommittedEvent: (event): void => {
          projection = applyCanonicalChanges(projection, event.changes, {
            projectId,
            worktreeId,
          });
        },
        onStatusChanged: (): void => undefined,
      },
    );
    await sync.hydrate(projectId, worktreeId);

    const cardState: CardStateV2 = {
      version: 2,
      cardRevision: 1,
      status: 'running',
      outputTruncated: false,
      prompt: 'Prompt amended while queued',
    };
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'chat:revision-2',
      occurredAt: '2026-10-19T00:00:00.000Z',
      projectId,
      worktreeId,
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: 'delegation.card_state_updated',
          chatId: 'chat',
          delegationId: 'loaded-card',
          runGeneration: 1,
          cardRevision: 1,
          streamRevision: 1,
          cardState,
        },
      ],
    };
    sync.handleEvent(event);

    const rows = projection.chatState.tabs[0]?.messages ?? [];
    expect(rows[0]?.blocks[0]).toMatchObject({
      delegationId: 'loaded-card',
      prompt: 'Prompt amended while queued',
    });
    expect(rows[1]?.blocks[0]).toMatchObject({
      delegationId: 'other-card',
      prompt: 'Creation prompt',
    });
    expect(sync.getStatus(projectId, worktreeId)).toEqual({
      phase: 'live',
      revision: 2,
    });
  });
});
