import {
  approvalSafetyDeniedInfoSchema,
  type ApprovalSafetyDeniedInfo,
} from '@canopy/protocol/approvals';
import { isPersistedChatMessage } from '../persisted-chat-message-validation';

const receipt: ApprovalSafetyDeniedInfo = {
  type: 'approval_safety_denied_info',
  receiptId: 'receipt-1',
  timestamp: 42,
  reason: 'force-push',
  command: 'git push --force origin HEAD',
  mode: 'ask',
  toolUseId: 'tool-1',
  subagentId: 'child-1',
  turnUserMessageId: 'user-1',
};

function isPersistedChatBlock(block: unknown): boolean {
  return isPersistedChatMessage({
    id: 'test',
    role: 'system',
    timestamp: 1,
    blocks: [block],
  });
}

describe('safety denial persisted contract', () => {
  it.each([
    'force-push',
    'destructive-delete',
    'disk-write',
    'unverifiable-command',
  ] as const)('round trips %s through persisted history', (reason) => {
    const value: unknown = JSON.parse(
      JSON.stringify({
        id: receipt.receiptId,
        role: 'system',
        timestamp: 42,
        blocks: [{ ...receipt, reason }],
      }),
    );
    expect(isPersistedChatMessage(value)).toBe(true);
    expect(
      approvalSafetyDeniedInfoSchema.safeParse({
        ...receipt,
        reason,
        mode: 'auto',
      }).success,
    ).toBe(true);
  });

  it.each([
    { reason: 'unknown' },
    { timestamp: NaN },
    { timestamp: Infinity },
    { timestamp: '42' },
    { mode: 'full-access' },
    { command: 'x'.repeat(4001) },
    { command: null },
    { receiptId: '' },
    { receiptId: 1 },
    { receiptId: 'x'.repeat(513) },
    { toolUseId: 1 },
    { toolUseId: '' },
    { subagentId: null },
    { subagentId: 'x'.repeat(513) },
    { turnUserMessageId: [] },
  ])('rejects malformed metadata %p', (patch) => {
    const value = { ...receipt, ...patch };
    expect(isPersistedChatBlock(value)).toBe(false);
    expect(approvalSafetyDeniedInfoSchema.safeParse(value).success).toBe(false);
  });

  it('keeps older history and unknown block validation behavior', () => {
    expect(
      isPersistedChatMessage({
        id: 'old',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'hello' }],
      }),
    ).toBe(true);
    expect(isPersistedChatBlock({ type: 'future-block', timestamp: 1 })).toBe(
      false,
    );
    expect(
      isPersistedChatBlock({
        ...receipt,
        command: 'x'.repeat(4000),
        toolUseId: undefined,
        subagentId: undefined,
        turnUserMessageId: undefined,
      }),
    ).toBe(true);
  });
});
