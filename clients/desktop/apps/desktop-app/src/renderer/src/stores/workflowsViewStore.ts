import { create } from 'zustand';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  EMPTY_WORKFLOW_RUN_FILTERS,
  WORKFLOW_NO_PROJECT,
  type WorkflowLibraryFilters,
  type WorkflowLibrarySort,
  type WorkflowRunFilters,
} from '@canopy/ui-app/workflows';
import type { WorkflowsPresetFilters } from '@/lib/navigation/workflows-target';

/**
 * View state of the Workflows tabs (CAN-3981): search, filters, sort, page
 * and scroll. Kept per window and outside the components, so opening a run or
 * an editor and coming Back restores the tab as it was.
 */
export interface WorkflowsViewState {
  readonly runsQuery: string;
  readonly runsFilters: WorkflowRunFilters;
  /** Scroll offset of the Runs tab, restored on return. */
  readonly runsScrollTop: number;
  readonly libraryFilters: WorkflowLibraryFilters;
  readonly librarySort: WorkflowLibrarySort;
  /** 1-based. */
  readonly libraryPage: number;
  /** A project id, `WORKFLOW_NO_PROJECT`, or `null` for any project. */
  readonly scheduleProject: string | null;
  /** The context the filters were last shown in; `null` before the first. */
  readonly contextKey: string | null;

  setRunsQuery: (query: string) => void;
  setRunsFilters: (filters: WorkflowRunFilters) => void;
  setRunsScrollTop: (scrollTop: number) => void;
  setLibraryFilters: (filters: WorkflowLibraryFilters) => void;
  setLibrarySort: (sort: WorkflowLibrarySort) => void;
  setLibraryPage: (page: number) => void;
  setScheduleProject: (project: string | null) => void;
  /**
   * Applies a legacy page id's filters. They replace the tab's persisted
   * filters and never merge with them, and they stay until the user changes
   * or clears them, like any other filter.
   */
  applyPreset: (preset: WorkflowsPresetFilters) => void;
  /** Clears every Library filter, so a row a reveal points at is listed. */
  clearLibraryFilters: () => void;
  /**
   * Records the Personal/organization context the tabs are shown in. When it
   * differs from the last one: back to page 1, and a Project filter that
   * names a project outside the new context is cleared.
   */
  resetForContext: (
    contextKey: string,
    projectIds: ReadonlySet<string>,
  ) => void;
}

function projectInContext(
  project: string | null,
  projectIds: ReadonlySet<string>,
): string | null {
  if (project === null || project === WORKFLOW_NO_PROJECT) return project;
  return projectIds.has(project) ? project : null;
}

export const useWorkflowsViewStore = create<WorkflowsViewState>((set) => ({
  runsQuery: '',
  runsFilters: EMPTY_WORKFLOW_RUN_FILTERS,
  runsScrollTop: 0,
  libraryFilters: EMPTY_WORKFLOW_LIBRARY_FILTERS,
  librarySort: 'recently-run',
  libraryPage: 1,
  scheduleProject: null,
  contextKey: null,

  setRunsQuery: (runsQuery): void => set({ runsQuery }),
  setRunsFilters: (runsFilters): void => set({ runsFilters }),
  setRunsScrollTop: (runsScrollTop): void => set({ runsScrollTop }),
  // A new query, filter or sort always starts from the first page.
  setLibraryFilters: (libraryFilters): void =>
    set({ libraryFilters, libraryPage: 1 }),
  setLibrarySort: (librarySort): void => set({ librarySort, libraryPage: 1 }),
  setLibraryPage: (libraryPage): void => set({ libraryPage }),
  setScheduleProject: (scheduleProject): void => set({ scheduleProject }),
  applyPreset: (preset): void =>
    set({
      ...(preset.libraryTriggers !== undefined
        ? {
            libraryFilters: {
              ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
              triggers: preset.libraryTriggers,
            },
            libraryPage: 1,
          }
        : {}),
      ...(preset.runKind !== undefined
        ? {
            runsQuery: '',
            runsFilters: {
              ...EMPTY_WORKFLOW_RUN_FILTERS,
              kind: preset.runKind,
            },
            runsScrollTop: 0,
          }
        : {}),
    }),
  clearLibraryFilters: (): void =>
    set({ libraryFilters: EMPTY_WORKFLOW_LIBRARY_FILTERS, libraryPage: 1 }),
  resetForContext: (contextKey, projectIds): void =>
    set((state) => {
      if (state.contextKey === contextKey) return state;
      // The first context shown has nothing to reset.
      if (state.contextKey === null) return { contextKey };
      const libraryProject = projectInContext(
        state.libraryFilters.project,
        projectIds,
      );
      return {
        contextKey,
        libraryPage: 1,
        libraryFilters:
          libraryProject === state.libraryFilters.project
            ? state.libraryFilters
            : { ...state.libraryFilters, project: libraryProject },
        scheduleProject: projectInContext(state.scheduleProject, projectIds),
      };
    }),
}));
