import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  EMPTY_WORKFLOW_RUN_FILTERS,
} from '@canopy/ui-app/workflows';
import { LEGACY_AUTOMATIONS_VIEW_MODE_KEY } from '@/lib/navigation/workflows-target';
import type { WorkflowEditTarget } from '@/lib/workflows/edit-target';
import {
  askNavigationGuard,
  registerNavigationGuard,
  runWithoutNavigationGuard,
  useNavigationStore,
} from '../navigationStore';
import { useWorkflowsViewStore } from '../workflowsViewStore';

describe('navigationStore openAddWorkspaceModal', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      addWorkspaceModalOpen: false,
      addWorkspaceInitialRepoUrl: null,
      activePage: 'overview',
    });
  });

  it('opens the modal WITHOUT navigating (App-level host overlays the current page)', () => {
    useNavigationStore.getState().openAddWorkspaceModal();
    const state = useNavigationStore.getState();
    expect(state.addWorkspaceModalOpen).toBe(true);
    // No prefill was requested, so the seed URL stays null.
    expect(state.addWorkspaceInitialRepoUrl).toBeNull();
    // Task H1 item 2: the Add Workspace modal is now hosted at App level
    // (`AddWorkspaceModalHost`), so it overlays whatever page is active —
    // opening it must NOT change the active page (Home, Overview, etc. stay
    // visible underneath).
    expect(state.activePage).toBe('overview');
  });

  it('seeds addWorkspaceInitialRepoUrl from the prefill arg and clears it on close (ECW-8121)', () => {
    useNavigationStore.getState().openAddWorkspaceModal({
      initialRepoUrl: 'https://github.com/other/repo',
    });
    expect(useNavigationStore.getState().addWorkspaceInitialRepoUrl).toBe(
      'https://github.com/other/repo',
    );

    useNavigationStore.getState().closeAddWorkspaceModal();
    const state = useNavigationStore.getState();
    expect(state.addWorkspaceModalOpen).toBe(false);
    expect(state.addWorkspaceInitialRepoUrl).toBeNull();
  });
});

describe('navigationStore Home composer focus requests', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      homeComposerFocusRequest: 0,
    });
  });

  it('delivers successive suggestion prompts after each request has been consumed', () => {
    const store = useNavigationStore.getState();
    store.requestHomeComposerText('First suggestion');
    const firstNonce =
      useNavigationStore.getState().pendingHomeComposerText?.nonce;
    store.consumeHomeComposerTextRequest();
    store.requestHomeComposerText('Second suggestion');
    expect(
      useNavigationStore.getState().pendingHomeComposerText?.nonce,
    ).not.toBe(firstNonce);
    expect(useNavigationStore.getState().pendingHomeComposerText?.text).toBe(
      'Second suggestion',
    );
  });

  it('requests focus every time Home is navigated to', () => {
    useNavigationStore.getState().navigate('home');
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'home',
      homeComposerFocusRequest: 1,
    });

    useNavigationStore.getState().navigate('home');
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'home',
      homeComposerFocusRequest: 2,
    });
  });

  it('does not request Home composer focus for another page', () => {
    useNavigationStore.getState().navigate('usage');

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'usage',
      homeComposerFocusRequest: 0,
    });
  });
});

describe('navigationStore project settings deep links', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      pendingWorkspaceSettings: undefined,
      workspaceSettingsModalOpen: false,
    });
  });

  it('marks the modal open while preserving the settings target', () => {
    useNavigationStore.getState().openWorkspaceSettings({
      workspaceId: 'workspace-1',
      initialTab: 'details',
    });

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'main',
      pendingWorkspaceSettings: {
        workspaceId: 'workspace-1',
        initialTab: 'details',
      },
      workspaceSettingsModalOpen: true,
    });
  });

  it('opens a project settings modal without changing the active page', () => {
    useNavigationStore.getState().openWorkspaceSettingsModal({
      workspaceId: 'cowork-1',
    });

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'overview',
      pendingWorkspaceSettings: {
        workspaceId: 'cowork-1',
      },
      workspaceSettingsModalOpen: true,
    });
  });
});

