import {
  findMemoryCitationFilesAttributes,
  parseAgentTranscriptLines,
  persistedMessageToPortalMessage,
  stripMemoryCitationTags,
} from '../../index';
import type { PersistedChatMessage } from '../../types';

function assistantText(messages: PersistedChatMessage[]): string[] {
  return messages.flatMap((message): string[] => {
    if (message.role !== 'assistant') {
      return [];
    }
    return message.blocks.flatMap((block): string[] =>
      block.type === 'text' ? [block.text] : [],
    );
  });
}

describe('local-memory citation display stripping', () => {
  it('strips a complete tag from the final assembled Claude message used by the renderer', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'What should I run?',
        submitted_text: 'What should I run?',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Run npm test.\n<memory_citation files="topics/testing.md"/>',
            },
          ],
        },
      }),
    ]);

    expect(assistantText(parsed.messages)).toEqual(['Run npm test.']);
  });

  it('strips complete tags from the final assembled Codex item', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Recall this',
        submitted_text: 'Recall this',
        plan_mode: false,
      }),
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started', turn_id: 'turn-1' }),
      JSON.stringify({
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          id: 'answer-1',
          type: 'agent_message',
          text: 'Remembered. <memory_citation files="MEMORY.md"/>',
        },
      }),
    ]);

    expect(assistantText(parsed.messages)).toEqual(['Remembered.']);
  });

  it('strips a tag assembled across streamed Cursor assistant patches', () => {
    const patch = (
      revision: number,
      patches: Array<
        | { index: number; block: { type: 'text' | 'thinking'; text: string } }
        | { index: number; appendText: string }
      >,
    ): string =>
      JSON.stringify({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'cursor-message-1',
        timestamp: 1,
        revision,
        patches,
      });
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'cursor',
        original_text: 'What should I run?',
        submitted_text: 'What should I run?',
        plan_mode: false,
      }),
      patch(1, [
        { index: 0, block: { type: 'text', text: 'Run npm test.\n' } },
      ]),
      patch(2, [{ index: 0, appendText: '<memory_citation files="inbox/' }]),
      patch(3, [{ index: 0, appendText: 'note.md"/>' }]),
    ]);

    // Trailing whitespace survives the streaming fold on purpose: trimming a
    // still-growing block would glue the next delta onto the previous line.
    expect(assistantText(parsed.messages)).toEqual(['Run npm test.\n']);
  });

  describe('Cursor patch boundaries after a closed tag', () => {
    const cursorPrompt = JSON.stringify({
      type: 'canopy_user_prompt',
      provider: 'cursor',
      original_text: 'Show me the format',
      submitted_text: 'Show me the format',
      plan_mode: false,
    });
    const foldText = (deltas: string[]): string[] => {
      const lines = deltas.map((delta, index) =>
        JSON.stringify({
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          messageId: 'cursor-message-1',
          timestamp: 1,
          revision: index + 1,
          patches: [
            index === 0
              ? { index: 0, block: { type: 'text', text: delta } }
              : { index: 0, appendText: delta },
          ],
        }),
      );
      return assistantText(
        parseAgentTranscriptLines([cursorPrompt, ...lines]).messages,
      );
    };

    it.each([
      [
        'a code fence that continues after the tag',
        [
          'Example:\n```xml\n',
          '<memory_citation files="x.md"/>\n',
          '```\nThat is the format.',
        ],
      ],
      [
        'a heading that follows a mid-reply citation',
        ['First answer. <memory_citation files="x.md"/>\n\n', '## Next\nMore.'],
      ],
      [
        'a paired open/close tag split across deltas',
        [
          'Answer <memory_citation files="x.md">',
          'cited</memory_citation> done.',
        ],
      ],
      [
        'a tag whose closing bracket arrives alone',
        ['Before <memory_citation files="x.md"/', '>', ' after.'],
      ],
      [
        'appends without a closing bracket after a stripped tag',
        ['Done. <memory_citation files="x.md"/>', ' more', ' text'],
      ],
    ])(
      'folds %s exactly like a single patch carrying the same text',
      (_name, deltas) => {
        const streamed = foldText(deltas);
        const singlePatch = foldText([deltas.join('')]);

        expect(streamed).toEqual(singlePatch);
        expect(streamed[0]).not.toContain('memory_citation');
      },
    );

    it('keeps the fence intact when the tag delta ends with a newline', () => {
      expect(
        foldText([
          'Example:\n```xml\n',
          '<memory_citation files="x.md"/>\n',
          '```\nThat is the format.',
        ]),
      ).toEqual(['Example:\n```xml\n\n```\nThat is the format.']);
    });

    it('keeps the space before a paired tag that closes in a later delta', () => {
      expect(
        foldText([
          'Answer <memory_citation files="x.md">',
          'cited</memory_citation> done.',
        ]),
      ).toEqual(['Answer cited done.']);
    });
  });

  it('strips a tag from a streamed Cursor thinking block', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'cursor',
        original_text: 'Recall this',
        submitted_text: 'Recall this',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'cursor-message-1',
        timestamp: 1,
        revision: 1,
        patches: [
          {
            index: 0,
            block: {
              type: 'thinking',
              text: 'Reasoning.\n<memory_citation files="MEMORY.md"/>',
            },
          },
        ],
      }),
    ]);

    const thinking = parsed.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.blocks.flatMap((block) =>
            block.type === 'thinking' ? [block.text] : [],
          )
        : [],
    );
    expect(thinking).toEqual(['Reasoning.\n']);
  });

  it('strips every block a single Cursor frame patches, and only those', () => {
    const frame = (
      revision: number,
      patches: Array<
        | { index: number; block: { type: 'text' | 'thinking'; text: string } }
        | { index: number; appendText: string }
      >,
    ): string =>
      JSON.stringify({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'cursor-message-1',
        timestamp: 1,
        revision,
        patches,
      });
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'cursor',
        original_text: 'Recall this',
        submitted_text: 'Recall this',
        plan_mode: false,
      }),
      frame(1, [
        {
          index: 0,
          block: {
            type: 'text',
            text: 'Answer <memory_citation files="x.md"/',
          },
        },
      ]),
      // One frame: a bracket-free append to the text block, a new thinking
      // block carrying a whole tag, and a second append that closes the
      // text block's tag.
      frame(2, [
        { index: 0, appendText: ' pending' },
        {
          index: 1,
          block: {
            type: 'thinking',
            text: 'Reasoning.\n<memory_citation files="MEMORY.md"/>',
          },
        },
        { index: 0, appendText: '> done.' },
      ]),
    ]);

    const message = parsed.messages.find(
      (candidate) => candidate.id === 'cursor-message-1',
    );
    expect(message?.blocks).toEqual([
      { type: 'text', text: 'Answer  done.' },
      { type: 'thinking', text: 'Reasoning.\n' },
    ]);
  });

  it('keeps a Cursor host notice carrying the literal tag intact', () => {
    const notice =
      'Some selections are not available: <memory_citation files="topics/x.md"/>';
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'cursor',
        original_text: 'Hello',
        submitted_text: 'Hello',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        role: 'system',
        messageId: 'cursor-notice-1',
        timestamp: 1,
        revision: 1,
        patches: [{ index: 0, block: { type: 'text', text: notice } }],
      }),
    ]);

    const systemText = parsed.messages.flatMap((message) =>
      message.role === 'system' && message.id === 'cursor-notice-1'
        ? message.blocks.flatMap((block) =>
            block.type === 'text' ? [block.text] : [],
          )
        : [],
    );
    expect(systemText).toEqual([notice]);
  });

  it('strips a quoted tag inside a code block and every tag in one text item', () => {
    const text = [
      '```xml',
      '<memory_citation files="topics/quoted.md"/>',
      '```',
      '<memory_citation files="inbox/note.md"/>',
    ].join('\n');

    expect(stripMemoryCitationTags(text)).toBe('```xml\n\n```');
  });

  it('keeps citation tags out of Portal-visible output for legacy persisted text', () => {
    const message: PersistedChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Visible answer.\n<memory_citation files="topics/x.md"/>',
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    expect(projected.text).toBe('Visible answer.');
    expect(JSON.stringify(projected)).not.toContain('memory_citation');
  });

  it('documents that separately rendered split chunks are stripped once a later assembled item contains the complete tag', () => {
    expect(stripMemoryCitationTags('<memory_cit')).toBe('<memory_cit');
    expect(stripMemoryCitationTags('ation files="topics/x.md"/>')).toBe(
      'ation files="topics/x.md"/>',
    );
    expect(
      stripMemoryCitationTags('<memory_citation files="topics/x.md"/>'),
    ).toBe('');
  });

  it('strips a non-self-closed tag without swallowing any surrounding text', () => {
    const text = [
      'Before the tag.',
      '<memory_citation files="topics/unclosed.md">',
      'This paragraph must survive.',
      'So must this line with <br/> inside.',
      'And this trailing text.',
    ].join('\n');

    const stripped = stripMemoryCitationTags(text);
    expect(stripped).not.toContain('memory_citation');
    expect(stripped).toContain('Before the tag.');
    expect(stripped).toContain('This paragraph must survive.');
    expect(stripped).toContain('So must this line with <br/> inside.');
    expect(stripped).toContain('And this trailing text.');
  });

  it('strips an uppercase tag so the fast-path guard stays case-insensitive', () => {
    expect(
      stripMemoryCitationTags(
        'Answer.\n<MEMORY_CITATION FILES="topics/x.md"/>',
      ),
    ).toBe('Answer.');
  });

  describe('adversarial inputs', () => {
    it('strips a tag whose model omitted the closing slash', () => {
      expect(
        stripMemoryCitationTags(
          'Answer.\n<memory_citation files="topics/x.md">',
        ),
      ).toBe('Answer.');
    });

    it('strips both halves of a paired open/close tag form', () => {
      const stripped = stripMemoryCitationTags(
        'Answer <memory_citation files="topics/x.md">cited</memory_citation> done.',
      );
      expect(stripped).toBe('Answer cited done.');
      expect(stripped).not.toContain('memory_citation');
    });

    it('strips a self-closed tag without a files attribute', () => {
      expect(stripMemoryCitationTags('Answer.\n<memory_citation/>')).toBe(
        'Answer.',
      );
    });

    it('never lets a nested/malformed tag consume content beyond the first ">"', () => {
      const text = [
        'Intro paragraph.',
        '<memory_citation files="a" <memory_citation files="topics/x.md"/>',
        'Everything after the closing bracket must survive.',
        'Including this <br/> and <Component /> markup.',
      ].join('\n');

      const stripped = stripMemoryCitationTags(text);
      expect(stripped).toContain('Intro paragraph.');
      expect(stripped).toContain(
        'Everything after the closing bracket must survive.',
      );
      expect(stripped).toContain(
        'Including this <br/> and <Component /> markup.',
      );
      expect(stripped).not.toContain('topics/x.md');
    });

    it('strips a tag with a huge files attribute without touching surrounding text', () => {
      const hugeAttribute = Array.from(
        { length: 2_000 },
        (_, i) => `topics/generated-${i}.md`,
      ).join(',');
      const text = `Before.\n<memory_citation files="${hugeAttribute}"/>\nAfter.`;

      expect(stripMemoryCitationTags(text)).toBe('Before.\n\nAfter.');
    });

    it('returns huge unclosed-prefix payloads unchanged in bounded time', () => {
      const text =
        '<memory_citation files="topics/x.md" '.repeat(2_000) +
        'payload '.repeat(2_500);
      const startedAt = Date.now();
      const stripped = stripMemoryCitationTags(text);
      const elapsedMs = Date.now() - startedAt;

      // No tag ever closes (the text contains no ">"), so nothing may be
      // removed, and the bounded [^>]* body must not backtrack
      // catastrophically across the repeated prefixes.
      expect(stripped).toBe(text);
      expect(elapsedMs).toBeLessThan(2_000);
    });

    it('strips every tag from a large payload with many interleaved tags', () => {
      const unit = 'Kept sentence. <memory_citation files="topics/x.md"/> ';
      const text = unit.repeat(1_000);
      const stripped = stripMemoryCitationTags(text);

      expect(stripped).not.toContain('memory_citation');
      expect(stripped).toContain('Kept sentence.');
    });

    it('leaves a tag split across a backtick code fence boundary intact until fully assembled', () => {
      const text = 'See `<memory_citation files="topics/x.md"` for details';
      expect(stripMemoryCitationTags(text)).toBe(text);
    });
  });
});

