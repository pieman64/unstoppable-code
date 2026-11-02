/** @jest-environment jsdom */
import {
  initClaudeModels,
  initCodexModels,
  type ChatStateChangedEvent,
  type ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { RevisionedChatSync } from '../revisioned-sync';
import { selectDelegationStreamHint } from '../slices/revisioned';

const projectId = 'hints-project';
const worktreeId = 'hints-worktree';
const scopeKey = `${projectId}/${worktreeId}`;
const selector = selectDelegationStreamHint(scopeKey, 'chat', 'delegate', 1);
let engine: RevisionedChatSync | undefined;
let revision = 1;
const snapshot = (rev: number): ChatStateSnapshot => ({
  schemaVersion: 1,
  projectId,
  worktreeId,
  revision: rev,
  tabsFile: {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Chat',
        model: 'codex-mini-latest',
        createdAt: '2026-10-20T00:00:00.000Z',
        messages: [
          {
            id: 'row',
            role: 'assistant',
            timestamp: 1,
            blocks: [
              {
                type: 'delegated_agent_call',
                agentBlockId: 'delegate:1',
                delegationId: 'delegate',
                runGeneration: 1,
                sequence: 1,
                parentHarnessId: 'codex',
                parentTurnId: 'turn',
                parentToolCallId: 'call',
                createdAt: 1,
                status: 'pending',
                outputTruncated: false,
                selectedModelId: 'model',
                runtimeModelId: '',
                targetHarnessId: '',
                description: 'Task',
                prompt: 'Prompt',
                executionMode: 'background',
                transcriptStore: 'chat-stream-v2',
              },
            ],
          },
        ],
      },
    ],
  },
  archives: [],
  runtimeByChatId: {},
  queue: [],
});
const getState = jest.fn<Promise<ChatStateSnapshot>, [unknown]>();
function commit(
  streamRevision: number,
  cardRevision: number,
  delegationId = 'delegate',
  runGeneration = 1,
): void {
  const event: ChatStateChangedEvent = {
    schemaVersion: 1,
    projectId,
    worktreeId,
    eventId: `event-${revision + 1}`,
    occurredAt: '2026-10-20T00:00:00.000Z',
    baseRevision: revision,
    revision: ++revision,
    changes: [
      {
        type: 'delegation.card_state_updated',
        chatId: 'chat',
        delegationId,
        runGeneration,
        streamRevision,
        cardRevision,
        cardState: {
          version: 2,
          cardRevision,
          status: 'running',
          outputTruncated: false,
        },
      },
    ],
  };
  useChatStore.getState().handleChatStateChanged(event);
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

beforeAll(() => {
  initClaudeModels([
    { id: 'claude-sonnet-4-6', label: 'Sonnet', contextWindow: 200000 },
  ]);
  initCodexModels([{ id: 'codex-mini-latest', label: 'Codex' }]);
});
beforeEach(async () => {
  useChatStore.getState().releaseChatScopeRevisioned(projectId, worktreeId);
  revision = 1;
  getState.mockReset().mockResolvedValue(snapshot(1));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        getState,
        declareStateScopes: jest.fn().mockResolvedValue(undefined),
      },
    },
  });
  useChatStore.setState({
    worktreeChats: {},
    delegationStreamHints: {},
    ensureModelDefaultsLoaded: () => Promise.resolve(null),
  });
  // The original is always invoked below with the captured engine as receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = RevisionedChatSync.prototype.hydrate;
  const instances: RevisionedChatSync[] = [];
  const capture = jest
    .spyOn(RevisionedChatSync.prototype, 'hydrate')
    .mockImplementation(function (this: RevisionedChatSync, ...args) {
      instances.push(this);
      engine = instances[0];
      return original.apply(this, args);
    });
  expect(
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId),
  ).toBe('installed');
  capture.mockRestore();
});
afterEach(() => {
  useChatStore.getState().releaseChatScopeRevisioned(projectId, worktreeId);
});

it('publishes a real committed stream revision without changing block.sequence, with stable selection', () => {
  commit(9, 2);
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 1,
    streamRevision: 9,
  });
  const selected = selector(useChatStore.getState());
  expect(selector(useChatStore.getState())).toBe(selected);
  expect(
    useChatStore.getState().worktreeChats[scopeKey].tabs[0].messages[0]
      .blocks[0],
  ).toMatchObject({ sequence: 1, streamRevision: 9 });
});
it('records unloaded cards and retains only the newest generation', () => {
  commit(7, 2, 'unloaded');
  expect(
    selectDelegationStreamHint(
      scopeKey,
      'chat',
      'unloaded',
      1,
    )(useChatStore.getState()),
  ).toEqual({ epoch: 1, streamRevision: 7 });
  commit(3, 1, 'unloaded', 2);
  commit(20, 4, 'unloaded', 1);
  expect(useChatStore.getState().delegationStreamHints[scopeKey]?.runs).toEqual(
    { 'chat:unloaded:2': { streamRevision: 3, cardRevision: 1 } },
  );
});
it('never downgrades either stream or card revisions', () => {
  commit(9, 4);
  commit(3, 2);
  commit(11, 3);
  expect(useChatStore.getState().delegationStreamHints[scopeKey]?.runs).toEqual(
    { 'chat:delegate:1': { streamRevision: 11, cardRevision: 4 } },
  );
});
it('bumps epoch during recovery and again for a replacement snapshot with no hint', async () => {
  commit(9, 2);
  let finish: (value: ChatStateSnapshot) => void = () => {
    throw new Error('Not started');
  };
  getState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  engine?.forceRefresh(projectId, worktreeId);
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 2,
    streamRevision: 0,
  });
  finish(snapshot(5));
  await flush();
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 3,
    streamRevision: 0,
  });
});
it('drops a deleted chat run even when its card was not loaded', () => {
  commit(9, 2, 'unloaded');
  const store = useChatStore.getState();
  store.handleChatStateChanged({
    schemaVersion: 1,
    projectId,
    worktreeId,
    eventId: 'deleted',
    occurredAt: '2026-10-20T00:00:00.000Z',
    baseRevision: revision,
    revision: ++revision,
    changes: [{ type: 'tab.removed', tabId: 'chat' }],
  });
  expect(useChatStore.getState().delegationStreamHints[scopeKey]?.runs).toEqual(
    {},
  );
});
it('bumps epoch on scope release and on the engine release-all host callback', async () => {
  commit(9, 2);
  engine?.releaseAll();
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 2,
    streamRevision: 0,
  });
  expect(
    await useChatStore
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId),
  ).toBe('installed');
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 3,
    streamRevision: 0,
  });
  useChatStore.getState().releaseChatScopeRevisioned(projectId, worktreeId);
  expect(selector(useChatStore.getState())).toEqual({
    epoch: 4,
    streamRevision: 0,
  });
});
