import type { CanopyApi, SidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function makeProject(id: string): SidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: true,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

beforeAll(() => {
  jest.useFakeTimers();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: { savePreferences: jest.fn().mockResolvedValue(undefined) },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
});

afterAll(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('projectsStore recentlyAddedProjectIds', () => {
  it('captures a baseline, pulses new projects, then clears after the window', () => {
    // First hydrated snapshot establishes the baseline without pulsing.
    useProjectsStore.setState({
      projects: [makeProject('alpha')],
      hasHydratedProjects: true,
      recentlyAddedProjectIds: new Set<string>(),
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();
    expect(useProjectsStore.getState().recentlyAddedProjectIds.size).toBe(0);

    // Adding a workspace at runtime pulses only the new id.
    useProjectsStore.setState({
      projects: [makeProject('alpha'), makeProject('beta')],
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();
    const pulsed = useProjectsStore.getState().recentlyAddedProjectIds;
    expect(pulsed.has('beta')).toBe(true);
    expect(pulsed.has('alpha')).toBe(false);

    // The pulse clears once the highlight window elapses.
    jest.advanceTimersByTime(4000);
    expect(
      useProjectsStore.getState().recentlyAddedProjectIds.has('beta'),
    ).toBe(false);
  });

  it('clearRecentlyAddedProjectTimers cancels pending pulse timers', () => {
    useProjectsStore.setState({
      projects: [makeProject('alpha'), makeProject('beta')],
    });
    // Add a third workspace to schedule a fresh timer.
    useProjectsStore.setState({
      projects: [
        makeProject('alpha'),
        makeProject('beta'),
        makeProject('gamma'),
      ],
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();
    expect(
      useProjectsStore.getState().recentlyAddedProjectIds.has('gamma'),
    ).toBe(true);

    useProjectsStore.getState().clearRecentlyAddedProjectTimers();
    // Advancing time no longer clears the pulse because the timer was cancelled;
    // the state stays as-is until a subsequent detect run reconciles it.
    jest.advanceTimersByTime(4000);
    expect(
      useProjectsStore.getState().recentlyAddedProjectIds.has('gamma'),
    ).toBe(true);
  });

  it('does not re-flag a project that disappears from a snapshot and returns', () => {
    // Establish all three ids as known, so the case holds whether or not the
    // earlier tests in this file have already seeded the module baseline.
    useProjectsStore.setState({
      projects: [
        makeProject('alpha'),
        makeProject('beta'),
        makeProject('gamma'),
      ],
      hasHydratedProjects: true,
      recentlyAddedProjectIds: new Set<string>(),
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();

    // A snapshot flap (watcher reload racing a workspace.json write) drops a
    // known workspace...
    useProjectsStore.setState({
      projects: [makeProject('alpha'), makeProject('gamma')],
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();

    // ...and the next snapshot brings it back with the same id.
    useProjectsStore.setState({
      projects: [
        makeProject('alpha'),
        makeProject('beta'),
        makeProject('gamma'),
      ],
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();
    expect(
      useProjectsStore.getState().recentlyAddedProjectIds.has('beta'),
    ).toBe(false);

    // A genuinely new id still pulses.
    useProjectsStore.setState({
      projects: [
        makeProject('alpha'),
        makeProject('beta'),
        makeProject('gamma'),
        makeProject('delta'),
      ],
    });
    useProjectsStore.getState().detectRecentlyAddedProjects();
    expect(
      useProjectsStore.getState().recentlyAddedProjectIds.has('delta'),
    ).toBe(true);
  });
});
