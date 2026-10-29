jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  CANOPY_STREAM_DEFINITIONS,
  CoreChatTranscriptPageParamsSchema,
} from '@canopy/protocol/canopy-core';
import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import {
  runRendererDeliveryBarriers,
  sendToWebContents,
} from '../lib/web-contents-send';
import { RevisionedChatSync } from '../../renderer/src/stores/chat/revisioned-sync';
import {
  ChatStateDelivery,
  ChatStateSubscriptions,
} from '../ipc/chat-state-delivery';
import {
  recordedChatInterest,
  registerChatStateHandlers,
  validateChatCommandRequest,
  validateChatStateScopesDeclaration,
  validateChatInterestDeclaration,
  validateChatGetStateRequest,
  validateChatTranscriptPageRequest,
  validateChatVisualReadRequest,
} from '../ipc/chat-state';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';

const visualRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_12345678-1234-1234-1234-123456789abc',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 4,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
    heights: [[320, 200]],
  },
  offset: 0,
  limit: 4,
};

describe('visual read boundary validation', () => {
  it('accepts an empty visual and exact bounded reference', () => {
    expect(validateChatVisualReadRequest(visualRequest)).toEqual(visualRequest);
    expect(
      validateChatVisualReadRequest({
        ...visualRequest,
        reference: { ...visualRequest.reference, byteLength: 0 },
        offset: 0,
        limit: 1,
      }).reference.byteLength,
    ).toBe(0);
  });

  it('rejects untrusted fields, malformed metadata and invalid ranges', () => {
    for (const invalid of [
      { ...visualRequest, path: '/secret' },
      {
        ...visualRequest,
        reference: { ...visualRequest.reference, path: '/secret' },
      },
      {
        ...visualRequest,
        reference: { ...visualRequest.reference, visualId: 'bad' },
      },
      {
        ...visualRequest,
        reference: {
          ...visualRequest.reference,
          heights: Array.from({ length: 33 }, () => [1, 1]),
        },
      },
      {
        ...visualRequest,
        reference: { ...visualRequest.reference, heights: [[1, 2, 3]] },
      },
      { ...visualRequest, offset: 5 },
      { ...visualRequest, limit: 0 },
      { ...visualRequest, limit: 1_048_577 },
      {
        ...visualRequest,
        archivedContainerId: 'worktree-1',
        standaloneHistory: true,
      },
    ])
      expect(() => validateChatVisualReadRequest(invalid)).toThrow();
  });
});

describe('transcript page boundary validation', () => {
  const scope = {
    workspaceId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  it('rejects the same invalid scope and paging combinations as legacy IPC', () => {
    const invalid = [
      { scope: { ...scope, workspaceId: '../outside' } },
      { scope: { ...scope, workspaceId: 'a'.repeat(257) } },
      { scope, turnId: 'turn-1' },
      { scope, view: 'turns', turnId: '../bad' },
      { scope, archivedContainerId: 'another-worktree' },
      { scope, archivedContainerId: scope.worktreeId, standaloneHistory: true },
    ];
    for (const params of invalid) {
      expect(CoreChatTranscriptPageParamsSchema.safeParse(params).success).toBe(
        false,
      );
      const { scope: candidateScope, ...fields } = params;
      expect(() =>
        validateChatTranscriptPageRequest({
          projectId: candidateScope.workspaceId,
          worktreeId: candidateScope.worktreeId,
          chatId: candidateScope.chatId,
          ...fields,
        }),
      ).toThrow();
    }
  });
});

describe('assertUntrustedChatInput', () => {
  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSteeringActor', { agentSteeringActor: { kind: 'bot' } }],
    ['agentSent', { agentSent: { sender: { kind: 'project' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    [
      'agent-sender-context',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'untrusted instruction',
        },
      },
    ],
  ] as const)('rejects %s on a nested seeded message', (_name, forged) => {
    expect(() =>
      assertUntrustedChatInput({
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          seedTab: {
            id: 'chat-1',
            messages: [{ id: 'message-1', ...forged }],
          },
        },
      }),
    ).toThrow();
  });

  it('preserves comment and watcher hidden-context kinds', () => {
    expect(() =>
      assertUntrustedChatInput({
        hiddenContext: { kind: 'comment', text: 'review note' },
      }),
    ).not.toThrow();
    expect(() =>
      assertUntrustedChatInput({
        hiddenContext: { kind: 'canopy-watcher-event', text: 'watcher note' },
        watcherFired: { kind: 'Chat completion (Watched task)' },
      }),
    ).not.toThrow();
  });

  it('does not scan arbitrary body or tool-result JSON', () => {
    expect(() =>
      assertUntrustedChatInput({
        id: 'chat-1',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            blocks: [
              {
                type: 'tool_result',
                content: {
                  userMessageSource: 'agent',
                  agentSent: { sender: { kind: 'project' } },
                  hiddenContext: { kind: 'agent-sender-context' },
                },
              },
            ],
          },
        ],
        arbitraryBody: {
          agentSenderProvenance: { version: 1 },
        },
      }),
    ).not.toThrow();
  });

  it('rejects provenance in known queued request payloads', () => {
    expect(() =>
      assertUntrustedChatInput({
        id: 'chat-1',
        messages: [],
        inputDelivery: {
          version: 1,
          epoch: 0,
          rows: [
            {
              id: 'row-1',
              payload: { agentSenderProvenance: { version: 1 } },
              attempts: [],
            },
          ],
        },
      }),
    ).toThrow('agentSenderProvenance');
  });

  it('handles repeated tabs and cyclic known command links', () => {
    const tab: Record<string, unknown> = { id: 'chat-1', messages: [] };
    const command: Record<string, unknown> = {
      type: 'chat.create_tab',
      tabId: 'chat-1',
      seedTab: tab,
    };
    command.replacementTab = command;

    expect(() =>
      assertUntrustedChatInput({ command, seedTab: tab }),
    ).not.toThrow();
  });
});

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

const snapshot: ChatStateSnapshot = {
  schemaVersion: 1,
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  revision: 2,
  tabsFile: { version: 1, revision: 2, tabs: [], activeTabId: '' },
  archives: [],
  runtimeByChatId: {},
  queue: [],
};

const command: ChatCommandRequest = {
  schemaVersion: 1,
  commandId: 'command-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  expectedRevision: 1,
  command: {
    type: 'chat.send_message',
    chatId: 'chat-1',
    userMessageId: 'message-1',
    text: 'hello',
  },
};

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = mockedRegisterIpcHandler.mock.calls.find(
    ([candidate]) => candidate === channel,
  )?.[1];
  if (!handler) throw new Error(`Missing ${channel} handler`);
  return (...args: unknown[]): unknown =>
    Reflect.apply(handler, undefined, args);
}

describe('plan review message validation', () => {
  it('accepts only a bounded, complete approval identity', () => {
    const approval = {
      requestId: 'review-1',
      planId: 'plan-1',
      revisionNumber: 2,
    };
    const requestWith = (planReviewApproval: unknown): unknown => ({
      ...command,
      command: { ...command.command, planReviewApproval },
    });
    expect(() =>
      validateChatCommandRequest(requestWith(approval)),
    ).not.toThrow();
    for (const invalid of [
      null,
      {},
      { ...approval, requestId: '' },
      { ...approval, planId: '../outside' },
      { ...approval, revisionNumber: 0 },
      { ...approval, revisionNumber: 1.5 },
      { ...approval, secretPath: '/host/file' },
    ]) {
      expect(() => validateChatCommandRequest(requestWith(invalid))).toThrow();
    }
  });
});

