import {
  applyDelegationTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '@canopy/agent-transcript';
import {
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import type { AgentDelegationBrokerOptions } from '@canopy/desktop-shared/node/delegation/broker';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation/types';
import type { ChatStateChangedEvent } from '@canopy/desktop-shared/types';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { ManagedDelegationSession } from '../agents/delegation/service';
import type { AgentSessionOptions } from '../agents/types';

let mockBrokerOptions: AgentDelegationBrokerOptions;
let mockInitialize: (() => void) | undefined;
let mockRecordStore: 'stream' | 'legacy' | undefined = 'stream';
let mockState = createEmptyTranscriptReducerState();
const mockListeners = new Set<(event: ChatStateChangedEvent) => void>();
const mockIngest = jest.fn<
  Promise<'applied' | 'not-applied'>,
  [{ data: Record<string, unknown> }]
>((input) => {
  const before = mockState;
  mockState = applyDelegationTranscriptEvent(mockState, input.data);
  return Promise.resolve(before === mockState ? 'not-applied' : 'applied');
});
const mockRead = jest.fn((_scope: unknown, _chatId: string, id: string) =>
  Promise.resolve(mockState.messages.find((row) => row.id === id)),
);
const mockAttached = jest.fn<void, [AgentDelegationTranscript]>();
const mockSend = jest.fn<void, unknown[]>();
jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): void => mockSend(...args),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => (): void => undefined,
}));
jest.mock('../portal/portal-event-bus', () => ({
  hasPortalEventConsumers: (): boolean => false,
  isCanopyPortalActive: (): boolean => false,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    ingestProviderEventWithOutcome: typeof mockIngest;
    readStoredParentMessage: typeof mockRead;
    getCompatibilityTabs: () => Promise<{ tabs: never[] }>;
    getCompatibilityArchives: () => Promise<{ archived: never[] }>;
    subscribe: (listener: (event: ChatStateChangedEvent) => void) => () => void;
  } => ({
    ingestProviderEventWithOutcome: mockIngest,
    readStoredParentMessage: mockRead,
    getCompatibilityTabs: () => Promise.resolve({ tabs: [] }),
    getCompatibilityArchives: () => Promise.resolve({ archived: [] }),
    subscribe: (listener: (event: ChatStateChangedEvent) => void) => {
      mockListeners.add(listener);
      return (): void => {
        mockListeners.delete(listener);
      };
    },
  }),
}));
jest.mock('@canopy/desktop-shared/node/delegation/broker', () => ({
  AgentDelegationBroker: jest.fn((options: AgentDelegationBrokerOptions) => {
    mockBrokerOptions = options;
    return {
      initialize: (): Promise<void> => {
        mockInitialize?.();
        return Promise.resolve();
      },
      recordStore: (): 'stream' | 'legacy' | undefined => mockRecordStore,
      // The service reports the worktree's lifetime allowance once the broker loads.
      lifetimeSnapshot: (): {
        kind: 'available';
        occupied: number;
        retained: number;
        limit: number;
        cap: number;
        atLimit: boolean;
        extension: 'at_cap';
      } => ({
        kind: 'available',
        occupied: 0,
        retained: 0,
        limit: 512,
        cap: 512,
        atLimit: false,
        extension: 'at_cap',
      }),
      transcripts: (): Promise<AgentDelegationTranscript[]> =>
        Promise.resolve([]),
      activeCount: (): number => 0,
      queuedCount: (): number => 0,
      closeOwner: (): Promise<void> => Promise.resolve(),
      close: (): Promise<void> => Promise.resolve(),
      replayQueuedBackground: (): Promise<void> => Promise.resolve(),
    };
  }),
}));
jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(() => ({ dispose: (): void => undefined })),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: () => void } => ({
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../ledger/delegate-owners', () => ({
  registerLedgerDelegateSource: (): void => undefined,
}));

