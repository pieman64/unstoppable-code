import {
  applyOnboardingTipsUpdate,
  isOnboardingTipId,
  normalizeOnboardingTipDismissals,
  ONBOARDING_TIP_IDS,
  parseOnboardingTipsState,
  parseOnboardingTipsUpdate,
} from '../index';

describe('onboarding tips', () => {
  it('lists tips in priority order', () => {
    expect(ONBOARDING_TIP_IDS).toEqual([
      'workflows',
      'worktree-chat',
      'workflows-schedule',
    ]);
  });

  it('recognises only known tip ids', () => {
    expect(isOnboardingTipId('workflows')).toBe(true);
    expect(isOnboardingTipId('nope')).toBe(false);
    expect(isOnboardingTipId(3)).toBe(false);
  });

  it('drops unknown ids and unparseable times', () => {
    expect(
      normalizeOnboardingTipDismissals({
        workflows: '2026-10-23T10:00:00.000Z',
        'worktree-chat': 'not a date',
        retired: '2026-10-23T10:00:00.000Z',
        'workflows-schedule': 5,
      }),
    ).toEqual({ workflows: '2026-10-23T10:00:00.000Z' });
    expect(normalizeOnboardingTipDismissals(null)).toEqual({});
    expect(normalizeOnboardingTipDismissals(['workflows'])).toEqual({});
  });

  it('parses a transported state or rejects it', () => {
    expect(
      parseOnboardingTipsState({
        dismissed: { workflows: '2026-10-23T10:00:00.000Z' },
      }),
    ).toEqual({ dismissed: { workflows: '2026-10-23T10:00:00.000Z' } });
    expect(parseOnboardingTipsState({})).toBeNull();
    expect(parseOnboardingTipsState('x')).toBeNull();
  });

  it('parses update requests', () => {
    expect(parseOnboardingTipsUpdate({ action: 'reset' })).toEqual({
      action: 'reset',
    });
    expect(
      parseOnboardingTipsUpdate({ action: 'dismiss', tipId: 'workflows' }),
    ).toEqual({ action: 'dismiss', tipId: 'workflows' });
    expect(
      parseOnboardingTipsUpdate({ action: 'dismiss', tipId: 'other' }),
    ).toBeNull();
    expect(parseOnboardingTipsUpdate({ action: 'delete' })).toBeNull();
    expect(parseOnboardingTipsUpdate(null)).toBeNull();
  });

  it('dismisses once, keeping the first time, and resets everything', () => {
    const now = new Date('2026-10-23T12:00:00.000Z');
    const once = applyOnboardingTipsUpdate(
      {},
      { action: 'dismiss', tipId: 'workflows' },
      now,
    );
    expect(once).toEqual({ workflows: '2026-10-23T12:00:00.000Z' });
    const again = applyOnboardingTipsUpdate(
      once,
      { action: 'dismiss', tipId: 'workflows' },
      new Date('2026-10-24T12:00:00.000Z'),
    );
    expect(again).toBe(once);
    expect(applyOnboardingTipsUpdate(once, { action: 'reset' }, now)).toEqual(
      {},
    );
  });
});
