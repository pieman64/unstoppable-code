import { actionTypingBudgetMs } from '../typing-budget';

describe('lane typing budget (D9a)', () => {
  it('adds the type character and delay budget', () => {
    expect(
      actionTypingBudgetMs({ kind: 'type', text: 'abcd', delayMs: 500 }),
    ).toBe(2060);
  });
  it('allows up to 4000 fill characters for typed fallback', () => {
    expect(
      actionTypingBudgetMs({ kind: 'fill', ref: 'r', text: 'x'.repeat(4000) }),
    ).toBe(60000);
    expect(
      actionTypingBudgetMs({ kind: 'fill', ref: 'r', text: 'x'.repeat(4001) }),
    ).toBe(0);
    expect(actionTypingBudgetMs({ kind: 'fill', ref: 'r', text: '' })).toBe(0);
  });
  it('adds combobox search typing to the lane deadline', () => {
    expect(
      actionTypingBudgetMs({
        kind: 'select_option',
        ref: 'r',
        labels: ['Amber'],
        searchText: 'amber',
      }),
    ).toBe(75);
    expect(
      actionTypingBudgetMs({
        kind: 'select_option',
        ref: 'r',
        labels: ['Amber'],
      }),
    ).toBe(0);
  });
  it('does not extend other actions', () => {
    expect(actionTypingBudgetMs({ kind: 'click', ref: 'r' })).toBe(0);
  });
});
