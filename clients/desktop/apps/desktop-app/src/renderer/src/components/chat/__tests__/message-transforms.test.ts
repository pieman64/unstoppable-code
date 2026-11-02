import { hasUnresolvedToolUseInCurrentTurn } from '../../../stores/chat/messages';
import type { ChatMessage } from '@/stores/chatStore';
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  reorderMessagesForDisplay,
  mergeToolResults,
} from '../message-transforms';
import {
  groupIntoTurns,
  computeTurnSummary,
  getToolCategory,
  parseMcpToolName,
} from '@canopy/desktop-shared/lib/turn-utils';
import type { DisplayBlock, DisplayMessage } from '../types';

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

type Block = ChatMessage['blocks'][number];
type Msg = ChatMessage;

function msg(
  id: string,
  role: 'user' | 'assistant' | 'system',
  blocks: Block[],
  extra?: { parentToolUseId?: string; parentBlockId?: string },
): Msg {
  return { id, role, blocks, timestamp: Date.now(), ...extra };
}

function textBlock(text: string): Extract<Block, { type: 'text' }> {
  return { type: 'text', text };
}

function toolUseBlock(
  toolUseId: string,
  toolName: string,
  input = '{}',
): Extract<Block, { type: 'tool_use' }> {
  return { type: 'tool_use', toolUseId, toolName, input };
}

function timerBlock(
  startedAt: number,
  completedAt: number | null = null,
): Extract<Block, { type: 'turn_timer' }> {
  return { type: 'turn_timer', startedAt, completedAt };
}

function thinkingBlock(text: string): Extract<Block, { type: 'thinking' }> {
  return { type: 'thinking', text };
}

function displayMsg(id: string, blocks: DisplayBlock[]): DisplayMessage {
  return { id, role: 'assistant', blocks, timestamp: Date.now() };
}

// Cast helpers — message-transforms expects ChatMessage / DisplayMessage but
// our lightweight test fixtures match their structural shape.
const asChat = (msgs: Msg[]): ChatMessage[] => msgs;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDisplay = (msgs: Array<Msg | DisplayMessage>): any[] => msgs;

// ---------------------------------------------------------------------------
// reorderMessagesForDisplay
// ---------------------------------------------------------------------------

describe('async answer turn ownership', () => {
  it.each([false, true])(
    'keeps the existing timer unless the answer starts a turn (%s)',
    (startsTurn) => {
      const original = msg('prompt', 'user', [textBlock('Ask while working')]);
      const timer = msg('timer', 'system', [
        { type: 'turn_timer', startedAt: 10, completedAt: 100 },
      ]);
      const question = msg('question', 'assistant', [
        textBlock('Which scope?'),
      ]);
      const progress = msg('progress', 'assistant', [
        textBlock('Still working'),
      ]);
      const answer = msg('answer', 'user', [
        {
          ...textBlock('Q: Which scope?\nA: Full'),
          asyncQuestionAnswer: {
            requestId: 'question',
            startsTurn,
            answers: [{ question: 'Which scope?', selectedOptions: ['Full'] }],
          },
        },
      ]);
      const final = msg('final', 'assistant', [textBlock('Done')]);
      const nextTimer = msg('next-timer', 'system', [
        { type: 'turn_timer', startedAt: 110, completedAt: 200 },
      ]);
      const ordered = reorderMessagesForDisplay([
        original,
        timer,
        question,
        progress,
        answer,
        ...(startsTurn ? [nextTimer] : []),
        final,
      ]);
      expect(ordered.map((m) => m.id)).toEqual(
        startsTurn
          ? [
              'prompt',
              'question',
              'progress',
              'timer',
              'answer',
              'final',
              'next-timer',
            ]
          : ['prompt', 'question', 'progress', 'answer', 'final', 'timer'],
      );
      expect(
        hasUnresolvedToolUseInCurrentTurn([
          original,
          msg('tool', 'assistant', [toolUseBlock('running', 'Bash')]),
          answer,
        ]),
      ).toBe(!startsTurn);
      const groups = groupIntoTurns(mergeToolResults(ordered));
      expect(groups).toHaveLength(startsTurn ? 2 : 1);
      expect(groups[groups.length - 1]).toMatchObject({
        kind: 'turn-group',
        isComplete: true,
        timerMessage: { id: startsTurn ? 'next-timer' : 'timer' },
      });
    },
  );

  it('groups persisted legacy pickup timers with their autonomous turn', () => {
    const ordered = reorderMessagesForDisplay(
      asChat([
        msg('root', 'user', [textBlock('Start the root turn')]),
        msg('root:timer', 'system', [timerBlock(1, 2)]),
        msg('root-answer', 'assistant', [textBlock('Root answer')]),
        msg('steer', 'user', [textBlock('Late steer')]),
        msg('steer:timer', 'assistant', [timerBlock(3, null)]),
        msg('steer-answer', 'assistant', [textBlock('Steer answer')]),
      ]),
    );

    expect(ordered.map((message: Msg) => message.id)).toEqual([
      'root',
      'root-answer',
      'root:timer',
      'steer',
      'steer-answer',
      'steer:timer',
    ]);
    expect(groupIntoTurns(mergeToolResults(ordered))).toMatchObject([
      {
        kind: 'turn-group',
        userMessage: { id: 'root' },
        timerMessage: { id: 'root:timer' },
      },
      {
        kind: 'turn-group',
        userMessage: { id: 'steer' },
        assistantMessages: [{ id: 'steer-answer' }],
        timerMessage: { id: 'steer:timer' },
        isComplete: false,
      },
    ]);
  });
});

