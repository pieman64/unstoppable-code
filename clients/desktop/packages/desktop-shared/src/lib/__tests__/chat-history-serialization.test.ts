import type { PersistedChatMessage, PersistedChatBlock } from '../../types';
import {
  isVisibleReadMessage,
  visibleMessageRawText,
  visibleMessageText,
  serializeVisibleReadMessage,
  legacyChatHistoryMessageText,
  serializeLegacyChatHistoryMessage,
} from '../chat-history-serialization';

function message(
  blocks: PersistedChatBlock[],
  overrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    timestamp: 1234,
    blocks,
    ...overrides,
  };
}

// One fixture for every persisted block discriminant; new variants must be pinned.
const blockPins = {
  text: { block: { type: 'text', text: '  hello  ' }, text: 'hello' },
  file_references: {
    block: {
      type: 'file_references',
      references: [
        { absolutePath: '/private/a.txt', displayPath: 'a.txt' },
        { absolutePath: 'C:\\secret\\b.txt', displayPath: 'b.txt' },
      ],
    },
    text: '[file] /private/a.txt\n[file] C:\\secret\\b.txt',
  },
  thinking: {
    block: { type: 'thinking', text: ' thought ' },
    text: '[thinking]\n thought',
  },
  tool_use: {
    block: {
      type: 'tool_use',
      toolUseId: 'tool',
      toolName: 'Read',
      input: '{"path":"secret"}',
      display: { toolName: 'Display', input: 'not raw' },
    },
    text: '[tool_use Read]\n{"path":"secret"}',
  },
  tool_result: {
    block: {
      type: 'tool_result',
      toolUseId: 'tool',
      toolName: 'Read',
      output: ' raw output ',
      isError: false,
    },
    text: '[tool_result Read]\n raw output',
  },
  hook_info: {
    block: { type: 'hook_info', triggerName: 'after-run', timestamp: 1 },
    text: '[hook after-run]',
  },
  claude_terminal_sync_warning: {
    block: {
      type: 'claude_terminal_sync_warning',
      timestamp: 1,
      message: ' failed ',
    },
    text: '[claude terminal sync warning]  failed',
  },
  turn_timer: { block: { type: 'turn_timer', completedAt: 10 }, text: '' },
  pending_setup_info: {
    block: { type: 'pending_setup_info', timestamp: 1 },
    text: '[pending setup]',
  },
  rebase_resolution_info: {
    block: {
      type: 'rebase_resolution_info',
      kind: 'stash_pop_conflict',
      repoName: 'repo',
      branchName: 'branch',
      timestamp: 1,
    },
    text: '[stash_pop_conflict] repo branch',
  },
  builtin_gh_chat_info: {
    block: {
      type: 'builtin_gh_chat_info',
      kind: 'ci_check_fix',
      repoName: 'repo',
      branchName: 'branch',
      timestamp: 1,
    },
    text: '[ci_check_fix] repo branch',
  },
  approval_resolution_info: {
    block: {
      type: 'approval_resolution_info',
      timestamp: 1,
      resolvedBy: 'mode-change',
      mode: 'full-access',
      titles: ['Read files', 'Run tests'],
    },
    text: '[approval released by mode change -> full-access] Read files; Run tests',
  },
  revert_info: {
    block: {
      type: 'revert_info',
      timestamp: 1,
      revertedFromMessageId: 'old',
      revertedFromTimestamp: 0,
      files: [{ path: 'a', status: 'modified', insertions: 3, deletions: 2 }],
      totalInsertions: 3,
      totalDeletions: 2,
    },
    text: '[revert] 1 files, +3/-2',
  },
  codex_agent_call: {
    block: {
      type: 'codex_agent_call',
      agentBlockId: 'agent',
      callId: 'call',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: ' child prompt ',
      agentsStates: {
        child: { status: 'completed', message: 'secret nested' },
      },
    },
    text: '[codex_agent spawnAgent completed]\n child prompt',
  },
  image: {
    block: {
      type: 'image',
      path: '/secret/image',
      dataUrl: 'data:image/png;secret',
      alt: 'secret alt',
    },
    text: '',
  },
  automation_info: {
    block: {
      type: 'automation_info',
      timestamp: 1,
      activityName: 'secret activity',
    },
    text: '',
  },
  compaction_info: {
    block: {
      type: 'compaction_info',
      timestamp: 1,
      provider: 'claude',
      interfaceMode: 'canopy',
      summary: 'secret summary',
      transcriptPath: '/secret/transcript',
    },
    text: '',
  },
  delegated_agent_call: {
    block: {
      type: 'delegated_agent_call',
      agentBlockId: 'agent',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'parent',
      parentTurnId: 'turn',
      parentToolCallId: 'call',
      createdAt: 1,
      selectedModelId: 'model',
      runtimeModelId: 'model',
      targetHarnessId: 'child',
      description: 'secret description',
      prompt: 'secret prompt',
      executionMode: 'background',
      delegationId: 'delegate',
      status: 'completed',
      outputTruncated: false,
      finalText: 'secret final',
      partialText: 'secret partial',
    },
    text: '',
  },
} satisfies Record<
  PersistedChatBlock['type'],
  { block: PersistedChatBlock; text: string }
