import { create } from 'zustand';
import type { ResumeQueueSnapshot } from '@canopy/desktop-shared/types';
import { useUsageLimitResumePromptStore } from './usageLimitResumePromptStore';

interface ResumeQueueState {
  snapshot: ResumeQueueSnapshot | null;
  isOpen: boolean;
  connectionError: string | null;
  apply: (snapshot: ResumeQueueSnapshot) => void;
  open: () => void;
  close: () => void;
}
export const useResumeQueueStore = create<ResumeQueueState>((set, get) => ({
  snapshot: null,
  isOpen: false,
  connectionError: null,
  apply: (snapshot): void => {
    const previous = get().snapshot;
    if (previous && snapshot.revision < previous.revision) return;
    set({ snapshot, connectionError: null });
  },
  open: (): void => {
    useUsageLimitResumePromptStore.getState().close();
    set({ isOpen: true });
  },
  close: (): void => set({ isOpen: false }),
}));

export function resumeQueueProgress(snapshot: ResumeQueueSnapshot): {
  waiting: number;
  resuming: number;
  resumed: number;
  processed: number;
  total: number;
  active: boolean;
  percentage: number;
} {
  const waiting = snapshot.entries.filter(
    (entry) => entry.status === 'waiting',
  ).length;
  const resuming = snapshot.entries.filter(
    (entry) => entry.status === 'resuming',
  ).length;
  const resumed = snapshot.entries.filter(
    (entry) => entry.status === 'resumed',
  ).length;
  const processed = snapshot.entries.length - waiting - resuming;
  return {
    waiting,
    resuming,
    resumed,
    processed,
    total: snapshot.entries.length,
    active: waiting + resuming > 0,
    percentage: snapshot.entries.length
      ? (processed / snapshot.entries.length) * 100
      : 0,
  };
}
