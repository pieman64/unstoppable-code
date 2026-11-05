import { useEffect } from 'react';
import { create } from 'zustand';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  isMergeQueueAgentHandling,
  type MergeQueueAgentHandling,
} from '@canopy/desktop-shared/types/github';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

interface MergeQueueAgentHandlingState {
  handling: MergeQueueAgentHandling;
  load: () => Promise<void>;
}

let loadStarted = false;

function handlingFrom(prefs: PreferencesData): MergeQueueAgentHandling {
  return isMergeQueueAgentHandling(prefs.mergeQueueAgentHandling)
    ? prefs.mergeQueueAgentHandling
    : DEFAULT_MERGE_QUEUE_AGENT_HANDLING;
}

/**
 * Shared, lazily loaded snapshot of the Settings > Git merge queue choice
 * that decides what the Merge button does on a merge queue pull request.
 *
 * Every worktree's status bar reads it, so it is loaded once and kept in
 * sync through the same-renderer `canopy:preferences-updated` event that
 * Settings emits after saving. Until the load resolves, the default (which
 * the main process also applies) stands in.
 */
export const useMergeQueueAgentHandlingStore =
  create<MergeQueueAgentHandlingState>((set) => ({
    handling: DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
    load: async (): Promise<void> => {
      if (loadStarted) return;
      loadStarted = true;
      try {
        const prefs: PreferencesData = await window.api.loadPreferences();
        set({ handling: handlingFrom(prefs) });
      } catch {
        // Preferences unavailable: keep the default and let a later
        // subscriber retry.
        loadStarted = false;
      }
    },
  }));

subscribePreferencesUpdated((prefs) => {
  useMergeQueueAgentHandlingStore.setState({ handling: handlingFrom(prefs) });
});

/**
 * Reactive read of the merge queue agent handling setting. Triggers the
 * shared one-time load on first mount.
 */
export function useMergeQueueAgentHandling(): MergeQueueAgentHandling {
  const load = useMergeQueueAgentHandlingStore((state) => state.load);
  useEffect(() => {
    void load();
  }, [load]);
  return useMergeQueueAgentHandlingStore((state) => state.handling);
}
