import {
  isClaudeTuiChatsEnabled,
  useClaudeTuiChatsEnabled,
} from './claude-tui-chats';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

interface ClaudeSettingsAvailabilityInput {
  platform: NodeJS.Platform;
  claudeTuiChatsEnabled: boolean;
  claudeTuiWorkersEnabled: boolean;
}

export function hasVisibleClaudeSettingsSections(
  input: ClaudeSettingsAvailabilityInput,
): boolean {
  void input;
  // Chat turn limits are available on every platform, independently of terminal flags.
  return true;
}

export function isClaudeTuiWorkersEnabledInRenderer(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key);
}

export function useClaudeTuiWorkersEnabledInRenderer(): boolean {
  return useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key),
  );
}

export function isClaudeSettingsAvailable(
  platform: NodeJS.Platform = window.platform,
): boolean {
  return hasVisibleClaudeSettingsSections({
    platform,
    claudeTuiChatsEnabled: isClaudeTuiChatsEnabled(),
    claudeTuiWorkersEnabled: isClaudeTuiWorkersEnabledInRenderer(),
  });
}

export function useClaudeSettingsAvailable(
  platform: NodeJS.Platform = window.platform,
): boolean {
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const claudeTuiWorkersEnabled = useClaudeTuiWorkersEnabledInRenderer();
  return hasVisibleClaudeSettingsSections({
    platform,
    claudeTuiChatsEnabled,
    claudeTuiWorkersEnabled,
  });
}
