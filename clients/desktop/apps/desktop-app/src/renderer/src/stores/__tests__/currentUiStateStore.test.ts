/**
 * @jest-environment jsdom
 */
import { useBrowserStore } from '@/stores/browserStore';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { SIDEBAR_DEFAULT_WIDTH, useSidebarStore } from '@/stores/sidebarStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { listAvailablePages } from '@/lib/navigation/page-availability';
import { searchAppAdvisorActions } from '@canopy/desktop-shared/lib/app-advisor-actions';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';

beforeEach(() => {
  useCurrentUiStateStore.setState({ revision: 0, slices: {} });
  resetLabsExperimentsStoreForTest();
  // The Labs page experiments are on, so their pages are reachable (CAN-3678).
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ revision: 0, experiments: pageExperimentsOn() }),
  );
  useFeatureFlagsStore.setState({
    snapshot: {
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-portal-enabled': true,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    },
  });
  useChatStore.setState({ selectedWorktree: null });
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  useProjectsStore.setState({ projects: [] });
  usePipelineRunsStore.setState({
    currentCwd: null,
    currentProjectId: null,
    currentWorktreeId: null,
    summaries: [],
    statesById: {},
  });
  useCanopyPortalStore.setState({
    hydrated: true,
    state: {
      status: 'pending_auth',
      connectionStatus: 'inactive',
      sessionId: 'sess',
      pairingCode: '123456',
      hostCode: null,
      pairingCodeExpiresAt: new Date().toISOString(),
      machineName: null,
      activatedAt: null,
      lastSeenAt: null,
      lastErrorAt: null,
      error: null,
    },
  });
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
  useSidebarStore.setState({
    hidden: false,
    width: SIDEBAR_DEFAULT_WIDTH,
    hydrated: true,
    codeSectionCollapsed: false,
    chatsSectionCollapsed: false,
  });
});

it('includes the forwarded App Advisor project state as ids and booleans only', () => {
  useCurrentUiStateStore.getState().updateSlice('appAdvisor.window', {
    activeWorkEntryId: 'entry-1',
    activeChatId: 'chat-1',
    navCollapsed: true,
    settingsModalOpen: false,
  });

  expect(
    useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor,
  ).toMatchObject({
    activeWorkEntryId: 'entry-1',
    activeChatId: 'chat-1',
    navCollapsed: true,
    settingsModalOpen: false,
  });
});

afterEach(() => {
  const panelStore = usePanelLayoutStore.getState();
  for (const key of Object.keys(panelStore.layouts)) {
    panelStore.disposeLayout(key);
  }
});

