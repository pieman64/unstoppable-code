const mockIsEnabled = jest.fn();
const mockLoadCanopyCloudAccount = jest.fn();
const mockCreatePortalSession = jest.fn();
const mockEndPortalSession = jest.fn();
const mockPollPortalCommands = jest.fn();
const mockSendPortalEvents = jest.fn();
const mockSendPortalHeartbeat = jest.fn();
const mockReadPortalStateStore = jest.fn();
const mockPersistPortalStopReason = jest.fn();
const mockPersistPortalEventOutbox = jest.fn<
  Promise<void>,
  [unknown[], Map<string, number>]
>();
const mockPersistCompletedPortalCommand = jest.fn();
const mockPersistPortalCommandCursor = jest.fn();
const mockClearActivePortalSession = jest.fn();
const mockReadCompletedPortalCommand = jest.fn();
const mockRecordAppDiagnostic = jest.fn();
const mockRecordSessionDiagnostic = jest.fn();
const mockClearWorktreeSummaryPortalFingerprints = jest.fn();

jest.mock('../../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    isEnabled: mockIsEnabled,
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: mockLoadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../canopy-portal-client', () => ({
  CanopyPortalClientError: class CanopyPortalClientError extends Error {
    code: string;
    status: number;
    constructor(code = 'http-error', message = '', status = 500) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  assertLiveCanopyPortalSupport: jest.fn(),
  createPortalSession: mockCreatePortalSession,
  endPortalSession: mockEndPortalSession,
  pollPortalCommands: mockPollPortalCommands,
  sendPortalEvents: mockSendPortalEvents,
  sendPortalHeartbeat: mockSendPortalHeartbeat,
}));
jest.mock('../portal-state-store', () => ({
  clearActivePortalSession: mockClearActivePortalSession,
  persistCompletedPortalCommand: mockPersistCompletedPortalCommand,
  persistActivePortalSession: jest.fn(),
  persistPortalCommandCursor: mockPersistPortalCommandCursor,
  persistPortalEventOutbox: mockPersistPortalEventOutbox,
  persistPortalStopReason: mockPersistPortalStopReason,
  readCompletedPortalCommand: mockReadCompletedPortalCommand,
  readPortalStateStore: mockReadPortalStateStore,
}));
jest.mock('../../services/terminal-service', () => ({
  subscribeTerminalPortalEvents: jest.fn(() => jest.fn()),
}));
const mockObservabilityListeners = new Set<(event: unknown) => void>();
const mockObservabilitySubscribe = jest.fn(
  (listener: (event: unknown) => void): (() => void) => {
    mockObservabilityListeners.add(listener);
    return (): void => {
      mockObservabilityListeners.delete(listener);
    };
  },
);
jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
    subscribe: mockObservabilitySubscribe,
    getUsageOverview: jest.fn(),
  }),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  clearWorktreeSummaryPortalFingerprints:
    mockClearWorktreeSummaryPortalFingerprints,
}));
const mockHandlePortalCommand = jest.fn();
const mockExecutePortalStateRequest = jest.fn();
jest.mock('../portal-command-handlers', () => ({
  handlePortalCommand: mockHandlePortalCommand,
  executePortalStateRequest: mockExecutePortalStateRequest,
  normalizeStateRequestPayload: (payload: unknown): unknown =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { scope: 'overview', ...payload }
      : { scope: 'overview' },
}));

