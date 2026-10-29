/**
 * Entry ids reaching telemetry stay bounded: the per-project template ids
 * (CAN-3032) carry a project id, a plugin name and a prompt id, none of which
 * may leave the client.
 */

const mockStart = jest.fn();
const mockSucceed = jest.fn();
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: (...args: unknown[]): void => {
    mockStart(...args);
  },
  succeedClientOperation: (...args: unknown[]): void => {
    mockSucceed(...args);
  },
}));

import {
  telemetryEntryId,
  trackOnboardingCategoryToggle,
  trackOnboardingSuggestionCompleted,
  trackOnboardingSuggestionCtaClick,
  trackOnboardingSuggestionDismiss,
} from '../telemetry';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('telemetryEntryId', () => {
  it('collapses template entry ids to their kind and leaves other ids alone', () => {
    expect(telemetryEntryId('blueprint:marketing-1:plugin:builtin-git')).toBe(
      'blueprint:plugin',
    );
    expect(telemetryEntryId('blueprint:marketing-1:prompt:ws-1')).toBe(
      'blueprint:prompt',
    );
    expect(telemetryEntryId('plugin:universal:google')).toBe(
      'plugin:universal:google',
    );
    expect(telemetryEntryId('roles')).toBe('roles');
  });

  it('is applied to every entry-bearing event', () => {
    trackOnboardingSuggestionCtaClick(
      'blueprint:marketing-1:plugin:builtin-git',
      'plugin-add',
    );
    trackOnboardingSuggestionDismiss('blueprint:marketing-1:prompt:ws-1');
    trackOnboardingSuggestionCompleted('blueprint:marketing-1:prompt:ws-1');
    const entries = mockSucceed.mock.calls.map(
      ([, options]: [unknown, { context: { entry?: string } }]) =>
        options.context.entry,
    );
    expect(entries).toEqual([
      'blueprint:plugin',
      'blueprint:prompt',
      'blueprint:prompt',
    ]);
  });
});

describe('trackOnboardingCategoryToggle', () => {
  it('emits one bounded category_toggle action per tile toggled', () => {
    trackOnboardingCategoryToggle('designer', true, 2);
    trackOnboardingCategoryToggle('designer', false, 1);
    expect(
      mockSucceed.mock.calls.map(([name]: [unknown, unknown]) => name),
    ).toEqual([
      'canopy.home_onboarding_suggestions',
      'canopy.home_onboarding_suggestions',
    ]);
    expect(
      mockSucceed.mock.calls.map(
        ([, options]: [unknown, { context: Record<string, unknown> }]) =>
          options.context,
      ),
    ).toEqual([
      {
        action: 'category_toggle',
        role: 'designer',
        is_selected: true,
        count: 2,
      },
      {
        action: 'category_toggle',
        role: 'designer',
        is_selected: false,
        count: 1,
      },
    ]);
  });
});
