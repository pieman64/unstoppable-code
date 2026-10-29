import type {
  AttachmentMeta,
  BranchEntry,
  CanopyApi,
  ChatTabPluginSelections,
  CoworkSidebarItem,
  FileIndexResponse,
  HomeBranchTargetsResponse,
  HomeDiscoverEnvironmentResponse,
  RepoFileIndex,
  SingleRepoSidebarItem,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import {
  initAiGatewayModels,
  initAgentModels,
  initOpenCodeModels,
  initOllamaModels,
  getExecutionHarnessForModel,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_MODEL,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  createOptionsForBranchTarget,
  createOptionsForNewWorktreeBaseTarget,
  defaultNewWorktreeBaseTarget,
  HOME_DRAFT_WORKTREE_ID,
  homeBranchTargetsEqual,
  isGitHubConnectResumeFresh,
  isHomeAttachmentImportCurrent,
  isHomeAttachmentTargetCurrent,
  isHomeSendEnabled,
  resolveHomeAttachmentWorktreeId,
  resolveHomeDiscoveryProviderType,
  resolveHomeDiscoveryTarget,
  resolveHomeEffectiveDefaults,
  resolveHomeEffectiveModelSettings,
  resolveHomeEffectiveProviderType,
  resolveHomeFastMode,
  resolveHomeSupportedThinkingLevels,
  useHomeComposerStore,
} from '../stores/homeComposerStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function makePluginSelections(
  overrides?: Partial<ChatTabPluginSelections>,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

function makeProject(
  id: string,
  overrides?: Partial<SingleRepoSidebarItem>,
): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    ...overrides,
  };
}

function makeBranchTargetsResponse(
  overrides?: Partial<HomeBranchTargetsResponse>,
): HomeBranchTargetsResponse {
  return {
    supported: true,
    branches: [],
    defaultBranch: 'main',
    ...overrides,
  };
}

function makeCoworkProject(
  id: string,
  overrides?: Partial<CoworkSidebarItem>,
): CoworkSidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#123456',
    order: 0,
    collapsed: false,
    ...overrides,
  };
}

function makeDiscovery(
  overrides?: Partial<WorktreeDiscovery>,
): WorktreeDiscovery {
  return {
    slashCommands: [],
    mcpServers: [],
    discoveredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAttachment(overrides?: Partial<AttachmentMeta>): AttachmentMeta {
  return {
    filename: 'a.txt',
    absolutePath: '/tmp/a.txt',
    ...overrides,
  };
}

type ModelDefaultsFixture = NonNullable<
  ReturnType<typeof useChatStore.getState>['modelDefaults']
>;

/**
 * Seeds distinct cowork (`chatModelByProvider`) vs worktree
 * (`worktreeModelByProvider`) Claude defaults so tests can assert
 * `resolveHomeEffectiveDefaults` picks the branch matching the selected
 * workspace's kind, mirroring `resolveTabDefaults`'s
 * `isCoworkChatTarget`-based branching.
 */
function makeModelDefaultsFixture(
  overrides?: Partial<ModelDefaultsFixture>,
): ModelDefaultsFixture {
  return {
    chatProvider: 'claude',
    chatModelByProvider: {
      claude: { model: 'chat-claude-model', thinkingLevel: 'medium' },
      codex: { model: 'chat-codex-model', thinkingLevel: 'medium' },
      ollama: null,
    },
    worktreeProvider: 'claude',
    worktreeModelByProvider: {
      claude: { model: 'worktree-claude-model', thinkingLevel: 'high' },
      codex: { model: 'worktree-codex-model', thinkingLevel: 'high' },
      ollama: null,
    },
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function installHomeApi(overrides: Partial<CanopyApi>): void {
  const existingWindow = (
    globalThis as unknown as { window?: { api?: Partial<CanopyApi> } }
  ).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ...existingWindow,
      api: {
        ...existingWindow?.api,
        ...overrides,
      },
    },
  });
}

function installHomeListBranchTargets(
  impl: CanopyApi['homeListBranchTargets'],
): void {
  installHomeApi({ homeListBranchTargets: impl });
}

function installHomeDiscoverEnvironment(
  impl: CanopyApi['homeDiscoverEnvironment'],
): void {
  installHomeApi({ homeDiscoverEnvironment: impl });
}

function installHomeFileIndex(impl: CanopyApi['homeFileIndex']): void {
  installHomeApi({ homeFileIndex: impl });
}

function makeRepoFileIndex(overrides?: Partial<RepoFileIndex>): RepoFileIndex {
  return {
    repoId: 'baseline',
    repoName: 'repo',
    absolutePath: '/data/repo-shadows/k/checkout',
    rootKind: 'git-repo',
    files: [],
    ...overrides,
  };
}

function resetStores(): void {
  useHomeComposerStore.getState().reset();
  useProjectsStore.setState({ projects: [] });
  // Deterministic starting point for `resolveHomeEffectiveDefaults` —
  // individual tests opt into a seeded `modelDefaults` via
  // `useChatStore.setState` when they need a non-fallback resolution.
  useChatStore.setState({ modelDefaults: null });
}

beforeEach(() => {
  resetStores();
  initAgentModels([]);
  initOpenCodeModels([]);
  installHomeListBranchTargets(
    jest.fn(() => Promise.resolve(makeBranchTargetsResponse())),
  );
  installHomeDiscoverEnvironment(
    jest.fn(() => Promise.resolve({ discovery: null })),
  );
  installHomeFileIndex(jest.fn(() => Promise.resolve({ repos: [] })));
  // Model registries are populated at app startup from package.json; tests
  // run without that bootstrap, so seed them explicitly for
  // `getProviderForModel` (via `resolveHomeDiscoveryProviderType`) to
  // classify codex/claude models correctly.
  initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet 5' }]);
  initCodexModels([{ id: 'gpt-6-sol', label: 'GPT 6 Sol' }]);
});

describe('homeComposerStore defaults', () => {
  it('remembers a hosted selection for the chat a Home draft will create', () => {
    const savePreferences = jest.fn().mockResolvedValue({});
    Object.assign(window.api, { savePreferences });
    useChatStore.setState({
      modelDefaults: makeModelDefaultsFixture({
        billingFramework: 'subscription',
      }),
    });
    useHomeComposerStore.getState().setModel('gpt-6-sol', 'ai-credits');
    expect(useHomeComposerStore.getState().model).toBe('gpt-6-sol');
    expect(useChatStore.getState().modelDefaults?.billingFramework).toBe(
      'ai-credits',
    );
    expect(savePreferences).toHaveBeenCalledWith({
      lastChatBillingFramework: 'ai-credits',
    });
  });

  it('shows and sends an inheriting Agent on the selected workspace default', () => {
    initClaudeModels([
      { id: 'worktree-claude-model', label: 'Worktree Claude' },
    ]);
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });

    expect(
      resolveHomeEffectiveModelSettings(
        'workspace-1',
        'agent_model_inherit',
        'high',
      ).model,
    ).toBe('agent_model_inherit@worktree-claude-model');
  });

  it('starts with the documented default shape', () => {
    const state = useHomeComposerStore.getState();
    expect(state.workspaceId).toBeNull();
    expect(state.branchTarget).toEqual({ kind: 'new-worktree' });
    expect(state.selectedRepoId).toBeUndefined();
    expect(state.mode).toBe('chat');
    expect(state.model).toBeUndefined();
    expect(state.thinkingLevel).toBeUndefined();
    expect(state.planMode).toBe(false);
    expect(state.approvalMode).toBeUndefined();
    expect(state.pluginSelections).toBeNull();
    expect(state.attachments).toEqual([]);
    expect(state.text).toBe('');
    expect(state.isSending).toBe(false);
    expect(state.sendError).toBeNull();
    expect(state.branchTargets).toBeNull();
    expect(state.branchTargetsLoading).toBe(false);
    expect(state.discovery).toBeNull();
    expect(state.discoveryLoading).toBe(false);
    expect(state.fileIndex).toBeNull();
    expect(state.fileIndexLoading).toBe(false);
    expect(state.scheduledSendDraft).toBeNull();
  });
});

