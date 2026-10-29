// Permanent legacy-host fallback for chat composers whose model catalog does
// not declare supported thinking levels. Model-aware controls consume the
// protocol helpers directly.

import {
  advanceThinkingLevel,
  normalizeThinkingForUi,
  providerFallbackThinkingLevels,
  type ThinkingUiLevel,
} from '@canopy/protocol/thinking';

/**
 * UI-selectable thinking levels (canonical `low` is hidden from the UI).
 * `ultra` is a per-model tier configured in the desktop model registry; it
 * can appear in projected desktop state but is not part of the provider-level
 * portal cycles below (the portal has no per-model support data, so cycling
 * from an `ultra` value falls back to the first cycle entry — the same
 * behavior a Codex-persisted `max` has always had).
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
