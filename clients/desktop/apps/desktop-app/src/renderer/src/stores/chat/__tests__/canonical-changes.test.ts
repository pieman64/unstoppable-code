// Frontend plan Phase 3 coverage: committed canonical changes apply
// materialized values only — tab lifecycle, ordered messages by stable id,
// runtime patches (no stale Stop button), pending questions, and archive
// summaries — without provider-event reduction or persistence side effects.
import type {
  ArchivedChatSummary,
  ChatTabMetadataPatch,
  ChatRuntimeState,
  ChatStateChange,
  PersistedChatMessage,
  PersistedChatTab,
  HostQueuedMessageView,
} from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  applyCanonicalChanges,
  applyRuntimeStatusesToTabs,
  chatRuntimeStatusToTabStatus,
  preserveRendererOnlyTabFields,
  type CanonicalScopeProjection,
} from '../canonical-changes';
import {
  computeTurnSummary,
  groupIntoTurns,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import { installTranscriptPage } from '../transcript-pages';
import { beginLocalCodexSpeedWrite } from '../codex-speed';
import { fromPersistedTab, toPersistedTab } from '../persisted-tabs';
import {
  reconcilePendingQueueMessages,
  presentedMessages,
  restoreDispatchedQueueRow,
} from '../optimistic-presentation';
import type { ChatTab, QueuedChatMessage } from '../types';
import {
  attachHostQueueMirror,
  hostQueueViewsToQueuedMessages,
  queuedRowForceAction,
} from '../queue-mirror';

it('reconciles identical pending queue submissions one-to-one across successive snapshots', () => {
  const pending: ChatTab['pendingQueueMessages'] = ['first', 'second'].map(
    (id) => ({
      userMessageId: id,
      previousHostIds: ['old-row'],
      message: { text: 'same text', pendingSend: true },
    }),
  );
  const oldRow: QueuedChatMessage = {
    text: 'same text',
    origin: 'desktop',
    hostQueueEntryId: 'old-row',
  };
  expect(reconcilePendingQueueMessages(pending, [oldRow])).toBe(pending);
  const first = { ...oldRow, hostQueueEntryId: 'new-row-1' };
  const remaining = reconcilePendingQueueMessages(pending, [oldRow, first]);
  expect(remaining?.map((entry) => entry.userMessageId)).toEqual(['second']);
  expect(reconcilePendingQueueMessages(remaining, [oldRow, first])).toBe(
    remaining,
  );
  expect(
    reconcilePendingQueueMessages(remaining, [
      oldRow,
      first,
      { ...first, hostQueueEntryId: 'new-row-2' },
    ]),
  ).toBeUndefined();
});

beforeAll(() => {
  initClaudeModels([
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
  ]);
  initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
});

const ctx = { projectId: 'proj', worktreeId: 'wt' };

function metadataPatchWithPrototypeKeys(): ChatTabMetadataPatch {
  const patch: ChatTabMetadataPatch = { title: 'Safe title' };
  Object.defineProperty(patch, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true,
  });
  Object.defineProperty(patch, 'prototype', {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true,
  });
  return patch;
}

