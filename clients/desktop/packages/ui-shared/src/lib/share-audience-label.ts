import type { ShareAudience } from '@canopy/protocol/sharing';

/**
 * An audience an author can pick. `private` stays a protocol storage value
 * (a public share is stored as private plus a public link), but it is never
 * offered as a choice.
 */
export type SelectableShareAudience = Exclude<ShareAudience, 'private'>;

/** Fixed label for each audience; every share surface reads the same. */
const SHARE_AUDIENCE_LABELS: Record<SelectableShareAudience, string> = {
  team: 'Team',
  organization: 'Organization',
  public: 'Public',
};

/** The label a share surface shows for an audience. */
export function shareAudienceLabel(audience: SelectableShareAudience): string {
  return SHARE_AUDIENCE_LABELS[audience];
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
