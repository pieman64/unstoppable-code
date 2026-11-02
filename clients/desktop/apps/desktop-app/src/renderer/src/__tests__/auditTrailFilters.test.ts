import { auditTrailProviderSelection } from '../lib/auditTrailFilters';

describe('auditTrailProviderSelection', () => {
  it.each([
    ['claude', ['claude']],
    ['codex', ['codex']],
    ['ollama', ['ollama']],
    ['all', []],
    [undefined, []],
  ] as const)('picks %s as %j', (value, expected) => {
    expect(auditTrailProviderSelection(value)).toEqual(expected);
  });
});
