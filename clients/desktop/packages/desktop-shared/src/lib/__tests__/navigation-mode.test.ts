import { PROFILE_ROLES } from '@canopy/protocol/plugin-catalog';
import {
  isNavigationMode,
  NAVIGATION_MODES,
  navigationModeForRole,
} from '../navigation-mode';

describe('navigationModeForRole (CAN-1817)', () => {
  test('software engineering roles land in Code mode', () => {
    expect(navigationModeForRole('software-engineer')).toBe('code');
    expect(navigationModeForRole('engineering-leader')).toBe('code');
  });

  test('every other role lands in Work mode', () => {
    for (const role of PROFILE_ROLES) {
      if (role === 'software-engineer' || role === 'engineering-leader') {
        continue;
      }
      expect(navigationModeForRole(role)).toBe('work');
    }
  });

  test('no role selected defaults to Code mode', () => {
    expect(navigationModeForRole(null)).toBe('code');
    expect(navigationModeForRole(undefined)).toBe('code');
  });
});

describe('isNavigationMode', () => {
  test('accepts exactly the declared modes', () => {
    expect(NAVIGATION_MODES).toEqual(['code', 'work']);
    for (const mode of NAVIGATION_MODES) {
      expect(isNavigationMode(mode)).toBe(true);
    }
    expect(isNavigationMode('advanced')).toBe(false);
    expect(isNavigationMode('')).toBe(false);
    expect(isNavigationMode(undefined)).toBe(false);
    expect(isNavigationMode(1)).toBe(false);
  });
});
