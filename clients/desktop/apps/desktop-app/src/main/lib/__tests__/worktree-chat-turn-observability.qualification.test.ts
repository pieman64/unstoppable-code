// CAN-5096: a worktree chat turn on the local worker starts, updates and
// finalizes its audit entry through the agent ingest port, never through the
// desktop service, so observability:load-history,
// observability:load-transcript and observability:load-usage-metrics read the
// same records. The harness is CAN-4115's worker qualification harness.
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { currentAgentWorkerContext } from '../../agent-runs/agent-worker-context';
import type { AgentSession } from '../../agents/types';
import type { inlineTurnRunsModule } from '../../__tests__/helpers/inline-agent-runs';
import { dispatchWorktreeChatTurn } from '../worktree-chat-turn';

type ProviderHandler = (data: unknown) => void | Promise<void>;
interface FakeProvider {
  handler: ProviderHandler | undefined;
  frames: unknown[];
  contexts: Array<ReturnType<typeof currentAgentWorkerContext>>;
  sent: number;
  onAcquire: (() => void) | undefined;
  onRemoved: (() => void) | undefined;
  disposed: boolean;
}
const provider: FakeProvider = {
  handler: undefined,
  frames: [],
  contexts: [],
  sent: 0,
  onAcquire: undefined,
  onRemoved: undefined,
  disposed: false,
};

type RecordedCall = [string, ...unknown[]];
jest.mock(
  '../../observability',
  (): {
    getObservabilityService: () => never;
    peekObservabilityService: () => null;
  } => ({
    getObservabilityService: (): never => {
      throw new Error('service used directly');
    },
    peekObservabilityService: (): null => null,
  }),
);
jest.mock(
  '../../observability/ingest',
  (): {
    getExecutionObservabilityIngest: () => object;
    __calls: RecordedCall[];
  } => {
    const calls: RecordedCall[] = [];
    const methods = [
      'startChatTurn',
      'observeChatEvent',
      'completeChatTurn',
      'pauseChatTurn',
      'resumeChatTurn',
      'recordInjectedPromptForOpenChatTurn',
      'observeSteeringInput',
      'setChatTurnServedModel',
      'setChatTurnAccountProxyRouted',
      'beginClaudeQuery',
      'endClaudeQuery',
      'startObservedTask',
      'updateObservedTask',
      'finalizeObservedTask',
      'interruptMatchingEntries',
      'seedTranscript',
      'appendTranscriptRecord',
      'observeClaudeEvent',
      'appendFinalizedChatTranscriptRecord',
      'markObservedTaskAccountProxyRouted',
      'recordUsageMetricEvent',
      'recordCreatedPullRequest',
      'recordSessionDiagnostic',
      'recordAppDiagnostic',
    ];
    const port = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args: unknown[]): void => {
          calls.push([method, ...args]);
        },
      ]),
    );
    return {
      getExecutionObservabilityIngest: (): object => port,
      __calls: calls,
    };
  },
);
jest.mock('../../agent-runs/turn-runs', () =>
  jest
    .requireActual<{
      inlineTurnRunsModule: typeof inlineTurnRunsModule;
    }>('../../__tests__/helpers/inline-agent-runs')
    .inlineTurnRunsModule(),
);
jest.mock('../../agents/session-event-router', () => ({
  ...jest.requireActual<object>('../../agents/session-event-router'),
  getLiveRoutedSession: (): undefined => undefined,
  getOrCreateRoutedSession: (
    _options: unknown,
    handler: ProviderHandler,
    _getWindow: unknown,
    lifecycle?: { onRemoved?: () => void },
  ): Promise<Partial<AgentSession>> => {
    provider.handler = handler;
    provider.onRemoved = lifecycle?.onRemoved;
    provider.contexts.push(currentAgentWorkerContext());
    provider.onAcquire?.();
    const methods: Partial<AgentSession> = {
      isDisposed: () => provider.disposed,
      sendMessage: () => {
        provider.sent += 1;
        provider.contexts.push(currentAgentWorkerContext());
        // Providers report output as it arrives, before the send returns.
        for (const frame of provider.frames) void provider.handler?.(frame);
      },
    };
    // Every other session member is a live setter the turn awaits.
    const session = new Proxy(methods, {
      get: (target, key): unknown =>
        key === 'then'
          ? undefined
          : ((key in target ? Reflect.get(target, key) : undefined) ??
            ((): Promise<void> => Promise.resolve())),
    });
    return Promise.resolve(session);
  },
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    holdRuntimeHost: (): (() => void) => () => undefined,
    runWithScopeActivity: <T>(_scope: unknown, run: () => T): T => run(),
  }),
}));
jest.mock('../../services/chat-dispatch-authorization', () => ({
  ...jest.requireActual<object>('../../services/chat-dispatch-authorization'),
  consumeDispatchAuthorization: (): void => undefined,
}));
jest.mock('../../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (options: {
    systemPromptAppend?: string;
  }): Promise<object> =>
    Promise.resolve({
      selectedModel: 'claude-sonnet-4-6',
      runtimeModel: 'claude-sonnet-4-6',
      providerType: 'claude',
      executionHarness: 'claude',
      systemPromptAppend: options.systemPromptAppend,
    }),
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): object => ({
    reserveChatTurnStart: (): Promise<{ release: () => void }> =>
      Promise.resolve({ release: () => undefined }),
  }),
}));

