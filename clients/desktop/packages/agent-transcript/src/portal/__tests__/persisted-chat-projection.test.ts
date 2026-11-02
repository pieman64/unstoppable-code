import {
  isVisiblePersistedChatMessage,
  type PersistedChatMessage,
} from '../../types';
import {
  PORTAL_CHAT_TEXT_MAX_CHARS,
  PORTAL_CHAT_UNBOUNDED_LIMITS,
  portalChatMessagesToPersisted,
  publishedChatToPersistedTab,
  persistedMessageToPortalMessage,
  persistedParts,
} from '../persisted-chat-projection';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import { isTurnFileRecord } from '@canopy/protocol/turn-files';

describe('persisted chat projection limits', () => {
  it.each(['completed', 'cancelled', 'failed', undefined] as const)(
    'preserves exact-execution timer outcome %s through Portal export/import',
    (outcome) => {
      const message: PersistedChatMessage = {
        id: 'T:timer',
        role: 'system',
        timestamp: 100,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'T',
            userMessageId: 'A',
            startedAt: 100,
            completedAt: 200,
            ...(outcome === undefined ? {} : { outcome }),
          },
        ],
      };
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'c',
        message,
      });
      expect(
        portalChatMessagesToPersisted([projected]).messages[0].blocks,
      ).toEqual(message.blocks);
    },
  );

  it('projects external-agent provenance for both chat scopes', () => {
    const message: PersistedChatMessage = {
      id: 'external-user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Inspect this project' }],
      agentSent: {
        kind: 'external_agent',
        connectionId: '11111111-1111-4111-8111-111111111111',
        clientName: 'External test client',
        verified: false,
        userId: '22222222-2222-4222-8222-222222222222',
      },
    };
    for (const scope of ['worktree', 'standalone'] as const) {
      expect(
        persistedMessageToPortalMessage({ scope, chatId: 'chat-1', message }),
      ).toMatchObject({ agentSent: message.agentSent, role: 'user' });
      const ordinary: PersistedChatMessage = { ...message };
      delete ordinary.agentSent;
      expect(
        persistedMessageToPortalMessage({
          scope,
          chatId: 'chat-1',
          message: ordinary,
        }),
      ).not.toHaveProperty('agentSent');
    }
  });
  it('projects supported recovery records without granting transcript authority', () => {
    const record = {
      version: 1,
      ownerId: 'owner',
      activationId: 'activation',
      attemptId: 'attempt',
      originatingMessageId: 'message',
      providerSessionId: 'session',
      provider: 'claude',
      trigger: 'auth',
      requiredTargets: [
        { kind: 'standalone', serverId: 'server', configId: 'config' },
      ],
      desiredGeneration: 1,
      phase: 'connecting',
      cancelled: false,
      admission: 'not_sent',
      retryEligible: false,
    };
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: {
        id: 'valid-record',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'mcp_activation', record }],
      },
    });
    expect(projected.parts).toContainEqual({
      kind: 'mcp_activation',
      data: { record },
    });
    expect(
      portalChatMessagesToPersisted([projected]).messages[0]?.blocks,
    ).toContainEqual({ type: 'mcp_activation', record });
  });

  it.each([{ version: 2 }, null])(
    'omits unsupported MCP blocks from the display projection (%j)',
    (unsupported: unknown) => {
      const message: PersistedChatMessage = {
        id: 'future-record',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'text', text: 'Keep this text' },
          { type: 'mcp_activation', record: unsupported },
        ],
      };
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat',
        message,
      });
      expect(projected.text).toBe('Keep this text');
      expect(
        (projected.parts ?? []).some((part) => part.kind === 'mcp_activation'),
      ).toBe(false);
      expect(message.blocks[1]).toEqual({
        type: 'mcp_activation',
        record: unsupported,
      });
    },
  );

  it.each([
    'human',
    'watcher',
    'deferred_tools_reload',
    'immediate_turn_restart',
  ] as const)(
    'projects %s provenance independently of the prompt text',
    (userMessageSource) => {
      expect(
        persistedMessageToPortalMessage({
          scope: 'worktree',
          chatId: 'chat-1',
          message: {
            id: 'prompt',
            role: 'user',
            timestamp: 1,
            userMessageSource,
            blocks: [{ type: 'text', text: 'Plain text' }],
          },
        }),
      ).toMatchObject({
        promptSource: userMessageSource === 'human' ? 'human' : 'automated',
      });
    },
  );
  it.each([
    {
      name: 'a single watcher',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    },
    {
      name: 'merged watchers',
      watcherFired: {
        kind: 'Multiple watchers fired (2)',
        combinedWatchers: [
          { kind: 'Pipeline completion (Deploy)', text: 'Deploy succeeded' },
          { kind: 'Chat completion', text: 'Review finished' },
        ],
      },
    },
  ])('carries watcher attribution for $name', ({ watcherFired }) => {
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message: {
        id: 'watcher',
        role: 'user',
        timestamp: 1,
        userMessageSource: 'watcher',
        watcherFired,
        blocks: [{ type: 'text', text: 'Canopy watcher fired.' }],
      },
    });
    expect(projected.promptSource).toBe('automated');
    expect(projected.watcherFired).toEqual(watcherFired);
    expect(projected.parts).toEqual([
      { kind: 'prompt_source', data: { source: 'automated', watcherFired } },
    ]);
  });
  it.each([
    { userMessageSource: 'human', source: 'human' },
    { userMessageSource: 'hook', source: 'automated' },
    { userMessageSource: 'deferred_tools_reload', source: 'automated' },
  ] as const)(
    'omits watcher attribution from $userMessageSource prompts',
    ({ userMessageSource, source }) => {
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message: {
          id: 'prompt',
          role: 'user',
          timestamp: 1,
          userMessageSource,
          blocks: [{ type: 'text', text: 'Canopy watcher fired.' }],
        },
      });
      expect(projected).not.toHaveProperty('watcherFired');
      expect(projected.parts).toEqual([
        { kind: 'prompt_source', data: { source } },
      ]);
    },
  );
  it('excludes host-only hidden messages before Portal projection', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'visible-user',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'visible request' }],
      },
      {
        id: 'hidden-delivery',
        role: 'user',
        hidden: true,
        timestamp: 2,
        blocks: [{ type: 'text', text: 'private orchestration payload' }],
      },
    ];

    const projected = messages.filter(isVisiblePersistedChatMessage);
    expect(projected.map((message) => message.id)).toEqual(['visible-user']);
    expect(JSON.stringify(projected)).not.toContain('private orchestration');
    const hidden = messages[1];
    if (!hidden) throw new Error('missing hidden fixture');
    expect(() =>
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message: hidden,
      }),
    ).toThrow('Hidden persisted messages cannot be projected');
  });

  it('projects only safe agent-sent display metadata and leaves older rows unchanged', () => {
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'project-1',
        taskId: 'task-1',
        chatId: 'sender-chat-1',
      },
      chatTitle: 'Fix flaky tests',
      projectLabel: 'Repository',
    };
    const agentMessage: PersistedChatMessage = {
      id: 'agent-message',
      role: 'user',
      timestamp: 1,
      userMessageSource: 'agent',
      agentSent,
      blocks: [{ type: 'text', text: 'I found the failing case.' }],
    };
    const legacyMessage: PersistedChatMessage = {
      id: 'legacy-user-message',
      role: 'user',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'A message from an older row.' }],
    };

    const projectedAgentMessage = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'receiving-chat',
      message: agentMessage,
    });
    const projectedLegacyMessage = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'receiving-chat',
      message: legacyMessage,
    });

    expect(projectedAgentMessage.agentSent).toEqual(agentSent);
    expect(projectedAgentMessage).not.toHaveProperty('hiddenContext');
    expect(projectedLegacyMessage).not.toHaveProperty('agentSent');
  });

  it('retains the existing Portal defaults and supports an unbounded publisher projection', () => {
    const text = 'x'.repeat(PORTAL_CHAT_TEXT_MAX_CHARS + 1_000);
    const message: PersistedChatMessage = {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text }],
    };
    const input = {
      scope: 'standalone' as const,
      chatId: 'chat-1',
      message,
    };

    expect(persistedMessageToPortalMessage(input).text).toContain('[truncated');
    expect(
      persistedMessageToPortalMessage(input, {
        textMaxChars: Infinity,
        partTextMaxChars: Infinity,
      }).text,
    ).toBe(text);
  });

  it('projects picked-up steering metadata as a neutral Portal part', () => {
    const message: PersistedChatMessage = {
      id: 'steering-1',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Use the latest test result',
          steering: { startsTurn: false, rootUserMessageId: 'root-1' },
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    expect(projected.parts).toContainEqual({
      kind: 'steering',
      data: { startsTurn: false, rootUserMessageId: 'root-1' },
    });
    expect(
      portalChatMessagesToPersisted([projected]).messages[0]?.blocks[0],
    ).toEqual({
      type: 'text',
      text: 'Use the latest test result',
      steering: { startsTurn: false, rootUserMessageId: 'root-1' },
    });
  });

  it('marks user messages that continue the current turn', () => {
    const project = (message: PersistedChatMessage): true | undefined =>
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message,
      }).continuesTurn;
    const user = (
      block: PersistedChatMessage['blocks'][number],
    ): PersistedChatMessage => ({
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      blocks: [block],
    });

    expect(
      project(
        user({ type: 'text', text: 'Steer', steering: { startsTurn: false } }),
      ),
    ).toBe(true);
    expect(
      project(
        user({
          type: 'text',
          text: 'Mars',
          asyncQuestionAnswer: {
            requestId: 'req-1',
            startsTurn: false,
            answers: [{ question: 'Which planet?', selectedOptions: ['Mars'] }],
          },
        }),
      ),
    ).toBe(true);
    expect(project(user({ type: 'text', text: 'A new prompt' }))).toBe(
      undefined,
    );
  });

  it('preserves steering metadata for attachment-only Portal messages', () => {
    const [message] = portalChatMessagesToPersisted([
      {
        messageId: 'steering-attachment-only',
        chatId: 'chat-1',
        role: 'user',
        status: 'complete',
        text: '',
        createdAtMs: 1,
        parts: [
          {
            kind: 'steering',
            data: { startsTurn: false, rootUserMessageId: 'root-1' },
          },
          {
            kind: 'attachment',
            data: { attachmentPaths: ['/publisher/path/image.png'] },
          },
        ],
      },
    ]).messages;

    expect(message?.blocks[0]).toEqual({
      type: 'text',
      text: '',
      steering: { startsTurn: false, rootUserMessageId: 'root-1' },
    });
  });

  it('keeps verbatim tool output inert when projected to Markdown-only Portal text', () => {
    const message: PersistedChatMessage = {
      id: 'message-verbatim',
      role: 'system',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Tool output (tests)\n\n![Tracking](https://attacker.example/pixel)',
          verbatim: true,
        },
      ],
    };

    expect(
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message,
      }).text,
    ).toBe(
      '    Tool output (tests)\n    \n    ![Tracking](https://attacker.example/pixel)',
    );
  });

  it('keeps lone carriage returns inside the verbatim Markdown literal', () => {
    const message: PersistedChatMessage = {
      id: 'message-verbatim-cr',
      role: 'system',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Safe output\r![Tracking](https://attacker.example/pixel)',
          verbatim: true,
        },
      ],
    };

    expect(
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message,
      }).text,
    ).toBe('    Safe output\n    ![Tracking](https://attacker.example/pixel)');
  });

  it('preserves a normal long response while retaining a bounded Portal default', () => {
    const text = 'x'.repeat(10_000);
    const message: PersistedChatMessage = {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text }],
    };
    const input = {
      scope: 'standalone' as const,
      chatId: 'chat-1',
      message,
    };

    expect(persistedMessageToPortalMessage(input).text).toBe(text);
    expect(
      persistedMessageToPortalMessage(input, {
        textMaxChars: Infinity,
        partTextMaxChars: Infinity,
      }).text,
    ).toBe(text);

    const oversized = {
      ...input,
      message: {
        ...message,
        blocks: [
          {
            type: 'text' as const,
            text: 'y'.repeat(PORTAL_CHAT_TEXT_MAX_CHARS + 1_000),
          },
        ],
      },
    };
    const bounded = persistedMessageToPortalMessage(oversized).text;
    expect(bounded).toHaveLength(PORTAL_CHAT_TEXT_MAX_CHARS);
    expect(bounded).toContain('[truncated');
  });

  it('supports an unbounded structural projection for published tool data', () => {
    const toolInput = {
      items: Array.from({ length: 25 }, (_, index) => `item-${index}`),
      fields: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`field-${index}`, index]),
      ),
      nested: { level1: { level2: { level3: 'preserved' } } },
    };
    const message: PersistedChatMessage = {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'inspect',
          input: '{}',
        },
      ],
    };
    const legacyToolUseBlock = message.blocks.find(
      (block) => block.type === 'tool_use',
    );
    if (legacyToolUseBlock?.type !== 'tool_use') {
      throw new Error('Expected tool-use block in the legacy fixture');
    }
    // Simulate a pre-canonical persisted object input without widening the
    // current block type or routing the fixture through JSON.parse's `any`.
    Object.defineProperty(legacyToolUseBlock, 'input', {
      value: toolInput,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const input = {
      scope: 'standalone' as const,
      chatId: 'chat-1',
      message,
    };

    const boundedPart = persistedMessageToPortalMessage(input).parts?.find(
      (part) => part.kind === 'tool_use',
    );
    const unboundedPart = persistedMessageToPortalMessage(input, {
      textMaxChars: Infinity,
      partTextMaxChars: Infinity,
      objectMaxDepth: Infinity,
      objectMaxKeys: Infinity,
      arrayMaxItems: Infinity,
    }).parts?.find((part) => part.kind === 'tool_use');

    const projectedInput = (part: typeof boundedPart): unknown => {
      if (
        part?.kind !== 'tool_use' ||
        typeof part.data !== 'object' ||
        part.data === null ||
        !('input' in part.data)
      ) {
        return undefined;
      }
      return part.data.input;
    };

    expect(projectedInput(boundedPart)).not.toEqual(toolInput);
    expect(projectedInput(unboundedPart)).toEqual(toolInput);
  });
});

