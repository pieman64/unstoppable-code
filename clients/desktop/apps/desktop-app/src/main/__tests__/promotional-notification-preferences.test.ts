import {
  DEFAULT_PROMOTIONAL_NOTIFICATIONS,
  isPromotionalCategoryEnabled,
  normalizePromotionalNotifications,
} from '@canopy/desktop-shared/lib/promotional-notifications';

describe('normalizePromotionalNotifications', () => {
  it('defaults every toggle on', () => {
    expect(DEFAULT_PROMOTIONAL_NOTIFICATIONS).toEqual({
      enabled: true,
      arbitrary: true,
    });
    expect(normalizePromotionalNotifications(undefined, true)).toEqual(
      DEFAULT_PROMOTIONAL_NOTIFICATIONS,
    );
  });

  it('carries an existing activation opt-out into the remaining category', () => {
    // Before CAN-3013 one `activation` category gated every promotional send.
    // A user who turned it off must not be re-enrolled by the new hierarchy.
    expect(normalizePromotionalNotifications(undefined, false)).toEqual({
      enabled: true,
      arbitrary: false,
    });
  });

  it('keeps saved values and ignores the legacy category once they exist', () => {
    expect(
      normalizePromotionalNotifications(
        { enabled: false, arbitrary: false },
        false,
      ),
    ).toEqual({ enabled: false, arbitrary: false });
  });

  it('repairs a partially valid value field by field', () => {
    expect(normalizePromotionalNotifications({ enabled: 'yes' }, true)).toEqual(
      { enabled: true, arbitrary: true },
    );
  });
});

describe('isPromotionalCategoryEnabled', () => {
  it('lets the master switch off the remaining category without changing them', () => {
    const preferences = {
      enabled: false,
      arbitrary: true,
    };
    expect(isPromotionalCategoryEnabled(preferences, 'arbitrary')).toBe(false);
    // Re-enabling the master restores the user's own child choices.
    expect(preferences).toEqual({
      enabled: false,
      arbitrary: true,
    });
  });

  it('gates the remaining category while the master is on', () => {
    const preferences = {
      enabled: true,
      arbitrary: true,
    };
    expect(isPromotionalCategoryEnabled(preferences, 'arbitrary')).toBe(true);
  });
});
