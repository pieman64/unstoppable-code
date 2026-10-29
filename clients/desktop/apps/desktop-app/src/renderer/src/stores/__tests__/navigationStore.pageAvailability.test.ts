/** @jest-environment jsdom */
import type { NavigationPage } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { HEADER_STATES_PAGE_STORAGE_KEY } from '@/components/sidebar/header-states-page-flag';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import { useGitHubStore } from '../githubStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '../labsExperimentsStore';
import {
  initAgentNavigationFlagTracking,
  useNavigationStore,
} from '../navigationStore';

const WORKERS_FLAG = CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key;

const GATED_PAGES: readonly NavigationPage[] = [
  'workers',
  'notice-states',
  'header-states',
  'worktree-states',
  'activity-states',
  'message-bubble-states',
  'change-review',
];

function setPageFlags(enabled: boolean): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.getState().setSnapshot({
    ...base,
    values: {
      ...base.values,
      [WORKERS_FLAG]: enabled,
    },
    status: 'ready',
    initialized: true,
  });
}

function setDevBuild(isDev: boolean): void {
  Object.defineProperty(window, 'devInfo', {
    configurable: true,
    value: { isDev },
  });
}

describe('navigationStore page availability (CAN-3661)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A packaged build with both page flags off: every gated page is denied
    // by its real gate predicate.
    setDevBuild(false);
    setPageFlags(false);
    useNavigationStore.setState({
      activePage: 'pipelines',
      homeComposerFocusRequest: 0,
      pendingAutomationReveal: undefined,
      pendingWorkerHighlight: undefined,
      pluginsBrowseSectionId: null,
      settingsOpen: false,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window, 'devInfo');
    resetLabsExperimentsStoreForTest();
    useGitHubStore.setState({ toasts: [] });
    useFeatureFlagsStore
      .getState()
      .setSnapshot(getDefaultFeatureFlagSnapshot());
  });

  it.each(GATED_PAGES)('lands on New task when %s is switched off', (page) => {
    useNavigationStore.getState().navigate(page);

    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('treats a denied request exactly like one navigation to New task', () => {
    useNavigationStore.setState({
      activePage: 'automations',
      pendingAutomationReveal: { activityId: 'activity-1', nonce: 1 },
      pluginsBrowseSectionId: 'section-1',
    });
    useNavigationStore.getState().navigate('workers');
    const denied = useNavigationStore.getState();

    useNavigationStore.setState({
      activePage: 'automations',
      homeComposerFocusRequest: 0,
      pendingAutomationReveal: { activityId: 'activity-1', nonce: 1 },
      pluginsBrowseSectionId: 'section-1',
    });
    useNavigationStore.getState().navigate('home');
    const direct = useNavigationStore.getState();

    expect(denied.activePage).toBe('home');
    expect(denied.homeComposerFocusRequest).toBe(1);
    expect(denied.pendingAutomationReveal).toBeUndefined();
    expect(denied.pluginsBrowseSectionId).toBeNull();
    expect({
      activePage: denied.activePage,
      homeComposerFocusRequest: denied.homeComposerFocusRequest,
      pendingAutomationReveal: denied.pendingAutomationReveal,
      pluginsBrowseSectionId: denied.pluginsBrowseSectionId,
    }).toEqual({
      activePage: direct.activePage,
      homeComposerFocusRequest: direct.homeComposerFocusRequest,
      pendingAutomationReveal: direct.pendingAutomationReveal,
      pluginsBrowseSectionId: direct.pluginsBrowseSectionId,
    });
  });

  it('requests composer focus once when denied while already on New task', () => {
    useNavigationStore.setState({ activePage: 'home' });

    useNavigationStore.getState().navigate('workers');

    expect(useNavigationStore.getState().activePage).toBe('home');
    expect(useNavigationStore.getState().homeComposerFocusRequest).toBe(1);
  });

  it('still opens pages that are switched on', () => {
    setPageFlags(true);
    setDevBuild(true);
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
    );
    window.localStorage.setItem(HEADER_STATES_PAGE_STORAGE_KEY, '1');

    for (const page of [
      'workers',
      'notice-states',
      'header-states',
      'statistics',
    ] as const) {
      useNavigationStore.getState().navigate(page);
      expect(useNavigationStore.getState().activePage).toBe(page);
    }
    expect(useNavigationStore.getState().homeComposerFocusRequest).toBe(0);
  });

  it('keeps the Settings alias opening MCP settings without changing page', () => {
    useNavigationStore.getState().navigate('mcp-account-connections');

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('pipelines');
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsInitialSection).toBe('mcp');
  });

  it('keeps the environments alias opening Settings → Environments without changing page', () => {
    useNavigationStore.getState().navigate('environments');

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('pipelines');
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsInitialSection).toBe('environment');
  });

  describe('openWorkers', () => {
    it('clears a stale highlight and follows New task when Workers is off', () => {
      useNavigationStore.setState({ pendingWorkerHighlight: 'stale-worker' });

      useNavigationStore.getState().openWorkers('worker-1');

      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('home');
      expect(state.pendingWorkerHighlight).toBeUndefined();
      expect(state.homeComposerFocusRequest).toBe(1);
    });

    it('opens and highlights the worker when Workers is on', () => {
      setPageFlags(true);

      useNavigationStore.getState().openWorkers('worker-1');

      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('workers');
      expect(state.pendingWorkerHighlight).toBe('worker-1');
      expect(state.homeComposerFocusRequest).toBe(0);
    });
  });

  describe('Labs page refusal toast (CAN-3678)', () => {
    let revision = 0;
    function publishPagesOff(): void {
      revision += 1;
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          revision,
          experiments: pageExperimentsOn().map((entry) => ({
            ...entry,
            choice: false,
          })),
        }),
      );
    }

    async function flushToasts(): Promise<void> {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('says nothing before a ready snapshot and lands on New task', async () => {
      useNavigationStore.getState().navigate('kanban');
      await flushToasts();

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    });

    it('posts one toast with an Open Labs action while the page is off', async () => {
      publishPagesOff();

      useNavigationStore.getState().navigate('statistics');
      await flushToasts();
      useNavigationStore.getState().navigate('statistics');
      await flushToasts();

      expect(useNavigationStore.getState().activePage).toBe('home');
      const toasts = useGitHubStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.message).toBe(
        'The Statistics page is switched off. Turn it on in Settings → Labs.',
      );
      expect(toasts[0]?.meta?.forceInApp).toBe(true);
      expect(toasts[0]?.meta?.suppressOsNotification).toBe(true);
      expect(toasts[0]?.meta?.action?.label).toBe('Open Labs');

      toasts[0]?.meta?.action?.onClick();
      const state = useNavigationStore.getState();
      expect(state.settingsOpen).toBe(true);
      expect(state.settingsInitialSection).toBe('experiments');
    });

    it('stays silent for a withdrawn page that Settings does not list', async () => {
      revision += 1;
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          revision,
          experiments: pageExperimentsOn().map((entry) => ({
            ...entry,
            availability: 'hidden',
          })),
        }),
      );

      useNavigationStore.getState().navigate('statistics');
      await flushToasts();

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    });

    it('swallows a failure to post the toast', async () => {
      publishPagesOff();
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      const getState = jest
        .spyOn(useGitHubStore, 'getState')
        .mockImplementation(() => {
          throw new Error('toast store unavailable');
        });
      try {
        useNavigationStore.getState().navigate('statistics');
        await flushToasts();
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        getState.mockRestore();
        process.off('unhandledRejection', unhandled);
      }

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('stays silent for feature-flag refusals', async () => {
      publishPagesOff();

      useNavigationStore.getState().navigate('workers');
      await flushToasts();

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    });

    it('stays silent when navigating to New task after a page was switched off', async () => {
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({ revision: 1, experiments: pageExperimentsOn() }),
      );
      useNavigationStore.getState().navigate('kanban');
      expect(useNavigationStore.getState().activePage).toBe('kanban');
      revision = 1;
      publishPagesOff();

      // The page host's fallback navigates to New task, never to the page.
      useNavigationStore.getState().navigate('home');
      await flushToasts();

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    });
  });
});

describe('retired Agents navigation boundaries (CAN-4266)', () => {
  let dispose: () => void;
  beforeEach(() => {
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useNavigationStore.setState({
      activePage: 'home',
      pendingPluginsNavigation: undefined,
    });
  });
  afterEach(() =>
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    }),
  );

  beforeEach(() => {
    dispose = initAgentNavigationFlagTracking();
  });
  afterEach(() => dispose());

  it('translates a legacy page request before activating a canonical page', () => {
    // Old callers can still supply a serialized page id at runtime.
    Reflect.apply(useNavigationStore.getState().navigate, undefined, [
      'agents',
    ]);
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'agent',
    });
  });

  it('drops queued agent navigation on flag disable even before the lazy page mounts', () => {
    useNavigationStore
      .getState()
      .openAgentReveal({ agentId: 'agent_model_reviewer', mode: 'edit' });
    const base = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...base,
        values: {
          ...base.values,
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: false,
        },
      },
    });
    useFeatureFlagsStore.setState({ snapshot: base });
    expect(
      useNavigationStore.getState().pendingPluginsNavigation,
    ).toBeUndefined();
  });
});
