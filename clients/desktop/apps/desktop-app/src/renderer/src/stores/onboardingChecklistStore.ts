// Renderer-side mirror of the persistent sidebar onboarding checklist
// (CAN-788). The main process is the source of truth: this store hydrates
// from `window.api.onboardingChecklist.getState()` and stays in sync via the
// `onboarding-checklist:changed` broadcast. Item completion is derived
// main-side from real product state — the one renderer-derived item
// (`connect-accounts`, whose provider auth probes live in renderer hooks) is
// latched through `markConnectAccountsComplete()`.

import { create } from 'zustand';
import type {
  OnboardingChecklistProvider,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';

/**
 * Minimum time "Remind me later" must hide the checklist for.
 *
 * Next-local-midnight alone is not enough: dismissing at 23:58 puts the
 * deadline two minutes out, and the snooze re-reveal timer in
 * `SidebarOnboardingChecklist` pops the card back inside the same sitting.
 * That satisfies "the following day" on a technicality while missing the
 * intent entirely, and reads as the control being broken.
 */
const MIN_ONBOARDING_CHECKLIST_REMINDER_MS = 6 * 60 * 60 * 1000;

/**
 * Deadline for "Remind me later" (CAN-2665): the start of the next local day,
 * floored so a late-evening dismissal cannot come straight back.
 *
 * A week was too long — dismissing mid-setup means "not right now", not "not
 * this week". Next-local-midnight rather than a flat +24h so an evening
 * dismissal returns the following morning instead of at 11pm the next night,
 * and so the delay reads as the "tomorrow" the label implies. The floor only
 * ever pushes the deadline later, so the ordinary daytime case is unchanged.
 *
 * Exported for tests; takes `now` so the late-evening boundary can be
 * exercised without faking the clock.
 */
export function nextOnboardingChecklistReminderAt(
  now: Date = new Date(),
): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);
  return new Date(
    Math.max(
      midnight.getTime(),
      now.getTime() + MIN_ONBOARDING_CHECKLIST_REMINDER_MS,
    ),
  );
}

export interface OnboardingChecklistStore {
  state: OnboardingChecklistState | null;
  hydrated: boolean;
  /**
   * Lazily mount the `onboarding-checklist:changed` subscription. Returns an
   * unsubscribe handle so `useEffect` cleanup can detach the underlying IPC
   * listener on unmount.
   */
  subscribeBridge: () => () => void;
  /** Snapshot the computed checklist state from the main process. */
  hydrate: () => Promise<void>;
  /**
   * Re-derive the snapshot. Called when the panel opens, and when a snooze
   * deadline lapses while the app stays open. Main pushes its own
   * `onboarding-checklist:changed` broadcast for the signals it owns (first
   * chat send, cloud sign-in/out), so this is no longer wired to the
   * preferences / automations / workspace-list surfaces the pre-CAN-2663 step
   * set depended on.
   */
  refresh: () => Promise<void>;
  dismiss: () => Promise<void>;
  snooze: () => Promise<void>;
  restore: () => Promise<void>;
  setProviderNotUsed: (
    provider: OnboardingChecklistProvider,
    notUsed: boolean,
  ) => Promise<void>;
  markConnectAccountsComplete: () => Promise<void>;
}

function getApi(): typeof window.api.onboardingChecklist | undefined {
  return typeof window !== 'undefined'
    ? window.api?.onboardingChecklist
    : undefined;
}

type SetState = (partial: Partial<OnboardingChecklistStore>) => void;

async function runMutation(
  set: SetState,
  call: (
    api: NonNullable<ReturnType<typeof getApi>>,
  ) => Promise<OnboardingChecklistState>,
): Promise<void> {
  const api = getApi();
  if (!api) return;
  try {
    const state = await call(api);
    set({ state, hydrated: true });
  } catch {
    // Checklist mutations are best-effort UI affordances; the broadcast (or
    // the next refresh) reconciles state if one fails.
  }
}

export const useOnboardingChecklistStore = create<OnboardingChecklistStore>(
  (set, get) => ({
    state: null,
    hydrated: false,
    subscribeBridge: (): (() => void) => {
      const api = getApi();
      if (!api?.onChanged) {
        return (): void => undefined;
      }
      return api.onChanged((state) => {
        set({ state, hydrated: true });
      });
    },
    hydrate: async (): Promise<void> => {
      const api = getApi();
      if (!api?.getState) {
        // Renderer is mounted without the preload bridge (e.g. unit tests).
        // Mark the store hydrated so consumers stop waiting.
        set({ hydrated: true });
        return;
      }
      try {
        const state = await api.getState();
        set({ state, hydrated: true });
      } catch {
        set({ hydrated: true });
      }
    },
    refresh: async (): Promise<void> => {
      await runMutation(set, (api) => api.getState());
    },
    dismiss: async (): Promise<void> => {
      await runMutation(set, (api) => api.dismiss());
    },
    snooze: async (): Promise<void> => {
      const until = nextOnboardingChecklistReminderAt().toISOString();
      await runMutation(set, (api) => api.snooze({ until }));
    },
    restore: async (): Promise<void> => {
      await runMutation(set, (api) => api.restore());
    },
    setProviderNotUsed: async (provider, notUsed): Promise<void> => {
      await runMutation(set, (api) =>
        api.setProviderNotUsed({ provider, notUsed }),
      );
    },
    markConnectAccountsComplete: async (): Promise<void> => {
      const items = get().state?.items;
      const alreadyComplete =
        items?.some(
          (item) => item.id === 'connect-accounts' && item.complete,
        ) === true;
      if (alreadyComplete) return;
      await runMutation(set, (api) =>
        api.markItemComplete({ itemId: 'connect-accounts' }),
      );
    },
  }),
);
