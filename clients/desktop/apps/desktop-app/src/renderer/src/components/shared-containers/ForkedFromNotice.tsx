/**
 * "Copied from a share" provenance line (CAN-2552).
 *
 * Renders nothing for a container that is not a fork, which is almost all of
 * them. The copy states the independence explicitly: a recipient who forked a
 * share weeks ago has no other way to tell whether the workspace they are
 * looking at still tracks someone else's, and guessing wrong in either
 * direction is costly.
 */
import type { JSX } from 'react';
import type { SharedContainerForkProvenance } from '@canopy/desktop-shared/types';

function formatForkedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : '';
}

export function ForkedFromNotice({
  provenance,
}: {
  provenance: SharedContainerForkProvenance | null;
}): JSX.Element | null {
  if (provenance === null) return null;
  const forkedAt = formatForkedAt(provenance.forkedAt);

  return (
    <p
      data-testid="shared-container-fork-provenance"
      className="text-xs fg-quaternary"
    >
      Copied from {provenance.sourceOwnerDisplayName}&rsquo;s share
      {forkedAt ? ` on ${forkedAt}` : ''}. This copy is yours and does not
      update when theirs does.
    </p>
  );
}
