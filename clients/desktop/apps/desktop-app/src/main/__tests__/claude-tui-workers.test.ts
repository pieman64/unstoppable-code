const mockIsEnabled = jest.fn<boolean, [string]>();

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: mockIsEnabled,
  })),
}));

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  getEffectiveClaudeWorkerConcurrencyLimit,
  getEffectiveClaudeWorkerModePreferences,
  isClaudeTuiWorkersEnabled,
} from '../lib/claude-tui-workers';

describe('claude TUI workers feature flag', () => {
  beforeEach(() => {
    mockIsEnabled.mockReset();
    mockIsEnabled.mockReturnValue(true);
  });

  it('uses the registered desktop workers flag key', () => {
    expect(isClaudeTuiWorkersEnabled()).toBe(true);
    expect(mockIsEnabled).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
    );
  });

  it('preserves saved worker preferences while the flag is enabled', () => {
    const preferences = {
      canopyBackgroundProcessesMode: 'terminal' as const,
      pipelinesMode: 'terminal' as const,
    };

    expect(getEffectiveClaudeWorkerModePreferences(preferences)).toBe(
      preferences,
    );
  });

  it('overrides saved terminal worker modes to canopy while the flag is disabled', () => {
    mockIsEnabled.mockReturnValue(false);
    const preferences = {
      canopyBackgroundProcessesMode: 'terminal' as const,
      pipelinesMode: 'terminal' as const,
    };

    expect(getEffectiveClaudeWorkerModePreferences(preferences)).toEqual({
      canopyBackgroundProcessesMode: 'canopy',
      pipelinesMode: 'canopy',
    });
    expect(preferences).toEqual({
      canopyBackgroundProcessesMode: 'terminal',
      pipelinesMode: 'terminal',
    });
  });

  it('blocks queued worker launches while the flag is disabled', () => {
    mockIsEnabled.mockReturnValue(false);

    expect(
      getEffectiveClaudeWorkerConcurrencyLimit({ workerConcurrencyLimit: 16 }),
    ).toBe(0);
  });
});
