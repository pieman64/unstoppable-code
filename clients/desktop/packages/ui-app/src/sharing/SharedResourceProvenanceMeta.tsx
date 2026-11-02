import type { ReactNode } from 'react';
import { ShareAudienceLabel } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { SharedResourceProvenance } from './sharedResourceProvenance';

export interface SharedResourceProvenanceMetaOptions {
  /** Audiences are listed in Shared by you; retain only header provenance. */
  readonly audienceListedBelow?: boolean;
}

/**
 * A shared resource's provenance as a detail header's quiet meta facts:
 * `By <author>`, the owning organization, then the audience. Omitted facts
 * render nothing, so `DetailHeader` never draws a dangling separator. The
 * organization fact is `${audienceTestId}-organization` and the author is
 * `${audienceTestId}-author`. Where Shared by you lists the owner's
 * audiences (CAN-5224), the audience slot is left empty.
 */
export function sharedResourceProvenanceMeta(
  provenance: SharedResourceProvenance,
  audienceTestId: string,
  options: SharedResourceProvenanceMetaOptions = {},
): ReactNode[] {
  const { author, organizationName } = provenance;
  const audience = options.audienceListedBelow ? null : provenance.audience;
  return [
    author ? (
      <span
        key="author"
        className="min-w-0 wrap-anywhere"
        data-testid={`${audienceTestId}-author`}
      >
        {/* The author is a person: replay records a box for the name. */}
        By <span className={REPLAY_BLOCK_CLASS}>{author}</span>
      </span>
    ) : null,
    organizationName ? (
      <span
        key="organization"
        className="min-w-0 wrap-anywhere"
        data-testid={`${audienceTestId}-organization`}
      >
        {organizationName}
      </span>
    ) : null,
    audience ? (
      <ShareAudienceLabel
        key="audience"
        audience={audience.audience}
        teamName={audience.teamName}
        personal={audience.personal}
        className="min-w-0 shrink! whitespace-normal! wrap-anywhere"
        dataTestId={audienceTestId}
      />
    ) : null,
  ];
}
