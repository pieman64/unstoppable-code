import { splitFinalMessages } from '@canopy/desktop-shared/lib/turn-utils';
import type { DisplayBlock, DisplayMessage } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function makeMsg(blocks: DisplayBlock[]): DisplayMessage {
  return {
    id: `msg-${nextId++}`,
    role: 'assistant',
    blocks,
    timestamp: Date.now(),
  };
}

function textMsg(): DisplayMessage {
  return makeMsg([{ type: 'text', text: 'hello' }]);
}

function imageMsg(): DisplayMessage {
  return makeMsg([
    { type: 'image', path: '/tmp/generated.png', alt: 'Generated image' },
  ]);
}

function bashMsg(): DisplayMessage {
  return makeMsg([
    { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Bash', input: 'ls' },
  ]);
}

function readMsg(): DisplayMessage {
  return makeMsg([
    {
      type: 'tool_use',
      toolUseId: 'tu-2',
      toolName: 'Read',
      input: 'file.ts',
    },
  ]);
}

function todoWriteMsg(): DisplayMessage {
  return makeMsg([
    {
      type: 'tool_use',
      toolUseId: 'tu-3',
      toolName: 'TodoWrite',
      input: '{}',
    },
  ]);
}

function exitPlanMsg(): DisplayMessage {
  return makeMsg([
    {
      type: 'tool_use',
      toolUseId: 'tu-4',
      toolName: 'ExitPlanMode',
      input: '{}',
    },
  ]);
}

beforeEach(() => {
  nextId = 1;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('splitFinalMessages', () => {
  it('returns empty arrays for empty input', () => {
    const result = splitFinalMessages([]);
    expect(result.intermediateMessages).toHaveLength(0);
    expect(result.finalMessages).toHaveLength(0);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('single text message → all final', () => {
    const t = textMsg();
    const result = splitFinalMessages([t]);
    expect(result.intermediateMessages).toHaveLength(0);
    expect(result.finalMessages).toEqual([t]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('single image message → all final', () => {
    const image = imageMsg();
    const result = splitFinalMessages([image]);
    expect(result.intermediateMessages).toHaveLength(0);
    expect(result.finalMessages).toEqual([image]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('image immediately before final text remains final', () => {
    const tool = bashMsg();
    const image = imageMsg();
    const text = textMsg();
    const result = splitFinalMessages([tool, image, text]);
    expect(result.intermediateMessages).toEqual([tool]);
    expect(result.finalMessages).toEqual([image, text]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('trailing text messages are final', () => {
    const b = bashMsg();
    const t = textMsg();
    const result = splitFinalMessages([b, t]);
    expect(result.intermediateMessages).toEqual([b]);
    expect(result.finalMessages).toEqual([t]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('text followed by tool — text is final, tool is trailing', () => {
    const b1 = bashMsg();
    const t = textMsg();
    const b2 = bashMsg();
    const result = splitFinalMessages([b1, t, b2]);
    expect(result.intermediateMessages).toEqual([b1]);
    expect(result.finalMessages).toEqual([t]);
    expect(result.trailingToolMessages).toEqual([b2]);
  });

  it('consecutive texts followed by tool — texts are final, tool is trailing', () => {
    const b = bashMsg();
    const t1 = textMsg();
    const t2 = textMsg();
    const r = readMsg();
    const result = splitFinalMessages([b, t1, t2, r]);
    expect(result.intermediateMessages).toEqual([b]);
    expect(result.finalMessages).toEqual([t1, t2]);
    expect(result.trailingToolMessages).toEqual([r]);
  });

  it('task-mgmt before text is included in final', () => {
    const b = bashMsg();
    const tw = todoWriteMsg();
    const t = textMsg();
    const result = splitFinalMessages([b, tw, t]);
    expect(result.intermediateMessages).toEqual([b]);
    expect(result.finalMessages).toEqual([tw, t]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('task-mgmt between text and trailing tool — task-mgmt stays in final', () => {
    const b1 = bashMsg();
    const t = textMsg();
    const tw = todoWriteMsg();
    const b2 = bashMsg();
    const result = splitFinalMessages([b1, t, tw, b2]);
    // TodoWrite is between text and the trailing tool, but anchor is at text (index 1)
    // since TodoWrite is not text/ExitPlanMode. Phase 2 extends backward from text.
    // finalMessages = [text], trailing = [TodoWrite, bash]
    expect(result.intermediateMessages).toEqual([b1]);
    expect(result.finalMessages).toEqual([t]);
    expect(result.trailingToolMessages).toEqual([tw, b2]);
  });

  it('ExitPlanMode acts as anchor', () => {
    const b = bashMsg();
    const ep = exitPlanMsg();
    const result = splitFinalMessages([b, ep]);
    expect(result.intermediateMessages).toEqual([b]);
    expect(result.finalMessages).toEqual([ep]);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('no text or ExitPlanMode — everything is intermediate', () => {
    const b1 = bashMsg();
    const b2 = readMsg();
    const result = splitFinalMessages([b1, b2]);
    expect(result.intermediateMessages).toEqual([b1, b2]);
    expect(result.finalMessages).toHaveLength(0);
    expect(result.trailingToolMessages).toHaveLength(0);
  });

  it('text between two tool runs — last text is final, trailing tool is trailing', () => {
    const b1 = bashMsg();
    const t1 = textMsg();
    const b2 = bashMsg();
    const t2 = textMsg();
    const b3 = bashMsg();
    const result = splitFinalMessages([b1, t1, b2, t2, b3]);
    expect(result.intermediateMessages).toEqual([b1, t1, b2]);
    expect(result.finalMessages).toEqual([t2]);
    expect(result.trailingToolMessages).toEqual([b3]);
  });

  it('multiple trailing tools after text', () => {
    const t = textMsg();
    const b1 = bashMsg();
    const b2 = readMsg();
    const result = splitFinalMessages([t, b1, b2]);
    expect(result.intermediateMessages).toHaveLength(0);
    expect(result.finalMessages).toEqual([t]);
    expect(result.trailingToolMessages).toEqual([b1, b2]);
  });

  it('text, text, tool — only texts shown as final', () => {
    const t1 = textMsg();
    const t2 = textMsg();
    const b = bashMsg();
    const result = splitFinalMessages([t1, t2, b]);
    expect(result.intermediateMessages).toHaveLength(0);
    expect(result.finalMessages).toEqual([t1, t2]);
    expect(result.trailingToolMessages).toEqual([b]);
  });

  it('keeps system notices visible beside the final answer after collapsing activity', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'notice',
        role: 'system',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Context could not be restored.' }],
      },
      {
        id: 'activity',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'thinking', text: 'Working' }],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Done.' }],
      },
    ];
    expect(splitFinalMessages(messages)).toEqual({
      intermediateMessages: [messages[1]],
      finalMessages: [messages[0], messages[2]],
      trailingToolMessages: [],
    });
  });

  it('keeps an account proxy switch visible between the replies after collapsing activity', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'first',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Wrapping the call in a retry.' }],
      },
      {
        id: 'switch',
        role: 'system',
        timestamp: 2,
        blocks: [
          {
            type: 'account_proxy_switch',
            timestamp: 2,
            account: 'sam@example.com',
            previousAccount: 'ops@example.com',
            previousAtLimit: true,
          },
        ],
      },
      {
        id: 'activity',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'thinking', text: 'Working' }],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 4,
        blocks: [{ type: 'text', text: 'Retries are in place.' }],
      },
    ];
    const split = splitFinalMessages(messages);
    expect(split.finalMessages.map((message) => message.id)).toEqual([
      'switch',
      'final',
    ]);
    expect(split.intermediateMessages.map((message) => message.id)).toEqual([
      'first',
      'activity',
    ]);
  });

  it('does not let a late host notice replace the final answer anchor', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'answer',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Done.' }],
      },
      {
        id: 'tool',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          { type: 'tool_use', toolUseId: 't', toolName: 'Read', input: '{}' },
        ],
      },
      {
        id: 'notice',
        role: 'system',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'A host notice.' }],
      },
    ];
    expect(splitFinalMessages(messages).finalMessages).toEqual([
      messages[0],
      messages[2],
    ]);
  });
});
