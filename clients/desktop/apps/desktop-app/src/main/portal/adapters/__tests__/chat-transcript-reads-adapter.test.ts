jest.mock('../../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: jest.fn(() => Promise.resolve(false)),
  peekCopilotRuntimeAvailability: jest.fn(() => false),
}));
jest.mock('../../../cursor/runtime-availability', () => ({
  peekCursorRuntimeAvailability: jest.fn(() => true),
}));
jest.mock('../../../ipc/chat-state', () => ({
  getChatStateCommandPort: jest.fn(),
}));
jest.mock('../../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: jest.fn(),
}));
const mockQuery = jest.fn<
  Promise<unknown>,
  [string, unknown, CanopyQueryOptions]
>();
jest.mock('../../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): unknown => ({ query: mockQuery }),
}));

import { CanopyOperationError } from '@canopy/core-runtime';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  TRANSCRIPT_READ_WRAPPER_BYTES,
  CoreChatTranscriptPageResultSchema,
} from '@canopy/protocol/canopy-core';
import {
  handlePortalCommand,
  type PortalCommandHandlerContext,
} from '../../portal-command-handlers';
import { resolveStandaloneChatTarget } from '../../../services/standalone-chat-service';
import {
  createCommandCompletedPayload,
  createPortalEvent,
} from '../../portal-event-bus';
import { PortalServiceError } from '../../../services/portal-service-error';

const source = {
  kind: 'worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
} as const;
const target = {
  kind: 'delegation',
  chatId: 'chat-1',
  delegationId: 'child-1',
  runGeneration: 1,
} as const;
const page = {
  messages: [],
  totalMessages: 0,
  transcriptRevision: 7,
  cursor: 'older-page',
};
const content = { text: 'body', byteLength: 4 };
const readTypes = [
  'portal.chat.transcript.page',
  'portal.chat.content.read',
] as const;

function command(
  type:
    | (typeof readTypes)[number]
    | 'portal.chat.transcript.blocks.page' = 'portal.chat.transcript.page',
  payload?: unknown,
): PortalCommandEnvelope {
  return {
    id: 'read-1',
    sequence: 42,
    type,
    target: { workspaceLocalId: 'workspace-1', worktreeLocalId: 'worktree-1' },
    payload: payload ?? {
      source,
      target,
      ...(type === 'portal.chat.content.read'
        ? {
            messageId: 'row-1',
            blockOrdinal: 2,
            field: 'output',
            offset: 4,
            limit: 64,
          }
        : { cursor: 'older-page' }),
    },
    createdAt: '2026-10-21T00:00:00.000Z',
    expiresAt: null,
  };
}

function context(): {
  events: PortalEventEnvelope[];
  handler: PortalCommandHandlerContext;
} {
  const events: PortalEventEnvelope[] = [];
  return {
    events,
    handler: {
      sessionId: 'session-1',
      canReadTranscripts: (): boolean => true,
      pairingCode: null,
      getWindow: (): null => null,
      enqueueEvent: (event): void => {
        events.push(event);
      },
      markAuthenticated: jest.fn(),
      stop: jest.fn(),
    },
  };
}

