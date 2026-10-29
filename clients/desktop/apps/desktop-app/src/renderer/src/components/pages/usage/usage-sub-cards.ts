import type {
  AgentProviderType,
  ProviderRateLimitSnapshot,
} from '@canopy/desktop-shared/types';
import {
  buildProviderUsageWindows,
  type ProviderUsageWindow,
} from '@canopy/desktop-shared/lib/provider-usage-windows';

export type LimitSubCard = ProviderUsageWindow;

/**
 * The desktop shows Claude Extra usage as its limit and remaining balance
 * only. The observability summary also keeps the provider-reported spend for
 * Remote Control clients, so drop it here to keep these cards unchanged.
 */
function withoutClaudeSpend(card: LimitSubCard): LimitSubCard {
  if (card.credits?.usedUsd === undefined) {
    return card;
  }
  const credits = { ...card.credits };
  delete credits.usedUsd;
  return { ...card, credits };
}

export function buildSubCards(
  provider: AgentProviderType,
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
): LimitSubCard[] {
  const cards = buildProviderUsageWindows(provider, rateLimits);
  return provider === 'claude' ? cards.map(withoutClaudeSpend) : cards;
}