describe('navigationStore worktree-row action requests', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      pendingDispatchPipeline: undefined,
      pendingAddRepoAdhoc: undefined,
      pendingDriftDetails: undefined,
      pendingArchiveWorktree: undefined,
    });
  });

  const target = { projectId: 'proj-1', worktreeId: 'wt-1' };

  it('starts with all row-action requests undefined', () => {
    const state = useNavigationStore.getState();
    expect(state.pendingDispatchPipeline).toBeUndefined();
    expect(state.pendingAddRepoAdhoc).toBeUndefined();
    expect(state.pendingDriftDetails).toBeUndefined();
  });

  it('requestDispatchPipeline sets and consume clears the payload', () => {
    useNavigationStore.getState().requestDispatchPipeline(target);
    expect(useNavigationStore.getState().pendingDispatchPipeline).toEqual(
      target,
    );
    useNavigationStore.getState().consumeDispatchPipelineRequest();
    expect(
      useNavigationStore.getState().pendingDispatchPipeline,
    ).toBeUndefined();
  });

  it('requestAddRepoAdhoc sets and consume clears the payload', () => {
    useNavigationStore.getState().requestAddRepoAdhoc(target);
    expect(useNavigationStore.getState().pendingAddRepoAdhoc).toEqual(target);
    useNavigationStore.getState().consumeAddRepoAdhocRequest();
    expect(useNavigationStore.getState().pendingAddRepoAdhoc).toBeUndefined();
  });

  it('requestSplitWorkspace sets and consume clears the payload', () => {
    useNavigationStore.getState().requestSplitWorkspace(target);
    expect(useNavigationStore.getState().pendingSplitWorkspace).toEqual(target);
    useNavigationStore.getState().consumeSplitWorkspaceRequest();
    expect(useNavigationStore.getState().pendingSplitWorkspace).toBeUndefined();
  });

  it('requestDriftDetails sets and consume clears the payload', () => {
    useNavigationStore.getState().requestDriftDetails(target);
    expect(useNavigationStore.getState().pendingDriftDetails).toEqual(target);
    useNavigationStore.getState().consumeDriftDetailsRequest();
    expect(useNavigationStore.getState().pendingDriftDetails).toBeUndefined();
  });

  it('requestArchiveWorktree sets and consume clears the payload', () => {
    const archiveTarget = {
      ...target,
      deleteBranch: false,
      expectedBranchName: 'feature/confirmed',
    };
    useNavigationStore.getState().requestArchiveWorktree(archiveTarget);
    expect(useNavigationStore.getState().pendingArchiveWorktree).toEqual(
      archiveTarget,
    );
    useNavigationStore.getState().consumeArchiveWorktreeRequest();
    expect(
      useNavigationStore.getState().pendingArchiveWorktree,
    ).toBeUndefined();
  });
});

describe('navigationStore automation edit deep link', () => {
  it('lets a newer explicit destination supersede a reveal before the page mounts', () => {
    useNavigationStore
      .getState()
      .openAutomationReveal({ activityId: 'late', outcome: 'installed' });
    useNavigationStore
      .getState()
      .openPipelineEdit({ pipelineId: 'next', source: 'user' });
    expect(
      useNavigationStore.getState().pendingAutomationReveal,
    ).toBeUndefined();
  });

  it('drops a reveal when navigation leaves before the Automations page mounts', () => {
    useNavigationStore
      .getState()
      .openAutomationReveal({ activityId: 'late', outcome: 'installed' });
    useNavigationStore.getState().navigate('home');
    expect(
      useNavigationStore.getState().pendingAutomationReveal,
    ).toBeUndefined();
    useNavigationStore.getState().navigate('automations');
    expect(
      useNavigationStore.getState().pendingAutomationReveal,
    ).toBeUndefined();
  });

  it('keeps a reveal on Workflows → Library and drops it on the other Workflows tabs (CAN-3981)', () => {
    // The Library tab itself, and the legacy ids that resolve to it.
    for (const page of ['workflows-library', 'automations'] as const) {
      useNavigationStore
        .getState()
        .openAutomationReveal({ activityId: 'copy', outcome: 'installed' });
      useNavigationStore.getState().navigate(page);
      expect(useNavigationStore.getState().pendingAutomationReveal).toEqual({
        activityId: 'copy',
        outcome: 'installed',
      });
    }

    for (const page of [
      'workflows',
      'workflows-schedule',
      'watchers',
    ] as const) {
      useNavigationStore
        .getState()
        .openAutomationReveal({ activityId: 'copy', outcome: 'installed' });
      useNavigationStore.getState().navigate(page);
      expect(
        useNavigationStore.getState().pendingAutomationReveal,
      ).toBeUndefined();
    }
  });

  it('normalizes legacy ownership into a Workflows section focus', () => {
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'marketplace-browse',
      query: '',
      tab: 'automation',
      ownership: 'shared-by-me',
    });
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'workflow',
      focusSection: 'shared-by-me',
    });
  });

  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });
  });

  it('openAutomationEdit navigates to the Library and opens the edit shell', () => {
    useNavigationStore.getState().openAutomationEdit({ activityId: 'act-1' });

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('workflows-library');
    expect(state.workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'act-1',
    });
  });

  it('openAutomationEdit passes a section and returnTo through', () => {
    useNavigationStore.getState().openAutomationEdit({
      activityId: 'act-1',
      section: 'runs',
      returnTo: { kind: 'pipeline', pipelineId: 'deploy' },
    });

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'act-1',
      section: 'runs',
      returnTo: { kind: 'pipeline', pipelineId: 'deploy' },
    });
  });

  it('opens and consumes an automation shared-pipeline review deep link', () => {
    useNavigationStore
      .getState()
      .openAutomationSharedPipelineReview({ activityId: 'act-1' });

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'workflows-library',
      pendingAutomationSharedPipelineReview: { activityId: 'act-1' },
    });

    useNavigationStore.getState().consumeAutomationSharedPipelineReview();
    expect(
      useNavigationStore.getState().pendingAutomationSharedPipelineReview,
    ).toBeUndefined();
  });
});