describe('currentUiStateStore.recomputeEnvelope', () => {
  it('keeps the revision on a Portal heartbeat so a guarded action can still match it', () => {
    // CAN-3592: a connected Portal stamps lastSeenAt every few seconds. When
    // the snapshot carried it, every heartbeat advanced the revision and each
    // guarded Advisor action was refused as stale_ui_state.
    const connected = {
      status: 'active' as const,
      connectionStatus: 'active' as const,
      sessionId: 'sess',
      pairingCode: null,
      hostCode: null,
      pairingCodeExpiresAt: null,
      machineName: null,
      activatedAt: '2026-10-13T11:00:00.000Z',
      lastSeenAt: '2026-10-13T11:05:02.178Z',
      lastErrorAt: null,
      error: null,
    };
    useCanopyPortalStore.setState({ hydrated: true, state: connected });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    const before = useCurrentUiStateStore.getState().envelope;
    useCanopyPortalStore.setState({
      hydrated: true,
      state: { ...connected, lastSeenAt: '2026-10-13T11:05:07.439Z' },
    });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    const after = useCurrentUiStateStore.getState().envelope;
    expect(after.revision).toBe(before.revision);
    expect(after.snapshot.canopyPortal).not.toHaveProperty('lastSeenAt');
  });

  it('preserves the availablePages contract when a large snapshot is reduced for transport', () => {
    const flags = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.getState().setSnapshot({
      ...flags,
      values: { ...flags.values, 'canopy-desktop-claude-tui-workers': true },
    });
    const pages = listAvailablePages();
    useCurrentUiStateStore.getState().updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'x'.repeat(50_000),
    });
    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(utf8ByteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(envelope.snapshot.availablePages).toEqual(pages);
    const discovery = searchAppAdvisorActions({
      availablePages: envelope.snapshot.availablePages,
      actionType: 'navigation.go_to_page',
    });
    expect(
      discovery.actions[0]?.fields.find((field) => field.name === 'page')?.type,
    ).toContain("'workers'");

    useFeatureFlagsStore.getState().setSnapshot({
      ...flags,
      values: { ...flags.values, 'canopy-desktop-claude-tui-workers': false },
    });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.availablePages,
    ).toEqual(listAvailablePages());
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.availablePages,
    ).not.toContain('workers');
  });
  it('redacts the Canopy Portal pairing code while preserving visibility flags', () => {
    const store = useCurrentUiStateStore.getState();
    store.recomputeEnvelope();
    const envelope = useCurrentUiStateStore.getState().envelope;
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('123456');
    expect(envelope.snapshot.canopyPortal?.pairingCodeVisible).toBe(true);
    expect(envelope.snapshot.canopyPortal?.featureEnabled).toBe(true);
    // The desktop app is bound to exactly one Canopy Cloud backend; the
    // assistant-visible snapshot intentionally omits any server identity
    // so server selection cannot leak into the assistant context.
    expect(serialized).not.toContain('selectedServerId');
    expect(serialized).not.toContain('selectedServerName');
    expect(serialized).not.toContain('selectedServerBaseUrl');
  });

  it('includes the current Canopy Portal feature flag state', () => {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-portal-enabled': false,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });

    const store = useCurrentUiStateStore.getState();
    store.recomputeEnvelope();

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.canopyPortal
        ?.featureEnabled,
    ).toBe(false);
  });

  it('only bumps the revision when the digest changes', () => {
    const store = useCurrentUiStateStore.getState();
    store.recomputeEnvelope();
    const first = useCurrentUiStateStore.getState();
    const firstRev = first.revision;

    store.recomputeEnvelope();
    expect(useCurrentUiStateStore.getState().revision).toBe(firstRev);

    useNavigationStore.setState({ settingsOpen: true });
    store.recomputeEnvelope();
    expect(useCurrentUiStateStore.getState().revision).toBeGreaterThan(
      firstRev,
    );
  });

  it('reflects reporter slices in the envelope', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('appAdvisor.dialogOpen', true);
    store.updateSlice('plugins.page', {
      view: 'management',
      managementSection: 'collections',
      searchActive: false,
      resultCount: 0,
    });
    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.overlays.appAdvisorOpen).toBe(true);
    expect(envelope.snapshot.plugins).toEqual({
      page: {
        view: 'management',
        managementSection: 'collections',
        searchActive: false,
        resultCount: 0,
      },
    });
  });

  it('sanitizes branch-from confirmation state for App Advisor', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('worktree.branchFromModal', {
      open: true,
      confirmationId: 'confirmation-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      menuOpen: true,
      diff: 'private working tree content',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.appAdvisor?.branchFromModal).toEqual({
      open: true,
      confirmationId: 'confirmation-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      menuOpen: true,
    });
    expect(JSON.stringify(envelope)).not.toContain(
      'private working tree content',
    );
  });

  it('includes sanitized settings targeted-update modal reporter state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('settings.targetUpdate', {
      versionPickerOpen: true,
      downgradeConfirmationOpen: true,
      versionSearch: 'internal-124',
      versionCount: 3,
      hasMoreVersions: true,
      loading: false,
      pending: true,
      errorVisible: true,
      selectedVersionTag: 'internal-123',
      selectedVersionRelation: 'downgrade',
      ignored: 'not included',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.settings?.targetUpdate).toEqual({
      versionPickerOpen: true,
      downgradeConfirmationOpen: true,
      versionSearch: 'internal-124',
      versionCount: 3,
      hasMoreVersions: true,
      loading: false,
      pending: true,
      errorVisible: true,
      selectedVersionTag: 'internal-123',
      selectedVersionRelation: 'downgrade',
    });
    expect(JSON.stringify(envelope)).not.toContain('not included');
  });

  it('includes sanitized Ollama settings state without executable paths or error text', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('settings.ollama', {
      loaded: true,
      mode: 'managed',
      status: 'stopped',
      installationReady: true,
      automaticInstallSupported: true,
      installationSource: 'installed',
      installationVersion: '0.15.0',
      installing: true,
      installPhase: 'verifying',
      errorVisible: true,
      executablePath: '/private/Applications/Ollama.app/ollama',
      error: 'secret local failure text',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.settings?.ollama).toEqual({
      loaded: true,
      mode: 'managed',
      status: 'stopped',
      installationReady: true,
      automaticInstallSupported: true,
      installationSource: 'installed',
      installationVersion: '0.15.0',
      installing: true,
      installPhase: 'verifying',
      errorVisible: true,
    });
    expect(JSON.stringify(envelope)).not.toContain('/private/Applications');
    expect(JSON.stringify(envelope)).not.toContain('secret local failure text');
  });

  it('includes sanitized local memory settings state without extra payload keys', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('settings.localMemory', {
      loaded: true,
      enabled: false,
      memoryDirPath: '/private/home/user/.canopy/memory',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.settings?.localMemory).toEqual({
      loaded: true,
      enabled: false,
    });
    expect(JSON.stringify(envelope)).not.toContain('/private/home/user');
  });

  it('includes a compact panels slice for the selected worktree layout', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    usePanelLayoutStore
      .getState()
      .initializeLayout(makeWorktreePanelKey('project-1', 'worktree-1'), {
        orientation: 'horizontal',
        groups: [
          { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
          { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
        ],
        containerSize: { width: 900, height: 600 },
      });
    usePanelLayoutStore
      .getState()
      .collapseGroup(
        makeWorktreePanelKey('project-1', 'worktree-1'),
        'group-b',
      );
    useWorkspaceLayoutModeStore.setState({
      entries: {
        'project-1/worktree-1': {
          mode: 'minimal',
          status: 'ready',
          requestId: 1,
        },
      },
    });

    useCurrentUiStateStore.getState().recomputeEnvelope();

    expect(useCurrentUiStateStore.getState().envelope.snapshot.panels).toEqual({
      layoutMode: 'minimal',
      layoutModeStatus: 'ready',
      groups: [
        {
          groupId: 'group-a',
          tabs: [{ panelId: 'panel-a', kind: 'chat' }],
          activePanelId: 'panel-a',
        },
        {
          groupId: 'group-b',
          tabs: [{ panelId: 'panel-b', kind: 'terminal' }],
          collapsed: true,
        },
      ],
      activeGroupId: 'group-a',
    });
  });

  it('reports the maximized panel group in the panels slice', () => {
    const key = makeWorktreePanelKey('project-1', 'worktree-1');
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
        { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
      ],
      containerSize: { width: 900, height: 600 },
    });
    usePanelLayoutStore.getState().maximizeGroup(key, 'group-b', true);

    useCurrentUiStateStore.getState().recomputeEnvelope();

    const panels = useCurrentUiStateStore.getState().envelope.snapshot.panels;
    expect(panels?.maximizedGroupId).toBe('group-b');
    expect(panels?.activeGroupId).toBe('group-b');
  });

  it('omits the panels slice when no worktree is selected or no layout is built', () => {
    // Layout exists but no worktree is selected.
    usePanelLayoutStore
      .getState()
      .initializeLayout(makeWorktreePanelKey('project-1', 'worktree-1'), {
        orientation: 'horizontal',
        groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
        containerSize: { width: 800, height: 600 },
      });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.panels,
    ).toBeUndefined();

    // Worktree selected but its layout has not been built.
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-2' },
    });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.panels,
    ).toBeUndefined();
  });

  it('includes sanitized adhoc existing-worktree join modal state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('worktree.adhocJoinModal', {
      open: true,
      sourceWorkspaceId: 'source-workspace',
      sourceWorktreeId: 'source-worktree',
      pickerMode: 'existing-worktrees',
      mode: 'temporary',
      existingWorkspaceGroupCount: 1,
      existingCandidateCount: 2,
      selectedExisting: {
        workspaceId: 'join-workspace',
        worktreeId: 'join-worktree',
        workspaceName: 'Join Workspace',
        worktreeName: 'join-feature',
        ignoredObject: { secret: 'not included' },
      },
      loading: false,
      submitting: true,
      errorVisible: false,
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.adhocJoinModal,
    ).toEqual({
      open: true,
      sourceWorkspaceId: 'source-workspace',
      sourceWorktreeId: 'source-worktree',
      pickerMode: 'existing-worktrees',
      mode: 'temporary',
      existingWorkspaceGroupCount: 1,
      existingCandidateCount: 2,
      selectedExisting: {
        workspaceId: 'join-workspace',
        worktreeId: 'join-worktree',
        workspaceName: 'Join Workspace',
        worktreeName: 'join-feature',
      },
      loading: false,
      submitting: true,
      errorVisible: false,
    });
  });

  it('includes sanitized tracked-plan share modal state in active chat context', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Current chat',
      status: 'idle',
    });
    store.updateSlice('plans.shareModal', {
      open: true,
      planId: 'plan-1',
      planTitle: 'Shareable plan',
      scope: 'team',
      busy: true,
      teamId: 'team-1',
      remoteUrl: 'https://token@example.test/acme/repo.git',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.activeChat?.sharePlanModal).toEqual({
      open: true,
      planId: 'plan-1',
      planTitle: 'Shareable plan',
      scope: 'team',
      busy: true,
      teamId: 'team-1',
    });
    expect(JSON.stringify(envelope)).not.toContain('token@example.test');
  });

  it('includes sanitized tool-approval dock state in active chat context', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Current chat',
      status: 'awaiting_user',
    });
    store.updateSlice('chat.toolApprovalDock', {
      visible: true,
      pendingCount: 2,
      selectedIndex: 1,
      provider: 'codex',
      requestKind: 'command',
      subagent: true,
      command: 'secret command text',
    });

    const activeChat =
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat;
    expect(activeChat?.toolApprovalDock).toEqual({
      visible: true,
      pendingCount: 2,
      selectedIndex: 1,
      provider: 'codex',
      requestKind: 'command',
      subagent: true,
    });
    expect(JSON.stringify(activeChat)).not.toContain('secret command text');
  });

  it('includes sanitized tracked-plan import modal state in active chat context', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Current chat',
      status: 'idle',
    });
    store.updateSlice('plans.importModal', {
      open: true,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      selectedGroup: 'suggestions',
      importing: true,
      originChatId: 'chat-1',
      detectedEntryCount: 3,
      activeDetectedEntryCount: 2,
      dismissedEntryCount: 1,
      sourceFilePath: '/private/tmp/secret-plan.md',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.activeChat?.importPlanModal).toEqual({
      open: true,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      selectedGroup: 'suggestions',
      importing: true,
      originChatId: 'chat-1',
      detectedEntryCount: 3,
      activeDetectedEntryCount: 2,
      dismissedEntryCount: 1,
    });
    expect(JSON.stringify(envelope)).not.toContain('secret-plan');
  });

  it('reports the plugins discovery page without the search text', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('plugins.page', {
      view: 'discovery',
      managementSection: null,
      searchActive: true,
      resultCount: 7.6,
      query: 'must not be copied',
    });

    const plugins = useCurrentUiStateStore.getState().envelope.snapshot.plugins;
    expect(plugins).toEqual({
      page: { view: 'discovery', searchActive: true, resultCount: 7 },
    });
    expect(JSON.stringify(plugins)).not.toContain('must not be copied');
  });

  it('still reads the retired plugins management view slice', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('plugins.managementView', {
      section: 'marketplaces',
      installedCount: 3,
      removeMarketplaceModal: {
        marketplaceId: 'mkt-1',
        marketplaceName: 'Acme Plugins',
        validProviders: ['claude', 'codex'],
      },
    });

    expect(useCurrentUiStateStore.getState().envelope.snapshot.plugins).toEqual(
      {
        managementView: {
          section: 'marketplaces',
          installedCount: 3,
          removeMarketplaceModal: {
            marketplaceId: 'mkt-1',
            marketplaceName: 'Acme Plugins',
            validProviders: ['claude', 'codex'],
          },
        },
      },
    );
  });

  it('reports the unified entry detail without source object contents', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('plugins.entryDetail', {
      open: true,
      entryId: 'mcp-catalog:github',
      kind: 'app',
      state: 'needs-auth',
      refType: 'curated-mcp',
      editingSharedSkill: true,
      editingCollection: false,
      endpointUrl: 'https://must-not-be-copied.example',
    });

    const plugins = useCurrentUiStateStore.getState().envelope.snapshot.plugins;
    expect(plugins).toEqual({
      entryDetail: {
        open: true,
        entryId: 'mcp-catalog:github',
        kind: 'app',
        state: 'needs-auth',
        refType: 'curated-mcp',
        editingSharedSkill: true,
        editingCollection: false,
      },
    });
    expect(JSON.stringify(plugins)).not.toContain('must-not-be-copied');
  });

  it('accepts a pipeline unified entry detail ref type', () => {
    useCurrentUiStateStore.getState().updateSlice('plugins.entryDetail', {
      open: true,
      entryId: 'pipeline:user:review',
      kind: 'pipeline',
      state: 'installed',
      refType: 'pipeline',
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.plugins?.entryDetail,
    ).toEqual({
      open: true,
      entryId: 'pipeline:user:review',
      state: 'installed',
      refType: 'pipeline',
    });
  });

  it('reports sanitized curated MCP browse and detail modal state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('plugins.mcpBrowseModal', {
      open: true,
      view: 'detail',
      resultCount: 4.8,
      query: 'must not be copied',
      selectedEntry: {
        key: 'github',
        name: 'GitHub',
        installed: true,
        endpointUrl: 'must not be copied',
      },
    });

    expect(useCurrentUiStateStore.getState().envelope.snapshot.plugins).toEqual(
      {
        mcpBrowseModal: {
          open: true,
          view: 'detail',
          resultCount: 4,
          selectedEntry: {
            key: 'github',
            name: 'GitHub',
            installed: true,
          },
        },
      },
    );
  });

  it('reports selected Collection row state and normalizes legacy bundle row kind', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('plugins.selectedRow', {
      kind: 'bundle',
      id: 'collection-1',
      name: 'Review Pack',
    });

    expect(useCurrentUiStateStore.getState().envelope.snapshot.plugins).toEqual(
      {
        selectedRow: {
          kind: 'collection',
          id: 'collection-1',
          name: 'Review Pack',
        },
      },
    );
  });

  it('includes shared skill and Collection workflow state in the plugins snapshot', () => {
    const store = useCurrentUiStateStore.getState();
    // Reporters may still emit `activeServerId` / detail-`serverId` because the
    // app is being migrated; the snapshot builder MUST strip them.
    store.updateSlice('plugins.sharedSkills', {
      activeServerId: 'server-skills',
      filters: { query: 'review', createdBy: 'me' },
      shareModalOpen: true,
      detailModal: {
        mode: 'edit',
        serverId: 'server-skills',
        id: 'skill-1',
        name: 'Review Skill',
      },
    });
    store.updateSlice('plugins.sharedCollections', {
      activeServerId: 'server-collections',
      filters: { createdBy: 'anyone' },
      shareModalOpen: false,
      importing: true,
      detailModal: {
        mode: 'view',
        serverId: 'server-collections',
        id: 'collection-1',
        name: 'Review Collection',
      },
    });

    expect(useCurrentUiStateStore.getState().envelope.snapshot.plugins).toEqual(
      {
        sharedSkills: {
          filters: { query: 'review', createdBy: 'me' },
          shareModalOpen: true,
          detailModal: {
            mode: 'edit',
            id: 'skill-1',
            name: 'Review Skill',
          },
        },
        sharedCollections: {
          filters: { createdBy: 'anyone' },
          shareModalOpen: false,
          importing: true,
          detailModal: {
            mode: 'view',
            id: 'collection-1',
            name: 'Review Collection',
          },
        },
      },
    );
  });

  it('includes sanitized Canopy Portal modal reporter state', () => {
    const store = useCurrentUiStateStore.getState();
    // Reporters may still publish server-identity fields during the
    // migration; the snapshot builder MUST drop them and keep only
    // `open`, `busy`, `errorVisible`, `viewPortalVisible`, and
    // `pairingQrVisible` (CAN-2938: visibility only, never the QR's URL).
    store.updateSlice('canopyPortal.modal', {
      open: true,
      selectedServerId: 'srv',
      busy: 'regenerating',
      serverListStatus: 'success',
      errorVisible: true,
      viewPortalVisible: true,
      pairingQrVisible: true,
      pairingUrl: 'https://cloud.example.test/portal/pair#code=123456',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.canopyPortal?.modal).toEqual({
      open: true,
      busy: 'regenerating',
      errorVisible: true,
      viewPortalVisible: true,
      pairingQrVisible: true,
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('selectedServerId');
    expect(serialized).not.toContain('serverListStatus');
    expect(serialized).not.toContain('portal/pair');
  });

  it('includes sanitized customize sidebar modal reporter state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('sidebar.customizeModal', {
      open: true,
      itemCount: 8,
      order: ['app-advisor'],
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.sidebar?.customizeModal).toEqual({
      open: true,
      itemCount: 8,
    });
    expect(JSON.stringify(envelope)).not.toContain('app-advisor');
  });

  it('reports resume readiness only for gated resume origins', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('usageLimit.resumeModal', {
      open: true,
      origin: 'home',
      loading: false,
      selectedCount: 2,
      readinessPending: false,
      readyCount: 2,
      waitingCount: 1,
    });
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.usageLimitResumeModal,
    ).toEqual({
      open: true,
      origin: 'home',
      loading: false,
      selectedCount: 2,
      readinessPending: false,
      readyCount: 2,
      waitingCount: 1,
    });
    store.updateSlice('usageLimit.resumeModal', {
      open: true,
      origin: 'account-change',
      provider: 'codex',
      selectedCount: 3,
    });
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.usageLimitResumeModal,
    ).toEqual({
      open: true,
      origin: 'account-change',
      provider: 'codex',
      selectedCount: 3,
    });
  });

  it('includes sanitized App Advisor watchers modal reporter state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('appAdvisor.watchersModal', {
      open: true,
      chatId: 'advisor-chat',
      watcherCount: 2,
      confirmingDelete: true,
    });
    store.updateSlice('usageLimit.resumeModal', {
      open: true,
      origin: 'authentication',
      provider: 'claude',
      loading: false,
      submitting: true,
      groupCount: 2,
      chatCount: 5,
      pipelineCount: 4,
      selectedCount: 3,
      chatTitle: 'Secret chat title',
    });
    store.updateSlice('auth.loginModal', {
      open: true,
      provider: 'codex',
      snapshotsAvailable: true,
      snapshotsPanelOpen: true,
      accountEmail: 'secret@example.com',
      terminalOutput: 'SECRET TERMINAL OUTPUT',
      usagePercent: 55,
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.appAdvisor?.watchersModal).toEqual({
      open: true,
      chatId: 'advisor-chat',
      watcherCount: 2,
      confirmingDelete: true,
    });
    expect(envelope.snapshot.appAdvisor?.usageLimitResumeModal).toEqual({
      open: true,
      origin: 'authentication',
      provider: 'claude',
      loading: false,
      submitting: true,
      groupCount: 2,
      chatCount: 5,
      pipelineCount: 4,
      selectedCount: 3,
    });
    expect(envelope.snapshot.appAdvisor?.authLoginModal).toEqual({
      open: true,
      provider: 'codex',
      snapshotsAvailable: true,
      snapshotsPanelOpen: true,
    });
    expect(JSON.stringify(envelope)).not.toContain('/secret/path');
    expect(JSON.stringify(envelope)).not.toContain('Secret chat title');
    expect(JSON.stringify(envelope)).not.toContain('secret@example.com');
    expect(JSON.stringify(envelope)).not.toContain('SECRET TERMINAL OUTPUT');
  });

  it('includes sanitized PR merge modal reporter state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('appAdvisor.watchersModal', {
      open: true,
      chatId: 'advisor-chat',
      watcherCount: 1,
    });
    store.updateSlice('github.prMergeModal', {
      open: true,
      mode: 'multi-repo',
      submitting: false,
      repoCount: 2,
      mergeableRepoCount: 1,
      blockedRepoCount: 1,
      unresolvedRepoCount: 1,
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          prNumber: 10,
          prUrl: 'https://github.com/org/repo-a/pull/10',
          mergeable: true,
          unresolvedReviewThreadCount: 0,
          ignored: { secret: 'not included' },
        },
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          prNumber: 11,
          prUrl: 'https://github.com/org/repo-b/pull/11',
          mergeable: false,
          blockedReason: 'has_conflicts',
          unknownReviewThreadState: true,
        },
      ],
    });

    const { appAdvisor } = useCurrentUiStateStore.getState().envelope.snapshot;
    expect(appAdvisor?.watchersModal).toEqual({
      open: true,
      chatId: 'advisor-chat',
      watcherCount: 1,
    });
    expect(appAdvisor?.prMergeModal).toEqual({
      open: true,
      mode: 'multi-repo',
      submitting: false,
      repoCount: 2,
      mergeableRepoCount: 1,
      blockedRepoCount: 1,
      unresolvedRepoCount: 1,
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          prNumber: 10,
          prUrl: 'https://github.com/org/repo-a/pull/10',
          mergeable: true,
          unresolvedReviewThreadCount: 0,
        },
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          prNumber: 11,
          prUrl: 'https://github.com/org/repo-b/pull/11',
          mergeable: false,
          blockedReason: 'has_conflicts',
          unknownReviewThreadState: true,
        },
      ],
    });
    expect(JSON.stringify(appAdvisor)).not.toContain('secret');
  });

  it('includes sanitized base-branch alignment modal state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('github.baseBranchAlignmentModal', {
      open: true,
      confirmationId: 'confirmation-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      driftCount: 2,
      repositoryNames: ['App', 'Docs'],
      privateBranchNames: ['secret/base'],
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.baseBranchAlignmentModal,
    ).toEqual({
      open: true,
      confirmationId: 'confirmation-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      driftCount: 2,
      repositoryNames: ['App', 'Docs'],
    });
    expect(
      JSON.stringify(
        useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor,
      ),
    ).not.toContain('secret/base');
  });

  it('includes sanitized merge queue popover state', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('github.mergeQueuePopover', {
      open: true,
      phase: 'queued',
      position: 3,
      etaMinutes: 19,
      queueLength: 9,
      repoCount: 1,
      otherTitles: ['secret: someone else'],
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.mergeQueuePopover,
    ).toEqual({
      open: true,
      phase: 'queued',
      position: 3,
      etaMinutes: 19,
      queueLength: 9,
      repoCount: 1,
    });
    expect(
      JSON.stringify(
        useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor,
      ),
    ).not.toContain('secret');

    store.updateSlice('github.mergeQueuePopover', {
      open: true,
      phase: 'unknown-phase',
      position: -1,
    });
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.mergeQueuePopover,
    ).toEqual({ open: true });
  });

  it('enforces the serialized hidden context size cap', () => {
    const store = useCurrentUiStateStore.getState();
    const oversizedTitle = 'x'.repeat(50_000);

    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: oversizedTitle,
      status: 'idle',
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    const serialized = JSON.stringify(envelope);
    expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(16 * 1024);
    expect(serialized).not.toContain(oversizedTitle);
  });

  it('reads selected project/worktree metadata and active pipeline context from renderer stores', () => {
    const summary: ExecutionSummary = {
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_name: 'Build',
      status: 'running',
      status_reasons: [
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-05-19T00:00:00.000Z',
          source: {
            job_id: 'review',
            step_id: 'agent',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      started_at: '2026-05-19T00:00:00.000Z',
      cwd: '/repo',
      event_name: 'dispatch',
      project_id: 'project-1',
      worktree_id: 'worktree-1',
    };
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Repo chat',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: '2026-05-19T00:00:00.000Z',
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: {
                thinkingLevel: 'high',
                speed: 'standard',
                fastMode: false,
              },
              fastModeExplicit: false,
              selectedRepoId: 'repo-a',
            },
          ],
        },
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-1',
          name: 'Canopy',
          repoPath: '/repo',
          color: '#123456',
          worktrees: [
            {
              id: 'worktree-1',
              branchName: 'feature/app-advisor',
              createdAt: '2026-05-19T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
    usePipelineRunsStore.setState({
      currentCwd: '/repo',
      currentProjectId: 'project-1',
      currentWorktreeId: 'worktree-1',
      summaries: [summary],
    });

    const store = useCurrentUiStateStore.getState();
    store.recomputeEnvelope();
    const { snapshot } = useCurrentUiStateStore.getState().envelope;

    expect(snapshot.selectedWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-a',
      projectName: 'Canopy',
      workspaceDisplayName: 'Canopy',
      workspaceType: 'single-repo',
      workspaceRepoCount: 1,
      worktreeName: 'feature/app-advisor',
    });
    expect(snapshot.activePipeline).toEqual({
      pipelineId: 'pipeline-1',
      name: 'Build',
    });
    expect(snapshot.activePipelineRun).toEqual({
      executionId: 'execution-1',
      pipelineId: 'pipeline-1',
      status: 'running',
      resumableStatusReasons: [
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          jobId: 'review',
          stepId: 'agent',
        },
      ],
    });
  });

  it('includes temporary multi-repo project metadata in selected worktree context', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      worktreeChats: {},
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'multi-repo',
          id: 'workspace-1',
          name: 'Adhoc Workspace',
          color: '#123456',
          temporary: true,
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repo-a',
              source: 'local',
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              repoPath: '/repo-b',
              source: 'local',
            },
          ],
          worktrees: [
            {
              id: 'worktree-1',
              branchName: 'feature/joined',
              createdAt: '2026-05-19T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    useCurrentUiStateStore.getState().recomputeEnvelope();
    const { snapshot } = useCurrentUiStateStore.getState().envelope;

    expect(snapshot.selectedWorktree).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      projectName: 'Repo A & Repo B',
      workspaceDisplayName: 'Repo A & Repo B',
      workspaceType: 'multi-repo',
      workspaceTemporary: true,
      workspaceRepoCount: 2,
      worktreeName: 'feature/joined',
    });
  });

  it('uses reporter slices for active chat, file, terminal, pipeline run, and pipeline editor metadata', () => {
    const store = useCurrentUiStateStore.getState();

    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Investigate',
      status: 'streaming',
      providerType: 'codex',
      model: 'gpt-5.5',
    });
    store.updateSlice('files.activeTab', {
      tabId: 'tab-1',
      path: '/repo/src/index.ts',
      mode: 'raw',
      dirty: true,
      fileTreeVisible: true,
    });
    store.updateSlice('files.commentsDrawer.tab-other', {
      active: true,
      visible: false,
      collapsed: true,
      heightPercent: 60,
      totalCount: 9,
      activeCount: 8,
      stagedCount: 7,
    });
    store.updateSlice('files.commentsDrawer.tab-1', {
      active: true,
      visible: true,
      collapsed: false,
      heightPercent: 34,
      totalCount: 3,
      activeCount: 2,
      stagedCount: 1,
    });
    store.updateSlice('terminal.drawer', {
      drawerOpen: true,
      activeSessionId: 'terminal-1',
      runningCount: 2,
    });
    store.updateSlice('pipelines.activeEditor', {
      pipelineId: 'pipeline-1',
      name: 'Build',
      editorOpen: true,
      dirty: true,
      readonly: true,
      activeView: 'details',
    });
    store.updateSlice('pipelines.chatPanel', {
      visible: true,
      widthPercent: 34,
    });
    store.updateSlice('pipelineRuns.debugProgress', {
      executionId: 'execution-1',
      status: 'debugging',
      inputRequired: true,
      resumable: false,
      transientRetry: {
        attempt: 2,
        maxAttempts: 4,
        nextRetryAt: 60_000,
        exhausted: false,
      },
    });

    const envelope = useCurrentUiStateStore.getState().envelope;
    expect(envelope.snapshot.activeChat).toEqual({
      chatId: 'chat-1',
      title: 'Investigate',
      status: 'streaming',
      providerType: 'codex',
      model: 'gpt-5.5',
    });
    expect(envelope.snapshot.activeFile).toEqual({
      path: '/repo/src/index.ts',
      mode: 'raw',
      dirty: true,
      fileTreeVisible: true,
      commentsDrawer: {
        visible: true,
        collapsed: false,
        heightPercent: 34,
        totalCount: 3,
        activeCount: 2,
        stagedCount: 1,
      },
    });
    expect(envelope.snapshot.terminal).toEqual({
      drawerOpen: true,
      activeSessionId: 'terminal-1',
      runningCount: 2,
    });
    expect(envelope.snapshot.activePipeline).toEqual({
      pipelineId: 'pipeline-1',
      name: 'Build',
      editorOpen: true,
      dirty: true,
      readonly: true,
      activeView: 'details',
    });
    expect(envelope.snapshot.pipelineChatPanel).toEqual({
      visible: true,
      widthPercent: 34,
    });
    expect(envelope.snapshot.activePipelineRun).toEqual({
      executionId: 'execution-1',
      status: 'debugging',
      inputRequired: true,
      resumable: false,
      transientRetry: {
        attempt: 2,
        maxAttempts: 4,
        nextRetryAt: 60_000,
        exhausted: false,
      },
    });
  });

  it('reflects the sidebar store as a compact sidebar slice in the envelope', () => {
    const store = useCurrentUiStateStore.getState();
    store.recomputeEnvelope();

    expect(useCurrentUiStateStore.getState().envelope.snapshot.sidebar).toEqual(
      {
        hidden: false,
        previewing: false,
        previewVisible: false,
        width: SIDEBAR_DEFAULT_WIDTH,
        codeSectionCollapsed: false,
        chatsSectionCollapsed: false,
      },
    );

    useSidebarStore.setState({
      hidden: true,
      width: 320,
      codeSectionCollapsed: true,
      chatsSectionCollapsed: false,
    });
    store.recomputeEnvelope();

    expect(useCurrentUiStateStore.getState().envelope.snapshot.sidebar).toEqual(
      {
        hidden: true,
        previewing: false,
        previewVisible: false,
        width: 320,
        codeSectionCollapsed: true,
        chatsSectionCollapsed: false,
      },
    );
  });

  it('forwards the automations.page reporter slice into the envelope', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('automations.page', {
      activeTab: 'scheduled',
      activityCount: 3,
      enabledActivityCount: 2,
      previouslyTriggeredCount: 1,
      watcherCount: 1,
      selectedActivityId: 'activity-1',
      sharedPipelineReviewModalOpen: true,
      sharedPipelineReviewActivityId: 'activity-1',
    });
    // The form and run history are the Workflows edit shell now (CAN-4072);
    // the envelope reads their flags from its slice.
    store.updateSlice('workflows.editShell', {
      kind: 'automation',
      id: 'activity-1',
      section: 'definition',
      dirty: false,
      readonly: false,
      draft: false,
    });
    store.recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.automations,
    ).toEqual({
      activeTab: 'scheduled',
      activityCount: 3,
      enabledActivityCount: 2,
      previouslyTriggeredCount: 1,
      watcherCount: 1,
      selectedActivityId: 'activity-1',
      formOpen: true,
      detailsModalOpen: false,
      sharedPipelineReviewModalOpen: true,
      sharedPipelineReviewActivityId: 'activity-1',
    });

    store.updateSlice('workflows.editShell', {
      kind: 'automation',
      id: 'activity-1',
      section: 'runs',
      dirty: false,
      readonly: false,
      draft: false,
    });
    store.recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.automations,
    ).toEqual(
      expect.objectContaining({
        formOpen: true,
        detailsModalOpen: true,
        detailsModalActivityId: 'activity-1',
      }),
    );

    // Closing the shell drops its slice, and both flags with it.
    store.updateSlice('workflows.editShell', null);
    store.recomputeEnvelope();
    const closed =
      useCurrentUiStateStore.getState().envelope.snapshot.automations;
    expect(closed).toEqual(
      expect.objectContaining({ formOpen: false, detailsModalOpen: false }),
    );
    expect(closed).not.toHaveProperty('detailsModalActivityId');
  });

  it('ignores a page reporter that still claims the old dialog flags', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('automations.page', {
      activeTab: 'scheduled',
      formOpen: true,
      detailsModalOpen: true,
      detailsModalActivityId: 'activity-1',
    });
    store.recomputeEnvelope();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.automations,
    ).toEqual({
      activeTab: 'scheduled',
      formOpen: false,
      detailsModalOpen: false,
    });
  });

  it('drops unknown automations.page activeTab values from the snapshot', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('automations.page', {
      activeTab: 'rogue',
      activityCount: 0,
      watcherCount: 0,
    });
    store.recomputeEnvelope();
    const automations =
      useCurrentUiStateStore.getState().envelope.snapshot.automations;
    expect(automations?.activeTab).toBeUndefined();
    expect(automations?.activityCount).toBe(0);
    expect(automations?.watcherCount).toBe(0);
  });

  it('forwards scheduled, usage-limit, and transient-retry state into activeChat', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Investigate',
      status: 'idle',
      usageLimitBannerVisible: true,
      usageResumeScheduled: true,
      transientRetry: {
        provider: 'codex',
        attempt: 2,
        maxAttempts: 5,
        nextRetryAt: 1_784_570_000_000,
        exhausted: false,
      },
      scheduledMessageCount: 2,
      scheduleModalOpen: true,
      scheduledMessageInlineEditOpen: true,
      scheduledMessageEditId: 'activity-8',
      automationEditModalOpen: true,
      automationEditId: 'activity-9',
    });
    store.recomputeEnvelope();
    const activeChat =
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat;
    expect(activeChat).toMatchObject({
      chatId: 'chat-1',
      usageLimitBannerVisible: true,
      usageResumeScheduled: true,
      transientRetry: {
        provider: 'codex',
        attempt: 2,
        maxAttempts: 5,
        nextRetryAt: 1_784_570_000_000,
        exhausted: false,
      },
      scheduledMessageCount: 2,
      scheduleModalOpen: true,
      scheduledMessageInlineEditOpen: true,
      scheduledMessageEditId: 'activity-8',
      automationEditModalOpen: true,
      automationEditId: 'activity-9',
    });
  });

  it('omits scheduled, usage-limit, and retry fields when inactive', () => {
    const store = useCurrentUiStateStore.getState();
    store.updateSlice('chat.activeTab', {
      chatId: 'chat-1',
      title: 'Investigate',
      status: 'idle',
    });
    store.recomputeEnvelope();
    const activeChat =
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat;
    expect(activeChat?.usageLimitBannerVisible).toBeUndefined();
    expect(activeChat?.usageResumeScheduled).toBeUndefined();
    expect(activeChat?.transientRetry).toBeUndefined();
    expect(activeChat?.scheduledMessageCount).toBeUndefined();
    expect(activeChat?.scheduleModalOpen).toBeUndefined();
    expect(activeChat?.scheduledMessageInlineEditOpen).toBeUndefined();
    expect(activeChat?.scheduledMessageEditId).toBeUndefined();
    expect(activeChat?.automationEditModalOpen).toBeUndefined();
    expect(activeChat?.automationEditId).toBeUndefined();
  });
});

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

