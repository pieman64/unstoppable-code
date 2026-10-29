import { useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useCanopyDesktopSharedContainersEnabled } from '@/hooks/useCanopyDesktopSharedContainersEnabled';
import { useCanopySharedContainerExternalSharingEnabled } from '@/hooks/useCanopySharedContainerExternalSharingEnabled';

/**
 * Whether a "Share" entry point should render on a worktree or
 * Work Entry row.
 *
 * The shared-containers rollout flag must be on, and the user must belong to
 * at least one organization - or, with external
 * sharing on, simply have a connected account: someone with no organization
 * can still share by email (Public). A disabled rollout
 * hides the entry point outright rather than degrading it to management-only:
 * the feature must not be visible at all when the flag is off.
 *
 * A billing lapse deliberately does NOT hide the entry point, even when EVERY
 * organization has lost the Teams entitlement (CAN-2551). This is the invariant
 * commit `9728d7bdea` ("preserve shared container access management")
 * established, and it must not be re-litigated as a listing concern: the entry
 * point is the only remaining surface for *revoking* access that was already
 * granted, and the server keeps that surface working on purpose.
 * `listSharedByMe`, `listContainerRecipients`, and `revokeContainerGrant` all
 * authorize on `authorizeOrgMembership` rather than a current entitlement,
 * precisely so "billing lapse blocks new grants, but must never strand existing
 * grants that the owner still needs to inspect and revoke". `InviteTeammateModal`
 * already renders a dedicated management path for the `blocked-by-org-billing`
 * refusal, and there is no web UI to fall back to — so hiding this would leave a
 * lapsed team with no way to remove a departed teammate's access to shared code,
 * plans, and chats.
 *
 * This is why the flag-off case in `4b5b7d48bd` is NOT a precedent for lapse.
 * Turning the rollout off removes the feature for everyone, including the
 * publisher's own recipients; a lapse leaves live grants outstanding that a
 * still-entitled member must be able to revoke.
 *
 * The recipient-side "Shared with me" section is suppressed separately, in
 * `sharedContainerReplicasStore`'s `blocked-by-org-billing` list status — that
 * is a listing concern and belongs there, not in this shared entry-point gate.
 *
 * The return order below is load-bearing. `accountHydrationFailed` fails open,
 * so a degraded secure-store read still shows the entry point: a transient
 * keychain failure must never hide a paid feature from an org that *is*
 * entitled.
 *
 * Reads a hydrated store snapshot, so this is safe to call from every row in a
 * long sidebar list: no per-render IPC, and no account read at all while the
 * rollout is off.
 */
export function useSharedContainerEntryPointVisible(): boolean {
  const sharedContainersEnabled = useCanopyDesktopSharedContainersEnabled();
  const externalSharingEnabled =
    useCanopySharedContainerExternalSharingEnabled();
  const {
    accountHydrated,
    accountHydrationFailed,
    accountKind,
    organizations,
  } = useSharedContainersStore(
    useShallow((s) => ({
      accountHydrated: s.accountHydrated,
      accountHydrationFailed: s.accountHydrationFailed,
      accountKind: s.accountKind,
      organizations: s.organizations,
    })),
  );
  const hydrateAccount = useSharedContainersStore((s) => s.hydrateAccount);

  useEffect(() => {
    if (!sharedContainersEnabled || accountHydrated) return;
    void hydrateAccount();
  }, [sharedContainersEnabled, accountHydrated, hydrateAccount]);
  if (!sharedContainersEnabled) return false;
  if (accountHydrationFailed) return true;
  if (externalSharingEnabled && accountKind === 'connected') return true;
  return organizations.length > 0;
}