function message(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function persistedTab(id: string, title = `Tab ${id}`): PersistedChatTab {
  return {
    id,
    title,
    messages: [message(`${id}-m1`, 'hello')],
    createdAt: '2026-08-07T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
  };
}

function runtimeState(
  status: ChatRuntimeState['status'],
  error?: string,
): ChatRuntimeState {
  return {
    status,
    queuedMessageIds: [],
    ...(error
      ? {
          error: {
            code: 'provider_error' as const,
            message: error,
            retryable: true,
            occurredAt: '2026-08-07T00:00:00.000Z',
          },
        }
      : {}),
  };
}

function baseProjection(): CanonicalScopeProjection {
  const tabA = fromPersistedTab(persistedTab('a'));
  const tabB = fromPersistedTab(persistedTab('b'));
  return {
    chatState: { tabs: [tabA, tabB], activeTabId: 'a' },
    archives: [],
    runtimeByChatId: {},
    pendingQuestions: {},
  };
}

function apply(
  projection: CanonicalScopeProjection,
  ...changes: ChatStateChange[]
): CanonicalScopeProjection {
  return applyCanonicalChanges(projection, changes, ctx);
}

describe('applyCanonicalChanges', () => {
  it('keeps a rank-safe reset window equal to reloading the same logical rows', () => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs[0];
    tab.messages = [
      message('first', 'first'),
      message('removed', 'removed'),
      message('last', 'last'),
    ];
    tab.transcriptLoaded = true;
    tab.transcriptWindow = {
      view: 'turns',
      turns: [],
      before: 10,
      messageOrdinals: { first: 10, removed: 11, last: 12 },
      totalMessages: 13,
      transcriptRevision: 1,
    };
    const transcript = {
      format: 'complete-message-jsonl-v1' as const,
      committedMessageCount: 13,
      committedByteLength: 100,
      transcriptRevision: 2,
      hasActiveSidecar: false,
    };
    const shortcut = apply(
      projection,
      {
        type: 'message.upserted',
        chatId: 'a',
        message: message('inserted', 'inserted'),
        afterMessageId: 'first',
      },
      { type: 'message.removed', chatId: 'a', messageId: 'removed' },
      { type: 'transcript.updated', chatId: 'a', transcript, reset: true },
    ).chatState.tabs[0];
    const reloaded = installTranscriptPage(
      { ...tab, transcript },
      {
        view: 'turns',
        turns: [],
        before: 10,
        messages: [
          message('first', 'first'),
          message('inserted', 'inserted'),
          message('last', 'last'),
        ],
        messageOrdinals: { first: 10, inserted: 11, last: 12 },
        totalMessages: 13,
        transcriptRevision: 2,
      },
      false,
    );
    expect(shortcut.transcriptLoaded).toBe(true);
    expect(shortcut.messages).toEqual(reloaded.messages);
    expect(shortcut.transcriptWindow).toEqual(reloaded.transcriptWindow);
  });

  it.each([
    'replacement',
    'unloaded-predecessor',
    'unpositioned-insert',
    'unloaded-removal',
    'pending-reset',
    'no-evidence',
    'unranked-predecessor',
    'root-turn-change',
    'removed-predecessor',
    'new-predecessor',
  ] as const)('reloads a reset conservatively for %s', (reason) => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs[0];
    tab.transcriptLoaded = reason !== 'pending-reset';
    tab.transcriptWindow = {
      view: 'turns',
      turns: [],
      before: 10,
      messageOrdinals: { 'a-m1': 10 },
      totalMessages: 11,
      transcriptRevision: 1,
    };
    if (reason === 'unranked-predecessor')
      tab.transcriptWindow.messageOrdinals = {};
    if (reason === 'root-turn-change')
      tab.transcriptWindow.turns = [
        {
          id: 'a-m1',
          start: 10,
          end: 11,
          complete: true,
          summary: computeTurnSummary([]),
          finalMessageIds: [],
        },
      ];
    const mutations: ChatStateChange[] =
      reason === 'replacement'
        ? [
            {
              type: 'messages.replaced',
              chatId: 'a',
              messages: tab.messages,
              removedMessageIds: [],
            },
          ]
        : reason === 'unloaded-removal'
          ? [{ type: 'message.removed', chatId: 'a', messageId: 'not-loaded' }]
          : reason === 'no-evidence'
            ? []
            : [
                {
                  type: 'message.upserted',
                  chatId: 'a',
                  message: message('new', 'new'),
                  ...(reason === 'unpositioned-insert'
                    ? {}
                    : {
                        afterMessageId:
                          reason === 'unloaded-predecessor'
                            ? 'not-loaded'
                            : 'a-m1',
                      }),
                },
              ];
    if (reason === 'removed-predecessor')
      mutations.unshift({
        type: 'message.removed',
        chatId: 'a',
        messageId: 'a-m1',
      });
    if (reason === 'new-predecessor')
      mutations.push({
        type: 'message.upserted',
        chatId: 'a',
        message: message('second-new', 'second-new'),
        afterMessageId: 'new',
      });
    const result = apply(projection, ...mutations, {
      type: 'transcript.updated',
      chatId: 'a',
      reset: true,
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 12,
        committedByteLength: 100,
        transcriptRevision: 2,
        hasActiveSidecar: false,
      },
    });
    expect(result.chatState.tabs[0].transcriptLoaded).toBe(false);
    expect(result.chatState.tabs[0].transcriptWindow).toBeDefined();
  });

  it('retains the visible transcript window and advances its reset token on repeated resets', () => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs[0];
    const transcript = {
      format: 'complete-message-jsonl-v1' as const,
      committedMessageCount: 2,
      committedByteLength: 120,
      transcriptRevision: 10,
      hasActiveSidecar: false,
    };
    tab.transcript = transcript;
    tab.transcriptLoaded = true;
    tab.transcriptWindow = {
      view: 'turns',
      turns: [],
      before: 0,
      messageOrdinals: { 'a-m1': 1 },
      totalMessages: 2,
      transcriptRevision: 10,
    };

    const firstReset = apply(projection, {
      type: 'transcript.updated',
      chatId: 'a',
      transcript: { ...transcript, transcriptRevision: 11 },
      reset: true,
    });
    const repeatedReset = apply(firstReset, {
      type: 'transcript.updated',
      chatId: 'a',
      transcript: { ...transcript, transcriptRevision: 12 },
      reset: true,
    });

    expect(repeatedReset.chatState.tabs[0].messages).toBe(tab.messages);
    expect(repeatedReset.chatState.tabs[0].transcriptLoaded).toBe(false);
    expect(repeatedReset.chatState.tabs[0].transcriptWindow).toMatchObject({
      view: 'turns',
      before: 0,
      messageOrdinals: { 'a-m1': 1 },
      transcriptRevision: 12,
    });
  });

  it('inserts a new delegation run after its visible anchor', () => {
    const projection = baseProjection();
    projection.chatState.tabs[0].messages.push(message('later', 'later turn'));
    const inserted = apply(projection, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('run-2', 'follow-up result'),
      afterMessageId: 'a-m1',
    });
    expect(inserted.chatState.tabs[0].messages.map((row) => row.id)).toEqual([
      'a-m1',
      'run-2',
      'later',
    ]);
    const paged = apply(projection, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('run-2', 'follow-up result'),
      afterMessageId: 'paged-out-parent',
    });
    expect(paged.chatState.tabs[0].messages.map((row) => row.id)).toEqual([
      'a-m1',
      'later',
    ]);
    // A positioned update to a row this page already holds stays in place.
    const updated = apply(inserted, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('run-2', 'final result'),
      afterMessageId: 'paged-out-parent',
    });
    expect(updated.chatState.tabs[0].messages.map((row) => row.id)).toEqual([
      'a-m1',
      'run-2',
      'later',
    ]);
  });

  it('attributes canonical work by change type', () => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    globalThis.__CANOPY_TRANSCRIPT_PERF__ = {
      schemaVersion: 2,
      startedAt: performance.now(),
      stages: {},
      counters: {},
      correlations: [],
    };
    try {
      applyCanonicalChanges(
        baseProjection(),
        [
          { type: 'tab.order_changed', tabIds: ['b', 'a'] },
          { type: 'tab.active_changed', activeTabId: 'b' },
        ],
        ctx,
      );

      expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.counters).toMatchObject({
        canonical_changes: 2,
        canonical_change_tab_order_changed: 1,
        canonical_change_tab_active_changed: 1,
      });
    } finally {
      delete globalThis.__CANOPY_TRANSCRIPT_PERF__;
      Object.defineProperty(globalThis, '__CANOPY_E2E__', {
        configurable: true,
        value: false,
      });
    }
  });

  it.each(['desktop', 'portal'] as const)(
    'reuses the refused original through funded Retry and reconciliation for %s-origin queue rows',
    (origin) => {
      const projection = baseProjection();
      const original = message('original-user', 'saved original');
      projection.chatState.tabs[0].messages = [original];
      const held: HostQueuedMessageView = {
        id: 'credit-retry',
        text: 'saved original',
        origin,
        enqueuedAtMs: 1,
        supersedesUserMessageId: original.id,
        retryable: true,
        retryBlockedReason: 'insufficient_credits',
        turnPhase: 'idle',
      };
      const hydrateQueue = (row: HostQueuedMessageView): void => {
        projection.chatState.tabs = attachHostQueueMirror(
          projection.chatState.tabs,
          new Map([['a', hostQueueViewsToQueuedMessages([row])]]),
        );
      };
      projection.runtimeByChatId.a = {
        status: 'completed',
        queuedMessageIds: [held.id],
      };
      hydrateQueue(held);
      expect(
        queuedRowForceAction(
          projection.chatState.tabs[0].queuedMessages[0],
          'idle',
        ),
      ).toBe('retry');
      expect(
        projection.chatState.tabs[0].queuedMessages[0].retryBlockedReason,
      ).toBe('insufficient_credits');
      hydrateQueue({ ...held, retryBlockedReason: undefined });
      // Funding republishes the row; only explicit host Retry dequeues it.
      expect(projection.chatState.tabs[0].messages).toEqual([original]);
      expect(projection.chatState.tabs[0].queuedMessages).toHaveLength(1);
      const retried = apply(projection, {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: {
          status: 'starting',
          queuedMessageIds: [],
          lastActivityAt: 20,
        },
      });
      expect(retried.chatState.tabs[0].queuedMessages).toEqual([]);
      expect(retried.chatState.tabs[0].messages).toEqual([original]);
      expect(retried.chatState.tabs[0].pendingQueueDispatch).toBeUndefined();
      const reconciled = apply(
        retried,
        { type: 'message.upserted', chatId: 'a', message: original },
        {
          type: 'runtime.patched',
          chatId: 'a',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      );
      expect(reconciled.chatState.tabs[0].messages).toEqual([original]);
      expect(reconciled.chatState.tabs[0].pendingUserMessages).toBeUndefined();
      // Same text is valid for another prompt; identity is the oracle.
      const distinct = apply(reconciled, {
        type: 'message.upserted',
        chatId: 'a',
        message: message('distinct-user', 'saved original'),
      });
      expect(distinct.chatState.tabs[0].messages.map((row) => row.id)).toEqual([
        'original-user',
        'distinct-user',
      ]);
    },
  );

  it.each(['delta', 'hydration'] as const)(
    'reconciles a delayed credit-retry original by identity through %s, ignoring identical text with a different ID',
    (delivery) => {
      const projection = baseProjection();
      projection.chatState.tabs[0].messages = [];
      projection.chatState.tabs = attachHostQueueMirror(
        projection.chatState.tabs,
        new Map([
          [
            'a',
            hostQueueViewsToQueuedMessages([
              {
                id: 'credit-retry',
                text: 'saved original',
                origin: 'desktop',
                enqueuedAtMs: 1,
                supersedesUserMessageId: 'original-user',
                retryable: true,
                turnPhase: 'idle',
              },
            ]),
          ],
        ]),
      );
      projection.runtimeByChatId.a = {
        status: 'completed',
        queuedMessageIds: ['credit-retry'],
      };
      const dequeued = apply(projection, {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: {
          status: 'starting',
          queuedMessageIds: [],
          lastActivityAt: 20,
        },
      });
      const unrelated = message('distinct-user', 'saved original');
      const intermediate = apply(dequeued, {
        type: 'message.upserted',
        chatId: 'a',
        message: unrelated,
      });
      expect(intermediate.chatState.tabs[0].pendingQueueDispatch).toBeDefined();
      expect(
        intermediate.chatState.tabs[0].messages.filter(
          (row) => row.role === 'user',
        ),
      ).toHaveLength(2);
      // Canonical content can differ from the retained queue preview.
      const original = message('original-user', 'canonical original');
      const accepted =
        delivery === 'delta'
          ? apply(intermediate, {
              type: 'message.upserted',
              chatId: 'a',
              message: original,
            })
          : apply(intermediate, {
              type: 'tab.upserted',
              tab: { ...persistedTab('a'), messages: [unrelated, original] },
            });
      expect(
        accepted.chatState.tabs[0].messages
          .filter((row) => row.role === 'user')
          .map((row) => row.id),
      ).toEqual(['distinct-user', 'original-user']);
      expect(accepted.chatState.tabs[0].pendingQueueDispatch).toBeUndefined();
      expect(accepted.chatState.tabs[0].pendingUserMessages ?? []).toEqual([]);
    },
  );

  it('bridges a dequeued prompt into the transcript until its canonical user and timer arrive', () => {
    const projection = baseProjection();
    projection.chatState.tabs[0].messages = [message('old-user', 'go')];
    projection.chatState.tabs[0].queuedMessages = [
      { hostQueueEntryId: 'queue-1', text: 'go', origin: 'desktop' },
    ];
    projection.runtimeByChatId.a = {
      status: 'completed',
      queuedMessageIds: ['queue-1'],
    };
    const dequeued = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: { status: 'idle', queuedMessageIds: [], lastActivityAt: 20 },
    });
    const tab = dequeued.chatState.tabs[0];
    expect(tab.queuedMessages).toHaveLength(0);
    expect(tab.messages.at(-1)).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }],
    });
    expect(presentedMessages(tab).at(-1)?.blocks[0].type).toBe('turn_timer');
    const oldEcho = apply(dequeued, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('old-user', 'go'),
    });
    expect(oldEcho.chatState.tabs[0].pendingQueueDispatch).toBeDefined();
    const restored = restoreDispatchedQueueRow(tab, [
      { hostQueueEntryId: 'queue-1', text: 'go' },
    ]);
    expect(restored.pendingQueueDispatch).toBeUndefined();
    expect(restored.pendingTurn).toBeUndefined();
    expect(restored.messages).toEqual(projection.chatState.tabs[0].messages);
    const stale = apply(dequeued, {
      type: 'tab.upserted',
      tab: persistedTab('a'),
    });
    expect(stale.chatState.tabs[0].messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'go' },
    ]);
    const accepted = apply(stale, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('real-user', 'go'),
    });
    expect(
      accepted.chatState.tabs[0].messages.filter((row) =>
        row.blocks.some(
          (block) => block.type === 'text' && block.text === 'go',
        ),
      ),
    ).toHaveLength(1);
    expect(accepted.chatState.tabs[0].pendingTurn?.userMessageId).toBe(
      'real-user',
    );
    const completed = apply(accepted, {
      type: 'message.upserted',
      chatId: 'a',
      message: {
        id: 'real-timer',
        role: 'system',
        timestamp: 21,
        blocks: [{ type: 'turn_timer', startedAt: 20, completedAt: 21 }],
      },
    });
    expect(completed.chatState.tabs[0].pendingTurn).toBeUndefined();
  });

  it('does not synthesize another user bubble for Portal prompts already persisted before queueing', () => {
    const projection = baseProjection();
    projection.chatState.tabs[0].messages = [message('portal-user', 'go')];
    projection.chatState.tabs[0].queuedMessages = [
      { hostQueueEntryId: 'portal-queue', text: 'go', origin: 'portal' },
    ];
    projection.runtimeByChatId.a = {
      status: 'queued',
      queuedMessageIds: ['portal-queue'],
    };
    const dispatched = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: { status: 'idle', queuedMessageIds: [] },
    });
    expect(dispatched.chatState.tabs[0].messages).toEqual(
      projection.chatState.tabs[0].messages,
    );
  });

  it('keeps no turn live after a sent prompt is cancelled from the host queue', () => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs[0];
    const prompt = message('queued-user', 'later');
    const localTimer: ChatTab['messages'][number] = {
      id: 'local-timer',
      role: 'system',
      timestamp: 10,
      blocks: [{ type: 'turn_timer', startedAt: 10, completedAt: null }],
    };
    tab.messages = [...tab.messages, prompt, localTimer];
    tab.pendingTurn = {
      userMessageId: 'queued-user',
      timerMessage: localTimer,
    };
    tab.pendingUserMessages = [prompt];

    const cancelled = apply(projection, {
      type: 'message.removed',
      chatId: 'a',
      messageId: 'queued-user',
    });
    // A later watcher turn runs to completion after the cancellation.
    const later = apply(
      cancelled,
      {
        type: 'message.upserted',
        chatId: 'a',
        message: message('watcher-user', 'event'),
        afterMessageId: 'a-m1',
      },
      {
        type: 'message.upserted',
        chatId: 'a',
        message: {
          id: 'turn-2:timer',
          role: 'system',
          timestamp: 21,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'turn-2',
              userMessageId: 'watcher-user',
              startedAt: 20,
              completedAt: 22,
            },
          ],
        },
        afterMessageId: 'watcher-user',
      },
    );

    const groups = groupIntoTurns(
      mergeToolResults(
        reorderMessagesForDisplay(presentedMessages(later.chatState.tabs[0])),
        undefined,
      ),
    );
    expect(
      groups.filter(
        (group) => group.kind === 'turn-group' && !group.isComplete,
      ),
    ).toEqual([]);
    expect(later.chatState.tabs[0].pendingTurn).toBeUndefined();
    expect(later.chatState.tabs[0].pendingUserMessages).toBeUndefined();
  });

  it('does not present cancelled queue removals as sent', () => {
    const projection = baseProjection();
    projection.chatState.tabs[0].queuedMessages = [
      { hostQueueEntryId: 'queue-1', text: 'cancel me' },
    ];
    projection.runtimeByChatId.a = {
      status: 'queued',
      queuedMessageIds: ['queue-1'],
    };
    const cancelled = apply(
      projection,
      {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
      { type: 'message.removed', chatId: 'a', messageId: 'unknown-user-id' },
    );
    expect(cancelled.chatState.tabs[0].pendingTurn).toBeUndefined();
    expect(cancelled.chatState.tabs[0].messages).toEqual(
      projection.chatState.tabs[0].messages,
    );
  });

  it('does not present an input-delivery queue removal as a new root turn', () => {
    const projection = baseProjection();
    projection.chatState.tabs[0].queuedMessages = [
      {
        hostQueueEntryId: 'queue-1',
        text: 'steer this',
        origin: 'desktop',
      },
    ];
    projection.chatState.tabs[0].inputDelivery = {
      version: 1,
      epoch: 0,
      rows: [
        {
          id: 'delivery-1',
          revision: 0,
          createdAt: 1,
          state: 'pending',
          text: 'steer this',
          payload: {
            projectId: 'p',
            worktreeId: 'w',
            chatId: 'a',
            userMessageId: 'delivery-1',
            text: 'steer this',
          },
          settingsKey: 'settings',
          origin: 'desktop',
          attempts: [],
        },
      ],
    };
    projection.runtimeByChatId.a = {
      status: 'streaming',
      queuedMessageIds: ['queue-1'],
    };

    const steered = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: { status: 'streaming', queuedMessageIds: [] },
    });

    expect(steered.chatState.tabs[0].pendingQueueDispatch).toBeUndefined();
    expect(steered.chatState.tabs[0].pendingTurn).toBeUndefined();
    expect(steered.chatState.tabs[0].messages).toEqual(
      projection.chatState.tabs[0].messages,
    );
  });

  it('keeps the pending turn through stale tabs and user acknowledgement until the real timer arrives', () => {
    const projection = baseProjection();
    const user = message('submitted', 'go');
    const timer: PersistedChatMessage = {
      id: 'local-timer',
      role: 'system',
      timestamp: 2,
      blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: null }],
    };
    Object.assign(projection.chatState.tabs[0], {
      messages: [user, timer],
      pendingUserMessages: [user],
      pendingTurn: { userMessageId: user.id, timerMessage: timer },
    });
    const stale = apply(projection, {
      type: 'tab.upserted',
      tab: persistedTab('a'),
    });
    expect(presentedMessages(stale.chatState.tabs[0])).toContainEqual(timer);
    const acknowledged = apply(stale, {
      type: 'message.upserted',
      chatId: 'a',
      message: user,
    });
    expect(presentedMessages(acknowledged.chatState.tabs[0])).toContainEqual(
      timer,
    );
    const realTimer = { ...timer, id: 'host-timer' };
    const running = apply(acknowledged, {
      type: 'message.upserted',
      chatId: 'a',
      message: realTimer,
    });
    expect(running.chatState.tabs[0].messages).not.toContainEqual(timer);
    expect(running.chatState.tabs[0].messages).toContainEqual(realTimer);
    expect(running.chatState.tabs[0]).not.toHaveProperty(
      'pendingTurn',
      expect.anything(),
    );
  });

  it('removes a pending timer on a canonical error without waiting for a timer echo', () => {
    const projection = baseProjection();
    const user = message('submitted', 'go');
    const timer: PersistedChatMessage = {
      id: 'local-timer',
      role: 'system',
      timestamp: 2,
      blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: null }],
    };
    Object.assign(projection.chatState.tabs[0], {
      messages: [user, timer],
      pendingTurn: { userMessageId: user.id, timerMessage: timer },
    });
    const failed = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: runtimeState('failed', 'No session'),
    });
    expect(presentedMessages(failed.chatState.tabs[0])).not.toContainEqual(
      timer,
    );
    expect(failed.chatState.tabs[0]).not.toHaveProperty(
      'pendingTurn',
      expect.anything(),
    );
  });

  it('upserts a new tab and preserves renderer-only fields on replacement', () => {
    const projection = baseProjection();
    const withNew = apply(projection, {
      type: 'tab.upserted',
      tab: persistedTab('c'),
    });
    expect(withNew.chatState.tabs.map((tab) => tab.id)).toEqual([
      'a',
      'b',
      'c',
    ]);

    // Replacement of an existing tab keeps transient renderer state.
    const marked = {
      ...withNew,
      chatState: {
        ...withNew.chatState,
        tabs: withNew.chatState.tabs.map((tab) =>
          tab.id === 'a'
            ? {
                ...tab,
                pendingAttachments: [
                  { absolutePath: '/tmp/x.png', filename: 'x.png' },
                ],
              }
            : tab,
        ),
      },
    };
    const replaced = apply(marked, {
      type: 'tab.upserted',
      tab: persistedTab('a', 'Renamed'),
    });
    const tabA = replaced.chatState.tabs.find((tab) => tab.id === 'a');
    expect(tabA?.title).toBe('Renamed');
    expect(tabA?.pendingAttachments).toHaveLength(1);
  });

  it('removes tabs, reassigns the active tab, and drops runtime entries', () => {
    const projection = {
      ...baseProjection(),
      runtimeByChatId: { a: runtimeState('streaming') },
    };
    const next = apply(projection, { type: 'tab.removed', tabId: 'a' });
    expect(next.chatState.tabs.map((tab) => tab.id)).toEqual(['b']);
    expect(next.chatState.activeTabId).toBe('b');
    expect(next.runtimeByChatId.a).toBeUndefined();
  });

  it('drops only the removed tab pending questions with its projection', () => {
    const withQuestions = apply(
      baseProjection(),
      {
        type: 'pending_question.upserted',
        question: { requestId: 'q-a', chatId: 'a', questions: [] },
      },
      {
        type: 'pending_question.upserted',
        question: { requestId: 'q-b', chatId: 'b', questions: [] },
      },
    );

    const next = apply(withQuestions, { type: 'tab.removed', tabId: 'a' });

    expect(next.pendingQuestions['q-a']).toBeUndefined();
    expect(next.pendingQuestions['q-b']).toMatchObject({ chatId: 'b' });
  });

  it('reorders tabs by canonical order and keeps unlisted tabs', () => {
    const projection = apply(baseProjection(), {
      type: 'tab.upserted',
      tab: persistedTab('c'),
    });
    const next = apply(projection, {
      type: 'tab.order_changed',
      tabIds: ['c', 'a'],
    });
    expect(next.chatState.tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b']);
  });

  it('applies active-tab changes only to known tabs', () => {
    const next = apply(baseProjection(), {
      type: 'tab.active_changed',
      activeTabId: 'b',
    });
    expect(next.chatState.activeTabId).toBe('b');
    const unknown = apply(next, {
      type: 'tab.active_changed',
      activeTabId: 'missing',
    });
    expect(unknown.chatState.activeTabId).toBe('a');
  });

  it('patches allowlisted tab settings without touching other fields', () => {
    const next = apply(baseProjection(), {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: {
        description: 'Canonical description',
        modelExplicitlyChosen: true,
        billingExplicitlyChosen: true,
        globalInstructionsSnapshot: 'Canonical instructions',
        approvalMode: 'full-access',
        planMode: true,
        proposalMode: 'required',
        pendingPlanExit: { plan: 'Review me' },
        pendingPlanExitRequestId: 'request-1',
        agentArtifactCarryByTurn: {
          'a-m1': [
            {
              version: 1,
              kind: 'pipeline_run',
              operation: 'pipeline.run',
              executionId: 'execution-1',
              dedupeKey: 'dedupe-1',
              createdAt: '2026-08-10T00:00:00.000Z',
              pipelineId: 'pipeline-1',
              pipelineName: 'Build',
              initialStatus: 'pending',
              queuedAt: '2026-08-10T00:00:00.000Z',
              projectId: 'proj',
              worktreeId: 'wt',
              navigationTarget: {
                kind: 'pipeline_execution',
                executionId: 'execution-1',
                projectId: 'proj',
                worktreeId: 'wt',
              },
            },
          ],
        },
        selectedRepoId: 'repo-1',
        modelConfig: { thinkingLevel: 'low' },
        thinkingLevel: 'low',
        codexFastModeEnabled: true,
        interfaceMode: 'claude-code',
        attentionDismissedAt: 123,
        trackedPlanId: 'plan-1',
        trackedPlanSource: 'claude',
        trackedPlanReviewStatus: 'pending',
        hasOutstandingProposal: true,
        latestRevisionNumber: 3,
        pendingSystemInstructions: [
          { id: 'instruction-1', text: 'Persist me' },
        ],
        pinned: true,
        fileViewMode: 'preview',
        pendingRevertAttachmentPath: '/attachments/revert.md',
        newChatStartedWatcherPending: true,
        newChatStartedWatcherFiredAt: '2026-08-11T19:00:00.000Z',
        usage: {
          contextTokens: 10,
          contextWindow: 100,
          maxOutputTokens: 20,
          totalCostUsd: 0.01,
          inputTokens: 8,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          durationMs: 50,
          durationApiMs: 40,
          numTurns: 1,
          model: 'claude-sonnet-4-6',
        },
      },
    });
    const tabA = next.chatState.tabs.find((tab) => tab.id === 'a');
    expect(tabA?.description).toBe('Canonical description');
    expect(tabA?.modelExplicitlyChosen).toBe(true);
    expect(tabA?.billingExplicitlyChosen).toBe(true);
    expect(tabA?.globalInstructionsSnapshot).toBe('Canonical instructions');
    expect(tabA?.approvalMode).toBe('full-access');
    expect(tabA?.planMode).toBe(true);
    expect(tabA?.proposalMode).toBe('required');
    expect(tabA?.pendingPlanExit).toEqual({ plan: 'Review me' });
    expect(tabA?.pendingPlanExitRequestId).toBe('request-1');
    expect(tabA?.agentArtifactCarryByTurn?.['a-m1']).toHaveLength(1);
    expect(tabA?.selectedRepoId).toBe('repo-1');
    expect(tabA?.thinkingLevel).toBe('low');
    expect(tabA?.codexFastModeEnabled).toBe(true);
    expect(tabA?.interfaceMode).toBe('claude-code');
    expect(tabA).toMatchObject({
      attentionDismissedAt: 123,
      trackedPlanId: 'plan-1',
      trackedPlanSource: 'claude',
      trackedPlanReviewStatus: 'pending',
      hasOutstandingProposal: true,
      latestRevisionNumber: 3,
      pendingSystemInstructions: [{ id: 'instruction-1', text: 'Persist me' }],
      pinned: true,
      fileViewMode: 'preview',
      pendingRevertAttachmentPath: '/attachments/revert.md',
      newChatStartedWatcherPending: true,
      newChatStartedWatcherFiredAt: '2026-08-11T19:00:00.000Z',
    });
    expect(tabA?.usage?.contextTokens).toBe(10);
    expect(tabA?.usage?.contextWindow).toBe(200_000);
    const tabB = next.chatState.tabs.find((tab) => tab.id === 'b');
    expect(tabB?.planMode).toBe(false);

    const cleared = apply(next, {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: {
        attentionDismissedAt: null,
        trackedPlanId: null,
        trackedPlanSource: null,
        trackedPlanReviewStatus: null,
        latestRevisionNumber: null,
        pendingSystemInstructions: null,
        pendingPlanExitRequestId: null,
        pinned: false,
        fileViewMode: 'raw',
        pendingRevertAttachmentPath: null,
        newChatStartedWatcherPending: null,
        newChatStartedWatcherFiredAt: null,
      },
    });
    const clearedTab = cleared.chatState.tabs.find((tab) => tab.id === 'a');
    expect(clearedTab).not.toHaveProperty('attentionDismissedAt');
    expect(clearedTab).not.toHaveProperty('trackedPlanId');
    expect(clearedTab).not.toHaveProperty('trackedPlanSource');
    expect(clearedTab).not.toHaveProperty('trackedPlanReviewStatus');
    expect(clearedTab).not.toHaveProperty('latestRevisionNumber');
    expect(clearedTab).not.toHaveProperty('pendingSystemInstructions');
    expect(clearedTab).not.toHaveProperty('pendingPlanExitRequestId');
    expect(clearedTab).not.toHaveProperty('pendingRevertAttachmentPath');
    expect(clearedTab).not.toHaveProperty('newChatStartedWatcherPending');
    expect(clearedTab).not.toHaveProperty('newChatStartedWatcherFiredAt');
    expect(clearedTab).toMatchObject({ pinned: false, fileViewMode: 'raw' });
  });

  it('ignores prototype-mutating metadata patch keys', () => {
    const next = apply(baseProjection(), {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: metadataPatchWithPrototypeKeys(),
    });
    const tabA = next.chatState.tabs.find((tab) => tab.id === 'a');

    expect(tabA?.title).toBe('Safe title');
    expect(Object.getPrototypeOf(tabA)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(tabA, 'prototype')).toBe(false);
  });

  it('relabels duplicate file basenames after a canonical path patch', () => {
    const projection = baseProjection();
    projection.chatState.tabs = [
      {
        ...projection.chatState.tabs[0],
        kind: 'file',
        title: 'index.ts',
        description: '/repo/src/index.ts',
        filePath: '/repo/src/index.ts',
      },
      {
        ...projection.chatState.tabs[1],
        kind: 'file',
        title: 'Open file',
        description: '',
        filePath: '',
      },
    ];

    const next = apply(projection, {
      type: 'tab.metadata_patched',
      tabId: 'b',
      patch: {
        filePath: '/repo/tests/index.ts',
        title: 'index.ts',
      },
    });

    expect(next.chatState.tabs.map((tab) => tab.title)).toEqual([
      'src/index.ts',
      'tests/index.ts',
    ]);
    expect(next.chatState.tabs[1].description).toBe('/repo/tests/index.ts');
  });

  it('upserts, replaces, and removes messages by stable id', () => {
    const upserted = apply(baseProjection(), {
      type: 'message.upserted',
      chatId: 'a',
      message: message('a-m2', 'second'),
    });
    const tabAfterUpsert = upserted.chatState.tabs.find(
      (tab) => tab.id === 'a',
    );
    expect(tabAfterUpsert?.messages.map((m) => m.id)).toEqual(['a-m1', 'a-m2']);

    const edited = apply(upserted, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('a-m2', 'edited'),
    });
    const tabAfterEdit = edited.chatState.tabs.find((tab) => tab.id === 'a');
    expect(tabAfterEdit?.messages).toHaveLength(2);

    const replaced = apply(edited, {
      type: 'messages.replaced',
      chatId: 'a',
      messages: [message('a-m9', 'only')],
      removedMessageIds: ['a-m1', 'a-m2'],
    });
    expect(
      replaced.chatState.tabs
        .find((tab) => tab.id === 'a')
        ?.messages.map((m) => m.id),
    ).toEqual(['a-m9']);

    const removed = apply(replaced, {
      type: 'message.removed',
      chatId: 'a',
      messageId: 'a-m9',
    });
    expect(
      removed.chatState.tabs.find((tab) => tab.id === 'a')?.messages,
    ).toHaveLength(0);
  });

  it('maps runtime patches onto controls: a completed turn cannot show a stale Stop button', () => {
    const streaming = apply(baseProjection(), {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: runtimeState('streaming'),
    });
    expect(streaming.chatState.tabs.find((tab) => tab.id === 'a')?.status).toBe(
      'streaming',
    );

    const completed = apply(streaming, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: runtimeState('completed'),
    });
    expect(completed.chatState.tabs.find((tab) => tab.id === 'a')?.status).toBe(
      'idle',
    );

    const failed = apply(completed, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: runtimeState('failed', 'provider exploded'),
    });
    const failedTab = failed.chatState.tabs.find((tab) => tab.id === 'a');
    expect(failedTab?.status).toBe('error');
    expect(failedTab?.error).toBe('provider exploded');
    expect(failed.runtimeByChatId.a.status).toBe('failed');
  });

  // CAN-2307: a provider "success" with nothing in it is a failure the user
  // can act on, so the recovery record has to reach the tab — and has to leave
  // again on its own when late output reconciles the turn.
  describe('empty-completion recovery (CAN-2307)', () => {
    function emptyCompletionRuntime(
      turnUserMessageId: string,
    ): ChatRuntimeState {
      return {
        status: 'failed',
        queuedMessageIds: [],
        error: {
          code: 'empty_completion',
          message:
            'The provider completed this turn without returning any output.',
          retryable: true,
          occurredAt: '2026-08-07T00:00:00.000Z',
        },
        emptyCompletionRecovery: {
          turnUserMessageId,
          detectedAt: 1234,
          automaticRetryAllowed: false,
        },
      };
    }

    it('projects the recovery record onto the tab as an error state', () => {
      const next = apply(baseProjection(), {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: emptyCompletionRuntime('a-m1'),
      });
      const tab = next.chatState.tabs.find((entry) => entry.id === 'a');
      expect(tab?.status).toBe('error');
      expect(tab?.emptyCompletionRecovery).toEqual({
        turnUserMessageId: 'a-m1',
        detectedAt: 1234,
        automaticRetryAllowed: false,
      });
    });

    it('clears the recovery record when late output reconciles the turn', () => {
      const flagged = apply(baseProjection(), {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: emptyCompletionRuntime('a-m1'),
      });
      const reconciled = apply(flagged, {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: runtimeState('completed'),
      });
      const tab = reconciled.chatState.tabs.find((entry) => entry.id === 'a');
      expect(tab?.status).toBe('idle');
      expect(tab?.emptyCompletionRecovery).toBeUndefined();
    });

    it('does not surface a recovery record for an unrelated error code', () => {
      const next = apply(baseProjection(), {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: {
          ...runtimeState('failed', 'provider exploded'),
          emptyCompletionRecovery: {
            turnUserMessageId: 'a-m1',
            detectedAt: 1234,
            automaticRetryAllowed: false,
          },
        },
      });
      expect(
        next.chatState.tabs.find((entry) => entry.id === 'a')
          ?.emptyCompletionRecovery,
      ).toBeUndefined();
    });

    // The snapshot install path (hydrate/refresh) is the OTHER runtime -> tab
    // projection. It has to mirror the incremental one: a scope hydrated after
    // the verdict was raised is the restart case the notice exists for, and a
    // refresh is the only thing that can retire a record
    // `preserveRendererOnlyTabFields` has been carrying forward.
    it('projects and retires the record through the snapshot install path', () => {
      const tab = fromPersistedTab(persistedTab('a'));
      const [flagged] = applyRuntimeStatusesToTabs([tab], {
        a: emptyCompletionRuntime('a-m1'),
      });
      expect(flagged?.status).toBe('error');
      expect(flagged?.emptyCompletionRecovery?.turnUserMessageId).toBe('a-m1');

      const [reconciled] = applyRuntimeStatusesToTabs([flagged ?? tab], {
        a: runtimeState('completed'),
      });
      expect(reconciled?.status).toBe('idle');
      expect(reconciled?.emptyCompletionRecovery).toBeUndefined();
    });

    // Main's Codex branches return `{ ...base, status: 'streaming' }` for a
    // non-terminal event, so a turn that goes live again (a late
    // `turn.started`/`item.started` for the SAME turn id, which the reconcile
    // gate deliberately admits) carries the previous verdict's `error` and
    // `emptyCompletionRecovery` forward. `error` was always safe there — the
    // renderer only reads it while the status says failed — and the recovery
    // record follows the same rule, or the notice would offer Resume and Try
    // again over a chat that is visibly streaming.
    it('ignores a stale record on a runtime that went live again', () => {
      const next = apply(baseProjection(), {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: {
          ...emptyCompletionRuntime('a-m1'),
          status: 'streaming',
        },
      });
      const tab = next.chatState.tabs.find((entry) => entry.id === 'a');
      expect(tab?.status).toBe('streaming');
      expect(tab?.emptyCompletionRecovery).toBeUndefined();
    });

    it('survives a canonical tab payload, which carries no runtime state', () => {
      const previous = fromPersistedTab(persistedTab('a'));
      previous.emptyCompletionRecovery = {
        turnUserMessageId: 'a-m1',
        detectedAt: 1234,
        automaticRetryAllowed: false,
      };
      const merged = preserveRendererOnlyTabFields(
        previous,
        fromPersistedTab(persistedTab('a')),
      );
      expect(merged.emptyCompletionRecovery?.turnUserMessageId).toBe('a-m1');
    });
  });

  it('applies runtime activity timestamps with streaming status', () => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs.find((entry) => entry.id === 'a');
    if (!tab) throw new Error('Expected chat tab a');
    tab.lastEventAt = 1;

    const next = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: {
        ...runtimeState('starting'),
        lastActivityAt: 2,
      },
    });

    expect(next.chatState.tabs.find((entry) => entry.id === 'a')).toMatchObject(
      {
        status: 'streaming',
        lastEventAt: 2,
      },
    );
  });

  it('does not regress a fresh renderer activity timestamp with a stale runtime patch', () => {
    const projection = baseProjection();
    const tab = projection.chatState.tabs.find((entry) => entry.id === 'a');
    if (!tab) throw new Error('Expected chat tab a');
    tab.lastEventAt = 200;

    const next = apply(projection, {
      type: 'runtime.patched',
      chatId: 'a',
      runtime: {
        ...runtimeState('starting'),
        lastActivityAt: 100,
      },
    });

    expect(next.chatState.tabs.find((entry) => entry.id === 'a')).toMatchObject(
      {
        status: 'streaming',
        lastEventAt: 200,
      },
    );
  });

  it('upserts and removes pending questions scoped to the event target', () => {
    const upserted = apply(baseProjection(), {
      type: 'pending_question.upserted',
      question: {
        requestId: 'q1',
        chatId: 'a',
        questions: [],
      },
    });
    expect(upserted.pendingQuestions.q1).toMatchObject({
      requestId: 'q1',
      chatId: 'a',
      projectId: 'proj',
      worktreeId: 'wt',
    });

    const removed = apply(upserted, {
      type: 'pending_question.removed',
      requestId: 'q1',
      chatId: 'a',
    });
    expect(removed.pendingQuestions.q1).toBeUndefined();
  });

  it('maintains archive summaries including read state', () => {
    const archive: ArchivedChatSummary = {
      chatId: 'arch-1',
      title: 'Archived',
      turnCount: 2,
      archivedAt: '2026-08-07T00:00:00.000Z',
      createdAt: '2026-08-06T00:00:00.000Z',
      restorable: true,
      unread: true,
    };
    const upserted = apply(baseProjection(), {
      type: 'archive.upserted',
      archive,
    });
    expect(upserted.archives).toHaveLength(1);

    const read = apply(upserted, {
      type: 'archive.read_state_changed',
      archiveEntryId: 'entry-1',
      chatId: 'arch-1',
      unread: false,
    });
    expect(read.archives[0].unread).toBe(false);

    const removed = apply(read, {
      type: 'archive.removed',
      archiveEntryId: 'entry-1',
      chatId: 'arch-1',
    });
    expect(removed.archives).toHaveLength(0);
  });
});