describe('published portal chat import', () => {
  it('imports a projected prompt without warning about its nonvisual provenance', () => {
    const message = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'source',
      message: {
        id: 'prompt',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Hello' }],
      },
    });
    const result = publishedChatToPersistedTab(
      {
        schemaVersion: 1,
        chatId: 'source',
        title: 'Chat',
        createdAt: '2026-10-15',
        messages: [message],
      },
      {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'copy',
        resolveAttachment: () => undefined,
      },
    );
    expect(result.warnings).toEqual([]);
    expect(result.tab.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('rehydrates a complete tab with local attachment paths and warnings', () => {
    const result = publishedChatToPersistedTab(
      {
        schemaVersion: 1,
        chatId: 'source-chat',
        title: 'Shared chat',
        description: 'Published transcript',
        createdAt: '2026-09-09T12:00:00.000Z',
        messages: [
          {
            messageId: 'message-1',
            chatId: 'source-chat',
            role: 'user',
            status: 'complete',
            text: 'Read this',
            createdAtMs: 1,
            parts: [
              {
                kind: 'attachment',
                data: {
                  attachmentPaths: ['attachment-1', 'missing'],
                },
              },
              { kind: 'thinking', data: { text: 42 } },
            ],
          },
        ],
      },
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'local-chat',
        resolveAttachment: (ref) =>
          ref === 'attachment-1' ? '/local/report.md' : undefined,
      },
    );

    expect(result.tab).toMatchObject({
      id: 'local-chat',
      title: 'Shared chat',
      description: 'Published transcript',
      createdAt: '2026-09-09T12:00:00.000Z',
    });
    expect(result.tab.messages[0]?.attachmentPaths).toEqual([
      '/local/report.md',
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining('missing'),
      expect.stringContaining('thinking'),
    ]);
    expect(result.tab).not.toHaveProperty('sdkSessionId');
    expect(result.tab).not.toHaveProperty('pluginSelections');
  });

  it('keeps a valid tab when ids drift and hostile part data exceeds bounds', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 12; depth += 1) nested = { nested };
    const result = publishedChatToPersistedTab(
      {
        schemaVersion: 1,
        chatId: 'source-chat',
        title: 'Hostile chat',
        createdAt: '2026-09-09T12:00:00.000Z',
        messages: [
          {
            messageId: 'duplicate',
            chatId: 'wrong-chat',
            role: 'assistant',
            status: 'complete',
            text: 'First',
            createdAtMs: 1,
            parts: [{ kind: 'thinking', data: nested }],
          },
          {
            messageId: 'duplicate',
            chatId: 'source-chat',
            role: 'assistant',
            status: 'complete',
            text: 'Second',
            createdAtMs: 2,
            parts: [{ kind: 'future-part' as 'thinking', data: {} }],
          },
        ],
      },
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'local-chat',
        resolveAttachment: () => undefined,
      },
    );

    expect(result.tab.messages).toHaveLength(2);
    expect(new Set(result.tab.messages.map((message) => message.id)).size).toBe(
      2,
    );
    expect(
      result.tab.messages[0]?.blocks.some(
        (block) =>
          block.type === 'text' && block.text.includes('content unavailable'),
      ),
    ).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('different chat id'),
        expect.stringContaining('replaced'),
        expect.stringContaining('deeply nested'),
        expect.stringContaining('future-part'),
      ]),
    );
  });

  it('keeps publisher-controlled attachment paths out of persisted messages', () => {
    const result = portalChatMessagesToPersisted([
      {
        messageId: 'message-1',
        chatId: 'chat-1',
        role: 'user',
        status: 'complete',
        text: 'See the attachment',
        createdAtMs: 1,
        parts: [
          {
            kind: 'attachment',
            data: {
              attachmentPaths: ['/etc/passwd', '\\\\server\\share\\secret.txt'],
            },
          },
        ],
      },
    ]);

    expect(result.messages[0]?.attachmentPaths).toBeUndefined();
    expect(result.messages[0]?.blocks).toContainEqual({
      type: 'text',
      text: '[Shared attachment]',
    });
  });

  it('drops unresolved published file references instead of persisting their paths', () => {
    const result = publishedChatToPersistedTab(
      {
        schemaVersion: 1,
        chatId: 'source-chat',
        title: 'Shared chat',
        createdAt: '2026-09-09T12:00:00.000Z',
        messages: [
          {
            messageId: 'message-1',
            chatId: 'source-chat',
            role: 'user',
            status: 'complete',
            text: 'Read these files',
            createdAtMs: 1,
            parts: [
              {
                kind: 'attachment',
                data: {
                  references: [
                    { displayPath: '/etc/passwd' },
                    {
                      displayPath: 'report.md',
                      artifactRef: 'attachments/report',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'local-chat',
        resolveAttachment: (reference) =>
          reference === 'attachments/report' ? '/local/report.md' : undefined,
      },
    );

    expect(result.tab.messages[0]?.attachmentPaths).toEqual([
      '/local/report.md',
    ]);
    expect(result.tab.messages[0]?.blocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'file_references' }),
      ]),
    );
    expect(JSON.stringify(result.tab.messages)).not.toContain('/etc/passwd');
    expect(result.warnings).toEqual([
      expect.stringContaining('could not be resolved'),
    ]);
  });

  it('validates every part kind and preserves surrounding messages when payloads are corrupt', () => {
    const portalMessages: PortalChatMessage[] = [
      {
        messageId: 'before',
        chatId: 'chat-1',
        role: 'user',
        status: 'complete',
        text: 'Before',
        createdAtMs: 1,
      },
      {
        messageId: 'parts',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: 'Answer',
        createdAtMs: 2,
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'tool-1',
              toolName: 'Read',
              input: { path: 'x' },
            },
          },
          {
            kind: 'tool_result',
            data: { toolUseId: 'tool-1', output: 'done', isError: false },
          },
          { kind: 'thinking', data: { text: 'reasoning' } },
          {
            kind: 'attachment',
            data: { references: [{ displayPath: 'report.md' }] },
          },
          { kind: 'image', data: { mimeType: 'image/png' } },
          { kind: 'agent', data: { description: 'researcher' } },
          {
            kind: 'turn_timer',
            data: { startedAt: 10, completedAt: 20 },
          },
          { kind: 'thinking', data: { text: 42 } },
          { kind: 'unknown' as 'thinking', data: {} },
        ],
      },
      {
        messageId: 'after',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: 'After',
        createdAtMs: 3,
      },
    ];

    const result = portalChatMessagesToPersisted(portalMessages, [
      {
        userMessageId: 'before',
        intermediateMessageIds: ['parts'],
        finalMessageIds: ['after'],
        summary: { readCount: 1 },
        files: [{ path: 'report.md', state: 'ready', change: 'updated' }],
      },
    ]);

    expect(result.messages.map((message) => message.id)).toEqual([
      'before',
      'parts',
      'after',
    ]);
    expect(result.turnGroups[0]?.files).toEqual([
      { path: 'report.md', state: 'ready', change: 'updated' },
    ]);
    expect(result.messages[1]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_use', toolUseId: 'tool-1' }),
        expect.objectContaining({ type: 'tool_result', toolUseId: 'tool-1' }),
        { type: 'thinking', text: 'reasoning' },
        expect.objectContaining({ type: 'file_references' }),
        expect.objectContaining({ type: 'turn_timer', completedAt: 20 }),
      ]),
    );
    expect(
      result.messages[1]?.blocks.some(
        (block) =>
          block.type === 'text' && block.text.includes('content unavailable'),
      ),
    ).toBe(true);
    expect(result.turnGroups).toEqual([
      expect.objectContaining({ userMessageId: 'before' }),
    ]);
  });
});