const options: AgentSessionOptions = {
  projectId: 'stream-host-project',
  worktreeId: 'worktree',
  chatId: 'chat',
  cwd: '/workspace',
};
const parent: DelegationParentContext = {
  ...options,
  harnessId: 'claude',
  sessionKey: 'stream-host-project/worktree/chat',
  runtimeGeneration: 1,
  depth: 0,
  turnId: 'turn',
  toolCallId: 'tool',
};
function envelope(sequence = 1): AgentDelegationTranscript {
  return {
    delegationId: 'delegate',
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'tool',
    createdAt: 100,
    task: {
      description: 'Original description',
      prompt: 'Original prompt',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'delegate',
      status: 'pending',
      depth: 1,
      outputTruncated: false,
      requestedModelId: 'requested',
      nestedDelegation: 'not_enabled',
    },
    transcript: [],
    transcriptStore: 'chat-stream-v2',
  };
}
function emit(transcript: AgentDelegationTranscript): void {
  mockBrokerOptions.onTranscript?.(parent, transcript);
}
async function tick(): Promise<void> {
  for (let i = 0; i < 30; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
function committed(): void {
  for (const listener of Array.from(mockListeners))
    listener({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      schemaVersion: 1,
      eventId: 'commit-event',
      occurredAt: '2026-10-19T16:00:00.000Z',
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { planMode: false },
        },
      ],
    });
}
async function attach(): Promise<ManagedDelegationSession> {
  const { createManagedDelegationSession } =
    await import('../agents/delegation/service');
  return createManagedDelegationSession({
    harness: 'claude',
    sessionKey: parent.sessionKey,
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
    onTranscript: mockAttached,
  });
}
function raw(): string {
  return JSON.stringify(mockState.messages[0]);
}
const CREATION_BYTES =
  '{"id":"delegated-agent-delegate","role":"assistant","timestamp":100,"blocks":[{"delegationId":"delegate","status":"pending","depth":1,"outputTruncated":false,"requestedModelId":"requested","nestedDelegation":"not_enabled","type":"delegated_agent_call","agentBlockId":"delegated-agent-delegate","runGeneration":1,"sequence":1,"parentHarnessId":"claude","parentTurnId":"turn","parentToolCallId":"tool","createdAt":100,"selectedModelId":"requested","runtimeModelId":"","targetHarnessId":"","description":"Original description","prompt":"Original prompt","executionMode":"background","transcriptStore":"chat-stream-v2"}]}';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockInitialize = undefined;
  mockRecordStore = 'stream';
  mockState = createEmptyTranscriptReducerState();
  mockListeners.clear();
  expect(isAgentDelegationTranscript(envelope())).toBe(true);
  mockAttached.mockImplementation(() => undefined);
});
afterEach(async () => {
  const { shutdownManagedDelegations } =
    await import('../agents/delegation/service');
  await shutdownManagedDelegations();
  jest.restoreAllMocks();
});

it.each(['log', 'card'])(
  'bypasses the hostile legacy %s writer and preserves the live stream marker',
  async (hostile) => {
    const { DelegationLogWriter } =
      await import('../agents/delegation/log-writer');
    const { DelegationCardPersistence } =
      await import('../agents/delegation/card-persistence');
    const logs = jest
      .spyOn(DelegationLogWriter.prototype, 'offer')
      .mockImplementation(() => {
        if (hostile === 'log') throw new Error('legacy log');
        return Promise.resolve();
      });
    const cards = jest
      .spyOn(DelegationCardPersistence.prototype, 'offer')
      .mockImplementation(() => {
        if (hostile === 'card') throw new Error('legacy card');
      });
    await attach();
    expect(() => emit(envelope())).not.toThrow();
    await tick();
    expect(logs).not.toHaveBeenCalled();
    expect(cards).not.toHaveBeenCalled();
    expect(mockAttached).toHaveBeenCalledWith(envelope());
    expect(mockSend.mock.calls[0]?.[2]).toMatchObject({
      data: { delegation: { transcriptStore: 'chat-stream-v2' } },
    });
  },
);

it.each(['attached-to-detached', 'detached-to-attached'])(
  'retains literal creation bytes while admission pauses: %s',
  async (transition) => {
    let session = await attach();
    if (transition === 'detached-to-attached') session.detach();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockAttached.mockImplementation((transcript) => {
      void held.then(() => mockIngest({ data: { delegation: transcript } }));
    });
    mockIngest.mockImplementationOnce(async (input) => {
      await held;
      mockState = applyDelegationTranscriptEvent(mockState, input.data);
      return 'applied';
    });
    emit(envelope());
    await tick();
    emit({
      ...envelope(2),
      task: { ...envelope().task, prompt: 'Amended prompt' },
    });
    emit({
      ...envelope(3),
      task: { ...envelope().task, prompt: 'Amended prompt' },
      snapshot: {
        ...envelope().snapshot,
        status: 'running',
        routeSnapshot: routeFixture(),
      },
    });
    if (transition === 'attached-to-detached') session.detach();
    else session = await attach();
    release();
    await tick();
    committed();
    await tick();
    expect(raw()).toBe(CREATION_BYTES);
    expect(mockState.messages).toHaveLength(1);
    session.detach();
  },
);

