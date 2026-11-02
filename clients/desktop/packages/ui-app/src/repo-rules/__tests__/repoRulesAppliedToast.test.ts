import { repoRulesAppliedToastCopy } from '../repoRulesAppliedToast';

describe('repoRulesAppliedToastCopy', () => {
  it('names one rule in the singular', () => {
    expect(
      repoRulesAppliedToastCopy({ status: { enabled: true }, ruleCount: 1 }),
    ).toEqual({
      title: 'Cursor rules on',
      message: '1 rule applies to new chats.',
    });
  });

  it('names several rules in the plural', () => {
    expect(
      repoRulesAppliedToastCopy({ status: { enabled: true }, ruleCount: 2 }),
    ).toEqual({
      title: 'Cursor rules on',
      message: '2 rules apply to new chats.',
    });
  });

  it('reports zero rules accurately', () => {
    expect(
      repoRulesAppliedToastCopy({ status: { enabled: true }, ruleCount: 0 })
        .message,
    ).toBe('0 rules apply to new chats.');
  });

  it('uses the off copy whenever rules are off, whatever the count', () => {
    const off = {
      title: 'Cursor rules off',
      message: "New chats won't use this project's Cursor rules.",
    };
    expect(
      repoRulesAppliedToastCopy({ status: { enabled: false }, ruleCount: 0 }),
    ).toEqual(off);
    expect(
      repoRulesAppliedToastCopy({ status: { enabled: false }, ruleCount: 3 }),
    ).toEqual(off);
  });
});
