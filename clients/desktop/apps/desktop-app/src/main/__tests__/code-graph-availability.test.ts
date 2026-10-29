const mockIsEnabled = jest.fn();

jest.mock('../feature-flags', (): object => ({
  getFeatureFlagService: () => ({ isEnabled: mockIsEnabled }),
}));

import {
  getCodeGraphGenerationTimeoutMinutes,
  getCodeGraphGenerationTimeoutMs,
  isCodeGraphAvailableForWorkspace,
  isCodeGraphPreferenceEnabledForWorkspace,
  resetCodeGraphAvailabilityForTests,
  setCodeGraphPreferences,
} from '../lib/code-graph-availability';

describe('Code Graph availability', () => {
  beforeEach(() => {
    resetCodeGraphAvailabilityForTests();
    mockIsEnabled.mockReturnValue(true);
  });

  it('uses the backward-compatible enabled/30-minute default', () => {
    expect(isCodeGraphAvailableForWorkspace('workspace-a')).toBe(true);
    expect(getCodeGraphGenerationTimeoutMinutes()).toBe(30);
    expect(getCodeGraphGenerationTimeoutMs()).toBe(30 * 60_000);
  });

  it('applies all preference modes per project', () => {
    setCodeGraphPreferences({
      mode: 'disabled',
      selectedWorkspaceIds: [],
      generationTimeoutMinutes: 30,
    });
    expect(isCodeGraphPreferenceEnabledForWorkspace('workspace-a')).toBe(false);

    setCodeGraphPreferences({
      mode: 'selected-workspaces',
      selectedWorkspaceIds: ['workspace-a'],
      generationTimeoutMinutes: 90,
    });
    expect(isCodeGraphAvailableForWorkspace('workspace-a')).toBe(true);
    expect(isCodeGraphAvailableForWorkspace('workspace-b')).toBe(false);
    expect(getCodeGraphGenerationTimeoutMinutes()).toBe(90);

    setCodeGraphPreferences({
      mode: 'enabled',
      selectedWorkspaceIds: [],
      generationTimeoutMinutes: 30,
    });
    expect(isCodeGraphAvailableForWorkspace('workspace-b')).toBe(true);
  });

  it('treats the feature flag as a hard kill switch without changing preferences', () => {
    setCodeGraphPreferences({
      mode: 'selected-workspaces',
      selectedWorkspaceIds: ['workspace-a'],
      generationTimeoutMinutes: 75,
    });
    mockIsEnabled.mockReturnValue(false);
    expect(isCodeGraphAvailableForWorkspace('workspace-a')).toBe(false);
    expect(getCodeGraphGenerationTimeoutMinutes()).toBe(75);
    mockIsEnabled.mockReturnValue(true);
    expect(isCodeGraphAvailableForWorkspace('workspace-a')).toBe(true);
  });
});