describe('homeComposerStore selectWorkspace', () => {
  it.each(['cursor-default', 'cursor:gpt-test'])(
    'keeps a Cursor draft across code workspaces and into Cowork, which runs Cursor too: %s',
    (model) => {
      useProjectsStore.setState({
        projects: [
          makeProject('proj-a'),
          makeProject('proj-b'),
          makeCoworkProject('cowork-a'),
        ],
      });
      useHomeComposerStore.getState().selectWorkspace('proj-a');
      useHomeComposerStore.getState().setModel(model);
      useHomeComposerStore.getState().selectWorkspace('proj-b');
      expect(useHomeComposerStore.getState().model).toBe(model);
      useHomeComposerStore.getState().selectWorkspace('cowork-a');
      expect(useHomeComposerStore.getState().model).toBe(model);
    },
  );

  it('resets branchTarget and seeds pluginSelections from the matching project defaults', () => {
    const pluginSelections = makePluginSelections({ collectionIds: ['col-1'] });
    useProjectsStore.setState({
      projects: [
        makeProject('proj-a', { defaultPluginSelections: pluginSelections }),
      ],
    });

    useHomeComposerStore.getState().setBranchTarget({
      kind: 'branch',
      branchName: 'feature/x',
      isRemote: false,
    });

    useHomeComposerStore.getState().selectWorkspace('proj-a');

    const state = useHomeComposerStore.getState();
    expect(state.workspaceId).toBe('proj-a');
    expect(state.branchTarget).toEqual({ kind: 'new-worktree' });
    expect(state.pluginSelections).toEqual(pluginSelections);
  });

  it('clears staged attachments from the previous project draft', () => {
    useProjectsStore.setState({
      projects: [makeProject('proj-a'), makeProject('proj-b')],
    });

    useHomeComposerStore.getState().selectWorkspace('proj-a');
    useHomeComposerStore
      .getState()
      .addAttachments([
        { filename: 'a.png', absolutePath: '/tmp/home-draft/a.png' },
      ]);
    expect(useHomeComposerStore.getState().attachments).toHaveLength(1);

    useHomeComposerStore.getState().selectWorkspace('proj-b');

    expect(useHomeComposerStore.getState().attachments).toEqual([]);
  });

  it('clears a staged scheduledSendDraft from the previous project draft', () => {
    useProjectsStore.setState({
      projects: [makeProject('proj-a'), makeProject('proj-b')],
    });

    useHomeComposerStore.getState().selectWorkspace('proj-a');
    useHomeComposerStore
      .getState()
      .setScheduledSendDraft({ runAt: '2026-07-08T12:00:00.000Z' });
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });

    useHomeComposerStore.getState().selectWorkspace('proj-b');

    expect(useHomeComposerStore.getState().scheduledSendDraft).toBeNull();
  });

  it('seeds pluginSelections as empty (not null) when the project has no defaults', () => {
    useProjectsStore.setState({ projects: [makeProject('proj-b')] });

    useHomeComposerStore.getState().selectWorkspace('proj-b');

    // Task F1: once a workspace is selected, `pluginSelections` is always a
    // concrete `union(defaults, manualPluginSelections)` blend — `null` is
    // reserved for "no project selected at all".
    expect(useHomeComposerStore.getState().pluginSelections).toEqual(
      makePluginSelections(),
    );
  });

  it('seeds pluginSelections as empty (not null) when no project matches the id', () => {
    useProjectsStore.setState({ projects: [] });

    useHomeComposerStore.getState().selectWorkspace('missing-workspace');

    const state = useHomeComposerStore.getState();
    expect(state.workspaceId).toBe('missing-workspace');
    expect(state.pluginSelections).toEqual(makePluginSelections());
  });

  it('selecting null clears workspace-scoped state without calling the branch-targets IPC', () => {
    const homeListBranchTargets = jest.fn(() =>
      Promise.resolve(makeBranchTargetsResponse()),
    );
    installHomeListBranchTargets(homeListBranchTargets);
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });

    useHomeComposerStore.getState().selectWorkspace('proj-a');
    useHomeComposerStore.getState().selectWorkspace(null);

    const state = useHomeComposerStore.getState();
    expect(state.workspaceId).toBeNull();
    expect(state.branchTarget).toEqual({ kind: 'new-worktree' });
    expect(state.pluginSelections).toBeNull();
    expect(state.branchTargets).toBeNull();
    // Only the first selectWorkspace('proj-a') call should have triggered a load.
    expect(homeListBranchTargets).toHaveBeenCalledTimes(1);
  });

  it('kicks off a branch-targets load for the newly selected project', async () => {
    const response = makeBranchTargetsResponse({ defaultBranch: 'develop' });
    const homeListBranchTargets = jest.fn(() => Promise.resolve(response));
    installHomeListBranchTargets(homeListBranchTargets);
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });

    useHomeComposerStore.getState().selectWorkspace('proj-a');
    expect(homeListBranchTargets).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(useHomeComposerStore.getState().branchTargets).toEqual(response);
    expect(useHomeComposerStore.getState().branchTargetsLoading).toBe(false);
    expect(useHomeComposerStore.getState().newWorktreeBaseTarget).toEqual({
      kind: 'branch',
      branchName: 'develop',
      isRemote: false,
    });
  });
});

describe('homeComposerStore plugin selections blending (Task F1)', () => {
  it('carries a manually enabled extra plugin from project A into project B, without adopting A-only defaults', () => {
    const defaultsA = makePluginSelections({ collectionIds: ['a-default'] });
    const defaultsB = makePluginSelections({ collectionIds: ['b-default'] });
    useProjectsStore.setState({
      projects: [
        makeProject('ws-a', { defaultPluginSelections: defaultsA }),
        makeProject('ws-b', { defaultPluginSelections: defaultsB }),
      ],
    });

    useHomeComposerStore.getState().selectWorkspace('ws-a');
    expect(
      useHomeComposerStore.getState().pluginSelections?.collectionIds,
    ).toEqual(['a-default']);

    // The user manually enables an extra collection beyond A's defaults.
    useHomeComposerStore
      .getState()
      .setPluginSelections(
        makePluginSelections({ collectionIds: ['a-default', 'extra'] }),
      );
    expect(useHomeComposerStore.getState().manualPluginSelections).toEqual(
      makePluginSelections({ collectionIds: ['extra'] }),
    );

    useHomeComposerStore.getState().selectWorkspace('ws-b');

    const bCollectionIds =
      useHomeComposerStore.getState().pluginSelections?.collectionIds;
    expect(bCollectionIds).toEqual(['b-default', 'extra']);
    expect(bCollectionIds).not.toContain('a-default');
  });

  it('a default removed on project A is workspace-session-only: it reappears after switching away and back', () => {
    const defaultsA = makePluginSelections({ collectionIds: ['a-default'] });
    const defaultsB = makePluginSelections({ collectionIds: ['b-default'] });
    useProjectsStore.setState({
      projects: [
        makeProject('ws-a', { defaultPluginSelections: defaultsA }),
        makeProject('ws-b', { defaultPluginSelections: defaultsB }),
      ],
    });

    useHomeComposerStore.getState().selectWorkspace('ws-a');
    expect(
      useHomeComposerStore.getState().pluginSelections?.collectionIds,
    ).toEqual(['a-default']);

    // The user explicitly removes A's own default for this session.
    useHomeComposerStore.getState().setPluginSelections(makePluginSelections());
    expect(
      useHomeComposerStore.getState().pluginSelections?.collectionIds,
    ).toEqual([]);
    // Nothing manual was added, so there is no delta to carry forward.
    expect(useHomeComposerStore.getState().manualPluginSelections).toEqual(
      makePluginSelections(),
    );

    useHomeComposerStore.getState().selectWorkspace('ws-b');
    expect(
      useHomeComposerStore.getState().pluginSelections?.collectionIds,
    ).toEqual(['b-default']);

    useHomeComposerStore.getState().selectWorkspace('ws-a');
    expect(
      useHomeComposerStore.getState().pluginSelections?.collectionIds,
    ).toEqual(['a-default']);
  });
});

describe('homeComposerStore loadBranchTargets error handling', () => {
  it('falls back to an unsupported/empty result when the IPC call rejects', async () => {
    installHomeListBranchTargets(
      jest.fn(() => Promise.reject(new Error('boom'))),
    );
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadBranchTargets();

    const state = useHomeComposerStore.getState();
    expect(state.branchTargets).toEqual({
      supported: false,
      branches: [],
      defaultBranch: null,
    });
    expect(state.branchTargetsLoading).toBe(false);
  });

  it('stores an explicit unsupported response as-is without crashing', async () => {
    const unsupported = makeBranchTargetsResponse({
      supported: false,
      branches: [],
      defaultBranch: null,
    });
    installHomeListBranchTargets(jest.fn(() => Promise.resolve(unsupported)));
    useHomeComposerStore.setState({ workspaceId: 'cowork-a' });

    await useHomeComposerStore.getState().loadBranchTargets();

    expect(useHomeComposerStore.getState().branchTargets).toEqual(unsupported);
  });

  it('does nothing when there is no selected project', async () => {
    const homeListBranchTargets = jest.fn(() =>
      Promise.resolve(makeBranchTargetsResponse()),
    );
    installHomeListBranchTargets(homeListBranchTargets);

    await useHomeComposerStore.getState().loadBranchTargets();

    expect(homeListBranchTargets).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().branchTargets).toBeNull();
  });
});

describe('homeComposerStore stale-response guard', () => {
  it('does not let a late response for a previously selected project clobber the newly selected one', async () => {
    useProjectsStore.setState({
      projects: [makeProject('workspace-a'), makeProject('workspace-b')],
    });

    const responseA = makeBranchTargetsResponse({ defaultBranch: 'a-default' });
    const responseB = makeBranchTargetsResponse({ defaultBranch: 'b-default' });
    const deferredA = deferred<HomeBranchTargetsResponse>();
    const deferredB = deferred<HomeBranchTargetsResponse>();

    const homeListBranchTargets = jest.fn(
      (request: { workspaceId: string }) => {
        if (request.workspaceId === 'workspace-a') {
          return deferredA.promise;
        }
        return deferredB.promise;
      },
    );
    installHomeListBranchTargets(homeListBranchTargets);

    useHomeComposerStore.getState().selectWorkspace('workspace-a');
    useHomeComposerStore.getState().selectWorkspace('workspace-b');

    expect(useHomeComposerStore.getState().workspaceId).toBe('workspace-b');

    // The late 'a' response resolves after 'b' has already been selected.
    // It must be dropped rather than overwriting workspace-b's state.
    deferredA.resolve(responseA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useHomeComposerStore.getState().workspaceId).toBe('workspace-b');
    expect(useHomeComposerStore.getState().branchTargets).toBeNull();

    // Once the 'b' response arrives, it is applied normally.
    deferredB.resolve(responseB);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useHomeComposerStore.getState().branchTargets).toEqual(responseB);
  });
});