const turnRuns = jest.requireMock<ReturnType<typeof inlineTurnRunsModule>>(
  '../../agent-runs/turn-runs',
);

const scope = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
function dispatch(
  onBeforeChatEvent: (event: { data: unknown }) => Promise<void> = () =>
    Promise.resolve(),
): Promise<void> {
  return dispatchWorktreeChatTurn({
    ...scope,
    userMessageId: 'message',
    text: 'hello',
    planMode: false,
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    initiationSource: 'user',
    getWindow: () => null,
    onBeforeChatEvent,
  });
}
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

const calls = jest.requireMock<{ __calls: RecordedCall[] }>(
  '../../observability/ingest',
).__calls;
function callsOf(method: string): unknown[][] {
  return calls.filter(([name]) => name === method).map(([, ...args]) => args);
}

beforeEach(() => {
  calls.length = 0;
  turnRuns.runs.length = 0;
  provider.handler = undefined;
  provider.frames = [];
  provider.contexts = [];
  provider.sent = 0;
  provider.onAcquire = undefined;
  provider.onRemoved = undefined;
  provider.disposed = false;
});

it('a worktree turn on the local worker starts, updates and finalizes its audit entry through the port', async () => {
  const assistant = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
  };
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
  };
  provider.frames = [assistant, result];
  await dispatch();
  await waitFor(() => callsOf('completeChatTurn').length > 0);

  expect(callsOf('startChatTurn')).toEqual([[expect.objectContaining(scope)]]);
  expect(callsOf('observeChatEvent')).toEqual([
    ['ws', 'wt', 'chat', assistant],
    ['ws', 'wt', 'chat', result],
  ]);
  expect(callsOf('completeChatTurn')).toEqual([
    ['ws', 'wt', 'chat', 'success', undefined],
  ]);
  const names = calls.map(([name]) => name);
  expect(names.indexOf('startChatTurn')).toBeLessThan(
    names.indexOf('observeChatEvent'),
  );
  expect(names.lastIndexOf('observeChatEvent')).toBeLessThan(
    names.indexOf('completeChatTurn'),
  );
});

it('one turn writes one audit start and one completion, agreeing with its run', async () => {
  provider.frames = [{ type: 'result', is_error: true, result: 'boom' }];
  await dispatch();
  await waitFor(
    () =>
      callsOf('completeChatTurn').length > 0 &&
      turnRuns.runs[0]?.settledWith != null,
  );

  expect(callsOf('startChatTurn')).toHaveLength(1);
  expect(callsOf('completeChatTurn')).toEqual([
    ['ws', 'wt', 'chat', 'failure', 'boom'],
  ]);
  expect(turnRuns.runs[0]?.settledWith).toBe('failed');
});

it('managed subagent frames reach the audit through the port', async () => {
  const delegation = {
    delegationId: 'delegation-1',
    runGeneration: 1,
    sequence: 0,
    createdAt: 0,
    parentHarnessId: 'claude',
    parentTurnId: 'turn-1',
    parentToolCallId: 'tool-1',
    task: {
      description: 'Look',
      prompt: 'Look around',
      executionMode: 'foreground',
    },
    snapshot: {
      delegationId: 'delegation-1',
      status: 'pending',
      outputTruncated: false,
      requestedModelId: 'claude-sonnet-4-6',
    },
    transcript: [],
  };
  expect(isAgentDelegationTranscript(delegation)).toBe(true);
  const frame = { type: 'canopy_delegation', delegation };
  provider.frames = [
    frame,
    { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
  ];
  await dispatch();
  await waitFor(() => callsOf('completeChatTurn').length > 0);

  expect(callsOf('observeChatEvent')).toContainEqual([
    'ws',
    'wt',
    'chat',
    frame,
  ]);
});
