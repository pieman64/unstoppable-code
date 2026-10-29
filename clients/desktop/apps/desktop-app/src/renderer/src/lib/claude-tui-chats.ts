import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  ChatInterfaceMode,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

type ClaudeChatModePreferences = Pick<
  PreferencesData,
  | 'defaultChatInterfaceMode'
  | 'defaultStandaloneChatInterfaceMode'
  | 'defaultAppAdvisorInterfaceMode'
>;
type EffectiveClaudeChatModePreferences<T extends ClaudeChatModePreferences> =
  Omit<T, keyof ClaudeChatModePreferences> & ClaudeChatModePreferences;

export function isClaudeTuiChatsEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key);
}

export function useClaudeTuiChatsEnabled(): boolean {
  return useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key),
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
  claudeTuiChatsEnabled = isClaudeTuiChatsEnabled(),
): ChatInterfaceMode {
  return claudeTuiChatsEnabled ? (mode ?? 'canopy') : 'canopy';
}

export function getPersistedClaudeChatInterfaceMode(
  mode: ChatInterfaceMode | undefined,
): ChatInterfaceMode | undefined {
  return mode === 'canopy' ? undefined : mode;
}
