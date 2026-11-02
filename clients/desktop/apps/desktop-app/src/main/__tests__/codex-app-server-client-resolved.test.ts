const mockAttachInteractiveClient = jest.fn();
const mockRequestAnswersFromRenderer = jest.fn();

jest.mock(
  '../codex/runtime-service',
  (): Record<string, unknown> => ({
    getCodexRuntimeService: (): {
      attachInteractiveClient: typeof mockAttachInteractiveClient;
    } => ({
      get attachInteractiveClient(): typeof mockAttachInteractiveClient {
        return mockAttachInteractiveClient;
      },
    }),
  }),
);

jest.mock(
  '../canopy-tools/session-runtime',
  (): Record<string, unknown> => ({
    get requestAnswersFromRenderer(): typeof mockRequestAnswersFromRenderer {
      return mockRequestAnswersFromRenderer;
    },
  }),
);

jest.mock(
  '../lib/main-process-logging',
  (): Record<string, unknown> => ({
    logMainProcessWarn: jest.fn(),
  }),
);

import { CodexAppServerClient } from '../codex/app-server-client';
import type {
  ApprovalCheck,
  McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import type { CodexMcpToolCallContext } from '@canopy/desktop-shared/node/codex-runtime';
import type { SendableBrowserWindow } from '../lib/window-send';
import type {
  ApprovalCheckDisplay,
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import type { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import { logMainProcessWarn } from '../lib/main-process-logging';

const mockLogMainProcessWarn = jest.mocked(logMainProcessWarn);

type RendererAnswerOptions = Parameters<typeof requestAnswersFromRenderer>[0];

type TestConnection = {
  completePendingServerRequest: jest.Mock<boolean, [string | number]>;
  flushPendingServerRequests: jest.Mock<void, [boolean]>;
  isInitialized: jest.Mock<boolean, []>;
  isOnlyOwner: jest.Mock<boolean, []>;
  rejectAllPendingRequests: jest.Mock<void, [Error]>;
  rejectPendingRequests: jest.Mock<void, [Error]>;
  release: jest.Mock<void, []>;
  send: jest.Mock<void, [Record<string, unknown>]>;
};

type RequestCase = {
  handler: 'approval' | 'mcp';
  method: string;
  name: string;
  request: Record<string, unknown>;
  setup?: (client: CodexAppServerClient) => void;
};

type QuestionCase = {
  handler: 'request-user-input' | 'form';
  name: string;
  request: Record<string, unknown>;
};

function createConnection(signal: AbortSignal): TestConnection {
  return {
    completePendingServerRequest: jest.fn<boolean, [string | number]>(
      () => !signal.aborted,
    ),
    flushPendingServerRequests: jest.fn<void, [boolean]>(),
    isInitialized: jest.fn<boolean, []>(() => false),
    isOnlyOwner: jest.fn<boolean, []>(() => true),
    rejectAllPendingRequests: jest.fn<void, [Error]>(),
    rejectPendingRequests: jest.fn<void, [Error]>(),
    release: jest.fn<void, []>(),
    send: jest.fn<void, [Record<string, unknown>]>(),
  };
}

function createApprovalSession(
  check: ApprovalSessionHandle['check'] = jest.fn(() =>
    Promise.resolve({ decision: 'deny' }),
  ),
): ApprovalSessionHandle {
  return {
    check,
    setMode: jest.fn(),
    reevaluatePendingApprovals: jest.fn(),
    dispose: jest.fn(),
  };
}

function createClient(
  signal: AbortSignal,
  events: unknown[],
  approvalSession: ApprovalSessionHandle,
): { client: CodexAppServerClient; connection: TestConnection } {
  const connection = createConnection(signal);
  mockAttachInteractiveClient.mockReturnValue(connection);
  const client = new CodexAppServerClient({
    cwd: '/tmp/repo',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'project/worktree/chat',
    onEvent: (event): void => {
      events.push(event);
    },
    getWindow: (): SendableBrowserWindow | null => null,
    approvalSession,
  });
  return { client, connection };
}

function invoke(
  client: CodexAppServerClient,
  methodName: string,
  args: unknown[],
): Promise<void> {
  const method: unknown = Reflect.get(client, methodName);
  if (typeof method !== 'function') {
    throw new Error(`Expected ${methodName} handler`);
  }
  const result: unknown = Reflect.apply(method, client, args);
  if (!(result instanceof Promise)) {
    throw new Error(`Expected ${methodName} to return a promise`);
  }
  return result;
}

function setActiveTurnItems(
  client: CodexAppServerClient,
  items: Array<[string, Record<string, unknown>]>,
): void {
  Reflect.set(client, 'activeTurn', {
    items: new Map(items),
    reject: jest.fn<void, [Error]>(),
  });
}

function approvalRequestCases(): RequestCase[] {
  return [
    {
      name: 'v2 command execution',
      handler: 'approval',
      method: 'item/commandExecution/requestApproval',
      request: {
        params: {
          threadId: 'thread-1',
          command: 'npm test',
          itemId: 'command-1',
        },
      },
    },
    {
      name: 'writeStdin command execution',
      handler: 'approval',
      method: 'item/commandExecution/requestApproval',
      request: {
        params: {
          threadId: 'thread-1',
          kind: 'writeStdin',
          approvalId: 'stdin-1',
          itemId: 'command-2',
        },
      },
    },
    {
      name: 'v2 file change',
      handler: 'approval',
      method: 'item/fileChange/requestApproval',
      request: {
        params: {
          threadId: 'thread-1',
          itemId: 'file-1',
        },
      },
      setup: (client): void => {
        setActiveTurnItems(client, [
          [
            'file-1',
            {
              type: 'file_change',
              changes: [{ path: '/tmp/one' }, { path: '/tmp/two' }],
            },
          ],
        ]);
      },
    },
    {
      name: 'v2 permissions',
      handler: 'approval',
      method: 'item/permissions/requestApproval',
      request: {
        params: {
          threadId: 'thread-1',
          itemId: 'permissions-1',
          permissions: { network: { enabled: true } },
        },
      },
    },
    {
      name: 'legacy exec',
      handler: 'approval',
      method: 'execCommandApproval',
      request: {
        params: {
          conversationId: 'thread-1',
          command: ['npm', 'test'],
        },
      },
    },
    {
      name: 'legacy patch',
      handler: 'approval',
      method: 'applyPatchApproval',
      request: {
        params: {
          conversationId: 'thread-1',
          fileChanges: { '/tmp/file': { type: 'update' } },
        },
      },
    },
    {
      name: 'fallback MCP approval',
      handler: 'approval',
      method: 'item/tool/requestUserInput',
      request: {
        params: {
          threadId: 'thread-1',
          itemId: 'mcp-1',
          questions: [
            {
              id: 'mcp_tool_call_approval_1',
              header: 'Approval',
              question: 'Allow tool use?',
              isOther: false,
              isSecret: false,
              options: [{ label: 'Allow', description: 'Allow' }],
            },
          ],
        },
      },
      setup: (client): void => {
        setActiveTurnItems(client, [
          ['mcp-1', { type: 'mcp_tool_call', server: 'server', tool: 'read' }],
        ]);
      },
    },
    {
      name: 'synthesized MCP approval through dispatcher',
      handler: 'approval',
      method: 'mcpServer/elicitation/request',
      request: {
        params: {
          threadId: 'thread-1',
          serverName: 'server',
          mode: 'form',
          message: 'Use tool?',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            tool_name: 'read',
          },
        },
      },
    },
    {
      name: 'synthesized MCP approval through direct owner handler',
      handler: 'mcp',
      method: 'handleMcpElicitation',
      request: { params: { _meta: { tool_title: 'Read' } } },
    },
  ];
}

function questionCases(): QuestionCase[] {
  return [
    {
      name: 'built-in request_user_input',
      handler: 'request-user-input',
      request: {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'input-1',
          questions: [
            {
              id: 'q1',
              header: 'Choice',
              question: 'Pick one',
              isOther: false,
              isSecret: false,
              options: [{ label: 'A', description: 'Option A' }],
            },
          ],
        },
      },
    },
    {
      name: 'genuine MCP form elicitation',
      handler: 'form',
      request: {
        params: {
          threadId: 'thread-1',
          serverName: 'server',
          mode: 'form',
          message: 'Tell us a value.',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      },
    },
  ];
}

function invokeRequestCase(
  client: CodexAppServerClient,
  requestCase: RequestCase,
  signal: AbortSignal,
): Promise<void> {
  if (requestCase.setup) requestCase.setup(client);
  if (requestCase.handler === 'mcp') {
    const toolCall: CodexMcpToolCallContext = {
      id: 'mcp-call-1',
      threadId: 'thread-1',
      serverName: 'server',
      toolName: 'read',
      arguments: {},
      normalizedArguments: '{}',
    };
    return invoke(client, requestCase.method, [
      'server-request',
      requestCase.request,
      toolCall,
      'mcp_tool_call',
      signal,
    ]);
  }
  return invoke(client, 'handleApprovalRequest', [
    'server-request',
    requestCase.method,
    requestCase.request,
    signal,
  ]);
}

function invokeQuestionCase(
  client: CodexAppServerClient,
  questionCase: QuestionCase,
  signal: AbortSignal,
): Promise<void> {
  if (questionCase.handler === 'form') {
    return invoke(client, 'handleApprovalRequest', [
      'server-request',
      'mcpServer/elicitation/request',
      questionCase.request,
      signal,
    ]);
  }
  return invoke(client, 'handleRequestUserInput', [
    'server-request',
    questionCase.request,
    signal,
  ]);
}

function hasFailedQuestionEvent(events: unknown[]): boolean {
  return events.some((event) => {
    if (typeof event !== 'object' || event === null || !('event' in event)) {
      return false;
    }
    const nested = event.event;
    if (typeof nested !== 'object' || nested === null || !('item' in nested)) {
      return false;
    }
    const item = nested.item;
    return (
      typeof item === 'object' &&
      item !== null &&
      'status' in item &&
      item.status === 'failed'
    );
  });
}

function makePendingApprovalSession(): {
  check: jest.Mock<
    Promise<ApprovalOutcome>,
    [ApprovalCheck, ApprovalCheckDisplay]
  >;
  rejectPendingCheck: (error: Error) => void;
  session: ApprovalSessionHandle;
} {
  let rejectPendingCheck: (error: Error) => void = () => undefined;
  const check = jest.fn(
    (_approvalCheck: ApprovalCheck, display: ApprovalCheckDisplay) =>
      new Promise<ApprovalOutcome>((_resolve, reject) => {
        rejectPendingCheck = reject;
        if (display.signal?.aborted) {
          reject(new Error('approval_request_resolved'));
          return;
        }
        display.signal?.addEventListener(
          'abort',
          () => reject(new Error('approval_request_resolved')),
          { once: true },
        );
      }),
  );
  return {
    check,
    rejectPendingCheck: (error): void => rejectPendingCheck(error),
    session: createApprovalSession(check),
  };
}

function startRendererAbortStub(): {
  getSignal: () => AbortSignal | undefined;
} {
  let requestSignal: AbortSignal | undefined;
  mockRequestAnswersFromRenderer.mockImplementation(
    (options: RendererAnswerOptions) => {
      requestSignal = options.signal;
      return new Promise<McpQuestionAnswer[]>((_resolve, reject) => {
        const cancel = (): void => reject(new Error('ask_user_cancelled'));
        if (options.signal?.aborted) cancel();
        else options.signal?.addEventListener('abort', cancel, { once: true });
      });
    },
  );
  return { getSignal: () => requestSignal };
}

function startLateRendererAnswerStub(): {
  getSignal: () => AbortSignal | undefined;
  resolve: (answers: McpQuestionAnswer[]) => void;
} {
  let requestSignal: AbortSignal | undefined;
  let resolveAnswers: (answers: McpQuestionAnswer[]) => void = () => undefined;
  mockRequestAnswersFromRenderer.mockImplementation(
    (options: RendererAnswerOptions) => {
      requestSignal = options.signal;
      return new Promise<McpQuestionAnswer[]>((resolve) => {
        resolveAnswers = resolve;
      });
    },
  );
  return {
    getSignal: () => requestSignal,
    resolve: (answers): void => resolveAnswers(answers),
  };
}

describe('Codex app-server resolved interactive requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAttachInteractiveClient.mockReset();
    mockRequestAnswersFromRenderer.mockReset();
  });

  it.each(approvalRequestCases())(
    'does not start the $name approval after its request is already resolved',
    async (requestCase) => {
      const controller = new AbortController();
      controller.abort();
      const events: unknown[] = [];
      const check = jest.fn<
        Promise<ApprovalOutcome>,
        [ApprovalCheck, ApprovalCheckDisplay]
      >(() => Promise.resolve({ decision: 'deny' }));
      const approvalSession = createApprovalSession(check);
      const { client, connection } = createClient(
        controller.signal,
        events,
        approvalSession,
      );
      const interruptTurn = jest.spyOn(client, 'interruptTurn');

      try {
        await invokeRequestCase(client, requestCase, controller.signal);

        expect(check).not.toHaveBeenCalled();
        expect(connection.send).not.toHaveBeenCalled();
        expect(mockRequestAnswersFromRenderer).not.toHaveBeenCalled();
        expect(interruptTurn).not.toHaveBeenCalled();
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        client.dispose();
      }
    },
  );

  it.each(approvalRequestCases())(
    'passes a cancellable signal through the $name prompt and ignores resolution',
    async (requestCase) => {
      const controller = new AbortController();
      const events: unknown[] = [];
      const { check, rejectPendingCheck, session } =
        makePendingApprovalSession();
      const { client, connection } = createClient(
        controller.signal,
        events,
        session,
      );
      const interruptTurn = jest.spyOn(client, 'interruptTurn');
      const handler = invokeRequestCase(client, requestCase, controller.signal);

      try {
        await Promise.resolve();
        expect(check).toHaveBeenCalledTimes(1);
        const display = check.mock.calls[0]?.[1];
        controller.abort();
        rejectPendingCheck(new Error('approval_request_resolved'));
        await handler;

        expect(display?.signal).toBe(controller.signal);
        expect(check).toHaveBeenCalledTimes(1);
        expect(connection.send).not.toHaveBeenCalled();
        expect(interruptTurn).not.toHaveBeenCalled();
        expect(hasFailedQuestionEvent(events)).toBe(false);
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        rejectPendingCheck(new Error('approval_request_resolved'));
        client.dispose();
      }
    },
  );

  it.each(questionCases())(
    'does not start $name after its request is already resolved',
    async (questionCase) => {
      const controller = new AbortController();
      controller.abort();
      const events: unknown[] = [];
      mockRequestAnswersFromRenderer.mockResolvedValue([]);
      const { client, connection } = createClient(
        controller.signal,
        events,
        createApprovalSession(),
      );

      try {
        await invokeQuestionCase(client, questionCase, controller.signal);

        expect(mockRequestAnswersFromRenderer).not.toHaveBeenCalled();
        expect(connection.send).not.toHaveBeenCalled();
        expect(hasFailedQuestionEvent(events)).toBe(false);
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        client.dispose();
      }
    },
  );

  it.each(questionCases())(
    'treats $name ask-user cancellation as expected and suppresses failure output',
    async (questionCase) => {
      const controller = new AbortController();
      const events: unknown[] = [];
      const { client, connection } = createClient(
        controller.signal,
        events,
        createApprovalSession(),
      );
      const renderer = startRendererAbortStub();
      const handler = invokeQuestionCase(
        client,
        questionCase,
        controller.signal,
      );

      try {
        await Promise.resolve();
        expect(mockRequestAnswersFromRenderer).toHaveBeenCalledTimes(1);
        controller.abort();
        await handler;

        expect(renderer.getSignal()?.aborted).toBe(true);
        expect(connection.send).not.toHaveBeenCalled();
        expect(hasFailedQuestionEvent(events)).toBe(false);
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        client.cancelPendingServerRequestsForRecovery();
        client.dispose();
      }
    },
  );

  it.each(questionCases())(
    'composes $name resolution cancellation with recovery cancellation',
    async (questionCase) => {
      const controller = new AbortController();
      const events: unknown[] = [];
      const { client, connection } = createClient(
        controller.signal,
        events,
        createApprovalSession(),
      );
      const renderer = startRendererAbortStub();
      const handler = invokeQuestionCase(
        client,
        questionCase,
        controller.signal,
      );

      try {
        await Promise.resolve();
        expect(mockRequestAnswersFromRenderer).toHaveBeenCalledTimes(1);
        expect(renderer.getSignal()?.aborted).toBe(false);
        client.cancelPendingServerRequestsForRecovery();
        await handler;

        expect(controller.signal.aborted).toBe(false);
        expect(renderer.getSignal()?.aborted).toBe(true);
        expect(connection.send).toHaveBeenCalledTimes(1);
        expect(hasFailedQuestionEvent(events)).toBe(
          questionCase.handler === 'request-user-input',
        );
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        client.dispose();
      }
    },
  );

  it.each(questionCases())(
    'ignores a late renderer answer for $name after request resolution',
    async (questionCase) => {
      const controller = new AbortController();
      const events: unknown[] = [];
      const { client, connection } = createClient(
        controller.signal,
        events,
        createApprovalSession(),
      );
      const renderer = startLateRendererAnswerStub();
      const handler = invokeQuestionCase(
        client,
        questionCase,
        controller.signal,
      );

      try {
        await Promise.resolve();
        expect(mockRequestAnswersFromRenderer).toHaveBeenCalledTimes(1);
        controller.abort();
        const signalWasAborted = renderer.getSignal()?.aborted;
        renderer.resolve([
          {
            questionId: 'q1',
            question: 'Pick one',
            selectedOptions: ['A'],
          },
        ]);
        await handler;

        expect(signalWasAborted).toBe(true);
        expect(connection.send).not.toHaveBeenCalled();
        expect(hasFailedQuestionEvent(events)).toBe(false);
        expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        client.cancelPendingServerRequestsForRecovery();
        client.dispose();
      }
    },
  );
});
