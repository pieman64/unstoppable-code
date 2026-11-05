import { marketplacePublicLinkPinnedAt } from '@canopy/protocol/marketplace';
import type { HostAction } from '@canopy/ui-shared/lib/host-action';
import {
  marketplaceLinkAccess,
  type MarketplaceLinkAccess,
} from './marketplaceShareLink';
import type { SharedByYouFacts } from './sharedByYouAudiences';
import type { SharedByYouCopyLinkPort } from './sharedByYouScopedLink';

export interface SharedByYouRow {
  readonly identity: string;
  readonly audience: MarketplaceLinkAccess['audience'];
  readonly name: string;
  readonly personal: boolean;
  readonly sinceIso?: string;
  readonly mode: 'delete' | 'revoke';
  readonly action: HostAction<() => Promise<void>>;
  readonly publicLinkPinnedAt?: string;
  readonly refresh?: HostAction<() => Promise<void>>;
  readonly copy?: {
    readonly link: string;
    readonly access: MarketplaceLinkAccess;
    readonly port: SharedByYouCopyLinkPort;
  };
}
export interface SharedByYouRowPorts {
  readonly identity: string;
  readonly deleteShare: HostAction<() => Promise<void>>;
  readonly revokePublicLink: HostAction<() => Promise<void>>;
  readonly refresh?: HostAction<() => Promise<void>>;
  readonly copy?: {
    readonly link: string | null;
    readonly port: SharedByYouCopyLinkPort;
  };
}
export function hasSharedByYouRow(facts: SharedByYouFacts): boolean {
  return facts.canDelete === true && marketplaceLinkAccess(facts) !== null;
}
export function sharedByYouRow(
  facts: SharedByYouFacts,
  personalOrganizationId: string | null,
  ports: SharedByYouRowPorts,
): SharedByYouRow | null {
  if (!hasSharedByYouRow(facts)) return null;
  const access = marketplaceLinkAccess(facts, personalOrganizationId);
  if (!access) return null;
  const scoped =
    facts.shareScope === 'team' || facts.shareScope === 'organization';
  const personal =
    facts.owner?.type === 'organization' &&
    facts.owner.id?.toLowerCase() === personalOrganizationId?.toLowerCase();
  const pinnedAt = marketplacePublicLinkPinnedAt(facts.publicShare?.updatedAt);
  const sinceIso = scoped ? facts.createdAt : facts.publicShare?.createdAt;
  return {
    identity: `${ports.identity}:${facts.publicShare?.externalId ?? ''}:${facts.publicShare?.updatedAt ?? ''}:${access.audience}`,
    audience: access.audience,
    name: personal
      ? 'Personal'
      : facts.owner?.name?.trim() ||
        (scoped ? 'Shared ' + facts.shareScope : 'Public link'),
    personal,
    mode: scoped ? 'delete' : 'revoke',
    action: scoped ? ports.deleteShare : ports.revokePublicLink,
    ...(sinceIso && !Number.isNaN(Date.parse(sinceIso)) ? { sinceIso } : {}),
    ...(pinnedAt ? { publicLinkPinnedAt: pinnedAt } : {}),
    ...(facts.publicShare?.upToDate === false && ports.refresh
      ? { refresh: ports.refresh }
      : {}),
    ...(ports.copy?.link
      ? { copy: { link: ports.copy.link, access, port: ports.copy.port } }
      : {}),
  };
}
