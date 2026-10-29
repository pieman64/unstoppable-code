import {
  OPERATIONAL_STATUS_COLORS,
  SIDEBAR_INDICATOR_BLUE,
  SIDEBAR_INDICATOR_COLORS,
} from '../operational-status-colors';

describe('OPERATIONAL_STATUS_COLORS', () => {
  it('maps each run state onto its intent role', () => {
    expect(OPERATIONAL_STATUS_COLORS.unread.foreground).toBe('fg-info');
    expect(OPERATIONAL_STATUS_COLORS.active.foreground).toBe('fg-info');
    expect(OPERATIONAL_STATUS_COLORS.failed.foreground).toBe(
      'fg-destructive-strong',
    );
    expect(OPERATIONAL_STATUS_COLORS.success.foreground).toBe(
      'fg-success-strong',
    );
    expect(OPERATIONAL_STATUS_COLORS.merged.foreground).toBe(
      'fg-special-strong',
    );
    expect(OPERATIONAL_STATUS_COLORS.paused.foreground).toBe('fg-secondary');
  });

  it('fills dots with the ink and tints with the intent subtle surface', () => {
    expect(OPERATIONAL_STATUS_COLORS.failed.background).toBe(
      'bg-fg-destructive-strong',
    );
    expect(OPERATIONAL_STATUS_COLORS.failed.backgroundSubtle).toBe(
      'bg-destructive-subtle',
    );
    expect(OPERATIONAL_STATUS_COLORS.merged.backgroundSubtle).toBe(
      'bg-special-subtle',
    );
    expect(OPERATIONAL_STATUS_COLORS.unread.backgroundSubtle).toBe(
      'bg-info-subtle',
    );
  });

  it('keeps no operational role of its own', () => {
    const classes = Object.values(OPERATIONAL_STATUS_COLORS).flatMap((tone) =>
      Object.values(tone),
    );
    expect(classes.filter((value) => value.includes('status-'))).toEqual([]);
  });

  it('exposes the generic hue roles for sidebar indicators', () => {
    expect(SIDEBAR_INDICATOR_COLORS).toEqual({
      blue: 'fg-blue',
      destructive: 'fg-destructive',
      success: 'fg-success',
      purple: 'fg-purple',
      warning: 'fg-warning',
      neutral: 'fg-quaternary',
    });
    expect(SIDEBAR_INDICATOR_BLUE).toEqual({
      foreground: 'fg-blue',
      background: 'bg-fg-blue',
    });
  });
});