describe('homeComposerStore simple field actions', () => {
  it('setBranchTarget replaces the branch target', () => {
    useHomeComposerStore
      .getState()
      .setBranchTarget({ kind: 'worktree', worktreeId: 'wt-1' });
    expect(useHomeComposerStore.getState().branchTarget).toEqual({
      kind: 'worktree',
      worktreeId: 'wt-1',
    });
  });

  it('setMode switches mode', () => {
    useHomeComposerStore.getState().setMode('pipeline');
    expect(useHomeComposerStore.getState().mode).toBe('pipeline');
  });

  it('setMode to pipeline clears a staged scheduledSendDraft', () => {
    useHomeComposerStore.setState({
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });
    useHomeComposerStore.getState().setMode('pipeline');
    expect(useHomeComposerStore.getState().scheduledSendDraft).toBeNull();
  });

  it('setMode back to chat leaves scheduledSendDraft untouched', () => {
    const draft = { runAt: '2026-07-08T12:00:00.000Z' };
    useHomeComposerStore.setState({
      mode: 'pipeline',
      scheduledSendDraft: draft,
    });
    useHomeComposerStore.getState().setMode('chat');
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual(draft);
  });

  it('keeps the Home harness choice local and clears it on model or scheduling changes', () => {
    initOllamaModels([
      {
        id: 'ollama-draft-test',
        rawModelId: 'draft-test',
        label: 'Local model',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    useHomeComposerStore.getState().setModel('ollama-draft-test');
    useHomeComposerStore.getState().setExecutionHarness('claude');
    expect(useHomeComposerStore.getState().executionHarness).toBe('claude');
    expect(getExecutionHarnessForModel('ollama-draft-test')).toBe('codex');
    useHomeComposerStore.getState().setModel('ollama-draft-test');
    expect(useHomeComposerStore.getState().executionHarness).toBe('claude');
    expect(
      resolveHomeEffectiveProviderType(null, 'ollama-draft-test', 'claude'),
    ).toBe('claude');
    useHomeComposerStore
      .getState()
      .setScheduledSendDraft({ runAt: '2030-01-01T00:00:00Z' });
    expect(useHomeComposerStore.getState().executionHarness).toBeUndefined();
    useHomeComposerStore.getState().setExecutionHarness('claude');
    useHomeComposerStore.getState().setModel('claude-sonnet-4-5');
    expect(useHomeComposerStore.getState().executionHarness).toBeUndefined();
    useHomeComposerStore.getState().setExecutionHarness('codex');
    expect(useHomeComposerStore.getState().executionHarness).toBeUndefined();
    initOllamaModels([]);
  });

  it('setModel sets and clears the model override', () => {
    useHomeComposerStore.getState().setModel('claude-test-model');
    expect(useHomeComposerStore.getState().model).toBe('claude-test-model');
    useHomeComposerStore.getState().setModel(undefined);
    expect(useHomeComposerStore.getState().model).toBeUndefined();
  });

  it('cycleThinkingLevel starts from the effective resolved default (undefined draft, no workspace/modelDefaults)', () => {
    // No workspace selected and `modelDefaults` unseeded (see `resetStores`)
    // — `resolveHomeEffectiveDefaults` falls back to `FALLBACK_THINKING_LEVEL`
    // ('high'), so the first cycle step advances from 'high', not from a
    // fixed starting point.
    //
    // The cycle is MODEL-AWARE (plan Task 3.2): it walks the resolved model's
    // declared level set plus the desktop host's `off` rung, not the static
    // `THINKING_UI_LEVELS` list. The fallback model declares
    // off/medium/high/xhigh/max, so `ultra` is never a stop here — a model
    // that does not declare a level must not be cyclable onto it.
    const store = useHomeComposerStore;
    expect(store.getState().thinkingLevel).toBeUndefined();
    store.getState().cycleThinkingLevel();
    expect(store.getState().thinkingLevel).toBe('xhigh');
    store.getState().cycleThinkingLevel();
    expect(store.getState().thinkingLevel).toBe('max');
    store.getState().cycleThinkingLevel();
    expect(store.getState().thinkingLevel).toBe('off');
    // Task F1: `undefined` ("project default") is no longer a cycle stop —
    // the cycle wraps straight back to 'medium' after 'off', always landing
    // on a concrete level (this "touches" the draft on every step).
    store.getState().cycleThinkingLevel();
    expect(store.getState().thinkingLevel).toBe('medium');
    store.getState().cycleThinkingLevel();
    expect(store.getState().thinkingLevel).toBe('high');
  });

  it('cycleThinkingLevel advances from a touched concrete level regardless of the effective default', () => {
    useHomeComposerStore.setState({ thinkingLevel: 'medium' });
    useHomeComposerStore.getState().cycleThinkingLevel();
    expect(useHomeComposerStore.getState().thinkingLevel).toBe('high');
  });

  it('does not expose Claude reasoning levels for the Cursor runtime', () => {
    expect(resolveHomeSupportedThinkingLevels(null, 'cursor-default')).toEqual(
      [],
    );
    expect(
      resolveHomeEffectiveModelSettings(null, 'cursor-default', 'high'),
    ).toMatchObject({
      supportedThinkingLevels: [],
      thinkingLevel: 'off',
    });
  });

  it('does not expose Claude reasoning levels for the OpenCode runtime', () => {
    expect(
      resolveHomeSupportedThinkingLevels(null, 'opencode:fixture%2Fmodel'),
    ).toEqual([]);
    expect(
      resolveHomeEffectiveModelSettings(
        null,
        'opencode:fixture%2Fmodel',
        'high',
      ),
    ).toMatchObject({
      supportedThinkingLevels: [],
      thinkingLevel: 'off',
    });
  });

  it('uses the selected Ollama harness for fallback effort levels', () => {
    initOllamaModels([
      {
        id: 'ollama-harness-effort',
        rawModelId: 'harness-effort',
        label: 'Harness effort',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    const claude = resolveHomeEffectiveModelSettings(
      null,
      'ollama-harness-effort',
      'max',
      'claude',
    );
    const codex = resolveHomeEffectiveModelSettings(
      null,
      'ollama-harness-effort',
      'max',
      'codex',
    );
    expect(claude.supportedThinkingLevels).toContain('max');
    expect(codex.supportedThinkingLevels).not.toContain('max');
    expect(claude.thinkingLevel).toBe('max');
    expect(codex.thinkingLevel).toBe('xhigh');
  });

  it('uses the selected model supported levels for both display and cycling', () => {
    initCodexModels([
      {
        id: 'limited-codex',
        label: 'Limited Codex',
        supportedThinkingLevels: ['off', 'medium', 'high'],
      },
    ]);
    useHomeComposerStore.setState({
      model: 'limited-codex',
      thinkingLevel: 'high',
    });

    expect(resolveHomeSupportedThinkingLevels(null, 'limited-codex')).toEqual([
      'off',
      'medium',
      'high',
    ]);
    useHomeComposerStore.getState().cycleThinkingLevel();
    expect(useHomeComposerStore.getState().thinkingLevel).toBe('off');
  });

  it('resolves the gateway thinking set when the billing seed activates AI Credits', () => {
    // Home-created tabs are seeded with `billingSeed: resolveBillingSeed(...)`
    // — a remembered "Use AI Credits" choice routes the session through the
    // gateway, so capability lookups must follow that route instead of the
    // model's native tiers (same bug class as the ChatInput/cycle fix).
    initClaudeModels([
      {
        id: 'routed-claude-model',
        label: 'Routed Claude',
        supportedThinkingLevels: ['off', 'medium', 'high', 'xhigh', 'max'],
      },
    ]);
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'routed-claude-model',
          gatewayId: 'provider/routed-claude-model',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 100_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['off', 'medium'],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    try {
      useProjectsStore.setState({ projects: [makeProject('ws-1')] });

      // Native route: the model's own declared set.
      useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });
      expect(
        resolveHomeSupportedThinkingLevels('ws-1', 'routed-claude-model'),
      ).toEqual(['off', 'medium', 'high', 'xhigh', 'max']);

      // AI-Credits seed: the gateway-advertised set for the same model.
      useChatStore.setState({
        modelDefaults: makeModelDefaultsFixture({
          billingFramework: 'ai-credits',
        }),
      });
      expect(
        resolveHomeSupportedThinkingLevels('ws-1', 'routed-claude-model'),
      ).toEqual(['off', 'medium']);
    } finally {
      initAiGatewayModels([], []);
    }
  });

  it('clamps the effective Home setting to the selected model exact supported set', () => {
    initCodexModels([
      {
        id: 'medium-only-codex',
        label: 'Medium-only Codex',
        supportedThinkingLevels: ['medium'],
      },
    ]);

    expect(
      resolveHomeEffectiveModelSettings(null, 'medium-only-codex', 'ultra'),
    ).toEqual({
      model: 'medium-only-codex',
      thinkingLevel: 'medium',
      supportedThinkingLevels: ['medium'],
    });
    expect(
      resolveHomeEffectiveModelSettings(null, 'medium-only-codex', 'off')
        .thinkingLevel,
    ).toBe('medium');
  });

  it('preserves explicit off when the selected model declares it', () => {
    initCodexModels([
      {
        id: 'off-capable-codex',
        label: 'Off-capable Codex',
        supportedThinkingLevels: ['off', 'medium'],
      },
    ]);

    expect(
      resolveHomeEffectiveModelSettings(null, 'off-capable-codex', 'off')
        .thinkingLevel,
    ).toBe('off');
  });

  it('clamps an untouched Home default against the effective model', () => {
    initCodexModels([
      {
        id: 'default-limited-codex',
        label: 'Default limited Codex',
        supportedThinkingLevels: ['off', 'medium'],
      },
    ]);
    useChatStore.setState({
      modelDefaults: makeModelDefaultsFixture({
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: null,
          codex: {
            model: 'default-limited-codex',
            thinkingLevel: 'high',
          },
          ollama: null,
        },
      }),
    });
    useProjectsStore.setState({ projects: [makeProject('ws-1')] });

    expect(
      resolveHomeEffectiveModelSettings('ws-1', undefined, undefined),
    ).toEqual({
      model: 'default-limited-codex',
      thinkingLevel: 'medium',
      supportedThinkingLevels: ['off', 'medium'],
    });
  });

  it('setSendError sets and clears the composer error', () => {
    useHomeComposerStore.getState().setSendError('attach failed');
    expect(useHomeComposerStore.getState().sendError).toBe('attach failed');
    useHomeComposerStore.getState().setSendError(null);
    expect(useHomeComposerStore.getState().sendError).toBeNull();
  });

  it('HOME_DRAFT_WORKTREE_ID satisfies the main-process validateId pattern', () => {
    // Mirrors SAFE_ID_RE in apps/desktop-app/src/main/lib/validation.ts —
    // the sentinel is sent as a worktreeId over IPC, so it must stay
    // lowercase alphanumeric + hyphens (the original '__home_draft__'
    // sentinel was rejected at the IPC boundary).
    expect(HOME_DRAFT_WORKTREE_ID).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('togglePlanMode flips the boolean', () => {
    expect(useHomeComposerStore.getState().planMode).toBe(false);
    useHomeComposerStore.getState().togglePlanMode();
    expect(useHomeComposerStore.getState().planMode).toBe(true);
    useHomeComposerStore.getState().togglePlanMode();
    expect(useHomeComposerStore.getState().planMode).toBe(false);
  });

  it('setApprovalMode sets and clears the override', () => {
    expect(useHomeComposerStore.getState().approvalMode).toBeUndefined();
    useHomeComposerStore.getState().setApprovalMode('auto');
    expect(useHomeComposerStore.getState().approvalMode).toBe('auto');
    useHomeComposerStore.getState().setApprovalMode(undefined);
    expect(useHomeComposerStore.getState().approvalMode).toBeUndefined();
  });

  it('setPluginSelections overwrites the current selections', () => {
    const selections = makePluginSelections({ collectionIds: ['a'] });
    useHomeComposerStore.getState().setPluginSelections(selections);
    expect(useHomeComposerStore.getState().pluginSelections).toEqual(
      selections,
    );
  });

  it('setPluginSelections with no selected project tracks the whole selection as manual (defaults are empty)', () => {
    const selections = makePluginSelections({ collectionIds: ['a'] });
    useHomeComposerStore.getState().setPluginSelections(selections);
    expect(useHomeComposerStore.getState().manualPluginSelections).toEqual(
      selections,
    );
  });

  it('addAttachments appends without duplicating by absolutePath', () => {
    useHomeComposerStore
      .getState()
      .addAttachments([{ filename: 'a.txt', absolutePath: '/tmp/a.txt' }]);
    useHomeComposerStore.getState().addAttachments([
      { filename: 'a.txt', absolutePath: '/tmp/a.txt' },
      { filename: 'b.txt', absolutePath: '/tmp/b.txt' },
    ]);
    expect(useHomeComposerStore.getState().attachments).toEqual([
      { filename: 'a.txt', absolutePath: '/tmp/a.txt' },
      { filename: 'b.txt', absolutePath: '/tmp/b.txt' },
    ]);
  });

  it('removeAttachment removes by absolutePath', () => {
    useHomeComposerStore.getState().addAttachments([
      { filename: 'a.txt', absolutePath: '/tmp/a.txt' },
      { filename: 'b.txt', absolutePath: '/tmp/b.txt' },
    ]);
    useHomeComposerStore.getState().removeAttachment('/tmp/a.txt');
    expect(useHomeComposerStore.getState().attachments).toEqual([
      { filename: 'b.txt', absolutePath: '/tmp/b.txt' },
    ]);
  });

  it('setText stores the serialized editor text', () => {
    useHomeComposerStore.getState().setText('hello world');
    expect(useHomeComposerStore.getState().text).toBe('hello world');
  });

  it('setScheduledSendDraft sets and clears the staged schedule', () => {
    useHomeComposerStore
      .getState()
      .setScheduledSendDraft({ runAt: '2026-07-08T12:00:00.000Z' });
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
    useHomeComposerStore.getState().setScheduledSendDraft(null);
    expect(useHomeComposerStore.getState().scheduledSendDraft).toBeNull();
  });
});

describe('homeComposerStore GitHub connect resume (CAN-4466)', () => {
  beforeEach(() => {
    useHomeComposerStore.getState().reset();
  });

  it('stages a resend that one consume claims', () => {
    const store = useHomeComposerStore.getState();
    expect(store.consumeGitHubConnectResume()).toBe(false);
    store.requestGitHubConnectResume();
    const first = useHomeComposerStore.getState().pendingGitHubConnectResume;
    store.requestGitHubConnectResume();
    expect(
      useHomeComposerStore.getState().pendingGitHubConnectResume?.nonce,
    ).toBe((first?.nonce ?? 0) + 1);
    expect(store.consumeGitHubConnectResume()).toBe(true);
    expect(useHomeComposerStore.getState().pendingGitHubConnectResume).toBe(
      null,
    );
    expect(store.consumeGitHubConnectResume()).toBe(false);
  });

  it('drops a resend older than 15 seconds', () => {
    const store = useHomeComposerStore.getState();
    store.requestGitHubConnectResume();
    const requestedAt =
      useHomeComposerStore.getState().pendingGitHubConnectResume?.requestedAt ??
      0;
    expect(store.consumeGitHubConnectResume(requestedAt + 15_000)).toBe(false);
    expect(useHomeComposerStore.getState().pendingGitHubConnectResume).toBe(
      null,
    );
    store.requestGitHubConnectResume();
    const fresh =
      useHomeComposerStore.getState().pendingGitHubConnectResume?.requestedAt ??
      0;
    expect(store.consumeGitHubConnectResume(fresh + 14_999)).toBe(true);
  });

  it('judges freshness without consuming', () => {
    expect(isGitHubConnectResumeFresh({ requestedAt: 1_000 }, 15_999)).toBe(
      true,
    );
    expect(isGitHubConnectResumeFresh({ requestedAt: 1_000 }, 16_000)).toBe(
      false,
    );
  });

  it('clears a staged resend on workspace change and reset', () => {
    useHomeComposerStore.getState().requestGitHubConnectResume();
    useHomeComposerStore.getState().selectWorkspace('ws-other');
    expect(useHomeComposerStore.getState().pendingGitHubConnectResume).toBe(
      null,
    );
    useHomeComposerStore.getState().requestGitHubConnectResume();
    useHomeComposerStore.getState().reset();
    expect(useHomeComposerStore.getState().pendingGitHubConnectResume).toBe(
      null,
    );
  });
});

describe('homeComposerStore reset', () => {
  it('restores every field to its documented default', () => {
    useProjectsStore.setState({
      projects: [
        makeProject('proj-a', {
          defaultPluginSelections: makePluginSelections({
            collectionIds: ['x'],
          }),
        }),
      ],
    });
    const store = useHomeComposerStore.getState();
    store.selectWorkspace('proj-a');
    store.setBranchTarget({
      kind: 'branch',
      branchName: 'main',
      isRemote: true,
    });
    store.setMode('pipeline');
    store.setModel('some-model');
    store.cycleThinkingLevel();
    store.togglePlanMode();
    store.setApprovalMode('full-access');
    store.addAttachments([{ filename: 'a.txt', absolutePath: '/tmp/a.txt' }]);
    store.setText('draft text');
    store.setScheduledSendDraft({ runAt: '2026-07-08T12:00:00.000Z' });
    useHomeComposerStore.setState({
      isSending: true,
      sendError: 'boom',
      branchTargetsLoading: true,
      discovery: makeDiscovery(),
      discoveryLoading: true,
      fileIndex: [makeRepoFileIndex()],
      fileIndexLoading: true,
    });

    useHomeComposerStore.getState().reset();

    const state = useHomeComposerStore.getState();
    expect(state.workspaceId).toBeNull();
    expect(state.branchTarget).toEqual({ kind: 'new-worktree' });
    expect(state.newWorktreeBaseTarget).toBeNull();
    expect(state.mode).toBe('chat');
    expect(state.model).toBeUndefined();
    expect(state.thinkingLevel).toBeUndefined();
    expect(state.planMode).toBe(false);
    expect(state.approvalMode).toBeUndefined();
    expect(state.pluginSelections).toBeNull();
    expect(state.attachments).toEqual([]);
    expect(state.text).toBe('');
    expect(state.isSending).toBe(false);
    expect(state.sendError).toBeNull();
    expect(state.branchTargets).toBeNull();
    expect(state.branchTargetsLoading).toBe(false);
    expect(state.discovery).toBeNull();
    expect(state.discoveryLoading).toBe(false);
    expect(state.fileIndex).toBeNull();
    expect(state.fileIndexLoading).toBe(false);
    expect(state.scheduledSendDraft).toBeNull();
  });
});

describe('resolveHomeDiscoveryTarget', () => {
  it('maps a cowork project to a cowork target regardless of branchTarget', () => {
    expect(resolveHomeDiscoveryTarget({ kind: 'new-worktree' }, true)).toEqual({
      kind: 'cowork',
    });
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'worktree', worktreeId: 'wt-1' },
        true,
      ),
    ).toEqual({ kind: 'cowork' });
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'branch', branchName: 'feature/x', isRemote: false },
        true,
      ),
    ).toEqual({ kind: 'cowork' });
  });

  it('maps an existing-worktree target to a worktree target', () => {
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'worktree', worktreeId: 'wt-1' },
        false,
      ),
    ).toEqual({ kind: 'worktree', worktreeId: 'wt-1' });
  });

  it('maps new-worktree and other-branch targets to a baseline target', () => {
    expect(resolveHomeDiscoveryTarget({ kind: 'new-worktree' }, false)).toEqual(
      { kind: 'baseline' },
    );
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'branch', branchName: 'feature/x', isRemote: true },
        false,
      ),
    ).toEqual({ kind: 'baseline' });
  });

  it('scopes worktree and baseline targets to the selected child repo', () => {
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'worktree', worktreeId: 'wt-1' },
        false,
        'repo-web',
      ),
    ).toEqual({ kind: 'worktree', worktreeId: 'wt-1', repoId: 'repo-web' });
    expect(
      resolveHomeDiscoveryTarget({ kind: 'new-worktree' }, false, 'repo-web'),
    ).toEqual({ kind: 'baseline', repoId: 'repo-web' });
    expect(
      resolveHomeDiscoveryTarget(
        { kind: 'branch', branchName: 'feature/x', isRemote: false },
        false,
        'repo-web',
      ),
    ).toEqual({ kind: 'baseline', repoId: 'repo-web' });
    // Cowork ignores the working-directory selection entirely.
    expect(
      resolveHomeDiscoveryTarget({ kind: 'new-worktree' }, true, 'repo-web'),
    ).toEqual({ kind: 'cowork' });
  });
});

