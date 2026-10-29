import type { DisplayBlock, DisplayMessage } from '../types';
import {
  LIVE_STEP_WINDOW_SIZE,
  liveStepWindow,
  segmentToolSteps,
  stepPieceOf,
  summarizeSteps,
  summarizeToolSteps,
  type ToolStepSegment,
} from '../tool-step-groups';

/**
 * CAN-4274: the opt-in live step window. These fixtures follow the shape the
 * Claude transform produces while a turn streams: a thinking block and the
 * tool calls it leads to arrive as their own assistant messages, sometimes
 * several calls in one message, and a thinking block can briefly be empty.
 */

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

let nextId = 0;

function toolUse(
  toolName: string,
  input: object = {},
  running = false,
): ToolUseBlock {
  nextId += 1;
  return {
    type: 'tool_use',
    toolUseId: `tool-${nextId}`,
    toolName,
    input: JSON.stringify(input),
    ...(running ? {} : { result: { output: 'ok', isError: false } }),
  };
}

function thinking(text: string): DisplayBlock {
  return { type: 'thinking', text };
}

function message(id: string, blocks: DisplayBlock[]): DisplayMessage {
  return { id, role: 'assistant', blocks, timestamp: 1 };
}

function text(id: string, value: string): DisplayMessage {
  return message(id, [{ type: 'text', text: value }]);
}

function shape(segments: ToolStepSegment[]): string[] {
  return segments.map((segment) =>
    segment.kind === 'message'
      ? segment.message.id
      : `[${segment.messages.map((m) => m.id).join(',')}]`,
  );
}

/** The step blocks a window shows, in order, by a readable name. */
function windowNames(messages: DisplayMessage[]): string[] {
  return liveStepWindow(messages).flatMap((m) =>
    m.blocks.flatMap((block) => {
      if (block.type === 'thinking') {
        return block.text.trim() ? [`think:${block.text}`] : [];
      }
      if (block.type === 'tool_use') return [`tool:${block.toolName}`];
      return [`other:${block.type}`];
    }),
  );
}

describe('segmentToolSteps with the live step window', () => {
  it('folds a single tool call into a group', () => {
    const messages = [message('read', [toolUse('Read')])];
    expect(shape(segmentToolSteps(messages))).toEqual(['read']);
    expect(shape(segmentToolSteps(messages, { liveStepWindow: true }))).toEqual(
      ['[read]'],
    );
  });

  it('folds a thinking-only run and counts each thinking block as a step', () => {
    const messages = [
      message('t1', [thinking('Where is the cache?')]),
      message('t2', [thinking('Check the store next.')]),
    ];
    expect(shape(segmentToolSteps(messages))).toEqual(['t1', 't2']);
    const [segment] = segmentToolSteps(messages, { liveStepWindow: true });
    if (segment?.kind !== 'steps') throw new Error('Expected a step group');
    expect(segment.steps.map((block) => block.type)).toEqual([
      'thinking',
      'thinking',
    ]);
    expect(segment.toolUses).toEqual([]);
  });

  it('does not count empty thinking blocks as steps', () => {
    const messages = [message('empty', [thinking('  ')])];
    expect(shape(segmentToolSteps(messages, { liveStepWindow: true }))).toEqual(
      ['empty'],
    );
  });

  it('counts every call in a message that holds several', () => {
    const messages = [
      message('multi', [
        toolUse('Read'),
        toolUse('Grep', { pattern: 'x' }),
        toolUse('Read'),
      ]),
    ];
    const [segment] = segmentToolSteps(messages, { liveStepWindow: true });
    if (segment?.kind !== 'steps') throw new Error('Expected a step group');
    expect(segment.steps).toHaveLength(3);
  });

  it('splits groups at agent text, which stays its own row', () => {
    const messages = [
      message('t1', [thinking('one')]),
      message('t2', [thinking('two')]),
      text('say', 'Let me check what Anthropic actually returns.'),
      message('t4', [thinking('four')]),
    ];
    expect(shape(segmentToolSteps(messages, { liveStepWindow: true }))).toEqual(
      ['[t1,t2]', 'say', '[t4]'],
    );
  });

  it('keeps the group key on its first message while steps arrive', () => {
    const first = message('first', [thinking('one')]);
    const keyOf = (messages: DisplayMessage[]): string | undefined => {
      const [segment] = segmentToolSteps(messages, { liveStepWindow: true });
      return segment?.kind === 'steps' ? segment.key : undefined;
    };
    expect(keyOf([first])).toBe('first');
    expect(keyOf([first, message('second', [toolUse('Read')])])).toBe('first');
  });

  it('leaves the early access grouping unchanged without the option', () => {
    const messages = [
      message('t1', [thinking('one')]),
      message('read', [toolUse('Read')]),
      text('say', 'Done reading.'),
      message('a', [toolUse('Read')]),
      message('b', [thinking('hm'), toolUse('Grep')]),
    ];
    const segments = segmentToolSteps(messages);
    expect(shape(segments)).toEqual(['t1', 'read', 'say', '[a,b]']);
    const group = segments[3];
    if (group?.kind !== 'steps') throw new Error('Expected a step group');
    // Thinking is not a step under early access alone.
    expect(group.steps).toEqual(group.toolUses);
  });
});

