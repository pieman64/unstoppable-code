import type * as CloudAccountStoreModule from '../../lib/canopy-cloud-account-store';
import type { PortalDelegationCardPort } from '../portal-delegation-card-events';
import type { ChatStateChangedEvent } from '@canopy/desktop-shared/types';
const mockChatStateListeners = new Set<
  (event: ChatStateChangedEvent) => void
>();
const mockSubscribeChatState = jest.fn(
  (listener: (event: ChatStateChangedEvent) => void) => {
    mockChatStateListeners.add(listener);
    return (): void => {
      mockChatStateListeners.delete(listener);
    };
  },
);
const mockCardGeneration = jest.fn<
  ReturnType<PortalDelegationCardPort['generation']>,
  Parameters<PortalDelegationCardPort['generation']>
>();
const mockCardAnchor = jest.fn<
  ReturnType<PortalDelegationCardPort['readStoredParentMessage']>,
  Parameters<PortalDelegationCardPort['readStoredParentMessage']>
>();
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): Omit<PortalDelegationCardPort, 'resolveOwner'> & {
    onTurnStateCommitted: () => () => void;
  } => ({
    get subscribe(): typeof mockSubscribeChatState {
      return mockSubscribeChatState;
    },
    get generation(): typeof mockCardGeneration {
      return mockCardGeneration;
    },
    get readStoredParentMessage(): typeof mockCardAnchor {
      return mockCardAnchor;
    },
    // Canonical turn timer and summary projections subscribe on session start.
    onTurnStateCommitted: () => () => undefined,
  }),
}));
const mockIsEnabled = jest.fn();
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
    get isEnabled(): typeof mockIsEnabled {
      return mockIsEnabled;
    },
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => {
  const listeners = new Set<(entry: unknown) => void>();
  return {
    loadCanopyCloudAccount: jest.fn(),
    hasCanopyCloudIdentityChanged: jest.requireActual<
      typeof CloudAccountStoreModule
    >('../../lib/canopy-cloud-account-store').hasCanopyCloudIdentityChanged,
    subscribeCanopyCloudAccountChanges: jest.fn(
      (listener: (entry: unknown) => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    ),
    __testAccountListeners: listeners,
  };
});
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
  get createPortalSession(): typeof mockCreatePortalSession {
    return mockCreatePortalSession;
  },
  get endPortalSession(): typeof mockEndPortalSession {
    return mockEndPortalSession;
  },
  get pollPortalCommands(): typeof mockPollPortalCommands {
    return mockPollPortalCommands;
  },
  get sendPortalEvents(): typeof mockSendPortalEvents {
    return mockSendPortalEvents;
  },
  get sendPortalHeartbeat(): typeof mockSendPortalHeartbeat {
    return mockSendPortalHeartbeat;
  },
}));
jest.mock('../portal-state-store', () => ({
  get clearActivePortalSession(): typeof mockClearActivePortalSession {
    return mockClearActivePortalSession;
  },
  get persistCompletedPortalCommand(): typeof mockPersistCompletedPortalCommand {
    return mockPersistCompletedPortalCommand;
  },
  persistActivePortalSession: jest.fn(),
  get persistPortalCommandCursor(): typeof mockPersistPortalCommandCursor {
    return mockPersistPortalCommandCursor;
  },
  get persistPortalEventOutbox(): typeof mockPersistPortalEventOutbox {
    return mockPersistPortalEventOutbox;
  },
  get persistPortalStopReason(): typeof mockPersistPortalStopReason {
    return mockPersistPortalStopReason;
  },
  get readCompletedPortalCommand(): typeof mockReadCompletedPortalCommand {
    return mockReadCompletedPortalCommand;
  },
  get readPortalStateStore(): typeof mockReadPortalStateStore {
    return mockReadPortalStateStore;
  },
}));
const mockSubscribeTerminal = jest.fn(() => jest.fn());
jest.mock('../../services/terminal-service', () => ({
  get subscribeTerminalPortalEvents(): typeof mockSubscribeTerminal {
    return mockSubscribeTerminal;
  },
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
    get recordAppDiagnostic(): typeof mockRecordAppDiagnostic {
      return mockRecordAppDiagnostic;
    },
    get recordSessionDiagnostic(): typeof mockRecordSessionDiagnostic {
      return mockRecordSessionDiagnostic;
    },
    get subscribe(): typeof mockObservabilitySubscribe {
      return mockObservabilitySubscribe;
    },
    getUsageOverview: jest.fn(),
  }),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  get clearWorktreeSummaryPortalFingerprints(): typeof mockClearWorktreeSummaryPortalFingerprints {
    return mockClearWorktreeSummaryPortalFingerprints;
  },
}));
jest.mock('../portal-command-handlers', () => ({
  handlePortalCommand: jest.fn(),
  executePortalStateRequest: jest.fn(),
  normalizeStateRequestPayload: (payload: unknown): unknown =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { scope: 'overview', ...payload }
      : { scope: 'overview' },
}));

import {
  compactPortalEvent,
  getCanopyPortalState,
  enqueuePortalEventForTest,
  flushPortalOutboxForTest,
  resumeCanopyPortalIfPossible,
  startCanopyPortal,
  stopCanopyPortal,
} from '../portal-session-manager';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import {
  isPortalEventSinkActive,
  capturePortalEmissionContext,
  isPortalEmissionContextCurrent,
} from '../portal-event-bus';
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
import * as MockCloudAccountStore from '../../lib/canopy-cloud-account-store';
import { loadCanopyCloudAccount as loadCanopyCloudAccountMock } from '../../lib/canopy-cloud-account-store';

const mockLoadCanopyCloudAccount = jest.mocked(loadCanopyCloudAccountMock);