describe('resolveHomeAttachmentWorktreeId', () => {
  it('maps a cowork project to the cowork home id regardless of branchTarget', () => {
    expect(
      resolveHomeAttachmentWorktreeId(true, { kind: 'new-worktree' }),
    ).toBe(COWORK_HOME_WORKTREE_ID);
    expect(
      resolveHomeAttachmentWorktreeId(true, {
        kind: 'worktree',
        worktreeId: 'wt-1',
      }),
    ).toBe(COWORK_HOME_WORKTREE_ID);
  });

  it('maps an existing-worktree target to that worktree id', () => {
    expect(
      resolveHomeAttachmentWorktreeId(false, {
        kind: 'worktree',
        worktreeId: 'wt-1',
      }),
    ).toBe('wt-1');
  });

  it('maps new-worktree and other-branch targets to the draft sentinel', () => {
    expect(
      resolveHomeAttachmentWorktreeId(false, { kind: 'new-worktree' }),
    ).toBe(HOME_DRAFT_WORKTREE_ID);
    expect(
      resolveHomeAttachmentWorktreeId(false, {
        kind: 'branch',
        branchName: 'feature/x',
        isRemote: false,
      }),
    ).toBe(HOME_DRAFT_WORKTREE_ID);
  });

  it('maps pr and linear-issue targets to the draft sentinel (no worktree yet)', () => {
    expect(
      resolveHomeAttachmentWorktreeId(false, {
        kind: 'pr',
        number: 7,
        title: 'Fix things',
        headRefName: 'fix/things',
        url: 'https://example.test/pr/7',
      }),
    ).toBe(HOME_DRAFT_WORKTREE_ID);
    expect(
      resolveHomeAttachmentWorktreeId(false, {
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Do it',
        branchName: 'ryan/ecw-1-do-it',
      }),
    ).toBe(HOME_DRAFT_WORKTREE_ID);
  });
});

