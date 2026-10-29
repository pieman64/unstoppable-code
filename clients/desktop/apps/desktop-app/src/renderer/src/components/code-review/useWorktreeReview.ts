import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { CodeReviewGetResponse } from '@canopy/desktop-shared/types';

interface Entry extends Partial<CodeReviewGetResponse> {
  error?: string;
}
const EMPTY: Entry = {};
const useArtifacts = create<{ entries: Record<string, Entry> }>(() => ({
  entries: {},
}));
const subscriptions = new Map<string, { users: number; release: () => void }>();

/** Shared worktree artifacts, with no selected file, modal, or chat owner. */
export function useWorktreeReview(
  projectId: string,
  worktreeId: string,
  enabled: boolean,
  visible: boolean,
): Entry {
  const key = `${projectId}/${worktreeId}`;
  const entry = useArtifacts((state) => state.entries[key] ?? EMPTY);
  const [consumerId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!enabled) return;
    let subscription = subscriptions.get(key);
    if (!subscription) {
      let disposed = false;
      let updated = false;
      const put = (entry: Entry): void =>
        useArtifacts.setState((state) => ({
          entries: { ...state.entries, [key]: entry },
        }));
      const unsubscribe = window.api.codeReview.onUpdated((event) => {
        if (event.projectId === projectId && event.worktreeId === worktreeId) {
          updated = true;
          put(event);
        }
      });
      void window.api.codeReview
        .get({ projectId, worktreeId })
        .then((result) => {
          if (!disposed && !updated) put(result);
        })
        .catch((error: unknown) => {
          if (!disposed)
            put({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load review artifacts.',
            });
        });
      subscription = {
        users: 0,
        release: (): void => {
          disposed = true;
          unsubscribe();
          useArtifacts.setState((state) => {
            const entries = { ...state.entries };
            delete entries[key];
            return { entries };
          });
        },
      };
      subscriptions.set(key, subscription);
    }
    subscription.users += 1;
    return (): void => {
      if (--subscription.users === 0) {
        subscription.release();
        subscriptions.delete(key);
      }
    };
  }, [enabled, key, projectId, worktreeId]);
  useEffect(() => {
    if (!enabled || !visible) return;
    void window.api.codeReview.setModalOpen({
      projectId,
      worktreeId,
      consumerId,
      open: true,
    });
    return (): void => {
      void window.api.codeReview.setModalOpen({
        projectId,
        worktreeId,
        consumerId,
        open: false,
      });
    };
  }, [enabled, visible, projectId, worktreeId, consumerId]);
  return enabled ? entry : EMPTY;
}
