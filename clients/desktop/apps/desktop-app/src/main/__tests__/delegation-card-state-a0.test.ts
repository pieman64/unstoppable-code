import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import {
  delegationBlockId,
  applyDelegationTranscriptEvent,
  persistedDelegationSnapshot,
  isDelegatedAgentCallBlock,
  type DelegatedAgentCallBlock,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import type { CardStateDraft, CardStateV2 } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  initClaudeModels,
  initCodexModels,
  type ChatStateChangedEvent,
  type ChatStateCommandPort,
  type ChatStateSnapshot,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { registerChatStateHandlers } from '../ipc/chat-state';
import { isPersistedChatMessage } from '../lib/chat-tabs-reader';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import { applyCanonicalChanges } from '../../renderer/src/stores/chat/canonical-changes';
import type { CanonicalScopeProjection } from '../../renderer/src/stores/chat/canonical-changes';
import { fromPersistedTab } from '../../renderer/src/stores/chat/persisted-tabs';
import { RevisionedChatSync } from '../../renderer/src/stores/chat/revisioned-sync';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.setTimeout(120_000);

const projectId = 'delegation-card-state-project';
const worktreeId = 'delegation-card-state-worktree';
const preparedRoute: NonNullable<DelegatedAgentCallBlock['routeSnapshot']> = {
  selectedModelId: 'model',
  runtimeModelId: 'model',
  harnessId: 'claude',
  runtimeKind: 'local',
  runnerRegistrationId: 'claude-runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'catalog',
  providerType: 'claude',
  assignmentRevision: 'assignment-1',
  billingAuthority: 'local',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'capabilities-sha256',
  capabilityGeneration: 1,
  policyRevision: 'policy-1',
};

function rawCard(
  delegationId: string,
  routeSnapshot?: DelegatedAgentCallBlock['routeSnapshot'],
): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: delegationBlockId(delegationId, 1),
    delegationId,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'codex',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'parent-call',
    createdAt: 100,
    status: 'pending',
    outputTruncated: false,
    requestedModelId: 'requested-model',
    selectedModelId: routeSnapshot?.selectedModelId ?? 'requested-model',
    runtimeModelId: routeSnapshot?.runtimeModelId ?? '',
    targetHarnessId: routeSnapshot?.harnessId ?? '',
    ...(routeSnapshot === undefined ? {} : { routeSnapshot }),
    description: 'A delegated task',
    prompt: 'Original prompt',
    executionMode: 'background',
    transcriptStore: 'chat-stream-v2',
  };
}

function cardMessage(
  messageId: string,
  card: DelegatedAgentCallBlock,
): PersistedChatMessage {
  return {
    id: messageId,
    role: 'assistant',
    timestamp: 100,
    blocks: [card],
  };
}

function storedTab(card: DelegatedAgentCallBlock): PersistedChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [cardMessage(card.agentBlockId, card)],
    createdAt: '2026-10-19T00:00:00.000Z',
    model: 'codex-mini-latest',
  };
}

function stateSnapshot(tab: PersistedChatTab): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision: 1,
    tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

function isChatStateChangedEvent(
  value: unknown,
): value is ChatStateChangedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'changes' in value &&
    Array.isArray(value.changes)
  );
}