describe('turn file evidence transport', () => {
  const group: PortalChatTurnGroup = {
    userMessageId: 'prompt',
    intermediateMessageIds: [],
    finalMessageIds: ['final'],
  };

  it('round-trips updated, pending, failed and legacy records through JSON', () => {
    const files: NonNullable<PortalChatTurnGroup['files']> = [
      {
        path: '/ws/report.md',
        state: 'ready',
        change: 'updated',
        target: { projectId: 'project', worktreeId: 'worktree' },
      },
      { path: 'pending.md', state: 'creating', change: 'updated' },
      { path: 'failed.md', state: 'failed', change: 'updated' },
      { path: 'saved.md', state: 'ready' },
    ];
    const transported: unknown = JSON.parse(JSON.stringify(files));
    if (!Array.isArray(transported) || !transported.every(isTurnFileRecord))
      throw new Error('Expected transported file evidence');
    const result = portalChatMessagesToPersisted(
      [],
      [{ ...group, files: transported }, group],
    );
    expect(result.turnGroups).toEqual([{ ...group, files }, group]);
    expect(result.turnGroups[0]?.files?.[3]).not.toHaveProperty('change');
    expect(result.turnGroups[1]).not.toHaveProperty('files');
  });

  it.each([
    { files: null },
    { files: {} },
    { files: [{ path: 'report.md', state: 'ready', change: 'deleted' }] },
    { files: [{ path: 'report.md', state: 'ready', change: null }] },
    { files: [{ path: 'report.md', state: 'updating', change: 'updated' }] },
    { files: [{ path: 'https://example.com/report.md', state: 'ready' }] },
    {
      files: [
        { path: 'report.md', state: 'ready', target: { projectId: 'project' } },
      ],
    },
  ])('rejects invalid imported file evidence: $files', ({ files }) => {
    const invalidGroup = { ...group };
    Object.defineProperty(invalidGroup, 'files', { value: files });
    expect(
      portalChatMessagesToPersisted([], [invalidGroup, group]).turnGroups,
    ).toEqual([group]);
  });
});