describe('navigationStore skill viewer deep links', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      pendingSkillViewer: undefined,
    });
  });

  it('accepts tagged installed and legacy installed links', () => {
    useNavigationStore.getState().openSkillViewer({
      kind: 'installed',
      sourceId: 'custom',
      skillName: 'review',
    });
    expect(useNavigationStore.getState().pendingSkillViewer).toEqual({
      kind: 'installed',
      sourceId: 'custom',
      skillName: 'review',
    });
    useNavigationStore
      .getState()
      .openSkillViewer({ sourceId: 'legacy', skillName: 'old' });
    expect(useNavigationStore.getState().pendingSkillViewer).toEqual({
      sourceId: 'legacy',
      skillName: 'old',
    });
  });

  it('navigates shared links to the skills manager and preserves the remote id', () => {
    useNavigationStore
      .getState()
      .openSkillViewer({ kind: 'shared', skillId: 'skill-1' });
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pendingSkillViewer).toEqual({
      kind: 'shared',
      skillId: 'skill-1',
    });
    useNavigationStore.getState().consumeSkillViewer();
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
  });
});

describe('navigationStore plugin tab deep links', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      pendingPluginsNavigation: undefined,
    });
  });

  it('maps the requested legacy tab to a pending management destination', () => {
    useNavigationStore.getState().openPluginsTab('mcp');

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'plugins',
      pendingPluginsNavigation: { kind: 'management', section: 'mcp' },
    });

    useNavigationStore.getState().consumePluginsNavigation();
    expect(
      useNavigationStore.getState().pendingPluginsNavigation,
    ).toBeUndefined();
  });
});

describe('navigationStore privacy opt-in requests (CAN-3383)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    useNavigationStore.setState({
      pendingPrivacyOptIn: undefined,
      queuedPrivacyOptIns: [],
    });
  });

  it('dedupes identical links and queues a different one', () => {
    const store = useNavigationStore.getState();
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_A });
    const first = useNavigationStore.getState().pendingPrivacyOptIn;
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_A });
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_B });
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_B });

    const state = useNavigationStore.getState();
    // The request under review is never silently replaced.
    expect(state.pendingPrivacyOptIn).toBe(first);
    expect(state.queuedPrivacyOptIns).toHaveLength(1);
    expect(state.queuedPrivacyOptIns[0]?.organizationId).toBe(ORG_B);
  });

  it('advances the queue only when the active request is consumed', () => {
    const store = useNavigationStore.getState();
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_A });
    store.openPrivacyOptIn({ feature: 'statistics', organizationId: ORG_A });
    const first = useNavigationStore.getState().pendingPrivacyOptIn;
    if (!first) throw new Error('expected a pending request');

    store.consumePrivacyOptIn(first.id);
    const second = useNavigationStore.getState().pendingPrivacyOptIn;
    expect(second?.feature).toBe('statistics');

    // A late completion of the old request leaves the newer one in place.
    store.consumePrivacyOptIn(first.id);
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toBe(second);

    if (!second) throw new Error('expected a second request');
    store.consumePrivacyOptIn(second.id);
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toBeUndefined();
  });

  it('treats the same link after closing as a new request', () => {
    const store = useNavigationStore.getState();
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_A });
    const first = useNavigationStore.getState().pendingPrivacyOptIn;
    if (!first) throw new Error('expected a pending request');
    store.consumePrivacyOptIn(first.id);
    store.openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG_A });
    const reopened = useNavigationStore.getState().pendingPrivacyOptIn;
    expect(reopened?.id).not.toBe(first.id);
  });
});

