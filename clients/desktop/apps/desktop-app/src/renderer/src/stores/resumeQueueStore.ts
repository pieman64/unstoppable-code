import { create } from 'zustand';
import type {
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';
import { useUsageLimitResumePromptStore } from './usageLimitResumePromptStore';

interface ResumeQueueState {
  snapshot: ResumeQueueSnapshot | null;
  isOpen: boolean;
  connectionError: string | null;
  /** A failed attempt to open a queued session, shown in the queue dialog. */
  navigationError: string | null;
  /** UI destination checks in flight; preserve their queue retry route. */
  pendingNavigationCount: number;
  apply: (snapshot: ResumeQueueSnapshot) => void;
  open: () => void;
  /** Open the queue as the retry route for a session that could not open. */
  openWithNavigationError: (message: string) => void;
  clearNavigationError: () => void;
  beginNavigation: () => void;
  endNavigation: () => void;
  close: () => void;
  /** Share one dismissal across Done, clean Close, and the sidebar timer. */
  dismiss: () => Promise<void>;
}
let pendingDismissal: Promise<void> | null = null;

export const useResumeQueueStore = create<ResumeQueueState>((set, get) => ({
  snapshot: null,
  isOpen: false,
  connectionError: null,
  navigationError: null,
  pendingNavigationCount: 0,
  apply: (snapshot): void => {
    const previous = get().snapshot;
    if (previous && snapshot.revision < previous.revision) return;
    set({ snapshot, connectionError: null });
  },
  open: (): void => {
    useUsageLimitResumePromptStore.getState().close();
    set({ isOpen: true });
  },
  openWithNavigationError: (message): void => {
    useUsageLimitResumePromptStore.getState().close();
    set({ isOpen: true, navigationError: message });
  },
  clearNavigationError: (): void => set({ navigationError: null }),
  beginNavigation: (): void =>
    set((state) => ({
      pendingNavigationCount: state.pendingNavigationCount + 1,
    })),
  endNavigation: (): void =>
    set((state) => ({
      pendingNavigationCount: Math.max(0, state.pendingNavigationCount - 1),
    })),
  close: (): void => set({ isOpen: false, navigationError: null }),
  dismiss: (): Promise<void> => {
    if (pendingDismissal) return pendingDismissal;
    pendingDismissal = window.api
      .controlResumeQueue('dismiss')
      .then((snapshot): void => get().apply(snapshot))
      .finally(() => {
        pendingDismissal = null;
      });
    return pendingDismissal;
  },
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

export type ResumeQueueStatusLabel =
  | 'Paused'
  | 'In progress'
  | 'Needs attention'
  | 'Stopped'
  | 'Started'
  | 'Nothing to resume';

/**
 * The queue's headline status. The queue records handoffs, not live turns, so
 * a resumed entry reads as Started rather than finished or running. Active
 * work outranks earlier row outcomes; a stale paused flag on a terminal
 * snapshot does not.
 */
export function resumeQueueStatusLabel(
  snapshot: ResumeQueueSnapshot,
): ResumeQueueStatusLabel {
  if (snapshot.error) return 'Paused';
  if (resumeQueueProgress(snapshot).active) {
    return snapshot.paused ? 'Paused' : 'In progress';
  }
  const has = (status: ResumeQueueEntry['status']): boolean =>
    snapshot.entries.some((entry) => entry.status === status);
  if (has('failed')) return 'Needs attention';
  if (has('stopped')) return 'Stopped';
  if (has('resumed')) return 'Started';
  return 'Nothing to resume';
}

const STATUS_LABEL_GLYPHS: Record<ResumeQueueStatusLabel, StatusGlyphState> = {
  Paused: 'paused',
  'In progress': 'running',
  'Needs attention': 'failed',
  Stopped: 'cancelled',
  Started: 'done',
  'Nothing to resume': 'cancelled',
};

/** The glyph beside the queue's headline status. */
export function resumeQueueStatusGlyphState(
  label: ResumeQueueStatusLabel,
): StatusGlyphState {
  return STATUS_LABEL_GLYPHS[label];
}

// A skipped entry was no longer interrupted, so the queue never started it;
// it shares the stop glyph rather than reading as started.
const ENTRY_GLYPHS: Record<ResumeQueueEntry['status'], StatusGlyphState> = {
  waiting: 'queued',
  resuming: 'running',
  resumed: 'done',
  skipped: 'cancelled',
  failed: 'failed',
  stopped: 'cancelled',
};

/** The glyph leading a queue row. */
export function resumeQueueEntryGlyphState(
  status: ResumeQueueEntry['status'],
): StatusGlyphState {
  return ENTRY_GLYPHS[status];
}