describe('persisted attachments projection', () => {
  it('emits display attachments for a user message with attachmentPaths', () => {
    const message: PersistedChatMessage = {
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Look at this' }],
      attachmentPaths: ['/w/attachments/t/screen.png'],
    };
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    expect(projected.attachments).toEqual([
      expect.objectContaining({
        filename: 'screen.png',
        mediaType: 'image/png',
      }),
    ]);
  });

  it('omits attachments for assistant rows and rows without paths', () => {
    const message: PersistedChatMessage = {
      id: 'a-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'ok' }],
      attachmentPaths: ['/w/attachments/t/screen.png'],
    };
    expect(
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'c',
        message,
      }),
    ).not.toHaveProperty('attachments');
  });
});

it('projects Cursor display fields while retaining raw persisted tool data', () => {
  const block = {
    type: 'tool_use' as const,
    toolUseId: 't',
    toolName: 'Read file',
    input: '{"path":"file"}',
    display: { toolName: 'Read', input: '{"file_path":"file"}' },
  };
  const projected = persistedMessageToPortalMessage({
    scope: 'worktree',
    chatId: 'c',
    message: { id: 'm', role: 'assistant', timestamp: 1, blocks: [block] },
  });
  expect(projected.parts).toContainEqual(
    expect.objectContaining({
      kind: 'tool_use',
      data: { toolUseId: 't', toolName: 'Read', input: '{"file_path":"file"}' },
    }),
  );
  expect(block.toolName).toBe('Read file');
});