function makeTestAccountEntry(
  overrides: Partial<CloudAccountStoreModule.CanopyCloudAccountEntry> = {},
): CloudAccountStoreModule.CanopyCloudAccountEntry {
  return {
    apiKey: 'test-key',
    capabilities: ['portal-v1'],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

function isAccountListenerSet(
  value: unknown,
): value is Set<(entry: unknown) => void> {
  return (
    value instanceof Set &&
    Array.from(value).every((listener) => typeof listener === 'function')
  );
}

const accountListenersCandidate: unknown = Reflect.get(
  MockCloudAccountStore,
  '__testAccountListeners',
);
if (!isAccountListenerSet(accountListenersCandidate)) {
  throw new Error('Expected account store mock listeners');
}
const mockAccountListeners = accountListenersCandidate;

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

function roundTripPortalEvent(event: PortalTestEvent): PortalTestEvent {
  const restored: unknown = JSON.parse(JSON.stringify(event));
  if (!isRecord(restored)) throw new Error('Expected a restored Portal event');
  return {
    ...event,
    payload: field(restored, 'payload'),
  };
}

function sentPortalOutboxEvents(): PortalTestEvent[] {
  return mockSendPortalEvents.mock.calls.flatMap(
    ([input]: [{ request: { events: PortalTestEvent[] } }]) =>
      input.request.events,
  );
}

function sentChatMessage(
  events: PortalTestEvent[],
  messageId: string,
): unknown {
  const event = events.find(
    (candidate) => candidate.type === 'portal.chat.event',
  );
  const message = event ? field(event.payload, 'message') : undefined;
  if (field(message, 'messageId') !== messageId) {
    throw new Error(`Expected restored chat message ${messageId}`);
  }
  return message;
}

async function restorePersistedPortalOutbox(
  events: PortalTestEvent[],
  duringSession?: () => void | Promise<void>,
): Promise<PortalTestEvent[]> {
  mockIsEnabled.mockReturnValue(true);
  mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
  mockReadPortalStateStore.mockResolvedValue({
    clientDeviceId: 'device-1',
    activeSession: {
      serverId: 'canopy-cloud',
      sessionId: 'restored-session',
      commandCursor: 0,
      activatedAt: '2026-10-21T00:00:00.000Z',
      lastSeenAt: null,
    },
    lastStopReason: 'app_shutdown',
    eventOutbox: events,
  });
  mockPersistPortalStopReason.mockResolvedValue(undefined);
  mockPersistPortalEventOutbox.mockResolvedValue(undefined);
  mockSendPortalEvents.mockClear();
  mockSendPortalEvents.mockResolvedValue({
    accepted: events.length,
    duplicates: 0,
    connectionStatus: 'active',
  });
  mockSendPortalHeartbeat.mockResolvedValue({ status: 'active' });
  mockPollPortalCommands.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );

  try {
    await resumeCanopyPortalIfPossible();
    await duringSession?.();
    await flushPortalOutboxForTest();
    return sentPortalOutboxEvents();
  } finally {
    await stopCanopyPortal('app_shutdown');
  }
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
    const occurrence = { id: 'receipt-call#1', revision: 3 };
    const outputLocator = {
      messageId: 'receipt-result',
      blockOrdinal: 1,
      field: 'output' as const,
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
          occurrence,
          ...(folded ? {} : { outputLocator }),
          data: folded
            ? {
                toolUseId: 't1',
                toolName: 'DispatchAction',
                input: '{}',
                result: { ...result, outputLocator },
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
    const part = findPart(
      field(compacted.payload, 'message'),
      folded ? 'tool_use' : 'tool_result',
    );
    expect(field(part, 'occurrence')).toEqual(occurrence);
    expect(
      folded
        ? field(data?.result, 'outputLocator')
        : field(part, 'outputLocator'),
    ).toEqual(outputLocator);
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
  it('preserves the ordinary primary output locator through enqueue and restore compaction', async () => {
    const occurrence = { id: 'canonical-call#7', revision: 31 };
    const suppliedOccurrence = occurrence;
    const locator = {
      messageId: 'primary-result-row-'.repeat(25),
      blockOrdinal: 42,
      field: 'output' as const,
    };
    const message: PortalChatMessage = {
      messageId: 'primary-chat-message',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          occurrence: suppliedOccurrence,
          data: {
            toolUseId: 'read-result',
            toolName: 'Read',
            input: '{}',
            result: {
              output: '"\\'.repeat(3_000),
              isError: false,
              outputLocator: locator,
            },
          },
        },
      ],
      createdAtMs: 1,
    };
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    const enqueued = await enqueuePortalEventForTest(chatEvent(message));
    if (!enqueued) throw new Error('Expected the primary event to enqueue');
    const enqueuedMessage = field(enqueued.payload, 'message');
    const enqueuedPart = findPart(enqueuedMessage, 'tool_use');
    const enqueuedResult = partData(enqueuedPart)?.result;

    expect(field(enqueuedPart, 'occurrence')).toEqual(occurrence);
    expect(field(enqueuedResult, 'outputLocator')).toEqual(locator);
    const compactedPreview = field(enqueuedResult, 'output');
    expect(typeof compactedPreview).toBe('string');
    if (typeof compactedPreview !== 'string') {
      throw new Error('Expected a compacted primary output preview');
    }
    expect(compactedPreview.length).toBeLessThanOrEqual(4_000);

    const restoredEvents = await restorePersistedPortalOutbox([
      roundTripPortalEvent(chatEvent(message)),
    ]);
    const restoredPart = findPart(
      sentChatMessage(restoredEvents, 'primary-chat-message'),
      'tool_use',
    );
    expect(field(partData(restoredPart)?.result, 'outputLocator')).toEqual(
      locator,
    );
    expect(field(restoredPart, 'occurrence')).toEqual(occurrence);
  });

  it('preserves the Delegate task primary output locator through enqueue and restore', async () => {
    const occurrence = { id: 'delegate-call#0', revision: 32 };
    const suppliedOccurrence = occurrence;
    const locator = {
      messageId: 'delegate-result-row',
      blockOrdinal: 7,
      field: 'output' as const,
    };
    const message: PortalChatMessage = {
      messageId: 'delegate-message',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          occurrence: suppliedOccurrence,
          data: {
            toolUseId: 'delegate-call',
            toolName: 'mcp__canopy__DelegateTask',
            input: { description: 'Inspect a compact preview.' },
            result: {
              output: '"\\'.repeat(3_000),
              isError: true,
              outputLocator: locator,
            },
          },
        },
      ],
      createdAtMs: 1,
    };
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    const compacted = await enqueuePortalEventForTest(chatEvent(message));
    if (!compacted)
      throw new Error('Expected the Delegate task event to enqueue');
    const result = partData(
      findPart(field(compacted.payload, 'message'), 'tool_use'),
    )?.result;

    expect(field(result, 'outputLocator')).toEqual(locator);
    expect(
      field(
        findPart(field(compacted.payload, 'message'), 'tool_use'),
        'occurrence',
      ),
    ).toEqual(occurrence);
    const compactedPreview = field(result, 'output');
    expect(typeof compactedPreview).toBe('string');
    if (typeof compactedPreview !== 'string') {
      throw new Error('Expected a compacted Delegate task output preview');
    }
    expect(compactedPreview.length).toBeLessThanOrEqual(4_000);
    expect(field(result, 'isError')).toBe(true);

    const restoredEvents = await restorePersistedPortalOutbox([
      roundTripPortalEvent(chatEvent(message)),
    ]);
    const restoredResult = partData(
      findPart(sentChatMessage(restoredEvents, 'delegate-message'), 'tool_use'),
    )?.result;
    expect(field(restoredResult, 'outputLocator')).toEqual(locator);
    expect(
      field(
        findPart(
          sentChatMessage(restoredEvents, 'delegate-message'),
          'tool_use',
        ),
        'occurrence',
      ),
    ).toEqual(occurrence);
  });

  it('preserves only typed standalone locator fields through enqueue and actual outbox restore', async () => {
    const occurrence = { id: 'cross-call#18', revision: 33 };
    const suppliedOccurrence = occurrence;
    const locator = {
      messageId: 'm'.repeat(512),
      blockOrdinal: 18,
      field: 'output' as const,
    };
    const suppliedLocator = { ...locator, extra: 'must-not-cross-compaction' };
    const message: PortalChatMessage = {
      messageId: 'standalone-result-message',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_result',
          outputLocator: suppliedLocator,
          occurrence: suppliedOccurrence,
          data: {
            toolUseId: 'cross-row-result',
            output: '"\\'.repeat(3_000),
            isError: false,
          },
        },
      ],
      createdAtMs: 1,
    };
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    const compacted = await enqueuePortalEventForTest(chatEvent(message));
    if (!compacted) throw new Error('Expected a standalone result event');
    const resultPart = findPart(
      field(compacted.payload, 'message'),
      'tool_result',
    );
    const resultPreview = field(partData(resultPart), 'output');

    expect(field(resultPart, 'outputLocator')).toEqual(locator);
    expect(field(resultPart, 'occurrence')).toEqual(occurrence);
    expect(typeof resultPreview).toBe('string');
    if (typeof resultPreview !== 'string') {
      throw new Error('Expected a compacted standalone output preview');
    }
    expect(resultPreview.length).toBeLessThanOrEqual(4_000);
    const sent = await restorePersistedPortalOutbox([
      roundTripPortalEvent(chatEvent(message)),
    ]);
    const restoredMessage = sentChatMessage(sent, 'standalone-result-message');
    expect(
      field(findPart(restoredMessage, 'tool_result'), 'outputLocator'),
    ).toEqual(locator);
    expect(
      field(findPart(restoredMessage, 'tool_result'), 'occurrence'),
    ).toEqual(occurrence);
  });

  it('strips damaged provenance on enqueue and actual restore, including Delegate task results', async () => {
    const extraOccurrence = { id: 'extra#3', revision: 1, extra: 'reject' };
    const message: PortalChatMessage = {
      messageId: 'damaged',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      createdAtMs: 1,
      parts: [
        {
          kind: 'tool_result',
          occurrence: extraOccurrence,
          outputLocator: { messageId: 'row', blockOrdinal: 3, field: 'output' },
          data: { toolUseId: 'extra', output: 'preview', isError: false },
        },
        {
          kind: 'tool_result',
          occurrence: { id: 'nul\u0000id', revision: 1 },
          outputLocator: { messageId: 'row', blockOrdinal: 0, field: 'output' },
          data: { toolUseId: 'r', output: 'preview', isError: false },
        },
        {
          kind: 'tool_use',
          occurrence: { id: 'lone\ud800id', revision: 1 },
          data: {
            toolUseId: 'd',
            toolName: 'mcp__canopy__DelegateTask',
            result: {
              output: 'preview',
              isError: false,
              outputLocator: {
                messageId: 'row',
                blockOrdinal: 1,
                field: 'output',
              },
            },
          },
        },
        {
          kind: 'tool_use',
          occurrence: { id: 'call#2', revision: 1 },
          data: {
            toolUseId: 'c',
            toolName: 'Read',
            result: {
              output: 'preview',
              isError: false,
              outputLocator: {
                messageId: 'target\u0000',
                blockOrdinal: 2,
                field: 'output',
              },
            },
          },
        },
      ],
    };
    const event = chatEvent(message);
    const enqueued = await enqueuePortalEventForTest(event);
    const restored = await restorePersistedPortalOutbox([
      roundTripPortalEvent(event),
    ]);
    for (const projected of [
      field(enqueued?.payload, 'message'),
      sentChatMessage(restored, 'damaged'),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('outputLocator');
      const parts = field(projected, 'parts');
      expect(Array.isArray(parts)).toBe(true);
      if (!Array.isArray(parts)) throw new Error('Expected damaged parts');
      expect(field(parts[0], 'occurrence')).toBeUndefined();
      expect(field(parts[1], 'occurrence')).toBeUndefined();
      expect(field(parts[2], 'occurrence')).toBeUndefined();
    }
  });

  it('invalidates synchronously even when start fails before replacing the installed sink', async () => {
    await restorePersistedPortalOutbox([], async () => {
      const context = capturePortalEmissionContext();
      if (!context) throw new Error('Expected installed context');
      mockIsEnabled.mockReturnValue(false);
      const starting = startCanopyPortal();
      expect(isPortalEmissionContextCurrent(context)).toBe(false);
      await expect(starting).rejects.toThrow('not available');
    });
  });

  it.each(['sign-out', 'switch'])(
    'fences a captured emission on %s even while the sink stays installed',
    async (change) => {
      await restorePersistedPortalOutbox([], () => {
        const context = capturePortalEmissionContext();
        if (!context) throw new Error('Expected installed emission context');
        expect(isPortalEmissionContextCurrent(context)).toBe(true);
        for (const listener of Array.from(mockAccountListeners))
          listener(
            change === 'sign-out'
              ? null
              : {
                  apiKey: 'other-key',
                  capabilities: ['portal-v1'],
                  account: { id: 'another-account' },
                },
          );
        expect(isPortalEmissionContextCurrent(context)).toBe(false);
      });
    },
  );

  it('routes a real committed subscription through the manager port and outbox under the registered anchor', async () => {
    const stored: PersistedChatMessage = {
      id: 'registered-committed-anchor',
      role: 'system',
      timestamp: 123,
      blocks: persistedDelegationMessages()
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'delegated_agent_call')
        .map((block) => ({
          ...block,
          transcriptStore: 'chat-stream-v2' as const,
        })),
    };
    mockCardGeneration.mockReset();
    mockCardGeneration.mockResolvedValue({
      entry: {
        chatId: 'chat-1',
        delegationId: 'managed-child-1',
        runGeneration: 1,
        version: 1,
        kind: 'generation',
        createdAt: 10,
        store: 'stream',
        executionMode: 'background',
        origin: { kind: 'launch', anchorMessageId: stored.id },
      },
      stream: null,
      result: null,
    });
    mockCardAnchor.mockReset().mockResolvedValue(stored);
    const events = await restorePersistedPortalOutbox([], async () => {
      expect(mockChatStateListeners.size).toBe(1);
      for (const listener of Array.from(mockChatStateListeners))
        listener({
          schemaVersion: 1,
          eventId: 'committed-delivery',
          occurredAt: '2026-10-21T00:00:00.000Z',
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          baseRevision: 9,
          revision: 10,
          changes: [
            {
              type: 'delegation.card_state_updated',
              chatId: 'chat-1',
              delegationId: 'managed-child-1',
              runGeneration: 1,
              cardRevision: 1,
              streamRevision: 17,
              cardState: {
                version: 2,
                cardRevision: 1,
                requestedModelId: 'reviewer',
                status: 'pending',
                outputTruncated: false,
              },
            },
          ],
        });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    const updates = events.filter(
      (event) => event.type === 'portal.chat.event',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toMatchObject({
      scope: 'worktree',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      message: {
        messageId: 'registered-committed-anchor',
        role: 'system',
        createdAtMs: 123,
        status: 'complete',
        parts: [
          {
            kind: 'agent',
            data: {
              delegation: {
                delegationId: 'managed-child-1',
                sequence: 1,
                streamRevision: 17,
              },
            },
          },
        ],
      },
    });
    expect(mockCardAnchor).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      'chat-1',
      'registered-committed-anchor',
    );
  });

  it('keeps the stream revision hint through enqueue and actual restored managed-card compaction', async () => {
    const source = liveDelegationMessage();
    const data = partData(findPart(source, 'agent'));
    if (!data || !isRecord(data.delegation)) throw new Error('Missing card');
    const message: PortalChatMessage = {
      ...source,
      parts: [
        {
          kind: 'agent',
          data: {
            ...data,
            delegation: {
              ...data.delegation,
              transcriptStore: 'chat-stream-v2',
              streamRevision: 17,
            },
          },
        },
      ],
    };
    const enqueued = await enqueuePortalEventForTest(chatEvent(message));
    expect(
      field(
        partData(findPart(field(enqueued?.payload, 'message'), 'agent'))
          ?.delegation,
        'streamRevision',
      ),
    ).toBe(17);
    const restored = await restorePersistedPortalOutbox([
      roundTripPortalEvent(chatEvent(message)),
    ]);
    expect(
      field(
        partData(
          findPart(sentChatMessage(restored, message.messageId), 'agent'),
        )?.delegation,
        'streamRevision',
      ),
    ).toBe(17);
  });

  it.each([
    ['generation', 'stop'],
    ['anchor', 'stop'],
    ['generation', 'shutdown'],
    ['anchor', 'shutdown'],
    ['generation', 'replacement'],
    ['anchor', 'replacement'],
    ['generation', 'resume'],
    ['anchor', 'resume'],
    ['generation', 'account'],
    ['anchor', 'account'],
    ['generation', 'inactive'],
    ['anchor', 'inactive'],
  ] as const)(
    'drops a held %s lookup across %s even when the next session reuses the id',
    async (stage, transition) => {
      jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
      mockIsEnabled.mockReturnValue(true);
      mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
      mockReadPortalStateStore.mockResolvedValue({
        clientDeviceId: 'device-1',
      });
      mockPersistPortalEventOutbox.mockResolvedValue(undefined);
      mockPersistPortalStopReason.mockResolvedValue(undefined);
      mockEndPortalSession.mockResolvedValue(undefined);
      mockClearActivePortalSession.mockResolvedValue(undefined);
      mockCreatePortalSession.mockResolvedValue({
        sessionId: 'same-session-id',
        status: 'pending_auth',
        pendingExpiresAt: '2026-10-21T00:00:00.000Z',
        commandCursor: 0,
      });
      mockSendPortalEvents.mockClear();
      mockSendPortalEvents.mockResolvedValue({
        accepted: 1,
        duplicates: 0,
        connectionStatus: 'active',
      });
      mockSendPortalHeartbeat.mockResolvedValue({ status: 'active' });
      mockPollPortalCommands.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            ),
          ),
      );
      const generation: NonNullable<
        Awaited<ReturnType<PortalDelegationCardPort['generation']>>
      > = {
        entry: {
          chatId: 'chat-1',
          delegationId: 'managed-child-1',
          runGeneration: 1,
          version: 1,
          kind: 'generation',
          createdAt: 10,
          store: 'stream',
          executionMode: 'background',
          origin: { kind: 'launch', anchorMessageId: 'exact-anchor' },
        },
        stream: null,
        result: null,
      };
      const anchor: PersistedChatMessage = {
        id: 'exact-anchor',
        role: 'assistant',
        timestamp: 10,
        blocks: persistedDelegationMessages()
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'delegated_agent_call')
          .map((block) => ({
            ...block,
            transcriptStore: 'chat-stream-v2' as const,
          })),
      };
      let releaseGeneration: (value: typeof generation) => void = () =>
        undefined;
      let releaseAnchor: (
        value: PersistedChatMessage | undefined,
      ) => void = () => undefined;
      const heldGeneration = new Promise<typeof generation>((resolve) => {
        releaseGeneration = resolve;
      });
      const heldAnchor = new Promise<PersistedChatMessage | undefined>(
        (resolve) => {
          releaseAnchor = resolve;
        },
      );
      mockCardGeneration.mockReset().mockResolvedValue(generation);
      mockCardAnchor.mockReset().mockResolvedValue(anchor);
      if (stage === 'generation')
        mockCardGeneration.mockReturnValueOnce(heldGeneration);
      else mockCardAnchor.mockReturnValueOnce(heldAnchor);
      try {
        await startCanopyPortal();
        expect(mockChatStateListeners.size).toBe(1);
        for (const listener of Array.from(mockChatStateListeners))
          listener({
            schemaVersion: 1,
            eventId: 'held-card',
            occurredAt: '2026-10-21T00:00:00.000Z',
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            baseRevision: 9,
            revision: 10,
            changes: [
              {
                type: 'delegation.card_state_updated',
                chatId: 'chat-1',
                delegationId: 'managed-child-1',
                runGeneration: 1,
                cardRevision: 1,
                streamRevision: 17,
                cardState: {
                  version: 2,
                  cardRevision: 1,
                  requestedModelId: 'reviewer',
                  status: 'pending',
                  outputTruncated: false,
                },
              },
            ],
          });
        for (let i = 0; i < 16; i++) await Promise.resolve();
        expect(
          stage === 'generation' ? mockCardGeneration : mockCardAnchor,
        ).toHaveBeenCalledTimes(1);
        if (transition === 'replacement') await startCanopyPortal();
        else if (transition === 'account') {
          for (const listener of Array.from(mockAccountListeners))
            listener(null);
          await startCanopyPortal();
        } else {
          const stopping = stopCanopyPortal(
            transition === 'stop' ? 'local_disconnect' : 'app_shutdown',
          );
          expect(mockChatStateListeners.size).toBe(0);
          await stopping;
          if (transition === 'resume') {
            mockReadPortalStateStore.mockResolvedValue({
              clientDeviceId: 'device-1',
              activeSession: {
                serverId: 'canopy-cloud',
                sessionId: 'same-session-id',
                commandCursor: 0,
                activatedAt: null,
                lastSeenAt: null,
              },
              lastStopReason: 'app_shutdown',
              eventOutbox: [],
            });
            await resumeCanopyPortalIfPossible();
            await resumeCanopyPortalIfPossible();
            expect(mockChatStateListeners.size).toBe(1);
          }
        }
        releaseGeneration(generation);
        releaseAnchor(anchor);
        for (let i = 0; i < 16; i++) await Promise.resolve();
        await flushPortalOutboxForTest();
        expect(
          sentPortalOutboxEvents().filter(
            (event) => event.type === 'portal.chat.event',
          ),
        ).toEqual([]);
      } finally {
        releaseGeneration(generation);
        releaseAnchor(anchor);
        await stopCanopyPortal('app_shutdown');
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    },
  );

  it('sends one full event for a message past the part cap, never a parts-only frame', async () => {
    // The shared chat store replaces a message on each frame, so a frame
    // carrying only later parts would erase the message's text and first parts.
    const parts: PortalChatPart[] = Array.from({ length: 24 }, () => ({
      kind: 'thinking',
      data: { text: 'preview' },
    }));
    parts.push({
      kind: 'tool_result',
      occurrence: { id: 'row#24', revision: 9 },
      outputLocator: { messageId: 'row', blockOrdinal: 24, field: 'output' },
      data: { toolUseId: 'late', output: 'preview', isError: false },
    });
    const message: PortalChatMessage = {
      messageId: 'visible',
      chatId: 'chat-1',
      role: 'system',
      status: 'complete',
      text: 'unchanged',
      createdAtMs: 11,
      updatedAtMs: 12,
      parts,
    };
    const sent = await restorePersistedPortalOutbox([], async () => {
      await enqueuePortalEventForTest(chatEvent(message));
    });
    const messages = sent
      .filter((e) => e.type === 'portal.chat.event')
      .map((e) => field(e.payload, 'message'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'visible',
      text: 'unchanged',
    });
  });

  it('cleans up a committed listener when a later start subscription fails', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'failed-subscription',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });
    mockSubscribeTerminal.mockImplementationOnce(() => {
      throw new Error('terminal subscription failed');
    });
    try {
      await expect(startCanopyPortal()).rejects.toThrow(
        'terminal subscription failed',
      );
      expect(mockChatStateListeners.size).toBe(0);
    } finally {
      await stopCanopyPortal('app_shutdown');
    }
  });

  it.each([
    ['create', 'sign-out'],
    ['start-subscription', 'sign-out'],
    ['resume-subscription', 'sign-out'],
    ['create', 'identity-change'],
    ['start-subscription', 'identity-change'],
    ['resume-subscription', 'identity-change'],
    ['create', 'repeated-sign-out'],
  ])(
    'cleans up an account-fenced %s operation after %s',
    async (stage, change) => {
      jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
      const account = makeTestAccountEntry({
        account: {
          id: 'account-1',
          name: 'Test account',
          email: 'test@example.test',
          role: 'DEVELOPER',
        },
      });
      const session = {
        sessionId: 'account-fenced-session',
        status: 'pending_auth',
        pendingExpiresAt: '2026-10-21T00:00:00.000Z',
        commandCursor: 0,
      };
      mockIsEnabled.mockReturnValue(true);
      mockLoadCanopyCloudAccount.mockResolvedValue(account);
      mockReadPortalStateStore.mockResolvedValue({
        clientDeviceId: 'device-1',
        ...(stage === 'resume-subscription'
          ? {
              activeSession: {
                serverId: 'canopy-cloud',
                sessionId: 'account-fenced-session',
                commandCursor: 0,
                activatedAt: null,
                lastSeenAt: null,
              },
              lastStopReason: 'app_shutdown',
              eventOutbox: [],
            }
          : {}),
      });
      mockPersistPortalEventOutbox.mockResolvedValue(undefined);
      mockPersistPortalStopReason.mockResolvedValue(undefined);
      mockCreatePortalSession.mockResolvedValue(session);
      mockEndPortalSession.mockClear();
      mockEndPortalSession.mockResolvedValue(undefined);
      mockClearActivePortalSession.mockResolvedValue(undefined);
      mockSendPortalHeartbeat.mockClear();
      mockPollPortalCommands.mockClear();
      let reachedBoundary: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        reachedBoundary = resolve;
      });
      let releaseCreate: () => void = () => undefined;
      const terminalUnsubscribe = jest.fn();
      if (stage === 'create') {
        mockCreatePortalSession.mockImplementationOnce(() => {
          reachedBoundary();
          return new Promise((resolve) => {
            releaseCreate = (): void => resolve(session);
          });
        });
      } else {
        mockSubscribeTerminal.mockImplementationOnce(() => {
          // Wake the test while subscribeFeatureEvents is still in flight,
          // before its caller can install heartbeat/poll/expiry timers.
          reachedBoundary();
          return terminalUnsubscribe;
        });
      }
      const operation =
        stage === 'resume-subscription'
          ? resumeCanopyPortalIfPossible()
          : startCanopyPortal();
      try {
        await reached;
        expect(getCanopyPortalState().status).toBe(
          stage === 'create'
            ? 'starting'
            : stage === 'start-subscription'
              ? 'pending_auth'
              : 'reconnecting',
        );
        for (const listener of Array.from(mockAccountListeners)) {
          listener(
            change === 'identity-change'
              ? { ...account, account: { id: 'account-2' } }
              : null,
          );
          if (change === 'repeated-sign-out') listener(null);
        }
        releaseCreate();
        await operation;
        expect(getCanopyPortalState().status).toBe('disabled');
        expect(getCanopyPortalState().sessionId).toBeNull();
        expect(getCanopyPortalState().pairingCode).toBeNull();
        expect(isPortalEventSinkActive()).toBe(false);
        expect(mockEndPortalSession).toHaveBeenCalledTimes(1);
        expect(mockEndPortalSession).toHaveBeenCalledWith({
          sessionId: 'account-fenced-session',
        });
        expect(mockChatStateListeners.size).toBe(0);
        if (stage !== 'create')
          expect(terminalUnsubscribe).toHaveBeenCalledTimes(1);
        expect(mockSendPortalHeartbeat).not.toHaveBeenCalled();
        expect(mockPollPortalCommands).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        releaseCreate();
        await operation;
        await stopCanopyPortal('app_shutdown');
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    },
  );

  it('a newer stop supersedes the account fence without cleaning up the old create response', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockEndPortalSession.mockClear();
    let reachedCreate: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedCreate = resolve;
    });
    let releaseCreate: () => void = () => undefined;
    mockCreatePortalSession.mockImplementationOnce(() => {
      reachedCreate();
      return new Promise((resolve) => {
        releaseCreate = (): void => {
          resolve({
            sessionId: 'superseded-create',
            status: 'pending_auth',
            pendingExpiresAt: '2026-10-21T00:00:00.000Z',
            commandCursor: 0,
          });
        };
      });
    });
    const starting = startCanopyPortal();
    try {
      await reached;
      for (const listener of Array.from(mockAccountListeners)) listener(null);
      await stopCanopyPortal('app_shutdown');
      releaseCreate();
      await starting;
      expect(getCanopyPortalState().status).toBe('disabled');
      expect(mockEndPortalSession).not.toHaveBeenCalled();
      expect(mockChatStateListeners.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      releaseCreate();
      await starting;
      await stopCanopyPortal('app_shutdown');
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('an account invalidation during stop does not abandon teardown of the same installed session', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'account-change-during-stop',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });
    let releaseStop: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopping: ReturnType<typeof stopCanopyPortal> | undefined;
    try {
      await startCanopyPortal();
      mockPersistPortalStopReason.mockReturnValueOnce(held);
      stopping = stopCanopyPortal('app_shutdown');
      for (const listener of Array.from(mockAccountListeners)) listener(null);
      releaseStop();
      await stopping;
      expect(getCanopyPortalState().status).toBe('disabled');
      expect(getCanopyPortalState().sessionId).toBeNull();
      expect(mockChatStateListeners.size).toBe(0);
    } finally {
      releaseStop();
      await stopping;
      await stopCanopyPortal('app_shutdown');
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('a held old stop cannot disable the replacement session after its listener attaches', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'replacement-after-held-stop',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });
    let releaseStop: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopping: ReturnType<typeof stopCanopyPortal> | undefined;
    try {
      await startCanopyPortal();
      mockPersistPortalStopReason.mockReturnValueOnce(held);
      stopping = stopCanopyPortal('app_shutdown');
      expect(mockChatStateListeners.size).toBe(0);
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
      releaseStop();
      await stopping;
      expect(getCanopyPortalState().sessionId).toBe(
        'replacement-after-held-stop',
      );
      expect(mockChatStateListeners.size).toBe(1);
    } finally {
      releaseStop();
      await stopping;
      await stopCanopyPortal('app_shutdown');
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it.each([false, true])(
    'a delayed rejected start cannot dispose a newer resumed session after account change %s',
    async (accountChange) => {
      jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
      mockIsEnabled.mockReturnValue(true);
      mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
      mockReadPortalStateStore.mockResolvedValue({
        clientDeviceId: 'device-1',
      });
      mockPersistPortalEventOutbox.mockResolvedValue(undefined);
      mockPersistPortalStopReason.mockResolvedValue(undefined);
      let rejectStart: (error: Error) => void = () => undefined;
      let reachedCreate: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        reachedCreate = resolve;
      });
      mockCreatePortalSession.mockImplementationOnce(() => {
        reachedCreate();
        return new Promise((_resolve, reject) => {
          rejectStart = reject;
        });
      });
      const starting = startCanopyPortal().catch(() => undefined);
      try {
        await reached;
        await stopCanopyPortal('app_shutdown');
        mockReadPortalStateStore.mockResolvedValue({
          clientDeviceId: 'device-1',
          activeSession: {
            serverId: 'canopy-cloud',
            sessionId: 'new-resumed-session',
            commandCursor: 0,
            activatedAt: null,
            lastSeenAt: null,
          },
          lastStopReason: 'app_shutdown',
          eventOutbox: [],
        });
        await resumeCanopyPortalIfPossible();
        expect(mockChatStateListeners.size).toBe(1);
        if (accountChange) {
          for (const listener of Array.from(mockAccountListeners))
            listener(null);
        }
        rejectStart(new Error('old start rejected'));
        await starting;
        expect(getCanopyPortalState().sessionId).toBe('new-resumed-session');
        expect(mockChatStateListeners.size).toBe(accountChange ? 0 : 1);
      } finally {
        rejectStart(new Error('cleanup'));
        await starting;
        await stopCanopyPortal('app_shutdown');
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    },
  );

  it('keeps the committed listener and an in-flight start across a same-identity account save', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const entry = (
      updatedAt: string,
    ): CloudAccountStoreModule.CanopyCloudAccountEntry =>
      makeTestAccountEntry({
        account: {
          id: 'account-1',
          name: 'Test account',
          email: 'test@example.test',
          role: 'DEVELOPER',
        },
        updatedAt,
      });
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(entry('t0'));
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'same-identity-session',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });
    try {
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
      // An enforced-settings re-probe saves the same account with a new time.
      const context = capturePortalEmissionContext();
      if (!context) throw new Error('Expected same-account context');
      for (const listener of Array.from(mockAccountListeners))
        listener(entry('t1'));
      expect(mockChatStateListeners.size).toBe(1);

      expect(isPortalEmissionContextCurrent(context)).toBe(true);

      await stopCanopyPortal('app_shutdown');
      expect(isPortalEmissionContextCurrent(context)).toBe(false);
      let releaseAccount: (
        value: CloudAccountStoreModule.CanopyCloudAccountEntry | null,
      ) => void = () => undefined;
      mockLoadCanopyCloudAccount.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseAccount = resolve;
        }),
      );
      const starting = startCanopyPortal();
      for (let i = 0; i < 16; i++) await Promise.resolve();
      for (const listener of Array.from(mockAccountListeners))
        listener(entry('t2'));
      releaseAccount(entry('t2'));
      await starting;
      expect(getCanopyPortalState().sessionId).toBe('same-identity-session');
      expect(mockChatStateListeners.size).toBe(1);
    } finally {
      await stopCanopyPortal('app_shutdown');
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('owns exactly one committed listener across repeated starts, stop, resume, account changes and failed start', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockEndPortalSession.mockResolvedValue(undefined);
    mockClearActivePortalSession.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'listener-session',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });
    try {
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
      const stopping = stopCanopyPortal('app_shutdown');
      expect(mockChatStateListeners.size).toBe(0);
      await stopping;
      await restorePersistedPortalOutbox([]);
      expect(mockChatStateListeners.size).toBe(0);
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
      for (const listener of Array.from(mockAccountListeners)) listener(null);
      expect(mockChatStateListeners.size).toBe(0);
      mockCreatePortalSession.mockRejectedValueOnce(new Error('start refused'));
      await expect(startCanopyPortal()).rejects.toThrow('start refused');
      expect(mockChatStateListeners.size).toBe(0);
      await startCanopyPortal();
      expect(mockChatStateListeners.size).toBe(1);
    } finally {
      await stopCanopyPortal('app_shutdown');
      jest.clearAllTimers();
      jest.useRealTimers();
    }
    expect(mockChatStateListeners.size).toBe(0);
  });

  it('announces transcript reads v1 and v2 when creating a Portal session', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadCanopyCloudAccount.mockResolvedValue(makeTestAccountEntry());
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockPersistPortalEventOutbox.mockResolvedValue(undefined);
    mockPersistPortalStopReason.mockResolvedValue(undefined);
    mockCreatePortalSession.mockResolvedValue({
      sessionId: 'portal-session-1',
      status: 'pending_auth',
      pendingExpiresAt: '2026-10-21T00:00:00.000Z',
      commandCursor: 0,
    });

    try {
      await startCanopyPortal();
      const firstCall: unknown = mockCreatePortalSession.mock.calls[0];
      const createArgs: unknown = Array.isArray(firstCall)
        ? firstCall[0]
        : undefined;
      const capabilities = field(createArgs, 'capabilities');
      expect(field(capabilities, 'transcript_reads_v1')).toBe(true);
      expect(field(capabilities, 'transcript_reads_v2')).toBe(true);
      expect(field(capabilities, 'pr_status_push_v1')).toBe(true);
    } finally {
      await stopCanopyPortal('app_shutdown');
    }
  });

  it.each(['chat-stream-v2', 'future-store', 'invalid-card'])(
    'never falls back to generic compaction for %s managed cards',
    (marker) => {
      const source = liveDelegationMessage();
      const original = partData(findPart(source, 'agent'));
      if (!original || !isRecord(original.delegation))
        throw new Error('Missing fixture');
      const message: PortalChatMessage = {
        ...source,
        parts: [
          {
            kind: 'agent',
            data: {
              delegation: {
                ...original.delegation,
                finalText: 'Retained answer',
                delegationId: '界\\"'.repeat(300),
                ...(marker === 'invalid-card'
                  ? { routeSnapshot: {} }
                  : { transcriptStore: marker }),
              },
              subBlocks: [{ kind: 'text', data: { text: 'STALE_SENTINEL' } }],
            },
          },
        ],
      };
      const projected = compactPortalEvent(chatEvent(message));
      const data = partData(
        findPart(field(projected.payload, 'message'), 'agent'),
      );
      expect(data?.subBlocks).toEqual([]);
      expect(data).toMatchObject({
        snapshotTruncated: true,
        subBlocksTruncated: true,
        omittedSubBlocks: 1,
      });
      const wire = JSON.stringify(projected);
      expect(wire).not.toContain('STALE_SENTINEL');
      if (marker === 'future-store') {
        expect(data?.delegation).toMatchObject({
          finalText: 'Retained answer',
          status: 'running',
        });
        expect(data?.delegation).not.toHaveProperty('transcriptStore');
      }
      expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(24 * 1024);
      const parsed: unknown = JSON.parse(wire);
      expect(parsed).toEqual(projected);
      expect(
        compactPortalEvent({ ...projected, payload: field(parsed, 'payload') }),
      ).toEqual(projected);
    },
  );
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

  it('keeps the Codex account model carrier structured on text parts (CAN-4716)', () => {
    const modelAccessFailure = {
      kind: 'model_unsupported' as const,
      model: 'gpt-6.1-sol',
      modelLabel: '6.1 Sol',
      fallbackModel: 'gpt-6-luna',
      fallbackModelLabel: 'Luna 6.0',
    };
    const text =
      "Error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
    const message: PortalChatMessage = {
      messageId: 'model-access',
      chatId: 'chat-1',
      role: 'system',
      status: 'complete',
      text: '',
      parts: [{ kind: 'text', data: { text, modelAccessFailure } }],
      createdAtMs: 1,
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
      expect(partData(findPart(compacted, 'text'))).toEqual({
        text,
        modelAccessFailure,
      });
    }
    const malformed = compactPortalEvent(
      chatEvent({
        ...message,
        parts: [
          { kind: 'text', data: { text, modelAccessFailure: { kind: 'x' } } },
        ],
      }),
    );
    expect(
      partData(findPart(field(malformed.payload, 'message'), 'text')),
    ).toEqual({ text });
  });

  it('keeps resume provenance and tool interruption structured on the relay', () => {
    const autoResume = {
      reason: 'app_shutdown' as const,
      resumesUserMessageId: 'user-1',
      resendsUserMessage: false,
    };
    const interruption = { reason: 'app_restart' as const, at: 1_000 };
    const prompt: PortalChatMessage = {
      messageId: 'resume',
      chatId: 'chat-1',
      role: 'user',
      status: 'complete',
      text: 'Continue',
      createdAtMs: 2_000,
      ...portalPromptProvenance({
        role: 'user',
        userMessageSource: 'auto_resume',
        autoResume,
      }),
    };
    const tools: PortalChatMessage = {
      messageId: 'tools',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      createdAtMs: 1_000,
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: 'edit-1',
            toolName: 'Edit',
            input: '{}',
            result: {
              output: 'Interrupted by app restart',
              isError: true,
              interruption,
            },
          },
        },
        {
          kind: 'tool_result',
          data: {
            toolUseId: 'edit-2',
            toolName: 'Edit',
            output: 'Interrupted by app restart',
            isError: true,
            interruption,
          },
        },
      ],
    };
    for (const event of [
      compactPortalEvent(chatEvent(prompt)),
      compactPortalEvent(snapshotEvent([prompt])),
    ]) {
      const compacted =
        field(event.payload, 'message') ??
        [field(event.payload, 'chatMessages')].flat()[0];
      expect(partData(findPart(compacted, 'prompt_source'))).toEqual({
        source: 'automated',
        autoResume,
      });
    }
    const compactedTools = field(
      compactPortalEvent(chatEvent(tools)).payload,
      'message',
    );
    expect(
      field(
        partData(findPart(compactedTools, 'tool_use'))?.result,
        'interruption',
      ),
    ).toEqual(interruption);
    expect(
      partData(findPart(compactedTools, 'tool_result'))?.interruption,
    ).toEqual(interruption);
    const compacted = compactPortalEvent(chatEvent(prompt));
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
