/**
 * Phase 12: `mergeToolResults` structural sharing. With the previous output
 * passed in, unchanged display messages and blocks keep their object identity
 * (so `React.memo` skips them) while the result stays deep-equal to a fresh
 * merge of the same input.
 */
import { mergeToolResults, shareDisplayMessages } from '../message-transforms';
import type { PersistedChatBlock, PersistedChatMessage } from '../../types';
import type { DisplayBlock, DisplayMessage } from '../../message-display';

function assistant(
  id: string,
  blocks: PersistedChatBlock[],
  extra: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1, ...extra };
}

function toolUse(toolUseId: string, toolName = 'Bash'): PersistedChatBlock {
  return { type: 'tool_use', toolUseId, toolName, input: '{"command":"ls"}' };
}

function toolResult(toolUseId: string, output: string): PersistedChatBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolName: 'Bash',
    output,
    isError: false,
  };
}

function blockAt(
  messages: DisplayMessage[],
  id: string,
  index: number,
): DisplayBlock {
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`missing message ${id}`);
  const block = message.blocks[index];
  if (!block) throw new Error(`missing block ${id}[${index}]`);
  return block;
}

function messageById(messages: DisplayMessage[], id: string): DisplayMessage {
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`missing message ${id}`);
  return message;
}

describe('mergeToolResults structural sharing', () => {
  const callA = assistant('a', [{ type: 'text', text: 'one' }, toolUse('t1')]);
  const resultA = assistant('ra', [toolResult('t1', 'out-1')]);
  const callB = assistant('b', [{ type: 'text', text: 'two' }, toolUse('t2')]);
  const resultB = assistant('rb', [toolResult('t2', 'out-2')]);

  it('returns the previous objects when nothing changed', () => {
    const input = [callA, resultA, callB];
    const first = mergeToolResults(input, undefined);
    const second = mergeToolResults(input, undefined, first);

    expect(second).toEqual(first);
    expect(messageById(second, 'a')).toBe(messageById(first, 'a'));
    expect(messageById(second, 'b')).toBe(messageById(first, 'b'));
  });

  it('shares unchanged tool blocks when a new result lands on another block', () => {
    const first = mergeToolResults([callA, resultA, callB], undefined);
    const second = mergeToolResults(
      [callA, resultA, callB, resultB],
      undefined,
      first,
    );

    // The block that received its result is new; everything else is shared.
    expect(blockAt(second, 'b', 1)).not.toBe(blockAt(first, 'b', 1));
    expect(blockAt(second, 'b', 1)).toMatchObject({
      type: 'tool_use',
      result: { output: 'out-2' },
    });
    expect(blockAt(second, 'b', 0)).toBe(blockAt(first, 'b', 0));
    expect(messageById(second, 'a')).toBe(messageById(first, 'a'));
    expect(messageById(second, 'b')).not.toBe(messageById(first, 'b'));
  });

  it('is deep-equal to a fresh merge across a sequence of edits', () => {
    const steps: PersistedChatMessage[][] = [
      [callA],
      [callA, resultA],
      [callA, resultA, callB],
      [callA, resultA, callB, resultB],
      // A replaced message object with identical content.
      [{ ...callA, blocks: [...callA.blocks] }, resultA, callB, resultB],
      // A changed result output for an earlier tool.
      [callA, assistant('ra', [toolResult('t1', 'out-1b')]), callB, resultB],
      // A removed message.
      [callA, callB, resultB],
    ];
    let previous: DisplayMessage[] | undefined;
    for (const step of steps) {
      const shared = mergeToolResults(step, undefined, previous);
      const fresh = mergeToolResults(step, undefined);
      expect(shared).toEqual(fresh);
      expect(JSON.stringify(shared)).toBe(JSON.stringify(fresh));
      previous = shared;
    }
  });

  it('shares unchanged agent sub-blocks when a late subagent row arrives', () => {
    const agentCall = assistant('agent', [
      {
        type: 'tool_use',
        toolUseId: 'agent-1',
        toolName: 'Agent',
        input: JSON.stringify({ description: 'Explore', prompt: 'look' }),
      },
    ]);
    const sub1 = assistant('sub-1', [{ type: 'text', text: 'first' }], {
      parentToolUseId: 'agent-1',
    });
    const sub2 = assistant('sub-2', [{ type: 'text', text: 'second' }], {
      parentToolUseId: 'agent-1',
    });

    const first = mergeToolResults([agentCall, sub1], undefined);
    const second = mergeToolResults([agentCall, sub1, sub2], undefined, first);

    const before = blockAt(first, 'agent', 0);
    const after = blockAt(second, 'agent', 0);
    expect(after).not.toBe(before);
    if (after.type !== 'agent' || before.type !== 'agent') {
      throw new Error('expected agent blocks');
    }
    expect(after.subBlocks).toHaveLength(2);
    expect(after.subBlocks[0]).toBe(before.subBlocks[0]);
    expect(second).toEqual(mergeToolResults([agentCall, sub1, sub2]));
  });

  it('never shares values that differ only in key presence or key order', () => {
    const previous: DisplayMessage[] = [
      {
        id: 'm',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 't',
            toolName: 'Bash',
            input: '{}',
            result: undefined,
          },
          { type: 'text', text: 'a' },
        ],
      },
    ];
    const next: DisplayMessage[] = [
      {
        id: 'm',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'tool_use', toolUseId: 't', toolName: 'Bash', input: '{}' },
          { type: 'text', text: 'a' },
        ],
      },
    ];
    const shared = shareDisplayMessages(previous, next);

    expect(shared[0]).not.toBe(previous[0]);
    expect(shared[0].blocks[0]).toBe(next[0].blocks[0]);
    expect(shared[0].blocks[1]).toBe(previous[0].blocks[1]);
    expect(Object.keys(shared[0].blocks[0])).toEqual(
      Object.keys(next[0].blocks[0]),
    );

    const reordered: DisplayMessage[] = [
      {
        role: 'assistant',
        id: 'm',
        timestamp: 1,
        blocks: previous[0].blocks,
      },
    ];
    const sharedReordered = shareDisplayMessages(previous, reordered);
    expect(sharedReordered[0]).not.toBe(previous[0]);
    expect(Object.keys(sharedReordered[0])).toEqual(Object.keys(reordered[0]));
  });

  it('does not share a message whose metadata changed', () => {
    const previous = mergeToolResults([callA], undefined);
    const next = mergeToolResults(
      [{ ...callA, attachmentPaths: ['/tmp/a.png'] }],
      undefined,
      previous,
    );

    expect(next[0]).not.toBe(previous[0]);
    expect(next[0].attachmentPaths).toEqual(['/tmp/a.png']);
    expect(next[0].blocks).toBe(previous[0].blocks);
  });
});