describe('a turn main holds for its worktree setup', () => {
  it('shows Stop for a canonical starting turn the renderer never presented', () => {
    const projection = baseProjection();
    expect(projection.chatState.tabs[0].provisionalFirstSend).toBeUndefined();
    const held = apply(
      projection,
      {
        type: 'message.upserted',
        chatId: 'a',
        message: message('held-user', 'Fix the deck'),
      },
      {
        type: 'runtime.patched',
        chatId: 'a',
        runtime: {
          status: 'starting',
          activeTurn: { userMessageId: 'held-user', startedAt: 20 },
          queuedMessageIds: [],
          lastActivityAt: 20,
        },
      },
    );
    const tab = held.chatState.tabs[0];
    expect(tab.status).toBe('streaming');
    expect(tab.messages.filter((row) => row.id === 'held-user')).toHaveLength(
      1,
    );
  });
});

describe('chatRuntimeStatusToTabStatus', () => {
  it('keeps live turns streaming and terminal turns idle', () => {
    expect(chatRuntimeStatusToTabStatus(runtimeState('starting'))).toBe(
      'streaming',
    );
    expect(chatRuntimeStatusToTabStatus(runtimeState('awaiting_input'))).toBe(
      'streaming',
    );
    expect(chatRuntimeStatusToTabStatus(runtimeState('interrupted'))).toBe(
      'idle',
    );
    expect(chatRuntimeStatusToTabStatus(runtimeState('cancelled'))).toBe(
      'idle',
    );
    expect(chatRuntimeStatusToTabStatus(runtimeState('failed'))).toBe('error');
  });
});

