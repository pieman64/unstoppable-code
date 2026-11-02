import type { ApprovalSafetyDeniedInfo } from '@canopy/protocol/approvals';
import type { ChatMessage } from '@/stores/chat/types';
import { placeSafetyDenialReceipts } from '../safety-denial-placement';

function receipt(
  receiptId: string,
  overrides: Partial<ApprovalSafetyDeniedInfo> = {},
): ChatMessage {
  return {
    id: receiptId,
    role: 'system',
    timestamp: 2,
    blocks: [
      {
        type: 'approval_safety_denied_info',
        receiptId,
        timestamp: 2,
        reason: 'force-push',
        command: 'git push --force origin HEAD',
        mode: 'ask',
        toolUseId: 'call-1',
        ...overrides,
      },
    ],
  };
}

const user: ChatMessage = {
  id: 'user-1',
  role: 'user',
  timestamp: 0,
  blocks: [{ type: 'text', text: 'Push it' }],
};

function streamingReply(): ChatMessage {
  // One assistant message the stream keeps extending: the denied row, then
  // the agent's follow-up text.
  return {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'Bash',
        input: '{"command":"git push --force origin HEAD"}',
      },
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        toolName: 'Bash',
        output: 'Blocked by a safety rule (force-push).',
        isError: true,
      },
      { type: 'text', text: 'The push was blocked.' },
    ],
  };
}

function blockTypes(messages: readonly ChatMessage[]): string[][] {
  return messages.map((message) => message.blocks.map((block) => block.type));
}