describe('createOptionsForBranchTarget', () => {
  function makeBranch(name: string): BranchEntry {
    return {
      name,
      isRemote: false,
      isCurrent: false,
      isUsedByWorktree: false,
      hasLocalRef: true,
      hasRemoteRef: false,
    };
  }

  it('returns undefined for new-worktree and existing-worktree targets', () => {
    expect(
      createOptionsForBranchTarget({ kind: 'new-worktree' }, []),
    ).toBeUndefined();
    expect(
      createOptionsForBranchTarget(
        { kind: 'worktree', worktreeId: 'wt-1' },
        [],
      ),
    ).toBeUndefined();
  });

  it('checks out the existing branch for a branch target', () => {
    expect(
      createOptionsForBranchTarget(
        { kind: 'branch', branchName: 'feature/x', isRemote: true },
        [],
      ),
    ).toEqual({ existingBranch: 'feature/x' });
  });

  it('checks out the PR head branch for a pr target', () => {
    expect(
      createOptionsForBranchTarget(
        {
          kind: 'pr',
          number: 42,
          title: 'Fix things',
          headRefName: 'fix/things',
          url: 'https://example.test/pr/42',
        },
        [],
      ),
    ).toEqual({ existingBranch: 'fix/things' });
  });

  it('checks out an existing Linear branch when it is already present', () => {
    expect(
      createOptionsForBranchTarget(
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'Do it',
          branchName: 'ryan/ecw-1-do-it',
        },
        [makeBranch('ryan/ecw-1-do-it')],
      ),
    ).toEqual({ existingBranch: 'ryan/ecw-1-do-it' });
  });

  it('creates a new branch for a Linear issue whose branch does not exist yet', () => {
    expect(
      createOptionsForBranchTarget(
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'Do it',
          branchName: 'ryan/ecw-1-do-it',
        },
        [makeBranch('some/other-branch')],
      ),
    ).toEqual({ branchName: 'ryan/ecw-1-do-it' });
  });
});

describe('new worktree base target helpers', () => {
  it('defaults to the remote default branch even when its local ref exists', () => {
    expect(
      defaultNewWorktreeBaseTarget(
        makeBranchTargetsResponse({
          defaultBranch: 'trunk',
          branches: [
            {
              name: 'trunk',
              isRemote: true,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: false,
              hasRemoteRef: true,
            },
            {
              name: 'trunk',
              isRemote: false,
              isCurrent: true,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
        }),
      ),
    ).toEqual({ kind: 'branch', branchName: 'trunk', isRemote: true });
  });

  it('uses the remote ref of a coalesced local-and-remote default branch', () => {
    expect(
      defaultNewWorktreeBaseTarget(
        makeBranchTargetsResponse({
          defaultBranch: 'main',
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: true,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
        }),
      ),
    ).toEqual({ kind: 'branch', branchName: 'main', isRemote: true });
  });

  it('falls back to the current local branch when no remote default is known', () => {
    expect(
      defaultNewWorktreeBaseTarget(
        makeBranchTargetsResponse({
          defaultBranch: null,
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: true,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: false,
            },
          ],
        }),
      ),
    ).toEqual({ kind: 'branch', branchName: 'main', isRemote: false });
  });

  it('maps worktrees to baseWorktreeId and branches/PRs to baseBranch', () => {
    expect(
      createOptionsForNewWorktreeBaseTarget({
        kind: 'worktree',
        worktreeId: 'wt-1',
      }),
    ).toEqual({ baseWorktreeId: 'wt-1' });
    expect(
      createOptionsForNewWorktreeBaseTarget({
        kind: 'branch',
        branchName: 'release',
        isRemote: true,
      }),
    ).toEqual({ baseBranch: 'origin/release' });
    expect(
      createOptionsForNewWorktreeBaseTarget({
        kind: 'branch',
        branchName: 'release',
        isRemote: false,
      }),
    ).toEqual({ baseBranch: 'release' });
    expect(
      createOptionsForNewWorktreeBaseTarget({
        kind: 'pr',
        number: 42,
        title: 'Release',
        headRefName: 'release/pr',
        url: 'https://example.test/pr/42',
      }),
    ).toEqual({ baseBranch: 'release/pr' });
  });
});

describe('homeBranchTargetsEqual', () => {
  it('treats pr targets as equal by number, ignoring other fields', () => {
    expect(
      homeBranchTargetsEqual(
        { kind: 'pr', number: 7, title: 'A', headRefName: 'a', url: 'u1' },
        { kind: 'pr', number: 7, title: 'B', headRefName: 'b', url: 'u2' },
      ),
    ).toBe(true);
    expect(
      homeBranchTargetsEqual(
        { kind: 'pr', number: 7, title: 'A', headRefName: 'a', url: 'u1' },
        { kind: 'pr', number: 8, title: 'A', headRefName: 'a', url: 'u1' },
      ),
    ).toBe(false);
  });

  it('treats linear-issue targets as equal by identifier, ignoring other fields', () => {
    expect(
      homeBranchTargetsEqual(
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'A',
          branchName: 'a',
        },
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'B',
          branchName: 'b',
        },
      ),
    ).toBe(true);
    expect(
      homeBranchTargetsEqual(
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'A',
          branchName: 'a',
        },
        {
          kind: 'linear-issue',
          identifier: 'ECW-2',
          title: 'A',
          branchName: 'a',
        },
      ),
    ).toBe(false);
  });

  it('treats targets with different kinds as unequal', () => {
    expect(
      homeBranchTargetsEqual(
        { kind: 'pr', number: 7, title: 'A', headRefName: 'a', url: 'u1' },
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'A',
          branchName: 'a',
        },
      ),
    ).toBe(false);
  });
});

describe('isHomeAttachmentTargetCurrent', () => {
  const target = { projectId: 'proj-a', worktreeId: 'wt-1' };

  it('accepts the same project and resolved attachment worktree', () => {
    expect(
      isHomeAttachmentTargetCurrent(
        target,
        'proj-a',
        { kind: 'worktree', worktreeId: 'wt-1' },
        false,
      ),
    ).toBe(true);
  });

  it('rejects a completion after the project changes', () => {
    expect(
      isHomeAttachmentTargetCurrent(
        target,
        'proj-b',
        { kind: 'worktree', worktreeId: 'wt-1' },
        false,
      ),
    ).toBe(false);
  });

  it('rejects a completion after the resolved attachment worktree changes', () => {
    expect(
      isHomeAttachmentTargetCurrent(
        target,
        'proj-a',
        { kind: 'worktree', worktreeId: 'wt-2' },
        false,
      ),
    ).toBe(false);
  });

  it('compares cowork targets using the cowork staging id', () => {
    expect(
      isHomeAttachmentTargetCurrent(
        { projectId: 'cowork-a', worktreeId: COWORK_HOME_WORKTREE_ID },
        'cowork-a',
        { kind: 'new-worktree' },
        true,
      ),
    ).toBe(true);
  });
});

describe('Home attachment import draft lifecycle', () => {
  const target = { projectId: 'proj-a', worktreeId: 'wt-1' };

  it('rejects a completion from an older generation even when the target matches', () => {
    expect(
      isHomeAttachmentImportCurrent(
        target,
        4,
        'proj-a',
        { kind: 'worktree', worktreeId: 'wt-1' },
        false,
        5,
      ),
    ).toBe(false);
  });

  it('tracks concurrent imports independently', () => {
    const first = useHomeComposerStore.getState().beginAttachmentImport();
    const second = useHomeComposerStore.getState().beginAttachmentImport();

    expect(useHomeComposerStore.getState().pendingAttachmentImportIds).toEqual([
      first.id,
      second.id,
    ]);

    useHomeComposerStore.getState().finishAttachmentImport(first);
    expect(useHomeComposerStore.getState().pendingAttachmentImportIds).toEqual([
      second.id,
    ]);

    useHomeComposerStore.getState().finishAttachmentImport(second);
    expect(useHomeComposerStore.getState().pendingAttachmentImportIds).toEqual(
      [],
    );
  });

  it('invalidates pending imports on reset without letting stale completions clear new ones', () => {
    const stale = useHomeComposerStore.getState().beginAttachmentImport();
    const staleGeneration = stale.draftGeneration;

    useHomeComposerStore.getState().reset();
    const current = useHomeComposerStore.getState().beginAttachmentImport();

    expect(current.draftGeneration).toBe(staleGeneration + 1);
    useHomeComposerStore.getState().finishAttachmentImport(stale);
    expect(useHomeComposerStore.getState().pendingAttachmentImportIds).toEqual([
      current.id,
    ]);
  });

  it('invalidates pending imports when the attachment target changes', () => {
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });
    const token = useHomeComposerStore.getState().beginAttachmentImport();

    useHomeComposerStore
      .getState()
      .setBranchTarget({ kind: 'worktree', worktreeId: 'wt-2' });

    const state = useHomeComposerStore.getState();
    expect(state.pendingAttachmentImportIds).toEqual([]);
    expect(state.draftGeneration).toBe(token.draftGeneration + 1);
  });
});

