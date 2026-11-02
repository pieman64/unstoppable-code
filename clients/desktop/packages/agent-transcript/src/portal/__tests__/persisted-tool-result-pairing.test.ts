import {
  persistedMessageToPortalMessage,
  persistedParts,
} from '../persisted-chat-projection';
import type { PersistedChatMessage } from '../../index';

function message(
  id: string,
  role: PersistedChatMessage['role'],
  blocks: PersistedChatMessage['blocks'],
): PersistedChatMessage {
  return { id, role, blocks, timestamp: 1 };
}

function toolUse(
  toolUseId: string,
  toolName = 'Bash',
): PersistedChatMessage['blocks'][number] {
  return {
    type: 'tool_use',
    toolUseId,
    toolName,
    input: JSON.stringify({ command: 'ls' }),
  };
}

function toolResult(
  toolUseId: string,
  output: string,
  isError = false,
): PersistedChatMessage['blocks'][number] {
  return { type: 'tool_result', toolUseId, toolName: 'Bash', output, isError };
}

describe('persistedParts tool_result pairing', () => {
  const storedResult: PersistedChatMessage['blocks'][number] = {
    type: 'tool_result',
    toolUseId: 'stored',
    toolName: 'Read',
    output: 'preview',
    isError: false,
    fullOutputRef: {
      version: 1,
      artifactId: 'primary-body',
      byteLength: 9000,
      sha256: '0'.repeat(64),
      encoding: 'utf-8',
      mediaType: 'text/plain',
    },
  };

  it('locates a same-row stored primary result by canonical row and logical ordinal', () => {
    const parts = persistedParts(
      message('primary-row', 'assistant', [
        { type: 'text', text: 'before' },
        toolUse('stored'),
        storedResult,
      ]),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveProperty('data.result.outputLocator', {
      messageId: 'primary-row',
      blockOrdinal: 2,
      field: 'output',
    });
  });

  it.each([4000, 4001])(
    'locates inline primary output only above the preview limit (%i)',
    (length) => {
      const parts = persistedParts(
        message('inline-row', 'assistant', [
          toolUse('inline'),
          toolResult('inline', 'x'.repeat(length)),
        ]),
      );
      if (length === 4000) {
        expect(parts[0]).not.toHaveProperty('data.result.outputLocator');
      } else {
        expect(parts[0]).toHaveProperty('data.result.outputLocator', {
          messageId: 'inline-row',
          blockOrdinal: 1,
          field: 'output',
        });
      }
    },
  );

  it('locates standalone stored and display-cut results without a call in their row', () => {
    const parts = persistedParts(
      message('result-row', 'user', [
        { type: 'text', text: 'prefix' },
        storedResult,
        toolResult('inline', 'x'.repeat(4001)),
      ]),
    );
    expect(parts[0]?.outputLocator).toEqual({
      messageId: 'result-row',
      blockOrdinal: 1,
      field: 'output',
    });
    expect(parts[1]?.outputLocator).toEqual({
      messageId: 'result-row',
      blockOrdinal: 2,
      field: 'output',
    });
  });

  it('pairs duplicate ids with the nearest preceding unmatched call, preserving each result ordinal', () => {
    const parts = persistedParts(
      message('duplicates-row', 'assistant', [
        toolUse('duplicate'),
        toolUse('duplicate'),
        toolResult('duplicate', 'nearest'.repeat(1000)),
        toolResult('duplicate', 'earlier'.repeat(1000)),
        toolResult('duplicate', 'unmatched'.repeat(1000)),
      ]),
    );
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveProperty('data.result.outputLocator', {
      messageId: 'duplicates-row',
      blockOrdinal: 3,
      field: 'output',
    });
    expect(parts[1]).toHaveProperty('data.result.outputLocator', {
      messageId: 'duplicates-row',
      blockOrdinal: 2,
      field: 'output',
    });
    expect(parts[0]).toHaveProperty(
      'data.result.output',
      expect.stringMatching(/^earlier/),
    );
    expect(parts[1]).toHaveProperty(
      'data.result.output',
      expect.stringMatching(/^nearest/),
    );
    expect(parts[2]?.outputLocator).toEqual({
      messageId: 'duplicates-row',
      blockOrdinal: 4,
      field: 'output',
    });
  });

  it('never pairs a result with a future call in the row', () => {
    const parts = persistedParts(
      message('future-row', 'assistant', [
        toolResult('future', 'x'.repeat(4001)),
        toolUse('future'),
      ]),
    );
    expect(parts.map((part) => part.kind)).toEqual(['tool_result', 'tool_use']);
    expect(parts[0]?.outputLocator).toEqual({
      messageId: 'future-row',
      blockOrdinal: 0,
      field: 'output',
    });
    expect(parts[1]).not.toHaveProperty('data.result');
  });

  it('folds a result inline when it shares the tool_use message', () => {
    const parts = persistedParts(
      message('m1', 'assistant', [
        toolUse('tool-1'),
        toolResult('tool-1', 'done'),
      ]),
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe('tool_use');
    expect(
      (parts[0]?.data as { result?: unknown } | undefined)?.result,
    ).toEqual({
      output: 'done',
      isError: false,
    });
  });

  it('emits a standalone tool_result part when the tool_use is in another message', () => {
    // How agents actually stream: the call lands in one persisted message and
    // the result in the next. Dropping the orphan left the card spinning
    // forever and threw the output away (CAN-2523).
    const callParts = persistedParts(
      message('m1', 'assistant', [toolUse('tool-1')]),
    );
    const resultParts = persistedParts(
      message('m2', 'user', [toolResult('tool-1', 'exit 0')]),
    );

    expect(callParts).toHaveLength(1);
    expect(callParts[0]?.kind).toBe('tool_use');

    expect(resultParts).toHaveLength(1);
    expect(resultParts[0]?.kind).toBe('tool_result');
    expect(resultParts[0]?.data).toEqual({
      toolUseId: 'tool-1',
      output: 'exit 0',
      isError: false,
    });
  });

  it('preserves the error flag on a cross-message result', () => {
    const parts = persistedParts(
      message('m2', 'user', [toolResult('tool-9', 'boom', true)]),
    );

    expect(parts[0]?.data).toEqual({
      toolUseId: 'tool-9',
      output: 'boom',
      isError: true,
    });
  });

  it('folds only the same-message pair when both kinds are present', () => {
    const parts = persistedParts(
      message('m1', 'assistant', [
        toolUse('same'),
        toolResult('same', 'inline'),
        toolResult('earlier', 'carried'),
      ]),
    );

    expect(parts.map((part) => part.kind)).toEqual(['tool_use', 'tool_result']);
    expect(
      (parts[0]?.data as { result?: unknown } | undefined)?.result,
    ).toEqual({
      output: 'inline',
      isError: false,
    });
    expect(parts[1]?.data).toMatchObject({
      toolUseId: 'earlier',
      output: 'carried',
    });
  });

  it('opts into unfolded results with original ordinals and deferred-output locators', () => {
    const row = message('row-1', 'assistant', [
      toolUse('duplicate'),
      {
        type: 'tool_result',
        toolUseId: 'duplicate',
        toolName: 'Bash',
        output: 'stored preview',
        isError: false,
        fullOutputRef: {
          version: 1,
          artifactId: 'artifact-1',
          byteLength: 42,
          sha256:
            '0000000000000000000000000000000000000000000000000000000000000000',
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
      },
      toolUse('duplicate'),
      toolResult('duplicate', '012345678901234567890123456789'),
      toolResult('short-result', 'short'),
    ]);
    const limits = { partTextMaxChars: 20, unfoldToolResults: true };

    const parts = persistedParts(row, undefined, limits);
    const results = parts.filter((part) => part.kind === 'tool_result');

    expect(parts.map((part) => part.kind)).toEqual([
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_result',
    ]);
    expect(parts[0]).not.toHaveProperty('data.result');
    expect(results).toHaveLength(3);
    expect(results).toMatchObject([
      {
        kind: 'tool_result',
        blockOrdinal: 1,
        outputLocator: {
          messageId: 'row-1',
          blockOrdinal: 1,
          field: 'output',
        },
        data: { toolUseId: 'duplicate', isError: false },
      },
      {
        kind: 'tool_result',
        blockOrdinal: 3,
        outputLocator: {
          messageId: 'row-1',
          blockOrdinal: 3,
          field: 'output',
        },
        data: { toolUseId: 'duplicate', isError: false },
      },
      {
        kind: 'tool_result',
        blockOrdinal: 4,
        data: { toolUseId: 'short-result', isError: false },
      },
    ]);
    expect(results[2]).not.toHaveProperty('outputLocator');
  });

  it('keeps the default seed projection exact for paired, nested, and image parts', () => {
    const row = message('root-row', 'assistant', [
      toolUse('pair-1'),
      toolResult('pair-1', 'same row output'),
      {
        type: 'delegated_agent_call',
        delegationId: 'delegation-1',
        status: 'completed',
        outputTruncated: false,
        agentBlockId: 'agent-block-1',
        runGeneration: 1,
        sequence: 2,
        parentHarnessId: 'codex',
        parentTurnId: 'turn-1',
        parentToolCallId: 'tool-call-1',
        createdAt: 99,
        selectedModelId: 'model',
        runtimeModelId: 'model',
        targetHarnessId: 'child',
        description: 'Nested task',
        prompt: 'Do this',
        executionMode: 'background',
      },
      { type: 'image', path: '/private/diagram.png', alt: 'A diagram' },
    ]);
    const child: PersistedChatMessage = {
      id: 'child-row',
      role: 'assistant',
      timestamp: 101,
      blocks: [{ type: 'text', text: 'nested child text' }],
      parentBlockId: 'agent-block-1',
      delegationSequence: 3,
    };

    const seedPart = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message: row,
      relatedMessages: [child],
    });

    expect(seedPart).toEqual({
      messageId: 'root-row',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          data: {
            toolUseId: 'pair-1',
            toolName: 'Bash',
            input: '{"command":"ls"}',
            result: { output: 'same row output', isError: false },
          },
          occurrence: { id: 'root-row#0', revision: 0 },
        },
        {
          kind: 'agent',
          data: {
            delegation: {
              type: 'delegated_agent_call',
              delegationId: 'delegation-1',
              status: 'completed',
              outputTruncated: false,
              agentBlockId: 'agent-block-1',
              runGeneration: 1,
              sequence: 2,
              parentHarnessId: 'codex',
              parentTurnId: 'turn-1',
              parentToolCallId: 'tool-call-1',
              createdAt: 99,
              selectedModelId: 'model',
              runtimeModelId: 'model',
              targetHarnessId: 'child',
              description: 'Nested task',
              prompt: 'Do this',
              executionMode: 'background',
            },
            subBlocks: [
              {
                kind: 'text',
                data: {
                  text: 'nested child text',
                  messageId: 'child-row',
                  occurredAt: 101,
                  sequence: 3,
                },
              },
            ],
          },
        },
        { kind: 'image', data: { alt: 'A diagram' } },
      ],
      createdAtMs: 1,
    });
  });
});