// Slice 5, PR 1 (desktop adopts the shared transcript): the local desktop
// projection must not lose the blocks the desktop renders. Image and
// compaction blocks project to the part kinds the shared view already knows,
// and in-flight turn timers project when a host asks for them.
describe('desktop-fidelity parts', () => {
  const at = 1_700_000_000_000;

  it('projects image blocks, carrying local sources only on explicit opt-in', () => {
    const message: PersistedChatMessage = {
      id: 'message-image',
      role: 'assistant',
      timestamp: at,
      blocks: [
        {
          type: 'image',
          path: '/tmp/generated/chart.png',
          dataUrl: 'data:image/png;base64,AAAA',
          alt: 'Generated chart',
        },
      ],
    };
    const bounded = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    // The wire carries the alt text alone: the absolute on-host path names
    // the desktop's filesystem and does not belong on the portal wire.
    expect(bounded.parts).toEqual([
      { kind: 'image', data: { alt: 'Generated chart' } },
    ]);
    // Lifted caps alone are NOT the signal: the shared-container publish
    // path projects with every cap at Infinity and must never inline a
    // raster or a machine path into the published envelope.
    const unbounded = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat-1', message },
      PORTAL_CHAT_UNBOUNDED_LIMITS,
    );
    expect(unbounded.parts?.[0]?.data).toEqual({ alt: 'Generated chart' });
    const paired = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat-1', message },
      { includeAssetReferences: true },
    );
    expect(paired.parts?.[0]?.data).toEqual({
      assetId: `asset-${encodeURIComponent(message.id)}-image-0`,
      alt: 'Generated chart',
    });
    const local = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat-1', message },
      { ...PORTAL_CHAT_UNBOUNDED_LIMITS, includeLocalImageSources: true },
    );
    expect(local.parts?.[0]?.data).toEqual({
      path: '/tmp/generated/chart.png',
      dataUrl: 'data:image/png;base64,AAAA',
      alt: 'Generated chart',
    });
  });

  it('caps image alt text like every other part text on the wire', () => {
    const message: PersistedChatMessage = {
      id: 'message-image-alt',
      role: 'assistant',
      timestamp: at,
      blocks: [
        {
          type: 'image',
          path: '/tmp/generated/chart.png',
          alt: 'a'.repeat(5_000),
        },
      ],
    };
    const bounded = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    const alt = bounded.parts?.[0]?.data;
    const altText =
      alt && typeof alt === 'object' && 'alt' in alt ? alt.alt : undefined;
    expect(typeof altText).toBe('string');
    expect((altText as string).length).toBeLessThan(5_000);
    const local = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat-1', message },
      { ...PORTAL_CHAT_UNBOUNDED_LIMITS, includeLocalImageSources: true },
    );
    expect(local.parts?.[0]?.data).toMatchObject({ alt: 'a'.repeat(5_000) });
  });

  it('projects compaction info to the compaction part the shared view renders', () => {
    const message: PersistedChatMessage = {
      id: 'message-compaction',
      role: 'system',
      timestamp: at,
      blocks: [
        {
          type: 'compaction_info',
          timestamp: at + 5,
          provider: 'claude',
          interfaceMode: 'canopy',
          reason: 'context_window',
          summary: 'Earlier tool output was summarized.',
        },
      ],
    };
    expect(
      persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message,
      }).parts,
    ).toEqual([
      {
        kind: 'compaction',
        data: {
          occurredAt: at + 5,
          // Who compacted travels too, so the renderer can name Codex or
          // Claude Code instead of captioning every banner as Claude's.
          provider: 'claude',
          interfaceMode: 'canopy',
          trigger: 'context_window',
          summary: 'Earlier tool output was summarized.',
        },
      },
    ]);
  });

  it('projects an account proxy switch only for the owner, never when publishing', () => {
    const message: PersistedChatMessage = {
      id: 'message-switch',
      role: 'system',
      timestamp: at,
      blocks: [
        {
          type: 'account_proxy_switch',
          timestamp: at + 5,
          account: 'sam@example.com',
          previousAccount: 'ops@example.com',
          previousAtLimit: true,
          provider: 'claude',
          sourceEventId: 'switch-1',
        },
      ],
    };
    const input = { scope: 'worktree' as const, chatId: 'chat-1', message };
    expect(
      persistedMessageToPortalMessage(input, {
        includeAccountProxySwitches: true,
      }).parts,
    ).toEqual([
      {
        kind: 'account_switch',
        data: {
          occurredAt: at + 5,
          account: 'sam@example.com',
          previousAccount: 'ops@example.com',
          previousAtLimit: true,
        },
      },
    ]);
    // The publish path projects without the opt-in: the account labels stay
    // with the chat's owner.
    expect(
      persistedMessageToPortalMessage(input, PORTAL_CHAT_UNBOUNDED_LIMITS)
        .parts ?? [],
    ).toEqual([]);
  });

  it('imports a published compaction part without an unknown-kind warning', () => {
    const result = publishedChatToPersistedTab(
      {
        schemaVersion: 1,
        chatId: 'source-chat',
        title: 'Shared chat',
        createdAt: '2026-09-09T12:00:00.000Z',
        messages: [
          {
            messageId: 'message-1',
            chatId: 'source-chat',
            role: 'system',
            status: 'complete',
            text: '',
            createdAtMs: at,
            parts: [
              {
                kind: 'compaction',
                data: { occurredAt: at + 5, summary: 'Summarized.' },
              },
            ],
          },
        ],
      },
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'local-chat',
        resolveAttachment: () => undefined,
      },
    );
    expect(result.warnings).toEqual([]);
    expect(result.tab.messages[0]?.blocks).toEqual([
      { type: 'text', text: '[Conversation context compacted] Summarized.' },
    ]);
  });

  it('projects an in-flight turn timer only when the host opts in', () => {
    const message: PersistedChatMessage = {
      id: 'message-live-timer',
      role: 'assistant',
      timestamp: at,
      blocks: [{ type: 'turn_timer', startedAt: at, completedAt: null }],
    };
    const wire = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    expect(wire.parts).toBeUndefined();
    expect(wire.status).toBe('complete');
    const local = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat-1', message },
      { ...PORTAL_CHAT_UNBOUNDED_LIMITS, includeInFlightTurnTimers: true },
    );
    // The shared view hides an unfinished timer on a completed message, so
    // the in-flight opt-in marks the message as still streaming.
    expect(local.status).toBe('streaming');
    expect(local.parts).toEqual([
      {
        kind: 'turn_timer',
        data: {
          startedAt: at,
          pausedAt: undefined,
          resumedAt: undefined,
          accumulatedPausedDurationMs: undefined,
          completedAt: null,
        },
      },
    ]);
  });
});

