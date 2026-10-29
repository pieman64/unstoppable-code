import { create } from 'zustand';
import type {
  AgentProviderType,
  TransientRetryStateEventData,
} from '@canopy/desktop-shared/types';
import {
  chatBannerKey,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';

/**
 * Target-keyed transient-retry banner state.
 *
 * When a chat turn hits a transient provider error (overload, 5xx, connection
 * drop), the main-process chat retry service drives the retry state machine and
 * pushes {@link TransientRetryStateEventData} through the single
 * `IPC_CHANNELS.chatEvent` pipeline. The central chat-event subscription feeds
 * those pushes into this store keyed by `{projectId, worktreeId, chatId}`
 * (reusing the AI Credits banner target keying), so the shared
 * `TransientRetryBanner` rendered in the universal `ChatInput` reflects the true
 * retry state on every chat surface without per-surface wiring.
 *
 * The renderer is a pure view of pushed state: `setState` stores exactly what
 * the main process reported and deletes the entry when a cycle ends (an
 * `active: false` push), so there is no local schedule/attempt computation.
 */
export interface TransientRetryBannerInfo {
  /** Native harness whose transient failure is being retried. */
  provider: AgentProviderType;
  /** 1-based current attempt. */
  attempt: number;
  /** Total attempts before giving up. */
  maxAttempts: number;
  /** Epoch ms of the next scheduled retry, or `null` when exhausted. */
  nextRetryAt: number | null;
  /** True once all attempts are used. */
  exhausted: boolean;
}

interface TransientRetryBannerStore {
  /** Latest retry state per chat (absent when no cycle is active). */
  stateByChat: Record<string, TransientRetryBannerInfo | undefined>;
  /**
   * Apply an authoritative retry-state push from the main process. An
   * `active: false` event ends the cycle and drops the entry so the banner
   * hides.
   */
  setState: (
    target: ChatBannerTarget,
    info: TransientRetryStateEventData,
  ) => void;
  /** Drop retry-banner state for a chat (dismissal / tab or worktree removal). */
  clearForChat: (target: ChatBannerTarget) => void;
}

export const useTransientRetryBannerStore = create<TransientRetryBannerStore>(
  (set) => ({
    stateByChat: {},
    setState: (target, info): void => {
      const key = chatBannerKey(target);
      set((state) => {
        const next = { ...state.stateByChat };
        if (!info.active) {
          delete next[key];
        } else {
          next[key] = {
            provider: info.provider,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            nextRetryAt: info.nextRetryAt,
            exhausted: info.exhausted,
          };
        }
        return { stateByChat: next };
      });
    },
    clearForChat: (target): void => {
      const key = chatBannerKey(target);
      set((state) => {
        if (!(key in state.stateByChat)) return state;
        const next = { ...state.stateByChat };
        delete next[key];
        return { stateByChat: next };
      });
    },
  }),
);

/** Reactive selector: the current transient-retry state for a chat, or null. */
export function useTransientRetryState(
  target: ChatBannerTarget | null,
): TransientRetryBannerInfo | null {
  return useTransientRetryBannerStore((state) =>
    target ? (state.stateByChat[chatBannerKey(target)] ?? null) : null,
  );
}