it('retains a failed attached first admission and redelivers it before newer envelopes', async () => {
  await attach();
  emit(envelope());
  await tick();
  expect(mockState.messages).toHaveLength(0);
  mockAttached.mockImplementation((transcript) => {
    void mockIngest({ data: { delegation: transcript } });
  });
  emit({
    ...envelope(2),
    task: { ...envelope().task, prompt: 'Amended prompt' },
  });
  await tick();
  expect(mockAttached.mock.calls.map(([value]) => value.sequence)).toEqual([
    1, 1, 2,
  ]);
  expect(raw()).toBe(CREATION_BYTES);
});

it('holds the initialization envelope before any root exists', async () => {
  mockInitialize = (): void => {
    emit(envelope());
    emit({
      ...envelope(2),
      task: { ...envelope().task, prompt: 'Initialization amendment' },
    });
  };
  mockAttached.mockImplementation((transcript) => {
    void mockIngest({ data: { delegation: transcript } });
  });
  await attach();
  await tick();
  expect(raw()).toBe(CREATION_BYTES);
});

it('refuses a stream marker contradicting the broker record identity', async () => {
  mockRecordStore = 'legacy';
  await attach();
  emit(envelope());
  await tick();
  expect(mockAttached).not.toHaveBeenCalled();
  expect(mockIngest).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it.each([
  ['before broker initialization completes'],
  ['after the parent rolls over to a new generation'],
])(
  'routes a broker-stamped stream envelope when its parent authority is unavailable %s',
  async () => {
    // recordStore checks live parent lineage, so it answers nothing in these
    // windows; the broker's own stamp still classifies its publication.
    mockRecordStore = undefined;
    await attach();
    emit(envelope());
    await tick();
    expect(mockSend.mock.calls[0]?.[2]).toMatchObject({
      data: { delegation: { transcriptStore: 'chat-stream-v2' } },
    });
    expect(mockAttached.mock.calls.map(([value]) => value.sequence)).toEqual([
      1,
    ]);
  },
);

it('preserves the stream marker on window live delivery independently of persistence', async () => {
  await attach();
  emit(envelope());
  await tick();
  expect(mockSend.mock.calls[0]?.[2]).toMatchObject({
    data: { delegation: { transcriptStore: 'chat-stream-v2' } },
  });
});

it('retains a rejected detached admission and retries creation before the amendment', async () => {
  const session = await attach();
  session.detach();
  mockIngest.mockRejectedValueOnce(new Error('first admission rejected'));
  emit(envelope());
  await tick();
  expect(mockState.messages).toHaveLength(0);
  emit({
    ...envelope(2),
    task: { ...envelope().task, prompt: 'Amended prompt' },
  });
  await tick();
  expect(mockIngest.mock.calls.map(([input]) => input.data.delegation)).toEqual(
    [
      envelope(),
      envelope(),
      {
        ...envelope(2),
        task: { ...envelope().task, prompt: 'Amended prompt' },
      },
    ],
  );
  expect(raw()).toBe(CREATION_BYTES);
});

it('does not release later attached envelopes until the own-card read confirms creation', async () => {
  await attach();
  emit(envelope());
  await tick();
  emit({
    ...envelope(2),
    task: { ...envelope().task, prompt: 'Amended prompt' },
  });
  await tick();
  expect(mockAttached.mock.calls.map(([value]) => value.sequence)).toEqual([
    1, 1,
  ]);
  expect(mockRead).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: 'chat' }),
    'chat',
    'delegated-agent-delegate',
  );
  await mockIngest({ data: { delegation: envelope() } });
  committed();
  await tick();
  expect(mockAttached.mock.calls.map(([value]) => value.sequence)).toEqual([
    1, 1, 1, 2,
  ]);
  expect(raw()).toBe(CREATION_BYTES);
});

it('refuses a missing stream marker on a stream record rather than routing to legacy', async () => {
  await attach();
  emit({ ...envelope(), transcriptStore: undefined });
  await tick();
  expect(mockAttached).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});