describe('revisioned chat-state IPC adapter', () => {
  const activeSubscriptions = new Set<symbol>();

  afterAll(() => {
    expect(activeSubscriptions.size).toBe(0);
  });
  let listener: ((event: ChatStateChangedEvent) => void) | undefined;
  let port: ChatStateCommandPort;
  const getState = jest.fn(
    (): Promise<ChatStateSnapshot> => Promise.resolve(snapshot),
  );
  const execute = jest.fn(
    (request: ChatCommandRequest): Promise<ChatCommandResult> =>
      Promise.resolve({
        commandId: request.commandId,
        revision: 2,
        outcome: 'applied',
      }),
  );
  const firstSend = jest.fn();
  const secondSend = jest.fn();
  const windows = [
    {
      isDestroyed: (): boolean => false,
      webContents: { isDestroyed: (): boolean => false, send: firstSend },
    },
    {
      isDestroyed: (): boolean => false,
      webContents: { isDestroyed: (): boolean => false, send: secondSend },
    },
  ];
  // Each registration runs a reopening event push until it is disposed; a
  // leaked one keeps writing to stderr in later test files on this worker.
  const teardowns: Array<() => Promise<void>> = [];
  const register = (
    ...args: Parameters<typeof registerChatStateHandlers>
  ): ReturnType<typeof registerChatStateHandlers> => {
    const dispose = registerChatStateHandlers(...args);
    teardowns.push(async () => {
      dispose();
      await args[2].dispatcher.shutdown();
    });
    return dispose;
  };

  afterEach(async () => {
    for (const teardown of teardowns.splice(0).reverse()) await teardown();
    expect(listener).toBeUndefined();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    listener = undefined;
    port = {
      getState,
      searchTranscript: jest
        .fn()
        .mockResolvedValue({ matches: [], totalCount: 0 }),
      getTranscriptPage: jest.fn().mockResolvedValue({
        messages: [],
        totalMessages: 0,
        transcriptRevision: 2,
      }),
      readToolOutput: jest.fn().mockResolvedValue({
        text: 'page',
        byteLength: 80000,
        nextOffset: 65536,
      }),
      readVisual: jest.fn().mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3, 4]),
        offset: 0,
        length: 4,
        byteLength: 4,
        sha256: 'a'.repeat(64),
      }),
      command: execute,
      subscribe: (next): (() => void) => {
        const subscription = Symbol('chat-state subscription');
        activeSubscriptions.add(subscription);
        listener = next;
        return (): void => {
          activeSubscriptions.delete(subscription);
          listener = undefined;
        };
      },
    };
    register(port, () => windows, {
      dispatcher: createDesktopRuntime({
        getChatStatePort: () => port,
        chatCommandPort: port,
      }),
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read', 'core.chat.write'],
      }),
    });
  });

  it('dispatches mapped desktop commands with the trusted IPC caller and preserves receipts', async () => {
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatCommandPort: port,
    });
    const caller = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-web-contents:42',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop' as const,
      grants: ['core.chat.write'],
    };
    const resolveCaller = jest.fn(() => caller);
    mockedRegisterIpcHandler.mockClear();
    register(port, () => windows, {
      dispatcher: runtime,
      resolveCaller,
    });

    const receipt = await handlerFor(IPC_CHANNELS.chatCommand)(
      { sender: { id: 42 } },
      command,
    );

    expect(resolveCaller).toHaveBeenCalledWith({ sender: { id: 42 } });
    expect(execute).toHaveBeenCalledWith(command);
    expect(receipt).toEqual({
      commandId: 'command-1',
      revision: 2,
      outcome: 'applied',
    });
  });

  it('validates canonical search requests and fences cancellation by renderer', async () => {
    let signal: AbortSignal | undefined;
    const searchSpy = jest
      .spyOn(port, 'searchTranscript')
      .mockImplementation((_request, captured) => {
        signal = captured;
        return new Promise(() => undefined);
      });
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      query: 'needle',
      requestId: 'search-1',
    };
    const pending = handlerFor(IPC_CHANNELS.chatSearchTranscript)(
      { sender: { id: 1 } },
      request,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handlerFor(IPC_CHANNELS.chatCancelTranscriptSearch)(
      { sender: { id: 2 } },
      'search-1',
    );
    expect(signal?.aborted).toBe(false);
    await handlerFor(IPC_CHANNELS.chatCancelTranscriptSearch)(
      { sender: { id: 1 } },
      'search-1',
    );
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      handlerFor(IPC_CHANNELS.chatSearchTranscript)(
        { sender: { id: 1 } },
        { ...request, query: 'x'.repeat(257) },
      ),
    ).rejects.toThrow();
    await expect(
      handlerFor(IPC_CHANNELS.chatSearchTranscript)(
        { sender: { id: 1 } },
        { ...request, filePath: '/private/path' },
      ),
    ).rejects.toThrow();
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate sender request while the first search is active', async () => {
    jest
      .spyOn(port, 'searchTranscript')
      .mockImplementation(() => new Promise(() => undefined));
    const event = { sender: { id: 5 } };
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      query: 'needle',
      requestId: 'search-duplicate',
    };
    const first = handlerFor(IPC_CHANNELS.chatSearchTranscript)(event, request);
    await expect(
      handlerFor(IPC_CHANNELS.chatSearchTranscript)(event, request),
    ).rejects.toThrow('Duplicate search request.');
    await handlerFor(IPC_CHANNELS.chatCancelTranscriptSearch)(
      event,
      request.requestId,
    );
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('validates and delegates snapshot queries exactly once', async () => {
    const result = await handlerFor(IPC_CHANNELS.chatGetState)(
      { sender: { id: 1 } },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    );
    expect(result).toEqual(snapshot);
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('delegates bounded transcript and artifact queries without passing filesystem paths', async () => {
    const scope = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const reference = {
      version: 1,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 80000,
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const pageCalls = jest.spyOn(port, 'getTranscriptPage');
    const outputCalls = jest.spyOn(port, 'readToolOutput');
    const pageRequest = { ...scope, before: 500, transcriptRevision: 2 };
    await handlerFor(IPC_CHANNELS.chatGetTranscriptPage)(
      undefined,
      pageRequest,
    );
    expect(pageCalls).toHaveBeenCalledWith(pageRequest);
    const outputRequest = {
      ...scope,
      messageId: 'chat-1:mut-1:3',
      toolUseId: 'toolu_01AbC',
      requestId: 'request-1',
      reference,
      offset: 0,
      limit: 65536,
    };
    await handlerFor(IPC_CHANNELS.chatReadToolOutput)(
      { sender: { id: 7 } },
      outputRequest,
    );
    expect(outputCalls).toHaveBeenCalledWith(
      outputRequest,
      expect.any(AbortSignal),
    );
    for (const invalid of [
      { ...outputRequest, limit: 65537 },
      { ...outputRequest, offset: -1 },
      {
        ...outputRequest,
        reference: { ...reference, artifactId: '../secret' },
      },
      { ...outputRequest, reference: { ...reference, path: '/secret' } },
      { ...outputRequest, chatId: '../chat' },
    ])
      await expect(
        Promise.resolve(
          handlerFor(IPC_CHANNELS.chatReadToolOutput)(
            { sender: { id: 7 } },
            invalid,
          ),
        ),
      ).rejects.toThrow();
    expect(outputCalls).toHaveBeenCalledTimes(1);
    expect(() =>
      handlerFor(IPC_CHANNELS.chatGetTranscriptPage)(undefined, {
        ...scope,
        before: -1,
      }),
    ).toThrow();
  });

  it('cancels only the matching renderer tool-output read', async () => {
    let observedSignal: AbortSignal | undefined;
    jest
      .spyOn(port, 'readToolOutput')
      .mockImplementation((_request, signal) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        });
      });
    const reference = {
      version: 1,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 80000,
      encoding: 'utf-8',
      mediaType: 'text/plain',
    };
    const pending = handlerFor(IPC_CHANNELS.chatReadToolOutput)(
      { sender: { id: 7 } },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        requestId: 'request-1',
        reference,
        offset: 0,
        limit: 65536,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedSignal?.aborted).toBe(false);
    await handlerFor(IPC_CHANNELS.chatCancelToolOutput)(
      { sender: { id: 8 } },
      { requestId: 'request-1' },
    );
    expect(observedSignal?.aborted).toBe(false);
    await handlerFor(IPC_CHANNELS.chatCancelToolOutput)(
      { sender: { id: 7 } },
      { requestId: 'request-1' },
    );
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('keeps visual read failures sanitized for the renderer', async () => {
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatCommandPort: port,
    });
    jest
      .spyOn(port, 'readVisual')
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "EACCES: permission denied, open '/Users/someone/chat-storage-v2/scope/transcripts/visuals/chat-1/x.html'",
          ),
          { code: 'EACCES' },
        ),
      );
    mockedRegisterIpcHandler.mockClear();
    const dispose = registerChatStateHandlers(port, () => windows, {
      dispatcher: runtime,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
    try {
      await expect(
        handlerFor(IPC_CHANNELS.chatReadVisual)(
          { sender: { id: 7 } },
          visualRequest,
        ),
      ).rejects.toMatchObject({ message: 'Chat visual read failed.' });
    } finally {
      dispose();
    }
  });

  it('routes visual reads through the canonical dispatcher, not direct IPC service access', async () => {
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatCommandPort: port,
    });
    const query = jest.spyOn(runtime, 'query');
    const serviceRead = jest.spyOn(port, 'readVisual');
    mockedRegisterIpcHandler.mockClear();
    const dispose = registerChatStateHandlers(port, () => windows, {
      dispatcher: runtime,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
    try {
      const result = await handlerFor(IPC_CHANNELS.chatReadVisual)(
        { sender: { id: 7 } },
        visualRequest,
      );
      expect(query.mock.calls[0]?.[0]).toBe('core.chat.visual.read');
      expect(query.mock.calls[0]?.[1]).toMatchObject({
        scope: {
          workspaceId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        reference: visualRequest.reference,
        offset: 0,
        limit: 4,
      });
      expect(query.mock.calls[0]?.[2].caller).toMatchObject({
        principalId: 'test-user',
      });
      expect(query.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
      expect(serviceRead).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        data: 'AQIDBA==',
        offset: 0,
        length: 4,
        byteLength: 4,
        sha256: 'a'.repeat(64),
      });
    } finally {
      dispose();
    }
  });

  it('aborts an in-flight visual read when chat handlers are torn down', async () => {
    let observedSignal: AbortSignal | undefined;
    jest.spyOn(port, 'readVisual').mockImplementation((_request, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      });
    });
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatCommandPort: port,
    });
    mockedRegisterIpcHandler.mockClear();
    const dispose = registerChatStateHandlers(port, () => windows, {
      dispatcher: runtime,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
    const pending = handlerFor(IPC_CHANNELS.chatReadVisual)(
      { sender: { id: 7 } },
      visualRequest,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedSignal?.aborted).toBe(false);
    dispose();
    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a duplicate tool-output request from the same renderer', async () => {
    let release: (() => void) | undefined;
    jest.spyOn(port, 'readToolOutput').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = (): void => resolve({ text: 'page', byteLength: 4 });
        }),
    );
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      toolUseId: 'tool-1',
      requestId: 'request-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        byteLength: 4,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    const read = handlerFor(IPC_CHANNELS.chatReadToolOutput);
    const pending = read({ sender: { id: 7 } }, request);
    await expect(read({ sender: { id: 7 } }, request)).rejects.toThrow(
      'Duplicate tool output request',
    );
    release?.();
    await expect(pending).resolves.toEqual({ text: 'page', byteLength: 4 });
  });

  it('keeps a cancelled tool-output request reserved until its backend read settles', async () => {
    let release: (() => void) | undefined;
    const readToolOutput = jest
      .spyOn(port, 'readToolOutput')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = (): void => resolve({ text: 'page', byteLength: 4 });
          }),
      );
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      toolUseId: 'tool-1',
      requestId: 'request-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        byteLength: 4,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    const read = handlerFor(IPC_CHANNELS.chatReadToolOutput);
    const pending = read({ sender: { id: 7 } }, request);
    let pendingSettled = false;
    const pendingOutcome = Promise.resolve(pending).then(
      (result) => {
        pendingSettled = true;
        return result;
      },
      (error: unknown) => {
        pendingSettled = true;
        return error;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readToolOutput).toHaveBeenCalledTimes(1);
    await handlerFor(IPC_CHANNELS.chatCancelToolOutput)(
      { sender: { id: 7 } },
      { requestId: 'request-1' },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pendingSettled).toBe(false);
    const retry = read({ sender: { id: 7 } }, request);
    const retryOutcome = Promise.resolve(retry).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrentCalls = readToolOutput.mock.calls.length;
    release?.();
    await expect(pendingOutcome).resolves.toEqual({
      text: 'page',
      byteLength: 4,
    });
    await expect(retryOutcome).resolves.toThrow(
      'Duplicate tool output request',
    );
    expect(concurrentCalls).toBe(1);
  });

  it('validates and delegates commands exactly once without changing outcomes', async () => {
    const result = await handlerFor(IPC_CHANNELS.chatCommand)(
      undefined,
      command,
    );
    expect(result).toEqual({
      commandId: 'command-1',
      revision: 2,
      outcome: 'applied',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(command);
  });

  it('routes a create command through the dispatcher with its CAS envelope intact', async () => {
    const create: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'create-routed',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      expectedRevision: 1,
      command: { type: 'chat.create_tab', tabId: 'chat-2', title: 'New chat' },
    };
    await expect(
      handlerFor(IPC_CHANNELS.chatCommand)(undefined, create),
    ).resolves.toEqual({
      commandId: 'create-routed',
      revision: 2,
      outcome: 'applied',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(create);
  });

  it.each([
    'applied',
    'already_applied',
    'conflict',
    'not_found',
    'rejected',
  ] as const)('preserves the %s terminal outcome', async (outcome) => {
    execute.mockResolvedValueOnce({
      commandId: command.commandId,
      revision: 9,
      outcome,
      reason: outcome === 'applied' ? undefined : 'safe reason',
    });
    await expect(
      handlerFor(IPC_CHANNELS.chatCommand)(undefined, command),
    ).resolves.toEqual({
      commandId: command.commandId,
      revision: 9,
      outcome,
      reason: outcome === 'applied' ? undefined : 'safe reason',
    });
  });

  it('preserves a typed backend load error instead of returning empty state', async () => {
    const loadError = {
      name: 'ChatStateLoadError',
      code: 'recovery_error',
      message: 'Chat state could not be recovered.',
      retryable: false,
    } as const;
    getState.mockRejectedValueOnce(loadError);
    await expect(
      handlerFor(IPC_CHANNELS.chatGetState)(
        { sender: { id: 1 } },
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ),
    ).rejects.toBe(loadError);
  });

  it('rejects unsupported versions, invalid revisions, oversized ids, and snapshot-shaped commands', () => {
    expect(() =>
      validateChatCommandRequest({ ...command, schemaVersion: 2 }),
    ).toThrow('schemaVersion');
    expect(() =>
      validateChatCommandRequest({ ...command, expectedRevision: -1 }),
    ).toThrow('expectedRevision');
    expect(() =>
      validateChatGetStateRequest({
        projectId: 'p'.repeat(257),
        worktreeId: 'worktree-1',
      }),
    ).toThrow('projectId');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: { ...command.command, tabs: [] },
      }),
    ).toThrow('unexpected');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          ...command.command,
          text: 'x'.repeat(1024 * 1024),
        },
      }),
    ).toThrow('payload-size');
  });

  it('rejects a main-only steering actor from renderer steer commands', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.steer_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-1',
          agentSteeringActor: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'task-1',
            chatId: 'sender-chat',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects main-only auto-routing fields from renderer chat commands', () => {
    for (const field of [
      { preserveModelSelectionMode: true },
      { autoRoutedMessageId: 'message-id' },
    ]) {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.set_model',
            tabId: 'tab-id',
            model: 'model',
            providerType: 'claude',
            ...field,
          },
        }),
      ).toThrow('unexpected');
    }
  });

  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSent', { agentSent: { sender: { kind: 'bot' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    [
      'hiddenContext',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'forged sender context',
        },
      },
    ],
  ] as const)(
    'rejects forged %s on nested seeded history before dispatch',
    async (field, attribution) => {
      const message = Object.assign(
        {
          id: 'message-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Existing history' }],
          timestamp: 1,
        },
        attribution,
      );
      const request = {
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          seedTab: {
            id: 'chat-1',
            title: 'Seed',
            createdAt: '2026-10-16T00:00:00.000Z',
            messages: [message],
          },
        },
      };

      await expect(
        handlerFor(IPC_CHANNELS.chatCommand)(undefined, request),
      ).rejects.toThrow(field);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects main-only settings fields from renderer chat commands', () => {
    for (const patch of [
      { description: 'Summary' },
      { pendingRevertAttachmentPath: null },
      { newChatStartedWatcherPending: true },
      { newChatStartedWatcherFiredAt: '2026-09-30T12:00:00Z' },
    ]) {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: { type: 'chat.patch_tab_settings', tabId: 'tab', patch },
        }),
      ).toThrow('unexpected');
    }
  });

  it.each([null, 'My chat', 'x'.repeat(256), '😀'.repeat(128)])(
    'accepts a normalized custom title: %s',
    (customTitle) => {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: 'tab',
            patch: { customTitle },
          },
        }),
      ).not.toThrow();
    },
  );

  it.each([
    '',
    ' ',
    ' leading',
    'trailing ',
    'trailing\n',
    '\uFEFFname',
    'x'.repeat(257),
    '😀'.repeat(129),
    42,
    false,
    {},
    [],
  ])('rejects an invalid custom title: %s', (customTitle) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { customTitle },
        },
      }),
    ).toThrow();
  });

  it('accepts a persisted diff context without optional repository or rename fields', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: {
            fileViewMode: 'diff',
            fileDiffContext: { path: 'README.md', source: 'uncommitted' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts canonical message and block ids as command anchors', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'chat-2',
          atMessageId: 'chat-1:provider-output:1',
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.reset_to_point',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          blockId: 'chat-1:tool-use:2',
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: { pinned: true, fileViewMode: 'preview' },
        },
      }),
    ).not.toThrow();
    // Entering and leaving per-turn Auto routing is an ordinary tab-settings
    // patch from the composer, so the IPC allowlist must carry the key or the
    // renderer's optimistic Auto state can never commit.
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelSelectionMode: 'auto' },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelSelectionMode: null },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelSelectionMode: 'manual' },
        },
      }),
    ).toThrow('command.patch.modelSelectionMode is unsupported.');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'chat-2',
          atMessageId: 'chat-1:provider-output:\u0000',
        },
      }),
    ).toThrow('control characters');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'chat-2',
          atMessageId: 'chat-1 provider-output',
        },
      }),
    ).toThrow('unsafe anchor id');
  });

  it('accepts bounded continuation metadata for canonical transcript forks', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.fork_tab',
          sourceTabId: 'chat-1',
          targetTabId: 'chat-2',
          atMessageId: 'message-2',
          cloneMode: 'continuation',
          destinationTab: {
            id: 'chat-2',
            title: 'Codex: Continue the task',
            messages: [],
            createdAt: '2026-09-09T00:00:00.000Z',
            providerType: 'codex',
            model: 'gpt-5.5',
            deferredToolsAllowed: false,
            subscriptionBillingOverride: true,
            disabledGlobalPluginSelections: {
              pluginRefs: [
                { marketplaceId: 'market', pluginName: 'source-only' },
              ],
            },
            forkedFrom: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              atMessageId: 'message-2',
              continuedFromProvider: 'claude',
              resumePointRequired: true,
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    {
      type: 'chat.set_model',
      tabId: 'chat-1',
      model: 'cursor-default',
      providerType: 'cursor',
    },
    {
      type: 'chat.create_tab',
      tabId: 'chat-1',
      model: 'cursor-default',
      providerType: 'cursor',
    },
    {
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { providerType: 'cursor', model: 'cursor-default' },
    },
    {
      type: 'chat.create_tab',
      tabId: 'chat-1',
      seedTab: {
        id: 'chat-1',
        title: 'Cursor',
        messages: [],
        createdAt: '2026-09-10T00:00:00Z',
        providerType: 'cursor',
        executionHarness: 'cursor',
        model: 'cursor-default',
      },
    },
  ])('accepts Cursor identity through $type', (cursorCommand) => {
    expect(() =>
      validateChatCommandRequest({ ...command, command: cursorCommand }),
    ).not.toThrow();
  });

  it.each([
    {
      type: 'chat.set_model',
      tabId: 'chat-1',
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
    },
    {
      type: 'chat.create_tab',
      tabId: 'chat-1',
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
    },
    {
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { providerType: 'opencode', model: 'opencode:fixture%2Fmodel' },
    },
    {
      type: 'chat.create_tab',
      tabId: 'chat-1',
      seedTab: {
        id: 'chat-1',
        title: 'OpenCode',
        messages: [],
        createdAt: '2026-09-10T00:00:00Z',
        providerType: 'opencode',
        executionHarness: 'opencode',
        model: 'opencode:fixture%2Fmodel',
      },
    },
  ])('accepts OpenCode identity through $type', (opencodeCommand) => {
    expect(() =>
      validateChatCommandRequest({ ...command, command: opencodeCommand }),
    ).not.toThrow();
  });

  it.each(['claude', 'codex'])(
    'accepts a canonical %s harness choice and rejects unsupported values',
    (harness) => {
      const request = {
        ...command,
        command: {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gateway-model',
          providerType: harness,
          executionHarness: harness,
        },
      };
      expect(() => validateChatCommandRequest(request)).not.toThrow();
      expect(() =>
        validateChatCommandRequest({
          ...request,
          command: { ...request.command, executionHarness: 'ollama' },
        }),
      ).toThrow('executionHarness is unsupported');
    },
  );

  it('accepts an explicit seeded draft harness and validates its boolean marker', () => {
    const seedTab = {
      id: 'chat-1',
      title: 'Draft',
      messages: [],
      createdAt: '2026-09-10T00:00:00Z',
      model: 'gateway-model',
      executionHarness: 'claude',
      executionHarnessExplicitlyChosen: true,
    };
    const request = {
      ...command,
      command: { type: 'chat.create_tab', tabId: 'chat-1', seedTab },
    };
    expect(() => validateChatCommandRequest(request)).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...request,
        command: {
          ...request.command,
          seedTab: { ...seedTab, executionHarnessExplicitlyChosen: 'false' },
        },
      }),
    ).toThrow('must be a boolean');
  });

  it('accepts the inherited plugin defaults marker on a seeded tab and validates it', () => {
    const seedTab = {
      id: 'chat-1',
      title: 'Branch',
      messages: [],
      createdAt: '2026-09-10T00:00:00Z',
      inheritedPluginDefaultsVersion: 1,
    };
    const request = {
      ...command,
      command: { type: 'chat.create_tab', tabId: 'chat-1', seedTab },
    };
    expect(() => validateChatCommandRequest(request)).not.toThrow();
    for (const invalid of [0, 1.5, '1']) {
      expect(() =>
        validateChatCommandRequest({
          ...request,
          command: {
            ...request.command,
            seedTab: { ...seedTab, inheritedPluginDefaultsVersion: invalid },
          },
        }),
      ).toThrow('inheritedPluginDefaultsVersion must be a positive integer');
    }
  });

  it('accepts a model-change notice in the revisioned set-model command', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'claude-sonnet-4-5-20250514',
          providerType: 'claude',
          notice: {
            id: 'model-change-notice-1',
            timestamp: 1_787_136_000_000,
            text: 'The selected model is no longer available.',
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts host-owned fields in the revisioned create-tab command', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-new',
          model: 'claude-opus-4-6',
          defaultStampModel: 'claude-opus-4-6',
          approvalMode: 'full-access',
        },
      }),
    ).not.toThrow();
  });

  it('accepts a complete seeded tab in the revisioned create-tab command', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-new',
          seedTab: {
            id: 'chat-new',
            title: 'Branched chat',
            createdAt: '2026-09-02T12:00:00.000Z',
            messages: [
              {
                id: 'source-user',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Cloned transcript' }],
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it('only accepts a projected seed file path from trusted main', () => {
    const request = {
      ...command,
      command: {
        type: 'chat.create_tab',
        tabId: 'file-seed',
        seedTab: {
          id: 'file-seed',
          title: 'File',
          createdAt: '2026-09-30T00:00:00.000Z',
          messages: [],
          filePath: '/root/file.ts',
        },
      },
    };
    expect(() => validateChatCommandRequest(request)).toThrow(
      'unexpected field "filePath"',
    );
    expect(() =>
      validateChatCommandRequest(request, { allowMainOnlyFields: true }),
    ).not.toThrow();
  });

  it('accepts a complete branch seed larger than the ordinary command cap', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-large-branch',
          seedTab: {
            id: 'chat-large-branch',
            title: 'Large branched chat',
            createdAt: '2026-09-03T00:00:00.000Z',
            messages: [
              {
                id: 'source-user',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }],
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ['host-owned approval mode', { approvalMode: 'full-access' }],
    [
      'host-owned session approval rules',
      {
        sessionApprovalRules: [
          {
            id: 'rule-1',
            behavior: 'allow',
            target: { kind: 'tool', toolName: 'exec_command' },
            createdAt: '2026-09-02T12:00:00.000Z',
            origin: 'session',
          },
        ],
      },
    ],
    ['file-tab metadata', { kind: 'file', filePath: '/tmp/escaped' }],
    ['malformed plugin selections', { pluginSelections: [] }],
    ['an unknown field', { injected: true }],
  ])('rejects a seeded tab carrying %s', (_label, extraSeedFields) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-new',
          seedTab: {
            id: 'chat-new',
            title: 'Branched chat',
            createdAt: '2026-09-02T12:00:00.000Z',
            messages: [],
            ...extraSeedFields,
          },
        },
      }),
    ).toThrow();
  });

  it.each([
    ['title', 7],
    ['providerType', 'invalid-provider'],
    ['model', 7],
    ['modelConfig', 'invalid-config'],
    ['planMode', 'yes'],
    ['proposalMode', 'sometimes'],
    ['pluginSelections', []],
    ['deferredToolsAllowed', 'yes'],
    ['interfaceMode', 'terminal'],
    ['approvalMode', 'full_access'],
  ])('rejects a malformed chat.create_tab %s field', (field, value) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-new',
          [field]: value,
        },
      }),
    ).toThrow();
  });

  it('validates every target in an atomic bulk close command', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.close_tabs',
          targets: [
            { tabId: 'chat-1', mode: 'archive' },
            { tabId: 'file-1', mode: 'discard_empty' },
          ],
          replacementTabId: 'chat-3',
          replacementTab: {
            type: 'chat.create_tab',
            tabId: 'chat-3',
            providerType: 'codex',
            model: 'gpt-6-sol',
            pluginSelections: {
              collectionIds: ['collection-1'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.close_tabs',
          targets: [{ tabId: '../../chat-1', mode: 'archive' }],
        },
      }),
    ).toThrow('unsafe id');
  });

  it.each([
    ['projectId', '../../tmp/escaped-project', 'worktree-1'],
    ['worktreeId', 'project-1', '..\\..\\escaped-worktree'],
  ] as const)(
    'rejects path traversal in %s at both renderer-facing entry points',
    (_field, projectId, worktreeId) => {
      expect(() =>
        validateChatGetStateRequest({ projectId, worktreeId }),
      ).toThrow('invalid');
      expect(() =>
        validateChatCommandRequest({ ...command, projectId, worktreeId }),
      ).toThrow('invalid');
    },
  );

  it('rejects unsafe command and nested entity ids at the IPC boundary', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        commandId: '../command',
      }),
    ).toThrow('invalid commandId');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.send_message',
          chatId: '../chat',
          userMessageId: 'message-1',
          text: 'unsafe',
        },
      }),
    ).toThrow('invalid command.chatId');
  });

  it.each(['archive', 'discard_empty', 'discard'] as const)(
    'accepts the contract close mode %s',
    (mode) => {
      expect(
        validateChatCommandRequest({
          ...command,
          command: { type: 'chat.close_tab', tabId: 'chat-1', mode },
        }).command,
      ).toEqual({ type: 'chat.close_tab', tabId: 'chat-1', mode });
    },
  );

  it('accepts the canonical unread transition command', () => {
    expect(
      validateChatCommandRequest({
        ...command,
        command: { type: 'chat.mark_unread', chatId: 'chat-1' },
      }).command,
    ).toEqual({ type: 'chat.mark_unread', chatId: 'chat-1' });
  });

  it('accepts a canonical provider session-id patch', () => {
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { sdkSessionId: 'thread-forked-1' },
        },
      }).command,
    ).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { sdkSessionId: 'thread-forked-1' },
    });
  });

  it.each([true, null])(
    'accepts a canonical auto-archive patch value %s',
    (autoArchive) => {
      expect(
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { autoArchive },
          },
        }).command,
      ).toEqual({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive },
      });
    },
  );

  it('accepts an empty global-instructions snapshot', () => {
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { globalInstructionsSnapshot: '' },
        },
      }).command,
    ).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { globalInstructionsSnapshot: '' },
    });
  });

  it('accepts canonical shared-run comment metadata', () => {
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            sharedRun: {
              externalId: 'run-1',
              shareScope: 'team',
              sharedAt: '2026-08-16T00:00:00.000Z',
              commentRevision: 4,
              unreadCommentCount: 0,
            },
          },
        },
      }).command,
    ).toEqual(
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        patch: expect.objectContaining({
          sharedRun: expect.objectContaining({
            commentRevision: 4,
            unreadCommentCount: 0,
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('rejects non-allowlisted settings and main-derived send fields', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { status: 'streaming' },
        },
      }),
    ).toThrow('unexpected');
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: { ...command.command, providerType: 'claude' },
      }),
    ).toThrow('unexpected');
  });

  it('accepts file-tab filePath/title patches and empty create_file_tab paths', () => {
    // The chat-tab rejection for these fields is a reducer invariant (they
    // are file-tab-only); IPC validation only checks shape.
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: { filePath: '/tmp/notes.md', title: 'notes.md' },
        },
      }).command,
    ).toEqual(
      expect.objectContaining({
        patch: { filePath: '/tmp/notes.md', title: 'notes.md' },
      }),
    );
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'file-1',
          patch: { filePath: '' },
        },
      }),
    ).toThrow('bounded');
    // Empty is the deliberate empty-file-tab state at creation only.
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.create_file_tab',
          tabId: 'file-1',
          filePath: '',
          title: 'New file',
        },
      }).command,
    ).toEqual(expect.objectContaining({ filePath: '' }));
  });

  it.each([true, false])(
    'accepts file-tab activate=%s at the legacy IPC boundary',
    (activate) => {
      expect(
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.create_file_tab',
            tabId: 'file-1',
            filePath: '/tmp/report.md',
            title: 'Report',
            activate,
          },
        }).command,
      ).toMatchObject({ type: 'chat.create_file_tab', activate });
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.create_file_tab',
            tabId: 'file-1',
            filePath: '/tmp/report.md',
            title: 'Report',
            activate: 'false',
          },
        }),
      ).toThrow('command.activate');
    },
  );

  it('rejects an unsupported nested model thinking level', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { thinkingLevel: 42 } },
        },
      }),
    ).toThrow('command.patch.modelConfig.thinkingLevel is unsupported');
  });

  describe('Codex speed model config', () => {
    const modelConfigSites: Array<{
      label: string;
      build: (modelConfig: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        label: 'command.seedTab.modelConfig',
        build: (modelConfig) => ({
          type: 'chat.create_tab',
          tabId: 'chat-new',
          seedTab: {
            id: 'chat-new',
            title: 'Branched chat',
            createdAt: '2026-09-30T00:00:00.000Z',
            messages: [],
            modelConfig,
          },
        }),
      },
      {
        label: 'command.modelConfig',
        build: (modelConfig) => ({
          type: 'chat.create_tab',
          tabId: 'chat-new',
          modelConfig,
        }),
      },
      {
        label: 'command.modelConfig',
        build: (modelConfig) => ({ ...command.command, modelConfig }),
      },
      {
        label: 'command.patch.modelConfig',
        build: (modelConfig) => ({
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig },
        }),
      },
      {
        label: 'command.settings.modelConfig',
        build: (modelConfig) => ({
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt-5.5',
          providerType: 'codex',
          settings: {
            thinkingLevel: 'high',
            modelConfig: {
              thinkingLevel: 'high',
              fastMode: false,
              ...modelConfig,
            },
            codexFastModeEnabled:
              modelConfig.fastMode ?? modelConfig.speed === 'fast',
            interfaceMode: null,
          },
        }),
      },
    ];

    function validateAt(
      site: (typeof modelConfigSites)[number],
      modelConfig: Record<string, unknown>,
    ): void {
      validateChatCommandRequest({
        ...command,
        command: site.build(modelConfig),
      });
    }

    it.each(modelConfigSites)(
      'accepts an exact speed with its derived fastMode in $label',
      (site) => {
        for (const modelConfig of [
          { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
          { thinkingLevel: 'high', speed: 'fast', fastMode: true },
          { thinkingLevel: 'high', speed: 'standard', fastMode: false },
        ]) {
          expect(() => validateAt(site, modelConfig)).not.toThrow();
        }
      },
    );

    it.each(modelConfigSites)(
      'keeps boolean-only legacy commands valid in $label',
      (site) => {
        for (const fastMode of [true, false]) {
          expect(() =>
            validateAt(site, { thinkingLevel: 'high', fastMode }),
          ).not.toThrow();
        }
      },
    );

    it.each(modelConfigSites)(
      'rejects an unsupported speed in $label',
      (site) => {
        for (const speed of ['turbo', 'priority', 7, null]) {
          expect(() =>
            validateAt(site, { thinkingLevel: 'high', speed, fastMode: false }),
          ).toThrow(`${site.label}.speed is unsupported`);
        }
      },
    );

    it.each(modelConfigSites)(
      'rejects a fastMode that contradicts the speed in $label',
      (site) => {
        for (const modelConfig of [
          { thinkingLevel: 'high', speed: 'ultrafast', fastMode: true },
          { thinkingLevel: 'high', speed: 'fast', fastMode: false },
          { thinkingLevel: 'high', speed: 'standard', fastMode: true },
        ]) {
          expect(() => validateAt(site, modelConfig)).toThrow(
            `${site.label}.fastMode contradicts ${site.label}.speed`,
          );
        }
      },
    );

    it('accepts an exact speed without the legacy boolean', () => {
      for (const site of modelConfigSites.slice(0, 4)) {
        expect(() =>
          validateAt(site, { thinkingLevel: 'high', speed: 'ultrafast' }),
        ).not.toThrow();
      }
    });

    it('rejects a set-model legacy alias that contradicts the exact speed', () => {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.set_model',
            tabId: 'chat-1',
            model: 'gpt-5.5',
            providerType: 'codex',
            settings: {
              thinkingLevel: 'high',
              modelConfig: {
                thinkingLevel: 'high',
                speed: 'ultrafast',
                fastMode: false,
              },
              codexFastModeEnabled: true,
              interfaceMode: null,
            },
          },
        }),
      ).toThrow(
        'command.settings.codexFastModeEnabled contradicts command.settings.modelConfig.speed',
      );
    });

    it('carries a valid retained Codex speed on a seeded tab and rejects others', () => {
      const seedTab = {
        id: 'chat-new',
        title: 'Branched chat',
        createdAt: '2026-09-30T00:00:00.000Z',
        messages: [],
        providerType: 'claude',
        retainedCodexSpeed: 'ultrafast',
      };
      const request = {
        ...command,
        command: { type: 'chat.create_tab', tabId: 'chat-new', seedTab },
      };
      expect(() => validateChatCommandRequest(request)).not.toThrow();
      for (const retainedCodexSpeed of ['turbo', true, 7]) {
        expect(() =>
          validateChatCommandRequest({
            ...request,
            command: {
              ...request.command,
              seedTab: { ...seedTab, retainedCodexSpeed },
            },
          }),
        ).toThrow('command.seedTab.retainedCodexSpeed is unsupported');
      }
    });

    it('keeps the retained Codex speed main-owned in settings patches', () => {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { retainedCodexSpeed: 'ultrafast' },
          },
        }),
      ).toThrow('unexpected field "retainedCodexSpeed"');
    });
  });

  it('accepts GitHub workflow-run carry receipts and rejects non-carry kinds', () => {
    const githubReceipt = {
      version: 1,
      kind: 'github_workflow_run',
      operation: 'github.watch',
      dedupeKey: 'canopy:github_workflow_run:acme%2Fapi:101',
      createdAt: '2026-07-20T00:00:00.000Z',
      watcherId: 'watcher-1',
      repository: 'acme/api',
      runId: '101',
      runAttempt: 1,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      state: { kind: 'terminal', conclusion: 'success' },
      observedAt: '2026-07-20T00:00:05.000Z',
      navigationTarget: {
        kind: 'github_workflow_run',
        repository: 'acme/api',
        runId: '101',
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      },
    };
    expect(
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { agentArtifactCarryByTurn: { 'user-1': [githubReceipt] } },
        },
      }).command,
    ).toEqual(
      expect.objectContaining({
        patch: { agentArtifactCarryByTurn: { 'user-1': [githubReceipt] } },
      }),
    );
    const skillReceipt = {
      version: 1,
      kind: 'skill',
      operation: 'skills.create_custom',
      dedupeKey: 'canopy:skill:installed:custom:review',
      createdAt: '2026-07-20T00:00:00.000Z',
      source: 'installed',
      sourceId: 'custom',
      installedName: 'review',
      name: 'Review',
      canUpdate: true,
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: 'custom',
        skillName: 'review',
      },
    };
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { agentArtifactCarryByTurn: { 'user-1': [skillReceipt] } },
        },
      }),
    ).toThrow('command.patch.agentArtifactCarryByTurn is malformed');
  });

  it('rejects GitHub carry receipts that serialization would truncate or weaken', () => {
    const githubReceipt = {
      version: 1,
      kind: 'github_workflow_run',
      operation: 'github.watch',
      dedupeKey: 'canopy:github_workflow_run:acme%2Fapi:101',
      createdAt: '2026-07-20T00:00:00.000Z',
      watcherId: 'watcher-1',
      repository: 'acme/api',
      runId: '101',
      runAttempt: 1,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      state: { kind: 'terminal', conclusion: 'success' },
      observedAt: '2026-07-20T00:00:05.000Z',
      navigationTarget: {
        kind: 'github_workflow_run',
        repository: 'acme/api',
        runId: '101',
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      },
    };
    const requestWithReceipt = (receipt: unknown): unknown => ({
      ...command,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { agentArtifactCarryByTurn: { 'user-1': [receipt] } },
      },
    });
    const jobs = Array.from({ length: 501 }, (_, index) => ({
      jobId: String(index + 1),
      name: `Job ${index + 1}`,
      status: 'completed',
      conclusion: 'success',
      htmlUrl: `https://github.com/acme/api/actions/runs/101/job/${index + 1}`,
      observedAt: '2026-07-20T00:00:05.000Z',
    }));
    expect(() =>
      validateChatCommandRequest(
        requestWithReceipt({ ...githubReceipt, jobs }),
      ),
    ).toThrow('command.patch.agentArtifactCarryByTurn is malformed');
    expect(() =>
      validateChatCommandRequest(
        requestWithReceipt({
          ...githubReceipt,
          definition: {
            sha: 'a'.repeat(40),
            observedAt: '2026-07-20T00:00:05.000Z',
            jobs: [
              {
                id: 'build',
                template: 'Build',
                names: 'Build',
                needs: [],
                dynamic: false,
              },
            ],
          },
        }),
      ),
    ).toThrow('command.patch.agentArtifactCarryByTurn is malformed');
  });

  it.each([
    ['providerType', 'invalid-provider'],
    ['model', 7],
    ['sdkSessionId', 7],
    ['pluginSelections', true],
    ['selectedRepoId', 7],
    ['aiCreditsRouting', true],
    ['scheduledSendDraft', { runAt: 7 }],
    ['autoArchive', 'yes'],
  ])('rejects a malformed chat.patch_tab_settings %s field', (field, value) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { [field]: value },
        },
      }),
    ).toThrow();
  });

  it.each([
    ['fileReferences', true],
    ['fileReferences', [{ displayPath: 'file.ts' }]],
    ['attachmentPaths', true],
    ['attachmentPaths', ['/tmp/file', 7]],
    ['attachmentPromptContexts', true],
    [
      'attachmentPromptContexts',
      [{ attachmentPath: '/tmp/file', promptKind: 'unknown-kind' }],
    ],
  ])('rejects malformed send attachment metadata in %s', (field, value) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: { ...command.command, [field]: value },
      }),
    ).toThrow();
  });

  it.each(['chat.answer_question', 'chat.dismiss_question'])(
    'rejects unsafe provider question references in %s',
    (type) => {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: {
            type,
            chatId: 'chat-1',
            questionId: 'codex-async:["thread-1","turn-1","call_AbC"]',
            ...(type === 'chat.answer_question'
              ? {
                  answers: [
                    {
                      questionId: '0',
                      question: 'Which scope?',
                      selectedOptions: ['Full'],
                    },
                  ],
                }
              : {}),
          },
        }),
      ).toThrow();
    },
  );

  it.each([
    ['questionId', 7],
    ['freeformText', 7],
    ['selectedOptions', ['x'.repeat(512 * 1024 + 1)]],
  ])('rejects a malformed answer %s field', (field, value) => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        command: {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'request-1',
          answers: [
            {
              question: 'Pick one',
              selectedOptions: [],
              [field]: value,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('accepts a terminal prompt commit with watcher attribution', () => {
    expect(() =>
      validateChatCommandRequest({
        ...command,
        commandId: 'watcher-delivery-terminal-terminal-prompt',
        command: {
          type: 'chat.commit_terminal_initial_prompt',
          chatId: 'chat-1',
          userMessageId: 'terminal-user-1',
          turnTimerMessageId: 'terminal-timer-1',
          text: 'Launch this prompt',
          pendingSystemInstructionIds: [
            'instruction-1',
            'plan-file-location:plan-1',
            'plan-import-/workspace/My Plan.md-1786104000000',
          ],
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
        },
      }),
    ).not.toThrow();
  });

  it('fans out the same ordered batches and revisions through the stream', async () => {
    expect(listener).toBeDefined();
    firstSend.mockImplementationOnce(() => {
      throw new Error('suspended');
    });
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'project-1:worktree-1:2',
      occurredAt: '2026-08-07T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 1,
      revision: 2,
      changes: [{ type: 'tab.order_changed', tabIds: [] }],
    };
    const next: ChatStateChangedEvent = {
      ...event,
      eventId: 'project-1:worktree-1:3',
      baseRevision: 2,
      revision: 3,
      changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
    };
    listener?.(event);
    listener?.(next);
    await new Promise(setImmediate);
    const directSecond = [event, next].map((batch) => [
      IPC_CHANNELS.chatStateChanged,
      batch,
    ]);
    expect(secondSend.mock.calls).toEqual(directSecond);
    expect(firstSend.mock.calls).toEqual(directSecond);
  });

  it('pushes chatStateChanged synchronously with the port event from registration onward', async () => {
    let freshListener: ((event: ChatStateChangedEvent) => void) | undefined;
    const freshPort: ChatStateCommandPort = {
      ...port,
      subscribe: (next): (() => void) => {
        freshListener = next;
        return (): void => {
          freshListener = undefined;
        };
      },
    };
    const send = jest.fn();
    const dispatcher = createDesktopRuntime({
      getChatStatePort: () => freshPort,
    });
    const dispose = registerChatStateHandlers(
      freshPort,
      () => [
        {
          isDestroyed: (): boolean => false,
          webContents: { isDestroyed: (): boolean => false, send },
        },
      ],
      {
        dispatcher,
        resolveCaller: () => ({
          principalId: 'test-user',
          clientInstanceId: 'test-client',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.chat.read'],
        }),
      },
    );
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'project-1:worktree-1:4',
      occurredAt: '2026-08-07T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 3,
      revision: 4,
      changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
    };
    freshListener?.(event);
    expect(send.mock.calls).toEqual([[IPC_CHANNELS.chatStateChanged, event]]);
    dispose();
    await dispatcher.shutdown();
  });

  it('reopens the legacy push after an error and recovers stranded events once', async () => {
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'burst-0',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
    };
    const subscribe = jest.spyOn(port, 'subscribe');
    const originalListener = listener;
    listener?.(event);
    const interrupted = {
      ...event,
      eventId: 'interrupted',
      baseRevision: 1,
      revision: 2,
    };
    const later = {
      ...event,
      eventId: 'after-error',
      baseRevision: 2,
      revision: 3,
    };
    const itemSchema = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item;
    const invalidItem = itemSchema.safeParse(null);
    if (invalidItem.success) throw new Error('Expected invalid stream item.');
    const parse = jest
      .spyOn(itemSchema, 'safeParse')
      .mockReturnValueOnce(invalidItem);
    listener?.(interrupted);
    parse.mockRestore();
    listener?.(later);
    await new Promise(setImmediate);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listener).not.toBe(originalListener);
    expect(secondSend.mock.calls).toEqual(
      [event, interrupted, later].map((item) => [
        IPC_CHANNELS.chatStateChanged,
        item,
      ]),
    );
    subscribe.mockRestore();
  });

  it('reports a stream that keeps ending once per outage and stays silent after teardown', async () => {
    const writes: string[] = [];
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        if (String(chunk).startsWith('Chat event stream'))
          writes.push(String(chunk));
        return true;
      });
    // Without a chat state port, every reopened stream ends in an error.
    const dispatcher = createDesktopRuntime({});
    const open = jest.spyOn(dispatcher, 'openChatEventsForLegacyIpc');
    const dispose = registerChatStateHandlers(port, () => windows, {
      dispatcher,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
    const waitFor = async (done: () => boolean): Promise<void> => {
      for (let waited = 0; !done(); waited += 10) {
        if (waited >= 5000) throw new Error('Timed out waiting for reopen.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await waitFor(() => open.mock.calls.length >= 3);
      expect(writes).toEqual(['Chat event stream ended; reopening.\n']);
      dispose();
      await dispatcher.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(writes).toEqual(['Chat event stream ended; reopening.\n']);
    } finally {
      dispose();
      await dispatcher.shutdown();
      open.mockRestore();
      write.mockRestore();
    }
  });

  it('delivers queued events with duplicate producer IDs without stopping the push', async () => {
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'duplicate-id',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
    };
    const second = { ...event, baseRevision: 1, revision: 2 };
    const third = {
      ...event,
      eventId: 'later-id',
      baseRevision: 2,
      revision: 3,
    };
    listener?.(event);
    listener?.(second);
    listener?.(third);
    await new Promise(setImmediate);
    expect(secondSend.mock.calls).toEqual(
      [event, second, third].map((batch) => [
        IPC_CHANNELS.chatStateChanged,
        batch,
      ]),
    );
  });
});

