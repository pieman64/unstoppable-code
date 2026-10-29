import {
  hasTrustedVisualToolUse,
  openTurnLedger,
} from '../visual-tool-identity';

const target = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

describe('Cursor visual tool identity', () => {
  it('scopes invocation ids to an open turn and exact chat', () => {
    const ledger = openTurnLedger(target);
    ledger.record('persisted-uuid');
    expect(hasTrustedVisualToolUse(target, 'persisted-uuid')).toBe(true);
    expect(
      hasTrustedVisualToolUse({ ...target, chatId: 'other' }, 'persisted-uuid'),
    ).toBe(false);
    ledger.forget('persisted-uuid');
    expect(hasTrustedVisualToolUse(target, 'persisted-uuid')).toBe(false);
    ledger.record('persisted-uuid');
    ledger.close();
    expect(hasTrustedVisualToolUse(target, 'persisted-uuid')).toBe(false);
  });

  it('does not let one handle close another handle for the same chat', () => {
    const first = openTurnLedger(target);
    const second = openTurnLedger(target);
    first.record('first');
    second.record('second');
    first.close();
    expect(hasTrustedVisualToolUse(target, 'first')).toBe(false);
    expect(hasTrustedVisualToolUse(target, 'second')).toBe(true);
    second.close();
  });

  it('evicts the oldest invocation id when a turn exceeds its bound', () => {
    const ledger = openTurnLedger(target);
    for (let index = 0; index <= 1_024; index++) ledger.record(`id-${index}`);
    expect(hasTrustedVisualToolUse(target, 'id-0')).toBe(false);
    expect(hasTrustedVisualToolUse(target, 'id-1024')).toBe(true);
    ledger.close();
  });
});
