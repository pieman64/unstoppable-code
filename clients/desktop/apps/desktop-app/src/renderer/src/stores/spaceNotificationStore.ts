// Renderer mirror of the main-owned per-space notification policy replica
// (CAN-3615). Main is the only writer: this store holds the last broadcast
// snapshot for synchronous delivery checks plus per-space menu progress.
// It hydrates at module load so toasts raised before any sidebar mounts are
// still gated, and it never claims a choice before main confirms it saved.

import { create } from 'zustand';
import type { SpaceNotificationClass } from '@canopy/protocol/space-notifications';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  evaluateScopedSpaceNotification,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
  SpaceNotificationSetStatus,
} from '@canopy/desktop-shared/types';
import {
  SPACE_NOTIFICATION_MENU_COPY,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
} from '@canopy/ui-shared/components';

interface SpaceMenuProgress {
  readonly status: 'loading' | 'saving' | 'failed';
  readonly pendingChoice?: SpaceNotificationMenuChoice;
  readonly failure?: string;
}

export interface SpaceNotificationStore {
  snapshot: SpaceNotificationPolicySnapshot;
  /** Menu progress per space key; absent means settled. */
  progress: Record<string, SpaceMenuProgress>;
  applySnapshot: (snapshot: SpaceNotificationPolicySnapshot) => void;
  refresh: (scope: SpaceNotificationScope) => Promise<void>;
  setChoice: (
    scope: SpaceNotificationScope,
    choice: SpaceNotificationMenuChoice,
  ) => Promise<void>;
}

/** Read lazily: the shared copy table is resolved when a save settles. */
function failureCopy(
  status: Exclude<SpaceNotificationSetStatus, 'saved'>,
): string {
  switch (status) {
    case 'conflict':
      return SPACE_NOTIFICATION_MENU_COPY.changedElsewhere;
    case 'unavailable':
      return SPACE_NOTIFICATION_MENU_COPY.loadFailed;
    case 'disabled':
      return SPACE_NOTIFICATION_MENU_COPY.writesClosed;
    case 'busy':
      return SPACE_NOTIFICATION_MENU_COPY.deliveryInProgress;
    case 'failed':
      return SPACE_NOTIFICATION_MENU_COPY.saveFailed;
  }
}

function getApi(): typeof window.api.spaceNotifications | undefined {
  return typeof window !== 'undefined'
    ? window.api?.spaceNotifications
    : undefined;
}

function withoutKey(
  progress: Record<string, SpaceMenuProgress>,
  key: string,
): Record<string, SpaceMenuProgress> {
  if (!(key in progress)) return progress;
  const next = { ...progress };
  delete next[key];
  return next;
}

export const useSpaceNotificationStore = create<SpaceNotificationStore>(
  (set, get) => ({
    snapshot: EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    progress: {},
    applySnapshot: (snapshot): void => {
      // Another account's progress and pending saves never carry over.
      const accountChanged = snapshot.accountKey !== get().snapshot.accountKey;
      set((state) => ({
        snapshot,
        progress: accountChanged ? {} : state.progress,
      }));
    },
    refresh: async (scope): Promise<void> => {
      const api = getApi();
      const key = spaceNotificationScopeKey(scope);
      const accountKey = get().snapshot.accountKey;
      if (!api || !accountKey) return;
      const current = get().progress[key];
      if (current?.status === 'saving' || current?.status === 'loading') return;
      const unknown = !get().snapshot.spaces[key];
      // Read quietly where the menu already omits the group: a first read
      // that failed, or any unknown space while main has never synced with
      // the cloud. Flashing "Loading…" there would add a group that then
      // vanishes, and the menu would resize and jump under the pointer.
      const quiet =
        unknown &&
        (current?.status === 'failed' || get().snapshot.syncedAt === null);
      if (unknown && !quiet) {
        set((state) => ({
          progress: { ...state.progress, [key]: { status: 'loading' } },
        }));
      }
      try {
        get().applySnapshot(await api.refresh(scope));
      } catch {
        // A failed read keeps the last acknowledged choice; an unknown space
        // is marked failed below, so callers never see an unhandled rejection.
      } finally {
        if (get().snapshot.accountKey === accountKey) {
          set((state) => {
            const settled = state.progress[key];
            const reading =
              settled?.status === 'loading' ||
              (quiet && (settled === undefined || settled.status === 'failed'));
            if (!reading) return state;
            if (state.snapshot.spaces[key]) {
              return settled === undefined
                ? state
                : { progress: withoutKey(state.progress, key) };
            }
            return {
              progress: {
                ...state.progress,
                [key]: {
                  status: 'failed',
                  failure: SPACE_NOTIFICATION_MENU_COPY.loadFailed,
                },
              },
            };
          });
        }
      }
    },
    setChoice: async (scope, requested): Promise<void> => {
      // All activity is stored as no override; send and compare it that way.
      const choice = requested === 'all' ? null : requested;
      const api = getApi();
      const key = spaceNotificationScopeKey(scope);
      const { snapshot, progress } = get();
      const space = snapshot.spaces[key];
      // One save at a time per space, never against an unknown revision.
      if (!api || !snapshot.accountKey || !space) return;
      if (
        progress[key]?.status === 'saving' ||
        progress[key]?.status === 'loading'
      )
        return;
      if (!snapshot.writesEnabled || space.override === choice) return;
      const accountKey = snapshot.accountKey;
      set((state) => ({
        progress: {
          ...state.progress,
          [key]: { status: 'saving', pendingChoice: choice },
        },
      }));
      let status: SpaceNotificationSetStatus = 'failed';
      try {
        const result = await api.set({
          ...scope,
          override: choice,
          expectedRevision: space.revision,
        });
        status = result.status;
        get().applySnapshot(result.snapshot);
      } catch {
        status = 'failed';
      }
      if (get().snapshot.accountKey !== accountKey) return;
      set((state) => ({
        progress:
          status === 'saved'
            ? withoutKey(state.progress, key)
            : {
                ...state.progress,
                [key]: { status: 'failed', failure: failureCopy(status) },
              },
      }));
    },
  }),
);