describe('chat-state push cadence and routing', () => {
  type Handler = (event: unknown, value: unknown) => unknown;
  let listener: ((event: ChatStateChangedEvent) => void) | undefined;
  let dispose: (() => void) | undefined;
  let dispatcher: ReturnType<typeof createDesktopRuntime> | undefined;
  const serviceGetState = jest.fn<Promise<ChatStateSnapshot>, []>();
  const mainSend = jest.fn<void, [string, ...unknown[]]>();
  const advisorSend = jest.fn<void, [string, ...unknown[]]>();
  let mainDestroyed: (() => void) | undefined;
  const mainContents = {
    id: 1,
    isDestroyed: (): boolean => false,
    send: mainSend,
    once: (_event: 'destroyed', next: () => void): void => {
      mainDestroyed = next;
    },
  };
  let advisorDestroyed: (() => void) | undefined;
  const advisorContents = {
    id: 2,
    isDestroyed: (): boolean => false,
    send: advisorSend,
    mainFrame: { id: 'advisor-frame' },
    once: (_event: 'destroyed', next: () => void): void => {
      advisorDestroyed = next;
    },
  };
  const windows = [
    { isDestroyed: (): boolean => false, webContents: mainContents },
    { isDestroyed: (): boolean => false, webContents: advisorContents },
  ];

  function event(
    worktreeId: string,
    baseRevision: number,
    changes: ChatStateChangedEvent['changes'],
    projectId = 'project-1',
  ): ChatStateChangedEvent {
    return {
      schemaVersion: 1,
      eventId: `${projectId}:${worktreeId}:${String(baseRevision + 1)}`,
      occurredAt: '2026-10-02T00:00:00.000Z',
      projectId,
      worktreeId,
      baseRevision,
      revision: baseRevision + 1,
      changes,
    };
  }

  function runtime(
    lastActivityAt: number,
  ): ChatStateChangedEvent['changes'][number] {
    return {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: { status: 'streaming', queuedMessageIds: [], lastActivityAt },
    };
  }

  function streamed(worktreeId: string, base: number): ChatStateChangedEvent {
    return event(worktreeId, base, [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: `text ${String(base)}` }],
          timestamp: 2,
        },
      },
      runtime(base),
    ]);
  }

  function handlerFor(channel: string): Handler {
    const calls = jest.mocked(registerIpcHandler).mock.calls;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index];
      if (call?.[0] === channel) {
        const handler = call[1];
        return (event, value) => handler(event as never, value);
      }
    }
    throw new Error(`No handler for ${channel}`);
  }

  function sentRevisions(
    send: jest.Mock<void, [string, ...unknown[]]>,
  ): Array<[string, number, number]> {
    return send.mock.calls
      .filter((call) => call[0] === IPC_CHANNELS.chatStateChanged)
      .map((call) => {
        const sent = call[1] as ChatStateChangedEvent;
        return [sent.worktreeId, sent.baseRevision, sent.revision];
      });
  }

  /** A snapshot of scope `wt-a` at `revision`. */
  function scopeSnapshot(revision: number): ChatStateSnapshot {
    return {
      ...snapshot,
      worktreeId: 'wt-a',
      revision,
      tabsFile: { ...snapshot.tabsFile, revision },
    };
  }

  /**
   * The advisor renderer's revisioned sync, fed with every chat state message
   * main sends that window. Its snapshot query is `chat:get-state` from that
   * window; like `registerIpcHandler`, the reply follows the window's
   * delivery barriers.
   */
  function advisorSync(): {
    sync: RevisionedChatSync;
    snapshotQueries: () => number;
  } {
    let queries = 0;
    const sync = new RevisionedChatSync(
      {
        getState: async (request): Promise<ChatStateSnapshot> => {
          queries += 1;
          try {
            return (await handlerFor(IPC_CHANNELS.chatGetState)(
              {
                sender: advisorContents,
                senderFrame: advisorContents.mainFrame,
              },
              request,
            )) as ChatStateSnapshot;
          } finally {
            runRendererDeliveryBarriers(
              advisorContents,
              IPC_CHANNELS.chatGetState,
            );
          }
        },
      },
      {
        installSnapshot: (): void => undefined,
        applyCommittedEvent: (): void => undefined,
      },
    );
    advisorSend.mockImplementation((channel, payload) => {
      if (channel === IPC_CHANNELS.chatStateChanged)
        sync.handleEvent(payload as ChatStateChangedEvent);
    });
    return { sync, snapshotQueries: () => queries };
  }

  beforeEach(() => {
    // Cadence is driven by publication time, independent of runner CPU pauses.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    jest.clearAllMocks();
    advisorSend.mockReset();
    serviceGetState.mockReset();
    mainDestroyed = undefined;
    advisorDestroyed = undefined;
    const port: ChatStateCommandPort = {
      getState: serviceGetState,
      searchTranscript: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      command: jest.fn(),
      subscribe: (next): (() => void) => {
        listener = next;
        return (): void => {
          listener = undefined;
        };
      },
    };
    dispatcher = createDesktopRuntime({ getChatStatePort: () => port });
    dispose = registerChatStateHandlers(port, () => windows, {
      dispatcher,
      resolveCaller: () => ({
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      }),
    });
  });

  afterEach(async () => {
    try {
      dispose?.();
      dispose = undefined;
      await dispatcher?.shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads the recorded interest for each target before delivery', () => {
    const sender = {
      sender: advisorContents,
      senderFrame: advisorContents.mainFrame,
    };
    const focused = {
      projectId: 'project-1',
      worktreeId: 'wt-a',
      chatId: 'chat-1',
    };
    const committed = streamed('wt-a', 1);
    handlerFor(IPC_CHANNELS.chatSetInterest)(sender, {
      focused: [focused],
      warm: [],
      acceptsMessagesOmitted: true,
    });
    listener?.(committed);
    expect(advisorSend).toHaveBeenLastCalledWith(
      IPC_CHANNELS.chatStateChanged,
      committed,
    );
    // Replace the recorded declaration: the old cached keys must not survive.
    handlerFor(IPC_CHANNELS.chatSetInterest)(sender, {
      focused: [],
      warm: [],
      acceptsMessagesOmitted: true,
    });
    const background = streamed('wt-a', 2);
    listener?.(background);
    jest.advanceTimersByTime(16);
    expect(advisorSend).toHaveBeenLastCalledWith(
      IPC_CHANNELS.chatStateChanged,
      {
        ...background,
        changes: [runtime(2), { type: 'messages.omitted', chatId: 'chat-1' }],
      },
    );
    expect(mainSend).toHaveBeenLastCalledWith(
      IPC_CHANNELS.chatStateChanged,
      background,
    );
    handlerFor(IPC_CHANNELS.chatSetInterest)(sender, {
      focused: [focused],
      warm: [],
      acceptsMessagesOmitted: true,
    });
    const visible = streamed('wt-a', 3);
    listener?.(visible);
    jest.advanceTimersByTime(16);
    expect(advisorSend).toHaveBeenLastCalledWith(
      IPC_CHANNELS.chatStateChanged,
      visible,
    );
  });

  it('sends a declared window only its scopes and an undeclared window all', async () => {
    await handlerFor(IPC_CHANNELS.chatSetStateScopes)(
      { sender: advisorContents, senderFrame: advisorContents.mainFrame },
      {
        kind: 'scopes',
        scopes: [{ projectId: 'app-advisor', worktreeId: 'entry-1' }],
      },
    );
    listener?.(event('wt-a', 1, [{ type: 'tab.removed', tabId: 'tab-1' }]));
    listener?.(
      event(
        'entry-1',
        1,
        [{ type: 'tab.removed', tabId: 'tab-1' }],
        'app-advisor',
      ),
    );
    expect(sentRevisions(mainSend)).toEqual([
      ['wt-a', 1, 2],
      ['entry-1', 1, 2],
    ]);
    expect(sentRevisions(advisorSend)).toEqual([['entry-1', 1, 2]]);

    await handlerFor(IPC_CHANNELS.chatSetStateScopes)(
      { sender: advisorContents, senderFrame: advisorContents.mainFrame },
      { kind: 'all' },
    );
    listener?.(event('wt-a', 2, [{ type: 'tab.removed', tabId: 'tab-2' }]));
    expect(sentRevisions(advisorSend)).toEqual([
      ['entry-1', 1, 2],
      ['wt-a', 2, 3],
    ]);
  });

  it('fails open on an invalid declaration and when the window is destroyed', async () => {
    const declare = handlerFor(IPC_CHANNELS.chatSetStateScopes);
    await declare(
      { sender: advisorContents, senderFrame: advisorContents.mainFrame },
      { kind: 'scopes', scopes: [] },
    );
    listener?.(event('wt-a', 1, [{ type: 'tab.removed', tabId: 'tab-1' }]));
    expect(sentRevisions(advisorSend)).toEqual([]);

    expect(() =>
      declare(
        { sender: advisorContents, senderFrame: advisorContents.mainFrame },
        { kind: 'scopes', scopes: [{ projectId: '../x', worktreeId: 'w' }] },
      ),
    ).toThrow();
    listener?.(event('wt-a', 2, [{ type: 'tab.removed', tabId: 'tab-2' }]));
    expect(sentRevisions(advisorSend)).toEqual([['wt-a', 2, 3]]);

    await declare(
      { sender: advisorContents, senderFrame: advisorContents.mainFrame },
      { kind: 'scopes', scopes: [] },
    );
    expect(advisorDestroyed).toBeDefined();
    advisorDestroyed?.();
    listener?.(event('wt-a', 3, [{ type: 'tab.removed', tabId: 'tab-3' }]));
    expect(sentRevisions(advisorSend)).toEqual([
      ['wt-a', 2, 3],
      ['wt-a', 3, 4],
    ]);
  });

  it('releases a window that never declared once it is destroyed', async () => {
    const forget = jest.spyOn(ChatStateDelivery.prototype, 'forgetTarget');
    try {
      // The main window receives pushes without ever declaring its scopes.
      listener?.(event('wt-a', 1, [{ type: 'tab.removed', tabId: 'tab-1' }]));
      expect(sentRevisions(mainSend)).toEqual([['wt-a', 1, 2]]);
      expect(mainDestroyed).toBeDefined();
      mainDestroyed?.();
      expect(forget).toHaveBeenCalledWith(mainContents);

      // A renderer that only queries a snapshot is released as well.
      let queryDestroyed: (() => void) | undefined;
      const querying = {
        isDestroyed: (): boolean => false,
        send: jest.fn(),
        mainFrame: { id: 'query-frame' },
        once: (_event: 'destroyed', next: () => void): void => {
          queryDestroyed = next;
        },
      };
      serviceGetState.mockResolvedValue(scopeSnapshot(3));
      await handlerFor(IPC_CHANNELS.chatGetState)(
        { sender: querying, senderFrame: querying.mainFrame },
        { projectId: 'project-1', worktreeId: 'wt-a' },
      );
      expect(queryDestroyed).toBeDefined();
      queryDestroyed?.();
      expect(forget).toHaveBeenCalledWith(querying);
    } finally {
      forget.mockRestore();
    }
  });

  it('rejects a declaration from a subframe', () => {
    expect(() =>
      handlerFor(IPC_CHANNELS.chatSetStateScopes)(
        { sender: advisorContents, senderFrame: { id: 'child-frame' } },
        { kind: 'all' },
      ),
    ).toThrow('Only a window can declare its chat state scopes.');
  });

  it('merges a burst and delivers it before any later message to that window', () => {
    listener?.(event('wt-a', 1, [runtime(1)]));
    listener?.(streamed('wt-a', 2));
    listener?.(streamed('wt-a', 3));
    expect(sentRevisions(mainSend)).toEqual([['wt-a', 1, 2]]);
    sendToWebContents(mainContents, IPC_CHANNELS.chatEvent, { marker: true });
    expect(mainSend.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.chatStateChanged,
      IPC_CHANNELS.chatStateChanged,
      IPC_CHANNELS.chatEvent,
    ]);
    expect(sentRevisions(mainSend)).toEqual([
      ['wt-a', 1, 2],
      ['wt-a', 2, 4],
    ]);
    // The other window's run is independent and still pending.
    expect(sentRevisions(advisorSend)).toEqual([['wt-a', 1, 2]]);
  });

  it('delivers a pending burst on the publication tick and on teardown', () => {
    listener?.(event('wt-a', 1, [runtime(1)]));
    listener?.(streamed('wt-a', 2));
    listener?.(streamed('wt-a', 3));
    jest.advanceTimersByTime(15);
    expect(sentRevisions(mainSend)).toEqual([['wt-a', 1, 2]]);
    expect(sentRevisions(advisorSend)).toEqual([['wt-a', 1, 2]]);
    jest.advanceTimersByTime(1);
    expect(sentRevisions(mainSend)).toEqual([
      ['wt-a', 1, 2],
      ['wt-a', 2, 4],
    ]);
    listener?.(streamed('wt-a', 4));
    dispose?.();
    dispose = undefined;
    expect(sentRevisions(mainSend)).toEqual([
      ['wt-a', 1, 2],
      ['wt-a', 2, 4],
      ['wt-a', 4, 5],
    ]);
    expect(sentRevisions(advisorSend)).toEqual(sentRevisions(mainSend));
  });

  it('never merges a run across the revision of a snapshot read while it is pending', async () => {
    const { sync, snapshotQueries } = advisorSync();
    let reply: (() => void) | undefined;
    serviceGetState.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = (): void => {
            resolve(scopeSnapshot(3));
          };
        }),
    );
    listener?.(event('wt-a', 1, [runtime(1)]));
    // Held for this tick: the window was sent revision 2 just now.
    listener?.(streamed('wt-a', 2));
    const hydrated = sync.hydrate('project-1', 'wt-a');
    for (let turn = 0; turn < 100 && !reply; turn += 1) await Promise.resolve();
    expect(reply).toBeDefined();
    // The snapshot was read at revision 3; revision 4 commits before the
    // reply and, without a boundary, joins the held run as one 2 -> 4 event.
    listener?.(streamed('wt-a', 3));
    reply?.();
    await expect(hydrated).resolves.toBe('installed');
    expect(sync.getStatus('project-1', 'wt-a')).toEqual({
      phase: 'live',
      revision: 4,
    });
    expect(snapshotQueries()).toBe(1);
  });

  it('never merges a run across the revision of a snapshot already replied', async () => {
    const { sync, snapshotQueries } = advisorSync();
    serviceGetState.mockResolvedValue(scopeSnapshot(3));
    listener?.(event('wt-a', 1, [runtime(1)]));
    await expect(sync.hydrate('project-1', 'wt-a')).resolves.toBe('installed');
    // Publication may lag a snapshot read (group commit publishes after the
    // journal sync): revision 3 reaches this projection after the reply.
    listener?.(streamed('wt-a', 2));
    listener?.(streamed('wt-a', 3));
    sendToWebContents(advisorContents, IPC_CHANNELS.chatEvent, {});
    expect(sync.getStatus('project-1', 'wt-a')).toEqual({
      phase: 'live',
      revision: 4,
    });
    expect(snapshotQueries()).toBe(1);
  });

  it('validates scope declarations with the snapshot request rules', () => {
    expect(validateChatStateScopesDeclaration({ kind: 'all' })).toEqual({
      kind: 'all',
    });
    expect(
      validateChatStateScopesDeclaration({
        kind: 'scopes',
        scopes: [{ projectId: 'p', worktreeId: 'w' }],
      }),
    ).toEqual({
      kind: 'scopes',
      scopes: [{ projectId: 'p', worktreeId: 'w' }],
    });
    expect(() =>
      validateChatStateScopesDeclaration({ kind: 'all', scopes: [] }),
    ).toThrow();
    expect(() =>
      validateChatStateScopesDeclaration({
        kind: 'scopes',
        scopes: [{ projectId: 'p', worktreeId: 'w', extra: 1 }],
      }),
    ).toThrow();
    expect(() =>
      validateChatStateScopesDeclaration({
        kind: 'scopes',
        scopes: Array.from({ length: 4097 }, (_, index) => ({
          projectId: 'p',
          worktreeId: `w-${String(index)}`,
        })),
      }),
    ).toThrow('Too many declared chat state scopes.');
  });

  it('validates and normalizes chat interest refs and overlap', () => {
    const first = { projectId: 'p', worktreeId: 'w', chatId: 'a' };
    const second = { projectId: 'p', worktreeId: 'w', chatId: 'b' };
    const run = { ...first, delegationId: 'd', runGeneration: 0 };
    expect(
      validateChatInterestDeclaration({
        focused: [first, first],
        warm: [second, first, second],
        focusedRuns: [run, run],
      }),
    ).toEqual({ focused: [first], warm: [second], focusedRuns: [run] });
    expect(validateChatInterestDeclaration({ focused: [], warm: [] })).toEqual({
      focused: [],
      warm: [],
    });
    expect(
      validateChatInterestDeclaration({
        focused: [],
        warm: [],
        acceptsMessagesOmitted: true,
      }),
    ).toEqual({ focused: [], warm: [], acceptsMessagesOmitted: true });
    expect(() =>
      validateChatInterestDeclaration({
        focused: [],
        warm: [],
        acceptsMessagesOmitted: false,
      }),
    ).toThrow('acceptsMessagesOmitted must be true when present.');
  });

  it.each([
    ['focused', 32, { projectId: 'p', worktreeId: 'w', chatId: 'a' }],
    ['warm', 16, { projectId: 'p', worktreeId: 'w', chatId: 'a' }],
    [
      'focusedRuns',
      64,
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'a',
        delegationId: 'd',
        runGeneration: 0,
      },
    ],
  ])('bounds %s at %i entries before deduplication', (field, limit, ref) => {
    const at = {
      focused: [],
      warm: [],
      [field]: Array.from({ length: limit }, () => ref),
    };
    const over = {
      focused: [],
      warm: [],
      [field]: Array.from({ length: limit + 1 }, () => ref),
    };
    expect(() => validateChatInterestDeclaration(at)).not.toThrow();
    expect(() => validateChatInterestDeclaration(over)).toThrow();
  });

  it('rejects invalid ids, unknown keys, and invalid run generations', () => {
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'a' };
    const valid = { focused: [chat], warm: [] };
    const invalid = [
      { ...valid, extra: 1 },
      { ...valid, focused: [{ ...chat, extra: 1 }] },
      { ...valid, focused: [{ ...chat, chatId: '../unsafe' }] },
      { ...valid, focused: [{ ...chat, projectId: '../unsafe' }] },
      { ...valid, focused: [{ ...chat, worktreeId: '../unsafe' }] },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((runGeneration) => ({
        ...valid,
        focusedRuns: [{ ...chat, delegationId: 'd', runGeneration }],
      })),
      {
        ...valid,
        focusedRuns: [{ ...chat, delegationId: '../unsafe', runGeneration: 0 }],
      },
      {
        ...valid,
        focusedRuns: [
          { ...chat, delegationId: 'd', runGeneration: 0, extra: 1 },
        ],
      },
    ];
    for (const declaration of invalid)
      expect(() => validateChatInterestDeclaration(declaration)).toThrow();
  });

  it('records normalized interest and clears it after invalid or subframe invokes', () => {
    const record = jest.spyOn(
      ChatStateSubscriptions.prototype,
      'declareInterest',
    );
    const clear = jest.spyOn(ChatStateSubscriptions.prototype, 'resetInterest');
    const invoke = handlerFor(IPC_CHANNELS.chatSetInterest);
    const sender = {
      sender: advisorContents,
      senderFrame: advisorContents.mainFrame,
    };
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'a' };
    try {
      invoke(sender, { focused: [chat, chat], warm: [chat] });
      expect(record).toHaveBeenCalledWith(advisorContents, {
        focused: [chat],
        warm: [],
      });
      expect(() =>
        invoke(sender, { focused: [chat], warm: [], extra: true }),
      ).toThrow();
      expect(clear).toHaveBeenCalledWith(advisorContents);
      invoke(sender, { focused: [chat], warm: [] });
      expect(() =>
        invoke(
          { sender: advisorContents, senderFrame: { id: 'child' } },
          { focused: [], warm: [] },
        ),
      ).toThrow('Only a window can declare its chat interest.');
      expect(clear).toHaveBeenCalledTimes(2);
      invoke(sender, { focused: [chat], warm: [] });
      advisorDestroyed?.();
      expect(clear).toHaveBeenCalledTimes(3);
    } finally {
      record.mockRestore();
      clear.mockRestore();
    }
  });

  it('exposes a window’s recorded interest to main-side readers', () => {
    const invoke = handlerFor(IPC_CHANNELS.chatSetInterest);
    const chat = { projectId: 'p', worktreeId: 'w', chatId: 'a' };
    expect(recordedChatInterest(advisorContents)).toBeUndefined();
    invoke(
      { sender: advisorContents, senderFrame: advisorContents.mainFrame },
      { focused: [chat], warm: [] },
    );
    expect(recordedChatInterest(advisorContents)).toEqual({
      focused: [chat],
      warm: [],
    });
    advisorDestroyed?.();
    expect(recordedChatInterest(advisorContents)).toBeUndefined();
  });
});

