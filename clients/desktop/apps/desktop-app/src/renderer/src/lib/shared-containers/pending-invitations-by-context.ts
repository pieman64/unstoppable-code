import { contextUpdateKey } from '@canopy/ui-app';
import type { SharedContainerAcceptedIdentity } from '@canopy/desktop-shared/types';
import type { SharedContainerListEntry } from '@/stores/sharedContainerReplicasStore';
import { sharedContainerHomeContext } from './home-context';
import { sharedContainerCanView } from './panel-allowlist';

/**
 * Pending share invitations per home context (CAN-4783), keyed like the
 * context switcher's dots (`contextUpdateKey`: `'personal'` or an
 * organization id). An invitation is a viewable listed entry that has not
 * been accepted, homed by `sharedContainerHomeContext` exactly as the
 * sidebar's Shared with you section lists it; entries no context lists are
 * skipped. Every home is counted, including the current context and
 * organizations the switcher does not list: the switcher decides what shows.
 * The section matches organization ids without case, so a listed home is
 * keyed by the membership's id, the one the switcher's rows use.
 */
export function pendingInvitationsByContext(
  entries: readonly SharedContainerListEntry[],
  acceptedIds: readonly string[],
  acceptedRecords: Readonly<Record<string, SharedContainerAcceptedIdentity>>,
  organizations: readonly { readonly id: string }[] | undefined,
): ReadonlyMap<string, number> {
  const accepted = new Set(acceptedIds);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = entry.container.id;
    if (!sharedContainerCanView(entry.container.capabilities)) continue;
    if (accepted.has(id)) continue;
    const home = sharedContainerHomeContext(
      entry,
      acceptedRecords[id],
      organizations,
    );
    if (home === null) continue;
    const membership =
      home.kind === 'organization'
        ? organizations?.find(
            (organization) =>
              organization.id.toLowerCase() ===
              home.organizationId.toLowerCase(),
          )
        : undefined;
    const key = membership?.id ?? contextUpdateKey(home);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