describe('12a A0 main card-state evidence', () => {
  let root = '';
  let fixture: RepositoryTranscriptPortFixture | undefined;

  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-card-state-a0-'));
    fixture = await createRepositoryTranscriptPortFixture(root)();
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('E1 journals a V2 descriptor, checkpoints it, and reads it after repository reopen', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    const target = current.ownedTarget('chat', 'descriptor-reopen', 1);
    const cardDraft: CardStateDraft = {
      version: 2,
      status: 'running',
      outputTruncated: false,
    };
    const expectedCardState: CardStateV2 = {
      ...cardDraft,
      cardRevision: 1,
    };

    expect(await current.port.open({ target })).toMatchObject({ ok: true });
    const update = await current.port.updateCardState({
      target,
      cardRevision: 1,
      cardDraft,
    });
    expect(update).toMatchObject({
      ok: true,
      value: { cardState: expectedCardState },
    });

    await current.checkpoint();
    await current.reopen();
    expect(await current.port.open({ target })).toMatchObject({
      ok: true,
      value: { cardState: expectedCardState },
    });
  });

  it('E4 appends an ingested detached stream card to an idle parent transcript', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    const delegation: AgentDelegationTranscript = {
      delegationId: 'ingested-stream-card',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'codex',
      parentTurnId: 'parent-chat',
      parentToolCallId: 'spawn-call',
      createdAt: 200,
      task: {
        description: 'Detached work',
        prompt: 'Review the change',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'ingested-stream-card',
        runGeneration: 1,
        status: 'pending',
        requestedModelId: 'requested-model',
        outputTruncated: false,
      },
      transcript: [],
      transcriptStore: 'chat-stream-v2',
    };

    const outcome = await current.service.ingestProviderEventWithOutcome({
      ...current.scope,
      chatId: 'chat',
      mutationId: 'detached-stream-card-first-event',
      data: { type: 'canopy_delegation', delegation },
    });
    const state = await current.repository.getState(current.scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const messages = state.tabsFile.tabs.find(
      (tab) => tab.id === 'chat',
    )?.messages;
    expect(outcome).toBe('applied');
    expect(messages?.at(-1)?.id).toBe(
      delegationBlockId('ingested-stream-card', 1),
    );
  });

  it('E8 projects descriptor state from a real repository snapshot without mutating the raw row', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    const card = rawCard('repository-reader-card');
    const message = cardMessage(card.agentBlockId, card);
    const target = current.ownedTarget('chat', card.delegationId, 1);
    await current.repository.transact(
      current.scope,
      [{ type: 'message.upserted', chatId: 'chat', message }],
      { source: 'provider' },
    );
    expect(await current.port.open({ target })).toMatchObject({ ok: true });

    const settle = await current.port.settle({
      target,
      settlementKey: 'reader-canonical-settlement',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 200 },
      finalChanges: [],
      answer: { role: 'final', text: 'Reader answer' },
      cardDraft: { version: 2, status: 'running', outputTruncated: false },
      cardRevision: 1,
    });
    expect(settle).toMatchObject({ ok: true });

    const snapshot = await current.repository.getState(current.scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const projectedCard = snapshot.tabsFile.tabs
      .find((tab) => tab.id === 'chat')
      ?.messages.find((entry) => entry.id === message.id)?.blocks[0];
    const rawRow = await current.readStoredParentMessage('chat', message.id);
    expect(projectedCard).toMatchObject({
      delegationId: 'repository-reader-card',
      status: 'completed',
      outputTruncated: false,
      finalText: 'Reader answer',
    });
    expect(rawRow).toEqual(message);
  });

  it('R2-B1 raw stream rows with absent and prepared routes pass both existing validators', () => {
    const withoutRoute = rawCard('raw-absent-route');
    const withRoute = rawCard('raw-prepared-route', {
      selectedModelId: 'selected-model',
      runtimeModelId: 'runtime-model',
      harnessId: 'claude',
      runtimeKind: 'local',
      runnerRegistrationId: 'claude-runner',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'catalog',
      providerType: 'claude',
      assignmentRevision: 'assignment-1',
      billingAuthority: 'local',
      aiCreditsRouted: false,
      capabilities: [],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'capabilities-sha256',
      capabilityGeneration: 1,
      policyRevision: 'policy-1',
    });
    for (const card of [withoutRoute, withRoute]) {
      expect(isDelegatedAgentCallBlock(card)).toBe(true);
      expect(isPersistedChatMessage(cardMessage(card.agentBlockId, card))).toBe(
        true,
      );
    }
  });

  it.each([false, true])(
    'E1 reducer-produced raw creation row persists/checkpoints/reopens before any update (prepared route %s)',
    async (prepared) => {
      const current = fixture;
      if (!current) throw new Error('Repository fixture was not created');
      const delegationId = prepared ? 'prepared-raw' : 'absent-raw';
      const delegation: AgentDelegationTranscript = {
        delegationId,
        runGeneration: 1,
        sequence: 0,
        parentHarnessId: 'codex',
        parentTurnId: 'turn',
        parentToolCallId: 'call',
        createdAt: 1,
        task: {
          description: 'Task',
          prompt: 'Original',
          executionMode: 'background',
        },
        snapshot: {
          delegationId,
          status: 'pending',
          outputTruncated: false,
          ...(prepared
            ? { routeSnapshot: preparedRoute }
            : { requestedModelId: 'requested' }),
        },
        transcript: [],
        transcriptStore: 'chat-stream-v2',
      };
      const state = applyDelegationTranscriptEvent(
        { messages: [], status: 'idle', error: null, planMode: false },
        { delegation },
      );
      const row = state.messages[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Reducer did not create row');
      expect(isPersistedChatMessage(row)).toBe(true);
      await current.repository.transact(
        current.scope,
        [{ type: 'message.upserted', chatId: 'chat', message: row }],
        { source: 'automation' },
      );
      const target = current.ownedTarget('chat', delegationId, 1);
      expect(await current.port.open({ target })).toMatchObject({ ok: true });
      expect(await current.readStoredParentMessage('chat', row.id)).toEqual(
        row,
      );
      await current.checkpoint();
      await current.reopen();
      expect(await current.readStoredParentMessage('chat', row.id)).toEqual(
        row,
      );
      expect(await current.port.open({ target })).toMatchObject({
        ok: true,
        value: { streamRevision: 0, cardState: null },
      });
    },
  );

  it('E9 preserves the legacy projection’s exact ordered JSON and accepted-control deletion', () => {
    const snapshot: AgentDelegationSnapshot = {
      delegationId: 'legacy-json-card',
      status: 'running',
      outputTruncated: false,
      routeSnapshot: preparedRoute,
      requestedModelId: undefined,
      partialText: undefined,
      phase: undefined,
      queue: undefined,
      approvalPending: undefined,
      stopRequested: undefined,
      workspaceObservation: undefined,
      control: {
        operationId: 'accepted-steer',
        operation: 'steer',
        status: 'accepted',
      },
      usage: { inputTokens: 10, outputTokens: 1 },
    };

    expect(JSON.stringify(persistedDelegationSnapshot(snapshot))).toBe(
      '{"delegationId":"legacy-json-card","status":"running","outputTruncated":false,"routeSnapshot":{"selectedModelId":"model","runtimeModelId":"model","harnessId":"claude","runtimeKind":"local","runnerRegistrationId":"claude-runner","runtimeVersion":"1","adapterVersion":"1","modelSource":"catalog","providerType":"claude","assignmentRevision":"assignment-1","billingAuthority":"local","aiCreditsRouted":false,"capabilities":[],"supportedThinkingLevels":[],"capabilitySnapshotHash":"capabilities-sha256","capabilityGeneration":1,"policyRevision":"policy-1"}}',
    );
  });

  it('E7 transports the committed K8 event through IPC, revisioned sync, and canonical changes', async () => {
    const card = rawCard('ipc-card');
    const tab = storedTab(card);
    const initial = stateSnapshot(tab);
    let projection: CanonicalScopeProjection = {
      chatState: { tabs: [fromPersistedTab(tab)], activeTabId: tab.id },
      archives: [],
      runtimeByChatId: {},
      pendingQuestions: {},
    };
    const storeInputs: ChatStateChangedEvent[] = [];
    const sync = new RevisionedChatSync(
      { getState: (): Promise<ChatStateSnapshot> => Promise.resolve(initial) },
      {
        installSnapshot: (): void => undefined,
        applyCommittedEvent: (event): void => {
          storeInputs.push(event);
          projection = applyCanonicalChanges(projection, event.changes, {
            projectId,
            worktreeId,
          });
        },
        onStatusChanged: (): void => undefined,
      },
    );
    const hydration = sync.hydrate(projectId, worktreeId);
    await hydration;

    let publish: ((event: ChatStateChangedEvent) => void) | undefined;
    const port: ChatStateCommandPort = {
      getState: () => Promise.resolve(initial),
      searchTranscript: () => Promise.resolve({ matches: [], totalCount: 0 }),
      getTranscriptPage: () =>
        Promise.resolve({
          messages: [],
          totalMessages: 0,
          transcriptRevision: 1,
        }),
      readToolOutput: () => Promise.resolve({ text: '', byteLength: 0 }),
      readVisual: jest.fn<
        ReturnType<ChatStateCommandPort['readVisual']>,
        Parameters<ChatStateCommandPort['readVisual']>
      >(),
      command: (request) =>
        Promise.resolve({
          commandId: request.commandId,
          revision: 1,
          outcome: 'applied',
        }),
      subscribe: (listener): (() => void) => {
        publish = listener;
        return (): void => {
          publish = undefined;
        };
      },
    };
    const forwarded: ChatStateChangedEvent[] = [];
    const send = jest.fn((channel: string, ...args: unknown[]): void => {
      const payload = args[0];
      if (
        channel === IPC_CHANNELS.chatStateChanged &&
        isChatStateChangedEvent(payload)
      ) {
        forwarded.push(payload);
        sync.handleEvent(payload);
      }
    });
    const dispatcher = createDesktopRuntime({ getChatStatePort: () => port });
    const window = new BrowserWindow();
    jest.spyOn(window.webContents, 'send').mockImplementation(send);
    const dispose = registerChatStateHandlers(port, () => [window], {
      dispatcher,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
    try {
      for (let turn = 0; turn < 8 && publish === undefined; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      const cardState: CardStateV2 = {
        version: 2,
        cardRevision: 1,
        status: 'running',
        outputTruncated: false,
        prompt: 'Queued prompt after host input',
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
            chatId: tab.id,
            delegationId: card.delegationId,
            runGeneration: 1,
            cardRevision: 1,
            streamRevision: 1,
            cardState,
          },
        ],
      };
      publish?.(event);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(forwarded).toEqual([event]);
      expect(storeInputs).toEqual([event]);
      // The renderer applies the V2 draft: its status and amended prompt replace
      // the creation values, the absent optional requested model clears, and
      // the event's stream revision is stamped for display.
      const { requestedModelId: _requested, ...applied } = card;
      void _requested;
      expect(projection.chatState.tabs[0]?.messages[0]?.blocks[0]).toEqual({
        ...applied,
        status: 'running',
        prompt: 'Queued prompt after host input',
        streamRevision: 1,
      });
    } finally {
      dispose();
      await dispatcher.shutdown();
    }
  });
});