describe('strict compliance tag matching', () => {
  it('returns files attributes only for the strict self-closing files form', () => {
    expect(
      findMemoryCitationFilesAttributes(
        [
          '<memory_citation files="topics/a.md"/>',
          '<memory_citation files="topics/loose.md">',
          '<memory_citation/>',
          '<memory_citation files="topics/b.md, MEMORY.md" />',
        ].join('\n'),
      ),
    ).toEqual(['topics/a.md', 'topics/b.md, MEMORY.md']);
  });

  it('matches nothing when only stripped-but-malformed variants are present', () => {
    expect(
      findMemoryCitationFilesAttributes(
        '<memory_citation files="topics/x.md">\n<memory_citation/>',
      ),
    ).toEqual([]);
  });
});

describe('local-memory citation portal projection scope', () => {
  const literalTag = '<memory_citation files="topics/x.md"/>';

  it('passes user text containing the literal tag through unchanged', () => {
    const text = `Please keep ${literalTag} exactly as written.`;
    const message: PersistedChatMessage = {
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text }],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    expect(projected.text).toBe(text);
  });

  it('passes tool input and tool output containing the literal tag through unchanged', () => {
    const input = `grep for ${literalTag} in the docs`;
    const output = `docs/example.md: found ${literalTag} on line 3`;
    const message: PersistedChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        { type: 'tool_use', toolUseId: 'tool-1', toolName: 'Grep', input },
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolName: 'Grep',
          output,
          isError: false,
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    const toolPart = (projected.parts ?? []).find(
      (part) => part.kind === 'tool_use',
    );
    expect(toolPart?.data).toEqual({
      toolUseId: 'tool-1',
      toolName: 'Grep',
      input,
      result: { output, isError: false },
    });
  });

  it('still strips the tag from projected assistant thinking blocks', () => {
    const message: PersistedChatMessage = {
      id: 'assistant-2',
      role: 'assistant',
      timestamp: 3,
      blocks: [
        { type: 'thinking', text: `Reasoning.\n${literalTag}` },
        { type: 'text', text: `Visible answer.\n${literalTag}` },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    expect(projected.text).toBe('Visible answer.');
    const thinkingPart = (projected.parts ?? []).find(
      (part) => part.kind === 'thinking',
    );
    expect(thinkingPart?.data).toEqual({ text: 'Reasoning.' });
  });
});