import { compactPortalEvent } from '../portal-session-manager';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import {
  isAgentDelegationCardData,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import type {
  PortalChatMessage,
  PortalChatPart,
} from '@canopy/protocol/portal';
import { portalPromptProvenance } from '@canopy/agent-transcript';
import { hideDelegationTransportParts } from '@canopy/ui-shared/lib';
import { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { runtimeChatEventToPortalMessage } from '@canopy/desktop-shared/portal/runtime-chat-projection';

type PortalTestEvent = Parameters<typeof compactPortalEvent>[0];
type TestChatMessage = {
  messageId?: unknown;
  parts?: unknown;
  text?: string;
  content?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function findPart(message: unknown, kind: PortalChatPart['kind']): unknown {
  const parts = field(message, 'parts');
  if (!Array.isArray(parts)) return undefined;
  return parts.find((part) => field(part, 'kind') === kind);
}

function partData(part: unknown): Record<string, unknown> | null {
  const data = field(part, 'data');
  return isRecord(data) ? data : null;
}

function chatEvent(message: PortalChatMessage): PortalTestEvent {
  return {
    eventId: 'chat-event',
    type: 'portal.chat.event',
    occurredAt: '2026-10-06T00:00:00.000Z',
    payload: {
      scope: 'worktree',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      message,
    },
  };
}

function snapshotEvent(messages: PortalChatMessage[]): PortalTestEvent {
  return {
    eventId: 'snapshot-event',
    type: 'portal.state.snapshot',
    occurredAt: '2026-10-06T00:00:00.000Z',
    payload: {
      scope: 'chat',
      chatMessages: messages,
    },
  };
}

function snapshotMessages(event: PortalTestEvent): TestChatMessage[] {
  const messages = field(event.payload, 'chatMessages');
  if (!Array.isArray(messages)) {
    throw new Error('Expected snapshot chat messages');
  }
  return messages.filter(isRecord);
}

function messageById(
  messages: TestChatMessage[],
  messageId: string,
): TestChatMessage | undefined {
  return messages.find((message) => message.messageId === messageId);
}

const managedDelegation: AgentDelegationTranscript = {
  delegationId: 'managed-child-1',
  runGeneration: 1,
  sequence: 1,
  parentHarnessId: 'claude',
  parentTurnId: 'parent-message',
  parentToolCallId: 'delegation-call',
  createdAt: 1_700_000_000_000,
  task: {
    description: 'Inspect the Portal projection',
    prompt: 'Check the current Portal chat projection.',
    executionMode: 'foreground',
  },
  snapshot: {
    delegationId: 'managed-child-1',
    status: 'running',
    requestedModelId: 'reviewer',
    routeSnapshot: {
      selectedModelId: 'reviewer',
      runtimeModelId: 'reviewer',
      harnessId: 'claude',
      runtimeKind: 'agent',
      runnerRegistrationId: 'test-runner',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'claude',
      assignmentRevision: 'test-assignment',
      billingAuthority: 'desktop',
      aiCreditsRouted: false,
      capabilities: [],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'test-capabilities',
      capabilityGeneration: 1,
      policyRevision: 'test-policy',
    },
    outputTruncated: false,
    partialText: 'I am checking the Portal projection.',
  },
  transcript: [
    {
      id: 'progress-text',
      sequence: 1,
      occurredAt: 1_700_000_000_001,
      type: 'text',
      text: 'I found the relevant projection.',
    },
    {
      id: 'progress-tool',
      sequence: 2,
      occurredAt: 1_700_000_000_002,
      type: 'tool',
      toolName: 'Read',
      input: '{"file":"portal-session-manager.ts"}',
      output: 'The session manager compacts Portal messages.',
      isError: false,
    },
  ],
};

function liveDelegationMessage(): PortalChatMessage {
  const message = runtimeChatEventToPortalMessage({
    scope: 'worktree',
    workspaceLocalId: 'workspace-1',
    worktreeLocalId: 'worktree-1',
    chatId: 'chat-1',
    data: {
      type: 'canopy_delegation',
      delegation: managedDelegation,
    },
  });
  if (!message) throw new Error('Expected live managed delegation message');
  return message;
}

function persistedDelegationMessages(): PersistedChatMessage[] {
  const parsed = parseAgentTranscriptLines(
    [
      JSON.stringify({
        type: 'canopy_delegation',
        delegation: managedDelegation,
      }),
    ],
    'claude',
  );
  const parentMessage: PersistedChatMessage = {
    id: 'parent-message',
    role: 'assistant',
    timestamp: 1_699_999_999_999,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: 'delegation-call',
        toolName: 'canopy_spawn_delegate',
        input: '{"description":"Inspect the Portal projection"}',
      },
      {
        type: 'tool_result',
        toolUseId: 'delegation-call',
        toolName: 'canopy_spawn_delegate',
        output: 'Delegate started.',
        isError: false,
      },
    ],
  };
  return [parentMessage, ...parsed.messages];
}

it.each([false, true])(
  'keeps validated receipt metadata structured through outbox compaction (folded=%s)',
  (folded) => {
    const receipt = {
      version: 1,
      kind: 'automation',
      operation: 'automation.create',
      dedupeKey: 'canopy:automation:global:a1',
      createdAt: '2026-10-16T00:00:00.000Z',
      activityId: 'a1',
      name: 'Daily',
      enabled: true,
      running: false,
      schedule: 'daily',
      actionKind: 'app_advisor_prompt',
      targetSummary: 'App Advisor',
      ifCommandConfigured: false,
      navigationTarget: { kind: 'automation_editor', activityId: 'a1' },
    };
    const result = {
      output: 'ok',
      isError: false,
      agentArtifacts: [receipt, { version: 999, kind: 'automation' }],
    };
    const message = {
      messageId: 'm1',
      chatId: 'c1',
      role: 'assistant' as const,
      status: 'complete' as const,
      text: '',
      createdAtMs: 1,
      parts: [
        {
          kind: folded ? ('tool_use' as const) : ('tool_result' as const),
          data: folded
            ? {
                toolUseId: 't1',
                toolName: 'DispatchAction',
                input: '{}',
                result,
              }
            : { toolUseId: 't1', ...result },
        },
      ],
    };
    const compacted = compactPortalEvent(chatEvent(message));
    const data = partData(
      findPart(
        field(compacted.payload, 'message'),
        folded ? 'tool_use' : 'tool_result',
      ),
    );
    expect(
      folded ? field(data?.result, 'agentArtifacts') : data?.agentArtifacts,
    ).toEqual([receipt]);
    expect(compactPortalEvent(compacted)).toEqual(compacted);
  },
);

it('keeps a plain inline tool result structured with its error flag', () => {
  const message = {
    messageId: 'm1',
    chatId: 'c1',
    role: 'system' as const,
    status: 'complete' as const,
    text: '',
    createdAtMs: 1,
    parts: [
      {
        kind: 'tool_use' as const,
        data: {
          toolUseId: 't1',
          toolName: 'command',
          input: '{}',
          result: { output: 'x'.repeat(10_000), isError: true },
        },
      },
    ],
  };
  const compacted = compactPortalEvent(chatEvent(message));
  const result = field(
    partData(findPart(field(compacted.payload, 'message'), 'tool_use')),
    'result',
  );
  expect(field(result, 'isError')).toBe(true);
  expect(typeof field(result, 'output')).toBe('string');
  expect(compactPortalEvent(compacted)).toEqual(compacted);
});

describe('Portal session manager chat outbox compaction', () => {
  it('keeps watcher attribution structured in live and snapshot prompt_source parts', () => {
    const watcherFired = {
      kind: 'Multiple watchers fired (2)',
      combinedWatchers: [
        { kind: 'Pipeline completion (Deploy)', text: 'Deploy succeeded' },
        { kind: 'Chat completion', text: 'Review finished' },
      ],
    };
    const message: PortalChatMessage = {
      messageId: 'watcher',
      chatId: 'chat-1',
      role: 'user',
      status: 'complete',
      text: 'Deploy succeeded\n\nReview finished',
      createdAtMs: 1,
      ...portalPromptProvenance({
        role: 'user',
        userMessageSource: 'watcher',
        watcherFired,
      }),
    };
    for (const compacted of [
      field(compactPortalEvent(chatEvent(message)).payload, 'message'),
      ...[
        field(
          compactPortalEvent(snapshotEvent([message])).payload,
          'chatMessages',
        ),
      ].flat(),
    ]) {
      expect(partData(findPart(compacted, 'prompt_source'))).toEqual({
        source: 'automated',
        watcherFired,
      });
      expect(field(compacted, 'watcherFired')).toEqual(watcherFired);
    }
    const compacted = compactPortalEvent(chatEvent(message));
    expect(compactPortalEvent(compacted)).toEqual(compacted);
  });

  it('bounds oversized watcher attribution without dropping its structure', () => {
    const watcherFired = {
      kind: 'k'.repeat(10_000),
      combinedWatchers: Array.from({ length: 40 }, (_, index) => ({
        kind: `Watcher ${index}`,
        text: 't'.repeat(10_000),
      })),
    };
    const message: PortalChatMessage = {
      messageId: 'watcher',
      chatId: 'chat-1',
      role: 'user',
      status: 'complete',
      text: 'Many watchers',
      createdAtMs: 1,
      ...portalPromptProvenance({
        role: 'user',
        userMessageSource: 'watcher',
        watcherFired,
      }),
    };
    const compactedMessage = field(
      compactPortalEvent(chatEvent(message)).payload,
      'message',
    );
    for (const compacted of [
      field(
        partData(findPart(compactedMessage, 'prompt_source')),
        'watcherFired',
      ),
      field(compactedMessage, 'watcherFired'),
    ]) {
      const kind = field(compacted, 'kind');
      const combined = field(compacted, 'combinedWatchers');
      expect(typeof kind === 'string' && kind.length).toBeLessThan(10_000);
      expect(Array.isArray(combined) && combined.length).toBe(24);
      const text = Array.isArray(combined)
        ? field(combined[0], 'text')
        : undefined;
      expect(typeof text === 'string' && text.length).toBeLessThan(10_000);
    }
  });

  it('keeps a live managed delegation card and child parts structured', () => {
    const liveMessage = liveDelegationMessage();
    const sourceAgentPart = findPart(liveMessage, 'agent');
    expect(
      isAgentDelegationCardData(partData(sourceAgentPart)?.delegation),
    ).toBe(true);
    expect(Array.isArray(partData(sourceAgentPart)?.subBlocks)).toBe(true);

    const compacted = compactPortalEvent(chatEvent(liveMessage));
    const compactedMessage = field(compacted.payload, 'message');
    const compactedAgentPart = findPart(compactedMessage, 'agent');
    expect(
      isAgentDelegationCardData(partData(compactedAgentPart)?.delegation),
    ).toBe(true);
    expect(Array.isArray(partData(compactedAgentPart)?.subBlocks)).toBe(true);
    expect(compactPortalEvent(compacted)).toEqual(compacted);
  });

  it('keeps hydrated delegation cards valid and removes their launch receipt', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      messages: persistedDelegationMessages(),
    });
    const compacted = compactPortalEvent(snapshotEvent(projected));
    const messages = snapshotMessages(compacted);
    const delegatedMessage = messages.find(
      (message) => findPart(message, 'agent') !== undefined,
    );
    expect(delegatedMessage).toBeDefined();
    const agentPart = findPart(delegatedMessage, 'agent');
    expect(isAgentDelegationCardData(partData(agentPart)?.delegation)).toBe(
      true,
    );
    expect(Array.isArray(partData(agentPart)?.subBlocks)).toBe(true);
    expect(compactPortalEvent(compacted)).toEqual(compacted);

    const visibleMessages = hideDelegationTransportParts(messages);
    expect(visibleMessages.map((message) => message.messageId)).not.toContain(
      'parent-message',
    );
  });

  it('keeps the same-message managed Delegate task result as structured data', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      messages: persistedDelegationMessages(),
    });
    const compacted = compactPortalEvent(snapshotEvent(projected));
    const parentMessage = messageById(
      snapshotMessages(compacted),
      'parent-message',
    );
    const toolUsePart = findPart(parentMessage, 'tool_use');
    const result = partData(toolUsePart)?.result;
    expect(isRecord(result)).toBe(true);
    expect(field(result, 'output')).toBe('Delegate started.');
    expect(field(result, 'isError')).toBe(false);
  });

  it('bounds managed launch output while keeping its input on the generic path', () => {
    const message: PortalChatMessage = {
      messageId: 'delegate-alias-message',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: 'delegate-alias-call',
            toolName: 'mcp__canopy__DelegateTask',
            input: { description: 'Inspect a bounded result.' },
            result: { output: 'x'.repeat(5_000), isError: true },
          },
        },
      ],
      createdAtMs: 1,
    };
    const compacted = compactPortalEvent(chatEvent(message));
    const toolUsePart = findPart(
      field(compacted.payload, 'message'),
      'tool_use',
    );
    const data = partData(toolUsePart);
    const result = data?.result;
    const output = field(result, 'output');
    expect(isRecord(result)).toBe(true);
    expect(typeof output).toBe('string');
    if (typeof output !== 'string') {
      throw new Error('Expected bounded managed tool output');
    }
    expect(output.length).toBeLessThanOrEqual(4_000);
    expect(field(result, 'isError')).toBe(true);
    expect(data?.input).toBe('{"description":"Inspect a bounded result."}');
  });

  it('keeps depth-one part compaction, a structured inline result and the original part cap', () => {
    const part: PortalChatPart = {
      kind: 'tool_use',
      data: {
        toolUseId: 'ordinary-tool',
        toolName: 'Read',
        input: { file: 'src/main.ts' },
        result: { output: 'Ordinary tool output.', isError: false },
      },
    };
    const message: PortalChatMessage = {
      messageId: 'ordinary-message',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: Array.from({ length: 25 }, () => part),
      createdAtMs: 1,
    };
    const compacted = compactPortalEvent(chatEvent(message));
    const compactedMessage = field(compacted.payload, 'message');
    const compactedParts = field(compactedMessage, 'parts');
    expect(compactedParts).toEqual([
      ...Array.from({ length: 24 }, () => ({
        kind: 'tool_use',
        data: {
          toolUseId: 'ordinary-tool',
          toolName: 'Read',
          input: '{"file":"src/main.ts"}',
          result: { output: 'Ordinary tool output.', isError: false },
        },
      })),
      '[truncated 1 items]',
    ]);
  });
});
