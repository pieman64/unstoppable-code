import { create } from 'zustand';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import type {
  SharedContainerOwnedTarget,
  SharedContainerPublicationState,
} from '@canopy/desktop-shared/types';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/execution-engine/types/pipeline';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Renderer-side cache for the shared-container (invite a teammate) surfaces.
 *
 * Two jobs, deliberately kept in one store:
 *
 * 1. **Entry-point visibility without a per-render IPC call.** Sidebar rows and
 *    worktree kebab menus ask "does this user belong to any org whose existing
 *    access may need management?" on every render. That answer is read
 *    synchronously from this snapshot; the underlying account read happens once
 *    per account change, not once per row.
 * 2. **Local publication state**, keyed by project, worktree, and organization,
 *    fed by the main → renderer `shared-containers:publication-changed` broadcast.
 *    Until CAN-2547/2548 ship a revision producer this reports `not-published`
 *    for everything, and it must keep reporting that honestly rather than
 *    inventing a published-looking state.
 * 3. **Which local worktrees own a shared container** (CAN-2551), hydrated once
 *    per account by fanning the org-wide owner listing over `organizations`.
 *    Before this, `listSharedByMe` was called only inside the invite modal, so
 *    there was no globally hydrated "this worktree is shared" fact for the
 *    sidebar badge to read.
 */
export interface SharedContainersState {
  /** False until the first account read resolves (successfully or not). */
  accountHydrated: boolean;
  /** True when the latest account read failed and visibility must fail open. */
  accountHydrationFailed: boolean;
  accountKind: 'unknown' | 'disconnected' | 'guest' | 'connected';
  organizations: CanopyOrganizationSummary[];
  /** Teams the account belongs to; the invite modal's Team audience lists them. */
  teams: CanopyTeamSummary[];
  orgBillingStates: CanopyOrgBillingState[];
  publicationStates: Record<string, SharedContainerPublicationState>;
  /**
   * Owner-side server truth, keyed by {@link publicationStateKey} - the same
   * `project:worktree:organization` key the publication states use, so the
   * invite modal can reconcile a local record against the server for one
   * specific org.
   */
  sharedTargets: Record<string, SharedContainerOwnedTarget>;
  /**
   * The same snapshots re-keyed by `project:worktree` for the sidebar badge.
   *
   * Kept as a second index rather than scanned out of `sharedTargets` because
   * a sidebar row asks "is this worktree shared?" on every render without
   * knowing which organization it is anchored to, and a worktree anchors to at
   * most one organization. Writes happen once per account hydration; reads
   * happen once per row per render, so the duplication buys an O(1) lookup on
   * the hot side.
   *
   * An absent entry means "unknown", not "not shared": a bounded or failed
   * owner listing simply leaves fewer known targets behind (see
   * {@link SharedContainersState.hydrateSharedTargets}). Readers must treat
   * absence as "render no badge", which is the correct fail-soft outcome for
   * an additive marker.
   */
  sharedWorktrees: Record<string, SharedContainerOwnedTarget>;
  hydrateAccount: (options?: {
    refreshAfterCurrent?: boolean;
  }) => Promise<void>;
  hydrateSharedTargets: () => Promise<void>;
  /**
   * Record a target the renderer just learned about first-hand (a successful
   * invite creates the container), so the sidebar badge appears immediately
   * instead of waiting for the next account-level hydration.
   */
  recordSharedTarget: (target: SharedContainerOwnedTarget) => void;
  /**
   * The counterpart to {@link SharedContainersState.recordSharedTarget}, for a
   * target the renderer just learned first-hand has gone away.
   *
   * Revoking the last recipient removes the container's last grant, and the
   * owner listing filters on `grants: { some: {} }` - so the server stops
   * returning that container immediately, while this cache is only re-fanned
   * at init and on account change. Without a removal path the cache is
   * add-only and the sidebar's "shared with teammates" badge outlives a full
   * revoke until the app restarts.
   */
  /** `organizationId` is absent for a personal container. */
  removeSharedTarget: (
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
  ) => void;
  subscribeToPublicationChanges: () => () => void;
  setPublicationState: (state: SharedContainerPublicationState) => void;
  reset: () => void;
}

let accountHydrationPromise: Promise<void> | null = null;
let accountHydrationQueued = false;
let accountHydrationEpoch = 0;
let sharedTargetsEpoch = 0;
let sharedTargetsPromise: Promise<void> | null = null;
/** The epoch `sharedTargetsPromise` was started for, so a stale in-flight
 * fan-out is never reused across an account change. */
let sharedTargetsPromiseEpoch = -1;

/**
 * Retire any in-flight owner fan-out. Its result can no longer be written and
 * the next `hydrateSharedTargets` starts fresh rather than awaiting it.
 */
