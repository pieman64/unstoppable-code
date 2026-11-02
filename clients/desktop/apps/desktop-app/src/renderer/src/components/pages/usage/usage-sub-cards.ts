import type {
  AgentProviderType,
  ProviderRateLimitSnapshot,
} from '@canopy/desktop-shared/types';
import {
  buildProviderUsageWindows,
  type ProviderUsageWindow,
} from '@canopy/desktop-shared/lib/provider-usage-windows';

export type LimitSubCard = ProviderUsageWindow;

export function buildSubCards(
  provider: AgentProviderType,
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
): LimitSubCard[] {
  return buildProviderUsageWindows(provider, rateLimits);
}