describe('preserveRendererOnlyTabFields', () => {
  it.each([true, false])(
    'preserves queued-edit focus permission (%s) and pending acquisition on tab upsert',
    (autoFocus) => {
      const projection = baseProjection();
      Object.assign(projection.chatState.tabs[0], {
        editingQueuedMessageIndex: 0,
        editingQueuedMessageFocusAllowed: autoFocus,
        pendingQueuedMessageEditId: 'queued-edit-attempt',
      });
      const next = apply(projection, {
        type: 'tab.upserted',
        tab: persistedTab('a', 'Updated title'),
      });
      expect(next.chatState.tabs[0].editingQueuedMessageFocusAllowed).toBe(
        autoFocus,
      );
      expect(next.chatState.tabs[0].pendingQueuedMessageEditId).toBe(
        'queued-edit-attempt',
      );
    },
  );

  it('keeps a submitted user bubble through stale canonical replacements until its exact echo arrives', () => {
    const projection = baseProjection();
    const submitted = message('submitted', 'same text');
    const tab = projection.chatState.tabs[0];
    Object.assign(tab, { pendingUserMessages: [submitted] });
    tab.messages = [...tab.messages, submitted];
    const stale = apply(projection, {
      type: 'tab.upserted',
      tab: persistedTab('a'),
    });
    expect(stale.chatState.tabs[0].messages).toContainEqual(submitted);
    const unrelated = apply(stale, {
      type: 'message.upserted',
      chatId: 'a',
      message: message('another-send', 'same text'),
    });
    expect(unrelated.chatState.tabs[0].messages).toContainEqual(submitted);
    const confirmed = apply(unrelated, {
      type: 'message.upserted',
      chatId: 'a',
      message: submitted,
    });
    expect(
      confirmed.chatState.tabs[0].messages.filter(
        (row) => row.id === submitted.id,
      ),
    ).toHaveLength(1);
    const reset = apply(confirmed, {
      type: 'tab.upserted',
      tab: persistedTab('a'),
    });
    expect(reset.chatState.tabs[0].messages).not.toContainEqual(submitted);
  });

  it.each([true, false])(
    'keeps the account proxy route main reported (%s) and never persists it',
    (accountProxyRouted) => {
      const previous: ChatTab = {
        ...fromPersistedTab(persistedTab('a')),
        accountProxyRouted,
      };
      const preserved = preserveRendererOnlyTabFields(
        previous,
        fromPersistedTab(persistedTab('a')),
      );
      expect(preserved.accountProxyRouted).toBe(accountProxyRouted);
      expect(toPersistedTab(preserved)).not.toHaveProperty(
        'accountProxyRouted',
      );
    },
  );

  it('leaves the account proxy route unset until main reports one', () => {
    const preserved = preserveRendererOnlyTabFields(
      fromPersistedTab(persistedTab('a')),
      fromPersistedTab(persistedTab('a')),
    );
    expect(preserved).not.toHaveProperty('accountProxyRouted');
  });

  it('returns the canonical tab untouched when there is no previous tab', () => {
    const next = fromPersistedTab(persistedTab('z'));
    expect(preserveRendererOnlyTabFields(undefined, next)).toBe(next);
  });

  it('preserves an inspected turn view when the same transcript arrives as a raw page', () => {
    const previous = fromPersistedTab(persistedTab('history'));
    previous.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 16000,
      committedByteLength: 2000000,
      transcriptRevision: 9,
      hasActiveSidecar: false,
    };
    previous.transcriptWindow = {
      view: 'turns',
      turns: [],
      totalMessages: 16000,
      transcriptRevision: 9,
    };
    previous.transcriptLoaded = true;
    const next = {
      ...fromPersistedTab(persistedTab('history')),
      transcript: previous.transcript,
      transcriptLoaded: true,
      transcriptWindow: {
        before: 15500,
        totalMessages: 16000,
        transcriptRevision: 9,
      },
    };
    const preserved = preserveRendererOnlyTabFields(previous, next);
    expect(preserved.transcriptWindow).toBe(previous.transcriptWindow);
    expect(preserved.messages).toBe(previous.messages);
  });

  it('keeps the loaded window when a body-less tab arrives at a newer revision', () => {
    // A metadata-only `tab.upserted` (title, status, descriptor bump) carries
    // `messages: []` and `transcriptLoaded: false`. Message rows and the
    // window's own revision are kept current by `message.upserted` and
    // `transcript.updated`, so dropping the turn frames here would render the
    // retained rows without previews and then discard every older page once
    // the reload replaces them.
    const previous = fromPersistedTab(persistedTab('history'));
    previous.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 16000,
      committedByteLength: 2000000,
      transcriptRevision: 9,
      hasActiveSidecar: false,
    };
    previous.transcriptWindow = {
      view: 'turns',
      turns: [],
      before: 15000,
      totalMessages: 16000,
      transcriptRevision: 9,
    };
    previous.transcriptLoaded = true;
    const next = {
      ...fromPersistedTab(persistedTab('history')),
      title: 'Renamed',
      messages: [],
      transcript: {
        ...previous.transcript,
        committedMessageCount: 16001,
        messageCount: 16001,
        transcriptRevision: 10,
      },
      transcriptLoaded: false,
      transcriptWindow: undefined,
    };
    const preserved = preserveRendererOnlyTabFields(previous, next);
    expect(preserved.title).toBe('Renamed');
    expect(preserved.transcript?.transcriptRevision).toBe(10);
    expect(preserved.messages).toBe(previous.messages);
    expect(preserved.transcriptLoaded).toBe(true);
    expect(preserved.transcriptWindow).toMatchObject({
      view: 'turns',
      before: 15000,
      transcriptRevision: 10,
      totalMessages: 16001,
    });
  });

  it('preserves local queue rows without re-adding a dropped setup annotation', () => {
    const previous = fromPersistedTab(persistedTab('setup'));
    const next = fromPersistedTab(persistedTab('setup'));
    const intro = {
      id: 'pending-setup-intro',
      role: 'system' as const,
      blocks: [
        {
          id: 'pending-setup-intro-block',
          type: 'pending_setup_info' as const,
          timestamp: 1,
        },
      ],
      timestamp: 1,
    };
    previous.messages = [intro, ...previous.messages];
    previous.queuedMessages = [{ text: 'queued while cloning' }];

    const preserved = preserveRendererOnlyTabFields(previous, next);

    expect(preserved.queuedMessages).toEqual([
      { text: 'queued while cloning' },
    ]);
    expect(preserved.messages).toEqual(next.messages);
  });

  it('keeps a legacy setup annotation that the canonical transcript still contains', () => {
    const previous = fromPersistedTab(persistedTab('legacy-setup'));
    const next = fromPersistedTab(persistedTab('legacy-setup'));
    const legacyIntro = {
      id: 'legacy-setup-intro',
      role: 'system' as const,
      blocks: [
        {
          id: 'legacy-setup-intro-block',
          type: 'pending_setup_info' as const,
          timestamp: 1,
        },
      ],
      timestamp: 1,
    };
    next.messages = [legacyIntro, ...next.messages];

    const preserved = preserveRendererOnlyTabFields(previous, next);

    // Hiding legacy annotations is a display responsibility; the canonical
    // transcript is accepted unchanged.
    expect(preserved.messages).toEqual(next.messages);
  });

  it('preserves the queued hook placeholder marker during canonical persistence', () => {
    const previous = fromPersistedTab(persistedTab('queued-hook'));
    const next = fromPersistedTab(persistedTab('queued-hook'));
    previous.messages = [];
    previous.queuedMessages = [
      {
        text: 'queued hook prompt',
        queuedHookQueueId: 'queued-1',
      },
    ];
    previous.queuedHookPlaceholder = true;

    const preserved = preserveRendererOnlyTabFields(previous, next);

    expect(preserved.queuedMessages).toEqual(previous.queuedMessages);
    expect(preserved.queuedHookPlaceholder).toBe(true);
    expect(preserved.messages).toEqual([]);
  });
});

