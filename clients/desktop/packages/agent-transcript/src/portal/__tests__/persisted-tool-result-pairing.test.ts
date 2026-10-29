import { persistedParts } from '../persisted-chat-projection';
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
  it('folds a result inline when it shares the tool_use message', () => {
    const parts = persistedParts(
      message('m1', 'assistant', [
        toolUse('tool-1'),
        toolResult('tool-1', 'done'),
      ]),
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe('tool_use');
    expect((parts[0]?.data as { result?: unknown }).result).toEqual({
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
    expect((parts[0]?.data as { result?: unknown }).result).toEqual({
      output: 'inline',
      isError: false,
    });
    expect(parts[1]?.data).toMatchObject({
      toolUseId: 'earlier',
      output: 'carried',
    });
  });
});
