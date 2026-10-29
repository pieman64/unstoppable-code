import {
  correlateTerminalAgentMessage,
  retainedTerminalAgentInput,
} from '../../agent-messaging/terminal-input';
import * as watcherIngress from '../active-chat-input';
import { noteWatcherDeliveryAuthorityChange } from '../watcher-delivery-authority';
import * as activePlan from '../../lib/active-plan-instruction';
import * as senderContext from '../../agent-messaging/sender-context';
import { browserHandoffs } from '../../browser/browser-handoffs';
import {
  capturePresentationTurn,
  recordPresentationTurn,
  forgetPresentationChat,
  presentationChatKey,
} from '../../canopy-tools/presentation-state';
import type { ChatStateCommit } from '../chat-state-contracts';
import { McpActivationStore } from '../mcp-activation-store';
import { McpActivationService } from '../mcp-activation-service';
import { McpSessionAvailability } from '../../mcp/session-availability';
import { mcpActivationMessageId } from '../mcp-activation-message';
import type { McpActivationRecord } from '@canopy/protocol/mcp-servers';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import { chatTabLabel } from '@canopy/protocol';
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandRequest,
  ChatCoreMutation,
  ChatAgentSentInfo,
  ChatRuntimeState,
  ChatRuntimeStatus,
  ChatSendMessageRequest,
  ChatStateChange,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  initAgentModels,
  initModelAliases,
  initModelHarnessAssignments,
  initOllamaModels,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { RETIRED_PLAN_CHAT_MESSAGE } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import {
  isInputLedger,
  inputRequestMatchesSettings,
  inputDeliveryViews,
} from '@canopy/desktop-shared/chat-input-delivery';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import { groupIntoTurns } from '@canopy/desktop-shared/lib/turn-utils';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { setChatTabsWriteObserver } from '../../lib/chat-tabs';
import * as agentAttachments from '../../lib/agent-attachments';
import * as planPersistence from '../../lib/plan-persistence';
import * as resolveWorktree from '../../lib/resolve-worktree';
import { ChatQueueService, getChatQueueService } from '../chat-queue-service';
import type {
  ChatQueuePersistenceMutation,
  ChatQueueServiceDependencies,
} from '../chat-queue-service';
import type * as ChatQueueServiceModule from '../chat-queue-service';
import type * as AppAdvisorWatchersModule from '../../app-advisor/watchers';
import { ChatStateV2Repository as ChatStateRepository } from '../chat-state-v2-repository';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../../lib/chat-transcript-log';
import * as standaloneHistory from '../../lib/standalone-history';
import * as archivedContainers from '../../lib/archived-containers';
import { ChatStateV2Backend } from '../chat-state-v2-backend';
import {
  ChatStateService,
  createShowVisualToolKeyResolver,
  isInitialChatTitleEligible,
  isNativeVisualToolResultEvent,
  preserveProviderVisualReferences,
} from '../chat-state-service';
import { withChatSendAdmission } from '../chat-send-admission';
import { getChatApprovalStateRevision } from '../../approvals/rule-revisions';
import { closeRejectedSplitAgentStartup } from '../split-agent-startup';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
  dispatchChatCommandForLegacyIpc,
} from '../../canopy-runtime/core-chat-command-adapter';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import * as chatStateServiceModule from '../chat-state-service';
import { persistOrgMemoryUsedForChat } from '../../lib/chat-tab-dispatch-utils';
import { TURN_END_LIMIT } from '../../lib/chat-turn-ends';
import { projectPortalLastTurnEnd } from '../../lib/portal-turn-end';
import { normalizeTabForInheritedPluginDefaults } from '../../lib/inherited-plugin-defaults-normalization';
import type { ChatStateServiceOptions } from '../chat-state-service';
import {
  beginChatTurnPreparation,
  cancelChatTurnPreparations,
} from '../../lib/chat-turn-preparation';
import {
  beginWorktreeGitSetup,
  type WorktreeGitSetupOutcome,
} from '../../lib/worktree-git-setup';
import type { AgentSession } from '../../agents/types';
import type {
  ChatInputAdmission,
  ChatInputDeliveryAction,
  ChatInputWithdrawal,
} from '@canopy/protocol/portal';
import type { SessionDiagnosticRecord } from '../../observability/service';
import { setDelegationActivity } from '../../agents/delegation/activity';
import {
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetAutoArchiveLease,
} from '../../lib/workspace-target-exclusion';

const mockObserveSteeringInput = jest.fn();

jest.mock('../../observability', () => ({
  getObservabilityService: () => ({
    observeSteeringInput: mockObserveSteeringInput,
    recordUsageMetricEvent: jest.fn(),
  }),
}));

jest.mock('../chat-queue-service', () => {
  const actual = jest.requireActual<typeof ChatQueueServiceModule>(
    '../chat-queue-service',
  );
  return { ...actual, getChatQueueService: jest.fn() };
});

const mockResumePendingObservations = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
const mockTerminalState = jest.fn(
  (): { turnState: string } | undefined => undefined,
);
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: () => ({
    getState: () => mockTerminalState(),
    resumePendingObservations: mockResumePendingObservations,
  }),
}));

const mockRecordInterruptedChats = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: (...args: unknown[]) =>
    mockRecordInterruptedChats(...args),
}));

const mockIsModelBlockedByStoredPolicy = jest.fn(() => Promise.resolve(false));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (...args: unknown[]) =>
    mockIsModelBlockedByStoredPolicy(...args),
}));

let mockWatcherService:
  | { handleChatTerminalEvent: (event: unknown) => Promise<void> }
  | undefined;
jest.mock('../../app-advisor/watchers', () => {
  const actual = jest.requireActual<typeof AppAdvisorWatchersModule>(
    '../../app-advisor/watchers',
  );
  return {
    ...actual,
    getAppAdvisorWatcherService: (
      ...args: Parameters<typeof actual.getAppAdvisorWatcherService>
    ): unknown =>
      mockWatcherService ?? actual.getAppAdvisorWatcherService(...args),
  };
});

const mockedGetChatQueueService = jest.mocked(getChatQueueService);
const queueEdit = jest.fn();
const queueCancel = jest.fn();
const queueForce = jest.fn();
const queueConsumeRestoredInput = jest.fn();
const queueSnapshots = jest.fn((): never[] => []);

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

describe('native visual provider event admission', () => {
  it.each([
    {
      name: 'Claude user tool results',
      expected: true,
      input: {
        providerType: 'claude',
        data: {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call', is_error: false },
            ],
          },
        },
      },
    },
    {
      name: 'Codex completed dynamic tool items',
      expected: true,
      input: {
        providerType: 'codex',
        data: {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              id: 'call',
              type: 'dynamic_tool_call',
              tool: 'ShowVisual',
              status: 'completed',
              success: true,
            },
          },
        },
      },
    },
    {
      name: 'Cursor assistant snapshots',
      expected: true,
      input: {
        providerType: 'cursor',
        data: {
          type: 'assistant',
          provider: 'cursor',
          message: {
            content: [
              { type: 'tool_result', toolUseId: 'call', isError: false },
            ],
          },
        },
      },
    },
    {
      name: 'Cursor assistant patches',
      expected: true,
      input: {
        providerType: 'cursor',
        data: {
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          patches: [
            {
              index: 1,
              block: { type: 'tool_result', toolUseId: 'call', isError: false },
            },
          ],
        },
      },
    },
    {
      name: 'terminal transcript synchronization',
      expected: false,
      input: {
        providerType: 'claude',
        data: {
          type: 'claude_terminal_transcript_sync',
          messages: [{ blocks: [{ type: 'tool_result', isError: false }] }],
        },
      },
    },
    {
      name: 'terminal provider results that close open tool uses',
      expected: false,
      input: {
        providerType: 'claude',
        data: { type: 'result', is_error: false, result: 'done' },
      },
    },
    {
      name: 'provider error events that close open tool uses',
      expected: false,
      input: {
        providerType: 'claude',
        data: { type: 'error', error: 'failed' },
      },
    },
    {
      name: 'tool results delivered through a terminal source',
      expected: false,
      input: {
        source: 'terminal',
        providerType: 'claude',
        data: {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call', is_error: false },
            ],
          },
        },
      },
    },
    {
      name: 'Claude errored tool results',
      expected: false,
      input: {
        providerType: 'claude',
        data: {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call', is_error: true },
            ],
          },
        },
      },
    },
    {
      name: 'Codex failed dynamic tool results',
      expected: false,
      input: {
        providerType: 'codex',
        data: {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              id: 'call',
              type: 'dynamic_tool_call',
              status: 'failed',
              success: false,
            },
          },
        },
      },
    },
    {
      name: 'non-completed Codex items',
      expected: false,
      input: {
        providerType: 'codex',
        data: {
          type: 'codex',
          event: {
            type: 'item.updated',
            item: { id: 'call', type: 'dynamic_tool_call', success: true },
          },
        },
      },
    },
    {
      name: 'non-dynamic Codex completed items',
      expected: false,
      input: {
        providerType: 'codex',
        data: {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: { id: 'call', type: 'command_execution', success: true },
          },
        },
      },
    },
    {
      name: 'Cursor errored results',
      expected: false,
      input: {
        providerType: 'cursor',
        data: {
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          patches: [
            {
              index: 1,
              block: { type: 'tool_result', toolUseId: 'call', isError: true },
            },
          ],
        },
      },
    },
  ])('admits only $name', ({ input, expected }) => {
    expect(isNativeVisualToolResultEvent(input)).toBe(expected);
  });

  it('preserves only existing visual references across provider reparses', () => {
    const visualRef: PersistedVisualReference = {
      version: 1,
      visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      byteLength: 12,
      sha256: 'a'.repeat(64),
      mediaType: 'text/html',
      title: 'Saved view',
      maxHeight: 400,
    };
    const providerReference: PersistedVisualReference = {
      ...visualRef,
      visualId: 'vis_123e4567-e89b-42d3-a456-426614174001',
    };
    const previous: PersistedChatMessage = {
      id: 'message',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'ShowVisual',
          output: 'old result',
          isError: false,
          visualRef,
        },
      ],
    };
    const reparsed: PersistedChatMessage = {
      id: 'message',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'ShowVisual',
          output: 'new result',
          isError: false,
        },
        {
          type: 'tool_result',
          toolUseId: 'unowned-call',
          toolName: 'Other',
          output: 'untrusted provider reference',
          isError: false,
          visualRef: providerReference,
        },
      ],
    };

    const [preserved] = preserveProviderVisualReferences(
      [previous],
      [reparsed],
    );

    expect(preserved?.blocks[0]).toMatchObject({ visualRef });
    expect(preserved?.blocks[1]).not.toHaveProperty('visualRef');
  });

  it('resolves ShowVisual only for injected exact provider tool names', () => {
    const linkedCall = {
      toolUseId: 'call',
      toolName: 'mcp__canopy__ShowVisual',
    };
    expect(
      createShowVisualToolKeyResolver(new Set())(linkedCall),
    ).toBeUndefined();
    expect(
      createShowVisualToolKeyResolver(new Set(['mcp__canopy__ShowVisual']))(
        linkedCall,
      ),
    ).toBe('show_visual');
    expect(
      createShowVisualToolKeyResolver(new Set(['show_visual']))(linkedCall),
    ).toBeUndefined();
    expect(
      createShowVisualToolKeyResolver(new Set(['mcp__canopy__ShowVisual']))({
        toolUseId: 'call',
        toolName: 'ShowVisual',
      }),
    ).toBeUndefined();
  });
});

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

// These tests commit through the real fsync'd WAL (createChat, transact,
// steering admission), so they are I/O-bound: alone, the file runs at ~14% CPU
// and its slowest tests take 3.5-5 s. Under a loaded two-worker CI run that
// crossed Jest's default 5 s (`preserves watcher display metadata ...`).
jest.setTimeout(60_000);

describe('chat state service', () => {
  const activation: McpActivationRecord = {
    version: 1,
    ownerId: 'owner',
    activationId: 'activation',
    attemptId: 'attempt',
    originatingMessageId: 'user-message',
    providerSessionId: 'provider-session',
    provider: 'claude',
    trigger: 'load',
    requiredTargets: [
      { kind: 'standalone', serverId: 'server', configId: 'config' },
    ],
    desiredGeneration: 1,
    phase: 'result_pending',
    cancelled: false,
    admission: 'not_sent',
    retryEligible: false,
  };

  it.each([false, true])(
    'protects archived MCP rows unless the restore is authoritative (%s)',
    async (authoritative) => {
      const target = service();
      await createChat(target);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const completed: McpActivationRecord = {
        ...activation,
        phase: 'completed',
        admission: 'accepted',
      };
      expect(
        await new McpActivationStore(target).compareAndSet(
          scope,
          undefined,
          completed,
        ),
      ).toBe(true);
      await target.command(
        envelope('archive-mcp', { type: 'chat.archive_tab', tabId: 'chat-1' }),
      );
      const snapshot = await target.getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      const canonical = structuredClone(snapshot.archived[0].tab);
      snapshot.archived[0].tab.mcpActivation = activation;
      snapshot.archived[0].tab.messages = canonical.messages.map((message) => ({
        ...message,
        blocks: [{ type: 'text', text: 'stale activation' }],
      }));
      await target.replaceCompatibilityArchives(SCOPE, snapshot, {
        authoritative,
      });
      await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);
      const reopened = await service().getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      expect(reopened.archived[0].tab.mcpActivation).toEqual(
        authoritative ? activation : completed,
      );
      expect(reopened.archived[0].tab.messages).toEqual(
        authoritative ? snapshot.archived[0].tab.messages : canonical.messages,
      );
    },
  );

  it('delivers committed MCP recovery through the real core chat event stream', async () => {
    const target = service();
    await createChat(target);
    const runtime = createDesktopRuntime({ getChatStatePort: () => target });
    const frames: unknown[] = [];
    const opened = await runtime.openChatEventsForLegacyIpc(
      { scope: SCOPE },
      {
        caller: {
          principalId: 'test-user',
          clientInstanceId: 'electron-main-chat-push',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.chat.read'],
        },
        onFrame: (frame) => frames.push(frame),
      },
    );
    try {
      const scope = { ...SCOPE, chatId: 'chat-1' };
      expect(
        await new McpActivationStore(target).compareAndSet(
          scope,
          undefined,
          activation,
        ),
      ).toBe(true);
      expect(await new McpActivationStore(service()).read(scope)).toEqual(
        activation,
      );
      expect(frames).toContainEqual(
        expect.objectContaining({
          kind: 'item',
          item: expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                type: 'message.upserted',
                chatId: 'chat-1',
                message: expect.objectContaining({
                  blocks: [{ type: 'mcp_activation', record: activation }],
                }),
              }),
            ]),
          }),
        }),
      );
    } finally {
      opened.handle.close();
      await runtime.shutdown();
    }
  });

  it('durably stores MCP recovery with CAS and protects it from stale compatibility writers', async () => {
    const target = service();
    await createChat(target);
    const scope = { ...SCOPE, chatId: 'chat-1' };
    const store = new McpActivationStore(target);
    const legacyRewrite = jest.spyOn(target, 'updateCompatibilityTab');
    const stale = await target.getCompatibilityTabs(SCOPE);
    expect(await store.compareAndSet(scope, undefined, activation)).toBe(true);
    expect(
      await store.compareAndSet(scope, undefined, {
        ...activation,
        attemptId: 'duplicate',
      }),
    ).toBe(false);
    await target.replaceCompatibilityTabs(SCOPE, stale, {
      changedTabIds: ['chat-1'],
    });
    expect(await store.read(scope)).toEqual(activation);
    const restarted = service();
    expect(await new McpActivationStore(restarted).read(scope)).toEqual(
      activation,
    );
    const next = {
      ...activation,
      phase: 'failed' as const,
      failureCode: 'timeout' as const,
      retryEligible: true,
    };
    expect(await store.compareAndSet(scope, activation, next)).toBe(true);
    const persisted = await restarted.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    const recovery = persisted.tabs[0].messages.filter((message) =>
      message.blocks.some((block) => block.type === 'mcp_activation'),
    );
    expect(recovery).toHaveLength(1);
    expect(recovery[0].blocks).toEqual([
      { type: 'mcp_activation', record: next },
    ]);
    expect(legacyRewrite).not.toHaveBeenCalled();
    await target.command(
      envelope('fork-mcp', {
        type: 'chat.fork_tab',
        sourceTabId: 'chat-1',
        targetTabId: 'fork-mcp',
      }),
    );
    expect(await store.read({ ...scope, chatId: 'fork-mcp' })).toBeUndefined();
  });

  it.each([
    { removed: 'origin', uncertain: false },
    { removed: 'origin', uncertain: true },
    { removed: 'recovery-row', uncertain: false },
    { removed: 'recovery-row', uncertain: true },
  ])(
    'cancels and reconciles MCP recovery after deleting $removed, uncertain=$uncertain, without restoring messages',
    async ({ removed, uncertain }) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const store = new McpActivationStore(target);
      const rowId = mcpActivationMessageId(activation.originatingMessageId);
      await repository.transact(
        SCOPE,
        [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: {
              id: activation.originatingMessageId,
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Enable the server' }],
            },
          },
        ],
        { source: 'migration' },
      );
      const pending: McpActivationRecord = {
        ...activation,
        phase: uncertain ? 'failed' : 'awaiting_auth',
        admission: uncertain ? 'uncertain' : 'not_sent',
        ...(uncertain ? { failureCode: 'admission_uncertain' as const } : {}),
      };
      expect(await store.compareAndSet(scope, undefined, pending)).toBe(true);
      const removedId =
        removed === 'origin' ? pending.originatingMessageId : rowId;
      await repository.transact(
        SCOPE,
        [
          {
            type: 'message.removed',
            chatId: 'chat-1',
            messageId: removedId,
          },
        ],
        { source: 'migration' },
      );
      const before = (
        await target.getCompatibilityTabs(SCOPE, {
          chatIds: ['chat-1'],
          fullTranscript: true,
        })
      ).tabs[0].messages;
      const host = {
        isCurrent: jest.fn(async () => true),
        prepare: jest.fn(),
        dispatch: jest.fn(),
        stop: jest.fn(async () => {}),
        reconcile: jest.fn(async (): Promise<'not_sent'> => 'not_sent'),
      };
      const activations = new McpActivationService(
        store,
        new McpSessionAvailability(),
        host,
      );
      await expect(activations.cancel(scope)).resolves.toBeUndefined();
      expect(await store.read(scope)).toMatchObject({
        phase: 'cancelled',
        admission: pending.admission,
      });
      await expect(activations.recover(scope)).resolves.toMatchObject({
        phase: 'cancelled',
        cancelled: true,
        admission: 'not_sent',
        retryEligible: false,
      });
      expect(host.reconcile).toHaveBeenCalledTimes(uncertain ? 1 : 0);
      const settled = await new McpActivationStore(service()).read(scope);
      expect(settled).toMatchObject({
        phase: 'cancelled',
        admission: 'not_sent',
      });
      expect(
        (
          await target.getCompatibilityTabs(SCOPE, {
            chatIds: ['chat-1'],
            fullTranscript: true,
          })
        ).tabs[0].messages,
      ).toEqual(before);
      // A removed task cannot be restarted or revived by a delayed writer.
      expect(
        await store.compareAndSet(scope, settled, {
          ...pending,
          phase: 'preparing',
        }),
      ).toBe(false);
      expect(
        await store.compareAndSet(scope, settled, {
          ...pending,
          activationId: 'stale-new-activation',
        }),
      ).toBe(false);
      const next = await activations.activate({
        binding: {
          scope,
          ownerId: 'owner',
          provider: 'claude',
          sessionId: 'new-session',
          generation: 2,
        },
        originatingMessageId: 'new-message',
        trigger: 'load',
        toolCallId: 'new-tool',
        targets: pending.requiredTargets,
      });
      expect(next.activationId).not.toBe(pending.activationId);
      await activations.cancel(scope);
      expect(host.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { removal: 'reset', startBefore: true },
    { removal: 'reset', startBefore: false },
    { removal: 'origin', startBefore: true },
    { removal: 'recovery-row', startBefore: true },
  ])(
    'keeps MCP recovery scoped to its chat after fork $removal, started=$startBefore',
    async ({ removal, startBefore }) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const store = new McpActivationStore(target);
      await repository.transact(
        SCOPE,
        ['earlier-prompt', activation.originatingMessageId].map((id) => ({
          type: 'message.upserted' as const,
          chatId: scope.chatId,
          message: {
            id,
            role: 'user' as const,
            timestamp: 1,
            blocks: [{ type: 'text' as const, text: id }],
          },
        })),
        { source: 'migration' },
      );
      if (startBefore)
        expect(await store.compareAndSet(scope, undefined, activation)).toBe(
          true,
        );
      await target.command(
        envelope('fork-recovery-scope', {
          type: 'chat.fork_tab',
          sourceTabId: scope.chatId,
          targetTabId: 'fork-recovery',
        }),
      );
      const forkScope = { ...scope, chatId: 'fork-recovery' };
      expect(await store.read(forkScope)).toBeUndefined();
      const rowId = mcpActivationMessageId(activation.originatingMessageId);
      if (removal === 'reset') {
        await target.command(
          envelope('reset-recovery-fork', {
            type: 'chat.reset_to_point',
            chatId: forkScope.chatId,
            userMessageId: 'earlier-prompt',
          }),
        );
      } else {
        await repository.transact(
          SCOPE,
          [
            {
              type: 'message.removed',
              chatId: forkScope.chatId,
              messageId:
                removal === 'origin' ? activation.originatingMessageId : rowId,
            },
          ],
          { source: 'migration' },
        );
      }
      await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);
      const reopened = service();
      const recoveredStore = new McpActivationStore(reopened);
      const next: McpActivationRecord = {
        ...activation,
        phase: 'awaiting_auth',
      };
      expect(
        await recoveredStore.compareAndSet(
          scope,
          startBefore ? activation : undefined,
          next,
        ),
      ).toBe(true);
      const source = (
        await reopened.getCompatibilityTabs(SCOPE, {
          chatIds: [scope.chatId],
          fullTranscript: true,
        })
      ).tabs.find((tab) => tab.id === scope.chatId);
      expect(source?.messages.map(({ id }) => id)).toEqual([
        'earlier-prompt',
        activation.originatingMessageId,
        rowId,
      ]);
      expect(await recoveredStore.read(scope)).toEqual(next);
      // The same removed ID must still fence the chat that actually deleted it.
      expect(
        await recoveredStore.compareAndSet(forkScope, undefined, next),
      ).toBe(false);
      const cancelled: McpActivationRecord = {
        ...next,
        phase: 'cancelled',
        cancelled: true,
      };
      expect(await recoveredStore.compareAndSet(scope, next, cancelled)).toBe(
        true,
      );
      const fresh: McpActivationRecord = {
        ...activation,
        activationId: 'fresh-activation',
        attemptId: 'fresh-attempt',
      };
      expect(await recoveredStore.compareAndSet(scope, cancelled, fresh)).toBe(
        true,
      );
    },
  );

  it('drops malformed and future MCP recovery records while keeping the chat readable', async () => {
    const target = service();
    await createChat(target);
    await target.updateCompatibilityTab(
      SCOPE,
      'chat-1',
      (tab) => ({
        ...tab,
        mcpActivation: {
          ...activation,
          version: 2,
        } as unknown as McpActivationRecord,
      }),
      undefined,
      { metadataOnly: true },
    );
    const tab = (await target.getCompatibilityTabs(SCOPE)).tabs[0];
    expect(tab.id).toBe('chat-1');
    expect(tab.mcpActivation).toBeUndefined();
  });
  let tempDir: string;
  let paths: { tabs: string; archives: string; journal: string };
  let repositories: ChatStateRepository[];
  let dispatched: ChatSendMessageRequest[];

  it('does not publish a new tab when paired authorization is revoked at the final commit boundary', async () => {
    const target = service();
    const canCommitCreate = jest
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await expect(
      target.command(
        envelope('create-revoked', {
          type: 'chat.create_tab',
          tabId: 'chat-revoked',
        }),
        { canCommitCreate },
      ),
    ).resolves.toMatchObject({ outcome: 'rejected' });
    const state = await target.getState(SCOPE);
    expect(state.tabsFile.tabs).toHaveLength(0);
    expect(state.revision).toBe(0);
    expect(
      await target.getCommandReceipt({ ...SCOPE, commandId: 'create-revoked' }),
    ).toBeNull();
  });

  beforeEach(() => {
    resetWorkspaceTargetExclusionsForTests();
    mockResumePendingObservations.mockReset().mockResolvedValue(undefined);
    mockTerminalState.mockReset().mockReturnValue(undefined);
    mockRecordInterruptedChats.mockReset().mockResolvedValue(undefined);
    mockIsModelBlockedByStoredPolicy.mockReset().mockResolvedValue(false);
    mockObserveSteeringInput.mockReset();
    initModelAliases({});
    initOllamaModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-state-service-'));
    paths = {
      tabs: join(tempDir, 'chats.json'),
      archives: join(tempDir, 'archives.json'),
      journal: join(tempDir, 'journal.jsonl'),
    };
    repositories = [];
    dispatched = [];
    queueEdit.mockReset();
    queueCancel.mockReset();
    queueEdit.mockReturnValue('applied');
    queueCancel.mockReturnValue('applied');
    queueForce.mockReset().mockResolvedValue('applied');
    queueConsumeRestoredInput.mockReset().mockResolvedValue(undefined);
    queueSnapshots.mockReset().mockReturnValue([]);
    const queueService = new ChatQueueService();
    jest.spyOn(queueService, 'edit').mockImplementation(queueEdit);
    jest.spyOn(queueService, 'cancel').mockImplementation(queueCancel);
    jest.spyOn(queueService, 'force').mockImplementation(queueForce);
    jest
      .spyOn(queueService, 'consumeRestoredInput')
      .mockImplementation(queueConsumeRestoredInput);
    jest
      .spyOn(queueService, 'getWorktreeSnapshots')
      .mockImplementation(queueSnapshots);
    mockedGetChatQueueService.mockReturnValue(queueService);
  });

  afterEach(async () => {
    setChatTabsWriteObserver(null);
    getChatQueueService().resetForTests();
    await Promise.all(repositories.map((repository) => repository.drainAll()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  function serviceWithRepository(
    overrides: Partial<ChatStateServiceOptions> = {},
    storagePaths = paths,
  ): {
    target: ChatStateService;
    repository: ChatStateRepository;
  } {
    const repository = new ChatStateRepository({
      resolvePaths: () => storagePaths,
    });
    repositories.push(repository);
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: async (request) => {
        dispatched.push(request);
      },
      steer: async () => false,
      onInputPickup: async () => undefined,
      authorizeSend: async () => undefined,
      approvePlanReview: async () => true,
      withPlanReviewRevision: async (_request, commit) => ({
        accepted: true,
        result: await commit(),
      }),
      cleanupSession: async () => undefined,
      // Fixture commands must not start the host's observability disk writer.
      recordDiagnostic: jest.fn(),
      ...overrides,
    });
    return { target, repository };
  }

  function service(): ChatStateService {
    return serviceWithRepository().target;
  }

  function copyDurableFilesAtBoundary(): typeof paths {
    const directory = mkdtempSync(join(tempDir, 'handoff-'));
    const snapshotPaths = {
      tabs: join(directory, 'chats.json'),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.jsonl'),
    };
    // Copy the real snapshot/WAL without draining the live repository or
    // allowing later provider receipts into the recovered files.
    for (const key of ['tabs', 'archives', 'journal'] as const) {
      if (existsSync(paths[key])) copyFileSync(paths[key], snapshotPaths[key]);
    }
    const sourceStorage = ChatStorageV2.fromLegacyPaths(paths);
    if (existsSync(sourceStorage.directory)) {
      const snapshotStorage = ChatStorageV2.fromLegacyPaths(snapshotPaths);
      cpSync(sourceStorage.directory, snapshotStorage.directory, {
        recursive: true,
      });
      mkdirSync(dirname(snapshotStorage.manifestPath), { recursive: true });
      copyFileSync(sourceStorage.manifestPath, snapshotStorage.manifestPath);
    }
    return snapshotPaths;
  }

  async function createChat(target: ChatStateService): Promise<void> {
    await expect(
      target.command(
        envelope('create-1', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          title: 'Durable chat',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied', revision: 1 });
  }

  it('resolves a snapshot while terminal observation publication is blocked', async () => {
    const target = service();
    await createChat(target);
    await target.updateCompatibilityTab(SCOPE, 'chat-1', (tab) => ({
      ...tab,
      interfaceMode: 'claude-code',
    }));
    Object.defineProperty(target, 'reconcileHostRuntime', { value: true });
    let release = (): void => undefined;
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockResumePendingObservations.mockReturnValue(publication);
    try {
      const result = await Promise.race([
        target.getState(SCOPE).then(() => 'snapshot'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('blocked'), 200),
        ),
      ]);
      expect(result).toBe('snapshot');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockResumePendingObservations).toHaveBeenCalledWith({
        ...SCOPE,
        chatId: 'chat-1',
      });
    } finally {
      release();
    }
  });

  it('claims first visible accepted start once with its original time', async () => {
    const target = service();
    await createChat(target);
    const input = {
      ...SCOPE,
      chatId: 'chat-1',
      sourceInputId: 'root-1',
      occurredAt: '2026-10-16T00:00:00.000Z',
    };
    expect(await target.claimNewChatStarted(input)).toBe(false);
    await target.updateCompatibilityTab(SCOPE, 'chat-1', (tab) => ({
      ...tab,
      messages: [
        {
          id: 'root-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Visible input' }],
        },
      ],
    }));
    expect(await target.claimNewChatStarted(input)).toBe(true);
    expect(await target.claimNewChatStarted(input)).toBe(false);
    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0].newChatStartedWatcherFiredAt).toBe(
      input.occurredAt,
    );
  });

  describe('visual provider re-reports', () => {
    const firstVisualId = 'vis_123e4567-e89b-42d3-a456-426614174000';
    const secondVisualId = 'vis_123e4567-e89b-42d3-a456-426614174001';
    const html = '<!doctype html><title>Saved view</title>';

    it('keeps Claude names, Codex names, and Cursor ledger identity separate per event', async () => {
      const { target, repository } = serviceWithRepository({
        claudeToolNames: new Set(['mcp__canopy__ShowVisual']),
        codexToolNames: new Set(['canopy_show_visual']),
        cursorToolUse: (scope, id) =>
          scope.chatId === 'chat-1' && id === 'trusted-cursor',
      });
      await createChat(target);
      const admission = jest.spyOn(repository, 'transactProviderEventWith');
      const cursorData = (provider: string) => ({
        type: 'canopy_assistant_patch',
        provider,
        messageId: `visual-${provider}`,
        timestamp: 1_786_104_000_000,
        revision: 1,
        patches: [
          {
            index: 0,
            block: {
              type: 'tool_result',
              toolUseId: 'trusted-cursor',
              output: firstVisualId,
              isError: false,
            },
          },
        ],
      });
      for (const [providerType, data] of [
        [
          'claude',
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'c',
                  content: firstVisualId,
                },
              ],
            },
          },
        ],
        [
          'codex',
          {
            type: 'codex',
            event: {
              type: 'item.completed',
              item: {
                id: 'cx',
                type: 'dynamic_tool_call',
                tool: 'canopy_show_visual',
                status: 'completed',
                success: true,
              },
            },
          },
        ],
        ['cursor', cursorData('cursor')],
        ['copilot', cursorData('cursor')],
      ] as const) {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          providerType,
          mutationId: `identity-${providerType}`,
          data,
        });
        const resolver = admission.mock.lastCall?.[3]?.resolveToolKey;
        if (providerType === 'copilot') {
          expect(
            resolver?.({
              toolUseId: 'trusted-cursor',
              toolName: 'mcp__canopy__ShowVisual',
            }),
          ).toBeUndefined();
          continue;
        }
        expect(resolver).toBeDefined();
        expect(
          resolver?.({
            toolUseId: 'trusted-cursor',
            toolName:
              providerType === 'codex'
                ? 'canopy_show_visual'
                : 'mcp__canopy__ShowVisual',
            codexCallId: 'cx',
          }),
        ).toBe('show_visual');
        expect(
          resolver?.({ toolUseId: 'untrusted', toolName: 'ShowVisual' }),
        ).toBeUndefined();
        if (providerType === 'codex')
          expect(
            resolver?.({
              toolUseId: 'untrusted',
              toolName: 'canopy_show_visual',
            }),
          ).toBeUndefined();
        if (providerType === 'cursor')
          expect(
            resolver?.({
              toolUseId: 'untrusted',
              toolName: 'mcp__canopy__ShowVisual',
            }),
          ).toBeUndefined();
      }
    });

    async function persistedVisualReference(
      repository: ChatStateRepository,
      messageId: string,
    ): Promise<PersistedVisualReference | undefined> {
      const state = await repository.getState(SCOPE, {
        chatIds: ['chat-1'],
      });
      const tab = state.tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat-1',
      );
      const message = tab?.messages.find(
        (candidate) => candidate.id === messageId,
      );
      const block = message?.blocks.find(
        (candidate) => candidate.type === 'tool_result',
      );
      return block?.type === 'tool_result' ? block.visualRef : undefined;
    }

    it('keeps a promoted Cursor patch reference over two assistant re-reports', async () => {
      const { target, repository } = serviceWithRepository({
        cursorToolUse: (target, toolUseId) =>
          target.chatId === 'chat-1' && toolUseId === 'cursor-visual-call',
      });
      await createChat(target);
      await target.stageVisual(
        SCOPE,
        { chatId: 'chat-1' },
        { visualId: firstVisualId, html, title: 'Saved view', maxHeight: 400 },
      );
      const patch = (revision: number) => ({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'cursor-visual-message',
        timestamp: 1_786_104_000_000,
        revision,
        patches: [
          {
            index: 0,
            block: {
              type: 'tool_use',
              toolUseId: 'cursor-visual-call',
              toolName: 'ShowVisual',
              input: '{}',
            },
          },
          {
            index: 1,
            block: {
              type: 'tool_result',
              toolUseId: 'cursor-visual-call',
              toolName: 'ShowVisual',
              output: `Shown ${firstVisualId}`,
              isError: false,
            },
          },
        ],
      });
      const sendPatch = async (revision: number): Promise<void> => {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          providerType: 'cursor',
          mutationId: `cursor-visual-${revision}`,
          data: patch(revision),
        });
      };

      await sendPatch(1);
      const first = await persistedVisualReference(
        repository,
        'cursor-visual-message',
      );
      expect(first?.visualId).toBe(firstVisualId);
      await sendPatch(2);
      await sendPatch(3);
      expect(
        await persistedVisualReference(repository, 'cursor-visual-message'),
      ).toEqual(first);
    });

    it('keeps a promoted Codex dynamic item reference over two completed-item re-reports', async () => {
      const { target, repository } = serviceWithRepository({
        codexToolNames: new Set(['canopy_show_visual']),
      });
      await createChat(target);
      await target.stageVisual(
        SCOPE,
        { chatId: 'chat-1' },
        {
          visualId: secondVisualId,
          html,
          title: 'Codex view',
          maxHeight: 400,
          codexCallId: 'native-visual-call',
        },
      );
      const completed = (sequence: number) => ({
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'native-visual-call',
            type: 'dynamic_tool_call',
            tool: 'canopy_show_visual',
            arguments: {},
            status: 'completed',
            success: true,
            content_items: [{ type: 'inputText', text: secondVisualId }],
          },
          sequence,
        },
      });
      const sendCompleted = async (sequence: number): Promise<void> => {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          providerType: 'codex',
          mutationId: `codex-visual-${sequence}`,
          data: completed(sequence),
        });
      };

      await sendCompleted(1);
      const first = await persistedVisualReference(
        repository,
        'codex-native-visual-call',
      );
      expect(first?.visualId).toBe(secondVisualId);
      await sendCompleted(2);
      await sendCompleted(3);
      expect(
        await persistedVisualReference(repository, 'codex-native-visual-call'),
      ).toEqual(first);
    });

    it('does not admit terminal sync, cancellation, or errored tool results', async () => {
      const { target, repository } = serviceWithRepository({
        claudeToolNames: new Set(['mcp__canopy__ShowVisual']),
      });
      await createChat(target);
      const providerAdmission = jest.spyOn(
        repository,
        'transactProviderEventWith',
      );
      const rejectedEvents: Array<{
        source: 'provider' | 'terminal';
        data: unknown;
      }> = [
        {
          source: 'terminal' as const,
          data: {
            type: 'claude_terminal_transcript_sync',
            messages: [
              {
                id: 'terminal-visual-result',
                role: 'assistant',
                timestamp: 1,
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId: 'terminal-call',
                    toolName: 'ShowVisual',
                    output: firstVisualId,
                    isError: false,
                  },
                ],
              },
            ],
          },
        },
        {
          source: 'provider' as const,
          data: { type: 'result', is_error: true, result: firstVisualId },
        },
        {
          source: 'provider' as const,
          data: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'errored-call',
                  content: firstVisualId,
                  is_error: true,
                },
              ],
            },
          },
        },
      ];
      for (let index = 0; index < rejectedEvents.length; index++) {
        const event = rejectedEvents[index];
        if (!event) continue;
        await target.ingestProviderEventWithOutcome({
          ...SCOPE,
          chatId: 'chat-1',
          providerType: 'claude',
          source: event.source,
          mutationId: `non-admitted-visual-${index}`,
          data: event.data,
        });
      }

      expect(providerAdmission).not.toHaveBeenCalled();
      const state = await repository.getState(SCOPE, { chatIds: ['chat-1'] });
      expect(
        state.tabsFile.tabs
          .find((tab) => tab.id === 'chat-1')
          ?.messages.flatMap((message) => message.blocks)
          .some((block) => block.type === 'tool_result' && block.visualRef),
      ).toBe(false);
    });
  });

  it('counts provider events ingested, those that committed, and their commits', async () => {
    const target = service();
    await createChat(target);
    resetWorkCounters();
    const reply = {
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'counted-reply',
      data: {
        type: 'assistant',
        message: {
          id: 'counted-reply',
          role: 'assistant',
          content: [{ type: 'text', text: 'Counted reply' }],
        },
      },
    };

    await expect(target.ingestProviderEvent(reply)).resolves.toBe(true);
    // A replayed event is ingested again but commits nothing.
    await expect(target.ingestProviderEvent(reply)).resolves.toBe(false);

    const counters = snapshotWorkCounters();
    expect(counters.provider).toEqual({ eventsIngested: 2, eventsApplied: 1 });
    expect(counters.chatStorage).toMatchObject({ commits: 1 });
    expect(counters.chatStorage.mutations).toBeGreaterThan(0);
  });

  it('reports a turn finished only once it was accepted and nothing runs or queues it', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const turn = { ...SCOPE, chatId: 'chat-1', userMessageId: 'user-turn' };
    const held = jest
      .spyOn(getChatQueueService(), 'holdsUserMessage')
      .mockReturnValue(false);
    const runtime = (
      status: ChatRuntimeStatus,
      activeUserMessageId: string | null,
      queuedMessageIds: string[] = [],
    ): Promise<unknown> =>
      repository.transact(
        SCOPE,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status,
              ...(activeUserMessageId
                ? {
                    activeTurn: {
                      userMessageId: activeUserMessageId,
                      startedAt: 1,
                    },
                  }
                : {}),
              queuedMessageIds,
            },
          },
        ],
        { source: 'provider' },
      );

    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    await runtime('streaming', 'later-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    await target.ingestProviderEvent({
      ...turn,
      mutationId: 'chat-1:user-turn:accepted',
      turnUserMessageId: 'user-turn',
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: 'user-turn',
      },
    });
    held.mockReturnValue(true);
    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    held.mockReturnValue(false);
    await runtime('streaming', 'user-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    await runtime('interrupted', 'user-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    await runtime('idle', null, ['user-turn']);
    await expect(target.turnOutcome(turn)).resolves.toBe('pending');
    await runtime('failed', 'user-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('failed');
    await runtime('cancelled', 'user-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('cancelled');
    await runtime('completed', 'user-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('completed');
    await runtime('streaming', 'later-turn');
    await expect(target.turnOutcome(turn)).resolves.toBe('completed');
  });

  it("reports a chat's first turn by its first user message", async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const first = { ...SCOPE, chatId: 'chat-1', userMessageId: null };
    jest
      .spyOn(getChatQueueService(), 'holdsUserMessage')
      .mockReturnValue(false);
    await expect(target.turnOutcome(first)).resolves.toBe('pending');
    await target.command(
      envelope('send-first', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-first',
        text: 'Start the review',
      }),
    );
    await target.command(
      envelope('send-second', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-second',
        text: 'Then check the docs',
      }),
    );
    await expect(target.turnOutcome(first)).resolves.toBe('pending');
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'chat-1:user-second:accepted',
      turnUserMessageId: 'user-second',
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: 'user-second',
      },
    });
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            activeTurn: { userMessageId: 'user-second', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
      ],
      { source: 'provider' },
    );
    await expect(target.turnOutcome(first)).resolves.toBe('completed');
  });

  it('names the user messages whose transcript position does not start a turn yet', async () => {
    const { target } = serviceWithRepository();
    await createChat(target);
    const chat = { ...SCOPE, chatId: 'chat-1' };
    await target.reconcileHostQueue(
      chat,
      ['row-queued'],
      true,
      undefined,
      [
        {
          id: 'row-queued',
          request: { ...chat, userMessageId: 'user-queued', text: 'Next' },
          origin: 'desktop',
          enqueuedAtMs: 1,
        },
      ],
      'user-running',
    );
    const dispatching = jest
      .spyOn(getChatQueueService(), 'dispatchingUserMessageId')
      .mockReturnValue('user-dispatching');

    await expect(target.provisionalTurnUserMessageIds(chat)).resolves.toEqual(
      new Set(['row-queued', 'user-queued', 'user-dispatching']),
    );

    await target.ingestProviderEvent({
      ...chat,
      mutationId: 'chat-1:user-dispatching:accepted',
      turnUserMessageId: 'user-dispatching',
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: 'user-dispatching',
      },
    });
    await expect(target.provisionalTurnUserMessageIds(chat)).resolves.toEqual(
      new Set(['row-queued', 'user-queued']),
    );
    dispatching.mockReturnValue(undefined);
  });

  it('reads a turn from the same chat state as its provisional user messages', async () => {
    const { target } = serviceWithRepository();
    await createChat(target);
    const chat = { ...SCOPE, chatId: 'chat-1' };
    const text = (
      id: string,
      role: 'user' | 'assistant',
      body: string,
    ): PersistedChatMessage => ({
      id,
      role,
      timestamp: 1,
      blocks: [{ type: 'text', text: body }],
    });
    const writeTranscript = async (
      messages: PersistedChatMessage[],
      lastAcceptedUserMessageId: string,
    ): Promise<void> => {
      const state = await target.getState(SCOPE);
      const tab = state.tabsFile.tabs[0];
      if (!tab) throw new Error('Expected chat');
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...state.tabsFile,
          tabs: [{ ...tab, lastAcceptedUserMessageId, messages }],
        },
        { authoritative: true },
      );
    };
    await writeTranscript(
      [text('user-a', 'user', 'A'), text('reply-a', 'assistant', 'Reply to A')],
      'user-a',
    );
    await target.reconcileHostQueue(
      chat,
      ['row-b'],
      true,
      undefined,
      [
        {
          id: 'row-b',
          request: { ...chat, userMessageId: 'user-b', text: 'B' },
          origin: 'desktop',
          enqueuedAtMs: 1,
        },
      ],
      'user-a',
    );
    let accepting: Promise<void> | undefined;
    const acceptFollowUp = async (): Promise<void> => {
      await writeTranscript(
        [
          text('user-a', 'user', 'A'),
          text('reply-a', 'assistant', 'Reply to A'),
          text('user-b', 'user', 'B'),
          text('reply-b', 'assistant', 'Reply to B'),
        ],
        'user-b',
      );
      await target.reconcileHostQueue(chat, [], true, undefined, [], 'user-b');
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const readState = ChatStateV2Backend.prototype.state;
    const stateRead = jest
      .spyOn(ChatStateV2Backend.prototype, 'state')
      .mockImplementationOnce(async function (
        this: ChatStateV2Backend,
        selection,
      ) {
        const state = await readState.call(this, selection);
        accepting = acceptFollowUp();
        return state;
      });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const readPage = ChatStateRepository.prototype.page;
    const pageRead = jest
      .spyOn(ChatStateRepository.prototype, 'page')
      .mockImplementation(async function (this: ChatStateRepository, ...args) {
        await accepting;
        return readPage.apply(this, args);
      });

    const turn = await target.turnReplyMessages({
      ...chat,
      userMessageId: 'user-a',
    });
    await accepting;
    stateRead.mockRestore();
    pageRead.mockRestore();

    const ids = (
      messages: PersistedChatMessage[] | null,
    ): string[] | undefined => messages?.map((message) => message.id);
    expect(accepting).toBeDefined();
    expect(ids(turn)).toEqual(['reply-a']);
    expect(
      ids(await target.turnReplyMessages({ ...chat, userMessageId: 'user-a' })),
    ).toEqual(['reply-a']);
    expect(
      ids(await target.turnReplyMessages({ ...chat, userMessageId: 'user-b' })),
    ).toEqual(['reply-b']);
  });

  describe('a turn an app restart interrupted', () => {
    type Notice = Parameters<
      NonNullable<ChatStateServiceOptions['notifyTurnTerminal']>
    >[0];
    const CHAT = { ...SCOPE, chatId: 'chat-1' };
    const turn = (
      userMessageId: string,
    ): typeof CHAT & { userMessageId: string } => ({ ...CHAT, userMessageId });

    function setup(): {
      target: ChatStateService;
      repository: ChatStateRepository;
      notices: Notice[];
    } {
      const notices: Notice[] = [];
      const { target, repository } = serviceWithRepository({
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      jest
        .spyOn(getChatQueueService(), 'holdsUserMessage')
        .mockReturnValue(false);
      return { target, repository, notices };
    }

    async function prompt(
      target: ChatStateService,
      userMessageId: string,
      resumes = false,
    ): Promise<void> {
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:user-prompt`,
        turnUserMessageId: userMessageId,
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: userMessageId,
          ...(resumes ? { canopy_resumes_interrupted_turn: true } : {}),
          canopy_persisted_messages: [
            {
              id: userMessageId,
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: `Run ${userMessageId}` }],
            },
          ],
        },
      });
    }

    async function accept(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<void> {
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:accepted`,
        turnUserMessageId: userMessageId,
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: userMessageId,
        },
      });
    }

    async function complete(
      repository: ChatStateRepository,
      userMessageId: string,
    ): Promise<void> {
      await repository.transact(
        SCOPE,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'completed',
              activeTurn: { userMessageId, startedAt: 1 },
              queuedMessageIds: [],
            },
          },
        ],
        { source: 'provider' },
      );
    }

    async function restart(target: ChatStateService): Promise<void> {
      Object.defineProperty(target, 'reconcileHostRuntime', {
        value: true,
        configurable: true,
      });
      await target.getState(SCOPE);
      Object.defineProperty(target, 'reconcileHostRuntime', {
        value: false,
        configurable: true,
      });
      expect(
        (await target.getState(SCOPE)).runtimeByChatId['chat-1'],
      ).toMatchObject({ status: 'interrupted' });
    }

    it.each([
      ['accepted', true],
      ['never accepted', false],
    ] as const)(
      'reports an %s interrupted turn by the turn that resumed it',
      async (_case, accepted) => {
        const { target, repository } = setup();
        await createChat(target);
        await prompt(target, 'user-x');
        if (accepted) await accept(target, 'user-x');
        await restart(target);
        await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
          'pending',
        );

        await prompt(target, 'user-resume', true);
        await accept(target, 'user-resume');
        await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
          'pending',
        );
        await complete(repository, 'user-resume');
        await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
          'completed',
        );

        await prompt(target, 'user-later');
        await accept(target, 'user-later');
        await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
          'completed',
        );
      },
    );

    it('reports a turn resumed after a second restart by the last resume', async () => {
      const { target, repository } = setup();
      await createChat(target);
      await prompt(target, 'user-x');
      await accept(target, 'user-x');
      await restart(target);
      await prompt(target, 'user-resume', true);
      await accept(target, 'user-resume');
      await restart(target);
      await expect(target.turnOutcome(turn('user-x'))).resolves.toBe('pending');

      await prompt(target, 'user-resume-again', true);
      await accept(target, 'user-resume-again');
      await complete(repository, 'user-resume-again');

      await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
        'completed',
      );
      await expect(target.turnOutcome(turn('user-resume'))).resolves.toBe(
        'completed',
      );
    });

    it('ends an interrupted turn as cancelled, once, when another turn starts instead of a resume', async () => {
      const { target, repository, notices } = setup();
      await createChat(target);
      await prompt(target, 'user-x');
      await accept(target, 'user-x');
      await restart(target);

      await prompt(target, 'user-fresh');
      await accept(target, 'user-fresh');
      await complete(repository, 'user-fresh');
      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
        'cancelled',
      );
      await expect(target.turnOutcome(turn('user-fresh'))).resolves.toBe(
        'completed',
      );
      expect(notices).toEqual([
        expect.objectContaining({
          chatId: 'chat-1',
          userMessageId: 'user-x',
          outcome: 'cancelled',
          data: expect.objectContaining({
            canopy_turn_user_message_id: 'user-x',
            canopy_turn_abandoned: true,
          }),
        }),
      ]);

      await prompt(target, 'user-resume', true);
      await accept(target, 'user-resume');
      await complete(repository, 'user-resume');
      await expect(target.turnOutcome(turn('user-x'))).resolves.toBe(
        'cancelled',
      );
      expect(notices).toHaveLength(1);
    });
  });

  describe('a turn that ended before a follow-up started', () => {
    const CHAT = { ...SCOPE, chatId: 'chat-1' };
    const turn = (
      userMessageId: string,
    ): typeof CHAT & { userMessageId: string } => ({ ...CHAT, userMessageId });

    function setup(): {
      target: ChatStateService;
      repository: ChatStateRepository;
    } {
      const fixture = serviceWithRepository();
      jest
        .spyOn(getChatQueueService(), 'holdsUserMessage')
        .mockReturnValue(false);
      return fixture;
    }

    async function startTurn(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<void> {
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:user-prompt`,
        turnUserMessageId: userMessageId,
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: userMessageId,
          canopy_persisted_messages: [
            {
              id: userMessageId,
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: `Run ${userMessageId}` }],
            },
          ],
        },
      });
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:accepted`,
        turnUserMessageId: userMessageId,
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: userMessageId,
        },
      });
    }

    async function completeTurn(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<void> {
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:reply`,
        turnUserMessageId: userMessageId,
        data: {
          type: 'assistant',
          message: {
            id: `${userMessageId}-reply`,
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
          },
        },
      });
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: `chat-1:${userMessageId}:result`,
        turnUserMessageId: userMessageId,
        data: { type: 'result', is_error: false, result: 'Done' },
      });
    }

    const ends = [
      {
        name: 'a provider error',
        outcome: 'failed',
        data: { type: 'result', is_error: true, result: 'Provider failed' },
      },
      {
        name: 'a Codex turn failure',
        outcome: 'failed',
        data: {
          type: 'codex',
          event: { type: 'turn.failed', message: 'Codex failed' },
        },
      },
      {
        name: 'Stop',
        outcome: 'cancelled',
        data: { type: 'result', is_error: false, result: 'Cancelled' },
      },
      {
        name: 'a Stop the provider reports as an aborted stream',
        outcome: 'cancelled',
        data: {
          type: 'result',
          is_error: true,
          terminal_reason: 'aborted_streaming',
        },
      },
      {
        name: 'a denied tool that stops the turn',
        outcome: 'cancelled',
        data: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
        },
      },
      {
        name: 'a plan handed to review',
        outcome: 'completed',
        data: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
          canopy_plan_handoff: true,
        },
      },
    ] as const;

    it.each(ends)(
      'keeps reporting a turn ended by $name as $outcome after a follow-up starts and completes',
      async ({ outcome, data }) => {
        const { target } = setup();
        await createChat(target);
        await startTurn(target, 'user-first');
        await target.ingestProviderEvent({
          ...CHAT,
          mutationId: 'chat-1:user-first:end',
          data,
        });
        await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
          outcome,
        );

        await startTurn(target, 'user-next');
        await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
          outcome,
        );
        await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
          'pending',
        );

        await completeTurn(target, 'user-next');
        await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
          outcome,
        );
        await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
          'completed',
        );
        await expect(
          target.settledTurn(turn('user-first')),
        ).resolves.toMatchObject({ outcome, userMessageId: 'user-first' });
      },
    );

    it('completes a plan handed to review without counting it an empty completion', async () => {
      const { target } = setup();
      await createChat(target);
      await startTurn(target, 'user-plan');
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: 'chat-1:user-plan:end',
        turnUserMessageId: 'user-plan',
        data: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
          canopy_plan_handoff: true,
        },
      });

      await expect(target.turnOutcome(turn('user-plan'))).resolves.toBe(
        'completed',
      );
      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime).toMatchObject({ status: 'completed' });
      expect(runtime?.error).toBeUndefined();
    });

    it('keeps the outcome of a turn whose chat was archived after a follow-up', async () => {
      const { target } = setup();
      await createChat(target);
      await startTurn(target, 'user-first');
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: 'chat-1:user-first:end',
        data: { type: 'result', is_error: true, result: 'Provider failed' },
      });
      await startTurn(target, 'user-next');
      await completeTurn(target, 'user-next');
      await expect(
        target.command(
          envelope('archive-ended', {
            type: 'chat.archive_tab',
            tabId: 'chat-1',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
        'failed',
      );
      await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
        'completed',
      );
    });

    it('reports a failed turn pending again once the same turn runs again', async () => {
      const { target } = setup();
      await createChat(target);
      await startTurn(target, 'user-first');
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: 'chat-1:user-first:end',
        data: { type: 'result', is_error: true, result: 'Provider failed' },
      });
      await target.ingestProviderEvent({
        ...CHAT,
        mutationId: 'chat-1:user-first:user-prompt-again',
        turnUserMessageId: 'user-first',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'user-first',
        },
      });
      await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
        'pending',
      );
      await completeTurn(target, 'user-first');
      await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
        'completed',
      );
    });

    it('infers from acceptance order for a turn that ended before ends were recorded', async () => {
      const { target, repository } = setup();
      await createChat(target);
      await startTurn(target, 'user-first');
      await repository.transact(
        SCOPE,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'failed',
              activeTurn: { userMessageId: 'user-first', startedAt: 1 },
              queuedMessageIds: [],
            },
          },
        ],
        { source: 'provider' },
      );
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs.find(
          (tab) => tab.id === 'chat-1',
        )?.turnEnds,
      ).toBeUndefined();
      await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
        'failed',
      );

      await startTurn(target, 'user-next');
      await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
        'completed',
      );
      await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
        'pending',
      );
    });
  });

  it('reports how turns ended after their markers left the bounded mutation index', async () => {
    const { target, repository } = serviceWithRepository({
      dispatch: async (request) => {
        dispatched.push(request);
        if (request.userMessageId === 'user-failed') {
          throw new Error('The provider could not start.');
        }
      },
    });
    await createChat(target);
    await expect(
      target.command(
        envelope('create-2', {
          type: 'chat.create_tab',
          tabId: 'chat-2',
          title: 'Second chat',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    jest
      .spyOn(getChatQueueService(), 'holdsUserMessage')
      .mockReturnValue(false);
    const turn = (
      userMessageId: string,
      chatId = 'chat-1',
    ): typeof SCOPE & { chatId: string; userMessageId: string } => ({
      ...SCOPE,
      chatId,
      userMessageId,
    });
    const send = (userMessageId: string, chatId = 'chat-1'): Promise<unknown> =>
      target.command(
        envelope(`send-${userMessageId}`, {
          type: 'chat.send_message',
          chatId,
          userMessageId,
          text: `Run ${userMessageId}`,
        }),
      );
    const accept = (userMessageId: string): Promise<boolean> =>
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: `chat-1:${userMessageId}:accepted`,
        turnUserMessageId: userMessageId,
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: userMessageId,
        },
      });

    await send('user-done');
    await accept('user-done');
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            activeTurn: { userMessageId: 'user-done', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
      ],
      { source: 'provider' },
    );
    await send('user-next');
    await accept('user-next');
    await send('user-queued');
    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      [],
      true,
      {
        type: 'cancel',
        request: {
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'user-queued',
          text: 'Run user-queued',
        },
      },
      [],
      'user-next',
    );
    await send('user-failed', 'chat-2');
    await expect(
      target.turnOutcome(turn('user-failed', 'chat-2')),
    ).resolves.toBe('failed');

    for (let start = 0; start < 4_200; start += 300) {
      await Promise.all(
        Array.from({ length: 300 }, (_, offset) =>
          repository.transact(
            SCOPE,
            [{ type: 'tab.metadata_patched', tabId: 'chat-2', patch: {} }],
            { source: 'automation', mutationId: `later-${start + offset}` },
          ),
        ),
      );
    }
    for (const marker of [
      'chat-1:user-done:accepted',
      'chat-1:user-next:accepted',
      'chat-1:user-queued:unaccepted:cancelled',
      'chat-2:user-failed:unaccepted:failed',
    ]) {
      await expect(repository.hasMutation(SCOPE, marker)).resolves.toBe(false);
    }

    await expect(target.turnOutcome(turn('user-done'))).resolves.toBe(
      'completed',
    );
    await expect(
      target.turnOutcome({ ...SCOPE, chatId: 'chat-1', userMessageId: null }),
    ).resolves.toBe('completed');
    await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
      'pending',
    );
    await expect(target.turnOutcome(turn('user-queued'))).resolves.toBe(
      'cancelled',
    );
    await expect(
      target.turnOutcome(turn('user-failed', 'chat-2')),
    ).resolves.toBe('failed');
  }, 120_000);

  it('reports a provider event’s place in commit order at once, so events submitted without waiting commit in provider order', async () => {
    // Group commit: the turn pipeline submits
    // the next streamed event once this signal fires, before the commit is
    // durable.

    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const queued: string[] = [];
    const results = ['r1', 'r2', 'r3', 'r4'].map((id) => {
      let reported = false;
      const result = target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: `overlap-${id}`,
        data: {
          type: 'assistant',
          message: {
            id,
            role: 'assistant',
            content: [{ type: 'text', text: `Reply ${id}` }],
          },
        },
        onCommitQueued: (): void => {
          reported = true;
          queued.push(id);
        },
      });
      // Synchronously: the scope lease already holds this commit's turn.
      expect(reported).toBe(true);
      return result;
    });
    await expect(Promise.all(results)).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(queued).toEqual(['r1', 'r2', 'r3', 'r4']);
    const state = await repository.getState(SCOPE, { chatIds: ['chat-1'] });
    expect(
      state.tabsFile.tabs[0].messages.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      ),
    ).toEqual(['Reply r1', 'Reply r2', 'Reply r3', 'Reply r4']);
    // Each event committed once, in order.
    expect(state.tabsFile.revision).toBe(5);
  });

  describe('a send to a chat that stores an Agent on the default model', () => {
    const ROUTE = 'agent_model_inherit@gpt-5.5';

    async function createAgentChat(target: ChatStateService): Promise<void> {
      await expect(
        target.command(
          envelope('create-agent', {
            type: 'chat.create_tab',
            tabId: 'chat-1',
            title: 'Agent chat',
            providerType: 'claude',
            model: 'agent_model_inherit',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    }

    function sendWithoutModel(target: ChatStateService) {
      return target.command(
        envelope('send-agent', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'agent-message',
          text: 'From the Portal',
        }),
      );
    }

    it('commits and dispatches the pinned route', async () => {
      const resolveSendModel = jest.fn(
        (
          _target: unknown,
          stored: string | undefined,
          requested: string | undefined,
        ): Promise<string | undefined> =>
          Promise.resolve(
            (requested ?? stored) === 'agent_model_inherit' ? ROUTE : undefined,
          ),
      );
      const { target } = serviceWithRepository({ resolveSendModel });
      await createAgentChat(target);

      await expect(sendWithoutModel(target)).resolves.toMatchObject({
        outcome: 'applied',
      });

      expect(resolveSendModel).toHaveBeenCalledWith(
        SCOPE,
        'agent_model_inherit',
        undefined,
      );
      expect((await target.getState(SCOPE)).tabsFile.tabs[0].model).toBe(ROUTE);
      expect(dispatched).toEqual([expect.objectContaining({ model: ROUTE })]);
    });

    it('writes nothing when the default is another Agent', async () => {
      const { target } = serviceWithRepository({
        resolveSendModel: () =>
          Promise.reject(new Error('the default model is an Agent')),
      });
      await createAgentChat(target);

      await expect(sendWithoutModel(target)).rejects.toThrow(
        'the default model is an Agent',
      );

      const [tab] = (await target.getState(SCOPE)).tabsFile.tabs;
      expect(tab.model).toBe('agent_model_inherit');
      expect(tab.messages).toEqual([]);
      expect(dispatched).toEqual([]);
    });

    it.each([
      ['the send names no model', undefined],
      ['the send names the Agent', 'agent_model_inherit'],
    ])(
      'writes nothing for a kept route whose model is no longer available when %s',
      async (_case, requestedModel) => {
        initAgentModels([
          {
            id: 'agent_model_inherit',
            name: 'Inherit',
            baseModel: 'default',
            instructions: '',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
            createdAt: '2026-10-14T00:00:00.000Z',
            updatedAt: '2026-10-14T00:00:00.000Z',
            available: true,
          },
        ]);
        try {
          // The real resolver, not a stub.
          const { target } = serviceWithRepository();
          await expect(
            target.command(
              envelope('create-stale-route', {
                type: 'chat.create_tab',
                tabId: 'chat-1',
                title: 'Agent chat',
                providerType: 'claude',
                model: 'agent_model_inherit@removed-model',
              }),
            ),
          ).resolves.toMatchObject({ outcome: 'applied' });

          await expect(
            target.command(
              envelope('send-agent', {
                type: 'chat.send_message',
                chatId: 'chat-1',
                userMessageId: 'agent-message',
                text: 'From the Portal',
                ...(requestedModel ? { model: requestedModel } : {}),
              }),
            ),
          ).rejects.toThrow('is set to unavailable model "removed-model"');

          const [tab] = (await target.getState(SCOPE)).tabsFile.tabs;
          expect(tab.model).toBe('agent_model_inherit@removed-model');
          expect(tab.messages).toEqual([]);
          expect(dispatched).toEqual([]);
        } finally {
          initAgentModels([]);
        }
      },
    );

    it('lets a model change that lands during the pin win', async () => {
      let releasePin: (() => void) | undefined;
      const pinGate = new Promise<void>((resolve) => {
        releasePin = resolve;
      });
      let pinStarted: (() => void) | undefined;
      const pinning = new Promise<void>((resolve) => {
        pinStarted = resolve;
      });
      const { target, repository } = serviceWithRepository({
        resolveSendModel: async () => {
          pinStarted?.();
          await pinGate;
          return ROUTE;
        },
      });
      await createAgentChat(target);

      const send = sendWithoutModel(target);
      await pinning;
      const [tab] = (await repository.getState(SCOPE, { chatIds: ['chat-1'] }))
        .tabsFile.tabs;
      await repository.transact(
        SCOPE,
        [
          {
            type: 'tab.created',
            tab: { ...tab, model: 'claude-sonnet-4-6' },
          },
        ],
        { source: 'renderer-command', mutationId: 'concurrent-model-change' },
      );
      releasePin?.();

      await expect(send).resolves.toMatchObject({ outcome: 'applied' });
      expect((await target.getState(SCOPE)).tabsFile.tabs[0].model).toBe(
        'claude-sonnet-4-6',
      );
      expect(dispatched).toEqual([
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      ]);
    });
  });

  it('reconciles a continuation from a durable receipt after reopening the service', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const request = envelope('continue-request', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'continuation-turn',
      text: 'Summarize my issues.',
    });
    const accepted = await target.command(request);
    expect(accepted).toMatchObject({
      outcome: 'applied',
      entityId: 'chat-1',
      messageId: 'continuation-turn',
    });
    await repository.drainAll();
    const reopened = service();
    await expect(
      reopened.getCommandReceipt({ ...SCOPE, commandId: request.commandId }),
    ).resolves.toMatchObject({
      outcome: 'applied',
      entityId: 'chat-1',
      messageId: 'continuation-turn',
    });
    await expect(reopened.command(request)).resolves.toMatchObject({
      outcome: 'already_applied',
      entityId: 'chat-1',
      messageId: 'continuation-turn',
    });
    expect(dispatched).toHaveLength(1);
  });

  it('replays the same continuation once when a receipt read misses an in-flight send', async () => {
    let releaseSend = (): void => undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markSendStarted = (): void => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const authorizeSend = jest.fn(async () => {
      markSendStarted();
      await sendGate;
    });
    const { target } = serviceWithRepository({ authorizeSend });
    await createChat(target);
    const request = envelope('try-it-continuation-request', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'continuation-request',
      text: 'Summarize my issues.',
    });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => target },
    });
    const readReceipt = () =>
      dispatcher.query(
        'core.chat.send.receipt',
        {
          scope: {
            workspaceId: SCOPE.projectId,
            worktreeId: SCOPE.worktreeId,
            chatId: 'chat-1',
          },
          commandId: request.commandId,
        },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'try-it-receipt-recovery',
            authorityId: 'local-desktop',
            interfaceKind: 'desktop',
            grants: ['core.chat.read'],
          },
        },
      );
    const original = target.command(request);
    let replay: ReturnType<typeof target.command> | undefined;
    try {
      await sendStarted;
      await expect(readReceipt()).resolves.toEqual({ outcome: 'missing' });
      expect(dispatched).toHaveLength(0);

      // Missing is only an observation: the original command can still commit.
      // Reuse its scope, command ID and message ID while it remains in flight.
      replay = target.command(request);
      releaseSend();
      const [accepted, retried] = await Promise.all([original, replay]);
      expect(accepted).toMatchObject({
        outcome: 'applied',
        commandId: 'try-it-continuation-request',
        entityId: 'chat-1',
        messageId: 'continuation-request',
      });
      expect(retried).toEqual({ ...accepted, outcome: 'already_applied' });
      await expect(readReceipt()).resolves.toEqual({
        outcome: 'matched',
        receipt: accepted,
      });
      expect(authorizeSend).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveLength(1);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.filter(
          ({ id }) => id === 'continuation-request',
        ),
      ).toHaveLength(1);
    } finally {
      releaseSend();
      await Promise.allSettled([original, ...(replay ? [replay] : [])]);
      await dispatcher.shutdown();
    }
  });

  it('does not treat a continuation message row as an acceptance receipt', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'continuation-turn',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Summarize my issues.' }],
          },
        },
      ],
      { source: 'renderer-command' },
    );
    await expect(
      target.getCommandReceipt({ ...SCOPE, commandId: 'continue-request' }),
    ).resolves.toBeNull();
    await expect(
      target.getPortalSendReceipt({
        ...SCOPE,
        commandId: 'continue-request',
        identity: {
          chatId: 'chat-1',
          userMessageId: 'continuation-turn',
          fingerprint: 'a'.repeat(64),
        },
      }),
    ).resolves.toEqual({ outcome: 'conflict' });
    expect(dispatched).toHaveLength(0);
  });

  it('replays a send receipt by command ID without comparing a changed payload', async () => {
    const target = service();
    await createChat(target);
    const first = await target.command({
      ...envelope('send-replay', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-first',
        text: 'First',
      }),
      expectedRevision: 0,
    });
    const replay = await target.command(
      envelope('send-replay', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-changed',
        text: 'Changed',
      }),
    );

    expect(first).toMatchObject({ outcome: 'applied' });
    expect(replay).toMatchObject({
      outcome: 'already_applied',
      revision: first.revision,
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0].messages.map(
        (message) => message.id,
      ),
    ).toContain('message-first');
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0].messages.map(
        (message) => message.id,
      ),
    ).not.toContain('message-changed');
  });

  // CAN-3923: Portal selection writes use the same settings patch as desktop.
  it('keeps the last committed plugin selection through replay, a later edit and reopen', async () => {
    const target = service();
    await createChat(target);
    const selected = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
    };
    const select = (
      commandId: string,
      pluginRefs: typeof selected.pluginRefs,
    ) =>
      envelope(commandId, {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pluginSelections: { ...selected, pluginRefs } },
      });
    const pluginRefs = async (): Promise<unknown> =>
      (await service().getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'chat-1',
      )?.pluginSelections?.pluginRefs;

    const committed = await target.command(
      select('select-1', selected.pluginRefs),
    );
    expect(committed).toMatchObject({ outcome: 'applied' });
    // A duplicate delivery never applies a second write.
    await expect(target.command(select('select-1', []))).resolves.toMatchObject(
      {
        outcome: 'already_applied',
        revision: committed.revision,
      },
    );
    await expect(pluginRefs()).resolves.toEqual(selected.pluginRefs);

    // Settings patches commute with newer commits: the later write wins, and
    // a reopened scope keeps exactly its refs.
    const later = [{ marketplaceId: 'market', pluginName: 'other' }];
    await expect(
      target.command({ ...select('select-2', later), expectedRevision: 0 }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(pluginRefs()).resolves.toEqual(later);
  });

  it('preserves create/update receipts and CAS outcomes through the dispatcher', async () => {
    const direct = service();
    const routedPaths = {
      tabs: join(tempDir, 'routed', 'chats.json'),
      archives: join(tempDir, 'routed', 'archives.json'),
      journal: join(tempDir, 'routed', 'journal.jsonl'),
    };
    const routed = serviceWithRepository({}, routedPaths).target;
    setChatStateCommandPort(routed);
    try {
      const dispatcher = createDesktopRuntime();
      const options = createChatCommandDispatchOptions(routed, dispatcher, {
        principalId: 'local-desktop-user',
        clientInstanceId: 'chat-equivalence',
        authorityId: 'local-desktop',
        interfaceKind: 'desktop',
        grants: ['core.chat.write'],
      });
      const requests = [
        envelope('create-equivalent', {
          type: 'chat.create_tab',
          tabId: 'chat-equivalent',
          title: 'Equivalent',
        }),
        envelope('update-equivalent', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-equivalent',
          patch: { unread: true, title: 'Renamed' },
        }),
        {
          ...envelope('stale-equivalent', {
            type: 'chat.mark_read',
            chatId: 'chat-equivalent',
          }),
          expectedRevision: 0,
        },
      ];
      for (const request of [...requests, requests[1]]) {
        expect(await dispatchTrustedChatCommand(request, options)).toEqual(
          await direct.command(request),
        );
      }
      expect(await routed.getState(SCOPE)).toEqual(
        await direct.getState(SCOPE),
      );
    } finally {
      setChatStateCommandPort(null);
    }
  });

  it('preserves archive/delete/fork receipts and CAS outcomes through the dispatcher', async () => {
    const directFixture = serviceWithRepository();
    const direct = directFixture.target;
    const routedPaths = {
      tabs: join(tempDir, 'routed-lifecycle', 'chats.json'),
      archives: join(tempDir, 'routed-lifecycle', 'archives.json'),
      journal: join(tempDir, 'routed-lifecycle', 'journal.jsonl'),
    };
    const routedFixture = serviceWithRepository({}, routedPaths);
    const routed = routedFixture.target;
    setChatStateCommandPort(routed);
    try {
      const dispatcher = createDesktopRuntime();
      const instruction = jest.spyOn(dispatcher, 'instruction');
      const options = createChatCommandDispatchOptions(routed, dispatcher, {
        principalId: 'local-desktop-user',
        clientInstanceId: 'chat-lifecycle-equivalence',
        authorityId: 'local-desktop',
        interfaceKind: 'desktop',
        grants: ['core.chat.write'],
      });
      const archive = envelope('archive-equivalent', {
        type: 'chat.archive_tab',
        tabId: 'chat-a',
      });
      const requests: ChatCommandRequest[] = [
        envelope('create-a', { type: 'chat.create_tab', tabId: 'chat-a' }),
        envelope('create-b', { type: 'chat.create_tab', tabId: 'chat-b' }),
        envelope('fork-equivalent', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-b',
          targetTabId: 'fork-b',
        }),
        archive,
        { ...archive, commandId: 'archive-stale', expectedRevision: 0 },
        envelope('restore-equivalent', {
          type: 'chat.restore_archive',
          archiveEntryId: 'chat-a',
        }),
        envelope('close-equivalent', {
          type: 'chat.close_tab',
          tabId: 'chat-a',
          mode: 'archive',
        }),
        envelope('close-many-equivalent', {
          type: 'chat.close_tabs',
          targets: [
            { tabId: 'chat-b', mode: 'archive' },
            { tabId: 'fork-b', mode: 'archive' },
          ],
          replacementTabId: 'starter',
        }),
        archive,
      ];
      const outcomes: string[] = [];
      for (const request of requests) {
        if (request.commandId === 'fork-equivalent') {
          for (const fixture of [directFixture, routedFixture]) {
            await fixture.repository.transact(
              SCOPE,
              [
                {
                  type: 'message.upserted',
                  chatId: 'chat-b',
                  message: {
                    id: 'fork-source',
                    role: 'user',
                    timestamp: 1,
                    blocks: [{ type: 'text', text: 'Fork source' }],
                  },
                },
              ],
              { source: 'provider' },
            );
          }
        }
        const routedResult = await dispatchTrustedChatCommand(request, options);
        expect(routedResult).toEqual(await direct.command(request));
        outcomes.push(routedResult.outcome);
      }
      expect(outcomes).toEqual([
        'applied',
        'applied',
        'applied',
        'applied',
        'conflict',
        'applied',
        'applied',
        'applied',
        'already_applied',
      ]);
      expect(instruction.mock.calls.map(([name]) => name)).toEqual([
        'core.chat.create',
        'core.chat.create',
        'core.chat.fork',
        'core.chat.archive',
        'core.chat.archive',
        'core.chat.archive',
        'core.chat.delete',
        'core.chat.delete',
        'core.chat.archive',
      ]);
      for (const { commandId } of requests) {
        expect(await routed.getCommandReceipt({ ...SCOPE, commandId })).toEqual(
          await direct.getCommandReceipt({ ...SCOPE, commandId }),
        );
      }
      expect(await routed.getState(SCOPE)).toEqual(
        await direct.getState(SCOPE),
      );
    } finally {
      setChatStateCommandPort(null);
    }
  });

  it('compares migrated model selections using the canonical registry identity', () => {
    initModelAliases({ 'claude-sonnet-4-6': 'claude-sonnet-5' });
    const tab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-15',
      messages: [],
      model: 'claude-sonnet-4-6',
    };
    expect(
      inputRequestMatchesSettings(
        {
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'next',
          text: 'Next',
          model: 'claude-sonnet-5',
        },
        tab,
      ),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(
        {
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'next',
          text: 'Next',
          model: 'claude-opus-4-6',
        },
        tab,
      ),
    ).toBe(false);
  });

  it.each([undefined, 'proxy-A'])(
    'rehydrates a host queue payload after restart with pin %s',
    async (pin) => {
      const target = service();
      await createChat(target);
      const request = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'queued-user',
        text: 'Durable queued follow-up',
        providerType: 'claude' as const,
        model: 'claude-opus-4-6',
      };
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: 'chat-1' },
        ['queue-1'],
        true,
        undefined,
        [
          {
            id: 'queue-1',
            request,
            origin: 'desktop',
            enqueuedAtMs: 123,
            ...(pin !== undefined
              ? { requiredAccountProxyConnectionId: pin }
              : {}),
          },
        ],
      );
      const persisted = await target.getState(SCOPE);
      expect(persisted.runtimeByChatId['chat-1']?.queuedMessages).toEqual([
        expect.objectContaining({
          id: 'queue-1',
          request: expect.objectContaining({
            text: 'Durable queued follow-up',
          }),
          ...(pin !== undefined
            ? { requiredAccountProxyConnectionId: pin }
            : {}),
        }),
      ]);

      getChatQueueService().resetForTests();
      const hydratePersistedInput = jest.spyOn(
        getChatQueueService(),
        'hydratePersistedInput',
      );
      const restarted = serviceWithRepository(
        { inputSession: async () => undefined },
        copyDurableFilesAtBoundary(),
      ).target;
      Object.defineProperty(restarted, 'reconcileHostRuntime', { value: true });
      await restarted.getState(SCOPE);
      expect(hydratePersistedInput).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Durable queued follow-up' }),
        'queue-1',
        'desktop',
        123,
        undefined,
        pin,
      );
    },
  );

  it('preserves trusted sender provenance from a send through queue restart replay', async () => {
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Web MCP Agent',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };
    const { target } = serviceWithRepository();
    await createChat(target);

    await expect(
      target.command(
        envelope('trusted-send', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'trusted-user',
          text: 'Sent by an MCP agent',
          agentSent,
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const acceptedRequest = dispatched.at(-1);
    if (!acceptedRequest) throw new Error('Missing accepted send request');
    expect(acceptedRequest.agentSent).toEqual(agentSent);
    const admitted = (
      await target.getState(SCOPE)
    ).tabsFile.tabs[0]?.messages.find(
      (message) => message.id === 'trusted-user',
    );
    expect(admitted?.agentSent).toEqual(agentSent);

    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      ['trusted-queue-row'],
      true,
      undefined,
      [
        {
          id: 'trusted-queue-row',
          request: acceptedRequest,
          origin: 'desktop',
          enqueuedAtMs: 123,
        },
      ],
    );
    const queued = (await target.getState(SCOPE)).runtimeByChatId['chat-1']
      ?.queuedMessages?.[0]?.request;
    expect(queued?.agentSent).toEqual(agentSent);

    getChatQueueService().resetForTests();
    const hydratePersistedInput = jest.spyOn(
      getChatQueueService(),
      'hydratePersistedInput',
    );
    const restarted = serviceWithRepository(
      { inputSession: async () => undefined },
      copyDurableFilesAtBoundary(),
    ).target;
    Object.defineProperty(restarted, 'reconcileHostRuntime', { value: true });
    await restarted.getState(SCOPE);

    expect(hydratePersistedInput).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: 'trusted-user', agentSent }),
      'trusted-queue-row',
      'desktop',
      123,
      undefined,
      undefined,
    );
  });

  it('requires queued input to match the active session settings exactly', () => {
    const request = {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'next',
      text: 'Next',
      model: 'claude-sonnet-4-6',
      providerType: 'claude' as const,
    };
    const tab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-15',
      messages: [],
      model: 'claude-sonnet-4-6',
      providerType: 'claude' as const,
      planMode: false,
      proposalMode: 'optional' as const,
    };

    expect(inputRequestMatchesSettings(request, tab)).toBe(true);
    expect(
      inputRequestMatchesSettings(request, {
        ...tab,
        globalInstructionsSnapshot: '',
      }),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings({ ...request, approvalMode: 'ask' }, tab),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(
        { ...request, approvalMode: 'full-access' },
        tab,
      ),
    ).toBe(false);
    const sessionApprovalRules = [
      {
        id: 'rule-1',
        behavior: 'allow' as const,
        target: { kind: 'tool' as const, toolName: 'Bash' },
        createdAt: '2026-09-17T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    expect(
      inputRequestMatchesSettings(
        { ...request, sessionApprovalRules },
        { ...tab, sessionApprovalRules },
      ),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(
        { ...request, sessionApprovalRules },
        { ...tab, sessionApprovalRules: [] },
      ),
    ).toBe(false);
    expect(
      inputRequestMatchesSettings(
        {
          ...request,
          executionHarness: 'claude',
          thinkingLevel: 'high',
          modelConfig: { thinkingLevel: 'high', fastMode: false },
          codexFastModeEnabled: false,
        },
        tab,
      ),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(request, { ...tab, planMode: true }),
    ).toBe(false);
    expect(
      inputRequestMatchesSettings(
        { ...request, codexProposalMode: 'required' },
        tab,
      ),
    ).toBe(false);
    expect(
      inputRequestMatchesSettings(
        {
          ...request,
          aiCreditsRouting: {
            active: true,
            scope: 'session',
            activatedAt: 1,
          },
        },
        tab,
      ),
    ).toBe(false);
  });

  it('distinguishes queued Ultra fast input from a Regular session', () => {
    const request: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'next',
      text: 'Next',
      model: 'gpt-5.5',
      providerType: 'codex',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      },
    };
    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-30',
      messages: [],
      model: 'gpt-5.5',
      providerType: 'codex',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
    };

    // Ultra fast and Regular both project `fastMode: false`; only the exact
    // speed tells the queued input apart from the running session.
    expect(inputRequestMatchesSettings(request, tab)).toBe(false);
    expect(
      inputRequestMatchesSettings(request, {
        ...tab,
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      }),
    ).toBe(true);
    // Legacy boolean-only records compare through the same exact speed, and
    // a record without speed information means Regular.
    expect(
      inputRequestMatchesSettings(
        { ...request, modelConfig: { thinkingLevel: 'high', fastMode: true } },
        {
          ...tab,
          modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
        },
      ),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(
        { ...request, modelConfig: { thinkingLevel: 'high' } },
        { ...tab, modelConfig: { thinkingLevel: 'high' } },
      ),
    ).toBe(true);
    expect(
      inputRequestMatchesSettings(
        {
          ...request,
          modelConfig: { thinkingLevel: 'high' },
          codexFastModeEnabled: true,
        },
        { ...tab, modelConfig: { thinkingLevel: 'high' } },
      ),
    ).toBe(false);
  });

  it('preserves watcher display metadata in delivery views while omitting provider payloads', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    const watcherFired = { kind: 'Pipeline completion (Deploy)' };
    const ledger = {
      version: 1 as const,
      epoch: 0,
      rows: [
        {
          ...row,
          payload: {
            ...row.payload,
            watcherFired,
            hiddenContext: {
              kind: 'canopy-watcher-event' as const,
              text: 'Private instructions',
            },
          },
        },
      ],
    };
    const [view] = inputDeliveryViews(ledger);
    expect(view).toEqual(expect.objectContaining({ watcherFired }));
    expect(JSON.stringify(view)).not.toContain('Private instructions');
    expect(view).not.toHaveProperty('payload');
  });

  it('keeps malformed or ambiguous delivery ledgers inert', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    const ledger = { version: 1 as const, epoch: 0, rows: [row] };
    expect(isInputLedger(ledger)).toBe(true);
    const malformed: unknown[] = [
      { ...ledger, epoch: -1 },
      { ...ledger, rows: [row, row] },
      { ...ledger, rows: [{ ...row, revision: 0 }] },
      { ...ledger, rows: [{ ...row, createdAt: null }] },
      { ...ledger, rows: [{ ...row, currentAttemptId: 'not-recorded' }] },
      {
        ...ledger,
        rows: [{ ...row, attempts: [...row.attempts, ...row.attempts] }],
      },
      {
        ...ledger,
        rows: [
          {
            ...row,
            payload: { ...row.payload, attachmentPaths: 'not-an-array' },
          },
        ],
      },
      {
        ...ledger,
        rows: [{ ...row, payload: { ...row.payload, fileReferences: [null] } }],
      },
      {
        ...ledger,
        rows: [{ ...row, payload: { ...row.payload, inputMode: 'invalid' } }],
      },
    ];
    for (const value of malformed) {
      expect(isInputLedger(value)).toBe(false);
      expect(inputDeliveryViews(value)).toEqual([]);
    }
  });

  it.each(['claude', 'codex'] as const)(
    'matches an implicit native %s interface to an explicitly persisted native tab',
    (providerType) => {
      const tab: PersistedChatTab = {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-09-17',
        messages: [],
        providerType,
        interfaceMode: 'canopy',
      };
      const request: ChatSendMessageRequest = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'watcher',
        text: 'Event',
        providerType,
      };
      expect(inputRequestMatchesSettings(request, tab)).toBe(true);
      expect(
        inputRequestMatchesSettings(
          { ...request, interfaceMode: 'canopy' },
          { ...tab, interfaceMode: undefined },
        ),
      ).toBe(true);
      expect(
        inputRequestMatchesSettings(
          { ...request, interfaceMode: 'claude-code' },
          tab,
        ),
      ).toBe(false);
    },
  );

  async function deliveryFixture(
    content: Partial<
      Pick<
        ChatSendMessageRequest,
        | 'initiationSource'
        | 'attachmentPaths'
        | 'attachmentPromptContexts'
        | 'fileReferences'
        | 'pendingSystemInstructions'
        | 'watcherFired'
        | 'hiddenContext'
        | 'agentSent'
        | 'agentSenderProvenance'
      >
    > = {},
    overrides: Partial<ChatStateServiceOptions> = {},
  ) {
    const scope = { ...SCOPE, chatId: 'chat-1' };
    const submission = jest.fn<
      Promise<ChatInputAdmission>,
      [string, string, string]
    >((_text, attemptId) => Promise.resolve({ kind: 'accepted', attemptId }));
    const withdrawal = jest.fn<Promise<ChatInputWithdrawal>, [string]>(
      (attemptId) =>
        Promise.resolve({
          kind: 'withdrawn',
          attemptId,
          evidenceId: attemptId,
        }),
    );
    const session: AgentSession = {
      sendMessage: jest.fn(),
      cancel: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
      setPlanMode: jest.fn(async () => undefined),
      setApprovalMode: jest.fn(async () => undefined),
      setThinkingLevel: jest.fn(async () => undefined),
      setModel: jest.fn(async () => undefined),
      getSteeringCapabilities: () => ({
        provider: 'claude',
        generation: 'generation-1',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
      submitSteeringInput: submission,
      withdrawSteeringInput: withdrawal,
    };
    const { target, repository } = serviceWithRepository({
      inputSession: async () => session,
      ...overrides,
    });
    await createChat(target);
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: scope.chatId,
          runtime: {
            status: 'streaming',
            queuedMessageIds: ['queue-1'],
            activeTurn: { userMessageId: 'root-1', startedAt: 1 },
          },
        },
      ],
      { source: 'provider' },
    );
    const request = {
      ...scope,
      userMessageId: 'row-1',
      text: 'Original message',
      model: 'claude-opus-4-6',
      providerType: 'claude' as const,
      inputMode: 'voice' as const,
      ...content,
    };
    const getRow = async () => {
      const row = (await target.getState(scope)).tabsFile.tabs[0].inputDelivery
        ?.rows[0];
      if (!row) throw new Error('Missing test delivery row');
      return row;
    };
    const steer = async () =>
      target.inputDelivery.steerQueued(
        request,
        () => [],
        { commandId: 'steer-1', outcome: 'applied', entityId: 'chat-1' },
        jest.fn(),
      );
    const action = async (
      kind: ChatInputDeliveryAction,
      text?: string,
      id = `action-${kind}`,
    ) => {
      const row = await getRow();
      return target.command(
        envelope(id, {
          type: 'chat.input_delivery_action',
          chatId: scope.chatId,
          rowId: row.id,
          rowRevision: row.revision,
          action: kind,
          ...(text !== undefined ? { text } : {}),
        }),
      );
    };
    return {
      target,
      repository,
      scope,
      request,
      submission,
      withdrawal,
      session,
      getRow,
      steer,
      action,
    };
  }

  it.each(['pending', 'cancelled', 'unknown'] as const)(
    'deduplicates a watcher retry after %s steering admission',
    async (state) => {
      const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
      if (state === 'unknown')
        f.submission.mockImplementation(async (_text, attemptId) => ({
          kind: 'unknown',
          attemptId,
          reason: 'Transport unavailable',
        }));
      const deliver = () =>
        f.target.inputDelivery.steerWatcher(
          f.request,
          () => [],
          'desktop',
          true,
        );
      expect(await deliver()).toEqual({ status: 'handled', submitted: true });
      if (state === 'cancelled') await f.action('cancel');
      const row = await f.getRow();
      expect(await deliver()).toEqual({ status: 'handled' });
      expect(f.submission).toHaveBeenCalledTimes(1);
      expect(await f.getRow()).toEqual(row);
    },
  );

  it('falls back before admission when the watcher destination is idle or steering is unavailable', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    f.session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'generation-1',
      steer: false,
      withdraw: false,
      interrupt: false,
    });
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'fallback' });
    expect(f.submission).not.toHaveBeenCalled();
    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0].inputDelivery,
    ).toBeUndefined();
  });

  it('returns a durable queue handoff when a watcher steering attempt is definitively rejected', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    f.submission.mockImplementation(async (_text, attemptId) => ({
      kind: 'rejected',
      attemptId,
      reason: 'Turn ended',
    }));
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'requeue', rowId: f.request.userMessageId, epoch: 0 });
    expect((await f.getRow()).state).toBe('cancelled');
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('hands an ordinary watcher fallback back without restoring it inside the coordinator', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      // The active watcher submission holds this queue's recovery reservation.
      .mockRejectedValue(new Error('Another message operation is in progress'));
    f.submission.mockImplementation(async (_text, attemptId) => ({
      kind: 'rejected',
      attemptId,
      reason: 'The active turn no longer accepts steering',
      fallback: 'ordinary',
    }));

    try {
      expect(
        await f.target.inputDelivery.steerWatcher(
          f.request,
          () => [],
          'desktop',
          true,
        ),
      ).toEqual({
        status: 'requeue',
        rowId: f.request.userMessageId,
        epoch: 0,
      });
      const row = await f.getRow();
      expect(row.state).toBe('cancelled');
      expect(row.reason).toContain('Falling back to ordinary delivery.');
      expect(
        row.attempts.every((attempt) => attempt.uncertainAt === undefined),
      ).toBe(true);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
  });

  it('does not steer a watcher input superseded during the final authorization', async () => {
    let f: Awaited<ReturnType<typeof deliveryFixture>> | undefined;
    // The coordinator captures the ingress check when the service is built.
    const ingress = jest
      .spyOn(watcherIngress, 'checkWatcherDeliveryIngress')
      .mockImplementation(async () => {
        if (!f) throw new Error('Missing test fixture');
        const ledger = (await f.target.getState(f.scope)).tabsFile.tabs[0]
          .inputDelivery;
        if (!ledger) throw new Error('Missing test delivery ledger');
        // Stop commits a new epoch while authorization is still pending.
        await f.repository.transact(
          f.scope,
          [
            {
              type: 'tab.metadata_patched',
              tabId: f.scope.chatId,
              patch: { inputDelivery: { ...ledger, epoch: ledger.epoch + 1 } },
            },
          ],
          { source: 'provider' },
        );
        return { allowed: true };
      });
    try {
      f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
      await f.target.inputDelivery.steerWatcher(
        { ...f.request, watcherDeliveryId: 'superseded-steering' },
        () => [],
        'desktop',
        true,
      );
      expect(ingress).toHaveBeenCalledTimes(1);
      expect(f.submission).not.toHaveBeenCalled();
      expect((await f.getRow()).reason).toContain('superseded by Stop');
    } finally {
      ingress.mockRestore();
    }
  });

  it('holds a watcher input whose authority changes after its final authorization', async () => {
    let authorized = false;
    const ingress = jest
      .spyOn(watcherIngress, 'checkWatcherDeliveryIngress')
      .mockImplementation(async () => {
        authorized = true;
        return { allowed: true };
      });
    try {
      const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
      const getState = f.repository.getState.bind(f.repository);
      jest
        .spyOn(f.repository, 'getState')
        .mockImplementation(async (...args) => {
          // Access is disabled while the coordinator re-reads its snapshot.
          if (authorized) {
            authorized = false;
            noteWatcherDeliveryAuthorityChange();
          }
          return getState(...args);
        });
      const result = await f.target.inputDelivery.steerWatcher(
        { ...f.request, watcherDeliveryId: 'revoked-after-authorization' },
        () => [],
        'desktop',
        true,
      );
      expect(f.submission).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'requeue',
        rowId: f.request.userMessageId,
        epoch: 0,
      });
    } finally {
      ingress.mockRestore();
    }
  });

  it.each(['preparation', 'admission'] as const)(
    'holds watcher access revoked during steering %s and retries after access returns',
    async (boundary) => {
      let allowed = true;
      const ingress = jest
        .spyOn(watcherIngress, 'checkWatcherDeliveryIngress')
        .mockImplementation(async () =>
          allowed
            ? { allowed: true }
            : { allowed: false, outcome: 'held', reason: 'owner_boundary' },
        );
      const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
      const request = { ...f.request, watcherDeliveryId: 'revoked-steering' };
      let enter: (() => void) | undefined;
      let release: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (boundary === 'preparation') {
        jest
          .spyOn(activePlan, 'resolveActivePlanSystemInstruction')
          .mockImplementationOnce(async () => {
            enter?.();
            await gate;
            return null;
          });
      } else {
        const transact = f.repository.transactWith.bind(f.repository);
        jest
          .spyOn(f.repository, 'transactWith')
          .mockImplementation(async (...args) => {
            const commit = await transact(...args);
            if (
              args[2]?.mutationId === `watcher-steer-${request.userMessageId}`
            ) {
              enter?.();
              await gate;
            }
            return commit;
          });
      }
      const ordinaryDispatch = jest.fn(async () => undefined);
      const delays: number[] = [];
      const queue = new ChatQueueService({
        checkWatcherIngress: (payload) =>
          watcherIngress.checkWatcherDeliveryIngress(payload),
        steerWatcher: (payload, origin, ids, allow) =>
          f.target.inputDelivery.steerWatcher(payload, ids, origin, allow),
        dispatch: ordinaryDispatch,
        cancel: async () => undefined,
        settleCancelledTurn: async () => undefined,
        hasActiveProviderTurn: () => false,
        hasPendingProviderContinuation: () => false,
        persistRuntime: (...args) => f.target.reconcileHostQueue(...args),
        broadcast: () => undefined,
        createId: () => 'held-queue-row',
        now: () => 1,
        schedule: (callback, delay) => {
          delays.push(delay);
          return setTimeout(callback, delay);
        },
      });
      mockedGetChatQueueService.mockReturnValue(queue);
      try {
        const submitting = queue.submit(request, 'desktop');
        await entered;
        allowed = false;
        release?.();
        await submitting;
        expect(f.submission).not.toHaveBeenCalled();
        expect(ordinaryDispatch).not.toHaveBeenCalled();
        expect((await f.getRow()).state).toBe('queued');
        expect(delays).toContain(5000);
        allowed = true;
        queue.retryHeldWatcherDeliveries();
        await new Promise<void>((resolve) => {
          ordinaryDispatch.mockImplementationOnce(async () => {
            resolve();
          });
        });
        expect(ordinaryDispatch).toHaveBeenCalledTimes(1);
        expect(f.submission).not.toHaveBeenCalled();
      } finally {
        release?.();
        queue.resetForTests();
        ingress.mockRestore();
      }
    },
  );

  it('restores and dispatches a refused watcher once through the reserved real queue', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    const mutations: ChatQueuePersistenceMutation[] = [];
    const ordinaryDispatches: Array<{
      request: ChatSendMessageRequest;
      origin: 'desktop' | 'portal';
      fromQueue: boolean;
    }> = [];
    let queueId = 0;
    const dependencies: ChatQueueServiceDependencies = {
      steerWatcher: (request, origin, queuedIds, allowSteering) =>
        f.target.inputDelivery.steerWatcher(
          request,
          queuedIds,
          origin,
          allowSteering,
        ),
      dispatch: async (request, origin, fromQueue) => {
        ordinaryDispatches.push({ request, origin, fromQueue });
      },
      cancel: async () => undefined,
      settleCancelledTurn: async () => undefined,
      hasActiveProviderTurn: () => false,
      drainProviderEvents: async () => undefined,
      hasPendingProviderContinuation: () => false,
      persistRuntime: async (
        target,
        queuedMessageIds,
        turnActive,
        mutation,
        queuedMessages,
        activeTurnUserMessageId,
      ) => {
        if (mutation) mutations.push(mutation);
        await f.target.reconcileHostQueue(
          target,
          queuedMessageIds,
          turnActive,
          mutation,
          queuedMessages,
          activeTurnUserMessageId,
        );
      },
      broadcast: () => undefined,
      createId: () => `queue-${++queueId}`,
      now: () => 1,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    };
    const queue = new ChatQueueService(dependencies);
    mockedGetChatQueueService.mockReturnValue(queue);
    f.submission.mockImplementation(async (_text, attemptId) => ({
      kind: 'rejected',
      attemptId,
      reason: 'The active turn no longer accepts steering',
      fallback: 'ordinary',
    }));

    await queue.submit(f.request, 'desktop');

    const row = await f.getRow();
    expect(row.state).toBe('queued');
    expect(
      row.attempts.every((attempt) => attempt.uncertainAt === undefined),
    ).toBe(true);
    expect(
      mutations.filter((mutation) => mutation.type === 'restore-input'),
    ).toEqual([
      expect.objectContaining({
        type: 'restore-input',
        rowId: f.request.userMessageId,
      }),
    ]);
    expect(ordinaryDispatches).toEqual([
      { request: f.request, origin: 'desktop', fromQueue: true },
    ]);

    await queue.submit(f.request, 'desktop');

    expect(ordinaryDispatches).toHaveLength(1);
  });

  it('propagates a typed refused-steer restoration failure without making the attempt uncertain', async () => {
    const f = await deliveryFixture();
    const restoreError = new Error('Another message operation is in progress');
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockRejectedValue(restoreError);
    f.submission.mockImplementation(async (_text, attemptId) => ({
      kind: 'rejected',
      attemptId,
      reason: 'The active turn no longer accepts steering',
      fallback: 'ordinary',
    }));

    try {
      await expect(f.steer()).rejects.toThrow(
        'Another message operation is in progress',
      );
      const row = await f.getRow();
      expect(row.state).toBe('cancelled');
      expect(row.reason).toContain('Falling back to ordinary delivery.');
      expect(
        row.attempts.every((attempt) => attempt.uncertainAt === undefined),
      ).toBe(true);
    } finally {
      restore.mockRestore();
    }
  });

  it('surfaces a failed watcher refusal settlement without recording an uncertain attempt', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    const settlementError = new Error(
      'Failed to persist the refused watcher settlement',
    );
    let failNextTransaction = false;
    const transactWith = f.repository.transactWith.bind(f.repository);
    const transaction = jest
      .spyOn(f.repository, 'transactWith')
      .mockImplementation(async (...args) => {
        if (failNextTransaction) {
          failNextTransaction = false;
          throw settlementError;
        }
        return transactWith(...args);
      });
    f.submission.mockImplementation(async (_text, attemptId) => {
      failNextTransaction = true;
      return {
        kind: 'rejected',
        attemptId,
        reason: 'The active turn no longer accepts steering',
        fallback: 'ordinary',
      };
    });

    try {
      await expect(
        f.target.inputDelivery.steerWatcher(
          f.request,
          () => [],
          'desktop',
          true,
        ),
      ).rejects.toThrow('Failed to persist the refused watcher settlement');
      const row = await f.getRow();
      expect(
        row.attempts.every((attempt) => attempt.uncertainAt === undefined),
      ).toBe(true);
    } finally {
      transaction.mockRestore();
    }
  });

  it('never falls back to a full watcher turn after ambiguous provider I/O', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    f.submission.mockRejectedValue(new Error('Transport closed after write'));
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'handled', submitted: true });
    expect((await f.getRow()).state).toBe('uncertain');
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'handled' });
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('does not requeue a rejected watcher when Stop supersedes its handoff', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    f.submission.mockImplementation(async (_text, attemptId) => {
      await f.target.inputDelivery.stop(f.scope, async () => undefined);
      return { kind: 'rejected', attemptId, reason: 'Stopped' };
    });
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'handled' });
    expect((await f.getRow()).state).toBe('cancelled');
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('falls back when the turn ends before watcher admission without recording a delivery attempt', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    let reads = 0;
    f.session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'generation-1',
      steer: ++reads === 1,
      withdraw: true,
      interrupt: true,
    });
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'fallback' });
    expect(f.submission).not.toHaveBeenCalled();
    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0].inputDelivery,
    ).toBeUndefined();
  });

  it('requeues a never-sent watcher if the turn ends after the durable claim', async () => {
    const f = await deliveryFixture({ watcherFired: { kind: 'Wakeup' } });
    let reads = 0;
    f.session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'generation-1',
      steer: ++reads <= 2,
      withdraw: true,
      interrupt: true,
    });
    expect(
      await f.target.inputDelivery.steerWatcher(
        f.request,
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'requeue', rowId: f.request.userMessageId, epoch: 0 });
    expect(f.submission).not.toHaveBeenCalled();
    expect((await f.getRow()).state).toBe('cancelled');
  });

  it('counts an input delivery event that commits as an applied provider event', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    resetWorkCounters();

    await expect(
      f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId: row.currentAttemptId,
          phase: 'picked-up',
        },
      }),
    ).resolves.toBe(true);
    // A malformed delivery event is ingested but never applied.
    await expect(
      f.target.ingestProviderEvent({
        ...f.scope,
        data: { type: 'canopy_input_delivery', provider: 'claude' },
      }),
    ).resolves.toBe(false);

    expect(snapshotWorkCounters().provider).toEqual({
      eventsIngested: 2,
      eventsApplied: 1,
    });
  });

  it('persists the steering actor separately from the original agent payload', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const actorCheck = jest
      .spyOn(senderContext, 'revalidateAgentSteeringActor')
      .mockResolvedValue(undefined);
    const sender: ChatAgentSentInfo['sender'] = {
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 'source-task',
      chatId: 'source-chat',
    };
    const actor: typeof sender = { ...sender, chatId: 'steering-chat' };
    const f = await deliveryFixture({
      agentSent: {
        sender,
        chatTitle: 'Original sender',
        projectLabel: 'App Advisor',
      },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'none' },
        capturedAt: '2026-10-16T00:00:00.000Z',
        acceptedInputId: 'row-1',
      },
      hiddenContext: { kind: 'agent-sender-context', text: 'Original context' },
    });
    const steering = jest
      .spyOn(getChatQueueService(), 'steer')
      .mockImplementation(async (_target, _entryId, receipt) => {
        await f.target.inputDelivery.steerQueued(
          f.request,
          () => [],
          receipt,
          jest.fn(),
        );
        return 'applied';
      });
    try {
      await expect(
        f.target.command(
          envelope('agent-steer', {
            type: 'chat.steer_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'queue-1',
            agentSteeringActor: actor,
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      // Reload from the durable store, not only the live coordinator view.
      const restarted = service();
      expect(
        await restarted.getCommandReceipt({
          ...SCOPE,
          commandId: 'agent-steer',
        }),
      ).toMatchObject({ outcome: 'applied', agentSteeringActor: actor });
      const row = (await restarted.getState(f.scope)).tabsFile.tabs[0]
        .inputDelivery?.rows[0];
      expect(row?.payload).toEqual(f.request);
      expect(row?.payload.agentSent).toEqual(f.request.agentSent);
      expect(row?.payload.agentSenderProvenance).toEqual(
        f.request.agentSenderProvenance,
      );
      expect(row?.payload).not.toHaveProperty('agentSteeringActor');
    } finally {
      steering.mockRestore();
      validation.mockRestore();
      actorCheck.mockRestore();
    }
  });

  it('rechecks the steering agent at provider handoff, submits nothing and reports the refusal', async () => {
    const actor = jest
      .spyOn(senderContext, 'revalidateAgentSteeringActor')
      .mockRejectedValue(
        new senderContext.AgentSenderContextError(
          'not_found',
          'The target chat is not available.',
        ),
      );
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockResolvedValue(undefined);
    try {
      const f = await deliveryFixture();
      const steeringActor = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'advisor-task',
        chatId: 'advisor-chat',
      };
      await expect(
        f.target.inputDelivery.steerQueued(
          f.request,
          () => [],
          {
            commandId: 'steer-1',
            outcome: 'applied',
            entityId: 'chat-1',
            agentSteeringActor: steeringActor,
          },
          jest.fn(),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(actor).toHaveBeenCalledWith(steeringActor, f.scope.projectId);
      expect(f.submission).not.toHaveBeenCalled();
      // The input goes back to the queue as ordinary input.
      expect(restore).toHaveBeenCalledTimes(1);
      expect(await f.getRow()).toMatchObject({ state: 'cancelled' });
    } finally {
      restore.mockRestore();
      actor.mockRestore();
    }
  });

  it('materializes steering pickup as agent, preserving captured attribution and one hidden instruction', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const agentSent = {
        sender,
        chatTitle: 'Captured title',
        projectLabel: 'App Advisor',
      };
      const hiddenContext = {
        kind: 'agent-sender-context' as const,
        text: '<system_instruction>Trusted sender</system_instruction>',
      };
      const f = await deliveryFixture({
        agentSent,
        hiddenContext,
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'row-1',
        },
      });
      await f.steer();
      const row = await f.getRow();
      expect(
        f.submission.mock.calls[0][0].split(hiddenContext.text),
      ).toHaveLength(2);
      for (let repeat = 0; repeat < 2; repeat++)
        await f.target.ingestProviderEvent({
          ...f.scope,
          data: {
            type: 'canopy_input_delivery',
            provider: 'claude',
            generation: 'generation-1',
            attemptId: row.currentAttemptId,
            phase: 'picked-up',
          },
        });
      const messages = (
        await f.target.getState(f.scope)
      ).tabsFile.tabs[0].messages.filter((message) => message.id === row.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        userMessageSource: 'agent',
        agentSent,
      });
      expect(JSON.stringify(messages)).not.toContain(hiddenContext.text);
    } finally {
      validation.mockRestore();
    }
  });

  it('names the external agent that sent a steered message', async () => {
    const f = await deliveryFixture({
      agentSent: {
        kind: 'external_agent',
        connectionId: '123e4567-e89b-42d3-a456-426614174000',
        clientName: 'Claude Desktop',
        verified: true,
        userId: '123e4567-e89b-42d3-a456-426614174001',
      },
    });
    await f.steer();
    expect(f.submission.mock.calls[0][0]).toContain(
      'sent by an external agent, "Claude Desktop" (connection ID 123e4567-e89b-42d3-a456-426614174000)',
    );
  });

  it('preserves watcher attribution and hidden context through steering pickup', async () => {
    const watcherFired = { kind: 'Command completed' };
    const hiddenContext = {
      kind: 'canopy-watcher-event' as const,
      text: '<system_instruction>Trusted event context</system_instruction>',
    };
    const f = await deliveryFixture({ watcherFired, hiddenContext });
    await f.steer();
    const row = await f.getRow();
    expect(f.submission.mock.calls[0][0]).toContain(hiddenContext.text);
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
      },
    });
    const message = (
      await f.target.getState(f.scope)
    ).tabsFile.tabs[0].messages.find((message) => message.id === row.id);
    expect(message?.watcherFired).toEqual(watcherFired);
    expect(message?.blocks).toContainEqual(
      expect.objectContaining({
        type: 'text',
        steering: expect.objectContaining({ startsTurn: false }),
      }),
    );
    expect(JSON.stringify(message)).not.toContain(hiddenContext.text);
  });

  it('journals steering before handoff and reconciles pickup before admission without resetting the root', async () => {
    const f = await deliveryFixture();
    f.submission.mockImplementation(async (text, attemptId) => {
      expect(text).toContain('transcribed from speech');
      expect((await f.getRow()).state).toBe('sending');
      const storage = ChatStorageV2.fromLegacyPaths(paths);
      // Durable state may be in the checkpoint or in a newer journal record.
      expect(
        readFileSync(join(storage.directory, 'live-index.json'), 'utf8') +
          readFileSync(join(storage.directory, 'delta-journal.log'), 'utf8'),
      ).toContain(attemptId);
      await f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId,
          phase: 'picked-up',
        },
      });
      return { kind: 'accepted', attemptId };
    });
    await f.steer();
    const snapshot = await f.target.getState(f.scope);
    expect((await f.getRow()).state).toBe('picked-up');
    expect(snapshot.runtimeByChatId['chat-1'].activeTurn?.userMessageId).toBe(
      'root-1',
    );
    expect(
      snapshot.tabsFile.tabs[0].messages.filter((m) => m.id === 'row-1'),
    ).toHaveLength(1);
    expect(snapshot.tabsFile.tabs[0].messages[0].blocks).toContainEqual(
      expect.objectContaining({
        type: 'text',
        steering: { startsTurn: false, rootUserMessageId: 'root-1' },
      }),
    );
    expect(snapshot.runtimeByChatId['chat-1'].queuedMessageIds).toEqual([]);
  });

  it.each(['user', 'portal', 'automation', 'hook'] as const)(
    'keeps trusted %s provenance when steering bypasses ordinary dispatch',
    async (source) => {
      const f = await deliveryFixture({ initiationSource: source });
      const origin = {
        projectId: f.scope.projectId,
        worktreeId: f.scope.worktreeId,
        chatTabId: f.scope.chatId,
      };
      const key = presentationChatKey(origin);
      browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
      recordPresentationTurn(key, 'root-1', 'user');
      const handoff = browserHandoffs.request(
        {
          projectId: origin.projectId,
          worktreeId: origin.worktreeId,
          browserId: 'browser',
          origin,
        },
        jest.fn(),
      );
      try {
        await f.steer();
        expect(
          browserHandoffs.snapshot(origin.projectId, origin.worktreeId)
            .handoff === null,
        ).toBe(source === 'user' || source === 'portal');
        if (source === 'automation' || source === 'hook') {
          expect(capturePresentationTurn(origin)).toEqual({
            turnId: 'root-1',
            source,
          });
          expect(
            browserHandoffs.snapshot(origin.projectId, origin.worktreeId)
              .handoff?.handoffId,
          ).toBe(handoff.handoffId);
        }
        const row = await f.getRow();
        await f.target.ingestProviderEvent({
          ...f.scope,
          data: {
            type: 'canopy_input_delivery',
            provider: 'claude',
            generation: 'generation-1',
            attemptId: row.currentAttemptId,
            phase: 'picked-up',
            startsTurn: true,
            userMessageId: row.id,
          },
        });
        expect(capturePresentationTurn(origin)).toEqual({
          turnId: row.id,
          source,
        });
      } finally {
        browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
        forgetPresentationChat(key);
      }
    },
  );

  it.each([false, true])(
    'fences delayed pickup release after uncertain steering (replacement=%s)',
    async (replace) => {
      const f = await deliveryFixture({ initiationSource: 'user' });
      const origin = {
        projectId: f.scope.projectId,
        worktreeId: f.scope.worktreeId,
        chatTabId: f.scope.chatId,
      };
      browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
      browserHandoffs.request(
        {
          projectId: origin.projectId,
          worktreeId: origin.worktreeId,
          browserId: 'original',
          origin,
        },
        jest.fn(),
      );
      try {
        f.submission.mockRejectedValueOnce(new Error('receipt lost'));
        await f.steer();
        if (replace)
          browserHandoffs.request(
            {
              projectId: origin.projectId,
              worktreeId: origin.worktreeId,
              browserId: 'replacement',
              origin,
            },
            jest.fn(),
          );
        const row = await f.getRow();
        await f.target.ingestProviderEvent({
          ...f.scope,
          data: {
            type: 'canopy_input_delivery',
            provider: 'claude',
            generation: 'generation-1',
            attemptId: row.currentAttemptId,
            phase: 'picked-up',
            userMessageId: row.id,
          },
        });
        expect(
          browserHandoffs.snapshot(origin.projectId, origin.worktreeId).handoff
            ?.browserId,
        ).toBe(replace ? 'replacement' : undefined);
      } finally {
        browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
        forgetPresentationChat(presentationChatKey(origin));
      }
    },
  );

  it('preserves durable queued payloads when an autonomous pickup starts a turn', async () => {
    const f = await deliveryFixture();
    const queuedMessage = {
      id: 'queue-1',
      request: {
        ...f.scope,
        userMessageId: 'queued-user',
        text: 'Keep this queued through restart',
        providerType: 'claude' as const,
        model: 'claude-opus-4-6',
      },
      origin: 'desktop' as const,
      enqueuedAtMs: 123,
    };
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'runtime.patched',
          chatId: f.scope.chatId,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [queuedMessage.id],
            queuedMessages: [queuedMessage],
            activeTurn: { userMessageId: 'root-1', startedAt: 1 },
          },
        },
      ],
      { source: 'provider' },
    );
    await f.steer();
    const row = await f.getRow();

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: row.id,
      },
    });

    expect(
      (await f.target.getState(f.scope)).runtimeByChatId[f.scope.chatId]
        .queuedMessages,
    ).toEqual([queuedMessage]);
  });

  // The turn that a pickup starts is owned and settled only when canonical
  // state applies the pickup, which takes a recorded delivery attempt. A
  // delegate's message to its root chat is therefore steered through here,
  // never handed straight to the provider session.
  it('applies the turn-start pickup of a recorded delegate message, not of an unrecorded steer', async () => {
    const f = await deliveryFixture();
    const pickup = (attemptId: string, userMessageId: string) =>
      f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId,
          phase: 'picked-up',
          startsTurn: true,
          userMessageId,
        },
      });
    expect(await pickup('unrecorded-attempt', 'unrecorded-attempt')).toBe(
      false,
    );

    expect(
      await f.target.inputDelivery.steerWatcher(
        {
          ...f.request,
          userMessageId: 'upward-1',
          text: '<system_instruction>Subordinate request</system_instruction>',
          initiationSource: 'automation',
          managedDelegationDeliveryId: 'upward-1',
        },
        () => [],
        'desktop',
        true,
      ),
    ).toEqual({ status: 'handled', submitted: true });
    const row = await f.getRow();
    expect(row.id).toBe('upward-1');
    if (!row.currentAttemptId) throw new Error('Missing delivery attempt');

    expect(await pickup(row.currentAttemptId, row.id)).toBe(true);
    const state = await f.target.getState(f.scope);
    expect(state.runtimeByChatId[f.scope.chatId].activeTurn).toMatchObject({
      userMessageId: 'upward-1',
    });
    // Like a delegate message dispatched as an ordinary queued turn, it is
    // hidden behind an automation start banner and never listed as a pending
    // delivery.
    const messages = state.tabsFile.tabs[0].messages;
    expect(
      messages
        .filter((message) => message.id.startsWith('upward-1'))
        .map(({ id, hidden }) => ({ id, hidden })),
    ).toEqual([
      { id: 'upward-1-automation-info', hidden: undefined },
      { id: 'upward-1', hidden: true },
      { id: 'upward-1:timer', hidden: undefined },
    ]);
    expect(inputDeliveryViews(state.tabsFile.tabs[0].inputDelivery)).toEqual(
      [],
    );
  });

  // A steer admitted while a turn was running can be picked up after that turn
  // already settled; the provider then starts it as a brand new turn. The
  // transcript must read as one — its own turn group, with the timer trailing
  // the answer — not as steering text dropped into the finished turn.
  it('renders an autonomous pickup as its own turn group with a trailing timer', async () => {
    const f = await deliveryFixture();
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'message.upserted',
          chatId: f.scope.chatId,
          message: {
            id: 'root-1',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Start the root turn' }],
          },
        },
        {
          type: 'message.upserted',
          chatId: f.scope.chatId,
          message: {
            id: 'root-1:timer',
            role: 'system',
            timestamp: 1,
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
          },
        },
        {
          type: 'message.upserted',
          chatId: f.scope.chatId,
          message: {
            id: 'root-answer',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Root answer' }],
          },
        },
      ],
      { source: 'provider' },
    );
    await f.steer();
    const row = await f.getRow();

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: row.id,
      },
    });
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'message.upserted',
          chatId: f.scope.chatId,
          message: {
            id: 'steer-answer',
            role: 'assistant',
            timestamp: 4,
            blocks: [{ type: 'text', text: 'Answer to the picked-up turn' }],
          },
        },
      ],
      { source: 'provider' },
    );

    const messages = (await f.target.getState(f.scope)).tabsFile.tabs[0]
      .messages;
    // Every other turn-timer producer writes a `system` message, and both
    // display predicates (`reorderMessagesForDisplay`, `groupIntoTurns`)
    // require that role before they recognize a timer at all.
    expect(
      messages.find((message) => message.id === `${row.id}:timer`),
    ).toMatchObject({ role: 'system' });
    const groups = groupIntoTurns(
      mergeToolResults(reorderMessagesForDisplay(messages)),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: 'turn-group',
      userMessage: { id: 'root-1' },
      timerMessage: { id: 'root-1:timer' },
    });
    expect(groups[1]).toMatchObject({
      kind: 'turn-group',
      userMessage: { id: row.id },
      assistantMessages: [{ id: 'steer-answer' }],
      timerMessage: { id: `${row.id}:timer` },
      isComplete: false,
    });
  });

  it('keeps a newer active turn when autonomous pickup root arbitration rejects the pickup', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: row.id,
        turnRootAccepted: false,
      },
    });
    const snapshot = await f.target.getState(f.scope);
    expect(snapshot.runtimeByChatId[f.scope.chatId].activeTurn).toEqual({
      userMessageId: 'root-1',
      startedAt: 1,
    });
    expect(
      snapshot.tabsFile.tabs[0].messages.find(
        (message) => message.id === `${row.id}:timer`,
      ),
    ).toBeUndefined();
    expect(
      snapshot.tabsFile.tabs[0].messages.find(
        (message) => message.id === row.id,
      ),
    ).toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          steering: expect.objectContaining({ startsTurn: false }),
        }),
      ]),
    });
    expect(
      snapshot.tabsFile.tabs[0].inputDelivery?.rows[0].attempts[0]
        .rootUserMessageId,
    ).toBe('root-1');
  });

  it('does not revive a turn when Stop supersedes pickup root arbitration', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    let releaseLookup = (): void => undefined;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted = (): void => undefined;
    const lookupReady = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let lookups = 0;
    const originalSession = f.session;
    const delayed = serviceWithRepository({
      inputSession: async () => {
        lookups += 1;
        if (lookups === 1) {
          lookupStarted();
          await lookupBlocked;
        }
        return originalSession;
      },
    }).target;
    if (!row.currentAttemptId) throw new Error('Missing test attempt');

    const observing = delayed.inputDelivery.observe(f.scope, {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'generation-1',
      attemptId: row.currentAttemptId,
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: row.id,
      turnRootAccepted: true,
    });
    await lookupReady;
    await delayed.inputDelivery.stop(f.scope, async () => undefined);
    releaseLookup();
    await observing;

    const snapshot = await delayed.getState(f.scope);
    expect(snapshot.runtimeByChatId[f.scope.chatId].activeTurn).not.toEqual(
      expect.objectContaining({ userMessageId: row.id }),
    );
    expect(
      snapshot.tabsFile.tabs[0].messages.find(
        (message) => message.id === `${row.id}:timer`,
      ),
    ).toBeUndefined();
  });

  it('timestamps materialized steering history at pickup time', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    const pickedUpAt = row.createdAt + 1_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(pickedUpAt);
    try {
      await f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId: row.currentAttemptId,
          phase: 'picked-up',
        },
      });
    } finally {
      now.mockRestore();
    }

    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0].messages.find(
        (message) => message.id === row.id,
      )?.timestamp,
    ).toBe(pickedUpAt);
  });

  it('refuses steering when the stored session model is blocked', async () => {
    const f = await deliveryFixture();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    await expect(f.steer()).rejects.toThrow(
      'This model is blocked by your organization policy.',
    );
    expect(f.submission).not.toHaveBeenCalled();
  });

  it('retains image, file context and voice input through Pending edit and pickup', async () => {
    jest
      .spyOn(agentAttachments, 'resolveAgentAttachmentsDir')
      .mockReturnValue(tempDir);
    const imagePath = join(tempDir, 'diagram with spaces.png');
    const filePath = join(tempDir, 'review notes.csv');
    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    writeFileSync(filePath, 'item,status\nsteering,review\n');
    const content = {
      attachmentPaths: [imagePath, filePath],
      attachmentPromptContexts: [
        {
          attachmentPath: imagePath,
          promptKind: 'in-app-browser-resource' as const,
        },
      ],
      fileReferences: [
        { absolutePath: filePath, displayPath: 'review notes.csv' },
      ],
    };
    const f = await deliveryFixture(content);
    await f.steer();
    await f.action('edit');
    await f.action('save', 'Review both attachments');
    for (const [text] of f.submission.mock.calls) {
      expect(text).toContain('transcribed from speech');
      expect(text).toContain('diagram with spaces.png');
      expect(text).toContain('review notes.csv');
    }
    const row = await f.getRow();
    expect(row.payload).toMatchObject({
      ...content,
      inputMode: 'voice',
      text: 'Review both attachments',
    });
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
      },
    });
    const state = await f.target.getState(f.scope);
    expect(
      state.tabsFile.tabs[0].messages.find((message) => message.id === row.id),
    ).toMatchObject({
      attachmentPaths: content.attachmentPaths,
      attachmentPromptContexts: content.attachmentPromptContexts,
      inputMode: 'voice',
      blocks: expect.arrayContaining([
        { type: 'file_references', references: content.fileReferences },
      ]),
    });
  });

  it('associates an edited resend with the current root turn', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('edit');
    await f.action('save', 'Edited steering');
    const row = await f.getRow();
    expect(row.attempts[row.attempts.length - 1]).toMatchObject({
      rootUserMessageId: 'root-1',
    });
  });

  it('consumes only the pending instructions actually picked up by steering', async () => {
    const sentInstruction = { id: 'sent', text: 'Use the retained context' };
    const retainedInstruction = {
      id: 'later',
      text: 'Keep for the next input',
    };
    const f = await deliveryFixture({
      pendingSystemInstructions: [sentInstruction],
    });
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: f.scope.chatId,
          patch: {
            pendingSystemInstructions: [sentInstruction, retainedInstruction],
          },
        },
      ],
      { source: 'provider' },
    );
    await f.steer();
    expect(f.submission.mock.calls[0][0]).toContain(sentInstruction.text);
    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0]
        .pendingSystemInstructions,
    ).toHaveLength(2);
    const row = await f.getRow();
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
      },
    });
    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0]
        .pendingSystemInstructions,
    ).toEqual([retainedInstruction]);
  });

  it('retains the editor and draft if an attachment disappears before resend', async () => {
    jest
      .spyOn(agentAttachments, 'resolveAgentAttachmentsDir')
      .mockReturnValue(tempDir);
    const attachmentPath = join(tempDir, 'notes.txt');
    writeFileSync(attachmentPath, 'Review notes');
    const f = await deliveryFixture({ attachmentPaths: [attachmentPath] });
    await f.steer();
    await f.action('edit');
    await f.action('save-draft', 'Retain this draft');
    rmSync(attachmentPath);
    await expect(f.action('save', 'Retain this draft')).rejects.toThrow();
    expect(await f.getRow()).toMatchObject({
      state: 'editing',
      draft: 'Retain this draft',
    });
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('retains a cancelled row if an attachment disappears before queue recovery', async () => {
    jest
      .spyOn(agentAttachments, 'resolveAgentAttachmentsDir')
      .mockReturnValue(tempDir);
    const attachmentPath = join(tempDir, 'queue-notes.txt');
    writeFileSync(attachmentPath, 'Queue notes');
    const f = await deliveryFixture({ attachmentPaths: [attachmentPath] });
    await f.steer();
    await f.action('cancel');
    rmSync(attachmentPath);
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockResolvedValue(undefined);

    await expect(f.action('queue')).rejects.toThrow();

    expect(restore).not.toHaveBeenCalled();
    expect(await f.getRow()).toMatchObject({ state: 'cancelled' });
    restore.mockRestore();
  });

  it.each(['save', 'resend-original'] as const)(
    'withdraws Pending before editing and uses a fresh attempt for %s',
    async (finish) => {
      const f = await deliveryFixture();
      await f.steer();
      const first = (await f.getRow()).currentAttemptId;
      expect((await f.action('edit')).outcome).toBe('applied');
      expect((await f.getRow()).state).toBe('editing');
      expect(f.submission).toHaveBeenCalledTimes(1);
      expect((await f.action(finish, 'Edited message')).outcome).toBe(
        'applied',
      );
      expect(f.submission).toHaveBeenCalledTimes(2);
      expect(f.submission.mock.calls[1][0]).toContain(
        finish === 'save' ? 'Edited message' : 'Original message',
      );
      expect((await f.getRow()).currentAttemptId).not.toBe(first);
      expect((await f.getRow()).attempts[0].withdrawnAt).toBeDefined();
    },
  );

  it('keeps Cancelled edits and closed Pending drafts inert across hydration', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('cancel');
    await f.action('edit');
    await f.action('save', 'Saved without sending');
    expect((await f.getRow()).state).toBe('cancelled');
    expect((await f.getRow()).text).toBe('Saved without sending');
    expect(f.submission).toHaveBeenCalledTimes(1);
    await f.repository.flushScope(f.scope);
    expect(
      readFileSync(
        join(ChatStorageV2.fromLegacyPaths(paths).directory, 'live-index.json'),
        'utf8',
      ),
    ).toContain('Saved without sending');
  });

  it('keeps delivery uncertain after transport loss and never makes it editable or queueable', async () => {
    const f = await deliveryFixture();
    f.submission.mockRejectedValue(new Error('connection lost after write'));
    await f.steer();
    expect((await f.getRow()).state).toBe('uncertain');
    await expect(f.action('edit')).rejects.toThrow('unavailable');
    await expect(f.action('queue')).rejects.toThrow('unavailable');
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  it('dismisses uncertain watcher notices durably while retaining deduplication and late evidence', async () => {
    const sessionLookup = jest.fn<Promise<AgentSession | undefined>, []>();
    const f = await deliveryFixture(
      {
        watcherFired: { kind: 'Delegate completion' },
      },
      { inputSession: sessionLookup },
    );
    sessionLookup.mockResolvedValue(f.session);
    f.submission.mockRejectedValue(new Error('connection lost after write'));
    const deliver = () =>
      f.target.inputDelivery.steerWatcher(f.request, () => [], 'desktop', true);
    await deliver();
    const before = await f.getRow();
    sessionLookup.mockClear();
    sessionLookup.mockRejectedValue(new Error('Provider lookup unavailable'));
    const dismiss = envelope('dismiss-watcher', {
      type: 'chat.input_delivery_action',
      chatId: f.scope.chatId,
      rowId: before.id,
      rowRevision: before.revision,
      action: 'dismiss',
    });
    expect((await f.target.command(dismiss)).outcome).toBe('applied');
    const dismissed = await f.getRow();
    expect(dismissed).toMatchObject({
      state: 'uncertain',
      dismissedAt: expect.any(Number),
      attempts: before.attempts,
      payload: before.payload,
    });
    expect(
      inputDeliveryViews(
        (await f.target.getState(f.scope)).tabsFile.tabs[0].inputDelivery,
      ),
    ).toEqual([]);
    await f.target.command(dismiss);
    expect(await f.getRow()).toEqual(dismissed);
    await deliver();
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect(f.withdrawal).not.toHaveBeenCalled();
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    await expect(f.action('queue')).rejects.toThrow('unavailable');
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: before.currentAttemptId,
        phase: 'picked-up',
      },
    });
    const late = await f.getRow();
    expect(late.dismissedAt).toBe(dismissed.dismissedAt);
    expect(late.attempts[0].pickedUpAt).toEqual(expect.any(Number));
    await f.repository.drainAll();
    const restarted = serviceWithRepository({
      inputSession: async () => undefined,
    }).target;
    await restarted.inputDelivery.recover(f.scope);
    const ledger = (await restarted.getState(f.scope)).tabsFile.tabs[0]
      .inputDelivery;
    expect(ledger?.rows[0].dismissedAt).toBe(dismissed.dismissedAt);
    expect(inputDeliveryViews(ledger)).toEqual([]);
  });

  it('refuses dismissal of a pending delivery and stale uncertain revisions', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const pending = await f.getRow();
    await expect(f.action('dismiss')).rejects.toThrow('unavailable');
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: pending.currentAttemptId,
        phase: 'unknown',
      },
    });
    await expect(
      f.target.command(
        envelope('stale-dismiss', {
          type: 'chat.input_delivery_action',
          chatId: f.scope.chatId,
          rowId: pending.id,
          rowRevision: pending.revision,
          action: 'dismiss',
        }),
      ),
    ).rejects.toThrow('changed');
    expect((await f.getRow()).dismissedAt).toBeUndefined();
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect(f.withdrawal).not.toHaveBeenCalled();
  });

  it('preserves host delivery evidence when an older client saves a fresh tab snapshot', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const before = await f.getRow();
    const snapshot = await f.target.getCompatibilityTabs(f.scope);
    const tab = { ...snapshot.tabs[0], title: 'Renamed by older client' };
    delete tab.inputDelivery;
    await f.target.replaceCompatibilityTabs(f.scope, {
      ...snapshot,
      tabs: [tab],
    });
    expect(await f.getRow()).toEqual(before);
    expect((await f.target.getState(f.scope)).tabsFile.tabs[0].title).toBe(
      'Renamed by older client',
    );
  });

  it.each(['pending', 'editing', 'cancelled'] as const)(
    'reopens durable %s input without replay after provider process loss',
    async (state) => {
      const f = await deliveryFixture();
      await f.steer();
      if (state === 'editing') {
        await f.action('edit');
        await f.action('save-draft', 'Draft survives process loss');
      } else if (state === 'cancelled') await f.action('cancel');
      const before = await f.getRow();
      await f.repository.drainAll();
      const restarted = serviceWithRepository({
        inputSession: async () => undefined,
      }).target;
      await restarted.inputDelivery.recover(f.scope);
      const restored = (await restarted.getState(f.scope)).tabsFile.tabs[0]
        .inputDelivery?.rows[0];
      expect(restored).toMatchObject({
        id: before.id,
        state: state === 'pending' ? 'uncertain' : state,
        attempts: before.attempts,
        payload: before.payload,
        ...(state === 'editing'
          ? { draft: 'Draft survives process loss' }
          : {}),
      });
      expect(f.submission).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([]);
    },
  );

  it.each([
    'before submission',
    'before admission receipt',
    'after committed pickup',
    'before withdrawal receipt',
  ] as const)(
    'recovers the durable files %s without replay',
    async (boundary) => {
      const f = await deliveryFixture();
      let captured: typeof paths | undefined;
      let submissionsAtCapture = -1;
      const capture = () => {
        captured = copyDurableFilesAtBoundary();
        submissionsAtCapture = f.submission.mock.calls.length;
      };

      if (boundary === 'before submission') {
        await f.target.inputDelivery.steerQueued(
          f.request,
          () => [],
          { commandId: 'steer-1', outcome: 'applied', entityId: 'chat-1' },
          capture,
        );
      } else if (boundary === 'before withdrawal receipt') {
        await f.steer();
        f.withdrawal.mockImplementation(async (attemptId) => {
          capture();
          return { kind: 'withdrawn', attemptId, evidenceId: attemptId };
        });
        await f.action('cancel');
      } else {
        f.submission.mockImplementation(async (_text, attemptId) => {
          if (boundary === 'after committed pickup') {
            await f.target.ingestProviderEvent({
              ...f.scope,
              data: {
                type: 'canopy_input_delivery',
                provider: 'claude',
                generation: 'generation-1',
                attemptId,
                phase: 'picked-up',
              },
            });
          }
          capture();
          return { kind: 'accepted', attemptId };
        });
        await f.steer();
      }

      expect(submissionsAtCapture).toBe(
        boundary === 'before submission' ? 0 : 1,
      );
      if (!captured) throw new Error('The handoff boundary was not reached');
      const restarted = serviceWithRepository(
        { inputSession: async () => undefined },
        captured,
      ).target;
      const before = (await restarted.getState(f.scope)).tabsFile.tabs[0]
        .inputDelivery?.rows[0];
      if (!before) throw new Error('The handoff intent was not durable');
      const pickedUp = boundary === 'after committed pickup';
      const cancelling = boundary === 'before withdrawal receipt';
      expect(before.state).toBe(
        pickedUp ? 'picked-up' : cancelling ? 'cancelling' : 'sending',
      );
      expect(before.attempts[0].withdrawnAt).toBeUndefined();
      expect(Boolean(before.attempts[0].admittedAt)).toBe(cancelling);
      expect(Boolean(before.attempts[0].pickedUpAt)).toBe(pickedUp);
      await restarted.inputDelivery.recover(f.scope);
      const recovered = await restarted.getState(f.scope);
      const restored = recovered.tabsFile.tabs[0].inputDelivery?.rows[0];
      expect(restored).toMatchObject({
        id: before.id,
        currentAttemptId: before.currentAttemptId,
        state: pickedUp ? 'picked-up' : 'uncertain',
        payload: { ...f.request, inputMode: 'voice' },
        attempts: before.attempts,
      });
      expect(restored?.attempts).toHaveLength(1);
      expect(restored?.attempts[0].withdrawnAt).toBeUndefined();
      expect(recovered.runtimeByChatId['chat-1'].queuedMessageIds).toEqual([]);
      expect(
        recovered.tabsFile.tabs[0].messages.filter(
          (m) => m.id === f.request.userMessageId,
        ),
      ).toHaveLength(pickedUp ? 1 : 0);
      expect(f.submission).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([]);
      if (cancelling) {
        // The original caller never received its reply. Retrying the same
        // command after restart returns the durable receipt without new I/O.
        await expect(
          restarted.command(
            envelope('action-cancel', {
              type: 'chat.input_delivery_action',
              chatId: f.scope.chatId,
              rowId: before.id,
              rowRevision: before.revision - 1,
              action: 'cancel',
            }),
          ),
        ).resolves.toMatchObject({ outcome: 'already_applied' });
        expect(f.withdrawal).toHaveBeenCalledTimes(1);
        expect(
          (await restarted.getState(f.scope)).tabsFile.tabs[0].inputDelivery
            ?.rows[0],
        ).toEqual(restored);
      }
    },
  );

  it('preserves a pending point-in-time anchor when forking the full visible transcript', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const initial = await target.getState(SCOPE);
    const source = initial.tabsFile.tabs[0];
    if (!source) throw new Error('Expected source chat');
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...initial.tabsFile,
        tabs: [
          {
            ...source,
            providerType: 'claude',
            sdkSessionId: 'source-session',
            claudeForkSessionOnNextSend: true,
            forkedFrom: {
              projectId: SCOPE.projectId,
              worktreeId: SCOPE.worktreeId,
              chatId: 'original-source',
              resumePointRequired: true,
            },
            messages: [
              {
                id: 'u1',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Kept prompt' }],
              },
              {
                id: 'a1',
                role: 'assistant',
                timestamp: 2,
                blocks: [{ type: 'text', text: 'Kept answer' }],
                claudeUuid: '11111111-1111-4111-8111-111111111111',
              },
            ],
          },
        ],
      },
      { authoritative: true },
    );

    await target.command(
      envelope('fork-pending-point-in-time', {
        type: 'chat.fork_tab',
        sourceTabId: source.id,
        targetTabId: 'fork-target',
        sourceSdkSessionId: 'source-session',
      }),
    );

    const fork = (
      await repository.getState(SCOPE, {
        chatIds: ['fork-target'],
        fullTranscript: true,
      })
    ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
    expect(fork).toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSessionOnNextSend: true,
      forkedFrom: { resumePointRequired: true },
    });
  });

  it('snapshot-anchors an ordinary full-history Claude fork', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const initial = await target.getState(SCOPE);
    const source = initial.tabsFile.tabs[0];
    if (!source) throw new Error('Expected source chat');
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...initial.tabsFile,
        tabs: [
          {
            ...source,
            providerType: 'claude',
            sdkSessionId: 'source-session',
            messages: [
              {
                id: 'a1',
                role: 'assistant',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Snapshot answer' }],
                claudeUuid: '11111111-1111-4111-8111-111111111111',
              },
            ],
          },
        ],
      },
      { authoritative: true },
    );

    await target.command(
      envelope('fork-full-history', {
        type: 'chat.fork_tab',
        sourceTabId: source.id,
        targetTabId: 'fork-target',
        sourceSdkSessionId: 'source-session',
      }),
    );

    const fork = (
      await repository.getState(SCOPE, {
        chatIds: ['fork-target'],
        fullTranscript: true,
      })
    ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
    expect(fork).toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSessionOnNextSend: true,
      forkedFrom: {
        atMessageId: 'a1',
        resumePointRequired: true,
      },
    });
  });

  describe('fork AI Credits routing (CAN-4200)', () => {
    async function forkWith(
      sourceFields: Partial<PersistedChatTab>,
      destinationFields?: Partial<PersistedChatTab>,
    ): Promise<PersistedChatTab | undefined> {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      const source = initial.tabsFile.tabs[0];
      if (!source) throw new Error('Expected source chat');
      const seeded: PersistedChatTab = {
        ...source,
        providerType: 'claude',
        ...sourceFields,
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Answer' }],
          },
        ],
      };
      await target.replaceCompatibilityTabs(
        SCOPE,
        { ...initial.tabsFile, tabs: [seeded] },
        { authoritative: true },
      );
      await target.command(
        envelope('fork-routing', {
          type: 'chat.fork_tab',
          sourceTabId: source.id,
          targetTabId: 'fork-target',
          ...(destinationFields
            ? {
                destinationTab: {
                  ...seeded,
                  ...destinationFields,
                  id: 'fork-target',
                  messages: [],
                },
              }
            : {}),
        }),
      );
      return (
        await repository.getState(SCOPE, {
          chatIds: ['fork-target'],
          fullTranscript: true,
        })
      ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
    }

    it('drops session routing and keeps the billing choices', async () => {
      const fork = await forkWith({
        aiCreditsRouting: { active: true, scope: 'session', activatedAt: 1 },
        subscriptionBillingOverride: true,
        billingExplicitlyChosen: true,
      });
      expect(fork).toBeDefined();
      expect(fork?.aiCreditsRouting).toBeUndefined();
      expect(fork).toMatchObject({
        subscriptionBillingOverride: true,
        billingExplicitlyChosen: true,
      });
    });

    it('keeps persistent routing', async () => {
      const routing = {
        active: true,
        scope: 'persistent',
        activatedAt: 1,
      } as const;
      const fork = await forkWith({ aiCreditsRouting: routing });
      expect(fork?.aiCreditsRouting).toEqual(routing);
    });

    it('drops session routing carried by the destination tab', async () => {
      const fork = await forkWith(
        {},
        {
          aiCreditsRouting: { active: true, scope: 'session', activatedAt: 2 },
        },
      );
      expect(fork).toBeDefined();
      expect(fork?.aiCreditsRouting).toBeUndefined();
    });
  });

  it('preserves fresh-context disclosure when re-forking a sessionless source', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const initial = await target.getState(SCOPE);
    const source = initial.tabsFile.tabs[0];
    if (!source) throw new Error('Expected source chat');
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...initial.tabsFile,
        tabs: [
          {
            ...source,
            providerType: 'claude',
            forkedFrom: {
              projectId: SCOPE.projectId,
              worktreeId: SCOPE.worktreeId,
              chatId: 'original-source',
              modelContext: 'fresh',
            },
            messages: [
              {
                id: 'a1',
                role: 'assistant',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Display-only answer' }],
              },
            ],
          },
        ],
      },
      { authoritative: true },
    );

    await target.command(
      envelope('refork-fresh-source', {
        type: 'chat.fork_tab',
        sourceTabId: source.id,
        targetTabId: 'fork-target',
      }),
    );

    const fork = (
      await repository.getState(SCOPE, {
        chatIds: ['fork-target'],
        fullTranscript: true,
      })
    ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
    expect(fork?.sdkSessionId).toBeUndefined();
    expect(fork?.forkedFrom?.modelContext).toBe('fresh');
  });

  it('recovers the committed Stop epoch before provider cleanup completes', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('edit');
    await f.action('save-draft', 'Draft retained through Stop');
    const before = (await f.target.getState(f.scope)).tabsFile.tabs[0]
      .inputDelivery;
    let captured: typeof paths | undefined;
    await f.target.inputDelivery.stop(f.scope, async () => {
      captured = copyDurableFilesAtBoundary();
    });
    if (!captured || !before) throw new Error('Stop boundary was not reached');
    const restarted = serviceWithRepository(
      { inputSession: async () => undefined },
      captured,
    ).target;
    await restarted.inputDelivery.recover(f.scope);
    const restored = (await restarted.getState(f.scope)).tabsFile.tabs[0]
      .inputDelivery;
    expect(restored?.epoch).toBe(before.epoch + 1);
    expect(restored?.rows[0]).toMatchObject({
      id: before.rows[0].id,
      state: 'cancelled',
      draft: 'Draft retained through Stop',
      editResubmits: false,
      attempts: before.rows[0].attempts,
    });
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  it('settles an accepted non-withdrawable steer when Stop wins before pickup', async () => {
    const f = await deliveryFixture();
    f.session.getSteeringCapabilities = () => ({
      provider: 'codex',
      generation: 'generation-1',
      steer: true,
      withdraw: false,
      interrupt: true,
    });
    await f.steer();
    expect((await f.getRow()).state).toBe('pending');

    await f.target.inputDelivery.stop(f.scope, async () => undefined);

    expect(await f.getRow()).toMatchObject({
      state: 'uncertain',
      reason: expect.stringContaining('stopped before pickup'),
    });
  });

  it('restores a safely rejected steer to the ordinary host queue', async () => {
    const f = await deliveryFixture();
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockImplementation(async (request, rowId, _receipt, epoch, origin) => {
        await f.target.reconcileHostQueue(
          f.scope,
          [rowId],
          false,
          { type: 'restore-input', rowId, epoch, request },
          [{ id: rowId, request, origin, enqueuedAtMs: 1 }],
        );
      });
    f.submission.mockImplementation(async (_text, attemptId) => ({
      kind: 'rejected',
      attemptId,
      reason: 'The active turn no longer accepts steering',
      fallback: 'ordinary',
    }));

    await f.steer();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(await f.getRow()).toMatchObject({ state: 'queued' });
    restore.mockRestore();
  });

  it('does not replace newer withdrawal evidence with an older delivery snapshot', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const stale = await f.target.getCompatibilityTabs(f.scope);
    await f.action('cancel');
    const cancelled = await f.getRow();
    await f.target.replaceCompatibilityTabs(f.scope, stale, {
      changedTabIds: ['chat-1'],
    });
    expect(await f.getRow()).toEqual(cancelled);
  });

  it('preserves an unknown ledger through compatibility saves and an explicit snapshot rollback', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const known = await f.target.getCompatibilityTabs(f.scope, {
      chatIds: [f.scope.chatId],
      fullTranscript: true,
    });
    const future = { version: 77, opaque: ['future delivery evidence'] };
    await f.target.updateCompatibilityTab(f.scope, 'chat-1', (tab) => {
      const next = { ...tab };
      Reflect.set(next, 'inputDelivery', future);
      return next;
    });
    const snapshot = await f.target.getCompatibilityTabs(f.scope);
    const withoutLedger = { ...snapshot.tabs[0] };
    delete withoutLedger.inputDelivery;
    await f.target.replaceCompatibilityTabs(f.scope, {
      ...snapshot,
      tabs: [withoutLedger],
    });
    const preserved = (await f.target.getCompatibilityTabs(f.scope)).tabs[0]
      .inputDelivery;
    expect(preserved).toEqual(future);
    expect(inputDeliveryViews(preserved)).toEqual([]);
    await expect(f.target.inputDelivery.recover(f.scope)).rejects.toThrow(
      'newer application',
    );
    await f.target.replaceCompatibilityTabs(f.scope, known, {
      authoritative: true,
    });
    expect(
      (await f.target.getCompatibilityTabs(f.scope)).tabs[0].inputDelivery,
    ).toEqual(known.tabs[0].inputDelivery);
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  it('preserves pickup when it wins a Pending edit cancellation race', async () => {
    const f = await deliveryFixture();
    await f.steer();
    f.withdrawal.mockImplementation(async (attemptId) => {
      await f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId,
          phase: 'picked-up',
        },
      });
      return { kind: 'picked-up', attemptId };
    });
    await f.action('edit');
    expect((await f.getRow()).state).toBe('picked-up');
    expect((await f.getRow()).draft).toBeUndefined();
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('projects and audits a late pickup from a superseded resend attempt', async () => {
    const f = await deliveryFixture({}, { onInputPickup: undefined });
    await f.steer();
    const originalAttemptId = (await f.getRow()).currentAttemptId;
    if (!originalAttemptId) throw new Error('Missing original attempt');

    await f.action('edit');
    await f.action('save', 'Edited replacement');
    const replacement = await f.getRow();
    expect(replacement.currentAttemptId).not.toBe(originalAttemptId);
    expect(replacement.state).toBe('pending');

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: originalAttemptId,
        phase: 'picked-up',
        startsTurn: true,
        turnRootAccepted: false,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const state = await f.target.getState(f.scope);
    expect(await f.getRow()).toMatchObject({
      state: 'uncertain',
      reason: expect.stringContaining('superseded delivery attempt'),
    });
    expect(state.tabsFile.tabs[0].messages).toContainEqual(
      expect.objectContaining({
        id: 'row-1',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: 'Original message',
          }),
        ]),
      }),
    );
    expect(mockObserveSteeringInput).toHaveBeenCalledWith(
      expect.objectContaining({
        ...f.scope,
        userMessageId: 'row-1',
        originalUserText: 'Original message',
        startsTurn: false,
      }),
    );
    const replacementAttemptId = replacement.currentAttemptId;
    if (!replacementAttemptId) throw new Error('Missing replacement attempt');

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: replacementAttemptId,
        phase: 'picked-up',
      },
    });

    expect(await f.getRow()).toMatchObject({
      state: 'uncertain',
      reason: expect.stringContaining('superseded delivery attempt'),
    });
  });

  it('invalidates edit-resend intent when Stop runs while provider withdrawal waits', async () => {
    const f = await deliveryFixture();
    await f.steer();
    let release: (result: ChatInputWithdrawal) => void = (): void => {
      throw new Error('Withdrawal release was not initialized');
    };
    let began = (): void => {
      throw new Error('Withdrawal start was not initialized');
    };
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.withdrawal.mockImplementation(() => {
      began();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const edit = f.action('edit');
    await ready;
    await f.target.inputDelivery.stop(f.scope, async () => undefined);
    const attemptId = (await f.getRow()).currentAttemptId;
    if (!attemptId) throw new Error('Missing test attempt');
    release({ kind: 'withdrawn', attemptId, evidenceId: attemptId });
    await expect(edit).rejects.toThrow('superseded');
    expect((await f.getRow()).state).toBe('cancelled');
    expect((await f.getRow()).editResubmits).not.toBe(true);
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('does not restore a queued move when Stop supersedes its pending withdrawal', async () => {
    const f = await deliveryFixture();
    await f.steer();
    let release: (result: ChatInputWithdrawal) => void = (): void => {
      throw new Error('Withdrawal release was not initialized');
    };
    let began = (): void => {
      throw new Error('Withdrawal start was not initialized');
    };
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.withdrawal.mockImplementation(() => {
      began();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockResolvedValue(undefined);

    const moving = f.action('queue', undefined, 'queue-before-stop');
    await ready;
    const attemptId = (await f.getRow()).currentAttemptId;
    if (!attemptId) throw new Error('Missing test attempt');
    await f.target.inputDelivery.stop(f.scope, async () => undefined);
    release({ kind: 'withdrawn', attemptId, evidenceId: attemptId });

    await expect(moving).rejects.toThrow('superseded');
    expect(restore).not.toHaveBeenCalled();
    expect((await f.getRow()).state).toBe('cancelled');
    restore.mockRestore();
  });

  it('releases the host queue after a confirmed steering withdrawal', async () => {
    const releaseInputOwnership = jest
      .spyOn(getChatQueueService(), 'releaseInputOwnership')
      .mockImplementation();
    const f = await deliveryFixture();
    await f.steer();

    await f.action('cancel');

    expect(releaseInputOwnership).toHaveBeenCalledWith(f.scope);
    releaseInputOwnership.mockRestore();
  });

  it('rejects malformed optional delivery event fields', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    const base = {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'generation-1',
      attemptId: row.currentAttemptId,
      phase: 'picked-up',
    };
    for (const malformed of [
      { ...base, providerTurnId: 1 },
      { ...base, itemId: false },
      { ...base, startsTurn: 'yes' },
      { ...base, userMessageId: {} },
    ]) {
      await expect(
        f.target.ingestProviderEvent({ ...f.scope, data: malformed }),
      ).resolves.toBe(false);
    }
    expect((await f.getRow()).state).toBe('pending');
  });

  it('rejects stale row commands and ignores provider events from another generation', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'old-generation',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
      },
    });
    expect((await f.getRow()).state).toBe('pending');
    const command = envelope('stale-action', {
      type: 'chat.input_delivery_action',
      chatId: 'chat-1',
      rowId: row.id,
      rowRevision: row.revision - 1,
      action: 'cancel',
    } as const);
    await expect(f.target.command(command)).rejects.toThrow('message changed');
    expect(f.withdrawal).not.toHaveBeenCalled();
  });

  it('keeps a withdrawn editor open when old admission and completion arrive late', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('edit');
    await f.action('save-draft', 'Durable draft');
    const row = await f.getRow();
    for (const phase of ['accepted', 'completed'] as const)
      await f.target.ingestProviderEvent({
        ...f.scope,
        data: {
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'generation-1',
          attemptId: row.currentAttemptId,
          phase,
        },
      });
    expect(await f.getRow()).toMatchObject({
      state: 'editing',
      draft: 'Durable draft',
    });
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('preserves late terminal evidence for a cancelled row after the tab is archived', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    await f.action('cancel');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await f.target.command(
      envelope('archive-input', { type: 'chat.archive_tab', tabId: 'chat-1' }),
    );
    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'completed',
      },
    });
    const state = await f.repository.getState(f.scope);
    expect(state.tabsFile.tabs).toEqual([]);
    expect(
      state.archivesFile.archived[0].tab.inputDelivery?.rows[0].attempts[0]
        .completedAt,
    ).toBeDefined();
    expect(
      state.archivesFile.archived[0].tab.inputDelivery?.rows[0],
    ).toMatchObject({ state: 'cancelled', text: 'Original message' });
    const olderSnapshot = structuredClone(state.archivesFile);
    delete olderSnapshot.archived[0].tab.inputDelivery;
    const saved = await f.target.replaceCompatibilityArchives(
      f.scope,
      olderSnapshot,
    );
    expect(saved.archived[0].tab.inputDelivery).toEqual(
      state.archivesFile.archived[0].tab.inputDelivery,
    );
  });

  it('materializes a late pickup in an archived chat transcript', async () => {
    const pickupObserver = jest.fn(async () => undefined);
    const f = await deliveryFixture({}, { onInputPickup: pickupObserver });
    await f.steer();
    const row = await f.getRow();
    await f.action('cancel');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'runtime.patched',
          chatId: f.scope.chatId,
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await f.target.command(
      envelope('archive-before-pickup', {
        type: 'chat.archive_tab',
        tabId: f.scope.chatId,
      }),
    );

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId,
        phase: 'picked-up',
        startsTurn: false,
      },
    });

    const archived = (
      await f.repository.getState(f.scope, { chatIds: [f.scope.chatId] })
    ).archivesFile.archived[0];
    expect(archived.tab.messages).toContainEqual(
      expect.objectContaining({ id: row.id, role: 'user' }),
    );
    expect(archived.turnCount).toBe(
      archived.tab.messages.filter((message) => message.role === 'user').length,
    );
    expect(pickupObserver).toHaveBeenCalledWith(
      expect.objectContaining(f.scope),
      expect.objectContaining({ id: row.id }),
      expect.objectContaining({ phase: 'picked-up' }),
    );
  });

  it('materializes an autonomous root pickup after the chat is archived', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const row = await f.getRow();
    await f.action('cancel');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'runtime.patched',
          chatId: f.scope.chatId,
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await f.target.command(
      envelope('archive-before-root-pickup', {
        type: 'chat.archive_tab',
        tabId: f.scope.chatId,
      }),
    );

    const before = await f.repository.getState(f.scope);
    expect(before.tabsFile.tabs).toEqual([]);
    await expect(
      f.target.inputDelivery.observe(f.scope, {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: row.currentAttemptId ?? '',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: row.id,
      }),
    ).resolves.toBe(true);

    const archived = (
      await f.repository.getState(f.scope, { chatIds: [f.scope.chatId] })
    ).archivesFile.archived[0];
    expect(archived.tab.messages).toContainEqual(
      expect.objectContaining({ id: row.id, role: 'user' }),
    );
  });

  it('forks inert message history with fresh identities and no source dispatch grants', async () => {
    const f = await deliveryFixture();
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'root-1',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Root' }],
          },
        },
      ],
      { source: 'provider' },
    );
    await f.steer();
    const source = await f.getRow();
    await f.target.command(
      envelope('fork-input', {
        type: 'chat.fork_tab',
        sourceTabId: 'chat-1',
        targetTabId: 'forked-chat',
      }),
    );
    const fork = (await f.target.getState(f.scope)).tabsFile.tabs.find(
      (tab) => tab.id === 'forked-chat',
    );
    const copy = fork?.inputDelivery?.rows[0];
    if (!copy) throw new Error('Missing forked delivery row');
    expect(copy.id).not.toBe(source.id);
    expect(copy.currentAttemptId).toBeUndefined();
    expect(copy.state).toBe('uncertain');
    expect(copy.payload).toMatchObject({
      chatId: 'forked-chat',
      userMessageId: copy.id,
      text: source.text,
    });
    expect(copy.attempts).toHaveLength(source.attempts.length);
    expect(copy.attempts[0]).toMatchObject({
      id: source.attempts[0].id,
      provider: source.attempts[0].provider,
      generation: source.attempts[0].generation,
      displayText: source.attempts[0].displayText,
    });
    expect(copy.attempts[0]).not.toHaveProperty('submittedText');
    expect(copy.attempts[0]).not.toHaveProperty('payloadSnapshot');
    expect(f.submission).toHaveBeenCalledTimes(1);
    expect((await f.getRow()).state).toBe('pending');
  });

  it('omits delivery rows created after a truncated fork anchor', async () => {
    const f = await deliveryFixture();
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'fork-anchor',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Fork here' }],
          },
        },
      ],
      { source: 'provider' },
    );
    await f.steer();
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'future-message',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Discarded future' }],
          },
        },
      ],
      { source: 'provider' },
    );
    await f.target.command(
      envelope('fork-before-delivery-row', {
        type: 'chat.fork_tab',
        sourceTabId: 'chat-1',
        targetTabId: 'truncated-fork',
        atMessageId: 'fork-anchor',
      }),
    );

    const fork = (await f.target.getState(f.scope)).tabsFile.tabs.find(
      (tab) => tab.id === 'truncated-fork',
    );
    expect(fork?.messages.map(({ id }) => id)).toEqual(['fork-anchor']);
    expect(fork?.inputDelivery?.rows).toEqual([]);
  });

  it('keeps the edited payload in the same transaction as its local queue transfer', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('cancel');
    const state = await f.repository.getState(f.scope);
    await f.target.reconcileHostQueue(f.scope, ['restored-entry'], true, {
      type: 'restore-input',
      rowId: 'row-1',
      epoch: state.tabsFile.tabs[0].inputDelivery?.epoch ?? -1,
      request: { ...f.request, text: 'Edited resend' },
    });
    const restored = await f.target.getState(f.scope);
    expect(restored.runtimeByChatId['chat-1'].queuedMessageIds).toEqual([
      'restored-entry',
    ]);
    expect(await f.getRow()).toMatchObject({
      state: 'queued',
      text: 'Edited resend',
      payload: { text: 'Edited resend' },
    });
    const restarted = serviceWithRepository(
      { inputSession: async () => undefined },
      copyDurableFilesAtBoundary(),
    ).target;
    await restarted.inputDelivery.recover(f.scope);
    const recovered = await restarted.getState(f.scope);
    expect(recovered.tabsFile.tabs[0].inputDelivery).toEqual(
      restored.tabsFile.tabs[0].inputDelivery,
    );
    expect(recovered.runtimeByChatId['chat-1'].queuedMessageIds).toEqual([
      'restored-entry',
    ]);
    expect(f.submission).toHaveBeenCalledTimes(1);
  });

  it('queues the saved draft after closing a Pending editor', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('edit');
    await f.action('close-editor', 'Saved draft');
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockResolvedValue(undefined);
    await f.action('queue');
    expect(restore.mock.calls[0]?.[0]).toMatchObject({
      ...f.request,
      text: 'Saved draft',
    });
  });

  it('does not commit a queue-action receipt before queue restoration is durable', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockRejectedValueOnce(new Error('crash before queue commit'))
      .mockResolvedValueOnce(undefined);

    await expect(f.action('queue', undefined, 'queue-once')).rejects.toThrow(
      'crash before queue commit',
    );
    expect(await f.target.hasMutation(f.scope, 'queue-once')).toBe(false);
    await expect(
      f.action('queue', undefined, 'queue-once'),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('coalesces provider and explicit withdrawal observations into one queue restoration', async () => {
    const f = await deliveryFixture();
    await f.steer();
    const pending = await f.getRow();
    const state = await f.target.getState(f.scope);
    const ledger = state.tabsFile.tabs[0].inputDelivery;
    if (!ledger || !pending.currentAttemptId)
      throw new Error('Missing pending delivery attempt');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: f.scope.chatId,
          patch: {
            inputDelivery: {
              ...ledger,
              rows: ledger.rows.map((row) =>
                row.id === pending.id
                  ? {
                      ...row,
                      state: 'cancelling',
                      revision: row.revision + 1,
                      queueIntent: {
                        commandId: 'queue-coalesced',
                        epoch: ledger.epoch,
                      },
                    }
                  : row,
              ),
            },
          },
        },
      ],
      { source: 'renderer-command' },
    );
    const queueService = getChatQueueService();
    let releaseRestore: (() => void) | undefined;
    let signalRestore: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestore = resolve;
    });
    const restore = jest
      .spyOn(queueService, 'restoreWithdrawnInput')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRestore = resolve;
            signalRestore?.();
          }),
      );
    const withdrawal = {
      ...f.scope,
      data: {
        type: 'canopy_input_delivery' as const,
        provider: 'claude' as const,
        generation: 'generation-1',
        attemptId: pending.currentAttemptId,
        phase: 'withdrawn' as const,
      },
    };
    const providerObservation = f.target.ingestProviderEvent(withdrawal);
    const explicitObservation = f.target.ingestProviderEvent({
      ...f.scope,
      data: withdrawal.data,
    });
    await restoreStarted;
    expect(restore).toHaveBeenCalledTimes(1);
    releaseRestore?.();

    await Promise.all([providerObservation, explicitObservation]);
    expect(restore).toHaveBeenCalledTimes(1);
    restore.mockRestore();
  });

  it('evicts a restored queue row when late pickup proves provider delivery', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('cancel');
    const withdrawn = await f.getRow();
    const attemptId = withdrawn.currentAttemptId;
    if (!attemptId) throw new Error('Missing pending delivery attempt');
    const state = await f.target.getState(f.scope);
    const ledger = state.tabsFile.tabs[0].inputDelivery;
    if (!ledger) throw new Error('Missing input ledger');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: f.scope.chatId,
          patch: {
            inputDelivery: {
              ...ledger,
              rows: ledger.rows.map((row) =>
                row.id === withdrawn.id
                  ? {
                      ...row,
                      revision: row.revision + 1,
                      state: 'queued' as const,
                      queueIntent: undefined,
                    }
                  : row,
              ),
            },
          },
        },
      ],
      { source: 'provider' },
    );
    expect(await f.getRow()).toMatchObject({ state: 'queued' });

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId,
        phase: 'picked-up',
      },
    });

    expect(queueConsumeRestoredInput).toHaveBeenCalledWith(
      expect.objectContaining(f.scope),
      'row-1',
    );
    expect(
      (await f.target.getState(f.scope)).tabsFile.tabs[0].messages,
    ).toContainEqual(expect.objectContaining({ id: 'row-1', role: 'user' }));
  });

  it('clears an interrupted queue intent before resending a recovered message', async () => {
    const f = await deliveryFixture();
    await f.steer();
    await f.action('cancel');
    const cancelled = await f.getRow();
    const state = await f.target.getState(f.scope);
    const ledger = state.tabsFile.tabs[0].inputDelivery;
    if (!ledger) throw new Error('Missing input ledger');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: f.scope.chatId,
          patch: {
            inputDelivery: {
              ...ledger,
              rows: ledger.rows.map((row) =>
                row.id === cancelled.id
                  ? {
                      ...row,
                      revision: row.revision + 1,
                      queueIntent: { commandId: 'interrupted-queue' },
                    }
                  : row,
              ),
            },
          },
        },
      ],
      { source: 'provider' },
    );
    const restore = jest.spyOn(getChatQueueService(), 'restoreWithdrawnInput');

    await f.action('resend');
    expect((await f.getRow()).queueIntent).toBeUndefined();
    await f.action('cancel', undefined, 'cancel-after-resend');

    expect(restore).not.toHaveBeenCalled();
    expect(await f.getRow()).toMatchObject({ state: 'cancelled' });
    restore.mockRestore();
  });

  it('materializes a late pickup from the immutable attempt payload', async () => {
    jest
      .spyOn(agentAttachments, 'resolveAgentAttachmentsDir')
      .mockReturnValue(tempDir);
    const originalPath = join(tempDir, 'original-context.txt');
    const replacementPath = join(tempDir, 'replacement-context.txt');
    writeFileSync(originalPath, 'original');
    writeFileSync(replacementPath, 'replacement');
    const originalFiles = [
      { absolutePath: originalPath, displayPath: 'original-context.txt' },
    ];
    const replacementFiles = [
      {
        absolutePath: replacementPath,
        displayPath: 'replacement-context.txt',
      },
    ];
    const f = await deliveryFixture({
      attachmentPaths: [originalPath],
      fileReferences: originalFiles,
    });
    await f.steer();
    const originalAttemptId = (await f.getRow()).currentAttemptId;
    if (!originalAttemptId) throw new Error('Missing original attempt');
    await f.action('cancel');
    const state = await f.target.getState(f.scope);
    const ledger = state.tabsFile.tabs[0].inputDelivery;
    if (!ledger) throw new Error('Missing input ledger');
    await f.repository.transact(
      f.scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: f.scope.chatId,
          patch: {
            inputDelivery: {
              ...ledger,
              rows: ledger.rows.map((row) => ({
                ...row,
                revision: row.revision + 1,
                state: 'queued' as const,
              })),
            },
          },
        },
      ],
      { source: 'provider' },
    );
    await f.target.inputDelivery.steerQueued(
      {
        ...f.request,
        text: 'Replacement message',
        attachmentPaths: [replacementPath],
        fileReferences: replacementFiles,
      },
      () => [],
      {
        commandId: 'steer-replacement',
        outcome: 'applied',
        entityId: f.scope.chatId,
      },
      jest.fn(),
    );

    await f.target.ingestProviderEvent({
      ...f.scope,
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'generation-1',
        attemptId: originalAttemptId,
        phase: 'picked-up',
      },
    });

    const message = (
      await f.target.getState(f.scope)
    ).tabsFile.tabs[0].messages.find(
      (candidate) => candidate.id === f.request.userMessageId,
    );
    expect(message).toMatchObject({
      attachmentPaths: [originalPath],
      blocks: expect.arrayContaining([
        { type: 'file_references', references: originalFiles },
        expect.objectContaining({ type: 'text', text: 'Original message' }),
      ]),
    });
  });

  it('retains an interrupted queue intent until authoritative withdrawal arrives', async () => {
    const f = await deliveryFixture();
    await f.steer();
    let releaseWithdrawal: (value: ChatInputWithdrawal) => void = (): void => {
      throw new Error('Withdrawal release was not initialized');
    };
    let markWithdrawalStarted = (): void => {
      throw new Error('Withdrawal start was not initialized');
    };
    const withdrawalStarted = new Promise<void>((resolve) => {
      markWithdrawalStarted = resolve;
    });
    f.withdrawal.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWithdrawal = resolve;
          markWithdrawalStarted();
        }),
    );

    const moving = f.action('queue', undefined, 'queue-after-restart');
    await withdrawalStarted;
    const captured = copyDurableFilesAtBoundary();
    const cancelling = await f.getRow();
    expect(cancelling).toMatchObject({
      state: 'cancelling',
      queueIntent: { commandId: 'queue-after-restart' },
    });
    releaseWithdrawal({
      kind: 'picked-up',
      attemptId: cancelling.currentAttemptId ?? '',
    });
    await moving;
    getChatQueueService().resetForTests();

    const restarted = serviceWithRepository(
      { inputSession: async () => undefined },
      captured,
    ).target;
    await restarted.inputDelivery.recover(f.scope);
    const recovered = (await restarted.getState(f.scope)).tabsFile.tabs[0]
      .inputDelivery?.rows[0];
    expect(recovered).toMatchObject({
      state: 'cancelled',
      queueIntent: { commandId: 'queue-after-restart' },
    });
    const restore = jest
      .spyOn(getChatQueueService(), 'restoreWithdrawnInput')
      .mockResolvedValue(undefined);
    await restarted.command(
      envelope('queue-after-restart', {
        type: 'chat.input_delivery_action',
        chatId: f.scope.chatId,
        rowId: cancelling.id,
        rowRevision: cancelling.revision - 1,
        action: 'queue',
      }),
    );
    expect(restore).toHaveBeenCalledWith(
      expect.any(Object),
      cancelling.id,
      expect.objectContaining({ commandId: 'queue-after-restart' }),
      expect.any(Number),
      'desktop',
    );
    getChatQueueService().resetForTests();
  });

  it.each([
    ['approval', { approvalMode: 'full-access' }],
    ['thinking', { thinkingLevel: 'high' }],
    ['model', { model: 'sonnet' }],
    ['plugins', { pluginSelections: { collectionIds: ['new-collection'] } }],
    ['billing', { subscriptionBillingOverride: true }],
    ['repository', { selectedRepoId: 'new-repository' }],
  ] as const)(
    'retains an edited Pending input when %s changes before resend',
    async (_name, patch) => {
      const f = await deliveryFixture();
      await f.steer();
      await f.action('edit');
      await f.action('save-draft', 'Saved before settings changed');
      await f.repository.transact(
        f.scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: f.scope.chatId,
            patch,
          },
        ],
        { source: 'provider' },
      );
      await expect(
        f.action('save', 'Saved before settings changed'),
      ).rejects.toThrow('Chat settings changed');
      expect(f.submission).toHaveBeenCalledTimes(1);
      expect(await f.getRow()).toMatchObject({
        state: 'editing',
        draft: 'Saved before settings changed',
      });
    },
  );

  it('reuses archive output ownership verification across page reads', async () => {
    const output = 'archived output page\n'.repeat(9_000);
    const archiveStore = new ChatStorageV2(
      join(tempDir, 'standalone-archive'),
      'chat-archive',
    );
    await archiveStore.migrate(async () => ({
      revision: 0,
      index: { activeTabId: '', runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* () {})(),
    }));
    const seed = new ChatStateV2Backend(archiveStore);
    await seed.transact(
      () => [
        {
          type: 'tab.created',
          tab: {
            id: 'chat-archive',
            title: 'Archived output',
            createdAt: '2026-09-09T00:00:00.000Z',
            messages: [],
          },
        },
      ],
      { source: 'import', fullTranscript: true },
    );
    await seed.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat-archive',
          message: {
            id: 'tool-message',
            role: 'assistant',
            timestamp: 1,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'tool-call',
                toolName: 'Read',
                output,
                isError: false,
              },
            ],
          },
        },
      ],
      { source: 'provider' },
    );
    const page = await seed.page('chat-archive');
    const block = page.messages[0]?.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef) {
      throw new Error('Missing archived output reference');
    }
    const storage = jest
      .spyOn(standaloneHistory, 'getStandaloneHistoryStorage')
      .mockResolvedValue(archiveStore);
    const iterate = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');
    const target = service();
    const request = {
      projectId: 'workspace-1',
      worktreeId: 'home',
      chatId: 'chat-archive',
      messageId: 'tool-message',
      toolUseId: 'tool-call',
      reference: block.fullOutputRef,
      offset: 0,
      limit: 64,
      standaloneHistory: true,
    };

    const first = await target.readToolOutput(request);
    await target.readToolOutput({ ...request, offset: first.nextOffset ?? 0 });

    expect(storage).toHaveBeenCalledTimes(1);
    expect(iterate).not.toHaveBeenCalled();
    storage.mockRestore();
    iterate.mockRestore();
  });

  it.each(['standalone', 'container'] as const)(
    'reads promoted visuals from a real %s archive store',
    async (kind) => {
      const html = '<!doctype html><p>Tree 🌲</p>';
      const sha256 = createHash('sha256').update(html).digest('hex');
      const reference: PersistedVisualReference = {
        version: 1,
        visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
        artifactId: `sha256-v1-${sha256}`,
        byteLength: Buffer.byteLength(html),
        sha256,
        mediaType: 'text/html',
        title: 'Tree',
        maxHeight: 400,
      };
      const archiveStore = new ChatStorageV2(
        join(tempDir, `visual-${kind}`),
        'archive-scope',
      );
      await archiveStore.migrate(async () => ({
        revision: 0,
        index: { activeTabId: 'chat-archive', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* () {
          yield {
            metadata: {
              id: 'chat-archive',
              title: 'Visual',
              createdAt: '2026-09-09',
            },
            messages: (async function* () {})(),
          };
        })(),
      }));
      const seed = new ChatStateV2Backend(archiveStore);
      // Writes verify referenced artifacts, so store the document first.
      await seed.storage.transcripts.artifacts.putVisual('chat-archive', html);
      await seed.transact(
        () => [
          {
            type: 'message.upserted',
            chatId: 'chat-archive',
            message: {
              id: 'visual-result',
              role: 'assistant',
              timestamp: 1,
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'call',
                  toolName: 'ShowVisual',
                  output: '',
                  isError: false,
                  visualRef: reference,
                },
              ],
            },
          },
        ],
        { source: 'import' },
      );
      const standaloneSpy = jest.spyOn(
        standaloneHistory,
        'getStandaloneHistoryStorage',
      );
      const containerSpy = jest.spyOn(
        archivedContainers,
        'getArchivedContainerChatStorage',
      );
      if (kind === 'standalone') standaloneSpy.mockResolvedValue(archiveStore);
      else containerSpy.mockResolvedValue(archiveStore);
      const target = service();
      const result = await target.readVisual({
        projectId: 'workspace-1',
        worktreeId: kind === 'container' ? 'container-1' : 'home',
        chatId: 'chat-archive',
        messageId: 'visual-result',
        toolUseId: 'call',
        reference,
        offset: 0,
        limit: 64,
        ...(kind === 'standalone'
          ? { standaloneHistory: true }
          : { archivedContainerId: 'container-1' }),
      });
      expect(Buffer.from(result.bytes).toString()).toBe(html);
      expect(result.sha256).toBe(sha256);
      standaloneSpy.mockRestore();
      containerSpy.mockRestore();
    },
  );

  it('reserves the workspace target until post-commit chat projection finishes', async () => {
    const target = service();
    let projectionStarted: (() => void) | undefined;
    let releaseProjection: (() => void) | undefined;
    const projectionReady = new Promise<void>((resolve) => {
      projectionStarted = resolve;
    });
    const projectionBlocked = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    setChatTabsWriteObserver(async () => {
      projectionStarted?.();
      await projectionBlocked;
    });

    const command = target.command(
      envelope('create-reserved', {
        type: 'chat.create_tab',
        tabId: 'chat-reserved',
        title: 'Reserved chat',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      }),
    );
    await projectionReady;

    const archiveAttempt = withWorkspaceTargetAutoArchiveLease(
      SCOPE.projectId,
      SCOPE.worktreeId,
      async () => undefined,
    );
    releaseProjection?.();
    await expect(command).resolves.toMatchObject({ outcome: 'applied' });
    await expect(archiveAttempt).rejects.toThrow(
      'Workspace target activity changed before Auto Delete',
    );
  });

  it('preserveActiveTab keeps the existing active tab during canonical creation', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-background', {
        type: 'chat.create_tab',
        tabId: 'background',
      }),
      { preserveActiveTab: true },
    );
    const state = await target.getState(SCOPE);
    expect(state.tabsFile.tabs.map((tab) => tab.id)).toEqual([
      'chat-1',
      'background',
    ]);
    expect(state.tabsFile.activeTabId).toBe('chat-1');
  });

  it('preserveActiveTab still activates the first tab in an empty scope', async () => {
    const target = service();
    await target.command(
      envelope('create-first-background', {
        type: 'chat.create_tab',
        tabId: 'first',
      }),
      { preserveActiveTab: true },
    );
    expect((await target.getState(SCOPE)).tabsFile.activeTabId).toBe('first');
  });

  it('persists an approval mode supplied by canonical tab creation', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-with-approval-mode', {
          type: 'chat.create_tab',
          tabId: 'chat-full-access',
          title: 'Durable full-access chat',
          approvalMode: 'full-access',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'chat-full-access',
      approvalMode: 'full-access',
    });
  });

  it('creates a starter only while the scope has no chat', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-first-starter', {
          type: 'chat.create_tab',
          tabId: 'chat-starter-1',
          starter: true,
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      entityId: 'chat-starter-1',
    });
    await expect(
      target.command(
        envelope('create-late-starter', {
          type: 'chat.create_tab',
          tabId: 'chat-starter-2',
          starter: true,
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'already_applied',
      entityId: 'chat-starter-1',
    });
    await expect(
      target.command(
        envelope('create-explicit-tab', {
          type: 'chat.create_tab',
          tabId: 'chat-explicit',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.map((tab) => tab.id),
    ).toEqual(['chat-starter-1', 'chat-explicit']);
  });

  it('persists the default-model ownership stamp supplied at creation', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-with-default-stamp', {
          type: 'chat.create_tab',
          tabId: 'chat-default-stamp',
          model: 'claude-opus-4-6',
          defaultStampModel: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'chat-default-stamp',
      model: 'claude-opus-4-6',
      defaultStampModel: 'claude-opus-4-6',
    });
  });

  it('stamps a new chat so an explicit pick of a project default survives the defaults changing', async () => {
    const target = service();
    const linear = { serverId: 'linear', configId: 'default' };
    const projectDefaults = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [linear],
    };

    await expect(
      target.command(
        envelope('create-with-own-pick', {
          type: 'chat.create_tab',
          tabId: 'chat-own-pick',
          pluginSelections: projectDefaults,
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const [created] = (await target.getState(SCOPE)).tabsFile.tabs;
    expect(created?.inheritedPluginDefaultsVersion).toBe(1);
    expect(
      created &&
        normalizeTabForInheritedPluginDefaults(created, projectDefaults),
    ).toBeNull();
    expect(created?.pluginSelections?.mcpServerRefs).toEqual([linear]);
  });

  it('keeps a seeded clone of a legacy chat unstamped so it is still normalized', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-seeded-legacy', {
          type: 'chat.create_tab',
          tabId: 'legacy-clone',
          seedTab: {
            id: 'legacy-clone',
            title: 'Legacy clone',
            createdAt: '2026-08-31T12:00:00.000Z',
            messages: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).not.toHaveProperty(
      'inheritedPluginDefaultsVersion',
    );
  });

  it('persists a complete seeded tab for a cross-scope branch', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-seeded-branch', {
          type: 'chat.create_tab',
          tabId: 'branched-chat',
          seedTab: {
            id: 'branched-chat',
            title: 'Branched chat',
            createdAt: '2026-08-31T12:00:00.000Z',
            messages: [
              {
                id: 'source-user',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Cloned transcript' }],
              },
            ],
            forkedFrom: {
              projectId: 'workspace-1',
              worktreeId: 'source-worktree',
              chatId: 'source-chat',
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'branched-chat',
      title: 'Branched chat',
      messages: [
        {
          id: 'source-user',
          role: 'user',
          blocks: [{ type: 'text', text: 'Cloned transcript' }],
        },
      ],
      forkedFrom: {
        projectId: 'workspace-1',
        worktreeId: 'source-worktree',
        chatId: 'source-chat',
      },
    });
  });

  it('drops host-owned approval state from a seeded tab', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-seeded-approval', {
          type: 'chat.create_tab',
          tabId: 'branched-chat',
          approvalMode: 'ask',
          seedTab: {
            id: 'branched-chat',
            title: 'Branched chat',
            createdAt: '2026-08-31T12:00:00.000Z',
            messages: [],
            approvalMode: 'full-access',
            sessionApprovalRules: [
              {
                id: 'seeded-rule',
                behavior: 'allow',
                target: { kind: 'tool', toolName: 'exec_command' },
                createdAt: '2026-08-31T12:00:00.000Z',
                origin: 'session',
              },
            ],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'branched-chat',
      approvalMode: 'ask',
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.sessionApprovalRules,
    ).toBeUndefined();
  });

  it('rejects a seeded tab whose id does not match the create command', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('create-mismatched-seed', {
          type: 'chat.create_tab',
          tabId: 'expected-chat',
          seedTab: {
            id: 'different-chat',
            title: 'Branched chat',
            createdAt: '2026-08-31T12:00:00.000Z',
            messages: [],
          },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('mismatched id'),
    });
    expect((await target.getState(SCOPE)).tabsFile.tabs).toEqual([]);
  });

  it('fails closed when journal corruption prevents a renderer snapshot', async () => {
    writeFileSync(
      paths.journal,
      ['conflict-a', 'conflict-b']
        .map(
          (mutationId) =>
            `${JSON.stringify({
              v: 1,
              revision: 1,
              mutationId,
              occurredAt: '2026-08-11T00:00:00.000Z',
              source: 'provider',
              mutations: [
                {
                  type: 'tab.created',
                  tab: {
                    id: mutationId,
                    title: 'Conflict',
                    createdAt: '2026-08-11T00:00:00.000Z',
                    messages: [],
                  },
                },
              ],
            })}\n`,
        )
        .join(''),
    );

    await expect(service().getState(SCOPE)).rejects.toMatchObject({
      name: 'ChatStateLoadError',
      message: expect.stringContaining('Conflicting duplicate chat revision'),
    });
  });

  it('keeps the shared-container viewer read-only while its file tabs stay recipient-local', async () => {
    const target = service();
    const viewerScope = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    };
    const viewerEnvelope = <T extends ChatCommand>(
      commandId: string,
      command: T,
    ): ChatCommandEnvelope<T> => ({
      schemaVersion: 1,
      commandId,
      ...viewerScope,
      command,
    });
    await target.replaceCompatibilityTabs(
      viewerScope,
      {
        version: 1,
        activeTabId: 'published-chat',
        tabs: [
          {
            id: 'published-chat',
            title: 'Published',
            createdAt: '2026-01-01T00:00:00.000Z',
            readOnly: true,
            messages: [
              {
                id: 'u1',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Published prompt' }],
              },
            ],
          },
        ],
      },
      { authoritative: true, activeTabId: 'published-chat' },
    );

    // Opening, re-moding and closing a replica file beside the chats is
    // recipient-local view state, exactly what the standard file viewer does.
    await expect(
      target.command(
        viewerEnvelope('open-viewer-file', {
          type: 'chat.create_file_tab',
          tabId: 'file-1',
          filePath: '/replica/repos/repo-1/src/index.ts',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(
      target.command(
        viewerEnvelope('mode-viewer-file', {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: { fileViewMode: 'raw' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    // Content writes, and file-tab-shaped commands aimed at a published
    // chat, fail closed.
    await expect(
      target.command(
        viewerEnvelope('patch-published-chat', {
          type: 'chat.patch_tab_settings',
          tabId: 'published-chat',
          patch: { title: 'Renamed' },
        }),
      ),
    ).rejects.toThrow('read-only');
    await expect(
      target.command(
        viewerEnvelope('discard-published-chat', {
          type: 'chat.close_tab',
          tabId: 'published-chat',
          mode: 'discard_empty',
        }),
      ),
    ).rejects.toThrow('read-only');
    await expect(
      target.command(
        viewerEnvelope('start-viewer-chat', {
          type: 'chat.create_tab',
          tabId: 'chat-new',
        }),
      ),
    ).rejects.toThrow('read-only');

    await expect(
      target.command(
        viewerEnvelope('close-viewer-file', {
          type: 'chat.close_tab',
          tabId: 'file-1',
          mode: 'discard_empty',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const reloaded = await service().getState(viewerScope);
    expect(reloaded.tabsFile.tabs.map((tab) => tab.id)).toEqual([
      'published-chat',
    ]);
  });

  it("hard-removes a contentful chat via close mode 'discard' in a hard-delete sentinel scope", async () => {
    const target = service();
    // The Code Review sentinel still accepts turns; legacy plan chats
    // (the other chat hard-delete scope) refuse them.
    const planScope = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'workspace-1--worktree-1',
    };
    const planEnvelope = <T extends ChatCommand>(
      commandId: string,
      command: T,
    ): ChatCommandEnvelope<T> => ({
      schemaVersion: 1,
      commandId,
      ...planScope,
      command,
    });
    await expect(
      target.command(
        planEnvelope('create-plan-chat', {
          type: 'chat.create_tab',
          tabId: 'chat-plan',
          providerType: 'claude',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(
      target.command(
        planEnvelope('send-plan', {
          type: 'chat.send_message',
          chatId: 'chat-plan',
          userMessageId: 'user-plan',
          text: 'Sentinel content that never archives',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await target.ingestProviderEvent({
      ...planScope,
      chatId: 'chat-plan',
      turnUserMessageId: 'user-plan',
      mutationId: 'plan-terminal',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });

    const result = await target.command(
      planEnvelope('discard-plan', {
        type: 'chat.close_tab',
        tabId: 'chat-plan',
        mode: 'discard',
      }),
    );

    expect(result).toMatchObject({ outcome: 'applied' });
    const snapshot = await target.getState(planScope);
    expect(snapshot.tabsFile.tabs).toEqual([]);
    // Hard delete, not archive-in-disguise.
    expect(snapshot.archives).toEqual([]);
  });

  it("rejects close mode 'discard' for a scope whose contentful closes must archive", async () => {
    const target = service();
    await createChat(target);
    await expect(
      target.command(
        envelope('send-guarded', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-guarded',
          text: 'A worktree chat must never be silently deleted',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const result = await target.command(
      envelope('discard-guarded', {
        type: 'chat.close_tab',
        tabId: 'chat-1',
        mode: 'discard',
      }),
    );

    expect(result).toMatchObject({ outcome: 'rejected' });
    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs.map((tab) => tab.id)).toEqual(['chat-1']);
  });

  it('bulk-closes several empty tabs and creates one replacement atomically', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-2', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
      }),
    );

    const result = await target.command(
      envelope('close-batch', {
        type: 'chat.close_tabs',
        targets: [
          { tabId: 'chat-1', mode: 'discard_empty' },
          { tabId: 'chat-2', mode: 'discard_empty' },
        ],
        replacementTabId: 'chat-3',
        replacementTab: {
          type: 'chat.create_tab',
          tabId: 'chat-3',
          providerType: 'codex',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'high', fastMode: true },
          pluginSelections: {
            collectionIds: ['collection-1'],
            skillRefs: [],
            pluginRefs: [],
          },
          deferredToolsAllowed: false,
          interfaceMode: 'canopy',
          subscriptionBillingOverride: true,
        },
      }),
    );

    expect(result).toMatchObject({ outcome: 'applied', revision: 3 });
    const snapshot = await service().getState(SCOPE);
    expect(snapshot.tabsFile.tabs.map((tab) => tab.id)).toEqual(['chat-3']);
    expect(snapshot.tabsFile.activeTabId).toBe('chat-3');
    expect(snapshot.tabsFile.tabs[0]).toMatchObject({
      providerType: 'codex',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      pluginSelections: { collectionIds: ['collection-1'] },
      deferredToolsAllowed: false,
      interfaceMode: 'canopy',
      subscriptionBillingOverride: true,
    });
  });

  it('persists resolved defaults on a final-tab replacement after reload', async () => {
    const target = service();
    await createChat(target);

    await target.command(
      envelope('close-final-with-defaults', {
        type: 'chat.close_tab',
        tabId: 'chat-1',
        mode: 'discard_empty',
        replacementTabId: 'chat-2',
        replacementTab: {
          type: 'chat.create_tab',
          tabId: 'chat-2',
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
          modelConfig: { thinkingLevel: 'medium', fastMode: false },
          pluginSelections: {
            collectionIds: ['collection-2'],
            skillRefs: [],
            pluginRefs: [],
          },
          deferredToolsAllowed: false,
          interfaceMode: 'claude-code',
          subscriptionBillingOverride: true,
        },
      }),
    );

    expect((await service().getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'chat-2',
      providerType: 'claude',
      model: 'claude-sonnet-4-6',
      modelConfig: { thinkingLevel: 'medium', fastMode: false },
      pluginSelections: { collectionIds: ['collection-2'] },
      deferredToolsAllowed: false,
      interfaceMode: 'claude-code',
      subscriptionBillingOverride: true,
    });
  });

  it('rejects a send to a legacy plan chat before persisting anything', async () => {
    const target = service();
    const legacyScope = {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
    };
    const legacyEnvelope = <T extends ChatCommand>(
      commandId: string,
      command: T,
    ): ChatCommandEnvelope<T> => ({
      schemaVersion: 1,
      commandId,
      ...legacyScope,
      command,
    });
    await expect(
      target.command(
        legacyEnvelope('create-legacy', {
          type: 'chat.create_tab',
          tabId: 'legacy-chat',
          title: 'Legacy plan chat',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    // The portal and the chat-command IPC reach the service directly,
    // without the send IPC or dispatch-funnel guards. A fresh service must
    // refuse before it opens (and could migrate) the legacy scope.
    const fresh = serviceWithRepository();
    const getRevision = jest.spyOn(fresh.repository, 'getRevision');
    const getState = jest.spyOn(fresh.repository, 'getState');
    await expect(
      fresh.target.command(
        legacyEnvelope('send-legacy', {
          type: 'chat.send_message',
          chatId: 'legacy-chat',
          userMessageId: 'user-legacy',
          text: 'Must not persist',
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: RETIRED_PLAN_CHAT_MESSAGE,
    });
    expect(getRevision).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();

    const state = await target.getState(legacyScope);
    expect(state.tabsFile.tabs[0]?.messages).toEqual([]);
    expect(state.runtimeByChatId['legacy-chat']?.activeTurn).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  it.each<{ label: string; command: ChatCommand }>([
    {
      label: 'a terminal initial prompt',
      command: {
        type: 'chat.commit_terminal_initial_prompt',
        chatId: 'legacy-chat',
        userMessageId: 'user-terminal',
        turnTimerMessageId: 'timer-terminal',
        text: 'Must not persist',
      },
    },
    {
      label: 'a fork',
      command: {
        type: 'chat.fork_tab',
        sourceTabId: 'legacy-chat',
        targetTabId: 'legacy-fork',
      },
    },
    {
      label: 'a session import',
      command: {
        type: 'chat.import_session',
        targetChatId: 'legacy-chat',
        source: { kind: 'transcript', providerType: 'claude', content: '' },
      },
    },
  ])(
    'rejects $label into a legacy plan chat before persisting anything',
    async ({ command }) => {
      const legacyScope = {
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
      };
      const { target, repository } = serviceWithRepository();
      const getRevision = jest.spyOn(repository, 'getRevision');
      const getState = jest.spyOn(repository, 'getState');

      await expect(
        target.command({
          schemaVersion: 1,
          commandId: `legacy-${command.type}`,
          ...legacyScope,
          command,
        }),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        reason: RETIRED_PLAN_CHAT_MESSAGE,
      });
      expect(getRevision).not.toHaveBeenCalled();
      expect(getState).not.toHaveBeenCalled();
      expect(dispatched).toEqual([]);
    },
  );

  it('keeps one prompt when a retried send saves the same user message again', async () => {
    const target = service();
    await createChat(target);
    const prompt = {
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'first-message',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Start the review',
        canopy_turn_user_message_id: 'first-message',
        canopy_persisted_messages: [
          {
            id: 'first-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Start the review' }],
            timestamp: 1,
          },
        ],
      },
    };
    await target.ingestProviderEvent(prompt);
    await target.ingestProviderEvent(prompt);
    const tab = (await target.getState(SCOPE)).tabsFile.tabs.find(
      (candidate) => candidate.id === 'chat-1',
    );
    expect(
      tab?.messages.filter((message) => message.id === 'first-message'),
    ).toHaveLength(1);
  });

  it('archives a rejected starting child even when its error-event ingestion fails', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-source', {
        type: 'chat.create_tab',
        tabId: 'source-chat',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'startup-user',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Continue',
        canopy_turn_user_message_id: 'startup-user',
      },
    });
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.status,
    ).toBe('starting');
    jest
      .spyOn(target, 'ingestProviderEvent')
      .mockRejectedValueOnce(new Error('error recording unavailable'));
    const sessions = await import('../../agents/session-manager');
    const stop = jest
      .spyOn(sessions, 'destroySession')
      .mockResolvedValue(undefined);
    const failure = new Error('provider startup rejected');
    try {
      await expect(
        closeRejectedSplitAgentStartup(
          { ...SCOPE, chatId: 'chat-1' },
          failure,
          target,
        ),
      ).rejects.toBe(failure);
      const snapshot = await target.getState(SCOPE);
      expect(snapshot.tabsFile.tabs.map((tab) => tab.id)).toEqual([
        'source-chat',
      ]);
      expect(snapshot.archives.some((entry) => entry.chatId === 'chat-1')).toBe(
        true,
      );
    } finally {
      stop.mockRestore();
    }
  });

  it('does not settle a startup with a durable acceptance receipt', async () => {
    const target = service();
    await createChat(target);
    const prompt = {
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'accepted-user',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'accepted-user',
      },
    };
    await target.ingestProviderEvent(prompt);
    await target.ingestProviderEvent({
      ...prompt,
      mutationId: 'chat-1:accepted-user:accepted',
      data: { type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE },
    });
    await target.ingestProviderEvent({
      ...prompt,
      mutationId: 'stale-prompt-replay',
    });
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.status,
    ).toBe('starting');
    await target.settleRejectedStartup(
      { ...SCOPE, chatId: 'chat-1' },
      'stale rejection',
    );
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.status,
    ).toBe('starting');
  });

  // A provider can fail while the host is still sending its prompt (for
  // example the MCP proxy port is held by another instance). The failure then
  // commits before the host records the prompt's acceptance; that late
  // acceptance must not reopen the failed turn as an endless "Working" state.
  it.each([
    ['tagged with the turn', { canopy_turn_user_message_id: 'failed-user' }],
    ['untagged', {}],
  ])(
    'keeps a turn that failed to start settled when its acceptance commits late (%s)',
    async (_label, turnTag) => {
      const target = service();
      await createChat(target);
      const prompt = {
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'failed-user',
        mutationId: 'chat-1:failed-user:user-prompt',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'failed-user',
        },
      };
      await target.ingestProviderEvent(prompt);
      const failure =
        'MCP proxy port 37645 is already in use by another MCP proxy.';
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'chat-1:failed-user:provider:initial:0',
        ...('canopy_turn_user_message_id' in turnTag
          ? { turnUserMessageId: 'failed-user' }
          : {}),
        data: { type: 'error', error: failure, ...turnTag },
      });
      await target.ingestProviderEvent({
        ...prompt,
        mutationId: 'chat-1:failed-user:accepted',
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: 'failed-user',
        },
      });

      const state = await target.getState(SCOPE);
      expect(state.runtimeByChatId['chat-1']).toMatchObject({
        status: 'failed',
        error: { message: failure },
      });
      const tab = state.tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat-1',
      );
      expect(tab?.lastAcceptedUserMessageId).toBe('failed-user');
      expect(
        tab?.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text === `Error: ${failure}`,
          ),
        ),
      ).toBe(true);
      expect(
        tab?.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'turn_timer' && block.completedAt === null,
          ),
        ),
      ).toBe(false);
    },
  );

  it('does not overwrite acceptance racing rejected-startup settlement', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'startup-user',
      data: { type: 'canopy_user_prompt' },
    });
    jest.spyOn(repository, 'hasMutation').mockImplementationOnce(async () => {
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'startup-user',
        data: { type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE },
      });
      return false;
    });
    await target.settleRejectedStartup(
      { ...SCOPE, chatId: 'chat-1' },
      'stale rejection',
    );
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.status,
    ).toBe('streaming');
  });

  it.each([
    ['admits a send whose admission check holds', 'ask', 'applied'],
    [
      'refuses a send whose chat switched to Full Access before admission',
      'full-access',
      'rejected',
    ],
  ] as const)('%s', async (_case, switchedTo, outcome) => {
    const { target } = serviceWithRepository({
      authorizeSend: async () => {
        await target.updateCompatibilityTab(
          SCOPE,
          'chat-1',
          (tab) => ({ ...tab, approvalMode: switchedTo }),
          'switch-during-send',
        );
      },
    });
    await target.command(
      envelope('create-guarded', {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        title: 'Guarded chat',
        approvalMode: 'ask',
      }),
    );
    const checked: unknown[] = [];
    const result = await withChatSendAdmission(
      { ...SCOPE, chatId: 'chat-1', userMessageId: 'user-guarded' },
      (tab) => {
        checked.push(tab.approvalMode);
        return tab.approvalMode === 'ask' ? undefined : 'Mode changed.';
      },
      () =>
        target.command(
          envelope('send-guarded', {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: 'user-guarded',
            text: 'Run it',
          }),
        ),
    );

    expect(checked).toEqual([switchedTo]);
    expect(result).toMatchObject({
      outcome,
      ...(outcome === 'rejected' ? { reason: 'Mode changed.' } : {}),
    });
    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab?.messages.map((message) => message.id)).toEqual(
      outcome === 'applied' ? ['user-guarded'] : [],
    );
    expect(dispatched.map((request) => request.userMessageId)).toEqual(
      outcome === 'applied' ? ['user-guarded'] : [],
    );
  });

  it.each([
    ['not accepted', false, 'failed', true],
    ['accepted', true, 'failed', false],
  ] as const)(
    'ends a turn whose dispatch fails before it is %s through the turn lifecycle',
    async (_label, accepted, outcome, notified) => {
      const notices: unknown[] = [];
      const { target, repository } = serviceWithRepository({
        dispatch: async (request) => {
          if (accepted)
            await repository.transact(
              SCOPE,
              [
                {
                  type: 'tab.metadata_patched',
                  tabId: request.chatId,
                  patch: {},
                },
              ],
              {
                source: 'provider',
                mutationId: `${request.chatId}:${request.userMessageId}:accepted`,
              },
            );
          throw new Error('The provider could not start.');
        },
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      await createChat(target);
      const message = { ...SCOPE, chatId: 'chat-1', userMessageId: 'user-1' };

      await expect(
        target.command(
          envelope('send-failing', {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: 'user-1',
            text: 'Start',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      expect(
        (await target.getState(SCOPE)).runtimeByChatId['chat-1'],
      ).toMatchObject({
        status: 'failed',
        error: { message: 'The provider could not start.' },
      });
      await expect(target.turnOutcome(message)).resolves.toBe(outcome);
      expect(notices).toEqual(
        notified
          ? [
              {
                ...message,
                outcome: 'failed',
                data: {
                  type: 'result',
                  is_error: true,
                  result: 'The provider could not start.',
                  canopy_turn_user_message_id: 'user-1',
                  canopy_turn_unaccepted: true,
                },
              },
            ]
          : [],
      );
    },
  );

  describe('a send held for its worktree setup', () => {
    type TurnNotice = Parameters<
      NonNullable<ChatStateServiceOptions['notifyTurnTerminal']>
    >[0];
    type HeldTurn = typeof SCOPE & { chatId: string; userMessageId: string };
    const CHAT = { ...SCOPE, chatId: 'chat-1' };

    function heldService(
      options: {
        provider?: (request: ChatSendMessageRequest) => Promise<void>;
        setupPending?: boolean;
        overrides?: Partial<ChatStateServiceOptions>;
      } = {},
    ): {
      target: ChatStateService;
      repository: ChatStateRepository;
      queue: ChatQueueService;
      notices: TurnNotice[];
      settle: (outcome: WorktreeGitSetupOutcome) => void;
      beginSetup: () => void;
    } {
      let setup: Promise<WorktreeGitSetupOutcome> | undefined;
      let settle: (outcome: WorktreeGitSetupOutcome) => void = () => undefined;
      const beginSetup = (): void => {
        setup = new Promise((resolve) => {
          settle = (outcome): void => {
            setup = undefined;
            resolve(outcome);
          };
        });
      };
      if (options.setupPending !== false) beginSetup();
      const notices: TurnNotice[] = [];
      let rowIds = 0;
      const service: { target?: ChatStateService } = {};
      const queue = new ChatQueueService({
        dispatch: async (request): Promise<void> => {
          dispatched.push(request);
          await options.provider?.(request);
        },
        beginTurnPreparation: beginChatTurnPreparation,
        cancel: async () => undefined,
        settleCancelledTurn: () => undefined,
        hasActiveProviderTurn: () => false,
        hasPendingProviderContinuation: () => false,
        persistRuntime: (
          queueTarget,
          ids,
          turnActive,
          mutation,
          rows,
          active,
        ) =>
          service.target?.reconcileHostQueue(
            queueTarget,
            ids,
            turnActive,
            mutation,
            rows,
            active,
          ),
        endDiscardedTurns: async (discardedTarget, requests) =>
          service.target?.endDiscardedQueuedTurns(discardedTarget, requests),
        broadcast: () => undefined,
        createId: () => `row-${(rowIds += 1)}`,
        now: () => 1_786_104_000_000,
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      });
      const { target, repository } = serviceWithRepository({
        awaitWorktreeSetup: () => setup,
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
        dispatch: (request, origin) => queue.submit(request, origin),
        worktreeSetupQueue: {
          hold: async (holdTarget, turnUserMessageId) =>
            queue.holdForWorktreeSetup(holdTarget, turnUserMessageId),
          release: async (releaseTarget, releaseOptions) =>
            queue.releaseWorktreeSetupHold(releaseTarget, releaseOptions),
          takeHeld: (heldTarget, outcome) =>
            queue.takeWorktreeSetupHeldSends(heldTarget, outcome),
        },
        ...options.overrides,
      });
      service.target = target;
      return {
        target,
        repository,
        queue,
        notices,
        settle: (outcome) => settle(outcome),
        beginSetup,
      };
    }

    const turn = (userMessageId: string): HeldTurn => ({
      ...CHAT,
      userMessageId,
    });

    async function post(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<void> {
      await expect(
        target.command(
          envelope(`send-${userMessageId}`, {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId,
            text: `Run ${userMessageId} once the worktree exists`,
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    }

    async function send(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<void> {
      await post(target, userMessageId);
      expect(target.isAwaitingWorktreeSetup(turn(userMessageId))).toBe(true);
    }

    async function queueBehind(
      target: ChatStateService,
      queue: ChatQueueService,
      userMessageId: string,
    ): Promise<void> {
      await post(target, userMessageId);
      expect(target.isAwaitingWorktreeSetup(turn(userMessageId))).toBe(false);
      expect(queue.holdsUserMessage(CHAT, userMessageId)).toBe(true);
    }

    async function until(predicate: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(predicate()).toBe(true);
    }

    async function released(
      target: ChatStateService,
      ...userMessageIds: string[]
    ): Promise<void> {
      await until(() =>
        userMessageIds.every((id) => !target.isAwaitingWorktreeSetup(turn(id))),
      );
    }

    async function settled(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
    }

    async function runtimeOf(
      target: ChatStateService,
    ): Promise<ChatRuntimeState | undefined> {
      return (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
    }

    async function queuedUserMessageIds(
      target: ChatStateService,
    ): Promise<string[]> {
      return ((await runtimeOf(target))?.queuedMessages ?? []).map(
        (row) => row.request.userMessageId,
      );
    }

    function dispatchedIds(): string[] {
      return dispatched.map((request) => request.userMessageId);
    }

    async function rowIdOf(
      target: ChatStateService,
      userMessageId: string,
    ): Promise<string> {
      const row = ((await runtimeOf(target))?.queuedMessages ?? []).find(
        (entry) => entry.request.userMessageId === userMessageId,
      );
      if (!row) throw new Error(`No queued row for ${userMessageId}`);
      return row.id;
    }

    function endNotice(
      userMessageId: string,
      outcome: 'cancelled' | 'failed',
      result = outcome === 'failed'
        ? 'The worktree could not be set up.'
        : 'Cancelled',
    ): TurnNotice {
      return {
        ...turn(userMessageId),
        outcome,
        data: {
          type: 'result',
          is_error: outcome === 'failed',
          result,
          canopy_turn_user_message_id: userMessageId,
          canopy_turn_unaccepted: true,
        },
      };
    }

    async function transcriptOf(
      target: ChatStateService,
    ): Promise<(string | number | null | undefined)[][]> {
      return (
        (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages ?? []
      ).map((message) =>
        message.role === 'user'
          ? ['user', message.id]
          : [
              message.role,
              ...message.blocks.flatMap((block) =>
                block.type === 'turn_timer'
                  ? [block.type, block.startedAt, block.completedAt]
                  : [block.type],
              ),
            ],
      );
    }

    it('ends a turn stopped while its setup is pending and never dispatches it', async () => {
      const { target, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');

      await cancelChatTurnPreparations(CHAT);

      expect(notices).toEqual([endNotice('user-held', 'cancelled')]);
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'cancelled',
      );
      await expect(runtimeOf(target)).resolves.toMatchObject({
        status: 'cancelled',
        activeTurn: { userMessageId: 'user-held' },
      });

      settle('ready');
      await released(target, 'user-held');
      await settled();

      expect(dispatched).toEqual([]);
      expect(notices).toHaveLength(1);
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'cancelled',
      );
      expect(await transcriptOf(target)).toEqual([
        ['user', 'user-held'],
        ['system', 'turn_timer', 1_786_104_000_000, 1_786_104_000_000],
      ]);
    });

    it('records when an unaccepted turn ended, so a later end can be ordered against it', async () => {
      const { target, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');

      await cancelChatTurnPreparations(CHAT);
      settle('ready');
      await released(target, 'user-held');
      await settled();

      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab?.unacceptedTurnEnds).toEqual({ 'user-held': 'cancelled' });
      expect(tab?.turnEnds).toEqual({
        'user-held': { outcome: 'cancelled', endedAt: 1_786_104_000_000 },
      });
    });

    it('keeps the last accepted end when an unaccepted end fills the bounded record', async () => {
      const { target, repository, settle } = heldService();
      await createChat(target);
      const failed = Object.fromEntries(
        Array.from({ length: TURN_END_LIMIT - 1 }, (_, index) => [
          `user-failed-${index}`,
          { outcome: 'failed' as const, endedAt: index },
        ]),
      );
      await repository.transact(
        SCOPE,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: {
              lastAcceptedUserMessageId: 'user-done',
              turnEnds: {
                ...failed,
                'user-done': { outcome: 'completed', endedAt: 1_000 },
              },
            },
          },
        ],
        { source: 'automation', mutationId: 'seed-turn-ends' },
      );
      await send(target, 'user-held');

      await cancelChatTurnPreparations(CHAT);
      settle('ready');
      await released(target, 'user-held');
      await settled();

      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab?.turnEnds?.['user-done']).toEqual({
        outcome: 'completed',
        endedAt: 1_000,
      });
      expect(tab && projectPortalLastTurnEnd(tab)).toMatchObject({
        userMessageId: 'user-held',
        outcome: 'cancelled',
      });
    });

    it.each(['failed', 'cancelled'] as const)(
      'ends the turn %s, notifying its end once, when its setup ends that way',
      async (outcome) => {
        const { target, notices, settle } = heldService();
        await createChat(target);
        await send(target, 'user-held');
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          'pending',
        );

        settle(outcome);
        await released(target, 'user-held');

        expect(dispatched).toEqual([]);
        expect(notices).toEqual([endNotice('user-held', outcome)]);
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          outcome,
        );
        await expect(
          target.turnOutcome({ ...CHAT, userMessageId: null }),
        ).resolves.toBe(outcome);
        await expect(runtimeOf(target)).resolves.toMatchObject({
          status: outcome,
          activeTurn: { userMessageId: 'user-held' },
          ...(outcome === 'failed'
            ? { error: { message: 'The worktree could not be set up.' } }
            : {}),
        });
        expect(await transcriptOf(target)).toEqual([
          ['user', 'user-held'],
          ['system', 'turn_timer', 1_786_104_000_000, 1_786_104_000_000],
        ]);
      },
    );

    it.each(['failed', 'cancelled'] as const)(
      'ends the first send %s, never dispatching it, when its setup settled that way before it arrived',
      async (outcome) => {
        const events: unknown[] = [];
        mockWatcherService = {
          handleChatTerminalEvent: (event): Promise<void> => {
            events.push(event);
            return Promise.resolve();
          },
        };
        try {
          const { target } = heldService({
            setupPending: false,
            overrides: {
              awaitWorktreeSetup: undefined,
              notifyTurnTerminal: undefined,
            },
          });
          await createChat(target);
          beginWorktreeGitSetup(SCOPE.projectId, SCOPE.worktreeId)(outcome);

          await post(target, 'user-first');
          await released(target, 'user-first');
          await until(() => events.length > 0);
          await settled();

          expect(dispatched).toEqual([]);
          expect(events).toEqual([
            expect.objectContaining({
              scope: 'worktree',
              ...CHAT,
              status: outcome === 'failed' ? 'failure' : 'cancelled',
              data: endNotice('user-first', outcome).data,
            }),
          ]);
          await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
            outcome,
          );
          await expect(runtimeOf(target)).resolves.toMatchObject({
            status: outcome,
            activeTurn: { userMessageId: 'user-first' },
          });

          await post(target, 'user-second');
          await until(() => dispatched.length === 1);
          expect(dispatchedIds()).toEqual(['user-second']);
          expect(events).toHaveLength(1);
        } finally {
          mockWatcherService = undefined;
        }
      },
    );

    it.each(['failed', 'cancelled'] as const)(
      'reports a held first turn %s to its watcher when its pending setup ends that way',
      async (outcome) => {
        const events: unknown[] = [];
        mockWatcherService = {
          handleChatTerminalEvent: (event): Promise<void> => {
            events.push(event);
            return Promise.resolve();
          },
        };
        try {
          const { target } = heldService({
            setupPending: false,
            overrides: {
              awaitWorktreeSetup: undefined,
              notifyTurnTerminal: undefined,
            },
          });
          await createChat(target);
          const settleSetup = beginWorktreeGitSetup(
            SCOPE.projectId,
            SCOPE.worktreeId,
          );
          await send(target, 'user-first');
          await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
            'pending',
          );
          expect(events).toEqual([]);

          settleSetup(outcome);
          await released(target, 'user-first');
          await until(() => events.length > 0);
          await settled();

          expect(dispatched).toEqual([]);
          expect(events).toEqual([
            expect.objectContaining({
              scope: 'worktree',
              ...CHAT,
              status: outcome === 'failed' ? 'failure' : 'cancelled',
              data: endNotice('user-first', outcome).data,
            }),
          ]);
          await expect(target.turnOutcome(turn('user-first'))).resolves.toBe(
            outcome,
          );
          await expect(runtimeOf(target)).resolves.toMatchObject({
            status: outcome,
            activeTurn: { userMessageId: 'user-first' },
            ...(outcome === 'failed'
              ? { error: { message: 'The worktree could not be set up.' } }
              : {}),
          });
        } finally {
          mockWatcherService = undefined;
        }
      },
    );

    describe('whose end cannot be committed', () => {
      function failingEnds(
        repository: ChatStateRepository,
        failures: number,
      ): { attempts: () => number } {
        let attempts = 0;
        const transactWith = repository.transactWith.bind(repository);
        jest
          .spyOn(repository, 'transactWith')
          .mockImplementation((scope, build, options) => {
            if (options.mutationId?.includes(':unaccepted:')) {
              attempts += 1;
              if (attempts <= failures) {
                return Promise.reject(new Error('The disk is full.'));
              }
            }
            return transactWith(scope, build, options);
          });
        return { attempts: () => attempts };
      }

      it('announces no end and leaves the turn as durably recorded', async () => {
        const retries: (() => void)[] = [];
        const { target, repository, notices, settle } = heldService({
          overrides: {
            schedule: (callback) => {
              retries.push(callback);
              return setTimeout(() => undefined, 0);
            },
          },
        });
        await createChat(target);
        await send(target, 'user-held');
        const ends = failingEnds(repository, Number.POSITIVE_INFINITY);

        settle('failed');
        await released(target, 'user-held');
        await settled();

        expect(ends.attempts()).toBe(1);
        expect(notices).toEqual([]);
        expect(dispatched).toEqual([]);
        await expect(runtimeOf(target)).resolves.toMatchObject({
          status: 'starting',
          activeTurn: { userMessageId: 'user-held' },
        });
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          'pending',
        );

        while (retries.length > 0) {
          retries.shift()?.();
          await settled();
        }
        expect(ends.attempts()).toBeGreaterThan(1);
        expect(notices).toEqual([]);
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          'pending',
        );
      });

      it('keeps a queued send queued, announcing nothing, when its cancel cannot be committed', async () => {
        const events: unknown[] = [];
        mockWatcherService = {
          handleChatTerminalEvent: (event): Promise<void> => {
            events.push(event);
            return Promise.resolve();
          },
        };
        try {
          const { target, repository, queue } = heldService({
            setupPending: false,
            overrides: { notifyTurnTerminal: undefined },
          });
          await createChat(target);
          await post(target, 'user-root');
          await queueBehind(target, queue, 'user-queued');
          const rowId = await rowIdOf(target, 'user-queued');
          const transactWith = repository.transactWith.bind(repository);
          let failNext = true;
          jest
            .spyOn(repository, 'transactWith')
            .mockImplementation((scope, build, options) => {
              if (failNext) {
                failNext = false;
                return Promise.reject(new Error('The disk is full.'));
              }
              return transactWith(scope, build, options);
            });

          await expect(queue.cancel(CHAT, rowId)).rejects.toThrow(
            'The disk is full.',
          );
          await settled();

          expect(events).toEqual([]);
          expect(queue.holdsUserMessage(CHAT, 'user-queued')).toBe(true);
          await expect(target.turnOutcome(turn('user-queued'))).resolves.toBe(
            'pending',
          );
          expect(
            (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.map(
              (message) => message.id,
            ),
          ).toEqual(['user-root', 'user-queued']);
        } finally {
          mockWatcherService = undefined;
        }
      });

      it('announces the end once a retry commits it', async () => {
        const retries: (() => void)[] = [];
        const { target, repository, notices, settle } = heldService({
          overrides: {
            schedule: (callback) => {
              retries.push(callback);
              return setTimeout(() => undefined, 0);
            },
          },
        });
        await createChat(target);
        await send(target, 'user-held');
        const ends = failingEnds(repository, 1);

        settle('failed');
        await released(target, 'user-held');
        await settled();
        expect(notices).toEqual([]);
        expect(retries).toHaveLength(1);

        retries.shift()?.();
        await until(() => notices.length > 0);
        await settled();

        expect(ends.attempts()).toBe(2);
        expect(notices).toEqual([endNotice('user-held', 'failed')]);
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          'failed',
        );
        await expect(runtimeOf(target)).resolves.toMatchObject({
          status: 'failed',
          activeTurn: { userMessageId: 'user-held' },
        });
      });
    });

    it("takes a failed setup's queued sends off the queue and records their ends in one commit", async () => {
      const { target, repository, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      await queueBehind(target, queue, 'user-last');
      const rowIdsBefore = {
        'user-next': await rowIdOf(target, 'user-next'),
      };
      const commits: ChatCoreMutation[][] = [];
      const transactWith = repository.transactWith.bind(repository);
      jest
        .spyOn(repository, 'transactWith')
        .mockImplementation(async (scope, build, options) => {
          const commit = await transactWith(scope, build, options);
          if (commit.applied) commits.push(commit.record.mutations);
          return commit;
        });

      settle('failed');
      await until(() => notices.length === 3);
      await settled();

      const recordsEnd = (
        mutations: ChatCoreMutation[],
        userMessageId: string,
      ): boolean =>
        mutations.some(
          (mutation) =>
            mutation.type === 'tab.metadata_patched' &&
            mutation.patch.unacceptedTurnEnds?.[userMessageId] === 'failed',
        );
      const removesFromQueue = (mutations: ChatCoreMutation[]): boolean =>
        mutations.some(
          (mutation) =>
            mutation.type === 'runtime.patched' &&
            !mutation.runtime.queuedMessageIds.includes(
              rowIdsBefore['user-next'],
            ),
        );
      const settlement = commits.filter((mutations) =>
        recordsEnd(mutations, 'user-next'),
      );
      expect(settlement).toHaveLength(1);
      expect(recordsEnd(settlement[0], 'user-last')).toBe(true);
      expect(commits.find(removesFromQueue)).toBe(settlement[0]);
      expect(settlement[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'runtime.patched',
            runtime: expect.objectContaining({
              status: 'failed',
              queuedMessageIds: [],
              queuedMessages: [],
            }),
          }),
        ]),
      );
      expect(notices).toEqual([
        endNotice('user-held', 'failed'),
        endNotice('user-next', 'failed'),
        endNotice('user-last', 'failed'),
      ]);
    });

    it.each(['failed', 'cancelled'] as const)(
      'keeps a setup that ended %s held, its queued sends durably queued, until the commit ending them succeeds',
      async (outcome) => {
        const retries: (() => void)[] = [];
        const notices: TurnNotice[] = [];
        let notifyQueuedTurnsEnded: () => void = () => undefined;
        const queuedTurnsEnded = new Promise<void>((resolve) => {
          notifyQueuedTurnsEnded = resolve;
        });
        const { target, repository, queue, settle } = heldService({
          overrides: {
            notifyTurnTerminal: async (notice) => {
              notices.push(notice);
              if (notices.length === 4) notifyQueuedTurnsEnded();
            },
            schedule: (callback) => {
              retries.push(callback);
              return setTimeout(() => undefined, 0);
            },
          },
        });
        await createChat(target);
        await send(target, 'user-held');
        await queueBehind(target, queue, 'user-next');
        await queueBehind(target, queue, 'user-last');
        let failEnds = true;
        const transactWith = repository.transactWith.bind(repository);
        jest
          .spyOn(repository, 'transactWith')
          .mockImplementation((scope, build, options) =>
            transactWith(
              scope,
              async (current, revision, context) => {
                const mutations = await build(current, revision, context);
                if (
                  failEnds &&
                  mutations.some(
                    (mutation) =>
                      mutation.type === 'tab.metadata_patched' &&
                      mutation.patch.unacceptedTurnEnds?.['user-next'] !==
                        undefined,
                  )
                )
                  throw new Error('The disk is full.');
                return mutations;
              },
              options,
            ),
          );

        settle(outcome);
        await until(() => retries.length === 1);
        await settled();

        expect(queue.holdsUserMessage(CHAT, 'user-next')).toBe(true);
        expect(queue.holdsUserMessage(CHAT, 'user-last')).toBe(true);
        expect(notices).toEqual([endNotice('user-held', outcome)]);
        expect(dispatched).toEqual([]);
        await queueBehind(target, queue, 'user-during-retry');

        const restarted = serviceWithRepository(
          {},
          copyDurableFilesAtBoundary(),
        ).target;
        const durable = await restarted.getState(SCOPE);
        const durableTab = durable.tabsFile.tabs.find(
          (tab) => tab.id === 'chat-1',
        );
        const durablyQueued = (
          durable.runtimeByChatId['chat-1']?.queuedMessages ?? []
        ).map((row) => row.request.userMessageId);
        for (const id of ['user-next', 'user-last', 'user-during-retry']) {
          expect(
            durablyQueued.includes(id) ||
              durableTab?.unacceptedTurnEnds?.[id] !== undefined,
          ).toBe(true);
          await expect(restarted.turnOutcome(turn(id))).resolves.toBe(
            'pending',
          );
        }
        expect(durablyQueued).toEqual([
          'user-next',
          'user-last',
          'user-during-retry',
        ]);
        await expect(restarted.turnOutcome(turn('user-held'))).resolves.toBe(
          outcome,
        );

        failEnds = false;
        retries.shift()?.();
        // Wait for the durable settlement signal, not filesystem wall time.
        await queuedTurnsEnded;
        expect(notices).toHaveLength(4);
        await settled();

        expect(retries).toEqual([]);
        expect(notices).toEqual([
          endNotice('user-held', outcome),
          endNotice('user-next', outcome),
          endNotice('user-last', outcome),
          endNotice('user-during-retry', outcome),
        ]);
        expect(dispatched).toEqual([]);
        for (const id of ['user-next', 'user-last', 'user-during-retry']) {
          expect(queue.holdsUserMessage(CHAT, id)).toBe(false);
          await expect(target.turnOutcome(turn(id))).resolves.toBe(outcome);
        }
        await expect(queuedUserMessageIds(target)).resolves.toEqual([]);
        await post(target, 'user-after');
        await until(() => dispatched.length === 1);
        expect(dispatchedIds()).toEqual(['user-after']);
      },
    );

    it('keeps the chat held and retries settling a failed setup whose queued sends could not be taken off the queue', async () => {
      const retries: (() => void)[] = [];
      const { target, queue, notices, settle } = heldService({
        overrides: {
          schedule: (callback) => {
            retries.push(callback);
            return setTimeout(() => undefined, 0);
          },
        },
      });
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      jest
        .spyOn(queue, 'takeWorktreeSetupHeldSends')
        .mockRejectedValueOnce(new Error('The disk is full.'));

      settle('failed');
      await until(() => retries.length === 1);
      await settled();

      expect(notices).toEqual([endNotice('user-held', 'failed')]);
      expect(dispatched).toEqual([]);
      expect(queue.holdsUserMessage(CHAT, 'user-next')).toBe(true);
      await queueBehind(target, queue, 'user-during-retry');

      retries.shift()?.();
      await until(() => notices.length === 3);
      await settled();

      expect(notices).toEqual([
        endNotice('user-held', 'failed'),
        endNotice('user-next', 'failed'),
        endNotice('user-during-retry', 'failed'),
      ]);
      expect(dispatched).toEqual([]);
      await post(target, 'user-after');
      await until(() => dispatched.length === 1);
      expect(dispatchedIds()).toEqual(['user-after']);
    });

    it('dispatches the turn once its setup is ready and ends nothing', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      expect(queue.holdsUserMessage(CHAT, 'user-held')).toBe(true);

      settle('ready');
      await released(target, 'user-held');

      expect(dispatchedIds()).toEqual(['user-held']);
      expect(notices).toEqual([]);
      await expect(runtimeOf(target)).resolves.toMatchObject({
        status: 'starting',
        activeTurn: { userMessageId: 'user-held' },
      });
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'pending',
      );
    });

    it('dispatches with the settings the chat holds when its setup is ready', async () => {
      const { target, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');

      await expect(
        target.command(
          envelope('patch-approval', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { approvalMode: 'full-access' },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        target.command(
          envelope('set-model', {
            type: 'chat.set_model',
            tabId: 'chat-1',
            model: 'gpt-6-sol',
            providerType: 'codex',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      settle('ready');
      await released(target, 'user-held');

      expect(dispatched).toEqual([
        expect.objectContaining({
          userMessageId: 'user-held',
          approvalMode: 'full-access',
          model: 'gpt-6-sol',
          providerType: 'codex',
        }),
      ]);
    });

    it.each([
      ['ask', ['user-held'], 'pending'],
      ['full-access', [], 'failed'],
    ] as const)(
      'checks the send admission again before dispatch when the chat switches to %s while setup is pending',
      async (switchedTo, expectedDispatched, outcome) => {
        const { target, notices, settle } = heldService();
        await createChat(target);
        const checked: unknown[] = [];
        await withChatSendAdmission(
          turn('user-held'),
          (tab) => {
            checked.push(tab.approvalMode);
            return tab.approvalMode === 'full-access'
              ? 'The chat would run with broader tool approvals.'
              : undefined;
          },
          () => send(target, 'user-held'),
        );
        await expect(
          target.command(
            envelope('patch-approval', {
              type: 'chat.patch_tab_settings',
              tabId: 'chat-1',
              patch: { approvalMode: switchedTo },
            }),
          ),
        ).resolves.toMatchObject({ outcome: 'applied' });

        settle('ready');
        await released(target, 'user-held');

        expect(checked).toEqual([undefined, switchedTo]);
        expect(dispatchedIds()).toEqual(expectedDispatched);
        await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
          outcome,
        );
        if (outcome === 'failed') {
          expect(notices).toEqual([
            endNotice(
              'user-held',
              'failed',
              'The chat would run with broader tool approvals.',
            ),
          ]);
          await expect(runtimeOf(target)).resolves.toMatchObject({
            status: 'failed',
            activeTurn: { userMessageId: 'user-held' },
            error: {
              message: 'The chat would run with broader tool approvals.',
            },
          });
        } else {
          expect(notices).toEqual([]);
        }
      },
    );

    it('ends a held turn whose dispatch fails through the turn lifecycle', async () => {
      const { target, notices, settle } = heldService({
        provider: async () => {
          throw new Error('The provider could not start.');
        },
      });
      await createChat(target);
      await send(target, 'user-held');

      settle('ready');
      await released(target, 'user-held');
      await until(() => notices.length > 0);

      expect(notices).toEqual([
        endNotice('user-held', 'failed', 'The provider could not start.'),
      ]);
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'failed',
      );
      await expect(runtimeOf(target)).resolves.toMatchObject({
        status: 'failed',
        activeTurn: { userMessageId: 'user-held' },
        error: { message: 'The provider could not start.' },
      });
    });

    it('queues later sends behind the held turn, in order, and runs them after it', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      await queueBehind(target, queue, 'user-last');

      await expect(queuedUserMessageIds(target)).resolves.toEqual([
        'user-next',
        'user-last',
      ]);
      await expect(runtimeOf(target)).resolves.toMatchObject({
        status: 'starting',
        activeTurn: { userMessageId: 'user-held' },
      });
      await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
        'pending',
      );

      settle('ready');
      await released(target, 'user-held');
      await settled();
      expect(dispatchedIds()).toEqual(['user-held']);

      queue.onTurnTerminal(CHAT, 'complete', 'user-held');
      await until(() => dispatched.length === 2);
      queue.onTurnTerminal(CHAT, 'complete', 'user-next');
      await until(() => dispatched.length === 3);

      expect(dispatchedIds()).toEqual(['user-held', 'user-next', 'user-last']);
      expect(notices).toEqual([]);
    });

    it('queues a send admitted after setup settles behind a held turn still dispatching', async () => {
      let releaseDispatch: () => void = () => undefined;
      const { target, queue, settle } = heldService({
        provider: async (request) => {
          if (request.userMessageId === 'user-held') {
            await new Promise<void>((resolve) => {
              releaseDispatch = resolve;
            });
          }
        },
      });
      await createChat(target);
      await send(target, 'user-held');

      settle('ready');
      await until(() => dispatched.length === 1);
      await post(target, 'user-after');
      expect(queue.holdsUserMessage(CHAT, 'user-after')).toBe(true);
      expect(dispatchedIds()).toEqual(['user-held']);

      releaseDispatch();
      await released(target, 'user-held');
      queue.onTurnTerminal(CHAT, 'complete', 'user-held');
      await until(() => dispatched.length === 2);

      expect(dispatchedIds()).toEqual(['user-held', 'user-after']);
    });

    it('stops only the held turn; queued sends wait for setup even after a Stop releases the queue', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');

      await cancelChatTurnPreparations(CHAT);
      queue.onTurnTerminal(CHAT, 'cancelled');
      await settled();

      expect(notices).toEqual([endNotice('user-held', 'cancelled')]);
      expect(dispatched).toEqual([]);
      expect(queue.holdsUserMessage(CHAT, 'user-next')).toBe(true);
      await queueBehind(target, queue, 'user-after-stop');
      await expect(queuedUserMessageIds(target)).resolves.toEqual([
        'user-next',
        'user-after-stop',
      ]);

      settle('ready');
      await until(() => dispatched.length === 1);
      queue.onTurnTerminal(CHAT, 'complete', 'user-next');
      await until(() => dispatched.length === 2);

      expect(dispatchedIds()).toEqual(['user-next', 'user-after-stop']);
      expect(notices).toHaveLength(1);
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'cancelled',
      );
    });

    it('never runs a queued send cancelled from the queue during the hold', async () => {
      const { target, queue, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-cancelled');
      await queueBehind(target, queue, 'user-kept');

      await expect(
        queue.cancel(CHAT, await rowIdOf(target, 'user-cancelled')),
      ).resolves.toBe('applied');
      await expect(queuedUserMessageIds(target)).resolves.toEqual([
        'user-kept',
      ]);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.map(
          (message) => message.id,
        ),
      ).toEqual(['user-held', 'user-kept']);

      settle('ready');
      await until(() => dispatched.length === 1);
      queue.onTurnTerminal(CHAT, 'complete', 'user-held');
      await until(() => dispatched.length === 2);
      await settled();

      expect(dispatchedIds()).toEqual(['user-held', 'user-kept']);
    });

    it('ends the held turn and every queued send, in order, when setup fails', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      await queueBehind(target, queue, 'user-last');

      settle('failed');
      await until(() => notices.length === 3);
      await settled();

      expect(dispatched).toEqual([]);
      expect(notices).toEqual([
        endNotice('user-held', 'failed'),
        endNotice('user-next', 'failed'),
        endNotice('user-last', 'failed'),
      ]);
      for (const id of ['user-held', 'user-next', 'user-last']) {
        await expect(target.turnOutcome(turn(id))).resolves.toBe('failed');
      }
      expect(queue.holdsUserMessage(CHAT, 'user-next')).toBe(false);
      await expect(queuedUserMessageIds(target)).resolves.toEqual([]);
      const ended = [
        'system',
        'turn_timer',
        1_786_104_000_000,
        1_786_104_000_000,
      ];
      expect(await transcriptOf(target)).toEqual([
        ['user', 'user-held'],
        ended,
        ['user', 'user-next'],
        ended,
        ['user', 'user-last'],
        ended,
      ]);
    });

    it('records how a queued send ended without disturbing another running turn', async () => {
      const { target, queue, notices, settle, beginSetup } = heldService({
        setupPending: false,
      });
      await createChat(target);
      await post(target, 'user-root');
      expect(dispatchedIds()).toEqual(['user-root']);
      beginSetup();
      await queueBehind(target, queue, 'user-held');

      settle('failed');
      await until(() => notices.length === 1);

      expect(dispatchedIds()).toEqual(['user-root']);
      expect(notices).toEqual([endNotice('user-held', 'failed')]);
      await expect(target.turnOutcome(turn('user-held'))).resolves.toBe(
        'failed',
      );
      await expect(runtimeOf(target)).resolves.toMatchObject({
        status: 'starting',
        activeTurn: { userMessageId: 'user-root' },
      });
    });

    it.each([
      'the chat queue',
      'the cancel command',
      'host queue reconciliation',
      'worktree deletion',
    ] as const)(
      'ends a watched send queued behind a running turn as cancelled when %s removes it',
      async (path) => {
        const events: unknown[] = [];
        mockWatcherService = {
          handleChatTerminalEvent: (event): Promise<void> => {
            events.push(event);
            return Promise.resolve();
          },
        };
        try {
          const { target, queue } = heldService({
            setupPending: false,
            overrides: { notifyTurnTerminal: undefined },
          });
          await createChat(target);
          await post(target, 'user-root');
          expect(dispatchedIds()).toEqual(['user-root']);
          await queueBehind(target, queue, 'user-queued');
          const rowId = await rowIdOf(target, 'user-queued');

          if (path === 'the chat queue') {
            await expect(queue.cancel(CHAT, rowId)).resolves.toBe('applied');
          } else if (path === 'the cancel command') {
            mockedGetChatQueueService.mockReturnValue(queue);
            await expect(
              target.command(
                envelope('cancel-queued', {
                  type: 'chat.cancel_queued_message',
                  chatId: 'chat-1',
                  queuedMessageId: rowId,
                }),
              ),
            ).resolves.toMatchObject({ outcome: 'applied' });
          } else if (path === 'host queue reconciliation') {
            const row = ((await runtimeOf(target))?.queuedMessages ?? []).find(
              (entry) => entry.id === rowId,
            );
            if (!row) throw new Error('No queued row');
            await target.reconcileHostQueue(
              CHAT,
              [],
              true,
              { type: 'cancel', request: row.request },
              [],
              'user-root',
            );
          } else {
            queue
              .beginWorktreeDeletion(SCOPE.projectId, SCOPE.worktreeId)
              .commit();
          }
          await until(() => events.length > 0);
          await settled();

          expect(events).toEqual([
            expect.objectContaining({
              scope: 'worktree',
              ...CHAT,
              status: 'cancelled',
              data: endNotice('user-queued', 'cancelled').data,
            }),
          ]);
          expect(dispatchedIds()).toEqual(['user-root']);
          if (path !== 'worktree deletion') {
            await expect(target.turnOutcome(turn('user-queued'))).resolves.toBe(
              'cancelled',
            );
            await expect(target.turnOutcome(turn('user-root'))).resolves.toBe(
              'pending',
            );
            await expect(runtimeOf(target)).resolves.toMatchObject({
              status: 'starting',
              activeTurn: { userMessageId: 'user-root' },
            });
            expect(
              (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.map(
                (message) => message.id,
              ),
            ).toEqual(['user-root']);
          }
        } finally {
          mockWatcherService = undefined;
        }
      },
    );

    it('keeps the chat open while sends are queued behind its held turn', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      await cancelChatTurnPreparations(CHAT);

      const close = envelope('close-1', {
        type: 'chat.close_tab',
        tabId: 'chat-1',
        mode: 'archive',
      });
      await expect(target.command(close)).resolves.toMatchObject({
        outcome: 'rejected',
      });
      await expect(
        queue.cancel(CHAT, await rowIdOf(target, 'user-next')),
      ).resolves.toBe('applied');
      await expect(
        target.command({ ...close, commandId: 'close-2' }),
      ).resolves.toMatchObject({ outcome: 'applied' });

      expect(notices).toEqual([
        endNotice('user-held', 'cancelled'),
        endNotice('user-next', 'cancelled'),
      ]);
      settle('ready');
      await released(target, 'user-held');
      await settled();
      expect(dispatched).toEqual([]);
      expect(notices).toHaveLength(2);
    });

    it("delivers a held turn's end to its chat's watchers as a provider's terminal event is", async () => {
      const events: unknown[] = [];
      mockWatcherService = {
        handleChatTerminalEvent: (event): Promise<void> => {
          events.push(event);
          return Promise.resolve();
        },
      };
      try {
        const { target, settle } = heldService({
          overrides: { notifyTurnTerminal: undefined },
        });
        await createChat(target);
        await send(target, 'user-held');

        settle('failed');
        await released(target, 'user-held');
        await until(() => events.length > 0);

        expect(events).toEqual([
          expect.objectContaining({
            scope: 'worktree',
            ...CHAT,
            status: 'failure',
            data: endNotice('user-held', 'failed').data,
          }),
        ]);
      } finally {
        mockWatcherService = undefined;
      }
    });

    it('neither dispatches nor ends a held turn or its queued sends once the service drains for shutdown', async () => {
      const { target, queue, notices, settle } = heldService();
      await createChat(target);
      await send(target, 'user-held');
      await queueBehind(target, queue, 'user-next');
      await expect(queuedUserMessageIds(target)).resolves.toEqual([
        'user-next',
      ]);

      await target.drain();
      settle('ready');
      await released(target, 'user-held');
      await settled();

      expect(dispatched).toEqual([]);
      expect(notices).toEqual([]);
      expect(queue.holdsUserMessage(CHAT, 'user-next')).toBe(true);
      expect(queue.holdsUserMessage(CHAT, 'user-held')).toBe(true);
    });
  });

  it("changes a chat's approval-state revision only when its mode, grants, or repository change", async () => {
    const { target } = serviceWithRepository();
    await createChat(target);
    const chat = { ...SCOPE, chatId: 'chat-1' };
    const grant = {
      id: 'grant-1',
      behavior: 'allow' as const,
      target: { kind: 'command' as const, pattern: 'npm publish' },
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt' as const,
    };
    const update = async (
      key: string,
      change: (tab: PersistedChatTab) => PersistedChatTab,
    ): Promise<number> => {
      const before = getChatApprovalStateRevision(chat);
      await target.updateCompatibilityTab(SCOPE, 'chat-1', change, key);
      return getChatApprovalStateRevision(chat) - before;
    };

    await expect(
      update('grant', (tab) => ({ ...tab, sessionApprovalRules: [grant] })),
    ).resolves.toBe(1);
    await expect(
      update('title', (tab) => ({ ...tab, title: 'Renamed' })),
    ).resolves.toBe(0);
    await expect(
      update('rollback', (tab) => ({ ...tab, sessionApprovalRules: [] })),
    ).resolves.toBe(1);
    await expect(
      update('mode', (tab) => ({ ...tab, approvalMode: 'ask' })),
    ).resolves.toBe(1);
    await expect(
      update('same mode', (tab) => ({ ...tab, approvalMode: 'ask' })),
    ).resolves.toBe(0);
    await expect(
      update('grant again', (tab) => ({
        ...tab,
        sessionApprovalRules: [grant],
      })),
    ).resolves.toBe(1);
    await expect(
      update('reordered grant', (tab) => ({
        ...tab,
        sessionApprovalRules: [
          {
            origin: grant.origin,
            createdAt: grant.createdAt,
            target: { pattern: 'npm publish', kind: 'command' },
            behavior: grant.behavior,
            id: grant.id,
          },
        ],
      })),
    ).resolves.toBe(0);
    const before = getChatApprovalStateRevision(chat);
    await expect(
      target.command(
        envelope('patch-same-mode', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { approvalMode: 'ask', title: 'Same mode' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(getChatApprovalStateRevision(chat) - before).toBe(0);
  });

  it('rejects closing a chat while its canonical runtime is active', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-active', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-active',
        text: 'Keep this turn alive',
      }),
    );

    await expect(
      target.command(
        envelope('close-active', {
          type: 'chat.close_tab',
          tabId: 'chat-1',
          mode: 'archive',
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('active'),
    });
    expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
  });

  it.each(['single', 'bulk'] as const)(
    'keeps a root-idle chat open during delegated work (%s)',
    async (kind) => {
      const target = service();
      await createChat(target);
      const sessionKey = `${SCOPE.projectId}/${SCOPE.worktreeId}/chat-1`;
      setDelegationActivity('test-delegation', sessionKey, 1);
      try {
        const command: ChatCommand =
          kind === 'single'
            ? { type: 'chat.close_tab', tabId: 'chat-1', mode: 'archive' }
            : {
                type: 'chat.close_tabs',
                targets: [{ tabId: 'chat-1', mode: 'archive' }],
              };
        await expect(
          target.command(envelope('close-child-active', command)),
        ).resolves.toMatchObject({
          outcome: 'rejected',
          reason: expect.stringContaining('active'),
        });
        expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
        setDelegationActivity('test-delegation', sessionKey, 0);
        await expect(
          target.command(envelope('close-child-settled', command)),
        ).resolves.toMatchObject({ outcome: 'applied' });
      } finally {
        setDelegationActivity('test-delegation', sessionKey, 0);
      }
    },
  );

  it('records a session diagnostic when a command is durably rejected', async () => {
    const diagnostics: SessionDiagnosticRecord[] = [];
    const { target } = serviceWithRepository({
      recordDiagnostic: (record) => diagnostics.push(record),
    });
    await createChat(target);
    await target.command(
      envelope('send-active', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-active',
        text: 'Keep this turn alive',
      }),
    );

    await expect(
      target.command(
        envelope('close-active', {
          type: 'chat.close_tab',
          tabId: 'chat-1',
          mode: 'archive',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'rejected' });

    expect(
      diagnostics.filter(({ kind }) => kind === 'chat_command_failed'),
    ).toEqual([
      expect.objectContaining({
        version: 1,
        kind: 'chat_command_failed',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: 'chat-1',
        chatCommandType: 'chat.close_tab',
        chatCommandId: 'close-active',
        chatCommandOutcome: 'rejected',
        error: expect.stringContaining('active'),
      }),
    ]);
  });

  it('forwards repository storage diagnostics to production diagnostics', async () => {
    const diagnostics: SessionDiagnosticRecord[] = [];
    const { target } = serviceWithRepository({
      recordDiagnostic: (record) => diagnostics.push(record),
    });

    await createChat(target);
    await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        version: 1,
        kind: 'chat_storage_diagnostic',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatStorageKind: 'checkpoint_completed',
        chatStorageAuthority: 'v2',
      }),
    );
  });

  it('records a legacy revision gap recovery as a worktree-scoped storage diagnostic', async () => {
    const diagnostics: SessionDiagnosticRecord[] = [];
    const chat = {
      id: 'owl-chat',
      title: 'Owl',
      createdAt: '2026-08-11T00:00:00.000Z',
      messages: [],
    };
    writeFileSync(
      paths.tabs,
      JSON.stringify({
        version: 1,
        revision: 20,
        activeTabId: chat.id,
        tabs: [chat],
      }),
    );
    writeFileSync(
      paths.archives,
      JSON.stringify({ version: 1, revision: 5, archived: [] }),
    );
    writeFileSync(
      paths.journal,
      `${JSON.stringify({
        v: 1,
        revision: 21,
        mutationId: 'after-gap',
        occurredAt: '2026-08-11T00:00:00.000Z',
        source: 'provider',
        mutations: [
          {
            type: 'tab.metadata_patched',
            tabId: chat.id,
            patch: { title: 'Owl 21' },
          },
        ],
      })}\n`,
    );
    const { target } = serviceWithRepository({
      recordDiagnostic: (record) => diagnostics.push(record),
    });

    await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);

    expect(
      diagnostics.filter(
        (record) =>
          record.chatStorageKind === 'legacy_chat_revision_gap_recovered',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'chat_storage_diagnostic',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: '',
        chatStorageAuthority: 'v2',
        chatStorageGapExpectedRevision: 6,
        chatStorageGapFoundRevision: 21,
        chatStorageGapNewestRevision: 20,
        chatStorageGapTabsRevision: 20,
        chatStorageGapArchiveRevision: 5,
        chatStorageGapStaleComponent: 'archives',
        chatStorageGapSkippedMutationCount: 0,
      }),
    ]);
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.title).toBe(
      'Owl 21',
    );
  });

  it('records one diagnostic per command, not per deduplicated caller', async () => {
    const diagnostics: SessionDiagnosticRecord[] = [];
    const { target } = serviceWithRepository({
      recordDiagnostic: (record) => diagnostics.push(record),
    });
    await createChat(target);
    await target.command(
      envelope('send-active', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-active',
        text: 'Keep this turn alive',
      }),
    );

    const close = envelope('close-active', {
      type: 'chat.close_tab',
      tabId: 'chat-1',
      mode: 'archive',
    });
    await Promise.all([target.command(close), target.command(close)]);

    expect(
      diagnostics.filter(({ kind }) => kind === 'chat_command_failed'),
    ).toHaveLength(1);
  });

  it('records a session diagnostic when a command throws, and still rethrows', async () => {
    const diagnostics: SessionDiagnosticRecord[] = [];
    const { target, repository } = serviceWithRepository({
      recordDiagnostic: (record) => diagnostics.push(record),
    });
    await createChat(target);
    jest
      .spyOn(repository, 'getReceipt')
      .mockRejectedValueOnce(new Error('journal read failed'));

    await expect(
      target.command(
        envelope('mark-read-1', { type: 'chat.mark_read', chatId: 'chat-1' }),
      ),
    ).rejects.toThrow('journal read failed');

    expect(
      diagnostics.filter(({ kind }) => kind === 'chat_command_failed'),
    ).toEqual([
      expect.objectContaining({
        kind: 'chat_command_failed',
        chatId: 'chat-1',
        chatCommandType: 'chat.mark_read',
        chatCommandId: 'mark-read-1',
        chatCommandOutcome: 'threw',
        error: 'journal read failed',
      }),
    ]);
  });

  it('does not hold the repository transaction while forcing a queued turn', async () => {
    const target = service();
    await createChat(target);
    let reentrantWriteTimedOut = false;
    queueForce.mockImplementationOnce(async () => {
      const reentrantWrite = target.upsertPendingQuestion(SCOPE, {
        requestId: 'force-question',
        chatId: 'chat-1',
        questions: [{ question: 'Continue?', options: ['Yes'] }],
      });
      const winner = await Promise.race([
        reentrantWrite.then(() => 'write' as const),
        new Promise<'timeout'>((resolve) =>
          // Under a lock regression this write cannot settle until queueForce
          // returns, so a generous deadline keeps the assertion meaningful
          // without depending on a busy CI runner scheduling it within 25 ms.
          setTimeout(() => resolve('timeout'), 1_000),
        ),
      ]);
      reentrantWriteTimedOut = winner === 'timeout';
      if (winner === 'write') await reentrantWrite;
      return 'applied';
    });

    await expect(
      target.command(
        envelope('force-queued', {
          type: 'chat.force_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queued-1',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(reentrantWriteTimedOut).toBe(false);
  });

  it('claims concurrent duplicate queue commands before mutating the queue', async () => {
    const target = service();
    await createChat(target);
    let releaseFirstCancel: (() => void) | undefined;
    let notifyFirstCancel: (() => void) | undefined;
    const firstCancelStarted = new Promise<void>((resolve) => {
      notifyFirstCancel = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstCancel = resolve;
    });
    queueCancel
      .mockImplementationOnce(async () => {
        notifyFirstCancel?.();
        await releaseFirst;
        await target.reconcileHostQueue(
          { ...SCOPE, chatId: 'chat-1' },
          [],
          true,
          {
            type: 'cancel',
            request: {
              ...SCOPE,
              chatId: 'chat-1',
              userMessageId: 'queued-1',
              text: 'Cancelled queued message',
            },
            commandResult: {
              commandId: 'cancel-queued-duplicate',
              outcome: 'applied',
              entityId: 'chat-1',
            },
          },
        );
        return 'applied';
      })
      .mockReturnValueOnce('not_found');
    const duplicateEnvelope = {
      ...envelope('cancel-queued-duplicate', {
        type: 'chat.cancel_queued_message' as const,
        chatId: 'chat-1',
        queuedMessageId: 'queued-1',
      }),
      expectedRevision: 1,
    };

    const first = target.command(duplicateEnvelope);
    await firstCancelStarted;
    const duplicate = target.command(duplicateEnvelope);
    releaseFirstCancel?.();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ outcome: 'applied', revision: 2 }),
      expect.objectContaining({ outcome: 'already_applied', revision: 2 }),
    ]);
    expect(queueCancel).toHaveBeenCalledTimes(1);
  });

  async function attachmentQueueFixture(): Promise<{
    target: ChatStateService;
    queue: ChatQueueService;
    dispatcher: ReturnType<typeof createDesktopRuntime>;
    attachments: Pick<
      ChatSendMessageRequest,
      'fileReferences' | 'attachmentPaths' | 'attachmentPromptContexts'
    >;
  }> {
    const directory = join(tempDir, `queue-fixture-${repositories.length}`);
    const target = serviceWithRepository(
      {},
      {
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      },
    ).target;
    await createChat(target);
    const queue = new ChatQueueService({
      dispatch: async () => undefined,
      cancel: async () => undefined,
      settleCancelledTurn: () => undefined,
      hasActiveProviderTurn: () => true,
      hasPendingProviderContinuation: () => false,
      persistRuntime: (...args) => target.reconcileHostQueue(...args),
      broadcast: () => undefined,
      createId: () => 'queue-1',
      now: () => 1234,
      schedule: () => {
        throw new Error('Unexpected queue drain');
      },
    });
    mockedGetChatQueueService.mockReturnValue(queue);
    const attachments = {
      fileReferences: [
        { absolutePath: '/tmp/context.txt', displayPath: 'context.txt' },
      ],
      attachmentPaths: ['/tmp/context.txt'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/tmp/context.txt',
          promptKind: 'linear-ticket' as const,
        },
      ],
    };
    await queue.submit(
      {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'queued-user',
        text: 'Original',
        ...attachments,
      },
      'desktop',
    );
    return {
      target,
      queue,
      attachments,
      dispatcher: createDesktopRuntime({ chatCommandPort: target }),
    };
  }

  it.each(['Updated', ''])(
    'preserves the host payload when Portal edits queued text to %j',
    async (text) => {
      const fixture = await attachmentQueueFixture();
      try {
        const edit = {
          ...envelope('portal-edit-attachments', {
            type: 'chat.edit_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'queue-1',
            text,
          }),
          origin: 'portal' as const,
        };
        const first = await fixture.target.command(edit);
        const retry = await fixture.target.command(edit);
        expect(first.outcome).toBe('applied');
        expect(retry).toMatchObject({
          outcome: 'already_applied',
          revision: first.revision,
        });
        expect(
          fixture.queue.getWorktreeSnapshots(
            SCOPE.projectId,
            SCOPE.worktreeId,
          )[0]?.queue[0],
        ).toMatchObject({
          id: 'queue-1',
          text,
          ...fixture.attachments,
        });
        const state = await fixture.target.getState(SCOPE);
        expect(state.queue[0]?.queue[0]).toMatchObject({
          text,
          ...fixture.attachments,
        });
      } finally {
        await fixture.dispatcher.shutdown();
      }
    },
  );

  const queueEditCaller = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'queue-equivalence',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop' as const,
    grants: ['core.chat.write'],
  };
  const canonicalQueueEdit = {
    scope: { workspaceId: SCOPE.projectId, worktreeId: SCOPE.worktreeId },
    commandId: 'edit-attachments',
    _meta: { idempotencyKey: 'edit-attachments' },
    chatId: 'chat-1',
    entryId: 'queue-1',
    mutation: {
      kind: 'edit' as const,
      text: 'Updated',
      inputMode: 'voice' as const,
    },
  };
  const queueEditOptions = {
    caller: queueEditCaller,
    metadata: { idempotencyKey: 'edit-attachments' },
  };

  it('preserves identical attachment-bearing queue entries through legacy IPC and canonical edits', async () => {
    const entries = [];
    const receipts = [];
    for (const path of ['legacy', 'canonical']) {
      const f = await attachmentQueueFixture();
      try {
        const revision = (await f.target.getState(SCOPE)).revision;
        const result =
          path === 'legacy'
            ? await dispatchChatCommandForLegacyIpc(
                {
                  ...envelope('edit-attachments', {
                    type: 'chat.edit_queued_message',
                    chatId: 'chat-1',
                    queuedMessageId: 'queue-1',
                    text: 'Updated',
                    inputMode: 'voice',
                    ...f.attachments,
                  }),
                  expectedRevision: revision,
                },
                createChatCommandDispatchOptions(
                  f.target,
                  f.dispatcher,
                  queueEditCaller,
                ),
              )
            : await f.dispatcher.instruction(
                'core.chat.queue.entry.update',
                canonicalQueueEdit,
                queueEditOptions,
              );
        expect(result.outcome).toBe('applied');
        receipts.push(result);
        const entry = f.queue.getWorktreeSnapshots(
          SCOPE.projectId,
          SCOPE.worktreeId,
        )[0]?.queue[0];
        expect(entry).toMatchObject({
          text: 'Updated',
          inputMode: 'voice',
          ...f.attachments,
        });
        entries.push(entry);
      } finally {
        await f.dispatcher.shutdown();
      }
    }
    expect(entries[1]).toEqual(entries[0]);
    expect(receipts[1]).toEqual(receipts[0]);
  });

  it.each([undefined, 2, 3])(
    'rejects a queue edit raced after the snapshot (expected revision %s)',
    async (expectedRevision) => {
      const f = await attachmentQueueFixture();
      const originalRead = f.target.getState.bind(f.target);
      jest.spyOn(f.target, 'getState').mockImplementationOnce(async (scope) => {
        const snapshot = await originalRead(scope);
        await f.target.command(
          envelope('concurrent-edit', {
            type: 'chat.edit_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'queue-1',
            text: 'Concurrent',
            attachmentPaths: ['/tmp/newer.txt'],
          }),
        );
        return snapshot;
      });
      try {
        const result = await f.dispatcher.instruction(
          'core.chat.queue.entry.update',
          {
            ...canonicalQueueEdit,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
          queueEditOptions,
        );
        expect(result.outcome).toBe('conflict');
        expect(
          f.queue.getWorktreeSnapshots(SCOPE.projectId, SCOPE.worktreeId)[0]
            ?.queue[0],
        ).toMatchObject({
          text: 'Concurrent',
          attachmentPaths: ['/tmp/newer.txt'],
        });
      } finally {
        await f.dispatcher.shutdown();
      }
    },
  );

  it('replays a canonical edit receipt after its queued entry has gone', async () => {
    const f = await attachmentQueueFixture();
    try {
      const applied = await f.dispatcher.instruction(
        'core.chat.queue.entry.update',
        canonicalQueueEdit,
        queueEditOptions,
      );
      await f.target.command(
        envelope('cancel-after-edit', {
          type: 'chat.cancel_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-1',
        }),
      );
      const read = jest.spyOn(f.target, 'getState');
      await expect(
        f.dispatcher.instruction(
          'core.chat.queue.entry.update',
          canonicalQueueEdit,
          queueEditOptions,
        ),
      ).resolves.toMatchObject({ ...applied, outcome: 'already_applied' });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await f.dispatcher.shutdown();
    }
  });

  it('returns not_found for a missing canonical queue edit without mutating state', async () => {
    const f = await attachmentQueueFixture();
    const command = jest.spyOn(f.target, 'command');
    try {
      await expect(
        f.dispatcher.instruction(
          'core.chat.queue.entry.update',
          { ...canonicalQueueEdit, entryId: 'missing' },
          queueEditOptions,
        ),
      ).resolves.toMatchObject({ outcome: 'not_found', revision: 2 });
      expect(command).not.toHaveBeenCalled();
    } finally {
      await f.dispatcher.shutdown();
    }
  });

  it('does not journal a queued-message command when the queue row is missing', async () => {
    const target = service();
    await createChat(target);
    queueEdit.mockReturnValueOnce('not_found');

    await expect(
      target.command(
        envelope('edit-missing-queued', {
          type: 'chat.edit_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'missing-row',
          text: 'No row to edit',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'not_found', revision: 1 });

    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('records a queue command receipt in the queue-runtime transaction', async () => {
    const target = service();
    await createChat(target);
    const command = envelope('cancel-queued-atomic', {
      type: 'chat.cancel_queued_message' as const,
      chatId: 'chat-1',
      queuedMessageId: 'queued-1',
    });
    const mutation = {
      type: 'cancel' as const,
      request: {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'queued-user-1',
        text: 'Cancel atomically',
      },
      commandResult: {
        commandId: command.commandId,
        outcome: 'applied' as const,
        entityId: 'chat-1',
      },
    };

    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      [],
      true,
      mutation,
    );
    queueCancel.mockReturnValueOnce('not_found');

    await expect(target.command(command)).resolves.toMatchObject({
      outcome: 'already_applied',
      entityId: 'chat-1',
    });
    expect(queueCancel).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'cancel',
      configure: (): void => {
        queueCancel.mockReturnValueOnce('not_found');
      },
      command: {
        type: 'chat.cancel_queued_message' as const,
        chatId: 'chat-1',
        queuedMessageId: 'missing-row',
      },
    },
    {
      label: 'force',
      configure: (): void => {
        queueForce.mockResolvedValueOnce('not_found');
      },
      command: {
        type: 'chat.force_queued_message' as const,
        chatId: 'chat-1',
        queuedMessageId: 'missing-row',
      },
    },
  ])('does not journal a missing queued-message $label', async (scenario) => {
    const target = service();
    await createChat(target);
    scenario.configure();

    await expect(
      target.command(envelope(`missing-${scenario.label}`, scenario.command)),
    ).resolves.toMatchObject({ outcome: 'not_found', revision: 1 });
    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('commits a user message before provider dispatch and derives settings from main state', async () => {
    const target = service();
    await createChat(target);
    const result = await target.command(
      envelope('send-1', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-1',
        text: 'Persist me first',
      }),
    );

    expect(result).toMatchObject({ outcome: 'applied', messageId: 'user-1' });
    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0]?.messages).toEqual([
      expect.objectContaining({ id: 'user-1', role: 'user' }),
    ]);
    expect(dispatched).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        userMessageId: 'user-1',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      }),
    ]);
  });

  it('dispatches revisioned sends with canonical approval settings', async () => {
    const target = service();
    const sessionApprovalRules = [
      {
        id: 'rule-1',
        behavior: 'allow' as const,
        target: { kind: 'tool' as const, toolName: 'Bash' },
        createdAt: '2026-09-18T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    await createChat(target);
    const created = await target.getState(SCOPE);
    const createdTab = created.tabsFile.tabs[0];
    if (!createdTab) throw new Error('Expected created chat tab');
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...created.tabsFile,
        tabs: [
          {
            ...createdTab,
            approvalMode: 'full-access',
            sessionApprovalRules,
          },
        ],
      },
      { authoritative: true },
    );

    await target.command(
      envelope('send-with-approval-settings', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-with-approval-settings',
        text: 'Preserve approval settings',
      }),
    );

    expect(dispatched).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        approvalMode: 'full-access',
        sessionApprovalRules,
      }),
    ]);
  });

  it.each([
    [
      'split-locked worktree',
      'split-lock',
      'Split PR workflow is in progress.',
    ],
    [
      'terminal-owned session',
      'terminal-owner',
      'Terminal-backed chats cannot be driven from the revisioned renderer.',
    ],
  ])(
    'rejects a revisioned send before persistence for a %s',
    async (_case, idSuffix, authorizationError) => {
      const repository = new ChatStateRepository({ resolvePaths: () => paths });
      repositories.push(repository);
      const authorizeSend = jest.fn(() =>
        Promise.reject(new Error(authorizationError)),
      );
      const options = {
        repository,
        now: () => 1_786_104_000_000,
        createId: () => 'event-id',
        dispatch: async (request: ChatSendMessageRequest): Promise<void> => {
          dispatched.push(request);
        },
        cleanupSession: async (): Promise<void> => undefined,
        authorizeSend,
      };
      const target = new ChatStateService(options);
      await createChat(target);

      await expect(
        target.command(
          envelope(`send-${idSuffix}`, {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: `message-${idSuffix}`,
            text: 'Do not persist an unauthorized prompt',
          }),
        ),
      ).rejects.toThrow(authorizationError);

      expect(authorizeSend).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([]);
      const snapshot = await target.getState(SCOPE);
      expect(snapshot.tabsFile.tabs[0]?.messages).toEqual([]);
      expect(snapshot.runtimeByChatId['chat-1']).toBeUndefined();
    },
  );

  it('keeps an edited host-queued prompt out of the transcript until dispatch', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-active', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-active',
        text: 'Active prompt',
      }),
    );
    const before = await target.getState(SCOPE);

    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      ['queue-1'],
      true,
      {
        type: 'edit',
        request: {
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'user-queued',
          text: 'Edited queued prompt',
        },
      },
    );

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']?.queuedMessageIds).toEqual([
      'queue-1',
    ]);
    expect(snapshot.tabsFile.tabs[0]?.messages).toEqual(
      before.tabsFile.tabs[0]?.messages,
    );
    expect(dispatched).toHaveLength(1);
  });

  it('keeps the running turn identity when a later Portal send is host-queued', async () => {
    const target = serviceWithRepository({
      dispatch: async (request) => {
        dispatched.push(request);
        if (request.userMessageId !== 'user-queued') return;
        await target.reconcileHostQueue(
          { ...SCOPE, chatId: 'chat-1' },
          ['queue-1'],
          true,
          undefined,
          [
            {
              id: 'queue-1',
              request,
              origin: 'portal',
              enqueuedAtMs: 1_786_104_000_001,
            },
          ],
          'user-root',
        );
      },
    }).target;
    await createChat(target);

    await target.command(
      envelope('send-root', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-root',
        text: 'Keep working',
      }),
    );
    await target.command(
      envelope('send-queued', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-queued',
        text: 'Wait behind the running turn',
      }),
    );

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']).toMatchObject({
      activeTurn: { userMessageId: 'user-root' },
      queuedMessageIds: ['queue-1'],
    });
  });

  it('places a queued Portal prompt after the running turn reply when it starts', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-root', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-root',
        text: 'First prompt',
      }),
    );
    await target.command({
      ...envelope('send-queued', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-queued',
        text: 'Queued prompt',
      }),
      origin: 'portal',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-root',
      mutationId: 'root-reply',
      data: {
        type: 'assistant',
        message: {
          id: 'root-reply',
          role: 'assistant',
          content: [{ type: 'text', text: 'First reply' }],
        },
      },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-root',
      mutationId: 'root-complete',
      data: { type: 'result', is_error: false, result: 'First reply' },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-queued',
      mutationId: 'queued-prompt-start',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'user-queued',
      },
    });

    const messages = (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages;
    expect(messages?.map((message) => message.id)).toEqual([
      'user-root',
      expect.stringContaining('root-reply'),
      'user-queued',
    ]);
  });

  it('keeps the running turn alive when a queued Portal send fails', async () => {
    const { target } = serviceWithRepository({
      dispatch: async (request) => {
        if (request.userMessageId === 'user-queued') {
          throw new Error('Queue persistence failed');
        }
        dispatched.push(request);
      },
    });
    await createChat(target);
    await target.command(
      envelope('send-root', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-root',
        text: 'Keep working',
      }),
    );
    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      ['queue-existing'],
      true,
    );

    await expect(
      target.command({
        ...envelope('send-queued', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-queued',
          text: 'Queue this follow-up',
        }),
        origin: 'portal',
      }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'Queue persistence failed',
    });

    const afterFailure = await target.getState(SCOPE);
    expect(afterFailure.runtimeByChatId['chat-1']).toMatchObject({
      status: 'starting',
      activeTurn: { userMessageId: 'user-root' },
      queuedMessageIds: ['queue-existing'],
    });
    expect(
      afterFailure.tabsFile.tabs[0]?.messages.some(
        (message) => message.id === 'user-queued',
      ),
    ).toBe(false);
    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-root',
        mutationId: 'root-reply-after-queue-failure',
        data: {
          type: 'assistant',
          message: {
            id: 'root-reply',
            role: 'assistant',
            content: [{ type: 'text', text: 'Still running' }],
          },
        },
      }),
    ).resolves.toBe(true);
  });

  it.each(['starting', 'streaming', 'awaiting_input', 'completing'] as const)(
    'accepts running-turn output and completion during a Portal send while %s',
    async (status) => {
      const observations: Array<{
        accepted: boolean;
        completed: boolean;
        runtime: unknown;
      }> = [];
      const { target, repository } = serviceWithRepository({
        dispatch: async (request) => {
          dispatched.push(request);
          if (request.userMessageId !== 'user-queued') return;
          // The send is durable, but host queue reconciliation has not run yet.
          const snapshot = await target.getState(SCOPE);
          expect(snapshot.tabsFile.tabs[0]?.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: 'user-queued' }),
            ]),
          );
          const accepted = await target.ingestProviderEvent({
            ...SCOPE,
            chatId: 'chat-1',
            turnUserMessageId: 'user-root',
            mutationId: 'root-output-during-send',
            data: {
              type: 'assistant',
              message: {
                id: 'root-native-message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Output during queued send' }],
              },
            },
          });
          const completed = await target.ingestProviderEvent({
            ...SCOPE,
            chatId: 'chat-1',
            turnUserMessageId: 'user-root',
            mutationId: 'root-completion-during-send',
            data: { type: 'result', is_error: false, result: 'Root completed' },
          });
          observations.push({
            accepted,
            completed,
            runtime: snapshot.runtimeByChatId['chat-1'],
          });
        },
      });
      await createChat(target);
      await target.command(
        envelope('send-root', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-root',
          text: 'Keep working',
        }),
      );
      await repository.transact(
        SCOPE,
        [
          ...(status === 'awaiting_input'
            ? [
                {
                  type: 'pending_question.upserted' as const,
                  question: {
                    requestId: 'root-question',
                    chatId: 'chat-1',
                    questions: [
                      { id: '0', question: 'Which scope?', options: ['Full'] },
                    ],
                  },
                },
              ]
            : []),
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status,
              activeTurn: { userMessageId: 'user-root', startedAt: 123 },
              queuedMessageIds: ['already-queued'],
            },
          },
        ],
        { source: 'provider' },
      );
      await expect(
        target.command({
          ...envelope('send-queued', {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: 'user-queued',
            text: 'Wait behind the running turn',
          }),
          origin: 'portal',
        }),
      ).resolves.toMatchObject({ outcome: 'applied' });
      expect(observations).toEqual([
        {
          accepted: true,
          completed: true,
          runtime: expect.objectContaining({
            status,
            activeTurn: { userMessageId: 'user-root', startedAt: 123 },
            queuedMessageIds: ['already-queued'],
          }),
        },
      ]);
      const finalState = await target.getState(SCOPE);
      expect(finalState.runtimeByChatId['chat-1']?.status).toBe('completed');
      expect(JSON.stringify(finalState.tabsFile.tabs[0]?.messages)).toContain(
        'Output during queued send',
      );
    },
  );

  it('updates the durable user message in the queue-runtime transaction', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-editable', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-editable',
        text: 'Original queued prompt',
      }),
    );

    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'chat-1' },
      ['queue-1'],
      true,
      {
        type: 'edit',
        request: {
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'user-editable',
          text: 'Edited queued prompt',
        },
      },
    );

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.tabsFile.tabs[0]?.messages).toEqual([
      expect.objectContaining({
        id: 'user-editable',
        blocks: [
          expect.objectContaining({
            type: 'text',
            text: 'Edited queued prompt',
          }),
        ],
      }),
    ]);
    expect(snapshot.runtimeByChatId['chat-1']?.queuedMessageIds).toEqual([
      'queue-1',
    ]);
  });

  it('persists organization memory metadata through provider ingestion', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-memory-prompt', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'memory-user',
        text: 'How do releases work?',
      }),
    );

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'memory-used-event',
      data: {
        type: 'org_memory_used',
        localChatId: 'chat-1',
        localMessageId: 'memory-user',
        searchId: '22222222-2222-4222-8222-222222222222',
        facts: [
          {
            factId: '11111111-1111-4111-8111-111111111111',
            factText: 'Releases use a weekly release train.',
            validAt: '2026-07-22',
            sourceTurnIds: ['source-turn-1'],
          },
        ],
      },
    });

    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.memoryByMessageId,
    ).toEqual({
      'memory-user': {
        searchId: '22222222-2222-4222-8222-222222222222',
        facts: [
          {
            factId: '11111111-1111-4111-8111-111111111111',
            factText: 'Releases use a weekly release train.',
            validAt: '2026-07-22',
            sourceTurnIds: ['source-turn-1'],
          },
        ],
      },
    });
  });

  it('persists delivered memory against canonical state while a newer provider event advances the snapshot', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-memory-race', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'memory-user',
        text: 'How do releases work?',
      }),
    );
    const staleTabs = await target.getCompatibilityTabs(SCOPE);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'newer-provider-message',
      data: {
        type: 'assistant',
        message: {
          id: 'newer-answer',
          content: [
            { type: 'text', text: 'The concurrent answer is retained.' },
          ],
        },
      },
    });
    const currentMessages = (await target.getState(SCOPE)).tabsFile.tabs[0]
      ?.messages;
    expect(
      currentMessages?.some((message) => message.role === 'assistant'),
    ).toBe(true);
    const singleton = jest
      .spyOn(chatStateServiceModule, 'getChatStateService')
      .mockReturnValue(target);
    const compatibilityRead = jest
      .spyOn(target, 'getCompatibilityTabs')
      .mockResolvedValue(staleTabs);
    try {
      await expect(
        persistOrgMemoryUsedForChat({
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'memory-user',
          searchId: 'memory-search',
          facts: [
            {
              factText: 'Releases use a weekly release train.',
              validAt: null,
              sourceTurnIds: ['source-turn'],
            },
          ],
        }),
      ).resolves.toBe(true);
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab?.messages).toEqual(currentMessages);
      expect(tab?.memoryByMessageId?.['memory-user']).toMatchObject({
        searchId: 'memory-search',
        facts: [{ factText: 'Releases use a weekly release train.' }],
      });
    } finally {
      compatibilityRead.mockRestore();
      singleton.mockRestore();
    }
  });

  it('does not attach a late memory disclosure to an absent user message', async () => {
    const target = service();
    await createChat(target);
    const singleton = jest
      .spyOn(chatStateServiceModule, 'getChatStateService')
      .mockReturnValue(target);
    try {
      await expect(
        persistOrgMemoryUsedForChat({
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'removed-user',
          facts: [
            { factText: 'Late memory.', validAt: null, sourceTurnIds: [] },
          ],
        }),
      ).resolves.toBe(false);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0]?.memoryByMessageId,
      ).toBeUndefined();
    } finally {
      singleton.mockRestore();
    }
  });

  it('removes a cancelled queued prompt in the queue-runtime transaction', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-cancellable', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-cancellable',
        text: 'Cancel this queued prompt',
      }),
    );

    await target.reconcileHostQueue({ ...SCOPE, chatId: 'chat-1' }, [], true, {
      type: 'cancel',
      request: {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'user-cancellable',
        text: 'Cancel this queued prompt',
      },
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.tabsFile.tabs[0]?.messages).toEqual([]);
    expect(snapshot.runtimeByChatId['chat-1']?.queuedMessageIds).toEqual([]);
    await expect(
      target.turnOutcome({
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'user-cancellable',
      }),
    ).resolves.toBe('cancelled');
  });

  it('removes a delegated prompt that was never accepted by its parent turn', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-delegated-result', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'delegated-result',
        text: 'A delegated task has finished.',
      }),
    );

    await target.removeUnacceptedUserPrompt({
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'delegated-result',
    });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.messages).toEqual(
      [],
    );
  });

  it('atomically records the first-send watcher transition before dispatch', async () => {
    const target = service();
    await createChat(target);

    await target.command(
      envelope('send-first', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-first',
        text: 'Start the tracked chat',
      }),
    );

    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab).toMatchObject({
      newChatStartedWatcherFiredAt: '2026-08-07T12:00:00.000Z',
    });
    expect(tab?.newChatStartedWatcherPending).toBeUndefined();
    expect(dispatched[0]).toMatchObject({ startsNewTrackedChat: true });

    await target.command(
      envelope('send-follow-up', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-follow-up',
        text: 'Follow up',
      }),
    );
    expect(dispatched[1]).not.toHaveProperty('startsNewTrackedChat');
  });

  it('clears the scheduled draft and consumed revert attachment in one command', async () => {
    const target = service();
    await createChat(target);
    const created = await target.getState(SCOPE);
    const createdTab = created.tabsFile.tabs[0];
    if (!createdTab) throw new Error('Expected created chat tab');
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...created.tabsFile,
        tabs: [
          {
            ...createdTab,
            scheduledSendDraft: { runAt: '2099-01-01T00:00:00.000Z' },
            pendingRevertAttachmentPath: '/attachments/revert.md',
          },
        ],
      },
      { authoritative: true },
    );

    await expect(
      target.command(
        envelope('clear-scheduled-composer', {
          type: 'chat.set_scheduled_send_draft',
          chatId: 'chat-1',
          draft: null,
          clearPendingRevertAttachment: true,
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab?.scheduledSendDraft).toBeUndefined();
    expect(tab?.pendingRevertAttachmentPath).toBeUndefined();
  });

  it('does not resurrect a tombstoned fork target id', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-source', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'source-message',
        text: 'Fork source',
      }),
    );
    await target.command(
      envelope('create-target', {
        type: 'chat.create_tab',
        tabId: 'fork-target',
        title: 'Temporary target',
      }),
    );
    await target.command(
      envelope('remove-target', {
        type: 'chat.close_tab',
        tabId: 'fork-target',
        mode: 'discard_empty',
      }),
    );

    await expect(
      target.command(
        envelope('fork-tombstoned-target', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'fork-target',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'not_found' });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.some(
        (tab) => tab.id === 'fork-target',
      ),
    ).toBe(false);
  });

  it.each(['visible-transcript', 'continuation'] as const)(
    'does not inherit source OpenCode plan approval in a %s fork',
    async (cloneMode) => {
      const target = service();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...initial.tabsFile,
          tabs: [
            {
              ...initial.tabsFile.tabs[0],
              providerType: 'opencode',
              model: 'opencode:fixture%2Fmodel',
              planMode: true,
              trackedPlanId: 'source-plan',
              trackedPlanSource: 'opencode',
              trackedPlanReviewStatus: 'pending',
              latestRevisionNumber: 1,
              hasOutstandingProposal: true,
              pendingPlanExitRequestId: 'source-request',
              pendingPlanExit: { source: 'opencode', plan: 'source-plan' },
              pendingSystemInstructions: [
                { id: 'source-hidden', text: 'SOURCE_HIDDEN_INSTRUCTIONS' },
              ],
              messages: [
                {
                  id: 'anchor',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'Selected visible input' }],
                },
              ],
            },
          ],
        },
        'seed-plan-fork',
      );
      await target.command(
        envelope('fork-pending-plan', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'fork-plan',
          ...(cloneMode === 'continuation'
            ? {
                cloneMode,
                destinationTab: {
                  ...initial.tabsFile.tabs[0],
                  id: 'fork-plan',
                  messages: [],
                },
              }
            : { atMessageId: 'anchor' }),
        }),
      );
      const fork = (await target.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'fork-plan',
      );
      expect(fork?.planMode).toBe(true);
      expect(fork?.trackedPlanId).toBeUndefined();
      expect(fork?.pendingPlanExitRequestId).toBeUndefined();
      expect(fork?.pendingPlanExit).toBeUndefined();
      expect(fork?.trackedPlanSource).toBeUndefined();
      expect(fork?.trackedPlanReviewStatus).toBeUndefined();
      expect(fork?.latestRevisionNumber).toBeUndefined();
      expect(fork?.hasOutstandingProposal).toBeUndefined();
      if (cloneMode !== 'continuation')
        expect(fork?.pendingSystemInstructions).toBeUndefined();
      const source = (await target.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'chat-1',
      );
      expect(source?.trackedPlanId).toBe('source-plan');
      expect(source?.trackedPlanReviewStatus).toBe('pending');
    },
  );

  it.each([false, true])(
    'marks an ordinary OpenCode fork from its canonical anchor, supplied metadata=%s',
    async (suppliedMetadata) => {
      const target = service();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      const source = initial.tabsFile.tabs[0];
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...initial.tabsFile,
          tabs: [
            {
              ...source,
              providerType: 'opencode',
              model: 'opencode:fixture%2Fmodel',
              sdkSessionId: 'source-private-native-session',
              messages: [
                {
                  id: 'source-user',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'FORK_KEEP_ALPHA' }],
                },
                {
                  id: 'selected-reply',
                  role: 'assistant',
                  timestamp: 2,
                  blocks: [{ type: 'text', text: 'FORK_KEEP_REPLY' }],
                },
                {
                  id: 'later-user',
                  role: 'user',
                  timestamp: 3,
                  blocks: [{ type: 'text', text: 'FORK_OMIT_OMEGA' }],
                },
              ],
            },
          ],
        },
        'seed-opencode-visible-fork',
      );
      await expect(
        target.command(
          envelope('historical-opencode-fork', {
            type: 'chat.fork_tab',
            sourceTabId: 'chat-1',
            targetTabId: 'historical-fork',
            atMessageId: 'selected-reply',
            ...(suppliedMetadata
              ? {
                  destinationTab: {
                    ...source,
                    id: 'historical-fork',
                    messages: [],
                    forkedFrom: {
                      projectId: 'wrong-project',
                      worktreeId: 'wrong-worktree',
                      chatId: 'wrong-chat',
                      atMessageId: 'later-user',
                      continuedFromProvider: 'claude' as const,
                    },
                  },
                }
              : {}),
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const fork = (await target.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'historical-fork',
      );
      expect(fork?.sdkSessionId).toBeUndefined();
      expect(fork?.forkedFrom).toEqual({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: 'chat-1',
        modelContext: 'visible-transcript',
        atMessageId: 'selected-reply',
      });
      await target.command(
        envelope('continue-visible-fork', {
          type: 'chat.send_message',
          chatId: 'historical-fork',
          userMessageId: 'new-question',
          text: 'Continue from that answer.',
        }),
      );
      const dispatchedRequest = JSON.stringify(dispatched.at(-1));
      expect(dispatchedRequest).not.toContain('FORK_OMIT_OMEGA');
      expect(dispatchedRequest).not.toContain('source-private-native-session');
      expect(
        (
          await target.getCompatibilityTabs(SCOPE, {
            chatIds: ['chat-1'],
            fullTranscript: true,
          })
        ).tabs.find((tab) => tab.id === 'chat-1')?.messages,
      ).toHaveLength(3);
    },
  );

  it.each([true, false])(
    'keeps OpenCode reports only at the source tip, truncated=%s',
    async (truncated) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      const source = initial.tabsFile.tabs[0];
      const report = { context: { usedTokens: 1234, maxTokens: 10000 } };
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...initial.tabsFile,
          tabs: [
            {
              ...source,
              providerType: 'opencode',
              model: 'opencode:fixture%2Fmodel',
              usage: {
                contextTokens: 1234,
                contextWindow: 10000,
                maxOutputTokens: 0,
                totalCostUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                durationMs: 0,
                durationApiMs: 0,
                numTurns: 2,
                model: 'opencode:fixture%2Fmodel',
                opencodeReportedUsage: report,
              },
              messages: [1, 2].map((timestamp) => ({
                id: `reply-${timestamp}`,
                role: 'assistant',
                timestamp,
                blocks: [{ type: 'text', text: `Reply ${timestamp}` }],
              })),
            },
          ],
        },
        { authoritative: true },
      );
      await expect(
        target.command(
          envelope('fork-opencode-usage', {
            type: 'chat.fork_tab',
            sourceTabId: source.id,
            targetTabId: 'fork-target',
            ...(truncated ? { atMessageId: 'reply-1' } : {}),
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await repository.drainAll();
      const restored = await service().getState(SCOPE);
      const fork = restored.tabsFile.tabs.find(
        (tab) => tab.id === 'fork-target',
      );
      expect(fork?.usage?.opencodeReportedUsage).toEqual(
        truncated ? undefined : report,
      );
      expect(fork?.usage?.contextTokens).toBe(truncated ? 0 : 1234);
      expect(fork?.usage?.contextWindow).toBe(truncated ? 0 : 10000);
      expect(
        restored.tabsFile.tabs.find((tab) => tab.id === source.id)?.usage
          ?.opencodeReportedUsage,
      ).toEqual(report);
    },
  );

  it('carries trusted sender provenance through an asynchronous question answer', async () => {
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Web MCP Agent',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };
    const trustedOptions = { agentSent };
    const { target, repository } = serviceWithRepository({
      steer: async () => false,
    });
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'pending_question.upserted',
          question: {
            requestId: 'trusted-async-question',
            chatId: 'chat-1',
            delivery: 'async',
            questions: [
              { id: '0', question: 'Which scope?', options: ['Full'] },
            ],
          },
        },
      ],
      { source: 'provider', mutationId: 'seed-trusted-async-question' },
    );

    await expect(
      target.command(
        envelope('trusted-async-answer', {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'trusted-async-question',
          answers: [
            {
              questionId: '0',
              question: 'Which scope?',
              selectedOptions: ['Full'],
            },
          ],
        }),
        trustedOptions,
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.agentSent).toEqual(agentSent);
    const answerMessage = (
      await target.getState(SCOPE)
    ).tabsFile.tabs[0]?.messages.find((message) => message.role === 'user');
    expect(answerMessage?.agentSent).toEqual(agentSent);
  });

  it.each([true, false])(
    'persists only applicable Cursor response usage when fork is truncated=%s',
    async (truncated) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      const source = initial.tabsFile.tabs[0];
      const usage = {
        contextTokens: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        model: 'cursor-default',
        totalCostUsd: 0,
        inputTokens: 12000,
        outputTokens: 800,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 500,
        durationMs: 1000,
        durationApiMs: 900,
        numTurns: 2,
        cursorReportedUsage: { inputTokens: 12000, outputTokens: 800 },
      };
      const sourceWithUsage: PersistedChatTab = {
        ...source,
        providerType: 'cursor',
        model: 'cursor-default',
        usage,
        messages: [
          {
            id: 'first-reply',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Earlier reply' }],
            timestamp: 1,
          },
          {
            id: 'latest-reply',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Latest reply' }],
            timestamp: 2,
          },
        ],
      };
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...initial.tabsFile,
          tabs: [sourceWithUsage],
        },
        { authoritative: true },
      );
      await expect(
        target.command(
          envelope('fork-cursor-usage', {
            type: 'chat.fork_tab',
            sourceTabId: source.id,
            targetTabId: 'fork-target',
            ...(truncated
              ? {
                  atMessageId: 'first-reply',
                  destinationTab: {
                    ...sourceWithUsage,
                    id: 'fork-target',
                    messages: [],
                  },
                }
              : {}),
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await repository.drainAll();
      // Reload the durable state, not just the optimistic renderer fork.
      const restored = await service().getState(SCOPE);
      const fork = restored.tabsFile.tabs.find(
        (tab) => tab.id === 'fork-target',
      );
      if (!fork) throw new Error('Expected durable fork');
      expect(fork.messages).toHaveLength(truncated ? 1 : 2);
      const { cursorReportedUsage, ...cumulativeUsage } = usage;
      expect(fork.usage).toEqual(truncated ? cumulativeUsage : usage);
      expect(
        restored.tabsFile.tabs.find((tab) => tab.id === source.id)?.usage
          ?.cursorReportedUsage,
      ).toEqual(cursorReportedUsage);
    },
  );

  it.each([
    {
      label: 'keeps the Claude session when the kept range has a chain uuid',
      claudeUuid: '11111111-1111-4111-8111-111111111111',
      expectedSession: 'source-session',
      expectedForkOnNextSend: true,
      expectedModelContext: undefined,
      expectedResumePointRequired: true,
    },
    {
      label: 'starts fresh and records it when no chain uuid exists',
      claudeUuid: undefined,
      expectedSession: undefined,
      expectedForkOnNextSend: undefined,
      expectedModelContext: 'fresh',
      expectedResumePointRequired: undefined,
    },
  ])(
    'truncated Claude fork $label',
    async ({
      claudeUuid,
      expectedSession,
      expectedForkOnNextSend,
      expectedModelContext,
      expectedResumePointRequired,
    }) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const initial = await target.getState(SCOPE);
      const source = initial.tabsFile.tabs[0];
      if (!source) throw new Error('Expected source chat');
      const messages: PersistedChatMessage[] = [
        {
          id: 'u1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'First' }],
        },
        {
          id: 'a1',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'First answer' }],
          ...(claudeUuid ? { claudeUuid } : {}),
        },
        {
          id: 'timer-1',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
        },
        {
          id: 'u2',
          role: 'user',
          timestamp: 4,
          blocks: [{ type: 'text', text: 'Second' }],
        },
      ];
      await target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...initial.tabsFile,
          tabs: [
            {
              ...source,
              providerType: 'claude',
              sdkSessionId: 'source-session',
              messages,
            },
          ],
        },
        { authoritative: true },
      );

      await expect(
        target.command(
          envelope('fork-truncated-claude', {
            type: 'chat.fork_tab',
            sourceTabId: source.id,
            targetTabId: 'fork-target',
            atMessageId: 'timer-1',
            sourceSdkSessionId: 'source-session',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      const fork = (
        await repository.getState(SCOPE, {
          chatIds: ['fork-target'],
          fullTranscript: true,
        })
      ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
      if (!fork) throw new Error('Expected durable fork');
      expect(fork.messages.map(({ id }) => id)).toEqual([
        'u1',
        'a1',
        'timer-1',
      ]);
      expect(fork.sdkSessionId).toBe(expectedSession);
      expect(fork.claudeForkSessionOnNextSend).toBe(expectedForkOnNextSend);
      expect(fork.forkedFrom?.modelContext).toBe(expectedModelContext);
      expect(fork.forkedFrom?.resumePointRequired).toBe(
        expectedResumePointRequired,
      );
    },
  );

  it('forks from the source snapshot serialized inside the journal transaction', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await target.command(
      envelope('send-source-before-fork', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'source-user',
        text: 'Source prompt',
      }),
    );
    const staleState = await repository.getState(SCOPE);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'source-user',
      mutationId: 'source-assistant-before-fork',
      data: {
        type: 'assistant',
        message: {
          id: 'source-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'Committed after the stale read' }],
        },
      },
    });
    const staleRead = jest
      .spyOn(repository, 'getState')
      .mockResolvedValueOnce(staleState);

    await expect(
      target.command(
        envelope('fork-after-concurrent-source-commit', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'fork-target',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    staleRead.mockRestore();
    const fork = (
      await repository.getState(SCOPE, {
        chatIds: ['fork-target'],
        fullTranscript: true,
      })
    ).tabsFile.tabs.find((tab) => tab.id === 'fork-target');
    expect(fork?.messages.map(({ id }) => id)).toContain('source-assistant');
  });

  it('continues a full canonical transcript into target-provider metadata', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const created = await repository.getState(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    const source = created.tabsFile.tabs[0];
    if (!source) throw new Error('Expected source chat');
    const messages: PersistedChatMessage[] = Array.from(
      { length: 620 },
      (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        timestamp: index,
        blocks: [{ type: 'text' as const, text: `message ${index}` }],
      }),
    );
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...created.tabsFile,
        tabs: [{ ...source, messages }],
      },
      { authoritative: true },
    );

    await expect(
      target.command(
        envelope('continue-full-history', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'continued',
          atMessageId: 'message-619',
          cloneMode: 'continuation',
          destinationTab: {
            ...source,
            id: 'continued',
            title: 'Continued on Codex',
            createdAt: '2026-09-09T00:00:00.000Z',
            messages: [],
            providerType: 'codex',
            model: 'gpt-5.5',
            pendingSystemInstructions: [
              { id: 'handoff', text: 'Canonical handoff summary' },
            ],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const continued = (
      await repository.getState(SCOPE, {
        chatIds: ['continued'],
        fullTranscript: true,
      })
    ).tabsFile.tabs.find((tab) => tab.id === 'continued');
    expect(continued).toMatchObject({
      title: 'Continued on Codex',
      providerType: 'codex',
      model: 'gpt-5.5',
      pendingSystemInstructions: [
        { id: 'handoff', text: 'Canonical handoff summary' },
      ],
    });
    expect(continued?.messages).toHaveLength(620);
    expect(continued?.sdkSessionId).toBeUndefined();
  }, 120_000);

  it('preserves portal origin when a stable-id send reaches the queue host', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      cleanupSession: async () => undefined,
    });
    await createChat(target);
    const queueService = mockedGetChatQueueService();
    const submit = jest.spyOn(queueService, 'submit').mockResolvedValue();
    const portalEnvelope = {
      ...envelope('portal-stable-id-send', {
        type: 'chat.send_message' as const,
        chatId: 'chat-1',
        userMessageId: 'portal-user',
        text: 'Send from the portal',
      }),
      origin: 'portal' as const,
    };

    await expect(target.command(portalEnvelope)).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: 'portal-user' }),
      'portal',
    );
  });

  it('dispatches a concurrently retried send command exactly once', async () => {
    const target = service();
    await createChat(target);
    const send = envelope('send-once', {
      type: 'chat.send_message' as const,
      chatId: 'chat-1',
      userMessageId: 'user-once',
      text: 'Only once',
    });

    const results = await Promise.all([
      target.command(send),
      target.command(send),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'already_applied',
      'applied',
    ]);
    expect(dispatched).toHaveLength(1);
  });

  it('seeds a trusted-send tab with the deny rules the send carries, never its grants', async () => {
    const target = service();
    const deny = {
      id: 'deny-src',
      behavior: 'deny' as const,
      target: { kind: 'file-write' as const, path: '/ws/src/**' },
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt' as const,
    };
    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'chat-denied',
      userMessageId: 'user-denied',
      text: 'Harden the parser',
      sessionApprovalRules: [
        deny,
        {
          ...deny,
          id: 'allow-publish',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm publish' },
        },
      ],
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'chat-denied',
      )?.sessionApprovalRules,
    ).toEqual([deny]);
  });

  it('titles a trusted-send tab with the explicit title the send carries', async () => {
    const target = service();
    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'chat-titled',
      userMessageId: 'user-titled',
      text: 'Review the parser for empty input',
      title: 'Parser review',
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === 'chat-titled',
      )?.title,
    ).toBe('Parser review');
  });

  it('keeps an explicit title over the generated summary until the user renames the chat', async () => {
    const target = service();
    const tabOf = async (): Promise<PersistedChatTab> => {
      const tab = (await target.getState(SCOPE)).tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat-titled',
      );
      if (!tab) throw new Error('missing chat');
      return tab;
    };
    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'chat-titled',
      userMessageId: 'user-titled',
      text: '1. Inspect the app structure and plan the toggle.',
      title: '  Dark mode plan ',
    });
    await target.command(
      envelope('send-titled', {
        type: 'chat.send_message',
        chatId: 'chat-titled',
        userMessageId: 'user-titled',
        text: '1. Inspect the app structure and plan the toggle.',
      }),
    );
    // A saved name closes the one initial generated title (CAN-3652).
    expect((await tabOf()).automaticTitleState).toBe('closed');
    expect(isInitialChatTitleEligible(await tabOf())).toBe(false);
    await expect(
      target.command(
        envelope('summarize', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-titled',
          patch: { description: '1 Inspect the apps structure and plan' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect(chatTabLabel(await tabOf())).toBe('Dark mode plan');
    expect(chatDisplayLabel({ ...(await tabOf()), fallback: '' })).toBe(
      'Dark mode plan',
    );

    await target.command(
      envelope('rename', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-titled',
        patch: { customTitle: 'Theme work' },
      }),
    );
    expect(chatTabLabel(await tabOf())).toBe('Theme work');
  });

  it('atomically materializes a missing trusted-send tab without overwriting an existing tab', async () => {
    const target = service();
    const request: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-raced',
      userMessageId: 'user-raced',
      text: 'Start immediately',
      providerType: 'codex',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      pluginSelections: { collectionIds: ['collection-1'] },
      deferredToolsAllowed: false,
      codexProposalMode: 'required',
      approvalMode: 'full-access',
    };

    await target.ensureChatForTrustedSend(request);
    expect(await target.getState(SCOPE)).toMatchObject({
      revision: 1,
      tabsFile: {
        activeTabId: 'chat-raced',
        tabs: [
          {
            id: 'chat-raced',
            title: 'Start immediately',
            providerType: 'codex',
            model: 'gpt-6-sol',
            modelConfig: { thinkingLevel: 'high', fastMode: true },
            pluginSelections: { collectionIds: ['collection-1'] },
            deferredToolsAllowed: false,
            proposalMode: 'required',
            approvalMode: 'full-access',
          },
        ],
      },
    });

    await target.ensureChatForTrustedSend({
      ...request,
      providerType: 'claude',
      model: 'claude-haiku-4-5',
    });
    const unchanged = await target.getState(SCOPE);
    expect(unchanged.revision).toBe(1);
    expect(unchanged.tabsFile.tabs[0]).toMatchObject({
      providerType: 'codex',
      model: 'gpt-6-sol',
    });
  });

  it.each<[string, Partial<ChatSendMessageRequest>]>([
    ['a hook', { initiationSource: 'hook' }],
    [
      'a scheduled automation',
      { initiationSource: 'automation', preserveActiveTab: true },
    ],
    ['a background send', { preserveActiveTab: true }],
  ])(
    'opens a trusted-send chat from %s without taking the active tab',
    async (_label, background) => {
      const target = service();
      await target.command(
        envelope('create-user-chat', {
          type: 'chat.create_tab',
          tabId: 'user-chat',
          title: 'My chat',
        }),
      );

      await target.ensureChatForTrustedSend({
        ...SCOPE,
        chatId: 'background-chat',
        userMessageId: 'background-prompt',
        text: 'Resolve the merge conflicts',
        ...background,
      });

      const state = await target.getState(SCOPE);
      expect(state.tabsFile.tabs.map((tab) => tab.id)).toEqual([
        'user-chat',
        'background-chat',
      ]);
      expect(state.tabsFile.activeTabId).toBe('user-chat');
    },
  );

  // Only chats nobody asked for stay behind. An automation send that did not
  // ask to keep the current tab is the user's own action (a Run now, a
  // pipeline Run, a delegate, or a retry), so it comes forward as before.
  it('selects an automation chat the user set in motion', async () => {
    const target = service();
    await target.command(
      envelope('create-user-chat', {
        type: 'chat.create_tab',
        tabId: 'user-chat',
        title: 'My chat',
      }),
    );

    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'run-now-chat',
      userMessageId: 'run-now-prompt',
      text: 'Summarize my inbox',
      initiationSource: 'automation',
    });

    const state = await target.getState(SCOPE);
    expect(state.tabsFile.tabs.map((tab) => tab.id)).toEqual([
      'user-chat',
      'run-now-chat',
    ]);
    expect(state.tabsFile.activeTabId).toBe('run-now-chat');
  });

  it('selects a background trusted-send chat when the scope has no other chat', async () => {
    const target = service();

    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'background-chat',
      userMessageId: 'background-prompt',
      text: 'Resolve the merge conflicts',
      initiationSource: 'hook',
    });

    expect((await target.getState(SCOPE)).tabsFile.activeTabId).toBe(
      'background-chat',
    );
  });

  it('materializes a trusted-send tab in the background when the send preserves the active tab', async () => {
    const target = service();
    const base: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-user',
      userMessageId: 'user-1',
      text: 'The chat the user is reading',
    };
    await target.ensureChatForTrustedSend(base);

    await target.ensureChatForTrustedSend({
      ...base,
      chatId: 'chat-reserved',
      userMessageId: 'user-2',
      text: 'Started by an agent',
      preserveActiveTab: true,
    });
    const state = await target.getState(SCOPE);
    expect(state.tabsFile.activeTabId).toBe('chat-user');
    expect(state.tabsFile.tabs.map((tab) => tab.id)).toEqual([
      'chat-user',
      'chat-reserved',
    ]);
  });

  it('activates a preserved-focus trusted-send tab when no tab is active', async () => {
    const target = service();
    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'chat-only',
      userMessageId: 'user-1',
      text: 'First chat',
      preserveActiveTab: true,
    });
    expect((await target.getState(SCOPE)).tabsFile.activeTabId).toBe(
      'chat-only',
    );
  });

  it.each([false, true])(
    'persists one automation banner for a trusted send (existing tab: %s)',
    async (existingTab) => {
      const target = service();
      if (existingTab) {
        await target.command(
          envelope('create-automation-chat', {
            type: 'chat.create_tab',
            tabId: 'automation-chat',
            title: 'New chat',
          }),
        );
      }
      const request: ChatSendMessageRequest = {
        ...SCOPE,
        chatId: 'automation-chat',
        userMessageId: 'automation-prompt',
        text: 'Run the weekly check',
        initiationSource: 'automation',
        automationName: 'Weekly check',
      };

      await target.ensureChatForTrustedSend(request);
      const first = await target.getCompatibilityTabs(SCOPE, {
        chatIds: [request.chatId],
      });
      expect(first.tabs[0].messages).toEqual([
        expect.objectContaining({
          role: 'system',
          timestamp: expect.any(Number),
          blocks: [
            expect.objectContaining({
              type: 'automation_info',
              activityName: 'Weekly check',
              timestamp: expect.any(Number),
            }),
          ],
        }),
      ]);

      await target.ensureChatForTrustedSend(request);
      const retried = await target.getCompatibilityTabs(SCOPE, {
        chatIds: [request.chatId],
      });
      expect(retried.tabs[0].messages).toEqual(first.tabs[0].messages);
    },
  );

  it('persists resolved routing when a trusted send targets a routing-less tab', async () => {
    const target = service();
    await target.command(
      envelope('create-routing-less', {
        type: 'chat.create_tab',
        tabId: 'chat-routing-less',
        title: 'New chat',
      }),
    );

    await target.ensureChatForTrustedSend({
      ...SCOPE,
      chatId: 'chat-routing-less',
      userMessageId: 'user-routing-less',
      text: 'Use the resolved route',
      providerType: 'codex',
      model: 'gpt-5.5',
      executionHarness: 'codex',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      approvalMode: 'full-access',
    });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: 'chat-routing-less',
      title: 'Use the resolved route',
      providerType: 'codex',
      model: 'gpt-5.5',
      executionHarness: 'codex',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      approvalMode: 'full-access',
    });
  });

  it('persists hydrated Advisor routing before the first prompt and retains it after reload and a second send', async () => {
    const scope = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
    };
    const target = service();
    await target.command({
      ...envelope('create-cold-advisor', {
        type: 'chat.create_tab',
        tabId: 'advisor-cold',
        title: 'New chat',
        model: 'claude-opus-4-8',
        providerType: 'claude',
      }),
      ...scope,
    });
    await target.updateCompatibilityTab(scope, 'advisor-cold', (tab) => ({
      ...tab,
      executionHarness: 'claude',
    }));
    const request: ChatSendMessageRequest = {
      ...scope,
      chatId: 'advisor-cold',
      userMessageId: 'advisor-first',
      text: 'First guest turn',
      model: 'gpt-5.6-luna',
      providerType: 'codex',
      executionHarness: 'codex',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
    };
    await target.ensureChatForTrustedSend(request);
    const routing = {
      model: request.model,
      providerType: request.providerType,
      executionHarness: request.executionHarness,
      modelConfig: request.modelConfig,
    };
    expect((await target.getState(scope)).tabsFile.tabs[0]).toMatchObject(
      routing,
    );
    await target.ingestProviderEvent({
      ...scope,
      chatId: request.chatId,
      mutationId: 'advisor-first:user-prompt',
      providerType: 'codex',
      turnUserMessageId: request.userMessageId,
      data: {
        type: 'canopy_user_prompt',
        original_text: request.text,
        canopy_turn_user_message_id: request.userMessageId,
        canopy_persisted_messages: [
          {
            id: request.userMessageId,
            role: 'user',
            timestamp: 1_786_104_000_000,
            blocks: [{ type: 'text', text: request.text }],
          },
        ],
      },
    });
    const recovered = serviceWithRepository(
      {},
      copyDurableFilesAtBoundary(),
    ).target;
    const reloaded = await recovered.getCompatibilityTabs(scope, {
      chatIds: [request.chatId],
    });
    expect(reloaded.tabs[0]).toMatchObject({
      ...routing,
      messages: expect.arrayContaining([
        expect.objectContaining({ id: request.userMessageId }),
      ]),
    });
    await recovered.ensureChatForTrustedSend({
      ...request,
      userMessageId: 'advisor-second',
      text: 'Continue',
    });
    expect((await recovered.getState(scope)).tabsFile.tabs[0]).toMatchObject(
      routing,
    );
    // A populated conversation must not be re-routed by another trusted send.
    await recovered.ensureChatForTrustedSend({
      ...request,
      userMessageId: 'advisor-stale',
      model: 'claude-opus-4-8',
      providerType: 'claude',
      executionHarness: 'claude',
    });
    expect((await recovered.getState(scope)).tabsFile.tabs[0]).toMatchObject(
      routing,
    );
  });

  it.each([
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      executionHarnessExplicitlyChosen: true,
    },
    { projectId: SCOPE.projectId, executionHarnessExplicitlyChosen: false },
  ])(
    'preserves trusted-send routing outside an unpinned Advisor: %j',
    async (lock) => {
      const scope = { ...SCOPE, projectId: lock.projectId };
      const target = service();
      await target.command({
        ...envelope('create-pinned-advisor', {
          type: 'chat.create_tab',
          tabId: 'advisor-pinned',
          title: 'My chat',
          model: 'claude-opus-4-8',
          providerType: 'claude',
        }),
        ...scope,
      });
      await target.updateCompatibilityTab(scope, 'advisor-pinned', (tab) => ({
        ...tab,
        executionHarness: 'claude',
        executionHarnessExplicitlyChosen: lock.executionHarnessExplicitlyChosen,
      }));
      const original = (await target.getState(scope)).tabsFile.tabs[0];
      await target.ensureChatForTrustedSend({
        ...scope,
        chatId: 'advisor-pinned',
        userMessageId: 'advisor-pinned-first',
        text: 'Preserve routing',
        model: 'gpt-5.6-luna',
        providerType: 'codex',
        executionHarness: 'codex',
      });
      expect((await target.getState(scope)).tabsFile.tabs[0]).toEqual(original);
    },
  );

  it('does not resurrect a tombstoned tab for a delayed trusted send', async () => {
    const target = service();
    const planScope = {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-trusted-send',
    };
    const command = <T extends ChatCommand>(
      commandId: string,
      value: T,
    ): ChatCommandEnvelope<T> => ({
      schemaVersion: 1,
      commandId,
      ...planScope,
      command: value,
    });
    await target.command(
      command('create-delayed', {
        type: 'chat.create_tab',
        tabId: 'chat-delayed',
      }),
    );
    await target.command(
      command('discard-delayed', {
        type: 'chat.close_tab',
        tabId: 'chat-delayed',
        mode: 'discard_empty',
      }),
    );

    await expect(
      target.ensureChatForTrustedSend({
        ...planScope,
        chatId: 'chat-delayed',
        userMessageId: 'user-delayed',
        text: 'This send arrived after deletion',
      }),
    ).rejects.toThrow('removed');
    await expect(target.getState(planScope)).resolves.toMatchObject({
      tabsFile: { tabs: [] },
    });
  });

  it('serializes create-tab against trusted send materialization', async () => {
    const target = service();
    const request: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-raced-create',
      userMessageId: 'user-raced-create',
      text: 'Preserve the trusted send',
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full-access',
    };

    const [created] = await Promise.all([
      target.command(
        envelope('create-raced', {
          type: 'chat.create_tab',
          tabId: request.chatId,
          title: 'New chat',
        }),
      ),
      (async () => {
        await target.ensureChatForTrustedSend(request);
        await target.command(
          envelope('send-raced', {
            type: 'chat.send_message',
            chatId: request.chatId,
            userMessageId: request.userMessageId,
            text: request.text,
          }),
        );
      })(),
    ]);

    expect(created.outcome).toBe('already_applied');
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      id: request.chatId,
      title: 'Preserve the trusted send',
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full-access',
      messages: [expect.objectContaining({ id: request.userMessageId })],
    });
  });

  it('titles a placeholder tab in the same transaction as its first revisioned send', async () => {
    const target = service();
    await target.command(
      envelope('create-placeholder', {
        type: 'chat.create_tab',
        tabId: 'chat-placeholder',
        title: 'New chat',
      }),
    );

    await target.command(
      envelope('send-placeholder', {
        type: 'chat.send_message',
        chatId: 'chat-placeholder',
        userMessageId: 'user-placeholder',
        text: 'Persist this first message title',
      }),
    );

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      title: 'Persist this first message title',
      messages: [expect.objectContaining({ id: 'user-placeholder' })],
    });
  });

  it.each(['userMessageSource', 'agentSent', 'agentSenderProvenance'])(
    'rejects a forged %s in a direct seeded create before canonical publication',
    async (field) => {
      const target = service();
      await expect(
        target.command(
          envelope(`forged-${field}`, {
            type: 'chat.create_tab',
            tabId: 'forged-seed',
            seedTab: {
              id: 'forged-seed',
              title: 'Seed',
              createdAt: '2026-10-16T00:00:00.000Z',
              messages: [
                {
                  id: 'forged-message',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'forged' }],
                  [field]: field === 'userMessageSource' ? 'agent' : {},
                },
              ],
            },
          }),
        ),
      ).rejects.toThrow('Untrusted chat input');
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(0);
      expect(dispatched).toEqual([]);
    },
  );

  function reviewAgentRequest(id: string): ChatSendMessageRequest {
    const sender = {
      kind: 'bot' as const,
      botId: 'app_advisor',
      taskId: 'source-task',
      chatId: 'source-chat',
    };
    return {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: id,
      text: 'Retained edited body',
      attachmentPaths: ['/retained.png'],
      agentSent: { sender, chatTitle: 'Captured', projectLabel: 'App Advisor' },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'none' },
        capturedAt: '2026-10-16T00:00:00.000Z',
        acceptedInputId: id,
      },
      hiddenContext: {
        kind: 'agent-sender-context',
        text: '<system_instruction>Private sender</system_instruction>',
      },
    };
  }

  it.each([false, true])(
    'review: rolls back a dispatch-time agent refusal without failing the runtime (busy: %s)',
    async (busy) => {
      const validation = jest
        .spyOn(senderContext, 'revalidateAgentSenderRequest')
        .mockResolvedValue(undefined);
      const error = new senderContext.AgentSenderContextError(
        'target_not_ready',
        'Target became unavailable after commit',
      );
      const fixture = serviceWithRepository({
        dispatch: async (request) => {
          const committed = await target.getState(SCOPE);
          expect(committed.tabsFile.tabs[0].messages).toContainEqual(
            expect.objectContaining({ id: request.userMessageId }),
          );
          expect(committed.runtimeByChatId['chat-1'].status).toBe(
            busy ? 'streaming' : 'starting',
          );
          throw error;
        },
      });
      const target = fixture.target;
      try {
        await createChat(target);
        const busyRuntime = {
          status: 'streaming' as const,
          activeTurn: { userMessageId: 'running-input', startedAt: 123 },
          queuedMessageIds: ['existing-queue-row'],
        };
        if (busy) {
          await fixture.repository.transact(
            SCOPE,
            [
              {
                type: 'runtime.patched',
                chatId: 'chat-1',
                runtime: busyRuntime,
              },
            ],
            { source: 'provider' },
          );
        }
        const transaction = jest.spyOn(fixture.repository, 'transactWith');
        const request = reviewAgentRequest('refused-agent-input');
        const command = envelope('refused-agent-command', {
          type: 'chat.send_message',
          chatId: request.chatId,
          userMessageId: request.userMessageId,
          text: request.text,
          agentSent: request.agentSent,
          agentSenderProvenance: request.agentSenderProvenance,
          hiddenContext: request.hiddenContext,
        });
        await expect(target.command(command)).rejects.toBe(error);
        const snapshot = await target.getState(SCOPE);
        expect(snapshot.tabsFile.tabs[0].messages).not.toContainEqual(
          expect.objectContaining({ id: request.userMessageId }),
        );
        const runtime = snapshot.runtimeByChatId['chat-1'];
        if (busy) {
          expect(runtime).toEqual(busyRuntime);
        } else {
          expect(runtime).toMatchObject({
            status: 'idle',
            queuedMessageIds: [],
          });
          expect(runtime.activeTurn).toBeUndefined();
          expect(runtime.error).toBeUndefined();
        }
        expect(
          await target.getCommandReceipt({
            ...SCOPE,
            commandId: command.commandId,
          }),
        ).toMatchObject({
          commandId: command.commandId,
          outcome: 'rejected',
          reason: error.message,
        });
        expect(transaction).toHaveBeenLastCalledWith(
          SCOPE,
          expect.any(Function),
          expect.objectContaining({
            mutationId: 'refused-agent-command:agent-send-rejected',
            commandResult: expect.objectContaining({ outcome: 'rejected' }),
          }),
        );
      } finally {
        validation.mockRestore();
      }
    },
  );

  it('review: a native start failure settles the agent acceptance row', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const fixture = serviceWithRepository({
      dispatch: async (request) => {
        // The queue persists started acceptance before provider preflight.
        await target.reconcileHostQueue(
          { ...SCOPE, chatId: request.chatId },
          [],
          true,
          {
            type: 'agent-send-accepted',
            request,
            acceptance: {
              acceptedInputId: request.userMessageId,
              disposition: 'started',
              acceptedAt: '2026-10-17T00:00:00.000Z',
            },
          },
          [],
        );
        throw new Error('Provider authentication expired');
      },
    });
    const target = fixture.target;
    try {
      await createChat(target);
      const request = reviewAgentRequest('native-start-failed');
      await target.command(
        envelope('native-start-failed-command', {
          type: 'chat.send_message',
          chatId: request.chatId,
          userMessageId: request.userMessageId,
          text: request.text,
          agentSent: request.agentSent,
          agentSenderProvenance: request.agentSenderProvenance,
          hiddenContext: request.hiddenContext,
        }),
      );
      const snapshot = await target.getState(SCOPE);
      expect(snapshot.runtimeByChatId['chat-1'].status).toBe('failed');
      expect(snapshot.tabsFile.tabs[0].inputDelivery?.rows).toEqual([
        expect.objectContaining({
          id: request.userMessageId,
          state: 'cancelled',
        }),
      ]);
    } finally {
      validation.mockRestore();
    }
  });

  it('review: a refusal rollback keeps a newer turn and queue written during authorization', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const newerRuntime = {
      status: 'streaming' as const,
      activeTurn: { userMessageId: 'newer-input', startedAt: 456 },
      queuedMessageIds: ['newer-queue-row'],
    };
    const fixture = serviceWithRepository({
      dispatch: async () => {
        // Send B starts and send C queues while A's authorization is pending.
        await fixture.repository.transact(
          SCOPE,
          [
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: newerRuntime,
            },
          ],
          { source: 'provider' },
        );
        throw new senderContext.AgentSenderContextError(
          'target_not_ready',
          'Target became unavailable after commit',
        );
      },
    });
    const target = fixture.target;
    try {
      await createChat(target);
      const request = reviewAgentRequest('refused-older-input');
      const command = envelope('refused-older-command', {
        type: 'chat.send_message',
        chatId: request.chatId,
        userMessageId: request.userMessageId,
        text: request.text,
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
      });
      await expect(target.command(command)).rejects.toMatchObject({
        code: 'target_not_ready',
      });
      const snapshot = await target.getState(SCOPE);
      expect(snapshot.runtimeByChatId['chat-1']).toEqual(newerRuntime);
      expect(snapshot.tabsFile.tabs[0].messages).not.toContainEqual(
        expect.objectContaining({ id: request.userMessageId }),
      );
    } finally {
      validation.mockRestore();
    }
  });

  it('review: a refusal rollback of an owned turn keeps payloads queued during authorization', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const queued = {
      id: 'queued-behind-a',
      request: {
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: 'chat-1',
        userMessageId: 'queued-c',
        text: 'queued while A was authorizing',
      },
      origin: 'desktop' as const,
      enqueuedAtMs: 789,
    };
    const fixture = serviceWithRepository({
      dispatch: async (request) => {
        const current = (await target.getState(SCOPE)).runtimeByChatId[
          'chat-1'
        ];
        await fixture.repository.transact(
          SCOPE,
          [
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: {
                ...current,
                queuedMessageIds: [queued.id],
                queuedMessages: [queued],
              },
            },
          ],
          { source: 'provider' },
        );
        expect(current.activeTurn?.userMessageId).toBe(request.userMessageId);
        throw new senderContext.AgentSenderContextError(
          'target_not_ready',
          'Target became unavailable after commit',
        );
      },
    });
    const target = fixture.target;
    try {
      await createChat(target);
      const request = reviewAgentRequest('refused-owner-input');
      const command = envelope('refused-owner-command', {
        type: 'chat.send_message',
        chatId: request.chatId,
        userMessageId: request.userMessageId,
        text: request.text,
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
      });
      await expect(target.command(command)).rejects.toMatchObject({
        code: 'target_not_ready',
      });
      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime).toMatchObject({
        status: 'idle',
        queuedMessageIds: [queued.id],
        queuedMessages: [queued],
      });
      expect(runtime.activeTurn).toBeUndefined();
    } finally {
      validation.mockRestore();
    }
  });

  it('phase 09: persists queue acceptance under the same command and replays identical facts after restart', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const readiness = jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockResolvedValue('pending');
    let target: ChatStateService;
    const queue = new ChatQueueService({
      dispatch: async () => {
        throw new Error('Pending setup must not dispatch');
      },
      cancel: async () => undefined,
      settleCancelledTurn: async () => undefined,
      hasActiveProviderTurn: () => false,
      hasPendingProviderContinuation: () => false,
      persistRuntime: async (...args) => target.reconcileHostQueue(...args),
      broadcast: () => undefined,
      createId: () => 'actual-queue-row',
      now: () => 1234,
      schedule: () => {
        const timer = setTimeout(() => undefined, 60000);
        timer.unref();
        return timer;
      },
    });
    const chatService = await import('../chat-service');
    const split = jest
      .spyOn(chatService, 'assertWorktreeChatSendNotSplitLocked')
      .mockReturnValue({ ...SCOPE });
    mockTerminalState.mockReturnValue({ turnState: 'running' });
    try {
      target = serviceWithRepository({
        authorizeSend: undefined,
        dispatch: (request, origin) => queue.submit(request, origin),
      }).target;
      await createChat(target);
      const request = reviewAgentRequest('phase09-input');
      const command = envelope('phase09-command', {
        type: 'chat.send_message' as const,
        chatId: request.chatId,
        userMessageId: request.userMessageId,
        text: request.text,
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
        agentSendSetup: { version: 1 as const },
      });
      const accepted = jest.fn();
      await target.command(command, { onAgentSendAccepted: accepted });
      expect(accepted).toHaveBeenCalledWith({
        acceptedInputId: request.userMessageId,
        disposition: 'queued',
        queuedMessageId: 'actual-queue-row',
        acceptedAt: '1970-01-01T00:00:01.234Z',
      });
      const snapshot = await target.getState(SCOPE);
      expect(
        snapshot.runtimeByChatId['chat-1'].queuedMessages?.[0]?.request,
      ).toMatchObject({
        agentSendSetup: { version: 1 },
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
      });
      expect(
        snapshot.tabsFile.tabs[0].messages.filter(
          (message) => message.id === request.userMessageId,
        ),
      ).toHaveLength(1);
      const restarted = serviceWithRepository(
        {},
        copyDurableFilesAtBoundary(),
      ).target;
      const replay = jest.fn();
      await expect(
        restarted.command(command, { onAgentSendAccepted: replay }),
      ).resolves.toMatchObject({ outcome: 'already_applied' });
      expect(replay.mock.calls).toEqual(accepted.mock.calls);
      expect(dispatched).toHaveLength(0);
      const replayedState = await restarted.getState(SCOPE);
      expect(
        replayedState.runtimeByChatId['chat-1'].queuedMessages,
      ).toHaveLength(1);
      expect(
        replayedState.tabsFile.tabs[0].messages.filter(
          (message) => message.id === request.userMessageId,
        ),
      ).toHaveLength(1);
      expect(
        (
          await restarted.getCommandReceipt({
            ...SCOPE,
            commandId: command.commandId,
          })
        )?.agentSendAcceptance,
      ).toEqual({
        acceptedInputId: request.userMessageId,
        disposition: 'queued',
        queuedMessageId: 'actual-queue-row',
        acceptedAt: '1970-01-01T00:00:01.234Z',
      });
      split.mockImplementation(() => {
        throw new Error('Split target is locked');
      });
      const blocked = reviewAgentRequest('split-locked-input');
      await expect(
        target.command(
          envelope('split-locked-command', {
            type: 'chat.send_message',
            chatId: blocked.chatId,
            userMessageId: blocked.userMessageId,
            text: blocked.text,
            agentSent: blocked.agentSent,
            agentSenderProvenance: blocked.agentSenderProvenance,
            hiddenContext: blocked.hiddenContext,
            agentSendSetup: { version: 1 },
          }),
        ),
      ).rejects.toThrow('Split target is locked');
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0].messages.some(
          (message) => message.id === blocked.userMessageId,
        ),
      ).toBe(false);
    } finally {
      split.mockRestore();
      queue.resetForTests();
      validation.mockRestore();
      readiness.mockRestore();
    }
  });

  it('phase 09: recovers a crash before queue acceptance without duplicating the input, queue row or receipt', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const readiness = jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockResolvedValue('pending');
    let target: ChatStateService;
    let queueId = 0;
    let crashFiles: typeof paths | undefined;
    const queue = new ChatQueueService({
      dispatch: async () => {
        throw new Error('Pending setup must not dispatch');
      },
      cancel: async () => undefined,
      settleCancelledTurn: async () => undefined,
      hasActiveProviderTurn: () => false,
      hasPendingProviderContinuation: () => false,
      persistRuntime: async (...args) => target.reconcileHostQueue(...args),
      broadcast: () => undefined,
      createId: () => `crash-queue-${++queueId}`,
      now: () => 1234,
      schedule: () => {
        const timer = setTimeout(() => undefined, 60000);
        timer.unref();
        return timer;
      },
    });
    try {
      target = serviceWithRepository({
        dispatch: async () => {
          // An abrupt crash preserves the pre-acceptance files, before the
          // live process can handle this refusal and roll back its input.
          crashFiles = copyDurableFilesAtBoundary();
          throw new senderContext.AgentSenderContextError(
            'owner_context_unavailable',
            'Simulated crash before queue',
          );
        },
      }).target;
      await createChat(target);
      const request = reviewAgentRequest('crash-input');
      const command = envelope('crash-command', {
        type: 'chat.send_message' as const,
        chatId: request.chatId,
        userMessageId: request.userMessageId,
        text: request.text,
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
        agentSendSetup: { version: 1 as const },
      });
      await expect(target.command(command)).rejects.toThrow(
        'Simulated crash before queue',
      );
      expect(
        await target.getCommandReceipt({
          ...SCOPE,
          commandId: command.commandId,
        }),
      ).toMatchObject({ outcome: 'rejected' });
      if (!crashFiles) throw new Error('Missing pre-acceptance crash files');
      target = serviceWithRepository(
        { dispatch: (request, origin) => queue.submit(request, origin) },
        crashFiles,
      ).target;
      const accepted = jest.fn();
      await target.command(command, { onAgentSendAccepted: accepted });
      await target.command(command, { onAgentSendAccepted: accepted });
      const snapshot = await target.getState(SCOPE);
      expect(
        snapshot.tabsFile.tabs[0].messages.filter(
          (message) => message.id === request.userMessageId,
        ),
      ).toHaveLength(1);
      expect(snapshot.runtimeByChatId['chat-1'].queuedMessages).toHaveLength(1);
      expect(queueId).toBe(1);
      const receipt = await target.getCommandReceipt({
        ...SCOPE,
        commandId: command.commandId,
      });
      expect(receipt).toMatchObject({
        commandId: command.commandId,
        agentSendAcceptance: {
          acceptedInputId: request.userMessageId,
          disposition: 'queued',
          queuedMessageId: 'crash-queue-1',
          acceptedAt: '1970-01-01T00:00:01.234Z',
        },
      });
      expect(accepted).toHaveBeenCalledTimes(2);
      expect(accepted.mock.calls[1]).toEqual(accepted.mock.calls[0]);
    } finally {
      queue.resetForTests();
      validation.mockRestore();
      readiness.mockRestore();
    }
  });

  it('phase 09: an ordinary cancel settles the agent acceptance row', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const request = reviewAgentRequest('cancelled-agent-input');
      const row = {
        id: 'host-row',
        request,
        origin: 'desktop' as const,
        enqueuedAtMs: 1234,
      };
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: request.chatId },
        ['host-row'],
        false,
        {
          type: 'agent-send-accepted',
          request,
          acceptance: {
            acceptedInputId: request.userMessageId,
            disposition: 'queued',
            queuedMessageId: 'host-row',
            acceptedAt: '2026-10-17T00:00:00.000Z',
          },
        },
        [row],
      );
      // chat.cancel_queued_message cancels without an error message.
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: request.chatId },
        [],
        false,
        { type: 'cancel', request },
        [],
      );
      const rows = (await target.getState(SCOPE)).tabsFile.tabs[0].inputDelivery
        ?.rows;
      expect(rows?.[0]).toMatchObject({
        id: request.userMessageId,
        state: 'cancelled',
      });
    } finally {
      validation.mockRestore();
    }
  });

  it('phase 09: settle-agent-input cancels only the queued agent row and keeps the transcript', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const notices: unknown[] = [];
      const { target } = serviceWithRepository({
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      await createChat(target);
      const request = reviewAgentRequest('settled-agent-input');
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: request.chatId },
        ['host-row'],
        false,
        {
          type: 'agent-send-accepted',
          request,
          acceptance: {
            acceptedInputId: request.userMessageId,
            disposition: 'queued',
            queuedMessageId: 'host-row',
            acceptedAt: '2026-10-17T00:00:00.000Z',
          },
        },
        [{ id: 'host-row', request, origin: 'desktop', enqueuedAtMs: 1 }],
      );
      const before = (await target.getState(SCOPE)).tabsFile.tabs[0].messages;
      const settle = (): Promise<void> =>
        target.reconcileHostQueue(
          { ...SCOPE, chatId: request.chatId },
          [],
          false,
          {
            type: 'settle-agent-input',
            request,
            reason: 'Model is blocked by policy',
          },
          [],
        );
      await settle();
      // Settling again finds no queued row and must not notify twice.
      await settle();
      await new Promise((resolve) => setImmediate(resolve));
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows[0]).toMatchObject({
        id: request.userMessageId,
        state: 'cancelled',
        reason: 'Model is blocked by policy',
      });
      expect(tab.messages).toEqual(before);
      // Watchers bound to the dropped input get its terminal outcome.
      expect(tab.unacceptedTurnEnds?.[request.userMessageId]).toBe('failed');
      expect(notices).toEqual([
        expect.objectContaining({
          chatId: request.chatId,
          userMessageId: request.userMessageId,
          outcome: 'failed',
          data: expect.objectContaining({
            result: 'Model is blocked by policy',
            canopy_turn_unaccepted: true,
          }),
        }),
      ]);
    } finally {
      validation.mockRestore();
    }
  });

  it('phase 09: upgrades host-queued terminal input to a retained managed-terminal attempt', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const request = reviewAgentRequest('queued-terminal-input');
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: request.chatId },
        ['host-terminal-row'],
        false,
        {
          type: 'agent-send-accepted',
          request,
          acceptance: {
            acceptedInputId: request.userMessageId,
            disposition: 'queued',
            queuedMessageId: 'host-terminal-row',
            acceptedAt: '2026-10-17T00:00:00.000Z',
          },
        },
        [
          {
            id: 'host-terminal-row',
            request,
            origin: 'desktop',
            enqueuedAtMs: 1234,
          },
        ],
      );
      const before = (await target.getState(SCOPE)).tabsFile.tabs[0]
        .inputDelivery?.rows[0];
      await target.retainTrustedTerminalInput(request);
      await target.retainTrustedTerminalInput(request);
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows).toHaveLength(1);
      expect(tab.inputDelivery?.rows[0]?.createdAt).toBe(before?.createdAt);
      expect(
        tab.inputDelivery?.rows[0]?.attempts.filter(
          (attempt) => attempt.generation === 'managed-terminal',
        ),
      ).toHaveLength(1);
      expect(
        (await target.getState(SCOPE)).runtimeByChatId['chat-1']
          .queuedMessages?.[0]?.id,
      ).toBe('host-terminal-row');
      expect(
        retainedTerminalAgentInput(tab, request.userMessageId),
      ).toMatchObject({
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
      });
    } finally {
      validation.mockRestore();
    }
  });

  it('phase 09: terminal acceptance still crosses core send and commits the canonical user message exactly once', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const target: ChatStateService = serviceWithRepository({
      dispatch: (request) => target.retainTrustedTerminalInput(request),
    }).target;
    await createChat(target);
    const runtime = createDesktopRuntime({ chatCommandPort: target });
    const instruction = jest.spyOn(runtime, 'instruction');
    try {
      const request = reviewAgentRequest('terminal-core-input');
      const accepted = jest.fn();
      await dispatchTrustedChatCommand(
        envelope('terminal-core-command', {
          type: 'chat.send_message',
          chatId: request.chatId,
          userMessageId: request.userMessageId,
          text: request.text,
          agentSent: request.agentSent,
          agentSenderProvenance: request.agentSenderProvenance,
          hiddenContext: request.hiddenContext,
        }),
        {
          ...createChatCommandDispatchOptions(target, runtime, {
            principalId: 'local-user',
            clientInstanceId: 'agent-chat-send',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.chat.write'],
          }),
          executionOptions: { onAgentSendAccepted: accepted },
        },
      );
      expect(instruction).toHaveBeenCalledWith(
        'core.chat.message.send',
        expect.objectContaining({ messageId: request.userMessageId }),
        expect.anything(),
      );
      expect(accepted).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptedInputId: request.userMessageId,
          disposition: 'queued',
        }),
      );
      await target.command(
        envelope('terminal-core-import', {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: request.chatId,
          userMessageId: request.userMessageId,
          turnTimerMessageId: 'terminal-timer',
          text: request.text,
        }),
      );
      const messages = (
        await target.getState(SCOPE)
      ).tabsFile.tabs[0].messages.filter(
        (message) => message.id === request.userMessageId,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        userMessageSource: 'agent',
        agentSent: request.agentSent,
      });
    } finally {
      await runtime.shutdown();
      validation.mockRestore();
    }
  });

  async function precommittedTerminalAgentInputFixture() {
    const fixture = serviceWithRepository({
      dispatch: (request) => target.retainTrustedTerminalInput(request),
    });
    const { target, repository } = fixture;
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            activeTurn: { userMessageId: 'running-input', startedAt: 123 },
            queuedMessageIds: [],
          },
        },
      ],
      { source: 'provider' },
    );
    const request = reviewAgentRequest('precommitted-terminal-input');
    const runtime = createDesktopRuntime({ chatCommandPort: target });
    await dispatchTrustedChatCommand(
      envelope('precommitted-terminal-command', {
        type: 'chat.send_message',
        chatId: request.chatId,
        userMessageId: request.userMessageId,
        text: request.text,
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
      }),
      createChatCommandDispatchOptions(target, runtime, {
        principalId: 'local-user',
        clientInstanceId: 'agent-chat-send',
        authorityId: 'local-desktop',
        interfaceKind: 'mcp',
        grants: ['core.chat.write'],
      }),
    );
    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab.messages).toContainEqual(
      expect.objectContaining({ id: request.userMessageId }),
    );
    expect(tab.inputDelivery?.rows[0]).toMatchObject({
      id: request.userMessageId,
      state: 'sending',
      attempts: [expect.objectContaining({ generation: 'managed-terminal' })],
    });
    expect(tab.inputDelivery?.rows[0].attempts[0].pickedUpAt).toBeUndefined();
    return { ...fixture, request, runtime, tab };
  }

  it.each(['edit', 'cancel'] as const)(
    'phase 09: %s applies to a precommitted terminal agent input waiting behind a busy terminal',
    async (action) => {
      const validation = jest
        .spyOn(senderContext, 'revalidateAgentSenderRequest')
        .mockResolvedValue(undefined);
      const f = await precommittedTerminalAgentInputFixture();
      const scope = { ...SCOPE, chatId: f.request.chatId };
      try {
        if (action === 'edit') {
          await expect(
            f.target.editRetainedTerminalAgentInput({
              ...scope,
              entryId: f.request.userMessageId,
              text: 'Updated while waiting',
            }),
          ).resolves.toBe('applied');
          const tab = (await f.target.getState(SCOPE)).tabsFile.tabs[0];
          expect(tab.inputDelivery?.rows[0]).toMatchObject({
            text: 'Updated while waiting',
            payload: {
              text: 'Updated while waiting',
              agentSenderProvenance: f.request.agentSenderProvenance,
              hiddenContext: f.request.hiddenContext,
            },
          });
          expect(
            tab.messages.find(
              (message) => message.id === f.request.userMessageId,
            ),
          ).toMatchObject({
            timestamp: f.tab.messages.find(
              (message) => message.id === f.request.userMessageId,
            )?.timestamp,
            blocks: [{ type: 'text', text: 'Updated while waiting' }],
            userMessageSource: 'agent',
            agentSent: f.request.agentSent,
          });
        } else {
          await expect(
            f.target.cancelRetainedTerminalAgentInput(
              scope,
              f.request.userMessageId,
            ),
          ).resolves.toBe('applied');
          const tab = (await f.target.getState(SCOPE)).tabsFile.tabs[0];
          expect(
            tab.messages.some(
              (message) => message.id === f.request.userMessageId,
            ),
          ).toBe(false);
          expect(tab.inputDelivery?.rows[0]).toMatchObject({
            state: 'cancelled',
            attempts: [
              expect.objectContaining({
                withdrawnAt: expect.any(Number),
                turnOutcome: 'cancelled',
              }),
            ],
          });
          await expect(
            f.target.authorizeRetainedTerminalAgentInputWrite(
              scope,
              f.request.userMessageId,
            ),
          ).rejects.toThrow('can no longer reach');
        }
      } finally {
        await f.runtime.shutdown();
        validation.mockRestore();
      }
    },
  );

  it('phase 09: a cancel committed during sender validation refuses the terminal write', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const f = await precommittedTerminalAgentInputFixture();
    const scope = { ...SCOPE, chatId: f.request.chatId };
    let release = (): void => undefined;
    validation.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const calls = validation.mock.calls.length;
    try {
      const write = f.target.authorizeRetainedTerminalAgentInputWrite(
        scope,
        f.request.userMessageId,
      );
      while (validation.mock.calls.length === calls)
        await new Promise((resolve) => setImmediate(resolve));
      await expect(
        f.target.cancelRetainedTerminalAgentInput(
          scope,
          f.request.userMessageId,
        ),
      ).resolves.toBe('applied');
      release();
      await expect(write).rejects.toThrow('can no longer reach');
    } finally {
      await f.runtime.shutdown();
      validation.mockRestore();
    }
  });

  it.each(['row', 'attempt'] as const)(
    'phase 09: precommitted terminal agent input cannot be edited or cancelled after %s pickup',
    async (pickup) => {
      const validation = jest
        .spyOn(senderContext, 'revalidateAgentSenderRequest')
        .mockResolvedValue(undefined);
      const f = await precommittedTerminalAgentInputFixture();
      try {
        if (!f.tab.inputDelivery)
          throw new Error('Missing terminal input fixture');
        await f.repository.transact(
          SCOPE,
          [
            {
              type: 'tab.metadata_patched',
              tabId: f.request.chatId,
              patch: {
                inputDelivery: {
                  ...f.tab.inputDelivery,
                  rows: f.tab.inputDelivery.rows.map((row) => ({
                    ...row,
                    ...(pickup === 'row'
                      ? { state: 'picked-up' as const }
                      : {}),
                    attempts: row.attempts.map((attempt) => ({
                      ...attempt,
                      ...(pickup === 'attempt' ? { pickedUpAt: 1234 } : {}),
                    })),
                  })),
                },
              },
            },
          ],
          { source: 'provider' },
        );
        const before = (await f.target.getState(SCOPE)).tabsFile.tabs[0];
        const scope = { ...SCOPE, chatId: f.request.chatId };
        await expect(
          f.target.cancelRetainedTerminalAgentInput(
            scope,
            f.request.userMessageId,
          ),
        ).resolves.toBe('not_found');
        await expect(
          f.target.editRetainedTerminalAgentInput({
            ...scope,
            entryId: f.request.userMessageId,
            text: 'Too late',
          }),
        ).rejects.toThrow(
          'The retained terminal agent input is no longer editable.',
        );
        expect((await f.target.getState(SCOPE)).tabsFile.tabs[0]).toEqual(
          before,
        );
      } finally {
        await f.runtime.shutdown();
        validation.mockRestore();
      }
    },
  );

  it('phase 09: ordinary user sends retain the existing early command receipt', async () => {
    const target = serviceWithRepository({
      dispatch: async () => {
        throw new Error('Transport failure');
      },
    }).target;
    await createChat(target);
    const command = envelope('ordinary-early', {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'ordinary-early-input',
      text: 'hello',
    });
    await target.command(command);
    expect(
      await target.getCommandReceipt({
        ...SCOPE,
        commandId: command.commandId,
      }),
    ).toMatchObject({ outcome: 'applied', messageId: 'ordinary-early-input' });
    expect(
      await target.getCommandReceipt({
        ...SCOPE,
        commandId: command.commandId,
      }),
    ).not.toHaveProperty('agentSendAcceptance');
  });

  it('phase 09: final steering authorization cancels with a stable code and never submits or falls back', async () => {
    let calls = 0;
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockImplementation(async () => {
        calls += 1;
        if (calls > 1)
          throw new senderContext.AgentSenderContextError(
            'owner_boundary',
            'Changed owner',
          );
      });
    try {
      const request = reviewAgentRequest('row-1');
      const f = await deliveryFixture({
        ...request,
        attachmentPaths: undefined,
      });
      await f.steer();
      expect(f.submission).not.toHaveBeenCalled();
      expect(await f.getRow()).toMatchObject({
        state: 'cancelled',
        reason: 'agent_send:owner_boundary',
      });
      expect(queueConsumeRestoredInput).not.toHaveBeenCalled();
    } finally {
      validation.mockRestore();
    }
  });

  it('review: native trusted sends do not append attemptless Sending ledger rows', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      const request = reviewAgentRequest('native-agent');
      await target.ensureChatForTrustedSend(request);
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows ?? []).toEqual([]);
    } finally {
      validation.mockRestore();
    }
  });

  it('review: missing ordinary edits return not_found without writing a ledger', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await expect(
      target.editRetainedTerminalAgentInput({
        ...SCOPE,
        chatId: 'chat-1',
        entryId: 'ordinary-missing',
        text: 'edit',
      }),
    ).resolves.toBe('not_found');
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0].inputDelivery,
    ).toBeUndefined();
    await repository.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: {
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: 'ordinary-row',
                  revision: 1,
                  createdAt: 1,
                  state: 'sending',
                  text: 'ordinary',
                  settingsKey: '',
                  payload: {
                    ...SCOPE,
                    chatId: 'chat-1',
                    userMessageId: 'ordinary-row',
                    text: 'ordinary',
                  },
                  attempts: [],
                },
              ],
            },
          },
        },
      ],
      { source: 'provider' },
    );
    await expect(
      target.editRetainedTerminalAgentInput({
        ...SCOPE,
        chatId: 'chat-1',
        entryId: 'ordinary-row',
        text: 'edit',
      }),
    ).resolves.toBe('not_found');
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0].inputDelivery?.rows[0]
        .text,
    ).toBe('ordinary');
  });

  it('review: transfers a pending terminal input to native with immutable capture and current send settings', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('switch-agent');
      await target.retainTrustedTerminalInput(retained);
      validation.mockClear();
      const incoming = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: retained.userMessageId,
        text: 'renderer stale body',
        attachmentPaths: ['/stale.png'],
        interfaceMode: 'native' as const,
        model: 'claude-sonnet-4-6',
        planMode: true,
      };
      const recovered =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      expect(validation).toHaveBeenCalledWith(
        expect.objectContaining(retained),
      );
      expect(recovered).toMatchObject({
        ...incoming,
        text: retained.text,
        attachmentPaths: retained.attachmentPaths,
        agentSent: retained.agentSent,
        agentSenderProvenance: retained.agentSenderProvenance,
        hiddenContext: retained.hiddenContext,
      });
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(
        retainedTerminalAgentInput(tab, retained.userMessageId),
      ).toBeUndefined();
      expect(tab.inputDelivery?.rows[0]).toMatchObject({
        state: 'cancelled',
        attempts: [
          expect.objectContaining({
            generation: 'managed-terminal',
            withdrawnAt: expect.any(Number),
          }),
        ],
      });
      expect(
        correlateTerminalAgentMessage(tab, {
          id: 'provider-id',
          role: 'user',
          timestamp: 1,
          blocks: [
            {
              type: 'text',
              text: `${retained.hiddenContext?.text}\n\n${retained.text}`,
            },
          ],
        }).agentSent,
      ).toBeUndefined();
    } finally {
      validation.mockRestore();
    }
  });

  it('review: refuses terminal to native recovery durably and leaves ordinary native requests unchanged', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('refused-switch');
      await target.retainTrustedTerminalInput(retained);
      const incoming = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: retained.userMessageId,
        text: 'ordinary renderer payload',
      };
      validation.mockRejectedValue(new Error('Private lookup detail'));
      await expect(
        target.claimRetainedTerminalAgentInputForNative(incoming),
      ).rejects.toThrow(
        'The agent that sent this message can no longer reach this chat.',
      );
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(
        retainedTerminalAgentInput(tab, retained.userMessageId),
      ).toBeUndefined();
      expect(tab.inputDelivery?.rows[0].state).toBe('cancelled');
      await expect(
        target.claimRetainedTerminalAgentInputForNative(incoming),
      ).rejects.toThrow(
        'The agent that sent this message can no longer reach this chat.',
      );
      validation.mockResolvedValue(undefined);
      await expect(
        target.claimRetainedTerminalAgentInputForNative(incoming),
      ).rejects.toThrow(
        'The agent that sent this message can no longer reach this chat.',
      );
      validation.mockClear();
      const ordinary = { ...incoming, userMessageId: 'ordinary' };
      expect(
        await target.claimRetainedTerminalAgentInputForNative(ordinary),
      ).toBe(ordinary);
      expect(validation).not.toHaveBeenCalled();
    } finally {
      validation.mockRestore();
    }
  });

  it('review 3: restores terminal evidence after failed native admission so retry stays agent attributed', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('retry-admission');
      await target.retainTrustedTerminalInput(retained);
      const incoming = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: retained.userMessageId,
        text: 'renderer body',
      };
      const claimed =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      await target.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
        claimed,
      );
      expect(
        retainedTerminalAgentInput(
          (await target.getState(SCOPE)).tabsFile.tabs[0],
          retained.userMessageId,
        ),
      ).toMatchObject(retained);
      const retry =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      expect(retry).toMatchObject({
        agentSent: retained.agentSent,
        text: retained.text,
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'retry-visible',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: retry.userMessageId,
          canopy_persisted_messages: [
            {
              id: retry.userMessageId,
              role: 'user',
              timestamp: 1,
              userMessageSource: 'agent',
              agentSent: retry.agentSent,
              blocks: [{ type: 'text', text: retry.text }],
            },
          ],
        },
      });
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0].messages,
      ).toContainEqual(
        expect.objectContaining({
          id: retained.userMessageId,
          userMessageSource: 'agent',
          agentSent: retained.agentSent,
        }),
      );
    } finally {
      validation.mockRestore();
    }
  });

  it('restores a precommitted terminal input whose native dispatch failed before acceptance', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('precommitted-retry');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const visible = (mutationId: string) =>
        target.ingestProviderEvent({
          ...scope,
          mutationId,
          data: {
            type: 'canopy_user_prompt',
            canopy_turn_user_message_id: retained.userMessageId,
            canopy_persisted_messages: [
              {
                id: retained.userMessageId,
                role: 'user',
                timestamp: 1,
                userMessageSource: 'agent',
                agentSent: retained.agentSent,
                blocks: [{ type: 'text', text: retained.text }],
              },
            ],
          },
        });
      // Core precommits agent messages before native delivery is attempted.
      await visible('precommitted-retry-visible');
      const incoming = {
        ...scope,
        userMessageId: retained.userMessageId,
        text: 'renderer body',
      };
      const claimed =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      // Model preparation failed: native delivery never accepted the input.
      await target.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
        claimed,
      );
      const retry =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      expect(retry).toMatchObject({ agentSent: retained.agentSent });

      // Once native delivery accepted the input, a failure never revives it.
      await visible(`chat-1:${retained.userMessageId}:accepted`);
      await target.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
        retry,
      );
      await expect(
        target.claimRetainedTerminalAgentInputForNative(incoming),
      ).rejects.toThrow('can no longer reach');
    } finally {
      validation.mockRestore();
    }
  });

  it('ends the turn of a retained input refused at terminal authorization', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const notices: unknown[] = [];
      const { target } = serviceWithRepository({
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      await createChat(target);
      const retained = reviewAgentRequest('refused-at-terminal');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      validation.mockRejectedValue(new Error('Sender access was revoked.'));
      await expect(
        target.authorizeRetainedTerminalAgentInputWrite(
          scope,
          retained.userMessageId,
        ),
      ).rejects.toThrow('can no longer reach this chat');
      await new Promise((resolve) => setImmediate(resolve));
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.unacceptedTurnEnds?.[retained.userMessageId]).toBe(
        'cancelled',
      );
      expect(notices).toEqual([
        expect.objectContaining({
          chatId: 'chat-1',
          userMessageId: retained.userMessageId,
          outcome: 'cancelled',
          data: expect.objectContaining({ canopy_turn_unaccepted: true }),
        }),
      ]);
    } finally {
      validation.mockRestore();
    }
  });

  it('revalidates a precommitted retained input before native delivery', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('precommitted-native');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      // Core precommits agent messages before the terminal picks them up.
      await target.ingestProviderEvent({
        ...scope,
        mutationId: 'precommitted-visible',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: retained.userMessageId,
          canopy_persisted_messages: [
            {
              id: retained.userMessageId,
              role: 'user',
              timestamp: 1,
              userMessageSource: 'agent',
              agentSent: retained.agentSent,
              blocks: [{ type: 'text', text: retained.text }],
            },
          ],
        },
      });
      validation.mockRejectedValue(new Error('Sender access was revoked.'));
      await expect(
        target.claimRetainedTerminalAgentInputForNative({
          ...scope,
          userMessageId: retained.userMessageId,
          text: 'renderer body',
        }),
      ).rejects.toThrow();
    } finally {
      validation.mockRestore();
    }
  });

  it('a late cancel after native delivery keeps the prompt and reports no turn end', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const notices: unknown[] = [];
      const { target } = serviceWithRepository({
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      await createChat(target);
      const retained = reviewAgentRequest('late-cancel-after-native');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const claimed = await target.claimRetainedTerminalAgentInputForNative({
        ...scope,
        userMessageId: retained.userMessageId,
        text: 'renderer body',
      });
      // Native dispatch has written the prompt; acceptance has not landed yet.
      await target.ingestProviderEvent({
        ...scope,
        mutationId: 'late-cancel-visible',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: claimed.userMessageId,
          canopy_persisted_messages: [
            {
              id: claimed.userMessageId,
              role: 'user',
              timestamp: 1,
              userMessageSource: 'agent',
              agentSent: claimed.agentSent,
              blocks: [{ type: 'text', text: claimed.text }],
            },
          ],
        },
      });
      await expect(
        target.cancelRetainedTerminalAgentInput(scope, retained.userMessageId),
      ).resolves.toBe('not_found');
      await new Promise((resolve) => setImmediate(resolve));
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.messages.map((message) => message.id)).toContain(
        retained.userMessageId,
      );
      expect(tab.unacceptedTurnEnds?.[retained.userMessageId]).toBeUndefined();
      expect(notices).toEqual([]);
    } finally {
      validation.mockRestore();
    }
  });

  it('review 3: failed admission rollback never revives a later explicit cancellation', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('cancel-during-admission');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      const incoming = {
        ...scope,
        userMessageId: retained.userMessageId,
        text: 'renderer body',
      };
      const claimed =
        await target.claimRetainedTerminalAgentInputForNative(incoming);
      await target.cancelRetainedTerminalAgentInput(
        scope,
        retained.userMessageId,
      );
      await target.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
        claimed,
      );
      await expect(
        target.claimRetainedTerminalAgentInputForNative(incoming),
      ).rejects.toThrow('can no longer reach');
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0].inputDelivery?.rows[0]
          .reason,
      ).toBe('Cancelled before delivery');
    } finally {
      validation.mockRestore();
    }
  });

  it('review 3: local terminal cancellation settles delivery and prevents claim or correlation idempotently', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const notices: unknown[] = [];
      const { target } = serviceWithRepository({
        notifyTurnTerminal: async (notice) => {
          notices.push(notice);
        },
      });
      await createChat(target);
      const retained = reviewAgentRequest('cancel-local');
      await target.retainTrustedTerminalInput(retained);
      const scope = { ...SCOPE, chatId: 'chat-1' };
      await expect(
        target.cancelRetainedTerminalAgentInput(scope, 'ordinary'),
      ).resolves.toBe('not_found');
      await expect(
        target.cancelRetainedTerminalAgentInput(scope, retained.userMessageId),
      ).resolves.toBe('applied');
      await expect(
        target.cancelRetainedTerminalAgentInput(scope, retained.userMessageId),
      ).resolves.toBe('not_found');
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows[0].state).toBe('cancelled');
      expect(
        retainedTerminalAgentInput(tab, retained.userMessageId),
      ).toBeUndefined();
      // Watchers bound to the cancelled input get one terminal outcome.
      await new Promise((resolve) => setImmediate(resolve));
      expect(tab.unacceptedTurnEnds?.[retained.userMessageId]).toBe(
        'cancelled',
      );
      expect(notices).toEqual([
        expect.objectContaining({
          chatId: 'chat-1',
          userMessageId: retained.userMessageId,
          outcome: 'cancelled',
          data: expect.objectContaining({ canopy_turn_unaccepted: true }),
        }),
      ]);
      await expect(
        target.claimRetainedTerminalAgentInputForNative({
          ...scope,
          userMessageId: retained.userMessageId,
          text: 'retry',
        }),
      ).rejects.toThrow('can no longer reach');
      expect(
        correlateTerminalAgentMessage(tab, {
          id: 'provider',
          role: 'user',
          timestamp: 1,
          blocks: [
            {
              type: 'text',
              text: `${retained.hiddenContext?.text}\n\n${retained.text}`,
            },
          ],
        }).agentSent,
      ).toBeUndefined();
      await expect(
        target.command(
          envelope('close-local-cancel', {
            type: 'chat.close_tab',
            tabId: 'chat-1',
            mode: 'archive',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    } finally {
      validation.mockRestore();
    }
  });

  it('review 2: permanent queue cancellation persists the safe error and withdraws retained evidence', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const request = reviewAgentRequest('cancel-refused');
      await target.retainTrustedTerminalInput(request);
      const lastErrorMessage =
        'The agent that sent this message can no longer reach this chat.';
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: 'chat-1' },
        [],
        false,
        { type: 'cancel', request, lastErrorMessage },
      );
      const state = await target.getState(SCOPE);
      expect(state.runtimeByChatId['chat-1']?.error).toMatchObject({
        message: lastErrorMessage,
        retryable: false,
      });
      expect(state.tabsFile.tabs[0].inputDelivery?.rows[0]).toMatchObject({
        state: 'cancelled',
        reason: lastErrorMessage,
      });
      expect(
        retainedTerminalAgentInput(
          state.tabsFile.tabs[0],
          request.userMessageId,
        ),
      ).toBeUndefined();
    } finally {
      validation.mockRestore();
    }
  });

  it('review: terminal transcript ingestion settles delivery atomically so restart and close work', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const retained = reviewAgentRequest('import-agent');
      await target.retainTrustedTerminalInput(retained);
      const before = (await target.getState(SCOPE)).tabsFile.tabs[0];
      const message = correlateTerminalAgentMessage(before, {
        id: 'provider-import',
        role: 'user',
        timestamp: 1,
        blocks: [
          {
            type: 'text',
            text: `${retained.hiddenContext?.text}\n\n${retained.text}`,
          },
        ],
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        source: 'terminal',
        mutationId: 'terminal-import',
        data: {
          type: 'claude_terminal_transcript_sync',
          messages: [message],
          importedEventCount: 1,
        },
      });
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.messages).toContainEqual(
        expect.objectContaining({
          id: retained.userMessageId,
          userMessageSource: 'agent',
        }),
      );
      expect(tab.inputDelivery?.rows[0]).toMatchObject({
        state: 'picked-up',
        attempts: [
          expect.objectContaining({
            generation: 'managed-terminal',
            pickedUpAt: expect.any(Number),
          }),
        ],
      });
      const restarted = serviceWithRepository(
        { inputSession: async () => undefined },
        copyDurableFilesAtBoundary(),
      ).target;
      Object.defineProperty(restarted, 'reconcileHostRuntime', { value: true });
      expect(
        (await restarted.getState(SCOPE)).tabsFile.tabs[0].inputDelivery
          ?.rows[0].state,
      ).toBe('picked-up');
      await expect(
        restarted.command(
          envelope('close-imported', {
            type: 'chat.close_tab',
            tabId: 'chat-1',
            mode: 'archive',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    } finally {
      validation.mockRestore();
    }
  });

  it('permanently rejects retained terminal correlation when sender revalidation fails before paste', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'rejected-agent',
        text: 'Never delivered',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'rejected-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Captured note</system_instruction>',
        },
      };
      await target.retainTrustedTerminalInput(request);
      validation.mockRejectedValue(new Error('Private origin lookup detail'));
      await expect(
        target.authorizeRetainedTerminalAgentInputWrite(
          { ...SCOPE, chatId: 'chat-1' },
          request.userMessageId,
        ),
      ).rejects.toThrow(
        'The agent that sent this message can no longer reach this chat.',
      );
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows[0]).toMatchObject({
        state: 'cancelled',
        payload: {
          agentSent: request.agentSent,
          agentSenderProvenance: request.agentSenderProvenance,
        },
      });
      expect(
        retainedTerminalAgentInput(tab, request.userMessageId),
      ).toBeUndefined();
      await expect(
        target.editRetainedTerminalAgentInput({
          ...SCOPE,
          chatId: 'chat-1',
          entryId: request.userMessageId,
          text: 'Too late',
        }),
      ).rejects.toThrow(
        'The retained terminal agent input is no longer editable.',
      );
      validation.mockResolvedValue(undefined);
      await expect(
        target.authorizeRetainedTerminalAgentInputWrite(
          { ...SCOPE, chatId: 'chat-1' },
          request.userMessageId,
        ),
      ).rejects.toThrow('can no longer reach');
      expect(
        retainedTerminalAgentInput(
          (await target.getState(SCOPE)).tabsFile.tabs[0],
          request.userMessageId,
        ),
      ).toBeUndefined();
    } finally {
      validation.mockRestore();
    }
  });

  it('durably edits only the visible fields of an uncommitted retained terminal agent input', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'editable-agent',
        text: 'Before edit',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'editable-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Captured note</system_instruction>',
        },
        attachmentPaths: ['/old.png'],
        inputMode: 'voice',
      };
      await target.retainTrustedTerminalInput(request);
      const before = (await target.getState(SCOPE)).tabsFile.tabs[0];
      if (!before.inputDelivery)
        throw new Error('Missing retained input fixture');
      await repository.transact(
        SCOPE,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: {
              inputDelivery: {
                ...before.inputDelivery,
                rows: [
                  ...before.inputDelivery.rows,
                  {
                    id: 'non-agent',
                    revision: 1,
                    createdAt: 1,
                    state: 'sending',
                    settingsKey: '',
                    text: 'ordinary',
                    payload: {
                      ...SCOPE,
                      chatId: 'chat-1',
                      userMessageId: 'non-agent',
                      text: 'ordinary',
                    },
                    attempts: [
                      {
                        id: 'non-agent',
                        generation: 'managed-terminal',
                        provider: 'claude',
                        createdAt: 1,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
        { source: 'provider' },
      );

      await expect(
        target.editRetainedTerminalAgentInput({
          ...SCOPE,
          chatId: 'different-chat',
          entryId: request.userMessageId,
          text: 'No',
        }),
      ).rejects.toThrow();
      await expect(
        target.editRetainedTerminalAgentInput({
          ...SCOPE,
          chatId: 'chat-1',
          entryId: 'non-agent',
          text: 'No',
        }),
      ).rejects.toThrow();
      await expect(
        target.editRetainedTerminalAgentInput({
          ...SCOPE,
          chatId: 'chat-1',
          entryId: request.userMessageId,
          text: 'After edit',
        }),
      ).resolves.toBe('applied');
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.inputDelivery?.rows[0].payload).toMatchObject({
        text: 'After edit',
        agentSent: request.agentSent,
        agentSenderProvenance: request.agentSenderProvenance,
        hiddenContext: request.hiddenContext,
        inputMode: 'voice',
      });
      expect(
        tab.inputDelivery?.rows[0].payload.attachmentPaths,
      ).toBeUndefined();
      const imported = correlateTerminalAgentMessage(tab, {
        id: 'native',
        role: 'user',
        timestamp: 1,
        blocks: [
          {
            type: 'text',
            text: `${request.hiddenContext?.text}\n\nAfter edit`,
          },
        ],
      });
      expect(imported).toMatchObject({
        userMessageSource: 'agent',
        agentSent: request.agentSent,
        blocks: [{ type: 'text', text: 'After edit' }],
      });
      await target.command(
        envelope('commit-edited-agent', {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: 'chat-1',
          userMessageId: request.userMessageId,
          turnTimerMessageId: 'edit-timer',
          text: 'After edit',
        }),
      );
      await expect(
        target.editRetainedTerminalAgentInput({
          ...SCOPE,
          chatId: 'chat-1',
          entryId: request.userMessageId,
          text: 'Too late',
        }),
      ).rejects.toThrow();
    } finally {
      validation.mockRestore();
    }
  });

  it('correlates terminal commits to durable main evidence, ignores renderer body and deduplicates', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const target = service();
      await createChat(target);
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'agent-input',
        text: 'Original visible body',
        agentSent: {
          sender,
          chatTitle: 'Captured title',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'agent-input',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Never display this</system_instruction>',
        },
      };
      await target.retainTrustedTerminalInput(request);
      await target.retainTrustedTerminalInput(request);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0].messages,
      ).toHaveLength(0);
      const commit = {
        type: 'chat.commit_terminal_initial_prompt' as const,
        chatId: 'chat-1',
        userMessageId: 'agent-input',
        turnTimerMessageId: 'agent-timer',
        text: 'Renderer cannot replace accepted body',
      };
      expect(
        await target.command(envelope('commit-agent', commit)),
      ).toMatchObject({ outcome: 'applied' });
      expect(
        await target.command(envelope('repeat-agent', commit)),
      ).toMatchObject({ outcome: 'already_applied' });
      const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(tab.messages[0]).toMatchObject({
        userMessageSource: 'agent',
        agentSent: request.agentSent,
        blocks: [{ type: 'text', text: request.text }],
      });
      expect(JSON.stringify(tab.messages)).not.toContain('Never display');
      expect(tab.inputDelivery?.rows).toHaveLength(1);
      expect(tab.inputDelivery?.rows[0].state).toBe('picked-up');
      expect(dispatched).toEqual([]);
      await target.command(
        envelope('unknown-terminal-input', {
          ...commit,
          userMessageId: 'unknown-input',
          turnTimerMessageId: 'unknown-timer',
        }),
      );
      const unknown = (
        await target.getState(SCOPE)
      ).tabsFile.tabs[0].messages.find(
        (message) => message.id === 'unknown-input',
      );
      expect(unknown?.userMessageSource).toBe('human');
      expect(unknown).not.toHaveProperty('agentSent');
    } finally {
      validation.mockRestore();
    }
  });

  it('commits a consumed terminal initial prompt without dispatching a second turn', async () => {
    const target = service();
    await target.command(
      envelope('create-terminal-placeholder', {
        type: 'chat.create_tab',
        tabId: 'chat-terminal',
        title: 'New chat',
        interfaceMode: 'claude-code',
      }),
    );
    await target.command(
      envelope('seed-terminal-instructions', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-terminal',
        patch: {
          pendingSystemInstructions: [
            { id: 'instruction-1', text: 'Read /tmp/plan.md.' },
          ],
        },
      }),
    );

    await expect(
      target.command(
        envelope('commit-terminal-prompt', {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: 'chat-terminal',
          userMessageId: 'terminal-user-1',
          turnTimerMessageId: 'terminal-timer-1',
          text: 'Launch this prompt',
          pendingSystemInstructionIds: ['instruction-1'],
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab).toMatchObject({
      title: 'Launch this prompt',
      messages: [
        expect.objectContaining({ id: 'terminal-user-1', role: 'user' }),
        expect.objectContaining({ id: 'terminal-timer-1', role: 'system' }),
      ],
    });
    expect(tab?.pendingSystemInstructions).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  it('persists provider session metadata through the canonical settings command', async () => {
    const target = service();
    await createChat(target);

    await expect(
      target.command(
        envelope('persist-provider-session', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            sdkSessionId: 'thread-forked-1',
            globalInstructionsSnapshot:
              '# User Overall Preferences\n\nOriginal snapshot.',
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      sdkSessionId: 'thread-forked-1',
      globalInstructionsSnapshot:
        '# User Overall Preferences\n\nOriginal snapshot.',
    });
  });

  it('commits repeated terminal prompts when their correlation ids are distinct', async () => {
    const target = service();
    await target.command(
      envelope('create-terminal-repeat', {
        type: 'chat.create_tab',
        tabId: 'chat-terminal-repeat',
        title: 'New chat',
        interfaceMode: 'claude-code',
      }),
    );

    for (const suffix of ['1', '2']) {
      await expect(
        target.command(
          envelope(`commit-terminal-repeat-${suffix}`, {
            type: 'chat.commit_terminal_initial_prompt',
            chatId: 'chat-terminal-repeat',
            userMessageId: `terminal-repeat-user-${suffix}`,
            turnTimerMessageId: `terminal-repeat-timer-${suffix}`,
            text: 'Run the same prompt',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    }

    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.map(
        ({ id }) => id,
      ),
    ).toEqual([
      'terminal-repeat-user-1',
      'terminal-repeat-timer-1',
      'terminal-repeat-user-2',
      'terminal-repeat-timer-2',
    ]);
  });

  it('commits the complete durable plan-review state in one revision', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('dismiss-plan-attention', {
        type: 'chat.dismiss_attention',
        chatId: 'chat-1',
      }),
    );

    await target.commitPlanExit({
      requestId: 'plan-request-1',
      ...SCOPE,
      chatId: 'chat-1',
      toolInput: { plan: 'Ship it' },
      pendingSystemInstructions: [{ id: 'instruction-1', text: 'Review it' }],
      planId: 'plan-1',
      source: 'codex',
      revisionNumber: 7,
    });

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      pendingPlanExit: { plan: 'Ship it' },
      pendingPlanExitRequestId: 'plan-request-1',
      pendingSystemInstructions: [{ id: 'instruction-1', text: 'Review it' }],
      trackedPlanId: 'plan-1',
      trackedPlanSource: 'codex',
      trackedPlanReviewStatus: 'pending',
      latestRevisionNumber: 7,
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.attentionDismissedAt,
    ).toBeUndefined();
  });

  it('does not publish an OpenCode proposal after its planning mode or active turn changes', async () => {
    const target = service();
    await createChat(target);
    const event = {
      requestId: 'late-opencode-plan',
      ...SCOPE,
      chatId: 'chat-1',
      toolInput: { plan: 'Late plan', source: 'opencode' },
      source: 'opencode' as const,
      reviewMode: 'proposal' as const,
    };
    expect(
      await target.commitPlanExit(event, {
        requirePlanMode: true,
        expectedUserMessageId: 'planning-turn',
      }),
    ).toBe(false);
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.pendingPlanExit,
    ).toBeUndefined();
    await target.command(
      envelope('plan-mode-on', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      }),
    );
    expect(
      await target.commitPlanExit(
        { ...event, requestId: 'late-opencode-plan-second' },
        { requirePlanMode: true, expectedUserMessageId: 'another-turn' },
      ),
    ).toBe(false);
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.pendingPlanExit,
    ).toBeUndefined();
  });

  describe('approval bound to an implementation message', () => {
    async function pendingReview(
      overrides: Partial<ChatStateServiceOptions> = {},
    ): Promise<ChatStateService> {
      const target = serviceWithRepository(overrides).target;
      await target.command(
        envelope('create-plan-chat', {
          type: 'chat.create_tab',
          tabId: 'plan-chat',
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
        }),
      );
      await target.command(
        envelope('enable-planning', {
          type: 'chat.patch_tab_settings',
          tabId: 'plan-chat',
          patch: { planMode: true },
        }),
      );
      await target.commitPlanExit({
        ...SCOPE,
        chatId: 'plan-chat',
        requestId: 'proposal-request',
        source: 'opencode',
        reviewMode: 'proposal',
        planId: 'tracked-plan',
        revisionNumber: 2,
        toolInput: { source: 'opencode', plan: 'Implement the parser' },
      });
      return target;
    }

    it('keeps planning mode and its review when the saved plan revision no longer matches', async () => {
      const approvePlanReview = jest.fn(() => Promise.resolve(false));
      const target = await pendingReview({ approvePlanReview });
      const send = {
        type: 'chat.send_message' as const,
        chatId: 'plan-chat',
        userMessageId: 'stale-plan-message',
        text: 'Implement.',
        planReviewApproval: {
          requestId: 'proposal-request',
          planId: 'tracked-plan',
          revisionNumber: 2,
        },
      };
      await expect(
        target.command(envelope('stale-plan-file', send)),
      ).resolves.toMatchObject({ outcome: 'rejected' });
      expect(approvePlanReview).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveLength(0);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs.find(
          (tab) => tab.id === 'plan-chat',
        ),
      ).toMatchObject({
        planMode: true,
        pendingPlanExitRequestId: 'proposal-request',
      });
    });

    it('rejects a saved plan edit between approval and canonical message acceptance', async () => {
      const planFile = join(tempDir, 'tracked-plans.json');
      const planPath = jest
        .spyOn(resolveWorktree, 'resolveTrackedPlansFilePath')
        .mockReturnValue(planFile);
      const createdAt = new Date().toISOString();
      writeFileSync(
        planFile,
        JSON.stringify({
          version: 1,
          plans: [
            {
              ...SCOPE,
              id: 'tracked-plan',
              source: 'opencode',
              title: 'Reviewed parser plan',
              content: 'Reviewed parser plan',
              reviewStatus: 'pending',
              createdAt,
              updatedAt: createdAt,
              latestRevisionNumber: 2,
              revisions: [
                {
                  revisionNumber: 2,
                  content: 'Reviewed parser plan',
                  source: 'opencode',
                  reviewStatus: 'pending',
                  createdAt,
                },
              ],
              linkedExecutionIds: [],
            },
          ],
        }),
      );
      try {
        const target = await pendingReview({
          ...{ withPlanReviewRevision: undefined },
          approvePlanReview: async (request) => {
            const approved = await planPersistence.updateTrackedPlan(
              {
                ...request,
                reviewStatus: 'approved',
                approvedAt: request.approvedAt,
              },
              { revisionNumber: request.revisionNumber, source: 'opencode' },
            );
            expect(approved?.latestRevisionNumber).toBe(2);
            const edited = await planPersistence.updateTrackedPlan({
              ...SCOPE,
              planId: 'tracked-plan',
              content: 'Unreviewed replacement',
            });
            expect(edited?.latestRevisionNumber).toBe(3);
            return approved !== null;
          },
        });
        await expect(
          target.command(
            envelope('approval-racing-plan-save', {
              type: 'chat.send_message',
              chatId: 'plan-chat',
              userMessageId: 'racing-implementation',
              text: 'Implement.',
              planReviewApproval: {
                requestId: 'proposal-request',
                planId: 'tracked-plan',
                revisionNumber: 2,
              },
            }),
          ),
        ).resolves.toMatchObject({ outcome: 'rejected' });
        expect(dispatched).toHaveLength(0);
        const tab = (await target.getState(SCOPE)).tabsFile.tabs.find(
          (entry) => entry.id === 'plan-chat',
        );
        expect(tab).toMatchObject({
          planMode: true,
          trackedPlanReviewStatus: 'pending',
          pendingPlanExitRequestId: 'proposal-request',
        });
        expect(
          tab?.messages.some(
            (message) => message.id === 'racing-implementation',
          ),
        ).toBe(false);
      } finally {
        planPath.mockRestore();
      }
    });

    it('rechecks the request after recording plan approval and before accepting a message', async () => {
      const target = await pendingReview({
        approvePlanReview: async () => {
          await replaceReview();
          return true;
        },
      });
      const replaceReview = async (): Promise<void> => {
        await target.commitPlanExit({
          ...SCOPE,
          chatId: 'plan-chat',
          requestId: 'new-review',
          source: 'opencode',
          reviewMode: 'proposal',
          planId: 'tracked-plan',
          revisionNumber: 3,
          toolInput: { source: 'opencode', plan: 'Changed plan' },
        });
      };
      const send = {
        type: 'chat.send_message' as const,
        chatId: 'plan-chat',
        userMessageId: 'stale-implementation',
        text: 'Implement.',
        planReviewApproval: {
          requestId: 'proposal-request',
          planId: 'tracked-plan',
          revisionNumber: 2,
        },
      };
      await expect(
        target.command(envelope('replaced-review-approval', send)),
      ).resolves.toMatchObject({ outcome: 'rejected' });
      expect(dispatched).toHaveLength(0);
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs.find(
          (tab) => tab.id === 'plan-chat',
        ),
      ).toMatchObject({
        planMode: true,
        pendingPlanExitRequestId: 'new-review',
      });
    });

    it('keeps the proposal pending when pairing is revoked during the plan write', async () => {
      let connected = true;
      const target = await pendingReview({
        approvePlanReview: async () => {
          connected = false;
          return true;
        },
      });
      await expect(
        target.command(
          envelope('revoked-approval', {
            type: 'chat.send_message',
            chatId: 'plan-chat',
            userMessageId: 'revoked-message',
            text: 'Implement.',
            planReviewApproval: {
              requestId: 'proposal-request',
              planId: 'tracked-plan',
              revisionNumber: 2,
            },
          }),
          { canCommitSend: () => connected },
        ),
      ).resolves.toMatchObject({ outcome: 'rejected' });
      expect(dispatched).toHaveLength(0);
      const tab = (await target.getState(SCOPE)).tabsFile.tabs.find(
        (entry) => entry.id === 'plan-chat',
      );
      expect(tab).toMatchObject({
        planMode: true,
        pendingPlanExitRequestId: 'proposal-request',
      });
      expect(
        tab?.messages.some((message) => message.id === 'revoked-message'),
      ).toBe(false);
    });

    it('commits approval, the user message and default mode together before dispatch', async () => {
      const target = await pendingReview();
      const send = {
        type: 'chat.send_message' as const,
        chatId: 'plan-chat',
        userMessageId: 'implementation-message',
        text: 'Approved. Implement the plan.',
        planReviewApproval: {
          requestId: 'proposal-request',
          planId: 'tracked-plan',
          revisionNumber: 2,
        },
      };
      await expect(
        target.command(envelope('approve-and-send', send)),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const state = await target.getState(SCOPE);
      const tab = state.tabsFile.tabs.find((entry) => entry.id === 'plan-chat');
      expect(tab).toMatchObject({
        planMode: false,
        trackedPlanReviewStatus: 'approved',
        hasOutstandingProposal: false,
      });
      expect(tab?.pendingPlanExitRequestId).toBeUndefined();
      expect(tab?.pendingPlanExit).toBeUndefined();
      expect(
        tab?.messages.filter(
          (message) => message.id === 'implementation-message',
        ),
      ).toHaveLength(1);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.planMode).toBe(false);
      await expect(
        target.command(envelope('approve-and-send-retry', send)),
      ).resolves.toMatchObject({ outcome: 'already_applied' });
      expect(dispatched).toHaveLength(1);
    });

    it.each(['request', 'plan', 'revision', 'active-turn', 'queued-revision'])(
      'refuses a %s mismatch before persisting or dispatching implementation',
      async (mismatch) => {
        const target = await pendingReview();
        if (mismatch === 'active-turn') {
          await target.command(
            envelope('revision-turn', {
              type: 'chat.send_message',
              chatId: 'plan-chat',
              userMessageId: 'revision-message',
              text: 'Revise it',
            }),
          );
        }
        if (mismatch === 'queued-revision') {
          await target.reconcileHostQueue(
            { ...SCOPE, chatId: 'plan-chat' },
            ['queued-revision'],
            false,
          );
        }
        const beforeDispatches = dispatched.length;
        const send = {
          type: 'chat.send_message' as const,
          chatId: 'plan-chat',
          userMessageId: 'implementation-message',
          text: 'Approved. Implement the plan.',
          planReviewApproval: {
            requestId:
              mismatch === 'request' ? 'old-request' : 'proposal-request',
            planId: mismatch === 'plan' ? 'other-plan' : 'tracked-plan',
            revisionNumber: mismatch === 'revision' ? 1 : 2,
          },
        };
        await expect(
          target.command(envelope('rejected-approval', send)),
        ).resolves.toMatchObject({ outcome: 'rejected' });
        const tab = (await target.getState(SCOPE)).tabsFile.tabs.find(
          (entry) => entry.id === 'plan-chat',
        );
        expect(tab).toMatchObject({
          planMode: true,
          pendingPlanExitRequestId: 'proposal-request',
          trackedPlanReviewStatus: 'pending',
        });
        expect(
          tab?.messages.some(
            (message) => message.id === 'implementation-message',
          ),
        ).toBe(false);
        expect(dispatched).toHaveLength(beforeDispatches);
      },
    );
  });

  it('refuses approval of an OpenCode proposal while a revision turn is active', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('plan-mode-on', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      }),
    );
    await target.commitPlanExit({
      ...SCOPE,
      chatId: 'chat-1',
      requestId: 'open-proposal',
      source: 'opencode',
      reviewMode: 'proposal',
      toolInput: { source: 'opencode', plan: 'Initial plan' },
    });
    await expect(
      target.command(
        envelope('revise-plan', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'revision-turn',
          text: 'Revise the plan',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const resolution = {
      type: 'chat.patch_tab_settings' as const,
      tabId: 'chat-1',
      expectedPendingPlanExitRequestId: 'open-proposal',
      patch: {
        planMode: false,
        pendingPlanExit: null,
        pendingPlanExitRequestId: null,
      },
    };
    await expect(
      target.command(envelope('early-approval', resolution)),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      planMode: true,
      pendingPlanExitRequestId: 'open-proposal',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'revision-completed',
      data: {
        type: 'result',
        provider: 'opencode',
        is_error: false,
        result: 'No changes needed',
      },
    });
    await expect(
      target.command(envelope('idle-approval', resolution)),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  it.each(['current', 'cancelled', 'other-plan', 'other-turn', 'mode-off'])(
    'retires an OpenCode plan review only for its current revision writer: %s',
    async (scenario) => {
      const target = service();
      await createChat(target);
      await target.command(
        envelope('enable-plan-mode', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { planMode: scenario !== 'mode-off' },
        }),
      );
      await target.commitPlanExit({
        ...SCOPE,
        chatId: 'chat-1',
        requestId: 'old-review',
        source: 'opencode',
        reviewMode: 'proposal',
        planId: 'plan-1',
        revisionNumber: 1,
        toolInput: { plan: 'Old plan', source: 'opencode' },
        pendingSystemInstructions: [
          { id: 'plan-file-location:plan-1', text: 'Old plan location' },
          { id: 'unrelated', text: 'Keep this instruction' },
        ],
      });
      const retired = await target.retirePlanReview({
        ...SCOPE,
        chatId: 'chat-1',
        planId: scenario === 'other-plan' ? 'plan-2' : 'plan-1',
        ...(scenario === 'other-turn'
          ? { expectedUserMessageId: 'another-turn' }
          : {}),
        isCurrent: () => scenario !== 'cancelled',
      });
      expect(retired).toBe(scenario === 'current');
      const tab = (await service().getState(SCOPE)).tabsFile.tabs[0];
      if (scenario !== 'current') {
        expect(tab).toMatchObject({
          pendingPlanExitRequestId: 'old-review',
          trackedPlanId: 'plan-1',
        });
        return;
      }
      expect(tab).toMatchObject({
        planMode: true,
        hasOutstandingProposal: false,
        pendingSystemInstructions: [
          { id: 'unrelated', text: 'Keep this instruction' },
        ],
      });
      expect(tab?.pendingPlanExitRequestId).toBeUndefined();
      expect(tab?.pendingPlanExit).toBeUndefined();
      expect(tab?.trackedPlanId).toBeUndefined();
      expect(tab?.trackedPlanSource).toBeUndefined();
      expect(tab?.trackedPlanReviewStatus).toBeUndefined();
      expect(tab?.latestRevisionNumber).toBeUndefined();
      await expect(
        target.command(
          envelope('stale-approval', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            expectedPendingPlanExitRequestId: 'old-review',
            patch: { planMode: false },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'conflict' });
    },
  );

  it('preserves a formal OpenCode proposal across terminal drain and restart', async () => {
    const target = service();
    await createChat(target);
    await target.commitPlanExit({
      requestId: 'opencode-plan',
      ...SCOPE,
      chatId: 'chat-1',
      toolInput: { plan: 'Validate the parser', source: 'opencode' },
      source: 'opencode',
      reviewMode: 'proposal',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'opencode-plan-terminal',
      data: {
        type: 'result',
        provider: 'opencode',
        is_error: false,
        result: 'Completed',
      },
    });
    expect((await service().getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      pendingPlanExitRequestId: 'opencode-plan',
      pendingPlanExit: { plan: 'Validate the parser', source: 'opencode' },
    });
  });

  it('rejects a plan resolution correlated to a superseded proposal', async () => {
    const target = service();
    await createChat(target);
    await target.commitPlanExit({
      requestId: 'plan-request-new',
      ...SCOPE,
      chatId: 'chat-1',
      toolInput: { plan: 'Newest plan' },
      source: 'claude',
    });

    await expect(
      target.command(
        envelope('stale-plan-resolution', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          expectedPendingPlanExitRequestId: 'plan-request-old',
          patch: {
            pendingPlanExit: null,
            pendingPlanExitRequestId: null,
            planMode: false,
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      pendingPlanExit: { plan: 'Newest plan' },
      pendingPlanExitRequestId: 'plan-request-new',
    });

    await expect(
      target.command(
        envelope('current-plan-resolution', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          expectedPendingPlanExitRequestId: 'plan-request-new',
          patch: {
            pendingPlanExit: null,
            pendingPlanExitRequestId: null,
            planMode: false,
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  it.each([
    ['cursor', 'proposal', true],
    ['codex', 'manual', false],
  ] as const)(
    'retains %s %s according to explicit review mode',
    async (source, reviewMode, retained) => {
      const target = service();
      await createChat(target);
      await target.commitPlanExit({
        requestId: 'review-mode-request',
        ...SCOPE,
        chatId: 'chat-1',
        source,
        reviewMode,
        toolInput: { plan: 'Review this' },
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'proposal-terminal',
        data: { type: 'result', is_error: false, result: 'Completed' },
      });
      expect(
        Boolean(
          (await target.getState(SCOPE)).tabsFile.tabs[0]?.pendingPlanExit,
        ),
      ).toBe(retained);
    },
  );

  it('deduplicates a committed proposal and admits only one concurrent resolution', async () => {
    const target = service();
    await createChat(target);
    const event = {
      requestId: 'proposal-once',
      ...SCOPE,
      chatId: 'chat-1',
      source: 'cursor' as const,
      reviewMode: 'proposal' as const,
      toolInput: { plan: 'One revision' },
    };
    await target.commitPlanExit(event);
    const revision = (await target.getState(SCOPE)).revision;
    await target.commitPlanExit(event);
    expect((await target.getState(SCOPE)).revision).toBe(revision);
    const outcomes = await Promise.all(
      ['approve-one', 'approve-two'].map((id) =>
        target.command(
          envelope(id, {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            expectedPendingPlanExitRequestId: 'proposal-once',
            patch: {
              pendingPlanExit: null,
              pendingPlanExitRequestId: null,
              planMode: false,
            },
          }),
        ),
      ),
    );
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      'applied',
      'conflict',
    ]);
  });

  it('rejects a proposal completed for an older user turn', async () => {
    const target = service();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'newer-turn',
      turnUserMessageId: 'newer-turn',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'newer-turn',
        canopy_persisted_messages: [
          {
            id: 'newer-turn',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'A newer request' }],
          },
        ],
      },
    });
    await expect(
      target.commitPlanExit({
        requestId: 'stale-turn-proposal',
        ...SCOPE,
        chatId: 'chat-1',
        source: 'cursor',
        reviewMode: 'proposal',
        turnUserMessageId: 'older-turn',
        toolInput: { plan: 'Obsolete' },
      }),
    ).rejects.toThrow('superseded');
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.pendingPlanExit,
    ).toBeUndefined();
  });

  it.each([
    ['cursor', 'proposal', 'conflict'],
    ['codex', 'manual', 'applied'],
  ] as const)(
    'checks %s %s plan resolution while a turn streams',
    async (source, reviewMode, outcome) => {
      const target = service();
      await createChat(target);
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'planning-user',
        turnUserMessageId: 'planning-user',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'planning-user',
          canopy_persisted_messages: [
            {
              id: 'planning-user',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Revise the plan' }],
            },
          ],
        },
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'planning-assistant',
        turnUserMessageId: 'planning-user',
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Planning...' }] },
        },
      });
      await target.commitPlanExit({
        requestId: 'live-proposal',
        ...SCOPE,
        chatId: 'chat-1',
        source,
        reviewMode,
        toolInput: { plan: 'Pending plan' },
      });
      expect(
        (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.status,
      ).toBe('streaming');
      await expect(
        target.command(
          envelope('guarded-projection', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            expectedPendingPlanExitRequestId: 'live-proposal',
            patch: {
              trackedPlanId: 'tracked-proposal',
              trackedPlanSource: source,
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        target.command(
          envelope('streaming-approve', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            expectedPendingPlanExitRequestId: 'live-proposal',
            patch: {
              pendingPlanExit: null,
              pendingPlanExitRequestId: null,
              planMode: false,
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome });
      expect(
        (await target.getState(SCOPE)).tabsFile.tabs[0]
          ?.pendingPlanExitRequestId,
      ).toBe(outcome === 'conflict' ? 'live-proposal' : undefined);
    },
  );

  it('refuses a deleted chat proposal instead of notifying an uncommitted request', async () => {
    const target = service();
    await createChat(target);
    await expect(
      target.commitPlanExit({
        requestId: 'deleted-chat-request',
        ...SCOPE,
        chatId: 'missing-chat',
        source: 'cursor',
        reviewMode: 'proposal',
        toolInput: { plan: 'Stale plan' },
      }),
    ).rejects.toThrow('no longer available');
  });

  it('clears a non-sticky Claude plan exit on a terminal provider event', async () => {
    const target = service();
    await createChat(target);
    await target.commitPlanExit({
      requestId: 'plan-request-terminal',
      ...SCOPE,
      chatId: 'chat-1',
      toolInput: { plan: 'Review this implementation' },
      source: 'claude',
    });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'terminal-clears-plan-exit',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });

    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.pendingPlanExit,
    ).toBeUndefined();
  });

  it('persists send-time composer settings atomically with the user message', async () => {
    const target = service();
    await createChat(target);
    const command = {
      type: 'chat.send_message' as const,
      chatId: 'chat-1',
      userMessageId: 'user-with-settings',
      text: 'Use these composer settings',
    };
    Reflect.set(command, 'planMode', true);
    Reflect.set(command, 'modelConfig', {
      thinkingLevel: 'high',
      fastMode: true,
    });
    Reflect.set(command, 'codexProposalMode', 'required');
    Reflect.set(command, 'modelSelectionMode', 'auto');

    await target.command(envelope('send-with-settings', command));

    const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab).toMatchObject({
      planMode: true,
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      proposalMode: 'required',
      modelSelectionMode: 'auto',
      messages: [expect.objectContaining({ id: 'user-with-settings' })],
    });
    expect(dispatched.at(-1)).toMatchObject({
      userMessageId: 'user-with-settings',
      modelSelectionMode: 'auto',
    });
  });

  it('dispatches a persisted Auto chat in Auto when the send omits the mode', async () => {
    // Remote Control enters Auto with `chat.patch_tab_settings` and then sends
    // an ordinary `chat.send_message`; without the canonical fallback the turn
    // would silently dispatch manual and never route.
    const target = service();
    await createChat(target);
    await target.command(
      envelope('enter-auto', {
        type: 'chat.patch_tab_settings' as const,
        tabId: 'chat-1',
        patch: { modelSelectionMode: 'auto' as const },
      }),
    );

    await target.command(
      envelope('send-without-mode', {
        type: 'chat.send_message' as const,
        chatId: 'chat-1',
        userMessageId: 'user-without-mode',
        text: 'Route this turn',
      }),
    );

    expect(dispatched.at(-1)).toMatchObject({
      userMessageId: 'user-without-mode',
      modelSelectionMode: 'auto',
    });
  });

  it('reduces complete provider output and session identity with no subscribers', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-1', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-1',
        text: 'Continue',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-1',
      mutationId: 'init-1',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
      },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-1',
      mutationId: 'assistant-1',
      data: {
        type: 'assistant',
        message: {
          id: 'assistant-native-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Completed without a renderer' }],
        },
      },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-1',
      mutationId: 'terminal-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'Completed',
        session_id: 'session-1',
        duration_ms: 50,
      },
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('completed');
    expect(snapshot.tabsFile.tabs[0]?.sdkSessionId).toBe('session-1');
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Completed without a renderer',
    );
  });

  it('keeps one foreground turn open across a continuation-marked Claude prelude and all later output', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-prelude-sequence', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-prelude-sequence',
        text: 'Finish after the background notification',
      }),
    );

    const events = [
      {
        mutationId: 'prelude',
        data: {
          type: 'result',
          is_error: false,
          num_turns: 0,
          result: '',
          origin: { kind: 'task-notification' },
          canopy_session_continues: true,
        },
      },
      {
        mutationId: 'thinking',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Still working' }],
          },
        },
      },
      {
        mutationId: 'assistant-text',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Reading the fixture' }],
          },
        },
      },
      {
        mutationId: 'tool-use',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-prelude-1',
                name: 'Read',
                input: { file_path: '/tmp/fixture.txt' },
              },
            ],
          },
        },
      },
      {
        mutationId: 'tool-result',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-prelude-1',
                content: 'fixture contents',
                is_error: false,
              },
            ],
          },
        },
      },
      {
        mutationId: 'final-text',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Follow-up finished after interruption.',
              },
            ],
          },
        },
      },
    ];

    for (const event of events) {
      await expect(
        target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'user-prelude-sequence',
          ...event,
        }),
      ).resolves.toBe(true);
      const snapshot = await target.getState(SCOPE);
      const runtime = snapshot.runtimeByChatId['chat-1'];
      expect(runtime?.activeTurn?.userMessageId).toBe('user-prelude-sequence');
      expect(runtime?.status).not.toBe('completed');
      expect(runtime?.error?.code).not.toBe('empty_completion');
      expect(runtime?.activeTurn?.startedAt).toEqual(expect.any(Number));
    }

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-prelude-sequence',
        mutationId: 'actual-terminal',
        data: {
          type: 'result',
          is_error: false,
          num_turns: 1,
          result: 'Follow-up finished after interruption.',
          duration_ms: 125,
        },
      }),
    ).resolves.toBe(true);

    const completed = await target.getState(SCOPE);
    expect(completed.runtimeByChatId['chat-1']).toMatchObject({
      status: 'completed',
    });
    expect(completed.runtimeByChatId['chat-1']?.activeTurn).toBeUndefined();
    const persisted = JSON.stringify(completed.tabsFile.tabs[0]?.messages);
    expect(persisted).toContain('Still working');
    expect(persisted).toContain('Reading the fixture');
    expect(persisted).toContain('fixture contents');
    expect(persisted).toContain('Follow-up finished after interruption.');
  });

  it.each([
    ['short', 50],
    ['long', 14 * 60 * 1_000],
  ])(
    'persists a recoverable failure for a %s successful turn with no output',
    async (_label, durationMs) => {
      const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
      const target = serviceWithRepository({ recordDiagnostic }).target;
      await createChat(target);
      await target.command(
        envelope('send-empty', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-empty',
          text: 'Complete this turn',
        }),
      );

      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-empty',
        mutationId: `empty-terminal-${durationMs}`,
        data: {
          type: 'result',
          is_error: false,
          result: 'Completed',
          session_id: 'session-empty',
          duration_ms: durationMs,
        },
      });

      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime).toMatchObject({
        status: 'failed',
        activeTurn: {
          userMessageId: 'user-empty',
          sessionId: 'session-empty',
        },
        error: {
          code: 'empty_completion',
          retryable: true,
        },
        emptyCompletionRecovery: {
          turnUserMessageId: 'user-empty',
          automaticRetryAllowed: false,
        },
      });
      expect(recordDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'empty_turn_completion',
          chatId: 'chat-1',
          providerType: 'claude',
          emptyCompletionTurnUserMessageId: 'user-empty',
          emptyCompletionDurationMs: durationMs,
        }),
      );
    },
  );

  it('classifies an empty Codex root completion as recoverable', async () => {
    const target = service();
    await target.command(
      envelope('create-empty-codex', {
        type: 'chat.create_tab',
        tabId: 'empty-codex',
        title: 'Empty Codex turn',
        providerType: 'codex',
        model: 'gpt-6-astra',
      }),
    );
    await target.command(
      envelope('send-empty-codex', {
        type: 'chat.send_message',
        chatId: 'empty-codex',
        userMessageId: 'user-empty-codex',
        text: 'Complete this turn',
      }),
    );
    const queuedMessage = {
      id: 'queued-after-empty-codex',
      request: {
        ...SCOPE,
        chatId: 'empty-codex',
        userMessageId: 'queued-user',
        text: 'Keep this queued through recovery',
        providerType: 'codex' as const,
        model: 'gpt-6-astra',
      },
      origin: 'desktop' as const,
      enqueuedAtMs: 123,
    };
    await target.reconcileHostQueue(
      { ...SCOPE, chatId: 'empty-codex' },
      [queuedMessage.id],
      true,
      undefined,
      [queuedMessage],
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'empty-codex',
      providerType: 'codex',
      turnUserMessageId: 'user-empty-codex',
      mutationId: 'empty-codex-init',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-empty-codex',
        canopy_turn_user_message_id: 'user-empty-codex',
      },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'empty-codex',
      providerType: 'codex',
      turnUserMessageId: 'user-empty-codex',
      mutationId: 'empty-codex-terminal',
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread-empty-codex',
          turn_id: 'turn-empty-codex',
        },
      },
    });

    expect(
      (await target.getState(SCOPE)).runtimeByChatId['empty-codex'],
    ).toMatchObject({
      status: 'failed',
      error: { code: 'empty_completion' },
      emptyCompletionRecovery: {
        turnUserMessageId: 'user-empty-codex',
        automaticRetryAllowed: false,
      },
      queuedMessages: [queuedMessage],
    });
  });

  it('treats a completed tool result as visible turn output', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-tool-only', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-tool-only',
        text: 'Read the file',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-tool-only',
      mutationId: 'tool-only-sync',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'tool-result',
            role: 'assistant',
            timestamp: 1_786_104_000_000,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'tool-use-1',
                toolName: 'Read',
                output: 'file contents',
                isError: false,
              },
            ],
          },
        ],
      },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-tool-only',
      mutationId: 'tool-only-terminal',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });

    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1'],
    ).toMatchObject({ status: 'completed' });
  });

  it('reconciles late persisted assistant output after an empty completion', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-late-output', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-late-output',
        text: 'Return output eventually',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-late-output',
      mutationId: 'late-output-terminal',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1']?.error?.code,
    ).toBe('empty_completion');

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-late-output',
      mutationId: 'late-output-sync',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'late-assistant',
            role: 'assistant',
            timestamp: 1_786_104_000_001,
            blocks: [{ type: 'text', text: 'Recovered persisted output' }],
          },
        ],
      },
    });

    const reconciled = await target.getState(SCOPE);
    expect(reconciled.runtimeByChatId['chat-1']).toMatchObject({
      status: 'completed',
    });
    expect(reconciled.runtimeByChatId['chat-1']).not.toHaveProperty('error');
    expect(reconciled.runtimeByChatId['chat-1']).not.toHaveProperty(
      'emptyCompletionRecovery',
    );
    expect(JSON.stringify(reconciled.tabsFile.tabs[0]?.messages)).toContain(
      'Recovered persisted output',
    );
  });

  it('keeps empty-completion recovery visible for late Codex lifecycle events without output', async () => {
    const target = service();
    await target.command(
      envelope('create-empty-codex-lifecycle', {
        type: 'chat.create_tab',
        tabId: 'empty-codex-lifecycle',
        title: 'Empty Codex lifecycle',
        providerType: 'codex',
        model: 'gpt-6-astra',
      }),
    );
    await target.command(
      envelope('send-empty-codex-lifecycle', {
        type: 'chat.send_message',
        chatId: 'empty-codex-lifecycle',
        userMessageId: 'user-empty-codex-lifecycle',
        text: 'Complete this turn',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'empty-codex-lifecycle',
      providerType: 'codex',
      turnUserMessageId: 'user-empty-codex-lifecycle',
      mutationId: 'empty-codex-lifecycle-terminal',
      data: {
        type: 'codex',
        canopy_turn_user_message_id: 'user-empty-codex-lifecycle',
        event: { type: 'turn.completed' },
      },
    });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'empty-codex-lifecycle',
      providerType: 'codex',
      turnUserMessageId: 'user-empty-codex-lifecycle',
      mutationId: 'late-codex-item-started',
      data: {
        type: 'codex',
        canopy_turn_user_message_id: 'user-empty-codex-lifecycle',
        event: {
          type: 'item.started',
          item: { id: 'late-command', type: 'command_execution' },
        },
      },
    });

    expect(
      (await target.getState(SCOPE)).runtimeByChatId['empty-codex-lifecycle'],
    ).toMatchObject({
      status: 'failed',
      error: { code: 'empty_completion' },
      emptyCompletionRecovery: {
        turnUserMessageId: 'user-empty-codex-lifecycle',
      },
    });
  });

  const interruptedCodexTurn = {
    type: 'codex',
    canopy_turn_user_message_id: 'user-interrupted-codex',
    event: { type: 'turn.completed', status: 'interrupted' },
  };
  const cancelledCodexResult = {
    type: 'result',
    is_error: false,
    result: 'Turn cancelled',
  };
  it.each([
    ['with no result', [interruptedCodexTurn]],
    [
      'with its result before completion',
      [cancelledCodexResult, interruptedCodexTurn],
    ],
    [
      'with its result after completion',
      [interruptedCodexTurn, cancelledCodexResult],
    ],
  ])(
    'records an interrupted Codex turn without output as cancelled %s',
    async (_label, events) => {
      const target = service();
      const chatId = 'interrupted-codex';
      await target.command(
        envelope('create-interrupted-codex', {
          type: 'chat.create_tab',
          tabId: chatId,
          title: 'Interrupted Codex',
          providerType: 'codex',
          model: 'gpt-6-astra',
        }),
      );
      await target.command(
        envelope('send-interrupted-codex', {
          type: 'chat.send_message',
          chatId,
          userMessageId: 'user-interrupted-codex',
          text: 'Stop me before I answer',
        }),
      );
      for (const [index, data] of events.entries()) {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId,
          providerType: 'codex',
          turnUserMessageId: 'user-interrupted-codex',
          mutationId: `interrupted-codex-${index}`,
          data,
        });
      }

      const runtime = (await target.getState(SCOPE)).runtimeByChatId[chatId];
      expect(runtime?.status).toBe('cancelled');
      expect(runtime?.error?.code).not.toBe('empty_completion');
      expect(runtime).not.toHaveProperty('emptyCompletionRecovery');
    },
  );

  it.each([
    [
      'cancellation',
      { type: 'result', is_error: false, result: 'Interrupted by user' },
      'cancelled',
    ],
    [
      'Claude user cancellation',
      { type: 'result', is_error: false, result: 'Aborted by user' },
      'cancelled',
    ],
    [
      'provider failure',
      { type: 'result', is_error: true, result: 'Provider failed' },
      'failed',
    ],
  ])(
    'does not reclassify %s as an empty completion',
    async (_label, data, status) => {
      const target = service();
      await createChat(target);
      await target.command(
        envelope(`send-${status}`, {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: `user-${status}`,
          text: 'Run this turn',
        }),
      );

      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: `user-${status}`,
        mutationId: `terminal-${status}`,
        data,
      });

      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime?.status).toBe(status);
      expect(runtime?.error?.code).not.toBe('empty_completion');
      expect(runtime).not.toHaveProperty('emptyCompletionRecovery');
    },
  );

  it('maps SDK turn-limit errors without a result into canonical runtime', async () => {
    const target = service();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'sdk-turn-limit',
      data: {
        type: 'result',
        subtype: 'error_max_turns',
        terminal_reason: 'max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (200)'],
      },
    });
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1'],
    ).toMatchObject({
      status: 'failed',
      error: {
        message: 'Reached maximum number of turns (200)',
        retryable: true,
      },
    });
    expect(
      (await service().getState(SCOPE)).runtimeByChatId['chat-1'],
    ).toMatchObject({
      status: 'failed',
      error: { message: 'Reached maximum number of turns (200)' },
    });
  });

  it('rejects provider output tagged for a superseded active turn', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-current', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-current',
        text: 'Current turn',
      }),
    );

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-superseded',
        mutationId: 'stale-assistant',
        data: {
          type: 'assistant',
          canopy_turn_user_message_id: 'user-superseded',
          message: {
            id: 'stale-native-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Orphaned output' }],
          },
        },
      }),
    ).resolves.toBe(false);

    const snapshot = await target.getState(SCOPE);
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).not.toContain(
      'Orphaned output',
    );
    expect(snapshot.runtimeByChatId['chat-1']?.activeTurn?.userMessageId).toBe(
      'user-current',
    );
  });

  describe('activity-only provider events', () => {
    const START = 1_786_104_000_000;

    async function streamingChat() {
      let clock = START;
      const { target, repository } = serviceWithRepository({
        now: () => clock,
      });
      await createChat(target);
      await target.command(
        envelope('send-activity', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          text: 'Continue',
        }),
      );
      await expect(
        target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'user-1',
          mutationId: 'assistant-1',
          data: {
            type: 'assistant',
            message: {
              id: 'assistant-native-1',
              role: 'assistant',
              content: [{ type: 'text', text: 'Working' }],
            },
          },
        }),
      ).resolves.toBe(true);
      const runtime = async () =>
        (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect((await runtime())?.status).toBe('streaming');
      expect((await runtime())?.lastActivityAt).toBe(START);
      return {
        target,
        revision: () => repository.getRevision(SCOPE),
        runtime,
        advance: (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      };
    }

    const progress = (sequence: number) => ({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-1',
      mutationId: `progress-${sequence}`,
      data: { type: 'system', subtype: 'status', status: 'requesting' },
    });

    it('does not commit an event whose only change is a newer activity timestamp', async () => {
      const f = await streamingChat();
      const revision = await f.revision();
      f.advance(1_000);

      await expect(f.target.ingestProviderEvent(progress(1))).resolves.toBe(
        false,
      );

      expect(await f.revision()).toBe(revision);
      expect((await f.runtime())?.lastActivityAt).toBe(START);
      f.advance(1_000);
      await expect(
        f.target.ingestProviderEventWithOutcome(progress(2)),
      ).resolves.toBe('activity-only');
      expect(await f.revision()).toBe(revision);
    });

    it('does not commit a Codex plan update that changes nothing durable', async () => {
      let clock = START;
      const { target, repository } = serviceWithRepository({
        now: () => clock,
      });
      await target.command(
        envelope('create-codex', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          title: 'Codex chat',
          providerType: 'codex',
          model: 'gpt-6-sol',
        }),
      );
      await target.command(
        envelope('send-codex', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          text: 'Continue',
        }),
      );
      const codexEvent = (mutationId: string, event: object) => ({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-1',
        providerType: 'codex' as const,
        mutationId,
        data: { type: 'codex', event },
      });
      await expect(
        target.ingestProviderEventWithOutcome(
          codexEvent('codex-turn', { type: 'turn.started' }),
        ),
      ).resolves.toBe('applied');
      const revision = await repository.getRevision(SCOPE);
      clock += 1_000;

      await expect(
        target.ingestProviderEventWithOutcome(
          codexEvent('codex-plan', {
            type: 'turn.plan.updated',
            plan: [{ step: 'Inspect', status: 'in_progress' }],
          }),
        ),
      ).resolves.toBe('activity-only');

      expect(await repository.getRevision(SCOPE)).toBe(revision);
      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime?.status).toBe('streaming');
      expect(runtime?.lastActivityAt).toBe(START);
    });

    it('persists streamed activity at most once per interval', async () => {
      const f = await streamingChat();
      const revision = await f.revision();
      for (let sequence = 0; sequence < 50; sequence += 1) {
        f.advance(150);
        await f.target.ingestProviderEvent(progress(sequence));
      }
      expect(f.now() - START).toBe(7_500);
      expect(await f.revision()).toBe(revision);
      expect((await f.runtime())?.lastActivityAt).toBe(START);

      f.advance(2_500);
      await expect(f.target.ingestProviderEvent(progress(50))).resolves.toBe(
        true,
      );
      expect(await f.revision()).toBe(revision + 1);
      expect((await f.runtime())?.lastActivityAt).toBe(START + 10_000);

      f.advance(1_000);
      await expect(f.target.ingestProviderEvent(progress(51))).resolves.toBe(
        false,
      );
      expect(await f.revision()).toBe(revision + 1);
      expect((await f.runtime())?.lastActivityAt).toBe(START + 10_000);
    });

    it('commits the current activity time with a transcript change', async () => {
      const f = await streamingChat();
      const revision = await f.revision();
      f.advance(1_000);

      await expect(
        f.target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'user-1',
          mutationId: 'assistant-2',
          data: {
            type: 'assistant',
            message: {
              id: 'assistant-native-2',
              role: 'assistant',
              content: [{ type: 'text', text: 'More output' }],
            },
          },
        }),
      ).resolves.toBe(true);

      expect(await f.revision()).toBe(revision + 1);
      expect((await f.runtime())?.lastActivityAt).toBe(START + 1_000);
    });

    it('rejects duplicate and stale-turn events without marking them activity-only', async () => {
      const f = await streamingChat();
      f.advance(1_000);
      await expect(
        f.target.ingestProviderEventWithOutcome({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'user-1',
          mutationId: 'assistant-1',
          data: { type: 'system', subtype: 'status', status: 'requesting' },
        }),
      ).resolves.toBe('not-applied');
      await expect(
        f.target.ingestProviderEventWithOutcome({
          ...progress(1),
          turnUserMessageId: 'user-superseded',
        }),
      ).resolves.toBe('not-applied');
    });

    it('records no mutation id for an activity-only event, so a repeated id stays live', async () => {
      const f = await streamingChat();
      const revision = await f.revision();
      f.advance(1_000);
      await expect(
        f.target.ingestProviderEventWithOutcome(progress(1)),
      ).resolves.toBe('activity-only');
      // A dispatched-again turn restarts its per-run event sequence, so the
      // same id arrives again as new live activity rather than a replay.
      f.advance(1_000);
      await expect(
        f.target.ingestProviderEventWithOutcome(progress(1)),
      ).resolves.toBe('activity-only');
      expect(await f.target.hasMutation(SCOPE, 'progress-1')).toBe(false);
      expect(await f.revision()).toBe(revision);

      f.advance(1_000);
      await expect(
        f.target.ingestProviderEventWithOutcome({
          ...progress(1),
          data: {
            type: 'assistant',
            message: {
              id: 'assistant-native-rerun',
              role: 'assistant',
              content: [{ type: 'text', text: 'Rerun output' }],
            },
          },
        }),
      ).resolves.toBe('applied');
      expect(await f.target.hasMutation(SCOPE, 'progress-1')).toBe(true);
      await expect(
        f.target.ingestProviderEventWithOutcome(progress(1)),
      ).resolves.toBe('not-applied');
    });

    it('commits a turn acceptance whose runtime is otherwise unchanged', async () => {
      const f = await streamingChat();
      const revision = await f.revision();
      f.advance(1_000);

      await expect(
        f.target.ingestProviderEventWithOutcome({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'user-1',
          mutationId: 'chat-1:user-1:accepted',
          data: {
            type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
            canopy_turn_user_message_id: 'user-1',
          },
        }),
      ).resolves.toBe('applied');

      expect(await f.revision()).toBe(revision + 1);
      expect(await f.target.hasMutation(SCOPE, 'chat-1:user-1:accepted')).toBe(
        true,
      );
    });

    it('commits the current activity time with a runtime status change', async () => {
      let clock = START;
      const { target, repository } = serviceWithRepository({
        now: () => clock,
      });
      await createChat(target);
      await target.command(
        envelope('send-status', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          text: 'Continue',
        }),
      );
      const before = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(before?.status).not.toBe('streaming');
      const revision = await repository.getRevision(SCOPE);
      clock += 1_000;

      await expect(target.ingestProviderEvent(progress(1))).resolves.toBe(true);

      const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      expect(runtime?.status).toBe('streaming');
      expect(runtime?.lastActivityAt).toBe(START + 1_000);
      expect(await repository.getRevision(SCOPE)).toBe(revision + 1);
    });
  });

  it('reconciles late provider output after an empty completion', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-completing', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-completing',
        text: 'Complete this turn',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-completing',
      mutationId: 'completed-turn',
      data: {
        type: 'result',
        is_error: false,
        result: 'Completed',
        canopy_turn_user_message_id: 'user-completing',
      },
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-completing',
        mutationId: 'late-assistant',
        data: {
          type: 'assistant',
          canopy_turn_user_message_id: 'user-completing',
          message: {
            id: 'late-native-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Late orphaned output' }],
          },
        },
      }),
    ).resolves.toBe(true);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('completed');
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Late orphaned output',
    );
  });

  it.each<[number, boolean]>([
    [0, false],
    [600, false],
    [1600, false],
    [600, true],
  ])(
    'retains background delegation activity with %i later rows (same turn %s) without reviving its root',
    async (laterRows, sameTurn) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      await target.command(
        envelope('send-delegation', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'delegating-user',
          text: 'Review independently',
        }),
      );
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'delegating-user',
        mutationId: 'root-complete',
        data: { type: 'result', is_error: false, result: 'Parent done' },
      });
      const data = {
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'owned-child',
          runGeneration: 1,
          sequence: 4,
          parentHarnessId: 'codex',
          parentTurnId: 'delegating-user',
          parentToolCallId: 'delegate-call',
          createdAt: 1000,
          task: {
            description: 'Independent review',
            prompt: 'Read source',
            executionMode: 'background',
          },
          snapshot: {
            delegationId: 'owned-child',
            status: 'completed',
            outputTruncated: false,
            nativeSessionId: 'child-native',
            routeSnapshot: {
              selectedModelId: 'reviewer',
              runtimeModelId: 'runtime',
              harnessId: 'claude',
            },
          },
          transcript: [
            {
              id: 'answer',
              type: 'text',
              text: 'Independent finding',
              sequence: 1,
              occurredAt: 1100,
            },
          ],
        },
      };
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-running',
        data: {
          ...data,
          delegation: {
            ...data.delegation,
            sequence: 3,
            snapshot: { ...data.delegation.snapshot, status: 'running' },
          },
        },
      });
      if (laterRows > 0) {
        const history: PersistedChatMessage[] = Array.from(
          { length: laterRows },
          (_, index): PersistedChatMessage => ({
            id: `later-${index}`,
            role: 'assistant',
            timestamp: 1201 + index,
            blocks: [{ type: 'text', text: `Later response ${index}` }],
          }),
        );
        if (!sameTurn)
          history.unshift({
            id: 'later-user',
            role: 'user',
            timestamp: 1200,
            blocks: [{ type: 'text', text: 'Continue with another turn' }],
          });
        await repository.transact(
          SCOPE,
          history.map((message) => ({
            type: 'message.upserted' as const,
            chatId: 'chat-1',
            message,
          })),
          { source: 'provider' },
        );
      }
      const readMessage = jest.spyOn(
        ChatTranscriptLog.prototype,
        'readMessage',
      );
      const transactWith = repository.transactWith.bind(repository);
      const hydratedCounts: number[] = [];
      const transactions = jest
        .spyOn(repository, 'transactWith')
        .mockImplementation((scope, build, options) =>
          transactWith(
            scope,
            (current, revision, context) => {
              hydratedCounts.push(
                current.tabsFile.tabs.find((tab) => tab.id === 'chat-1')
                  ?.messages.length ?? 0,
              );
              return build(current, revision, context);
            },
            options,
          ),
        );
      await expect(
        target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'delegating-user',
          mutationId: 'child-complete',
          data,
        }),
      ).resolves.toBe(true);
      expect(readMessage.mock.calls.map((call) => call[1])).toEqual(
        // Admission and the returned committed projection each hydrate one card.
        laterRows
          ? ['delegated-agent-owned-child', 'delegated-agent-owned-child']
          : [],
      );
      if (laterRows) expect(hydratedCounts).toEqual([502]);
      expect(transactions.mock.calls.at(-1)?.[2]).toMatchObject({
        fullTranscript: false,
        messageAnchor: {
          messageId: 'delegated-agent-owned-child',
          fallbackMessageId: 'delegating-user',
        },
      });
      transactions.mockRestore();
      readMessage.mockRestore();
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'stale-child-running',
        data: {
          ...data,
          delegation: {
            ...data.delegation,
            sequence: 3,
            snapshot: { ...data.delegation.snapshot, status: 'running' },
          },
        },
      });
      const snapshot = await target.getState(SCOPE);
      const saved = await target.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      expect(
        saved.tabs[0]?.messages.find(
          (message) => message.id === 'delegated-agent-owned-child',
        )?.blocks[0],
      ).toMatchObject({
        status: 'completed',
        sequence: 4,
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-follow-up-complete',
        data: {
          ...data,
          delegation: { ...data.delegation, runGeneration: 2, sequence: 1 },
        },
      });
      const followUp = await target.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      const persistedIds = followUp.tabs[0]?.messages.map(
        (message) => message.id,
      );
      expect(persistedIds?.indexOf('delegated-agent-owned-child-run-2')).toBe(
        (followUp.tabs[0]?.messages
          .map((message) => message.parentBlockId)
          .lastIndexOf('delegated-agent-owned-child') ?? -1) + 1,
      );
      expect(
        followUp.tabs[0]?.messages.find(
          (message) => message.id === 'delegated-agent-owned-child-run-2',
        )?.blocks[0],
      ).toMatchObject({ status: 'completed', runGeneration: 2 });
      // A follow-up the user sends from the subagent viewer has no root turn
      // or tool call; its run still lands beside the delegate's earlier run.
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-user-follow-up',
        data: {
          ...data,
          canopy_turn_user_message_id: 'user-stop',
          delegation: {
            ...data.delegation,
            runGeneration: 3,
            sequence: 1,
            parentTurnId: 'user-stop',
            parentToolCallId: 'user-stop:operation',
          },
        },
      });
      const userFollowUp = await target.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      expect(
        userFollowUp.tabs[0]?.messages.find(
          (message) => message.id === 'delegated-agent-owned-child-run-3',
        )?.blocks[0],
      ).toMatchObject({ status: 'completed', runGeneration: 3 });

      expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('completed');
      expect(snapshot.tabsFile.tabs[0]?.sdkSessionId).not.toBe('child-native');
      expect(snapshot.tabsFile.tabs[0]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            parentBlockId: 'delegated-agent-owned-child',
            blocks: [{ type: 'text', text: 'Independent finding' }],
          }),
        ]),
      );
    },
    300_000,
  );

  it.each([false, true])(
    'keeps late output for a paged-out delegation card inside its originating turn (auto-archived %s)',
    async (archived) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      await target.command(
        envelope('send-delegation', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'delegating-user',
          text: 'Review independently',
        }),
      );
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'delegating-user',
        mutationId: 'root-complete',
        data: { type: 'result', is_error: false, result: 'Parent done' },
      });
      const answer = {
        id: 'answer',
        type: 'text',
        text: 'Independent finding',
        sequence: 1,
        occurredAt: 1100,
      };
      const delegation = {
        delegationId: 'owned-child',
        runGeneration: 1,
        sequence: 3,
        parentHarnessId: 'codex',
        parentTurnId: 'delegating-user',
        parentToolCallId: 'delegate-call',
        createdAt: 1000,
        task: {
          description: 'Independent review',
          prompt: 'Read source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'owned-child',
          status: 'running',
          outputTruncated: false,
          nativeSessionId: 'child-native',
          routeSnapshot: {
            selectedModelId: 'reviewer',
            runtimeModelId: 'runtime',
            harnessId: 'claude',
          },
        },
        transcript: [answer],
      };
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-running',
        data: { type: 'canopy_delegation', delegation },
      });
      await repository.transact(
        SCOPE,
        [
          {
            id: 'later-user',
            role: 'user' as const,
            timestamp: 1200,
            blocks: [{ type: 'text' as const, text: 'Continue' }],
          },
          ...Array.from({ length: 600 }, (_, index) => ({
            id: `later-${index}`,
            role: 'assistant' as const,
            timestamp: 1201 + index,
            blocks: [
              { type: 'text' as const, text: `Later response ${index}` },
            ],
          })),
        ].map((message) => ({
          type: 'message.upserted' as const,
          chatId: 'chat-1',
          message,
        })),
        { source: 'provider' },
      );
      if (archived) {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          mutationId: 'enable-auto-archive',
          data: { type: 'canopy_set_auto_archive_requested', enabled: true },
        });
        await target.command(
          envelope('auto-archive-delegating-chat', {
            type: 'chat.archive_tab',
            tabId: 'chat-1',
            keepSession: true,
          }),
        );
      }
      const published: ChatStateChange[] = [];
      target.subscribe((event) => published.push(...event.changes));

      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-complete',
        data: {
          type: 'canopy_delegation',
          delegation: {
            ...delegation,
            sequence: 4,
            snapshot: { ...delegation.snapshot, status: 'completed' },
            transcript: [
              answer,
              {
                id: 'summary',
                type: 'text',
                text: 'Final summary',
                sequence: 2,
                occurredAt: 1300,
              },
            ],
          },
        },
      });

      const saved = archived
        ? (
            await target.getCompatibilityArchives(SCOPE, {
              chatIds: ['chat-1'],
              fullTranscript: true,
            })
          ).archived[0]?.tab
        : (
            await target.getCompatibilityTabs(SCOPE, {
              chatIds: ['chat-1'],
              fullTranscript: true,
            })
          ).tabs[0];
      expect((await target.getState(SCOPE)).archives).toHaveLength(
        archived ? 1 : 0,
      );
      const ids = saved?.messages.map((message) => message.id) ?? [];
      const summary = ids.indexOf('delegated-agent-owned-child:summary');
      expect(summary).toBe(
        ids.indexOf('delegated-agent-owned-child:answer') + 1,
      );
      expect(summary).toBeLessThan(ids.indexOf('later-user'));
      // A renderer page that ends after the later turn has no row to anchor
      // these to, so each must carry a position instead of a tail append.
      const owned = published.flatMap((change) =>
        change.type === 'message.upserted' &&
        (change.message.id === 'delegated-agent-owned-child' ||
          change.message.parentBlockId === 'delegated-agent-owned-child')
          ? [change]
          : [],
      );
      for (const change of owned) {
        expect(change.afterMessageId).toBeDefined();
        expect(ids.indexOf(change.afterMessageId ?? '')).toBeLessThan(
          ids.indexOf(change.message.id),
        );
      }
      // Archived chats publish summaries, not incremental rows.
      if (!archived)
        expect(owned.map((change) => change.message.id)).toEqual(
          expect.arrayContaining([
            'delegated-agent-owned-child',
            'delegated-agent-owned-child:summary',
          ]),
        );
    },
    120_000,
  );

  it('commits only the card of a delegate whose transcript is in the delegate log', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-logged-delegation', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'delegating-user',
        text: 'Review independently',
      }),
    );
    const delegation = (
      sequence: number,
      snapshot: Record<string, unknown>,
    ): Record<string, unknown> => ({
      type: 'canopy_delegation',
      delegation: {
        delegationId: 'logged-child',
        runGeneration: 1,
        sequence,
        parentHarnessId: 'claude',
        parentTurnId: 'delegating-user',
        parentToolCallId: 'delegate-call',
        createdAt: 1000,
        transcriptStore: 'chat-log-v1',
        task: {
          description: 'Independent review',
          prompt: 'Read source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'logged-child',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'reviewer',
            runtimeModelId: 'runtime',
            harnessId: 'claude',
          },
          ...snapshot,
        },
        transcript: [
          {
            id: 'answer',
            type: 'text',
            text: 'Independent finding',
            sequence: 1,
            occurredAt: 1100,
          },
        ],
      },
    });
    for (const [sequence, snapshot] of [
      [1, { status: 'running', partialText: 'Reading', phase: 'tool' }],
      [2, { status: 'completed', finalText: 'Done', partialText: 'Done' }],
    ] as const)
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'delegating-user',
        mutationId: `logged-child-${String(sequence)}`,
        data: delegation(sequence, snapshot),
      });
    const messages = (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages;
    expect(
      messages?.filter(
        (message) => message.parentBlockId === 'delegated-agent-logged-child',
      ),
    ).toEqual([]);
    const card = messages
      ?.flatMap((message) => message.blocks)
      .find((block) => block.type === 'delegated_agent_call');
    expect(card).toEqual(
      expect.objectContaining({
        status: 'completed',
        finalText: 'Done',
        transcriptStore: 'chat-log-v1',
        sequence: 2,
      }),
    );
    expect(card).not.toHaveProperty('partialText');
    expect(card).not.toHaveProperty('phase');
  });

  it('revives a settled runtime for an untagged continuation stream', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-continuing', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-continuing',
        text: 'Continue this turn',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-continuing',
      mutationId: 'continuation-initial-result',
      data: {
        type: 'result',
        is_error: false,
        result: 'Initially completed',
        canopy_turn_user_message_id: 'user-continuing',
      },
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-continuing',
        mutationId: 'continuation-revival',
        data: {
          type: 'assistant',
          message: {
            id: 'continued-native-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Continuation resumed' }],
          },
        },
      }),
    ).resolves.toBe(true);
    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-continuing',
        mutationId: 'continuation-tail',
        data: {
          type: 'assistant',
          canopy_turn_user_message_id: 'user-continuing',
          message: {
            id: 'continued-tail-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Continuation tail' }],
          },
        },
      }),
    ).resolves.toBe(true);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']).toMatchObject({
      status: 'streaming',
      activeTurn: { userMessageId: 'user-continuing' },
    });
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Continuation resumed',
    );
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Continuation tail',
    );
  });

  it('accepts a tagged terminal-only revival for a settled runtime', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-terminal-revival', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-terminal-revival',
        text: 'Resume this turn after loading tools',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-terminal-revival',
      mutationId: 'terminal-revival-initial-result',
      data: {
        type: 'result',
        is_error: false,
        result: 'Initially completed',
        canopy_turn_user_message_id: 'user-terminal-revival',
      },
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-terminal-revival',
        mutationId: 'terminal-only-revival',
        data: {
          type: 'result',
          is_error: true,
          result: 'Reload continuation failed',
          canopy_turn_user_message_id: 'user-terminal-revival',
          canopy_turn_revival: true,
        },
      }),
    ).resolves.toBe(true);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']).toMatchObject({
      status: 'failed',
      error: { message: 'Reload continuation failed' },
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-terminal-revival',
        mutationId: 'mismatched-terminal-revival',
        data: {
          type: 'result',
          is_error: false,
          result: 'Wrong turn completed',
          canopy_turn_user_message_id: 'another-user-message',
          canopy_turn_revival: true,
        },
      }),
    ).resolves.toBe(false);
  });

  it('persists replacement session metadata after a tagged failed turn', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-rebuilding', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-rebuilding',
        text: 'Retry on a replacement session',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-rebuilding',
      mutationId: 'rebuilding-initial-result',
      data: {
        type: 'result',
        is_error: true,
        result: 'Rejected stale session',
        canopy_turn_user_message_id: 'user-rebuilding',
      },
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-rebuilding',
        mutationId: 'replacement-session-init',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: 'replacement-session',
          canopy_turn_user_message_id: 'user-rebuilding',
          canopy_turn_revival: true,
        },
      }),
    ).resolves.toBe(true);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0]?.sdkSessionId).toBe('replacement-session');
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('failed');

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'replacement-session-output',
        data: {
          type: 'assistant',
          canopy_turn_user_message_id: 'user-rebuilding',
          canopy_turn_revival: true,
          message: {
            id: 'replacement-native-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Replacement session recovered' }],
          },
        },
      }),
    ).resolves.toBe(true);

    const revived = await target.getState(SCOPE);
    expect(revived.runtimeByChatId['chat-1']).toMatchObject({
      status: 'streaming',
      activeTurn: { userMessageId: 'user-rebuilding' },
    });
    expect(JSON.stringify(revived.tabsFile.tabs[0]?.messages)).toContain(
      'Replacement session recovered',
    );
  });

  it('rejects delayed replacement session metadata after a new turn starts', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-failing', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-failing',
        text: 'Fail this turn',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-failing',
      mutationId: 'failing-result',
      data: {
        type: 'result',
        is_error: true,
        result: 'Rejected stale session',
        canopy_turn_user_message_id: 'user-failing',
      },
    });
    await target.command(
      envelope('send-active', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-active',
        text: 'Start a new turn',
      }),
    );

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'user-failing',
        mutationId: 'delayed-replacement-session-init',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: 'stale-replacement-session',
          canopy_turn_user_message_id: 'user-failing',
          canopy_turn_revival: true,
        },
      }),
    ).resolves.toBe(false);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0]?.sdkSessionId).not.toBe(
      'stale-replacement-session',
    );
    expect(snapshot.runtimeByChatId['chat-1']).toMatchObject({
      status: 'starting',
      activeTurn: { userMessageId: 'user-active' },
    });
  });

  it('commits provider metadata without storing a transcript-bearing scope record', async () => {
    const { target, repository } = serviceWithRepository();
    const transactions = jest.spyOn(repository, 'transactWith');
    await createChat(target);
    // Seed settled history in one durable transaction. Only the final send
    // must exercise admission; 25 serial fsync-heavy sends test unrelated
    // queue behavior and can exhaust Jest's timeout on a busy test host.
    await target.updateCompatibilityTab(SCOPE, 'chat-1', (tab) => ({
      ...tab,
      messages: Array.from({ length: 24 }, (_, index) => ({
        id: `history-${String(index)}`,
        role: 'user' as const,
        timestamp: index + 1,
        blocks: [
          { type: 'text' as const, text: `History message ${String(index)}` },
        ],
      })),
    }));
    await target.command(
      envelope('send-history-24', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'history-24',
        text: 'History message 24',
      }),
    );

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'history-24',
      mutationId: 'provider-session-metadata',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'session-with-large-history',
      },
    });

    const position = transactions.mock.calls.findIndex(
      (call) => call[2].mutationId === 'provider-session-metadata',
    );
    const transactionResult = transactions.mock.results[position];
    if (!transactionResult || transactionResult.type !== 'return')
      throw new Error('Provider metadata transaction did not return');
    const committed: ChatStateCommit = await transactionResult.value;
    const record = committed.record;
    const storage = ChatStorageV2.fromLegacyPaths(paths);
    const indexes = await storage.indexes();
    expect(indexes.live.tabs[0].sdkSessionId).toBe(
      'session-with-large-history',
    );
    expect(indexes.live.tabs[0]).not.toHaveProperty('messages');
    expect(existsSync(paths.journal)).toBe(false);
    expect(
      readFileSync(join(storage.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
    expect(record.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: expect.objectContaining({
            sdkSessionId: 'session-with-large-history',
          }),
        }),
      ]),
    );
    expect(record?.mutations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tab.created' }),
      ]),
    );
    expect(JSON.stringify(record)).not.toContain('History message 0');
  });

  it('persists a terminal transcript title across later canonical syncs', async () => {
    const target = service();
    await target.command(
      envelope('create-terminal-title', {
        type: 'chat.create_tab',
        tabId: 'terminal-title',
        title: 'New chat',
        interfaceMode: 'claude-code',
      }),
    );
    const terminalUser: PersistedChatMessage = {
      id: 'terminal-title-user',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Implement terminal-only branch naming',
        },
      ],
    };

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'terminal-title',
      mutationId: 'terminal-title-sync',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [terminalUser],
      },
    });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.title).toBe(
      'Implement terminal-only branch naming',
    );

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'terminal-title',
      mutationId: 'terminal-title-assistant-sync',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: 'terminal-title-assistant',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Finished' }],
          },
        ],
      },
    });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.title).toBe(
      'Implement terminal-only branch naming',
    );
  });

  it('persists terminal transcript messages, settings, and turn diffs across canonical reload', async () => {
    const target = service();
    await target.command(
      envelope('create-terminal-reload', {
        type: 'chat.create_tab',
        tabId: 'terminal-reload',
        interfaceMode: 'claude-code',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'terminal-reload',
      mutationId: 'terminal-reload-sync',
      source: 'terminal',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 2,
        messages: [
          {
            id: 'terminal-reload-user',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Persist terminal transcript' }],
          },
          {
            id: 'terminal-reload-assistant',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Persisted' }],
          },
        ],
        settingsSync: { model: 'claude-sonnet-4-6', planMode: true },
        turnDiffs: {
          'terminal-reload-user': {
            files: [],
            totalInsertions: 2,
            totalDeletions: 1,
            capturedAt: 2,
          },
        },
      },
    });

    const reloaded = service();
    const snapshot = await reloaded.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0]).toMatchObject({
      id: 'terminal-reload',
      model: 'claude-sonnet-4-6',
      providerType: 'claude',
      planMode: true,
      messages: [
        { id: 'terminal-reload-user' },
        { id: 'terminal-reload-assistant' },
      ],
      turnDiffs: {
        'terminal-reload-user': {
          totalInsertions: 2,
          totalDeletions: 1,
        },
      },
    });
  });

  it('commits unread state through the canonical command port', async () => {
    const target = service();
    await createChat(target);

    await expect(
      target.command(
        envelope('mark-unread', {
          type: 'chat.mark_unread',
          chatId: 'chat-1',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      unread: true,
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0].attentionDismissedAt,
    ).toBeUndefined();
  });

  it('rejects a remote read when output changes after the adapter snapshot', async () => {
    const target = service();
    await createChat(target);
    const observed = await target.getState(SCOPE);
    await target.command(
      envelope('new-output-unread', {
        type: 'chat.mark_unread',
        chatId: 'chat-1',
      }),
    );
    const result = await target.command({
      ...envelope('stale-remote-read', {
        type: 'chat.mark_read',
        chatId: 'chat-1',
      }),
      origin: 'portal',
      expectedRevision: observed.revision,
    });
    expect(result.outcome).toBe('conflict');
    expect((await target.getState(SCOPE)).tabsFile.tabs[0].unread).toBe(true);
  });

  it('persists a remote read without activating the tab or clearing its sibling', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('sibling', { type: 'chat.create_tab', tabId: 'chat-2' }),
    );
    for (const chatId of ['chat-1', 'chat-2']) {
      await target.command(
        envelope(`unread-${chatId}`, { type: 'chat.mark_unread', chatId }),
      );
    }
    const before = await target.getState(SCOPE);
    const ack = {
      ...envelope('remote-read', {
        type: 'chat.mark_read' as const,
        chatId: 'chat-1',
      }),
      origin: 'portal' as const,
      expectedRevision: before.revision,
    };
    expect(await target.command(ack)).toMatchObject({ outcome: 'applied' });
    expect(await target.command(ack)).toMatchObject({
      outcome: 'already_applied',
    });
    const persisted = await service().getState(SCOPE);
    expect(persisted.tabsFile.activeTabId).toBe(before.tabsFile.activeTabId);
    expect(
      persisted.tabsFile.tabs.find((tab) => tab.id === 'chat-1')?.unread,
    ).toBe(false);
    expect(
      persisted.tabsFile.tabs.find((tab) => tab.id === 'chat-2')?.unread,
    ).toBe(true);
  });

  it('does not interrupt a starting turn while accepted dispatch is in flight', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    let releaseDispatch = (): void => undefined;
    let markDispatchStarted = (): void => undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      dispatch: async () => {
        markDispatchStarted();
        await dispatchGate;
      },
      cleanupSession: async () => undefined,
    });
    Object.defineProperty(target, 'reconcileHostRuntime', { value: true });
    await createChat(target);

    const send = target.command(
      envelope('send-in-flight', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-in-flight',
        text: 'Start before provider registration',
      }),
    );
    await dispatchStarted;

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']).toMatchObject({
      status: 'starting',
      activeTurn: { userMessageId: 'user-in-flight' },
    });

    releaseDispatch();
    await send;
  });

  it.each([
    'streaming',
    'idle',
    'interrupted',
    'registry-failure',
    'live-terminal',
  ] as const)(
    'registers and settles an orphaned %s turn before resume',
    async (status) => {
      const { target, repository } = serviceWithRepository();
      Object.defineProperty(target, 'reconcileHostRuntime', { value: true });
      await createChat(target);
      const created = await target.getState(SCOPE);
      const createdTab = created.tabsFile.tabs[0];
      if (!createdTab) throw new Error('Expected created chat tab');

      await repository.transact(
        SCOPE,
        [
          {
            type: 'tab.created',
            tab: {
              ...createdTab,
              messages: [
                {
                  id: 'user-orphaned',
                  role: 'user',
                  timestamp: 10,
                  blocks: [{ type: 'text', text: 'Finish this turn' }],
                },
                {
                  id: 'timer-orphaned',
                  role: 'system',
                  timestamp: 10,
                  blocks: [
                    { type: 'turn_timer', startedAt: 10, completedAt: null },
                  ],
                },
              ],
            },
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status:
                status === 'registry-failure' || status === 'live-terminal'
                  ? 'streaming'
                  : status,
              queuedMessageIds: [],
              activeTurn: { userMessageId: 'user-orphaned', startedAt: 10 },
            },
          },
          {
            type: 'pending_question.upserted',
            question: {
              requestId: 'sync-question',
              chatId: 'chat-1',
              questions: [{ question: 'Still running?', options: ['Yes'] }],
            },
          },
          {
            type: 'pending_question.upserted',
            question: {
              requestId: 'async-question',
              chatId: 'chat-1',
              delivery: 'async',
              questions: [{ question: 'Which scope?', options: ['Focused'] }],
            },
          },
        ],
        { source: 'provider', mutationId: 'orphaned-turn' },
      );

      if (status === 'live-terminal') {
        mockTerminalState.mockReturnValue({ turnState: 'running' });
        const snapshot = await target.getState(SCOPE);
        expect(snapshot.runtimeByChatId['chat-1'].status).toBe('streaming');
        expect(mockRecordInterruptedChats).not.toHaveBeenCalled();
        mockTerminalState.mockReturnValue(undefined);
      }
      if (status === 'registry-failure') {
        mockRecordInterruptedChats.mockRejectedValueOnce(
          new Error('registry unavailable'),
        );
        await expect(target.getState(SCOPE)).rejects.toThrow(
          'registry unavailable',
        );
        expect(
          (await repository.getState(SCOPE)).runtimeByChatId['chat-1'].status,
        ).toBe('streaming');
      }
      const reconciled = await target.getState(SCOPE);
      expect(mockRecordInterruptedChats).toHaveBeenCalledWith([
        expect.objectContaining({
          ...SCOPE,
          chatId: 'chat-1',
          resumeReason: 'app_shutdown',
        }),
      ]);
      expect(reconciled.runtimeByChatId['chat-1']).toMatchObject({
        status: 'interrupted',
        error: { code: 'interrupted', retryable: true },
      });
      expect(reconciled.runtimeByChatId['chat-1']).not.toHaveProperty(
        'activeTurn',
      );
      expect(reconciled.tabsFile.tabs[0]?.messages[1]).toMatchObject({
        id: 'timer-orphaned',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: 10,
            completedAt: 1_786_104_000_000,
          },
        ],
      });
      expect(reconciled.tabsFile.pendingQuestions).toEqual([
        expect.objectContaining({
          requestId: 'async-question',
          delivery: 'async',
        }),
      ]);
      mockRecordInterruptedChats.mockClear();
      await target.getState(SCOPE);
      expect(mockRecordInterruptedChats).not.toHaveBeenCalled();
    },
  );

  it('preserves an intentionally paused timer while reconciling an idle runtime', async () => {
    const { target, repository } = serviceWithRepository();
    Object.defineProperty(target, 'reconcileHostRuntime', { value: true });
    await createChat(target);
    const created = await target.getState(SCOPE);
    const createdTab = created.tabsFile.tabs[0];
    if (!createdTab) throw new Error('Expected created chat tab');

    await repository.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: {
            ...createdTab,
            messages: [
              {
                id: 'paused-timer',
                role: 'system',
                timestamp: 10,
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: 10,
                    completedAt: null,
                    pausedAt: 20,
                  },
                ],
              },
            ],
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'paused-history' },
    );

    const reconciled = await target.getState(SCOPE);

    expect(mockRecordInterruptedChats).not.toHaveBeenCalled();
    expect(reconciled.runtimeByChatId['chat-1'].status).toBe('idle');
    expect(reconciled.tabsFile.tabs[0]?.messages[0]?.blocks).toEqual([
      {
        type: 'turn_timer',
        startedAt: 10,
        completedAt: null,
        pausedAt: 20,
      },
    ]);
  });

  it('diffs provider output by indexed message identity without linearly searching the transcript', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    const messages: PersistedChatMessage[] = [
      {
        id: 'existing-user',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Existing transcript' }],
      },
    ];
    Object.defineProperty(messages, 'find', {
      configurable: true,
      get(): never {
        throw new Error('provider diff linearly searched the transcript');
      },
    });
    await repository.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: {
            id: 'chat-indexed',
            title: 'Indexed provider diff',
            createdAt: '2026-08-07T12:00:00.000Z',
            providerType: 'claude',
            messages,
          },
        },
      ],
      { source: 'migration' },
    );
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      cleanupSession: async () => undefined,
    });

    await expect(
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-indexed',
        mutationId: 'metadata-only-event',
        data: { type: 'canopy_injected_prompt' },
      }),
    ).resolves.toBe(true);
  });

  it('keeps terminal runtime terminal while committing a late turn diff', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-turn-diff', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-turn-diff',
        text: 'Change a file',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-turn-diff',
      mutationId: 'turn-terminal',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-turn-diff',
      mutationId: 'turn-diff',
      data: {
        type: 'turn_diff',
        userMessageId: 'user-turn-diff',
        files: [
          {
            path: 'src/example.ts',
            status: 'modified',
            insertions: 2,
            deletions: 1,
          },
        ],
        totalInsertions: 2,
        totalDeletions: 1,
        capturedAt: 1_786_104_000_000,
      },
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('completed');
    expect(snapshot.tabsFile.tabs[0]?.turnDiffs).toEqual({
      'user-turn-diff': expect.objectContaining({
        totalInsertions: 2,
        totalDeletions: 1,
      }),
    });
  });

  it('commits late Codex subagent lifecycle metadata without reopening the settled root turn', async () => {
    const target = service();
    await target.command(
      envelope('create-late-subagent-chat', {
        type: 'chat.create_tab',
        tabId: 'late-subagent-chat',
        title: 'Late subagent chat',
        providerType: 'codex',
        model: 'gpt-6-astra',
      }),
    );
    await target.command(
      envelope('send-late-subagent-chat', {
        type: 'chat.send_message',
        chatId: 'late-subagent-chat',
        userMessageId: 'late-subagent-user',
        text: 'Delegate and report back',
      }),
    );
    const ingest = (mutationId: string, event: Record<string, unknown>) =>
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'late-subagent-chat',
        providerType: 'codex',
        turnUserMessageId: 'late-subagent-user',
        mutationId,
        data: { type: 'codex', event },
      });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'late-subagent-chat',
      providerType: 'codex',
      turnUserMessageId: 'late-subagent-user',
      mutationId: 'late-subagent-root-init',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-root',
        canopy_turn_user_message_id: 'late-subagent-user',
      },
    });
    await ingest('late-subagent-started', {
      type: 'item.completed',
      thread_id: 'thread-root',
      turn_id: 'turn-root',
      item: {
        id: 'child-started',
        type: 'sub_agent_activity',
        kind: 'started',
        agent_thread_id: 'thread-child',
        agent_path: '/root/review',
      },
    });
    await ingest('late-subagent-root-completed', {
      type: 'turn.completed',
      thread_id: 'thread-root',
      turn_id: 'turn-root',
    });

    await expect(
      ingest('late-subagent-thread-metadata', {
        type: 'thread.started',
        thread_id: 'thread-child',
        parent_thread_id: 'thread-root',
        agent_nickname: 'Tesla',
        model: 'gpt-6-astra',
        reasoning_effort: 'high',
      }),
    ).resolves.toBe(true);
    await expect(
      ingest('late-subagent-completed', {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
        item: {
          id: 'child-completed',
          type: 'sub_agent_activity',
          kind: 'completed',
          agent_thread_id: 'thread-child',
          agent_path: '/root/review',
        },
      }),
    ).resolves.toBe(true);
    await expect(
      ingest('late-subagent-failed', {
        type: 'turn.failed',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
        error: { message: 'Child failed' },
      }),
    ).resolves.toBe(true);

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['late-subagent-chat']?.status).toBe(
      'completed',
    );
    const blocks = snapshot.tabsFile.tabs[0]?.messages.flatMap(
      (message) => message.blocks,
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: 'codex_agent_call',
        receiverThreadIds: ['thread-child'],
        agentsStates: expect.objectContaining({
          'thread-child': expect.objectContaining({
            status: 'errored',
            message: 'Child failed',
          }),
        }),
        receiverAgents: expect.objectContaining({
          'thread-child': expect.objectContaining({
            nickname: 'Tesla',
            agentPath: '/root/review',
            model: 'gpt-6-astra',
            reasoningEffort: 'high',
          }),
        }),
      }),
    );
  });

  it('starts a new runtime turn when a user prompt follows a terminal result', async () => {
    const target = service();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-first',
      mutationId: 'first-turn-failed',
      data: { type: 'result', is_error: true, result: 'First turn failed' },
    });
    expect(
      (await target.getState(SCOPE)).runtimeByChatId['chat-1'],
    ).toMatchObject({
      status: 'failed',
      error: { message: 'First turn failed' },
    });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-second',
      mutationId: 'second-turn-prompt',
      data: { type: 'canopy_user_prompt' },
    });

    const runtime = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
    expect(runtime).toMatchObject({
      status: 'starting',
      activeTurn: { userMessageId: 'user-second' },
    });
    expect(runtime).not.toHaveProperty('error');
  });

  it('refreshes and preserves steering capabilities when a Claude turn starts', async () => {
    const f = await deliveryFixture();
    await f.target.ingestProviderEvent({
      ...f.scope,
      mutationId: 'claude-init',
      data: { type: 'system', subtype: 'init' },
    });
    expect(
      (await f.target.getState(f.scope)).runtimeByChatId[f.scope.chatId]
        .steeringCapabilities,
    ).toMatchObject({ generation: 'generation-1', steer: true });

    jest.spyOn(f.session, 'getSteeringCapabilities').mockReturnValue({
      provider: 'claude',
      generation: 'generation-2',
      steer: true,
      withdraw: true,
      interrupt: true,
    });
    await f.target.ingestProviderEvent({
      ...f.scope,
      turnUserMessageId: 'next-turn',
      mutationId: 'claude-next-prompt',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'next-turn',
      },
    });

    expect(
      (await f.target.getState(f.scope)).runtimeByChatId[f.scope.chatId],
    ).toMatchObject({
      status: 'starting',
      steeringCapabilities: {
        generation: 'generation-2',
        steer: true,
        withdraw: true,
      },
    });
  });

  it.each(['error', 'turn.failed'])(
    'persists a settled Codex timer before a follow-up result is discarded (%s)',
    async (type) => {
      const target = service();
      await createChat(target);
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'failed-user',
        mutationId: 'failed-prompt',
        data: {
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Investigate',
          canopy_turn_user_message_id: 'failed-user',
        },
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        turnUserMessageId: 'failed-user',
        mutationId: 'codex-failure',
        data: {
          type: 'codex',
          event: {
            type,
            message: 'Usage limit exceeded.',
            error: { message: 'Usage limit exceeded.' },
            codexErrorInfo: 'usageLimitExceeded',
          },
        },
      });
      const failed = await target.getState(SCOPE);
      expect(failed.runtimeByChatId['chat-1'].status).toBe('failed');
      expect(
        failed.tabsFile.tabs[0].messages.flatMap((message) => message.blocks),
      ).toContainEqual({
        type: 'turn_timer',
        startedAt: 1_786_104_000_000,
        completedAt: 1_786_104_000_000,
      });
      // The already-settled runtime rejects the session's trailing result. The
      // first terminal event must therefore persist the timer settlement itself.
      expect(
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          turnUserMessageId: 'failed-user',
          mutationId: 'trailing-result',
          data: {
            type: 'result',
            is_error: true,
            result: 'Usage limit exceeded.',
          },
        }),
      ).toBe(false);
    },
  );

  it('consumes accepted one-shot system instructions in canonical state', async () => {
    const target = service();
    await createChat(target);
    const created = await target.getState(SCOPE);
    const createdTab = created.tabsFile.tabs[0];
    if (!createdTab) throw new Error('Expected created chat tab');
    await target.replaceCompatibilityTabs(SCOPE, {
      ...created.tabsFile,
      tabs: [
        {
          ...createdTab,
          pendingSystemInstructions: [
            { id: 'consume-me', text: 'Use this once.' },
            { id: 'keep-me', text: 'Use this later.' },
          ],
          llmProviderUsageLimitBanner: {
            provider: 'claude',
            message: 'Usage limit reached',
            detectedAt: 1,
            dismissKey: 'usage-limit:claude:test',
          },
          dismissedLlmProviderUsageLimitBannerKey: 'usage-limit:claude:test',
          claudeUsageLimitBanner: {
            provider: 'claude',
            message: 'Legacy usage limit reached',
            detectedAt: 1,
            dismissKey: 'usage-limit:claude:legacy',
          },
          dismissedClaudeUsageLimitBannerKey: 'usage-limit:claude:legacy',
        },
      ],
    });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-accepted',
      mutationId: 'user-accepted:accepted',
      data: {
        type: 'canopy_user_prompt_accepted',
        canopy_turn_user_message_id: 'user-accepted',
        canopy_consumed_pending_system_instruction_ids: ['consume-me'],
      },
    });

    const acceptedTab = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(acceptedTab).toMatchObject({
      lastAcceptedUserMessageId: 'user-accepted',
      pendingSystemInstructions: [{ id: 'keep-me', text: 'Use this later.' }],
    });
    expect(acceptedTab).not.toHaveProperty('llmProviderUsageLimitBanner');
    expect(acceptedTab).not.toHaveProperty(
      'dismissedLlmProviderUsageLimitBannerKey',
    );
    expect(acceptedTab).not.toHaveProperty('claudeUsageLimitBanner');
    expect(acceptedTab).not.toHaveProperty(
      'dismissedClaudeUsageLimitBannerKey',
    );
    // Older renderer snapshots must not erase or replace host delivery evidence.
    await target.replaceCompatibilityTabs(
      SCOPE,
      {
        ...created.tabsFile,
        tabs: [{ ...createdTab, lastAcceptedUserMessageId: 'stale' }],
      },
      { changedTabIds: [createdTab.id] },
    );
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]
        ?.lastAcceptedUserMessageId,
    ).toBe('user-accepted');
  });

  it('reduces Codex thread, assistant, tool, and terminal events without subscribers', async () => {
    const target = service();
    await target.command(
      envelope('create-codex', {
        type: 'chat.create_tab',
        tabId: 'codex-chat',
        title: 'Codex durable chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      }),
    );
    await target.command(
      envelope('send-codex', {
        type: 'chat.send_message',
        chatId: 'codex-chat',
        userMessageId: 'codex-user-1',
        text: 'Run a command',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'codex-chat',
      providerType: 'codex',
      turnUserMessageId: 'codex-user-1',
      mutationId: 'codex-prompt',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Run a command',
        provider: 'codex',
      },
    });
    const events = [
      { type: 'thread.started', thread_id: 'thread-root' },
      {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-1',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/tmp/project',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-1',
        item: {
          id: 'image-1',
          type: 'image_generation',
          status: 'completed',
          revised_prompt: 'A generated landscape',
          saved_path: '/tmp/generated-images/landscape.png',
        },
      },
      {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-1',
        item: {
          id: 'answer-1',
          type: 'agent_message',
          text: 'Codex completed without a renderer',
        },
      },
      {
        type: 'turn.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-1',
      },
    ];
    for (const [index, event] of events.entries()) {
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'codex-chat',
        providerType: 'codex',
        turnUserMessageId: 'codex-user-1',
        mutationId: `codex-event-${index}`,
        data: { type: 'codex', event },
      });
    }

    const snapshot = await target.getState(SCOPE);
    const persisted = snapshot.tabsFile.tabs[0];
    expect(persisted?.sdkSessionId).toBe('thread-root');
    expect(
      persisted?.messages.filter((message) => message.id === 'codex-user-1'),
    ).toHaveLength(1);
    expect(JSON.stringify(persisted?.messages)).toContain('/tmp/project');
    expect(JSON.stringify(persisted?.messages)).toContain(
      'Codex completed without a renderer',
    );
    expect(JSON.stringify(persisted?.messages)).toContain(
      '/tmp/generated-images/landscape.png',
    );
    expect(snapshot.runtimeByChatId['codex-chat']?.status).toBe('completed');
    const timers = persisted?.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'turn_timer');
    expect(timers).toHaveLength(1);
    expect(timers?.[0]?.completedAt).toEqual(expect.any(Number));
  });

  it('keeps a Codex root turn streaming after a subagent completes', async () => {
    const target = service();
    await target.command(
      envelope('create-codex-subagent', {
        type: 'chat.create_tab',
        tabId: 'codex-subagent-chat',
        title: 'Codex subagent chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      }),
    );
    await target.command(
      envelope('send-codex-subagent', {
        type: 'chat.send_message',
        chatId: 'codex-subagent-chat',
        userMessageId: 'codex-subagent-user',
        text: 'Delegate and finish',
      }),
    );
    const ingest = (mutationId: string, event: Record<string, unknown>) =>
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'codex-subagent-chat',
        providerType: 'codex',
        turnUserMessageId: 'codex-subagent-user',
        mutationId,
        data: { type: 'codex', event },
      });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'codex-subagent-chat',
      providerType: 'codex',
      turnUserMessageId: 'codex-subagent-user',
      mutationId: 'codex-root-init',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-root',
        canopy_turn_user_message_id: 'codex-subagent-user',
      },
    });
    await expect(
      ingest('codex-child-completed', {
        type: 'turn.completed',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
      }),
    ).resolves.toBe(true);
    await expect(
      ingest('codex-root-tail', {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
        item: {
          id: 'root-answer',
          type: 'agent_message',
          text: 'Root turn finished after delegation',
        },
      }),
    ).resolves.toBe(true);

    let snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['codex-subagent-chat']?.status).toBe(
      'streaming',
    );
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Root turn finished after delegation',
    );

    await ingest('codex-root-completed', {
      type: 'turn.completed',
      thread_id: 'thread-root',
      turn_id: 'turn-root',
    });
    snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['codex-subagent-chat']?.status).toBe(
      'completed',
    );
  });

  it('keeps a Codex root turn active after a subagent errors', async () => {
    const target = service();
    await target.command(
      envelope('create-codex-subagent-error', {
        type: 'chat.create_tab',
        tabId: 'codex-subagent-error-chat',
        title: 'Codex subagent error chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      }),
    );
    await target.command(
      envelope('send-codex-subagent-error', {
        type: 'chat.send_message',
        chatId: 'codex-subagent-error-chat',
        userMessageId: 'codex-subagent-error-user',
        text: 'Delegate despite a child failure',
      }),
    );
    const ingest = (mutationId: string, event: Record<string, unknown>) =>
      target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'codex-subagent-error-chat',
        providerType: 'codex',
        turnUserMessageId: 'codex-subagent-error-user',
        mutationId,
        data: { type: 'codex', event },
      });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'codex-subagent-error-chat',
      providerType: 'codex',
      turnUserMessageId: 'codex-subagent-error-user',
      mutationId: 'codex-root-init-for-child-error',
      data: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-root',
        canopy_turn_user_message_id: 'codex-subagent-error-user',
      },
    });
    await expect(
      ingest('codex-child-error', {
        type: 'error',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
        message: 'Child failed',
      }),
    ).resolves.toBe(true);

    let snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['codex-subagent-error-chat']?.status).toBe(
      'streaming',
    );

    await expect(
      ingest('codex-root-completed-after-child-error', {
        type: 'turn.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
      }),
    ).resolves.toBe(true);
    snapshot = await target.getState(SCOPE);
    expect(snapshot.runtimeByChatId['codex-subagent-error-chat']?.status).toBe(
      'completed',
    );
  });

  it('returns retained receipts and natural-key dedupe after restart', async () => {
    const first = service();
    await createChat(first);
    await first.flushScope(SCOPE.projectId, SCOPE.worktreeId);

    const second = service();
    await expect(
      second.command(
        envelope('create-1', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'already_applied', revision: 1 });
    await expect(
      second.command(
        envelope('create-retry-new-id', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'already_applied',
      entityId: 'chat-1',
    });
  });

  it('allows concurrent idempotent tab patches from the same observed revision', async () => {
    const target = service();
    await createChat(target);
    const before = await target.getState(SCOPE);
    const chat = before.tabsFile.tabs[0];
    if (!chat) throw new Error('Expected created chat tab');
    await target.replaceCompatibilityTabs(SCOPE, {
      ...before.tabsFile,
      tabs: [{ ...chat, unread: true }],
    });
    const revision = (await target.getState(SCOPE)).revision;
    const withRevision = <T extends ChatCommand>(
      commandId: string,
      command: T,
    ): ChatCommandEnvelope<T> => ({
      ...envelope(commandId, command),
      expectedRevision: revision,
    });

    await expect(
      Promise.all([
        target.command(
          withRevision('activate-same-revision', {
            type: 'chat.activate_tab',
            tabId: 'chat-1',
          }),
        ),
        target.command(
          withRevision('read-same-revision', {
            type: 'chat.mark_read',
            chatId: 'chat-1',
          }),
        ),
        target.command(
          withRevision('dismiss-same-revision', {
            type: 'chat.dismiss_attention',
            chatId: 'chat-1',
          }),
        ),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ outcome: 'applied' }),
      expect.objectContaining({ outcome: 'applied' }),
      expect.objectContaining({ outcome: 'applied' }),
    ]);
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      unread: false,
      attentionDismissedAt: 1_786_104_000_000,
    });
  });

  it('treats read and attention clears for an absent tab as idempotent no-ops', async () => {
    const target = service();

    await expect(
      target.command(
        envelope('read-absent', {
          type: 'chat.mark_read',
          chatId: 'not-created-yet',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'already_applied', revision: 0 });
    await expect(
      target.command(
        envelope('dismiss-absent', {
          type: 'chat.dismiss_attention',
          chatId: 'not-created-yet',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'already_applied', revision: 0 });
  });

  it('retains every message when an archive larger than one page is restored under a new id', async () => {
    const target = service();
    const messages: PersistedChatMessage[] = Array.from(
      { length: 510 },
      (_, index) => ({
        id: `history-${index}`,
        role: 'assistant',
        timestamp: index,
        blocks: [{ type: 'text', text: `message ${index}` }],
      }),
    );
    await target.replaceCompatibilityArchives(SCOPE, {
      archived: [
        {
          tab: {
            id: 'old-archive',
            title: 'History',
            createdAt: '2026-09-05',
            messages,
          },
          archivedAt: '2026-09-05',
          turnCount: 0,
        },
      ],
    });
    expect(
      await target.command(
        envelope('restore-long-archive', {
          type: 'chat.restore_archive',
          archiveEntryId: 'old-archive',
          targetTabId: 'new-live',
        }),
      ),
    ).toMatchObject({ outcome: 'applied' });
    const tabs = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['new-live'],
      fullTranscript: true,
    });
    expect(tabs.tabs[0].messages).toEqual(messages);
    // This integration case persists and restores more than a page of real
    // transcript rows; directory synchronization can exceed Jest's default.
  }, 30_000);

  it('commits archive and restore as single revisions', async () => {
    const target = service();
    await createChat(target);
    const archived = await target.command(
      envelope('archive-1', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    expect(archived.revision).toBe(2);
    let snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs).toEqual([]);
    expect(snapshot.archives).toHaveLength(1);

    const restored = await target.command(
      envelope('restore-1', {
        type: 'chat.restore_archive',
        archiveEntryId: 'chat-1',
      }),
    );
    expect(restored.revision).toBe(3);
    snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs[0]?.id).toBe('chat-1');
    expect(snapshot.archives).toEqual([]);
  });

  it('serializes concurrent restores without replacing the newly live tab', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-concurrent', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );

    const results = await Promise.all([
      target.command(
        envelope('restore-concurrent-a', {
          type: 'chat.restore_archive',
          archiveEntryId: 'chat-1',
        }),
      ),
      target.command(
        envelope('restore-concurrent-b', {
          type: 'chat.restore_archive',
          archiveEntryId: 'chat-1',
        }),
      ),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      'already_applied',
      'applied',
    ]);
    expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
  });

  it('persists the renderer successor when closing the active tab', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-successor-2', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
      }),
    );
    await target.command(
      envelope('create-successor-3', {
        type: 'chat.create_tab',
        tabId: 'chat-3',
      }),
    );
    await target.command(
      envelope('activate-successor-middle', {
        type: 'chat.activate_tab',
        tabId: 'chat-2',
      }),
    );
    const beforeClose = await target.getState(SCOPE);
    const chat3 = beforeClose.tabsFile.tabs.find((tab) => tab.id === 'chat-3');
    if (!chat3) throw new Error('Expected successor tab');
    await target.replaceCompatibilityTabs(SCOPE, {
      ...beforeClose.tabsFile,
      tabs: beforeClose.tabsFile.tabs.map((tab) =>
        tab.id === 'chat-3'
          ? { ...tab, unread: true, attentionDismissedAt: undefined }
          : tab,
      ),
    });

    await target.command(
      envelope('close-successor-middle', {
        type: 'chat.close_tab',
        tabId: 'chat-2',
        mode: 'discard_empty',
      }),
    );

    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile.activeTabId).toBe('chat-3');
    expect(
      reloaded.tabsFile.tabs.find((tab) => tab.id === 'chat-3'),
    ).toMatchObject({
      unread: false,
      attentionDismissedAt: 1_786_104_000_000,
    });
  });

  it('persists the acknowledged successor after a bulk active-tab close', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-bulk-successor-2', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
      }),
    );
    await target.command(
      envelope('create-bulk-successor-3', {
        type: 'chat.create_tab',
        tabId: 'chat-3',
      }),
    );
    await target.command(
      envelope('activate-bulk-successor-middle', {
        type: 'chat.activate_tab',
        tabId: 'chat-2',
      }),
    );
    const beforeClose = await target.getState(SCOPE);
    await target.replaceCompatibilityTabs(SCOPE, {
      ...beforeClose.tabsFile,
      tabs: beforeClose.tabsFile.tabs.map((tab) =>
        tab.id === 'chat-3'
          ? { ...tab, unread: true, attentionDismissedAt: undefined }
          : tab,
      ),
    });

    await target.command(
      envelope('close-bulk-with-successor', {
        type: 'chat.close_tabs',
        targets: [
          { tabId: 'chat-1', mode: 'discard_empty' },
          { tabId: 'chat-2', mode: 'discard_empty' },
        ],
      }),
    );

    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile.activeTabId).toBe('chat-3');
    expect(reloaded.tabsFile.tabs).toEqual([
      expect.objectContaining({
        id: 'chat-3',
        unread: false,
        attentionDismissedAt: 1_786_104_000_000,
      }),
    ]);
  });

  it('creates a background file without publishing or persisting an active-tab change', async () => {
    const target = service();
    await createChat(target);
    const before = await target.getState(SCOPE);
    const command = {
      type: 'chat.create_file_tab' as const,
      tabId: 'background-file',
      filePath: '/tmp/background.md',
      activate: false,
    };
    await expect(
      target.command(envelope('create-background-file', command)),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile.activeTabId).toBe(before.tabsFile.activeTabId);
    expect(reloaded.tabsFile.tabs).toContainEqual(
      expect.objectContaining({ id: 'background-file', kind: 'file' }),
    );
  });

  it('activates a file-tab successor without applying chat metadata', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-file-successor', {
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: '/tmp/successor.md',
      }),
    );
    await target.command(
      envelope('reactivate-chat-before-file-successor', {
        type: 'chat.activate_tab',
        tabId: 'chat-1',
      }),
    );

    await expect(
      target.command(
        envelope('close-chat-before-file-successor', {
          type: 'chat.close_tab',
          tabId: 'chat-1',
          mode: 'discard_empty',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile.activeTabId).toBe('file-1');
    expect(reloaded.tabsFile.tabs).toEqual([
      expect.objectContaining({ id: 'file-1', kind: 'file' }),
    ]);
  });

  it('remembers a surviving editable chat when close activates a file tab', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('create-surviving-editable-chat', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        providerType: 'codex',
      }),
    );
    await target.command(
      envelope('create-file-close-successor', {
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: '/tmp/successor.md',
      }),
    );
    await target.command(
      envelope('activate-chat-before-file-close', {
        type: 'chat.activate_tab',
        tabId: 'chat-2',
      }),
    );

    await target.command(
      envelope('close-chat-into-file', {
        type: 'chat.close_tab',
        tabId: 'chat-2',
        mode: 'discard_empty',
      }),
    );

    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile).toMatchObject({
      activeTabId: 'file-1',
      lastActiveEditableChatId: 'chat-1',
    });
  });

  it('remembers a surviving editable chat when bulk close activates a file tab', async () => {
    const target = service();
    await createChat(target);
    for (const tabId of ['chat-2', 'chat-3']) {
      await target.command(
        envelope(`create-${tabId}-before-file-bulk-close`, {
          type: 'chat.create_tab',
          tabId,
        }),
      );
    }
    await target.command(
      envelope('create-file-bulk-close-successor', {
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: '/tmp/bulk-successor.md',
      }),
    );
    await target.command(
      envelope('activate-chat-before-file-bulk-close', {
        type: 'chat.activate_tab',
        tabId: 'chat-2',
      }),
    );

    await target.command(
      envelope('bulk-close-chats-into-file', {
        type: 'chat.close_tabs',
        targets: [
          { tabId: 'chat-2', mode: 'discard_empty' },
          { tabId: 'chat-3', mode: 'discard_empty' },
        ],
      }),
    );

    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile).toMatchObject({
      activeTabId: 'file-1',
      lastActiveEditableChatId: 'chat-1',
    });
  });

  it('uses the renderer positional successor after a multi-target bulk close', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    for (const tabId of ['chat-2', 'chat-3', 'chat-4']) {
      await target.command(
        envelope(`create-${tabId}`, {
          type: 'chat.create_tab',
          tabId,
        }),
      );
    }
    await target.command(
      envelope('activate-first-before-positional-close', {
        type: 'chat.activate_tab',
        tabId: 'chat-1',
      }),
    );

    await target.command(
      envelope('close-nonadjacent-tabs', {
        type: 'chat.close_tabs',
        targets: [
          { tabId: 'chat-1', mode: 'discard_empty' },
          { tabId: 'chat-3', mode: 'discard_empty' },
        ],
      }),
    );

    await repository.flushScope(SCOPE);
    const reloaded = await service().getState(SCOPE);
    expect(reloaded.tabsFile.tabs.map((tab) => tab.id)).toEqual([
      'chat-2',
      'chat-4',
    ]);
    expect(reloaded.tabsFile.activeTabId).toBe('chat-2');
  });

  it('archives transcript updates committed after the close command reads state', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const assistant: PersistedChatMessage = {
      id: 'assistant-during-close',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Committed while close was pending' }],
    };
    const transactWith = repository.transactWith.bind(repository);
    let injected = false;
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation(async (scope, build, options) => {
        if (
          options.mutationId === 'close-with-latest-transcript' &&
          !injected
        ) {
          injected = true;
          await transactWith(
            SCOPE,
            () => [
              {
                type: 'message.upserted',
                chatId: 'chat-1',
                message: assistant,
              },
            ],
            {
              source: 'provider',
              mutationId: 'provider-during-close',
            },
          );
        }
        return transactWith(scope, build, options);
      });

    await expect(
      target.command(
        envelope('close-with-latest-transcript', {
          type: 'chat.close_tab',
          tabId: 'chat-1',
          mode: 'archive',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect(
      (
        await target.getCompatibilityArchives(SCOPE, {
          chatIds: ['chat-1'],
          fullTranscript: true,
        })
      ).archived[0]?.tab.messages,
    ).toContainEqual(assistant);
  });

  it('persists the last editable chat and provider across file-tab restart', async () => {
    const first = service();
    await createChat(first);
    await first.command(
      envelope('create-activation-target', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        providerType: 'codex',
        model: 'gpt-6-sol',
      }),
    );
    await first.command(
      envelope('activate-editable-chat', {
        type: 'chat.activate_tab',
        tabId: 'chat-1',
      }),
    );
    await first.command(
      envelope('create-file-after-activation', {
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: '/tmp/notes.md',
      }),
    );
    await first.flushScope(SCOPE.projectId, SCOPE.worktreeId);

    const restored = await service().getState(SCOPE);
    expect(restored.tabsFile).toMatchObject({
      activeTabId: 'file-1',
      lastActiveEditableChatId: 'chat-1',
      lastActiveChatProvider: 'claude',
    });
  });

  it('settles an interrupted transcript before command-port archive', async () => {
    const target = service();
    await createChat(target);
    const live = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...live,
      tabs: live.tabs.map((tab) =>
        tab.id === 'chat-1'
          ? {
              ...tab,
              messages: [
                ...tab.messages,
                {
                  id: 'assistant-interrupted',
                  role: 'assistant' as const,
                  timestamp: 2,
                  blocks: [
                    {
                      type: 'turn_timer' as const,
                      startedAt: 10,
                      completedAt: null,
                    },
                    {
                      type: 'tool_use' as const,
                      toolUseId: 'tool-interrupted',
                      toolName: 'Read',
                      input: '{}',
                    },
                  ],
                },
              ],
            }
          : tab,
      ),
    });

    await target.command(
      envelope('archive-interrupted', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );

    const archived = (
      await target.getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      })
    ).archived[0];
    const blocks = archived?.tab.messages.flatMap(({ blocks }) => blocks) ?? [];
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: 'turn_timer',
        completedAt: 1_786_104_000_000,
      }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'tool-interrupted',
        isError: true,
      }),
    );
  });

  it('dispatches a stable user message id only once under concurrent commands', async () => {
    const target = service();
    await createChat(target);
    const command = {
      type: 'chat.send_message' as const,
      chatId: 'chat-1',
      userMessageId: 'stable-message',
      text: 'Exactly once',
    };

    const results = await Promise.all([
      target.command(envelope('send-concurrent-a', command)),
      target.command(envelope('send-concurrent-b', command)),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      'already_applied',
      'applied',
    ]);
    expect(dispatched).toHaveLength(1);
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.messages.filter(
        ({ id }) => id === 'stable-message',
      ),
    ).toHaveLength(1);
  });

  it('forwards persisted fork and reconstruction metadata on canonical sends', async () => {
    const target = service();
    await createChat(target);
    const live = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...live,
      tabs: live.tabs.map((tab) =>
        tab.id === 'chat-1'
          ? {
              ...tab,
              sdkSessionId: 'session-1',
              claudeForkSessionOnNextSend: true,
              codexReconstructionSeedId: 'seed-1',
              forkedFrom: {
                projectId: SCOPE.projectId,
                worktreeId: SCOPE.worktreeId,
                chatId: 'source-chat',
                atMessageId: 'assistant-anchor',
                resumePointRequired: true,
              },
              messages: [
                {
                  id: 'assistant-anchor',
                  role: 'assistant' as const,
                  timestamp: 1,
                  blocks: [{ type: 'text' as const, text: 'Kept answer' }],
                  claudeUuid: '11111111-1111-4111-8111-111111111111',
                },
              ],
            }
          : tab,
      ),
    });

    await target.command(
      envelope('send-with-reconstruction', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-with-reconstruction',
        text: 'Continue',
      }),
    );

    expect(dispatched[0]).toMatchObject({
      sdkSessionId: 'session-1',
      claudeForkSession: true,
      claudeForkResumeAt: '11111111-1111-4111-8111-111111111111',
      codexReconstructionSeedId: 'seed-1',
    });
  });

  it.each([false, true])(
    'consumes a successful Claude fork init durably before a resumed send (fresh=%s)',
    async (fresh) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      const live = await target.getCompatibilityTabs(SCOPE);
      await target.replaceCompatibilityTabs(SCOPE, {
        ...live,
        tabs: live.tabs.map((tab) => ({
          ...tab,
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: SCOPE.projectId,
            worktreeId: SCOPE.worktreeId,
            chatId: 'source-chat',
            atMessageId: 'assistant-anchor',
            resumePointRequired: true,
          },
          messages: [
            {
              id: 'assistant-anchor',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Source answer' }],
              claudeUuid: '11111111-1111-4111-8111-111111111111',
            },
          ],
        })),
      });
      await target.command(
        envelope('initial-fork-send', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'child-prompt',
          text: 'Remember the child-only task',
        }),
      );
      expect(dispatched[0]).toMatchObject({
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: '11111111-1111-4111-8111-111111111111',
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-init',
        turnUserMessageId: 'child-prompt',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: 'child-session',
          ...(fresh ? { canopy_fork_model_context: 'fresh' } : {}),
        },
      });
      const initialized = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(initialized).toMatchObject({ sdkSessionId: 'child-session' });
      expect(initialized).not.toHaveProperty('claudeForkSessionOnNextSend');
      expect(initialized.forkedFrom).toEqual({
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: 'source-chat',
        atMessageId: 'assistant-anchor',
        ...(fresh ? { modelContext: 'fresh' } : {}),
      });
      await target.ingestProviderEvent({
        ...SCOPE,
        chatId: 'chat-1',
        mutationId: 'child-result',
        turnUserMessageId: 'child-prompt',
        data: {
          type: 'result',
          result: 'Child-only task accepted',
          is_error: false,
        },
      });
      await repository.drainAll();
      const restarted = serviceWithRepository().target;
      await restarted.command(
        envelope('resumed-child-send', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'resumed-prompt',
          text: 'Continue the child-only task',
        }),
      );
      expect(dispatched[1]).toMatchObject({ sdkSessionId: 'child-session' });
      expect(dispatched[1]).not.toHaveProperty('claudeForkSession');
      expect(dispatched[1]).not.toHaveProperty('claudeForkResumeAt');
      expect(dispatched[1]).not.toHaveProperty('claudeForkStartsFresh');
      const restored = await restarted.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      expect(
        restored.tabs[0].messages.some(
          (message) => message.id === 'child-prompt',
        ),
      ).toBe(true);
    },
  );

  it('does not reuse durable fork provenance as a canonical resume anchor after restore', async () => {
    const target = service();
    await createChat(target);
    const live = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...live,
      tabs: live.tabs.map((tab) => ({
        ...tab,
        sdkSessionId: 'session-1',
        claudeForkSessionOnNextSend: true,
        forkedFrom: {
          projectId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
          chatId: 'original-source',
          atMessageId: 'stale-original-fork-point',
        },
      })),
    });

    await target.command(
      envelope('send-plain-fork', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-plain-fork',
        text: 'Continue',
      }),
    );

    expect(dispatched[0]).toMatchObject({
      sdkSessionId: 'session-1',
      claudeForkSession: true,
    });
    expect(dispatched[0]).not.toHaveProperty('claudeForkResumeAt');
    expect(dispatched[0]).not.toHaveProperty('claudeForkStartsFresh');
  });

  it('marks a point-in-time fork fresh when its canonical anchor disappears', async () => {
    const target = service();
    await createChat(target);
    const live = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...live,
      tabs: live.tabs.map((tab) => ({
        ...tab,
        sdkSessionId: 'session-1',
        claudeForkSessionOnNextSend: true,
        forkedFrom: {
          projectId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
          chatId: 'source-chat',
          resumePointRequired: true,
        },
      })),
    });

    await target.command(
      envelope('send-fresh-fallback', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-fresh-fallback',
        text: 'Continue',
      }),
    );

    expect(dispatched[0]).toMatchObject({ claudeForkStartsFresh: true });
    expect(dispatched[0]).not.toHaveProperty('sdkSessionId');
    expect(dispatched[0]).not.toHaveProperty('claudeForkSession');
  });

  it('persists compatibility updates to existing tabs as well as new tabs', async () => {
    const target = service();
    await createChat(target);

    const updated = await target.updateCompatibilityTabs(SCOPE, (current) => ({
      ...current,
      tabs: current.tabs.map((tab) => ({ ...tab, title: 'Relabeled chat' })),
    }));

    expect(updated.tabs[0]?.title).toBe('Relabeled chat');
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.title).toBe(
      'Relabeled chat',
    );
  });

  it('updates compatibility metadata without requesting transcript hydration', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const transactions = jest.spyOn(repository, 'transactWith');
    await target.updateCompatibilityTab(
      SCOPE,
      'chat-1',
      (tab) => ({ ...tab, sdkSessionId: 'replacement-thread' }),
      undefined,
      { metadataOnly: true },
    );
    const options =
      transactions.mock.calls[transactions.mock.calls.length - 1]?.[2];
    expect(options).not.toHaveProperty('chatIds');
    expect(options).not.toHaveProperty('fullTranscript');
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]?.sdkSessionId).toBe(
      'replacement-thread',
    );
  });

  it('finds one durable message id in live and archived chats without reading the transcript', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const message = (
      id: string,
      role: 'user' | 'assistant',
    ): PersistedChatMessage => ({
      id,
      role,
      timestamp: 1,
      blocks: [{ type: 'text', text: id }],
    });
    await repository.transact(
      SCOPE,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message('watcher-delivered', 'user'),
        },
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message('settled-reply', 'assistant'),
        },
      ],
      { source: 'provider' },
    );
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'active-root', startedAt: 1 },
          },
        },
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message('active-root', 'user'),
        },
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message('streaming-reply', 'assistant'),
        },
      ],
      { source: 'provider' },
    );
    const iterate = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');
    const page = jest.spyOn(ChatTranscriptLog.prototype, 'page');

    for (const id of ['watcher-delivered', 'active-root', 'streaming-reply'])
      await expect(
        target.hasTranscriptMessage(SCOPE, 'chat-1', id),
      ).resolves.toBe(true);
    await expect(
      target.hasTranscriptMessage(SCOPE, 'chat-1', 'watcher-never-sent'),
    ).resolves.toBe(false);
    await expect(
      target.hasTranscriptMessage(SCOPE, 'missing-chat', 'watcher-delivered'),
    ).resolves.toBe(false);
    expect(iterate).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();

    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await target.command(
      envelope('archive-before-message-lookup', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    expect((await target.getState(SCOPE)).tabsFile.tabs).toEqual([]);
    await expect(
      target.hasTranscriptMessage(SCOPE, 'chat-1', 'watcher-delivered'),
    ).resolves.toBe(true);
    await expect(
      target.hasTranscriptMessage(SCOPE, 'chat-1', 'watcher-never-sent'),
    ).resolves.toBe(false);
  });

  it('removes a compatibility archive through the canonical repository', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-for-compatibility-removal', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );

    await expect(
      target.removeCompatibilityArchive(SCOPE, 'chat-1'),
    ).resolves.toMatchObject({ tab: { id: 'chat-1' } });
    await expect(
      target.removeCompatibilityArchive(SCOPE, 'chat-1'),
    ).resolves.toBeNull();
    await expect(
      target.getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      }),
    ).resolves.toMatchObject({
      version: 1,
      archived: [],
    });
  });

  describe('initial automatic chat titles', () => {
    async function untitled(target: ChatStateService): Promise<void> {
      await target.command(
        envelope('create-untitled', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
        }),
      );
    }

    it.each([
      {
        fields: { title: 'New chat', description: null, customTitle: null },
        eligible: true,
      },
      {
        fields: { title: '  ', description: '  ', customTitle: '  ' },
        eligible: true,
      },
      { fields: { title: 'New chat', description: 'Saved' }, eligible: false },
      { fields: { title: 'New chat', customTitle: 'Mine' }, eligible: false },
      { fields: { title: 'Meaningful creation title' }, eligible: false },
    ])(
      'normalizes nullable and whitespace fields: $fields',
      ({ fields, eligible }) => {
        expect(isInitialChatTitleEligible(fields)).toBe(eligible);
      },
    );

    it.each([false, true])(
      'protects a legacy saved description (archived=%s)',
      async (archived) => {
        const target = service();
        await untitled(target);
        await target.updateChatDescription(SCOPE, 'chat-1', 'Legacy title');
        if (archived)
          await target.command(
            envelope('archive', { type: 'chat.archive_tab', tabId: 'chat-1' }),
          );
        await expect(
          target.commitInitialChatTitle(SCOPE, 'chat-1', 'Replacement'),
        ).resolves.toBe(false);
        await expect(
          target.getInitialChatTitlePrompt(SCOPE, 'chat-1'),
        ).resolves.toBeNull();
      },
    );

    it('keeps the generated title when a later rename is cleared', async () => {
      const target = service();
      await untitled(target);
      await target.commitInitialChatTitle(SCOPE, 'chat-1', 'Original title');
      await target.command(
        envelope('rename', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'Mine' },
        }),
      );
      await target.command(
        envelope('clear', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: null },
        }),
      );
      expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
        description: 'Original title',
        automaticTitleState: 'closed',
      });
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Late title'),
      ).resolves.toBe(false);
    });

    it('uses the first visible user message, including an attachment-only prompt', async () => {
      const target = service();
      const tab: PersistedChatTab = {
        id: 'chat-1',
        title: 'New chat',
        createdAt: new Date().toISOString(),
        messages: [
          {
            id: 'hidden',
            role: 'user',
            hidden: true,
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Injected continuation' }],
          },
          {
            id: 'assistant',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Agent output' }],
          },
          {
            id: 'first',
            role: 'user',
            timestamp: 3,
            blocks: [],
            attachmentPaths: ['/attachment.png'],
          },
          {
            id: 'later',
            role: 'user',
            timestamp: 4,
            blocks: [{ type: 'text', text: 'Later subject' }],
          },
        ],
      };
      await target.replaceCompatibilityState(
        SCOPE,
        { version: 1, activeTabId: tab.id, tabs: [tab] },
        { version: 1, archived: [] },
      );
      await expect(
        target.getInitialChatTitlePrompt(SCOPE, tab.id),
      ).resolves.toBe('');
    });

    it.each([
      {
        automaticTitleState: undefined,
        title: undefined,
        expectedTitle: 'Investigate the failing health-check end...',
        expected: 'pending',
      },
      {
        automaticTitleState: 'closed' as const,
        title: undefined,
        expectedTitle: 'Investigate the failing health-check end...',
        expected: 'closed',
      },
      // An explicit send title is a saved name, so it closes naming.
      {
        automaticTitleState: undefined,
        title: 'Health check',
        expectedTitle: 'Health check',
        expected: 'closed',
      },
    ])(
      'keeps naming state when a trusted send retitles an existing placeholder chat ($automaticTitleState, title=$title)',
      async ({ automaticTitleState, title, expectedTitle, expected }) => {
        const target = service();
        await target.replaceCompatibilityState(
          SCOPE,
          {
            version: 1,
            activeTabId: 'chat-1',
            tabs: [
              {
                id: 'chat-1',
                title: 'New Chat',
                createdAt: '2026-10-01T00:00:00.000Z',
                messages: [],
                ...(automaticTitleState ? { automaticTitleState } : {}),
              },
            ],
          },
          { version: 1, archived: [] },
        );
        await target.ensureChatForTrustedSend({
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'user-first',
          text: 'Investigate the failing health-check endpoint.',
          ...(title ? { title } : {}),
        });
        const tab = (await target.getState(SCOPE)).tabsFile.tabs[0];
        expect(tab).toMatchObject({
          title: expectedTitle,
          ...(title ? { customTitle: title } : {}),
          automaticTitleState: expected,
        });
        expect(isInitialChatTitleEligible(tab)).toBe(expected === 'pending');
      },
    );

    it('skips the canonical read once naming is closed', async () => {
      const { target, repository } = serviceWithRepository();
      await untitled(target);
      await target.command(
        envelope('create-renamed', {
          type: 'chat.create_tab',
          tabId: 'chat-renamed',
        }),
      );
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Generated title'),
      ).resolves.toBe(true);
      await target.command(
        envelope('rename', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-renamed',
          patch: { customTitle: 'Mine' },
        }),
      );
      const getState = jest.spyOn(repository, 'getState');

      await expect(
        target.getInitialChatTitlePrompt(SCOPE, 'chat-1'),
      ).resolves.toBeNull();
      expect(getState).not.toHaveBeenCalled();

      // A rename closes naming durably; the first read remembers it.
      await expect(
        target.getInitialChatTitlePrompt(SCOPE, 'chat-renamed'),
      ).resolves.toBeNull();
      await expect(
        target.getInitialChatTitlePrompt(SCOPE, 'chat-renamed'),
      ).resolves.toBeNull();
      expect(getState).toHaveBeenCalledTimes(1);
    });

    it('remembers legacy settled chats after one canonical read', async () => {
      const { target, repository } = serviceWithRepository();
      await target.replaceCompatibilityState(
        SCOPE,
        {
          version: 1,
          activeTabId: 'chat-described',
          tabs: [
            {
              id: 'chat-described',
              title: 'New Chat',
              description: 'Saved summary',
              createdAt: '2026-10-01T00:00:00.000Z',
              messages: [],
            },
            {
              id: 'chat-named',
              title: 'Release planning',
              createdAt: '2026-10-01T00:00:00.000Z',
              messages: [],
            },
          ],
        },
        { version: 1, archived: [] },
      );
      const getState = jest.spyOn(repository, 'getState');
      for (const chatId of ['chat-described', 'chat-named']) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            target.getInitialChatTitlePrompt(SCOPE, chatId),
          ).resolves.toBeNull();
        }
      }
      expect(getState).toHaveBeenCalledTimes(2);
    });

    it('does not recreate a deleted chat with a late result', async () => {
      const target = service();
      await untitled(target);
      await target.command(
        envelope('close', { type: 'chat.close_tab', tabId: 'chat-1' }),
      );
      await target.removeCompatibilityArchive(SCOPE, 'chat-1');
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Late title'),
      ).resolves.toBe(false);
      await expect(
        target.getInitialChatTitlePrompt(SCOPE, 'chat-1'),
      ).resolves.toBeNull();
    });

    it.each([false, true])(
      'commits once for an untitled chat (archived=%s)',
      async (archived) => {
        const target = service();
        await untitled(target);
        if (archived)
          await target.command(
            envelope('archive', { type: 'chat.archive_tab', tabId: 'chat-1' }),
          );
        const results = await Promise.all([
          target.commitInitialChatTitle(SCOPE, 'chat-1', 'First title'),
          target.commitInitialChatTitle(SCOPE, 'chat-1', 'Second title'),
        ]);
        expect(results).toEqual([true, false]);
        const recovered = serviceWithRepository(
          {},
          copyDurableFilesAtBoundary(),
        ).target;
        await expect(
          recovered.commitInitialChatTitle(SCOPE, 'chat-1', 'After restart'),
        ).resolves.toBe(false);
      },
    );

    it('protects saved creation names, missing chats and blank results', async () => {
      const target = service();
      await createChat(target);
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Replacement'),
      ).resolves.toBe(false);
      await expect(
        target.commitInitialChatTitle(SCOPE, 'missing', 'Replacement'),
      ).resolves.toBe(false);
      await target.command(
        envelope('placeholder', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { title: 'New chat' },
        }),
      );
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', '   '),
      ).resolves.toBe(false);
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Valid title'),
      ).resolves.toBe(true);
    });

    it.each([false, true])(
      'rename then clear suppresses naming across restart (archived=%s)',
      async (archived) => {
        const target = service();
        await untitled(target);
        await target.command(
          envelope('rename', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { customTitle: 'Mine' },
          }),
        );
        await target.command(
          envelope('clear', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { customTitle: null },
          }),
        );
        if (archived)
          await target.command(
            envelope('archive', { type: 'chat.archive_tab', tabId: 'chat-1' }),
          );
        const recovered = serviceWithRepository(
          {},
          copyDurableFilesAtBoundary(),
        ).target;
        await expect(
          recovered.commitInitialChatTitle(SCOPE, 'chat-1', 'Late result'),
        ).resolves.toBe(false);
      },
    );

    it.each(['state', 'archives'] as const)(
      'keeps rename suppression through a %s compatibility snapshot',
      async (kind) => {
        const target = service();
        await untitled(target);
        await target.command(
          envelope('rename', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { customTitle: 'Mine' },
          }),
        );
        await target.command(
          envelope('clear', {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { customTitle: null },
          }),
        );
        await target.command(
          envelope('archive', { type: 'chat.archive_tab', tabId: 'chat-1' }),
        );
        const archives = await target.getCompatibilityArchives(SCOPE, {
          chatIds: ['chat-1'],
          fullTranscript: true,
        });
        const incoming = {
          ...archives,
          archived: archives.archived.map((entry) => ({
            ...entry,
            tab: { ...entry.tab },
          })),
        };
        delete incoming.archived[0].tab.automaticTitleState;
        if (kind === 'state')
          await target.replaceCompatibilityState(
            SCOPE,
            { version: 1, tabs: [], activeTabId: '' },
            incoming,
          );
        else await target.replaceCompatibilityArchives(SCOPE, incoming);
        await expect(
          target.commitInitialChatTitle(SCOPE, 'chat-1', 'Late result'),
        ).resolves.toBe(false);
      },
    );

    it('keeps rename suppression through a fresh live compatibility tab snapshot', async () => {
      const target = service();
      await untitled(target);
      await target.command(
        envelope('rename', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'Mine' },
        }),
      );
      await target.command(
        envelope('clear', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: null },
        }),
      );
      const { tabsFile } = await target.getState(SCOPE);
      const incoming = {
        ...tabsFile,
        tabs: tabsFile.tabs.map((tab) => ({ ...tab })),
      };
      delete incoming.tabs[0].automaticTitleState;
      await target.replaceCompatibilityTabs(SCOPE, incoming);
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Stale result'),
      ).resolves.toBe(false);
    });

    it('selects the canonical first prompt after later sends and restart', async () => {
      const target = service();
      await untitled(target);
      for (const [id, text] of [
        ['first', 'Repair login'],
        ['later', 'Different request'],
      ]) {
        await target.command(
          envelope(id, {
            type: 'chat.commit_terminal_initial_prompt',
            chatId: 'chat-1',
            userMessageId: id,
            turnTimerMessageId: id + '-timer',
            text,
          }),
        );
      }
      const recovered = serviceWithRepository(
        {},
        copyDurableFilesAtBoundary(),
      ).target;
      await expect(
        recovered.getInitialChatTitlePrompt(SCOPE, 'chat-1'),
      ).resolves.toBe('Repair login');
      await expect(
        recovered.commitInitialChatTitle(SCOPE, 'chat-1', 'Login repair'),
      ).resolves.toBe(true);
      await expect(
        recovered.getInitialChatTitlePrompt(SCOPE, 'chat-1'),
      ).resolves.toBeNull();
    });

    it('leaves eligibility open when durable persistence fails', async () => {
      const { target, repository } = serviceWithRepository();
      await untitled(target);
      jest
        .spyOn(repository, 'transactWith')
        .mockRejectedValueOnce(new Error('disk full'));
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Lost title'),
      ).rejects.toThrow('disk full');
      await expect(
        target.commitInitialChatTitle(SCOPE, 'chat-1', 'Saved title'),
      ).resolves.toBe(true);
    });
  });

  it('preserves custom titles through generated updates, canonical reload, archive and restore, then clears them', async () => {
    const target = service();
    await createChat(target);
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).not.toHaveProperty(
      'customTitle',
    );
    await expect(
      target.command(
        envelope('rename', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'My chat' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied', revision: 2 });
    await target.updateChatDescription(SCOPE, 'chat-1', 'New generated name');
    await target.command(
      envelope('pin-after-rename', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pinned: true },
      }),
    );
    const recovered = serviceWithRepository(
      {},
      copyDurableFilesAtBoundary(),
    ).target;
    const tab = (await recovered.getState(SCOPE)).tabsFile.tabs[0];
    expect(tab).toMatchObject({
      customTitle: 'My chat',
      description: 'New generated name',
      pinned: true,
    });
    expect(chatDisplayLabel({ ...tab, fallback: 'Chat' })).toBe('My chat');
    await recovered.command(
      envelope('archive-renamed', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    await recovered.updateChatDescription(
      SCOPE,
      'chat-1',
      'Generated after archive',
    );
    expect((await recovered.getState(SCOPE)).archives[0]).toMatchObject({
      customTitle: 'My chat',
      description: 'Generated after archive',
    });
    await recovered.command(
      envelope('restore-renamed', {
        type: 'chat.restore_archive',
        archiveEntryId: 'chat-1',
      }),
    );
    expect((await recovered.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      customTitle: 'My chat',
      description: 'Generated after archive',
    });
    await recovered.command(
      envelope('replace-rename', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { customTitle: 'Replacement' },
      }),
    );
    await recovered.command(
      envelope('clear-rename', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { customTitle: null },
      }),
    );
    const cleared = (await recovered.getState(SCOPE)).tabsFile.tabs[0];
    expect(cleared).not.toHaveProperty('customTitle');
    expect(cleared).toMatchObject({
      pinned: true,
      description: 'Generated after archive',
    });
    expect(chatDisplayLabel({ ...cleared, fallback: 'Chat' })).toBe(
      'Generated after archive',
    );
  });

  it('applies a stale rename without overwriting newer settings and rejects file or missing targets', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('pin', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pinned: true, customTitle: 'Current name' },
      }),
    );
    await expect(
      target.command({
        ...envelope('stale-rename', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'Stale name' },
        }),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      pinned: true,
      customTitle: 'Stale name',
    });
    await target.command(
      envelope('create-file', {
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: '',
      }),
    );
    await expect(
      target.command(
        envelope('rename-file', {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: { customTitle: 'File name' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'rejected' });
    await expect(
      target.command(
        envelope('rename-missing', {
          type: 'chat.patch_tab_settings',
          tabId: 'missing',
          patch: { customTitle: 'Missing name' },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'not_found' });
  });

  it.each([undefined, 'continuation'] as const)(
    'derives a fork creation title from the effective source name without inheriting its override (%s)',
    async (cloneMode) => {
      const target = service();
      await createChat(target);
      await target.command(
        envelope('send-source', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'source-message',
          text: 'Source prompt',
        }),
      );
      await target.command(
        envelope('rename-source', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { customTitle: 'My chat' },
        }),
      );
      await expect(
        target.command(
          envelope('fork-renamed', {
            type: 'chat.fork_tab',
            sourceTabId: 'chat-1',
            targetTabId: 'fork',
            cloneMode,
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const tabs = (await target.getState(SCOPE)).tabsFile.tabs;
      expect(tabs.find((tab) => tab.id === 'fork')).toMatchObject({
        title: 'Fork: My chat',
      });
      expect(tabs.find((tab) => tab.id === 'fork')).not.toHaveProperty(
        'customTitle',
      );
      expect(tabs.find((tab) => tab.id === 'chat-1')).toMatchObject({
        customTitle: 'My chat',
      });
      await expect(
        target.getInitialChatTitlePrompt(SCOPE, 'fork'),
      ).resolves.toBeNull();
      await expect(
        target.commitInitialChatTitle(SCOPE, 'fork', 'Replacement'),
      ).resolves.toBe(false);
    },
  );

  it('names a genuinely untitled derived chat from its canonical first prompt', async () => {
    const target = service();
    await createChat(target);
    await expect(
      target.command(
        envelope('source-prompt', {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: 'chat-1',
          userMessageId: 'source-first',
          turnTimerMessageId: 'source-timer',
          text: 'Repair login',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const source = (await target.getState(SCOPE)).tabsFile.tabs[0];
    await expect(
      target.command(
        envelope('derive-untitled', {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'untitled-fork',
          destinationTab: {
            ...source,
            id: 'untitled-fork',
            title: 'New Chat',
            messages: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(
      target.command(
        envelope('derived-later', {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: 'untitled-fork',
          userMessageId: 'derived-later',
          turnTimerMessageId: 'derived-timer',
          text: 'Different subject',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(
      target.getInitialChatTitlePrompt(SCOPE, 'untitled-fork'),
    ).resolves.toBe('Repair login');
    await expect(
      target.commitInitialChatTitle(SCOPE, 'untitled-fork', 'Login repair'),
    ).resolves.toBe(true);
    await expect(
      target.commitInitialChatTitle(SCOPE, 'untitled-fork', 'Later title'),
    ).resolves.toBe(false);
  });

  it('persists a late generated description into an archived chat', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-before-summary', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );

    await target.updateChatDescription(
      SCOPE,
      'chat-1',
      'Generated after archive',
    );

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs).toEqual([]);
    expect(snapshot.archives).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Durable chat',
        description: 'Generated after archive',
      }),
    ]);
    const archivesFile = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    expect(archivesFile.archived[0]?.tab.description).toBe(
      'Generated after archive',
    );
  });

  it('atomically resumes an auto-archived chat when provider output arrives', async () => {
    const target = service();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'enable-auto-archive',
      data: { type: 'canopy_set_auto_archive_requested', enabled: true },
    });
    await target.command(
      envelope('auto-archive-1', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
        keepSession: true,
      }),
    );

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'resumed-assistant-1',
      data: {
        type: 'assistant',
        message: {
          id: 'resumed-assistant-native-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Resumed after auto-archive' }],
        },
      },
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.archives).toEqual([]);
    expect(snapshot.tabsFile.tabs).toHaveLength(1);
    expect(snapshot.tabsFile.tabs[0]).toMatchObject({
      id: 'chat-1',
      autoArchive: true,
    });
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Resumed after auto-archive',
    );
  });

  it('keeps an auto-archived chat archived while applying late turn metadata', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('send-before-auto-archive', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-auto-archive',
        text: 'Change a file',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'enable-auto-archive-before-metadata',
      data: { type: 'canopy_set_auto_archive_requested', enabled: true },
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-auto-archive',
      mutationId: 'complete-before-auto-archive',
      data: { type: 'result', is_error: false, result: 'Completed' },
    });
    await target.command(
      envelope('auto-archive-before-metadata', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
        keepSession: true,
      }),
    );

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'user-auto-archive',
      mutationId: 'late-turn-diff-after-auto-archive',
      data: {
        type: 'turn_diff',
        userMessageId: 'user-auto-archive',
        files: [
          {
            path: 'src/example.ts',
            status: 'modified',
            insertions: 2,
            deletions: 1,
          },
        ],
        totalInsertions: 2,
        totalDeletions: 1,
        capturedAt: 1_786_104_000_000,
      },
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs).toEqual([]);
    expect(snapshot.archives).toEqual([
      expect.objectContaining({ chatId: 'chat-1' }),
    ]);
    const archivesFile = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    expect(archivesFile.archived[0]?.tab.turnDiffs).toEqual({
      'user-auto-archive': expect.objectContaining({
        totalInsertions: 2,
        totalDeletions: 1,
      }),
    });
  });

  it('commits semantic scope deletion before removing every chat-state sidecar', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-before-scope-delete', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );

    await target.deleteScope(SCOPE);

    expect(existsSync(paths.tabs)).toBe(false);
    expect(existsSync(paths.archives)).toBe(false);
    expect(existsSync(paths.journal)).toBe(false);
    // A reused scope id (recreated worktree or Work Entry) admits fresh.
    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 0,
      tabsFile: expect.objectContaining({ tabs: [] }),
      archives: [],
    });
    await expect(
      target.command(
        envelope('create-after-delete', {
          type: 'chat.create_tab',
          tabId: 'chat-again',
          title: 'Recreated chat',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied', revision: 1 });
  });

  it.each(['chat.activate_tab', 'chat.reorder_tabs'] as const)(
    'reports %s as already_applied when only its mutation id survived receipt eviction',
    async (type) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      await repository.transact(
        SCOPE,
        [{ type: 'tab.active_changed', activeTabId: 'chat-1' }],
        { source: 'renderer-command', mutationId: `replayed-${type}` },
      );
      const command: ChatCommand =
        type === 'chat.activate_tab'
          ? { type, tabId: 'chat-1' }
          : { type, tabIds: ['chat-1'] };
      await expect(
        target.command(envelope(`replayed-${type}`, command)),
      ).resolves.toMatchObject({ outcome: 'already_applied', revision: 2 });
    },
  );

  it('reconciles only the runtimes selected for the snapshot when a runtime appears mid-read', async () => {
    const { target, repository } = serviceWithRepository();
    Object.defineProperty(target, 'reconcileHostRuntime', { value: true });
    await createChat(target);
    const getState = repository.getState.bind(repository);
    jest
      .spyOn(repository, 'getState')
      .mockImplementationOnce(async (scope, selection) => {
        const stale = await getState(scope, selection);
        await repository.transact(
          SCOPE,
          [
            {
              type: 'tab.created',
              tab: {
                id: 'chat-late',
                title: 'Late chat',
                createdAt: '2026-09-05',
                messages: [
                  {
                    id: 'late-user',
                    role: 'user',
                    timestamp: 10,
                    blocks: [{ type: 'text', text: 'Late turn' }],
                  },
                ],
              },
            },
            {
              type: 'runtime.patched',
              chatId: 'chat-late',
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
          { source: 'provider', mutationId: 'late-runtime' },
        );
        return stale;
      });

    const snapshot = await target.getState(SCOPE);

    expect(snapshot.runtimeByChatId['chat-late']).toMatchObject({
      status: 'streaming',
    });
  });

  it('rejects commands that would resurrect a scope while it is being deleted', async () => {
    const target = service();
    await createChat(target);

    const deletion = target.deleteScope(SCOPE);
    const concurrentCreate = target.command(
      envelope('resurrect-during-delete', {
        type: 'chat.create_tab',
        tabId: 'replacement-chat',
        title: 'Replacement chat',
      }),
    );

    await expect(concurrentCreate).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'Chat scope is being deleted',
    });
    await expect(deletion).resolves.toBeUndefined();
    expect(existsSync(paths.tabs)).toBe(false);
  });

  it('allows provider commits while the lifecycle fence blocks new commands', async () => {
    const target = service();
    await createChat(target);
    let releaseLifecycle: (() => void) | undefined;
    const lifecycleBlocked = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });

    const lifecycle = target.runWithScopeDeletionLifecycle(
      SCOPE,
      async () => lifecycleBlocked,
    );
    await expect(
      target.command(
        envelope('resurrect-during-lifecycle', {
          type: 'chat.create_tab',
          tabId: 'replacement-chat',
          title: 'Replacement chat',
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'Chat scope is being deleted',
    });

    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'provider-during-lifecycle',
      data: {
        type: 'assistant',
        message: {
          id: 'assistant-during-lifecycle',
          role: 'assistant',
          content: [{ type: 'text', text: 'Committed during teardown' }],
        },
      },
    });

    releaseLifecycle?.();
    await lifecycle;
    const snapshot = await target.getState(SCOPE);
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Committed during teardown',
    );
  });

  it('closes scope admission and waits for an admitted send before deletion', async () => {
    const target = service();
    let releaseSend: (() => void) | undefined;
    let sendAdmitted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      sendAdmitted = resolve;
    });
    const send = target.runWithScopeActivity(SCOPE, async () => {
      sendAdmitted?.();
      await sendGate;
    });
    await admitted;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();

    expect(deletionStarted).toBe(false);
    await expect(
      target.runWithScopeActivity(SCOPE, async () => undefined),
    ).rejects.toMatchObject({
      message: 'Chat scope is being deleted',
      code: 'CHAT_SCOPE_DELETING',
    });

    releaseSend?.();
    await send;
    await deletion;
    expect(deletionStarted).toBe(true);
  });

  it('keeps an admitted forced queued message inside the deletion activity drain', async () => {
    const target = service();
    await createChat(target);
    let releaseForce: (() => void) | undefined;
    let notifyForceStarted: (() => void) | undefined;
    const forceGate = new Promise<void>((resolve) => {
      releaseForce = resolve;
    });
    const forceStarted = new Promise<void>((resolve) => {
      notifyForceStarted = resolve;
    });
    queueForce.mockImplementationOnce(async () => {
      notifyForceStarted?.();
      await forceGate;
      return 'applied';
    });

    const force = target.command(
      envelope('force-before-delete', {
        type: 'chat.force_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queued-1',
      }),
    );
    await forceStarted;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();
    const deletionStartedBeforeForceRelease = deletionStarted;

    releaseForce?.();
    await expect(force).resolves.toMatchObject({ outcome: 'applied' });
    await deletion;

    expect(deletionStartedBeforeForceRelease).toBe(false);
    expect(deletionStarted).toBe(true);
  });

  it('lets an admitted async context enter nested activity after deletion closes admission', async () => {
    const target = service();
    let releaseOuter: (() => void) | undefined;
    let outerAdmitted: (() => void) | undefined;
    let releaseNested: (() => void) | undefined;
    let nestedStarted = false;
    let nestedError: unknown;
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      outerAdmitted = resolve;
    });
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const outer = target.runWithScopeActivity(SCOPE, async () => {
      outerAdmitted?.();
      await outerGate;
      try {
        await target.runWithScopeActivity(SCOPE, async () => {
          nestedStarted = true;
          await nestedGate;
        });
      } catch (error) {
        nestedError = error;
      }
    });
    await admitted;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();
    await expect(
      target.runWithScopeActivity(SCOPE, async () => undefined),
    ).rejects.toThrow('Chat scope is being deleted');

    releaseOuter?.();
    await Promise.resolve();
    const nestedStartedBeforeRelease = nestedStarted;
    const deletionStartedBeforeNestedRelease = deletionStarted;
    releaseNested?.();
    await outer;
    await deletion;

    expect(nestedError).toBeUndefined();
    expect(nestedStartedBeforeRelease).toBe(true);
    expect(deletionStartedBeforeNestedRelease).toBe(false);
    expect(deletionStarted).toBe(true);
  });

  it('lets an admitted trusted send finish after deletion closes admission', async () => {
    const target = service();
    let releaseSend: (() => void) | undefined;
    let notifySendAdmitted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendAdmitted = new Promise<void>((resolve) => {
      notifySendAdmitted = resolve;
    });
    const send = target.runWithScopeActivity(SCOPE, async () => {
      notifySendAdmitted?.();
      await sendGate;
      await target.ensureChatForTrustedSend({
        ...SCOPE,
        chatId: 'admitted-trusted-chat',
        userMessageId: 'admitted-trusted-message',
        text: 'Finish the admitted trusted send',
      });
    });
    await sendAdmitted;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();

    releaseSend?.();
    await expect(send).resolves.toBeUndefined();
    await deletion;
    expect(deletionStarted).toBe(true);
  });

  it('lets an admitted revisioned send finish after deletion closes admission', async () => {
    const target = service();
    await createChat(target);
    let releaseSend: (() => void) | undefined;
    let notifySendAdmitted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendAdmitted = new Promise<void>((resolve) => {
      notifySendAdmitted = resolve;
    });
    const send = target.runWithScopeActivity(SCOPE, async () => {
      notifySendAdmitted?.();
      await sendGate;
      return target.command(
        envelope('admitted-revisioned-send', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'admitted-revisioned-message',
          text: 'Finish the admitted revisioned send',
        }),
      );
    });
    await sendAdmitted;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();

    releaseSend?.();
    await expect(send).resolves.toMatchObject({ outcome: 'applied' });
    await deletion;
    expect(deletionStarted).toBe(true);
  });

  it('admits a revisioned send before deletion can start its cleanup sweep', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    let releaseAuthorization: (() => void) | undefined;
    let authorizationStarted: (() => void) | undefined;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizing = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const dispatch = jest.fn(() => Promise.resolve());
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch,
      authorizeSend: async () => {
        authorizationStarted?.();
        await authorizationGate;
      },
      cleanupSession: async () => undefined,
    });
    await createChat(target);

    const send = target.command(
      envelope('revisioned-send-before-delete', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'revisioned-user-message',
        text: 'Keep this send inside the deletion drain',
      }),
    );
    await authorizing;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();

    expect(deletionStarted).toBe(false);
    releaseAuthorization?.();
    await expect(send).resolves.toMatchObject({ outcome: 'applied' });
    await deletion;
    expect(deletionStarted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('admits an async answer before deletion can start its cleanup sweep', async () => {
    let releaseAuthorization: (() => void) | undefined;
    let authorizationStarted: (() => void) | undefined;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizing = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const dispatch = jest.fn(() => Promise.resolve());
    const { target, repository } = serviceWithRepository({
      dispatch,
      authorizeSend: async () => {
        authorizationStarted?.();
        await authorizationGate;
      },
    });
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'pending_question.upserted',
          question: {
            requestId: 'async-question',
            chatId: 'chat-1',
            delivery: 'async',
            questions: [
              { id: '0', question: 'Which scope?', options: ['Full'] },
            ],
          },
        },
      ],
      { source: 'provider', mutationId: 'seed-async-question' },
    );

    const answer = target.command(
      envelope('async-answer-before-delete', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'async-question',
        answers: [
          {
            questionId: '0',
            question: 'Which scope?',
            selectedOptions: ['Full'],
          },
        ],
      }),
    );
    await authorizing;

    let deletionStarted = false;
    const deletion = target.runWithScopeDeletionLifecycle(SCOPE, async () => {
      deletionStarted = true;
    });
    await Promise.resolve();
    const deletionStartedBeforeAnswerFinished = deletionStarted;

    releaseAuthorization?.();
    await expect(answer).resolves.toMatchObject({ outcome: 'applied' });
    await deletion;
    expect(deletionStartedBeforeAnswerFinished).toBe(false);
    expect(deletionStarted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a trusted send that would resurrect a scope while it is being deleted', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const deleteEmptyScope = repository.deleteEmptyScope.bind(repository);
    let releaseDeletion: (() => void) | undefined;
    let deletionReachedSidecarRemoval: (() => void) | undefined;
    const sidecarRemovalReached = new Promise<void>((resolve) => {
      deletionReachedSidecarRemoval = resolve;
    });
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    jest
      .spyOn(repository, 'deleteEmptyScope')
      .mockImplementation(async (scope) => {
        deletionReachedSidecarRemoval?.();
        await deletionGate;
        await deleteEmptyScope(scope);
      });

    const deletion = target.deleteScope(SCOPE);
    await sidecarRemovalReached;

    await expect(
      target.ensureChatForTrustedSend({
        ...SCOPE,
        chatId: 'replacement-chat',
        userMessageId: 'replacement-message',
        text: 'Do not recreate the deleting scope',
      }),
    ).rejects.toThrow('Chat scope is being deleted');

    releaseDeletion?.();
    await expect(deletion).resolves.toBeUndefined();
    expect(existsSync(paths.tabs)).toBe(false);
  });

  it('rejects compatibility writes that would resurrect a scope while it is being deleted', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const staleTabs = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    const deleteEmptyScope = repository.deleteEmptyScope.bind(repository);
    let releaseDeletion: (() => void) | undefined;
    let deletionReachedSidecarRemoval: (() => void) | undefined;
    const sidecarRemovalReached = new Promise<void>((resolve) => {
      deletionReachedSidecarRemoval = resolve;
    });
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    jest
      .spyOn(repository, 'deleteEmptyScope')
      .mockImplementation(async (scope) => {
        deletionReachedSidecarRemoval?.();
        await deletionGate;
        await deleteEmptyScope(scope);
      });

    const deletion = target.deleteScope(SCOPE);
    await sidecarRemovalReached;

    await expect(
      target.replaceCompatibilityTabs(
        SCOPE,
        {
          ...staleTabs,
          tabs: [
            ...staleTabs.tabs,
            {
              ...staleTabs.tabs[0],
              id: 'replacement-chat',
              title: 'Replacement chat',
            },
          ],
        },
        { authoritative: true },
      ),
    ).rejects.toThrow('Chat scope is being deleted');

    releaseDeletion?.();
    await expect(deletion).resolves.toBeUndefined();
    expect(existsSync(paths.tabs)).toBe(false);
    expect(existsSync(paths.archives)).toBe(false);
    expect(existsSync(paths.journal)).toBe(false);
  });

  it('keeps an archive committed and retries provider cleanup asynchronously', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    const cleanupSession = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('provider still busy'))
      .mockResolvedValue(undefined);
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: async () => undefined,
      cleanupSession,
      schedule: (callback) => setTimeout(callback, 0),
    });
    await createChat(target);

    await expect(
      target.command(
        envelope('archive-cleanup-retry', {
          type: 'chat.archive_tab',
          tabId: 'chat-1',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied', revision: 2 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(cleanupSession).toHaveBeenCalledTimes(2);
    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 2,
      tabsFile: { tabs: [] },
      archives: [expect.objectContaining({ chatId: 'chat-1' })],
    });
  });

  it('imports a transcript into a new canonical chat in one revision', async () => {
    const target = service();
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Imported question' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'assistant-imported',
          role: 'assistant',
          content: [{ type: 'text', text: 'Imported answer' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'Imported answer',
      }),
    ].join('\n');

    await expect(
      target.command(
        envelope('import-1', {
          type: 'chat.import_session',
          targetChatId: 'imported-chat',
          source: { kind: 'transcript', providerType: 'claude', content },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      revision: 1,
      entityId: 'imported-chat',
    });

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.tabs).toHaveLength(1);
    expect(snapshot.tabsFile.tabs[0]).toMatchObject({
      id: 'imported-chat',
      providerType: 'claude',
    });
    expect(JSON.stringify(snapshot.tabsFile.tabs[0]?.messages)).toContain(
      'Imported answer',
    );
    expect(snapshot.runtimeByChatId['imported-chat']?.status).toBe('completed');

    await expect(
      target.command(
        envelope('import-retry', {
          type: 'chat.import_session',
          targetChatId: 'imported-chat',
          source: { kind: 'transcript', providerType: 'claude', content },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'already_applied',
      entityId: 'imported-chat',
    });
  });

  it('hydrates only selected transcripts while applying a compatibility update', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    const original: PersistedChatMessage = {
      id: 'original',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Original turn' }],
    };
    const marker: PersistedChatMessage = {
      id: 'marker',
      role: 'system',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Reverted turn' }],
    };
    const history = [
      original,
      ...Array.from(
        { length: 600 },
        (_, index): PersistedChatMessage => ({
          id: `history-${index}`,
          role: 'assistant',
          timestamp: index + 2,
          blocks: [{ type: 'text', text: `Historical response ${index}` }],
        }),
      ),
    ];
    await repository.transact(
      SCOPE,
      history.map((message) => ({
        type: 'message.upserted' as const,
        chatId: 'chat-1',
        message,
      })),
      { source: 'provider' },
    );
    await target.command(
      envelope('create-unrelated', {
        type: 'chat.create_tab',
        tabId: 'unrelated',
      }),
    );
    const transactions = jest.spyOn(repository, 'transactWith');
    await target.updateCompatibilityTabs(
      SCOPE,
      (current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === 'chat-1'
            ? { ...tab, messages: [...tab.messages, marker] }
            : tab,
        ),
      }),
      'revert-marker',
      ['chat-1'],
    );
    expect(
      transactions.mock.calls[transactions.mock.calls.length - 1]?.[2],
    ).toMatchObject({
      chatIds: ['chat-1'],
    });
    const saved = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    expect(saved.tabs.find((tab) => tab.id === 'chat-1')?.messages).toEqual([
      ...history,
      marker,
    ]);
  });

  it('atomically removes selected pending questions while retaining concurrent question records', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await repository.transact(
      SCOPE,
      ['reverted-question', 'later-question'].map((requestId) => ({
        type: 'pending_question.upserted' as const,
        question: {
          requestId,
          chatId: 'chat-1',
          delivery: 'async' as const,
          questions: [{ question: 'Scope?', options: ['Full'] }],
        },
      })),
      { source: 'provider', mutationId: 'questions-before-revert' },
    );
    const result = await target.updateCompatibilityTabs(SCOPE, (current) => ({
      ...current,
      pendingQuestions: current.pendingQuestions?.filter(
        (question) => question.requestId !== 'reverted-question',
      ),
    }));
    expect(
      result.pendingQuestions?.map((question) => question.requestId),
    ).toEqual(['later-question']);
  });

  it('persists async questions once without blocking or reopening answered questions on replay', async () => {
    const target = service();
    await target.command(
      envelope('create-async', {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        providerType: 'codex',
      }),
    );
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: { type: 'thread.started', thread_id: 'thread' },
      },
    });
    const event = {
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread',
        turn_id: 'turn',
        item: {
          id: 'async-question',
          type: 'agent_message',
          text: 'Which scope?\n- Full',
          delivery: 'async',
          phase: 'final_answer',
          questions: [{ title: 'Which scope?', options: ['Full'] }],
        },
      },
    };
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: event,
      mutationId: 'async-1',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread',
          turn_id: 'turn',
        },
      },
      mutationId: 'async-completed',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: event,
      mutationId: 'async-replay',
    });
    let snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.pendingQuestions).toHaveLength(1);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('completed');
    expect(snapshot.runtimeByChatId['chat-1']?.status).not.toBe(
      'awaiting_input',
    );
    const question = snapshot.tabsFile.pendingQuestions?.[0];
    if (!question) throw new Error('Missing async question');
    expect(question).toMatchObject({
      delivery: 'async',
      questions: [{ question: 'Which scope?', options: ['Full'] }],
    });
    const command = {
      type: 'chat.answer_question',
      chatId: 'chat-1',
      questionId: question.requestId,
      answers: [{ question: 'Which scope?', selectedOptions: ['Full'] }],
    } as const;
    await expect(
      target.command(
        envelope('async-answer', {
          ...command,
          answers: [...command.answers].map((a) => ({
            ...a,
            selectedOptions: [...a.selectedOptions],
          })),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: event,
      mutationId: 'async-after-answer',
    });
    snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.pendingQuestions?.[0]?.answeredAt).toBeDefined();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toContain('Q: Which scope?');
    expect(
      snapshot.tabsFile.tabs[0]?.messages.filter(
        (message) => message.role === 'user',
      ),
    ).toHaveLength(1);
  });

  it.each([true, false])(
    'routes async answers using live turn liveness (%s) and deduplicates concurrent submissions',
    async (active) => {
      const steer = jest.fn(async () => active);
      const { target, repository } = serviceWithRepository({ steer });
      await createChat(target);
      await repository.transact(
        SCOPE,
        [
          {
            type: 'pending_question.upserted',
            question: {
              requestId: 'async-route',
              chatId: 'chat-1',
              delivery: 'async',
              questions: [
                { id: '0', question: 'Which scope?', options: ['Full'] },
              ],
            },
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: active ? 'streaming' : 'completed',
              queuedMessageIds: [],
              activeTurn: { userMessageId: 'original-user', startedAt: 10 },
              lastActivityAt: 10,
            },
          },
        ],
        { source: 'provider', mutationId: 'seed-async-route' },
      );
      const before = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
      const command: ChatCommand = {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'async-route',
        answers: [
          {
            questionId: '0',
            question: 'Which scope?',
            selectedOptions: ['Full'],
          },
        ],
      };
      const results = await Promise.all([
        target.command(envelope('answer-a', command)),
        target.command(envelope('answer-b', command)),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'already_applied',
        'applied',
      ]);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveLength(active ? 0 : 1);
      const after = await target.getState(SCOPE);
      expect(
        after.tabsFile.tabs[0]?.messages.filter(
          (message) => message.role === 'user',
        ),
      ).toHaveLength(1);
      expect(after.runtimeByChatId['chat-1']).toEqual(before);
      const answerMessage = after.tabsFile.tabs[0]?.messages.find(
        (message) => message.role === 'user',
      );
      expect(answerMessage?.blocks[0]).toMatchObject({
        type: 'text',
        asyncQuestionAnswer: {
          requestId: 'async-route',
          startsTurn: false,
          answers: [{ question: 'Which scope?', selectedOptions: ['Full'] }],
        },
      });
      if (!active && answerMessage) {
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: 'chat-1',
          data: {
            type: 'canopy_user_prompt',
            provider: 'codex',
            original_text: dispatched[0]?.text,
            canopy_turn_user_message_id: answerMessage.id,
            canopy_persisted_messages: [
              {
                ...answerMessage,
                blocks: [{ type: 'text', text: dispatched[0]?.text }],
              },
            ],
          },
          turnUserMessageId: answerMessage.id,
        });
        const started = await target.getState(SCOPE);
        expect(
          started.tabsFile.tabs[0]?.messages.find(
            (message) => message.id === answerMessage.id,
          )?.blocks[0],
        ).toMatchObject({ asyncQuestionAnswer: { startsTurn: true } });
        expect(
          started.tabsFile.tabs[0]?.messages
            .flatMap((message) => message.blocks)
            .filter((block) => block.type === 'turn_timer'),
        ).toHaveLength(1);
      }
    },
  );

  it('keeps an async question retryable after transport failure without queuing or settling its active turn', async () => {
    const steer = jest.fn(async () => {
      throw new Error('Connection lost');
    });
    const { target, repository } = serviceWithRepository({
      steer,
    });
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'pending_question.upserted',
          question: {
            requestId: 'async-error',
            chatId: 'chat-1',
            delivery: 'async',
            questions: [
              { id: '0', question: 'Which scope?', options: ['Full'] },
            ],
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'original-user', startedAt: 10 },
            lastActivityAt: 10,
          },
        },
      ],
      { source: 'provider', mutationId: 'seed-async-error' },
    );
    const before = (await target.getState(SCOPE)).runtimeByChatId['chat-1'];
    await expect(
      target.command(
        envelope('answer-failed', {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'async-error',
          answers: [
            {
              questionId: '0',
              question: 'Which scope?',
              selectedOptions: ['Full'],
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'rejected' });
    await expect(
      target.command(
        envelope('answer-retried', {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'async-error',
          answers: [
            {
              questionId: '0',
              question: 'Which scope?',
              selectedOptions: ['Full'],
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'rejected' });
    const after = await target.getState(SCOPE);
    expect(after.runtimeByChatId['chat-1']).toEqual(before);
    expect(after.tabsFile.pendingQuestions?.[0]?.answeredAt).toBeUndefined();
    expect(after.tabsFile.tabs[0]?.messages).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer.mock.calls[0]?.[0].clientUserMessageId).toBe(
      'answer-async-error',
    );
    expect(steer.mock.calls[0]?.[0].clientUserMessageId).toBe(
      steer.mock.calls[1]?.[0].clientUserMessageId,
    );
    expect(steer.mock.calls[0]?.[0].userMessageId).not.toBe(
      steer.mock.calls[1]?.[0].userMessageId,
    );
  });

  it.each(['cancel', 'edit'] as const)(
    'restores a queued async question when its answer is %s',
    async (mutationType) => {
      const { target, repository } = serviceWithRepository();
      await createChat(target);
      await repository.transact(
        SCOPE,
        [
          {
            type: 'pending_question.upserted',
            question: {
              requestId: 'async-queued',
              chatId: 'chat-1',
              delivery: 'async',
              questions: [
                { id: '0', question: 'Which scope?', options: ['Full'] },
              ],
            },
          },
        ],
        { source: 'provider', mutationId: 'seed-async-queued' },
      );

      await expect(
        target.command(
          envelope('answer-queued', {
            type: 'chat.answer_question',
            chatId: 'chat-1',
            questionId: 'async-queued',
            answers: [
              {
                questionId: '0',
                question: 'Which scope?',
                selectedOptions: ['Full'],
              },
            ],
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      const queuedRequest = dispatched[0];
      expect(queuedRequest).toMatchObject({
        asyncQuestionId: 'async-queued',
      });
      if (!queuedRequest) throw new Error('Missing queued async answer');
      const { asyncQuestionId, ...editedRequest } = queuedRequest;
      await target.reconcileHostQueue(
        { ...SCOPE, chatId: 'chat-1' },
        mutationType === 'edit' ? ['answer-answer-queued'] : [],
        true,
        mutationType === 'edit'
          ? {
              type: 'edit',
              request: { ...editedRequest, text: 'Edited queued answer' },
              restoredAsyncQuestionId: asyncQuestionId,
            }
          : { type: 'cancel', request: queuedRequest },
      );

      const snapshot = await target.getState(SCOPE);
      const question = snapshot.tabsFile.pendingQuestions?.[0];
      expect(question?.answeredAt).toBeUndefined();
      expect(question?.answers).toBeUndefined();
      const userMessages = snapshot.tabsFile.tabs[0]?.messages.filter(
        (message) => message.role === 'user',
      );
      if (mutationType === 'cancel') expect(userMessages).toEqual([]);
      else
        expect(userMessages?.[0]).toMatchObject({
          blocks: [{ type: 'text', text: 'Edited queued answer' }],
        });
    },
  );

  it('removes an async pending question when reset truncates its message', async () => {
    const { target, repository } = serviceWithRepository();
    await createChat(target);
    await repository.transact(
      SCOPE,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'reset-anchor',
            role: 'user',
            timestamp: 10,
            blocks: [{ type: 'text', text: 'Start here' }],
          },
        },
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'async-question-message',
            role: 'assistant',
            timestamp: 20,
            blocks: [
              {
                type: 'text',
                text: 'Which scope?',
                asyncQuestion: {
                  requestId: 'async-reset',
                  questions: [{ title: 'Which scope?', options: ['Full'] }],
                },
              },
            ],
          },
        },
        {
          type: 'pending_question.upserted',
          question: {
            requestId: 'async-reset',
            chatId: 'chat-1',
            delivery: 'async',
            questions: [
              { id: '0', question: 'Which scope?', options: ['Full'] },
            ],
          },
        },
      ],
      { source: 'provider', mutationId: 'seed-reset-question' },
    );

    await expect(
      target.command(
        envelope('reset-before-question', {
          type: 'chat.reset_to_point',
          chatId: 'chat-1',
          userMessageId: 'reset-anchor',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const state = await target.getState(SCOPE);
    expect(state.tabsFile.tabs[0]?.messages.map(({ id }) => id)).toEqual([
      'reset-anchor',
    ]);
    expect(state.tabsFile.pendingQuestions).toEqual([]);
  });

  it('retains async dismissals on replay and never exposes a child-thread question as a root form', async () => {
    const target = service();
    await createChat(target);
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: { type: 'thread.started', thread_id: 'root' },
      },
    });
    const item = {
      id: 'async-dismiss',
      type: 'agent_message',
      text: 'Explain the issue?',
      delivery: 'async',
      questions: [{ title: 'Explain the issue?', options: null }],
    };
    const rootEvent = {
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'root',
        turn_id: 'turn',
        item,
      },
    };
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: rootEvent,
      mutationId: 'question-root',
    });
    const pending = (await target.getState(SCOPE)).tabsFile
      .pendingQuestions?.[0];
    if (!pending) throw new Error('Missing question');
    await expect(
      target.command(
        envelope('dismiss-async', {
          type: 'chat.dismiss_question',
          chatId: 'chat-1',
          questionId: pending.requestId,
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: rootEvent,
      mutationId: 'question-replay',
    });
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          ...rootEvent.event,
          thread_id: 'child',
          item: { ...item, id: 'child-question' },
        },
      },
      mutationId: 'question-child',
    });
    const after = await target.getState(SCOPE);
    expect(after.tabsFile.pendingQuestions).toHaveLength(1);
    expect(after.tabsFile.pendingQuestions?.[0]?.dismissedAt).toBeDefined();
    expect(after.tabsFile.pendingQuestions?.[0]?.answeredAt).toBeDefined();
    expect(dispatched).toHaveLength(0);
  });

  it('rejects invalid interactive answers without consuming the request, then accepts a corrected answer', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'form-1',
      chatId: 'chat-1',
      questions: [
        {
          question: 'Quantity',
          options: [],
          control: 'number',
          required: true,
        },
      ],
    });
    const invalid = await target.command(
      envelope('invalid-form', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'form-1',
        answers: [
          {
            question: 'Quantity',
            selectedOptions: [],
            freeformText: 'not a number',
          },
        ],
      }),
    );
    expect(invalid.outcome).toBe('rejected');
    expect(
      (await target.getState(SCOPE)).tabsFile.pendingQuestions?.[0]?.answeredAt,
    ).toBeUndefined();
    const valid = await target.command(
      envelope('valid-form', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'form-1',
        answers: [
          { question: 'Quantity', selectedOptions: [], freeformText: '3.5' },
        ],
      }),
    );
    expect(valid.outcome).toBe('applied');
    expect(
      (await target.getState(SCOPE)).tabsFile.pendingQuestions?.[0]
        ?.answers?.[0]?.freeformText,
    ).toBe('3.5');
  });

  it('commits pending questions and applies an answer exactly once', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Pick', options: ['A'] }],
    });

    const first = await target.command(
      envelope('answer-1', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['A'] }],
      }),
    );
    const duplicate = await target.command(
      envelope('answer-2', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['A'] }],
      }),
    );

    expect(first).toMatchObject({ outcome: 'applied', revision: 3 });
    expect(duplicate).toMatchObject({
      outcome: 'already_applied',
      revision: 3,
    });
    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['A'] }],
      }),
    ]);
  });

  it('serializes concurrent answer and dismiss commands so only one wins', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-race',
      chatId: 'chat-1',
      questions: [{ question: 'Pick', options: ['A'] }],
    });

    const results = await Promise.all([
      target.command(
        envelope('answer-race', {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'question-race',
          answers: [{ question: 'Pick', selectedOptions: ['A'] }],
        }),
      ),
      target.command(
        envelope('dismiss-race', {
          type: 'chat.dismiss_question',
          chatId: 'chat-1',
          questionId: 'question-race',
        }),
      ),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      'already_applied',
      'applied',
    ]);
  });

  it('preserves concurrent tab commits during archive-only replacement', async () => {
    const target = service();
    await createChat(target);
    const repository = repositories[repositories.length - 1];
    if (!repository) throw new Error('Expected chat-state repository');
    const originalGetState = repository.getState.bind(repository);
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jest.spyOn(repository, 'getState').mockImplementationOnce(async (scope) => {
      const snapshot = await originalGetState(scope);
      await readGate;
      return snapshot;
    });

    const archiveWrite = target.replaceCompatibilityArchives(SCOPE, {
      version: 1,
      archived: [],
    });
    await target.command(
      envelope('concurrent-model', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'gpt-6-sol',
        providerType: 'codex',
      }),
    );
    releaseRead?.();
    await archiveWrite;

    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      model: 'gpt-6-sol',
      providerType: 'codex',
    });
  });

  it('does not delete an archive added after a compatibility snapshot was read', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-stale-first', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    const stale = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.updateChatDescription(
      SCOPE,
      'chat-1',
      'Updated after the stale read',
    );

    await target.command(
      envelope('create-stale-second', {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        title: 'Newer archive',
      }),
    );
    await target.command(
      envelope('archive-stale-second', {
        type: 'chat.archive_tab',
        tabId: 'chat-2',
      }),
    );

    await target.replaceCompatibilityArchives(SCOPE, stale);

    const current = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    expect(current.archived.map((entry) => entry.tab.id)).toEqual([
      'chat-2',
      'chat-1',
    ]);
    expect(current.archived[1]?.tab.description).toBe(
      'Updated after the stale read',
    );
  });

  it('preserves supplied newest-first order when importing new archives', async () => {
    const target = service();

    await target.replaceCompatibilityArchives(SCOPE, {
      version: 1,
      archived: [
        {
          tab: {
            id: 'archive-newest',
            title: 'Newest',
            createdAt: '2026-08-11T02:00:00.000Z',
            messages: [],
          },
          archivedAt: '2026-08-11T03:00:00.000Z',
          turnCount: 0,
        },
        {
          tab: {
            id: 'archive-older',
            title: 'Older',
            createdAt: '2026-08-11T00:00:00.000Z',
            messages: [],
          },
          archivedAt: '2026-08-11T01:00:00.000Z',
          turnCount: 0,
        },
      ],
    });

    expect(
      (
        await target.getCompatibilityArchives(SCOPE, {
          chatIds: ['chat-1'],
          fullTranscript: true,
        })
      ).archived.map(({ tab }) => tab.id),
    ).toEqual(['archive-newest', 'archive-older']);
  });

  it('does not restore an archive removed after a compatibility snapshot was read', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-before-stale-removal', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    const stale = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });

    await target.removeCompatibilityArchive(SCOPE, 'chat-1');
    await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);
    const recovered = service();
    await recovered.replaceCompatibilityArchives(SCOPE, stale);

    await expect(
      recovered.getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      }),
    ).resolves.toMatchObject({ archived: [] });
  });

  it('authoritatively restores a tombstoned archive during rollback', async () => {
    const target = service();
    await createChat(target);
    await target.command(
      envelope('archive-before-authoritative-restore', {
        type: 'chat.archive_tab',
        tabId: 'chat-1',
      }),
    );
    const rollbackSnapshot = await target.getCompatibilityArchives(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.removeCompatibilityArchive(SCOPE, 'chat-1');

    await target.replaceCompatibilityArchives(SCOPE, rollbackSnapshot, {
      authoritative: true,
    });

    await expect(
      target.getCompatibilityArchives(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      }),
    ).resolves.toMatchObject({
      archived: [
        expect.objectContaining({
          tab: expect.objectContaining({ id: 'chat-1' }),
        }),
      ],
    });
  });

  it.each(['claude', 'cursor'] as const)(
    'clears incompatible billing in the canonical Cursor model commit from %s',
    async (providerType) => {
      const target = service();
      await createChat(target);
      const tabs = await target.getCompatibilityTabs(SCOPE);
      await target.replaceCompatibilityTabs(SCOPE, {
        ...tabs,
        tabs: tabs.tabs.map((tab) => ({
          ...tab,
          providerType,
          model:
            providerType === 'cursor' ? 'cursor-default' : 'claude-sonnet-4-6',
          aiCreditsRouting: {
            active: true,
            scope: 'persistent',
            activatedAt: Date.now(),
          },
          subscriptionBillingOverride: true,
          billingExplicitlyChosen: true,
        })),
      });
      await expect(
        target.command(
          envelope('cursor-billing', {
            type: 'chat.set_model',
            tabId: 'chat-1',
            model: 'cursor-default',
            providerType: 'cursor',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const switched = (await target.getState(SCOPE)).tabsFile.tabs[0];
      expect(switched).toMatchObject({
        model: 'cursor-default',
        providerType: 'cursor',
      });
      for (const key of [
        'aiCreditsRouting',
        'subscriptionBillingOverride',
        'billingExplicitlyChosen',
      ])
        expect(switched).not.toHaveProperty(key);
      await target.flushScope(SCOPE.projectId, SCOPE.worktreeId);
      const reloaded = (await service().getState(SCOPE)).tabsFile.tabs[0];
      expect(reloaded).toEqual(switched);
    },
  );

  it('switches model/provider atomically and clears foreign session state', async () => {
    const target = service();
    await createChat(target);
    const tabs = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...tabs,
      tabs: tabs.tabs.map((candidate) =>
        candidate.id === 'chat-1'
          ? {
              ...candidate,
              thinkingLevel: 'low',
              modelConfig: { thinkingLevel: 'low', fastMode: false },
              codexFastModeEnabled: false,
              interfaceMode: 'claude-code',
              executionHarness: 'claude',
              sdkSessionId: 'claude-session',
              globalInstructionsSnapshot: 'claude-only instructions',
              claudeForkSessionOnNextSend: true,
              codexReconstructionSeedId: 'stale-codex-seed',
              claudeTerminal: { turnState: 'idle' },
            }
          : candidate,
      ),
    });

    await expect(
      target.command(
        envelope('switch-provider', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt-6-sol',
          providerType: 'codex',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const switched = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(switched).toMatchObject({
      model: 'gpt-6-sol',
      providerType: 'codex',
      modelExplicitlyChosen: true,
    });
    expect(switched).not.toHaveProperty('thinkingLevel');
    expect(switched).not.toHaveProperty('modelConfig');
    expect(switched).not.toHaveProperty('codexFastModeEnabled');
    expect(switched).not.toHaveProperty('interfaceMode');
    expect(switched).not.toHaveProperty('executionHarness');
    expect(switched).not.toHaveProperty('sdkSessionId');
    expect(switched).not.toHaveProperty('globalInstructionsSnapshot');
    expect(switched).not.toHaveProperty('claudeForkSessionOnNextSend');
    expect(switched).not.toHaveProperty('codexReconstructionSeedId');
    expect(switched).not.toHaveProperty('claudeTerminal');
  });

  it('records the model Auto picked for each routed turn', async () => {
    const target = service();
    await createChat(target);
    const tabs = await target.getCompatibilityTabs(SCOPE);
    await target.replaceCompatibilityTabs(SCOPE, {
      ...tabs,
      tabs: tabs.tabs.map((tab) => ({
        ...tab,
        model: 'opus',
        providerType: 'claude' as const,
        modelSelectionMode: 'auto' as const,
        messages: [
          {
            id: 'user-routed',
            role: 'user' as const,
            timestamp: 2,
            blocks: [{ type: 'text' as const, text: 'Route me' }],
          },
        ],
      })),
    });
    const result = await target.command(
      envelope('auto-route-turn', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'sonnet',
        providerType: 'claude',
        preserveModelSelectionMode: true,
        autoRoutedMessageId: 'user-routed',
      }),
    );
    expect(result).toMatchObject({ outcome: 'applied' });
    const [tab] = (await target.getState(SCOPE)).tabsFile.tabs;
    expect(tab?.model).toBe('sonnet');
    expect(tab?.modelSelectionMode).toBe('auto');
    expect(tab?.autoRoutedModels).toEqual({ 'user-routed': 'sonnet' });
    // A later routed turn adds to the history instead of replacing it.
    await target.command(
      envelope('auto-route-next-turn', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'opus',
        providerType: 'claude',
        preserveModelSelectionMode: true,
        autoRoutedMessageId: 'user-next',
      }),
    );
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.autoRoutedModels,
    ).toEqual({ 'user-routed': 'sonnet', 'user-next': 'opus' });
  });

  it('persists a per-chat Ollama harness without changing its default', async () => {
    initOllamaModels([
      {
        id: 'ollama-local-model',
        rawModelId: 'local-model',
        label: 'Local model',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    const target = service();
    await createChat(target);
    const result = await target.command(
      envelope('choose-chat-harness', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'ollama-local-model',
        providerType: 'ollama',
        ...{ executionHarness: 'claude' as const },
      }),
    );
    expect(result).toMatchObject({ outcome: 'applied' });
    expect((await target.getState(SCOPE)).tabsFile.tabs[0]).toMatchObject({
      model: 'ollama-local-model',
      providerType: 'ollama',
      executionHarness: 'claude',
    });
  });

  it('rejects changing the harness after a chat has started', async () => {
    initOllamaModels([
      {
        id: 'ollama-local-model',
        rawModelId: 'local-model',
        label: 'Local model',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    const target = service();
    await createChat(target);
    const tabs = await target.getCompatibilityTabs(SCOPE);
    await target.replaceCompatibilityTabs(SCOPE, {
      ...tabs,
      tabs: tabs.tabs.map((tab) => ({
        ...tab,
        model: 'ollama-local-model',
        providerType: 'ollama' as const,
        executionHarness: 'codex' as const,
        messages: [
          {
            id: 'user-start',
            role: 'user' as const,
            timestamp: 1,
            blocks: [{ type: 'text' as const, text: 'Hello' }],
          },
        ],
      })),
    });
    const result = await target.command(
      envelope('started-chat-harness', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'ollama-local-model',
        providerType: 'ollama',
        ...{ executionHarness: 'claude' as const },
      }),
    );
    expect(result.outcome).toBe('rejected');
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs[0]?.executionHarness,
    ).toBe('codex');
  });

  it('rejects a per-chat harness that the selected native model cannot run on', async () => {
    const target = service();
    await createChat(target);
    const result = await target.command(
      envelope('invalid-chat-harness', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'gpt-6-sol',
        providerType: 'codex',
        ...{ executionHarness: 'claude' as const },
      }),
    );
    expect(result.outcome).toBe('rejected');
  });

  it('clears foreign continuation state when an empty tab changes harness', async () => {
    initOllamaModels([
      {
        id: 'ollama-local-model',
        rawModelId: 'local-model',
        label: 'Local model',
      },
    ]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-local-model',
          source: 'ollama',
          harness: 'codex',
          defaultHarness: 'claude',
          configurable: true,
          overridden: true,
        },
      ],
    });
    const target = service();
    await createChat(target);
    const tabs = await target.getCompatibilityTabs(SCOPE);
    await target.replaceCompatibilityTabs(SCOPE, {
      ...tabs,
      tabs: tabs.tabs.map((candidate) =>
        candidate.id === 'chat-1'
          ? {
              ...candidate,
              model: 'ollama-local-model',
              providerType: 'ollama',
              executionHarness: 'claude',
              sdkSessionId: 'claude-session',
              globalInstructionsSnapshot: 'claude instructions',
              codexReconstructionSeedId: 'claude-seed',
              claudeForkSessionOnNextSend: true,
              claudeTerminal: { turnState: 'idle' },
            }
          : candidate,
      ),
    });

    await expect(
      target.command(
        envelope('switch-harness', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'ollama-local-model',
          providerType: 'ollama',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const switched = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(switched).toMatchObject({
      model: 'ollama-local-model',
      providerType: 'ollama',
    });
    expect(switched).not.toHaveProperty('executionHarness');
    expect(switched).not.toHaveProperty('sdkSessionId');
    expect(switched).not.toHaveProperty('globalInstructionsSnapshot');
    expect(switched).not.toHaveProperty('claudeForkSessionOnNextSend');
    expect(switched).not.toHaveProperty('codexReconstructionSeedId');
    expect(switched).not.toHaveProperty('claudeTerminal');
  });

  it('persists an automatic model-change notice atomically with the model', async () => {
    const target = service();
    await createChat(target);

    await expect(
      target.command(
        envelope('automatic-model-fallback', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt-6-sol',
          providerType: 'codex',
          notice: {
            id: 'model-policy-notice',
            timestamp: 42,
            text: 'The blocked model was replaced.',
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const switched = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(switched).toMatchObject({
      model: 'gpt-6-sol',
      providerType: 'codex',
    });
    expect(switched?.messages).toContainEqual({
      id: 'model-policy-notice',
      role: 'system',
      timestamp: 42,
      blocks: [{ type: 'text', text: 'The blocked model was replaced.' }],
    });
  });

  it('clears terminal continuation state atomically on a native model change', async () => {
    const target = service();
    await createChat(target);
    const tabs = await target.getCompatibilityTabs(SCOPE);
    await target.replaceCompatibilityTabs(SCOPE, {
      ...tabs,
      tabs: tabs.tabs.map((tab) => ({
        ...tab,
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        interfaceMode: 'auto',
        sdkSessionId: 'terminal-session',
        globalInstructionsSnapshot: 'terminal instructions',
        codexReconstructionSeedId: 'seed',
        claudeForkSessionOnNextSend: true,
        claudeTerminal: { turnState: 'idle' },
      })),
    });

    await target.command(
      envelope('terminal-to-native', {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        settings: {
          thinkingLevel: 'high',
          modelConfig: { thinkingLevel: 'high', fastMode: false },
          codexFastModeEnabled: false,
          interfaceMode: 'canopy',
        },
      }),
    );

    const switched = (await target.getState(SCOPE)).tabsFile.tabs[0];
    expect(switched).toMatchObject({
      model: 'claude-sonnet-4-6',
      interfaceMode: 'canopy',
      thinkingLevel: 'high',
    });
    expect(switched).not.toHaveProperty('sdkSessionId');
    expect(switched).not.toHaveProperty('globalInstructionsSnapshot');
    expect(switched).not.toHaveProperty('codexReconstructionSeedId');
    expect(switched).not.toHaveProperty('claudeForkSessionOnNextSend');
    expect(switched).not.toHaveProperty('claudeTerminal');
  });

  describe('Codex speed', () => {
    async function seedChat(
      target: ChatStateService,
      overrides: Partial<PersistedChatTab>,
    ): Promise<void> {
      await createChat(target);
      const tabs = await target.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      await target.replaceCompatibilityTabs(SCOPE, {
        ...tabs,
        tabs: tabs.tabs.map((candidate) =>
          candidate.id === 'chat-1'
            ? { ...candidate, ...overrides }
            : candidate,
        ),
      });
    }

    async function chatTab(
      target: ChatStateService,
      id = 'chat-1',
    ): Promise<PersistedChatTab | undefined> {
      return (await target.getState(SCOPE)).tabsFile.tabs.find(
        (candidate) => candidate.id === id,
      );
    }

    it('retains the requested speed across a Codex to Claude to Codex round trip', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'codex',
        model: 'gpt-6-sol',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      });

      await expect(
        target.command(
          envelope('codex-to-claude', {
            type: 'chat.set_model',
            tabId: 'chat-1',
            model: 'claude-sonnet-4-6',
            providerType: 'claude',
            settings: {
              thinkingLevel: 'high',
              modelConfig: {
                thinkingLevel: 'high',
                speed: 'standard',
                fastMode: false,
              },
              codexFastModeEnabled: false,
              interfaceMode: null,
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      // Retained in the same durable command as the provider change; Claude
      // itself resolves Regular.
      expect(await chatTab(target)).toMatchObject({
        providerType: 'claude',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        retainedCodexSpeed: 'ultrafast',
      });

      await expect(
        target.command(
          envelope('claude-to-codex', {
            type: 'chat.set_model',
            tabId: 'chat-1',
            model: 'gpt-6-sol',
            providerType: 'codex',
            settings: {
              thinkingLevel: 'high',
              modelConfig: {
                thinkingLevel: 'high',
                speed: 'ultrafast',
                fastMode: false,
              },
              codexFastModeEnabled: false,
              interfaceMode: null,
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const returned = await chatTab(target);
      expect(returned).toMatchObject({
        providerType: 'codex',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
        codexFastModeEnabled: false,
      });
      expect(returned).not.toHaveProperty('retainedCodexSpeed');
    });

    it('retains a legacy Fast alias as the exact Fast speed', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'codex',
        model: 'gpt-6-sol',
        codexFastModeEnabled: true,
      });

      await target.command(
        envelope('legacy-to-claude', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
        }),
      );

      expect(await chatTab(target)).toMatchObject({
        providerType: 'claude',
        retainedCodexSpeed: 'fast',
      });
    });

    it('restores the retained speed when a settings-less change returns to Codex', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        retainedCodexSpeed: 'ultrafast',
      });

      await target.command(
        envelope('remote-codex-pick', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt-6-sol',
          providerType: 'codex',
        }),
      );

      const returned = await chatTab(target);
      expect(returned?.modelConfig).toEqual({
        speed: 'ultrafast',
        fastMode: false,
      });
      expect(returned).not.toHaveProperty('retainedCodexSpeed');
    });

    it('keeps inheriting the Codex default when the chat never chose a speed', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'codex',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'high' },
      });

      await target.command(
        envelope('inherited-to-claude', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
        }),
      );

      expect(await chatTab(target)).not.toHaveProperty('retainedCodexSpeed');
    });

    it('keeps the retained speed across non-Codex model changes', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        retainedCodexSpeed: 'ultrafast',
      });

      await target.command(
        envelope('claude-model-change', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'claude-opus-4-6',
          providerType: 'claude',
        }),
      );

      expect(await chatTab(target)).toMatchObject({
        model: 'claude-opus-4-6',
        retainedCodexSpeed: 'ultrafast',
      });
    });

    it('stores set-model settings with the derived fastMode and alias', async () => {
      const target = service();
      await seedChat(target, { providerType: 'codex', model: 'gpt-6-sol' });

      await target.command(
        envelope('codex-ultra-settings', {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt-6-sol',
          providerType: 'codex',
          settings: {
            thinkingLevel: 'high',
            modelConfig: {
              thinkingLevel: 'high',
              speed: 'ultrafast',
              fastMode: true,
            },
            codexFastModeEnabled: true,
            interfaceMode: null,
          },
        }),
      );

      expect(await chatTab(target)).toMatchObject({
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
        codexFastModeEnabled: false,
      });
    });

    it('stores created and trusted-send model configs canonically', async () => {
      const target = service();
      await target.command(
        envelope('create-ultra', {
          type: 'chat.create_tab',
          tabId: 'chat-ultra',
          providerType: 'codex',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'high', speed: 'ultrafast' },
        }),
      );
      await target.command(
        envelope('create-legacy-fast', {
          type: 'chat.create_tab',
          tabId: 'chat-legacy',
          providerType: 'codex',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'high', fastMode: true },
        }),
      );
      await target.ensureChatForTrustedSend({
        ...SCOPE,
        chatId: 'chat-trusted',
        userMessageId: 'user-trusted',
        text: 'Start',
        providerType: 'codex',
        model: 'gpt-6-sol',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: true,
        },
      });

      expect((await chatTab(target, 'chat-ultra'))?.modelConfig).toEqual({
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      });
      expect((await chatTab(target, 'chat-legacy'))?.modelConfig).toEqual({
        thinkingLevel: 'high',
        speed: 'fast',
        fastMode: true,
      });
      expect((await chatTab(target, 'chat-trusted'))?.modelConfig).toEqual({
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      });
    });

    it('carries a seeded speed canonically with its retained speed', async () => {
      const target = service();
      await expect(
        target.command(
          envelope('create-seeded-speed', {
            type: 'chat.create_tab',
            tabId: 'branched-chat',
            seedTab: {
              id: 'branched-chat',
              title: 'Branched chat',
              createdAt: '2026-09-30T12:00:00.000Z',
              messages: [],
              providerType: 'claude',
              modelConfig: { thinkingLevel: 'high', speed: 'standard' },
              retainedCodexSpeed: 'ultrafast',
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      expect(await chatTab(target, 'branched-chat')).toMatchObject({
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        retainedCodexSpeed: 'ultrafast',
      });
    });

    it('carries the exact speed and retained speed through fork and restore', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        retainedCodexSpeed: 'ultrafast',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Hello' }],
          },
        ],
      });

      await expect(
        target.command(
          envelope('fork-speed', {
            type: 'chat.fork_tab',
            sourceTabId: 'chat-1',
            targetTabId: 'fork-1',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        target.command(
          envelope('archive-speed', {
            type: 'chat.archive_tab',
            tabId: 'chat-1',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        target.command(
          envelope('restore-speed', {
            type: 'chat.restore_archive',
            archiveEntryId: 'chat-1',
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });

      for (const id of ['fork-1', 'chat-1']) {
        expect(await chatTab(target, id)).toMatchObject({
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          retainedCodexSpeed: 'ultrafast',
        });
      }
    });

    it('keeps Ultra fast for a thinking-only send-time setting', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'codex',
        model: 'gpt-6-sol',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      });

      await target.command(
        envelope('send-thinking-only', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-thinking',
          text: 'Keep Ultra fast',
          modelConfig: { thinkingLevel: 'low' },
        }),
      );

      const expected = {
        thinkingLevel: 'low',
        speed: 'ultrafast',
        fastMode: false,
      };
      expect((await chatTab(target))?.modelConfig).toEqual(expected);
      expect(dispatched.at(-1)?.modelConfig).toEqual(expected);
    });

    it('applies a send-time legacy false as an explicit Regular command', async () => {
      const target = service();
      await seedChat(target, {
        providerType: 'codex',
        model: 'gpt-6-sol',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      });

      await target.command(
        envelope('send-legacy-false', {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-regular',
          text: 'Regular now',
          modelConfig: { thinkingLevel: 'high', fastMode: false },
        }),
      );

      const expected = {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      };
      expect((await chatTab(target))?.modelConfig).toEqual(expected);
      expect(dispatched.at(-1)?.modelConfig).toEqual(expected);
    });
  });

  it('archives the latest canonical tab instead of a stale compatibility snapshot', async () => {
    const target = service();
    await createChat(target);
    const staleTab = (
      await target.getCompatibilityTabs(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      })
    ).tabs[0];
    const assistant: PersistedChatMessage = {
      id: 'assistant-latest',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Latest provider output' }],
    };
    await target.ingestProviderEvent({
      ...SCOPE,
      chatId: 'chat-1',
      mutationId: 'provider-after-archive-read',
      data: {
        type: 'canopy_user_prompt',
        canopy_persisted_messages: [assistant],
      },
    });

    const archived = await target.archiveCompatibilityTab(SCOPE, {
      tab: staleTab,
      archivedAt: '2026-08-10T00:00:00.000Z',
      turnCount: 1,
    });

    expect(archived.archived[0]?.tab.messages).toContainEqual(assistant);
  });

  it('settles the latest canonical transcript inside the archive transaction', async () => {
    const target = service();
    await createChat(target);
    const live = await target.getCompatibilityTabs(SCOPE, {
      chatIds: ['chat-1'],
      fullTranscript: true,
    });
    await target.replaceCompatibilityTabs(SCOPE, {
      ...live,
      tabs: live.tabs.map((candidate) =>
        candidate.id === 'chat-1'
          ? {
              ...candidate,
              messages: [
                ...candidate.messages,
                {
                  id: 'assistant-open-tool',
                  role: 'assistant' as const,
                  timestamp: 2,
                  blocks: [
                    {
                      type: 'tool_use' as const,
                      toolUseId: 'tool-open',
                      toolName: 'Read',
                      input: '{}',
                    },
                  ],
                },
              ],
            }
          : candidate,
      ),
    });

    const archived = await target.archiveCompatibilityTab(SCOPE, {
      tab: live.tabs[0],
      archivedAt: '2026-08-10T00:00:00.000Z',
      turnCount: 0,
    });

    expect(
      archived.archived[0]?.tab.messages.flatMap(({ blocks }) => blocks),
    ).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'tool-open',
        isError: true,
      }),
    );
  });

  it('persists secret answers redacted while retaining non-secret answers', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-secret',
      chatId: 'chat-1',
      questions: [
        {
          id: 'token',
          question: 'Enter API token',
          options: [],
          secret: true,
        },
        { id: 'scope', question: 'Choose scope', options: ['Focused'] },
      ],
    });

    await target.command(
      envelope('answer-secret', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'question-secret',
        answers: [
          {
            questionId: 'token',
            question: 'Enter API token',
            selectedOptions: [],
            freeformText: 'raw-super-secret',
          },
          {
            questionId: 'scope',
            question: 'Choose scope',
            selectedOptions: ['Focused'],
            freeformText: 'keep this note',
          },
        ],
      }),
    );

    const snapshot = await target.getState(SCOPE);
    expect(JSON.stringify(snapshot.tabsFile.pendingQuestions)).not.toContain(
      'raw-super-secret',
    );
    expect(snapshot.tabsFile.pendingQuestions?.[0]?.answers).toEqual([
      expect.objectContaining({
        questionId: 'token',
        freeformText: '[hidden]',
      }),
      expect.objectContaining({
        questionId: 'scope',
        freeformText: 'keep this note',
      }),
    ]);
  });

  it('uses answer question ids when reordered secret and non-secret answers are persisted', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-secret-sibling',
      chatId: 'chat-1',
      questions: [
        { id: 'scope', question: 'Choose scope', options: ['Focused'] },
        {
          id: 'token',
          question: 'Enter API token',
          options: [],
          secret: true,
        },
      ],
    });

    await target.command(
      envelope('answer-secret-sibling', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'question-secret-sibling',
        answers: [
          {
            questionId: 'token',
            question: 'Enter API token',
            selectedOptions: [],
            freeformText: 'raw-sibling-secret',
          },
          {
            questionId: 'scope',
            question: 'Choose scope',
            selectedOptions: ['Focused'],
            freeformText: 'retain-sibling-note',
          },
        ],
      }),
    );

    const snapshot = await target.getState(SCOPE);
    expect(JSON.stringify(snapshot.tabsFile.pendingQuestions)).not.toContain(
      'raw-sibling-secret',
    );
    expect(snapshot.tabsFile.pendingQuestions?.[0]?.answers).toEqual([
      expect.objectContaining({
        questionId: 'token',
        freeformText: '[hidden]',
      }),
      expect.objectContaining({
        questionId: 'scope',
        freeformText: 'retain-sibling-note',
      }),
    ]);
  });

  it('retains an answered question record when the provider consumes it', async () => {
    // The portal renders answered questions from the projected canonical
    // record (CAN-396 answered-questions bubble). The provider waiter's
    // success path consumes the pending question after the answer resolves;
    // that consume must not erase the just-committed answered state.
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Pick', options: ['Red', 'Blue'] }],
    });
    await target.command(
      envelope('answer-1', {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['Blue'] }],
      }),
    );

    await target.consumePendingQuestion(SCOPE, 'chat-1', 'question-1');

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['Blue'] }],
        answeredAt: expect.any(Number),
      }),
    ]);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('streaming');
  });

  it('removes an unanswered question record when the provider consumes it', async () => {
    const target = service();
    await createChat(target);
    await target.upsertPendingQuestion(SCOPE, {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Pick', options: ['Red', 'Blue'] }],
    });

    await target.consumePendingQuestion(SCOPE, 'chat-1', 'question-1');

    const snapshot = await target.getState(SCOPE);
    expect(snapshot.tabsFile.pendingQuestions ?? []).toHaveLength(0);
    expect(snapshot.runtimeByChatId['chat-1']?.status).toBe('streaming');
  });

  it('isolates a throwing observer after the journal commit', async () => {
    const target = service();
    const healthy = jest.fn();
    target.subscribe(() => {
      throw new Error('projection failed');
    });
    target.subscribe(healthy);
    await createChat(target);
    expect(healthy).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: 0, revision: 1 }),
    );
    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('retries a failed materialized projection without delaying wire subscribers', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    const projection = jest
      .fn<void, []>()
      .mockImplementationOnce(() => {
        throw new Error('search index temporarily unavailable');
      })
      .mockImplementation(() => undefined);
    setChatTabsWriteObserver(projection);
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: async () => undefined,
      cleanupSession: async () => undefined,
      schedule: (callback) => setTimeout(callback, 0),
    });
    const wireSubscriber = jest.fn();
    target.subscribe(wireSubscriber);

    await createChat(target);

    expect(wireSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: 0, revision: 1 }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(projection).toHaveBeenCalledTimes(2);
    await expect(target.getState(SCOPE)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('skips a stale projection retry after a newer revision projects', async () => {
    const repository = new ChatStateRepository({ resolvePaths: () => paths });
    repositories.push(repository);
    const scheduled: Array<() => void> = [];
    const projection = jest
      .fn<void, []>()
      .mockImplementationOnce(() => {
        throw new Error('search index temporarily unavailable');
      })
      .mockImplementation(() => undefined);
    setChatTabsWriteObserver(projection);
    const target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: async () => undefined,
      cleanupSession: async () => undefined,
      schedule: (callback) => {
        scheduled.push(callback);
        return { unref: jest.fn() } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    await createChat(target);
    await target.command(
      envelope('rename-2', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      }),
    );
    expect(projection).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(projection).toHaveBeenCalledTimes(2);
  });
});
