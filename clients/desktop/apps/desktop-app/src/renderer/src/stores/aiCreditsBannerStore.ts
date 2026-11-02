import { create } from 'zustand';
import type { AgentProviderType } from '@canopy/desktop-shared/types';

/**
 * Target-keyed AI Credits banner state (CAN-838).
 *
 * Every chat surface — worktree, standalone (cowork), App Advisor, pipeline
 * editor, plan-explore, and any future surface — emits session events through
 * the single `IPC_CHANNELS.chatEvent` pipeline. The central chat-event
 * subscription feeds authoritative routing status and usage-limit signals into
 * this store keyed by the chat's `{projectId, worktreeId, chatId}`, so shared
 * banner components rendered in the universal `ChatInput` reflect the true state
 * on every surface without per-surface wiring. New surfaces inherit them free.
 */
export interface ChatBannerTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export function chatBannerKey(target: ChatBannerTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

/** A reached native-provider usage limit for one chat. */
export interface UsageLimitBannerInfo {
  provider: AgentProviderType;
  /** Soonest quota-window reset (ms since epoch), when known. */
  resetsAt?: number;
  /** Stable identity for the reached window, used for dismissal. */
  dismissKey: string;
  /**
   * Set when a switch back to the subscription restored the limit rather than
   * a turn reaching it, so no interrupted turn waits to continue (CAN-4756).
   */
  restoredBySwitch?: true;
}

function usageLimitDismissKey(
  provider: AgentProviderType,
  resetsAt?: number,
): string {
  return `${provider}:${typeof resetsAt === 'number' ? resetsAt : ''}`;
}

/**
 * A turn that reached the hosted gateway with nothing to bill it to (CAN-2413).
 *
 * Distinct from {@link UsageLimitBannerInfo}: a usage limit is a native
 * provider quota that resets on a clock, while this is an empty credit balance
 * that only a purchase clears. It carries no `dismissKey` because there is no
 * window to dismiss — it stays until the user acts or sends again.
 */
export interface NoBillingSourceSignal {
  provider: AgentProviderType;
  /** When the runtime failure was observed (ms since epoch). */
  detectedAt: number;
}

interface AiCreditsBannerStore {
  /** True when the identified session is actively routing through AI Credits. */
  routingActiveByChat: Record<string, { active: boolean; updatedAt: number }>;
  /** Latest reached usage limit per chat (undefined when none/cleared). */
  usageLimitByChat: Record<string, UsageLimitBannerInfo | undefined>;
  /** Latest runtime no-billing-source failure per chat. */
  noBillingSourceByChat: Record<string, NoBillingSourceSignal | undefined>;
  /** Dismiss key the user acknowledged per chat, to suppress re-showing it. */
  dismissedUsageLimitKeyByChat: Record<string, string>;
  /** Apply an authoritative routing-status update from the main process. */
  setRoutingActive: (target: ChatBannerTarget, active: boolean) => void;
  /** Record a reached usage limit from the main process. */
  setUsageLimit: (
    target: ChatBannerTarget,
    info: { provider: AgentProviderType; resetsAt?: number },
  ) => void;
  /**
   * Show a known usage limit again after the user leaves AI Credits for a
   * still-limited subscription (CAN-4759). Unlike `setUsageLimit`, it clears a
   * prior dismissal, because the user just chose to bill the limited provider.
   * A newer limit already recorded for the same provider is kept.
   */
  restoreUsageLimit: (
    target: ChatBannerTarget,
    info: { provider: AgentProviderType; resetsAt?: number },
  ) => void;
  /** Record a runtime no-billing-source failure from the main process. */
  setNoBillingSource: (
    target: ChatBannerTarget,
    info: { provider: AgentProviderType; detectedAt?: number },
  ) => void;
  /** Acknowledge (dismiss) the current usage-limit banner for a chat. */
  dismissUsageLimit: (target: ChatBannerTarget, dismissKey: string) => void;
  /** Drop only usage-limit banner state while preserving routing status. */
  clearUsageLimitForChat: (target: ChatBannerTarget) => void;
  /** Drop only the runtime no-billing-source signal for a chat. */
  clearNoBillingSourceForChat: (target: ChatBannerTarget) => void;
  /** Drop all banner state for a chat (e.g. tab/worktree removal). */
  clearForChat: (target: ChatBannerTarget) => void;
}

export const useAiCreditsBannerStore = create<AiCreditsBannerStore>((set) => ({
  routingActiveByChat: {},
  usageLimitByChat: {},
  noBillingSourceByChat: {},
  dismissedUsageLimitKeyByChat: {},
  setRoutingActive: (target, active): void => {
    const key = chatBannerKey(target);
    set((state) => {
      return {
        routingActiveByChat: {
          ...state.routingActiveByChat,
          [key]: { active, updatedAt: Date.now() },
        },
      };
    });
  },
  setUsageLimit: (target, info): void => {
    const key = chatBannerKey(target);
    const dismissKey = usageLimitDismissKey(info.provider, info.resetsAt);
    set((state) => {
      const existing = state.usageLimitByChat[key];
      if (existing?.dismissKey === dismissKey) {
        return state;
      }
      return {
        usageLimitByChat: {
          ...state.usageLimitByChat,
          [key]: {
            provider: info.provider,
            resetsAt: info.resetsAt,
            dismissKey,
          },
        },
      };
    });
  },
  restoreUsageLimit: (target, info): void => {
    const key = chatBannerKey(target);
    const dismissKey = usageLimitDismissKey(info.provider, info.resetsAt);
    set((state) => {
      const existing = state.usageLimitByChat[key];
      // Never roll a later reset for the same provider back to the captured one.
      const keepExisting =
        existing?.dismissKey === dismissKey ||
        (existing?.provider === info.provider &&
          typeof existing.resetsAt === 'number' &&
          (info.resetsAt === undefined || existing.resetsAt > info.resetsAt));
      const nextDismissed = { ...state.dismissedUsageLimitKeyByChat };
      delete nextDismissed[key];
      return {
        usageLimitByChat: keepExisting
          ? state.usageLimitByChat
          : {
              ...state.usageLimitByChat,
              [key]: {
                provider: info.provider,
                resetsAt: info.resetsAt,
                dismissKey,
                restoredBySwitch: true,
              },
            },
        dismissedUsageLimitKeyByChat: nextDismissed,
      };
    });
  },
  setNoBillingSource: (target, info): void => {
    const key = chatBannerKey(target);
    set((state) => {
      const existing = state.noBillingSourceByChat[key];
      // Same provider already flagged: keep the original `detectedAt` so a
      // repeated failure inside one turn does not churn the store (and every
      // subscribed composer) with a new object identity.
      if (existing?.provider === info.provider) {
        return state;
      }
      return {
        noBillingSourceByChat: {
          ...state.noBillingSourceByChat,
          [key]: {
            provider: info.provider,
            detectedAt: info.detectedAt ?? Date.now(),
          },
        },
      };
    });
  },
  dismissUsageLimit: (target, dismissKey): void => {
    const key = chatBannerKey(target);
    set((state) => {
      if (state.dismissedUsageLimitKeyByChat[key] === dismissKey) {
        return state;
      }
      return {
        dismissedUsageLimitKeyByChat: {
          ...state.dismissedUsageLimitKeyByChat,
          [key]: dismissKey,
        },
      };
    });
  },
  clearUsageLimitForChat: (target): void => {
    const key = chatBannerKey(target);
    set((state) => {
      const nextUsage = { ...state.usageLimitByChat };
      const nextDismissed = { ...state.dismissedUsageLimitKeyByChat };
      delete nextUsage[key];
      delete nextDismissed[key];
      return {
        usageLimitByChat: nextUsage,
        dismissedUsageLimitKeyByChat: nextDismissed,
      };
    });
  },
  clearNoBillingSourceForChat: (target): void => {
    const key = chatBannerKey(target);
    set((state) => {
      if (state.noBillingSourceByChat[key] === undefined) {
        return state;
      }
      const next = { ...state.noBillingSourceByChat };
      delete next[key];
      return { noBillingSourceByChat: next };
    });
  },
  clearForChat: (target): void => {
    const key = chatBannerKey(target);
    set((state) => {
      const nextRouting = { ...state.routingActiveByChat };
      const nextUsage = { ...state.usageLimitByChat };
      const nextNoBillingSource = { ...state.noBillingSourceByChat };
      const nextDismissed = { ...state.dismissedUsageLimitKeyByChat };
      delete nextRouting[key];
      delete nextUsage[key];
      delete nextNoBillingSource[key];
      delete nextDismissed[key];
      return {
        routingActiveByChat: nextRouting,
        usageLimitByChat: nextUsage,
        noBillingSourceByChat: nextNoBillingSource,
        dismissedUsageLimitKeyByChat: nextDismissed,
      };
    });
  },
}));

/** Reactive selector: is the given chat currently routing through AI Credits? */
export function useAiCreditsRoutingActive(
  target: ChatBannerTarget | null,
): boolean {
  return useAiCreditsBannerStore((state) =>
    target
      ? (state.routingActiveByChat[chatBannerKey(target)]?.active ?? false)
      : false,
  );
}

/**
 * Pure selector: the visible (undismissed) usage-limit banner for a chat, or
 * `null` when none is active or it was dismissed. Exported for direct testing.
 */
export function selectVisibleUsageLimitBanner(
  state: Pick<
    AiCreditsBannerStore,
    'usageLimitByChat' | 'dismissedUsageLimitKeyByChat'
  >,
  target: ChatBannerTarget | null,
): UsageLimitBannerInfo | null {
  if (!target) return null;
  const key = chatBannerKey(target);
  const info = state.usageLimitByChat[key];
  if (!info) return null;
  if (state.dismissedUsageLimitKeyByChat[key] === info.dismissKey) {
    return null;
  }
  return info;
}

/**
 * Reactive selector: the runtime no-billing-source signal for a chat, or `null`
 * when the chat has not hit one (or it was cleared by a dispatched send).
 */
export function useNoBillingSourceSignal(
  target: ChatBannerTarget | null,
): NoBillingSourceSignal | null {
  return useAiCreditsBannerStore((state) =>
    target
      ? (state.noBillingSourceByChat[chatBannerKey(target)] ?? null)
      : null,
  );
}

/**
 * Reactive selector: the visible (undismissed) usage-limit banner for a chat, or
 * `null` when none is active or it was dismissed.
 */
export function useVisibleUsageLimitBanner(
  target: ChatBannerTarget | null,
): UsageLimitBannerInfo | null {
  return useAiCreditsBannerStore((state) =>
    selectVisibleUsageLimitBanner(state, target),
  );
}
