/**
 * "Copied from a share" provenance line (CAN-2552).
 *
 * Renders nothing for a container that is not a fork, which is almost all of
 * them. The copy states the independence explicitly: a recipient who forked a
 * share weeks ago has no other way to tell whether the workspace they are
 * looking at still tracks someone else's, and guessing wrong in either
 * direction is costly.
 *
 * A copy made since CAN-4908 names the source version by its publication time,
 * the same anchor its confirmation showed. Older records, and any without a
 * valid source time, keep the copy date instead.
 */
import type { JSX, Ref } from 'react';
import type { SharedContainerForkProvenance } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { formatRevisionTime } from '@/lib/shared-containers/revision-time';
import { RevisionTime } from './RevisionTime';

function formatForkedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : '';
}

export function ForkedFromNotice({
  provenance,
  focusRef,
}: {
  provenance: SharedContainerForkProvenance | null;
  /** Focus target after a copy opens; `tabIndex={-1}` adds no Tab stop. */
  focusRef?: Ref<HTMLParagraphElement>;
}): JSX.Element | null {
  if (provenance === null) return null;
  const sourceTime = formatRevisionTime(provenance.sourceRevisionCreatedAt);
  const forkedAt = formatForkedAt(provenance.forkedAt);

  return (
    <p
      ref={focusRef}
      tabIndex={-1}
      data-testid="shared-container-fork-provenance"
      className="text-xs fg-quaternary"
    >
      Copied from{' '}
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
        {provenance.sourceOwnerDisplayName}
      </span>
      &rsquo;s share
      {sourceTime !== null ? (
        <>
          {' '}
          (version of <RevisionTime label={sourceTime} />)
        </>
      ) : forkedAt ? (
        ` on ${forkedAt}`
      ) : (
        ''
      )}
      . This copy is yours and does not update when theirs does.
    </p>
  );
}
