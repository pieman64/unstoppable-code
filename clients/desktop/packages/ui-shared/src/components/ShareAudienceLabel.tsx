import type { JSX } from 'react';
import {
  type SelectableShareAudience,
  shareAudienceLabel,
} from './ShareScopeControls';

/**
 * The shared-state label every list row and detail header shows after a
 * shared resource's name: `Team: Growth`, `Organization`, or `Public`.
 *
 * It is quiet text, not a pill. Who a thing is shared with is routine
 * metadata, so it takes the tertiary ink beside the name instead of a badge
 * (`DESIGN.md`: earn every badge). A resource that is not shared renders no
 * label at all; callers omit the component.
 */
export interface ShareAudienceLabelProps {
  audience: SelectableShareAudience;
  /** The team's name, for a Team share. Rendered as `Team: <name>`. */
  teamName?: string | null;
  personal?: boolean;
  /** Placement only; the ink and size belong to the label. */
  className?: string;
  dataTestId?: string;
}

/** The label's text, for hosts that render it inside their own element. */
export function shareAudienceLabelText(
  audience: SelectableShareAudience,
  teamName?: string | null,
  personal = false,
): string {
  if (audience === 'organization' && personal) return 'Personal';
  const label = shareAudienceLabel(audience);
  const name = teamName?.trim();
  return audience === 'team' && name ? `${label}: ${name}` : label;
}

export function ShareAudienceLabel({
  audience,
  teamName,
  personal,
  className,
  dataTestId,
}: ShareAudienceLabelProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      data-share-audience={audience}
      className={`shrink-0 whitespace-nowrap text-xs fg-tertiary${
        className ? ` ${className}` : ''
      }`}
    >
      {shareAudienceLabelText(audience, teamName, personal)}
    </span>
  );
}