describe('persisted chat projection plugin mentions', () => {
  it('keeps plugin mentions out of the attachment part but keeps file references', () => {
    const message: PersistedChatMessage = {
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'file_references',
          references: [
            { displayPath: 'src/app.ts', absolutePath: '/repo/src/app.ts' },
            {
              displayPath: 'figma',
              absolutePath: 'plugin://claude-plugins-official/figma',
              kind: 'plugin',
            },
          ],
        },
        { type: 'text', text: 'Use figma on src/app.ts' },
      ],
    };

    const parts = persistedParts(message);
    const attachment = parts.find((part) => part.kind === 'attachment');
    expect(attachment).toBeDefined();
    expect(attachment?.data).toEqual({
      references: [
        { displayPath: 'src/app.ts', absolutePath: '/repo/src/app.ts' },
      ],
    });
  });

  it('drops the attachment part entirely when only plugins are mentioned', () => {
    const message: PersistedChatMessage = {
      id: 'user-2',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'file_references',
          references: [
            {
              displayPath: 'figma',
              absolutePath: 'plugin://claude-plugins-official/figma',
              kind: 'plugin',
            },
          ],
        },
        { type: 'text', text: 'Use figma' },
      ],
    };

    expect(
      persistedParts(message).some((part) => part.kind === 'attachment'),
    ).toBe(false);
  });
});

