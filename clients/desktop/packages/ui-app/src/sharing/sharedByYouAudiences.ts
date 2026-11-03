import type { HostAction } from '@canopy/ui-shared/lib/host-action';
import type { RemovePublicLinkRemainingAudience } from '@canopy/ui-shared/lib/remove-public-link';
import { SHARED_BY_YOU_PUBLIC_LINK_LABEL } from '@canopy/ui-shared/lib/shared-by-you';
import {
  deriveExistingShare,
  type ExistingShareFacts,
} from './deriveExistingShare';
import {
  scopedLinkForAudience,
  type SharedByYouCopyLinkPort,
  type SharedByYouScopedLink,
  type SharedByYouScopedLinkTarget,
} from './sharedByYouScopedLink';

/**
 * Which audiences an owner shared a Marketplace item with, one "Shared by
 * you" row each (CAN-4842). Pure over the share facts every shared summary
 * already carries; hosts supply the transports as ports.
 */

/** The share facts the section reads. Every shared summary is assignable. */
export interface SharedByYouFacts extends ExistingShareFacts {
  /** Only the owner can unshare, so only the owner sees the section. */
  readonly canDelete?: boolean;
  readonly createdAt?: string;
  readonly publicShare?: {
    readonly upToDate?: boolean;
    readonly createdAt?: string;
    readonly externalId?: string;
  } | null;
}

/** What each row's Unshare runs, or why the host cannot run it. */
export interface SharedByYouPorts {
  /** Deletes the account share; its public link goes with it. */
  readonly deleteShare: HostAction<() => Promise<void>>;
  /** Removes only the public link; the account share stays. */
  readonly revokePublicLink: HostAction<() => Promise<void>>;
  /**
   * Copies the account audience's member link (CAN-5452). Without it, or
   * when the share cannot form a link, the row offers no Copy link.
   */
  readonly copyLink?: SharedByYouCopyLinkPort & {
    readonly target: SharedByYouScopedLinkTarget;
  };
}

/** An account row's Copy link: the member link and the host's port. */
export interface SharedByYouAccountCopyLink {
  readonly link: SharedByYouScopedLink;
  readonly port: SharedByYouCopyLinkPort;
}

export type SharedByYouAudience =
  | {
      readonly id: 'account';
      readonly audience: 'team' | 'organization';
      readonly name: string;
      readonly personal?: boolean;
      readonly sinceIso?: string;
      readonly action: HostAction<() => Promise<void>>;
      /** The share also has a public link, which stops working too. */
      readonly alsoRevokesPublicLink: boolean;
      /** Copy link for the member link, when the host and share allow it. */
      readonly copyLink?: SharedByYouAccountCopyLink;
    }
  | {
      readonly id: 'public';
      readonly audience: 'public';
      readonly name: string;
      /** The link's own id, when the facts carry it; tells links apart. */
      readonly linkId?: string;
      readonly sinceIso?: string;
      readonly action: HostAction<() => Promise<void>>;
      /**
       * The account audience that keeps access once the link goes. Absent
       * when none remains, so the item leaves shared lists too.
       */
      readonly remainingAudience?: RemovePublicLinkRemainingAudience;
    };

type AccountAudienceRow = Omit<
  Extract<SharedByYouAudience, { id: 'account' }>,
  'action' | 'copyLink'
>;
type PublicAudienceRow = Omit<
  Extract<SharedByYouAudience, { id: 'public' }>,
  'action'
>;

const TEAM_FALLBACK_NAME = 'Shared team';
const ORGANIZATION_FALLBACK_NAME = 'Shared organization';