describe('browser slice (panel-derived)', () => {
  const KEY = makeWorktreePanelKey('project-1', 'worktree-1');

  function browserSessionSnapshot(
    id: string,
    overrides: Record<string, unknown> = {},
  ): never {
    return {
      id,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      createdAt: 1,
      updatedAt: 2,
      url: `http://localhost:3000/${id}`,
      title: `Title ${id}`,
      status: 'ready',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      themeMode: 'light',
      pickMode: false,
      recording: false,
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    useBrowserStore.setState({
      worktrees: {},
      consoleEntries: {},
      networkEntries: {},
      dialogs: {},
    });
  });

  afterEach(() => {
    useBrowserStore.setState({
      worktrees: {},
      consoleEntries: {},
      networkEntries: {},
      dialogs: {},
    });
  });

  function seedSessions(activeBrowserId: string | null): void {
    useBrowserStore.setState({
      worktrees: {
        'project-1/worktree-1': {
          browserOrder: ['b1', 'b2'],
          activeBrowserId,
          browsers: {
            b1: browserSessionSnapshot('b1'),
            b2: browserSessionSnapshot('b2', { loading: true }),
          },
          live: new Set(['b1', 'b2']),
          hydrated: true,
        },
      },
    });
  }

  it('derives the summary from visible bound panels + the explicit active browser', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
        {
          kind: 'browser',
          groupId: 'group-b',
          panelId: 'panel-browser-b1',
          instance: { browserId: 'b1' },
        },
        {
          kind: 'browser',
          groupId: 'group-c',
          panelId: 'panel-browser-b2',
          instance: { browserId: 'b2' },
        },
      ],
      containerSize: { width: 1200, height: 700 },
    });
    seedSessions('b1');
    useBrowserStore.getState().appendConsoleEntry('b1', {
      id: 'c1',
      browserId: 'b1',
      timestamp: 5,
      level: 'error',
      text: 'boom',
    });
    useBrowserStore.getState().setDialog('b1', {
      id: 'dialog-1',
      browserId: 'b1',
      type: 'prompt',
      message: 'Enter your display name',
      defaultPrompt: 'Ada',
      url: 'https://example.test/profile',
      frameId: 'frame-1',
      openedAt: 10,
    });
    useBrowserStore.getState().setDialog('b2', {
      id: 'dialog-2',
      browserId: 'b2',
      type: 'confirm',
      message: 'Continue?',
      url: 'https://example.test/checkout',
      openedAt: 11,
    });

    useCurrentUiStateStore.getState().recomputeEnvelope();

    const browser = useCurrentUiStateStore.getState().envelope.snapshot.browser;
    expect(browser).toMatchObject({
      drawerOpen: true,
      browserCount: 2,
      activeBrowserId: 'b1',
      url: 'http://localhost:3000/b1',
      title: 'Title b1',
      loading: false,
      recentConsoleErrorCount: 1,
      recentFailedRequestCount: 0,
      pendingDialogs: [
        {
          browserId: 'b1',
          id: 'dialog-1',
          type: 'prompt',
          message: 'Enter your display name',
          defaultPrompt: 'Ada',
          url: 'https://example.test/profile',
          frameId: 'frame-1',
        },
        {
          browserId: 'b2',
          id: 'dialog-2',
          type: 'confirm',
          message: 'Continue?',
          url: 'https://example.test/checkout',
        },
      ],
    });
  });

  it('reports drawerOpen=false when no Browser panel is actually visible', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
        { kind: 'terminal', groupId: 'group-b', panelId: 'panel-terminal' },
      ],
      containerSize: { width: 900, height: 600 },
    });
    // The bound browser tab is NOT the active tab of its group.
    usePanelLayoutStore.getState().addTab(KEY, 'group-b', 'browser', {
      panelId: 'panel-browser-b1',
      instance: { browserId: 'b1' },
    });
    usePanelLayoutStore.getState().selectTab(KEY, 'group-b', 'panel-terminal');
    seedSessions('b1');

    useCurrentUiStateStore.getState().recomputeEnvelope();

    const browser = useCurrentUiStateStore.getState().envelope.snapshot.browser;
    expect(browser?.drawerOpen).toBe(false);
    expect(browser?.activeDrawerTab).toBeUndefined();
    expect(browser?.browserCount).toBe(1);
    // The explicit active browser's metadata is still reported.
    expect(browser?.activeBrowserId).toBe('b1');
  });

  it('marks activeDrawerTab=browser when a Browser panel is the active surface', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
        {
          kind: 'browser',
          groupId: 'group-b',
          panelId: 'panel-browser-b1',
          instance: { browserId: 'b1' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-b');
    seedSessions('b1');

    useCurrentUiStateStore.getState().recomputeEnvelope();

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.browser
        ?.activeDrawerTab,
    ).toBe('browser');
  });

  it('omits the browser slice when there are no panels and no sessions', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
      containerSize: { width: 800, height: 600 },
    });

    useCurrentUiStateStore.getState().recomputeEnvelope();

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.browser,
    ).toBeUndefined();
  });
});
