import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ChatIngestionLag } from '@canopy/desktop-shared/types';
import {
  chatBannerKey,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';

export const INGESTION_LAG_STALE_AFTER_MS = 10_000;

/**
 * Main-process ingestion samples are ephemeral, use main's clock, and are
 * displayed for at most ten seconds so a lost clear cannot stick indefinitely.
 */
interface IngestionLagEntry extends ChatBannerTarget {
  lag: ChatIngestionLag;
}

interface IngestionLagStore {
  lagByChat: Record<string, IngestionLagEntry | undefined>;
  setLag: (target: ChatBannerTarget, lag: ChatIngestionLag | null) => void;
  clearForChat: (target: ChatBannerTarget) => void;
  clearForScope: (projectId: string, worktreeId: string) => void;
}

function targetsMatch(
  entry: IngestionLagEntry,
  target: ChatBannerTarget,
): boolean {
  return (
    entry.projectId === target.projectId &&
    entry.worktreeId === target.worktreeId &&
    entry.chatId === target.chatId
  );
}

function lagsMatch(left: ChatIngestionLag, right: ChatIngestionLag): boolean {
  return (
    left.lagMs === right.lagMs &&
    left.source === right.source &&
    left.sampledAtMs === right.sampledAtMs &&
    left.catchingUp === right.catchingUp
  );
}

export const useIngestionLagStore = create<IngestionLagStore>((set) => ({
  lagByChat: {},
  setLag: (target, lag): void => {
    const key = chatBannerKey(target);
    set((state) => {
      const existing = state.lagByChat[key];
      if (lag === null) {
        if (!existing || !targetsMatch(existing, target)) return state;
        const lagByChat = { ...state.lagByChat };
        delete lagByChat[key];
        return { lagByChat };
      }
      if (
        existing &&
        targetsMatch(existing, target) &&
        lagsMatch(existing.lag, lag)
      ) {
        return state;
      }
      return {
        lagByChat: {
          ...state.lagByChat,
          [key]: {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
            lag,
          },
        },
      };
    });
  },
  clearForChat: (target): void => {
    const key = chatBannerKey(target);
    set((state) => {
      const existing = state.lagByChat[key];
      if (!existing || !targetsMatch(existing, target)) return state;
      const lagByChat = { ...state.lagByChat };
      delete lagByChat[key];
      return { lagByChat };
    });
  },
  clearForScope: (projectId, worktreeId): void => {
    set((state) => {
      let lagByChat: Record<string, IngestionLagEntry | undefined> | null =
        null;
      for (const [key, entry] of Object.entries(state.lagByChat)) {
        if (entry?.projectId === projectId && entry.worktreeId === worktreeId) {
          lagByChat ??= { ...state.lagByChat };
          delete lagByChat[key];
        }
      }
      return lagByChat === null ? state : { lagByChat };
    });
  },
}));

export function visibleCatchingUpLag(
  entryLag: ChatIngestionLag | null | undefined,
  nowMs: number,
): ChatIngestionLag | null {
  if (
    !entryLag ||
    !entryLag.catchingUp ||
    nowMs - entryLag.sampledAtMs > INGESTION_LAG_STALE_AFTER_MS
  ) {
    return null;
  }
  return entryLag;
}

export function useCatchingUpLag(
  target: ChatBannerTarget | null,
): ChatIngestionLag | null {
  const lag = useIngestionLagStore((state) =>
    target ? (state.lagByChat[chatBannerKey(target)]?.lag ?? null) : null,
  );
  const [, setRenderVersion] = useState(0);
  const visibleLag = visibleCatchingUpLag(lag, Date.now());

  useEffect(() => {
    if (!visibleLag) return undefined;
    const untilStaleMs =
      visibleLag.sampledAtMs + INGESTION_LAG_STALE_AFTER_MS - Date.now() + 1;
    const timer = window.setTimeout(
      (): void => setRenderVersion((version) => version + 1),
      Math.max(0, untilStaleMs),
    );
    return (): void => window.clearTimeout(timer);
  }, [visibleLag]);

  return visibleLag;
}