>;

describe('legacy history serialization characterization', () => {
  it.each(Object.entries(blockPins))(
    'pins %s exactly',
    (_kind, { block, text }) => {
      expect(legacyChatHistoryMessageText(message([block]))).toEqual({
        text,
        truncated: false,
      });
      expect(serializeLegacyChatHistoryMessage(message([block]))).toEqual({
        id: 'message-1',
        role: 'assistant',
        timestamp: 1234,
        text,
        truncated: false,
      });
    },
  );

  it('pins error tool results and missing optional banner fields', () => {
    expect(
      legacyChatHistoryMessageText(
        message([
          {
            type: 'tool_result',
            toolUseId: 'tool',
            toolName: 'Exec',
            isError: true,
            output: 'failed',
          },
          { type: 'claude_terminal_sync_warning', timestamp: 1 },
          { type: 'builtin_gh_chat_info', kind: 'merge_queue', timestamp: 1 },
          {
            type: 'approval_resolution_info',
            timestamp: 1,
            resolvedBy: 'mode-change',
            mode: 'auto',
            titles: [],
          },
        ]),
      ),
    ).toEqual({
      text: '[tool_result Exec error]\nfailed\n\n[claude terminal sync warning]\n\n[merge_queue]\n\n[approval released by mode change -> auto]',
      truncated: false,
    });
  });

  it('filters empty blocks but retains whitespace until the single final trim', () => {
    expect(
      legacyChatHistoryMessageText(
        message([
          { type: 'text', text: '' },
          { type: 'text', text: '  first  ' },
          blockPins.turn_timer.block,
          { type: 'text', text: ' \t ' },
          blockPins.image.block,
          { type: 'text', text: ' last  ' },
          { type: 'file_references', references: [] },
        ]),
      ),
    ).toEqual({ text: 'first  \n\n \t \n\n last', truncated: false });
    expect(legacyChatHistoryMessageText(message([]))).toEqual({
      text: '',
      truncated: false,
    });
    expect(
      legacyChatHistoryMessageText(message([{ type: 'text', text: ' \n\t ' }])),
    ).toEqual({ text: '', truncated: false });
  });

  it.each(['system', 'user', 'assistant'] as const)(
    'does not filter %s, hidden or child rows; preserves legacy envelope keys',
    (role) => {
      expect(
        serializeLegacyChatHistoryMessage(
          message([{ type: 'text', text: 'content' }], {
            id: '42',
            timestamp: 42,
            role,
            hidden: true,
            parentBlockId: 'parent',
            parentToolUseId: 'tool',
          }),
        ),
      ).toEqual({
        id: '42',
        role,
        timestamp: 42,
        text: 'content',
        truncated: false,
      });
    },
  );

  it.each([7999, 8000, 8001, 1000000])(
    'pins suffix arithmetic at %i chars',
    (length) => {
      const expected =
        length <= 8000
          ? 'x'.repeat(length)
          : length === 8001
            ? `${'x'.repeat(7979)}\n\n[truncated 1 chars]`
            : `${'x'.repeat(7974)}\n\n[truncated 992000 chars]`;
      expect(
        serializeLegacyChatHistoryMessage(
          message([{ type: 'text', text: 'x'.repeat(length) }]),
        ),
      ).toEqual({
        id: 'message-1',
        role: 'assistant',
        timestamp: 1234,
        text: expected,
        truncated: length > 8000,
      });
    },
  );
});

