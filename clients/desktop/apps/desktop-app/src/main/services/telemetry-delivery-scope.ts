import type { TelemetryShareScope } from '@canopy/protocol';

/**
 * Where one queued telemetry item is delivered (CAN-3515).
 *
 * Activity counts only in the scope that owns the work. Work in an
 * organization-owned workspace (converted, set up from the catalog, an org
 * Cowork workspace, or an org's default Chats) goes to that organization; work
 * in a Personal workspace stays the member's own. The sidebar selection is not
 * an input: it neither chooses nor caps the destination.
 *
 * Everything else still applies around this: the caller resolves the owner and
 * fails closed when it is unknown, applies that owner's enforced policy and the
 * member's per-kind preference to produce `preferredScope`, and flush still
 * checks membership, billing, and the tracked-source binding before sending.
 */
export interface TelemetryDeliveryTargetInput {
  /** The member's preference for this data kind, after the owner's policy. */
  preferredScope: TelemetryShareScope;
  /** The organization that owns the work, or null for Personal work. */
  ownerOrganizationId: string | null;
  /**
   * An organization the member explicitly chose for this item, independent of
   * the sidebar: today only a shared container's anchor registration. Null
   * for ambient activity.
   */
  explicitOrganizationId: string | null;
}

export interface TelemetryDeliveryTarget {
  scope: TelemetryShareScope;
  /** Destination organization; null exactly when `scope` is private. */
  organizationId: string | null;
  /**
   * True when this is where the work's own activity lands. False only for an
   * explicit anchor in an organization that does not own the work, which must
   * carry the envelope alone and never the member's presence or content.
   */
  ownerRoute: boolean;
}

export function resolveTelemetryDeliveryTarget({
  preferredScope,
  ownerOrganizationId,
  explicitOrganizationId,
}: TelemetryDeliveryTargetInput): TelemetryDeliveryTarget {
  const destination = explicitOrganizationId ?? ownerOrganizationId;
  if (preferredScope === 'private' || destination === null) {
    return { scope: 'private', organizationId: null, ownerRoute: true };
  }
  return {
    scope: preferredScope,
    organizationId: destination,
    ownerRoute: destination === ownerOrganizationId,
  };
}