describe('homeComposerStore setSelectedRepoId', () => {
  it('sets a child repo id and collapses the workspace-root sentinel to undefined', () => {
    useHomeComposerStore.getState().setSelectedRepoId('repo-web');
    expect(useHomeComposerStore.getState().selectedRepoId).toBe('repo-web');

    useHomeComposerStore.getState().setSelectedRepoId(WORKSPACE_ROOT_REPO_ID);
    expect(useHomeComposerStore.getState().selectedRepoId).toBeUndefined();

    useHomeComposerStore.getState().setSelectedRepoId('repo-api');
    useHomeComposerStore.getState().setSelectedRepoId(undefined);
    expect(useHomeComposerStore.getState().selectedRepoId).toBeUndefined();
  });

  it('is reset by selectWorkspace (repo ids are workspace-specific) but survives branch-target changes', () => {
    useProjectsStore.setState({
      projects: [makeProject('proj-a'), makeProject('proj-b')],
    });
    useHomeComposerStore.getState().selectWorkspace('proj-a');
    useHomeComposerStore.getState().setSelectedRepoId('repo-web');

    useHomeComposerStore
      .getState()
      .setBranchTarget({ kind: 'worktree', worktreeId: 'wt-1' });
    expect(useHomeComposerStore.getState().selectedRepoId).toBe('repo-web');

    useHomeComposerStore.getState().selectWorkspace('proj-b');
    expect(useHomeComposerStore.getState().selectedRepoId).toBeUndefined();
  });
});

describe('resolveHomeDiscoveryProviderType', () => {
  it('defaults to claude when no model override is set', () => {
    expect(resolveHomeDiscoveryProviderType(undefined)).toBe('claude');
  });

  it('resolves codex models to codex', () => {
    expect(resolveHomeDiscoveryProviderType('gpt-6-sol')).toBe('codex');
  });

  it('resolves claude and ollama models to claude', () => {
    expect(resolveHomeDiscoveryProviderType('claude-sonnet-4-5')).toBe(
      'claude',
    );
  });
});

describe('resolveHomeEffectiveProviderType (Task F2 carry-forward fix)', () => {
  // MANDATORY carry-forward from the F1 review: provider routing for
  // discovery/command-building must key off the EFFECTIVE model (touched
  // draft override, else the settings-derived default), not the raw
  // possibly-`undefined` draft model — otherwise an untouched draft on a
  // codex-default workspace would incorrectly build claude-flavored
  // discovery/commands requests.
  it('falls back to the workspace-kind effective default when the draft model is untouched', () => {
    useProjectsStore.setState({ projects: [makeProject('ws-1')] });
    useChatStore.setState({
      // `worktreeModelByProvider.codex.model` must be a REGISTERED codex
      // model id (from `initCodexModels` in `beforeEach`) so
      // `getProviderForModel` actually classifies it as codex rather than
      // falling back to claude for an unrecognized id.
      modelDefaults: makeModelDefaultsFixture({
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'worktree-claude-model', thinkingLevel: 'high' },
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          ollama: null,
        },
      }),
    });

    expect(resolveHomeEffectiveProviderType('ws-1', undefined)).toBe('codex');
  });

  it('uses the touched draft model verbatim when the user has picked one, even against a codex-default project', () => {
    useProjectsStore.setState({ projects: [makeProject('ws-1')] });
    useChatStore.setState({
      modelDefaults: makeModelDefaultsFixture({ worktreeProvider: 'codex' }),
    });

    expect(resolveHomeEffectiveProviderType('ws-1', 'claude-sonnet-4-5')).toBe(
      'claude',
    );
  });

  it('falls back to claude when no project is selected and the draft is untouched', () => {
    expect(resolveHomeEffectiveProviderType(null, undefined)).toBe('claude');
  });
});

describe('resolveHomeEffectiveDefaults', () => {
  it('falls back to DEFAULT_MODEL / the backend-mirrored thinking default when no project is selected', () => {
    expect(resolveHomeEffectiveDefaults(null)).toEqual({
      model: DEFAULT_MODEL,
      thinkingLevel: 'high',
    });
  });

  it('falls back the same way when modelDefaults has not loaded yet, even with a selected project', () => {
    useProjectsStore.setState({ projects: [makeProject('ws-1')] });
    expect(resolveHomeEffectiveDefaults('ws-1')).toEqual({
      model: DEFAULT_MODEL,
      thinkingLevel: 'high',
    });
  });

  it('resolves the worktree-kind default for a code (single-repo) project', () => {
    useProjectsStore.setState({ projects: [makeProject('ws-1')] });
    useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });

    expect(resolveHomeEffectiveDefaults('ws-1')).toEqual({
      model: 'worktree-claude-model',
      thinkingLevel: 'high',
    });
  });

  it('resolves the chat-kind default for a cowork project', () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });

    expect(resolveHomeEffectiveDefaults('cowork-1')).toEqual({
      model: 'chat-claude-model',
      thinkingLevel: 'medium',
    });
  });
});

describe('homeComposerStore model/thinking effective-default blending (Task F1)', () => {
  it('an untouched model shows the newly selected project kind default after switching from code to cowork', () => {
    useProjectsStore.setState({
      projects: [makeProject('ws-1'), makeCoworkProject('cowork-1')],
    });
    useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });

    useHomeComposerStore.getState().selectWorkspace('ws-1');
    expect(useHomeComposerStore.getState().model).toBeUndefined();
    expect(
      resolveHomeEffectiveDefaults(useHomeComposerStore.getState().workspaceId),
    ).toEqual({ model: 'worktree-claude-model', thinkingLevel: 'high' });

    useHomeComposerStore.getState().selectWorkspace('cowork-1');
    // Still untouched — `selectWorkspace` never writes a concrete `model`.
    expect(useHomeComposerStore.getState().model).toBeUndefined();
    expect(
      resolveHomeEffectiveDefaults(useHomeComposerStore.getState().workspaceId),
    ).toEqual({ model: 'chat-claude-model', thinkingLevel: 'medium' });
  });

  it('a touched (concrete) model persists verbatim across a workspace-kind switch', () => {
    useProjectsStore.setState({
      projects: [makeProject('ws-1'), makeCoworkProject('cowork-1')],
    });
    useChatStore.setState({ modelDefaults: makeModelDefaultsFixture() });

    useHomeComposerStore.getState().selectWorkspace('ws-1');
    useHomeComposerStore.getState().setModel('user-picked-model');
    expect(useHomeComposerStore.getState().model).toBe('user-picked-model');

    useHomeComposerStore.getState().selectWorkspace('cowork-1');

    expect(useHomeComposerStore.getState().model).toBe('user-picked-model');
  });
});

describe('isHomeSendEnabled', () => {
  it('chat mode allows an empty work area with empty or whitespace text', () => {
    expect(isHomeSendEnabled('chat', '', [])).toBe(true);
    expect(isHomeSendEnabled('chat', '   ', [])).toBe(true);
    expect(isHomeSendEnabled('chat', '   ', [makeAttachment()])).toBe(true);
  });

  it('chat mode enables once there is non-whitespace text', () => {
    expect(isHomeSendEnabled('chat', 'fix the bug', [])).toBe(true);
  });

  it('pipeline mode requires text OR attachments — neither disables', () => {
    expect(isHomeSendEnabled('pipeline', '', [])).toBe(false);
    expect(isHomeSendEnabled('pipeline', '   ', [])).toBe(false);
  });

  it('pipeline mode enables on text alone', () => {
    expect(isHomeSendEnabled('pipeline', 'build a thing', [])).toBe(true);
  });

  it('pipeline mode enables on attachments alone (e.g. a staged Linear ticket), even with empty text', () => {
    expect(isHomeSendEnabled('pipeline', '', [makeAttachment()])).toBe(true);
    expect(isHomeSendEnabled('pipeline', '   ', [makeAttachment()])).toBe(true);
  });
});

describe('Home Fast mode draft', () => {
  it('keeps an explicit off choice across destinations instead of restoring the provider default', () => {
    useChatStore.setState({
      modelDefaults: makeModelDefaultsFixture({
        modelConfigDefaultsByProvider: { codex: { fastMode: true } },
      }),
    });
    const model = 'gpt-6-sol';
    expect(resolveHomeFastMode(model, undefined)).toBe(true);
    useHomeComposerStore.getState().setFastMode(false);
    useHomeComposerStore.getState().selectWorkspace('cowork-default');
    expect(
      resolveHomeFastMode(model, useHomeComposerStore.getState().fastMode),
    ).toBe(false);
    expect(resolveHomeFastMode('sonnet', true)).toBeUndefined();
    useHomeComposerStore.getState().reset();
    expect(
      resolveHomeFastMode(model, useHomeComposerStore.getState().fastMode),
    ).toBe(true);
  });
});