describe('navigationStore automation reveal deep link (CAN-3651)', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
      pendingAutomationReveal: undefined,
    });
  });

  it('navigates to Automations and stages the exact reveal payload', () => {
    useNavigationStore
      .getState()
      .openAutomationReveal({ activityId: 'act-1', outcome: 'installed' });

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('workflows-library');
    expect(state.pendingAutomationReveal).toEqual({
      activityId: 'act-1',
      outcome: 'installed',
    });
  });

  it('consumeAutomationReveal clears the payload', () => {
    useNavigationStore
      .getState()
      .openAutomationReveal({ activityId: 'act-1', outcome: 'updated' });

    useNavigationStore.getState().consumeAutomationReveal();

    expect(
      useNavigationStore.getState().pendingAutomationReveal,
    ).toBeUndefined();
  });

  it('stages a fresh payload for a repeated same-id request', () => {
    const store = useNavigationStore.getState();
    store.openAutomationReveal({ activityId: 'act-1', outcome: 'installed' });
    const first = useNavigationStore.getState().pendingAutomationReveal;
    store.consumeAutomationReveal();
    store.openAutomationReveal({ activityId: 'act-1', outcome: 'installed' });

    const second = useNavigationStore.getState().pendingAutomationReveal;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('lets a later reveal close the edit shell', () => {
    const store = useNavigationStore.getState();
    store.openAutomationEdit({ activityId: 'act-edit' });
    store.openAutomationReveal({ activityId: 'act-new', outcome: 'installed' });

    const state = useNavigationStore.getState();
    expect(state.workflowEdit).toBeUndefined();
    expect(state.pendingAutomationReveal).toEqual({
      activityId: 'act-new',
      outcome: 'installed',
    });
  });

  it('lets a later edit supersede a pending reveal', () => {
    const store = useNavigationStore.getState();
    store.openAutomationReveal({ activityId: 'act-new', outcome: 'installed' });
    store.openAutomationEdit({ activityId: 'act-edit' });

    const state = useNavigationStore.getState();
    expect(state.pendingAutomationReveal).toBeUndefined();
    expect(state.workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'act-edit',
    });
    expect(state.activePage).toBe('workflows-library');
  });
});