describe('visible read projection', () => {
  it('keeps only text and basename references from mixed blocks', () => {
    const row = message([
      { type: 'text', text: '  visible  ' },
      ...Object.values(blockPins)
        .filter(
          ({ block }) =>
            block.type !== 'text' && block.type !== 'file_references',
        )
        .map(({ block }) => block),
      blockPins.file_references.block,
      { type: 'text', text: ' end ' },
    ]);
    expect(visibleMessageRawText(row)).toBe(
      'visible  \n\n[file] a.txt\n[file] b.txt\n\n end',
    );
    expect(serializeVisibleReadMessage(row, 'canonical-turn')).toEqual({
      messageId: 'message-1',
      turnId: 'canonical-turn',
      role: 'assistant',
      timestamp: '1970-01-01T00:00:01.234Z',
      text: 'visible  \n\n[file] a.txt\n[file] b.txt\n\n end',
      truncated: false,
    });
  });

  it.each(
    Object.entries(blockPins).filter(
      ([kind]) => kind !== 'text' && kind !== 'file_references',
    ),
  )(
    'excludes %s and its secret-looking payloads by default',
    (_kind, { block }) => {
      expect(visibleMessageText(message([block]))).toEqual({
        text: '',
        truncated: false,
      });
      expect(serializeVisibleReadMessage(message([block]))).toBeNull();
      const mixed = message([{ type: 'text', text: 'public' }, block]);
      expect(serializeVisibleReadMessage(mixed)?.text).toBe('public');
    },
  );

  it.each([
    { hidden: true },
    { parentBlockId: 'child' },
    { parentToolUseId: 'legacy-child' },
    { parentBlockId: '', parentToolUseId: '' },
    { role: 'system' as const },
  ])('rejects ineligible rows %p', (overrides) => {
    const row = message([{ type: 'text', text: 'SECRET_TOKEN' }], overrides);
    expect(isVisibleReadMessage(row)).toBe(false);
    expect(visibleMessageRawText(row)).toBe('');
    expect(serializeVisibleReadMessage(row)).toBeNull();
  });

  it('rejects empty/tool-only rows and never invents visible messages', () => {
    for (const blocks of [
      [],
      [{ type: 'text' as const, text: ' \n\t ' }],
      [blockPins.tool_result.block],
      [{ type: 'file_references' as const, references: [] }],
    ]) {
      const row = message(blocks);
      expect(isVisibleReadMessage(row)).toBe(true);
      expect(serializeVisibleReadMessage(row)).toBeNull();
    }
  });

  it('uses a usable basename, falls back to host path, and skips nameless references', () => {
    const row = message([
      {
        type: 'file_references',
        references: [
          {
            displayPath: 'repo/src/name.ts',
            absolutePath: '/private/secret/name.ts',
          },
          {
            displayPath: '',
            absolutePath: 'C:\\private\\secret\\fallback.txt',
          },
          { displayPath: 'portable.txt', absolutePath: '' },
          { displayPath: '', absolutePath: '' },
          { displayPath: '   ', absolutePath: '/private/' },
          { displayPath: '.', absolutePath: '/' },
          { displayPath: '..', absolutePath: 'C:\\' },
        ],
      },
    ]);
    expect(visibleMessageText(row)).toEqual({
      text: '[file] name.ts\n[file] fallback.txt\n[file] portable.txt',
      truncated: false,
    });
    expect(
      serializeVisibleReadMessage(
        message([
          {
            type: 'file_references',
            references: [{ displayPath: '', absolutePath: '' }],
          },
        ]),
      ),
    ).toBeNull();
  });

  it('retains legacy joins and one final trim for allowed blocks', () => {
    const row = message([
      { type: 'text', text: '' },
      { type: 'text', text: '  a  ' },
      blockPins.tool_use.block,
      { type: 'text', text: ' \t ' },
      { type: 'text', text: ' b  ' },
    ]);
    expect(visibleMessageText(row)).toEqual({
      text: 'a  \n\n \t \n\n b',
      truncated: false,
    });
  });

  it.each([7999, 8000, 8001, 1000000])(
    'caps visible output at boundary %i but leaves raw query text intact',
    (length) => {
      const raw = 'x'.repeat(length);
      const row = message([{ type: 'text', text: raw }]);
      const expected =
        length <= 8000
          ? raw
          : length === 8001
            ? `${'x'.repeat(7979)}\n\n[truncated 1 chars]`
            : `${'x'.repeat(7974)}\n\n[truncated 992000 chars]`;
      expect(visibleMessageRawText(row)).toBe(raw);
      expect(visibleMessageText(row)).toEqual({
        text: expected,
        truncated: length > 8000,
      });
      expect(serializeVisibleReadMessage(row)?.text).toBe(expected);
    },
  );

  it('supports literal query matching after the cap and file-only matching', () => {
    const row = message([{ type: 'text', text: `${'x'.repeat(8000)}Needle` }]);
    expect(visibleMessageRawText(row).toLowerCase().includes('needle')).toBe(
      true,
    );
    expect(visibleMessageText(row).text.toLowerCase().includes('needle')).toBe(
      false,
    );
    expect(
      visibleMessageRawText(
        message([blockPins.file_references.block]),
      ).includes('a.txt'),
    ).toBe(true);
  });

  it.each(['user', 'assistant'] as const)(
    'preserves %s role without leaking non-DTO metadata',
    (role) => {
      const row = message(
        [
          {
            type: 'text',
            text: 'visible',
            asyncQuestion: {
              requestId: 'secret-request',
              questions: [
                { title: 'SECRET_TOKEN', options: ['SECRET_OPTION'] },
              ],
            },
          },
        ],
        {
          role,
          userMessageSource: 'watcher',
          attachmentPaths: ['/secret/file'],
          codexThreadId: 'secret-thread',
          codexTurnId: 'not-a-canonical-turn',
          claudeUuid: 'secret-session',
        },
      );
      expect(serializeVisibleReadMessage(row)).toEqual({
        messageId: 'message-1',
        role,
        timestamp: '1970-01-01T00:00:01.234Z',
        text: 'visible',
        truncated: false,
      });
    },
  );

  it('omits invalid timestamps and absent canonical turn IDs', () => {
    expect(
      serializeVisibleReadMessage(
        message([{ type: 'text', text: 'visible' }], { timestamp: Number.NaN }),
      ),
    ).toEqual({
      messageId: 'message-1',
      role: 'assistant',
      text: 'visible',
      truncated: false,
    });
  });
});

