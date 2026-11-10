import type { AppAdvisorJson } from '../types';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';
import { fuzzyMatchText } from './app-advisor-chat-reads';

/** One marketplace as App Advisor's plugin marketplace actions answer it. */
export interface MarketplaceAdvisorRow {
  [key: string]: AppAdvisorJson;
  id: string;
  name: string;
  sourceType: string;
  sourceUrl: string;
  pluginCount: number;
  validProviders: string[];
  claudeState: string;
  codexState: string;
  claudeError: string;
  codexError: string;
}

export function marketplaceSummary(
  marketplace: MarketplaceInfo,
): MarketplaceAdvisorRow {
  return {
    id: marketplace.id,
    name: marketplace.name,
    sourceType: marketplace.sourceType,
    sourceUrl: marketplace.sourceUrl,
    pluginCount: marketplace.pluginCount,
    validProviders: marketplace.validProviders,
    claudeState: marketplace.providerStatus.claude.state,
    codexState: marketplace.providerStatus.codex.state,
    claudeError: marketplace.providerStatus.claude.error ?? '',
    codexError: marketplace.providerStatus.codex.error ?? '',
  };
}

export function marketplaceMatches(
  marketplace: MarketplaceInfo,
  query: string | undefined,
): boolean {
  return fuzzyMatchText(query, [
    marketplace.id,
    marketplace.name,
    marketplace.sourceType,
    marketplace.sourceUrl,
    marketplace.validProviders.join(' '),
    marketplace.providerStatus.claude.state,
    marketplace.providerStatus.codex.state,
    marketplace.providerStatus.claude.error ?? '',
    marketplace.providerStatus.codex.error ?? '',
  ]);
}
