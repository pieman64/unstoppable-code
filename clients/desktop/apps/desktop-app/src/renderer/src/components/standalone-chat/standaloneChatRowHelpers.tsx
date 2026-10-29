import type {
  AgentProviderType,
  StandaloneChatMeta,
} from '@canopy/desktop-shared/types';
import { ClaudeLogo } from '../ClaudeLogo';
import { CodexLogo } from '../CodexLogo';
import { getStandaloneChatDisplayLabel } from './chat-label';

/**
 * Resolve the display label for a standalone chat row. Mirrors the rail's
 * `getChatLabel`: prefers the persisted description/title, falling back to a
 * live tab title when the persisted values are placeholders.
 */
export function getStandaloneRowLabel(
  chat: StandaloneChatMeta,
  liveTitle?: string,
): string {
  return getStandaloneChatDisplayLabel({
    customTitle: chat.customTitle,
    title: chat.title,
    description: chat.description,
    liveTitle,
    fallback: 'New chat',
  });
}

/**
 * Narrow the desktop's broader {@link AgentProviderType} (which can include
 * `'ollama'`) to the shared row's `'claude' | 'codex'` union. Any non-Codex
 * provider falls through to the Claude branch.
 */
export function toStandaloneRowProvider(
  provider: AgentProviderType | undefined,
): 'claude' | 'codex' | undefined {
  if (provider === undefined) return undefined;
  if (provider === 'codex') return 'codex';
  return 'claude';
}

export const STANDALONE_CLAUDE_PROVIDER_ICON = (
  <ClaudeLogo width={12} height={12} className="shrink-0" />
);
export const STANDALONE_CODEX_PROVIDER_ICON = (
  <CodexLogo width={12} height={12} className="shrink-0" />
);
