import type { JSX } from 'react';
import type { ProviderCarryoverProvider } from '@canopy/desktop-shared/types';
import { ReadyStatusLine } from '@canopy/ui-shared/components/ReadyStatusLine';
import { useProviderCarryover } from '@/hooks/useProviderCarryover';
import {
  providerCarryoverAttention,
  providerCarryoverLine,
} from '@/lib/providerCarryoverCopy';

interface ProviderCarryoverNoteProps {
  provider: ProviderCarryoverProvider;
  /** The provider is connected; nothing is read or shown before that. */
  enabled: boolean;
  /** Bumped by the host after a sign-in, so the line re-reads. */
  refreshKey?: number;
}

/**
 * Under a connected provider: what the user's own setup carries over into
 * its chats, behind the ready check, and what could not be loaded, which
 * takes no check (CAN-3701, CAN-4765). Nothing renders until
 * the read answers, so a connected row never flashes an empty claim.
 */
export function ProviderCarryoverNote({
  provider,
  enabled,
  refreshKey,
}: ProviderCarryoverNoteProps): JSX.Element | null {
  const summary = useProviderCarryover(provider, enabled, refreshKey);
  if (!summary) return null;
  const attention = providerCarryoverAttention(summary);
  return (
    <span
      data-testid={`provider-carryover-${provider}`}
      className="block text-xs fg-secondary"
    >
      <ReadyStatusLine>{providerCarryoverLine(summary)}</ReadyStatusLine>
      {attention && (
        <span
          data-testid={`provider-carryover-${provider}-attention`}
          className="block fg-warning"
        >
          {attention}
        </span>
      )}
    </span>
  );
}