function audienceRows(
  facts: SharedByYouFacts,
  personalOrganizationId: string | null,
): { account?: AccountAudienceRow; public?: PublicAudienceRow } {
  if (facts.canDelete !== true) return {};
  const scope = facts.shareScope ?? 'private';
  const publicShare = facts.publicShare ?? null;
  // A stale link (`upToDate: false`) still serves the old copy, so it is a link.
  const hasPublicLink = publicShare !== null;
  const account: AccountAudienceRow | undefined =
    scope === 'team' || scope === 'organization'
      ? accountRow(facts, scope, hasPublicLink, personalOrganizationId)
      : undefined;
  const publicRow: PublicAudienceRow | undefined = hasPublicLink
    ? {
        id: 'public',
        audience: 'public',
        name: SHARED_BY_YOU_PUBLIC_LINK_LABEL,
        ...(publicShare.externalId ? { linkId: publicShare.externalId } : {}),
        ...(publicShare.createdAt ? { sinceIso: publicShare.createdAt } : {}),
        ...(account
          ? {
              remainingAudience: {
                name: account.name,
                ...(account.personal ? { personal: true } : {}),
              },
            }
          : {}),
      }
    : undefined;
  return {
    ...(account ? { account } : {}),
    ...(publicRow ? { public: publicRow } : {}),
  };
}

function accountRow(
  facts: SharedByYouFacts,
  scope: 'team' | 'organization',
  hasPublicLink: boolean,
  personalOrganizationId: string | null,
): AccountAudienceRow {
  const existing = deriveExistingShare(facts, personalOrganizationId);
  const audience = existing?.targetAudience ?? scope;
  const personal =
    audience === 'organization' &&
    facts.owner?.type === 'organization' &&
    facts.owner.id !== undefined &&
    facts.owner.id === personalOrganizationId;
  return {
    id: 'account',
    audience,
    name:
      // Keep owner data intact; the row and confirmation display Personal
      // from its identity flag rather than replacing the stored name.
      (personal ? facts.owner?.name : undefined) ??
      existing?.target?.name ??
      (audience === 'team' ? TEAM_FALLBACK_NAME : ORGANIZATION_FALLBACK_NAME),
    ...(personal ? { personal: true } : {}),
    ...(facts.createdAt ? { sinceIso: facts.createdAt } : {}),
    alsoRevokesPublicLink: hasPublicLink,
  };
}

/**
 * The owner's audience rows, account audience first then the public link.
 * Empty unless the viewer can delete the share. A share stored as private
 * (or with no scope, as an older desktop may send) shows only its public
 * link; a private share with no link shows nothing.
 */
export function sharedByYouAudiences(
  facts: SharedByYouFacts,
  personalOrganizationId: string | null,
  ports: SharedByYouPorts,
): readonly SharedByYouAudience[] {
  const rows = audienceRows(facts, personalOrganizationId);
  const audiences: SharedByYouAudience[] = [];
  if (rows.account) {
    const link = ports.copyLink
      ? eligibleScopedLink(facts, rows.account, ports.copyLink.target)
      : null;
    audiences.push({
      ...rows.account,
      action: ports.deleteShare,
      ...(link && ports.copyLink
        ? {
            copyLink: {
              link,
              port: {
                write: ports.copyLink.write,
                notify: ports.copyLink.notify,
              },
            },
          }
        : {}),
    });
  }
  if (rows.public) {
    audiences.push({ ...rows.public, action: ports.revokePublicLink });
  }
  return audiences;
}

/** Row count without ports; drives the ⋯ Unshare label. */
export function sharedByYouAudienceCount(
  facts: SharedByYouFacts,
  personalOrganizationId: string | null,
): number {
  const rows = audienceRows(facts, personalOrganizationId);
  return (rows.account ? 1 : 0) + (rows.public ? 1 : 0);
}

/**
 * The owner's member link for the account audience, or `null` unless the
 * viewer can delete a team or organization share whose id forms a link.
 * The same facts decide the Shared by you row, so the row and a ⋯ menu's
 * Copy link always agree (CAN-5452).
 */
export function sharedByYouScopedLink(
  facts: SharedByYouFacts,
  personalOrganizationId: string | null,
  target: SharedByYouScopedLinkTarget,
): SharedByYouScopedLink | null {
  const { account } = audienceRows(facts, personalOrganizationId);
  return account ? eligibleScopedLink(facts, account, target) : null;
}

/** Display rows may use fallback names; copy notices require stored identity. */
function eligibleScopedLink(
  facts: SharedByYouFacts,
  account: AccountAudienceRow,
  target: SharedByYouScopedLinkTarget,
): SharedByYouScopedLink | null {
  const owner = facts.owner;
  if (
    !owner?.id?.trim() ||
    !owner.name?.trim() ||
    owner.type !== facts.shareScope
  )
    return null;
  return scopedLinkForAudience(account, target);
}