describe('homeComposerStore loadDiscovery', () => {
  it('does nothing when there is no selected project', async () => {
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({ discovery: null }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().discovery).toBeNull();
  });

  it('does not discover commands for Cursor or adopt a pending Claude response', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const pending = deferred<HomeDiscoverEnvironmentResponse>();
    const discover = jest
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ discovery: makeDiscovery() });
    installHomeDiscoverEnvironment(discover);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });
    const loading = useHomeComposerStore.getState().loadDiscovery();
    useHomeComposerStore.getState().setModel('cursor-default');
    await useHomeComposerStore.getState().loadDiscovery(true);
    pending.resolve({ discovery: makeDiscovery() });
    await loading;
    expect(discover).toHaveBeenCalledTimes(1);
    expect(useHomeComposerStore.getState().discovery).toBeNull();
    expect(useHomeComposerStore.getState().discoveryLoading).toBe(false);
  });

  it('keeps skills and Collections through a Cursor selection, a workspace-default sync, and the switch back', () => {
    // A Cursor draft loads skills from its private Cursor root, so the
    // selection is the same working set on every model: nothing is stripped
    // on the way in, and nothing has to be restored on the way out.
    const selections = makePluginSelections({
      collectionIds: ['collection-a'],
      skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
    });
    useProjectsStore.setState({
      projects: [
        makeProject('proj-a', { defaultPluginSelections: selections }),
      ],
    });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      pluginSelections: selections,
      manualPluginSelections: selections,
    });
    useHomeComposerStore.getState().setModel('cursor-default');
    expect(useHomeComposerStore.getState().pluginSelections).toEqual(
      selections,
    );
    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject(
      selections,
    );
    useHomeComposerStore.getState().selectWorkspace('proj-a');
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject(
      selections,
    );
    useHomeComposerStore.getState().setModel('claude-sonnet-4-5');
    expect(useHomeComposerStore.getState().pluginSelections).toEqual(
      selections,
    );
  });

  it('requests a baseline target for a new-worktree branch target', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const discovery = makeDiscovery();
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({ discovery }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'claude',
    });
    expect(useHomeComposerStore.getState().discovery).toEqual(discovery);
    expect(useHomeComposerStore.getState().discoveryLoading).toBe(false);
  });

  it('forwards current plugin selections to discovery', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const pluginSelections = makePluginSelections({
      collectionIds: ['collection-a'],
    });
    const discovery = makeDiscovery();
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({ discovery }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      pluginSelections,
    });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'claude',
      pluginSelections,
    });
  });

  it('omits force by default and forwards force: true when requested', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadDiscovery();
    expect(homeDiscoverEnvironment).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'claude',
    });

    await useHomeComposerStore.getState().loadDiscovery(true);
    expect(homeDiscoverEnvironment).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'claude',
      force: true,
    });
  });

  it('requests a worktree target for an existing-worktree branch target', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'worktree', worktreeId: 'wt-1' },
      providerType: 'claude',
    });
  });

  it('requests a cowork target for a cowork project', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-a')] });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({ workspaceId: 'cowork-a' });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'cowork-a',
      target: { kind: 'cowork' },
      providerType: 'claude',
    });
  });

  it('scopes the target to the selected working-directory repo', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      selectedRepoId: 'repo-web',
    });

    await useHomeComposerStore.getState().loadDiscovery();
    expect(homeDiscoverEnvironment).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline', repoId: 'repo-web' },
      providerType: 'claude',
    });

    useHomeComposerStore.setState({
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });
    await useHomeComposerStore.getState().loadDiscovery();
    expect(homeDiscoverEnvironment).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'worktree', worktreeId: 'wt-1', repoId: 'repo-web' },
      providerType: 'claude',
    });
  });

  it('resolves the provider type from the draft model', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'gpt-6-sol',
    });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'codex',
    });
  });

  it('Task F2 carry-forward fix: resolves the EFFECTIVE provider type (settings default) when the draft model is untouched, not a hardcoded claude fallback', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useChatStore.setState({
      modelDefaults: makeModelDefaultsFixture({
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'worktree-claude-model', thinkingLevel: 'high' },
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          ollama: null,
        },
      }),
    });
    const homeDiscoverEnvironment = jest.fn(() =>
      Promise.resolve<HomeDiscoverEnvironmentResponse>({
        discovery: makeDiscovery(),
      }),
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    // `model` is left `undefined` (untouched draft) — a codex-default
    // workspace must still discover against codex, not claude.
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadDiscovery();

    expect(homeDiscoverEnvironment).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'codex',
    });
  });

  it('falls back to null discovery when the IPC call rejects', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    installHomeDiscoverEnvironment(
      jest.fn(() => Promise.reject(new Error('boom'))),
    );
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadDiscovery();

    const state = useHomeComposerStore.getState();
    expect(state.discovery).toBeNull();
    expect(state.discoveryLoading).toBe(false);
  });

  it('drops a stale response when the project changes while the request is in flight', async () => {
    useProjectsStore.setState({
      projects: [makeProject('workspace-a'), makeProject('workspace-b')],
    });
    const deferredA = deferred<HomeDiscoverEnvironmentResponse>();
    const discoveryB = makeDiscovery();
    const homeDiscoverEnvironment = jest.fn(
      (request: { workspaceId: string }) => {
        if (request.workspaceId === 'workspace-a') {
          return deferredA.promise;
        }
        return Promise.resolve<HomeDiscoverEnvironmentResponse>({
          discovery: discoveryB,
        });
      },
    );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);

    useHomeComposerStore.setState({ workspaceId: 'workspace-a' });
    const loadA = useHomeComposerStore.getState().loadDiscovery();

    useHomeComposerStore.setState({ workspaceId: 'workspace-b' });
    await useHomeComposerStore.getState().loadDiscovery();

    expect(useHomeComposerStore.getState().discovery).toEqual(discoveryB);

    deferredA.resolve(makeDiscovery({ discoveredAt: 'stale' }));
    await loadA;
    await Promise.resolve();

    // The late 'a' response must not clobber workspace-b's discovery.
    expect(useHomeComposerStore.getState().discovery).toEqual(discoveryB);
    expect(useHomeComposerStore.getState().workspaceId).toBe('workspace-b');
  });

  it('drops a stale response when the branch target changes while the request is in flight', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const deferredFirst = deferred<HomeDiscoverEnvironmentResponse>();
    const secondDiscovery = makeDiscovery({ discoveredAt: 'second' });
    const homeDiscoverEnvironment = jest
      .fn()
      .mockReturnValueOnce(deferredFirst.promise)
      .mockReturnValueOnce(
        Promise.resolve<HomeDiscoverEnvironmentResponse>({
          discovery: secondDiscovery,
        }),
      );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    const loadFirst = useHomeComposerStore.getState().loadDiscovery();
    useHomeComposerStore.setState({
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });
    await useHomeComposerStore.getState().loadDiscovery();

    expect(useHomeComposerStore.getState().discovery).toEqual(secondDiscovery);

    deferredFirst.resolve(makeDiscovery({ discoveredAt: 'stale' }));
    await loadFirst;
    await Promise.resolve();

    expect(useHomeComposerStore.getState().discovery).toEqual(secondDiscovery);
  });

  it('drops a stale response when plugin selections change while the request is in flight', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const firstSelections = makePluginSelections({ collectionIds: ['first'] });
    const secondSelections = makePluginSelections({
      collectionIds: ['second'],
    });
    const deferredFirst = deferred<HomeDiscoverEnvironmentResponse>();
    const secondDiscovery = makeDiscovery({ discoveredAt: 'second' });
    const homeDiscoverEnvironment = jest
      .fn()
      .mockReturnValueOnce(deferredFirst.promise)
      .mockReturnValueOnce(
        Promise.resolve<HomeDiscoverEnvironmentResponse>({
          discovery: secondDiscovery,
        }),
      );
    installHomeDiscoverEnvironment(homeDiscoverEnvironment);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      pluginSelections: firstSelections,
    });

    const loadFirst = useHomeComposerStore.getState().loadDiscovery();
    useHomeComposerStore.setState({ pluginSelections: secondSelections });
    await useHomeComposerStore.getState().loadDiscovery();

    expect(useHomeComposerStore.getState().discovery).toEqual(secondDiscovery);

    deferredFirst.resolve(makeDiscovery({ discoveredAt: 'stale' }));
    await loadFirst;
    await Promise.resolve();

    expect(useHomeComposerStore.getState().discovery).toEqual(secondDiscovery);
    expect(homeDiscoverEnvironment).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      providerType: 'claude',
      pluginSelections: secondSelections,
    });
  });
});