describe('canonical Codex speed changes', () => {
  function codexProjection(
    overrides: Partial<PersistedChatTab> = {},
  ): CanonicalScopeProjection {
    const tab = fromPersistedTab({
      ...persistedTab('a'),
      model: 'codex-mini-latest',
      providerType: 'codex',
      ...overrides,
    });
    return {
      chatState: { tabs: [tab], activeTabId: 'a' },
      archives: [],
      runtimeByChatId: {},
      pendingQuestions: {},
    };
  }
  const ULTRA: Partial<PersistedChatTab> = {
    modelConfig: { speed: 'ultrafast', fastMode: false },
  };

  function patchModelConfig(
    projection: CanonicalScopeProjection,
    modelConfig: ChatTabMetadataPatch['modelConfig'],
  ): ChatTab | undefined {
    return apply(projection, {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: { modelConfig },
    }).chatState.tabs.find((tab) => tab.id === 'a');
  }

  it('lets a legacy boolean false patch replace Ultra fast with Regular', () => {
    const tab = patchModelConfig(codexProjection(ULTRA), { fastMode: false });

    expect(tab?.modelConfig).toMatchObject({
      speed: 'standard',
      fastMode: false,
    });
    expect(tab?.fastModeExplicit).toBe(true);
    expect(tab?.codexFastModeEnabled).toBe(false);
  });

  it('lets a legacy boolean true patch replace Ultra fast with Fast', () => {
    const tab = patchModelConfig(codexProjection(ULTRA), { fastMode: true });

    expect(tab?.modelConfig).toMatchObject({ speed: 'fast', fastMode: true });
    expect(tab?.codexFastModeEnabled).toBe(true);
  });

  it('preserves Ultra fast across a thinking-only patch', () => {
    const tab = patchModelConfig(codexProjection(ULTRA), {
      thinkingLevel: 'low',
    });

    expect(tab?.modelConfig).toMatchObject({
      thinkingLevel: 'low',
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(tab?.fastModeExplicit).toBe(true);
  });

  it('applies an exact speed patch as an explicit choice with its derived boolean', () => {
    const tab = patchModelConfig(codexProjection(), { speed: 'ultrafast' });

    expect(tab?.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(tab?.fastModeExplicit).toBe(true);
    expect(tab?.codexFastModeEnabled).toBe(false);
  });

  it('hydrates an upserted Ultra fast tab without downgrading it', () => {
    const next = apply(codexProjection(), {
      type: 'tab.upserted',
      tab: {
        ...persistedTab('a'),
        model: 'codex-mini-latest',
        providerType: 'codex',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
    });
    const tab = next.chatState.tabs.find((candidate) => candidate.id === 'a');

    expect(tab?.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(tab?.fastModeExplicit).toBe(true);
  });

  it('keeps a newer local speed while an echo of an earlier write lands', () => {
    // Local Fast is in flight; main echoes the earlier Regular commit.
    const release = beginLocalCodexSpeedWrite(
      ctx.projectId,
      ctx.worktreeId,
      'a',
      'standard',
    );
    let tab: ChatTab | undefined;
    let rollback: string | undefined;
    try {
      tab = patchModelConfig(
        codexProjection({ modelConfig: { speed: 'fast', fastMode: true } }),
        { speed: 'standard', fastMode: false, thinkingLevel: 'low' },
      );
    } finally {
      // A refused newest write falls back to the echoed speed.
      rollback = release(true);
    }

    expect(tab?.modelConfig).toMatchObject({
      thinkingLevel: 'low',
      speed: 'fast',
      fastMode: true,
    });
    expect(rollback).toBe('standard');

    // Once settled, the canonical speed applies again.
    const settled = patchModelConfig(
      codexProjection({ modelConfig: { speed: 'fast', fastMode: true } }),
      { speed: 'standard', fastMode: false },
    );
    expect(settled?.modelConfig).toMatchObject({
      speed: 'standard',
      fastMode: false,
    });
  });

  it('mirrors the main-owned retained Codex speed and clears it on null', () => {
    const retained = apply(codexProjection(), {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: { retainedCodexSpeed: 'ultrafast' },
    });
    expect(retained.chatState.tabs[0]?.retainedCodexSpeed).toBe('ultrafast');

    const cleared = apply(retained, {
      type: 'tab.metadata_patched',
      tabId: 'a',
      patch: { retainedCodexSpeed: null },
    });
    expect(cleared.chatState.tabs[0]).not.toHaveProperty('retainedCodexSpeed');
  });
});

it('rebases delegate insert ranks and turn gap cursors exactly as a replacement page', () => {
  const projection = baseProjection();
  const tab = projection.chatState.tabs[0];
  tab.messages = [message('first', 'first'), message('final', 'final')];
  tab.transcriptLoaded = true;
  const summary = {
    id: 'first',
    start: 10,
    end: 15,
    before: 14,
    complete: true,
    summary: {},
    finalMessageIds: ['final'],
  };
  // Use the real summary shape without conflating a nested child with a root row.
  const turn = { ...summary, summary: computeTurnSummary([]) };
  tab.transcriptWindow = {
    view: 'turns',
    turns: [turn],
    before: 10,
    messageOrdinals: { first: 10, final: 14 },
    totalMessages: 15,
    transcriptRevision: 1,
  };
  const child = {
    ...message('child', 'child'),
    parentBlockId: 'delegate-tool',
  };
  const transcript = {
    format: 'complete-message-jsonl-v1' as const,
    committedMessageCount: 16,
    committedByteLength: 100,
    transcriptRevision: 2,
    hasActiveSidecar: false,
  };
  const applied = apply(
    projection,
    {
      type: 'message.upserted',
      chatId: 'a',
      message: child,
      afterMessageId: 'first',
    },
    { type: 'transcript.updated', chatId: 'a', transcript, reset: true },
  ).chatState.tabs[0];
  const replacement = installTranscriptPage(
    tab,
    {
      view: 'turns',
      turns: [{ ...turn, end: 16, before: 15 }],
      before: 10,
      messages: [message('first', 'first'), child, message('final', 'final')],
      messageOrdinals: { first: 10, child: 11, final: 15 },
      totalMessages: 16,
      transcriptRevision: 2,
    },
    false,
  );
  expect(applied.transcriptLoaded).toBe(true);
  expect(applied.messages).toEqual(replacement.messages);
  expect(applied.transcriptWindow).toEqual(replacement.transcriptWindow);
});

it('marks omitted bodies stale, preserves stale through metadata, and never serializes it', () => {
  const initial = baseProjection();
  expect(apply(initial, { type: 'messages.omitted', chatId: 'missing' })).toBe(
    initial,
  );
  const stale = apply(initial, { type: 'messages.omitted', chatId: 'a' });
  expect(stale.chatState.tabs[0].transcriptStale).toBe(true);
  const updated = apply(
    stale,
    { type: 'tab.upserted', tab: persistedTab('a') },
    { type: 'tab.metadata_patched', tabId: 'a', patch: { title: 'New' } },
  );
  expect(updated.chatState.tabs[0].transcriptStale).toBe(true);
  expect(toPersistedTab(updated.chatState.tabs[0])).not.toHaveProperty(
    'transcriptStale',
  );
});
