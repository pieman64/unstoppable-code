import { create } from 'zustand';
import type { ExternalProjectProvider } from '@canopy/desktop-shared/types';
import type { ImportProjectsPhase } from '@/components/import-projects/ImportProjectsPanel';

/** Where the bulk project import flow was opened from (telemetry and copy). */
export type ImportProjectsSource =
  | 'settings'
  | 'checklist'
  | 'invite'
  | 'app-advisor'
  | 'command';

export interface ImportProjectsModalTarget {
  source: ImportProjectsSource;
  /** Restrict discovery to one provider (Settings provider tabs). */
  providers?: ExternalProjectProvider[];
}

interface ImportProjectsModalStore {
  target: ImportProjectsModalTarget | null;
  /** Bumps on every open so the host remounts the panel and rescans. */
  openCount: number;
  /** Current panel phase while open, reported to App Advisor's UI snapshot. */
  phase: ImportProjectsPhase | null;
  open: (target: ImportProjectsModalTarget) => void;
  close: () => void;
  setPhase: (phase: ImportProjectsPhase) => void;
}

/**
 * App-wide host state for the bulk Claude/Codex project import modal
 * (CAN-2439). Settings, the Getting started checklist, the one-time invite,
 * and App Advisor all open the same flow through {@link openImportProjectsModal}.
 */
export const useImportProjectsModalStore = create<ImportProjectsModalStore>(
  (set) => ({
    target: null,
    openCount: 0,
    phase: null,
    open: (target): void =>
      set((state) => ({
        target,
        phase: 'scanning',
        openCount: state.openCount + 1,
      })),
    close: (): void => set({ target: null, phase: null }),
    setPhase: (phase): void => set({ phase }),
  }),
);

export function openImportProjectsModal(
  target: ImportProjectsModalTarget = { source: 'command' },
): void {
  useImportProjectsModalStore.getState().open(target);
}

export function closeImportProjectsModal(): void {
  useImportProjectsModalStore.getState().close();
}