describe('homeComposerStore loadFileIndex (Task F3)', () => {
  it('does nothing when there is no selected project', async () => {
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos: [] }),
    );
    installHomeFileIndex(homeFileIndex);

    await useHomeComposerStore.getState().loadFileIndex();

    expect(homeFileIndex).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().fileIndex).toBeNull();
  });

  it('requests a baseline target for a new-worktree branch target', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const repos = [makeRepoFileIndex()];
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadFileIndex();

    expect(homeFileIndex).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
    });
    expect(useHomeComposerStore.getState().fileIndex).toEqual(repos);
    expect(useHomeComposerStore.getState().fileIndexLoading).toBe(false);
  });

  it('omits force by default and forwards force: true when requested', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos: [makeRepoFileIndex()] }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadFileIndex();
    expect(homeFileIndex).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
    });

    await useHomeComposerStore.getState().loadFileIndex(true);
    expect(homeFileIndex).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline' },
      force: true,
    });
  });

  it('requests a worktree target for an existing-worktree branch target', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos: [makeRepoFileIndex()] }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });

    await useHomeComposerStore.getState().loadFileIndex();

    expect(homeFileIndex).toHaveBeenCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'worktree', worktreeId: 'wt-1' },
    });
  });

  it('requests a cowork target for a cowork project', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-a')] });
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos: [makeRepoFileIndex()] }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({ workspaceId: 'cowork-a' });

    await useHomeComposerStore.getState().loadFileIndex();

    expect(homeFileIndex).toHaveBeenCalledWith({
      workspaceId: 'cowork-a',
      target: { kind: 'cowork' },
    });
  });

  it('scopes the target to the selected working-directory repo', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const homeFileIndex = jest.fn(() =>
      Promise.resolve<FileIndexResponse>({ repos: [makeRepoFileIndex()] }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      selectedRepoId: 'repo-web',
    });

    await useHomeComposerStore.getState().loadFileIndex();
    expect(homeFileIndex).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'baseline', repoId: 'repo-web' },
    });

    useHomeComposerStore.setState({
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });
    await useHomeComposerStore.getState().loadFileIndex();
    expect(homeFileIndex).toHaveBeenLastCalledWith({
      workspaceId: 'proj-a',
      target: { kind: 'worktree', worktreeId: 'wt-1', repoId: 'repo-web' },
    });
  });

  it('drops a stale response when the working directory changes mid-flight', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    let resolveRequest: (response: FileIndexResponse) => void = () => {};
    const homeFileIndex = jest.fn(
      () =>
        new Promise<FileIndexResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    const load = useHomeComposerStore.getState().loadFileIndex();
    useHomeComposerStore.getState().setSelectedRepoId('repo-web');
    resolveRequest({ repos: [makeRepoFileIndex()] });
    await load;

    expect(useHomeComposerStore.getState().fileIndex).toBeNull();
  });

  it('falls back to a null file index when the IPC call rejects', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    installHomeFileIndex(jest.fn(() => Promise.reject(new Error('boom'))));
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    await useHomeComposerStore.getState().loadFileIndex();

    expect(useHomeComposerStore.getState().fileIndex).toBeNull();
    expect(useHomeComposerStore.getState().fileIndexLoading).toBe(false);
  });

  it('drops a stale response when the project changes while the request is in flight', async () => {
    useProjectsStore.setState({
      projects: [makeProject('workspace-a'), makeProject('workspace-b')],
    });
    const deferredA = deferred<FileIndexResponse>();
    const reposB = [makeRepoFileIndex({ repoId: 'b' })];
    const homeFileIndex = jest.fn((request: { workspaceId: string }) => {
      if (request.workspaceId === 'workspace-a') {
        return deferredA.promise;
      }
      return Promise.resolve<FileIndexResponse>({ repos: reposB });
    });
    installHomeFileIndex(homeFileIndex);

    useHomeComposerStore.setState({ workspaceId: 'workspace-a' });
    const loadA = useHomeComposerStore.getState().loadFileIndex();

    useHomeComposerStore.setState({ workspaceId: 'workspace-b' });
    await useHomeComposerStore.getState().loadFileIndex();

    expect(useHomeComposerStore.getState().fileIndex).toEqual(reposB);

    deferredA.resolve({ repos: [makeRepoFileIndex({ repoId: 'stale' })] });
    await loadA;
    await Promise.resolve();

    // The late 'a' response must not clobber workspace-b's file index.
    expect(useHomeComposerStore.getState().fileIndex).toEqual(reposB);
    expect(useHomeComposerStore.getState().workspaceId).toBe('workspace-b');
  });

  it('drops a stale response when the branch target changes while the request is in flight', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const deferredFirst = deferred<FileIndexResponse>();
    const secondRepos = [makeRepoFileIndex({ repoId: 'second' })];
    const homeFileIndex = jest
      .fn()
      .mockReturnValueOnce(deferredFirst.promise)
      .mockReturnValueOnce(
        Promise.resolve<FileIndexResponse>({ repos: secondRepos }),
      );
    installHomeFileIndex(homeFileIndex);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });

    const loadFirst = useHomeComposerStore.getState().loadFileIndex();
    useHomeComposerStore.setState({
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });
    await useHomeComposerStore.getState().loadFileIndex();

    expect(useHomeComposerStore.getState().fileIndex).toEqual(secondRepos);

    deferredFirst.resolve({
      repos: [makeRepoFileIndex({ repoId: 'stale' })],
    });
    await loadFirst;
    await Promise.resolve();

    expect(useHomeComposerStore.getState().fileIndex).toEqual(secondRepos);
  });
});

describe('homeComposerStore link targets (CAN-3606)', () => {
  const readyTarget = {
    status: 'ready' as const,
    key: 'github.com/acme/app',
    fingerprint: 'fp',
    plan: {
      kind: 'existing-project' as const,
      workspaceId: 'proj-a',
      workspaceName: 'proj-a',
      branchTarget: { kind: 'new-worktree' as const },
    },
  };

  it('records whether the user chose the workspace', () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const store = useHomeComposerStore.getState();
    store.selectWorkspace('proj-a');
    expect(useHomeComposerStore.getState().workspaceSelectionExplicit).toBe(
      false,
    );
    store.selectWorkspace('proj-a', { explicit: true });
    expect(useHomeComposerStore.getState().workspaceSelectionExplicit).toBe(
      true,
    );
    store.markWorkspaceSelectionInherited();
    expect(useHomeComposerStore.getState().workspaceSelectionExplicit).toBe(
      false,
    );
  });

  it('dismissal hides the preview and clears a chosen reference', () => {
    const store = useHomeComposerStore.getState();
    store.setLinkTarget(readyTarget);
    store.chooseLinkReference('github.com/acme/app');
    store.dismissLinkReferences(['github.com/acme/app']);
    const state = useHomeComposerStore.getState();
    expect(state.linkTarget).toEqual({ status: 'idle' });
    expect(state.dismissedLinkKeys).toEqual(['github.com/acme/app']);
    expect(state.chosenLinkKey).toBeNull();
  });

  it('pipeline mode drops the preview, and reset clears all link state', () => {
    const store = useHomeComposerStore.getState();
    store.setLinkTarget(readyTarget);
    store.setMode('pipeline');
    expect(useHomeComposerStore.getState().linkTarget).toEqual({
      status: 'idle',
    });
    store.setMode('chat');
    store.dismissLinkReferences(['linear:CAN-1']);
    store.retryLinkTarget();
    store.reset();
    const state = useHomeComposerStore.getState();
    expect(state.dismissedLinkKeys).toEqual([]);
    expect(state.linkRetryGeneration).toBe(0);
  });
});

describe('CAN-3794 draft ownership', () => {
  it('clears the global draft on an account change even without a mounted composer', () => {
    useHomeComposerStore.getState().setText('private previous-account draft');
    useWorkspaceContextStore.setState((state) => ({
      accountEpoch: state.accountEpoch + 1,
    }));
    expect(useHomeComposerStore.getState().text).toBe('');
    expect(useHomeComposerStore.getState().fileReferences).toEqual([]);
  });
  it('publishes one coherent snapshot and clones mutable reference metadata', () => {
    const references = [
      {
        displayPath: 'src/app.ts',
        absolutePath: '/repo/src/app.ts',
        textStart: 4,
      },
    ];
    const observed: unknown[] = [];
    const unsubscribe = useHomeComposerStore.subscribe((state) => {
      observed.push({ text: state.text, fileReferences: state.fileReferences });
    });
    try {
      useHomeComposerStore
        .getState()
        .setDraft({ text: 'see src/app.ts', fileReferences: references });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toEqual({
        text: 'see src/app.ts',
        fileReferences: references,
      });
      references[0].displayPath = 'mutated';
      expect(
        useHomeComposerStore.getState().fileReferences[0].displayPath,
      ).toBe('src/app.ts');
    } finally {
      unsubscribe();
    }
  });
  it('clearSubmittedDraft empties the text and references and leaves the rest of the draft alone', () => {
    const attachments = [{ filename: 'a.png', absolutePath: '/tmp/a.png' }];
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      attachments,
      isSending: true,
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });
    useHomeComposerStore.getState().setDraft({
      text: 'see src/app.ts',
      fileReferences: [
        {
          displayPath: 'src/app.ts',
          absolutePath: '/repo/src/app.ts',
          textStart: 4,
        },
      ],
    });
    const before = useHomeComposerStore.getState();

    before.clearSubmittedDraft();

    const after = useHomeComposerStore.getState();
    expect(after.text).toBe('');
    expect(after.fileReferences).toEqual([]);
    expect(after.draftGeneration).toBe(before.draftGeneration + 1);
    expect(after.linkDraftRevision).toBe(before.linkDraftRevision + 1);
    expect(after.workspaceId).toBe('ws-1');
    expect(after.attachments).toBe(attachments);
    expect(after.scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
    expect(after.isSending).toBe(true);
  });
  it('clearSubmittedDraft leaves the link revision alone when the text was already empty', () => {
    const before = useHomeComposerStore.getState();
    before.clearSubmittedDraft();
    const after = useHomeComposerStore.getState();
    expect(after.linkDraftRevision).toBe(before.linkDraftRevision);
    expect(after.draftGeneration).toBe(before.draftGeneration + 1);
  });
});

function registerOpenCodeAgent(): string {
  const id = 'agent_model_opencode_home';
  initOpenCodeModels([
    {
      id: 'opencode:fixture%2Fmodel',
      rawModelId: 'fixture/model',
      label: 'Fixture model',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ]);
  initAgentModels([
    {
      id,
      name: 'OpenCode Home Agent',
      baseModel: 'opencode:fixture%2Fmodel',
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
      available: true,
    },
  ]);
  return id;
}

describe('OpenCode Agent Home routing', () => {
  it('resolves a registered Agent to the provider used by Home capability inventory', () => {
    const agent = registerOpenCodeAgent();
    expect(resolveHomeDiscoveryProviderType(agent)).toBe('opencode');
    expect(resolveHomeEffectiveProviderType(null, agent)).toBe('opencode');
  });

  it('skips discovery and discards a stale Claude response after selecting an OpenCode Agent', async () => {
    const agent = registerOpenCodeAgent();
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const pending = deferred<HomeDiscoverEnvironmentResponse>();
    const discover = jest
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ discovery: makeDiscovery() });
    installHomeDiscoverEnvironment(discover);
    useHomeComposerStore.setState({ workspaceId: 'proj-a' });
    const loading = useHomeComposerStore.getState().loadDiscovery();
    useHomeComposerStore.getState().setModel(agent);
    await useHomeComposerStore.getState().loadDiscovery(true);
    pending.resolve({ discovery: makeDiscovery() });
    await loading;
    expect(discover).toHaveBeenCalledTimes(1);
    expect(useHomeComposerStore.getState().discovery).toBeNull();
    expect(useHomeComposerStore.getState().discoveryLoading).toBe(false);
  });
});
