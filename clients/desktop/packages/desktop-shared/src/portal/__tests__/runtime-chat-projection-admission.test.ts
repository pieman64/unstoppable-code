import { runtimeChatEventToPortalMessage } from '../runtime-chat-projection';
import { persistedParts } from '@canopy/agent-transcript/portal/persisted-chat-projection';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';

describe('admitted primary projection', () => {
  it.each(['standalone', 'app_advisor'] as const)(
    'keeps excluded %s sources preview-only even if handed a receipt',
    (scope) => {
      const input = {
        scope,
        chatId: 'chat',
        data: {
          type: 'user',
          message: {
            id: 'visible',
            content: [
              { type: 'tool_result', tool_use_id: 'same', content: 'preview' },
            ],
          },
        },
        admission: {
          revision: 1,
          tools: [
            {
              sourceToken: '0',
              occurrenceId: 'row#0',
              result: { rowId: 'row', blockOrdinal: 1, needsRead: true },
            },
          ],
        },
      };
      const part = runtimeChatEventToPortalMessage(input)?.parts?.[0];
      expect(part?.occurrence).toBeUndefined();
      expect(part?.outputLocator).toBeUndefined();
    },
  );
  it('uses absolute source slots, not duplicate tool ids, and agrees with canonical projection', () => {
    const row: PersistedChatMessage & { revision: number } = {
      id: 'canonical-2',
      role: 'assistant',
      timestamp: 1,
      revision: 8,
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', toolUseId: 'same', toolName: 'Read', input: '{}' },
        {
          type: 'tool_result',
          toolUseId: 'same',
          toolName: 'Read',
          output: 'x'.repeat(4001),
          isError: false,
        },
        { type: 'tool_use', toolUseId: 'same', toolName: 'Read', input: '{}' },
        {
          type: 'tool_result',
          toolUseId: 'same',
          toolName: 'Read',
          output: 'y'.repeat(4001),
          isError: false,
        },
      ],
    };
    const input = {
      scope: 'worktree' as const,
      chatId: 'chat',
      data: {
        type: 'assistant',
        message: {
          id: 'visible',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'same', name: 'Read', input: {} },
            {
              type: 'tool_result',
              tool_use_id: 'same',
              content: 'x'.repeat(4001),
            },
            { type: 'tool_use', id: 'same', name: 'Read', input: {} },
            {
              type: 'tool_result',
              tool_use_id: 'same',
              content: 'y'.repeat(4001),
            },
          ],
        },
      },
      admission: {
        revision: 8,
        tools: [
          {
            sourceToken: '1',
            occurrenceId: 'canonical-2#1',
            call: { rowId: 'canonical-2', blockOrdinal: 1 },
          },
          {
            sourceToken: '2',
            occurrenceId: 'canonical-2#1',
            result: { rowId: 'canonical-2', blockOrdinal: 2, needsRead: true },
          },
          {
            sourceToken: '3',
            occurrenceId: 'canonical-2#3',
            call: { rowId: 'canonical-2', blockOrdinal: 3 },
          },
          {
            sourceToken: '4',
            occurrenceId: 'canonical-2#3',
            result: { rowId: 'canonical-2', blockOrdinal: 4, needsRead: true },
          },
        ],
      },
    };
    const live = runtimeChatEventToPortalMessage(input);
    const persisted = persistedParts(row, undefined, {
      unfoldToolResults: true,
    });
    const tools = persisted.filter(
      (part) => part.kind === 'tool_use' || part.kind === 'tool_result',
    );
    const expected = [
      { id: 'canonical-2#1', revision: 8 },
      { id: 'canonical-2#1', revision: 8 },
      { id: 'canonical-2#3', revision: 8 },
      { id: 'canonical-2#3', revision: 8 },
    ];
    expect(live?.parts?.map((part) => part.occurrence)).toEqual(expected);
    expect(tools.map((part) => part.occurrence)).toEqual(expected);
    expect(live?.parts?.[1]?.outputLocator).toEqual({
      messageId: 'canonical-2',
      blockOrdinal: 2,
      field: 'output',
    });
    expect(live?.parts?.[3]?.outputLocator).toEqual({
      messageId: 'canonical-2',
      blockOrdinal: 4,
      field: 'output',
    });
    const without = {
      scope: input.scope,
      chatId: input.chatId,
      data: input.data,
    };
    jest.spyOn(Date, 'now').mockReturnValue(100);
    const plain = runtimeChatEventToPortalMessage(without);
    const explicitInput = { ...without, admission: undefined };
    const explicit = runtimeChatEventToPortalMessage(explicitInput);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(plain)).not.toMatch(/occurrence|outputLocator/);
    jest.restoreAllMocks();
  });

  it('anchors a cross-row standalone result to the nearest unmatched call in its lane and turn', () => {
    const call: PersistedChatMessage = {
      id: 'canonical:2',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'prefix' },
        { type: 'tool_use', toolUseId: 'same', toolName: 'Read', input: '{}' },
      ],
    };
    const result: PersistedChatMessage = {
      id: 'result-row',
      role: 'system',
      timestamp: 2,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'same',
          toolName: 'Read',
          output: 'x'.repeat(4001),
          isError: false,
        },
      ],
    };
    const part = persistedParts(result, undefined, {}, [call, result])[0];
    expect(part?.occurrence).toEqual({ id: 'canonical:2#1', revision: 0 });
    expect(part?.outputLocator).toEqual({
      messageId: 'result-row',
      blockOrdinal: 0,
      field: 'output',
    });
    const boundary: PersistedChatMessage = {
      id: 'next-turn',
      role: 'user',
      timestamp: 3,
      blocks: [{ type: 'text', text: 'next' }],
    };
    // Across a turn boundary the projection finds no call, so the result
    // stays unkeyed instead of claiming its own address.
    expect(
      persistedParts(result, undefined, {}, [call, boundary, result])[0],
    ).not.toHaveProperty('occurrence');
    expect(persistedParts(result)[0]).not.toHaveProperty('occurrence');
  });

  it('stamps Codex call and terminal result from their exact role tokens', () => {
    const input = {
      scope: 'worktree' as const,
      chatId: 'chat',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'cmd',
            type: 'command_execution',
            command: 'pwd',
            status: 'completed',
            aggregated_output: 'long',
          },
        },
      },
      admission: {
        revision: 12,
        tools: [
          { sourceToken: 'cmd:call', occurrenceId: 'codex-cmd#0' },
          {
            sourceToken: 'cmd:result',
            occurrenceId: 'codex-cmd#0',
            result: { rowId: 'codex-cmd', blockOrdinal: 1, needsRead: true },
          },
        ],
      },
    };
    const parts = runtimeChatEventToPortalMessage(input)?.parts;
    expect(parts?.map((part) => part.occurrence)).toEqual([
      { id: 'codex-cmd#0', revision: 12 },
      { id: 'codex-cmd#0', revision: 12 },
    ]);
    expect(parts?.[1]?.outputLocator).toEqual({
      messageId: 'codex-cmd',
      blockOrdinal: 1,
      field: 'output',
    });
  });
});
