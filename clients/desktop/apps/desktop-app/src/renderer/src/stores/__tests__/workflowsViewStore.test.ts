import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  EMPTY_WORKFLOW_RUN_FILTERS,
  WORKFLOW_NO_PROJECT,
} from '@canopy/ui-app/workflows';
import { useWorkflowsViewStore } from '../workflowsViewStore';

describe('workflowsViewStore', () => {
  beforeEach(() => {
    useWorkflowsViewStore.setState({
      runsQuery: '',
      runsFilters: EMPTY_WORKFLOW_RUN_FILTERS,
      runsScrollTop: 0,
      libraryFilters: EMPTY_WORKFLOW_LIBRARY_FILTERS,
      librarySort: 'recently-run',
      libraryPage: 1,
      scheduleProject: null,
      contextKey: null,
    });
  });

  it('returns to page 1 when the Library query, filters or sort change', () => {
    const store = useWorkflowsViewStore.getState();
    store.setLibraryPage(4);
    store.setLibraryFilters({ ...EMPTY_WORKFLOW_LIBRARY_FILTERS, query: 'x' });
    expect(useWorkflowsViewStore.getState().libraryPage).toBe(1);

    store.setLibraryPage(3);
    store.setLibrarySort('name');
    expect(useWorkflowsViewStore.getState().libraryPage).toBe(1);
    expect(useWorkflowsViewStore.getState().librarySort).toBe('name');
  });

  it('replaces the Library filters with a preset and leaves the sort', () => {
    const store = useWorkflowsViewStore.getState();
    store.setLibrarySort('name');
    store.setLibraryFilters({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      query: 'deploy',
      source: 'mine',
      status: 'on',
    });
    store.setLibraryPage(2);

    store.applyPreset({ libraryTriggers: ['schedule', 'once'] });

    const state = useWorkflowsViewStore.getState();
    expect(state.libraryFilters).toEqual({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['schedule', 'once'],
    });
    expect(state.libraryPage).toBe(1);
    expect(state.librarySort).toBe('name');
  });

  it('replaces the Runs search and filters with a preset and scrolls to the top', () => {
    const store = useWorkflowsViewStore.getState();
    store.setRunsQuery('status:failed');
    store.setRunsFilters({ ...EMPTY_WORKFLOW_RUN_FILTERS, starter: 'manual' });
    store.setRunsScrollTop(900);

    store.applyPreset({ runKind: 'watcher' });

    const state = useWorkflowsViewStore.getState();
    expect(state.runsQuery).toBe('');
    expect(state.runsFilters).toEqual({
      ...EMPTY_WORKFLOW_RUN_FILTERS,
      kind: 'watcher',
    });
    expect(state.runsScrollTop).toBe(0);
  });

  it('keeps Runs state across a Library preset, and the other way round', () => {
    const store = useWorkflowsViewStore.getState();
    store.setRunsQuery('nightly');
    store.applyPreset({ libraryTriggers: ['manual'] });
    expect(useWorkflowsViewStore.getState().runsQuery).toBe('nightly');

    store.applyPreset({ runKind: 'watcher' });
    expect(useWorkflowsViewStore.getState().libraryFilters.triggers).toEqual([
      'manual',
    ]);
  });

  it('clears every Library filter for a reveal', () => {
    const store = useWorkflowsViewStore.getState();
    store.setLibraryFilters({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['manual'],
      source: 'built-in',
    });
    store.setLibraryPage(2);

    store.clearLibraryFilters();

    expect(useWorkflowsViewStore.getState().libraryFilters).toEqual(
      EMPTY_WORKFLOW_LIBRARY_FILTERS,
    );
    expect(useWorkflowsViewStore.getState().libraryPage).toBe(1);
  });

  describe('resetForContext', () => {
    it('returns to page 1 and clears a Project filter outside the new context', () => {
      const store = useWorkflowsViewStore.getState();
      store.setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        project: 'project-a',
        query: 'kept',
      });
      store.setLibraryPage(3);
      store.setScheduleProject('project-a');
      store.resetForContext('personal', new Set(['project-a']));

      store.resetForContext('org-1', new Set(['project-b']));

      const state = useWorkflowsViewStore.getState();
      expect(state.libraryPage).toBe(1);
      expect(state.libraryFilters.project).toBeNull();
      // Only the Project filter is context-bound.
      expect(state.libraryFilters.query).toBe('kept');
      expect(state.scheduleProject).toBeNull();
    });

    it('keeps a Project filter the new context still lists, and "No project"', () => {
      const store = useWorkflowsViewStore.getState();
      store.setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        project: 'project-a',
      });
      store.setScheduleProject(WORKFLOW_NO_PROJECT);
      store.resetForContext('personal', new Set(['project-a']));

      store.resetForContext('org-1', new Set(['project-a']));

      const state = useWorkflowsViewStore.getState();
      expect(state.libraryFilters.project).toBe('project-a');
      expect(state.scheduleProject).toBe(WORKFLOW_NO_PROJECT);
    });

    it('leaves the view alone while the context stays the same', () => {
      const store = useWorkflowsViewStore.getState();
      store.resetForContext('personal', new Set(['project-a']));
      store.setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        project: 'project-a',
      });
      store.setLibraryPage(3);

      // The page mounting again in the same context is not a switch.
      store.resetForContext('personal', new Set<string>());

      const state = useWorkflowsViewStore.getState();
      expect(state.libraryPage).toBe(3);
      expect(state.libraryFilters.project).toBe('project-a');
    });

    it('catches a switch made while the page was not shown', () => {
      const store = useWorkflowsViewStore.getState();
      store.resetForContext('personal', new Set(['project-a']));
      store.setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        project: 'project-a',
      });

      // Nothing ran for the switch itself; the next mount reports the context.
      store.resetForContext('org-1', new Set(['project-b']));

      expect(
        useWorkflowsViewStore.getState().libraryFilters.project,
      ).toBeNull();
    });
  });
});
