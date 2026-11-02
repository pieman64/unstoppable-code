import type { JSX } from 'react';
import { Users } from '../icons/AppIcons';
import {
  type SelectableShareAudience,
  shareAudienceLabelText,
} from '../lib/share-audience-label';

export { shareAudienceLabelText } from '../lib/share-audience-label';

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
  /**
   * Show a team share as a team icon and the team's name, for dense rows such
   * as Browse cards. Screen readers still hear `Team: <name>`.
   */
  teamIcon?: boolean;
}

export function ShareAudienceLabel({
  audience,
  teamName,
  personal,
  className,
  dataTestId,
  teamIcon = false,
}: ShareAudienceLabelProps): JSX.Element {
  const name = teamName?.trim();
  const iconTeam = teamIcon && audience === 'team' && Boolean(name);
  return (
    <span
      data-testid={dataTestId}
      data-share-audience={audience}
      className={`shrink-0 whitespace-nowrap text-xs fg-tertiary${
        iconTeam ? ' inline-flex items-center gap-1' : ''
      }${className ? ` ${className}` : ''}`}
    >
      {iconTeam ? (
        <>
          <Users size={12} aria-hidden="true" className="shrink-0" />
          <span className="sr-only">{`${shareAudienceLabelText(audience)}: `}</span>
          {name}
        </>
      ) : (
        shareAudienceLabelText(audience, teamName, personal)
      )}
    </span>
  );
}