describe('trusted Portal transcript reads through command completion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue(page);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes a blocks command by type, always bounded, retaining every wrapper budget', async () => {
    const value = CoreChatTranscriptBoundedBlocksPageResultSchema.parse({
      projection: 'bounded-v1',
      messageId: 'm'.repeat(512),
      firstBlockOrdinal: 0,
      entries: Array.from({ length: 62 }, (_, ordinal) => ({
        kind: 'block',
        ordinal,
        block: {
          type: 'tool_use',
          toolUseId: 't'.repeat(512),
          toolName: 'shell',
          input: '"\\\n\u0000'.repeat(1000),
        },
      })),
      blockCount: 512,
      nextBlockOrdinal: 62,
      cursor: '62:'.padEnd(2048, 'c'),
      transcriptRevision: Number.MAX_SAFE_INTEGER,
      runTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(784865);
    mockQuery.mockResolvedValue(value);
    const { handler, events } = context();
    const payload = {
      source,
      target,
      messageId: 'm'.repeat(512),
      limit: 512,
      cursor: 'c'.repeat(2048),
    };
    await handlePortalCommand(
      command('portal.chat.transcript.blocks.page', payload),
      handler,
    );
    const signalMatcher: unknown = expect.any(AbortSignal);
    const callerMatcher: unknown = expect.objectContaining({
      interfaceKind: 'portal',
      grants: ['core.chat.read'],
    });
    expect(mockQuery).toHaveBeenCalledWith(
      'core.chat.transcript.blocks.page',
      {
        scope: {
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        target,
        messageId: 'm'.repeat(512),
        limit: 512,
        cursor: 'c'.repeat(2048),
        projection: 'bounded-v1',
      },
      expect.objectContaining({
        signal: signalMatcher,
        caller: callerMatcher,
      }),
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { ok: true, value } },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, value }))).toBe(784885);
    process.stdout.write(
      `T reply=784885 event=${Buffer.byteLength(JSON.stringify(events[0]))} batch=${Buffer.byteLength(JSON.stringify({ events }))}\n`,
    );
    for (const wrapper of [events[0], { events }, { ok: true, value }]) {
      expect(Buffer.byteLength(JSON.stringify(wrapper))).toBeLessThanOrEqual(
        TRANSCRIPT_READ_WRAPPER_BYTES,
      );
    }
    // A client cannot opt back into the local raw compatibility projection.
    mockQuery.mockClear();
    await handlePortalCommand(
      command('portal.chat.transcript.blocks.page', {
        ...payload,
        projection: 'raw',
      }),
      handler,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    [
      'active',
      { entryId: 'entry-1', archivedInEntryId: null, isArchived: false },
      { worktreeId: 'entry-1' },
    ],
    [
      'archived entry',
      { entryId: null, archivedInEntryId: 'archive-1', isArchived: true },
      { worktreeId: 'archive-1', archivedContainerId: 'archive-1' },
    ],
    [
      'pre-entry archive',
      { entryId: null, archivedInEntryId: null, isArchived: true },
      null,
    ],
  ] as const)(
    'reads primary logical content for %s standalone sources under the existing archive policy',
    async (_label, resolution, expected) => {
      jest
        .mocked(resolveStandaloneChatTarget)
        .mockResolvedValue({ workspaceId: 'project-1', ...resolution });
      mockQuery.mockResolvedValue(content);
      const { handler, events } = context();
      await handlePortalCommand(
        {
          ...command('portal.chat.content.read'),
          target: { standaloneChatLocalId: 'chat-1' },
          payload: {
            source: {
              kind: 'standalone',
              projectLocalId: 'project-1',
              chatId: 'chat-1',
            },
            target: { kind: 'primary', chatId: 'chat-1' },
            messageId: 'result-row',
            blockOrdinal: 42,
            field: 'output',
            fieldSource: 'logical',
            offset: 4000,
            limit: 64,
          },
        },
        handler,
      );
      if (expected === null) {
        expect(mockQuery).not.toHaveBeenCalled();
        expect(events[0]).toMatchObject({
          type: 'portal.command.completed',
          payload: { result: { ok: false, reason: 'unavailable' } },
        });
      } else {
        const { worktreeId, ...archive } = expected;
        expect(mockQuery).toHaveBeenCalledWith(
          'core.chat.content.read',
          {
            scope: { workspaceId: 'project-1', worktreeId, chatId: 'chat-1' },
            ...archive,
            target: { kind: 'primary', chatId: 'chat-1' },
            messageId: 'result-row',
            blockOrdinal: 42,
            field: 'output',
            fieldSource: 'logical',
            offset: 4000,
            limit: 64,
          },
          expect.anything(),
        );
        expect(events[0]).toMatchObject({
          payload: { result: { ok: true, value: content } },
        });
      }
    },
  );

  it.each([undefined, 'worktree-1'])(
    'reads primary worktree content with archive %s, source identity and post-await authorization',
    async (archivedContainerId) => {
      const payload = {
        source: {
          ...source,
          ...(archivedContainerId ? { archivedContainerId } : {}),
        },
        target: { kind: 'primary', chatId: 'chat-1' },
        messageId: 'result-row',
        blockOrdinal: 42,
        field: 'output',
        fieldSource: 'logical',
        offset: 4000,
        limit: 64,
      };
      mockQuery.mockResolvedValue(content);
      const { handler, events } = context();
      await handlePortalCommand(
        command('portal.chat.content.read', payload),
        handler,
      );
      expect(mockQuery).toHaveBeenCalledWith(
        'core.chat.content.read',
        expect.objectContaining({
          target: payload.target,
          fieldSource: 'logical',
          ...(archivedContainerId ? { archivedContainerId } : {}),
        }),
        expect.anything(),
      );
      expect(events[0]).toMatchObject({
        payload: { result: { ok: true, value: content } },
      });
      mockQuery.mockClear();
      await handlePortalCommand(
        command('portal.chat.content.read', {
          ...payload,
          target: { kind: 'primary', chatId: 'other' },
        }),
        handler,
      );
      expect(mockQuery).not.toHaveBeenCalled();
      await handlePortalCommand(
        {
          ...command('portal.chat.content.read', payload),
          target: { workspaceLocalId: 'other', worktreeLocalId: 'worktree-1' },
        },
        handler,
      );
      expect(mockQuery).not.toHaveBeenCalled();
      events.length = 0;
      let authorized = true;
      handler.canReadTranscripts = (): boolean => authorized;
      mockQuery.mockImplementationOnce(() => {
        authorized = false;
        return Promise.resolve(content);
      });
      await handlePortalCommand(
        command('portal.chat.content.read', payload),
        handler,
      );
      expect(events).toEqual([]);
    },
  );

  it('maps the new blocks stale code without leaking backend details', async () => {
    mockQuery.mockRejectedValue(
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.chat.transcript.blocks.page.staleCursor',
        message: 'private',
        retry: { kind: 'never' },
      }),
    );
    const { handler, events } = context();
    await handlePortalCommand(
      command('portal.chat.transcript.blocks.page', {
        source,
        target,
        messageId: 'row-1',
        limit: 16,
      }),
      handler,
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { ok: false, reason: 'stale' } },
    });
  });

  it.each(readTypes)(
    'dispatches %s directly with the source, target, ranges and trusted caller',
    async (type) => {
      const { handler, events } = context();
      const signalMatcher: unknown = expect.any(AbortSignal);
      mockQuery.mockResolvedValue(
        type === 'portal.chat.content.read' ? content : page,
      );
      await handlePortalCommand(command(type), handler);
      expect(mockQuery).toHaveBeenCalledWith(
        type === 'portal.chat.content.read'
          ? 'core.chat.content.read'
          : 'core.chat.transcript.page',
        {
          scope: {
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
          target: {
            kind: 'delegation',
            chatId: 'chat-1',
            delegationId: 'child-1',
            runGeneration: 1,
          },
          ...(type === 'portal.chat.content.read'
            ? {
                messageId: 'row-1',
                blockOrdinal: 2,
                field: 'output',
                offset: 4,
                limit: 64,
              }
            : { cursor: 'older-page' }),
        },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'portal-session:session-1',
            authorityId: 'local-desktop',
            interfaceKind: 'portal',
            grants: ['core.chat.read'],
          },
          signal: signalMatcher,
        },
      );
      expect(events).toHaveLength(1);
      expect(events).toMatchObject([
        {
          type: 'portal.command.completed',
          payload: {
            result: {
              ok: true,
              value: type === 'portal.chat.content.read' ? content : page,
            },
          },
        },
      ]);
    },
  );

  it.each(readTypes)(
    'rejects an envelope/source mismatch for %s',
    async (type) => {
      const { handler, events } = context();
      await handlePortalCommand(
        {
          ...command(type),
          target: {
            workspaceLocalId: 'workspace-1',
            worktreeLocalId: 'wrong-worktree',
          },
        },
        handler,
      );
      expect(mockQuery).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: {
          error: {
            code: 'invalid_target',
            message: 'Invalid transcript read target.',
          },
        },
      });
    },
  );

  it.each(readTypes)(
    'rejects malformed primary payloads for %s',
    async (type) => {
      const { handler, events } = context();
      const envelope = command(type);
      await handlePortalCommand(
        {
          ...envelope,
          payload: { source, target: { kind: 'primary', chatId: 'chat-1' } },
        },
        handler,
      );
      expect(events[0]).toMatchObject({
        type: 'portal.command.failed',
        payload: {
          error: {
            code: 'invalid_payload',
            message: 'Only delegation transcript reads are supported.',
          },
        },
      });
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no permission', { canReadTranscripts: undefined }],
    ['revoked permission', { canReadTranscripts: (): boolean => false }],
    ['no session', { sessionId: undefined }],
  ])('fails closed with %s before dispatch', async (_name, overrides) => {
    const { handler, events } = context();
    await handlePortalCommand(command(), { ...handler, ...overrides });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'invalid_target',
          message: 'The paired transcript session is no longer authorized.',
        },
      },
    });
  });

  it.each(['revoked', 'replaced'])(
    'sends no completion when the session is %s after the await',
    async () => {
      const { handler, events } = context();
      let authorized = true;
      handler.canReadTranscripts = (): boolean => authorized;
      mockQuery.mockImplementationOnce(() => {
        authorized = false;
        return Promise.resolve(page);
      });
      await handlePortalCommand(command(), handler);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    },
  );

  it.each([
    [
      'active',
      { entryId: 'entry-1', archivedInEntryId: null, isArchived: false },
      { worktreeId: 'entry-1' },
    ],
    [
      'archived entry',
      { entryId: null, archivedInEntryId: 'archive-1', isArchived: true },
      { worktreeId: 'archive-1', archivedContainerId: 'archive-1' },
    ],
  ] as const)(
    'resolves %s standalone sources canonically for both reads',
    async (_name, resolution, expected) => {
      jest
        .mocked(resolveStandaloneChatTarget)
        .mockResolvedValue({ workspaceId: 'project-1', ...resolution });
      const { worktreeId, ...archive } = expected;
      for (const type of readTypes) {
        const { handler } = context();
        const envelope = command(type);
        const fields =
          type === 'portal.chat.content.read'
            ? {
                messageId: 'row-1',
                blockOrdinal: 2,
                field: 'output',
                offset: 4,
                limit: 64,
              }
            : { cursor: 'older-page' };
        await handlePortalCommand(
          {
            ...envelope,
            target: { standaloneChatLocalId: 'chat-1' },
            payload: {
              source: {
                kind: 'standalone',
                projectLocalId: 'project-1',
                chatId: 'chat-1',
              },
              target,
              ...fields,
            },
          },
          handler,
        );
        expect(mockQuery).toHaveBeenLastCalledWith(
          type === 'portal.chat.content.read'
            ? 'core.chat.content.read'
            : 'core.chat.transcript.page',
          {
            scope: { workspaceId: 'project-1', worktreeId, chatId: 'chat-1' },
            ...archive,
            target: {
              kind: 'delegation',
              chatId: 'chat-1',
              delegationId: 'child-1',
              runGeneration: 1,
            },
            ...fields,
          },
          expect.anything(),
        );
      }
      expect(resolveStandaloneChatTarget).toHaveBeenCalledWith({
        projectLocalId: 'project-1',
        chatId: 'chat-1',
      });
    },
  );

  it.each(readTypes)(
    'returns unavailable for pre-entry legacy archives on %s without dispatch',
    async (type) => {
      jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
        workspaceId: 'project-1',
        entryId: null,
        archivedInEntryId: null,
        isArchived: true,
      });
      const { handler, events } = context();
      await handlePortalCommand(
        {
          ...command(type),
          target: { standaloneChatLocalId: 'chat-1' },
          payload: {
            source: {
              kind: 'standalone',
              projectLocalId: 'project-1',
              chatId: 'chat-1',
            },
            target,
            ...(type === 'portal.chat.content.read'
              ? {
                  messageId: 'row-1',
                  blockOrdinal: 0,
                  field: 'text',
                  offset: 0,
                  limit: 64,
                }
              : {}),
          },
        },
        handler,
      );
      expect(mockQuery).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        type: 'portal.command.completed',
        payload: { result: { ok: false, reason: 'unavailable' } },
      });
    },
  );

  it('preserves worktree archive and enforces the core archive refinement', async () => {
    const { handler, events } = context();
    await handlePortalCommand(
      command('portal.chat.transcript.page', {
        source: { ...source, archivedContainerId: 'worktree-1' },
        target,
        cursor: 'archive-cursor',
      }),
      handler,
    );
    expect(mockQuery).toHaveBeenCalledWith(
      'core.chat.transcript.page',
      {
        scope: {
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        archivedContainerId: 'worktree-1',
        target,
        cursor: 'archive-cursor',
      },
      expect.anything(),
    );
    mockQuery.mockClear();
    events.length = 0;
    await handlePortalCommand(
      command('portal.chat.transcript.page', {
        source: { ...source, archivedContainerId: 'wrong-archive' },
        target,
      }),
      handler,
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'invalid_payload',
          message: 'Invalid transcript read payload.',
        },
      },
    });
  });

  it('does not expose a resolver service error as a validation failure', async () => {
    jest
      .mocked(resolveStandaloneChatTarget)
      .mockRejectedValueOnce(
        new PortalServiceError('not_found', '/private/workspace/error'),
      );
    const { handler, events } = context();
    await handlePortalCommand(
      {
        ...command(),
        target: { standaloneChatLocalId: 'chat-1' },
        payload: {
          source: {
            kind: 'standalone',
            projectLocalId: 'project-1',
            chatId: 'chat-1',
          },
          target,
        },
      },
      handler,
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { ok: false, reason: 'failed' } },
    });
    expect(JSON.stringify(events)).not.toContain('/private');
  });

  it.each([
    [
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.chat.transcript.page.staleCursor',
        message: '/private/workspace stale',
        retry: { kind: 'never' },
      }),
      'stale',
    ],
    [
      new CanopyOperationError({
        kind: 'capability_unavailable',
        message: '/private/workspace unavailable',
        retry: { kind: 'never' },
      }),
      'unavailable',
    ],
    [new Error('/private/workspace unexpected'), 'failed'],
  ] as const)(
    'maps a thrown error to %s without leaking details',
    async (error, reason) => {
      const { handler, events } = context();
      mockQuery.mockRejectedValue(error);
      await handlePortalCommand(command(), handler);
      expect(events[0]).toMatchObject({
        type: 'portal.command.completed',
        payload: { result: { ok: false, reason } },
      });
      expect(JSON.stringify(events)).not.toContain('/private');
    },
  );

  it('fits a 960,000-byte multibyte/escaped page in the real serialized event batch', async () => {
    const value = {
      messages: [
        {
          id: 'row-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [],
          text: 'é"\\\n'.repeat(100_000),
        },
      ],
      totalMessages: 1,
      transcriptRevision: 7,
    };
    const padding = 960_000 - Buffer.byteLength(JSON.stringify(value), 'utf8');
    value.messages[0].text += 'x'.repeat(padding);
    expect(CoreChatTranscriptPageResultSchema.safeParse(value).success).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(960_000);
    mockQuery.mockResolvedValue(value);
    const { handler, events } = context();
    await handlePortalCommand(command(), handler);
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { ok: true, value } },
    });
    const event = createPortalEvent(
      'portal.command.completed',
      createCommandCompletedPayload(command(), { ok: true, value }),
      {
        commandId: 'read-1',
        eventId: 'event-1',
        occurredAt: '2026-10-21T00:00:00.000Z',
      },
    );
    expect(
      Buffer.byteLength(JSON.stringify({ events: [event] }), 'utf8'),
    ).toBeLessThanOrEqual(1_048_576);
    expect(
      Buffer.byteLength(JSON.stringify({ events }), 'utf8'),
    ).toBeLessThanOrEqual(1_048_576);
  });

  it.each([...readTypes, 'portal.chat.transcript.blocks.page'] as const)(
    'bounds a never-settling %s at 120 seconds, aborts, and drops late results',
    async (type) => {
      jest.useFakeTimers();
      let settle: ((value: unknown) => void) | undefined;
      mockQuery.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      const { handler, events } = context();
      const pending = handlePortalCommand(
        command(
          type,
          type === 'portal.chat.transcript.blocks.page'
            ? { source, target, messageId: 'row', limit: 16 }
            : undefined,
        ),
        handler,
      );
      await jest.advanceTimersByTimeAsync(119_999);
      expect(events).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(events).toHaveLength(1);
      expect(events).toMatchObject([
        {
          type: 'portal.command.completed',
          payload: {
            result: { ok: false, reason: 'failed' },
          },
        },
      ]);
      expect(mockQuery.mock.calls[0][2].signal?.aborted).toBe(true);
      settle?.(page);
      await jest.advanceTimersByTimeAsync(1);
      expect(events).toHaveLength(1);
    },
  );
});
