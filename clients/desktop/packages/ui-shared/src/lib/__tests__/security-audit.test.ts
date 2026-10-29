import { parseSecurityAudit } from '../security-audit';

describe('parseSecurityAudit', () => {
  it('accepts the risk levels the audit endpoint emits', () => {
    for (const level of [
      'safe',
      'low',
      'medium',
      'high',
      'critical',
      'unknown',
    ] as const) {
      expect(parseSecurityAudit({ level, socketAlerts: 0 })).toEqual({
        level,
        socketAlerts: 0,
      });
    }
  });

  it('reads a missing alert count as null', () => {
    expect(parseSecurityAudit({ level: 'safe' })).toEqual({
      level: 'safe',
      socketAlerts: null,
    });
    expect(parseSecurityAudit({ level: 'safe', socketAlerts: null })).toEqual({
      level: 'safe',
      socketAlerts: null,
    });
  });

  it.each([
    undefined,
    null,
    'safe',
    { level: 'SAFE' },
    { level: 'green', socketAlerts: 0 },
    { level: 'safe', socketAlerts: '0' },
    { level: 'safe', socketAlerts: -1 },
    { level: 'safe', socketAlerts: 1.5 },
    ['safe'],
  ])('rejects %p', (value) => {
    expect(parseSecurityAudit(value)).toBeNull();
  });
});