describe('visible read privacy seams', () => {
  it('never includes secret-looking tokens from blocked content or orchestration metadata', () => {
    const token = 'sk-private-token-DO-NOT-EXPOSE';
    const row = {
      ...message([
        { type: 'text', text: 'public' },
        { type: 'thinking', text: token },
        { type: 'tool_use', toolUseId: 'tool', toolName: token, input: token },
        {
          type: 'tool_result',
          toolUseId: 'tool',
          toolName: token,
          output: token,
          isError: true,
        },
        { type: 'image', path: token, dataUrl: token, alt: token },
        {
          type: 'compaction_info',
          timestamp: 1,
          provider: 'codex',
          interfaceMode: 'canopy',
          summary: token,
          transcriptPath: token,
        },
        { ...blockPins.codex_agent_call.block, prompt: token },
        { ...blockPins.delegated_agent_call.block, finalText: token },
      ]),
      hiddenContext: { instruction: token },
      submittedText: token,
      inputDelivery: { rows: [{ attempts: [{ submittedText: token }] }] },
      subBlocks: [{ type: 'text', text: token }],
    };
    expect(visibleMessageRawText(row)).toBe('public');
    expect(serializeVisibleReadMessage(row)).toEqual({
      messageId: 'message-1',
      role: 'assistant',
      timestamp: '1970-01-01T00:00:01.234Z',
      text: 'public',
      truncated: false,
    });
    expect(JSON.stringify(serializeVisibleReadMessage(row))).not.toContain(
      token,
    );
  });

  it('copies only validated agent-sent display metadata into visible history', () => {
    const secret = 'hidden-instruction-and-provenance-must-not-escape';
    const agentSent = {
      sender: {
        kind: 'project',
        projectType: 'cowork',
        projectId: 'sender-project',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      chatTitle: 'Review migration',
      projectLabel: 'Research Space',
    };
    const row = {
      ...message([{ type: 'text', text: 'Public message body.' }], {
        role: 'user',
      }),
      agentSent: {
        ...agentSent,
        sender: { ...agentSent.sender, rawIdentity: secret },
        hiddenInstruction: secret,
        provenance: { acceptedInputId: secret },
      },
      hiddenContext: { text: secret },
      agentSenderProvenance: { sender: { identity: secret } },
    };

    const projected = serializeVisibleReadMessage(row);

    expect(projected).toEqual({
      messageId: 'message-1',
      role: 'user',
      timestamp: '1970-01-01T00:00:01.234Z',
      text: 'Public message body.',
      truncated: false,
      agentSent,
    });
    expect(projected?.agentSent).toEqual(agentSent);
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('omits malformed agent-sent metadata and keeps old rows unmarked', () => {
    const invalid = {
      ...message([{ type: 'text', text: 'Public message body.' }], {
        role: 'user',
      }),
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'unsupported',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Review migration',
        projectLabel: 'Research Space',
      },
    };
    const legacy = message([{ type: 'text', text: 'Earlier message.' }], {
      role: 'user',
    });

    expect(serializeVisibleReadMessage(invalid)).toEqual({
      messageId: 'message-1',
      role: 'user',
      timestamp: '1970-01-01T00:00:01.234Z',
      text: 'Public message body.',
      truncated: false,
    });
    expect(serializeVisibleReadMessage(legacy)).toEqual({
      messageId: 'message-1',
      role: 'user',
      timestamp: '1970-01-01T00:00:01.234Z',
      text: 'Earlier message.',
      truncated: false,
    });
  });
});