describe('navigationStore navigation guard', () => {
  let clear: (() => void) | undefined;
  const store = (): ReturnType<typeof useNavigationStore.getState> =>
    useNavigationStore.getState();

  beforeEach(() => {
    useNavigationStore.setState({ activePage: 'home' });
  });

  afterEach(() => {
    clear?.();
    clear = undefined;
  });

  it('navigates synchronously when no guard is registered', () => {
    useNavigationStore.getState().navigate('plugins');
    expect(useNavigationStore.getState().activePage).toBe('plugins');
  });

  it('asks the guard with the requested page and blocks a denied navigation', () => {
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    useNavigationStore.getState().navigate('plugins');
    expect(guard).toHaveBeenCalledWith('plugins');
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('applies an allowed navigation synchronously', () => {
    clear = registerNavigationGuard(() => true);
    useNavigationStore.getState().navigate('plugins');
    expect(useNavigationStore.getState().activePage).toBe('plugins');
  });

  it('waits for an async guard, then navigates once without asking again', async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const guard = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    clear = registerNavigationGuard(guard);
    useNavigationStore.getState().navigate('plugins');
    expect(useNavigationStore.getState().activePage).toBe('home');
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('drops the navigation when an async guard resolves false or rejects', async () => {
    clear = registerNavigationGuard(() => Promise.resolve(false));
    useNavigationStore.getState().navigate('plugins');
    await Promise.resolve();
    await Promise.resolve();
    expect(useNavigationStore.getState().activePage).toBe('home');

    clear();
    clear = registerNavigationGuard(() =>
      Promise.reject(new Error('save failed')),
    );
    useNavigationStore.getState().navigate('plugins');
    await Promise.resolve();
    await Promise.resolve();
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('keeps one guard at a time: registering replaces, and a stale clear is a no-op', () => {
    const first = jest.fn(() => false);
    const second = jest.fn(() => false);
    const clearFirst = registerNavigationGuard(first);
    clear = registerNavigationGuard(second);
    useNavigationStore.getState().navigate('plugins');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    // The replaced editor unmounts: its successor's guard stays.
    clearFirst();
    useNavigationStore.getState().navigate('plugins');
    expect(second).toHaveBeenCalledTimes(2);
    expect(useNavigationStore.getState().activePage).toBe('home');

    clear();
    useNavigationStore.getState().navigate('plugins');
    expect(useNavigationStore.getState().activePage).toBe('plugins');
  });

  it('guards the redirect page ids too, before any side effect', () => {
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    useNavigationStore.setState({ settingsOpen: false });
    useNavigationStore.getState().navigate('mcp-account-connections');
    expect(guard).toHaveBeenCalledWith('mcp-account-connections');
    expect(useNavigationStore.getState().settingsOpen).toBe(false);

    useNavigationStore.getState().navigate('environments');
    expect(guard).toHaveBeenCalledWith('environments');
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });

  it('does not ask for the page already shown', () => {
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    useNavigationStore.getState().navigate('home');
    expect(guard).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  it('does not ask for a legacy id that opens the tab already shown', () => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    store().navigate('pipelines');
    store().navigate('automations');
    expect(guard).not.toHaveBeenCalled();
    expect(store().activePage).toBe('workflows-library');

    // `watchers` opens Runs, which would replace what the Library shows.
    store().navigate('watchers');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(store().activePage).toBe('workflows-library');
  });

  it.each<[string, () => void]>([
    [
      'openSkillViewer',
      (): void => store().openSkillViewer({ skillId: 'skill' }),
    ],
    ['openPluginsTab', (): void => store().openPluginsTab('marketplace')],
    [
      'openPluginsNavigation',
      (): void =>
        store().openPluginsNavigation({
          kind: 'management',
          section: 'marketplaces',
        }),
    ],
    [
      'openWorkspaceSettings',
      (): void => store().openWorkspaceSettings({ projectId: 'project' }),
    ],
    ['openWorkers', (): void => store().openWorkers()],
    [
      'openPipelineDispatch',
      (): void => store().openPipelineDispatch({ pipelineId: 'pipeline' }),
    ],
    [
      'requestHomeComposerText',
      (): void => store().requestHomeComposerText('hi'),
    ],
  ])('%s waits for the guard before changing the page', (_name, act) => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    act();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');

    clear();
    act();
    expect(useNavigationStore.getState().activePage).not.toBe(
      'workflows-library',
    );
  });
});

describe('navigationStore Workflows pages (CAN-3981)', () => {
  // This suite runs without a DOM, so it supplies the storage `navigate`
  // reads the old List/Calendar choice from.
  const stored = new Map<string, string>();
  const localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
    },
    removeItem: (key) => {
      stored.delete(key);
    },
  };

  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorage,
      configurable: true,
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  beforeEach(() => {
    localStorage.removeItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY);
    useNavigationStore.setState({ activePage: 'home' });
    useWorkflowsViewStore.setState({
      runsQuery: 'stale',
      runsFilters: { ...EMPTY_WORKFLOW_RUN_FILTERS, status: 'failure' },
      libraryFilters: {
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'stale',
        source: 'mine',
      },
      libraryPage: 3,
    });
  });

  it('asks when a saved calendar preference sends automations to Schedule', () => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    localStorage.setItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY, 'calendar');
    const guard = jest.fn(() => false);
    const clear = registerNavigationGuard(guard);
    useNavigationStore.getState().navigate('automations');
    expect(guard).toHaveBeenCalledTimes(1);
    // Refused, so the one-time redirect is still owed.
    expect(localStorage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBe(
      'calendar',
    );
    clear();
  });
  it('activates each Workflows tab under its own page id and keeps its filters', () => {
    for (const page of [
      'workflows',
      'workflows-schedule',
      'workflows-library',
    ] as const) {
      useNavigationStore.getState().navigate(page);
      expect(useNavigationStore.getState().activePage).toBe(page);
    }
    const view = useWorkflowsViewStore.getState();
    expect(view.runsQuery).toBe('stale');
    expect(view.libraryFilters.query).toBe('stale');
    expect(view.libraryPage).toBe(3);
  });

  it('never activates a legacy id: automations opens the Library on scheduled and one-time triggers', () => {
    useNavigationStore.getState().navigate('automations');
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    const view = useWorkflowsViewStore.getState();
    // The preset replaces the persisted filters; it does not merge with them.
    expect(view.libraryFilters).toEqual({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['schedule', 'once'],
    });
    expect(view.libraryPage).toBe(1);
    // The Runs filters belong to another tab and stay as they were.
    expect(view.runsQuery).toBe('stale');
  });

  it('opens the Library on pipeline triggers for the legacy pipelines id', () => {
    useNavigationStore.getState().navigate('pipelines');
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(useWorkflowsViewStore.getState().libraryFilters).toEqual({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['manual', 'plan-approved', 'task-ready'],
    });
  });

  it('opens Runs on the Watcher kind for the legacy watchers id', () => {
    useNavigationStore.getState().navigate('watchers');
    expect(useNavigationStore.getState().activePage).toBe('workflows');
    const view = useWorkflowsViewStore.getState();
    expect(view.runsQuery).toBe('');
    expect(view.runsFilters).toEqual({
      ...EMPTY_WORKFLOW_RUN_FILTERS,
      kind: 'watcher',
    });
    expect(view.libraryFilters.query).toBe('stale');
  });

  it('opens Schedule once for a saved calendar preference, then removes it', () => {
    localStorage.setItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY, 'calendar');
    useNavigationStore.getState().navigate('automations');
    expect(useNavigationStore.getState().activePage).toBe('workflows-schedule');
    expect(localStorage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBeNull();
    // The Library filters are untouched by a visit that opened Schedule.
    expect(useWorkflowsViewStore.getState().libraryFilters.query).toBe('stale');

    useNavigationStore.getState().navigate('automations');
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
  });

  it('removes any other saved view mode without effect', () => {
    localStorage.setItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY, 'list');
    useNavigationStore.getState().navigate('automations');
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(localStorage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBeNull();
  });

  it('leaves the calendar preference alone for other pages', () => {
    localStorage.setItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY, 'calendar');
    useNavigationStore.getState().navigate('pipelines');
    expect(localStorage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBe(
      'calendar',
    );
  });

  it('asks the guard before an editor opens, even on the same page', async () => {
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
    });
    let answer: (allowed: boolean) => void = () => undefined;
    const guard = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const clear = registerNavigationGuard(guard);
    try {
      useNavigationStore
        .getState()
        .openPipelineEdit({ pipelineId: 'next', source: 'user' });
      expect(guard).toHaveBeenCalledWith('workflows-library');
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
      answer(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(useNavigationStore.getState().workflowEdit).toEqual({
        kind: 'pipeline',
        pipelineId: 'next',
        source: 'user',
      });

      useNavigationStore.getState().openAutomationEdit({ activityId: 'a-1' });
      answer(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(useNavigationStore.getState().workflowEdit).toEqual({
        kind: 'pipeline',
        pipelineId: 'next',
        source: 'user',
      });
    } finally {
      clear();
    }
  });
});

describe('navigationStore Workflows edit shell (CAN-4072)', () => {
  let clear: (() => void) | undefined;
  const store = (): ReturnType<typeof useNavigationStore.getState> =>
    useNavigationStore.getState();
  const automation: WorkflowEditTarget = {
    kind: 'automation',
    activityId: 'act-1',
  };
  const flushDecision = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
      pendingPluginsNavigation: undefined,
      pendingAutomationReveal: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });
  });

  afterEach(() => {
    clear?.();
    clear = undefined;
  });

  it('opens a target on the Library and drops a pending reveal', () => {
    useNavigationStore.setState({
      activePage: 'home',
      pendingAutomationReveal: { activityId: 'act-0', outcome: 'installed' },
    });
    store().openWorkflowEdit(automation);
    expect(store().activePage).toBe('workflows-library');
    expect(store().workflowEdit).toEqual(automation);
    expect(store().pendingAutomationReveal).toBeUndefined();
  });

  it('only moves the section for the key already shown, without asking', () => {
    store().openWorkflowEdit(automation);
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);

    store().openAutomationEdit({ activityId: 'act-1', section: 'runs' });
    expect(guard).not.toHaveBeenCalled();
    expect(store().workflowEdit).toEqual({ ...automation, section: 'runs' });

    // No section asked for: nothing changes, not even the object.
    const shown = store().workflowEdit;
    store().openAutomationEdit({ activityId: 'act-1' });
    expect(store().workflowEdit).toBe(shown);
    expect(guard).not.toHaveBeenCalled();
  });

  it('treats a pipeline named only by its id as the one shown', () => {
    store().openPipelineEdit({ pipelineId: 'deploy', source: 'user' });
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);

    store().openPipelineEdit({ pipelineId: 'deploy' }, { section: 'runs' });

    expect(guard).not.toHaveBeenCalled();
    expect(store().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'deploy',
      source: 'user',
      section: 'runs',
    });
  });

  it('asks before opening another item and waits for a deferred answer', async () => {
    store().openWorkflowEdit(automation);
    let answer: (allowed: boolean) => void = () => undefined;
    const guard = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    clear = registerNavigationGuard(guard);

    store().openPipelineEdit({ pipelineId: 'deploy' }, { section: 'trigger' });
    expect(guard).toHaveBeenCalledWith('workflows-library');
    expect(store().workflowEdit).toEqual(automation);

    answer(true);
    await flushDecision();
    expect(store().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'deploy',
      section: 'trigger',
    });
  });

  it('gives each new pipeline draft its own key, so New twice asks', () => {
    store().openPipelineEdit({ pipelineId: null });
    const first = store().workflowEdit;
    if (first?.kind !== 'pipeline') throw new Error('expected a pipeline');
    expect(first.draftKey).toEqual(expect.any(String));

    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    store().openPipelineEdit({ pipelineId: null });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(store().workflowEdit).toBe(first);

    clear();
    store().openPipelineEdit({ pipelineId: null });
    const second = store().workflowEdit;
    expect(second?.kind === 'pipeline' && second.draftKey).not.toBe(
      first.draftKey,
    );
  });

  it('keeps a shared pipeline free of a draft key', () => {
    store().openPipelineEdit({ pipelineId: null, sharedRemoteId: 'remote-1' });
    expect(store().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: null,
      sharedRemoteId: 'remote-1',
    });
  });

  it('opens each automation draft fresh with its seed', () => {
    const seed = { projectId: 'proj-1', isCowork: false };
    store().openAutomationDraft(seed);
    const first = store().workflowEdit;
    store().openAutomationDraft();
    const second = store().workflowEdit;
    if (
      first?.kind !== 'automation-draft' ||
      second?.kind !== 'automation-draft'
    ) {
      throw new Error('expected two automation drafts');
    }
    expect(first).toEqual({
      kind: 'automation-draft',
      draftKey: first.draftKey,
      seed,
    });
    expect(second).toEqual({
      kind: 'automation-draft',
      draftKey: second.draftKey,
    });
    expect(first.draftKey).not.toBe(second.draftKey);
  });

  it('closes to returnTo only once the guard allows it', async () => {
    const pipeline: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      section: 'trigger',
    };
    store().openWorkflowEdit({ ...automation, returnTo: pipeline });

    const refuse = jest.fn(() => false);
    clear = registerNavigationGuard(refuse);
    store().closeWorkflowEdit();
    expect(refuse).toHaveBeenCalledWith('workflows-library');
    expect(store().workflowEdit).toEqual({ ...automation, returnTo: pipeline });
    clear();

    let answer: (allowed: boolean) => void = () => undefined;
    clear = registerNavigationGuard(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    store().closeWorkflowEdit();
    expect(store().workflowEdit).toEqual({ ...automation, returnTo: pipeline });
    answer(true);
    await flushDecision();
    expect(store().workflowEdit).toEqual(pipeline);
    expect(store().activePage).toBe('workflows-library');
  });

  it('drops a deferred close once another item is shown', async () => {
    store().openWorkflowEdit(automation);
    let answer: (allowed: boolean) => void = () => undefined;
    clear = registerNavigationGuard(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    store().closeWorkflowEdit();
    const duplicate: WorkflowEditTarget = {
      kind: 'automation',
      activityId: 'copy',
    };
    store().replaceWorkflowEdit(duplicate);
    answer(true);
    await flushDecision();
    expect(store().workflowEdit).toEqual(duplicate);
  });

  it('closes to the Library list', () => {
    store().openWorkflowEdit(automation);
    store().closeWorkflowEdit();
    expect(store().activePage).toBe('workflows-library');
    expect(store().workflowEdit).toBeUndefined();
  });

  it('does not ask when no shell is open', () => {
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    store().closeWorkflowEdit();
    expect(guard).not.toHaveBeenCalled();
  });

  it('closes to a Plugins destination asking the guard once', () => {
    store().openPipelineEdit({
      pipelineId: 'deploy',
      returnToMarketplace: { query: 'deploy', tab: 'pipeline' },
    });
    const guard = jest.fn(() => true);
    clear = registerNavigationGuard(guard);

    store().closeWorkflowEdit();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith('plugins');
    expect(store().activePage).toBe('plugins');
    expect(store().workflowEdit).toBeUndefined();
    expect(store().pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: 'deploy',
      tab: 'workflow',
    });
  });

  it('replaces the target without asking', () => {
    store().openWorkflowEdit({ kind: 'automation-draft', draftKey: 'd-1' });
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    const count = store().workflowEditReplaceCount;

    store().replaceWorkflowEdit(automation);
    expect(store().workflowEdit).toEqual(automation);
    expect(store().workflowEditReplaceCount).toBe(count + 1);

    store().replaceWorkflowEdit(null);
    expect(store().workflowEdit).toBeUndefined();
    expect(store().activePage).toBe('workflows-library');
    expect(guard).not.toHaveBeenCalled();
  });

  it('replacing from another page opens the Library', () => {
    useNavigationStore.setState({ activePage: 'home' });
    store().replaceWorkflowEdit(automation);
    expect(store().activePage).toBe('workflows-library');
    expect(store().workflowEdit).toEqual(automation);
  });

  it('sets the section of the open shell only', () => {
    store().setWorkflowEditSection('runs');
    expect(store().workflowEdit).toBeUndefined();
    store().openWorkflowEdit(automation);
    store().setWorkflowEditSection('trigger');
    expect(store().workflowEdit).toEqual({ ...automation, section: 'trigger' });
  });

  it.each<[string, () => void]>([
    ['navigate', (): void => store().navigate('home')],
    ['a Workflows tab switch', (): void => store().navigate('workflows')],
    ['openWorkers', (): void => store().openWorkers()],
    [
      'openPluginsNavigation',
      (): void => store().openPluginsNavigation({ kind: 'browse-apps' }),
    ],
    [
      'openPipelineDispatch',
      (): void =>
        store().openPipelineDispatch({
          pipelineId: 'p',
          projectId: 'proj',
          worktreeId: 'wt',
        }),
    ],
  ])('closes the shell when %s leaves the Library', (_name, act) => {
    store().openWorkflowEdit(automation);
    act();
    expect(store().activePage).not.toBe('workflows-library');
    expect(store().workflowEdit).toBeUndefined();
  });

  it('keeps the shell for a navigation to the page already shown', () => {
    store().openWorkflowEdit(automation);
    store().navigate('workflows-library');
    store().openSettings('canopy');
    expect(store().workflowEdit).toEqual(automation);
  });

  it('closes the shell for an automation review on the Library', () => {
    store().openWorkflowEdit(automation);
    store().openAutomationSharedPipelineReview({ activityId: 'act-1' });
    expect(store().workflowEdit).toBeUndefined();
    expect(store().pendingAutomationSharedPipelineReview).toEqual({
      activityId: 'act-1',
    });
  });

  it('runWithoutNavigationGuard skips the guard and returns the result', () => {
    store().openWorkflowEdit(automation);
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);

    const result = runWithoutNavigationGuard(() => {
      store().navigate('home');
      return runWithoutNavigationGuard(() => askNavigationGuard('plugins'));
    });

    expect(result).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(store().activePage).toBe('home');
    // The bypass ends with the call.
    expect(askNavigationGuard('plugins')).toBe(false);
    expect(guard).toHaveBeenCalledWith('plugins');
  });

  it('runWithoutNavigationGuard ends the bypass when fn throws', () => {
    const guard = jest.fn(() => false);
    clear = registerNavigationGuard(guard);
    expect(() =>
      runWithoutNavigationGuard(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(askNavigationGuard('home')).toBe(false);
  });
});