describe('reorderMessagesForDisplay', () => {
  it('returns messages unchanged when there are no turn timers', () => {
    const input = asChat([
      msg('1', 'user', [textBlock('hi')]),
      msg('2', 'assistant', [textBlock('hello')]),
    ]);
    const result = reorderMessagesForDisplay(input);
    expect(result.map((m: Msg) => m.id)).toEqual(['1', '2']);
  });

  it('moves a turn timer before the next user message', () => {
    const input = asChat([
      msg('1', 'user', [textBlock('hi')]),
      msg('2', 'assistant', [textBlock('response')]),
      msg('timer', 'system', [timerBlock(100, 200)]),
      msg('3', 'user', [textBlock('another')]),
    ]);
    const result = reorderMessagesForDisplay(input);
    expect(result.map((m: Msg) => m.id)).toEqual(['1', '2', 'timer', '3']);
  });

  it('keeps trailing turn timer at the end', () => {
    const input = asChat([
      msg('1', 'user', [textBlock('hi')]),
      msg('2', 'assistant', [textBlock('response')]),
      msg('timer', 'system', [timerBlock(100, null)]),
    ]);
    const result = reorderMessagesForDisplay(input);
    expect(result.map((m: Msg) => m.id)).toEqual(['1', '2', 'timer']);
  });

  it('does not reinterpret unrelated assistant-role timer blocks', () => {
    const input = asChat([
      msg('1', 'user', [textBlock('hi')]),
      msg('assistant-timer', 'assistant', [timerBlock(100, null)]),
      msg('2', 'assistant', [textBlock('response')]),
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['1', 'assistant-timer', '2']);
  });

  it('handles multiple consecutive timers (last one wins)', () => {
    const input = asChat([
      msg('1', 'user', [textBlock('a')]),
      msg('t1', 'system', [timerBlock(1, 2)]),
      msg('t2', 'system', [timerBlock(3, 4)]),
      msg('2', 'user', [textBlock('b')]),
    ]);
    const result = reorderMessagesForDisplay(input);
    // Only the last pending timer is kept; earlier ones are replaced
    expect(result.map((m: Msg) => m.id)).toEqual(['1', 't2', '2']);
  });

  it("shows every canonical execution's timer, at the end of its turn", () => {
    const input = asChat([
      msg('u1', 'user', [textBlock('a')]),
      msg('t-first', 'system', [
        { ...timerBlock(1, 2), turnId: 'turn-1', userMessageId: 'u1' },
      ]),
      msg('t-restart', 'system', [
        { ...timerBlock(3, null), turnId: 'turn-2', userMessageId: 'u1' },
      ]),
      msg('a1', 'assistant', [textBlock('answer')]),
      msg('u2', 'user', [textBlock('b')]),
    ]);
    const result = reorderMessagesForDisplay(input);
    // A restart execution's timer no longer replaces the first one.
    expect(result.map((m: Msg) => m.id)).toEqual([
      'u1',
      'a1',
      't-restart',
      't-first',
      'u2',
    ]);
  });

  it("keeps a resumed turn live: the latest execution's timer owns the turn", () => {
    const input = asChat([
      msg('u1', 'user', [textBlock('a')]),
      msg('t-first', 'system', [
        { ...timerBlock(1, 2), turnId: 'turn-1', userMessageId: 'u1' },
      ]),
      msg('t-restart', 'system', [
        { ...timerBlock(3, null), turnId: 'turn-2', userMessageId: 'u1' },
      ]),
      msg('a1', 'assistant', [textBlock('answer')]),
    ]);
    const groups = groupIntoTurns(
      mergeToolResults(reorderMessagesForDisplay(input)),
    );
    const turn = groups[0];
    expect(turn?.kind).toBe('turn-group');
    if (turn?.kind !== 'turn-group') return;
    expect(turn.timerMessage.id).toBe('t-restart');
    expect(turn.isComplete).toBe(false);
    // The earlier execution's timer still shows, as its own row.
    expect(
      groups
        .slice(1)
        .map((group) =>
          group.kind === 'standalone' ? group.message.id : group.kind,
        ),
    ).toEqual(['t-first']);
  });

  describe('wake boundaries (turn-state phase 40d)', () => {
    const wakeInput = (spawnedBy: {
      taskId?: string;
      toolUseId?: string;
    }): Msg[] => [
      msg('u1', 'user', [textBlock('run the tests in the background')]),
      msg('a1', 'assistant', [
        toolUseBlock(
          'tool-1',
          'Bash',
          JSON.stringify({ command: 'npm test', description: 'Run the tests' }),
        ),
      ]),
      msg('t1', 'system', [
        { ...timerBlock(1, 2), turnId: 'turn-1', userMessageId: 'u1' },
      ]),
      msg('tw', 'system', [
        { ...timerBlock(3, null), turnId: 'wake', spawnedBy },
      ]),
      msg('a-wake', 'assistant', [textBlock('The tests passed.')]),
    ];

    it('heads a wake with a boundary row naming its task, closed by its own timer', () => {
      const result = reorderMessagesForDisplay(
        asChat(wakeInput({ taskId: 'task-1', toolUseId: 'tool-1' })),
      );
      expect(result.map((m: Msg) => m.id)).toEqual([
        'u1',
        'a1',
        't1',
        'tw:wake',
        'a-wake',
        'tw',
      ]);
      expect(result[3]).toMatchObject({
        role: 'system',
        blocks: [
          {
            type: 'wake_boundary',
            turnId: 'wake',
            taskLabel: 'Run the tests',
            spawningUserMessageId: 'u1',
          },
        ],
      });
      const groups = groupIntoTurns(mergeToolResults(result));
      expect(
        groups.map((group) =>
          group.kind === 'turn-group'
            ? [group.userMessage.id, group.timerMessage.id, group.isComplete]
            : group.kind,
        ),
      ).toEqual([
        ['u1', 't1', true],
        ['tw:wake', 'tw', false],
      ]);
    });

    it("names no task when the provider doesn't say what woke the turn", () => {
      const result = reorderMessagesForDisplay(asChat(wakeInput({})));
      const boundary = result.find((m: Msg) => m.id === 'tw:wake');
      expect(boundary?.blocks).toEqual([
        { type: 'wake_boundary', turnId: 'wake' },
      ]);
    });
  });

  it("places a canonical timer in its anchor's turn, not where it was appended", () => {
    const input = asChat([
      msg('u1', 'user', [textBlock('a')]),
      msg('a1', 'assistant', [textBlock('answer')]),
      msg('u2', 'user', [textBlock('b')]),
      msg('a2', 'assistant', [textBlock('second answer')]),
      msg('t1', 'system', [
        { ...timerBlock(1, 2), turnId: 'turn-1', userMessageId: 'u1' },
      ]),
    ]);
    const result = reorderMessagesForDisplay(input);
    expect(result.map((m: Msg) => m.id)).toEqual([
      'u1',
      'a1',
      't1',
      'u2',
      'a2',
    ]);
  });

  it('keeps a canonical timer whose anchor is not in the transcript where it was appended', () => {
    const input = asChat([
      msg('u1', 'user', [textBlock('a')]),
      msg('t1', 'system', [
        { ...timerBlock(1, 2), turnId: 'turn-1', userMessageId: 'missing' },
      ]),
      msg('a1', 'assistant', [textBlock('answer')]),
    ]);
    const result = reorderMessagesForDisplay(input);
    expect(result.map((m: Msg) => m.id)).toEqual(['u1', 'a1', 't1']);
  });

  it('drops legacy Claude Code queue-operation prompt echoes before the real user message', () => {
    const input = asChat([
      {
        ...msg('queue-echo', 'assistant', [textBlock('what am i looking at?')]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('what am i looking at?')]),
        timestamp: 1005,
      },
      msg('assistant', 'assistant', [textBlock('Here is the screen.')]),
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['user', 'assistant']);
  });

  it('matches prompt echoes with the same trimmed and collapsed Unicode whitespace semantics', () => {
    const input = asChat([
      {
        ...msg('queue-echo', 'assistant', [
          textBlock('\t review\u00a0this\n\nchange \u3000'),
        ]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('review this change')]),
        timestamp: 1500,
      },
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['user']);
  });

  it('does not collapse a missing word boundary when detecting prompt echoes', () => {
    const input = asChat([
      {
        ...msg('assistant', 'assistant', [textBlock('reviewthis change')]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('review this change')]),
        timestamp: 1001,
      },
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['assistant', 'user']);
  });

  it('keeps matching assistant and user text outside the queue-echo time window', () => {
    const input = asChat([
      {
        ...msg('assistant', 'assistant', [textBlock('same prompt')]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('same prompt')]),
        timestamp: 2001,
      },
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['assistant', 'user']);
  });

  it('keeps multi-block assistant messages even when their text matches the next user message', () => {
    const input = asChat([
      {
        ...msg('assistant', 'assistant', [
          textBlock('same prompt'),
          thinkingBlock('queued'),
        ]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('same prompt')]),
        timestamp: 1001,
      },
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['assistant', 'user']);
  });

  it('keeps adjacent assistant and user text when it is not a prompt echo', () => {
    const input = asChat([
      {
        ...msg('assistant', 'assistant', [textBlock('Done.')]),
        timestamp: 1000,
      },
      {
        ...msg('user', 'user', [textBlock('what next?')]),
        timestamp: 1005,
      },
    ]);

    const result = reorderMessagesForDisplay(input);

    expect(result.map((m: Msg) => m.id)).toEqual(['assistant', 'user']);
  });
});

// ---------------------------------------------------------------------------
// groupIntoTurns
// ---------------------------------------------------------------------------

describe('groupIntoTurns', () => {
  it('creates a turn-group from user + assistant + timer', () => {
    const input = asDisplay([
      msg('u1', 'user', [textBlock('hi')]),
      msg('a1', 'assistant', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
    ]);
    const result = groupIntoTurns(input);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('turn-group');
    if (result[0].kind === 'turn-group') {
      expect(result[0].userMessage.id).toBe('u1');
      expect(result[0].assistantMessages).toHaveLength(1);
      expect(result[0].assistantMessages[0].id).toBe('a1');
      expect(result[0].isComplete).toBe(true);
    }
  });

  it('marks incomplete turns (timer.completedAt === null)', () => {
    const input = asDisplay([
      msg('u1', 'user', [textBlock('hi')]),
      msg('a1', 'assistant', [textBlock('working...')]),
      msg('t1', 'system', [timerBlock(100, null)]),
    ]);
    const result = groupIntoTurns(input);
    expect(result).toHaveLength(1);
    if (result[0].kind === 'turn-group') {
      expect(result[0].isComplete).toBe(false);
    }
  });

  it('flushes incomplete turns (no timer) as standalone messages', () => {
    const input = asDisplay([
      msg('u1', 'user', [textBlock('hi')]),
      msg('a1', 'assistant', [textBlock('still working')]),
    ]);
    const result = groupIntoTurns(input);
    // Without a timer, the messages should be standalone
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('standalone');
    expect(result[1].kind).toBe('standalone');
  });

  it('handles multiple consecutive turn groups', () => {
    const input = asDisplay([
      msg('u1', 'user', [textBlock('first')]),
      msg('a1', 'assistant', [textBlock('r1')]),
      msg('t1', 'system', [timerBlock(1, 2)]),
      msg('u2', 'user', [textBlock('second')]),
      msg('a2', 'assistant', [textBlock('r2')]),
      msg('t2', 'system', [timerBlock(3, 4)]),
    ]);
    const result = groupIntoTurns(input);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('turn-group');
    expect(result[1].kind).toBe('turn-group');
  });

  it('treats orphan timer (no preceding user msg) as standalone', () => {
    const input = asDisplay([msg('t1', 'system', [timerBlock(100, 200)])]);
    const result = groupIntoTurns(input);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('standalone');
  });

  it('groups multiple assistant messages into one turn group', () => {
    const input = asDisplay([
      msg('u1', 'user', [textBlock('go')]),
      msg('a1', 'assistant', [textBlock('step 1')]),
      msg('a2', 'assistant', [textBlock('step 2')]),
      msg('a3', 'assistant', [textBlock('done')]),
      msg('t1', 'system', [timerBlock(1, 10)]),
    ]);
    const result = groupIntoTurns(input);
    expect(result).toHaveLength(1);
    if (result[0].kind === 'turn-group') {
      expect(result[0].assistantMessages).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// computeTurnSummary
// ---------------------------------------------------------------------------

describe('computeTurnSummary', () => {
  it('counts text blocks as messages', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [textBlock('hello'), textBlock('world')]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.messages).toBe(2);
  });

  it('counts thinking blocks', () => {
    const input = asDisplay([msg('a1', 'assistant', [thinkingBlock('hmm')])]);
    const result = computeTurnSummary(input);
    expect(result.thinking).toBe(1);
  });

  it('ignores empty thinking blocks', () => {
    const input = asDisplay([msg('a1', 'assistant', [thinkingBlock('   ')])]);
    const result = computeTurnSummary(input);
    expect(result.thinking).toBe(0);
  });

  it('categorizes tool_use blocks correctly', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [
        toolUseBlock('1', 'Bash'),
        toolUseBlock('2', 'Read'),
        toolUseBlock('3', 'ReadLines'),
        toolUseBlock('4', 'Write'),
        toolUseBlock('5', 'Glob'),
        toolUseBlock('6', 'Grep'),
        toolUseBlock('7', 'WebFetch'),
        toolUseBlock('8', 'Skill'),
        toolUseBlock('9', 'TaskCreate'),
        toolUseBlock('10', 'TaskStop'),
        toolUseBlock('11', 'ClaudeModelChange'),
      ]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.bash).toBe(1);
    expect(result.read).toBe(1);
    expect(result.readLines).toBe(1);
    expect(result.writeEdit).toBe(1);
    expect(result.search).toBe(1);
    expect(result.grep).toBe(1);
    expect(result.web).toBe(1);
    expect(result.skills).toBe(1);
    expect(result.tasks).toBe(1);
    expect(result.taskStop).toBe(1);
    expect(result.claude).toBe(1);
  });

  it('counts MCP tool calls', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [toolUseBlock('1', 'mcp__server__tool')]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.mcp).toBe(1);
  });

  it('counts Canopy action tool calls separately from App Advisor', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [
        toolUseBlock('1', 'mcp__canopy__SearchActions'),
        toolUseBlock('2', 'canopy_dispatch_action'),
        toolUseBlock('3', 'mcp__canopy__ReadPipelineYaml'),
        toolUseBlock('4', 'canopy_app_advisor_read_pipeline_yaml'),
      ]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.canopy).toBe(3);
    expect(result.appAdvisor).toBe(1);
  });

  it('skips EnterPlanMode and ExitPlanMode', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [
        toolUseBlock('1', 'EnterPlanMode'),
        toolUseBlock('2', 'ExitPlanMode'),
        toolUseBlock('3', 'Bash'),
      ]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.bash).toBe(1);
    expect(result.other).toBe(0);
  });

  it('handles file_change blocks', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          toolUseId: '1',
          toolName: 'file_change',
          input: 'edit: src/foo.ts\nadd: src/bar.ts\ndelete: src/baz.ts',
        },
      ]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.fileEdit).toBe(1);
    expect(result.fileAdd).toBe(1);
    expect(result.fileDelete).toBe(1);
  });

  it('returns zero counts for empty input', () => {
    const result = computeTurnSummary([]);
    expect(result.messages).toBe(0);
    expect(result.bash).toBe(0);
    expect(result.thinking).toBe(0);
  });

  it('counts a codex_agent display block as one agent (Phase F3 §5)', () => {
    const agentBlock: Extract<DisplayBlock, { type: 'codex_agent' }> = {
      type: 'codex_agent',
      agentBlockId: 'codex-agent-1',
      callId: '1',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['sub'],
      prompt: 'do',
      description: 'do',
      displayName: 'Codex',
      agentsStates: {},
      subBlocks: [],
    };
    const input = asDisplay([displayMsg('a1', [agentBlock])]);
    const result = computeTurnSummary(input);
    expect(result.agent).toBe(1);
    expect(result.other).toBe(0);
  });

  it('counts an unmatched Claude TaskOutput tool as agent activity', () => {
    const input = asDisplay([
      msg('a1', 'assistant', [toolUseBlock('1', 'TaskOutput')]),
    ]);
    const result = computeTurnSummary(input);
    expect(result.agent).toBe(1);
    expect(result.other).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getToolCategory
// ---------------------------------------------------------------------------

describe('getToolCategory', () => {
  it('maps Bash to bash', () => {
    expect(getToolCategory('Bash')).toBe('bash');
  });

  it('maps Edit to writeEdit', () => {
    expect(getToolCategory('Edit')).toBe('writeEdit');
  });

  it('maps ReadLines to readLines', () => {
    expect(getToolCategory('ReadLines')).toBe('readLines');
  });

  it('maps unknown tools to other', () => {
    expect(getToolCategory('SomeUnknownTool')).toBe('other');
  });

  it('maps MCP tools to mcp', () => {
    expect(getToolCategory('mcp__myserver__mytool')).toBe('mcp');
  });
});

// ---------------------------------------------------------------------------
// parseMcpToolName
// ---------------------------------------------------------------------------

describe('parseMcpToolName', () => {
  it('parses standard MCP tool names', () => {
    expect(parseMcpToolName('mcp__server__tool')).toEqual({
      server: 'server',
      tool: 'tool',
    });
  });

  it('returns null for non-MCP tools', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
  });

  it('returns null for canopy internal MCP tools', () => {
    expect(parseMcpToolName('mcp__canopy__AskUserQuestion')).toBeNull();
  });

  it('handles dynamic server names', () => {
    const result = parseMcpToolName('mcp__appdyn-myserver--abc__mytool');
    expect(result).toEqual({ server: 'myserver', tool: 'mytool' });
  });

  it('handles proxied OAuth MCP server names', () => {
    const result = parseMcpToolName(
      'mcp__appproxy-github--server-config__create_issue',
    );
    expect(result).toEqual({ server: 'github', tool: 'create_issue' });
  });

  it('handles appplugin- prefixed MCP server names', () => {
    const result = parseMcpToolName(
      'mcp__appplugin-linear--linear-Linear__list_issues',
    );
    expect(result).toEqual({ server: 'linear', tool: 'list_issues' });
  });

  it('renders proxied MCPs identically to standalone MCPs', () => {
    const proxied = parseMcpToolName(
      'mcp__appproxy-github--server-config__create_issue',
    );
    const standalone = parseMcpToolName('mcp__github__create_issue');
    expect(proxied).toEqual(standalone);
  });

  it('handles tool names with double underscores', () => {
    expect(parseMcpToolName('mcp__server__nested__tool')).toEqual({
      server: 'server',
      tool: 'nested__tool',
    });
  });
});