describe('phase 09 host-only send fields', () => {
  const fields = {
    agentSent: {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      chatTitle: 'Sender',
      projectLabel: 'App Advisor',
    },
    agentSenderProvenance: {
      version: 1,
      capturedAt: '2026-10-17T00:00:00.000Z',
      acceptedInputId: 'message-1',
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      owner: { kind: 'none' },
    },
    hiddenContext: { kind: 'agent-sender-context', text: 'trusted' },
    agentSendSetup: { version: 1 },
  };
  it('admits validated fields only through main ingress and rejects incomplete metadata', () => {
    expect(
      validateChatCommandRequest(
        { ...command, command: { ...command.command, ...fields } },
        { allowMainOnlyFields: true },
      ).command,
    ).toMatchObject(fields);
    expect(() =>
      validateChatCommandRequest(
        {
          ...command,
          command: { ...command.command, agentSent: fields.agentSent },
        },
        { allowMainOnlyFields: true },
      ),
    ).toThrow();
  });
  it("admits only a true started-chat flag on main's setup marker", () => {
    const withSetup = (agentSendSetup: object): unknown =>
      validateChatCommandRequest(
        {
          ...command,
          command: { ...command.command, ...fields, agentSendSetup },
        },
        { allowMainOnlyFields: true },
      ).command;
    expect(withSetup({ version: 1, startedChat: true })).toMatchObject({
      agentSendSetup: { version: 1, startedChat: true },
    });
    expect(() => withSetup({ version: 1, startedChat: false })).toThrow();
    expect(() => withSetup({ version: 1, other: true })).toThrow();
  });
  it.each(Object.entries(fields))(
    'rejects renderer spoof field %s',
    (key, value) => {
      expect(() =>
        validateChatCommandRequest({
          ...command,
          command: { ...command.command, [key]: value },
        }),
      ).toThrow();
    },
  );
});
