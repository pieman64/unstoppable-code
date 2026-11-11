import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  type CanopyInjectedToolSurface,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { getFeatureFlagService } from '../feature-flags';

/** Read the live desktop kill switch, including changes during an active turn. */
export function isChatVisualsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key,
  );
}

export interface ChatVisualsEligibility {
  providerType?: string;
  surface: CanopyInjectedToolSurface | 'codex-worktree' | 'codex-cowork';
  key?: 'show_visual' | 'preview_visual';
  assistantMode?: 'default' | 'app-advisor' | 'pipeline-editor';
}

/** Intersect the flag, assistant mode, surface, and provider trust boundary. */
export function chatVisualsEligible({
  providerType,
  surface,
  assistantMode,
  key = 'show_visual',
}: ChatVisualsEligibility): boolean {
  if (
    !isChatVisualsEnabled() ||
    (assistantMode !== undefined && assistantMode !== 'default')
  )
    return false;
  if (surface === 'codex-worktree' || surface === 'codex-cowork')
    return providerType === 'codex';
  if (!CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(key))
    return false;
  if (surface === 'native-sdk' || surface === 'native-sdk-standalone')
    return providerType === 'claude';
  if (surface === 'cursor-acp' || surface === 'cursor-acp-standalone')
    return providerType === 'cursor';
  if (surface === 'opencode-acp' || surface === 'opencode-acp-standalone')
    return providerType === 'opencode';
  return false;
}

/**
 * Whether a default-mode chat prompt describes ShowVisual: the same answer
 * as advertisement for the provider's own surface in that workspace kind.
 */
export function chatVisualsPromptEligible(
  providerType: string | undefined,
  workspace: 'worktree' | 'cowork',
): boolean {
  const cowork = workspace === 'cowork';
  const surface =
    providerType === 'codex'
      ? cowork
        ? 'codex-cowork'
        : 'codex-worktree'
      : providerType === 'cursor'
        ? cowork
          ? 'cursor-acp-standalone'
          : 'cursor-acp'
        : providerType === 'opencode'
          ? cowork
            ? 'opencode-acp-standalone'
            : 'opencode-acp'
          : cowork
            ? 'native-sdk-standalone'
            : 'native-sdk';
  return chatVisualsEligible({ providerType, surface });
}
