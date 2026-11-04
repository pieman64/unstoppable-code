import type { JSX } from 'react';
import { Heading } from '@canopy/ui-shared/components';

interface DigestRequestUnavailableProps {
  testIdPrefix: string;
}

/**
 * Stands in for the request form when the quota could not be read.
 *
 * The read is guarded so a billing-side failure degrades the request control
 * instead of taking down the archive — but degrading silently is its own
 * problem: a user who used the form yesterday would find it simply gone, with
 * no way to tell a transient outage from the feature being withdrawn. This says
 * which one it is, in one line, and the archive still renders beneath it.
 */
export function DigestRequestUnavailable({
  testIdPrefix,
}: DigestRequestUnavailableProps): JSX.Element {
  return (
    // Same recessed, outlined control surface as `DigestRequestForm`: it stands
    // in the same slot, so it must not suddenly look like an archive row.
    <section
      className="rounded-xl border bg-depth p-5"
      data-testid={`${testIdPrefix}-digest-request-unavailable`}
    >
      <Heading level={3} variant="title">
        Request a digest
      </Heading>
      <p className="mt-1 text-xs fg-secondary">
        Digest requests are temporarily unavailable. Refresh in a moment to try
        again — your existing digests are unaffected.
      </p>
    </section>
  );
}