/** The menu state for one space, from the snapshot plus its progress. */
export function spaceNotificationMenuStateFor(
  state: Pick<SpaceNotificationStore, 'snapshot' | 'progress'>,
  scope: SpaceNotificationScope,
): SpaceNotificationMenuState {
  const key = spaceNotificationScopeKey(scope);
  const progress = state.progress[key];
  const space = state.snapshot.spaces[key];
  if (!state.snapshot.accountKey) {
    return {
      status: 'ready',
      selectionKnown: false,
      override: null,
      disabledReason: SPACE_NOTIFICATION_MENU_COPY.signIn,
    };
  }
  if (!space) {
    // Main has never reached the cloud this session, so this space's choice
    // cannot load: report the failed first read up front, and the menu omits
    // the group instead of opening with one that then disappears.
    if (state.snapshot.syncedAt === null && progress?.status !== 'loading') {
      return {
        status: 'failed',
        selectionKnown: false,
        override: null,
        failure: progress?.failure ?? SPACE_NOTIFICATION_MENU_COPY.loadFailed,
        disabledReason: SPACE_NOTIFICATION_MENU_COPY.loadFailed,
      };
    }
    return {
      status:
        progress?.status === 'failed'
          ? 'failed'
          : progress?.status === 'loading'
            ? 'loading'
            : 'ready',
      selectionKnown: false,
      override: null,
      failure: progress?.failure,
      disabledReason:
        progress?.status === 'loading'
          ? undefined
          : SPACE_NOTIFICATION_MENU_COPY.loadFailed,
    };
  }
  return {
    status: progress?.status ?? 'ready',
    override: space.override,
    pendingChoice: progress?.pendingChoice,
    failure: progress?.failure,
    disabledReason: state.snapshot.writesEnabled
      ? undefined
      : SPACE_NOTIFICATION_MENU_COPY.writesClosed,
  };
}

/**
 * A chat or pipeline occurrence's originating space and typed meaning. Carried
 * by every delivery of chat or pipeline activity, so a known scoped event can
 * never be delivered as if it were unscoped.
 */
export interface ScopedNotificationDescriptor extends SpaceNotificationScope {
  eventClass: SpaceNotificationClass;
  /** Local time of the occurrence; defaults to the time of delivery. */
  occurredAt?: number;
}

/**
 * Whether a scoped chat or pipeline occurrence may raise a popup or native
 * notification now. Recording never calls this. Synchronous: it reads the
 * last broadcast snapshot.
 */
export function isSpaceNotificationDeliverable(
  scope: SpaceNotificationScope,
  eventClass: SpaceNotificationClass,
  occurredAtMs: number = Date.now(),
): boolean {
  return (
    evaluateScopedSpaceNotification(
      useSpaceNotificationStore.getState().snapshot,
      scope,
      eventClass,
      occurredAtMs,
    ) === 'eligible'
  );
}

let bridgeStarted = false;

/** Attach to main's broadcasts once; safe to call repeatedly. */
export function startSpaceNotificationBridge(): void {
  const api = getApi();
  if (bridgeStarted || !api?.onChanged) return;
  bridgeStarted = true;
  let broadcastSeen = false;
  api.onChanged((snapshot) => {
    broadcastSeen = true;
    useSpaceNotificationStore.getState().applySnapshot(snapshot);
  });
  void api
    .getSnapshot()
    .then((snapshot) => {
      // A broadcast is always at least as new as this initial read.
      if (!broadcastSeen)
        useSpaceNotificationStore.getState().applySnapshot(snapshot);
    })
    .catch(() => {
      // Main has not registered the channel yet; the broadcast delivers the
      // first snapshot instead.
    });
}

startSpaceNotificationBridge();

export function isScopedNotificationDeliverable(
  descriptor: ScopedNotificationDescriptor,
): boolean {
  return isSpaceNotificationDeliverable(
    descriptor,
    descriptor.eventClass,
    descriptor.occurredAt,
  );
}