describe('canonical turn timer identity', () => {
  it('carries the execution and anchor through projection and import', () => {
    const timer: PersistedChatMessage = {
      id: 'T:timer',
      role: 'system',
      timestamp: 10,
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'T',
          userMessageId: 'A',
          startedAt: 10,
          completedAt: 20,
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message: timer,
    });
    expect(projected.parts).toMatchObject([
      { kind: 'turn_timer', data: { turnId: 'T', userMessageId: 'A' } },
    ]);
    expect(portalChatMessagesToPersisted([projected]).messages).toMatchObject([
      {
        id: 'T:timer',
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'T',
            userMessageId: 'A',
            completedAt: 20,
          },
        ],
      },
    ]);
  });

  it("carries a wake's cause through projection and import", () => {
    const timer: PersistedChatMessage = {
      id: 'W:timer',
      role: 'system',
      timestamp: 10,
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'W',
          spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
          startedAt: 10,
          completedAt: 20,
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message: timer,
    });
    expect(projected.parts).toMatchObject([
      {
        kind: 'turn_timer',
        data: { spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' } },
      },
    ]);
    expect(portalChatMessagesToPersisted([projected]).messages).toMatchObject([
      {
        blocks: [
          {
            type: 'turn_timer',
            spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
          },
        ],
      },
    ]);
  });

  it.each([
    ['an event wake', { taskId: 'task-1', toolUseId: 'tool-1', event: true }],
    ['a cron fire', { toolUseId: 'tool-1', scheduled: true }],
  ] as const)(
    "carries %s's cause through projection and import",
    (_name, spawnedBy) => {
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        message: {
          id: 'W:timer',
          role: 'system',
          timestamp: 10,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'W',
              spawnedBy,
              startedAt: 10,
              completedAt: 20,
            },
          ],
        },
      });
      expect(projected.parts).toMatchObject([
        { kind: 'turn_timer', data: { spawnedBy } },
      ]);
      expect(portalChatMessagesToPersisted([projected]).messages).toMatchObject(
        [{ blocks: [{ type: 'turn_timer', spawnedBy }] }],
      );
    },
  );
});

