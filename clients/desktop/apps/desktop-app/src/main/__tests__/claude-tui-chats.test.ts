const mockIsEnabled = jest.fn<boolean, [string]>();

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: mockIsEnabled,
  })),
}));

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  getEffectiveClaudeChatInterfaceMode,
  getEffectiveClaudeChatModePreferences,
  getPersistedClaudeChatInterfaceMode,
  isClaudeTuiChatsEnabled,
} from '../lib/claude-tui-chats';

describe('claude TUI chats feature flag', () => {
  beforeEach(() => {
    mockIsEnabled.mockReset();
    mockIsEnabled.mockReturnValue(true);
  });

  it('uses the registered desktop chats flag key', () => {
    expect(isClaudeTuiChatsEnabled()).toBe(true);
    expect(mockIsEnabled).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
    );
  });

  it('preserves saved chat mode preferences while the flag is enabled', () => {
    const preferences = {
      defaultChatInterfaceMode: 'claude-code' as const,
      defaultStandaloneChatInterfaceMode: 'auto' as const,
      defaultAppAdvisorInterfaceMode: 'claude-code' as const,
    };

    expect(getEffectiveClaudeChatModePreferences(preferences)).toBe(
      preferences,
    );
    expect(getEffectiveClaudeChatInterfaceMode('auto')).toBe('auto');
    expect(getPersistedClaudeChatInterfaceMode('claude-code')).toBe(
      'claude-code',
    );
  });

  it('overrides saved terminal chat modes to canopy while the flag is disabled', () => {
    mockIsEnabled.mockReturnValue(false);
    const preferences = {
      defaultChatInterfaceMode: 'claude-code' as const,
      defaultStandaloneChatInterfaceMode: 'auto' as const,
      defaultAppAdvisorInterfaceMode: 'claude-code' as const,
    };

    expect(getEffectiveClaudeChatModePreferences(preferences)).toEqual({
      defaultChatInterfaceMode: 'canopy',
      defaultStandaloneChatInterfaceMode: 'canopy',
      defaultAppAdvisorInterfaceMode: 'canopy',
    });
    expect(getEffectiveClaudeChatInterfaceMode('auto')).toBe('canopy');
    expect(getPersistedClaudeChatInterfaceMode('claude-code')).toBeUndefined();
    expect(preferences).toEqual({
      defaultChatInterfaceMode: 'claude-code',
      defaultStandaloneChatInterfaceMode: 'auto',
      defaultAppAdvisorInterfaceMode: 'claude-code',
    });
  });
});
