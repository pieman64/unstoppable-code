import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  ChatInterfaceMode,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';

type ClaudeChatModePreferences = Pick<
  PreferencesData,
  | 'defaultChatInterfaceMode'
  | 'defaultStandaloneChatInterfaceMode'
  | 'defaultAppAdvisorInterfaceMode'
>;
type EffectiveClaudeChatModePreferences<T extends ClaudeChatModePreferences> =
  Omit<T, keyof ClaudeChatModePreferences> & ClaudeChatModePreferences;

export function isClaudeTuiChatsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
  );
}

export function getEffectiveClaudeChatModePreferences<
  T extends ClaudeChatModePreferences,
>(preferences: T): EffectiveClaudeChatModePreferences<T> {
  if (isClaudeTuiChatsEnabled()) {
    return preferences;
  }
  return {
    ...preferences,
    defaultChatInterfaceMode: 'canopy',
    defaultStandaloneChatInterfaceMode: 'canopy',
    defaultAppAdvisorInterfaceMode: 'canopy',
  };
}

export function getEffectiveClaudeChatInterfaceMode(
  mode: ChatInterfaceMode | undefined,
): ChatInterfaceMode {
  return isClaudeTuiChatsEnabled() ? (mode ?? 'canopy') : 'canopy';
}

export function getPersistedClaudeChatInterfaceMode(
  mode: ChatInterfaceMode | undefined,
): ChatInterfaceMode | undefined {
  const effectiveMode = getEffectiveClaudeChatInterfaceMode(mode);
  return effectiveMode === 'canopy' ? undefined : effectiveMode;
}