describe('placeSafetyDenialReceipts', () => {
  it('returns the same array when the transcript has no receipts', () => {
    const messages = [user, streamingReply()];
    expect(placeSafetyDenialReceipts(messages)).toBe(messages);
  });

  it('places the notice after its tool row and before later text in a reused message', () => {
    const placed = placeSafetyDenialReceipts([
      user,
      streamingReply(),
      receipt('r-1'),
    ]);
    expect(blockTypes(placed)).toEqual([
      ['text'],
      ['tool_use', 'tool_result', 'approval_safety_denied_info', 'text'],
    ]);
  });

  it('places a receipt committed before its row arrived', () => {
    const placed = placeSafetyDenialReceipts([
      user,
      receipt('r-1'),
      streamingReply(),
    ]);
    expect(placed.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
    expect(placed[1]?.blocks[2]?.type).toBe('approval_safety_denied_info');
  });

  it.each(['parentBlockId', 'parentToolUseId'] as const)(
    'keeps the root origin across a delegated user follow-up with %s',
    (parentKey) => {
      const child = { ...streamingReply(), parentToolUseId: 'agent-call' };
      const followUp = {
        ...user,
        id: 'delegated-follow-up',
        [parentKey]: 'agent-call',
      };
      const placed = placeSafetyDenialReceipts([
        user,
        followUp,
        child,
        receipt('child-receipt', {
          subagentId: 'child',
          turnUserMessageId: user.id,
        }),
      ]);
      expect(placed).toHaveLength(3);
      expect(placed[2]?.blocks[2]?.type).toBe('approval_safety_denied_info');
    },
  );

  it('renders a duplicated receipt exactly once', () => {
    const placed = placeSafetyDenialReceipts([
      user,
      streamingReply(),
      receipt('r-1'),
      receipt('r-1'),
    ]);
    const receipts = placed.flatMap((message) =>
      message.blocks.filter(
        (block) => block.type === 'approval_safety_denied_info',
      ),
    );
    expect(receipts).toHaveLength(1);
  });

  it('keeps distinct receipts for separate invocations of one command', () => {
    const second: ChatMessage = {
      id: 'assistant-2',
      role: 'assistant',
      timestamp: 3,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'call-2',
          toolName: 'Bash',
          input: '{"command":"git push --force origin HEAD"}',
        },
        { type: 'text', text: 'Blocked again.' },
      ],
    };
    const placed = placeSafetyDenialReceipts([
      user,
      streamingReply(),
      receipt('r-1'),
      second,
      receipt('r-2', { toolUseId: 'call-2' }),
    ]);
    expect(blockTypes(placed)).toEqual([
      ['text'],
      ['tool_use', 'tool_result', 'approval_safety_denied_info', 'text'],
      ['tool_use', 'approval_safety_denied_info', 'text'],
    ]);
  });

  it('places a subagent receipt inside the subagent message that holds the row', () => {
    const child: ChatMessage = {
      id: 'child-1',
      role: 'assistant',
      timestamp: 1,
      parentToolUseId: 'agent-call',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'child-call',
          toolName: 'Bash',
          input: '{}',
        },
        { type: 'text', text: 'Child continues.' },
      ],
    };
    const placed = placeSafetyDenialReceipts([
      user,
      child,
      receipt('r-child', { toolUseId: 'child-call', subagentId: 'child' }),
    ]);
    expect(placed[1]?.parentToolUseId).toBe('agent-call');
    expect(blockTypes(placed)[1]).toEqual([
      'tool_use',
      'approval_safety_denied_info',
      'text',
    ]);
  });

  it('keeps unmatched and uncorrelated receipts visible in transcript order', () => {
    const unmatched = receipt('r-unmatched', { toolUseId: 'call-missing' });
    const uncorrelated = receipt('r-none', { toolUseId: undefined });
    const placed = placeSafetyDenialReceipts([
      user,
      unmatched,
      streamingReply(),
      uncorrelated,
    ]);
    expect(placed.map((message) => message.id)).toEqual([
      'user-1',
      'r-unmatched',
      'assistant-1',
      'r-none',
    ]);
    expect(placed[2]).toEqual(streamingReply());
  });

  it('uses the originating turn when an invocation ID is reused before a delayed receipt', () => {
    const oldReply = streamingReply();
    const nextUser = { ...user, id: 'user-2' };
    const nextReply = { ...streamingReply(), id: 'assistant-2' };
    const placed = placeSafetyDenialReceipts([
      user,
      oldReply,
      nextUser,
      nextReply,
      receipt('delayed', { turnUserMessageId: user.id }),
    ]);
    expect(
      placed[1]?.blocks.some(
        (block) => block.type === 'approval_safety_denied_info',
      ),
    ).toBe(true);
    expect(placed[3]).toBe(nextReply);
  });

  it('does not attach a late row to an earlier turn that reused the ID', () => {
    const oldReply = streamingReply();
    const nextUser = { ...user, id: 'user-2' };
    const nextReply = { ...streamingReply(), id: 'assistant-2' };
    const placed = placeSafetyDenialReceipts([
      user,
      oldReply,
      nextUser,
      receipt('early', { turnUserMessageId: nextUser.id }),
      nextReply,
    ]);
    expect(placed[1]).toBe(oldReply);
    expect(
      placed[3]?.blocks.some(
        (block) => block.type === 'approval_safety_denied_info',
      ),
    ).toBe(true);
  });

  it('keeps a historical receipt visible when its originating turn is not loaded', () => {
    const denial = receipt('historical', {
      turnUserMessageId: 'unloaded-turn',
    });
    const placed = placeSafetyDenialReceipts([user, streamingReply(), denial]);
    expect(placed[2]).toBe(denial);
  });

  it('does not guess between subagent and root rows that reuse an invocation ID', () => {
    const child = {
      ...streamingReply(),
      id: 'child',
      parentToolUseId: 'agent-call',
    };
    const denial = receipt('ambiguous', {
      turnUserMessageId: user.id,
      subagentId: 'child-agent',
    });
    const placed = placeSafetyDenialReceipts([
      user,
      streamingReply(),
      child,
      denial,
    ]);
    expect(placed[3]).toBe(denial);
  });

  it('keeps the notice before text when the result block arrives after that text', () => {
    const reply = streamingReply();
    const [call, result, text] = reply.blocks;
    if (!call || !result || !text) throw new Error('Missing fixture blocks');
    reply.blocks = [call, text, result];
    expect(
      blockTypes(
        placeSafetyDenialReceipts([user, reply, receipt('late-result')]),
      )[1],
    ).toEqual([
      'tool_use',
      'approval_safety_denied_info',
      'text',
      'tool_result',
    ]);
  });

  it('does not move a denial past another invocation while waiting for its result', () => {
    const reply = streamingReply();
    const [call, result, text] = reply.blocks;
    if (!call || !result || !text || call.type !== 'tool_use')
      throw new Error('Missing fixture blocks');
    reply.blocks = [call, { ...call, toolUseId: 'call-2' }, result, text];
    expect(
      blockTypes(
        placeSafetyDenialReceipts([user, reply, receipt('parallel')]),
      )[1],
    ).toEqual([
      'tool_use',
      'approval_safety_denied_info',
      'tool_use',
      'tool_result',
      'text',
    ]);
  });

  it('keeps a subagent receipt visible until a child row arrives', () => {
    const denial = receipt('child-late', { subagentId: 'child' });
    const placed = placeSafetyDenialReceipts([user, streamingReply(), denial]);
    expect(placed[2]).toBe(denial);
  });

  it('selects the captured Codex child thread when item IDs repeat across threads', () => {
    const root = { ...streamingReply(), codexThreadId: 'root-thread' };
    const childA = {
      ...streamingReply(),
      id: 'child-a',
      parentBlockId: 'agent-a',
      codexThreadId: 'thread-a',
    };
    const childB = {
      ...streamingReply(),
      id: 'child-b',
      parentBlockId: 'agent-b',
      codexThreadId: 'thread-b',
    };
    const placed = placeSafetyDenialReceipts([
      user,
      root,
      childA,
      childB,
      receipt('child-denial', {
        turnUserMessageId: user.id,
        subagentId: 'thread-b',
      }),
    ]);
    expect(placed).toHaveLength(4);
    expect(placed[1]).toBe(root);
    expect(placed[2]).toBe(childA);
    expect(
      placed[3]?.blocks.some(
        (block) => block.type === 'approval_safety_denied_info',
      ),
    ).toBe(true);
  });

  it('does not borrow another Codex child thread while its own row is unloaded', () => {
    const childA = {
      ...streamingReply(),
      id: 'child-a',
      parentBlockId: 'agent-a',
      codexThreadId: 'thread-a',
    };
    const denial = receipt('child-denial', {
      turnUserMessageId: user.id,
      subagentId: 'thread-b',
    });
    expect(placeSafetyDenialReceipts([user, childA, denial])[2]).toBe(denial);
  });

  it('keeps placed message identity across recomputation', () => {
    const reply = streamingReply();
    const denial = receipt('r-1');
    const first = placeSafetyDenialReceipts([user, reply, denial]);
    const second = placeSafetyDenialReceipts([user, reply, denial]);
    expect(second[1]).toBe(first[1]);
  });
});
