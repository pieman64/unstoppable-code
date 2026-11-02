// Shared effort-control helpers and permanent provider-only legacy fallbacks.
// Model-aware callers resolve canonical levels through the protocol clamp.

import {
  THINKING_LEVEL_LABELS,
  advanceThinkingLevel,
  normalizeThinkingForUi,
  providerFallbackThinkingLevels,
  type ThinkingLevel,
  type ThinkingUiLevel,
} from '@canopy/protocol/thinking';

/**
 * Legacy provider-only UI level type. Model-aware callers use ThinkingLevel
 * and the model's canonical capability set, including a declared Low tier.
 */
export type { ThinkingUiLevel as ChatThinkingUiLevel };

/**
 * Provider hint accepted by {@link getChatThinkingCycle}.
 *
 * The desktop store stores its provider as `'claude' | 'codex' | 'ollama'`
 * (Ollama internally reuses the Claude cycle), and the portal's wire contract
 * narrows that to `'claude' | 'codex'`. Both shapes share the
 * `'claude' | 'codex'` discriminator, so the helper accepts a free-form
 * string and only branches on the Codex value. Unknown / missing providers
 * fall through to the Claude cycle, which is the historical default.
 */
export type ChatThinkingProviderHint = string | undefined;

/**
 * Return the canonical UI cycle of thinking levels for the given provider.
 *
 * - Claude / Ollama / unknown: `off → medium → high → xhigh → max → off`
 * - Codex provider-level cycle: `off → medium → high → xhigh → off`
 */
export function getChatThinkingCycle(
  providerType: ChatThinkingProviderHint,
): readonly ThinkingUiLevel[] {
  return providerFallbackThinkingLevels(providerType).filter(
    (level): level is ThinkingUiLevel => level !== 'low',
  );
}

/**
 * Advance the cycle by one step. If `current` is not present in the cycle for
 * the active provider (e.g. a model-specific Codex `max`), the helper picks
 * the first cycle entry so the next press always lands on a defined value.
 */
export function advanceChatThinkingLevel(
  current: ThinkingUiLevel,
  providerType: ChatThinkingProviderHint,
): ThinkingUiLevel {
  return normalizeThinkingForUi(
    advanceThinkingLevel(current, providerFallbackThinkingLevels(providerType)),
  );
}

// Shared by the desktop panel, Portal capsule and compact overflow cycle.
export function thinkingLevelLabel(
  level: ThinkingLevel | undefined,
  includeLow: boolean,
): string {
  return level === undefined
    ? 'Default'
    : level === 'low' && includeLow
      ? 'Low'
      : THINKING_LEVEL_LABELS[normalizeThinkingForUi(level)];
}

export function thinkingControlLevels(
  supportedLevels: readonly ThinkingLevel[],
  includeLow: boolean,
): readonly ThinkingLevel[] {
  return includeLow
    ? supportedLevels
    : supportedLevels.filter(
        (level): level is ThinkingUiLevel => level !== 'low',
      );
}

export function advanceThinkingControlLevel(
  value: ThinkingLevel,
  supportedLevels: readonly ThinkingLevel[],
  includeLow: boolean,
): ThinkingLevel {
  if (!includeLow) return advanceThinkingLevel(value, supportedLevels);
  const index = supportedLevels.indexOf(value);
  if (supportedLevels.length === 0) return 'off';
  if (index < 0) return supportedLevels[0] ?? 'off';
  return supportedLevels[(index + 1) % supportedLevels.length] ?? 'off';
}
