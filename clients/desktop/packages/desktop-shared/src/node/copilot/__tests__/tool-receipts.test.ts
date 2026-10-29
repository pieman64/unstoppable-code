import type { SessionEvent } from '@github/copilot-sdk';
import {
  copilotReceiptText,
  CopilotMcpApprovals,
  CopilotToolReceipts,
} from '../tool-receipts';

type Completion = Extract<SessionEvent, { type: 'tool.execution_complete' }>;
function completion(
  id = 'native',
  text = 'accepted',
  data: Partial<Completion['data']> = {},
): Completion {
  return {
    id: `event-${id}`,
    type: 'tool.execution_complete',
    parentId: null,
    timestamp: '2026-10-12T00:00:00Z',
    data: {
      toolCallId: id,
      success: true,
      result: {
        content: text,
        detailedContent: text,
        contents: [{ type: 'text', text }],
      },
      ...data,
    },
  };
}

describe('Copilot native MCP approvals', () => {
  it('rejects concurrent identical calls before reverse HTTP arrival can swap native receipts', () => {
    const approvals = new CopilotMcpApprovals();
    const receipts = new CopilotToolReceipts();
    expect(
      approvals.approve('first-native', 'host', 'load', { ref: 'skill' }),
    ).toBe(true);
    expect(
      approvals.approve('second-native', 'host', 'load', { ref: 'skill' }),
    ).toBe(false);
    const nativeId = approvals.take('host', 'load', { ref: 'skill' });
    expect(nativeId).toBe('first-native');
    if (!nativeId) throw new Error('First approved call lost its identity');
    receipts.expect(nativeId, 'first-http', 'accepted');
    expect(receipts.observe(completion('first-native'))).toBe('first-http');
    expect(receipts.observe(completion('second-native'))).toBeUndefined();
  });
  it('retains distinct native ids for serial calls and consumes each once', () => {
    const approvals = new CopilotMcpApprovals();
    expect(approvals.approve('a', 'host', 'load', { x: 1, y: 2 })).toBe(true);
    expect(approvals.take('host', 'load', { x: 2, y: 2 })).toBeUndefined();
    expect(approvals.take('host', 'other', { x: 1, y: 2 })).toBeUndefined();
    expect(approvals.take('other', 'load', { x: 1, y: 2 })).toBeUndefined();
    expect(approvals.take('host', 'load', { x: 1, y: 2 })).toBe('a');
    expect(approvals.approve('b', 'host', 'load', { y: 2, x: 1 })).toBe(true);
    expect(approvals.take('host', 'load', { x: 1, y: 2 })).toBe('b');
    expect(approvals.take('host', 'load', { x: 1, y: 2 })).toBeUndefined();
    expect(approvals.approve('a', 'host', 'load', {})).toBe(false);
  });
  it('bounds pending approvals across distinct arguments', () => {
    const approvals = new CopilotMcpApprovals();
    for (let i = 0; i < 1024; i++)
      expect(approvals.approve(`${i}`, 'host', 'load', { i })).toBe(true);
    expect(approvals.approve('overflow', 'host', 'load', {})).toBe(false);
    expect(approvals.take('host', 'load', { i: 0 })).toBe('0');
    expect(approvals.approve('after-consume', 'host', 'load', {})).toBe(true);
  });
});

describe('Copilot result receipts', () => {
  it('acknowledges only the exact successful native receipt, once', () => {
    const receipts = new CopilotToolReceipts();
    expect(receipts.expect('native', 'host:rpc', 'accepted')).toBe(true);
    expect(receipts.observe(completion('other'))).toBeUndefined();
    expect(receipts.observe(completion())).toBe('host:rpc');
    expect(receipts.observe(completion())).toBeUndefined();
    expect(receipts.expect('native', 'again', 'accepted')).toBe(false);
  });
  it.each([
    ['failed', completion('native', 'accepted', { success: false })],
    ['wrong text', completion('native', 'different')],
    ['missing result', completion('native', 'accepted', { result: undefined })],
    [
      'no structured receipt',
      completion('native', 'accepted', { result: { content: 'accepted' } }),
    ],
    [
      'wrong detailed content',
      completion('native', 'accepted', {
        result: {
          content: 'accepted',
          detailedContent: 'other',
          contents: [{ type: 'text', text: 'accepted' }],
        },
      }),
    ],
    [
      'wrong structured content',
      completion('native', 'accepted', {
        result: {
          content: 'accepted',
          contents: [{ type: 'text', text: 'other' }],
        },
      }),
    ],
    [
      'multiple contents',
      completion('native', 'accepted', {
        result: {
          content: 'accepted',
          contents: [
            { type: 'text', text: 'accepted' },
            { type: 'text', text: 'extra' },
          ],
        },
      }),
    ],
  ])('rejects %s and never accepts a later replacement', (_name, event) => {
    const receipts = new CopilotToolReceipts();
    receipts.expect('native', 'host:rpc', 'accepted');
    expect(receipts.observe(event)).toBeUndefined();
    expect(receipts.observe(completion())).toBeUndefined();
  });
  it('does not accept a receipt observed before the host result', () => {
    const receipts = new CopilotToolReceipts();
    expect(receipts.observe(completion())).toBeUndefined();
    expect(receipts.expect('native', 'host:rpc', 'accepted')).toBe(false);
  });
  it('ignores both current and legacy native subagent completions', () => {
    const receipts = new CopilotToolReceipts();
    receipts.expect('native', 'host:rpc', 'accepted');
    expect(
      receipts.observe({ ...completion(), agentId: 'child' }),
    ).toBeUndefined();
    expect(
      receipts.observe(
        completion('native', 'accepted', { parentToolCallId: 'parent' }),
      ),
    ).toBeUndefined();
    expect(receipts.observe(completion())).toBe('host:rpc');
  });
  it('invalidates ambiguous duplicate attribution', () => {
    const receipts = new CopilotToolReceipts();
    expect(receipts.expect('native', 'one', 'accepted')).toBe(true);
    expect(receipts.expect('native', 'two', 'accepted')).toBe(false);
    expect(receipts.observe(completion())).toBeUndefined();
  });
  it('cannot acknowledge a cancelled or obsolete turn', () => {
    const receipts = new CopilotToolReceipts();
    receipts.expect('native', 'host:rpc', 'accepted');
    receipts.close();
    expect(receipts.observe(completion())).toBeUndefined();
    expect(receipts.expect('next', 'host:rpc', 'accepted')).toBe(false);
  });
  it('bounds response size and pending receipts', () => {
    const receipts = new CopilotToolReceipts();
    expect(receipts.expect('huge', 'host:rpc', 'é'.repeat(1024 * 1024))).toBe(
      false,
    );
    for (let i = 0; i < 1024; i++)
      expect(receipts.expect(`${i}`, `host:${i}`, 'accepted')).toBe(true);
    expect(receipts.expect('overflow', 'host:rpc', 'accepted')).toBe(false);
  });
});

describe('Copilot host result parsing', () => {
  it('extracts one successful MCP text block', () => {
    expect(
      copilotReceiptText({ content: [{ type: 'text', text: 'accepted' }] }),
    ).toBe('accepted');
  });
  it.each([
    null,
    {},
    { isError: true, content: [{ type: 'text', text: 'accepted' }] },
    { content: [{ type: 'image', data: 'a' }] },
    {
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    },
  ])(
    'does not acknowledge an ambiguous or failed host result (%p)',
    (value) => {
      expect(copilotReceiptText(value)).toBeUndefined();
    },
  );
});