describe('liveStepWindow', () => {
  it('shows the newest three steps and drops the oldest as steps arrive', () => {
    const messages: DisplayMessage[] = [];
    const seen: string[][] = [];
    for (let index = 1; index <= 5; index += 1) {
      messages.push(message(`m${index}`, [thinking(`step ${index}`)]));
      seen.push(windowNames(messages));
    }
    expect(LIVE_STEP_WINDOW_SIZE).toBe(3);
    expect(seen).toEqual([
      ['think:step 1'],
      ['think:step 1', 'think:step 2'],
      ['think:step 1', 'think:step 2', 'think:step 3'],
      ['think:step 2', 'think:step 3', 'think:step 4'],
      ['think:step 3', 'think:step 4', 'think:step 5'],
    ]);
  });

  it('trims a message with several calls to the steps inside the window', () => {
    const messages = [
      message('think', [thinking('plan')]),
      message('multi', [
        toolUse('Grep', { pattern: 'a' }),
        toolUse('Read'),
        toolUse('Glob'),
      ]),
    ];
    expect(windowNames(messages)).toEqual([
      'tool:Grep',
      'tool:Read',
      'tool:Glob',
    ]);
    messages.push(message('last', [toolUse('Bash', {}, true)]));
    const window = liveStepWindow(messages);
    expect(window.map((m) => m.id)).toEqual(['multi', 'last']);
    expect(windowNames(messages)).toEqual([
      'tool:Read',
      'tool:Glob',
      'tool:Bash',
    ]);
  });

  it('keeps the original message object when all of it is in the window', () => {
    const kept = message('kept', [toolUse('Read')]);
    const messages = [message('old', [toolUse('Read')]), kept];
    const window = liveStepWindow(messages);
    expect(window[window.length - 1]).toBe(kept);
  });

  it('returns the same trimmed message while its blocks are unchanged', () => {
    const multi = message('multi', [
      toolUse('Read'),
      toolUse('Read'),
      toolUse('Read'),
      toolUse('Read'),
    ]);
    const first = liveStepWindow([multi]);
    const second = liveStepWindow([multi]);
    expect(first[0]).not.toBe(multi);
    expect(second[0]).toBe(first[0]);
  });

  it('leaves out empty thinking shells and never repeats a step', () => {
    const messages = [
      message('shell-1', [thinking('')]),
      message('read-1', [toolUse('Read')]),
      message('shell-2', [thinking(' ')]),
      message('read-2', [toolUse('Read')]),
      message('read-3', [toolUse('Grep')]),
      message('read-4', [toolUse('Glob')]),
      message('shell-3', [thinking('')]),
    ];
    const window = liveStepWindow(messages);
    expect(window.map((m) => m.id)).toEqual(['read-2', 'read-3', 'read-4']);
    const ids = window.flatMap((m) =>
      m.blocks.flatMap((block) =>
        block.type === 'tool_use' ? [block.toolUseId] : [],
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns every message when the group has three steps or fewer', () => {
    const messages = [
      message('a', [thinking('one')]),
      message('b', [toolUse('Read'), toolUse('Read')]),
    ];
    expect(liveStepWindow(messages)).toEqual(messages);
  });
});

describe('summarizeSteps', () => {
  it('names thinking alongside tool calls, in first-seen order', () => {
    expect(
      summarizeSteps([
        thinking('plan'),
        toolUse('Read'),
        thinking('again'),
        toolUse('Grep', { pattern: 'x' }),
      ]),
    ).toBe('Thought 2 times, read 1 file, searched 1 time');
  });

  it('reads a single thought on its own', () => {
    expect(summarizeSteps([thinking('plan')])).toBe('Thought');
  });

  it('matches the tool-call summary when there is no thinking', () => {
    const calls = [toolUse('Read'), toolUse('Bash', { command: 'ls' })];
    expect(summarizeSteps(calls)).toBe(summarizeToolSteps(calls));
  });
});

/**
 * One assistant message can hold text between its steps: a Claude assistant
 * event carries thinking, text and tool calls in one `content` array, and an
 * OpenCode patch stream appends a tool call after the text it opened with
 * (`agent-transcript/src/lib/__tests__/opencode-transcript.test.ts`). The
 * window must split those at block boundaries, not hide or repeat the text.
 */
describe('a message with text between its steps', () => {
  const say = 'Let me check what Anthropic actually returns for your account.';

  function mixed(): DisplayMessage {
    return message('claude-1', [
      thinking('Planning the lookup'),
      toolUse('Read'),
      toolUse('Grep', { pattern: 'x' }),
      { type: 'text', text: say },
      toolUse('Read'),
      toolUse('Glob', { pattern: '*.ts' }),
      thinking('Comparing'),
      toolUse('Bash', { command: 'ls' }, true),
    ]);
  }

  function pieces(segments: ToolStepSegment[]): string[][] {
    return segments.map((segment) =>
      (segment.kind === 'message' ? [segment.message] : segment.messages)
        .flatMap((m) => m.blocks)
        .map((block) =>
          block.type === 'tool_use' ? block.toolName : block.type,
        ),
    );
  }

  it('splits the steps around the text and keeps every block in order', () => {
    const source = mixed();
    const segments = segmentToolSteps([source], { liveStepWindow: true });
    expect(segments.map((segment) => segment.kind)).toEqual([
      'steps',
      'message',
      'steps',
    ]);
    expect(pieces(segments)).toEqual([
      ['thinking', 'Read', 'Grep'],
      ['text'],
      ['Read', 'Glob', 'thinking', 'Bash'],
    ]);
    // The blocks are the source's own objects, so results and running state
    // ride along untouched.
    expect(
      segments
        .flatMap((segment) =>
          segment.kind === 'message' ? [segment.message] : segment.messages,
        )
        .flatMap((m) => m.blocks),
    ).toEqual(source.blocks);
    const [, , last] = segments;
    if (last?.kind !== 'steps') throw new Error('Expected a step group');
    expect(last.steps).toHaveLength(4);
    expect(windowNames(last.messages)).toEqual([
      'tool:Glob',
      'think:Comparing',
      'tool:Bash',
    ]);
  });

  it('keeps the source id and gives each piece its own stable key', () => {
    const source = mixed();
    const segments = segmentToolSteps([source], { liveStepWindow: true });
    const shown = segments.flatMap((segment) =>
      segment.kind === 'message' ? [segment.message] : segment.messages,
    );
    expect(shown.map((m) => m.id)).toEqual([
      'claude-1',
      'claude-1',
      'claude-1',
    ]);
    const keys = shown.map((m) => stepPieceOf(m).key);
    expect(new Set(keys).size).toBe(3);
    expect(shown.map((m) => stepPieceOf(m).source)).toEqual([
      source,
      source,
      source,
    ]);
    // Only the last piece can still receive text.
    expect(shown.map((m) => stepPieceOf(m).endsSource)).toEqual([
      false,
      false,
      true,
    ]);
    const groupKeys = segments.flatMap((segment) =>
      segment.kind === 'steps' ? [segment.key] : [],
    );
    expect(new Set(groupKeys).size).toBe(2);

    // Re-segmenting the same message returns the same pieces, and a longer
    // message keeps the keys of the pieces it already had.
    const again = segmentToolSteps([source], { liveStepWindow: true });
    expect(
      again.flatMap((segment) =>
        segment.kind === 'message' ? [segment.message] : segment.messages,
      ),
    ).toEqual(shown);
    const grown = message('claude-1', [
      ...source.blocks,
      { type: 'text', text: 'Found it.' },
    ]);
    const grownKeys = segmentToolSteps([grown], { liveStepWindow: true })
      .flatMap((segment) =>
        segment.kind === 'message' ? [segment.message] : segment.messages,
      )
      .map((m) => stepPieceOf(m).key);
    expect(grownKeys.slice(0, 3)).toEqual(keys);
    expect(grownKeys).toHaveLength(4);
  });

  it('keeps a trimmed window row linked to its piece', () => {
    const segments = segmentToolSteps([mixed()], { liveStepWindow: true });
    const last = segments[segments.length - 1];
    if (last?.kind !== 'steps') throw new Error('Expected a step group');
    const [row] = liveStepWindow(last.messages);
    if (!row) throw new Error('Expected a window row');
    expect(row).not.toBe(last.messages[0]);
    const piece = stepPieceOf(last.messages[0]);
    // The window drops Read from the front of the piece that starts at 4.
    expect(piece.blockOffset).toBe(4);
    expect(stepPieceOf(row)).toEqual({ ...piece, blockOffset: 5 });
  });

  it('follows the OpenCode patch shape: text, then a call with its result', () => {
    const call = toolUse('Read', { file_path: 'README.md' });
    const segments = segmentToolSteps(
      [
        message('opencode-message', [
          { type: 'text', text: 'Inspected the project.' },
          call,
        ]),
      ],
      { liveStepWindow: true },
    );
    expect(pieces(segments)).toEqual([['text'], ['Read']]);
    const [, group] = segments;
    if (group?.kind !== 'steps') throw new Error('Expected a step group');
    expect(group.toolUses).toEqual([call]);
    expect(group.toolUses[0]?.result).toEqual({ output: 'ok', isError: false });
  });

  it('keeps calls that need their own row out of the group', () => {
    const failed: ToolUseBlock = {
      ...toolUse('Bash', { command: 'false' }),
      result: { output: 'boom', isError: true },
    };
    expect(
      pieces(
        segmentToolSteps(
          [message('m', [toolUse('Read'), failed, toolUse('Read')])],
          { liveStepWindow: true },
        ),
      ),
    ).toEqual([['Read'], ['Bash'], ['Read']]);
  });

  it('leaves the message whole without the option', () => {
    const source = mixed();
    const segments = segmentToolSteps([source]);
    expect(segments).toEqual([{ kind: 'message', message: source }]);
    expect(stepPieceOf(source)).toEqual({
      source,
      key: 'claude-1',
      endsSource: true,
      blockOffset: 0,
    });
  });
});
