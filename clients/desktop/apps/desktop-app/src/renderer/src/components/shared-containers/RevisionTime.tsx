import type { JSX } from 'react';
import type { RevisionTimeLabel } from '@/lib/shared-containers/revision-time';

/** A revision's compact time, with the full date, time and zone on hover. */
export function RevisionTime({
  label,
}: {
  label: RevisionTimeLabel;
}): JSX.Element {
  return (
    <time dateTime={label.iso} title={label.full}>
      {label.short}
    </time>
  );
}
