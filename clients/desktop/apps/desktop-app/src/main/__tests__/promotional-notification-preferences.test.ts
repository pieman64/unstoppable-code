import {
  DEFAULT_PROMOTIONAL_NOTIFICATIONS,
  isPromotionalCategoryEnabled,
  normalizePromotionalNotifications,
} from '@canopy/desktop-shared/lib/promotional-notifications';

describe('normalizePromotionalNotifications', () => {
  it('defaults every toggle on', () => {
    expect(DEFAULT_PROMOTIONAL_NOTIFICATIONS).toEqual({
      enabled: true,
      gettingStarted: true,
      arbitrary: true,
    });
    expect(normalizePromotionalNotifications(undefined, true)).toEqual(
      DEFAULT_PROMOTIONAL_NOTIFICATIONS,
    );
  });

  it('carries an existing Getting Started opt-out into both children', () => {
    // Before CAN-3013 one `activation` category gated every promotional send.
    // A user who turned it off must not be re-enrolled by the new hierarchy.
    expect(normalizePromotionalNotifications(undefined, false)).toEqual({
      enabled: true,
      gettingStarted: false,
      arbitrary: false,
    });
  });

  it('keeps saved values and ignores the legacy category once they exist', () => {
    expect(
      normalizePromotionalNotifications(
        { enabled: false, gettingStarted: true, arbitrary: false },
        false,
      ),
    ).toEqual({ enabled: false, gettingStarted: true, arbitrary: false });
  });

  it('repairs a partially valid value field by field', () => {
    expect(
      normalizePromotionalNotifications(
        { enabled: 'yes', gettingStarted: false },
        true,
      ),
    ).toEqual({ enabled: true, gettingStarted: false, arbitrary: true });
  });
});

describe('isPromotionalCategoryEnabled', () => {
  it('lets the master switch off both children without changing them', () => {
    const preferences = {
      enabled: false,
      gettingStarted: true,
      arbitrary: true,
    };
    expect(isPromotionalCategoryEnabled(preferences, 'gettingStarted')).toBe(
      false,
    );
    expect(isPromotionalCategoryEnabled(preferences, 'arbitrary')).toBe(false);
    // Re-enabling the master restores the user's own child choices.
    expect(preferences).toEqual({
      enabled: false,
      gettingStarted: true,
      arbitrary: true,
    });
  });

  it('gates each child independently while the master is on', () => {
    const preferences = {
      enabled: true,
      gettingStarted: false,
      arbitrary: true,
    };
    expect(isPromotionalCategoryEnabled(preferences, 'gettingStarted')).toBe(
      false,
    );
    expect(isPromotionalCategoryEnabled(preferences, 'arbitrary')).toBe(true);
  });
});