describe('visual references on Portal parts', () => {
  const visualRef = {
    version: 1 as const,
    visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 700_000,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html' as const,
    title: 'Revenue chart',
    maxHeight: 720,
    heights: [[800, 400]] as Array<[number, number]>,
  };
  const call = {
    type: 'tool_use' as const,
    toolUseId: 'tool-visual',
    toolName: 'mcp__canopy__ShowVisual',
    input: '{"title":"Revenue chart"}',
  };
  const result = {
    type: 'tool_result' as const,
    toolUseId: 'tool-visual',
    toolName: 'mcp__canopy__ShowVisual',
    output: `${visualRef.visualId} Shown to the user above your reply.`,
    isError: false,
    visualRef,
  };

  it('carries the full reference on a cross-message result part', () => {
    const parts = persistedParts({
      id: 'result-message',
      role: 'assistant',
      timestamp: 2,
      blocks: [result],
    });
    expect(parts).toEqual([
      {
        kind: 'tool_result',
        data: {
          toolUseId: 'tool-visual',
          output: result.output,
          isError: false,
          messageId: 'result-message',
          visual: visualRef,
        },
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain('<');
  });

  it('keeps a visual part beside a same-message pair that folds its result', () => {
    const parts = persistedParts({
      id: 'pair-message',
      role: 'assistant',
      timestamp: 2,
      blocks: [call, result],
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      kind: 'tool_use',
      data: {
        toolUseId: 'tool-visual',
        result: { output: result.output, isError: false },
      },
    });
    expect(parts.slice(1)).toEqual([
      {
        kind: 'tool_result',
        data: {
          toolUseId: 'tool-visual',
          messageId: 'pair-message',
          visual: visualRef,
        },
      },
    ]);
  });

  it('leaves results without a visual unchanged', () => {
    const plain = { ...result, visualRef: undefined };
    expect(
      persistedParts({
        id: 'pair-message',
        role: 'assistant',
        timestamp: 2,
        blocks: [call, plain],
      }),
    ).toHaveLength(1);
    expect(
      persistedParts({
        id: 'result-message',
        role: 'assistant',
        timestamp: 2,
        blocks: [plain],
      }),
    ).toEqual([
      {
        kind: 'tool_result',
        data: {
          toolUseId: 'tool-visual',
          output: result.output,
          isError: false,
        },
      },
    ]);
  });

  it('imports published visual parts without placeholders or references', () => {
    const portal: PortalChatMessage[] = [
      persistedMessageToPortalMessage({
        scope: 'standalone',
        chatId: 'chat',
        message: {
          id: 'pair-message',
          role: 'assistant',
          timestamp: 2,
          blocks: [call, result],
        },
      }),
      persistedMessageToPortalMessage({
        scope: 'standalone',
        chatId: 'chat',
        message: {
          id: 'result-message',
          role: 'assistant',
          timestamp: 3,
          blocks: [{ ...result, toolUseId: 'tool-other' }],
        },
      }),
    ];
    const { messages } = portalChatMessagesToPersisted(portal);
    const blocks = messages.flatMap((message) => message.blocks);
    // Published copies carry no visual artifact, so no reference survives,
    // and the folded result is not duplicated by its visual part.
    expect(JSON.stringify(blocks)).not.toContain('visualRef');
    expect(blocks.filter((block) => block.type === 'tool_result')).toHaveLength(
      2,
    );
    expect(blocks.some((block) => block.type === 'text')).toBe(false);
  });
});

it('round trips resume provenance and explicit interruption through the Portal relay', () => {
  const original: PersistedChatMessage = {
    id: 'resume',
    role: 'user',
    timestamp: 500,
    userMessageSource: 'auto_resume',
    autoResume: {
      reason: 'app_shutdown',
      resumesUserMessageId: 'original',
      resendsUserMessage: false,
      providerName: 'Codex',
    },
    blocks: [{ type: 'text', text: 'Continue' }],
  };
  const projected = persistedMessageToPortalMessage({
    scope: 'worktree',
    chatId: 'chat',
    message: original,
  });
  expect(projected).toMatchObject({
    promptSource: 'automated',
    autoResume: original.autoResume,
    createdAtMs: 500,
  });
  expect(portalChatMessagesToPersisted([projected]).messages[0]).toMatchObject({
    autoResume: original.autoResume,
    userMessageSource: 'auto_resume',
    timestamp: 500,
  });
  delete projected.autoResume;
  expect(
    portalChatMessagesToPersisted([projected]).messages[0]?.autoResume,
  ).toEqual(original.autoResume);
  const result: PersistedChatMessage = {
    id: 'result',
    role: 'system',
    timestamp: 180,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'edit',
        toolName: 'Edit',
        output: 'Interrupted by app restart',
        isError: true,
        interruption: { reason: 'app_restart', at: 180 },
      },
    ],
  };
  const relay = persistedMessageToPortalMessage({
    scope: 'worktree',
    chatId: 'chat',
    message: result,
  });
  expect(
    portalChatMessagesToPersisted([relay]).messages[0]?.blocks,
  ).toMatchObject([
    {
      interruption: { reason: 'app_restart', at: 180 },
      isError: true,
      output: 'Interrupted by app restart',
    },
  ]);
});

it('retains content with generic attribution when automatic metadata is incomplete', () => {
  const message = {
    id: 'unknown-resume',
    role: 'user' as const,
    timestamp: 100,
    userMessageSource: 'auto_resume' as const,
    autoResume: { reason: 'future_reason', resendsUserMessage: false },
    blocks: [{ type: 'text' as const, text: 'Continue' }],
  };
  const projected = persistedMessageToPortalMessage({
    scope: 'worktree',
    chatId: 'chat',
    message: { ...message, autoResume: undefined },
  });
  expect(projected).toMatchObject({
    promptSource: 'automated',
    text: 'Continue',
  });
  expect(projected).not.toHaveProperty('autoResume');
});

it.each(['parentBlockId', 'parentToolUseId'] as const)(
  'projects a child-directed user row with %s as a continuation of the root turn',
  (parentField) => {
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: {
        id: 'child-follow-up',
        role: 'user',
        timestamp: 200,
        [parentField]: 'background-agent',
        blocks: [{ type: 'text', text: 'Check the background work' }],
      },
    });
    expect(projected).toMatchObject({ continuesTurn: true });
  },
);
