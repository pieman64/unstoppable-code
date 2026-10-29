import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  CoreChatSendReceiptParamsSchema,
  CoreChatSendReceiptResultSchema,
} from '@canopy/protocol/canopy-core';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';
import { createDesktopRuntime } from '../desktop-runtime';
import { ChatVisualReadError } from '../../lib/chat-visual-read-errors';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read'],
};
const scope = {
  workspaceId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('canonical send receipt reads', () => {
  const identity = {
    userMessageId: 'user-message',
    fingerprint: 'a'.repeat(64),
  };
  const receipt = {
    commandId: 'original-command',
    revision: 3,
    outcome: 'applied' as const,
    entityId: 'chat-1',
    messageId: 'user-message',
  };

  it('checks grants and local scope before querying any receipt', async () => {
    const port = portFixture();
    const probe = jest.fn().mockResolvedValue({ outcome: 'matched', receipt });
    port.getPortalSendReceipt = probe;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'retry-command', identity },
          { caller: { ...caller, grants: [] } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          {
            scope: { ...scope, authorityId: 'remote-core' },
            commandId: 'retry-command',
            identity,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          {
            scope: { ...scope, targetId: 'worker' },
            commandId: 'retry-command',
            identity,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(probe).not.toHaveBeenCalled();
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'retry-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'matched', receipt });
      expect(probe).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        commandId: 'retry-command',
        identity: { chatId: 'chat-1', ...identity },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('does not return another chat receipt and omits host fields from matching receipts', async () => {
    const port = portFixture();
    const read = jest.fn().mockResolvedValue({
      ...receipt,
      portalSend: { chatId: 'other-chat', ...identity },
    });
    port.getCommandReceipt = read;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command' },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'conflict' });
      read.mockResolvedValue({
        ...receipt,
        reason: '/local/private',
        portalSend: { chatId: 'chat-1', ...identity },
      });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'matched', receipt });
      read.mockResolvedValue(null);
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'missing' });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('rejects malformed identifiers and host paths in the portable contract', () => {
    expect(
      CoreChatSendReceiptParamsSchema.safeParse({
        scope,
        commandId: '/local/command',
        identity,
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptParamsSchema.safeParse({
        scope,
        commandId: 'command',
        identity: { ...identity, fingerprint: 'invalid' },
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptResultSchema.safeParse({
        outcome: 'matched',
        receipt: { ...receipt, entityId: '/local/private' },
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptResultSchema.safeParse({
        outcome: 'matched',
        receipt: { ...receipt, reason: '/local/private' },
      }).success,
    ).toBe(false);
  });
});

function portFixture(): ChatStateCommandPort {
  return {
    getState: jest.fn<Promise<ChatStateSnapshot>, []>(),
    getTranscriptPage: jest.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [
            { type: 'text', text: '/Users/alice/project/file.ts' },
            { type: 'image', path: '/local/private.png', alt: 'image' },
            { type: 'compaction_info', transcriptPath: '/local/raw.jsonl' },
            { type: 'revert_info', attachmentPath: '/local/revert.md' },
          ],
          timestamp: 1,
          absolutePath: '/local/private',
        },
        {
          id: 'hidden-1',
          role: 'system',
          blocks: [{ type: 'text', text: 'host orchestration' }],
          timestamp: 2,
          hidden: true,
        },
      ],
      totalMessages: 2,
      transcriptRevision: 2,
      turns: [
        {
          id: 'turn-1',
          start: 0,
          end: 2,
          complete: true,
          finalMessageIds: ['message-1'],
          files: [{ path: '/local/deliverable.md', state: 'ready' }],
        },
      ],
    }),
    searchTranscript: jest
      .fn()
      .mockResolvedValue({ matches: [], totalCount: 0 }),
    readToolOutput: jest
      .fn()
      .mockResolvedValue({ text: 'hello', byteLength: 5 }),
    readVisual: jest.fn().mockResolvedValue({
      bytes: Uint8Array.from([0xf0, 0x9f, 0x8c, 0xb2]),
      offset: 0,
      length: 4,
      byteLength: 4,
      sha256: 'a'.repeat(64),
    }),
    command: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
  };
}

describe('core chat read adapter', () => {
  const visualReference = {
    version: 1 as const,
    visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 4,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html' as const,
    title: 'Visual',
    maxHeight: 400,
  };

  it('projects raw visual bytes and maps typed failures without host details', async () => {
    const port = portFixture();
    const visualMock = jest.spyOn(port, 'readVisual');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const params = {
      scope,
      messageId: 'result',
      toolUseId: 'call',
      reference: visualReference,
      offset: 0,
      limit: 4,
    };
    await expect(
      dispatcher.query('core.chat.visual.read', params, { caller }),
    ).resolves.toMatchObject({ data: '8J+Msg==', length: 4 });
    expect(visualMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        reference: visualReference,
      }),
      expect.any(AbortSignal),
    );
    for (const [reason, kind, code] of [
      ['not_found', 'not_found', 'core.chat.visual.read.notFound'],
      [
        'invalid_state',
        'failed_precondition',
        'core.chat.visual.read.invalidState',
      ],
    ] as const) {
      jest
        .spyOn(port, 'readVisual')
        .mockRejectedValueOnce(new ChatVisualReadError(reason));
      await expect(
        dispatcher.query('core.chat.visual.read', params, { caller }),
      ).rejects.toMatchObject({ payload: { kind, code } });
    }
    await expect(
      dispatcher.query(
        'core.chat.visual.read',
        {
          ...params,
          limit: 1_048_577,
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    jest
      .spyOn(port, 'readVisual')
      .mockRejectedValueOnce(
        Object.assign(
          new Error("EIO: i/o error, read '/Users/someone/visuals/x.html'"),
          { code: 'EIO' },
        ),
      );
    await expect(
      dispatcher.query('core.chat.visual.read', params, { caller }),
    ).rejects.toMatchObject({
      payload: { kind: 'internal', message: 'Chat visual read failed.' },
    });
  });
  it('captures the exact legacy results from all three dispatched service calls', async () => {
    const port = portFixture();
    const searchMock = jest.spyOn(port, 'searchTranscript');
    const toolOutputMock = jest.spyOn(port, 'readToolOutput');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const page = await dispatcher.queryChatTranscriptPageForLegacyIpc(
      { scope },
      { caller },
    );
    expect(page.legacyResult).toEqual(
      await port.getTranscriptPage({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/private',
    );
    expect(JSON.stringify(page.canonicalResult)).toContain(
      '/Users/alice/project/file.ts',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/private.png',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/raw.jsonl',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/revert.md',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      'host orchestration',
    );
    expect(page.canonicalResult.messages).toHaveLength(1);
    expect(page.legacyResult.turns?.[0]?.files).toEqual([
      { path: '/local/deliverable.md', state: 'ready' },
    ]);
    expect(page.canonicalResult.turns?.[0]).not.toHaveProperty('files');
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/deliverable.md',
    );
    const search = await dispatcher.queryChatTranscriptSearchForLegacyIpc(
      { scope, query: 'hello' },
      { caller },
      'search-1',
    );
    expect(search.legacyResult).toEqual(
      await port.searchTranscript({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        query: 'hello',
        requestId: 'search-1',
      }),
    );
    const reference = {
      version: 1 as const,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 5,
      encoding: 'utf-8' as const,
      mediaType: 'text/plain' as const,
    };
    const output = await dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
        offset: 0,
        limit: 4,
      },
      { caller },
      'output-1',
    );
    expect(output.legacyResult).toEqual(
      await port.readToolOutput({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
        offset: 0,
        limit: 4,
        requestId: 'output-1',
      }),
    );
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'search-1' }),
      expect.any(AbortSignal),
    );
    expect(toolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'output-1' }),
      expect.any(AbortSignal),
    );
  });

  it('rejects absent services and foreign authorities before reading', async () => {
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => null },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc(
        { scope: { ...scope, authorityId: 'remote' } },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('reports service identifier failures as invalid arguments', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'getTranscriptPage')
      .mockRejectedValue(new IdentifierValidationError('Invalid chatId'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it.each([
    ['Unknown chat: chat-1', 'not_found'],
    ['Standalone archive not found', 'not_found'],
    ['Invalid transcript page cursor', 'invalid_argument'],
    ['Unknown transcript turn', 'invalid_argument'],
    ['Invalid turn page cursor', 'invalid_argument'],
    ["Couldn't load messages.", 'internal'],
  ])('classifies page service error %s as %s', async (message, kind) => {
    const port = portFixture();
    const cause = new Error(message);
    jest.spyOn(port, 'getTranscriptPage').mockRejectedValue(cause);
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind }, runtimeCause: cause });
  });

  it('classifies an unknown chat in search as not found', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'searchTranscript')
      .mockRejectedValue(new Error('Unknown chat: chat-1'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptSearchForLegacyIpc(
        { scope, query: 'hello' },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('classifies an unknown chat in a canonical tool-output read as not found', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'readToolOutput')
      .mockRejectedValue(new Error('Unknown chat: chat-1'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.query(
        'core.chat.toolOutput.read',
        {
          scope,
          messageId: 'message-1',
          toolUseId: 'tool-1',
          reference: {
            version: 1,
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            byteLength: 5,
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
          offset: 0,
          limit: 4,
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('aborts a running search through the dispatcher signal', async () => {
    const port = portFixture();
    let observed: AbortSignal | undefined;
    jest
      .spyOn(port, 'searchTranscript')
      .mockImplementation((_request, signal) => {
        observed = signal;
        return new Promise(() => undefined);
      });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatTranscriptSearchForLegacyIpc(
      { scope, query: 'hello' },
      { caller, signal: controller.signal },
      'search-1',
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    expect(observed?.aborted).toBe(true);
  });

  it('keeps the backend result when cancellation races with tool-output completion', async () => {
    const port = portFixture();
    let observed: AbortSignal | undefined;
    let release: (() => void) | undefined;
    jest
      .spyOn(port, 'readToolOutput')
      .mockImplementation((_request, signal) => {
        observed = signal;
        return new Promise((resolve) => {
          release = (): void => resolve({ text: 'hello', byteLength: 5 });
        });
      });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference: {
          version: 1,
          artifactId: `sha256-v1-${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          byteLength: 5,
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
        offset: 0,
        limit: 4,
      },
      { caller, signal: controller.signal },
      'output-1',
    );
    let settled = false;
    const outcome = pending.then(
      () => {
        settled = true;
        return 'resolved';
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await Promise.resolve();
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release?.();
    await expect(outcome).resolves.toBe('resolved');
    await expect(pending).resolves.toEqual({
      canonicalResult: { text: 'hello', byteLength: 5 },
      legacyResult: { text: 'hello', byteLength: 5 },
    });
    expect(observed?.aborted).toBe(true);
  });

  it('keeps the backend error when cancellation races with tool-output failure', async () => {
    const port = portFixture();
    const backendError = new Error('backend read failed');
    backendError.name = 'AbortError';
    let rejectRead: ((error: Error) => void) | undefined;
    jest.spyOn(port, 'readToolOutput').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference: {
          version: 1,
          artifactId: `sha256-v1-${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          byteLength: 5,
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
        offset: 0,
        limit: 4,
      },
      { caller, signal: controller.signal },
      'output-1',
    );
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    rejectRead?.(backendError);
    await expect(outcome).resolves.toBe(backendError);
  });
});
