import { readAuditTrailProviderFilter } from '../lib/auditTrailFilters';

describe('readAuditTrailProviderFilter', () => {
  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['ollama', 'ollama'],
    ['unexpected', 'all'],
  ] as const)('maps %s to %s', (value, expected) => {
    expect(readAuditTrailProviderFilter(value)).toBe(expected);
  });
});