function invalidateSharedTargets(): void {
  sharedTargetsEpoch += 1;
  sharedTargetsPromise = null;
}

/**
 * Owner segment used in store keys for a personal container, which no
 * organization owns. Organization ids are UUIDs, so this cannot collide.
 */
export const PERSONAL_SHARE_OWNER_KEY = 'personal';

export function publicationStateKey(
  projectId: string,
  worktreeId: string,
  organizationId: string | undefined,
): string {
  return `${projectId}:${worktreeId}:${organizationId ?? PERSONAL_SHARE_OWNER_KEY}`;
}

/** True when external (email) sharing is enabled for this session. */
function isExternalSharingEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key);
}

/**
 * Organization-free key for the sidebar badge. A worktree anchors to at most
 * one organization (`anchored-to-other-organization` is a refusal, not a
 * second anchor), so this identifies a shared worktree uniquely.
 */
export function sharedWorktreeKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}:${worktreeId}`;
}

export const useSharedContainersStore = create<SharedContainersState>(
  (set, get) => ({
    accountHydrated: false,
    accountHydrationFailed: false,
    accountKind: 'unknown',
    organizations: [],
    teams: [],
    orgBillingStates: [],
    publicationStates: {},
    sharedTargets: {},
    sharedWorktrees: {},

    hydrateAccount: async (options): Promise<void> => {
      if (accountHydrationPromise) {
        if (options?.refreshAfterCurrent) {
          accountHydrationQueued = true;
        }
        return accountHydrationPromise;
      }
      const epoch = accountHydrationEpoch;
      const hydration = (async (): Promise<void> => {
        do {
          accountHydrationQueued = false;
          try {
            const account = await window.api?.loadCanopyCloudAccount();
            if (accountHydrationEpoch !== epoch) return;
            if (account && (account.read ?? 'ok') !== 'ok') {
              // A degraded secure-store read is inconclusive, not a sign-out.
              // Preserve the last-known-good account/org snapshot and fail open
              // until a later read can answer authoritatively.
              set({ accountHydrated: true, accountHydrationFailed: true });
              continue;
            }
            set({
              accountHydrated: true,
              accountHydrationFailed: false,
              accountKind:
                account && isGuestAccount(account)
                  ? 'guest'
                  : isCanopyCloudConnected(account)
                    ? 'connected'
                    : 'disconnected',
              organizations: account?.organizations ?? [],
              teams: account?.teams ?? [],
              orgBillingStates: account?.orgBillingStates ?? [],
            });
          } catch {
            if (accountHydrationEpoch !== epoch) return;
            // Fail open: a probe failure must never invent a lockout. The entry
            // point stays visible and the modal's own eligibility probe explains
            // any real refusal. A later account event or explicit call may retry.
            set({ accountHydrated: true, accountHydrationFailed: true });
          }
        } while (accountHydrationQueued && accountHydrationEpoch === epoch);
      })();
      accountHydrationPromise = hydration;
      try {
        await hydration;
      } finally {
        if (accountHydrationPromise === hydration) {
          accountHydrationPromise = null;
        }
      }
    },

    /**
     * Fan the org-wide owner listing over every organization on the account.
     *
     * Deliberately fail-soft in both directions: a bridge that predates the
     * listing, an org whose page fails, and a listing bounded by `truncated`
     * all resolve to "fewer known targets", never to a thrown init path or a
     * blocked sidebar render.
     *
     * That is why a partial answer is not tracked separately: the only thing a
     * reader could do with "this listing was incomplete" is decline to render
     * an additive badge, and an absent target already renders no badge. A
     * missing entry therefore means "unknown", not "not shared", and every
     * reader of {@link SharedContainersState.sharedWorktrees} and
     * {@link SharedContainersState.sharedTargets} must read it that way.
     *
     * The one attempt that writes *nothing* is the one that read nothing: if
     * every organization's listing failed, this hydration learned no facts at
     * all, so the previously known targets are left in place instead of being
     * replaced with an empty map. That is not a claim the shares still exist,
     * only a refusal to downgrade known entries to "unknown" on the strength
     * of a total transport failure. A partial failure still replaces the maps,
     * because at least one organization answered authoritatively and its
     * removals have to land.
     */
    hydrateSharedTargets: async (): Promise<void> => {
      // Coalesce concurrent callers, but only while they would compute the
      // same answer. An account change bumps the epoch, and reusing the
      // in-flight promise across that boundary would resolve the new account
      // against the previous account's `organizations` and never re-fan.
      if (
        sharedTargetsPromise &&
        sharedTargetsPromiseEpoch === sharedTargetsEpoch
      ) {
        return sharedTargetsPromise;
      }
      const epoch = sharedTargetsEpoch;
      const { organizations, accountKind } = get();
      const bridge = window.api?.sharedContainers;
      // Personal containers (shared by email, owned by no organization) have
      // their own owner listing, requested with no organization id.
      const includePersonal =
        accountKind === 'connected' && isExternalSharingEnabled();
      const listings: Array<{ organizationId?: string }> = [
        ...organizations.map((organization) => ({
          organizationId: organization.id,
        })),
        ...(includePersonal ? [{}] : []),
      ];
      if (!bridge?.listOwnedTargets || listings.length === 0) {
        // An absent bridge or an account with nothing to list is a complete
        // answer, not a partial one: there is nothing left unread.
        set({ sharedTargets: {}, sharedWorktrees: {} });
        return;
      }
      const hydration = (async (): Promise<void> => {
        // `Promise.allSettled` only absorbs *rejections*. A bridge that throws
        // synchronously would escape the `.map` and reject this hydration,
        // which the `void` in `initializeSharedContainersStore` would surface
        // as an unhandled rejection during app init - the one thing this
        // listing is required never to do.
        const results = await Promise.allSettled(
          listings.map(async (listing) => bridge.listOwnedTargets(listing)),
        );
        if (sharedTargetsEpoch !== epoch) return;
        let answered = 0;
        for (const result of results) {
          if (result.status === 'fulfilled') answered += 1;
        }
        // `results` is always sized to `listings`, and an empty
        // `listings` short-circuited above, so `answered === 0` alone
        // means "every organization rejected" - it can never mean "there was
        // nothing to ask". An organization that genuinely owns nothing
        // resolves fulfilled with an empty page and counts as answered.
        if (answered === 0) {
          // Nobody answered, so this attempt carries no information about any
          // organization. Replacing the maps with `{}` here would clear every
          // badge on a single transient outage; leaving them alone keeps the
          // last facts that were actually read until a later attempt, an
          // account change, or a first-hand `removeSharedTarget` supersedes
          // them.
          return;
        }
        const sharedTargets: Record<string, SharedContainerOwnedTarget> = {};
        const sharedWorktrees: Record<string, SharedContainerOwnedTarget> = {};
        for (const result of results) {
          // A rejected org, and a page bounded by `truncated`, both just
          // contribute fewer entries. Absence is the fail-soft signal.
          if (result.status !== 'fulfilled') continue;
          for (const target of result.value.targets) {
            sharedTargets[
              publicationStateKey(
                target.projectId,
                target.worktreeId,
                target.organizationId,
              )
            ] = target;
            sharedWorktrees[
              sharedWorktreeKey(target.projectId, target.worktreeId)
            ] = target;
          }
        }
        set({ sharedTargets, sharedWorktrees });
      })();
      // Coalesced callers get `guarded`, never the raw `hydration`. Only the
      // originating caller awaits `hydration` inside the try/catch below, so
      // handing the raw promise out would put a rejection outside every catch
      // in the chain - and this is awaited from a `void`-ed async IIFE during
      // app init, where that surfaces as an unhandled rejection.
      const guarded = hydration.catch((): void => {});
      sharedTargetsPromise = guarded;
      sharedTargetsPromiseEpoch = epoch;
      try {
        await hydration;
      } catch {
        // Only reachable for the synchronous-throw case described above:
        // `Promise.allSettled` already absorbs every per-organization
        // rejection, so nothing inside the fan-out itself lands here. Swallow
        // it so a listing problem can never block sidebar render or app
        // initialization. Like the all-organizations-failed path, this leaves
        // the existing maps untouched, because nothing was read.
      } finally {
        if (sharedTargetsPromise === guarded) sharedTargetsPromise = null;
      }
    },

    recordSharedTarget: (target: SharedContainerOwnedTarget): void => {
      set((current) => ({
        sharedTargets: {
          ...current.sharedTargets,
          [publicationStateKey(
            target.projectId,
            target.worktreeId,
            target.organizationId,
          )]: target,
        },
        sharedWorktrees: {
          ...current.sharedWorktrees,
          [sharedWorktreeKey(target.projectId, target.worktreeId)]: target,
        },
      }));
    },

    removeSharedTarget: (
      projectId: string,
      worktreeId: string,
      organizationId: string | undefined,
    ): void => {
      set((current) => {
        const sharedTargets = { ...current.sharedTargets };
        delete sharedTargets[
          publicationStateKey(projectId, worktreeId, organizationId)
        ];
        const worktreeKey = sharedWorktreeKey(projectId, worktreeId);
        const sharedWorktrees = { ...current.sharedWorktrees };
        // The org-free index is only dropped when the entry sitting there is
        // the one being removed. A worktree anchors to a single organization,
        // but a stale entry left by a different org must not be clobbered by
        // this org's revoke - that would erase a badge that is still true.
        if (sharedWorktrees[worktreeKey]?.organizationId === organizationId) {
          delete sharedWorktrees[worktreeKey];
        }
        return { sharedTargets, sharedWorktrees };
      });
    },

    subscribeToPublicationChanges: (): (() => void) => {
      // Defensive: the bridge is absent in older preloads and in partial test
      // harnesses. A missing optional subscription must degrade to "no
      // publication updates", never take down app initialization.
      const bridge = window.api?.sharedContainers;
      if (!bridge) {
        return (): void => {};
      }
      return bridge.onPublicationChanged((state) => {
        get().setPublicationState(state);
      });
    },

    setPublicationState: (state: SharedContainerPublicationState): void => {
      set((current) => ({
        publicationStates: {
          ...current.publicationStates,
          [publicationStateKey(
            state.projectId,
            state.worktreeId,
            state.organizationId,
          )]: state,
        },
      }));
    },

    reset: (): void => {
      accountHydrationEpoch += 1;
      accountHydrationPromise = null;
      accountHydrationQueued = false;
      sharedTargetsEpoch += 1;
      sharedTargetsPromise = null;
      set({
        accountHydrated: false,
        accountHydrationFailed: false,
        accountKind: 'unknown',
        organizations: [],
        teams: [],
        orgBillingStates: [],
        publicationStates: {},
        sharedTargets: {},
        sharedWorktrees: {},
      });
    },
  }),
);

/**
 * Read the account, then re-fan the owner listing over whatever organizations
 * that read produced.
 *
 * This is the *only* implementation of that chain, and every surface that
 * re-reads the account has to go through it: app init, the account-changed
 * listener, the invite modal's own connect callback, and its secure-storage
 * retry. Calling `hydrateAccount` on its own repopulates `organizations` for a
 * new or recovered account while `sharedTargets`/`sharedWorktrees` still hold
 * the previous account's entries, which leaves the sidebar badge and the
 * modal's publish-status fallback asserting the wrong account's shares until
 * the app restarts.
 *
 * The owner listing is fanned over `organizations`, so it can only run once
 * the account read has populated them - chained, not raced. Fire-and-forget by
 * design: both legs swallow their own failures, so this can never produce an
 * unhandled rejection during app initialization.
 */
export function hydrateSharedContainersAccount(options?: {
  refreshAfterCurrent?: boolean;
}): void {
  // A refresh means the account (and therefore the organization set) may
  // have changed underneath an in-flight fan-out. Bumping the epoch retires
  // that fan-out so its result cannot be written, and so the next call
  // starts a fresh one instead of awaiting the stale promise.
  if (options?.refreshAfterCurrent) invalidateSharedTargets();
  void (async (): Promise<void> => {
    try {
      await useSharedContainersStore.getState().hydrateAccount(options);
    } catch {
      // `hydrateAccount` already fails open internally; this only keeps an
      // unexpected throw from stopping the chain before the owner listing.
    }
    await useSharedContainersStore.getState().hydrateSharedTargets();
  })();
}

/**
 * Wire the store to account changes once, from the app shell. Returns a
 * teardown that removes the DOM listener, the IPC subscription, and the
 * feature-flag subscription.
 */
export function initializeSharedContainersStore(): () => void {
  const { subscribeToPublicationChanges } = useSharedContainersStore.getState();
  hydrateSharedContainersAccount();
  const onAccountChanged = (): void => {
    hydrateSharedContainersAccount({ refreshAfterCurrent: true });
  };
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onAccountChanged);
  const unsubscribe = subscribeToPublicationChanges();

  // Retry the owner listing when the rollout flag turns on mid-session.
  //
  // With `canopy-desktop-shared-containers` off, the main handler answers the
  // listing with a *complete* empty result and this store caches `{}`. The
  // flag can still flip to on later in the same session - LaunchDarkly
  // connecting after a boot-time timeout, or a live rollout toggle - which
  // reveals the invite entry points while `sharedWorktrees` is still that
  // cached `{}` with nothing left to re-fan it. The badge would then be
  // silently absent for the rest of the session.
  //
  // Edge-triggered on purpose: snapshots are broadcast for every flag, and
  // re-fanning the org-wide listing on each unrelated delivery would turn one
  // hydration per account into one per flag change.
  const flagKey = CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key;
  let sharedContainersEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(flagKey);
  const unsubscribeFlags = useFeatureFlagsStore.subscribe((state) => {
    const enabled = state.isEnabled(flagKey);
    if (enabled === sharedContainersEnabled) return;
    sharedContainersEnabled = enabled;
    // Only the disabled -> enabled edge. Turning the flag off hides the entry
    // points anyway, and dropping the cache there would only cost a re-fan if
    // it came back.
    if (enabled) hydrateSharedContainersAccount({ refreshAfterCurrent: true });
  });

  return () => {
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    unsubscribe();
    unsubscribeFlags();
  };
}
