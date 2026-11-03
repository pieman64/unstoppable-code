import {
  buildDesktopShareDeepLink,
  type DesktopShareDeepLinkEntity,
} from '@canopy/protocol/share-deep-link';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib/marketplace-unshare';
import {
  SHARED_BY_YOU_COPY_LINK_ERROR,
  sharedByYouLinkCopiedNotice,
} from '@canopy/ui-shared/lib/shared-by-you';
import type { ShareNotify } from './ShareDialogFrame';

/**
 * The owner's member link for an account audience (CAN-5452): the share's
 * desktop link with the audience that selects member resolution. Copying it
 * never publishes, revokes or changes who can open the item.
 */

/** What the link points at; the host supplies its brand scheme. */
export interface SharedByYouScopedLinkTarget {
  readonly scheme: string;
  readonly kind: MarketplaceUnshareKind;
  /** The account share's canonical id, never an installed copy's id. */
  readonly shareId: string;
}

/** A copyable member link and the share facts its notice describes. */
export interface SharedByYouScopedLink {
  readonly url: string;
  readonly audience: 'team' | 'organization';
  /** The stored audience name; a Personal row does not show it. */
  readonly audienceName: string;
  readonly personal: boolean;
  readonly hasPublicLink: boolean;
}

/** The account audience facts a link is built from. */
export interface SharedByYouScopedLinkAudience {
  readonly audience: 'team' | 'organization';
  readonly name: string;
  readonly personal?: boolean;
  readonly alsoRevokesPublicLink: boolean;
}

/** How a host writes the link and reports the result. */
export interface SharedByYouCopyLinkPort {
  /** Resolves whether the write succeeded; a rejection counts as failure. */
  readonly write: (text: string) => Promise<boolean>;
  readonly notify: ShareNotify;
}

const ENTITY_FOR_KIND: Readonly<
  Record<MarketplaceUnshareKind, DesktopShareDeepLinkEntity>
> = {
  skill: 'skill',
  collection: 'collection',
  plugin: 'plugin',
  agent: 'agent',
};

/**
 * The member link for one account audience, or `null` when the share id or
 * scheme cannot form one. The protocol builder owns the URL grammar; its
 * invalid-input error is the only failure caught here.
 */
export function scopedLinkForAudience(
  account: SharedByYouScopedLinkAudience,
  target: SharedByYouScopedLinkTarget,
): SharedByYouScopedLink | null {
  let url: string;
  try {
    url = buildDesktopShareDeepLink({
      scheme: target.scheme,
      entity: ENTITY_FOR_KIND[target.kind],
      externalId: target.shareId,
      audience: account.audience === 'team' ? 'TEAM' : 'ORGANIZATION',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message ===
        'Invalid share externalId (must be a canonical UUID)' ||
        error.message.startsWith(
          'Invalid desktop deep-link scheme (must match ',
        ))
    )
      return null;
    throw error;
  }
  return {
    url,
    audience: account.audience,
    audienceName: account.name,
    personal: account.personal === true,
    hasPublicLink: account.alsoRevokesPublicLink,
  };
}

/** The success notice for a copied member link. */
export function sharedByYouScopedLinkNotice(
  link: SharedByYouScopedLink,
): string {
  return sharedByYouLinkCopiedNotice(link);
}

/**
 * Wraps a host writer so a failed or rejected write warns once and resolves
 * `false`; it never rejects. Success is reported by the caller, after the
 * control has confirmed the copy.
 */
export function scopedLinkWriter(
  port: SharedByYouCopyLinkPort,
  isCurrent: () => boolean = (): boolean => true,
): (text: string) => Promise<boolean> {
  return async (text: string): Promise<boolean> => {
    let ok: boolean;
    try {
      ok = await port.write(text);
    } catch {
      ok = false;
    }
    if (!ok && isCurrent()) {
      port.notify({ tone: 'warning', message: SHARED_BY_YOU_COPY_LINK_ERROR });
    }
    return ok;
  };
}

/** Posts the success notice for a copied member link. */
export function notifyScopedLinkCopied(
  port: SharedByYouCopyLinkPort,
  link: SharedByYouScopedLink,
): void {
  port.notify({
    tone: 'success',
    message: sharedByYouScopedLinkNotice(link),
    // Audience names identify an organization or team.
    blockMessageFromReplay: true,
  });
}

/**
 * Copies a member link and reports the result, for a control without its
 * own copied state such as a menu item. `isCurrent` lets the caller drop
 * the notice when the page moved on to another item while the write ran.
 */
export async function copySharedByYouScopedLink(
  link: SharedByYouScopedLink,
  port: SharedByYouCopyLinkPort,
  isCurrent: () => boolean = (): boolean => true,
): Promise<boolean> {
  const ok = await scopedLinkWriter(port, isCurrent)(link.url);
  if (ok && isCurrent()) notifyScopedLinkCopied(port, link);
  return ok;
}
